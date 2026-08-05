#!/usr/bin/env node
// tools/audio/contactsheet.mjs — THE EYE. Nobody in this loop can hear, so
// every sound in this repo is judged by a number (measure.mjs) or by an
// event (probe.mjs). This is the third instrument: it turns a set of clips
// into PICTURES an agent can actually Read, plus the descriptor table and
// the pairwise distance matrix that answer the only question a family of
// new cues has to answer — "are these thirteen sounds, or one sound
// thirteen times?"
//
// What it makes, per clip, under <out>/<name>/:
//   spec_<id>.png    spectrogram  (640x260, log freq, combined channels)
//   wave_<id>.png    waveform     (640x120 — envelope, attack, decay)
//   panel_NN.png     caption + spectrogram + waveform, one clip
//   sheet_N.png      up to 9 panels tiled 3-across — READ THESE
//
// and, on stdout:
//   DESCRIPTOR TABLE   duration, peak, RMS, crest, attack time, spectral
//                      centroid / rolloff85 / flatness, dominant 3 octave
//                      bands — all computed from the DECODED samples of the
//                      ENCODED file (the thing that ships), like measure.mjs.
//   DISTINCTNESS       z-scored descriptor vectors, Euclidean distance
//                      between every pair, nearest neighbour per clip, and
//                      every pair under the flag threshold.
//
// HONEST LIMIT, stated in the tool because the report will repeat it: a
// spectrogram shows SHAPE, BRIGHTNESS and ENVELOPE. It cannot show whether
// a sound is good, whether it reads as the thing it depicts, or whether it
// is annoying on the four-hundredth cast. Distinct-on-this-matrix is a
// necessary condition for "thirteen different sounds", never a sufficient
// one. The owner's ear remains the acceptance (SOUNDPLAN §5).
//
// Usage:
//   node tools/audio/contactsheet.mjs --name casts public/audio/sfx/cast_*.ogg
//   node tools/audio/contactsheet.mjs --name ref --cols 3 --json <files...>
//
// Options: --name <slug>  subdirectory + sheet prefix (default "set")
//          --out <dir>    root output dir (default tools/audio/_r2_sheets)
//          --cols N       panels per sheet row (default 3; 3x3 = 9/sheet)
//          --rows N       panel rows per sheet (default 3)
//          --threshold X  absolute distance flag; default is adaptive (0.45x
//                         the family's own mean pairwise distance)
//          --json         also write <name>/descriptors.json
//          --no-images    numbers only — skip the PNGs. A full 13-clip run
//                         emits ~10MB of spectrograms, which is the wrong
//                         cost to pay on the twentieth iteration of a mix
//                         tweak. Read the sheets once the numbers converge.

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const files = [];
let name = "set";
let outRoot = resolve(new URL("./_r2_sheets", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
let cols = 3, rows = 3, wantJson = false, absThreshold = null, images = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--name") name = argv[++i];
  else if (a === "--out") outRoot = resolve(argv[++i]);
  else if (a === "--cols") cols = Number(argv[++i]);
  else if (a === "--rows") rows = Number(argv[++i]);
  else if (a === "--threshold") absThreshold = Number(argv[++i]);
  else if (a === "--json") wantJson = true;
  else if (a === "--no-images") images = false;
  else files.push(a);
}
if (files.length === 0) {
  console.error("usage: node tools/audio/contactsheet.mjs [--name slug] [--out dir] [--cols 3] [--rows 3] [--json] <files...>");
  process.exit(2);
}
const OUT = join(outRoot, name);
mkdirSync(OUT, { recursive: true });

const SR = 48000;
const ff = (args) => execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 1 << 30 });

// A drawtext fontfile beats fontconfig-by-name on this box (and the caption
// is the only thing making a 9-up sheet readable, so it must not fail soft).
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/consola.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/System/Library/Fonts/Menlo.ttc",
];
const font = FONT_CANDIDATES.find((f) => existsSync(f));
// In a filtergraph ':' separates options, so a Windows drive letter must be
// BOTH quoted and escaped — `fontfile=C\:/...` alone parses as "no option
// name near /Windows/..." on ffmpeg 8, and `font=Consolas` (fontconfig
// lookup) segfaults on this box. Measured, both of them.
const fontOpt = font ? `fontfile='${font.replace(/:/g, "\\:")}'` : "font=monospace";

