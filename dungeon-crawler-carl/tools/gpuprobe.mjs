// Real-GPU frame profiler. Unlike shot.mjs/perfprobe.mjs (SwiftShader software
// GL), this asks Chromium for hardware ANGLE/D3D11 so frame times mean
// something. Verifies the unmasked renderer string before trusting numbers.
//
// Usage: node tools/gpuprobe.mjs [url] [--seconds 8] [--w 1920] [--h 1080]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : "http://localhost:5285/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 8));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
// THE TARGET DISPLAY IS HiDPI. Measured on the owner's machine: devicePixelRatio
// 2 on a 1440x900 screen — so a "1440x852" canvas rasterizes 2880x1704 (~4.9M
// px), 2.4x the pixels of a naive 1920x1080 DPR-1 probe. Renderer3D calls
// setPixelRatio(min(devicePixelRatio, 2)), so this is what the player pays.
// Profiling at DPR 1 measures a machine nobody owns; default to the real thing.
const dpr = Number(flag("--dpr", 2));

const browser = await chromium.launch({
  headless: false, // headless-new still routes through SwiftShader on many boxes
  args: [
    "--use-angle=d3d11",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--disable-frame-rate-limit", // uncapped so we measure cost, not vsync
    "--disable-gpu-vsync",
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { renderer: "NO WEBGL" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "unknown",
  };
});
console.log("GPU:", JSON.stringify(gpu));

// Wait for the loading screen to release the game.
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);

// DRAW-CALL ACCOUNTING (this probe used to report "calls: 1").
// three.js resets renderer.info at the START of every WebGLRenderer.render().
// The composed frame is ~21 of those calls, and the LAST one is a single
// fullscreen output quad — so reading info after composer.render() reports
// that quad and nothing else. Disable autoReset and accumulate across the
// whole composed frame instead, then divide by frames to get the real number.
await page.evaluate(() => {
  const r3d = window.__dcc?.renderer;
  const gl = r3d?.renderer;
  if (!r3d || !gl?.info) return;
  gl.info.autoReset = false;
  const acc = { calls: 0, tris: 0, frames: 0 };
  window.__frameAcc = acc;
  const orig = r3d.render.bind(r3d);
  r3d.render = function () {
    gl.info.reset();
    orig();
    acc.calls += gl.info.render.calls;
    acc.tris += gl.info.render.triangles;
    acc.frames++;
  };
});

const sample = async (label) => {
  const r = await page.evaluate((secs) => new Promise((resolve) => {
    const frames = [];
    const acc = window.__frameAcc;
    const c0 = acc ? acc.calls : 0, t0 = acc ? acc.tris : 0, f0 = acc ? acc.frames : 0;
    let last = performance.now();
    const start = last;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (now - start < secs * 1000) requestAnimationFrame(tick);
      else {
        frames.sort((a, b) => a - b);
        const info = window.__dcc?.renderer?.renderer?.info ?? window.__dcc?.renderer?.info;
        const df = acc ? acc.frames - f0 : 0;
        resolve({
          frames: frames.length,
          medianMs: +frames[Math.floor(frames.length / 2)].toFixed(2),
          p95Ms: +frames[Math.floor(frames.length * 0.95)].toFixed(2),
          worstMs: +frames[frames.length - 1].toFixed(2),
          fps: +(1000 / frames[Math.floor(frames.length / 2)]).toFixed(1),
          // per COMPOSED frame, summed over every pass (see the note above)
          calls: df ? Math.round((acc.calls - c0) / df) : null,
          ktris: df ? Math.round((acc.tris - t0) / df / 1000) : null,
          programs: info?.programs?.length ?? null,
        });
      }
    };
    requestAnimationFrame(tick);
  }), seconds);
  console.log(label, JSON.stringify(r));
  return r;
};

const idle = await sample("IDLE   ");
// Move + fight: walking loads streaming/dressing, casting loads FX.
await page.keyboard.down("w");
const moving = await sample("MOVING ");
await page.keyboard.up("w");
for (const k of ["Space", "q", "c"]) { await page.keyboard.press(k).catch(() => {}); }
const fighting = await sample("COMBAT ");

console.log(JSON.stringify({ gpu, idle, moving, fighting }, null, 1));
await browser.close();
