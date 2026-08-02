// Acceptance capture 3: a REAL DAILY CONTRACT run, entered through the menu,
// against the seeded live server. This is the ten seconds under judgement.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_acc3";
const API = "http://localhost:5431";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
  localStorage.setItem("dcc:name:v1", "Carl");
});

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k); };
const settle = async () => { await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } }); await page.waitForTimeout(150); };
async function shot(name, sel) { await settle(); await (sel ? page.locator(sel) : page).screenshot({ timeout: 300000, path: `${OUT}/${name}.png` }); console.log("saved", name); }

await page.goto(`${BASE}&debug=1`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(3000);
await shot("M-menu");

// ENTER THE DAILY CONTRACT — the ranked path
await page.click("#m-daily");
await page.waitForTimeout(2500);
await shot("M-casting");
await page.click("#m-cast-go");
await page.waitForFunction(() => document.getElementById("menu")?.style.display === "none", null, { timeout: 60000 });
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
rec("run entered", await page.evaluate(() => JSON.stringify({
  floor: window.__dcc.state.floor, mode: window.__dcc.state.mode, seed: window.__dcc.state.seed,
})));

// play for real
for (let i = 0; i < 6; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(800); await page.keyboard.up("w");
  await page.keyboard.down("j"); await page.waitForTimeout(700); await page.keyboard.up("j");
  await page.keyboard.down("d"); await page.waitForTimeout(500); await page.keyboard.up("d");
}
rec("pre-death", await page.evaluate(() => { const p = window.__dcc.state.players[0]; return JSON.stringify({ elapsed: window.__dcc.state.elapsed, kills: p.kills, hp: p.hp, lvl: p.level }); }));

await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });

// consent card first-submit
await page.waitForTimeout(1200);
const consentUp = await page.evaluate(() => { const c = document.getElementById("consent"); return c && getComputedStyle(c).display !== "none" ? c.innerText : null; });
rec("CONSENT CARD", consentUp ?? "(not shown)");
if (consentUp) { await shot("N-consent"); await page.evaluate(() => { const b = [...document.querySelectorAll("#consent button")].find(x => /PUBLIC/i.test(x.textContent)); b?.click(); }); }

// the ten seconds
let t = 0;
for (const step of [800, 2200, 4000, 6000, 8000]) {
  await page.waitForTimeout(step - t); t = step;
  const st = await page.evaluate(() => ({
    seal: document.getElementById("recap-seal")?.innerText,
    ladder: document.getElementById("recap-ladder")?.innerText,
    earned: document.getElementById("recap-earned")?.innerText,
  }));
  rec(`t=${step}ms`, JSON.stringify(st, null, 1));
  await page.locator("#recap").screenshot({ timeout: 300000, path: `${OUT}/P${step}.png` });
}
await page.waitForTimeout(6000);
rec("VERDICT final", await page.evaluate(() => {
  const p = document.querySelector("#recap .panel");
  return `scrollH=${p.scrollHeight} clientH=${p.clientHeight}\n` + p.innerText;
}));
await shot("P-verdict");

await page.evaluate(() => document.querySelector("#recap .eline")?.click());
await page.waitForTimeout(400);
await shot("P-verdict-math");
rec("MATH", await page.evaluate(() => document.getElementById("recap-earned-detail")?.innerText));

await page.keyboard.down("Tab"); await page.waitForTimeout(700);
rec("TAB", await page.evaluate(() => document.getElementById("recap-tab")?.innerText?.slice(0, 3000)));
await shot("P-tab");
await page.keyboard.up("Tab");

// STANDINGS with rows
await page.evaluate(() => { document.getElementById("recap").style.display = "none"; });
for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
  await page.evaluate((t2) => {
    const l = document.getElementById("ladder"); l.style.display = "flex";
    const b = [...l.querySelectorAll("button")].find(x => x.dataset?.tab === t2 || x.textContent.trim().toLowerCase().replace(/[^a-z]/g, "").startsWith(t2.slice(0, 5)));
    b?.click();
  }, tab);
  await page.waitForTimeout(2600);
  rec(`STANDINGS ${tab}`, await page.evaluate(() => document.getElementById("ladder")?.innerText?.slice(0, 4000)));
  await shot(`Q-standings-${tab}`);
}
await page.evaluate(() => { document.getElementById("ladder").style.display = "none"; document.getElementById("career").style.display = "flex"; });
await page.waitForTimeout(2600);
rec("CAREER", await page.evaluate(() => document.getElementById("career")?.innerText?.slice(0, 4000)));
await shot("Q-career");

writeFileSync(`${OUT}/dump.txt`, log.join("\n"));
console.log("done");
await browser.close();