// ------------------------------------------------------------- decoding ---
// Same contract as measure.mjs: decode at the file's own channel count and
// mix down 0.5/0.5 (ffmpeg's -ac 1 uses 0.707 and inflates peaks by up to
// 3dB on correlated stereo); peak is judged across real channels.
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
    for (let c = 0; c < ch; c++) {
      const v = inter[i * ch + c];
      s += v;
      const a = Math.abs(v);
      if (a > chPeak) chPeak = a;
    }
    mono[i] = s / ch;
  }
  return { mono, chPeak };
}

// ------------------------------------------------------------------ FFT ---
/** In-place iterative radix-2 Cooley-Tukey. re/im length must be a power of 2. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const N = 2048, HOP = 512;
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

/**
 * Energy-weighted average power spectrum over the file. Weighting by frame
 * energy is the point: a 220ms whoosh followed by 40ms of near-silence must
 * not have its brightness dragged toward the noise floor of its own tail.
 */
function avgSpectrum(x) {
  const half = N / 2;
  const acc = new Float64Array(half);
  let totalW = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let o = 0; o + N <= x.length; o += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i] * hann[i]; re[i] = v; im[i] = 0; e += v * v; }
    if (e <= 1e-12) continue;
    fft(re, im);
    // Summing raw power IS the energy weighting: a loud frame contributes a
    // proportionally bigger spectrum than a quiet tail frame.
    for (let k = 0; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    totalW += e;
  }
  if (totalW === 0) { // file shorter than one window, or silent: single padded frame
    for (let i = 0; i < N; i++) { const v = (i < x.length ? x[i] : 0) * hann[i]; re[i] = v; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) acc[k] = re[k] * re[k] + im[k] * im[k];
  }
  return acc;
}

const OCT = [
  ["63", 45, 90], ["125", 90, 180], ["250", 180, 355], ["500", 355, 710],
  ["1k", 710, 1400], ["2k", 1400, 2800], ["4k", 2800, 5600],
  ["8k", 5600, 11200], ["16k", 11200, 22000],
];

/**
 * THE SMALL-SPEAKER AXIS (added after the r2 critics: a family claimed to be
 * level-matched to ±1.5dB measured a 21dB spread once its bass was gone).
 * Two cascaded RBJ highpasses at 250Hz ≈ 24dB/oct — a deliberately brutal
 * stand-in for a laptop or phone driver, which simply does not move air below
 * ~250Hz. A clip carrying 90% of its energy at 125Hz loses most of itself
 * here, and that is the point: `hp250` is what the majority of players
 * actually hear, so it is measured rather than assumed.
 */
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

