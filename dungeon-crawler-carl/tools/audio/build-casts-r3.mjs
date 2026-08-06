#!/usr/bin/env node
// build-casts-r3.mjs — THE ACT, take three: the same briefs, RECORDED sources.
//
// Audio r3 exists because of one owner verdict (SOUNDPLAN §1.3a, 2026-08-05,
// verbatim): "hmm it all sounds very robotic -- not necessarily what i was
// looking for sound effects." That verdict is about CHARACTER, not levels —
// the r2 renders were measurement-clean and still read as oscillators. So
// this script keeps gen-sfx-casts.mjs's sonic briefs (what each cue MEANS)
// and replaces every oscillator with a RECORDING: real air being displaced,
// real steel being struck, real wood, a real winch, a real circuit breaker,
// a real cave-in, a real machine spinning down, real thunder.
//
// Sources: tools/audio/r3_src/*.wav — trimmed mono-48k snippets of CC0
// recordings fetched from OpenGameArt (per-file provenance in ASSETS.md).
// Processing per layer: trim / pitch (resample) / pitch-ramp / reverse /
// biquad EQ / envelope — foley editing, not synthesis. The only synthesis
// left in the family is silence.
//
// The 14 cues this script owns (the §1.3a rejected set):
//   cast_dash        the body leaves (real swish, energy at the front)
//   cast_orbit       the ring un-ships (real metal ring, pitched away)
//   cast_stance      a selector detent (real wood chock + switch click)
//   cast_overcharge  a breaker thrown (a REAL breaker, then a buzz banked)
//   cast_cutto       two transients with a hole (swish thup .. blade tick)
//   cast_crowdsurf   a winch paying out (a real winch) into one clank
//   cast_stuntdouble the professional clocks in (wood slate, body lands)
//   cast_bulwark     a plate planted (real slam), a struck-metal dome held
//   cast_cables      two pins (real clunks), a real creak tensioning up
//   cast_airstrike   the call goes in (real static syllables, real whistle
//                    bent down, real thunder as the departure)
//   cast_cataclysm   the floor gives (a real cave-in, real rockfall)
//   cast_bullettime  the projector jams (a real machine powering down)
//   cast_injunction  the gavel (real wood), swallowed (a ring, reversed)
//   level_up         the System files a promotion (a REAL typewriter stamp,
//                    a real bell stepping G5 -> C6, done in a third of a second)
//
// chain_line and weapon_flash stay with gen-sfx-casts.mjs: they are room-tone
// ticks, they were not on the audition sheet, and they carry no verdict.
//
// Mastering targets are unchanged from r2 (SOUNDPLAN §2.2 / §2.2a): the mix
// contract was never the problem. Deterministic: fixed sources, fixed edits,
// bitexact encode — rerun reproduces the bytes.
//
// `node tools/audio/build-casts-r3.mjs --measure` prints the pre-encode table.

import { execFileSync } from "node:child_process";
import { SR, secs, rng, buf, noise, filt, env, mix, gain, verb, master, declick, peakDb as peakOf, momentaryDb as momOf } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const SRC = HERE + "r3_src/";
const OUT = HERE + "../../public/audio/sfx/";
const MEASURE = process.argv.includes("--measure");

const ACTIVE = { rmsDb: -17, peakDb: -5.3, windowSec: 0.4, iters: 4 };
const ULT = { rmsDb: -14.5, peakDb: -3.8, windowSec: 0.4, iters: 4 };

// ------------------------------------------------------------ source I/O --
const cache = new Map();
/** Decode a source snippet to mono Float32 at 48k (they are stored that way). */
function src(name) {
  if (!cache.has(name)) {
    const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error",
      "-i", SRC + name + ".wav", "-ar", String(SR), "-ac", "1", "-f", "f32le", "-"],
      { maxBuffer: 1 << 30 });
    cache.set(name, new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2));
  }
  return Float32Array.from(cache.get(name));
}

// --------------------------------------------------------- foley editing --
/** Normalize peak to 1 so mix gains mean the same thing they meant for the
 *  r2 oscillators (which were born at ±1). Recordings arrive at any level. */
function norm(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  if (p > 0) for (let i = 0; i < x.length; i++) x[i] /= p;
  return x;
}
const slice = (x, t0, t1) => x.slice(secs(t0), t1 === undefined ? x.length : secs(t1));
/** Repitch by resampling: ratio 2 = up an octave and half the length. */
function pitch(x, ratio) {
  const n = Math.max(1, Math.floor(x.length / ratio));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, j = Math.floor(p), f = p - j;
    o[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f;
  }
  return o;
}
/** Variable-rate read, ratio sweeping r0 -> r1 geometrically over durSec.
 *  A recording of a steady thing becomes a thing that rises or falls. */
