// ACCEPTANCE ROUND 1 — LOOK and COST, one build, one browser session.
//
// Written by the acceptance critic, not by the authors of the build. It does
// not import their measurement conclusions; it only reuses tools/_boxload.mjs
// (the contamination meter) because both sides must agree on "clean".
//
// Rules obeyed here:
//  * ONE Chromium, ever. Look frames and the frame-time contract are taken in
//    the SAME tab, back to back, so both describe one build on one machine.
//  * REAL GPU. headless:false + ANGLE/D3D11, and the unmasked renderer of the
//    GAME's own context is asserted to be Intel before anything is believed.
//  * VSYNC ON. The budget is stated in what a player feels, so rAF is paced by
//    the compositor. No --disable-gpu-vsync, no --disable-frame-rate-limit.
//  * The preset is NOT pinned. "Which rung does auto-tune actually land on" is
//    half the question — a build that holds 60 by quietly rendering at 1.0x is
//    not the build whose frames were scored. Preset + effective pixel ratio are
//    sampled EVERY frame and reported as a histogram.
//  * Every frame is PROVEN: boot card gone (asserted to have no box), crawler
//    alive, no recap/intro/cine overlay, and for combat frames a live monster
//    count in the ring. Anything else is written down as MISSED.
//
// Usage: node tools/_accept1.mjs [--port 5282] [--out tools/_accept1]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_accept1");
const W = Number(flag("--w", 1440)), H = Number(flag("--h", 852)), DPR = Number(flag("--dpr", 2));
const SECONDS = Number(flag("--seconds", 22));
mkdirSync(outDir, { recursive: true });

const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));
const shaderErrors = [];
page.on("console", (m) => { const t = m.text(); if (/shader error|THREE\.WebGLProgram|ERROR: 0:/i.test(t)) shaderErrors.push(t.slice(0, 240)); });

// Keep-alive: dropped in at depth the crawler dies fast, and then every frame
// and every sample would describe the death card instead of the game.
await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* not up */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const urlFor = (floor, extra = "") =>
  `http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}&abilities=all&seed=41&eagerassets&clean=1&debug=1${extra}`;

async function ready(label) {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  // Shader program count must stop moving: precompile is still running behind
  // a dismissed boot card and a shot taken now photographs a half-built scene.
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
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (box && box.w > 0 && box.h > 0 && box.display !== "none" && box.opacity > 0.01) {
    say(`${label}: BOOT CARD STILL UP — MISSED`, JSON.stringify(box));
    return false;
  }
  return true;
}

const claimNow = () => page.evaluate(() => {
  const st = window.__dcc.state, R = window.__dcc.renderer;
  const p = st.players[0];
  const up = (id) => {
    const e = document.getElementById(id);
    if (!e) return false;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01;
  };
  const near = st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length;
  return {
    hp: p ? Math.min(p.hp, 999999) : -1,
    nearMobs: near,
    liveMobs: st.monsters.filter((m) => m.hp > 0).length,
    recapUp: up("recap"), introUp: up("bossintro"), cine: document.body.classList.contains("cine"),
    preset: R?.qualityProfile?.name ?? "?",
    setting: R?.qualitySetting ?? "?",
    pxRatio: R?.renderer?.getPixelRatio?.() ?? null,
    dpr: window.devicePixelRatio,
    drawCalls: R?.renderer?.info?.render?.calls ?? null,
    tris: R?.renderer?.info?.render?.triangles ?? null,
    programs: R?.renderer?.info?.programs?.length ?? null,
  };
});

// ---------------------------------------------------------------- GPU checks
await page.goto(urlFor(2), { waitUntil: "load", timeout: 120000 });
await page.bringToFront();
const probeGpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
say("PROBE GPU:", probeGpu, `| ${W}x${H} css @dpr${DPR}`);
if (/SwiftShader|Software|llvmpipe/i.test(probeGpu)) { say("REFUSING: software GL"); await browser.close(); process.exit(1); }

const results = { gpu: probeGpu, look: [], perf: null, shaderErrors };