function descriptors(id, file) {
  const { mono: x, chPeak } = decode(file);
  const n = x.length;
  const dbf = (v) => 20 * Math.log10(Math.max(1e-12, v));

  let sum = 0, peakIdx = 0, peakAbs = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    sum += x[i] * x[i];
    if (a > peakAbs) { peakAbs = a; peakIdx = i; }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const peakDb = dbf(chPeak);
  const rmsDb = dbf(rms);
  const crestDb = peakDb - rmsDb;
  // momDb = max 400ms windowed RMS — measure.mjs's number, and the one the
  // §2.2 family targets are written against. Printed next to whole-file RMS
  // because on a 1.1s ultimate the two differ by 2-3dB, and reading the
  // whole-file number against a family target invents a compliance failure.
  const wN = Math.min(n, Math.round(0.4 * SR));
  let ws = 0;
  for (let i = 0; i < wN; i++) ws += x[i] * x[i];
  let wMax = ws;
  for (let i = wN; i < n; i++) { ws += x[i] * x[i] - x[i - wN] * x[i - wN]; if (ws > wMax) wMax = ws; }
  const momDb = 10 * Math.log10(Math.max(1e-12, wMax / Math.max(1, wN)));
  // ATTACK: file start -> the peak sample. Reported alongside t10, the first
  // crossing of 10% of peak, because "0 to peak" on a two-transient clip
  // (cutto, cables) can point at the SECOND transient — t10 says where the
  // clip actually begins to speak.
  const attackMs = (peakIdx / SR) * 1000;
  let t10 = 0;
  for (let i = 0; i < n; i++) if (Math.abs(x[i]) >= 0.1 * peakAbs) { t10 = (i / SR) * 1000; break; }

  const P = avgSpectrum(x);
  const half = P.length;
  const binHz = SR / N;
  // Centroid and rolloff use the MAGNITUDE spectrum (the textbook
  // definition); band shares and flatness use POWER. Mixing those up moves
  // the centroid by an octave on a low-heavy clip, which is exactly the
  // number the briefs argue about — so it is spelled out here.
  const M = new Float64Array(half);
  for (let k = 0; k < half; k++) M[k] = Math.sqrt(P[k]);
  let pTot = 0, mTot = 0, fSum = 0;
  for (let k = 1; k < half; k++) { pTot += P[k]; mTot += M[k]; fSum += M[k] * k * binHz; }
  const centroid = mTot > 0 ? fSum / mTot : 0;
  let acc = 0, rolloff = 0;
  for (let k = 1; k < half; k++) { acc += M[k]; if (acc >= 0.85 * mTot) { rolloff = k * binHz; break; } }
  let lnSum = 0, arSum = 0, cnt = 0;
  for (let k = 1; k < half; k++) { lnSum += Math.log(P[k] + 1e-20); arSum += P[k]; cnt++; }
  const flatness = Math.exp(lnSum / cnt) / (arSum / cnt);

  const bands = OCT.map(([label, lo, hi]) => {
    let e = 0;
    for (let k = 1; k < half; k++) { const f = k * binHz; if (f >= lo && f < hi) e += P[k]; }
    return { label, share: pTot > 0 ? e / pTot : 0 };
  });
  const top3 = [...bands].sort((a, b) => b.share - a.share).slice(0, 3);
  let lowShare = 0;
  for (let k = 1; k < half; k++) if (k * binHz < 500) lowShare += P[k];
  lowShare = pTot > 0 ? lowShare / pTot : 0;

  // hp250: the same momentary window, on the highpassed copy. The DELTA
  // (momDb - hp250MomDb) is the number that matters — how much of this clip
  // exists only on a subwoofer.
  const hx = highpassed(x);
  let hws = 0;
  for (let i = 0; i < wN; i++) hws += hx[i] * hx[i];
  let hwMax = hws;
  for (let i = wN; i < n; i++) { hws += hx[i] * hx[i] - hx[i - wN] * hx[i - wN]; if (hws > hwMax) hwMax = hws; }
  const hp250MomDb = 10 * Math.log10(Math.max(1e-12, hwMax / Math.max(1, wN)));

  return {
    id, file,
    sec: +(n / SR).toFixed(3),
    peakDb: +peakDb.toFixed(1),
    rmsDb: +rmsDb.toFixed(1),
    momDb: +momDb.toFixed(1),
    hp250MomDb: +hp250MomDb.toFixed(1),
    hp250LossDb: +(momDb - hp250MomDb).toFixed(1),
    crestDb: +crestDb.toFixed(1),
    attackMs: +attackMs.toFixed(1),
    t10Ms: +t10.toFixed(1),
    centroidHz: Math.round(centroid),
    rolloff85Hz: Math.round(rolloff),
    // 3 significant figures, not 4 decimals: a tonal one-shot lands at
    // 1e-4..1e-3 and toFixed(4) printed every one of them as "0".
    flatness: +flatness.toPrecision(3),
    lowShare: +lowShare.toFixed(3),
    top3: top3.map((b) => `${b.label}(${Math.round(b.share * 100)}%)`).join(" "),
    bands: Object.fromEntries(bands.map((b) => [b.label, +(b.share * 100).toFixed(1)])),
  };
}