function pitchRamp(x, r0, r1, durSec) {
  const n = secs(durSec);
  const o = new Float32Array(n);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const j = Math.floor(p), f = p - j;
    if (j >= x.length - 1) break;
    o[i] = x[j] * (1 - f) + x[j + 1] * f;
    p += r0 * Math.pow(r1 / r0, i / n);
  }
  return o;
}
/** A decay played backwards is an inhale that stops. */
function rev(x) {
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = x[x.length - 1 - i];
  return o;
}
const trim = (x, sec) => x.slice(0, Math.min(x.length, secs(sec)));
/** THE LESSON THAT SEPARATES r3 FROM A SYNTH: a recording does not begin
 *  where the sound does. A microphone is already rolling when the hammer
 *  lands, so every snippet in r3_src carries pre-roll — measured, at the
 *  onset survey: metal_slam's slam starts 43ms in, breaker_on's throw 142ms
 *  in, sword_clash's clash 109ms in, mech_clank's clank 65ms in. The first
 *  r3 cut enveloped these as if t=0 were the strike, which multiplied every
 *  transient by whatever the attack ramp had reached by the time the real
 *  one arrived — and in the worst cases (`trim(sword_clash, 0.02)`,
 *  `trim(breaker_on, 0.09)`, `trim(mech_clunk, 0.06)`) kept nothing but the
 *  room tone, so the layer the brief was built around was simply not in the
 *  file. This finds the first sample at `frac` of the clip's peak and starts
 *  `back` seconds ahead of it. An oscillator never needed this; a recording
 *  always does. */
function onset(x, frac = 0.06, back = 0.0015) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  let k = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= frac * p) { k = i; break; }
  return x.slice(Math.max(0, k - secs(back)));
}
/** A struck source: onset-aligned, trimmed, peak-normalised — the three
 *  things every percussive layer in this file wanted, in one call. */
const hit = (name, durSec) => norm(durSec === undefined ? onset(src(name)) : trim(onset(src(name)), durSec));
/** Start at the CREST, not the onset. A swish that winds up for 35ms becomes
 *  a swish that has already arrived — which is what a cast cue owes the
 *  button. Same trick, higher threshold. */
const crest = (name, durSec, back = 0.004) => norm(trim(onset(src(name), 0.85, back), durSec));

const rows = [];
function emit(id, x, spec) {
  master(x, spec);
  declick(x, 0.003);
  renderOgg(OUT + id + ".ogg", x);
  rows.push({ id, sec: +(x.length / SR).toFixed(3), peak: +peakOf(x).toFixed(1), mom: +momOf(x, spec.windowSec ?? 0.4).toFixed(1), target: spec.rmsDb });
}

// ---- cast_dash (~0.21s): a body displacing AIR — now an actual recording of
// air being displaced (Swishes Sound Pack). Energy at the front, the mass
// falling away behind: the swish is re-enveloped to speak in ~2ms (the raw
// take winds up for 35ms, and the r2 lesson was that a cast must acknowledge
// the button), a second darker swish pitched down 0.45 is the mass HINT under
// it (0.16 — the first r2 render taught us what happens when the mass leads),
// and a tiny bright swish is the push-off scuff.
{
  const air = crest("swish_b", 0.19);                       // starts AT the crest
  filt(air, "lowpass", 2400, 0.7);
  filt(air, "highpass", 300, 0.7);
  env(air, [[0, 0], [0.004, 1], [0.06, 0.55], [0.19, 0]]);
  const scuff = crest("swish_e", 0.05, 0.002);              // push-off grit
  filt(scuff, "highpass", 900, 0.8);
  env(scuff, [[0, 0], [0.0025, 1], [0.05, 0]]);
  const mass = pitch(crest("swish_b", 0.09), 0.45);         // the body, behind
  filt(mass, "lowpass", 420, 0.8);
  env(mass, [[0, 0], [0.006, 0.9], [0.12, 0.3], [0.20, 0]]);
  emit("cast_dash", trim(mix([air, 0, 1], [scuff, 0, 0.22], [mass, 0.004, 0.16]), 0.19), ACTIVE);
}

