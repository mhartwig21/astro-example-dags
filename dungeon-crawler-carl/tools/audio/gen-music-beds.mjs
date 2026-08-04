#!/usr/bin/env node
// tools/audio/gen-music-beds.mjs — the SOUNDPLAN §3 music plan, rendered.
//
// Seven looping beds: the six band ambiences (UNDERCROFT / SEWERS / GARDEN /
// RUINS / IRONWORKS / APPROACH) plus the menu/campfire check-in bed. All
// synthesized from the shared DSP lib (seeded, deterministic — a rerun is
// byte-identical thanks to enc.mjs bitexact muxing), stereo, and mastered to
// the §2.2 ambient-family targets: -23 LUFS-I ±1, true peak ≤ -6 dBTP —
// measured with ffmpeg loudnorm here in the script, then re-verified from
// the encoded OGG by tools/audio/measure.mjs.
//
// LOOP SEAMS ARE CONSTRUCTED, NOT HOPED FOR: every bed renders LOOP+XF+TAIL
// seconds; loopFold() wrap-adds everything past LOOP+XF back into the body
// (event/reverb tails cross the seam instead of being cut) and equal-power
// crossfades the XF-second tail into the head, so sample LOOP-1 → sample 0
// is continuous by construction. measure.mjs --loop reports the number.
//
// House sound: dungeon-crawler FIRST — dry menace, not carnival. Registers
// per bed are the §3 table's, verbatim.
//
// Usage: node tools/audio/gen-music-beds.mjs [bed...]   (default: all)

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  rng, secs, buf, db, sine, saw, tri, noise, pink, filt, env,
  shimmer, verb, writeWavStereo,
} from "./lib.mjs";
import { renderOggStereo } from "./enc.mjs";

const OUT = "public/audio/music";
const TARGET_I = -23; // LUFS-I, ambient family (§2.2)
const CEIL_TP = -6.0; // dBTP ceiling
const only = process.argv.slice(2);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Add src into dst at second-offset `at` (dst must be long enough). */
function add(dst, src, at, g = 1) {
  const o = secs(at);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * g;
}

/**
 * Make a loop of exactly `L` seconds from a longer render: equal-power
 * crossfade the [L, L+XF) tail into the [0, XF) head. out[0] === x[L], so the
 * wrap point is continuous by construction. CONTRACT ON THE GENERATORS: every
 * event tail (verb included) must decay before L+XF — schedule the last event
 * early enough — because material past L+XF is discarded, not wrapped (a
 * wrap-add would double the steady drone layers, which run the full render).
 */
function loopFold(x, L, XF) {
  const Ln = secs(L), XFn = secs(XF);
  const out = new Float32Array(Ln);
  for (let i = 0; i < Ln; i++) out[i] = x[i];
  for (let i = 0; i < XFn; i++) {
    const w = (i / XFn) * (Math.PI / 2);
    out[i] = out[i] * Math.sin(w) + x[Ln + i] * Math.cos(w);
  }
  return out;
}

/** Multiply by a periodic envelope: shape(phase 0..1) -> gain. */
function cycleMod(x, periodSec, shape) {
  const p = secs(periodSec);
  for (let i = 0; i < x.length; i++) x[i] *= shape((i % p) / p);
  return x;
}

/** Detuned saw stack -> lowpass: the pad/drone workhorse. */
function padStack(sec, notes, { detune = 0.0025, lp = 900, q = 0.8, seed = 1 } = {}) {
  const r = rng(seed);
  let out = buf(sec);
  for (const f of notes) {
    const d = 1 + (r() * 2 - 1) * detune;
    add(out, saw(sec, f * d), 0, 1 / notes.length);
    add(out, saw(sec, f / d), 0, 1 / notes.length);
  }
  return filt(out, "lowpass", lp, q);
}

/** Swept-sine thump (the physical low hit). */
function thump(f0, f1, sec) {
  const x = sine(sec, f0, f1);
  const n = x.length;
  for (let i = 0; i < n; i++) x[i] *= Math.exp((-4 * i) / n);
  return x;
}

/** Exponentially decaying sine (bell partial / pluck). */
function ding(f, sec, tau) {
  const x = sine(sec, f);
  for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / secs(tau));
  return x;
}

/** Short filtered-noise burst with exponential decay. */
function burst(sec, r, type, f, q, tau) {
  const x = filt(noise(sec, r), type, f, q);
  for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / secs(tau));
  return x;
}

// ---- mastering: measure real LUFS/TP with ffmpeg loudnorm, hit the family
// target with a joint gain, soft-knee limit only if the ceiling forces it.