// ---------------------------------------------------------------- images --
function renderImages(d, i) {
  const spec = join(OUT, `spec_${d.id}.png`);
  const wave = join(OUT, `wave_${d.id}.png`);
  ff(["-i", d.file, "-lavfi", "showspectrumpic=s=640x260:mode=combined:legend=0:scale=log", "-y", spec]);
  ff(["-i", d.file, "-lavfi", "showwavespic=s=640x120:colors=cyan", "-y", wave]);

  // caption strip: id + the numbers that explain the picture under it.
  const l1 = `${d.id}   ${d.sec.toFixed(2)}s   peak ${d.peakDb}   rms ${d.rmsDb}   mom ${d.momDb}   crest ${d.crestDb} dB`;
  // The band shares lose their "%" here: drawtext expands %{...} and no
  // amount of escaping survives both parser levels on this build (measured
  // — \% and \\% both warn "Stray %" and eat the character), so the caption
  // says "125(90)" and the header below says the unit once.
  const l2 = `atk ${d.attackMs}ms (t10 ${d.t10Ms}ms)   centroid ${d.centroidHz}Hz   roll85 ${d.rolloff85Hz}Hz   flat ${d.flatness}   bands pct ${d.top3.replace(/%/g, "")}`;
  // drawtext expands %{...}, so a bare % in "125(90%)" warns "Stray %" and
  // eats the character. Escape it, the colon (option separator) and quotes.
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/%/g, "\\%").replace(/'/g, "");
  const panel = join(OUT, `panel_${String(i + 1).padStart(2, "0")}.png`);
  ff([
    "-f", "lavfi", "-i", "color=c=0x101018:s=640x46",
    "-i", spec, "-i", wave,
    "-lavfi",
    `[0:v]drawtext=${fontOpt}:text='${esc(l1)}':fontcolor=0xffe08a:fontsize=17:x=6:y=4,` +
    `drawtext=${fontOpt}:text='${esc(l2)}':fontcolor=0x9fd4ff:fontsize=13:x=6:y=27[cap];` +
    `[cap][1:v][2:v]vstack=inputs=3,pad=w=iw+10:h=ih+10:x=5:y=5:color=0x2a2a34`,
    "-frames:v", "1", "-y", panel,
  ]);
  return { spec, wave, panel };
}

function renderSheets(count) {
  const per = cols * rows;
  const sheets = [];
  for (let s = 0; s * per < count; s++) {
    const sheet = join(OUT, `sheet_${name}_${s + 1}.png`);
    ff([
      "-start_number", String(s * per + 1),
      "-i", join(OUT, "panel_%02d.png"),
      "-lavfi", `tile=${cols}x${rows}:margin=10:padding=10:color=0x07070b`,
      "-frames:v", "1", "-y", sheet,
    ]);
    sheets.push(sheet);
  }
  return sheets;
}

// --------------------------------------------------------------- run it ---
const ds = [];
for (const f of files) {
  const file = resolve(f);
  if (!existsSync(file)) { console.error(`missing: ${file}`); process.exit(2); }
  ds.push(descriptors(basename(file).replace(/\.[^.]+$/, ""), file));
}
let sheets = [];
if (images) {
  ds.forEach((d, i) => renderImages(d, i));
  sheets = renderSheets(ds.length);
}

// DESCRIPTOR TABLE
const COLS = ["id", "sec", "peakDb", "rmsDb", "momDb", "hp250MomDb", "hp250LossDb", "crestDb", "attackMs", "t10Ms", "centroidHz", "rolloff85Hz", "flatness", "top3"];
const w = COLS.map((c) => Math.max(c.length, ...ds.map((d) => String(d[c]).length)));
const line = (cells) => cells.map((v, i) => String(v).padEnd(w[i])).join("  ");
console.log(`\n=== DESCRIPTORS — ${name} (${ds.length} clips) ===`);
console.log(line(COLS));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const d of ds) console.log(line(COLS.map((c) => d[c])));

