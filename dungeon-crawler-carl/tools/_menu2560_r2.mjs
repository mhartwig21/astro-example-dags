import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
const cdp = await page.context().newCDPSession(page);
await page.goto("http://localhost:5284/iso.html?eagerassets", { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true; const cs = getComputedStyle(l); return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0; }, null, { timeout: 200000 }).catch(() => {});
await page.waitForTimeout(4500);
const g = await page.evaluate(() => {
  const b = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const solo = b("#m-solo"), daily = b("#m-daily"), test = b(".m-testlink"), foot = b(".m-foot"), panel = b("#menu .panel");
  const strip = document.querySelector(".m-board-tabs");
  return { solo, daily, ratio: +(solo.h / daily.h).toFixed(2), test, foot, panel,
    stackGapBelowTest: foot.y - test.bottom, stripScroll: strip.scrollWidth - strip.clientWidth,
    colsOver: (() => { const c = document.querySelector(".m-cols"); return { x: c.scrollWidth - c.clientWidth, y: c.scrollHeight - c.clientHeight }; })() };
});
console.log(JSON.stringify(g, null, 1));
writeFileSync("shots/acc-social-r2/menu-2560x1440.png", Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
await browser.close();
