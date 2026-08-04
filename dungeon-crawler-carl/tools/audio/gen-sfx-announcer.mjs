#!/usr/bin/env node
// gen-sfx-announcer.mjs — the System's stinger language (SOUNDPLAN §4.1):
// twelve cues generated from ONE shared timbre — a dry two-partial bell over
// filtered air, a little too professional — so the whole announcer surface
// sounds like one voice. Sourcing twelve clips from twelve authors is how
// you get carnival; this script is how you get a broadcast.
//
//   ident         System line, normal priority (2-note blip)
//   ident_high    headline moments (3-note authority + sub)
//   stamp         TODAY'S RULE: bureaucracy, audible (thock + paper)
//   count_tick    starting-gun countdown second (clinical)
//   count_go      the GUN at second zero
//   ledger_bank   run end IS the deposit (coins settle, drawer closes)
//   door_close    DEATH IS A DOOR: terminal, dry, no musical comment
//   draft_pick    constellation confirm (ascending shimmer)
//   draft_bank    the pick filed behind the badge (soft)
//   descend_whoosh the portal swallows you (under descend + band_sting)
//   verdict       grade reveal; host pitches it per letter (one sting, five grades)
//   till          service purchase — the System takes a cut, audibly
//
// Family targets §2.2: announcer -14 mom / peak <= -3; UI cues -22 / -8.
// Deterministic, CC0 own work. Measured from encode by measure.mjs.