function loudnorm(wavPath) {
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", wavPath,
    "-af", "loudnorm=I=-23:TP=-6.0:LRA=20:print_format=json", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 1 << 28 });
  const m = r.stderr.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`loudnorm gave no JSON for ${wavPath}:\n${r.stderr.slice(-800)}`);
  const j = JSON.parse(m[0]);
  return { i: parseFloat(j.input_i), tp: parseFloat(j.input_tp) };
}

function jointGain(l, r, d) {
  const g = db(d);
  for (let i = 0; i < l.length; i++) { l[i] *= g; r[i] *= g; }
}

/** Soft-knee ceiling on the sample-pair max (image-preserving): identity up
 * to 70% of the ceiling, tanh compression above, asymptote at the ceiling. */
function jointLimit(l, r, ceilDb) {
  const c = db(ceilDb), k = c * 0.7, range = c - k;
  for (let i = 0; i < l.length; i++) {
    const m = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (m <= k) continue;
    const s = (k + range * Math.tanh((m - k) / range)) / m;
    l[i] *= s; r[i] *= s;
  }
}

/** Master a stereo pair to TARGET_I / CEIL_TP; returns the final measures. */
function masterBed(name, l, r) {
  const tmp = join(tmpdir(), `dcc-bed-${process.pid}-${name}.wav`);
  writeWavStereo(tmp, l, r);
  let m = loudnorm(tmp);
  let g = TARGET_I - m.i;
  if (m.tp + g > CEIL_TP - 0.5) {
    // Loudness gain would breach the ceiling: take the gain, then shave the
    // crest (limit to 0.7dB under the ceiling — margin for intersample peaks).
    jointGain(l, r, g);
    jointLimit(l, r, CEIL_TP - 0.7);
    writeWavStereo(tmp, l, r);
    m = loudnorm(tmp);
    g = TARGET_I - m.i;
    if (m.tp + g <= CEIL_TP - 0.2) { jointGain(l, r, g); writeWavStereo(tmp, l, r); m = loudnorm(tmp); }
  } else {
    jointGain(l, r, g);
    writeWavStereo(tmp, l, r);
    m = loudnorm(tmp);
  }
  rmSync(tmp, { force: true });
  return m;
}

// ---------------------------------------------------------------------------
// the seven beds (§3 table, top to bottom)
// ---------------------------------------------------------------------------

