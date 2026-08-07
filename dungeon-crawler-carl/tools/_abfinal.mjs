// ASSET BUDGET — the closing measurement.
//
// Re-runs the boot census the round opened with, on the built dist served by
// the PRODUCTION server (gameServer + STATIC_DIR=dist), because that is the
// only server that applies this branch's two shipped mechanisms: the
// precompressed sidecars and the immutable cache policy. `vite preview` serves
// the same bytes under different headers and would answer a different question
// (HANDOFF.md §0 is a list of times this project measured the adjacent thing).
//
// WIRE vs DECODED, and why both columns exist. The round's opening baseline
// ("35.86 MB / 399 requests") was collected with a client that did not send
// accept-encoding, so it is a census of bytes ON DISK. A browser always sends
// it. Reporting only one number would either flatter this round (comparing
// disk-before to wire-after) or erase it. So every row carries both:
//   transfer = what crossed the socket   decoded = what the client ended up with
// The honest before/after is wire-to-wire; the disk column is what the baseline
// actually measured and is kept so the two can be reconciled.
//
// TTI IS DEFINED HERE because the baseline did not record its definition.
// "Interactive" = the loading overlay is gone AND the render loop has since
// delivered 3 consecutive animation frames — i.e. the first moment a keypress
// would be seen and drawn. Any other definition is fine; an unstated one is not.
import { mkdirSync, writeFileSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://127.0.0.1:5285");
const outDir = flag("--out", "tools/_abshots");
const gpu = flag("--gpu", "d3d11");
mkdirSync(outDir, { recursive: true });

const gpuArgs = gpu === "swiftshader"
  ? ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

const browser = await chromium.launch({ headless: true, args: [...gpuArgs, "--disable-frame-rate-limit"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const report = { base, gpu, boots: [], shots: [], renderer: null };

// ---------------------------------------------------------------- classification
// Baseline's classes, kept byte-for-byte so the two tables can be laid side by
// side. `icons` and `docs` were folded into the baseline's "other"; they are
// broken out here because the icons tree is one of the two things this branch
// versioned by directory and it should be visible.
function classify(path) {
  const ext = (path.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
  if (ext === ".glb" || ext === ".gltf") return "models";
  if (ext === ".ogg" || ext === ".wav" || ext === ".mp3" || ext === ".m4a") return "audio";
  if (ext === ".ttf" || ext === ".woff" || ext === ".woff2" || ext === ".otf") return "fonts";
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".webp" || ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".ktx2") return "textures";
  if (ext === ".svg") return "icons";
  if (ext === ".html") return "docs";
  if (ext === ".css") return "css";
  if (ext === ".json") return "json";
  if (ext === ".txt") return "text";
  return "other";
}

async function boot(label) {
  const page = await ctx.newPage();
  // The Resource Timing buffer defaults to 250 entries. A boot that fetches
  // ~380 files truncates there in silence and every total under it is a lie.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(6000));
  const bad = [];
  const pageErrors = [];
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const t0 = Date.now();
  await page.goto(`${base}/iso.html`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
  const settled = Date.now() - t0;
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || getComputedStyle(el).display === "none" || el.classList.contains("done");
  }, null, { timeout: 300000 }).catch(() => {});
  const loadingDone = Date.now() - t0;
  // TTI: three consecutive rAF ticks AFTER the overlay cleared.
  await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const tick = () => (++n >= 3 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  const tti = Date.now() - t0;

  const census = await page.evaluate(() => {
    const paint = performance.getEntriesByType("paint");
    const fp = paint.find((e) => e.name === "first-paint");
    const fcp = paint.find((e) => e.name === "first-contentful-paint");
    const nav = performance.getEntriesByType("navigation")[0];
    const rows = performance.getEntriesByType("resource")
      .filter((e) => e.name.startsWith(location.origin))
      .map((e) => ({ path: new URL(e.name).pathname, transfer: e.transferSize, decoded: e.decodedBodySize }));
    return {
      firstPaint: fp ? Math.round(fp.startTime) : null,
      fcp: fcp ? Math.round(fcp.startTime) : null,
      rows,
      docTransfer: nav?.transferSize ?? 0,
      docDecoded: nav?.decodedBodySize ?? 0,
      truncated: rows.length >= 5990,
    };
  });

  const byType = {};
  const add = (k, transfer, decoded) => {
    byType[k] = byType[k] ?? { used: 0, net: 0, transfer: 0, decoded: 0 };
    byType[k].used++; byType[k].transfer += transfer; byType[k].decoded += decoded;
    if (transfer > 0) byType[k].net++;
  };
  add("docs", census.docTransfer, census.docDecoded); // the navigation itself
  for (const r of census.rows) add(classify(r.path), r.transfer, r.decoded);

  const used = census.rows.length + 1;
  const net = census.rows.filter((r) => r.transfer > 0).length + (census.docTransfer > 0 ? 1 : 0);
  const transfer = census.rows.reduce((a, r) => a + r.transfer, 0) + census.docTransfer;
  const decoded = census.rows.reduce((a, r) => a + r.decoded, 0) + census.docDecoded;

  const rec = {
    label, used, net, transfer, decoded, byType,
    firstPaint: census.firstPaint, fcp: census.fcp,
    settled, loadingDone, tti,
    bad, pageErrors, truncated: census.truncated,
  };
  report.boots.push(rec);

  console.log(`\n=== ${label} ===`);
  console.log(`requests used=${used}  HIT NETWORK=${net}  transferred=${(transfer / 1e6).toFixed(2)}MB  decoded=${(decoded / 1e6).toFixed(2)}MB`);
  console.log(`firstPaint=${census.firstPaint}ms fcp=${census.fcp}ms assetsSettled=${settled}ms loadingScreenDone=${loadingDone}ms TTI=${tti}ms`);
  console.log(`  ${"type".padEnd(9)} ${"used".padStart(4)} ${"net".padStart(4)}  ${"wire MB".padStart(8)}  ${"disk MB".padStart(8)}`);
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].decoded - a[1].decoded)) {
    console.log(`  ${k.padEnd(9)} ${String(v.used).padStart(4)} ${String(v.net).padStart(4)}  ${(v.transfer / 1e6).toFixed(3).padStart(8)}  ${(v.decoded / 1e6).toFixed(3).padStart(8)}`);
  }
  console.log(`  4xx/5xx: ${bad.length}${bad.length ? " -> " + bad.slice(0, 10).join(", ") : ""}`);
  console.log(`  pageerrors: ${pageErrors.length}${pageErrors.length ? " -> " + pageErrors.slice(0, 5).join(" | ") : ""}`);
  if (census.truncated) console.log("  !! RESOURCE TIMING BUFFER TRUNCATED — totals are floors, not totals");

  if (label === "COLD CACHE") {
    report.renderer = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return "no webgl";
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "masked";
    });
    console.log(`  webgl renderer: ${report.renderer}`);
  }
  await page.close();
  return rec;
}