// ---- cast_orbit (~0.30s): the ring UN-SHIPS. A real struck metal ring
// (bing, 2.1kHz) bent DOWNWARD as it leaves (pitch ramp 1.06 -> 0.78 — the
// doppler of a thing receding), over the grit of a real sword-draw; the
// un-ship bite is the first 30ms of a real sword clash, and the hub it
// leaves is the low ring pitched under it. Pitched, receding, hangs — where
// `swing` is broadband, arriving, dry.
{
  const ring = pitchRamp(hit("ring_bright"), 1.06, 0.78, 0.30);
  env(ring, [[0, 0], [0.006, 1], [0.12, 0.45], [0.30, 0]]);
  const grind = norm(slice(src("sword_draw"), 0.15, 0.47)); // past the draw's onset (155ms)
  filt(grind, "bandpass", 2400, 1.0);
  env(grind, [[0, 0], [0.006, 0.9], [0.10, 0.4], [0.28, 0]]);
  const bite = hit("sword_clash", 0.03);                    // the clash is 109ms into the take
  filt(bite, "highpass", 1200, 0.8);
  env(bite, [[0, 0], [0.0015, 1], [0.03, 0]]);
  const hub = pitch(hit("ring_low", 0.30), 2.0);            // 419 -> ~840, short
  filt(hub, "lowpass", 500, 0.8);
  env(hub, [[0, 0], [0.003, 1], [0.06, 0.3], [0.13, 0]]);
  const x = mix([ring, 0, 0.9], [grind, 0, 0.4], [bite, 0, 0.55], [hub, 0, 0.5]);
  filt(x, "highpass", 190, 0.7);
  emit("cast_orbit", trim(x, 0.30), ACTIVE);
}

// ---- cast_stance (~0.11s): a selector detent. ONE real hardwood chock
// (wood_hit_05 — 955Hz, woody, damped) with a real switch snap as its click,
// and nothing after it. Still the shortest, quietest cue in the family; the
// fatigue bet is unchanged.
{
  const chock = hit("wood_chock", 0.10);                    // the chock is 57ms into the take
  env(chock, [[0, 0], [0.002, 1], [0.05, 0.25], [0.10, 0]]);
  // The snap is a whisper, not the voice (0.2, lowpassed): with it at 0.45
  // the matrix put stance's centroid at 5714Hz — a bright tick in the same
  // register as cutto's knife-edge arrival, 1.54 apart. A selector detent
  // is WOOD; the 955Hz chock is the sound.
  const snap = hit("click_snap", 0.03);                     // the snap is 52ms into the take
  filt(snap, "bandpass", 2200, 1.0);
  env(snap, [[0, 0], [0.0012, 1], [0.03, 0]]);
  emit("cast_stance", trim(mix([chock, 0, 1], [snap, 0, 0.2]), 0.11), ACTIVE);
}

// ---- cast_overcharge (~0.30s): a breaker thrown — by an actual recording of
// a breaker being thrown (SFX - Circuit breaker). Then a real electrical buzz
// bent UP a fifth over 220ms that CUTS OFF DEAD at the top: the power is
// banked, the sound stops instead of resolving. The spark burst under the
// rise is a real arc. The director still replays this file at rate 1.3 /
// gain 0.55 on the SPEND edge — one file, two moments.
{
  const clack = hit("breaker_on", 0.09);                    // the throw is 142ms into the take
  env(clack, [[0, 0], [0.0015, 1], [0.05, 0.3], [0.09, 0]]);
  const whine = pitchRamp(hit("buzz"), 1.0, 1.5, 0.245);
  filt(whine, "highpass", 350, 0.7);
  filt(whine, "lowpass", 2600, 0.8);
  env(whine, [[0, 0], [0.02, 0.25], [0.13, 0.6], [0.235, 1], [0.243, 1], [0.245, 0]]); // the cut
  const arc = norm(trim(src("spark_burst"), 0.20));
  env(arc, [[0, 0], [0.03, 0.3], [0.18, 0.55], [0.20, 0]]);
  // Tighter pre-encode ceiling: the real breaker transient + dense buzz
  // overshoot vorbis ~1.8dB (measured on the first r3 encode: -5.4 pre,
  // -3.6 encoded, ceiling -4.5 — a breach the file table would have shipped).
  emit("cast_overcharge", trim(mix([clack, 0, 1], [whine, 0.03, 0.6], [arc, 0.05, 0.22]), 0.285), { ...ACTIVE, peakDb: -8.2 });
}

