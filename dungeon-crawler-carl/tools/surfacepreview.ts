// Eyeball the generative surface bake WITHOUT launching a browser: runs the
// real src/render3d/surfaceMaps.ts bake and writes the four channels out as
// PNGs (normal RG, roughness, cavity, plus a relit preview under a raking light
// so the relief is actually visible rather than a pastel blur).
// Usage: npx tsx tools/surfacepreview.ts [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { surfaceDetailMap } from "../src/render3d/surfaceMaps.js";

const out = process.argv[2] ?? "tools/_surface";
mkdirSync(out, { recursive: true });

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; });
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = (png as unknown as { t?: Int32Array }).t ??= (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
      return t;
    })();
    let c = ~0;
    for (const b of body) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const tex = surfaceDetailMap();
const size = tex.image.width as number;
const px = tex.image.data as Uint8Array;
const N = size * size;

const write = (name: string, fn: (i: number) => [number, number, number]) => {
  const buf = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) { const [r, g, b] = fn(i); buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; }
  writeFileSync(`${out}/${name}.png`, png(size, size, buf));
};

write("normal", (i) => [px[i * 4], px[i * 4 + 1], 255]);
write("roughness", (i) => [px[i * 4 + 2], px[i * 4 + 2], px[i * 4 + 2]]);
write("cavity", (i) => [px[i * 4 + 3], px[i * 4 + 3], px[i * 4 + 3]]);
// Relit: a warm raking light over a mid-grey albedo, times cavity. This is the
// one to eyeball — it is what a torch actually does to the surface.
write("relit", (i) => {
  const nx = px[i * 4] / 255 * 2 - 1, ny = px[i * 4 + 1] / 255 * 2 - 1;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const L = [0.52, -0.34, 0.78];
  const nl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
  const cav = px[i * 4 + 3] / 255;
  const lit = (0.16 + 0.9 * nl) * cav;
  return [
    Math.min(255, Math.round(255 * lit * 1.06)),
    Math.min(255, Math.round(255 * lit * 0.95)),
    Math.min(255, Math.round(255 * lit * 0.86)),
  ];
});

let mnR = 255, mxR = 0, mnC = 255, mxC = 0;
for (let i = 0; i < N; i++) {
  mnR = Math.min(mnR, px[i * 4 + 2]); mxR = Math.max(mxR, px[i * 4 + 2]);
  mnC = Math.min(mnC, px[i * 4 + 3]); mxC = Math.max(mxC, px[i * 4 + 3]);
}
console.log(`baked ${size}x${size}  roughness ${mnR}..${mxR}  cavity ${mnC}..${mxC}  -> ${out}/`);
