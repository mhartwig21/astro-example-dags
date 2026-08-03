// ACCEPTANCE ROUND 1, PART D — instrument check, then the raw frame trace.
//
// Part C's CONTROL (floor 2, empty room, standing still) read 24.9 ms median.
// Every number in the whole set is a multiple of 8.33 ms, which says the panel
// is 120 Hz and the vsync quantum is 8.33 ms, not 16.7. Before "an empty room
// misses 60 fps" is published, the harness must show that the SAME browser, on
// the SAME box, can pace faster than that on a page with no game in it. If a
// blank page also reads 25 ms, the 40 fps is the instrument.
//
// Then the frame trace is kept RAW, so a hitch can be located in time: 35% of
// frames over 33 ms is a different defect depending on whether they are the
// first two seconds (first-use shader compile) or spread across the window
// (sustained stutter, which is what a player actually feels).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_accept1");
const SECONDS = 24;
mkdirSync(outDir, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));

const out = {};

// ---------------------------------------------------- 0. INSTRUMENT CHECK
await waitForIdle("instrument check", { log: say, maxWaitMs: 180000 });
await page.goto("about:blank");
await page.bringToFront();
out.blankPage = await page.evaluate(() => new Promise((res) => {
  const dt = []; let last = 0; const t0 = performance.now();
  const tick = (t) => {
    if (last) dt.push(t - last);
    last = t;
    if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
    else { const s = dt.slice(5).sort((a, b) => a - b); res({ n: s.length, median: +s[s.length >> 1].toFixed(2), min: +s[0].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2) }); }
  };
  requestAnimationFrame(tick);
}));
say("BLANK PAGE rAF cadence:", JSON.stringify(out.blankPage));

// A blank page paints nothing; a page that paints a trivial full-viewport
// canvas every frame is the fairer floor for "can this browser present at
// 120 Hz while compositing".
await page.setContent(`<canvas id=c width=2880 height=1704 style="width:1440px;height:852px"></canvas>`);
out.trivialCanvas = await page.evaluate(() => new Promise((res) => {
  const g = document.getElementById("c").getContext("2d");
  const dt = []; let last = 0; const t0 = performance.now();
  const tick = (t) => {
    if (last) dt.push(t - last);
    last = t;
    g.fillStyle = `hsl(${(t / 20) % 360},50%,40%)`; g.fillRect(0, 0, 2880, 1704);
    if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
    else { const s = dt.slice(5).sort((a, b) => a - b); res({ n: s.length, median: +s[s.length >> 1].toFixed(2), min: +s[0].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2) }); }
  };
  requestAnimationFrame(tick);
}));
say("TRIVIAL FULLSCREEN CANVAS cadence:", JSON.stringify(out.trivialCanvas));

