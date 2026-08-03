// ACCEPTANCE ROUND 1, PART C — confirm the cost number, with a CONTROL.
//
// Part B measured 33.4 ms median / 66.7 ms p99 in a clean window. Before that
// is published, the harness has to prove it can SEE 60 fps: if a quiet early
// room also read 33 ms, the instrument (window occluded, panel not 60 Hz, rAF
// throttled) would be what was measured, not the game. So:
//
//   CONTROL   floor 2, standing still, no abilities   -> must approach 16.7 ms
//   NATURAL   floor 17, real fight, nothing staged
//   DENSE     floor 17, staged pull held at 22 mobs   -> the contract scene
//
// Same tab, same build, idle-gated before each window, foreign load reported
// with each number.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_accept1");
const SECONDS = Number(flag("--seconds", 16));
const CROWD = 22;
mkdirSync(outDir, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));
await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const boot = async (floor) => {
  await page.goto(`http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}&abilities=all&seed=41&eagerassets&clean=1&debug=1`, { waitUntil: "load", timeout: 120000 });
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
  const b = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: r.width, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (b && b.w > 0 && b.display !== "none" && b.opacity > 0.01) throw new Error(`floor ${floor}: boot card still up`);
  await page.evaluate(() => {
    const R = window.__dcc.renderer;
    R.renderer.info.autoReset = false;
    const comp = R.composer; const orig = comp.render.bind(comp);
    window.__lastInfo = { calls: 0, tris: 0 };
    comp.render = function (...a) {
      try { return orig(...a); } finally { window.__lastInfo = { calls: R.renderer.info.render.calls, tris: R.renderer.info.render.triangles }; R.renderer.info.reset(); }
    };
  });
};

const record = (s) => page.evaluate((sec) => {
  const w = window; w.__acc = { dt: [], preset: [], px: [], near: [], calls: [], tris: [], done: false };
  const R = w.__dcc.renderer; let last = 0; const t0 = performance.now();
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
    if (performance.now() - t0 < sec * 1000) requestAnimationFrame(tick); else w.__acc.done = true;
  };
  requestAnimationFrame(tick);
}, s);

const harvest = () => page.evaluate(() => {
  const a = window.__acc; const dt = a.dt.slice(10);
  const s = [...dt].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const med = (arr) => { const b = [...arr].sort((x, y) => x - y); return b[b.length >> 1]; };
  const hist = {}; for (const p of a.preset) hist[p] = (hist[p] || 0) + 1;
  const pxh = {}; for (const p of a.px) pxh[p.toFixed(2)] = (pxh[p.toFixed(2)] || 0) + 1;
  const near = a.near.slice(10);
  return {
    frames: dt.length, medianFps: +(1000 / q(0.5)).toFixed(1),
    median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
    over16_7: +((dt.filter((d) => d > 16.7).length / dt.length) * 100).toFixed(1),
    over33: +((dt.filter((d) => d > 33).length / dt.length) * 100).toFixed(1),
    presetHist: hist, pxHist: pxh,
    nearMin: Math.min(...near), nearMed: med(near), nearMax: Math.max(...near),
    callsMed: med(a.calls.slice(10)), trisMed: med(a.tris.slice(10)),
  };
});

const fireLoop = async (ms) => {
  const keys = ["Space", "Shift", "q", "c", "f"]; const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) { await page.keyboard.press(keys[i++ % keys.length], { delay: 40 }); await page.waitForTimeout(150); }
};

const out = {};
const runWindow = async (name, { fire, shot }) => {
  say(`\n== ${name}`);
  const gate = await waitForIdle(name, { log: say, maxWaitMs: 240000 });
  const before = probeLoad(process.pid);
  await record(SECONDS);
  if (fire) await fireLoop(SECONDS * 1000 + 400); else await page.waitForTimeout(SECONDS * 1000 + 800);
  await page.waitForFunction(() => window.__acc.done, { timeout: 60000 });
  if (shot) await page.screenshot({ path: `${outDir}/${shot}` });
  const after = probeLoad(process.pid);
  const r = await harvest();
  r.foreignLoadPct = foreignLoadPct(before, after);
  r.idleGateOpened = gate.idle;
  out[name] = r;
  say(`${name}:`, JSON.stringify(r));
};

// CONTROL — quiet floor 2, standing still. If this is not near 16.7 ms the
// instrument is what is being measured and nothing below means anything.
await boot(2);
say("GAME GPU:", await page.evaluate(() => { const c = window.__dcc.renderer.renderer.getContext(); const d = c.getExtension("WEBGL_debug_renderer_info"); return String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)); }));
await runWindow("CONTROL_f2_still", { fire: false, shot: "perf_control_f2.png" });

// NATURAL — floor 17, a real fight, nothing staged.
await boot(17);
await page.keyboard.down("w"); await page.waitForTimeout(1800); await page.keyboard.up("w");
await runWindow("NATURAL_f17_fight", { fire: true, shot: "perf_natural_f17.png" });

// DENSE — the contract scene: a late-floor pull held at 22 live mobs.
const staged = await page.evaluate(({ crowd }) => {
  const st = window.__dcc.state, p = st.players[0], mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 6 && spots.length < crowd; ri++) {
    const r = 1.7 + ri * 0.85;
    for (let k = 0; k < 18 && spots.length < crowd; k++) {
      const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
  const hold = () => {
    try {
      const s2 = window.__dcc.state, pl = s2.players[0];
      const near = s2.monsters.filter((m) => m.hp > 0)
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
}, { crowd: CROWD });
say("staged:", JSON.stringify(staged));
await page.waitForTimeout(2500);
await runWindow("DENSE_f17_pull", { fire: true, shot: "perf_dense_f17.png" });

writeFileSync(`${outDir}/accept1c.json`, JSON.stringify(out, null, 2));
writeFileSync(`${outDir}/accept1c.log`, log.join("\n"));
await browser.close();
say("\ndone.");
