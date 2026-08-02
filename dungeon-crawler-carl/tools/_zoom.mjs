// Crop + upscale so a critic can actually see a 40px beat.
// node tools/_zoom.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const [inPath, outPath, x, y, w, h, s] = process.argv.slice(2);
const scale = Number(s || 2);
const b64 = readFileSync(inPath).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ b64, x, y, w, h, scale }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.drawImage(img, x, y, w, h, 0, 0, w * scale, h * scale);
  return c.toDataURL("image/png").split(",")[1];
}, { b64, x: +x, y: +y, w: +w, h: +h, scale });
writeFileSync(outPath, Buffer.from(data, "base64"));
await browser.close();
console.log("zoomed", outPath);
