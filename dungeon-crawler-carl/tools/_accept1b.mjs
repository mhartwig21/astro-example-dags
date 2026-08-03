// ACCEPTANCE ROUND 1, PART B — the COST number, taken on an IDLE box.
//
// Part A's window was contaminated (15 foreign browser processes burning 55.8%
// of the machine) and its crowd staging was wrong in the other direction: with
// every monster immortal, all 200 on the floor converged and the "dense scene"
// became 83-103 mobs inside 10 tiles, which no real pull produces. Both are
// fixed here:
//
//  * IDLE GATE before every measured window (tools/_boxload.mjs), and the
//    foreign load is re-probed AFTER the window and reported with the number.
//    A window that ran dirty is labelled as such rather than published.
//  * DENSITY IS HELD, NOT INFLATED. A pump keeps at most CROWD live monsters
//    inside the ring and pushes the surplus out dormant, so the scene stays a
//    dense late-floor pull instead of growing without bound.
//  * TWO windows: a NATURAL floor-17 fight (no staging at all) and the staged
//    dense pull. The contract is read off the worse one.
//  * vsync ON, preset NOT pinned, preset + effective pixel ratio sampled every
//    frame, draw calls accumulated per frame (info.autoReset off).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_accept1");
const W = 1440, H = 852, DPR = 2;
const SECONDS = Number(flag("--seconds", 20));
const CROWD = Number(flag("--crowd", 22));
mkdirSync(outDir, { recursive: true });

const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const url = `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`;
await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.bringToFront();

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
  const w = window;
  if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
  return (w.__ph || 0) >= 12;
}, { timeout: 120000, polling: 100 }).catch(() => {});
await page.waitForTimeout(3000);
const box = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
});
if (box && box.w > 0 && box.display !== "none" && box.opacity > 0.01) { say("BOOT CARD UP — MISSED"); await browser.close(); process.exit(1); }

const gameGpu = await page.evaluate(() => {
  const ctx = window.__dcc.renderer.renderer.getContext();
  const d = ctx.getExtension("WEBGL_debug_renderer_info");
  return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
say("GAME CONTEXT GPU:", gameGpu);
if (!/Intel/i.test(gameGpu) || /SwiftShader|llvmpipe/i.test(gameGpu)) { say("REFUSING: not the iGPU"); await browser.close(); process.exit(1); }

// Per-frame draw-call truth: three.js resets info at every render() call and the
// composer calls it once per pass, so the value read after a frame is the last
// fullscreen quad. Turn autoReset off and reset once per composed frame.
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  R.renderer.info.autoReset = false;
  const comp = R.composer;
  const orig = comp.render.bind(comp);
  window.__lastInfo = { calls: 0, tris: 0 };
  comp.render = function (...a) {
    try { return orig(...a); } finally {
      window.__lastInfo = { calls: R.renderer.info.render.calls, tris: R.renderer.info.render.triangles };
      R.renderer.info.reset();
    }
  };
});

await page.keyboard.down("w"); await page.waitForTimeout(1800); await page.keyboard.up("w");

const fireLoop = async (ms) => {
  const keys = ["Space", "Shift", "q", "c", "f"];
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) {
    await page.keyboard.press(keys[i++ % keys.length], { delay: 40 });
    await page.waitForTimeout(150);
  }
};

const record = (seconds) => page.evaluate((s) => {
  const w = window;
  w.__acc = { dt: [], preset: [], px: [], near: [], calls: [], tris: [], done: false };
  const R = w.__dcc.renderer;
  let last = 0; const t0 = performance.now();
  const tick = (t) => {
    if (last) {
      const st = w.__dcc.state, p = st.players[0];
      w.__acc.dt.push(t - last);
      w.__acc.preset.push(R.qualityProfile?.name ?? "?");
      w.__acc.px.push(R.renderer.getPixelRatio());
      w.__acc.near.push(st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length);
      w.__acc.calls.push(w.__lastInfo.calls); w.__acc.tris.push(w.__lastInfo.tris);
    }
    last = t;
    if (performance.now() - t0 < s * 1000) requestAnimationFrame(tick); else w.__acc.done = true;
  };
  requestAnimationFrame(tick);
}, seconds);