// ---- cast_cutto (~0.22s): two transients with a hole between them. The THUP
// is a real swish pitched down to a compressed-air slap; the hole is ~90ms of
// near-silence (a whisper of real static where the smoke hangs); the ARRIVAL
// is the first 20ms of a real blade clash plus a real clink. vs cast_dash:
// dash is one continuous whoosh; this is two impulses and a gap.
{
  const thup = pitch(crest("swish_a", 0.07, 0.003), 0.72);
  filt(thup, "lowpass", 1400, 0.8);
  env(thup, [[0, 0], [0.003, 1], [0.065, 0]]);
  const smoke = norm(trim(src("static"), 0.13));
  filt(smoke, "bandpass", 2600, 1.6);
  env(smoke, [[0, 0], [0.02, 0.08], [0.13, 0.02]]);
  // The arrival is BRIGHT on purpose (highpass 3200, and the clink rides
  // full): the first r3 matrix run put cutto 1.64 from cast_stance — two
  // dark clacks at two lengths. The knife-edge is the axis that separates
  // a teleport's arrival from a selector detent.
  const tick = hit("sword_clash", 0.02);                    // the clash is 109ms into the take
  filt(tick, "highpass", 3200, 0.8);
  env(tick, [[0, 0], [0.001, 1], [0.02, 0]]);
  const edge = hit("clink_b", 0.06);                        // the clink is 42ms in
  filt(edge, "highpass", 2600, 0.8);
  env(edge, [[0, 0], [0.0015, 0.7], [0.06, 0]]);
  // Pre-encode ceiling tightened to -6.0: with the arrival transients now
  // actually IN the file (they were room tone before onset alignment), the
  // encoded peak measured -3.9 against the family's -4.5 ceiling.
  emit("cast_cutto", trim(mix([thup, 0, 1], [smoke, 0.03, 0.5], [tick, 0.155, 1], [edge, 0.157, 0.8]), 0.22), { ...ACTIVE, peakDb: -8.8 });
}

// ---- cast_crowdsurf (~0.35s): a winch paying out — an actual winch
// (Chain winch sounds), its ratchet grains thinning as the line travels,
// ending in ONE load-bearing clank (a real metal hit) with a real landing's
// low end under it. The first link takes the load at t=0 (r2 lesson: the
// picture commits on the cast frame, so must the sound).
{
  const payout = norm(slice(src("winch_payout"), 0.21, 0.53)); // past the ratchet's onset (207ms)
  filt(payout, "bandpass", 1900, 0.9);
  env(payout, [[0, 0], [0.01, 1], [0.20, 0.5], [0.26, 0.15]]);
  const firstLink = hit("metal_clank_a", 0.03);
  filt(firstLink, "highpass", 1000, 0.8);
  env(firstLink, [[0, 0], [0.0015, 1], [0.03, 0]]);
  const clank = hit("metal_clank_b", 0.10);
  env(clank, [[0, 0], [0.002, 1], [0.10, 0]]);
  const load = crest("body_land_a", 0.12);                   // the landing's weight, not its approach
  filt(load, "lowpass", 260, 0.8);
  env(load, [[0, 0], [0.005, 0.9], [0.12, 0]]);
  // Same tightened pre-encode ceiling as r2 (-6.5): sparse grains + a clank
  // transient overshoot vorbis ~1.6dB, measured on the r2 render.
  emit("cast_crowdsurf", trim(mix([firstLink, 0, 0.75], [payout, 0, 0.8], [clank, 0.25, 0.9], [load, 0.252, 0.6]), 0.36), { ...ACTIVE, peakDb: -6.5 });
}

// ---- cast_stuntdouble (~0.42s): the professional clocks in. The slate is a
// real dry wood clack (broadcast, no room), and the DOUBLE landing ~190ms
// behind it is a real jump-landing thud doubled with a wood block at body
// pitch — two bodies' worth of floor. The settle after is the low half of a
// real fall. No bell, no chime, nothing that reads as pickup.
{
  // The slate keeps its BITE (highpass 900): un-filtered, the landing thuds
  // dragged the whole clip's centroid down to 1869Hz — 66Hz from bulwark's
  // dome (1.27 on the matrix). A film slate is the brightest wood on a set;
  // the double may be heavy, the slate is not.
  const slate = hit("wood_clack", 0.09);
  filt(slate, "highpass", 1400, 0.7);
  env(slate, [[0, 0], [0.0015, 1], [0.05, 0.25], [0.09, 0]]);
  const landA = pitch(crest("body_land_b", 0.30), 1.15);     // the floor taking it, not the fall
  filt(landA, "lowpass", 900, 0.8);
  filt(landA, "highpass", 110, 0.7); // body, not subwoofer — the sub octave was half the clip's lowShare
  env(landA, [[0, 0], [0.006, 1], [0.15, 0.2], [0.24, 0]]);
  const landB = pitch(hit("wood_block", 0.20), 0.85);
  env(landB, [[0, 0], [0.004, 0.9], [0.16, 0]]);
  const scuff = pitch(crest("swish_c", 0.14), 0.8);
  filt(scuff, "lowpass", 760, 0.9);
  env(scuff, [[0, 0], [0.006, 0.8], [0.09, 0.3], [0.20, 0]]);
  const settle = norm(slice(src("body_hit_low"), 0.02, 0.24));
  filt(settle, "bandpass", 600, 1.1);
  env(settle, [[0, 0], [0.03, 0.35], [0.22, 0]]);
  // The double's footsteps INTO frame bridge the slate and the landing (the
  // first r3 cut left 100ms of dead air there and measured 23% silence — a
  // gap reads as an edit, a footfall reads as someone arriving).
  const arrive = pitch(hit("swish_c"), 1.3);
  filt(arrive, "lowpass", 600, 0.9);
  env(arrive, [[0, 0], [0.01, 0.5], [0.14, 0]]);
  // Pre-encode ceiling tightened to -6.0: the slate is a real hardwood crack
  // and once it was onset-aligned the encoded peak measured -3.8 against the
  // family's -4.5 ceiling.
  emit("cast_stuntdouble", trim(mix(
    [slate, 0, 1.15], [arrive, 0.07, 0.3], [landA, 0.19, 0.55], [landB, 0.216, 0.45],
    [scuff, 0.19, 0.25], [settle, 0.30, 0.3],
  ), 0.41), { ...ACTIVE, peakDb: -6.9 });
}

