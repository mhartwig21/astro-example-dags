import { chromium } from "playwright";
import { readFileSync } from "fs";
const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of files) {
  const b64 = readFileSync(f).toString("base64");
  const r = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    // Sample the PLAYFIELD only: skip the HUD strips.
    const d = g.getImageData(0, 120, img.width, img.height - 300).data;
    let n = 0, sum = 0, hot = 0, clip = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]) / 255;
      sum += L; n++; if (L > 0.8) hot++; if (d[i] > 250 && d[i+1] > 248) clip++;
    }
    return { mean: (sum/n).toFixed(3), hotFrac: (hot/n).toFixed(3), clipFrac: (clip/n).toFixed(3) };
  }, b64);
  console.log(f, JSON.stringify(r));
}
await browser.close();
