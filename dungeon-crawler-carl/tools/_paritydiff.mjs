// PER-PIXEL DIFF for two static parity frames (same seed, same camera).
// Prints a summary and writes a x8-amplified difference image so a lost AO
// contact line or a missing bloom halo shows up as a lit region.
// Usage: node tools/_paritydiff.mjs <a.png> <b.png> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB;
      else if (filter === 1) v = rawB + a;
      else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

const [, , aP, bP, outP] = process.argv;
const A = decodePng(readFileSync(aP)), B = decodePng(readFileSync(bP));
if (A.w !== B.w || A.h !== B.h) throw new Error("size mismatch");
const X0 = 120, Y0 = 120, X1 = 1480, Y1 = 780;
const out = Buffer.alloc(A.w * A.h * 3);
let n = 0, sum = 0, over8 = 0, over24 = 0, max = 0, signed = 0;
for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const ao = (y * A.w + x) * A.channels, bo = (y * B.w + x) * B.channels;
    const dr = A.px[ao] - B.px[bo], dg = A.px[ao + 1] - B.px[bo + 1], db = A.px[ao + 2] - B.px[bo + 2];
    const d = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    const o = (y * A.w + x) * 3;
    // B brighter than A -> red; A brighter than B -> cyan. x8 amplified.
    const lumD = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
    const amp = Math.min(255, d * 8);
    if (lumD < 0) { out[o] = amp; out[o + 1] = 0; out[o + 2] = 0; }
    else { out[o] = 0; out[o + 1] = amp; out[o + 2] = amp; }
    if (x >= X0 && x < X1 && y >= Y0 && y < Y1) {
      n++; sum += d; signed += lumD;
      if (d > 8) over8++;
      if (d > 24) over24++;
      if (d > max) max = d;
    }
  }
}
writeFileSync(outP, encodePng(A.w, A.h, out));
console.log(
  `${aP.split(/[\\/]/).pop()} vs ${bP.split(/[\\/]/).pop()}: ` +
  `mean|d| ${(sum / n).toFixed(2)}  >8: ${(over8 / n * 100).toFixed(2)}%  >24: ${(over24 / n * 100).toFixed(2)}%  ` +
  `max ${max}  mean signed lum (B-A) ${(-signed / n).toFixed(2)}`,
);
