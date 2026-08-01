// Controlled A/B: does PRESET SWITCHING (not the passage of time) build shaders
// and leak GPU resources? Waits for the shader guard to arm first so nothing
// races prewarm.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const floor = flag("--floor", "8");
const url = `${base}/iso.html?test&floor=${floor}&level=16&seed=41&abilities=all&debug=1`;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
let armed = false;
page.on("console", (m) => { if (m.text().includes("shader-guard] armed")) armed = true; });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
// Wait for prewarm to finish (the guard arms at its very end).
for (let i = 0; i < 120 && !armed; i++) await page.waitForTimeout(500);
console.log("guard armed:", armed);
await page.waitForTimeout(2000);

const state = () => page.evaluate(() => {
  const r = window.__dcc.renderer, gl = r.renderer;
  return {
    keys: gl.info.programs.map((p) => `${p.name}::${p.cacheKey}`),
    tex: gl.info.memory.textures, geo: gl.info.memory.geometries,
    preset: r.quality.name,
    aoRT: `${r.gtao.gtaoRenderTarget.width}x${r.gtao.gtaoRenderTarget.height}`,
    pdRT: `${r.gtao.pdRenderTarget.width}x${r.gtao.pdRenderTarget.height}`,
    bloomRT: r.bloom.renderTargetsHorizontal
      ? `${r.bloom.renderTargetsHorizontal[0].width}x${r.bloom.renderTargetsHorizontal[0].height}` : "?",
    rt1: `${r.composer.renderTarget1.width}x${r.composer.renderTarget1.height}`,
    aoScale: r.gtao.aoScale, denoiseScale: r.gtao.denoiseScale,
  };
});

const diff = (a, b) => b.keys.filter((k) => !a.keys.includes(k));

// PHASE A — do nothing for 12s.
const a0 = await state();
await page.waitForTimeout(12000);
const a1 = await state();
console.log(`IDLE 12s   : programs ${a0.keys.length} -> ${a1.keys.length}  tex ${a0.tex}->${a1.tex}  geo ${a0.geo}->${a1.geo}`);
for (const k of diff(a0, a1)) console.log("   NEW(idle):", k.slice(0, 160));

// PHASE B — churn the ladder for ~12s.
const b0 = await state();
for (let i = 0; i < 12; i++) {
  for (const p of ["ultra", "high", "balanced", "performance"]) {
    await page.evaluate((q) => window.__dcc.renderer.setQuality(q), p);
    await page.waitForTimeout(250);
  }
}
await page.evaluate(() => window.__dcc.renderer.setQuality("ultra"));
await page.waitForTimeout(1500);
const b1 = await state();
console.log(`CHURN 48sw : programs ${b0.keys.length} -> ${b1.keys.length}  tex ${b0.tex}->${b1.tex}  geo ${b0.geo}->${b1.geo}`);
for (const k of diff(b0, b1)) console.log("   NEW(churn):", k.slice(0, 200));

// PHASE C — settle, then re-read to see whether the growth is transient.
await page.waitForTimeout(8000);
const c1 = await state();
console.log(`SETTLE +8s : programs ${c1.keys.length}  tex ${c1.tex}  geo ${c1.geo}`);

// PHASE D — per-preset buffer geometry, to verify the ladder actually resizes.
for (const p of ["ultra", "high", "balanced", "performance"]) {
  await page.evaluate((q) => window.__dcc.renderer.setQuality(q), p);
  await page.waitForTimeout(500);
  const s = await state();
  console.log(`PRESET ${p.padEnd(12)} rt1=${s.rt1} ao=${s.aoRT} pd=${s.pdRT} bloom=${s.bloomRT} aoScale=${s.aoScale} dnScale=${s.denoiseScale}`);
}
await browser.close();