// ------------------------------------------------------------------ 1. LOOK
const LOOK_FLOORS = [2, 8, 14, 17];
for (const floor of LOOK_FLOORS) {
  say(`\n== LOOK floor ${floor}`);
  if (floor !== 2) await page.goto(urlFor(floor), { waitUntil: "load", timeout: 120000 });
  if (!(await ready(`f${floor}`))) { results.look.push({ floor, status: "MISSED_BOOT_CARD" }); continue; }

  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(600); await page.keyboard.up("d");
  await page.waitForTimeout(1500);

  let claim = await claimNow();
  for (let t = 0; t < 12 && (claim.recapUp || claim.introUp || claim.cine); t++) {
    await page.waitForTimeout(1500); claim = await claimNow();
  }
  if (!(claim.hp > 0) || claim.recapUp || claim.introUp || claim.cine) {
    say(`f${floor}: NOT A WORLD FRAME — MISSED`, JSON.stringify(claim));
    results.look.push({ floor, status: "MISSED_NOT_GAMEPLAY", claim });
    continue;
  }
  const shot = `${outDir}/ours_f${floor}_room.png`;
  await page.screenshot({ path: shot });
  await page.screenshot({ path: `${outDir}/ours_f${floor}_room_zoom.png`, clip: { x: 470, y: 210, width: 500, height: 330 } });
  say(`f${floor}: OK preset=${claim.preset}(${claim.setting}) px=${claim.pxRatio} calls=${claim.drawCalls} tris=${claim.tris} nearMobs=${claim.nearMobs}`);
  results.look.push({ floor, status: "OK", shot, claim });
}

// ---------------------------------- 2. THE WORST REAL SCENE: dense f17 combat
say(`\n== WORST SCENE: floor 17, staged crowd, abilities live`);
await page.goto(urlFor(17), { waitUntil: "load", timeout: 120000 });
if (!(await ready("worst"))) { say("worst scene MISSED at boot"); await browser.close(); process.exit(1); }

const gameGpu = await page.evaluate(() => {
  try {
    const ctx = window.__dcc.renderer.renderer.getContext();
    const d = ctx.getExtension("WEBGL_debug_renderer_info");
    return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch (e) { return `ERR ${e.message}`; }
});
say("GAME CONTEXT GPU:", gameGpu);
results.gameGpu = gameGpu;
if (/SwiftShader|Software|llvmpipe/i.test(gameGpu)) { say("REFUSING: game context is software"); await browser.close(); process.exit(1); }

// Walk so streamed dressing is live, then ring the crawler with real monsters.
await page.keyboard.down("w"); await page.waitForTimeout(1800); await page.keyboard.up("w");
const staged = await page.evaluate((ring) => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const mapW = st.map.w;
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
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.hp = m.maxHp || m.hp; m.dormant = false; });
  // Monsters must not evaporate mid-window either: a "dense combat" number
  // measured over a room that emptied out in 4 s is an empty-room number.
  const BIG = 1e7;
  const pump = () => {
    try {
      for (const m of window.__dcc.state.monsters) { m.maxHp = Math.max(m.maxHp || 0, BIG); m.hp = BIG; }
    } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  return { placed: used.length, liveTotal: live.length };
}, 20);
say("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2000);

// Ability loop: a real fight, not a still life. Held in a browser-side timer so
// it keeps firing through the whole measurement window.
const fireLoop = async (ms) => {
  const keys = ["Space", "Shift", "q", "c", "f"];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < ms) {
    await page.keyboard.press(keys[i++ % keys.length], { delay: 40 });
    await page.waitForTimeout(160);
  }
};