import { SR, rng, buf, sine, saw, noise, pink, filt, env, mix, verb, master, declick } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const OUT = new URL("../../public/audio/sfx/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

/** The house bell: fundamental + 2.4x partial, tight decay, a hair of air. */
function bell(f, sec, r, bright = 0.35) {
  const a = sine(sec, f, f * 0.998);
  const b = sine(sec, f * 2.4, f * 2.39);
  env(a, [[0, 0], [0.004, 1], [sec, 0]]);
  env(b, [[0, 0], [0.002, bright], [sec * 0.6, 0]]);
  const air = filt(noise(sec, r), "bandpass", f * 3, 3);
  env(air, [[0, 0], [0.01, 0.1], [sec * 0.4, 0]]);
  return mix([a, 0, 1], [b, 0, 1], [air, 0, 1]);
}

function announcerMaster(x, windowSec = 0.3) {
  master(x, { rmsDb: -14, peakDb: -4.5, windowSec });
  return declick(x);
}
function uiMaster(x, windowSec = 0.2) {
  master(x, { rmsDb: -22, peakDb: -9, windowSec });
  return declick(x);
}

// ---- ident: two notes, up a fourth — "the System is speaking".
{
  const r = rng(0x1de1);
  let x = mix([bell(659, 0.28, r), 0, 0.9], [bell(880, 0.4, r), 0.14, 1]);
  x = verb(x, { time: 0.3, wet: 0.1, damp: 0.4 });
  renderOgg(OUT + "ident.ogg", announcerMaster(x, 0.2));
}

// ---- ident_high: three descending notes + a dry sub — authority, headline.
{
  const r = rng(0x1de2);
  const sub = sine(0.5, 90, 55);
  env(sub, [[0, 0], [0.006, 1], [0.5, 0]]);
  let x = mix(
    [bell(880, 0.3, r), 0, 0.9],
    [bell(659, 0.3, r), 0.16, 0.95],
    [bell(440, 0.6, r, 0.5), 0.32, 1],
    [sub, 0.32, 0.8],
  );
  x = verb(x, { time: 0.45, wet: 0.12, damp: 0.4 });
  renderOgg(OUT + "ident_high.ogg", announcerMaster(x, 0.4));
}

// ---- stamp: TODAY'S RULE — a rubber-stamp thock and the paper's flap.
{
  const r = rng(0x57a3);
  const thock = sine(0.09, 240, 130);
  env(thock, [[0, 0], [0.003, 1], [0.09, 0]]);
  const knock = filt(noise(0.05, r), "bandpass", 700, 1.2);
  env(knock, [[0, 0], [0.002, 1], [0.05, 0]]);
  const flap = filt(noise(0.14, r), "bandpass", [2600, 1200], 1);
  env(flap, [[0, 0], [0.02, 0.6], [0.14, 0]]);
  let x = mix([thock, 0, 1], [knock, 0, 0.7], [flap, 0.07, 0.5]);
  renderOgg(OUT + "stamp.ogg", announcerMaster(x, 0.15));
}

// ---- count_tick: one clinical countdown second. Short. No drama — yet.
{
  const r = rng(0x71c8);
  const t = bell(1245, 0.11, r, 0.15);
  const click = filt(noise(0.015, r), "highpass", 2500, 0.8);
  env(click, [[0, 0], [0.001, 0.8], [0.015, 0]]);
  let x = mix([t, 0, 1], [click, 0, 0.5]);
  renderOgg(OUT + "count_tick.ogg", announcerMaster(x, 0.1));
}

// ---- count_go: the GUN. A starter-pistol crack over a downbeat sub. One
// synchronized moment every seat shares — it must land as one.
{
  const r = rng(0x60e0);
  const crack = filt(noise(0.07, r), "bandpass", [5200, 1400], 0.8);
  env(crack, [[0, 0], [0.0015, 1], [0.07, 0]]);
  const body = filt(noise(0.2, r), "lowpass", 900, 0.9);
  env(body, [[0, 0], [0.004, 1], [0.2, 0]]);
  const sub = sine(0.42, 110, 45);
  env(sub, [[0, 0], [0.004, 1], [0.3, 0.4], [0.42, 0]]);
  const note = bell(880, 0.5, r, 0.4);
  let x = mix([crack, 0, 1], [body, 0.002, 0.8], [sub, 0.002, 1], [note, 0.06, 0.5]);
  x = verb(x, { time: 0.4, wet: 0.12, damp: 0.45 });
  renderOgg(OUT + "count_go.ogg", announcerMaster(x, 0.3));
}

// ---- ledger_bank: coins settle into the drawer, the drawer closes. The
// System is indifferent about whether you won — the deposit sounds the same.
{
  const r = rng(0x1ed6);
  const coins = [];
  let at = 0;
  for (let i = 0; i < 9; i++) {
    const f = 2400 + r() * 2200;
    const c = sine(0.06, f, f * 0.97);
    env(c, [[0, 0], [0.002, 0.5 + r() * 0.5], [0.06, 0]]);
    coins.push([c, at, 0.5 * (1 - i / 12)]);
    at += 0.035 + r() * 0.07 + i * 0.012; // settling: gaps widen
  }
  const drawer = filt(noise(0.1, r), "bandpass", 500, 1.1);
  env(drawer, [[0, 0], [0.004, 1], [0.1, 0]]);
  const latch = sine(0.08, 190, 120);
  env(latch, [[0, 0], [0.003, 1], [0.08, 0]]);
  let x = mix(...coins, [drawer, at + 0.12, 0.9], [latch, at + 0.13, 0.9]);
  x = verb(x, { time: 0.25, wet: 0.08, damp: 0.5 });
  renderOgg(OUT + "ledger_bank.ogg", announcerMaster(x, 0.35));
}

// ---- door_close: DEATH IS A DOOR. A single cold close: soft thud, latch,
// nothing else. Terminal, dry, no musical comment.
{
  const r = rng(0xd004);
  const thud = sine(0.16, 120, 62);
  env(thud, [[0, 0], [0.005, 1], [0.16, 0]]);
  const wood = filt(noise(0.09, r), "bandpass", 320, 1.3);
  env(wood, [[0, 0], [0.004, 0.9], [0.09, 0]]);
  const latch = filt(noise(0.03, r), "bandpass", 1900, 2);
  env(latch, [[0, 0], [0.002, 0.7], [0.03, 0]]);
  let x = mix([thud, 0, 1], [wood, 0.002, 0.7], [latch, 0.22, 0.5]);
  renderOgg(OUT + "door_close.ogg", announcerMaster(x, 0.25));
}

// ---- draft_pick: the constellation confirm — three quick notes up + sparkle.
{
  const r = rng(0xd4a1);
  let x = mix(
    [bell(659, 0.16, r), 0, 0.8],
    [bell(831, 0.16, r), 0.07, 0.85],
    [bell(1109, 0.34, r), 0.14, 1],
  );
  const spark = filt(noise(0.25, r), "highpass", 4000, 0.8);
  env(spark, [[0, 0], [0.15, 0.15], [0.25, 0]]);
  x = mix([x, 0, 1], [spark, 0.14, 1]);
  renderOgg(OUT + "draft_pick.ogg", uiMaster(x, 0.25));
}

// ---- draft_bank: filed behind the badge — a muted tick and a paper slide.
{
  const r = rng(0xd4a2);
  const tick = bell(740, 0.09, r, 0.1);
  const slide = filt(noise(0.16, r), "bandpass", [1800, 900], 1);
  env(slide, [[0, 0], [0.05, 0.5], [0.16, 0]]);
  let x = mix([tick, 0, 0.8], [slide, 0.03, 0.6]);
  renderOgg(OUT + "draft_bank.ogg", uiMaster(x, 0.15));
}

// ---- descend_whoosh: the portal swallows you — a downward swallow under
// the existing descend thunk + band sting (they layer; this is the air).
{
  const r = rng(0xde5c);
  const air = filt(noise(0.9, r), "bandpass", [2400, 220], 1.1);
  env(air, [[0, 0], [0.1, 0.6], [0.35, 1], [0.9, 0]]);
  const fall = sine(0.9, 300, 55);
  env(fall, [[0, 0], [0.15, 0.5], [0.9, 0]]);
  let x = mix([air, 0, 1], [fall, 0, 0.5]);
  x = verb(x, { time: 0.4, wet: 0.15, damp: 0.5 });
  renderOgg(OUT + "descend_whoosh.ogg", master(declick(x), { rmsDb: -18, peakDb: -7, windowSec: 0.4 }));
}

// ---- verdict: the grade reveal. ONE sting; the host pitches it per letter
// (S=1.22 down to D=0.82), so five grades cost one file.
{
  const r = rng(0x6ade);
  const sub = sine(0.6, 100, 58);
  env(sub, [[0, 0], [0.006, 1], [0.6, 0]]);
  let x = mix(
    [bell(587, 0.35, r, 0.45), 0, 0.9],
    [bell(880, 0.9, r, 0.5), 0.18, 1],
    [sub, 0.18, 0.7],
  );
  x = verb(x, { time: 0.6, wet: 0.16, damp: 0.4 });
  renderOgg(OUT + "verdict.ogg", announcerMaster(x, 0.4));
}

// ---- till: the transaction. Ka-chunk, then the faintest ding — a register,
// not a slot machine. The cut the System takes is the chunk.
{
  const r = rng(0x7111);
  const chunk1 = filt(noise(0.04, r), "bandpass", 900, 1.4);
  env(chunk1, [[0, 0], [0.002, 1], [0.04, 0]]);
  const chunk2 = filt(noise(0.05, r), "bandpass", 600, 1.2);
  env(chunk2, [[0, 0], [0.003, 1], [0.05, 0]]);
  const ding = bell(2100, 0.3, r, 0.2);
  let x = mix([chunk1, 0, 0.9], [chunk2, 0.09, 1], [ding, 0.16, 0.35]);
  renderOgg(OUT + "till.ogg", uiMaster(x, 0.2));
}