// DISTINCTNESS MATRIX
// The vector: 7 dimensions a spectrogram can actually see. Durations,
// attacks and frequencies go in as log10 because hearing them is
// ratio-shaped (a 20ms vs 40ms attack is the same "step" as 200 vs 400).
// rmsDb is deliberately EXCLUDED: every clip was mastered to a family target
// (§2.2), so loudness encodes which table row it is, not what it sounds like.
const DIMS = [
  ["logSec", (d) => Math.log10(Math.max(0.02, d.sec))],
  ["logAtk", (d) => Math.log10(Math.max(1, d.attackMs))],
  ["logCentroid", (d) => Math.log10(Math.max(20, d.centroidHz))],
  ["logRolloff", (d) => Math.log10(Math.max(20, d.rolloff85Hz))],
  ["flatness", (d) => d.flatness],
  ["crestDb", (d) => d.crestDb],
  ["lowShare", (d) => d.lowShare],
];
const raw = ds.map((d) => DIMS.map(([, f]) => f(d)));
const zs = raw.map((r) => r.slice());
for (let j = 0; j < DIMS.length; j++) {
  const col = raw.map((r) => r[j]);
  const mu = col.reduce((a, b) => a + b, 0) / col.length;
  const sd = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length) || 1;
  for (let i = 0; i < zs.length; i++) zs[i][j] = (raw[i][j] - mu) / sd;
}
const dist = (a, b) => Math.sqrt(zs[a].reduce((s, v, j) => s + (v - zs[b][j]) ** 2, 0));
const pairs = [];
for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) pairs.push({ a: ds[i].id, b: ds[j].id, d: dist(i, j) });
const mean = pairs.reduce((s, p) => s + p.d, 0) / Math.max(1, pairs.length);
// THRESHOLD, justified: z-scoring gives every dimension unit variance, so the
// family's own mean pairwise distance is the natural yardstick (for k
// uncorrelated dims it lands near sqrt(2k) = 3.7 here). A pair sitting under
// 45% of that mean is, on average across all seven axes, less than half as
// far apart as two clips of this family typically are — i.e. it occupies the
// same point in shape/brightness/envelope space, which is where two cues stop
// being separable by the only faculties this instrument has. The number is a
// FLAG, not a verdict: the ranked closest-pairs list below is printed in full
// so a reader can disagree with the cutoff without rerunning anything.
const threshold = absThreshold ?? 0.45 * mean;
const idw = Math.max(...ds.map((d) => d.id.length));
console.log(`\n=== PAIRWISE DISTINCTNESS — ${name} ===`);
console.log(`dims: ${DIMS.map(([n]) => n).join(", ")} (z-scored across this set)`);
console.log(`mean pairwise distance ${mean.toFixed(2)}   flag threshold ${threshold.toFixed(2)} (${absThreshold ? "absolute, --threshold" : "0.45 x mean"})`);
console.log("");
console.log("".padEnd(idw) + "  " + ds.map((d) => d.id.slice(-6).padStart(6)).join(" "));
for (let i = 0; i < ds.length; i++) {
  const cells = ds.map((_, j) => (i === j ? "     ." : dist(i, j).toFixed(2).padStart(6)));
  console.log(ds[i].id.padEnd(idw) + "  " + cells.join(" "));
}
console.log("\nnearest neighbour per clip:");
for (let i = 0; i < ds.length; i++) {
  let best = -1, bd = Infinity;
  for (let j = 0; j < ds.length; j++) if (j !== i && dist(i, j) < bd) { bd = dist(i, j); best = j; }
  console.log(`  ${ds[i].id.padEnd(idw)}  ${bd.toFixed(2)}  ${ds[best].id}${bd < threshold ? "   <-- FLAG" : ""}`);
}
const sorted = [...pairs].sort((p, q) => p.d - q.d);
console.log("\nclosest pairs (ranked):");
for (const p of sorted.slice(0, 12)) console.log(`  ${p.d.toFixed(2)}  ${p.a} / ${p.b}${p.d < threshold ? "   <-- FLAG" : ""}`);
const flagged = sorted.filter((p) => p.d < threshold);
console.log(`\nFLAGGED PAIRS (< ${threshold.toFixed(2)}): ${flagged.length === 0 ? "none" : ""}`);
for (const p of flagged) console.log(`  ${p.d.toFixed(2)}  ${p.a} / ${p.b}`);

if (images) {
  console.log(`\n=== SHEETS (Read these) ===`);
  for (const s of sheets) console.log(s.replace(/\\/g, "/"));
} else {
  console.log(`\n(--no-images: numbers only, no PNGs written)`);
}

if (wantJson) {
  const jsonPath = join(OUT, "descriptors.json");
  writeFileSync(jsonPath, JSON.stringify({
    name, threshold, meanDistance: mean, dims: DIMS.map(([n]) => n),
    clips: ds, pairs: sorted.map((p) => ({ ...p, d: +p.d.toFixed(3) })), sheets,
  }, null, 2));
  console.log(jsonPath.replace(/\\/g, "/"));
}
