// The tuner's warm-up gate is armed on the FIRST composed frame while
// qualityChoice === "auto". prewarm() composes several frames of its own behind
// the loading screen, so check whether the 4s gate has already expired by the
// time the player gets control.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false,
  args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
let armedAt = null;
page.on("console", (m) => { if (m.text().includes("shader-guard] armed")) armedAt = Date.now(); });
await page.goto("http://localhost:5294/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1", { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
for (let i = 0; i < 60 && !armedAt; i++) await page.waitForTimeout(300);
const r = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  return { now: performance.now(), warmupUntil: R.warmupUntil, choice: R.qualityChoice,
           preset: R.quality.name, frameNo: R.frameNo };
});
console.log(JSON.stringify(r));
console.log(`warm-up gate ${r.warmupUntil === 0 ? "NOT ARMED" : (r.now > r.warmupUntil ? `ALREADY EXPIRED ${(r.now - r.warmupUntil).toFixed(0)}ms ago` : `${(r.warmupUntil - r.now).toFixed(0)}ms remaining`)} at the moment prewarm finished`);
await browser.close();
