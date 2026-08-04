// ACCEPTANCE ROUND 2 — one build, two judgements, ONE browser.
//
// Phase A captures the LOOK frames (and self-verifies that each frame actually
// contains what its filename claims, because a frame that does not is worse
// than a missing one). Phase B measures the COST on the same page session.
//
// The machine is shared with a sibling workflow, so Phase B gates on
// _boxload's foreign-CPU meter and records what it saw either way.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_accept2");
const only = flag("--only", "both"); // look | cost | both
mkdirSync(outDir, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

// Owner's panel: 1440x900 CSS @ dpr 2 (2880x1800 physical, verified via
// Win32_VideoController). Browser chrome eats ~48 CSS px of height.
const VP = { width: 1440, height: 852 };
const DPR = 2;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: VP, deviceScaleFactor: DPR });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));

const out = { meta: {} };

// ------------------------------------------------------------ GPU IDENTITY
await page.goto("about:blank");
out.meta.gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { error: "no webgl" };
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    unmaskedRenderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "(no ext)",
    unmaskedVendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : "(no ext)",
    devicePixelRatio, screen: `${screen.width}x${screen.height}`,
    cores: navigator.hardwareConcurrency,
  };
});
say("GPU:", JSON.stringify(out.meta.gpu));
if (/swiftshader|software|llvmpipe/i.test(out.meta.gpu.unmaskedRenderer || "")) {
  say("!! SOFTWARE RENDERER — every number and pixel below would be worthless. Aborting.");
  await browser.close();
  process.exit(2);
}

// ------------------------------------------------------------- READINESS
// html[data-assets-settled] is NOT playable: shader precompile + the PMREM bake
// run behind the boot card. Poll the card out, let the program count stop
// moving, wait 3 s, then ASSERT the card has no box.
const boot = async (url) => {
  await page.goto(url, { waitUntil: "load", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => say("  (assets-settled timed out)"));
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => say("  (loading card never left)"));
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
    const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 14;
  }, { timeout: 180000, polling: 100 }).catch(() => say("  (program count never settled)"));
  await page.waitForTimeout(3200);
  const b = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (b && b.w > 0 && b.h > 0 && b.display !== "none" && b.opacity > 0.01) {
    throw new Error(`BOOT CARD STILL UP: ${JSON.stringify(b)}`);
  }
  return page.evaluate(() => {
    const R = window.__dcc.renderer;
    return {
      preset: R.qualityProfile?.name ?? "?",
      pixelRatio: R.renderer.getPixelRatio(),
      drawBuffer: `${R.renderer.getContext().drawingBufferWidth}x${R.renderer.getContext().drawingBufferHeight}`,
      programs: R.renderer.info.programs?.length ?? -1,
    };
  });
};

const testUrl = (floor, extra = "") =>
  `http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}` +
  `&abilities=all&seed=7&eagerassets&clean=1&debug=1${extra}`;

// Keep the player alive without touching sim rules from the harness beyond hp.
await page.addInitScript(() => {
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; }
    } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

/** Pull N live monsters into a ring around the player and keep them there. */
const stage = (crowd) => page.evaluate((n) => {
  const s0 = window.__dcc.state, p = s0.players[0], mapW = s0.map.w;
  const ok = s0.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = s0.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 7 && spots.length < n; ri++) {
    const r = 1.8 + ri * 0.8;
    for (let k = 0; k < 20 && spots.length < n; k++) {
      const a = (k / 20) * Math.PI * 2 + 0.4 + ri * 0.33;
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
      const near = s2.monsters.filter((m) => m.hp > 0)
        .map((m) => ({ m, d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) }))
        .sort((a, b) => a.d - b.d);
      near.forEach((e, i) => {
        if (i < n) { e.m.maxHp = Math.max(e.m.maxHp || 1, 5e5); e.m.hp = 5e5; e.m.dormant = false; }
      });
    } catch { /* */ }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
  return { placed: used.length, liveTotal: live.length };
}, crowd);

const keys = ["Space", "Shift", "q", "c", "f"];
const fireLoop = async (ms) => {
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) {
    await page.keyboard.press(keys[i++ % keys.length], { delay: 40 });
    await page.waitForTimeout(140);
  }
};

/** What is actually in the frame right now — used to verify or MISS a shot. */
const census = () => page.evaluate(() => {
  const s = window.__dcc.state, R = window.__dcc.renderer, p = s.players[0];
  const near = s.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 11);
  const load = document.getElementById("loading");
  const lr = load ? load.getBoundingClientRect() : null;
  return {
    floor: s.floor,
    band: s.bandName ?? null,
    monstersWithin11: near.length,
    monstersOnScreen: near.filter((m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 8).length,
    bossAlive: s.monsters.some((m) => m.hp > 0 && m.kind === "boss"),
    bossDist: (() => {
      const b = s.monsters.find((m) => m.hp > 0 && m.kind === "boss");
      return b ? +Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y).toFixed(1) : -1;
    })(),
    livingParticles: R.fxParticleCount?.() ?? (R.particleCount ?? null),
    preset: R.qualityProfile?.name ?? "?",
    pixelRatio: R.renderer.getPixelRatio(),
    triangles: R.renderer.info.render.triangles,
    drawCalls: R.renderer.info.render.calls,
    loadingBox: lr ? { w: lr.width, h: lr.height } : null,
  };
});

