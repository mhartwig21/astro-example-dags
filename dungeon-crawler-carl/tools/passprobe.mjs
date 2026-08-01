// Pass-ablation profiler. Same real-GPU setup as gpuprobe.mjs (headed Chromium,
// ANGLE D3D11, vsync off) but additionally reads the PERFSTATS counters the
// instrumented scratch build exposes on window.__perf, so each sample reports
// BOTH the rAF frame time (authoritative) and the CPU split (update vs render
// submission vs canopy) plus real per-frame draw calls / triangles.
//
// Draw calls are meaningful here only because the scratch build sets
// renderer.info.autoReset = false and resets once per frame: with autoReset on,
// info.render is clobbered by the LAST composer pass, which is why the stock
// gpuprobe reports calls=1 tris=1.
//
// Usage: node tools/passprobe.mjs "<url>" [--seconds 5]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2];
const seconds = Number(flag("--seconds", 5));
const width = Number(flag("--w", 1920));
const height = Number(flag("--h", 1080));
if (!url) { console.error("need a url"); process.exit(1); }

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
if (!/Intel|D3D11/.test(gpu)) { console.error("REFUSING: not a real GPU:", gpu); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);

const sample = async (label) => {
  const r = await page.evaluate((secs) => new Promise((resolve) => {
    const S = window.__perf.PERFSTATS;
    const base = { ...S };
    const frames = [];
    let last = performance.now();
    const start = last;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (now - start < secs * 1000) requestAnimationFrame(tick);
      else {
        const n = Math.max(1, S.frames - base.frames);
        frames.sort((a, b) => a - b);
        const q = (p) => +frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(2);
        resolve({
          n: frames.length,
          medianMs: q(0.5), p95Ms: q(0.95), worstMs: +frames[frames.length - 1].toFixed(1),
          fps: +(1000 / q(0.5)).toFixed(1),
          cpuUpdateMs: +((S.aUpdate - base.aUpdate) / n).toFixed(2),
          cpuRenderMs: +((S.aRender - base.aRender) / n).toFixed(2),
          cpuCanopyMs: +((S.aCanopy - base.aCanopy) / n).toFixed(3),
          calls: Math.round((S.calls - base.calls) / n),
          tris: Math.round((S.tris - base.tris) / n),
        });
      }
    };
    requestAnimationFrame(tick);
  }), seconds);
  console.log(label, JSON.stringify(r));
  return r;
};

const idle = await sample("IDLE   ");
await page.keyboard.down("w");
const moving = await sample("MOVING ");
await page.keyboard.up("w");
for (const k of ["Space", "Shift", "q", "c", "f"]) { await page.keyboard.press(k).catch(() => {}); }
const combat = await sample("COMBAT ");
console.log("RESULT " + JSON.stringify({ url, idle, moving, combat }));
await browser.close();
