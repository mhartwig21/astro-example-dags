// Objective darkness audit for capture panels (final cinematic pass, issue #1:
// "60-75% of every frame is crushed near-black"). Decodes a PNG (minimal
// in-repo decoder: 8-bit gray/RGB/RGBA, non-interlaced — exactly what
// Playwright emits) and reports the fraction of pixels under 5% luminance.
// CONTRACT: standard floor shots must come in UNDER 35% crushed.
// Usage: node tools/lumcheck.mjs shot.png [more.png ...] [--max 35]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  // Unfilter scanlines (spec filters 0-4).
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = (y * (stride + 1)) + 1;
    const dst = y * stride;
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
      else { // paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

function audit(file, maxPct) {
  const { w, h, channels, px } = decodePng(readFileSync(file));
  const n = w * h;
  let under5 = 0, under10 = 0, sum = 0;
  const bins = new Array(10).fill(0); // luminance deciles
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const lum = channels >= 3
      ? 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]
      : px[o];
    sum += lum;
    if (lum < 12.75) under5++;
    if (lum < 25.5) under10++;
    bins[Math.min(9, (lum / 25.6) | 0)]++;
  }
  const p5 = (under5 / n) * 100;
  const p10 = (under10 / n) * 100;
  const mean = (sum / n / 255) * 100;
  const hist = bins.map((b) => Math.round((b / n) * 100)).join(" ");
  const verdict = p5 <= maxPct ? "PASS" : "FAIL";
  console.log(
    `${verdict} ${file}\n  under 5% lum: ${p5.toFixed(1)}% (limit ${maxPct}%) | under 10%: ${p10.toFixed(1)}% | mean lum: ${mean.toFixed(1)}%\n  decile histogram (0-100%): ${hist}`,
  );
  return p5 <= maxPct;
}

const args = process.argv.slice(2);
const mi = args.indexOf("--max");
const maxPct = mi >= 0 ? Number(args.splice(mi, 2)[1]) : 35;
if (args.length === 0) {
  console.error("usage: node tools/lumcheck.mjs shot.png [more.png ...] [--max 35]");
  process.exit(1);
}
let ok = true;
for (const f of args) ok = audit(f, maxPct) && ok;
process.exit(ok ? 0 : 1);
