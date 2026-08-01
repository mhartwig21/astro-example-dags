// PROGRAM-KEY DIFF — the ground truth for "what does prewarm still miss?".
//
// Earlier probes fingerprinted programs by scraping `#define`s out of the
// shader source. That is wrong twice over: three.js string-REPLACES the light
// counts rather than defining them, and material.onBeforeCompile injections
// land in the shader BODY, so two genuinely different programs can have byte-
// identical prefixes. three.js already computes the exact key and parks it on
// the program object as `.cacheKey` (WebGLProgram, three.module.js:20399), so
// read that instead and stop guessing.
//
// Reports every cacheKey that appears AFTER the loading screen lifts — each one
// is a shader build inside a live frame, i.e. a hitch.
//
// Usage: node tools/progkeys.mjs "<url>"
import { chromium } from "playwright";

const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5296/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1&quality=ultra";

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
}));

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done") || getComputedStyle(el).opacity === "0";
}, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(1200);

const keys = () => page.evaluate(() => {
  const info = window.__dcc?.renderer?.renderer?.info;
  return (info?.programs ?? []).map((p) => `${p.name}${p.cacheKey}`);
});
const baseline = await keys();
console.log(`programs at loading-screen lift: ${baseline.length}`);

// Frame recorder over the whole play window.
await page.evaluate(() => {
  const F = [];
  window.__PKF = F;
  let last = performance.now();
  const tick = () => { const n = performance.now(); F.push(n - last); last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

const walk = async () => {
  for (const k of ["w", "d", "s", "a"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
};
const fight = async () => {
  for (let i = 0; i < 6; i++) {
    for (const k of ["Space", "Shift", "q", "c", "f", "x", "e", "r"]) {
      await page.keyboard.press(k).catch(() => {});
      await page.waitForTimeout(110);
    }
  }
};
await walk(); const afterWalk = await keys();
await fight(); const afterFight = await keys();
await walk(); await fight();
await page.waitForTimeout(1500);
const final = await keys();

const frames = await page.evaluate(() => window.__PKF);
await browser.close();

console.log(`after walk : ${afterWalk.length}  (+${afterWalk.length - baseline.length})`);
console.log(`after fight: ${afterFight.length}  (+${afterFight.length - afterWalk.length})`);
console.log(`after 2nd  : ${final.length}  (+${final.length - afterFight.length})`);

const f = frames.slice().sort((a, b) => a - b);
const q = (x) => f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
console.log(`\nFRAMES n=${f.length}  p50=${q(0.5)}  p95=${q(0.95)}  p99=${q(0.99)}  WORST=${f[f.length - 1].toFixed(0)}ms`);
console.log(`  >100ms: ${f.filter((x) => x > 100).length}   >200ms: ${f.filter((x) => x > 200).length}   >500ms: ${f.filter((x) => x > 500).length}`);

const base = new Set(baseline);
const added = final.filter((k) => !base.has(k));
console.log(`\n=== ${added.length} PROGRAMS BUILT DURING GAMEPLAY ===`);
// The cacheKey is a comma-joined parameter array; its LAST field is
// material.customProgramCacheKey(), which is where this app stamps its own
// variant names (rimN / |hitflash / |dissolve / wl*). That plus the shader
// name is enough to point at the exact construction site in src/render3d.
const rows = added.map((k) => {
  const [name, key] = k.split("");
  const parts = key.split(",");
  return { name, custom: parts[parts.length - 1] || "(none)", key };
});
const g = {};
for (const r of rows) (g[`${r.name}  custom=${r.custom}`] ||= []).push(r);
for (const [k, v] of Object.entries(g).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  n=${String(v.length).padStart(2)}  ${k}`);
}
// POSITIONAL DIFF. The cacheKey is a comma-joined parameter ARRAY
// (WebGLPrograms.getProgramCacheKey), so comparing a runtime key field-by-field
// against the nearest prewarmed key names the exact parameter that forked —
// e.g. field "numPointLights: 14 vs 10" for the FX-light-pool permutation.
console.log(`\n=== EXACT FORK FIELD (runtime key vs nearest prewarmed key) ===`);
const warm = baseline.map((k) => {
  const [name, key] = k.split("");
  return { name, parts: key.split(",") };
});
const seen = new Set();
for (const r of rows) {
  const mine = r.key.split(",");
  let best = null, bestDiff = 1e9;
  for (const w of warm) {
    if (w.parts.length !== mine.length) continue;
    let d = 0;
    for (let i = 0; i < mine.length; i++) if (w.parts[i] !== mine[i]) d++;
    if (d < bestDiff) { bestDiff = d; best = w; }
  }
  if (!best) { console.log(`  ${r.name}: no prewarmed key of the same arity`); continue; }
  const diffs = [];
  for (let i = 0; i < mine.length; i++) {
    if (best.parts[i] !== mine[i]) diffs.push(`[${i}] runtime="${mine[i]}" prewarm="${best.parts[i]}"`);
  }
  const line = `  ${r.name || "(unnamed)"} vs ${best.name || "(unnamed)"}: ${diffs.join("  ") || "IDENTICAL"}`;
  if (seen.has(line)) continue;
  seen.add(line);
  console.log(line);
}

if (process.argv.includes("--full")) {
  console.log("\n--- full keys ---");
  for (const r of rows) console.log(`  ${r.name} :: ${r.key}`);
}