// ---- cast_bulwark (~0.45s): a plate planted, and then THE DOME. The plant
// is a real metal slam (low, damped fast — a plate, not a bell), and the
// dome is a real struck metal ring pitched to ~262Hz, swelling under it and
// HOLDING for the length of the clip. The r2 lesson stands: the shell
// carries the level, the thunk is only the attack.
{
  // THE FIX THE LAST ROUND FLAGGED AND COULD NOT LAND: the plant did not
  // carry the peak (measured attack 294ms — the dome's bloom, and 1.07 from
  // cast_cataclysm on the matrix, the family's one flagged pair). Raising
  // the thunk's gain could not fix it because the thunk was not there:
  // metal_slam's slam is 43ms into the take and crests at 60ms, so an
  // envelope peaking at 2ms was multiplying room tone by 1 and the slam by
  // 0.35. Onset-aligned, and with the envelope HOLDING through the
  // recording's own 18ms rise instead of decaying across it, the plant is a
  // real transient at t=0 and owns the peak by construction.
  const thunk = hit("metal_slam", 0.16);
  // A PLATE, not a bell. Onset-aligned, metal_slam's raw clang dragged the
  // whole clip's centroid to 2180Hz and its rolloff85 to 5648 — 119Hz from
  // cast_stuntdouble's slate (1.55 on the matrix, the family's new flagged
  // pair) and flatly contrary to bulwark's own brief, which is a closed
  // hollow. The lowpass keeps the transient's timing and throws away the
  // ring that made it read as a struck bell.
  filt(thunk, "lowpass", 1500, 0.8);
  env(thunk, [[0, 0], [0.0015, 1], [0.03, 1], [0.09, 0.3], [0.16, 0]]);
  const oak = hit("wood_hammer", 0.09);
  filt(oak, "lowpass", 800, 0.8);
  env(oak, [[0, 0], [0.003, 0.9], [0.02, 0.9], [0.09, 0]]);
  // The dome is DARK and DAMPED (lowpass 900 on the ring): the first r3
  // matrix run put bulwark 0.83 from cast_cables — two pitched-metal
  // sustains in the same register. The split is now material: bulwark is a
  // closed hollow (low, sealed, all fundamental), cables is an open line
  // (bright, creaking, singing). Both survive a 250Hz highpass.
  // The PLANT carries the peak (dome capped at 0.72): with the dome at 0.9
  // the file's peak landed 294ms in — the same late-blooming envelope as
  // cataclysm's rumble (1.11 on the matrix, attack 294ms vs 261ms). A plate
  // is planted AT the button; the dome holds UNDER it.
  const shellEnv = [[0, 0], [0.09, 0.3], [0.24, 0.72], [0.48, 0.68], [0.60, 0]];
  const shell = pitch(hit("ring_low"), 0.625);                // 419 -> ~262Hz
  filt(shell, "lowpass", 900, 0.8);
  env(shell, shellEnv);
  const shellHi = pitch(hit("ring_low"), 0.94);               // -> ~394Hz, the rim
  env(shellHi, shellEnv);
  const shellRoot = pitch(hit("ring_low"), 0.31);             // -> ~130Hz, the seal
  filt(shellRoot, "lowpass", 500, 0.8);
  env(shellRoot, shellEnv);
  const shellAir = norm(trim(src("static"), 0.55));           // breath in the dome
  filt(shellAir, "bandpass", 420, 2.8);
  env(shellAir, shellEnv);
  filt(shellHi, "lowpass", 1500, 0.8);                        // rim, not sparkle
  // Balance, final pass, all three lessons kept: the PLANT owns the peak
  // (thunk at 1.2 over a source that now genuinely peaks at 1.0 in its first
  // 20ms — at parity the dome's summed partials out-peaked it and the attack
  // read as cataclysm's late bloom), the DOME owns the level
  // (cluster at 0.70/0.20/0.34 — starved, the clip became one more
  // front-transient object and sat 1.27-1.47 from stuntdouble), and the
  // dome is TONAL (air layer trimmed to 0.1, rim lowpassed): a brace is a
  // spike into a pitched sustain — low crest, front attack, ringing
  // spectrum — and no other cue in the family has all three.
  emit("cast_bulwark", trim(mix(
    [thunk, 0, 1.2], [oak, 0.002, 0.55],
    [shell, 0, 0.70], [shellHi, 0, 0.20], [shellRoot, 0, 0.42], [shellAir, 0, 0.05],
  ), 0.62), ACTIVE);
}

