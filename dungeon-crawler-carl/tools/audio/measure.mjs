#!/usr/bin/env node
// tools/audio/measure.mjs — per-file measurement table (SOUNDPLAN §5).
// Decodes via ffmpeg and computes, from the ENCODED file (the thing that
// ships, not the pre-encode buffer):
//   peak dBFS, max windowed RMS (400ms momentary proxy, dB), duration,
//   silence share (10ms windows under -60dBFS), and for --loop files the
//   seam delta (RMS of last 50ms vs first 50ms) + seam transient check
//   (max |sample-to-sample delta| across the wrapped seam vs the file's own
//   p95 delta — a click at the seam is a number).
//
// Usage: node tools/audio/measure.mjs <file...>   (globs OK via shell)
//        --loop <file>  treat as loop (seam metrics)
//        --json         machine output

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const loopFlags = new Set();
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") continue;
  if (argv[i] === "--loop") { loopFlags.add(argv[++i]); files.push(argv[i]); continue; }
  files.push(argv[i]);
}
if (files.length === 0) {
  console.error("usage: node tools/audio/measure.mjs [--json] [--loop] <files...>");
  process.exit(2);
}

const SR = 48000;
function decode(file) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
}

const dbf = (v) => 20 * Math.log10(Math.max(1e-12, v));
const rows = [];
for (const file of files) {
  const x = decode(file);
  const n = x.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  // momentary proxy: max 400ms RMS
  const w = Math.min(n, Math.round(0.4 * SR));
  let sum = 0;
  for (let i = 0; i < w; i++) sum += x[i] * x[i];
  let maxSum = sum;
  for (let i = w; i < n; i++) {
    sum += x[i] * x[i] - x[i - w] * x[i - w];
    if (sum > maxSum) maxSum = sum;
  }
  const mom = 10 * Math.log10(Math.max(1e-12, maxSum / w));
  // silence share: 10ms windows under -60 dBFS RMS
  const sw = Math.round(0.01 * SR);
  let silent = 0, windows = 0;
  for (let o = 0; o + sw <= n; o += sw) {
    let s = 0;
    for (let i = o; i < o + sw; i++) s += x[i] * x[i];
    windows++;
    if (10 * Math.log10(Math.max(1e-12, s / sw)) < -60) silent++;
  }
  const row = {
    file: file.replace(/\\/g, "/").replace(/^.*public\/audio\//, ""),
    sec: Number((n / SR).toFixed(2)),
    kb: Math.round(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=size", "-of", "csv=p=0", file]).toString().trim() / 1024),
    peakDb: Number(dbf(peak).toFixed(1)),
    momDb: Number(mom.toFixed(1)),
    silencePct: Math.round((100 * silent) / Math.max(1, windows)),
  };
  if (loopFlags.has(file)) {
    const seamW = Math.round(0.05 * SR);
    const rms = (o) => {
      let s = 0;
      for (let i = o; i < o + seamW; i++) s += x[i] * x[i];
      return 10 * Math.log10(Math.max(1e-12, s / seamW));
    };
    row.seamDeltaDb = Number(Math.abs(rms(0) - rms(n - seamW)).toFixed(1));
    // wrapped transient: |x[0]-x[n-1]| vs p95 of |dx| in the body
    const deltas = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) {
      const j = 1 + Math.floor((i / 4096) * (n - 2));
      deltas[i] = Math.abs(x[j] - x[j - 1]);
    }
    deltas.sort();
    const p95 = deltas[Math.floor(4096 * 0.95)];
    row.seamJump = Number(Math.abs(x[0] - x[n - 1]).toFixed(4));
    row.bodyP95 = Number(p95.toFixed(4));
    row.seamClick = row.seamJump > p95;
  }
  rows.push(row);
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const cols = ["file", "sec", "kb", "peakDb", "momDb", "silencePct", "seamDeltaDb", "seamClick"];
  console.log(cols.join(" | "));
  console.log(cols.map(() => "---").join(" | "));
  for (const r of rows) console.log(cols.map((c) => r[c] ?? "").join(" | "));
}
