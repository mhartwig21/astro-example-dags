// TEMP: retry of the one failed panel shot (r2-ui-shop). Deleted after use.
import { chromium } from "playwright";

const OUT = "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
const BASE = "http://localhost:5285/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(7000);
await page.waitForFunction(() => !!window.__dcc, { timeout: 90000 });
await page.evaluate(() => {
  const s = window.__dcc.state;
  const p = s.players[0];
  p.pos.x = s.map.stairs.x;
  p.pos.y = s.map.stairs.y;
});
await page.waitForTimeout(500);
await page.keyboard.down("e");
await page.waitForTimeout(400);
await page.keyboard.up("e");
await page.waitForTimeout(2500);
// The full-page screenshot stalled once at 300s under SwiftShader (rAF at
// seconds-per-frame + font settle). CDP capture skips Playwright's
// stability waits entirely — grab the frame as it is.
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("fs");
writeFileSync(`${OUT}/r2-ui-shop.png`, Buffer.from(data, "base64"));
console.log("saved r2-ui-shop");
await browser.close();
