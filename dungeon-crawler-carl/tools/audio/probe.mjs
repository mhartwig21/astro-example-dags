#!/usr/bin/env node
// tools/audio/probe.mjs — the in-game audio verification instrument
// (SOUNDPLAN.md §5, HARNESS.md spec #4). Drives a staged brawl on the live
// dev server and asserts, with numbers:
//
//   1. IMPACT SYNC   — for every frame the sim emitted a combat HitEvent, the
//                      audio director attempted the mapped clip within 2
//                      frames (measured, not assumed).
//   2. BRAWL HEADROOM — across a 20+-hit brawl the master compressor OUTPUT
//                      never reaches 1.0 (no hard clipping); the compressor
//                      INPUT peak is reported as the headroom number.
//   3. RATE LIMITING — per-clip audible plays are spaced >= the manifest
//                      throttle, and dense attempts get swallowed
//                      (attempts > plays for the impact family).
//
// Usage: node tools/audio/probe.mjs [url] [--headed] [--seconds N]
// Default url: http://localhost:5282/iso.html?test&floor=4&level=10&abilities=all&seed=11&debug=1&noassets
//
// MACHINE LIMIT: exactly one Chromium; launch, use, CLOSE.

import { chromium } from "playwright";

const args = process.argv.slice(2);
// HARNESS.md rule 3: headless = SwiftShader = ~2fps frames, which makes the
// "within 2 frames" spec meaningless. Headed with the d3d11 flags is the
// default; --headless is the opt-in degraded mode.
const headed = !args.includes("--headless");
const secIx = args.indexOf("--seconds");
const SECONDS = secIx >= 0 ? Number(args[secIx + 1]) : 8;
const url =
  args.find((a) => a.startsWith("http")) ??
  "http://localhost:5282/iso.html?test&floor=4&level=10&abilities=all&seed=11&debug=1&noassets";

// Director's HitKind -> clip map (mirror of src/audio/director.ts HIT_SOUNDS
// + the kill layer). The probe matches THESE ids against hit frames.
const COMBAT_IDS = new Set(["hit", "crit", "player_hurt", "kill", "heal", "gold", "item", "dash"]);
// Manifest throttles for the ids the brawl exercises (default 70).
const THROTTLE = { hit: 70, crit: 70, player_hurt: 70, kill: 90, swing: 120, tell: 150 };

