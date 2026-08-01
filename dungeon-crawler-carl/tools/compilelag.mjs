// COMPILE-LAG PROBE — proves the shape of the fix.
//
// ANGLE/D3D11 compiles a linked program on WORKER threads. The main thread
// only stalls if it asks for the result before the worker is done. So for each
// program the blocking cost should be roughly
//     stall  ~=  max(0, compileCost - backgroundTimeAvailable)
// where backgroundTimeAvailable = (first time three asked) - (link time).
//
// If that relation holds, the fix is NOT "compile less" and NOT "flush
// eagerly" (firstuseprobe --flush proved eager flushing costs 38s). The fix is
// "LINK EVERYTHING EARLY, ASK LATE" — i.e. renderer.compileAsync(), or
// compile() followed by real work before anything is drawn.
//
// This probe tags every program at link time, then attributes each blocking
// first-use query back to its program and reports the lag it was given.
//
// Usage: node tools/compilelag.mjs "<url>"
import { chromium } from "playwright";

const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const CL = { phase: "boot", rows: [], links: [] };
  window.__CL = CL;
  const linkedAt = new WeakMap();
  const firstUse = new WeakSet();

  function patch(proto) {
    if (!proto || proto.__clPatched) return;
    proto.__clPatched = true;

    const rawLink = proto.linkProgram;
    proto.linkProgram = function (program) {
      const r = rawLink.call(this, program);
      linkedAt.set(program, performance.now());
      let stack = "";
      try { stack = (new Error().stack || "").split("\n").slice(2, 5).map((s) => s.trim()).join(" <- "); } catch { /* noop */ }
      CL.links.push({ phase: CL.phase, t: +performance.now().toFixed(0), stack });
      return r;
    };

    // The first query against a program is the one that blocks on the driver.
    const record = (program, fn, t0, dt) => {
      if (!program || firstUse.has(program)) return;
      firstUse.add(program);
      const lt = linkedAt.get(program);
      if (lt === undefined) return;
      let stack = "";
      try { stack = (new Error().stack || "").split("\n").slice(2, 6).map((s) => s.trim()).join(" <- "); } catch { /* noop */ }
      CL.rows.push({ phase: CL.phase, fn, t: +t0.toFixed(0), lagMs: +(t0 - lt).toFixed(1), stallMs: +dt.toFixed(1), stack });
    };
    for (const fn of ["getProgramParameter", "getProgramInfoLog"]) {
      const raw = proto[fn];
      if (typeof raw !== "function") continue;
      proto[fn] = function (program, ...rest) {
        const t0 = performance.now();
        const r = raw.call(this, program, ...rest);
        record(program, fn, t0, performance.now() - t0);
        return r;
      };
    }
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
}));

const phase = (p) => page.evaluate((v) => { window.__CL.phase = v; }, p);
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await phase("prewarm");
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done");
}, { timeout: 180000 }).catch(() => {});
await phase("runtime");
await page.waitForTimeout(3000);
for (const k of ["w", "d", "s", "a"]) { await page.keyboard.down(k); await page.waitForTimeout(1200); await page.keyboard.up(k); }
for (let i = 0; i < 5; i++) {
  for (const k of [" ", "Shift", "q", "c", "f", "x"]) {
    await page.keyboard.press(k === " " ? "Space" : k).catch(() => {});
    await page.waitForTimeout(150);
  }
}
await page.waitForTimeout(2000);

const out = await page.evaluate(() => window.__CL);
await browser.close();

console.log(`\nlinkProgram calls: ${out.links.length}  (${["boot", "prewarm", "runtime"].map((p) => `${p}=${out.links.filter((l) => l.phase === p).length}`).join(" ")})`);
console.log(`programs observed at first use: ${out.rows.length}  (${["boot", "prewarm", "runtime"].map((p) => `${p}=${out.rows.filter((r) => r.phase === p).length}`).join(" ")})`);
console.log(`\n=== WHO LINKS (top callers of linkProgram) ===`);
{
  const s = {};
  for (const l of out.links) s[l.stack || "?"] = (s[l.stack || "?"] || 0) + 1;
  for (const [k, n] of Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`  n=${n}  ${k}`);
}
const bucket = (r) => r.lagMs < 1 ? "a: <1ms lag (asked immediately)"
  : r.lagMs < 10 ? "b: 1-10ms lag"
  : r.lagMs < 100 ? "c: 10-100ms lag"
  : r.lagMs < 1000 ? "d: 0.1-1s lag"
  : "e: >1s lag (plenty of background time)";

const groups = {};
for (const r of out.rows) (groups[bucket(r)] ||= []).push(r);
const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;

console.log(`\n=== STALL vs BACKGROUND-COMPILE TIME AVAILABLE ===`);
console.log(`(lag = ms between linkProgram and the first query that needs the result)`);
for (const k of Object.keys(groups).sort()) {
  const g = groups[k];
  const st = g.map((r) => r.stallMs);
  console.log(`  ${k.padEnd(38)} n=${String(g.length).padStart(3)}  medianStall=${med(st).toFixed(1)}ms  maxStall=${Math.max(...st).toFixed(0)}ms  totalStall=${st.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
}

console.log(`\n=== BY PHASE ===`);
for (const p of ["boot", "prewarm", "runtime"]) {
  const g = out.rows.filter((r) => r.phase === p);
  if (!g.length) continue;
  const st = g.map((r) => r.stallMs);
  console.log(`  ${p.padEnd(9)} n=${String(g.length).padStart(3)}  totalStall=${st.reduce((a, b) => a + b, 0).toFixed(0)}ms  medianLag=${med(g.map((r) => r.lagMs)).toFixed(1)}ms  worstStall=${Math.max(...st).toFixed(0)}ms`);
}
const rt = out.rows.filter((r) => r.phase === "runtime");
console.log(`\nruntime first-uses: ${rt.length}, spread over t=${rt[0]?.t}ms .. ${rt[rt.length - 1]?.t}ms of page time`);

console.log(`\n=== WHO ASKS FIRST (callers of the blocking query) ===`);
const stacks = {};
for (const r of out.rows) {
  const k = r.stack || "(none)";
  (stacks[k] ||= { n: 0, ms: 0 });
  stacks[k].n++; stacks[k].ms += r.stallMs;
}
for (const [k, v] of Object.entries(stacks).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)) {
  console.log(`  n=${v.n} totalStall=${v.ms.toFixed(0)}ms\n     ${k}`);
}
