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
//   battle_winter.ogg — WIRE COST, and a seam defect on top of it (HANDOFF
//                   §3d, perf-mobile opt8). 262.45s / 3.63MB of music for a
//                   bed the director drops after a 6s BATTLE_LINGER, streamed
//                   MID-FIGHT on the floors where BATTLE_TRACKS picks index 2
//                   (floor % 3 === 2 — so 2/5/8/11/14/17, NOT the floor-10
//                   scene the perf probes drive). Measured on the real wire:
//                   3,654,308 bytes fetched 12.9s into a floor-11 fight and
//                   the element buffered all 262.5s of it. The bed also loops
//                   over a 6s fade to digital silence: seamDelta 95.1dB, the
//                   worst in the whole music folder. Fix: keep one 64.0s
//                   window of the A section, seam-crossfaded. See the block.
//
// Crossfade-trim: y[i] = x[i]*fadeIn + x[n-W+i]*fadeOut for i<W, then
// y[i] = x[i] up to n-W. The loop's wrap lands on the blended head, so
// end→start is continuous by construction. Level-only + loop-surgery — no
// creative content added; both defects are in the CC0 sources, not our
// re-encode (verified r2). Rerun to reproduce byte-for-byte (bitexact mux).
//
// EACH BLOCK IS A SOURCE->OUTPUT TRANSFORM, NOT AN IDEMPOTENT REPAIR. The
// shipped files are the OUTPUTS; a bare rerun would trim collapse another
// -2.0dB and blend another 2s off safe_room's head. Pass bed names to run a
// subset (the battle_winter block additionally guards on duration).
//
// Usage: node tools/audio/fix-beds.mjs [collapse.ogg] [safe_room.ogg] [battle_winter.ogg]
//        (no args = all three, which is only correct against pristine sources)

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

/** Which beds this invocation should touch (no args = all of them). */
const only = new Set(process.argv.slice(2).map((a) => a.replace(/^.*[\\/]/, "")));
const want = (name) => only.size === 0 || only.has(name);

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
if (want("collapse.ogg")) {
  const f = join(MUSIC, "collapse.ogg");
  let x = decode(f);
  const g = db(-2.0);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  x = loopCrossfade(x, 0.025);
  encode(f, x, 4);
  console.log(`collapse.ogg: -2.0dB, 25ms seam crossfade, ${(x.length / CH / SR).toFixed(2)}s`);
}

// ---- safe_room.ogg: trim the fade-out tail, then 2s seam crossfade --------
if (want("safe_room.ogg")) {
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

// ---- battle_winter.ogg: 262.45s -> 64.0s window of the A section ----------
//
// WHY THESE NUMBERS, and not "cut it roughly in half":
//
//  * Tempo. Onset-envelope autocorrelation over the whole file peaks on a
//    0.2s grid with the strongest musical lags at 0.4 / 0.8 / 1.6s — a 150bpm
//    4/4 bar of 1.6s. Every offset below is an exact multiple of 1.6s, so no
//    cut lands inside a beat.
//  * Where. The 1s RMS envelope reads: 0-10s a quiet intro ramp (-27..-34dB),
//    10-79s the full-energy A section (-23..-29dB, no dropouts), 80-99s a
//    quieter B breakdown (-28..-31), and from 231s a 30s decay into digital
//    silence. Keeping a window wholly inside A avoids splicing across the
//    A/B level step, and drops the intro ramp and the fade — which is also
//    what kills the 95.1dB seam.
//  * How long. Macro autocorrelation of the 1s envelope peaks at multiples of
//    32s (96s .386, 64s .276, 32s .220), so 64.0s = 40 bars is a period the
//    track itself repeats on. It is also the "~1 min of bed is ample" the
//    handoff asked for: the director drops this bed 6s after the last blow.
//  * The crossfade is ONE BAR (1.6s), not the 2.0s safe_room uses. On a
//    rhythmic bed the blend length has to be a whole number of bars or the
//    overlaid copy arrives off the grid and smears every downbeat inside the
//    window; at exactly one bar the two copies are downbeat-aligned and the
//    transients stack instead of blurring.
//
// So: take source [12.8s, 78.4s) = 65.6s = 41 bars, then crossfade-trim one
// bar off the end into the head -> 64.0s = 40 bars, loop-continuous by
// construction. q=4 (~128kbps) is deliberately ABOVE the 113kbps source rate:
// this is a generational re-encode and the point is to lose nothing audible,
// not to bank another 60KB.
//
// NOT IDEMPOTENT — like the two blocks above, this is a source->output
// transform, so it guards on duration and skips a file that has already been
// cut. The 262.45s source is in git history (main@b7c15f3) and ASSETS.md.
if (want("battle_winter.ogg")) {
  const f = join(MUSIC, "battle_winter.ogg");
  let x = decode(f);
  const srcSec = x.length / CH / SR;
  if (srcSec < 100) {
    console.log(`battle_winter.ogg: already trimmed (${srcSec.toFixed(2)}s) — skipping; source is main@b7c15f3`);
  } else {
    const START = 12.8, SPAN = 65.6, FADE = 1.6; // seconds; all multiples of a 1.6s bar
    const a = Math.round(START * SR), b = Math.round((START + SPAN) * SR);
    x = x.slice(a * CH, b * CH);
    x = loopCrossfade(x, FADE);
    encode(f, x, 4);
    console.log(`battle_winter.ogg: kept [${START}s, ${(START + SPAN).toFixed(1)}s) of ${srcSec.toFixed(2)}s, ${FADE}s (1 bar) seam crossfade, ${(x.length / CH / SR).toFixed(2)}s`);
  }
}
