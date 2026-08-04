#!/usr/bin/env node
// gen-sfx-world.mjs — status APPLY cues + the breakable smash family
// (SOUNDPLAN §1.4 rows 1 and 5). Deterministic; see lib.mjs.
//
// Applies read as THE MOMENT IT LANDS (transient, element-voiced), distinct
// from the tick voices (dot_burn crackle / dot_poison bubble / dot_chill
// chime) which keep reading as the element burning along.
// Family: barks/status applies — -18 LUFS momentary, peak <= -6 dBFS.
// Smashes are impacts: -15 momentary, peak <= -3 (played at manifest ~0.55).

import { rng, sine, saw, noise, pink, filt, env, mix, verb, master, declick, buf, SR } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const OUT = new URL("../../public/audio/sfx/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

// ---- apply_burn: ignition — a rising air whoosh catching into crackle.
{
  const r = rng(0xf1ae);
  const whoosh = filt(noise(0.3, r), "bandpass", [500, 2600], 1.2);
  env(whoosh, [[0, 0], [0.05, 0.7], [0.14, 1], [0.3, 0]]);
  // crackle: sparse impulse bursts through a highpass
  const crackle = buf(0.28);
  for (let i = 0; i < crackle.length; i++) crackle[i] = r() < 0.004 ? (r() * 2 - 1) : 0;
  filt(crackle, "highpass", 1800, 0.9);
  env(crackle, [[0, 0], [0.08, 0.4], [0.18, 1], [0.28, 0]]);
  let x = mix([whoosh, 0, 0.8], [crackle, 0.04, 0.9]);
  master(x, { rmsDb: -18, peakDb: -6, windowSec: 0.2 });
  declick(x);
  renderOgg(OUT + "apply_burn.ogg", x);
}

// ---- apply_poison: the splat — a wet impact with a low blub swallowed after.
{
  const r = rng(0x9015);
  const splat = filt(noise(0.09, r), "bandpass", [1400, 300], 0.8);
  env(splat, [[0, 0], [0.004, 1], [0.09, 0]]);
  const blub = sine(0.16, 210, 70);
  env(blub, [[0, 0], [0.02, 0.8], [0.16, 0]]);
  const drip = sine(0.07, 900, 500);
  env(drip, [[0, 0], [0.01, 0.5], [0.07, 0]]);
  let x = mix([splat, 0, 1], [blub, 0.03, 0.8], [drip, 0.12, 0.35]);
  master(x, { rmsDb: -18, peakDb: -6, windowSec: 0.15 });
  declick(x);
  renderOgg(OUT + "apply_poison.ogg", x);
}

// ---- apply_chill: crystallization — inharmonic glassy partials snapping in,
// then a cold air hiss settling. Distinct from dot_chill's soft chime.
{
  const r = rng(0xc111);
  const partials = [2100, 2740, 3390, 4630].map((f, i) => {
    const s = sine(0.22, f, f * 0.996);
    env(s, [[0, 0], [0.003 + i * 0.012, 1], [0.05 + i * 0.012, 0.3], [0.22, 0]]);
    return [s, i * 0.012, 0.32 - i * 0.05];
  });
  const hiss = filt(pink(0.3, r), "highpass", 3000, 0.8);
  env(hiss, [[0, 0], [0.05, 0.5], [0.3, 0]]);
  const snap = filt(noise(0.02, r), "bandpass", 3300, 2);
  env(snap, [[0, 0], [0.002, 1], [0.02, 0]]);
  let x = mix([snap, 0, 0.8], ...partials, [hiss, 0.02, 0.4]);
  master(x, { rmsDb: -18, peakDb: -6, windowSec: 0.2 });
  declick(x);
  renderOgg(OUT + "apply_chill.ogg", x);
}

// ---- smash_wood: crate/furniture pop — snap transient + wood-body knock +
// a couple of splinter clicks. The engine's ±5% jitter + director's hashed
// rate spread keep repeats from machine-gunning.
{
  const r = rng(0x800d);
  const snap = filt(noise(0.03, r), "bandpass", [2600, 800], 0.9);
  env(snap, [[0, 0], [0.002, 1], [0.03, 0]]);
  const knock = sine(0.12, 180, 95);
  env(knock, [[0, 0], [0.004, 1], [0.12, 0]]);
  const body = filt(noise(0.14, r), "bandpass", 420, 1.4);
  env(body, [[0, 0], [0.006, 0.9], [0.14, 0]]);
  const splinters = buf(0.16);
  for (let i = 0; i < splinters.length; i++) splinters[i] = r() < 0.0015 ? (r() * 2 - 1) : 0;
  filt(splinters, "bandpass", 1900, 1.4);
  env(splinters, [[0, 0], [0.03, 1], [0.16, 0]]);
  let x = mix([snap, 0, 0.9], [knock, 0.002, 0.9], [body, 0.004, 0.7], [splinters, 0.03, 0.7]);
  x = verb(x, { time: 0.25, wet: 0.1, damp: 0.5 });
  master(x, { rmsDb: -15, peakDb: -4, windowSec: 0.15 });
  declick(x);
  renderOgg(OUT + "smash_wood.ogg", x);
}

// ---- smash_clay: pot/bottle shatter — brighter crack, ceramic ring shards.
{
  const r = rng(0xc1a4);
  const crack = filt(noise(0.025, r), "bandpass", [4200, 1500], 0.8);
  env(crack, [[0, 0], [0.0015, 1], [0.025, 0]]);
  const rings = [1350, 2210, 3480].map((f, i) => {
    const s = sine(0.14, f, f * 0.99);
    env(s, [[0, 0], [0.004, 0.8], [0.14, 0]]);
    return [s, 0.004 + i * 0.006, 0.28 - i * 0.07];
  });
  const shards = buf(0.18);
  for (let i = 0; i < shards.length; i++) shards[i] = r() < 0.002 ? (r() * 2 - 1) : 0;
  filt(shards, "highpass", 2500, 0.8);
  env(shards, [[0, 0], [0.02, 1], [0.18, 0]]);
  let x = mix([crack, 0, 1], ...rings, [shards, 0.02, 0.8]);
  x = verb(x, { time: 0.2, wet: 0.08, damp: 0.4 });
  master(x, { rmsDb: -15, peakDb: -4, windowSec: 0.15 });
  declick(x);
  renderOgg(OUT + "smash_clay.ogg", x);
}
