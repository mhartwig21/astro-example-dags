// CAMPFIRE / CHARACTER-SELECT parity frame. This scene renders DIRECT to the
// canvas (not through the composer), so it is the one place the renderer's
// `antialias` flag and the manual shadowMap.needsUpdate arming are visible.
// Usage: node tools/_paritymenu.mjs <outDir> <tag> --base URL [--quality Q]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2];
const TAG = process.argv[3];
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : ""; };
const BASE = (arg("--base") || "http://localhost:5285").replace(/\/$/, "");
const Q = arg("--quality");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${BASE}/iso.html?eagerassets${Q ? `&quality=${Q}` : ""}`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(9000);
await page.evaluate(() => { for (const a of document.getAnimations()) a.pause(); }).catch(() => {});
const path = `${OUT}/menu-${TAG}.png`;
await page.screenshot({ path, timeout: 240000 });
console.log("saved", path);
await browser.close();
