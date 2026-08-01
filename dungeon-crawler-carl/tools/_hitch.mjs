// WHAT IS THE ONE ~100 ms FRAME AT THE START OF PLAY?
//
// Runs vsync-paced (so the reading is a real hitch, not rAF run-ahead), watches
// every composed frame for the first --seconds, and for any frame over --thresh
// prints the deltas that could explain it: three's live counters (programs,
// geometries, textures), the built-floor generation, scene object count, and
// JS heap. Also records the ~4 frames either side for context.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5322/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1");
const seconds = Number(flag("--seconds", 20));
const thresh = Number(flag("--thresh", 40));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization",
    "--js-flags=--expose-gc"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 });

const rows = await page.evaluate((cfg) => new Promise((resolve) => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const t0 = performance.now();
  const log = [];
  let last = performance.now();
  let prev = null;
  const snap = () => ({
    programs: gl.info.programs.length,
    geometries: gl.info.memory.geometries,
    textures: gl.info.memory.textures,
    calls: gl.info.render.calls,
    builtFloor: R.builtFloor,
    sceneKids: R.scene.children.length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  });
  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;
    const s = snap();
    if (dt > cfg.thresh && prev) {
      log.push({
        atMs: +(now - t0).toFixed(0), frameMs: +dt.toFixed(1),
        dPrograms: s.programs - prev.programs,
        dGeometries: s.geometries - prev.geometries,
        dTextures: s.textures - prev.textures,
        dSceneKids: s.sceneKids - prev.sceneKids,
        builtFloor: `${prev.builtFloor}->${s.builtFloor}`,
        heapMB: s.heapMB, dHeapMB: prev.heapMB === null ? null : +(s.heapMB - prev.heapMB).toFixed(1),
      });
    }
    prev = s;
    if (now - t0 < cfg.seconds * 1000) requestAnimationFrame(tick);
    else resolve(log);
  };
  requestAnimationFrame(tick);
}), { seconds, thresh });

console.log(`hitches over ${thresh}ms in the first ${seconds}s: ${rows.length}`);
for (const r of rows) console.log(" ", JSON.stringify(r));
await browser.close();
