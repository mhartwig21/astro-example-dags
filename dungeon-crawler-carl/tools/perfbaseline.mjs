// HONEST PERF BASELINE — the contract number.
//
// One browser session, several REAL scenes, PLAYER PACING (vsync on).
//
// Why vsync ON and not the uncapped mode gpuprobe defaults to: the budget is
// stated in what the player feels (median <= 16.7 ms, p99 <= 33 ms). With vsync
// and the frame-rate limiter both off, rAF runs ahead of the GPU, the driver
// queues cheap frames until the swap chain fills, then blocks for the backlog —
// the distribution goes bimodal and the median only ever sees the cheap mode.
// gpuprobe.mjs says this in its own comments. So the contract is measured with
// the compositor pacing rAF, and per-pass COST is measured separately by
// gputime.mjs (GL timer queries, which do not care about pacing).
//
// The auto-tuner is deliberately NOT pinned: "which rung does the owner's
// machine actually land on" is one of the questions. The preset is sampled
// every frame, so a sample that straddles a preset change is visible instead of
// silently averaged.
//
// Every scene is PROVEN: live awake monsters within 10 sim tiles of the player
// are counted at sample time (a stated proxy for "in shot" — the iso camera is
// player-locked), and a screenshot is written next to the numbers. A frame-time
// number from an empty room is not a baseline.
//
// Usage: node tools/perfbaseline.mjs --port 5282 [--seconds 12] [--out dir]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad as probeLoadShared, foreignLoadPct, waitForIdle as waitForIdleShared } from "./_boxload.mjs";

// CONTAMINATION METER — shared with every other perf tool in here, so they all
// gate on one definition of "clean". See tools/_boxload.mjs for why counting
// chrome-headless-shell and thresholding machine-wide CPU% were both wrong, and
// why the foreign-CPU sum is now computed with an explicit loop that cannot
// silently return a confidently-clean zero.
let ownPid = process.pid;
const probeLoad = () => probeLoadShared(ownPid);

// How much foreign browser CPU we will tolerate across a sample, in % of the
// whole machine. Not zero: a parked sibling browser still ticks timers, and
// demanding a literal zero would never sample. 3% of a 16-thread box is under
// half a core — below the point where it can move a 16.7 ms frame budget.
const FOREIGN_LOAD_LIMIT = Number(flagEarly("--foreignlimit", 3));
function flagEarly(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; }

const waitForIdle = (label) => waitForIdleShared(label, { limitPct: FOREIGN_LOAD_LIMIT, ownPid });

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
// --awaitidle: block for a quiet box and retry any sample the box dirtied.
const awaitIdle = process.argv.includes("--awaitidle");
const maxAttempts = Number(flag("--attempts", 4));
const base = `http://localhost:${port}`;
const seconds = Number(flag("--seconds", 12));
const outDir = flag("--out", "tools/_baseline");
// The owner's panel is 2880x1800 physical, scaled to 1440x900 logical =>
// devicePixelRatio 2. 852 leaves room for browser chrome, matching every other
// tool in here, so a 1440x852 viewport rasterizes 2880x1704.
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

mkdirSync(outDir, { recursive: true });

// debug=1 is required for window.__dcc.renderer (main3d.ts:9034). It only arms
// the shader guard, which logs a console.warn if a program is built AFTER boot —
// i.e. it costs nothing per frame and it names a hitch cause for free. It is
// also on unconditionally under the dev server (import.meta.env.DEV), so it
// changes nothing about what is being measured here.
const SCENES = [
  // The early row deliberately does NOT stage a crowd: it is the light-scene
  // end of the spread. Run 2 recorded monstersNear10Peak=0 for it, so it is
  // labelled as the quiet room it actually is rather than as a fight.
  { id: "early", label: "EARLY FLOOR 1 (quiet room, roaming)", q: "test&floor=1&level=3&abilities=all&seed=7&eagerassets&clean=1&debug=1", ring: 0, combat: true },
  { id: "late", label: "DENSE LATE FLOOR 17 (roaming, as-generated)", q: "test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1", ring: 0, combat: true },
  { id: "latecrowd", label: "FLOOR 17 STAGED CROWD MID-COMBAT (worst real scene)", q: "test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1", ring: 18, combat: true },
];