const harvest = () => page.evaluate(() => {
  const a = window.__acc;
  const dt = a.dt.slice(10);
  const s = [...dt].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const med = (arr) => { const b = [...arr].sort((x, y) => x - y); return b[b.length >> 1]; };
  const hist = {}; for (const p of a.preset) hist[p] = (hist[p] || 0) + 1;
  const pxh = {}; for (const p of a.px) pxh[p.toFixed(2)] = (pxh[p.toFixed(2)] || 0) + 1;
  const near = a.near.slice(10), calls = a.calls.slice(10);
  return {
    frames: dt.length, fps: +(1000 / q(0.5)).toFixed(1),
    median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
    mean: +(dt.reduce((x, y) => x + y, 0) / dt.length).toFixed(2),
    over16_7: +((dt.filter((d) => d > 16.7).length / dt.length) * 100).toFixed(1),
    over20: +((dt.filter((d) => d > 20).length / dt.length) * 100).toFixed(1),
    over33: +((dt.filter((d) => d > 33).length / dt.length) * 100).toFixed(1),
    presetHist: hist, pxHist: pxh,
    nearMin: Math.min(...near), nearMed: med(near), nearMax: Math.max(...near),
    callsMed: med(calls), trisMed: med(a.tris.slice(10)),
  };
});

const out = { gameGpu, windows: {} };

// ---------------------------------------------- WINDOW 1: natural f17 fight
say("\n== WINDOW 1: natural floor-17 fight, nothing staged");
await waitForIdle("window 1", { log: say });
let before = probeLoad(process.pid);
await record(SECONDS);
await fireLoop(SECONDS * 1000 + 400);
await page.waitForFunction(() => window.__acc.done, { timeout: 60000 });
await page.screenshot({ path: `${outDir}/perf_w1_natural.png` });
let after = probeLoad(process.pid);
out.windows.natural = await harvest();
out.windows.natural.foreignLoadPct = foreignLoadPct(before, after);
say("NATURAL:", JSON.stringify(out.windows.natural));

// ------------------------------------ WINDOW 2: staged dense pull, held at N
say(`\n== WINDOW 2: staged dense pull, held at <=${CROWD} live mobs in the ring`);
const staged = await page.evaluate(({ ring, crowd }) => {
  const st = window.__dcc.state, p = st.players[0], mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 6 && spots.length < ring; ri++) {
    const r = 1.7 + ri * 0.85;
    for (let k = 0; k < 18 && spots.length < ring; k++) {
      const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });

  // HOLD the density. The nearest `crowd` stay alive and topped up so the fight
  // lasts the window; everything else inside 14 tiles is pushed back out and
  // put to sleep, so the room cannot snowball into a 100-mob pile that no real
  // pull produces.
  const hold = () => {
    try {
      const s2 = window.__dcc.state, pl = s2.players[0];
      const near = s2.monsters
        .filter((m) => m.hp > 0)
        .map((m) => ({ m, d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) }))
        .sort((a, b) => a.d - b.d);
      near.forEach((e, i) => {
        if (i < crowd) { e.m.maxHp = Math.max(e.m.maxHp || 1, 5e5); e.m.hp = 5e5; e.m.dormant = false; }
        else if (e.d < 14) { e.m.dormant = true; const ang = Math.atan2(e.m.pos.y - pl.pos.y, e.m.pos.x - pl.pos.x); e.m.pos.x = pl.pos.x + Math.cos(ang) * 22; e.m.pos.y = pl.pos.y + Math.sin(ang) * 22; }
      });
    } catch { /* */ }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
  return { placed: used.length, liveTotal: live.length };
}, { ring: CROWD, crowd: CROWD });
say("staged:", JSON.stringify(staged));
await page.waitForTimeout(2500);

await waitForIdle("window 2", { log: say });
before = probeLoad(process.pid);
await record(SECONDS);
await fireLoop(SECONDS * 1000 + 400);
await page.waitForFunction(() => window.__acc.done, { timeout: 60000 });
await page.screenshot({ path: `${outDir}/perf_w2_dense.png` });
await page.screenshot({ path: `${outDir}/perf_w2_dense_zoom.png`, clip: { x: 470, y: 210, width: 500, height: 330 } });
after = probeLoad(process.pid);
out.windows.dense = await harvest();
out.windows.dense.foreignLoadPct = foreignLoadPct(before, after);
say("DENSE:", JSON.stringify(out.windows.dense));

const claim = await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  const up = (id) => { const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && cs.display !== "none" && Number(cs.opacity) > 0.01; };
  return { hp: Math.min(p.hp, 9e5), near: st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length, recapUp: up("recap"), introUp: up("bossintro"), cine: document.body.classList.contains("cine") };
});
say("dense proof claim:", JSON.stringify(claim));
out.denseClaim = claim;

writeFileSync(`${outDir}/accept1b.json`, JSON.stringify(out, null, 2));
writeFileSync(`${outDir}/accept1b.log`, log.join("\n"));
await browser.close();
say("\ndone.");
