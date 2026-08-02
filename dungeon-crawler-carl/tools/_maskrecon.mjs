// THROWAWAY recon aid (deleted after use): reduce the six -3fight frames to
// black-and-white silhouette masks and lay them out as one contact sheet, so
// "fights differ by shape, not hue" can be judged the way the doc asks.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const beat = process.argv[2] || "3fight";
const ids = ["rentcollector", "sumpking", "topiary", "permitoffice", "marshal", "showrunner"];
const dir = "tools/_bossrecon3/";
const imgs = ids.map((id) => ({ id, b64: readFileSync(dir + id + "-" + beat + ".png").toString("base64") }));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const data = await page.evaluate(async ({ imgs, thresh }) => {
  const CW = 380, CH = 260;           // per-cell, from a 1600x900 source crop
  const SX = 240, SY = 120, SW = 1140, SH = 780; // arena crop, HUD excluded
  const sheet = document.createElement("canvas");
  sheet.width = CW * 3; sheet.height = CH * 2;
  const sc = sheet.getContext("2d");
  sc.fillStyle = "#000"; sc.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < imgs.length; i++) {
    const img = new Image();
    img.src = "data:image/png;base64," + imgs[i].b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = CW; c.height = CH;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, SX, SY, SW, SH, 0, 0, CW, CH);
    const d = ctx.getImageData(0, 0, CW, CH);
    for (let p = 0; p < d.data.length; p += 4) {
      const l = (d.data[p] * 0.2126 + d.data[p + 1] * 0.7152 + d.data[p + 2] * 0.0722) / 255;
      const v = l > thresh ? 255 : 0;
      d.data[p] = d.data[p + 1] = d.data[p + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    const gx = (i % 3) * CW, gy = Math.floor(i / 3) * CH;
    sc.drawImage(c, gx, gy);
    sc.fillStyle = "#f00"; sc.font = "bold 18px monospace";
    sc.fillText(imgs[i].id, gx + 8, gy + 22);
    sc.strokeStyle = "#f00"; sc.strokeRect(gx, gy, CW, CH);
  }
  return sheet.toDataURL("image/png").split(",")[1];
}, { imgs, thresh: Number(process.argv[3] || 0.55) });
writeFileSync(dir + "_mask-" + beat + ".png", Buffer.from(data, "base64"));
await browser.close();
console.log("wrote " + dir + "_mask-" + beat + ".png");
