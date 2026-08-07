#!/usr/bin/env node
// tools/audio/fix-beds.mjs — deterministic loop-seam + true-peak repair for
// inherited CC0/CC-BY beds whose defects were measured (SOUNDPLAN §5: a click
// at the seam is a number, not an opinion):
//
//   collapse      — seam click (end→start jump above the body's p95 delta)
//                   and +0.52 dBTP true peak. Fix: -2.0dB trim + a short
//                   25ms equal-power crossfade-trim at the loop point.
//                   APPLIED in SFX r2.
//   safe_room     — the source track FADES OUT, so every loop restart steps
//                   20.7dB (last-50ms vs first-50ms RMS). Fix: trim the tail
//                   back to body level, then a 2s equal-power crossfade-trim
//                   (it's an ambient pad — a long blend is inaudible).
//                   APPLIED in SFX r2.
//   battle_winter — 262.45s / 3.7MB for a bed the director drops after a ~6s
//                   BATTLE_LINGER: a mid-fight fetch stall on a phone
//                   (HANDOFF §3d — wire cost, not memory; music streams).
//                   Measured on the real wire by the perf round: 3,654,308
//                   bytes fetched 12.9s into a floor-11 fight (BATTLE_TRACKS
//                   picks this bed where floor % 3 === 2, i.e. 2/5/8/11/14/17
//                   — NOT the floor-10 scene the perf probes drive) and the
//                   element buffered all 262.5s of it. The source also loops
//                   over a 6s fade to digital silence: seamDelta 95.1dB, the
//                   worst in the whole music folder.
//                   Fix: trim to the best loop cut in 60–90s, chosen by a
//                   deterministic head-similarity search (envelope correlation
//                   of what FOLLOWS the cut in the source vs what the loop
//                   will actually deliver — the head), then a 1.2s equal-power
//                   crossfade-trim (two beats at the track's ~100 BPM). The
//                   SHIPPED output is that search's: 88.40s / 1.18MB, seam
//                   measured at 0.8dB (measure.mjs --loop), no click.
//
// Crossfade-trim: y[i] = x[i]*fadeIn + x[n-W+i]*fadeOut for i<W, then
// y[i] = x[i] up to n-W. The loop's wrap lands on the blended head, so
// end→start is continuous by construction. Level-only + loop-surgery — no
// creative content added.
//
// EACH TASK IS ONE-SHOT against the PRE-FIX file. Re-running a task on a file
// it already fixed double-applies the surgery (collapse would lose another
// 2dB; battle_winter would fold its trimmed tail again). That is why tasks
// must be named explicitly — there is no "run everything" default. The
// pre-fix sources are in git history (battle_winter's 262.45s master is at
// main@b7c15f3) and in ASSETS.md.
//
// Usage: node tools/audio/fix-beds.mjs <task...>   tasks: collapse safe_room battle_winter

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, statSync } from "node:fs";
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

const TASKS = {
  // ---- collapse: -2.0dB trim (TP +0.52 -> ~-1.5) + 25ms seam crossfade ----
  collapse() {
    const f = join(MUSIC, "collapse.ogg");
    let x = decode(f);
    const g = db(-2.0);
    for (let i = 0; i < x.length; i++) x[i] *= g;
    x = loopCrossfade(x, 0.025);
    encode(f, x, 4);
    console.log(`collapse.ogg: -2.0dB, 25ms seam crossfade, ${(x.length / CH / SR).toFixed(2)}s`);
  },

  // ---- safe_room: trim the fade-out tail, then 2s seam crossfade ----------
  safe_room() {
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
  },

  // ---- battle_winter: trim 262s -> best loop cut in 60-90s ----------------
  // The cut L is CHOSEN BY MEASUREMENT, not by ear (nobody here has one): for
  // each candidate L the score is the Pearson correlation between the 10ms
  // mono RMS envelope of [L, L+4s] in the source (the continuation a listener
  // would expect) and [0, 4s] (the continuation the loop actually delivers),
  // minus a penalty for the level step across the crossfade window. The
  // measured-seam guarantee itself comes from loopCrossfade — the wrap lands
  // on the blended head and is continuous by construction — so the search is
  // only deciding WHERE the fold is least of a non-sequitur, and the final
  // seam numbers come from measure.mjs --loop, not from this score.
  battle_winter() {
    const f = join(MUSIC, "battle_winter.ogg");
    const before = statSync(f).size;
    const x = decode(f);
    const nFrames = x.length / CH;

    // 10ms mono RMS envelope
    const h = Math.round(0.01 * SR);
    const env = [];
    for (let o = 0; o + h <= nFrames; o += h) {
      let s = 0;
      for (let i = o; i < o + h; i++) {
        const m = (x[i * CH] + x[i * CH + 1]) * 0.5;
        s += m * m;
      }
      env.push(Math.sqrt(s / h));
    }
    const dbv = (v) => 20 * Math.log10(Math.max(1e-6, v));
    const seg = (tSec, lenSec) => env.slice(Math.round(tSec * 100), Math.round(tSec * 100) + Math.round(lenSec * 100));
    const stats = (a) => {
      const mu = a.reduce((p, c) => p + c, 0) / a.length;
      const sd = Math.sqrt(a.reduce((p, c) => p + (c - mu) ** 2, 0) / a.length) || 1e-9;
      return { mu, sd };
    };

    const CTX = 4.0; // seconds of continuation compared
    const XF = 1.2;  // crossfade: two beats at the track's ~100 BPM
    const head = seg(0, CTX);
    const hs = stats(head);
    const headXf = stats(seg(0, XF));

    let best = null;
    for (let L = 60; L <= 90; L = +(L + 0.05).toFixed(2)) {
      const c = seg(L, CTX);
      if (c.length < head.length) break;
      const cs = stats(c);
      let r = 0;
      for (let i = 0; i < head.length; i++) r += ((head[i] - hs.mu) / hs.sd) * ((c[i] - cs.mu) / cs.sd);
      r /= head.length;
      const tailXf = stats(seg(L - XF, XF));
      const lvlDiff = Math.abs(dbv(tailXf.mu) - dbv(headXf.mu));
      const score = r - 0.03 * lvlDiff;
      if (!best || score > best.score) best = { L, r, lvlDiff, score };
    }

    let y = x.subarray(0, Math.round(best.L * SR) * CH);
    y = loopCrossfade(y, XF);
    encode(f, y, 4);
    const after = statSync(f).size;
    console.log(
      `battle_winter.ogg: ${(nFrames / SR).toFixed(2)}s -> ${(y.length / CH / SR).toFixed(2)}s ` +
      `(cut at ${best.L.toFixed(2)}s, continuation corr ${best.r.toFixed(3)}, ` +
      `xfade level step ${best.lvlDiff.toFixed(1)}dB, ${XF}s crossfade), ` +
      `${(before / 1048576).toFixed(2)}MB -> ${(after / 1048576).toFixed(2)}MB`,
    );
  },
};

const names = process.argv.slice(2);
if (names.length === 0 || names.some((n) => !TASKS[n])) {
  console.error(`usage: node tools/audio/fix-beds.mjs <task...>   tasks: ${Object.keys(TASKS).join(" ")}`);
  console.error("each task is ONE-SHOT against the pre-fix file — re-running double-applies it");
  process.exit(2);
}
for (const n of names) TASKS[n]();
