// ROUND 2 SPEND — one build, one browser, look frames AND the frame cost.
//
// Deliberately a near-copy of the acceptance critic's tools/_accept1.mjs: the
// staging, the readiness gate, the frame recorder and the box-load meter are
// theirs, so the numbers this prints can be compared to the numbers that
// rejected the last build without arguing about method. What is added:
//
//   * --tag, so the SAME script can measure two builds (git stash between
//     runs) and the difference is the cost of the change, not of the harness.
//   * --quality, pinned, because the whole point of the tuner freeze shipped in
//     this round is that a measurement has to name its rung.
//   * an ULT frame: the exact cast acceptance photographed as a fullscreen
//     chromatic wash, fired on a known key at a known time.
//   * a CONTROL: floor 2, empty, standing still.
//
// ONE Chromium, headless:false, ANGLE/D3D11, vsync ON, and the unmasked
// renderer of the GAME's own context asserted before any number is believed.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const tag = flag("--tag", "run");
const quality = flag("--quality", "performance");
const outDir = flag("--out", `tools/_r2spend/${tag}`);
const W = Number(flag("--w", 1440)), H = Number(flag("--h", 852)), DPR = Number(flag("--dpr", 2));
const SECONDS = Number(flag("--seconds", 20));
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
// would describe the death card instead of the game.
await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* not up */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const urlFor = (floor) =>
  `http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}` +
  `&abilities=all&seed=41&eagerassets&clean=1&debug=1&quality=${quality}`;

async function ready(label) {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  // Program count must stop moving: precompile runs behind a dismissed card.
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
    // The two DOM layers this round rewrote — counted, not assumed.
    dmgNumbers: document.querySelectorAll("#fx .dmg").length,
    platesTotal: document.querySelectorAll("#mobplates .mplate").length,
    platesShown: [...document.querySelectorAll("#mobplates .mplate")]
      .filter((e) => e.style.display !== "none").length,
    platesResting: document.querySelectorAll("#mobplates .mplate.rest").length,
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
const results = { tag, quality, look: [], shaderErrors };

if (!(await ready("f2"))) { say("f2 MISSED at boot"); await browser.close(); process.exit(1); }
const gameGpu = await page.evaluate(() => {
  try {
    const ctx = window.__dcc.renderer.renderer.getContext();
    const d = ctx.getExtension("WEBGL_debug_renderer_info");
    return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch (e) { return `ERR ${e.message}`; }
});
say("GAME CONTEXT GPU:", gameGpu, `| ${W}x${H} css @dpr${DPR} | quality=${quality}`);
results.gameGpu = gameGpu;
if (/SwiftShader|Software|llvmpipe/i.test(gameGpu)) { say("REFUSING: game context is software"); await browser.close(); process.exit(1); }

// ------------------------------------------------- CONTROL: floor 2, at rest
say(`\n== CONTROL: floor 2, empty room, standing still`);
await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w");
await page.waitForTimeout(1500);
{
  const before = probeLoad(process.pid);
  await page.evaluate((seconds) => {
    const w = window;
    w.__acc = { dt: [], done: false };
    let last = 0; const t0 = performance.now();
    const tick = (t) => {
      if (last) w.__acc.dt.push(t - last);
      last = t;
      if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick);
      else w.__acc.done = true;
    };
    requestAnimationFrame(tick);
  }, 10);
  await page.waitForFunction(() => window.__acc && window.__acc.done, { timeout: 60000 });
  const after = probeLoad(process.pid);
  const claim = await claimNow();
  await page.screenshot({ path: `${outDir}/control_f2.png` });
  const stats = await page.evaluate(() => {
    const a = window.__acc.dt.slice(10);
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
    return {
      frames: a.length, median: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2),
      max: +s[s.length - 1].toFixed(2),
      over16_7: +((a.filter((d) => d > 16.7).length / a.length) * 100).toFixed(1),
    };
  });
  stats.foreignLoadPct = foreignLoadPct(before, after);
  stats.claim = claim;
  results.control = stats;
  say("CONTROL:", JSON.stringify(stats));
}

// -------------------------------------- THE WORST REAL SCENE: dense f17 pull
say(`\n== WORST SCENE: floor 17, staged crowd, abilities live`);
await page.goto(urlFor(17), { waitUntil: "load", timeout: 120000 });
if (!(await ready("f17"))) { say("f17 MISSED at boot"); await browser.close(); process.exit(1); }

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
  // THE SCENE HAS TO BE THE SAME SCENE IN BOTH RUNS OF AN A/B. The critic's
  // staging places 20 and leaves the other ~185 on the floor free to path in;
  // measured that way the ring drifted from 23 to 60 near mobs inside one
  // 20 s window, which makes "before" and "after" two different scenes and
  // the difference between them meaningless. Everything not staged is pinned
  // dormant for the duration.
  const keep = new Set(used.map((m) => m.id));
  const BIG = 1e7;
  const pump = () => {
    try {
      for (const m of window.__dcc.state.monsters) {
        m.maxHp = Math.max(m.maxHp || 0, BIG); m.hp = BIG;
        if (!keep.has(m.id)) m.dormant = true;
      }
    } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  return { placed: used.length, liveTotal: live.length };
}, 20);
say("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2000);

const fireLoop = async (ms) => {
  const keys = ["Space", "Shift", "q", "c", "f"];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < ms) {
    await page.keyboard.press(keys[i++ % keys.length], { delay: 40 });
    await page.waitForTimeout(160);
  }
};

