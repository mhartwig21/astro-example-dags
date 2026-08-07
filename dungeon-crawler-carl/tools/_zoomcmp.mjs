#!/usr/bin/env node
// tools/_zoomcmp.mjs — dependency-free side-by-side zoom of the SAME region of
// two PNGs, plus an amplified difference panel. No browser, no libs: decodes
// with the _pngdiff filter chain and re-encodes with filter-0 rows.
// Usage: node tools/_zoomcmp.mjs a.png b.png x y w h zoom out.png
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

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

function crc32(buf) {
  let c, t = crc32.t;
  if (!t) {
    t = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const [, , pa, pb, xs, ys, ws, hs, zs, outp] = process.argv;
const X = +xs, Y = +ys, W = +ws, H = +hs, Z = +zs;
const A = decode(pa), B = decode(pb);
const GAP = 8;
const panelW = W * Z, panelH = H * Z;
const outW = panelW * 3 + GAP * 2, outH = panelH;
const out = Buffer.alloc(outW * outH * 3);
for (let y = 0; y < panelH; y++) {
  for (let x = 0; x < panelW; x++) {
    const sx = X + ((x / Z) | 0), sy = Y + ((y / Z) | 0);
    const ia = (sy * A.w + sx) * A.bpp, ib = (sy * B.w + sx) * B.bpp;
    const put = (px, r, g, b) => { const o = (y * outW + px) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b; };
    put(x, A.data[ia], A.data[ia + 1], A.data[ia + 2]);
    put(panelW + GAP + x, B.data[ib], B.data[ib + 1], B.data[ib + 2]);
    // amplified |a-b| x8, so a 2-value drift is visible and a 30-value one saturates
    const d0 = Math.min(255, Math.abs(A.data[ia] - B.data[ib]) * 8);
    const d1 = Math.min(255, Math.abs(A.data[ia + 1] - B.data[ib + 1]) * 8);
    const d2 = Math.min(255, Math.abs(A.data[ia + 2] - B.data[ib + 2]) * 8);
    put(panelW * 2 + GAP * 2 + x, d0, d1, d2);
  }
}
writeFileSync(outp, encode(outW, outH, out));
console.log(`wrote ${outp} (${outW}x${outH})  left=A right=B far-right=|A-B|x8`);
