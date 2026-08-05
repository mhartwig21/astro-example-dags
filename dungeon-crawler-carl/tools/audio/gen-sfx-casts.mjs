#!/usr/bin/env node
// gen-sfx-casts.mjs — THE ACT. One script for the whole cast family, the same
// reasoning §4.1 used for the announcer: twelve new cues plus a regenerated
// `cast_dash` rendered from one set of committed parameters, so the roster
// sounds like one game instead of thirteen authors.
//
// The gap this closes (SOUNDPLAN §1.4 row E-21): 16 abilities, 3 cast cues.
// (16, not 17 — AbilityId has sixteen members. The first r2 cut miscounted
// the roster in the row written to be the roster's audit.)
// You hear the CONSEQUENCE when a hit lands; you never hear the ACT. And the
// 13 were never even silent — 11 spoke in BORROWED clips (the `item` pickup
// chime via the sim's "weapon" juice poofs, the `dash` whoosh via "chain"
// hits, `equip` for Stunt Double, `crit` for Fault Line, `dash` at 0.8 for
// Bullet Time). Only Sponsor Barrage and Injunction were literally silent.
//
//   cast_dash        the body leaves — REGENERATED (owner verdict §1.3a:
//                    "the dash sound effect sucks"; the Kenney clip is the
//                    NEGATIVE reference, not the template)
//   cast_orbit       the ring un-ships (metal ring-off, receding)
//   cast_stance      a selector detent (one chock, no tail)
//   cast_overcharge  a breaker thrown (clack, then a whine that is BANKED)
//   cast_cutto       two transients with a hole between them
//   cast_crowdsurf   a winch paying out into one load-bearing clank
//   cast_stuntdouble the professional clocks in (slate, then the double lands)
//   cast_bulwark     a plate planted, a shell swelling under it
//   cast_cables      two pins into the deck, a line tensioning to a hum
//   cast_airstrike   the call goes in (comms key-up, no melody anywhere)
//   cast_cataclysm   the floor gives (sub-drop, stone tear, a bigger room)
//   cast_bullettime  the projector jams (all of it under 700Hz on purpose)
//   cast_injunction  the gavel, swallowed (the loudest cast in the game)
//   chain_line       the taut-line tick that stops `HIT_SOUNDS.chain` from
//                    being the dash whoosh on four different emitters
//
// Family targets (SOUNDPLAN §2.2, the two rows this round adds):
//   Ability casts (actives)  -17   LUFS momentary, peak <= -4.5 dBFS
//   Ultimate casts           -14.5 LUFS momentary, peak <= -3.0 dBFS
//   chain_line (room tone)   -28   LUFS momentary, peak <= -12 dBFS
// Actives sit 2dB UNDER impacts (-15) on purpose: the consequence must
// out-punch the act, or every cast is a lie about how much damage it did.
//
// Pre-encode peak ceilings are set ~0.8dB under the family ceiling because
// vorbis overshoots on transients and the number that must clear is the one
// measure.mjs reads back from the ENCODED file.
//
// Deterministic (seeded, no wall clock); rerun reproduces the bytes.
// `node tools/audio/gen-sfx-casts.mjs --measure` also prints the pre-encode
// table for the commit message.

