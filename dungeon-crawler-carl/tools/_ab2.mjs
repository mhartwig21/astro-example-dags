// Side-by-side A/B sheet: two frames, no labels on the images themselves.
// node tools/_ab2.mjs <a.png> <b.png> <out.png>
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const [aPath, bPath, outPath] = process.argv.slice(2);
const a = readFileSync(aPath).toString("base64");
const b = readFileSync(bPath).toString("base64");
const mime = (p) => (p.endsWith(".jpg") || p.endsWith(".jpeg") ? "jpeg" : "png");
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ a, b, ma, mb }) => {
  const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
  const ia = await load(`data:image/${ma};base64,${a}`);
  const ib = await load(`data:image/${mb};base64,${b}`);
  const W = 1400, H = Math.round(W * 9 / 16);
  const c = document.createElement("canvas");
  c.width = W; c.height = H * 2 + 8;
  const g = c.getContext("2d");
  g.fillStyle = "#111"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(ia, 0, 0, W, H);
  g.drawImage(ib, 0, H + 8, W, H);
  return c.toDataURL("image/png").split(",")[1];
}, { a, b, ma: mime(aPath), mb: mime(bPath) });
writeFileSync(outPath, Buffer.from(data, "base64"));
await browser.close();
console.log("ab", outPath);
