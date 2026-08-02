// Desktop panel captures — is the touch chrome visible on a fine pointer?
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://localhost:5420";
const OUT = "tools/_mobile/ac-desk";
mkdirSync(OUT, { recursive: true });
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=3&level=14&seed=7";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE}/iso.html?${TEST}`, { waitUntil: "load", timeout: 180000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || getComputedStyle(l).display === "none" || getComputedStyle(l).opacity === "0"; }, null, { timeout: 120000 });
await page.waitForTimeout(1500);
const alive = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing"; });
const report = {};
for (const [key, id] of [["i", "inv"], ["p", "sheet"], ["t", "abil"], ["k", "keys"]]) {
  await alive();
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/desktop-${id}.png`, timeout: 180000 });
  report[id] = await page.evaluate((pid) => {
    const e = document.getElementById(pid);
    const g = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, position: cs.position, bg: cs.backgroundColor, font: cs.fontFamily.split(",")[0], border: cs.borderTopWidth + " " + cs.borderTopColor }; };
    return { x: g(e.querySelector(".tp-x")), done: g(e.querySelector(".tp-done")), panel: g(e.querySelector(".panel")) };
  }, id);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
