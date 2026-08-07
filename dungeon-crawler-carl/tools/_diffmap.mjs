#!/usr/bin/env node
// tools/_diffmap.mjs — localize where two PNGs differ, and say whether the
// differing pixels sit on EDGES (sub-pixel silhouette shift: benign) or fill
// CONTIGUOUS AREAS (a shading/colour change: not benign).
// Reuses _pngdiff's decoder. Usage: node tools/_diffmap.mjs a.png b.png [thresh]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decode(path) {
  const buf = readFileSync(path);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
      if (depth !== 8 || (ctype !== 6 && ctype !== 2)) throw new Error(`unsupported png ${depth}/${ctype}`);
      if (data[12] !== 0) throw new Error("interlaced png unsupported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const [, , pa, pb, thArg] = process.argv;
const TH = +(thArg ?? 8);
const A = decode(pa), B = decode(pb);
if (A.w !== B.w || A.h !== B.h) throw new Error("size mismatch");
const { w, h } = A;
const hit = new Uint8Array(w * h);
let n = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const ia = (y * w + x) * A.bpp, ib = (y * w + x) * B.bpp;
    const d = Math.max(
      Math.abs(A.data[ia] - B.data[ib]),
      Math.abs(A.data[ia + 1] - B.data[ib + 1]),
      Math.abs(A.data[ia + 2] - B.data[ib + 2]));
    if (d > TH) { hit[y * w + x] = 1; n++; }
  }
}
// Connected components (4-neighbour) over the hit mask.
const seen = new Uint8Array(w * h);
const comps = [];
const stack = new Int32Array(w * h);
for (let i = 0; i < w * h; i++) {
  if (!hit[i] || seen[i]) continue;
  let sp = 0; stack[sp++] = i; seen[i] = 1;
  let size = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  while (sp > 0) {
    const j = stack[--sp];
    const x = j % w, y = (j / w) | 0;
    size++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (x > 0 && hit[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack[sp++] = j - 1; }
    if (x < w - 1 && hit[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack[sp++] = j + 1; }
    if (y > 0 && hit[j - w] && !seen[j - w]) { seen[j - w] = 1; stack[sp++] = j - w; }
    if (y < h - 1 && hit[j + w] && !seen[j + w]) { seen[j + w] = 1; stack[sp++] = j + w; }
  }
  // fill ratio: a 1-2px silhouette rim fills a tiny share of its bbox; a face
  // repaint fills most of it.
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  comps.push({ size, box: [x0, y0, x1, y1], fill: +(size / (bw * bh)).toFixed(3), thick: +(size / Math.max(bw, bh)).toFixed(2) });
}
comps.sort((a, b) => b.size - a.size);
console.log(JSON.stringify({
  a: pa, b: pb, threshold: TH, differingPixels: n, pct: +(100 * n / (w * h)).toFixed(3),
  components: comps.length,
  // "thick" ~= mean width of the component in pixels: <=3 is an edge rim.
  thickComponents: comps.filter((c) => c.thick > 3 && c.size > 200).length,
  top: comps.slice(0, 10),
}, null, 2));
