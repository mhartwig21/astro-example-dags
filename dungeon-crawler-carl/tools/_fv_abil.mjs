// FINAL VERIFICATION — surface (d): THE ABILITY / CONSTELLATION screen.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=d3d11", "--force_high_performance_gpu"],
});
const out = {};
const vp = { width: 1366, height: 768 };
const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// POISON THE OLD PREFERENCE FIRST. The complaint was that one click on STAR
// CHART stuck forever via localStorage["dcc.abilView"]; the only honest test is
// to arrive with that key set to "graph" and see what the screen opens on.
await page.goto("http://localhost:5311/iso.html", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.evaluate(() => localStorage.setItem("dcc.abilView", "graph"));

await page.goto(`${BASE}?test&floor=8&level=16&abilities=all&gold=900&seed=41&debug=1&eagerassets`,
  { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc?.state, { timeout: 120000 });
await page.waitForTimeout(2500);

const probe = () => {
  const root = document.querySelector("#sr-page-abil")?.offsetParent !== null
    ? document.querySelector("#sr-page-abil") : document.getElementById("abil");
  const modes = [...document.querySelectorAll(".amode[data-view]")]
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ view: e.dataset.view, on: e.classList.contains("on"), text: e.innerText.trim() }));
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
  const stage = vis("#sr-abil .ccard, #sr-abil .acard, #abil .ccard, #abil .acard");
  const rail = vis("#sr-abil-index button[data-ab-sel], #abil-index button[data-ab-sel]");
  const ell = rail.map((b) => {
    const t = b.querySelector(".aidx-t") || b;
    return { text: t.innerText.trim(), w: +t.getBoundingClientRect().width.toFixed(1),
      scrollW: t.scrollWidth, clientW: t.clientWidth, truncated: t.scrollWidth > t.clientWidth + 1 };
  });
  const cards = stage.map((c) => {
    const r = c.getBoundingClientRect();
    const box = c.parentElement.getBoundingClientRect();
    return {
      kind: c.className.includes("ccard") ? "STAR CHART" : "LIST",
      h: +r.height.toFixed(1), boxH: +box.height.toFixed(1),
      overflows: r.bottom > box.bottom + 1,
      hasSlotBtns: c.querySelectorAll(".slot-btn").length,
      slotBtnsVisible: [...c.querySelectorAll(".slot-btn")].filter((b) => {
        const br = b.getBoundingClientRect();
        return br.bottom <= box.bottom + 1 && br.height > 2;
      }).length,
      hasMods: !!c.querySelector(".amods"),
      hasGraph: !!c.querySelector(".cgraph"),
      // "what can I take next": affordable/available nodes named on THIS card.
      nodeRows: c.querySelectorAll(".nrow").length,
      nextTakeable: c.querySelectorAll(".nrow.can, .ntile.can, .ntile.avail, .nrow.avail").length,
      title: (c.querySelector(".ahname")?.innerText || "").trim(),
    };
  });
  const railW = document.querySelector("#sr-abil-index, #abil-index")?.getBoundingClientRect().width;
  const loadout = vis(".lslot").map((l) => ({
    idx: l.dataset.slotidx, cursor: getComputedStyle(l).cursor,
    empty: l.classList.contains("empty"),
  }));
  return { modes, cards, rail: ell, railW: railW ? +railW.toFixed(1) : null, loadout,
    stageScrollH: root?.querySelector("#sr-abil, #abil-grid")?.scrollHeight ?? null };
};

// --- 1. The T PANEL, opened cold (with the poisoned pref in localStorage) ---
await page.keyboard.press("t");
await page.waitForTimeout(1800);
out.tPanelOnOpen = await page.evaluate(probe);
let cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-tpanel-open.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
await page.keyboard.press("t");
await page.waitForTimeout(800);

// --- 2. THE SAFE ROOM's ABILITIES page, the screen in the complaint ---
await page.evaluate(() => {
  const s = window.__dcc.state;
  s.players[0].pos.x = s.map.stairs.x;
  s.players[0].pos.y = s.map.stairs.y;
});
await page.waitForTimeout(600);
await page.keyboard.down("e");
await page.waitForTimeout(500);
await page.keyboard.up("e");
await page.waitForFunction(() => {
  const el = document.getElementById("saferoom");
  return !!el && getComputedStyle(el).display !== "none";
}, { timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => document.getElementById("sr-tab-abil").click());
await page.waitForTimeout(1500);
out.safeRoomOnOpen = await page.evaluate(probe);
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-saferoom-open.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// --- 3. CLICK COUNT to "what can I take next" on a DIFFERENT ability ---
// Route A: a loadout tile (the bar at the top of the page). One click.
const clicked = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".lslot")].filter((l) => !l.classList.contains("empty"));
  const before = (document.querySelector("#sr-abil .ahname")?.innerText || "").trim();
  // pick a loadout tile that is NOT the one already staged
  for (const t of tiles) {
    t.click();
    const after = (document.querySelector("#sr-abil .ahname")?.innerText || "").trim();
    if (after && after !== before) return { ok: true, before, after, clicks: 1 };
  }
  return { ok: false, before };
});
await page.waitForTimeout(1200);
out.loadoutClickRoute = clicked;
out.afterLoadoutClick = await page.evaluate(probe);
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-after-loadout-click.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// --- 4. THE STAR CHART view, reached deliberately ---
await page.evaluate(() => {
  const b = [...document.querySelectorAll(".amode[data-view='graph']")].find((e) => e.offsetParent !== null);
  b?.click();
});
await page.waitForTimeout(1500);
out.starChartDeliberate = await page.evaluate(probe);
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-starchart.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// --- 5. Does the chart view STICK across a re-open? (the persistence bug) ---
await page.evaluate(() => document.getElementById("sr-tab-shop").click());
await page.waitForTimeout(700);
await page.evaluate(() => document.getElementById("sr-tab-abil").click());
await page.waitForTimeout(1200);
out.afterReopen = await page.evaluate(probe);
out.storedPref = await page.evaluate(() => localStorage.getItem("dcc.abilView"));
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/abil-reopen.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

writeFileSync(`${OUT}/abil.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await page.close();
await browser.close();
