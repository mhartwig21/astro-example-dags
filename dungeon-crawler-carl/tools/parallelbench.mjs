// PARALLEL-COMPILE BENCH — does deferring the query actually make it free?
//
// compilelag proved every program in this app is queried within ~0.1ms of
// being linked, so the main thread eats the whole ANGLE GLSL->HLSL->D3D
// compile serially (13s during prewarm, 25s during play in that run).
//
// The proposed fix is "link everything, then ask later". That is only worth
// anything if ANGLE really compiles on worker threads. batchflush hinted so
// (122/122 COMPLETION_STATUS ready at lift) but could not prove it, because
// those programs had already been flushed by prewarm's render.
//
// This bench settles it, using the app's OWN heaviest shader pair, harvested
// live from the running page. Each clone gets a unique #define so no driver or
// three-level program cache can serve it.
//
//   A) SERIAL   link, then immediately query LINK_STATUS. N times.
//   B) DEFERRED link all N, then poll COMPLETION_STATUS_KHR (non-blocking)
//               until every one reports done, then query.
//
// If B's blocking time collapses while total wall time stays near A/cores,
// the compile genuinely runs in parallel and the fix is real.
//
// Usage: node tools/parallelbench.mjs "<url>" [--n 16]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const N = Number(flag("--n", 16));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Harvest the real shader sources of the biggest program the app builds.
await page.addInitScript(() => {
  window.__SRC = null;
  const patch = (proto) => {
    if (!proto || proto.__pbPatched) return;
    proto.__pbPatched = true;
    const raw = proto.linkProgram;
    proto.linkProgram = function (program) {
      try {
        const shaders = this.getAttachedShaders(program) || [];
        const srcs = shaders.map((s) => this.getShaderSource(s) || "");
        const total = srcs.reduce((a, s) => a + s.length, 0);
        if (srcs.length === 2 && (!window.__SRC || total > window.__SRC.total)) {
          const vert = srcs.find((s) => /gl_Position/.test(s)) || srcs[0];
          const frag = srcs.find((s) => s !== vert) || srcs[1];
          window.__SRC = { vert, frag, total };
        }
      } catch { /* noop */ }
      return raw.call(this, program);
    };
  };
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
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
await page.waitForTimeout(3000);

const res = await page.evaluate(async (n) => {
  const S = window.__SRC;
  if (!S) return { error: "no shader source harvested" };
  // Fresh context so we never disturb the game's renderer.
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  const mk = (src, type, tag) => {
    // Unique token defeats every level of program caching.
    const tagged = src.replace(/^#version 300 es\r?\n/, `#version 300 es\n#define PBTAG_${tag} 1\n`);
    const sh = gl.createShader(type);
    gl.shaderSource(sh, tagged.includes("PBTAG") ? tagged : `#define PBTAG_${tag} 1\n` + src);
    gl.compileShader(sh);
    return sh;
  };
  const build = (tag) => {
    const p = gl.createProgram();
    gl.attachShader(p, mk(S.vert, gl.VERTEX_SHADER, tag));
    gl.attachShader(p, mk(S.frag, gl.FRAGMENT_SHADER, tag));
    gl.linkProgram(p);
    return p;
  };

  // --- A) SERIAL: link then immediately demand the result ---
  let serialBlock = 0;
  const tA0 = performance.now();
  for (let i = 0; i < n; i++) {
    const p = build(`S${i}_${Math.random().toString(36).slice(2)}`);
    const q0 = performance.now();
    gl.getProgramParameter(p, gl.LINK_STATUS);
    serialBlock += performance.now() - q0;
  }
  const serialWall = performance.now() - tA0;

  // --- B) DEFERRED: link all, poll non-blockingly, then demand ---
  const tB0 = performance.now();
  const progs = [];
  for (let i = 0; i < n; i++) progs.push(build(`D${i}_${Math.random().toString(36).slice(2)}`));
  const linkWall = performance.now() - tB0;

  let pollWall = 0;
  if (ext) {
    const pollStart = performance.now();
    // Yield to the event loop between polls so ANGLE's worker threads run.
    for (;;) {
      let ready = 0;
      for (const p of progs) if (gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) ready++;
      if (ready === progs.length) break;
      if (performance.now() - pollStart > 30000) break;
      await new Promise((r) => setTimeout(r, 8));
    }
    pollWall = performance.now() - pollStart;
  }
  let deferredBlock = 0;
  const q0 = performance.now();
  for (const p of progs) gl.getProgramParameter(p, gl.LINK_STATUS);
  deferredBlock = performance.now() - q0;

  return {
    n, hasExt: !!ext, bytes: S.total,
    serialWall: +serialWall.toFixed(0), serialBlock: +serialBlock.toFixed(0),
    linkWall: +linkWall.toFixed(0), pollWall: +pollWall.toFixed(0),
    deferredBlock: +deferredBlock.toFixed(1),
    deferredWall: +(linkWall + pollWall + deferredBlock).toFixed(0),
  };
}, N);

await browser.close();

if (res.error) { console.error(res.error); process.exit(1); }
console.log(`\nshader pair harvested from the app: ${(res.bytes / 1024).toFixed(0)}KB of GLSL, KHR_parallel_shader_compile=${res.hasExt}`);
console.log(`\nA) SERIAL   (link -> query immediately), n=${res.n}`);
console.log(`     main-thread BLOCKED: ${res.serialBlock}ms      wall: ${res.serialWall}ms   (${(res.serialBlock / res.n).toFixed(0)}ms blocked per program)`);
console.log(`\nB) DEFERRED (link all -> yield -> query), n=${res.n}`);
console.log(`     link phase:          ${res.linkWall}ms`);
console.log(`     yielded poll phase:  ${res.pollWall}ms  (main thread FREE, ANGLE worker threads compiling)`);
console.log(`     main-thread BLOCKED: ${res.deferredBlock}ms      wall: ${res.deferredWall}ms`);
console.log(`\n  >>> main-thread blocking reduced ${res.serialBlock}ms -> ${res.deferredBlock}ms  (${(res.serialBlock / Math.max(0.1, res.deferredBlock)).toFixed(0)}x)`);
console.log(`  >>> total wall ${res.serialWall}ms -> ${res.deferredWall}ms (${(res.serialWall / Math.max(1, res.deferredWall)).toFixed(2)}x) — parallelism across cores`);