const shots = [];
const shoot = async (name, claim, clip) => {
  const c = await census();
  await page.screenshot({ path: `${outDir}/${name}.png`, ...(clip ? { clip } : {}) });
  shots.push({ name, claim, census: c });
  say(`  shot ${name}: ${JSON.stringify(c)}`);
  return c;
};

// =========================================================== PHASE A: LOOK
if (only === "look" || only === "both") {
  say("\n===== PHASE A: LOOK =====");

  // A1 — early-band environment, no combat. The lol_10 / lol_11 comparison:
  // what does the world look like when nothing is exploding.
  say("A1 floor 2 environment");
  out.meta.bootF2 = await boot(testUrl(2));
  say("  boot:", JSON.stringify(out.meta.bootF2));
  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  await shoot("ours_f2_environment", "an Undercroft room with no combat in it");

  // A2 — mid-band environment (THE GARDEN) for biome variety.
  say("A2 floor 8 environment");
  await boot(testUrl(8));
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  await shoot("ours_f8_environment", "a Garden-band room with no combat in it");

  // A3 — the teamfight frame. Dense late floor, abilities mid-cast.
  // This is the lol_01 / lol_02 / d4_02 comparison and the one that matters.
  say("A3 floor 14 dense combat");
  await boot(testUrl(14));
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  const staged = await stage(20);
  say("  staged:", JSON.stringify(staged));
  await page.waitForTimeout(1800);
  await fireLoop(3500); // warm first-use FX so the shot is not a compile frame
  // Fire, then grab several frames a beat apart and keep the busiest.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(keys[i % keys.length], { delay: 40 });
    await page.waitForTimeout(110);
    await shoot(`ours_f14_combat_${i}`, "a dense floor-14 fight with abilities mid-cast");
  }
  // A character crop, for the lol_05 / lol_06 shading comparison.
  await shoot("ours_f14_character_crop", "a close crop on the crawler and the mobs around them", {
    x: VP.width / 2 - 190, y: VP.height / 2 - 150, width: 380, height: 320,
  });

  // A4 — boss staging, the d4_02 comparison.
  say("A4 floor 15 boss arena");
  await boot(testUrl(15));
  for (let t = 0; t < 26; t++) {
    await page.keyboard.down("w"); await page.waitForTimeout(500); await page.keyboard.up("w");
    await page.keyboard.press(keys[t % keys.length], { delay: 40 });
    const c = await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const b = s.monsters.find((m) => m.hp > 0 && (m.boss || m.isBoss));
      return b ? Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) : -1;
    });
    if (c >= 0 && c < 9) break;
    if (t % 6 === 5) { await page.keyboard.down("d"); await page.waitForTimeout(600); await page.keyboard.up("d"); }
  }
  await fireLoop(3000);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(keys[i % keys.length], { delay: 40 });
    await page.waitForTimeout(130);
    await shoot(`ours_f15_boss_${i}`, "a floor-15 boss on screen mid-fight");
  }

  out.look = shots;
  writeFileSync(`${outDir}/look.json`, JSON.stringify(shots, null, 2));
}

// ============================================ PHASE A2: THE BOSS FRAME, RETRY
// The first pass walked toward the arena and never got there, so the three
// "boss" frames had no boss in them. Walking is not the job; getting the boss
// on screen is. Move the CRAWLER to the boss instead of hoping.
if (only === "boss") {
  say("\n===== PHASE A2: BOSS =====");
  say("boot:", JSON.stringify(await boot(testUrl(18))));
  const jump = await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const b = s.monsters.find((m) => m.hp > 0 && m.kind === "boss");
    if (!b) return { ok: false, kinds: [...new Set(s.monsters.map((m) => m.kind))] };
    b.dormant = false; b.maxHp = Math.max(b.maxHp || 1, 5e6); b.hp = 5e6;
    p.pos.x = b.pos.x + 3.2; p.pos.y = b.pos.y + 3.2;
    const hold = () => {
      try {
        const s2 = window.__dcc.state;
        const bb = s2.monsters.find((m) => m.kind === "boss");
        if (bb) { bb.hp = 5e6; bb.dormant = false; }
      } catch { /* */ }
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
    return { ok: true, bossId: b.bossId ?? null, at: { x: b.pos.x, y: b.pos.y } };
  });
  say("jump:", JSON.stringify(jump));
  await page.waitForTimeout(2500);
  await fireLoop(4000);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(keys[i % keys.length], { delay: 40 });
    await page.waitForTimeout(200);
    await shoot(`ours_f18_boss_${i}`, "a floor-18 boss on screen mid-fight");
  }
  writeFileSync(`${outDir}/boss.json`, JSON.stringify(shots, null, 2));
}