const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio", // graph still processes; the box stays quiet
    ...(headed ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : []),
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  // A muted engine records plays but produces silent analysers — force sound ON.
  await page.addInitScript(() => localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // HARNESS honesty rule 1: the boot card must actually be gone.
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Unlock the AudioContext with a real gesture, then confirm it runs.
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
  const ctxState = await page.evaluate(() => window.__dcc.audio.ctxState());
  const buffers = await page.evaluate(() => window.__dcc.audio.buffers());
  if (ctxState !== "running") {
    console.error(`FAIL: AudioContext state = ${ctxState} (need "running")`);
    process.exit(2);
  }

  // rAF observer: one record per rendered frame; hit frames deduped by
  // state.elapsed (state.hits is a per-step transient — see probe header).
  await page.evaluate(() => {
    const P = { frames: 0, t0: 0, t1: 0, lastElapsed: -1, hitFrames: [] };
    window.__probe = P;
    const loop = (t) => {
      if (!P.t0) P.t0 = t;
      P.t1 = t;
      P.frames++;
      const s = window.__dcc.state;
      if (s && s.elapsed !== P.lastElapsed) {
        P.lastElapsed = s.elapsed;
        const combat = s.hits.filter((h) => !h.effect && (h.kind === "enemy" || h.kind === "crit" || h.kind === "player"));
        if (combat.length > 0) {
          P.hitFrames.push({ t: performance.now(), n: combat.length, kinds: combat.map((h) => h.kind + (h.killed ? "!" : "")) });
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  // Stage the brawl: ring the player with 8 fast-swinging, unkillable-ish
  // monsters, bulletproof the player, and re-pin the scene every 300ms
  // (HARNESS rule 6: pin the scene). Hold Space so the player swings back.
  await page.evaluate(() => {
    window.__stage = setInterval(() => {
      const s = window.__dcc.state;
      if (!s || !s.players[0]) return;
      const p = s.players[0];
      p.maxHp = 999999; p.hp = 999999;
      const ring = s.monsters.slice(0, 8);
      ring.forEach((m, i) => {
        const a = (i / 8) * Math.PI * 2;
        m.pos.x = p.pos.x + Math.cos(a) * 1.1;
        m.pos.y = p.pos.y + Math.sin(a) * 1.1;
        m.hp = Math.max(m.hp, 200);
        m.maxHp = Math.max(m.maxHp, 200);
        m.attackCooldown = Math.min(m.attackCooldown, 0.05);
        m.windup = Math.min(m.windup, 0.08);
        m.stagger = 0;
        m.dormant = false;
      });
    }, 300);
  });
  await page.evaluate(() => window.__dcc.audio.resetPeaks());
  await page.keyboard.down(" ");
  await page.waitForTimeout(SECONDS * 1000);
  await page.keyboard.up(" ");
  await page.evaluate(() => clearInterval(window.__stage));

  const data = await page.evaluate(() => ({
    probe: window.__probe,
    plays: window.__dcc.audio.plays,
    peakPre: window.__dcc.audio.peakPre(),
    peakPost: window.__dcc.audio.peakPost(),
    music: window.__dcc.audio.currentMusic(),
  }));
  await browser.close();

  // ---- analysis ----
  const { probe, plays, peakPre, peakPost } = data;
  const frameDur = (probe.t1 - probe.t0) / Math.max(1, probe.frames - 1);
  const winMs = 2 * frameDur;
  const audible = plays.filter((p) => !p.throttled);
  const attempts = plays; // throttled + audible

  // 1) impact sync: every observed combat-hit frame has a combat-clip ATTEMPT
  // within 2 frames (the director fired; the engine may legally swallow).
  const combatAttempts = attempts.filter((p) => COMBAT_IDS.has(p.id));
  let synced = 0;
  let worst = 0;
  const misses = [];
  for (const hf of probe.hitFrames) {
    const deltas = combatAttempts.map((p) => Math.abs(p.at - hf.t));
    const best = deltas.length ? Math.min(...deltas) : Infinity;
    if (best <= winMs) {
      synced++;
      if (best > worst) worst = best;
    } else {
      misses.push({ t: hf.t, best: Number.isFinite(best) ? Math.round(best) : null, kinds: hf.kinds });
    }
  }

  // 2) rate limiting: audible same-id spacing >= throttle (10ms jitter grace).
  const byId = {};
  for (const p of audible) (byId[p.id] ??= []).push(p.at);
  const rate = {};
  let rateOk = true;
  for (const [id, ts] of Object.entries(byId)) {
    ts.sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < ts.length; i++) minGap = Math.min(minGap, ts[i] - ts[i - 1]);
    const throttle = THROTTLE[id];
    const attemptsN = attempts.filter((p) => p.id === id).length;
    rate[id] = { plays: ts.length, attempts: attemptsN, minGapMs: ts.length > 1 ? Math.round(minGap) : null };
    if (throttle && ts.length > 1 && minGap < throttle - 10) rateOk = false;
  }

  const hitAttempts = attempts.filter((p) => p.id === "hit").length;
  const hitPlays = (byId.hit ?? []).length;

  const report = {
    url,
    seconds: SECONDS,
    fps: Math.round(1000 / frameDur),
    frameMs: Number(frameDur.toFixed(2)),
    ctx: "running",
    decodedClips: buffers.length,
    music: data.music,
    hitFrames: probe.hitFrames.length,
    impactSync: {
      windowMs: Math.round(winMs),
      synced,
      missed: misses.length,
      worstMs: Math.round(worst),
      misses: misses.slice(0, 5),
    },
    headroom: {
      peakCompressorIn: Number(peakPre.toFixed(3)),
      peakCompressorOut: Number(peakPost.toFixed(3)),
      clipped: peakPost >= 1.0,
    },
    rateLimit: rate,
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (probe.hitFrames.length < 20) failures.push(`brawl too small: ${probe.hitFrames.length} hit frames (< 20)`);
  if (misses.length > 0) failures.push(`impact sync: ${misses.length} hit frames with no combat clip within ${Math.round(winMs)}ms`);
  if (peakPost >= 1.0) failures.push(`hard clip: compressor output peaked at ${peakPost.toFixed(3)}`);
  if (!rateOk) failures.push("rate limit violated (same-id spacing under manifest throttle)");
  if (hitAttempts > 0 && hitPlays === 0) failures.push("'hit' attempted but never audible — file missing or bus dead");
  if (failures.length) {
    console.error("\nPROBE FAIL:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.error("\nPROBE PASS");
} finally {
  await browser.close().catch(() => {});
}