const BEDS = {
  // THE UNDERCROFT (floors 1-3) — crypt drone. Bone-dry low C pedal, faint
  // choir-formant swells, one distant stone impact per phrase. Museum-quiet.
  band_undercroft() {
    const L = 72, XF = 6, T = L + XF + 8;
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      // low C pedal: C1 + C2, breathing on the 18s phrase
      add(ch, cycleMod(sine(T, 32.7), 18, (p) => 0.78 + 0.22 * Math.sin(p * 2 * Math.PI)), 0, db(-16));
      add(ch, sine(T, 65.41), 0, db(-20));
      // faint fifth drone, detuned per channel
      add(ch, filt(saw(T, seed % 2 ? 98.1 : 97.85), "lowpass", 260, 0.7), 0, db(-27));
      // dry stone air
      add(ch, shimmer(filt(pink(T, r), "lowpass", 420, 0.7), r, 2, 0.4), 0, db(-31));
      // choir-formant swells: one per phrase, alternating vowel
      for (let p2 = 0; p2 < 4; p2++) {
        const f = p2 % 2 ? 900 : 700;
        let sw = saw(10, 130.81 * (1 + (r() * 2 - 1) * 0.004));
        sw = filt(filt(sw, "bandpass", f, 4), "bandpass", f * 1.5, 6);
        env(sw, [[0, 0], [4, 1], [6, 1], [10, 0]]);
        add(ch, sw, p2 * 18 + 3, db(-14));
      }
      return ch;
    };
    const l = mk(101), r = mk(102);
    // distant stone impacts (mono center, verb'd): 3 per loop, off the grid
    const ri = rng(103);
    const stones = buf(T);
    for (const t of [9.5, 31, 55.5]) {
      add(stones, thump(90, 42, 0.7), t, 1);
      add(stones, burst(0.4, ri, "lowpass", 300, 0.7, 0.09), t, 0.5);
    }
    const wet = verb(stones, { time: 1.8, wet: 0.5, damp: 0.5 });
    add(l, wet, 0, db(-8)); add(r, wet, 0, db(-8));
    return { L, XF, l, r };
  },

  // THE SEWERS (4-6) — wet resonance: detuned pipe partials, drip transients
  // as percussion, sub pulse like distant pumps on a slow 6s cycle.
  band_sewers() {
    const L = 72, XF = 6, T = L + XF + 8;
    const pump = (ch) => cycleMod(sine(T, 45), 6, (p) =>
      p < 0.1 ? p / 0.1 : p < 0.37 ? 1 - 0.3 * ((p - 0.1) / 0.27) : 0.7 * Math.exp(-(p - 0.37) * 5));
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      add(ch, pump(ch), 0, db(-17));
      // inharmonic pipe partials, each on its own slow random walk
      for (const [f, g] of [[110, -26], [303, -30], [594, -33], [979, -36]]) {
        const d = 1 + (r() * 2 - 1) * 0.003;
        add(ch, shimmer(sine(T, f * d), r, 0.8, 0.8), 0, db(g));
      }
      add(ch, filt(pink(T, r), "lowpass", 700, 0.7), 0, db(-33));
      return ch;
    };
    const l = mk(202), r = mk(203);
    // drips: seeded irregular pings through a wet verb, thrown left/right
    const rd = rng(204);
    const dl = buf(T), dr = buf(T);
    for (let t = 1 + rd() * 2; t < L; t += 0.7 + rd() * 2.2) {
      const f = 900 + rd() * 900;
      const ping = sine(0.05, f, f * 0.45);
      for (let i = 0; i < ping.length; i++) ping[i] *= Math.exp(-i / secs(0.012));
      const side = rd() < 0.5;
      add(dl, ping, t, side ? 0.9 : 0.25);
      add(dr, ping, t, side ? 0.25 : 0.9);
    }
    add(l, verb(dl, { time: 1.4, wet: 0.65, damp: 0.3 }), 0, db(-13));
    add(r, verb(dr, { time: 1.4, wet: 0.65, damp: 0.3 }), 0, db(-13));
    return { L, XF, l, r };
  },

  // THE GARDEN (7-9) — overgrown false calm: breath-slow minor pad, shaped-
  // noise insect bed, an occasional wrong-note bloom (the floor fights back).
  band_garden() {
    const L = 84, XF = 6, T = L + XF + 8;
    const NOTES = [110, 130.81, 164.81, 246.94];
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      const pad = padStack(T, NOTES, { lp: 850, seed: seed * 7 });
      cycleMod(pad, 21, (p) => 0.68 + 0.32 * Math.sin(p * 2 * Math.PI - Math.PI / 2));
      add(ch, pad, 0, db(-9));
      // insect bed: high shaped noise, fast shimmer — alive, not friendly
      add(ch, shimmer(filt(noise(T, r), "bandpass", 4800, 2.5), r, 11, 0.8), 0, db(-33));
      add(ch, shimmer(filt(noise(T, r), "bandpass", 6400, 3), r, 7, 0.9), 0, db(-38));
      add(ch, filt(pink(T, r), "lowpass", 600, 0.7), 0, db(-33));
      return ch;
    };
    const l = mk(303), r = mk(304);
    // wrong-note blooms: D# against the A-minor pad, swelling out of the verb
    const blooms = buf(T);
    for (const [t, f] of [[16, 155.56], [47, 155.56], [68, 233.08]]) {
      let b = sine(4, f);
      add(b, sine(4, f * 1.5), 0, 0.4);
      env(b, [[0, 0], [1.8, 1], [2.6, 0.8], [4, 0]]);
      add(blooms, b, t, 1);
    }
    const wet = verb(blooms, { time: 2.2, wet: 0.45, damp: 0.35 });
    add(l, wet, 0, db(-17)); add(r, wet, 0.02, db(-18)); // slight haas skew
    return { L, XF, l, r };
  },

  // THE RUINS (10-12) — dead civilization: formant-filtered saw "choir" on a
  // liturgical cadence, a slow inharmonic bell, long stone tails.
  band_ruins() {
    const L = 84, XF = 6, T = L + XF + 8;
    const CHORDS = [
      [73.42, 110, 146.83, 174.61],   // Dm
      [116.54, 146.83, 174.61],       // Bb
      [98, 116.54, 146.83],           // Gm
      [110, 138.59, 164.81],          // A (the unresolved dominant)
    ];
    const mk = (seed) => {
      const ch = buf(T);
      // chords every 21s, 2s in / 4s out overlaps; chord 0 re-enters at 84
      // so the wrap crossfade lands mid-phrase, not mid-silence
      for (let c = 0; c <= 4; c++) {
        const notes = CHORDS[c % 4];
        let seg = padStack(23, notes, { lp: 1200, seed: seed * 13 + c });
        seg = filt(seg, "bandpass", 620, 1.2);
        const seg2 = padStack(23, notes, { lp: 1200, seed: seed * 17 + c });
        add(seg, filt(seg2, "bandpass", 980, 1.6), 0, 0.7);
        env(seg, [[0, 0], [2, 1], [19, 1], [23, 0]]);
        add(ch, seg, c * 21, db(-6));
      }
      const r = rng(seed);
      add(ch, filt(pink(T, r), "lowpass", 500, 0.7), 0, db(-33));
      return ch;
    };
    const l = mk(404), r = mk(405);
    // the bell: classic inharmonic partial set, tolling every 14s
    const bells = buf(T);
    const RATIOS = [0.56, 0.92, 1.19, 1.71, 2.0, 2.74];
    for (let k = 0; k < 6; k++) {
      const base = k % 2 ? 123.47 : 164.81;
      for (let pi = 0; pi < RATIOS.length; pi++) {
        add(bells, ding(base * RATIOS[pi], 9, 2.2 / (pi + 1)), 7 + k * 14, 0.5 / (pi + 1));
      }
    }
    const wet = verb(bells, { time: 2.8, wet: 0.35, damp: 0.45 });
    add(l, wet, 0, db(-13)); add(r, wet, 0.015, db(-13.5));
    return { L, XF, l, r };
  },

  // THE IRONWORKS (13-15) — the machine floor: 90 BPM industrial pulse,
  // vent hiss, clank accents off the beat, conveyor drone. Bar-exact loop:
  // 80s = 30 bars of 4 at 90 BPM.
  band_ironworks() {
    const L = 80, XF = 16 / 3, T = L + XF + 8; // XF = 8 beats, grid-aligned
    const BEAT = 2 / 3;
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      add(ch, filt(saw(T, seed % 2 ? 55 : 55.35), "lowpass", 240, 0.8), 0, db(-19));
      add(ch, filt(saw(T, seed % 2 ? 82.6 : 82.4), "lowpass", 300, 0.8), 0, db(-27));
      // vent hiss every 8 beats
      for (let t = 2 * BEAT; t < T - 2; t += 8 * BEAT) {
        const h = filt(noise(2, r), "highpass", 2200, 0.7);
        env(h, [[0, 0], [0.15, 1], [0.9, 0.3], [2, 0]]);
        add(ch, h, t, db(seed % 2 ? -30 : -32));
      }
      return ch;
    };
    const l = mk(505), r = mk(506);
    // the pulse: a dry thump on every beat, accent on the bar
    const pulse = buf(T);
    for (let b = 0; b * BEAT < L; b++) {
      add(pulse, thump(85, 42, 0.18), b * BEAT, b % 4 === 0 ? 1 : 0.62);
    }
    add(l, pulse, 0, db(-11)); add(r, pulse, 0, db(-11));
    // clanks: inharmonic metal on off-beats, seeded bar pattern, thrown wide
    const rc = rng(507);
    const cl = buf(T), cr = buf(T);
    for (let bar = 0; bar * 4 * BEAT < L; bar++) {
      if (rc() < 0.45) continue;
      const t = bar * 4 * BEAT + (rc() < 0.5 ? 1.5 : 2.5) * BEAT;
      const hit = buf(0.6);
      for (const [f, g] of [[700, 0.5], [1660, 0.34], [2350, 0.2], [3100, 0.12]]) {
        add(hit, ding(f * (1 + (rc() * 2 - 1) * 0.02), 0.6, 0.07), 0, g);
      }
      add(hit, burst(0.09, rc, "bandpass", 2500, 1.5, 0.02), 0, 0.5);
      const side = rc() < 0.5;
      add(cl, hit, t, side ? 1 : 0.3);
      add(cr, hit, t, side ? 0.3 : 1);
    }
    add(l, verb(cl, { time: 1.1, wet: 0.25, damp: 0.4 }), 0, db(-13));
    add(r, verb(cr, { time: 1.1, wet: 0.25, damp: 0.4 }), 0, db(-13));
    return { L, XF, l, r };
  },

  // THE APPROACH (16-18) — showtime dread: broadcast mains hum, a low
  // brass-ish cluster, a crowd texture that NEVER resolves into cheering,
  // and a 45 BPM heartbeat. The studio is watching.
  band_approach() {
    const L = 84, XF = 6, T = L + XF + 8;
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      // mains hum (mono-ish center: same partials, different phase drift)
      add(ch, sine(T, 50), 0, db(-22));
      add(ch, sine(T, 100 * (1 + (r() - 0.5) * 0.0004)), 0, db(-28));
      add(ch, sine(T, 150), 0, db(-33));
      // low cluster: minor seconds, swelling on a 12s cycle (7 per loop)
      const cluster = padStack(T, [87.31, 92.5, 98], { lp: 380, seed: seed * 31 });
      cycleMod(cluster, 12, (p) => 0.62 + 0.38 * Math.sin(p * 2 * Math.PI - Math.PI / 2));
      add(ch, cluster, 0, db(-7));
      // the crowd: band-limited roar that swells and always backs down
      const crowd = shimmer(filt(pink(T, r), "bandpass", 900, 0.5), r, 5, 0.6);
      cycleMod(crowd, 10.5, (p) => (p < 0.66 ? 0.55 + 0.45 * (p / 0.66) : 1 - 0.45 * ((p - 0.66) / 0.34)));
      add(ch, crowd, 0, db(-25));
      return ch;
    };
    const l = mk(606), r = mk(607);
    // heartbeat: lub-dub every 4/3s (63 per loop, exact)
    const hb = buf(T);
    for (let t = 0; t < L - 0.01; t += 4 / 3) {
      add(hb, thump(58, 40, 0.11), t, 1);
      add(hb, thump(52, 38, 0.09), t + 0.32, 0.55);
    }
    add(l, hb, 0, db(-13)); add(r, hb, 0, db(-13));
    return { L, XF, l, r };
  },

  // Menu / campfire — the check-in: small, warm-ish, tired. Soft pad, a slow
  // filtered arp, fire crackle. The only near-friendly cue in the game.
  menu() {
    const L = 72, XF = 6, T = L + XF + 8;
    const NOTES = [130.81, 164.81, 196, 246.94]; // Cmaj7, voiced low
    const mk = (seed) => {
      const r = rng(seed);
      const ch = buf(T);
      const pad = padStack(T, NOTES, { lp: 1100, seed: seed * 3 });
      const soft = buf(T);
      for (const f of NOTES) add(soft, tri(T, f * (1 + (r() - 0.5) * 0.002)), 0, 0.25);
      add(pad, filt(soft, "lowpass", 1400, 0.7), 0, 0.5);
      cycleMod(pad, 9, (p) => 0.7 + 0.3 * Math.sin(p * 2 * Math.PI - Math.PI / 2));
      add(ch, pad, 0, db(-10));
      // campfire: warm floor + seeded crackles
      add(ch, filt(pink(T, r), "lowpass", 260, 0.7), 0, db(-27));
      for (let t = 0.4 + r(); t < T - 0.5; t += 0.3 + r() * 1.4) {
        add(ch, burst(0.03, r, "bandpass", 1800 + r() * 1200, 1.2, 0.004), t, db(-24 - r() * 8));
      }
      return ch;
    };
    const l = mk(707), r = mk(708);
    // the arp: 0.45s grid, 160 steps (exact), 6 notes + 2 rests per cycle
    const ARP = [261.63, 329.63, 392, 493.88, 392, 329.63, 0, 0];
    const ra = rng(709);
    const al = buf(T), ar = buf(T);
    for (let s = 0; s * 0.45 < L; s++) {
      const f = ARP[s % 8];
      if (!f) continue;
      let p = sine(0.5, f);
      for (let i = 0; i < p.length; i++) p[i] *= Math.exp(-i / secs(0.14));
      p = filt(p, "lowpass", 2000 - 900 * ((s % 8) / 8), 0.9);
      const pan = 0.5 + 0.3 * Math.sin(s * 1.1) + (ra() - 0.5) * 0.06;
      add(al, p, s * 0.45, 1 - pan * 0.6);
      add(ar, p, s * 0.45, 0.4 + pan * 0.6);
    }
    add(l, verb(al, { time: 1.3, wet: 0.3, damp: 0.4 }), 0, db(-17));
    add(r, verb(ar, { time: 1.3, wet: 0.3, damp: 0.4 }), 0, db(-17));
    return { L, XF, l, r };
  },
};

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

for (const [name, build] of Object.entries(BEDS)) {
  if (only.length && !only.includes(name)) continue;
  const t0 = Date.now();
  const { L, XF, l, r } = build();
  const ll = loopFold(l, L, XF);
  const rr = loopFold(r, L, XF);
  const m = masterBed(name, ll, rr);
  renderOggStereo(join(OUT, `${name}.ogg`), ll, rr, { q: 3 });
  console.log(
    `  ${name}: ${L}s loop, mastered to ${m.i} LUFS-I (target ${TARGET_I}±1), ` +
    `TP ${m.tp} dBTP (ceil ${CEIL_TP}), ${((Date.now() - t0) / 1000).toFixed(1)}s render`,
  );
}