// ---- THE ULT FRAME. This is the shot acceptance rejected: an ordinary
// Injunction cast that turned the whole world flat pink-red. Fired on its own
// key, photographed at three points across the cast so the peak cannot be
// missed, and each frame is claim-checked before it is believed.
const ultShots = [];
for (let attempt = 0; attempt < 3 && ultShots.length < 3; attempt++) {
  await fireLoop(700);
  await page.keyboard.press("f", { delay: 40 });
  for (const [i, wait] of [90, 160, 320].entries()) {
    await page.waitForTimeout(i === 0 ? wait : wait - [90, 160, 320][i - 1]);
    const c = await claimNow();
    if (!(c.hp > 0) || c.recapUp || c.introUp || c.cine || c.nearMobs < 6) continue;
    const path = `${outDir}/ult_f17_${ultShots.length + 1}.png`;
    await page.screenshot({ path });
    ultShots.push({ path, atMs: wait, claim: c });
  }
  if (ultShots.length) break;
}
results.ultShots = ultShots;
if (!ultShots.length) say("ULT FRAME: MISSED");
else say(`ult frames: ${ultShots.length} ok`);

// ---- Ordinary combat look frames. TEN of them, not two, and the sampling is
// the acceptance harness's own free-running 5-key rotation rather than a
// staged single cast. That protocol is what surfaced the fullscreen wash in the
// first place — it was 1 frame in 12, so two frames would have been a coin flip
// dressed up as a verification.
const combatShots = [];
for (let attempt = 0; attempt < 14 && combatShots.length < 10; attempt++) {
  await fireLoop(700);
  const c = await claimNow();
  if (!(c.hp > 0) || c.recapUp || c.introUp || c.cine || c.nearMobs < 6) {
    say(`combat shot attempt ${attempt}: not a fight yet ${JSON.stringify(c)}`);
    continue;
  }
  const path = `${outDir}/combat_f17_${String(combatShots.length + 1).padStart(2, "0")}.png`;
  await page.screenshot({ path });
  if (combatShots.length < 2) {
    await page.screenshot({ path: path.replace(".png", "_zoom.png"), clip: { x: 470, y: 210, width: 500, height: 330 } });
  }
  combatShots.push({ path, claim: c });
  say(`combat ${combatShots.length}: nearMobs=${c.nearMobs} numbers=${c.dmgNumbers} plates=${c.platesShown}(rest ${c.platesResting}) preset=${c.preset} px=${c.pxRatio}`);
}
results.combatShots = combatShots;
if (!combatShots.length) say("COMBAT LOOK FRAME: MISSED");

// ------------------------------------------------------------------ 3. COST
const before = probeLoad(process.pid);
say(`box before: ${JSON.stringify(before)}`);

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
await page.screenshot({ path: `${outDir}/perf_dense_f17.png` });
const proofClaim = await claimNow();
say("perf proof frame:", JSON.stringify(proofClaim));

const after = probeLoad(process.pid);
const foreign = foreignLoadPct(before, after);
say(`box after: ${JSON.stringify(after)} | FOREIGN LOAD DURING WINDOW: ${foreign}% of the machine`);

const perf = await page.evaluate(() => {
  const a = window.__acc;
  const dt = a.dt.slice(10);
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
    nearMin: Math.min(...near), nearMedian: [...near].sort((x, y) => x - y)[near.length >> 1], nearMax: Math.max(...near),
    callsMedian: [...a.calls.slice(10)].sort((x, y) => x - y)[(a.calls.length - 10) >> 1],
  };
});
perf.foreignLoadPct = foreign;
perf.staged = staged;
perf.proofClaim = proofClaim;
results.perf = perf;
say("PERF:", JSON.stringify(perf, null, 2));

// ---- floor 8 look frame (the AoE-on-ground critique's own reference shot)
say(`\n== LOOK floor 8`);
await page.goto(urlFor(8), { waitUntil: "load", timeout: 120000 });
if (await ready("f8")) {
  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  await fireLoop(1400);
  const c = await claimNow();
  if (c.hp > 0 && !c.recapUp && !c.introUp && !c.cine) {
    await page.screenshot({ path: `${outDir}/f8_room.png` });
    await page.screenshot({ path: `${outDir}/f8_room_zoom.png`, clip: { x: 470, y: 210, width: 500, height: 330 } });
    results.look.push({ floor: 8, status: "OK", claim: c });
    say(`f8: OK ${JSON.stringify(c)}`);
  } else { results.look.push({ floor: 8, status: "MISSED", claim: c }); say("f8 MISSED"); }
}

writeFileSync(`${outDir}/spend2.json`, JSON.stringify(results, null, 2));
writeFileSync(`${outDir}/spend2.log`, log.join("\n"));
if (shaderErrors.length) say("SHADER ERRORS:", shaderErrors.slice(0, 3).join(" | "));
await browser.close();
say("\ndone.");
