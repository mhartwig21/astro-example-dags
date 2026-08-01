// CPU-FLOOR BENCH. gpuprobe.mjs measures rAF-to-rAF wall time, which pins at
// ~16.7ms the moment the frame gets cheap enough to hit vsync — useless for
// watching a CPU floor fall from 26ms to 8ms. This instead times the CPU
// INSIDE the frame: performance.now() around Renderer3D.update and
// Renderer3D.render, sampled over hundreds of real frames, reported as
// medians. Vsync can cap the frame RATE; it cannot inflate the CPU spent
// submitting the frame.
//
// Run at 640x360 dpr1: fill-rate goes to ~0 and what is left is the floor.
//
// Usage: node tools/floorbench.mjs <url> [--seconds 8] [--w 640 --h 360 --dpr 1]
//                                  [--reps 2] [--json out.json]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 8));
const width = Number(flag("--w", 640));
const height = Number(flag("--h", 360));
const dpr = Number(flag("--dpr", 1));
const reps = Number(flag("--reps", 2));
const jsonOut = flag("--json", null);

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
console.log("GPU:", gpu, `@ ${width}x${height} dpr${dpr}`);
if (!/Intel|D3D11|NVIDIA|AMD|Radeon/i.test(gpu)) console.warn("!! NOT a hardware GPU string — timings are worthless");

// Let the loading screen finish and the streaming assets settle: shader
// compiles during the window would swamp the signal we are after.
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);
// Walk into the room and start a fight so the sampled frames are COMBAT frames.
await page.keyboard.down("w"); await page.waitForTimeout(2200); await page.keyboard.up("w");
for (const k of ["Space", "q", "e"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }

// Hook update/render for CPU timing, and accumulate renderer.info across the
// whole composed frame (three.js resets it at the start of every internal
// WebGLRenderer.render, of which a composed frame is ~21).
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  gl.info.autoReset = false;
  const s = { upd: [], ren: [], frame: [], calls: 0, tris: 0, n: 0, progs: 0 };
  window.__bench = s;
  const origU = R.update.bind(R), origR = R.render.bind(R);
  let tFrameStart = 0;
  R.update = function (...a) { tFrameStart = performance.now(); origU(...a); s.upd.push(performance.now() - tFrameStart); };
  R.render = function (...a) {
    const t = performance.now();
    gl.info.reset();
    origR(...a);
    const dt = performance.now() - t;
    s.ren.push(dt);
    s.frame.push(performance.now() - tFrameStart);
    s.calls += gl.info.render.calls; s.tris += gl.info.render.triangles; s.n++;
    s.progs = gl.info.programs.length;
  };
});

const med = (a) => a.length ? +[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : null;
const pct = (a, p) => a.length ? +[...a].sort((x, y) => x - y)[Math.floor(a.length * p)].toFixed(2) : null;

const sample = async (label) => {
  await page.evaluate(() => { const s = window.__bench; s.upd = []; s.ren = []; s.frame = []; s.calls = 0; s.tris = 0; s.n = 0; });
  await page.waitForTimeout(seconds * 1000);
  const s = await page.evaluate(() => {
    const s = window.__bench;
    return { upd: s.upd, ren: s.ren, frame: s.frame, calls: s.calls, tris: s.tris, n: s.n, progs: s.progs };
  });
  const out = {
    frames: s.n,
    cpuFrameMs: med(s.frame),      // update + render CPU, the floor
    cpuFrameP95: pct(s.frame, 0.95),
    renderMs: med(s.ren),          // composer chain alone
    updateMs: med(s.upd),          // all game render logic
    callsPerFrame: s.n ? Math.round(s.calls / s.n) : null,
    ktrisPerFrame: s.n ? Math.round(s.tris / s.n / 1000) : null,
    programs: s.progs,
  };
  console.log(label, JSON.stringify(out));
  return out;
};

const runs = [];
for (let i = 0; i < reps; i++) runs.push(await sample(`REP${i}  `));
const medianOf = (k) => med(runs.map((r) => r[k]));
const summary = {
  gpu, width, height, dpr, reps,
  cpuFrameMs: medianOf("cpuFrameMs"),
  renderMs: medianOf("renderMs"),
  updateMs: medianOf("updateMs"),
  callsPerFrame: medianOf("callsPerFrame"),
  programs: runs[runs.length - 1].programs,
  runs,
};
console.log("SUMMARY " + JSON.stringify(summary, null, 1));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
await browser.close();
