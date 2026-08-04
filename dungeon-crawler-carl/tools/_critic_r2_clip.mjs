import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.setViewportSize({ width: 1366, height: 768 });
await page.goto("http://localhost:5286/iso.html?noassets", { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
await page.waitForTimeout(4000);
const r = await page.evaluate(() => {
  const el = document.getElementById("m-rush-sub");
  return { text: el.textContent, sh: el.scrollHeight, ch: el.clientHeight, clipped: el.scrollHeight > el.clientHeight + 2 };
});
console.log(JSON.stringify(r));
await browser.close();