// ------------------------------------------------------------- the game
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
    if (!e) return true; if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0; const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 12;
  }, { timeout: 120000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(3000);
  const b = await page.evaluate(() => {
    const e = document.getElementById("loading"); if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: r.width, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (b && b.w > 0 && b.display !== "none" && b.opacity > 0.01) throw new Error("boot card still up");
};

const record = (s) => page.evaluate((sec) => {
  const w = window; w.__acc = { t: [], dt: [], near: [], preset: [], px: [], done: false };
  const R = w.__dcc.renderer; let last = 0; const t0 = performance.now();
  const tick = (t) => {
    if (last) {
      const st = w.__dcc.state, p = st.players[0];
      w.__acc.t.push(+(t - t0).toFixed(1)); w.__acc.dt.push(+(t - last).toFixed(2));
      w.__acc.near.push(st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length);
      w.__acc.preset.push(R.qualityProfile?.name ?? "?"); w.__acc.px.push(R.renderer.getPixelRatio());
    }
    last = t;
    if (performance.now() - t0 < sec * 1000) requestAnimationFrame(tick); else w.__acc.done = true;
  };
  requestAnimationFrame(tick);
}, s);

const fireLoop = async (ms) => {
  const keys = ["Space", "Shift", "q", "c", "f"]; const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) { await page.keyboard.press(keys[i++ % keys.length], { delay: 40 }); await page.waitForTimeout(150); }
};

const stats = (dt) => {
  const s = [...dt].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return {
    n: s.length, median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
    over16_7: +((dt.filter((d) => d > 16.7).length / dt.length) * 100).toFixed(1),
    over33: +((dt.filter((d) => d > 33).length / dt.length) * 100).toFixed(1),
  };
};

const runWindow = async (name, floor, { fire, stage }) => {
  say(`\n== ${name}`);
  if (floor !== null) {
    await boot(floor);
    await page.keyboard.down("w"); await page.waitForTimeout(1800); await page.keyboard.up("w");
  }
  if (stage) {
    const st = await page.evaluate((crowd) => {
      const s0 = window.__dcc.state, p = s0.players[0], mapW = s0.map.w;
      const ok = s0.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
      const live = s0.monsters.filter((m) => m.hp > 0); const spots = [];
      for (let ri = 0; ri < 6 && spots.length < crowd; ri++) {
        const r = 1.7 + ri * 0.85;
        for (let k = 0; k < 18 && spots.length < crowd; k++) {
          const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
          const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
          if (s0.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
          if (spots.some((q) => Math.hypot(q.x - x, q.y - y) < 0.9)) continue;
          spots.push({ x, y });
        }
      }
      const used = live.slice(0, spots.length);
      used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
      const hold = () => {
        try {
          const s2 = window.__dcc.state, pl = s2.players[0];
          const near = s2.monsters.filter((m) => m.hp > 0).map((m) => ({ m, d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) })).sort((a, b) => a.d - b.d);
          near.forEach((e, i) => {
            if (i < crowd) { e.m.maxHp = Math.max(e.m.maxHp || 1, 5e5); e.m.hp = 5e5; e.m.dormant = false; }
            else if (e.d < 14) { e.m.dormant = true; const ang = Math.atan2(e.m.pos.y - pl.pos.y, e.m.pos.x - pl.pos.x); e.m.pos.x = pl.pos.x + Math.cos(ang) * 22; e.m.pos.y = pl.pos.y + Math.sin(ang) * 22; }
          });
        } catch { /* */ }
        requestAnimationFrame(hold);
      };
      requestAnimationFrame(hold);
      return { placed: used.length, liveTotal: live.length };
    }, 22);
    say("staged:", JSON.stringify(st));
    await page.waitForTimeout(2500);
  }
  // Warm the ability FX before the measured window: first-use shader compile is
  // a real defect but a DIFFERENT one from sustained stutter, and mixing them
  // in one p99 hides both.
  if (fire) await fireLoop(6000);
  const gate = await waitForIdle(name, { log: say, maxWaitMs: 240000 });
  const before = probeLoad(process.pid);
  await record(SECONDS);
  if (fire) await fireLoop(SECONDS * 1000 + 400); else await page.waitForTimeout(SECONDS * 1000 + 800);
  await page.waitForFunction(() => window.__acc.done, { timeout: 90000 });
  await page.screenshot({ path: `${outDir}/trace_${name}.png` });
  const after = probeLoad(process.pid);
  const raw = await page.evaluate(() => window.__acc);
  const dt = raw.dt.slice(10);
  const r = stats(dt);
  // Where do the spikes live? First third vs last third of the window.
  const third = Math.floor(dt.length / 3);
  r.firstThird = stats(dt.slice(0, third));
  r.lastThird = stats(dt.slice(-third));
  r.spikeTimes = raw.t.slice(10).filter((_, i) => dt[i] > 50).slice(0, 25);
  r.presets = [...new Set(raw.preset)];
  r.px = [...new Set(raw.px.map((v) => +v.toFixed(2)))];
  r.nearMed = [...raw.near].sort((a, b) => a - b)[raw.near.length >> 1];
  r.foreignLoadPct = foreignLoadPct(before, after);
  r.idleGateOpened = gate.idle;
  out[name] = r;
  writeFileSync(`${outDir}/rawtrace_${name}.json`, JSON.stringify({ t: raw.t, dt: raw.dt, near: raw.near }));
  say(`${name}:`, JSON.stringify(r));
};

await runWindow("CONTROL_f2_still", 2, { fire: false });
await runWindow("NATURAL_f17_fight", 17, { fire: true });
await runWindow("DENSE_f17_pull", null, { fire: true, stage: true });

writeFileSync(`${outDir}/accept1d.json`, JSON.stringify(out, null, 2));
writeFileSync(`${outDir}/accept1d.log`, log.join("\n"));
await browser.close();
say("\ndone.");