const browser = await chromium.launch({
  headless: false, // headless-new still routes through SwiftShader on this box
  args: [
    "--use-angle=d3d11",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    // NO --disable-gpu-vsync / --disable-frame-rate-limit: player pacing.
  ],
});
// Claim our own process tree so probeLoad can tell OUR browser from a sibling's.
// Seeded from THIS node process, not browser.process() — that method is not on
// the Browser object in this Playwright version, and Playwright's chrome.exe is
// a direct child of us anyway, so the tree walk finds it and its renderers.
ownPid = process.pid;
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
// A program built after boot is a multi-hundred-ms frame the player sees. The
// shader guard names them; collect them per scene.
let lateShaders = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard] program built AFTER boot")) lateShaders.push(t.split("\n")[0].slice(0, 200));
});

// ---- THE KEEP-ALIVE HAS TO BE ARMED BEFORE THE GAME'S OWN SCRIPTS RUN.
//
// Run 2 of this tool installed it after the readiness gate and still measured a
// corpse on floor 17. The recap said "RUN TIME 0:01.51" — the crawler was
// killed ~1.5 s into the run, which is while the boot card is still up and long
// before the gate (program-cache settle + 3 s) opens. By the time anything could
// be poked, the run was already over and #recap was on screen for the whole
// sample. addInitScript runs before any page script, so the pump is live from
// the first sim step.
//
// This stages a throwaway ?test session; it does not change a rule. Nothing in
// src/ is touched, the sim stays pure and deterministic, and only this page's
// own state object is written — the same thing crowdbench.mjs already does when
// it writes m.hp/m.pos to stage a crowd.
await page.addInitScript(() => {
  const BIG = 1e9;
  const w = window;
  w.__alive = { deaths: 0, armedAt: null, pumps: 0 };
  const pump = () => {
    try {
      const st = w.__dcc && w.__dcc.state;
      if (st && st.players) {
        if (w.__alive.armedAt === null) w.__alive.armedAt = performance.now();
        for (const p of st.players) {
          if (p.hp <= 0) w.__alive.deaths++;
          p.maxHp = BIG;
          p.hp = BIG;
        }
        w.__alive.pumps++;
      }
    } catch { /* not up yet, or shape changed — the scene assertion catches it */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

// --only late : re-measure one scene, for the cross-session reproducibility
// check the contract number needs (a GL timer query is supposed to be immune to
// this box's CPU load — the way to show that is to reproduce it in a second,
// independent browser session under a different load and compare).
const only = flag("--only", "");
const SELECTED = only ? SCENES.filter((s) => s.id === only) : SCENES;

const results = [];

for (const scene of SELECTED) {
  const url = `${base}/iso.html?${scene.q}`;
  console.log(`\n================ ${scene.label}\n${url}`);
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  // An occluded/backgrounded window gets its compositor throttled, which would
  // quietly turn every frame time below into a measurement of Chromium's
  // background policy. The panel is 120 Hz, so the vsync quantum is 8.33 ms and
  // frame deltas quantize to multiples of it — 16.67 ms is exactly 2 quanta,
  // which is what makes a vsync-paced median readable against the budget.
  await page.bringToFront();

  // ---- GPU identity. SwiftShader numbers are worthless; so are numbers from a
  // discrete adapter this laptop does not use for the browser.
  const gpu = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return { renderer: "NO WEBGL", vendor: "" };
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown",
      vendor: d ? String(gl.getParameter(d.UNMASKED_VENDOR_WEBGL)) : "unknown",
      dpr: devicePixelRatio,
    };
  });
  console.log("GPU:", JSON.stringify(gpu));
  if (/SwiftShader|Software|llvmpipe/i.test(gpu.renderer)) {
    console.error("REFUSING: software GL — every number below would be a lie");
    await browser.close(); process.exit(1);
  }

  // ---- READINESS. data-assets-settled is NOT playable: the boot card is still
  // up while shader precompile and the PMREM bake run behind it.
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  // Program cache must stop growing: the tail of the ladder walk lands just
  // after the overlay lifts and it is not gameplay.
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
    const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 12;
  }, { timeout: 120000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(3000);

  // ---- ASSERT the loading card has no box. A shot/number taken over the boot
  // card is worse than a missing one.
  const loadingBox = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: cs.opacity, cls: e.className };
  });
  if (loadingBox && loadingBox.w > 0 && loadingBox.h > 0 && loadingBox.display !== "none" && Number(loadingBox.opacity) > 0.01) {
    console.error("BOOT CARD STILL UP:", JSON.stringify(loadingBox), "— MISSED, skipping scene");
    results.push({ scene: scene.id, status: "MISSED_BOOT_CARD", loadingBox });
    continue;
  }
  console.log("loading card:", loadingBox ? `present but inert ${JSON.stringify(loadingBox)}` : "absent");

  // ---- THE ADAPTER THE GAME'S OWN CONTEXT GOT.
  // The probe canvas above is a different context, and this laptop has two
  // adapters: the Intel iGPU that drives the panel, and an RTX 5090. Renderer3D
  // asks for powerPreference:'high-performance', which on a hybrid laptop can
  // hand it the discrete part — in which case every number here would describe
  // hardware the budget is not written against. Read the string off the context
  // that is actually drawing the game.
  const gameGpu = await page.evaluate(() => {
    try {
      const ctx = window.__dcc.renderer.renderer.getContext();
      const d = ctx.getExtension("WEBGL_debug_renderer_info");
      return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
    } catch (e) { return `ERR ${e.message}`; }
  });
  console.log("GAME CONTEXT GPU:", gameGpu);
  if (/SwiftShader|Software|llvmpipe/i.test(gameGpu)) {
    console.error("REFUSING: the GAME's context is software GL");
    await browser.close(); process.exit(1);
  }
  if (!/Intel/i.test(gameGpu)) console.warn(`!! GAME IS NOT ON THE INTEGRATED INTEL PART (${gameGpu}) — the budget is written against the iGPU; these numbers describe a different machine`);

  // ---- KEEP THE CRAWLER ALIVE FOR THE DURATION OF THE MEASUREMENT.
  //
  // THIS EXISTS BECAUSE THE FIRST RUN OF THIS TOOL MEASURED A CORPSE. Dropped
  // in at floor 17 via ?test, the crawler is killed by a beam trap for 1697
  // damage from 100% HP about 1.5 s after spawn — so all twelve seconds of the
  // "dense late floor mid-combat" sample were actually the IN MEMORIAM recap
  // panel sitting over a dead world, and floor 1 died to a Brute at 12.5 s.
  // Every screenshot was the death card. Those numbers described a UI panel.
  //
  // The fix is to STAGE, not to change any rule: the harness tops the player's
  // HP back up every frame from outside the sim, exactly the way crowdbench
  // already writes m.hp to stage a crowd. No sim code is touched and no rule
  // moves; the run simply cannot end inside the window.
  // (the keep-alive pump is already live — see addInitScript above)

  // ---- stage the scene ----
  await page.keyboard.down("w"); await page.waitForTimeout(2000); await page.keyboard.up("w");

  let staged = null;
  if (scene.ring > 0) {
    // Deterministic crowd: teleport live monsters into rings around the player,
    // exactly the beautyshot/crowdbench trick, so "dense combat" is the same
    // frame every run instead of a 4x-varying distribution.
    staged = await page.evaluate((ring) => {
      const st = window.__dcc.state;
      const p = st.players[0];
      const mapW = st.map.w;
      const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
      const live = st.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
      const spots = [];
      for (let ri = 0; ri < 6 && spots.length < ring; ri++) {
        const r = 1.6 + ri * 0.85;
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
      return { placed: used.length, liveTotal: live.length };
    }, scene.ring);
    console.log("staged crowd:", JSON.stringify(staged));
    await page.waitForTimeout(2500); // let meshes for the arrivals build
  }

  // ---- instrument: per-composed-frame draw calls, CPU split, preset trace ----
  await page.evaluate(() => {
    const R = window.__dcc.renderer;
    const gl = R.renderer;
    gl.info.autoReset = false;
    const s = { calls: 0, tris: 0, n: 0, upd: [], ren: [], progs: 0 };
    window.__pb = s;
    const origU = R.update.bind(R), origR = R.render.bind(R);
    R.update = function (...a) { const t = performance.now(); origU(...a); s.upd.push(performance.now() - t); };
    R.render = function (...a) {
      const t = performance.now();
      gl.info.reset();
      origR(...a);
      s.ren.push(performance.now() - t);
      s.calls += gl.info.render.calls; s.tris += gl.info.render.triangles; s.n++;
      s.progs = gl.info.programs.length;
    };
  });

  if (scene.combat) for (const k of ["Space", "q", "e", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }
  lateShaders = []; // only count builds that land inside the sampled window

  // ---- sample ----
  // Retried under the idle gate: a wall-clock contract number measured while
  // another browser is hammering the box is not a number about this game.
  let loadBefore, loadAfter, sample, attempt = 0, sampleForeignLoad = null;
  for (;;) {
    attempt++;
    if (awaitIdle) await waitForIdle(`scene "${scene.id}" sample (attempt ${attempt})`);
    loadBefore = probeLoad();
    console.log(`  box load BEFORE sample (attempt ${attempt}):`, JSON.stringify(loadBefore));
    sample = await runSample();
    loadAfter = probeLoad();
    // The number that decides trust: foreign browser CPU burned DURING the
    // window we just measured, not before it and not after it.
    sampleForeignLoad = foreignLoadPct(loadBefore, loadAfter);
    console.log(`  box load AFTER sample: ${JSON.stringify(loadAfter)}\n  FOREIGN LOAD DURING SAMPLE: ${sampleForeignLoad}% of box (limit ${FOREIGN_LOAD_LIMIT}%)`);
    if (!awaitIdle) break;
    if (sampleForeignLoad !== null && sampleForeignLoad <= FOREIGN_LOAD_LIMIT) { console.log("  [idle gate] sample is CLEAN — no foreign browser competed for this window"); break; }
    if (attempt >= maxAttempts) { console.warn(`  [idle gate] ${maxAttempts} attempts all contended — reporting the last as an UPPER BOUND`); break; }
    console.warn("  [idle gate] a foreign browser worked during the window — DISCARDING this sample and retaking it");
  }

  async function runSample() {
    return page.evaluate(({ secs, combat }) => new Promise((resolve) => {
    const R = window.__dcc.renderer;
    const s = window.__pb;
    s.calls = 0; s.tris = 0; s.n = 0; s.upd.length = 0; s.ren.length = 0;
    const frames = [];      // ms
    const presets = [];     // preset name sampled per frame
    const longs = [];       // {ms, t, preset, monstersVisible}
    const presetChanges = [];
    let lastPreset = R.qualityProfile?.name ?? "?";
    presetChanges.push({ tMs: 0, to: lastPreset });

    // SCENE PROOF, in SIM SPACE on purpose.
    //
    // The first draft of this projected each monster through
    // projectionMatrix * matrixWorldInverse and called the result "visible".
    // That needed three unverified assumptions (that the host maps sim (x,y) to
    // world (x,_,y), that matrixWorldInverse was current outside render, and
    // the element order) — and a proof number that is quietly wrong is exactly
    // the thing that launders a defect into evidence. So this counts a fact
    // that needs no camera at all: live, awake monsters within 10 sim tiles of
    // the player. The iso camera is player-locked, so that is a fair proxy for
    // "in shot", it is stated as a proxy rather than as frustum truth, and the
    // screenshot written next to it is what actually gets eyeballed.
    const nearRadius = 10;
    const visibleMonsters = () => {
      try {
        const st = window.__dcc.state;
        const p = st.players[0];
        const live = st.monsters.filter((m) => m.hp > 0 && !m.dormant);
        let n = 0;
        for (const m of live) {
          const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y;
          if (dx * dx + dy * dy <= nearRadius * nearRadius) n++;
        }
        return { visible: n, live: live.length };
      } catch { return { visible: -1, live: -1 }; }
    };

    let last = performance.now();
    const start = last;
    let peakVisible = 0, sumVisible = 0, nVisible = 0;

    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      frames.push(dt);
      const p = R.qualityProfile?.name ?? "?";
      presets.push(p);
      if (p !== lastPreset) { presetChanges.push({ tMs: +(now - start).toFixed(0), from: lastPreset, to: p }); lastPreset = p; }
      if (frames.length % 10 === 0) {
        const v = visibleMonsters();
        if (v.visible >= 0) { peakVisible = Math.max(peakVisible, v.visible); sumVisible += v.visible; nVisible++; }
      }
      if (dt > 50) {
        const v = visibleMonsters();
        longs.push({ ms: +dt.toFixed(1), tMs: +(now - start).toFixed(0), preset: p, monstersNear10: v.visible, frameIdx: frames.length });
      }
      // keep the fight going for the whole window
      if (combat && frames.length % 45 === 0) {
        try { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); window.dispatchEvent(new KeyboardEvent("keyup", { key: " " })); } catch { /* ignore */ }
      }
      if (now - start < secs * 1000) requestAnimationFrame(tick);
      else {
        const elapsed = now - start;
        const sorted = [...frames].sort((a, b) => a - b);
        const q = (p2) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p2))].toFixed(2);
        const med = (a) => a.length ? +[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : null;
        const pr = R.qualityProfile;
        resolve({
          frames: frames.length,
          elapsedMs: +elapsed.toFixed(0),
          medianMs: q(0.5),
          p90Ms: q(0.90),
          p95Ms: q(0.95),
          p99Ms: q(0.99),
          maxMs: +sorted[sorted.length - 1].toFixed(2),
          meanMs: +(elapsed / frames.length).toFixed(2),
          fpsThroughput: +((frames.length * 1000) / elapsed).toFixed(1),
          over33: frames.filter((f) => f > 33).length,
          over50: frames.filter((f) => f > 50).length,
          over80: frames.filter((f) => f > 80).length,
          longFrames: longs.sort((a, b) => b.ms - a.ms).slice(0, 12),
          presetStart: presets[0], presetEnd: presets[presets.length - 1],
          presetChanges,
          presetHistogram: presets.reduce((m, p2) => { m[p2] = (m[p2] || 0) + 1; return m; }, {}),
          profile: pr ? { name: pr.name, pixelRatioCap: pr.pixelRatioCap, gtao: pr.gtao, gtaoScale: pr.gtaoScale, gtaoSamples: pr.gtaoSamples, bloomScale: pr.bloomScale, shadowMapSize: pr.shadowMapSize, shadowInterval: pr.shadowInterval, msaaSamples: pr.msaaSamples, smaa: pr.smaa } : null,
          effectivePixelRatio: Math.min(devicePixelRatio || 1, pr ? pr.pixelRatioCap : 1),
          backbuffer: { w: R.renderer.domElement.width, h: R.renderer.domElement.height },
          callsPerFrame: s.n ? Math.round(s.calls / s.n) : null,
          ktrisPerFrame: s.n ? Math.round(s.tris / s.n / 1000) : null,
          composedFrames: s.n,
          cpuUpdateMs: med(s.upd),
          cpuRenderMs: med(s.ren),
          cpuUpdateP95: s.upd.length ? +[...s.upd].sort((a, b) => a - b)[Math.floor(s.upd.length * 0.95)].toFixed(2) : null,
          cpuRenderP95: s.ren.length ? +[...s.ren].sort((a, b) => a - b)[Math.floor(s.ren.length * 0.95)].toFixed(2) : null,
          programs: s.progs,
          monstersNear10Peak: peakVisible,
          monstersNear10Mean: nVisible ? +(sumVisible / nVisible).toFixed(1) : null,
          monstersLive: (() => { try { return window.__dcc.state.monsters.filter((m) => m.hp > 0).length; } catch { return -1; } })(),
        });
      }
    };
    requestAnimationFrame(tick);
    }), { secs: seconds, combat: scene.combat });
  }
  // ---- SCENE ASSERTION. A frame that does not contain what it claims is worse
  // than a missing frame, so prove the window was gameplay before believing it:
  // the crawler alive, and the #recap death/verdict panel NOT on screen.
  const claim = await page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    const recap = document.getElementById("recap");
    let recapUp = false;
    if (recap) {
      const r = recap.getBoundingClientRect();
      const cs = getComputedStyle(recap);
      recapUp = r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01;
    }
    return {
      playerHp: p ? p.hp : -1,
      playerMaxHp: p ? p.maxHp : -1,
      recapPanelUp: recapUp,
      deathsObserved: window.__alive ? window.__alive.deaths : -1,
      monstersLive: st.monsters.filter((m) => m.hp > 0).length,
    };
  });
  const sceneValid = claim.playerHp > 0 && !claim.recapPanelUp;
  console.log(`  SCENE ASSERTION: ${sceneValid ? "OK" : "*** MISSED ***"} ${JSON.stringify(claim)}`);

  // The wall-clock rows are only a CONTRACT number on an idle box. Say so in
  // the artifact rather than leaving it to a reader's memory of the session.
  const busy = sampleForeignLoad === null || sampleForeignLoad > FOREIGN_LOAD_LIMIT;
  const wallClockTrust = busy
    ? `CONTAMINATED (foreign browsers burned ${sampleForeignLoad}% of the box during this window — wall-clock rows are an UPPER BOUND, not the contract)`
    : `clean (foreign browser load during the window: ${sampleForeignLoad}% of the box)`;
  console.log("  wall-clock trust:", wallClockTrust);

  // ---- PER-PASS GPU TIME, same session, same staged scene.
  // EXT_disjoint_timer_query_webgl2 measures what the GPU itself spent
  // executing a command range, so it is immune to both the oversubscribed CPU
  // and to vsync pacing. Timer queries cannot nest, so the frame is cut into
  // NON-OVERLAPPING segments: entering a nested region ends the enclosing
  // query and starts a new one, and leaving it resumes the enclosing label.
  // Per-label ms therefore sum to the GPU cost of the composed frame.
  // (Same construction as tools/gputime.mjs; done here so the whole baseline is
  // one browser launch — this laptop crashed today under concurrent ones.)
  const passGpu = await page.evaluate((secs) => new Promise((resolve) => {
    const R = window.__dcc.renderer;
    const gl = R.renderer;
    const comp = R.composer;
    const ctx = gl.getContext();
    const ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) { resolve({ ok: false, why: "no EXT_disjoint_timer_query_webgl2" }); return; }

    // Chain is RenderPass -> GTAO -> Bloom -> Output -> Grade -> SMAA
    // (renderer3d.ts:1854-1891). Label by index so a reorder shows up as a
    // mismatch instead of a silently mislabelled row.
    const PASS_LABEL = ["1_Render(scene)", "3_GTAO", "4_Bloom", "5_Output", "6_Grade", "7_SMAA"];
    let curLabel = null, active = null;
    const pending = [];
    let frameIdx = 0;
    const perFrame = new Map();

    const endActive = () => { if (!active) return; ctx.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; };
    const mark = (label) => {
      endActive(); curLabel = label;
      if (!label) return;
      const q = ctx.createQuery();
      ctx.beginQuery(ext.TIME_ELAPSED_EXT, q);
      active = { q, label, f: frameIdx };
    };
    const drain = () => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const e = pending[i];
        if (!ctx.getQueryParameter(e.q, ctx.QUERY_RESULT_AVAILABLE)) continue;
        const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = ctx.getQueryParameter(e.q, ctx.QUERY_RESULT);
        ctx.deleteQuery(e.q); pending.splice(i, 1);
        if (disjoint) continue; // driver says the clock was disturbed — drop it
        let row = perFrame.get(e.f);
        if (!row) { row = {}; perFrame.set(e.f, row); }
        row[e.label] = (row[e.label] || 0) + ns / 1e6;
      }
    };
    const region = (obj, key, label) => {
      const orig = obj[key].bind(obj);
      obj[key] = function (...a) {
        const prev = curLabel;
        if (prev !== null) mark(label);
        try { return orig(...a); } finally { if (prev !== null) mark(prev); }
      };
    };
    const order = comp.passes.map((p, i) => `${i}:${p.constructor.name}`);
    comp.passes.forEach((p, i) => region(p, "render", PASS_LABEL[i] || `pass${i}_${p.constructor.name}`));
    region(gl.shadowMap, "render", "0_shadowMap");
    if (R.gtao && R.gtao.renderOverride) region(R.gtao, "renderOverride", "2_GTAO_normal_re-render");

    const origRender = comp.render.bind(comp);
    comp.render = function (...a) {
      mark("_composer_overhead");
      try { return origRender(...a); } finally { mark(null); frameIdx++; drain(); }
    };

    const start = performance.now();
    const tick = () => {
      if (performance.now() - start < secs * 1000) requestAnimationFrame(tick);
      else setTimeout(() => {
        // A row needs several labels present or it is a partially-drained frame.
        const rows = [...perFrame.values()].filter((r) => Object.keys(r).length >= 4);
        const keys = [...new Set(rows.flatMap(Object.keys))].sort();
        const med = (a) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? +s2[Math.floor(s2.length / 2)].toFixed(2) : 0; };
        const out = {};
        for (const k of keys) out[k] = med(rows.map((r) => r[k] || 0));
        out["=GPU TOTAL"] = med(rows.map((r) => Object.values(r).reduce((a, b) => a + b, 0)));
        comp.render = origRender;
        resolve({ ok: true, gpuFrames: rows.length, passOrder: order, passes: out });
      }, 400);
    };
    requestAnimationFrame(tick);
  }), Math.max(6, Math.round(seconds / 2)));

  if (passGpu.ok) {
    console.log("  per-pass GPU (median ms), chain =", passGpu.passOrder.join(" -> "));
    for (const [k, v] of Object.entries(passGpu.passes).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(30)} ${String(v).padStart(7)} ms GPU`);
    }
  } else console.log("  per-pass GPU: UNAVAILABLE —", passGpu.why);

  const shot = `${outDir}/${scene.id}.png`;
  await page.screenshot({ path: shot });

  const row = { scene: scene.id, label: scene.label, url, gpu, gameGpu, staged, shot, passGpu, loadBefore, loadAfter, wallClockTrust, sampleForeignLoadPct: sampleForeignLoad, sampleAttempts: attempt, idleGate: awaitIdle, sceneValid, sceneClaim: claim, status: sceneValid ? "OK" : "MISSED_NOT_GAMEPLAY", lateShaderBuilds: lateShaders.slice(0, 10), lateShaderCount: lateShaders.length, ...sample };
  results.push(row);
  console.log(JSON.stringify({
    scene: scene.id, status: sceneValid ? "OK" : "MISSED_NOT_GAMEPLAY",
    preset: sample.profile?.name, ePR: sample.effectivePixelRatio,
    backbuffer: sample.backbuffer,
    median: sample.medianMs, p99: sample.p99Ms, max: sample.maxMs, mean: sample.meanMs, fps: sample.fpsThroughput,
    over33: sample.over33, over50: sample.over50,
    calls: sample.callsPerFrame, ktris: sample.ktrisPerFrame,
    cpuUpd: sample.cpuUpdateMs, cpuRen: sample.cpuRenderMs,
    monstersNear10Peak: sample.monstersNear10Peak, monstersLive: sample.monstersLive,
    presetChanges: sample.presetChanges,
  }, null, 1));
}

writeFileSync(`${outDir}/baseline.json`, JSON.stringify(results, null, 2));
console.log(`\nWROTE ${outDir}/baseline.json`);
await browser.close();
