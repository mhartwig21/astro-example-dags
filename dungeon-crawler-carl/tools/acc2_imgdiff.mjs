// PRESET A/B WITH ITS OWN CONTROL.
//
// Same two statistics as tools/acc1_imgdiff.mjs (acutance = mean |luma
// gradient|, and a per-pixel luma difference), but the mode list includes
// `highB` — a second HIGH exposure taken one interval after the first, with no
// mode switch between them. Everything that moves while the sim is frozen
// (animation-mixer pose, motes, shader time uniforms) lands in high-vs-highB,
// so it is the FLOOR any preset difference has to clear to be a preset
// difference at all.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function readPng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) throw new Error(`${path}: unsupported PNG`);
  const ch = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      switch (f) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
      }
      cur[x] = v & 255;
    }
  }
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) L[i] = 0.2126 * out[j] + 0.7152 * out[j + 1] + 0.0722 * out[j + 2];
  return { w, h, L };
}

const acutance = (img) => {
  const { w, h, L } = img;
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = y * w + x;
    s += Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
    n++;
  }
  return +(s / n / 2).toFixed(3);
};

function diff(a, b) {
  const { w, h } = a;
  let sum = 0, o2 = 0, o8 = 0, o16 = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(a.L[i] - b.L[i]);
    sum += d;
    if (d > 2) o2++;
    if (d > 8) o8++;
    if (d > 16) o16++;
  }
  const n = w * h;
  return { meanAbs: +(sum / n).toFixed(3), pctOver2: +(100 * o2 / n).toFixed(2), pctOver8: +(100 * o8 / n).toFixed(2), pctOver16: +(100 * o16 / n).toFixed(2) };
}

const base = process.argv[2] ?? "tools/_acc2shots/dgpu";
for (const scene of ["worst", "quiet"]) {
  const imgs = {};
  for (const m of ["low", "medium", "high", "highB"]) {
    try { imgs[m] = readPng(`${base}_${scene}_${m}.png`); } catch { /* not captured */ }
  }
  if (Object.keys(imgs).length < 3) continue;
  console.log(`\n=== ${scene} ===`);
  console.log("ACUTANCE (mean |luma gradient|, higher = sharper):");
  for (const m of Object.keys(imgs)) console.log(`  ${m.padEnd(7)} ${acutance(imgs[m])}`);
  if (imgs.high && imgs.highB) {
    console.log(`  HIGH vs its own repeat: acutance ${acutance(imgs.high)} vs ${acutance(imgs.highB)} `
      + `(${(100 * (acutance(imgs.highB) / acutance(imgs.high) - 1)).toFixed(1)}% — this is the noise floor)`);
  }
  const pairs = [["high", "highB"], ["high", "medium"], ["medium", "low"], ["high", "low"]];
  console.log("pair              mean|dL|   >2%    >8%   >16%");
  for (const [a, b] of pairs) {
    if (!imgs[a] || !imgs[b]) continue;
    const d = diff(imgs[a], imgs[b]);
    const tag = a === "high" && b === "highB" ? " <- CONTROL (motion only)" : "";
    console.log(`${`${a} vs ${b}`.padEnd(18)} ${String(d.meanAbs).padStart(7)} ${String(d.pctOver2).padStart(6)} ${String(d.pctOver8).padStart(6)} ${String(d.pctOver16).padStart(6)}${tag}`);
  }
}
