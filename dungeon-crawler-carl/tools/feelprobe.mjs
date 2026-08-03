// FEEL PROBE — the things the owner feels and stills cannot show, as numbers.
//
// Modes:
//   node tools/feelprobe.mjs latency <url>
//     Input-to-motion latency: an in-page keydown listener stamps t0 the
//     moment the key arrives; a rAF loop stamps t1 on the first frame the
//     player's sim position has moved. Reports median/worst over N trials.
//     (Visual latency adds <=1-2 compositor frames on top; this measures the
//     input->sim->render-loop path where regressions actually happen.)
//
//   node tools/feelprobe.mjs bosscam <url>
//     THE PLAYER IS NEVER LOST: triggers a boss encounter, then runs the
//     player AWAY from the boss while sampling the player's projected screen
//     position every ~90ms. FAILS if the player's screen position leaves the
//     safe rect (6%..94% of the viewport) on any sample while the boss beat
//     owns the camera. This is the owner's reported bug as a regression test.
//     <url> should be a boss floor, e.g. ?test&floor=3&level=8&abilities=all
//     &seed=7&debug=1&eagerassets&clean=1
//
// Both modes: real GPU, boot-gate enforced, page errors reported.
import { chromium } from "playwright";

const [, , MODE, URL_ARG] = process.argv;
if (!MODE || !URL_ARG) {
  console.error("usage: node tools/feelprobe.mjs <latency|bosscam> <url>");
  process.exit(2);
}

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(URL_ARG, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  if (!el || el.classList.contains("done")) return true;
  const cs = getComputedStyle(el);
  return cs.display === "none" || parseFloat(cs.opacity) === 0;
}, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);

const hookOk = await page.evaluate(() => !!window.__dcc?.state?.players?.length);
if (!hookOk) {
  console.error("FAIL: window.__dcc not available — add &debug=1 to the url.");
  await browser.close();
  process.exit(1);
}

// Minimal world->screen projection using the renderer's own camera matrices
// (column-major elements; NDC -> css pixels). Injected once, both modes use it.
await page.evaluate(() => {
  window.__feelProject = (wx, wy, wz) => {
    const r = window.__dcc.renderer;
    const cam = r?.camera;
    if (!cam) return null;
    cam.updateMatrixWorld?.();
    const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    // view = V * world
    const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
    const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
    const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
    const vw = v[3] * wx + v[7] * wy + v[11] * wz + v[15];
    // clip = P * view
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
    const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
    if (!cw) return null;
    const ndcX = cx / cw, ndcY = cy / cw;
    return { x: (ndcX * 0.5 + 0.5) * innerWidth, y: (-ndcY * 0.5 + 0.5) * innerHeight };
  };
});

if (MODE === "latency") {
  const trials = [];
  for (let t = 0; t < 8; t++) {
    const key = t % 2 === 0 ? "d" : "a"; // alternate so the crawler shuttles
    await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      window.__lat = { t0: 0, t1: 0, sx: p.pos.x, sy: p.pos.y, done: false };
      const onKey = (e) => { if (!window.__lat.t0) { window.__lat.t0 = performance.now(); } removeEventListener("keydown", onKey, true); };
      addEventListener("keydown", onKey, true);
      const tick = () => {
        const L = window.__lat, pl = window.__dcc.state.players[0];
        if (L.t0 && !L.done && (Math.abs(pl.pos.x - L.sx) > 1e-4 || Math.abs(pl.pos.y - L.sy) > 1e-4)) { L.t1 = performance.now(); L.done = true; return; }
        if (!L.done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.down(key);
    await page.waitForTimeout(450);
    await page.keyboard.up(key);
    const r = await page.evaluate(() => window.__lat);
    if (r.done) trials.push(Number((r.t1 - r.t0).toFixed(1)));
    await page.waitForTimeout(200);
  }
  trials.sort((a, b) => a - b);
  const median = trials[Math.floor(trials.length / 2)] ?? null;
  const verdict = median === null ? "NO SAMPLES" : median <= 50 ? "GOOD (<=50ms)" : median <= 90 ? "NOTICEABLE (50-90ms)" : "BAD (>90ms — input feels laggy)";
  console.log(JSON.stringify({ mode: "latency", trials, medianMs: median, worstMs: trials.at(-1) ?? null, verdict, pageErrors }, null, 2));
  await browser.close();
  process.exit(median !== null && median <= 90 ? 0 : 1);
}

if (MODE === "bosscam") {
  // Find the boss, walk the player INTO the arena to trigger the beat, then
  // run AWAY while sampling projected player position.
  const setup = await page.evaluate(() => {
    const s = window.__dcc.state;
    const boss = s.monsters.find((m) => m.kind === "boss");
    if (!boss) return { ok: false, why: "no boss on this floor" };
    const p = s.players[0];
    // drop the player near the boss (just outside melee) to trigger the intro
    p.pos.x = boss.pos.x + 6; p.pos.y = boss.pos.y + 6;
    return { ok: true, boss: { x: boss.pos.x, y: boss.pos.y } };
  });
  if (!setup.ok) {
    console.error(`FAIL: ${setup.why}`);
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(1800); // let the intro/beat begin and take the camera

  // Run away (down-right in screen terms) for 4s, sampling as we go.
  const samples = [];
  page.keyboard.down("s").catch(() => {});
  page.keyboard.down("d").catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const s = await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const scr = window.__feelProject(p.pos.x, 0.8, p.pos.y);
      const bossAlive = st.monsters.some((m) => m.kind === "boss" && m.hp > 0);
      return scr ? { x: Math.round(scr.x), y: Math.round(scr.y), bossAlive } : null;
    });
    if (s) samples.push(s);
    await page.waitForTimeout(90);
  }
  await page.keyboard.up("s").catch(() => {});
  await page.keyboard.up("d").catch(() => {});

  const W = 1280, H = 720, mx = W * 0.06, my = H * 0.06;
  const out = samples.filter((s) => s.x < mx || s.x > W - mx || s.y < my || s.y > H - my);
  const worst = samples.reduce((w, s) => {
    const d = Math.max(mx - s.x, s.x - (W - mx), my - s.y, s.y - (H - my));
    return d > w.d ? { d, s } : w;
  }, { d: -1e9, s: null });
  const shot = "tools/_feel_bosscam.jpg";
  await page.screenshot({ path: shot, type: "jpeg", quality: 82 });
  console.log(JSON.stringify({
    mode: "bosscam", samples: samples.length, offscreenSamples: out.length,
    worstExcursionPx: Math.round(worst.d), worstSample: worst.s, frame: shot, pageErrors,
  }, null, 2));
  console.log(out.length === 0
    ? "PASS: the player never left the safe rect during the boss beat."
    : `FAIL: player off the safe rect in ${out.length}/${samples.length} samples — the owner's 'get lost during a boss' bug is live.`);
  await browser.close();
  process.exit(out.length === 0 ? 0 : 1);
}

console.error(`unknown mode: ${MODE}`);
await browser.close();
process.exit(2);