import { SR, secs, rng, buf, sine, saw, noise, pink, filt, env, mix, shimmer, verb, master, declick, peakDb as peakOf, momentaryDb as momOf } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const OUT = new URL("../../public/audio/sfx/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const MEASURE = process.argv.includes("--measure");

// windowSec 0.4 everywhere: that is measure.mjs's momentary basis (and for a
// clip shorter than 400ms both reduce to "RMS of the whole file"), so the
// number this script masters to is the number the instrument reads back.
const ACTIVE = { rmsDb: -17, peakDb: -5.3, windowSec: 0.4, iters: 4 };
const ULT = { rmsDb: -14.5, peakDb: -3.8, windowSec: 0.4, iters: 4 };
const TICK = { rmsDb: -28, peakDb: -12.8, windowSec: 0.4, iters: 2 };

const rows = [];
function emit(id, x, spec) {
  master(x, spec);
  declick(x, 0.003);
  renderOgg(OUT + id + ".ogg", x);
  rows.push({ id, sec: +(x.length / SR).toFixed(3), peak: +peakOf(x).toFixed(1), mom: +momOf(x, 0.4).toFixed(1), target: spec.rmsDb });
}

/** Trim a reverb tail back to the briefed duration (verb() extends length). */
const trim = (x, sec) => x.slice(0, Math.min(x.length, secs(sec)));
/** Reverse: a decay played backwards is an inhale that stops. */
function rev(x) {
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = x[x.length - 1 - i];
  return o;
}

// ---- cast_dash (REGENERATED, ~0.20s): a body displacing AIR. Mid-centred
// (1500->430Hz) where `swing` is bright (1600->350) and ARRIVING; this one
// departs — energy at the front, the mass falling away behind it. The old
// Kenney clip was 0.47s and peaked at -1.2 dBFS; "sounds like the old dash"
// is the failure condition, so nothing here is a cartoon swish.
//
// R2 CRITIC FIX — this render is the second one. The first put the `mass`
// sine in at 0.5, and because master() normalizes on RMS, that one layer
// then carried 90% of the file's energy into the 125Hz octave. Three
// measured consequences: the clip sat 0.98 from cast_bulwark on the repo's
// own distinctness matrix (threshold 1.66 — the closest pair in the family,
// on the one clip the owner rejected by name), 1.32 from `kill`, and it lost
// 11.0dB through a 250Hz highpass, i.e. most of it did not exist on a
// laptop. The mass is now a HINT under the air (0.16), which is what the
// brief said in the first place.
{
  const r = rng(0x0da58);
  const air = noise(0.20, r);
  filt(air, "bandpass", [1500, 430], 0.9);
  // a single biquad bandpass has 6dB/oct skirts, so the first cut left enough
  // broadband hiss to measure at a 2981Hz centroid — brighter than `swing`'s
  // own body and the opposite of the brief. The extra lowpass is what makes
  // this air rather than hiss (measured: 2981 -> ~700Hz).
  filt(air, "lowpass", 1900, 0.7);
  filt(air, "highpass", 300, 0.7);
  env(air, [[0, 0], [0.012, 1], [0.06, 0.55], [0.20, 0]]);
  const scuff = filt(noise(0.045, r), "bandpass", [2200, 800], 1.3); // push-off grit
  env(scuff, [[0, 0], [0.0025, 1], [0.045, 0]]);
  const mass = sine(0.16, 190, 82);
  env(mass, [[0, 0], [0.005, 0.9], [0.10, 0.35], [0.16, 0]]);
  emit("cast_dash", mix([air, 0, 1], [scuff, 0, 0.26], [mass, 0.003, 0.20]), ACTIVE);
}

// ---- cast_orbit (~0.26s): the ring UN-SHIPS. Four blades tighten into a saw
// and leave the body: inharmonic partials at 1.6-2.2kHz all sliding down
// together (doppler away) over a fine grind. vs `swing`: swing is broadband,
// arriving, dry. This is pitched, RECEDING, and it hangs.
//
// R2 CRITIC FIX — the first render highpassed at 900Hz and measured
// lowShare 0.000: 99% of the file in the single 2k octave band, the only
// clip in the 22-file house survey with no low anchor whatsoever, and its
// picture was a flat unenveloped band of filtered noise held at near-constant
// level for 85% of the file — structurally the same failure this script
// already found and corrected on the first cast_dash render. Two fixes: the
// ring un-ships from a BODY (the hub tone), and the grind gets a front bite
// and a decay instead of a plateau.
{
  const r = rng(0x0261b);
  const ring = [1620, 1815, 1980, 2210].map((f, i) => {
    const s = sine(0.26, f, f * 0.84);
    env(s, [[0, 0], [0.004 + i * 0.003, 1], [0.10, 0.45], [0.26, 0]]);
    return [s, i * 0.004, 0.42 - i * 0.07];
  });
  const grind = filt(noise(0.26, r), "bandpass", [2600, 1500], 1.1);
  shimmer(grind, r, 90, 0.5);
  env(grind, [[0, 0], [0.006, 0.9], [0.09, 0.42], [0.26, 0]]);
  const bite = filt(noise(0.03, r), "bandpass", [3000, 1200], 0.9); // the un-ship
  env(bite, [[0, 0], [0.0015, 1], [0.03, 0]]);
  const hub = sine(0.13, 250, 150); // the body it leaves
  env(hub, [[0, 0], [0.003, 1], [0.05, 0.3], [0.13, 0]]);
  const x = mix(...ring, [grind, 0, 0.35], [bite, 0, 0.5], [hub, 0, 0.5]);
  filt(x, "highpass", 190, 0.7);
  emit("cast_orbit", x, ACTIVE);
}

// ---- cast_stance (~0.11s): a selector detent. ONE damped hardwood-on-steel
// chock and nothing after it. The shortest and (at manifest vol 0.5) the
// quietest cue in the family, because a Flow build swaps every 1.8s — this is
// the fatigue bet, and it is named in the audition sheet for that reason.
// The director gives direction with rate: 1.06 into ranged, 0.94 into melee.
{
  const r = rng(0x57a4c);
  const chock = filt(noise(0.014, r), "bandpass", [3200, 1400], 0.9);
  env(chock, [[0, 0], [0.0015, 1], [0.014, 0]]);
  const wood = sine(0.105, 430, 250);
  env(wood, [[0, 0], [0.003, 1], [0.055, 0.12], [0.09, 0]]);
  const steel = sine(0.05, 1880, 1840);
  env(steel, [[0, 0], [0.002, 0.5], [0.05, 0]]);
  const body = filt(noise(0.06, r), "bandpass", 700, 1.2);
  env(body, [[0, 0], [0.004, 0.8], [0.06, 0]]);
  emit("cast_stance", mix([chock, 0, 1], [wood, 0, 0.9], [steel, 0.001, 0.3], [body, 0.002, 0.5]), ACTIVE);
}

// ---- cast_overcharge (~0.30s): a breaker thrown. Relay clack, then a
// capacitor whine rising a fifth (620->930) over 220ms that CUTS OFF DEAD at
// the top — the power is banked, so the sound stops instead of resolving.
// vs `bolt`: bolt discharges outward and decays; this charges inward and
// truncates. The director replays this same file at rate 1.3 / gain 0.55 on
// the SPEND edge — one file, two moments.
{
  const r = rng(0x0c4a9);
  const clack = filt(noise(0.022, r), "bandpass", [2400, 900], 1.0);
  env(clack, [[0, 0], [0.0015, 1], [0.022, 0]]);
  const relay = sine(0.09, 260, 140);
  env(relay, [[0, 0], [0.003, 1], [0.09, 0]]);
  const whine = sine(0.275, 620, 930);
  const whine2 = sine(0.275, 1240, 1860);
  const buzz = saw(0.275, 310, 465);
  filt(buzz, "lowpass", 2600, 0.8);
  const cut = [[0, 0], [0.02, 0.2], [0.13, 0.55], [0.235, 1], [0.255, 1], [0.265, 0]];
  env(whine, cut); env(whine2, cut); env(buzz, cut);
  emit("cast_overcharge", mix([clack, 0, 1], [relay, 0, 0.8], [whine, 0.03, 0.55], [whine2, 0.03, 0.16], [buzz, 0.03, 0.14]), ACTIVE);
}

// ---- cast_cutto (~0.22s): two transients with a hole between them. A
// compressed-air THUP as the body leaves, ~90ms of near-silence (smoke
// hanging where you were — near, not absolute), then a hard knife-edge tick
// at the ARRIVAL, which is also where the director positions it. vs
// cast_dash: dash is one continuous whoosh with a body; this is two impulses
// and a gap.
{
  const r = rng(0x0c117);
  const thup = filt(noise(0.06, r), "bandpass", [1500, 380], 0.8);
  env(thup, [[0, 0], [0.003, 1], [0.06, 0]]);
  const puff = sine(0.07, 190, 85);
  env(puff, [[0, 0], [0.004, 0.7], [0.07, 0]]);
  const smoke = filt(noise(0.13, r), "bandpass", 2600, 1.6);
  env(smoke, [[0, 0], [0.02, 0.09], [0.13, 0.02]]);
  const tick = filt(noise(0.018, r), "bandpass", [6000, 2600], 0.9);
  env(tick, [[0, 0], [0.001, 1], [0.018, 0]]);
  const edge = sine(0.06, 3200, 2600);
  env(edge, [[0, 0], [0.0015, 0.45], [0.06, 0]]);
  emit("cast_cutto", mix([thup, 0, 1], [puff, 0.002, 0.6], [smoke, 0.03, 0.5], [tick, 0.155, 1], [edge, 0.155, 0.5]), ACTIVE);
}

// ---- cast_crowdsurf (~0.35s): a winch paying out. Chain-link grains thinning
// as the line travels, ending in ONE load-bearing clank as it goes taut. vs
// cast_cables: both are rigging steel, but Extradition MOVES (rattle ->
// clank, energy at the END) where Cables PLANTS (energy at the front).
{
  const r = rng(0x0c205);
  const chain = buf(0.26);
  for (let i = 0; i < chain.length; i++) {
    const t = i / chain.length;
    chain[i] = r() < 0.016 * (1 - 0.7 * t) ? r() * 2 - 1 : 0;
  }
  filt(chain, "bandpass", [1500, 2600], 1.3);
  env(chain, [[0, 0], [0.01, 1], [0.20, 0.5], [0.26, 0.18]]);
  const clankRing = [330, 486, 790].map((f, i) => {
    const s = sine(0.1, f, f * 0.995);
    env(s, [[0, 0], [0.003, 1], [0.05, 0.2], [0.1, 0]]);
    return [s, 0.25 + i * 0.001, 0.46 - i * 0.1];
  });
  const clank = filt(noise(0.05, r), "bandpass", [2000, 700], 0.9);
  env(clank, [[0, 0], [0.002, 1], [0.05, 0]]);
  const load = sine(0.1, 150, 78);
  env(load, [[0, 0], [0.005, 0.8], [0.1, 0]]);
  // R2 CRITIC FIX — the first link takes the load at t=0. The old render's
  // peak was at 254.7ms behind a visibly faint opening, while
  // renderer3d.castCommitEdges fires its commit flash, FX light and trauma on
  // the cast frame: the picture committed and the sound did not. The winch
  // still ENDS on the clank (that is the brief); it now also starts.
  const firstLink = filt(noise(0.03, r), "bandpass", [2700, 1100], 1.1);
  env(firstLink, [[0, 0], [0.0015, 1], [0.03, 0]]);
  // rattle sits UNDER the clank (0.7, not 0.9): the energy belongs at the end.
  // Tighter pre-encode ceiling than the rest of the family (-6.5 vs -5.3):
  // measured, the sparse grains + clank transient overshoot ~1.6dB through
  // vorbis — twice the family's usual — and landed exactly ON the -4.5
  // ceiling. Letting the limiter shave the crest keeps RMS on target with
  // ~1dB of real margin instead of zero.
  emit("cast_crowdsurf", mix([firstLink, 0, 0.75], [chain, 0, 0.7], ...clankRing, [clank, 0.25, 0.8], [load, 0.25, 0.7]), { ...ACTIVE, peakDb: -6.5 });
}

// ---- cast_stuntdouble (~0.42s): the professional clocks in. A film-slate
// clack (wood, dry, broadcast — no room), then a DOUBLED body-weight thud
// 120ms behind it as the stand-in lands. The negative reference is `equip`,
// the clip it borrows today: no bell, no chime, nothing that could read as
// picking something up.
{
  const r = rng(0x57d0b);
  const clack = filt(noise(0.02, r), "bandpass", [5400, 2300], 0.9);
  env(clack, [[0, 0], [0.0012, 1], [0.02, 0]]);
  const slate = sine(0.085, 810, 470);
  env(slate, [[0, 0], [0.0015, 1], [0.085, 0]]);
  const plank = filt(noise(0.06, r), "bandpass", 1500, 1.1);
  env(plank, [[0, 0], [0.0025, 0.9], [0.06, 0]]);
  const thud = (dur, f0, f1) => {
    const s = sine(dur, f0, f1);
    env(s, [[0, 0], [0.006, 1], [dur, 0]]);
    return s;
  };
  const scuff = filt(noise(0.22, r), "lowpass", 760, 0.9);
  env(scuff, [[0, 0], [0.006, 0.9], [0.09, 0.35], [0.22, 0]]);
  // The stand-in settling — the beat AFTER the landing. It is what makes the
  // clip a two-event 0.48s gesture rather than another 0.2s transient, which
  // is the axis the distinctness matrix can actually see.
  const settle = filt(noise(0.20, r), "bandpass", [900, 380], 1.4);
  env(settle, [[0, 0], [0.03, 0.35], [0.20, 0]]);
  // R2 CRITIC FIX — the landing thuds ran at 118/104Hz into 52/46 and pulled
  // 67% of the clip into the 125Hz band, which cost 9.5dB through a 250Hz
  // highpass and left the clip 1.47 from cast_cables (flagged, threshold
  // 1.66) with the same low-heavy shape at the same length. The slate is now
  // the loud half — which is also the brief, "the professional CLOCKS IN" —
  // and the double lands at body pitch instead of subwoofer pitch.
  emit("cast_stuntdouble", mix(
    [clack, 0, 1], [slate, 0, 0.9], [plank, 0.002, 0.6],
    [thud(0.15, 200, 96), 0.19, 0.62], [thud(0.19, 176, 86), 0.216, 0.55],
    [scuff, 0.19, 0.5], [settle, 0.33, 0.4],
  ), ACTIVE);
}

// ---- cast_bulwark (~0.42s): a plate planted, and then THE DOME. Steel-and-oak
// thunk with its ring damped at once, and a hollow shell that swells under it
// and HOLDS for the length of the clip. vs cast_stance: same material palette,
// five times the mass, a sustained shell instead of a full stop.
//
// R2 CRITIC FIX — the first render was 0.27s of thunk with a shell that only
// just got started, and it measured as a low thump with a wash on it: 0.98
// from cast_dash (the closest pair in the family), 0.71 from `kill` (the
// closest pair in the whole 22-file house survey — a defensive brace sitting
// in the acoustic slot the game uses for a death), and -12.7dB through a
// 250Hz highpass. The shell now runs the whole clip, an octave up, and
// carries the level; the thunk is the attack, not the sound.
{
  const r = rng(0x0b0147);
  const thunk = filt(noise(0.035, r), "bandpass", [1700, 640], 0.9);
  env(thunk, [[0, 0], [0.002, 1], [0.035, 0]]);
  const plate = sine(0.12, 240, 118);
  env(plate, [[0, 0], [0.004, 1], [0.045, 0.3], [0.12, 0]]);
  const oak = filt(noise(0.09, r), "bandpass", 520, 1.2);
  env(oak, [[0, 0], [0.005, 0.9], [0.09, 0]]);
  const shellEnv = [[0, 0], [0.09, 0.35], [0.24, 0.9], [0.42, 0.85], [0.52, 0]];
  const shellA = sine(0.52, 262, 258);
  const shellB = sine(0.52, 393, 389);
  const shellRoot = sine(0.52, 131, 130);
  const shellAir = filt(noise(0.52, r), "bandpass", 500, 2.8);
  env(shellA, shellEnv); env(shellB, shellEnv); env(shellRoot, shellEnv); env(shellAir, shellEnv);
  emit("cast_bulwark", mix(
    [thunk, 0, 1], [plate, 0, 0.7], [oak, 0.002, 0.55],
    [shellA, 0, 0.62], [shellB, 0, 0.26], [shellRoot, 0, 0.3], [shellAir, 0, 0.26],
  ), ACTIVE);
}

// ---- cast_cables (~0.30s): two stage pins fired into the deck 30ms apart —
// pneumatic, dull, no ring — and a cable tensioning UP to a taut hum that
// SINGS rather than rumbles. The only cast whose tail is a pitched sustain,
// which is what a field that persists for 4s should sound like.
//
// R2 CRITIC FIX — the hum ran 86->122Hz, which put 79% of the file in the
// 125Hz band, cost 15.2dB through a 250Hz highpass, and left the clip 1.47
// from cast_stuntdouble and 1.80 from cast_dash: three clips, one low-heavy
// gesture at three lengths. A tensioning steel line is a MID sing with a low
// root under it, so the hum moved up an octave, the creak came up to carry
// the tension audibly, and the clip lost 80ms it was not using.
{
  const r = rng(0x0cab1);
  const pin = () => {
    const p = filt(noise(0.04, r), "lowpass", 1300, 0.9);
    env(p, [[0, 0], [0.002, 1], [0.04, 0]]);
    const d = sine(0.07, 300, 130);
    env(d, [[0, 0], [0.003, 0.9], [0.07, 0]]);
    return mix([p, 0, 1], [d, 0, 0.55]);
  };
  const hEnv = [[0, 0], [0.04, 0.3], [0.10, 0.8], [0.26, 0]];
  const humA = sine(0.26, 190, 268);
  const humB = sine(0.26, 380, 536);
  const humRoot = sine(0.26, 95, 134);
  env(humA, hEnv); env(humB, hEnv); env(humRoot, hEnv);
  const creak = filt(noise(0.24, r), "bandpass", [900, 2400], 2.0);
  env(creak, [[0, 0], [0.05, 0.4], [0.24, 0]]);
  emit("cast_cables", mix(
    [pin(), 0, 1], [pin(), 0.03, 0.9],
    [humA, 0.035, 0.7], [humB, 0.035, 0.26], [humRoot, 0.035, 0.28], [creak, 0.035, 0.45],
  ), ACTIVE);
}

// ---- cast_airstrike (~0.50s, ULTIMATE): the call goes in. A band-limited
// comms key-up (300Hz-3.4kHz, deliberately telephone-narrow), two clipped
// syllables of carrier noise, and a descending whistle handing off to the
// shells — which already sound, so this is the CALL-IN only, one cue per
// press, not a loop. No melody anywhere: the house line is dry menace, never
// a laugh track, so the Barrage does not get a sponsor jingle.
//
// R2 CRITIC FIX — the first render was 0.50s at crest 9.6 with lowShare 0.21
// and measured 1.25 from cast_overcharge, an ACTIVE: same length class, same
// brightness, same flat dynamic shape. Two things separate an ultimate from
// an active here, and the render had neither: a hard key-up TRANSIENT (an
// ultimate sits under flash3 at 1.7 scale and addTrauma 0.45 — it needs a
// spike, not a swell) and WEIGHT (the shells departing). Both added; the
// telephone-narrow comms body is unchanged, because that IS the brief.
{
  const r = rng(0xa1257);
  const key = filt(noise(0.022, r), "bandpass", 2600, 1.0);
  env(key, [[0, 0], [0.0008, 1], [0.022, 0]]);
  const syl = (dur, f1, f2) => {
    const a = filt(pink(dur, r), "bandpass", f1, 5);
    const b = filt(pink(dur, r), "bandpass", f2, 6);
    const s = mix([a, 0, 1], [b, 0, 0.6]);
    env(s, [[0, 0], [0.012, 1], [dur * 0.7, 0.8], [dur, 0]]);
    return s;
  };
  const comms = mix([key, 0, 0.8], [syl(0.1, 660, 1450), 0.05, 1], [syl(0.13, 520, 1900), 0.19, 1]);
  filt(comms, "highpass", 300, 0.9); filt(comms, "highpass", 300, 0.9);
  filt(comms, "lowpass", 3400, 0.9); filt(comms, "lowpass", 3400, 0.9);
  for (let i = 0; i < comms.length; i++) comms[i] = Math.tanh(comms[i] * 2.2) * 0.6; // carrier drive
  const whistle = sine(0.30, 2600, 620);
  env(whistle, [[0, 0], [0.04, 0.5], [0.22, 0.45], [0.30, 0]]);
  const air = filt(noise(0.30, r), "bandpass", [2400, 800], 3);
  env(air, [[0, 0], [0.05, 0.25], [0.30, 0]]);
  // The departure — an ultimate has to weigh something.
  const rumble = sine(0.30, 105, 62);
  env(rumble, [[0, 0], [0.04, 0.5], [0.14, 0.8], [0.30, 0]]);
  emit("cast_airstrike", mix([comms, 0, 1], [whistle, 0.30, 0.5], [air, 0.30, 0.3], [rumble, 0.32, 0.40]), ULT);
}

// ---- cast_cataclysm (~0.90s, ULTIMATE): the floor gives. A sub-drop to ~40Hz
// under a long stone-tearing mid crack, then a settling debris tail carrying
// the reverb of a much bigger room than the one you are standing in. vs
// `nova` (whose ring it shares visually and whose `crit` layer it borrows
// today): nova is bright, gold, outward, airy. Fault Line is dark, DOWNWARD,
// geological.
{
  const r = rng(0x0ca7a);
  const sub = sine(0.8, 120, 38);
  env(sub, [[0, 0], [0.008, 1], [0.35, 0.6], [0.8, 0]]);
  const crack = filt(noise(0.09, r), "bandpass", [2600, 900], 0.9);
  env(crack, [[0, 0], [0.0015, 1], [0.09, 0]]);
  const tear = filt(noise(0.55, r), "bandpass", [1100, 320], 0.7);
  shimmer(tear, r, 26, 0.6);
  env(tear, [[0, 0], [0.02, 0.9], [0.3, 0.5], [0.55, 0]]);
  const debris = buf(0.6);
  for (let i = 0; i < debris.length; i++) {
    const t = i / debris.length;
    debris[i] = r() < 0.006 * (1 - 0.85 * t) ? r() * 2 - 1 : 0;
  }
  filt(debris, "bandpass", 900, 1.2);
  env(debris, [[0, 0], [0.05, 0.8], [0.6, 0]]);
  // R2 CRITIC FIX — a mid-register STONE layer, and the sub demoted from 1.0
  // to 0.7. The first render put 99% of its energy under 250Hz and lost
  // 21.8dB through a 250Hz highpass: it went from the hottest-mastered
  // ultimate in the family to the quietest thing in the entire set on a
  // laptop — Fault Line reshaping the room inaudibly while Sponsor Barrage
  // played at full level. It is still geological; it is no longer sub-only.
  const grind = filt(noise(0.5, r), "bandpass", [560, 980], 1.3);
  shimmer(grind, r, 17, 0.5);
  env(grind, [[0, 0], [0.02, 0.8], [0.26, 0.45], [0.5, 0]]);
  let x = mix([sub, 0, 0.55], [crack, 0, 0.95], [tear, 0.005, 1.0], [grind, 0.01, 0.6], [debris, 0.28, 0.6]);
  x = verb(x, { time: 1.1, wet: 0.26, damp: 0.45 }); // a room you are not in
  // Geological means DARK, but not sub-only. Measured at damp 0.3 the bright
  // reverb tail put the centroid at 1667Hz — 35Hz from cast_injunction, two
  // ultimates the instrument could not tell apart. Over-damping then dropped
  // it to 506Hz, inside cast_bullettime's deliberately-capped register. This
  // lands ~800Hz: the tear still reads as stone, and both neighbours clear.
  filt(x, "lowpass", 3400, 0.7);
  emit("cast_cataclysm", trim(x, 0.9), ULT);
}

// ---- cast_bullettime (~0.61s, ULTIMATE): the projector jams. One dry
// mechanical clunk AT ZERO, then the room slowing behind it — pitch-smeared
// downward, fluttering, exhaling. EVERYTHING is lowpassed at 700Hz on purpose
// — the engine sweeps a 700Hz master LPF on this same edge, so a cue with
// energy above it would sound like a mistake. vs cast_dash (which it
// literally stole at 0.8 gain before this round): no whoosh anywhere, and it
// ends on a STOP, not a departure.
//
// R2 CRITIC FIX — the first render opened near-silent, swelled for over half
// its length and PEAKED AT 412ms (t10 31.8ms, 4.5x the next-slowest cast).
// The visual it fires with is instantaneous: main3d.ts flips btGradeOn and
// applyScreenGrade() hard-cuts the canvas filter on the frame bulletTimeLeft
// goes positive, and the director sweeps the LPF on the same edge. A 400ms
// swell under a 1-frame snap is the sound not acknowledging the button. The
// jam is now at t=0 and the swell became the EXHALE after it.
{
  const r = rng(0x0b117);
  const clunk = filt(noise(0.055, r), "lowpass", 640, 0.9);
  env(clunk, [[0, 0], [0.0015, 1], [0.055, 0]]);
  const seize = sine(0.16, 300, 118);
  env(seize, [[0, 0], [0.003, 1], [0.16, 0]]);
  const smear = sine(0.34, 320, 78);
  env(smear, [[0, 0], [0.012, 0.6], [0.34, 0]]);
  const flutter = filt(noise(0.5, r), "lowpass", 520, 0.9);
  shimmer(flutter, r, 11, 0.8);
  env(flutter, [[0, 0], [0.02, 0.45], [0.5, 0]]);
  const drag = pink(0.55, r);
  filt(drag, "bandpass", [540, 250], 0.8);
  env(drag, [[0, 0], [0.06, 0.55], [0.28, 0.4], [0.55, 0]]);
  const sink = sine(0.55, 190, 84);
  env(sink, [[0, 0], [0.05, 0.5], [0.55, 0]]);
  const x = mix(
    [clunk, 0, 1], [seize, 0, 0.85], [smear, 0.01, 0.45], [flutter, 0.01, 0.35],
    [drag, 0.06, 0.5], [sink, 0.06, 0.3],
  );
  filt(x, "lowpass", 700, 0.7);
  emit("cast_bullettime", x, ULT);
}

// ---- cast_injunction (~1.10s, ULTIMATE): the loudest cast in the game. One
// hard gavel-front with no reverb of its own, swallowed instantly by an
// inhaled reverse-swell, over a low institutional tone that holds ~700ms —
// and a faint tick in the tail that STOPS mid-beat (the missing third tick is
// the sound). vs cast_cataclysm: cataclysm is downward and geological;
// Injunction is INWARD and institutional, and it is the only cast in the
// roster with a tonal sustain. The seal FX buys REACH and DURATION, not
// luminance; the audio makes the same trade.
{
  const r = rng(0x1a1c7);
  const strike = filt(noise(0.03, r), "bandpass", [2400, 800], 0.9);
  env(strike, [[0, 0], [0.0012, 1], [0.03, 0]]);
  const block = sine(0.11, 320, 155);
  env(block, [[0, 0], [0.003, 1], [0.11, 0]]);
  const swellSrc = filt(noise(0.34, r), "bandpass", [2200, 700], 1.1);
  env(swellSrc, [[0, 0], [0.01, 1], [0.34, 0]]);
  const swell = rev(swellSrc); // a decay played backwards: it inhales, then stops
  const tones = [116, 174, 232.5].map((f, i) => {
    const s = sine(0.78, f, f * 0.999);
    env(s, [[0, 0], [0.04, 0.85], [0.62, 0.75], [0.78, 0]]);
    // Leaned INTO in r2: the institutional tone is the one thing no other
    // cast has (the roster is transients and washes), and letting it carry
    // more of the clip is what separates Injunction from every two-event
    // gesture in the family on every set the matrix is run over.
    return [s, 0.02, [0.68, 0.30, 0.19][i]];
  });
  const tick = () => {
    const t = filt(noise(0.02, r), "bandpass", 3000, 2.2);
    env(t, [[0, 0], [0.001, 1], [0.02, 0]]);
    const b = sine(0.05, 2100, 2050);
    env(b, [[0, 0], [0.002, 0.4], [0.05, 0]]);
    return mix([t, 0, 1], [b, 0, 0.5]);
  };
  // R2 CRITIC FIX — the ticks were at 0.14/0.12 and the clip ran to 1.10s, so
  // the last 0.45s measured as 18% silence plus two blips at the noise floor:
  // on the biggest cue in the game that reads as dead air, not as a rest. The
  // ticks are now audible (0.30/0.24) and the file ends one tick-beat after
  // the second, which is exactly long enough for the missing third to be
  // missed. Whether the rest LANDS is an ear question — §9 row 1.
  emit("cast_injunction", mix(
    [strike, 0, 1], [block, 0, 0.85], [swell, 0.02, 0.5], ...tones,
    [tick(), 0.72, 0.30], [tick(), 0.84, 0.24],
    [buf(1.0), 0, 0], // the beat the third tick does not arrive on
  ), ULT);
}

// ---- chain_line (~0.12s): so HIT_SOUNDS.chain stops being the dash whoosh.
// Four different things emit "chain" hits (including monster grabs) and today
// every one of them plays a dash. A low taut-line tick: the line takes the
// load, nothing leaves. Room-tone family (-28), manifest vol 0.35.
{
  const r = rng(0x0c4a1);
  const tick = filt(noise(0.012, r), "bandpass", [1800, 750], 1.0);
  env(tick, [[0, 0], [0.001, 1], [0.012, 0]]);
  const line = sine(0.12, 340, 190);
  env(line, [[0, 0], [0.003, 0.9], [0.12, 0]]);
  const taut = sine(0.07, 620, 560);
  env(taut, [[0, 0], [0.004, 0.3], [0.07, 0]]);
  emit("chain_line", mix([tick, 0, 1], [line, 0, 0.8], [taut, 0.002, 0.35]), TICK);
}

// ---- weapon_flash (~0.09s): so HIT_SOUNDS.weapon stops being the `item`
// PICKUP CHIME. This is the round's own thesis, half-executed until now: the
// r2 build shipped thirteen cast cues and left six of them playing a coin
// chime underneath themselves at full gain (orbit, stance, overcharge,
// bulwark, cutto, crowdsurf all emit "weapon" juice poofs on the cast frame),
// and through a 250Hz highpass the chime measured LOUDER than the cue it was
// supposed to sit under. It is not only a cast artifact either: `grep '"weapon"'
// src/sim/game.ts` is 30 call sites and most are monster-side — adds arriving,
// risers, boss children, the orbit parry, the snare snip — every one of which
// rang a pickup chime.
// So: a dry steel FLICK. No bell, no ring, nothing that could read as picking
// something up, and room-tone family (-28) so it lives under the impact.
{
  const r = rng(0x0e4f1);
  const flick = filt(noise(0.016, r), "bandpass", [2800, 1200], 1.0);
  env(flick, [[0, 0], [0.0008, 1], [0.016, 0]]);
  const steel = sine(0.055, 1450, 1180);
  env(steel, [[0, 0], [0.0015, 0.5], [0.055, 0]]);
  const body = filt(noise(0.045, r), "bandpass", 760, 1.3);
  env(body, [[0, 0], [0.002, 0.7], [0.045, 0]]);
  emit("weapon_flash", mix([flick, 0, 1], [steel, 0, 0.45], [body, 0.001, 0.5]), TICK);
}

if (MEASURE) {
  console.log("\nid | sec | peakDb | momDb | target");
  console.log("--- | --- | --- | --- | ---");
  for (const r of rows) console.log(`${r.id} | ${r.sec} | ${r.peak} | ${r.mom} | ${r.target}`);
}
