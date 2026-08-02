// Acceptance capture 4: career + standings driven by their REAL buttons.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "tools/_acc4";
const API = "http://localhost:5431";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
  localStorage.setItem("dcc:name:v1", "Carl");
});
const log = []; const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k); };
const settle = async () => { await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } }); await page.waitForTimeout(150); };
async function shot(n, s) { await settle(); await (s ? page.locator(s) : page).screenshot({ timeout: 300000, path: `${OUT}/${n}.png` }); console.log("saved", n); }

await page.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2500);

await page.click("#m-careerset");
await page.waitForTimeout(3500);
rec("CAREER", await page.evaluate(() => {
  const c = document.getElementById("career"); const p = c.querySelector(".panel");
  return `scrollH=${p?.scrollHeight} clientH=${p?.clientHeight}\n` + c.innerText.slice(0, 5000);
}));
await shot("C-career");
await page.evaluate(() => document.querySelector("#career .panel")?.scrollTo(0, 99999));
await page.waitForTimeout(400);
await shot("C-career-bottom");

await page.keyboard.press("Escape"); await page.waitForTimeout(600);
await page.click("#m-standings"); await page.waitForTimeout(3000);
for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll("#ladder button")].find(x => x.dataset?.tab === t || x.textContent.trim().toLowerCase().replace(/[^a-z]/g, "").startsWith(t.slice(0, 5)));
    b?.click();
  }, tab);
  await page.waitForTimeout(2600);
  const m = await page.evaluate(() => {
    const p = document.querySelector("#ladder .panel"); const r = p.getBoundingClientRect();
    return { sh: p.scrollHeight, ch: p.clientHeight, w: Math.round(r.width), x: Math.round(r.x) };
  });
  rec(`STANDINGS ${tab} ${JSON.stringify(m)}`, await page.evaluate(() => document.getElementById("ladder")?.innerText?.slice(0, 4500)));
  await shot(`L-${tab}`);
  await page.evaluate(() => document.querySelector("#ladder .panel")?.scrollTo(0, 99999));
  await page.waitForTimeout(400);
  await shot(`L-${tab}-bottom`);
  await page.evaluate(() => document.querySelector("#ladder .panel")?.scrollTo(0, 0));
}
writeFileSync(`${OUT}/dump.txt`, log.join("\n"));
console.log("done"); await browser.close();