// ---- cast_cables (~0.30s): two stage pins fired into the deck 30ms apart —
// real mechanical clunks, pneumatic-dull, no ring — and then the one thing
// r2 could only fake: a REAL creak (a tree under load) carrying the tension
// while a real metal ring pitched down to ~270Hz is bent UPWARD into the
// taut hum that sings. The only cast whose tail is a pitched sustain.
{
  const pin = () => {
    const p = crest("mech_clunk", 0.06, 0.003);             // the clunk, not the 104ms of room before it
    filt(p, "lowpass", 1300, 0.9);
    env(p, [[0, 0], [0.002, 1], [0.06, 0]]);
    return p;
  };
  // Creak-LED and bright (band up at 3400, hum up an octave-ish, no sub
  // root): the first r3 matrix run sat cables 0.83 from bulwark and 1.48
  // from airstrike — a mid wash like both of them, and once the pins were
  // onset-aligned into actual pins it drifted to 1.58 from cast_stuntdouble
  // instead. An open line under tension is bright and it complains; that is
  // what a recorded creak is for, and 2200 was not far enough out of the
  // wood-and-body register to say so. The hum still tensions UP to taut
  // (the r2 brief's one keeper). The pins own t10 (2.1ms — the clip speaks
  // on the button); the creak owns the peak 123ms later, which is what
  // "tension arrives after the pins bite" means as a number.
  const creak = norm(slice(src("creak"), 0.30, 0.62));
  filt(creak, "bandpass", 3400, 1.0);
  env(creak, [[0, 0], [0.03, 0.6], [0.22, 0.55], [0.27, 0]]);
  const humSrc = pitch(hit("ring_low"), 0.96);                // 419 -> ~400Hz
  const hum = pitchRamp(humSrc, 0.72, 1.04, 0.26);            // tensioning UP to taut
  filt(hum, "highpass", 300, 0.7);
  env(hum, [[0, 0], [0.04, 0.3], [0.10, 0.8], [0.26, 0]]);
  emit("cast_cables", trim(mix(
    [pin(), 0, 1.05], [pin(), 0.03, 0.92],
    [hum, 0.035, 0.6], [creak, 0.035, 1.0],
  ), 0.30), ACTIVE);
}

// ---- cast_airstrike (~0.53s, ULTIMATE): the call goes in. The key-up is a
// real switch; the two clipped syllables are REAL radio static, enveloped
// into speech-length bursts and driven through the same telephone-narrow
// 300-3400 band (the band IS the brief); the descending whistle is a real
// steam whistle bent down an octave; and the departure is real thunder.
// No melody anywhere.
{
  const key = hit("click_switch", 0.025);
  env(key, [[0, 0], [0.0008, 1], [0.006, 1], [0.025, 0]]);
  const syl = (t0, dur) => {
    const s = norm(slice(src("static"), t0, t0 + dur));
    env(s, [[0, 0], [0.012, 1], [dur * 0.7, 0.8], [dur, 0]]);
    return s;
  };
  const comms = mix([key, 0, 0.8], [syl(0.30, 0.10), 0.05, 1], [syl(0.85, 0.13), 0.19, 1]);
  filt(comms, "highpass", 300, 0.9); filt(comms, "highpass", 300, 0.9);
  filt(comms, "lowpass", 3400, 0.9); filt(comms, "lowpass", 3400, 0.9);
  for (let i = 0; i < comms.length; i++) comms[i] = Math.tanh(comms[i] * 2.2) * 0.6; // carrier drive
  // From 0.35s in: the steam whistle's take spends a third of a second
  // getting up to pressure, and the descent has to start on a note.
  const whistle = pitchRamp(norm(slice(src("whistle"), 0.35, 1.20)), 1.35, 0.55, 0.30);
  filt(whistle, "highpass", 500, 0.7);
  env(whistle, [[0, 0], [0.04, 0.5], [0.22, 0.45], [0.30, 0]]);
  // The departure carries real WEIGHT (thunder at 0.62, held longer): an
  // ultimate sits under flash3 at 1.7 scale — and the first r3 matrix run
  // had airstrike within 1.48-1.60 of two mid-heavy actives, which is what
  // happens when the biggest button in the game is all telephone band.
  const rumble = norm(slice(src("thunder"), 0.55, 1.75));
  filt(rumble, "lowpass", 300, 0.8);
  env(rumble, [[0, 0], [0.04, 0.5], [0.16, 0.7], [0.36, 0]]);
  // Rumble at 0.45, under the comms: at 0.62 the file's PEAK moved into the
  // departure (attack 256ms — cataclysm's own envelope, 1.16 on the matrix).
  // The call is the event; the shells are the consequence leaving.
  emit("cast_airstrike", trim(mix([comms, 0, 1], [whistle, 0.30, 0.45], [rumble, 0.31, 0.45]), 0.65), ULT);
}

