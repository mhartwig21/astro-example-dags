// IS **HIGH** ACTUALLY BETTER TO LOOK AT THAN MEDIUM? — the third acceptance
// question, answered with pixels instead of adjectives.
//
// The three modes differ visually in exactly four ways (quality.ts): pixel
// ratio (2.0 / 1.4 / 1.0), shadow map (2048@1 / 1536@2 / 1024@3), AO sample
// count + AO buffer scale, and bloom input scale. Occlusion, particles, motes
// and lights are declared IDENTICAL across all three. So the whole visible
// difference should be sharpness and shadow crispness — and if it is not
// measurable it is not visible either.
//
// Two numbers per image pair:
//   ACUTANCE — mean |luma gradient| over the frame. Resolution and shadow-map
//     detail both raise it; a soft upscale lowers it. This is the "is it
//     sharper" number, and it is comparable across images of the same scene
//     because the scene is the same.
//   DIFFERENCE — mean absolute per-pixel luma delta, plus the share of pixels
//     over 2/8/16 levels, plus an 8x6 grid so a difference that lives in one
//     place (a shadow edge) can be told from one spread over the frame.
//
// Pure node: a minimal PNG reader (RGBA8/RGB8, non-interlaced — what Chromium
// writes) so nothing has to be installed.
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
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) {
    throw new Error(`${path}: unsupported PNG (depth=${depth} color=${color} interlace=${interlace})`);
  }
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
  // luma plane
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    L[i] = 0.2126 * out[j] + 0.7152 * out[j + 1] + 0.0722 * out[j + 2];
  }
  return { w, h, L };
}

const acutance = (img) => {
  const { w, h, L } = img;
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      s += Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
      n++;
    }
  }
  return +(s / n / 2).toFixed(3);
};

function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error("size mismatch");
  const { w, h } = a;
  let sum = 0, o2 = 0, o8 = 0, o16 = 0;
  const GX = 8, GY = 6;
  const grid = new Float64Array(GX * GY), gridN = new Float64Array(GX * GY);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GY - 1, Math.floor(y * GY / h));
    for (let x = 0; x < w; x++) {
      const d = Math.abs(a.L[y * w + x] - b.L[y * w + x]);
      sum += d;
      if (d > 2) o2++;
      if (d > 8) o8++;
      if (d > 16) o16++;
      const gi = gy * GX + Math.min(GX - 1, Math.floor(x * GX / w));
      grid[gi] += d; gridN[gi]++;
    }
  }
  const n = w * h;
  return {
    meanAbs: +(sum / n).toFixed(3),
    pctOver2: +(100 * o2 / n).toFixed(2),
    pctOver8: +(100 * o8 / n).toFixed(2),
    pctOver16: +(100 * o16 / n).toFixed(2),
    grid: [...Array(GY)].map((_, gy) => [...Array(GX)].map((_, gx) => +(grid[gy * GX + gx] / gridN[gy * GX + gx]).toFixed(1))),
  };
}

const base = process.argv[2] ?? "tools/_acc1/igpu";
const scenes = ["quiet", "worst"];
for (const scene of scenes) {
  const imgs = {};
  for (const m of ["low", "medium", "high"]) {
    try { imgs[m] = readPng(`${base}_${scene}_${m}.png`); } catch (e) { console.log(`skip ${scene}/${m}: ${e.message}`); }
  }
  const have = Object.keys(imgs);
  if (have.length < 2) continue;
  console.log(`\n=== ${scene} · ${have.map((m) => `${m} ${imgs[m].w}x${imgs[m].h}`).join(" · ")} ===`);
  console.log("ACUTANCE (mean |luma gradient| — higher is sharper):");
  for (const m of have) console.log(`  ${m.padEnd(7)} ${acutance(imgs[m])}`);
  const pairs = [["high", "medium"], ["medium", "low"], ["high", "low"]];
  for (const [a, b] of pairs) {
    if (!imgs[a] || !imgs[b]) continue;
    const d = diff(imgs[a], imgs[b]);
    console.log(`\n${a} vs ${b}: mean|dL|=${d.meanAbs}  >2:${d.pctOver2}%  >8:${d.pctOver8}%  >16:${d.pctOver16}%`);
    for (const row of d.grid) console.log("   ", row.map((v) => String(v).padStart(6)).join(""));
  }
}