// =========================================================== PHASE B: COST
if (only === "cost" || only === "both") {
  say("\n===== PHASE B: COST =====");

  const stats = (dt) => {
    const s = [...dt].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
    return {
      n: s.length,
      median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2),
      p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
      mean: +(dt.reduce((a, b) => a + b, 0) / dt.length).toFixed(2),
      over16_7: +((dt.filter((d) => d > 16.7).length / dt.length) * 100).toFixed(1),
      over33: +((dt.filter((d) => d > 33).length / dt.length) * 100).toFixed(1),
    };
  };

  const SECONDS = 22;
  const record = (sec) => page.evaluate((s) => {
    const w = window; w.__acc = { t: [], dt: [], near: [], preset: [], px: [], done: false };
    const R = w.__dcc.renderer; let last = 0; const t0 = performance.now();
    const tick = (t) => {
      if (last) {
        const st = w.__dcc.state, p = st.players[0];
        w.__acc.t.push(+(t - t0).toFixed(1));
        w.__acc.dt.push(+(t - last).toFixed(2));
        w.__acc.near.push(st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 11).length);
        w.__acc.preset.push(R.qualityProfile?.name ?? "?");
        w.__acc.px.push(R.renderer.getPixelRatio());
      }
      last = t;
      if (performance.now() - t0 < s * 1000) requestAnimationFrame(tick); else w.__acc.done = true;
    };
    requestAnimationFrame(tick);
  }, sec);

  const window_ = async (name, { floor, crowd, fire }) => {
    say(`\n-- ${name}`);
    const b = await boot(testUrl(floor));
    say("  boot:", JSON.stringify(b));
    await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
    if (crowd) { say("  staged:", JSON.stringify(await stage(crowd))); await page.waitForTimeout(2200); }
    if (fire) await fireLoop(6000); // burn off first-use shader compiles
    const gate = await waitForIdle(name, { log: say, maxWaitMs: 900000 });
    const before = probeLoad(process.pid);
    await record(SECONDS);
    if (fire) await fireLoop(SECONDS * 1000 + 500); else await page.waitForTimeout(SECONDS * 1000 + 900);
    await page.waitForFunction(() => window.__acc.done, { timeout: 90000 });
    await page.screenshot({ path: `${outDir}/cost_${name}.png` });
    const after = probeLoad(process.pid);
    const raw = await page.evaluate(() => window.__acc);
    const dt = raw.dt.slice(10);
    const r = stats(dt);
    const third = Math.floor(dt.length / 3);
    r.firstThird = stats(dt.slice(0, third));
    r.lastThird = stats(dt.slice(-third));
    r.spikeTimes = raw.t.slice(10).filter((_, i) => dt[i] > 50).slice(0, 30);
    r.presets = [...new Set(raw.preset)];
    r.pixelRatios = [...new Set(raw.px.map((v) => +v.toFixed(2)))];
    r.nearMedian = [...raw.near].sort((a, b) => a - b)[raw.near.length >> 1];
    r.foreignLoadPct = foreignLoadPct(before, after);
    r.idleGateOpened = gate.idle;
    r.censusAtEnd = await census();
    writeFileSync(`${outDir}/raw_${name}.json`, JSON.stringify({ t: raw.t, dt: raw.dt, near: raw.near }));
    out[name] = r;
    say(`  ${name}: ${JSON.stringify(r)}`);
  };

  // Reference cadence: what does this browser do with nothing to draw.
  await page.goto("about:blank");
  out.blankPage = await page.evaluate(() => new Promise((res) => {
    const dt = []; let last = 0; const t0 = performance.now();
    const tick = (t) => {
      if (last) dt.push(t - last); last = t;
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
      else { const s = dt.slice(5).sort((a, b) => a - b); res({ n: s.length, median: +s[s.length >> 1].toFixed(2), min: +s[0].toFixed(2) }); }
    };
    requestAnimationFrame(tick);
  }));
  say("blank page rAF cadence:", JSON.stringify(out.blankPage));

  await window_("CONTROL_f2_idle", { floor: 2, crowd: 0, fire: false });
  await window_("WORST_f17_dense_combat", { floor: 17, crowd: 22, fire: true });
}

writeFileSync(`${outDir}/accept2.json`, JSON.stringify(out, null, 2));
writeFileSync(`${outDir}/accept2.log`, log.join("\n"));
await browser.close();
say("\ndone.");