// ---- cast_cataclysm (~0.90s, ULTIMATE): the floor gives — and the floor is
// a REAL cave-in. A real rock crack at t=0, real thunder pitched down as the
// sub, the cave-in recording as the long stone tear, and real rockfall as
// the settling debris, all sent through the same not-this-room reverb. Dark,
// downward, geological; the r2 centroid corridor (~800Hz, between injunction
// above and bullettime below) is kept by the same 3.4k lowpass.
{
  // crest, not onset: rock_break's take is a slow crumble that CRACKS 465ms
  // in. `trim(..., 0.09)` was keeping the crumble and throwing away the crack.
  const crack = crest("rock_break", 0.09);
  env(crack, [[0, 0], [0.0015, 1], [0.02, 1], [0.09, 0]]);
  const sub = norm(pitch(slice(src("thunder"), 0.55, 1.60), 0.75));
  filt(sub, "lowpass", 160, 0.8);
  env(sub, [[0, 0], [0.01, 1], [0.35, 0.6], [0.8, 0]]);
  const tear = norm(slice(src("cave_in"), 0.30, 0.90));       // past the take's 300ms of room
  filt(tear, "bandpass", 700, 0.7);
  env(tear, [[0, 0], [0.02, 0.9], [0.3, 0.5], [0.55, 0]]);
  const grind = norm(slice(src("cave_in"), 1.0, 1.55));
  filt(grind, "bandpass", 760, 1.1);
  env(grind, [[0, 0], [0.02, 0.8], [0.26, 0.45], [0.5, 0]]);
  const debris = norm(slice(src("rock_fall"), 0.05, 0.65));
  env(debris, [[0, 0], [0.05, 0.8], [0.6, 0]]);
  let x = mix([sub, 0, 0.55], [crack, 0, 0.95], [tear, 0.005, 1.0], [grind, 0.01, 0.55], [debris, 0.28, 0.6]);
  x = verb(x, { time: 1.1, wet: 0.26, damp: 0.45 }); // a room you are not in
  // 2400, not r2's 3400: with real rock in the layers the extra octave was
  // pulling the centroid up to 1321Hz — 21Hz from cast_bulwark's dome, the
  // matrix's last flagged pair (1.18). Geological means DARK; the recorded
  // tear keeps reading as stone below 2.4k, and bulwark's rim sits above it.
  filt(x, "lowpass", 2400, 0.7);
  emit("cast_cataclysm", trim(x, 0.9), ULT);
}

// ---- cast_bullettime (~0.61s, ULTIMATE): the projector jams — with a real
// machine actually powering down behind it. A real clunk lowpassed to a
// mechanism's THUD at t=0 (the jam acknowledges the button on the frame the
// screen snaps), then the power-down recording pitched to fit, fluttering
// and sinking. EVERYTHING under 700Hz on purpose: the engine closes a 700Hz
// master LPF on this same edge.
{
  const clunk = crest("mech_clank", 0.06, 0.003);             // the clank is 65-180ms into the take
  filt(clunk, "lowpass", 640, 0.9);
  env(clunk, [[0, 0], [0.0015, 1], [0.012, 1], [0.055, 0]]);
  const seize = pitch(crest("body_land_b", 0.20), 1.1);
  filt(seize, "lowpass", 500, 0.8);
  env(seize, [[0, 0], [0.003, 1], [0.16, 0]]);
  // the room slowing: the machine's own spin-down, compressed to the cue
  const down = pitchRamp(norm(slice(src("machine_off"), 0.25, 2.0)), 2.6, 3.4, 0.5);
  filt(down, "lowpass", 620, 0.8);
  env(down, [[0, 0], [0.02, 0.5], [0.30, 0.4], [0.5, 0]]);
  const sink = pitch(norm(slice(src("thunder"), 0.60, 1.60)), 1.4);
  filt(sink, "lowpass", 200, 0.8);
  env(sink, [[0, 0], [0.05, 0.5], [0.55, 0]]);
  const x = mix([clunk, 0, 1], [seize, 0, 0.7], [down, 0.02, 0.55], [sink, 0.06, 0.35]);
  filt(x, "lowpass", 700, 0.7);
  emit("cast_bullettime", trim(x, 0.61), ULT);
}

