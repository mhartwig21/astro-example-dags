#!/usr/bin/env node
// gen-sfx-combat.mjs — the five P0 files that were wired end-to-end in
// director.ts and silent on disk (SOUNDPLAN §1.2): swing, tell, kill, crowd,
// boss_intro. House sound: dry menace, physical, broadcast-professional —
// no carnival. Deterministic (seeded); rerun to reproduce byte-for-byte.
//
// Family targets (SOUNDPLAN §2.2), enforced by master() and re-verified from
// the encoded files by tools/audio/measure.mjs:
//   impacts (kill)            -15 LUFS-ish momentary, peak <= -3 dBFS
//   tells/whoosh (swing/tell) -18 momentary, peak <= -6
//   crowd (sfx family)        -18 momentary, peak <= -6
//   announcer sting (intro)   -14 momentary, peak <= -3

import { SR, rng, buf, sine, saw, noise, pink, filt, env, gain, mix, shimmer, verb, master, declick } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const OUT = new URL("../../public/audio/sfx/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

// ---- swing: melee whoosh, ~0.18s. Air, not tone: bandpassed noise whose
// center dives 1600->350Hz — the arc of a heavy blade. Reads through the
// engine's ±5% rate jitter and still whooshes on a whiff.
{
  const r = rng(0x51119);
  let x = noise(0.19, r);
  filt(x, "bandpass", [1600, 350], 1.1);
  filt(x, "highpass", 140, 0.8);
  env(x, [[0, 0], [0.03, 0.35], [0.07, 1], [0.14, 0.5], [0.19, 0]]);
  // peak -7 pre-encode: vorbis overshoots ~0.5dB on noise transients, and the
  // measured-from-encode number is the one that must clear the -6 ceiling.
  master(x, { rmsDb: -18, peakDb: -7, windowSec: 0.1 });
  declick(x);
  renderOgg(OUT + "swing.ogg", x);
}

// ---- tell: enemy windup cue, ~0.28s. The game's fastest telegraph channel
// AND the per-boss pitched signature carrier (rate 0.75–1.35 must all read).
// A dry minor-second dyad swelling in — dissonant enough to mean danger,
// tonal enough to survive repitching.
{
  const r = rng(0x7e11);
  const a = sine(0.28, 620, 660);
  const b = sine(0.28, 660 * 1.06, 700 * 1.06);
  const grit = filt(noise(0.28, r), "bandpass", 2400, 4);
  let x = mix([a, 0, 0.55], [b, 0, 0.45], [grit, 0, 0.1]);
  env(x, [[0, 0], [0.09, 0.45], [0.2, 1], [0.28, 0]]);
  master(x, { rmsDb: -18, peakDb: -6, windowSec: 0.15 });
  declick(x);
  renderOgg(OUT + "tell.ogg", x);
}

// ---- kill: killing-blow thump layered over `hit`, ~0.24s. A pitch-dropping
// sub (95->42Hz) under a tight noise crack — meat, not fireworks.
{
  const r = rng(0xa11);
  const sub = sine(0.24, 95, 42);
  env(sub, [[0, 0], [0.004, 1], [0.16, 0.5], [0.24, 0]]);
  const crack = filt(noise(0.05, r), "bandpass", [3200, 900], 0.9);
  env(crack, [[0, 0], [0.002, 1], [0.05, 0]]);
  const body = filt(noise(0.12, r), "lowpass", 400, 0.9);
  env(body, [[0, 0], [0.008, 1], [0.12, 0]]);
  let x = mix([sub, 0, 1], [crack, 0, 0.5], [body, 0.004, 0.45]);
  // 0.4s window (= the measured momentary basis): the shipped Kenney `hit`
  // measures -13.8 mom at volume 0.8 (effective -15.7); kill at -15 file /
  // 0.9 volume sits right beside it with all its energy below 400Hz — the
  // "meatier" is spectral, not a loudness war.
  master(x, { rmsDb: -15, peakDb: -3, windowSec: 0.4 });
  declick(x);
  renderOgg(OUT + "kill.ogg", x);
}

// ---- crowd: the studio audience, ~1.5s swell. Formant-stacked pink noise
// with slow AM shimmer (many voices, no words), a step up and a die-down.
// Distant and dry-ish: the crowd is out there beyond the lights, and it
// NEVER laughs.
{
  const r = rng(0xc80d);
  const layers = [
    [400, 2, 0.9], [780, 2.5, 0.7], [1500, 3, 0.45], [240, 1.5, 0.6],
  ].map(([f, q, g]) => {
    const n = pink(1.5, r);
    filt(n, "bandpass", f, q);
    return [n, 0, g];
  });
  let x = mix(...layers);
  shimmer(x, r, 7, 0.55);
  env(x, [[0, 0], [0.12, 0.55], [0.3, 1], [0.8, 0.85], [1.5, 0]]);
  x = verb(x, { time: 0.5, wet: 0.18, damp: 0.55 });
  master(x, { rmsDb: -18, peakDb: -6 });
  declick(x);
  renderOgg(OUT + "crowd.ogg", x);
}

// ---- boss_phase: the phase-transition HIT (SOUNDPLAN row 15 — band_sting
// was doing double duty). A dry cluster impact + short upward sweep: the
// fight just changed shape, says the broadcast.
{
  const r = rng(0xb0552);
  const hit = [98, 98 * 1.012, 147].map((f, i) => {
    const s = saw(0.7, f, f * 0.99);
    filt(s, "lowpass", 900, 0.8);
    env(s, [[0, 0], [0.005, 1], [0.4, 0.4], [0.7, 0]]);
    return [s, 0, i < 2 ? 0.5 : 0.35];
  });
  const sweep = filt(noise(0.35, r), "bandpass", [500, 3200], 1.4);
  env(sweep, [[0, 0], [0.28, 0.7], [0.35, 0]]);
  const sub = sine(0.4, 80, 45);
  env(sub, [[0, 0], [0.005, 1], [0.4, 0]]);
  let x = mix([sweep, 0, 0.5], ...hit.map(([s, at, g]) => [s, 0.3, g]), [sub, 0.3, 0.9]);
  x = verb(x, { time: 0.5, wet: 0.14, damp: 0.4 });
  master(x, { rmsDb: -14, peakDb: -4.5, windowSec: 0.4 });
  declick(x);
  renderOgg(OUT + "boss_phase.ogg", x);
}

// ---- boss_punish: the unload window OPENS — a crowd gasp (inhale swell)
// into a dry crack. The one moment the studio holds its breath.
{
  const r = rng(0xb0553);
  const gasp = filt(pink(0.4, r), "bandpass", [600, 1800], 1.6);
  env(gasp, [[0, 0], [0.3, 1], [0.4, 0.2]]);
  const crack = filt(noise(0.06, r), "bandpass", [4200, 1200], 0.9);
  env(crack, [[0, 0], [0.002, 1], [0.06, 0]]);
  const thump = sine(0.2, 130, 60);
  env(thump, [[0, 0], [0.004, 1], [0.2, 0]]);
  let x = mix([gasp, 0, 0.7], [crack, 0.4, 1], [thump, 0.4, 0.9]);
  master(x, { rmsDb: -14, peakDb: -4.5, windowSec: 0.3 });
  declick(x);
  renderOgg(OUT + "boss_punish.ogg", x);
}

// ---- boss_down: the LOW TAIL layered under kill+crowd on DEFEATED — a sub
// drop and a long dark decay. The building settles over the corpse.
{
  const r = rng(0xb0554);
  const drop = sine(1.4, 90, 30);
  env(drop, [[0, 0], [0.01, 1], [0.8, 0.4], [1.4, 0]]);
  const rumble = filt(noise(1.4, r), "lowpass", 160, 0.9);
  env(rumble, [[0, 0], [0.05, 0.8], [1.4, 0]]);
  let x = mix([drop, 0, 1], [rumble, 0, 0.6]);
  x = verb(x, { time: 0.8, wet: 0.2, damp: 0.6 });
  master(x, { rmsDb: -15, peakDb: -4.5, windowSec: 0.5 });
  declick(x);
  renderOgg(OUT + "boss_down.ogg", x);
}

// ---- boss_intro: THE RINGSIDE INTRODUCTION, ~1.7s. Stinger language, not a
// fanfare: a noise riser into a detuned low brass-cluster hit with a sub
// thump, and a single dry broadcast "ping" over the decay. A little too
// professional — that's the System.
{
  const r = rng(0xb055);
  const riser = filt(noise(0.5, r), "bandpass", [300, 2600], 1.4);
  env(riser, [[0, 0], [0.4, 0.8], [0.5, 0]]);
  const clusterF = [55, 55 * 1.01, 82.5, 110 * 0.995, 130.8];
  const hits = clusterF.map((f, i) => {
    const s = saw(1.2, f, f * 0.985);
    filt(s, "lowpass", 700, 0.8);
    env(s, [[0, 0], [0.006, 1], [0.55, 0.5], [1.2, 0]]);
    return [s, 0.5, i < 2 ? 0.5 : 0.32];
  });
  const sub = sine(0.5, 70, 38);
  env(sub, [[0, 0], [0.005, 1], [0.35, 0.4], [0.5, 0]]);
  const ping = sine(0.35, 1975);
  env(ping, [[0, 0], [0.004, 0.5], [0.35, 0]]);
  let x = mix([riser, 0, 0.5], ...hits, [sub, 0.5, 1], [ping, 1.05, 0.16]);
  x = verb(x, { time: 0.7, wet: 0.16, damp: 0.4 });
  master(x, { rmsDb: -14, peakDb: -3, windowSec: 0.4 });
  declick(x);
  renderOgg(OUT + "boss_intro.ogg", x);
}
