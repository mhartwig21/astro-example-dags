// Like tools/shot.mjs but POLLS <html data-assets-settled="1"> (assets.ts
// stamps it when the manifest settles) instead of sleeping a fixed wait —
// robust when the dev server is busy re-transforming after HMR.
// Usage: node tools/shotwait.mjs "<url>" <out.png> [--timeout ms] [--keys "w:800"] [--settle ms]
import { chromium } from "playwright";

const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node tools/shotwait.mjs <url> <out.png> [flags]"); process.exit(1); }
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const timeout = Number(flag("--timeout", 120000));
const settle = Number(flag("--settle", 2500));
const keys = flag("--keys", "");

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
try {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout });
} catch {
  console.error("WARN: assets never settled; shooting anyway");
}
await page.waitForTimeout(3500); // floor build + first frames after settle
if (keys) {
  for (const pair of keys.split(",")) {
    const [k, holdRaw] = pair.split(":");
    await page.keyboard.down(k);
    await page.waitForTimeout(Number(holdRaw ?? 120));
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
}
await page.waitForTimeout(settle);
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
console.log("saved", out);
