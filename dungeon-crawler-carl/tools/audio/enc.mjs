// tools/audio/enc.mjs — render helper shared by the generator scripts:
// Float32 buffer -> temp WAV -> ffmpeg libvorbis OGG at the target path.
// Deterministic input; ffmpeg does the only lossy step, pinned by -q:a.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { writeWav } from "./lib.mjs";

/** Encode `samples` (mono 48k) to an OGG at `outPath` (q defaults to 4). */
export function renderOgg(outPath, samples, { q = 4 } = {}) {
  const tmp = join(tmpdir(), `dcc-gen-${process.pid}-${Math.random().toString(36).slice(2)}.wav`);
  writeWav(tmp, samples);
  mkdirSync(dirname(outPath), { recursive: true });
  // bitexact: without it the Ogg muxer randomizes the stream serial per run,
  // so a rerun of a DETERMINISTIC generator still byte-diffed (measured).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp,
    "-c:a", "libvorbis", "-q:a", String(q), "-fflags", "+bitexact", "-flags", "+bitexact", outPath]);
  rmSync(tmp, { force: true });
  console.log(`wrote ${outPath} (${samples.length} samples, ${(samples.length / 48000).toFixed(2)}s)`);
}
