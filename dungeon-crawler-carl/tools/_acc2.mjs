// Acceptance capture 2: REAL floor-1 run against a seeded live server.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_acc2";
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
  localStorage.setItem("dcc:consent:v1", "public");
});

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k); };
const settle = async () => { await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } }); await page.waitForTimeout(150); };
async function shot(name, sel) { await settle(); await (sel ? page.locator(sel) : page).screenshot({ timeout: 300000, path: `${OUT}/${name}.png` }); console.log("saved", name); }

// ---- REAL run: no ?test, starts at floor 1, recorded, submittable ----
await page.goto(`${BASE}&debug=1&seed=31`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
rec("run kind", await page.evaluate(() => JSON.stringify({ floor: window.__dcc.state.floor, status: window.__dcc.state.status })));
// play a bit so the proof has content
for (let i = 0; i < 4; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(700); await page.keyboard.up("w");
  await page.keyboard.down("j"); await page.waitForTimeout(600); await page.keyboard.up("j");
}
await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });

// the ten seconds, un-scrubbed, as the player experiences them
for (const ms of [1500, 5000, 11000]) {
  await page.waitForTimeout(ms === 1500 ? 1500 : ms === 5000 ? 3500 : 6000);
  const seal = await page.evaluate(() => document.getElementById("recap-seal")?.innerText);
  rec(`seal @${ms}ms`, seal ?? "(none)");
  await page.locator("#recap").screenshot({ timeout: 300000, path: `${OUT}/R${ms}.png` });
}
rec("VERDICT real (default)", await page.evaluate(() => {
  const p = document.querySelector("#recap .panel");
  return `scrollH=${p.scrollHeight} clientH=${p.clientHeight}\n` + p.innerText;
}));
await shot("R-verdict-real");
await page.locator("#recap .panel").screenshot({ timeout: 300000, path: `${OUT}/R-panel.png` });

// expand the math
await page.evaluate(() => document.querySelector("#recap .eline")?.click());
await page.waitForTimeout(400);
rec("VERDICT math open", await page.evaluate(() => document.getElementById("recap-earned-detail")?.innerText));
await shot("S-verdict-math");

// TAB with a real board to compare against
await page.keyboard.down("Tab"); await page.waitForTimeout(600);
rec("TAB real", await page.evaluate(() => document.getElementById("recap-tab")?.innerText?.slice(0, 2500)));
await shot("T-verdict-tab");
await page.keyboard.up("Tab");

// ---- STANDINGS with real rows ----
await page.evaluate(() => { document.getElementById("recap").style.display = "none"; });
for (const t of ["contracts", "alltime", "bands", "rivals"]) {
  const r = await page.evaluate((tab) => {
    const l = document.getElementById("ladder"); l.style.display = "flex";
    const b = [...l.querySelectorAll("button")].find(x => x.dataset?.tab === tab || x.textContent.trim().toLowerCase().replace("-", "").includes(tab.slice(0, 5)));
    if (b) { b.click(); return b.textContent.trim(); } return "NOT FOUND";
  }, t);
  await page.waitForTimeout(2500);
  rec(`STANDINGS ${t} (${r})`, await page.evaluate(() => document.getElementById("ladder")?.innerText?.slice(0, 3500)));
  await shot(`U-standings-${t}`);
}
// row detail: click the top row
const rowInfo = await page.evaluate(() => {
  const l = document.getElementById("ladder");
  const row = l.querySelector(".lrow, tr, li, [data-run]");
  if (!row) return "no row";
  row.click(); return row.className || row.tagName;
});
await page.waitForTimeout(1500);
rec("row click -> " + rowInfo, await page.evaluate(() => document.getElementById("ladder")?.innerText?.slice(0, 2500)));
await shot("V-standings-rowdetail");

// ---- CAREER ----
await page.evaluate(() => { document.getElementById("ladder").style.display = "none"; document.getElementById("career").style.display = "flex"; });
await page.waitForTimeout(2500);
rec("CAREER", await page.evaluate(() => document.getElementById("career")?.innerText?.slice(0, 3500)));
await shot("W-career");

writeFileSync(`${OUT}/dump.txt`, log.join("\n"));
console.log("done");
await browser.close();
