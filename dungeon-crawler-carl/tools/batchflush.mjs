// BATCH-FLUSH PROBE — is a COMPLETE prewarm affordable?
//
// The fix for the runtime hitches is "link + flush every program behind the
// loading screen". firstuseprobe --flush showed that flushing SERIALLY,
// immediately after each linkProgram, costs 38s — unshippable.
//
// But ANGLE exposes KHR_parallel_shader_compile (confirmed present on this
// Intel/D3D11 box, 16 cores): after linkProgram returns, the driver keeps
// translating GLSL->HLSL and compiling on WORKER threads. The main thread only
// blocks if it asks for the result before the worker finished. So the cost of
// a flush depends entirely on WHEN you ask.
//
// This probe links normally (no per-link stall), remembers every program, and
// then flushes the whole batch at a chosen moment. Comparing that batch total
// against the 38s serial total measures how much of the compile the driver
// really does in parallel — i.e. whether a complete prewarm can be cheap.
//
// Usage: node tools/batchflush.mjs "<url>" [--wait 0]   (--wait = ms to let
//        background compilation run before flushing the batch)
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const wait = Number(flag("--wait", 0));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const BF = { pending: [], flushed: [], ctx: null };
  window.__BF = BF;
  function patch(proto) {
    if (!proto || proto.__bfPatched) return;
    proto.__bfPatched = true;
    const rawLink = proto.linkProgram;
    proto.linkProgram = function (program) {
      const r = rawLink.call(this, program);
      BF.ctx = this;
      BF.pending.push({ program, linkedAt: performance.now() });
      return r;
    };
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  // Ask the driver whether a program finished compiling WITHOUT blocking.
  window.__bfReadyCount = () => {
    const gl = BF.ctx;
    if (!gl) return { total: 0, ready: 0 };
    const ext = gl.getExtension("KHR_parallel_shader_compile");
    if (!ext) return { total: BF.pending.length, ready: -1 };
    let ready = 0;
    for (const p of BF.pending) {
      if (gl.getProgramParameter(p.program, ext.COMPLETION_STATUS_KHR)) ready++;
    }
    return { total: BF.pending.length, ready };
  };

  // Blocking flush of the whole batch: exactly what prewarm calling
  // getUniforms() on every program would cost.
  window.__bfFlush = () => {
    const gl = BF.ctx;
    if (!gl) return { n: 0, ms: 0 };
    const t0 = performance.now();
    let n = 0;
    for (const p of BF.pending) {
      gl.getProgramParameter(p.program, gl.LINK_STATUS);
      gl.getProgramInfoLog(p.program);
      n++;
    }
    const ms = performance.now() - t0;
    BF.flushed.push({ n, ms });
    BF.pending = [];
    return { n, ms: +ms.toFixed(1) };
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
}));

await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done");
}, { timeout: 180000 }).catch(() => {});
console.log("loading screen lifted");

// How many of the linked programs did the driver already finish on its own,
// with zero main-thread blocking?
const before = await page.evaluate(() => window.__bfReadyCount());
console.log(`non-blocking readiness at lift: ${before.ready}/${before.total} programs already compiled by ANGLE worker threads`);

if (wait > 0) {
  await page.waitForTimeout(wait);
  const mid = await page.evaluate(() => window.__bfReadyCount());
  console.log(`after ${wait}ms more: ${mid.ready}/${mid.total} ready`);
}

const res = await page.evaluate(() => window.__bfFlush());
console.log(`\nBATCH FLUSH of ${res.n} programs: ${res.ms}ms total (${(res.ms / Math.max(1, res.n)).toFixed(1)}ms/program)`);
console.log(`  compare: firstuseprobe --flush SERIAL (query immediately after each link) = 37947ms`);

await browser.close();
