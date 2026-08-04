#!/usr/bin/env node
// tools/audio/fix-beds.mjs — deterministic loop-seam + true-peak repair for
// the two inherited CC0 beds whose defects the SFX r2 critic measured
// (SOUNDPLAN §5: a click at the seam is a number, not an opinion):
//
//   collapse.ogg  — seam click (end→start jump above the body's p95 delta)
//                   and +0.52 dBTP true peak. Fix: -2.0dB trim + a short
//                   25ms equal-power crossfade-trim at the loop point.
//   safe_room.ogg — the source track FADES OUT, so every loop restart steps
//                   20.7dB (last-50ms vs first-50ms RMS). Fix: trim the tail
//                   back to body level, then a 2s equal-power crossfade-trim
//                   (it's an ambient pad — a long blend is inaudible).
//
// Crossfade-trim: y[i] = x[i]*fadeIn + x[n-W+i]*fadeOut for i<W, then
// y[i] = x[i] up to n-W. The loop's wrap lands on the blended head, so
// end→start is continuous by construction. Level-only + loop-surgery — no
// creative content added; both defects are in the CC0 sources, not our
// re-encode (verified r2). Rerun to reproduce byte-for-byte (bitexact mux).
//
// Usage: node tools/audio/fix-beds.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SR = 48000;
const CH = 2;
const MUSIC = new URL("../../public/audio/music/", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");

function decode(file) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
    "-ar", String(SR), "-ac", String(CH), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2); // interleaved LR
}

function encode(file, x, q) {
  // Interleaved f32 -> WAV(f32) via raw pipe file, then libvorbis.
  const tmp = join(tmpdir(), `dcc-bed-${process.pid}.f32`);
  writeFileSync(tmp, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "f32le", "-ar", String(SR), "-ac", String(CH), "-i", tmp,
    "-c:a", "libvorbis", "-q:a", String(q), "-fflags", "+bitexact", "-flags", "+bitexact", file]);
  rmSync(tmp, { force: true });
}

const db = (d) => Math.pow(10, d / 20);

/** Equal-power crossfade-trim of the last W frames into the first W. */
function loopCrossfade(x, wSec) {
  const W = Math.round(wSec * SR);
  const nFrames = x.length / CH;
  const out = new Float32Array((nFrames - W) * CH);
  for (let i = 0; i < W; i++) {
    const t = i / W;
    const gIn = Math.sin((t * Math.PI) / 2);
    const gOut = Math.cos((t * Math.PI) / 2);
    for (let c = 0; c < CH; c++) {
      out[i * CH + c] = x[i * CH + c] * gIn + x[(nFrames - W + i) * CH + c] * gOut;
    }
  }
  out.set(x.subarray(W * CH, (nFrames - W) * CH), W * CH);
  return out;
}

/** Mono 50ms-window RMS series (dB) over interleaved stereo. */
function rmsSeries(x) {
  const W = Math.round(0.05 * SR);
  const nFrames = x.length / CH;
  const out = [];
  for (let o = 0; o + W <= nFrames; o += W) {
    let s = 0;
    for (let i = o; i < o + W; i++) {
      const m = (x[i * CH] + x[i * CH + 1]) * 0.5;
      s += m * m;
    }
    out.push(10 * Math.log10(Math.max(1e-12, s / W)));
  }
  return out;
}

// ---- collapse.ogg: -2.0dB trim (TP +0.52 -> ~-1.5) + 25ms seam crossfade --
{
  const f = join(MUSIC, "collapse.ogg");
  let x = decode(f);
  const g = db(-2.0);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  x = loopCrossfade(x, 0.025);
  encode(f, x, 4);
  console.log(`collapse.ogg: -2.0dB, 25ms seam crossfade, ${(x.length / CH / SR).toFixed(2)}s`);
}

// ---- safe_room.ogg: trim the fade-out tail, then 2s seam crossfade --------
{
  const f = join(MUSIC, "safe_room.ogg");
  let x = decode(f);
  const series = rmsSeries(x); // 50ms windows
  const body = [...series.slice(Math.floor(series.length * 0.25), Math.floor(series.length * 0.75))].sort((a, b) => a - b);
  const median = body[body.length >> 1];
  let lastGood = series.length - 1;
  while (lastGood > 0 && series[lastGood] < median - 6) lastGood--;
  const keepFrames = Math.min(x.length / CH, (lastGood + 1) * Math.round(0.05 * SR));
  x = x.subarray(0, keepFrames * CH);
  x = loopCrossfade(x, 2.0);
  encode(f, x, 3);
  console.log(`safe_room.ogg: trimmed fade tail (body median ${median.toFixed(1)}dB, kept ${(keepFrames / SR).toFixed(2)}s), 2s seam crossfade, ${(x.length / CH / SR).toFixed(2)}s`);
}