await boot("COLD CACHE");
await boot("WARM CACHE (same context, nothing cleared)");

// ------------------------------------------------------------------ visual pass
// `eagerassets` blocks boot until the whole manifest settles, so a still shows
// the final art rather than a mid-stream mix of real models and stand-ins —
// which is the entire question this pass exists to answer.
async function shoot(name, url, opts = {}) {
  const page = await ctx.newPage();
  const bad = [];
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(url, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || getComputedStyle(el).display === "none" || el.classList.contains("done");
  }, null, { timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(opts.settle ?? 2500);
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file });
  // A GLB that 404s falls back to a procedural stand-in SILENTLY (assets.ts
  // swallows the error by design), so the 4xx list is the machine half of this
  // check and the still is the human half. Neither alone is sufficient.
  const glb = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((e) => e.name.endsWith(".glb")).length);
  report.shots.push({ name, url, file, bad, glb });
  console.log(`shot ${name}: glb=${glb} 4xx=${bad.length}${bad.length ? " " + bad.slice(0, 6).join(",") : ""}`);
  return page;
}

const seed = 42;
for (const floor of [1, 4, 10, 16]) {
  const lvl = Math.min(30, 3 + floor * 2);
  const page = await shoot(`floor${String(floor).padStart(2, "0")}`,
    `${base}/iso.html?test&floor=${floor}&level=${lvl}&abilities=all&gold=500&seed=${seed}&eagerassets&clean=1`);
  await page.close();
}

// Combat: hold an attack and take a filmstrip. Under any GL this is the frame
// sequence that would expose a broken skin or a dropped animation clip — the
// one failure mode a static still of an idle crawler cannot show.
{
  const page = await shoot("combat-00-pre",
    `${base}/iso.html?test&floor=7&level=18&abilities=all&gold=500&seed=${seed}&eagerassets&clean=1`);
  await page.mouse.move(720, 380);
  for (let i = 1; i <= 6; i++) {
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(120);
    const file = `${outDir}/combat-${String(i).padStart(2, "0")}.png`;
    await page.screenshot({ path: file });
    report.shots.push({ name: `combat-${i}`, file });
  }
  console.log("combat filmstrip: 6 frames");
  await page.close();
}

writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(`\nreport -> ${outDir}/report.json`);
await ctx.close();
await browser.close();