// ---- cast_injunction (~1.05s, ULTIMATE): the loudest cast in the game. The
// gavel is REAL WOOD — a hard block strike with a hammer's weight under it,
// no reverb of its own — swallowed instantly by a real metal ring played
// BACKWARDS (an inhale that stops), over the institutional tone: the same
// ring pitched down to ~116Hz, holding ~700ms. The tail keeps r2's rest:
// two faint real clinks, and the file ends on the beat the third does not
// arrive on. Whether the rest lands is still an ear question.
{
  const strike = hit("wood_block", 0.05);
  env(strike, [[0, 0], [0.0012, 1], [0.014, 1], [0.05, 0]]);
  const block = pitch(hit("wood_hammer", 0.14), 0.8);
  filt(block, "lowpass", 700, 0.8);
  env(block, [[0, 0], [0.003, 1], [0.015, 1], [0.14, 0]]);
  // From the strike, not from the room before it: reversed, the take's
  // leading 28ms of silence would have been the last 28ms of the inhale,
  // i.e. a swallow that stops 28ms early.
  const swell = rev(norm(slice(src("ring_low"), 0.028, 0.36)));
  filt(swell, "bandpass", 950, 1.1);
  env(swell, [[0, 0], [0.30, 1], [0.34, 0]]);
  const toneEnv = [[0, 0], [0.04, 0.85], [0.62, 0.75], [0.78, 0]];
  const tone = pitch(hit("ring_low"), 0.54);                  // 214-partial -> ~116Hz
  env(tone, toneEnv);
  const toneHi = pitch(hit("ring_low"), 0.81);                // -> ~174Hz region
  env(toneHi, toneEnv);
  const tick = () => {
    const t = hit("clink_a", 0.05);
    filt(t, "highpass", 1400, 0.9);
    env(t, [[0, 0], [0.001, 1], [0.05, 0]]);
    return t;
  };
  // Tuned against stuntdouble (the matrix's last near-pair — two hard wood
  // fronts): the swell sits at 950Hz not 1300 (institutional gloom, not
  // slate brightness), and the tone stays at r2's 0.68/0.26 lean — pushing
  // it to 0.78 was tried and measured CLOSER (1.51 vs 1.64): the extra
  // sustain lowered the crest onto stuntdouble's, which is z-space for
  // "now they match on one more axis". The instrument's answer, kept.
  emit("cast_injunction", trim(mix(
    [strike, 0, 1], [block, 0, 0.85], [swell, 0.02, 0.55],
    [tone, 0.02, 0.68], [toneHi, 0.02, 0.26],
    [tick(), 0.72, 0.30], [tick(), 0.84, 0.24],
    [buf(1.0), 0, 0], // the beat the third tick does not arrive on
  ), 1.05), ULT);
}

// ---- level_up (~0.33s): THE SYSTEM FILES A PROMOTION — on a REAL machine.
// The stamp is an actual typewriter strike (what else does a bureaucracy
// sound like?) with a wood chock's weight under it, and the two notes a
// fourth apart (G5 -> C6) are a real bell, struck twice, each cut short
// before it can ring into a jingle. Same trade as r2: short and dry beats
// long and celebratory on an edge that fires every level. Same bus (sfx),
// same -19 momentary target, same reason.
{
  const stamp = hit("typewriter", 0.09);
  env(stamp, [[0, 0], [0.0015, 1], [0.006, 1], [0.09, 0]]);
  const thock = pitch(hit("wood_chock", 0.10), 0.9);
  filt(thock, "lowpass", 900, 0.8);
  env(thock, [[0, 0], [0.0025, 1], [0.10, 0]]);
  // hit(), or there are no notes: the bell take does not strike until 80ms
  // in, and each note is trimmed to 140-220ms — the first r3 cut therefore
  // shipped a promotion with a stamp and NO BELL, which is exactly the kind
  // of thing an instrument catches and an ear does not forgive.
  const note = (ratio, dur) => {
    const n = pitch(hit("bell"), ratio);
    env(n, [[0, 0], [0.003, 1], [dur * 0.55, 0.35], [dur, 0]]);
    return trim(n, dur);
  };
  const x = mix(
    [stamp, 0, 1], [thock, 0, 0.7],
    [note(0.741, 0.14), 0.03, 0.55],   // 1058Hz bell -> G5 784
    [note(0.989, 0.22), 0.11, 0.65],   // -> C6 1046
  );
  emit("level_up", trim(x, 0.33), { rmsDb: -19, peakDb: -6.5, windowSec: 0.3, iters: 4 });
}

if (MEASURE) {
  console.log("\nid | sec | peakDb | momDb | target");
  console.log("--- | --- | --- | --- | ---");
  for (const r of rows) console.log(`${r.id} | ${r.sec} | ${r.peak} | ${r.mom} | ${r.target}`);
}
