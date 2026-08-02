// Frame statistics for the acceptance round: how much of a boss frame is dead
// black, and how wide is its hue spread?
//
// Both are claims a critic should not make by eye. "35-70% of every fight frame
// was dead black" (BOSSES-V2 §5.11) was closed by a fix; "the frame is all one
// hue" is the kind of statement that is either measurable or worthless. This
// measures the PLAYFIELD only — the HUD bands top and bottom are chrome, and
// including them would flatter the dark number and pollute the hue number.
//
// Usage: node tools/_r8stats.mjs tools/_r8a/*.png
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2).filter((a) => a.endsWith(".png"));
if (!files.length) { console.error("usage: node tools/_r8stats.mjs FILE.png..."); process.exit(2); }

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage();
await page.goto("about:blank");

console.log("file".padEnd(34) + "dark%  mid%  blown%  hueSpread  sat");
for (const f of files) {
  const b64 = readFileSync(f).toString("base64");
  const r = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    // The playfield, excluding the HUD bands: top 12% is the plate/marquee
    // band, bottom 12% is the ability bar, and the outer 3% either side is
    // panel gutter. What is left is the picture.
    const x0 = Math.round(c.width * 0.03), x1 = Math.round(c.width * 0.97);
    const y0 = Math.round(c.height * 0.12), y1 = Math.round(c.height * 0.88);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, blown = 0, n = 0, satSum = 0;
    const hueHist = new Array(36).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      n++;
      if (l < 0.06) dark++;              // below this nothing is legible
      if (l > 0.94 && max - min < 0.06) blown++; // clipped to white
      const s = max === 0 ? 0 : (max - min) / max;
      satSum += s;
      if (s > 0.18 && l > 0.06) {        // only chromatic pixels vote on hue
        let h;
        if (max === min) h = 0;
        else if (max === R) h = ((G - B) / (max - min)) % 6;
        else if (max === G) h = (B - R) / (max - min) + 2;
        else h = (R - G) / (max - min) + 4;
        h = ((h * 60) + 360) % 360;
        hueHist[Math.floor(h / 10)]++;
      }
    }
    const votes = hueHist.reduce((a, b) => a + b, 0);
    // How many 10-degree hue bins hold at least 5% of the chromatic pixels?
    // A frame painted in one colour family scores 1-3; a frame with real
    // colour design scores 6+.
    const spread = hueHist.filter((v) => v > votes * 0.05).length;
    return {
      dark: (dark / n) * 100, blown: (blown / n) * 100,
      spread, sat: satSum / n,
    };
  }, b64);
  console.log(
    basename(f).padEnd(34) +
    r.dark.toFixed(1).padStart(5) +
    (100 - r.dark - r.blown).toFixed(1).padStart(6) +
    r.blown.toFixed(2).padStart(8) +
    String(r.spread).padStart(10) +
    r.sat.toFixed(3).padStart(7));
}
await browser.close();
