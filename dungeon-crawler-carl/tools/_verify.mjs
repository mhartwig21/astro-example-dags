// POST-FIX VERIFICATION. One session, four independent checks, all read from
// the live production bundle via window.__dcc — nothing in src/ is touched.
//
//  1 VRAM      resident GL textures after boot (the preupload budget)
//  2 PROGRAMS  renderer.info.programs across a full ability rotation
//  3 TUNER     which preset auto-detect actually settles on, and when
//  4 SHADOW    backbuffer luminance on every preset switch (the dark frame)
//
// Usage: node tools/_verify.mjs --url http://localhost:5322/iso.html?...
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5322/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1&eagerassets");
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
const guardHits = [];
page.on("console", (m) => { if (m.text().includes("[shader-guard] program built AFTER")) guardHits.push(m.text().split("\n")[0]); });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const t0 = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);
if (/SwiftShader|Software/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 });
console.log(`loadingHidden at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await page.waitForTimeout(3000);

// ---- 1 VRAM ----------------------------------------------------------------
const vram = await page.evaluate(() => {
  const gl = window.__dcc.renderer.renderer;
  const props = gl.properties;
  let uploaded = 0, bytes = 0;
  // Walk every texture three knows about via its properties WeakMap is not
  // possible; instead sum from the model manifest and ask which have a GL
  // handle. renderer.info.memory.textures is the authoritative resident count.
  const models = window.__dcc.renderer.models || {};
  const seen = new Set();
  for (const k of Object.keys(models)) {
    const m = models[k]; if (!m?.scene) continue;
    m.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const mat of mats) {
        for (const slot of ["map", "normalMap", "emissiveMap", "roughnessMap", "metalnessMap", "aoMap", "alphaMap"]) {
          const t = mat[slot]; if (!t || seen.has(t)) continue; seen.add(t);
          const w = t.image?.width || 0, h = t.image?.height || 0;
          const b = Math.ceil(w * h * 4 * 4 / 3);
          if (props.get(t)?.__webglTexture) { uploaded++; bytes += b; }
        }
      }
    });
  }
  return {
    residentGLTextures: gl.info.memory.textures,
    manifestTexturesUploaded: uploaded,
    manifestTexturesTotal: seen.size,
    uploadedMB: +(bytes / 1048576).toFixed(1),
  };
});
console.log("1 VRAM      ", JSON.stringify(vram));

// ---- 2 PROGRAMS ------------------------------------------------------------
const progAt = async (tag) => {
  const n = await page.evaluate(() => window.__dcc.renderer.renderer.info.programs.length);
  console.log(`2 PROGRAMS   ${tag.padEnd(16)} ${n}`);
  return n;
};
const p0 = await progAt("after boot");
for (const k of ["w", "a", "s", "d"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
await progAt("after roaming");
for (const k of ["Space", "q", "c", "e", "r", "f", "1", "2", "3"]) {
  await page.keyboard.press(k).catch(() => {});
  await page.waitForTimeout(500);
}
await page.waitForTimeout(2500);
const p1 = await progAt("after casting");
console.log(`2 PROGRAMS   delta=${p1 - p0}  guardHits=${guardHits.length}`);
for (const g of guardHits.slice(0, 8)) console.log("   ", g);

// ---- 4 SHADOW FLASH --------------------------------------------------------
// Read the REAL backbuffer right after each composed frame and record mean
// luminance together with whether the key light had a shadow map that frame.
const flash = await page.evaluate(async () => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const ctx = gl.getContext();
  const W = 160, H = 96;
  const buf = new Uint8Array(W * H * 4);
  const rows = [];
  const orig = R.render.bind(R);
  R.render = function () {
    orig();
    try {
      ctx.readPixels(200, 200, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      rows.push({ lum: +(sum / (W * H)).toFixed(2), map: R.key.shadow.map ? R.key.shadow.mapSize.x : 0, preset: R.qualityProfile.name });
    } catch { /* backbuffer not readable this frame */ }
  };
  const order = ["ultra", "high", "balanced", "performance", "balanced", "ultra", "performance", "high"];
  for (let r = 0; r < 3; r++) {
    for (const q of order) {
      R.setQuality(q);
      await new Promise((res) => setTimeout(res, 260));
    }
  }
  R.render = orig;
  R.setQuality("auto");
  const withMap = rows.filter((x) => x.map > 0);
  const noMap = rows.filter((x) => x.map === 0);
  const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x.lum, 0) / a.length).toFixed(2) : null);
  return {
    frames: rows.length,
    nullMapFrames: noMap.length,
    meanLumWithMap: mean(withMap),
    meanLumNullMap: mean(noMap),
    darkest: rows.length ? Math.min(...rows.map((x) => x.lum)) : null,
    brightest: rows.length ? Math.max(...rows.map((x) => x.lum)) : null,
  };
});
console.log("4 SHADOW    ", JSON.stringify(flash));

// ---- 3 TUNER (fresh load, auto) -------------------------------------------
const page2 = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
const autoUrl = url.replace(/[?&]quality=[a-z]+/, "");
await page2.goto(autoUrl, { waitUntil: "load", timeout: 60000 });
await page2.evaluate(() => { try { localStorage.removeItem("dcc:quality:v1"); } catch { /* blocked */ } });
await page2.reload({ waitUntil: "load" });
await page2.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 });
const timeline = [];
for (let i = 0; i < 20; i++) {
  await page2.waitForTimeout(1500);
  if (i === 2) { await page2.keyboard.down("w"); }
  if (i === 6) { await page2.keyboard.up("w"); }
  if (i >= 6 && i % 2 === 0) { for (const k of ["Space", "q", "c"]) await page2.keyboard.press(k).catch(() => {}); }
  const s = await page2.evaluate(() => {
    const R = window.__dcc.renderer;
    return { p: R.qualityProfile.name, pr: +R.renderer.getPixelRatio().toFixed(2) };
  });
  const last = timeline[timeline.length - 1];
  if (!last || last.p !== s.p) timeline.push({ t: (i + 1) * 1.5, ...s });
}
const mpx = await page2.evaluate(() => {
  const gl = window.__dcc.renderer.renderer;
  const c = gl.domElement;
  return { bufW: c.width, bufH: c.height, mpx: +((c.width * c.height) / 1e6).toFixed(2) };
});
console.log("3 TUNER      timeline:", JSON.stringify(timeline), JSON.stringify(mpx));

console.log("VERIFYJSON", JSON.stringify({ vram, programs: { after: p0, end: p1, guardHits: guardHits.length }, flash, timeline, mpx }));
await browser.close();
