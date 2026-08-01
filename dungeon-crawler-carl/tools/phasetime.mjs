// PER-PHASE CPU TIME. Wraps each render phase in place and accumulates
// performance.now() deltas, so the frame is decomposed WITHOUT perturbing the
// scene (no A/B toggling, no shader recompiles, no state drift). What it
// measures is CPU submission time — exactly the cost of pushing draw calls
// through ANGLE — plus the JS scene walks that surround them.
//
// Because GL is asynchronous these numbers are CPU-side; the residual between
// the phase sum and the rAF-to-rAF delta is GPU stall + browser compositing.
// Pass --finish to insert gl.finish() after each phase and convert the same
// breakdown into GPU-inclusive time (slower overall, but attributes GPU cost).
//
// Usage: node tools/phasetime.mjs "<url>" [--seconds 10] [--finish] [--w --h --dpr]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 10));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const finish = has("--finish");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);
if (!/D3D11/i.test(gpu)) { console.error("NOT ANGLE/D3D11 — refusing"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.keyboard.down("w"); await page.waitForTimeout(2200); await page.keyboard.up("w");
for (const k of ["Space", "q", "e", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(100); }

await page.evaluate((doFinish) => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const raw = gl.getContext();
  const gtao = R.gtao;
  const acc = {};
  const calls = {};
  let frames = 0;
  const bump = (k, ms) => { (acc[k] ||= []).push(ms); };
  const sync = () => { if (doFinish) raw.finish(); };

  const wrap = (obj, key, name) => {
    if (!obj || typeof obj[key] !== "function") return;
    const orig = obj[key].bind(obj);
    obj[key] = function (...a) {
      const t0 = performance.now();
      const r = orig(...a);
      sync();
      bump(name, performance.now() - t0);
      return r;
    };
  };

  // draw-call counter per phase
  let phase = "other", n = 0;
  const phaseCalls = {};
  const origRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (...a) { phaseCalls[phase] = (phaseCalls[phase] || 0) + 1; return origRBD(...a); };
  const tagged = (obj, key, name) => {
    if (!obj || typeof obj[key] !== "function") return;
    const orig = obj[key].bind(obj);
    obj[key] = function (...a) {
      const p = phase; phase = name;
      const t0 = performance.now();
      let r; try { r = orig(...a); } finally { sync(); bump(name, performance.now() - t0); phase = p; }
      return r;
    };
  };

  tagged(gl.shadowMap, "render", "1_shadowPass");
  if (gtao) {
    wrap(gtao, "overrideVisibility", "2a_gtaoVisWalk");
    wrap(gtao, "restoreVisibility", "2c_gtaoVisRestore");
    tagged(gtao, "renderOverride", "2b_gtaoGBuffer");
    tagged(gtao, "renderPass", "2d_gtaoFsQuads");
  }
  R.composer.passes.forEach((p, i) => {
    if (p === gtao) return;
    tagged(p, "render", `3_${i}_${p.constructor.name}`);
  });

  // whole composer frame + the JS that runs before it
  const origComposer = R.composer.render.bind(R.composer);
  let composerStart = 0;
  R.composer.render = function (...a) {
    composerStart = performance.now();
    const r = origComposer(...a);
    sync();
    bump("0_composerTotal", performance.now() - composerStart);
    frames++;
    return r;
  };
  // Renderer3D.update (or whatever the host calls each frame) — measured as
  // rAF-to-rAF minus composer, below.
  let lastRaf = performance.now();
  const rafTick = () => { const t = performance.now(); bump("Z_rafDelta", t - lastRaf); lastRaf = t; requestAnimationFrame(rafTick); };
  requestAnimationFrame(rafTick);

  window.__pt = {
    reset() { for (const k of Object.keys(acc)) delete acc[k]; for (const k of Object.keys(phaseCalls)) delete phaseCalls[k]; frames = 0; },
    dump() {
      const out = {};
      for (const [k, v] of Object.entries(acc)) {
        const s = [...v].sort((a, b) => a - b);
        out[k] = { medianMs: +s[s.length >> 1].toFixed(2), meanMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2), n: s.length };
      }
      const cpf = {};
      for (const [k, v] of Object.entries(phaseCalls)) cpf[k] = +(v / Math.max(1, frames)).toFixed(1);
      return { frames, phases: out, callsPerFrame: cpf };
    },
  };
}, finish);

const run = async (label) => {
  await page.evaluate(() => window.__pt.reset());
  await page.waitForTimeout(seconds * 1000);
  const d = await page.evaluate(() => window.__pt.dump());
  console.log(`\n=== ${label} (${finish ? "GPU-INCLUSIVE gl.finish()" : "CPU submit only"}) frames=${d.frames} ===`);
  const keys = Object.keys(d.phases).sort();
  console.log("phase".padEnd(24), "median".padStart(8), "mean".padStart(8), "p95".padStart(8), "calls/frame".padStart(12));
  for (const k of keys) {
    const p = d.phases[k];
    console.log(k.padEnd(24), String(p.medianMs).padStart(8), String(p.meanMs).padStart(8), String(p.p95Ms).padStart(8), String(d.callsPerFrame[k] ?? "").padStart(12));
  }
  const tot = d.phases["0_composerTotal"]?.medianMs ?? 0;
  const raf = d.phases["Z_rafDelta"]?.medianMs ?? 0;
  console.log(`-> composer ${tot}ms of ${raf}ms rAF frame; non-render JS + GPU stall = ${(raf - tot).toFixed(2)}ms`);
  return d;
};

await run("COMBAT (standing in the fight)");
await page.keyboard.down("w");
await run("MOVING");
await page.keyboard.up("w");
await browser.close();
