// AO LOOK GUARD. The perf round makes GTAO consume the main pass's depth
// buffer instead of re-rendering the scene into its own G-buffer. That trades
// MeshNormalMaterial normals for normals reconstructed from depth, so the
// question "did the picture change?" has to be answered against the SAME
// frame, not against a reference shot from another commit with different gear.
//
// This loads one page, freezes it, screenshots with the shipped shared-depth
// path, flips the pass back to the stock G-buffer path at runtime, screenshots
// again, and reports a per-pixel difference histogram. Same camera, same seed,
// same RNG state — the only variable is the AO source.
//
// Usage: node tools/aodiff.mjs <baseUrl> [--floor 8] [--out DIR] [--w 1600 --h 900]
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = (process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:5291").replace(/\/$/, "");
const floors = flag("--floor", "2,8,14").split(",");
const out = flag("--out", "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/aodiff");
const width = Number(flag("--w", 1600));
const height = Number(flag("--h", 900));
mkdirSync(out, { recursive: true });

// ---- minimal PNG decoder (cloned from lumcheck.mjs: 8-bit RGB/RGBA only)
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, px };
}

function diff(aBuf, bBuf) {
  const A = decodePng(aBuf), B = decodePng(bBuf);
  if (A.w !== B.w || A.h !== B.h) throw new Error("size mismatch");
  const n = A.w * A.h;
  let sum = 0, over2 = 0, over8 = 0, over24 = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const ai = i * A.ch, bi = i * B.ch;
    const d = Math.max(Math.abs(A.px[ai] - B.px[bi]), Math.abs(A.px[ai + 1] - B.px[bi + 1]), Math.abs(A.px[ai + 2] - B.px[bi + 2]));
    sum += d; if (d > max) max = d;
    if (d > 2) over2++; if (d > 8) over8++; if (d > 24) over24++;
  }
  return {
    meanDelta: +(sum / n).toFixed(3), maxDelta: max,
    pctOver2: +(100 * over2 / n).toFixed(2),
    pctOver8: +(100 * over8 / n).toFixed(2),
    pctOver24: +(100 * over24 / n).toFixed(2),
  };
}

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const results = {};
for (const floor of floors) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(`${base}/iso.html?test&floor=${floor}&level=16&seed=41&abilities=all&debug=1&clean=1&eagerassets`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // FREEZE THE WORLD. The host frame loop re-arms itself with rAF, so nulling
  // rAF stops it dead after the current frame — without that the sim advances
  // seconds between the two shots and the diff measures gameplay, not AO.
  await page.evaluate(() => new Promise((resolve) => {
    const raf = window.requestAnimationFrame.bind(window);
    raf(() => raf(() => {
      window.requestAnimationFrame = () => 0; // host loop halts here
      const R = window.__dcc.renderer;
      window.__ao = { t: performance.now() / 1000, R, state: window.__dcc.state };
      window.__aoShot = () => { R.update(window.__ao.state, window.__ao.t); R.render(); };
      resolve();
    }));
  }));
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__aoShot(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__aoShot());
  const shotNew = await page.screenshot();

  // Flip the pass back to the stock path: its own G-buffer prepass + real
  // MeshNormalMaterial normals — i.e. exactly what shipped before this round.
  const flipped = await page.evaluate(() => {
    const g = window.__dcc.renderer.gtao;
    if (!("gbufOff" in g)) return false;
    g.gbufOff = false;
    g.setGBuffer();                      // rebuilds normalRenderTarget + own depth
    g.setSize(g.gtaoRenderTarget.width, g.gtaoRenderTarget.height);
    return true;
  });
  if (!flipped) { console.error("could not flip gtao back to the stock path"); break; }
  // The stock path needs its normal-material programs compiled; give it a few
  // frames and a beat before believing the picture.
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__aoShot(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__aoShot());
  const shotOld = await page.screenshot();

  writeFileSync(`${out}/f${floor}-shareddepth.png`, shotNew);
  writeFileSync(`${out}/f${floor}-gbuffer.png`, shotOld);
  results[`floor${floor}`] = diff(shotNew, shotOld);
  console.log(`floor ${floor}`, JSON.stringify(results[`floor${floor}`]));
  await page.close();
}
console.log("AODIFF " + JSON.stringify(results, null, 1));
await browser.close();
