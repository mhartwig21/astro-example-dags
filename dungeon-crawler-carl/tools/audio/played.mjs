#!/usr/bin/env node
// tools/audio/played.mjs — AS PLAYED, not as encoded.
//
// Why this exists. Every loudness number the audio track has ever quoted came
// out of measure.mjs, which reads the ENCODED FILE. But the engine does not
// play the file; it plays the file times the manifest volume:
//
//     engine.ts play():  gain.gain.value = (def.volume ?? 1) * opts.gain
//
// So a clip mastered exactly to its §2.2 family target can still land 5dB
// under it in the game, and the two most load-bearing sentences in §2.2 —
// "ability casts sit 2dB UNDER impacts" and "an ultimate IS an event" — are
// claims about the SPEAKER, not about the file. The r2 critics measured the
// shipped mix and found the invariant inverted: with the volumes that round
// set, pressing dash was LOUDER than the hit it caused.
//
// This script closes that gap. It parses the manifest (ids, urls, buses,
// volumes), decodes every file, and prints:
//
//     momDb        max 400ms windowed RMS of the file  (what measure.mjs says)
//     vol          the manifest volume the engine multiplies by
//     playedDb     momDb + 20log10(vol)                (what the player hears)
//     hp250Db      the same, through a 250Hz highpass  (what a laptop hears)
//
// It also fails loudly if any manifest url does not resolve to a file on
// disk — a typo'd url ships as a silent cue and no other instrument notices.
//
// Usage: node tools/audio/played.mjs [--json] [--bus sfx] [--grep cast_]
//
// The ordering assertions live in test/audio.test.ts, which reads the same
// manifest; this script is how you get the NUMBERS to put in SOUNDPLAN §2.2.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const busFilter = argv.includes("--bus") ? argv[argv.indexOf("--bus") + 1] : null;
const grep = argv.includes("--grep") ? argv[argv.indexOf("--grep") + 1] : null;

const ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const SR = 48000;

// ---- manifest parse -------------------------------------------------------
// A regex rather than a TS import on purpose: this is a node script with no
// build step, and the manifest's shape (one entry per line, url first) is
// enforced by test/audio.test.ts. If the shape ever changes, the count check
// below fails loudly instead of silently measuring half the game.
const src = readFileSync(resolve(ROOT, "src/audio/manifest.ts"), "utf8");
const ENTRY = /^\s{2}(\w+): \{ url: "([^"]+)", bus: "(\w+)"(?:, volume: ([\d.]+))?/gm;
const entries = [];
for (const m of src.matchAll(ENTRY)) {
  entries.push({ id: m[1], url: m[2], bus: m[3], vol: m[4] === undefined ? 1 : Number(m[4]) });
}
const declared = (src.match(/^\s{2}\w+: \{ url: "/gm) ?? []).length;
if (entries.length !== declared) {
  console.error(`manifest parse mismatch: matched ${entries.length} of ${declared} url lines`);
  process.exit(2);
}

// ---- missing-file gate ----------------------------------------------------
const missing = entries.filter((e) => !existsSync(resolve(ROOT, "public" + e.url)));
if (missing.length) {
  console.error("MANIFEST URLS THAT DO NOT RESOLVE:");
  for (const e of missing) console.error(`  ${e.id}  ${e.url}`);
  process.exit(1);
}

// ---- measurement ----------------------------------------------------------
// Same decode contract as measure.mjs / contactsheet.mjs: the file's own
// channel count, mixed 0.5/0.5 (ffmpeg's -ac 1 uses 0.707 and inflates peaks
// by up to 3dB on correlated stereo).
function decode(file) {
  const ch = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=channels", "-of", "csv=p=0", file]).toString().trim()) || 1;
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
    "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  const n = Math.floor(inter.length / ch);
  const mono = new Float32Array(n);
  let chPeak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) { const v = inter[i * ch + c]; s += v; if (Math.abs(v) > chPeak) chPeak = Math.abs(v); }
    mono[i] = s / ch;
  }
  return { mono, chPeak };
}

/** Two cascaded RBJ highpasses ≈ 24dB/oct: the laptop/phone stand-in. */
function highpassed(x, f = 250) {
  const y = Float32Array.from(x);
  const w = (2 * Math.PI * f) / SR, cw = Math.cos(w), alpha = Math.sin(w) / (2 * 0.707);
  const a0 = 1 + alpha;
  const c = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = c[0] * y[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v;
      y[i] = v;
    }
  }
  return y;
}

function momDb(x) {
  const n = x.length;
  const w = Math.min(n, Math.round(0.4 * SR));
  let s = 0;
  for (let i = 0; i < w; i++) s += x[i] * x[i];
  let max = s;
  for (let i = w; i < n; i++) { s += x[i] * x[i] - x[i - w] * x[i - w]; if (s > max) max = s; }
  return 10 * Math.log10(Math.max(1e-12, max / Math.max(1, w)));
}

const rows = [];
for (const e of entries) {
  if (busFilter && e.bus !== busFilter) continue;
  if (grep && !e.id.includes(grep)) continue;
  const { mono, chPeak } = decode(resolve(ROOT, "public" + e.url));
  const m = momDb(mono);
  const h = momDb(highpassed(mono));
  const g = 20 * Math.log10(Math.max(1e-6, e.vol));
  rows.push({
    id: e.id, bus: e.bus, vol: e.vol,
    peakDb: +(20 * Math.log10(Math.max(1e-12, chPeak))).toFixed(1),
    momDb: +m.toFixed(1),
    playedDb: +(m + g).toFixed(1),
    hp250PlayedDb: +(h + g).toFixed(1),
  });
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const COLS = ["id", "bus", "vol", "peakDb", "momDb", "playedDb", "hp250PlayedDb"];
  const w = COLS.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cs) => cs.map((v, i) => String(v).padEnd(w[i])).join("  ");
  console.log(line(COLS));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(COLS.map((c) => r[c])));
  console.log(`\n${rows.length} entries measured; all ${entries.length} manifest urls resolve.`);
}
