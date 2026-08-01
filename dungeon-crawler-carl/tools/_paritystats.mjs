// Luminance + local-contrast statistics over the PLAYFIELD region only (the
// DOM HUD is identical by construction and would dilute every number).
// Usage: node tools/_paritystats.mjs <a.png> [b.png ...]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
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
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

// Playfield box: below the top HUD strip, above the ability bar, inside the
// side panels. Everything measured here is rendered by the 3D pipeline.
let X0 = 120, Y0 = 120, X1 = 1480, Y1 = 780;
const boxIdx = process.argv.indexOf("--box");
const files = process.argv.slice(2).filter((a, i) => !a.startsWith("--") && (boxIdx < 0 || i + 2 < boxIdx || i + 2 > boxIdx + 4));
if (boxIdx >= 0) {
  X0 = +process.argv[boxIdx + 1]; Y0 = +process.argv[boxIdx + 2];
  X1 = X0 + +process.argv[boxIdx + 3]; Y1 = Y0 + +process.argv[boxIdx + 4];
}

for (const p of files) {
  const { w, channels, px } = decodePng(readFileSync(p));
  const lum = (x, y) => {
    const o = (y * w + x) * channels;
    return channels >= 3 ? 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2] : px[o];
  };
  let n = 0, sum = 0, sat = 0, warm = 0;
  // ACUTANCE: mean |Laplacian|. A sharper image (crisper texture detail, tighter
  // AO contact lines) scores higher; a blurrier or flatter one scores lower.
  let acu = 0;
  for (let y = Y0 + 1; y < Y1 - 1; y++) {
    for (let x = X0 + 1; x < X1 - 1; x++) {
      const l = lum(x, y);
      sum += l; n++;
      acu += Math.abs(4 * l - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1));
      const o = (y * w + x) * channels;
      if (channels >= 3) {
        const r = px[o], g = px[o + 1], b = px[o + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sat += mx === 0 ? 0 : (mx - mn) / mx;
        warm += r - b;
      }
    }
  }
  const name = p.split(/[\\/]/).slice(-2).join("/");
  console.log(
    `${name.padEnd(46)} lum ${(sum / n).toFixed(2).padStart(6)}  ` +
    `acutance ${(acu / n).toFixed(2).padStart(6)}  ` +
    `sat ${(sat / n).toFixed(4)}  warmth(R-B) ${(warm / n).toFixed(2).padStart(7)}`,
  );
}
