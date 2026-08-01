// TEMP crop tool: node tools/crop.mjs <in.png> <out.png> <x> <y> <w> <h>
// Uses Playwright's bundled Chromium to crop via canvas (no native deps).
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const [inPath, outPath, x, y, w, h] = process.argv.slice(2);
const b64 = readFileSync(inPath).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ b64, x, y, w, h }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
  return c.toDataURL("image/png").split(",")[1];
}, { b64, x: +x, y: +y, w: +w, h: +h });
writeFileSync(outPath, Buffer.from(data, "base64"));
await browser.close();
console.log("cropped", outPath);