// Combat LOOK frame first — mid-cast, verified to contain a fight.
const combatShots = [];
for (let attempt = 0; attempt < 3 && combatShots.length < 2; attempt++) {
  await fireLoop(900);
  const c = await claimNow();
  if (!(c.hp > 0) || c.recapUp || c.introUp || c.cine || c.nearMobs < 6) {
    say(`combat shot attempt ${attempt}: not a fight yet ${JSON.stringify(c)}`);
    continue;
  }
  const path = `${outDir}/ours_f17_combat_${combatShots.length + 1}.png`;
  await page.screenshot({ path });
  await page.screenshot({ path: path.replace(".png", "_zoom.png"), clip: { x: 470, y: 210, width: 500, height: 330 } });
  combatShots.push({ path, claim: c });
  say(`combat shot ${combatShots.length}: OK nearMobs=${c.nearMobs} preset=${c.preset} px=${c.pxRatio} calls=${c.drawCalls}`);
}
results.combatShots = combatShots;
if (!combatShots.length) say("COMBAT LOOK FRAME: MISSED");

// ------------------------------------------------------------------ 3. COST
const before = probeLoad(process.pid);
say(`box before: ${JSON.stringify(before)}`);

// Frame recorder: rAF deltas (what the player feels, vsync-paced), plus the
// live preset/pixel-ratio and near-mob count on EVERY frame, so a rung change
// or an emptying room inside the window is visible instead of averaged away.
await page.evaluate((seconds) => {
  const w = window;
  w.__acc = { dt: [], preset: [], px: [], near: [], calls: [], done: false };
  const R = w.__dcc.renderer;
  let last = 0;
  const t0 = performance.now();
  const tick = (t) => {
    if (last) {
      const st = w.__dcc.state, p = st.players[0];
      w.__acc.dt.push(t - last);
      w.__acc.preset.push(R.qualityProfile?.name ?? "?");
      w.__acc.px.push(R.renderer.getPixelRatio());
      w.__acc.near.push(st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length);
      w.__acc.calls.push(R.renderer.info.render.calls);
    }
    last = t;
    if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick);
    else w.__acc.done = true;
  };
  requestAnimationFrame(tick);
}, SECONDS);

await fireLoop(SECONDS * 1000 + 500);
await page.waitForFunction(() => window.__acc && window.__acc.done, { timeout: 60000 });
await page.screenshot({ path: `${outDir}/ours_f17_perf_proof.png` });
const proofClaim = await claimNow();
say("perf proof frame:", JSON.stringify(proofClaim));

const after = probeLoad(process.pid);
const foreign = foreignLoadPct(before, after);
say(`box after: ${JSON.stringify(after)} | FOREIGN LOAD DURING WINDOW: ${foreign}% of the machine`);

const perf = await page.evaluate(() => {
  const a = window.__acc;
  const dt = a.dt.slice(10); // drop the first frames: the recorder's own warmup
  const s = [...dt].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const hist = {};
  for (const p of a.preset) hist[p] = (hist[p] || 0) + 1;
  const pxHist = {};
  for (const p of a.px) pxHist[p.toFixed(2)] = (pxHist[p.toFixed(2)] || 0) + 1;
  const near = a.near.slice(10);
  return {
    frames: dt.length,
    median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2), min: +s[0].toFixed(2),
    mean: +(dt.reduce((x, y) => x + y, 0) / dt.length).toFixed(2),
    over16_7: +((dt.filter((d) => d > 16.7).length / dt.length) * 100).toFixed(1),
    over33: +((dt.filter((d) => d > 33).length / dt.length) * 100).toFixed(1),
    over50: +((dt.filter((d) => d > 50).length / dt.length) * 100).toFixed(1),
    presetHist: hist, pxHist,
    nearMin: Math.min(...near), nearMedian: near.sort((x, y) => x - y)[near.length >> 1], nearMax: Math.max(...near),
    callsMedian: a.calls.slice(10).sort((x, y) => x - y)[(a.calls.length - 10) >> 1],
  };
});
perf.foreignLoadPct = foreign;
perf.staged = staged;
perf.proofClaim = proofClaim;
results.perf = perf;
say("PERF:", JSON.stringify(perf, null, 2));

writeFileSync(`${outDir}/accept1.json`, JSON.stringify(results, null, 2));
writeFileSync(`${outDir}/accept1.log`, log.join("\n"));
if (shaderErrors.length) say("SHADER ERRORS:", shaderErrors.slice(0, 3).join(" | "));
await browser.close();
say("\ndone.");
