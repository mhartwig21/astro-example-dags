// tools/audio/lib.mjs — the shared DSP library every committed generator
// script builds on (SOUNDPLAN §3/§4.1: generated assets are reproducible —
// seeded, deterministic, byte-stable across runs). Mono Float32 buffers at
// 48kHz in, PCM-16 WAV out; ffmpeg does the OGG encode in the generators.
//
// Nothing here is clever: band-limited-enough oscillators for the register
// we synthesize in (drones, thumps, whooshes, formant noise), RBJ biquads,
// piecewise envelopes, a Schroeder-style reverb, and a mastering helper that
// hits the SOUNDPLAN §2.2 family targets (momentary RMS + peak ceiling) by
// construction instead of by ear — nobody in this loop has one.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SR = 48000;

/** Deterministic RNG (mulberry32). Every generator seeds explicitly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const secs = (n) => Math.round(n * SR);
export const buf = (sec) => new Float32Array(secs(sec));
export const db = (d) => Math.pow(10, d / 20);

/** Sine with optional exponential frequency sweep (phase-integrated). */
export function sine(sec, f0, f1 = f0, phase = 0) {
  const out = buf(sec);
  const n = out.length;
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const f = f0 * Math.pow(f1 / f0, i / n);
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(ph);
  }
  return out;
}

/** Naive saw/triangle — used only under lowpass filters in drone register. */
export function saw(sec, f0, f1 = f0) {
  const out = buf(sec);
  const n = out.length;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * Math.pow(f1 / f0, i / n);
    ph = (ph + f / SR) % 1;
    out[i] = ph * 2 - 1;
  }
  return out;
}

export function tri(sec, f0, f1 = f0) {
  const s = saw(sec, f0, f1);
  for (let i = 0; i < s.length; i++) s[i] = 2 * Math.abs(s[i]) - 1;
  return s;
}

export function noise(sec, r) {
  const out = buf(sec);
  for (let i = 0; i < out.length; i++) out[i] = r() * 2 - 1;
  return out;
}

/** Pink-ish noise (Voss three-pole approximation — fine for beds/crowds). */
export function pink(sec, r) {
  const out = buf(sec);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return out;
}

// RBJ cookbook biquad.
function coeffs(type, f, q, sr = SR) {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lowpass") {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === "highpass") {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === "bandpass") {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === "notch") {
    b0 = 1; b1 = -2 * cw; b2 = 1;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else throw new Error(`unknown filter ${type}`);
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Filter in place. `f` may be [f0, f1] for an exponential sweep. */
export function filt(x, type, f, q = 0.707) {
  const sweep = Array.isArray(f);
  let c = coeffs(type, sweep ? f[0] : f, q);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    if (sweep && (i & 63) === 0) {
      c = coeffs(type, f[0] * Math.pow(f[1] / f[0], i / n), q);
    }
    const y = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

/** Multiply by a piecewise-linear envelope: points = [[sec, gain], ...]. */
export function env(x, points) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    while (p < points.length - 1 && points[p + 1][0] <= t) p++;
    const [t0, v0] = points[p];
    const [t1, v1] = points[Math.min(p + 1, points.length - 1)];
    const g = t1 <= t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    x[i] *= Math.max(0, g);
  }
  return x;
}

/** Gain (dB) in place. */
export function gain(x, d) {
  const g = db(d);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Sum layers, offset in seconds; output sized to the latest tail. */
export function mix(...layers) {
  let end = 0;
  for (const [x, at = 0] of layers) end = Math.max(end, secs(at) + x.length);
  const out = new Float32Array(end);
  for (const [x, at = 0, g = 1] of layers) {
    const o = secs(at);
    for (let i = 0; i < x.length; i++) out[o + i] += x[i] * g;
  }
  return out;
}

/** Amplitude modulation by an LFO-ish random walk (crowds shimmer). */
export function shimmer(x, r, rateHz = 8, depth = 0.5) {
  let v = 0, target = 0, k = 0;
  const step = Math.round(SR / rateHz);
  for (let i = 0; i < x.length; i++) {
    if (k-- <= 0) { target = r() * 2 - 1; k = step; }
    v += (target - v) / step;
    x[i] *= 1 - depth * (0.5 + 0.5 * v);
  }
  return x;
}

/** Schroeder-ish reverb: 4 combs + 1 allpass, mixed in at `wet`. */
export function verb(x, { time = 0.9, wet = 0.25, damp = 0.4, predelaySec = 0.01 } = {}) {
  const tail = secs(time);
  const out = new Float32Array(x.length + tail);
  out.set(x);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, buf: new Float32Array(d), i: 0, lp: 0 }));
  const fb = Math.pow(0.001, 1 / ((time * SR) / 1500)); // ~RT60-ish
  const pd = secs(predelaySec);
  const wetBuf = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const dry = i - pd >= 0 && i - pd < x.length ? x[i - pd] : 0;
    let sum = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * (1 - damp) + c.lp * damp;
      c.buf[c.i] = dry + c.lp * fb;
      c.i = (c.i + 1) % c.d;
      sum += y;
    }
    wetBuf[i] = sum * 0.25;
  }
  // one allpass
  const ap = { d: 225, buf: new Float32Array(225), i: 0 };
  for (let i = 0; i < out.length; i++) {
    const inp = wetBuf[i];
    const bufOut = ap.buf[ap.i];
    const y = -inp * 0.5 + bufOut;
    ap.buf[ap.i] = inp + bufOut * 0.5;
    ap.i = (ap.i + 1) % ap.d;
    out[i] += y * wet;
  }
  return out;
}

/** Max RMS over a sliding window (proxy for momentary loudness, dB). */
export function momentaryDb(x, windowSec = 0.4) {
  const w = Math.min(x.length, secs(windowSec));
  let sum = 0;
  for (let i = 0; i < w; i++) sum += x[i] * x[i];
  let max = sum;
  for (let i = w; i < x.length; i++) {
    sum += x[i] * x[i] - x[i - w] * x[i - w];
    if (sum > max) max = sum;
  }
  return 10 * Math.log10(Math.max(1e-12, max / w));
}

export function peakDb(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return 20 * Math.log10(Math.max(1e-12, p));
}

/**
 * Master to the SOUNDPLAN §2.2 family spec: scale so max-window RMS hits
 * `rmsDb`, then if the peak exceeds `peakDb` soft-limit (tanh) down to the
 * ceiling. Deterministic, no look-ahead pretensions — a one-shot mastering
 * pass whose output the measure script re-verifies from the encoded file.
 */
export function master(x, { rmsDb: target, peakDb: ceiling, windowSec = 0.4 }) {
  const cur = momentaryDb(x, windowSec);
  gain(x, target - cur);
  const p = peakDb(x);
  if (p > ceiling) {
    const c = db(ceiling);
    const drive = db(p) / c;
    const norm = Math.tanh(drive);
    for (let i = 0; i < x.length; i++) x[i] = (Math.tanh((x[i] / c) ) / norm) * c;
  }
  return x;
}

/** Short raised-cosine fade at both ends (declick). */
export function declick(x, sec = 0.004) {
  const n = Math.min(secs(sec), x.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

/** 16-bit PCM mono WAV. */
export function writeWav(path, x, sr = SR) {
  const n = x.length;
  const bytes = 44 + n * 2;
  const b = Buffer.alloc(bytes);
  b.write("RIFF", 0); b.writeUInt32LE(bytes - 8, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    b.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}
