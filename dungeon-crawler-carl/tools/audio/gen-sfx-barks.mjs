#!/usr/bin/env node
// gen-sfx-barks.mjs — creature vocalization per archetype FAMILY, not per
// 36-mob roster (SOUNDPLAN §1.4 row 9): five voices x {aggro, pain, death}
// x 2 variants = 30 mono clips. One parametric synth per family so the set
// sounds like five SPECIES, not thirty files from thirty authors.
//
//   skel — bone rattle: irregular click bursts, no vocal cords at all
//   org  — beast/plant: rough AM growl through wide formants
//   hum  — humanoid/show-cast: shorter, darker grunt (formant stack)
//   mech — machine: servo sweeps + inharmonic clank, power-down deaths
//   air  — phantom/witch: breath, whistle partials, dissolve deaths
//
// Family target (§2.2 barks): -18 LUFS momentary, peak <= -6 dBFS.
// Deterministic per (family, event, variant) seed. CC0 own work.

import { SR, rng, buf, sine, saw, noise, pink, filt, env, mix, verb, master, declick } from "./lib.mjs";
import { renderOgg } from "./enc.mjs";

const OUT = new URL("../../public/audio/sfx/barks/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

/** Sparse impulse train: density per second, amplitude jitter. */
function clicks(sec, r, density, band, q = 1.2) {
  const x = buf(sec);
  for (let i = 0; i < x.length; i++) if (r() < density / SR) x[i] = (0.4 + 0.6 * r()) * (r() < 0.5 ? -1 : 1);
  return filt(x, "bandpass", band, q);
}

/** Rough growl source: detuned saw pair + AM roughness, formant filtered. */
function growl(sec, r, f0, f1, formants, rough = 32) {
  const a = saw(sec, f0, f1);
  const b = saw(sec, f0 * 1.02, f1 * 1.018);
  let x = mix([a, 0, 0.6], [b, 0, 0.5]);
  for (let i = 0; i < x.length; i++) x[i] *= 0.65 + 0.35 * Math.sin((2 * Math.PI * rough * i) / SR + Math.sin(i * 0.0003) * 2);
  const voiced = formants.map(([f, q, g]) => {
    const c = Float32Array.from(x);
    filt(c, "bandpass", f, q);
    return [c, 0, g];
  });
  const breath = filt(noise(sec, r), "bandpass", formants[0][0] * 2, 1.2);
  return mix(...voiced, [breath, 0, 0.12]);
}

const FAMS = {
  skel(ev, v, r) {
    const long = ev === "death";
    const sec = ev === "pain" ? 0.28 : long ? 0.8 : 0.45;
    const x = clicks(sec, r, ev === "pain" ? 70 : 55, [1900 + v * 250, 700], 1.0);
    // jaw resonance so it reads skull, not castanet
    const jaw = clicks(sec, r, 24, 320, 2.2);
    let y = mix([x, 0, 1], [jaw, 0, 0.8]);
    if (long) {
      // the collapse: rattle accelerates then a bone clunk lands
      env(y, [[0, 0.4], [0.3, 1], [0.65, 0.7], [0.8, 0]]);
      const clunk = sine(0.12, 150 + v * 15, 70);
      env(clunk, [[0, 0], [0.005, 1], [0.12, 0]]);
      y = mix([y, 0, 1], [clunk, sec - 0.18, 0.9]);
    } else {
      env(y, [[0, 0], [0.03, 1], [sec - 0.08, 0.8], [sec, 0]]);
    }
    return y;
  },
  org(ev, v, r) {
    const base = 105 + v * 22;
    if (ev === "aggro") {
      let x = growl(0.55, r, base * 0.8, base * 1.5, [[420, 2.2, 1], [1150, 2.8, 0.5]]);
      env(x, [[0, 0], [0.08, 0.5], [0.35, 1], [0.55, 0]]);
      return x;
    }
    if (ev === "pain") {
      let x = growl(0.26, r, base * 1.9, base * 1.1, [[560, 2.4, 1], [1400, 3, 0.6]]);
      env(x, [[0, 0], [0.015, 1], [0.26, 0]]);
      return x;
    }
    let x = growl(0.85, r, base * 1.3, base * 0.55, [[380, 2.2, 1], [980, 2.6, 0.4]]);
    env(x, [[0, 0], [0.05, 1], [0.5, 0.6], [0.85, 0]]);
    return x;
  },
  hum(ev, v, r) {
    const base = 125 + v * 18;
    const form = [[430, 3, 1], [900, 3.5, 0.55], [2300, 4, 0.2]];
    if (ev === "aggro") {
      let x = growl(0.32, r, base, base * 1.35, form, 24);
      env(x, [[0, 0], [0.04, 1], [0.26, 0.7], [0.32, 0]]);
      return x;
    }
    if (ev === "pain") {
      let x = growl(0.18, r, base * 1.6, base * 1.15, form, 26);
      env(x, [[0, 0], [0.012, 1], [0.18, 0]]);
      return x;
    }
    let x = growl(0.6, r, base * 1.2, base * 0.6, form, 22);
    env(x, [[0, 0], [0.04, 1], [0.35, 0.5], [0.6, 0]]);
    return x;
  },
  mech(ev, v, r) {
    const servo = (sec, f0, f1) => {
      const s = saw(sec, f0, f1);
      filt(s, "lowpass", 3200, 0.8);
      for (let i = 0; i < s.length; i++) s[i] *= 0.8 + 0.2 * Math.sin((2 * Math.PI * 90 * i) / SR);
      return s;
    };
    const clank = (at, f) => {
      const partials = [f, f * 2.76, f * 5.4].map((pf, i) => {
        const s = sine(0.14, pf, pf * 0.99);
        env(s, [[0, 0], [0.002, 1 - i * 0.25], [0.14, 0]]);
        return [s, at, 0.4 - i * 0.1];
      });
      return partials;
    };
    if (ev === "aggro") {
      const s = servo(0.4, 300 + v * 60, 900 + v * 80);
      env(s, [[0, 0], [0.05, 0.7], [0.3, 1], [0.4, 0]]);
      return mix([s, 0, 0.7], ...clank(0.3, 480 + v * 90));
    }
    if (ev === "pain") {
      const s = servo(0.2, 800 + v * 90, 500);
      env(s, [[0, 0], [0.01, 1], [0.2, 0]]);
      return mix([s, 0, 0.6], ...clank(0.015, 640 + v * 70));
    }
    const s = servo(0.9, 700 + v * 60, 90); // power-down
    env(s, [[0, 0], [0.02, 1], [0.7, 0.5], [0.9, 0]]);
    const rattle = clicks(0.35, r, 40, 1100, 1.4);
    env(rattle, [[0, 0], [0.1, 1], [0.35, 0]]);
    return mix([s, 0, 0.7], ...clank(0.5, 380 + v * 50), [rattle, 0.55, 0.5]);
  },
  air(ev, v, r) {
    const breath = (sec, f0, f1, q = 2.6) => {
      const n = pink(sec, r);
      filt(n, "bandpass", [f0, f1], q);
      return n;
    };
    if (ev === "aggro") {
      const b = breath(0.6, 900 + v * 150, 2400);
      const w = sine(0.6, 1150 + v * 90, 1450 + v * 90);
      env(b, [[0, 0], [0.25, 0.8], [0.5, 1], [0.6, 0]]);
      env(w, [[0, 0], [0.3, 0.25], [0.6, 0]]);
      return mix([b, 0, 1], [w, 0, 0.35]);
    }
    if (ev === "pain") {
      const b = breath(0.24, 2000 + v * 200, 900, 1.8);
      const w = sine(0.24, 1900 + v * 120, 1300);
      env(b, [[0, 0], [0.01, 1], [0.24, 0]]);
      env(w, [[0, 0], [0.02, 0.5], [0.24, 0]]);
      return mix([b, 0, 1], [w, 0, 0.4]);
    }
    const b = breath(1.0, 1500 + v * 150, 350);
    const w = sine(1.0, 1300 + v * 80, 420);
    env(b, [[0, 0], [0.08, 1], [0.6, 0.4], [1.0, 0]]);
    env(w, [[0, 0], [0.1, 0.3], [1.0, 0]]);
    return mix([b, 0, 1], [w, 0, 0.3]);
  },
};

for (const [fam, synth] of Object.entries(FAMS)) {
  for (const ev of ["aggro", "pain", "death"]) {
    for (let v = 0; v < 2; v++) {
      // Stable seed per clip: family/event/variant packed into an int.
      const seed = (fam.charCodeAt(0) << 16) ^ (ev.charCodeAt(0) << 8) ^ (v + 1);
      let x = synth(ev, v, rng(seed >>> 0));
      x = verb(x, { time: 0.3, wet: 0.08, damp: 0.5 });
      // Pre-encode ceiling -7.5: vorbis overshoots clicky transients by up
      // to ~1.5dB, and the -6 family ceiling is judged on the ENCODED file.
      master(x, { rmsDb: -18, peakDb: -7.5, windowSec: 0.25 });
      declick(x);
      renderOgg(`${OUT}bark_${fam}_${ev}_${v === 0 ? "a" : "b"}.ogg`, x);
    }
  }
}
