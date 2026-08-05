// FINAL VERIFICATION — surface (d), click-count half: real mouse clicks, DOM
// re-queried after every re-render (the first pass held stale nodes).
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--force_high_performance_gpu"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${BASE}?test&floor=8&level=16&abilities=all&gold=900&seed=41&debug=1&eagerassets`,
  { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc?.state, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const s = window.__dcc.state;
  s.players[0].pos.x = s.map.stairs.x; s.players[0].pos.y = s.map.stairs.y;
});
await page.waitForTimeout(600);
await page.keyboard.down("e"); await page.waitForTimeout(500); await page.keyboard.up("e");
await page.waitForFunction(() => {
  const el = document.getElementById("saferoom");
  return !!el && getComputedStyle(el).display !== "none";
}, { timeout: 60000 });
await page.waitForTimeout(2000);
await page.getByText("ABILITIES", { exact: false }).first().click();
await page.waitForTimeout(1500);

const staged = () => page.evaluate(() =>
  (document.querySelector("#sr-abil .ahname")?.innerText || "").trim());
const out = { steps: [] };
out.openStaged = await staged();

// ONE real click on loadout slot 2 (a different ability from slot 1).
const before = await staged();
await page.locator("#sr-loadout .lslot").nth(1).click({ force: true });
await page.waitForTimeout(1000);
const after = await staged();
out.steps.push({ route: "loadout tile (slot 2), 1 click", before, after, changed: after !== before });

// What does the card answer about "what can I take next"?
out.nextTakeableRead = await page.evaluate(() => {
  const card = document.querySelector("#sr-abil .acard, #sr-abil .ccard");
  if (!card) return null;
  const rows = [...card.querySelectorAll(".nrow")].map((r) => ({
    text: r.innerText.replace(/\s+/g, " ").trim().slice(0, 90),
    cls: r.className,
  }));
  return { title: (card.querySelector(".ahname")?.innerText || "").trim(), rows };
});
let cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-1click-loadout.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// ONE real click on a rail entry the loadout does not carry (a benched ability).
const b2 = await staged();
await page.locator("#sr-abil-index button[data-ab-sel]").nth(9).click({ force: true });
await page.waitForTimeout(1000);
const a2 = await staged();
out.steps.push({ route: "rail entry #10, 1 click", before: b2, after: a2, changed: a2 !== b2 });

// Count clicks from the safe room's front door (SYSTEM SHOP tab) to a named
// upgrade list for a specific ability.
await page.evaluate(() => document.getElementById("sr-tab-shop").click());
await page.waitForTimeout(800);
let clicks = 0;
await page.getByText("ABILITIES", { exact: false }).first().click(); clicks++;
await page.waitForTimeout(1200);
const arrival = await page.evaluate(() => {
  const card = document.querySelector("#sr-abil .acard, #sr-abil .ccard");
  return { title: (card?.querySelector(".ahname")?.innerText || "").trim(),
    nodeRows: card?.querySelectorAll(".nrow").length ?? 0,
    isChart: !!card?.className.includes("ccard") };
});
out.fromShopTab = { clicks, arrival };
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-arrival.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

writeFileSync(`${OUT}/abil2.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await page.close();
await browser.close();
