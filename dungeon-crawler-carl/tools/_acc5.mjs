// Probe: is content below the fold actually reachable on CAREER / STANDINGS?
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = "tools/_acc5"; mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", e => console.error("PAGE ERROR:", e.message));
await page.addInitScript(() => { localStorage.setItem("dcc:token:v1", "SHOTCRAWLER"); localStorage.setItem("dcc:name:v1", "Carl"); });
await page.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent("http://localhost:5431")}&noassets`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2500);

const probe = async (rootId) => page.evaluate((id) => {
  const root = document.getElementById(id);
  const out = [];
  const walk = (el) => {
    const s = getComputedStyle(el);
    if (el.scrollHeight - el.clientHeight > 4) {
      out.push({ sel: el.id || el.className, oy: s.overflowY, sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop });
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}, rootId);

await page.click("#m-careerset"); await page.waitForTimeout(3500);
console.log("CAREER overflow:", JSON.stringify(await probe("career"), null, 1));
// mouse wheel over the panel
await page.mouse.move(800, 600); await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
console.log("after wheel:", JSON.stringify(await probe("career"), null, 1));
await page.screenshot({ timeout: 300000, path: `${OUT}/career-after-wheel.png` });
console.log("MORE BELOW visible?", await page.evaluate(() => {
  const e = [...document.querySelectorAll("#career *")].find(x => /MORE BELOW/.test(x.textContent) && x.children.length === 0);
  return e ? JSON.stringify({ txt: e.textContent.trim(), cls: e.className }) : "none";
}));

await page.keyboard.press("Escape"); await page.waitForTimeout(600);
await page.click("#m-standings"); await page.waitForTimeout(3500);
console.log("STANDINGS overflow:", JSON.stringify(await probe("ladder"), null, 1));
await page.mouse.move(800, 600); await page.mouse.wheel(0, 2000); await page.waitForTimeout(600);
console.log("after wheel:", JSON.stringify(await probe("ladder"), null, 1));
await page.screenshot({ timeout: 300000, path: `${OUT}/standings-after-wheel.png` });
// affordance?
console.log("standings scroll hint:", await page.evaluate(() => {
  const t = document.getElementById("ladder").innerText;
  return /MORE BELOW|SCROLL|▾/.test(t) ? "present" : "ABSENT";
}));
await browser.close();
