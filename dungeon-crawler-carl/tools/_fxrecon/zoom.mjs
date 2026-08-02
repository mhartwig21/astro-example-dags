// Crop + integer upscale (nearest) so FX anatomy is inspectable in a still.
// node zoom.mjs <in.png> <out.png> <x> <y> <w> <h> <scale>
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const [inPath, outPath, x, y, w, h, s] = process.argv.slice(2);
const b64 = readFileSync(inPath).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ b64, x, y, w, h, s }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w * s; c.height = h * s;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  return c.toDataURL("image/png").split(",")[1];
}, { b64, x: +x, y: +y, w: +w, h: +h, s: +s });
writeFileSync(outPath, Buffer.from(data, "base64"));
await browser.close();
