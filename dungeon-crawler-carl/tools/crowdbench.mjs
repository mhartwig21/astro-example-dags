// MONSTER-DENSE, DETERMINISTIC FRAME BENCH. drawcensus/floorbench drive the
// game with keystrokes, so how many monsters are alive and on screen at sample
// time varies run to run by 4x — which is more than the effect being measured.
//
// This stages the SAME frame every time: teleport N live monsters into a ring
// around the player (the beautyshot crowd trick), halt the host loop, then run
// update+render in a tight loop with a fixed clock. Draw calls are then a fixed
// number, not a distribution, and the per-frame CPU is directly comparable
// between two builds.
//
// Usage: node tools/crowdbench.mjs "<baseUrl>" [--ring 16] [--iters 400] [--reps 3]
//                                  [--floor 8] [--w 640 --h 360]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = (process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:5291").replace(/\/$/, "");
const ring = Number(flag("--ring", 16));
const iters = Number(flag("--iters", 400));
const reps = Number(flag("--reps", 3));
const floor = flag("--floor", "8");
const width = Number(flag("--w", 640));
const height = Number(flag("--h", 360));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${base}/iso.html?test&floor=${floor}&level=16&seed=41&abilities=all&debug=1&eagerassets`, { waitUntil: "load", timeout: 120000 });
const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu, `@ ${width}x${height} ring=${ring}`);
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(3000);

const staged = await page.evaluate((ring) => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const mapW = st.map.w;
  const okVal = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  // Big silhouettes first, same ordering rule beautyshot uses.
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0 && m.kind !== "boss");
  live.sort((a, b) => (a.kind === "swarmer" ? 1 : 0) - (b.kind === "swarmer" ? 1 : 0));
  const spots = [];
  for (let ri = 0; ri < 5 && spots.length < ring; ri++) {
    const r = 1.4 + ri * 0.8;
    for (let k = 0; k < 16 && spots.length < ring; k++) {
      const a = (k / 16) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== okVal) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.85)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.hp = m.maxHp || m.hp; m.dormant = false; });
  return { placed: used.length, liveTotal: live.length };
}, ring);
console.log("staged", JSON.stringify(staged));

// Let the renderer build meshes for the newly-arrived crowd, then halt the host
// loop so nothing but our own render calls touch the GPU.
await page.waitForTimeout(2500);
await page.evaluate(() => new Promise((resolve) => {
  const raf = window.requestAnimationFrame.bind(window);
  raf(() => raf(() => {
    window.requestAnimationFrame = () => 0;
    const R = window.__dcc.renderer;
    R.renderer.info.autoReset = false;
    window.__cb = { R, st: window.__dcc.state, t: performance.now() / 1000 };
    resolve();
  }));
}));

const run = (iters) => page.evaluate((iters) => {
  const { R, st, t } = window.__cb;
  const gl = R.renderer;
  const times = [];
  let calls = 0, tris = 0;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    R.update(st, t);          // fixed clock: identical work every iteration
    gl.info.reset();
    R.render();
    times.push(performance.now() - t0);
    calls += gl.info.render.calls; tris += gl.info.render.triangles;
  }
  times.sort((a, b) => a - b);
  return {
    cpuFrameMs: +times[Math.floor(times.length / 2)].toFixed(2),
    p10: +times[Math.floor(times.length * 0.1)].toFixed(2),
    callsPerFrame: Math.round(calls / iters),
    ktris: Math.round(tris / iters / 1000),
    programs: gl.info.programs.length,
  };
}, iters);

await run(60); // warm caches / let any last program link settle

// --shot: save the staged frame. Two builds staged identically produce two
// directly comparable pictures, which is the only honest way to prove a
// geometry change (rig welding) did not alter what the player sees.
const shotPath = (() => { const i = process.argv.indexOf("--shot"); return i >= 0 ? process.argv[i + 1] : null; })();
if (shotPath) {
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__cb.R.render(); });
  await page.screenshot({ path: shotPath });
  console.log("shot", shotPath);
}
const out = [];
for (let i = 0; i < reps; i++) { const r = await run(iters); out.push(r); console.log(`rep${i}`, JSON.stringify(r)); }
const med = (k) => { const v = out.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log("CROWDBENCH " + JSON.stringify({
  base, ring, placed: staged.placed,
  cpuFrameMs: med("cpuFrameMs"), p10: med("p10"),
  callsPerFrame: med("callsPerFrame"), ktris: med("ktris"), programs: out[out.length - 1].programs,
}));
await browser.close();
