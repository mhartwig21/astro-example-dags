// Funnel r2 — critic MAJOR 1 acceptance: with the flip hour configured (19),
// the server's day is 2026-08-03 while the browser's UTC-midnight guess says
// 2026-08-04. Every day-gated surface must show/route on the SERVER's day:
//   A. the menu board header names the server's day, and the RUSH sub
//      restates the flip in the viewer's clock;
//   B. a ?c= card whose seed is the LIVE (flipped) daily is recognized as
//      TODAY once the server answers — not demoted to a closed-day rerun.
// Run with the flip-19 server on :5391 (started separately) and the
// worktree's vite on :5286.
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const API = "http://localhost:5391";
const SERVER_DAY = "2026-08-03";
const LOCAL_DAY = new Date().toISOString().slice(0, 10); // 2026-08-04
const CARD = "WzEsMjY5ODkzMjExNywiIiwiTUVBVFNISUVMRCIsNywwLDM3Miw0MSw5LCIiXQ"; // dailySeed(2026-08-03)

const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

// HARNESS.md: data-assets-settled is NOT playable — a frame is only honest
// once #loading has actually left (absent, .done, display:none, or zero box).
// (.done is stamped at fade START — an honest frame needs the fade DONE, so
// this waits for the computed opacity to actually reach zero.)
const loadingGone = async (page) => {
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    const r = l.getBoundingClientRect();
    return cs.display === "none" || cs.visibility === "hidden"
      || parseFloat(cs.opacity) <= 0.02 || r.width === 0 || r.height === 0;
  }, { timeout: 90000, polling: 200 });
  await page.waitForTimeout(400); // paint settle
};

try {
  // ---- A: the menu speaks the server's day --------------------------------
  const a = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  a.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));
  await a.goto(`${BASE}/iso.html?noassets&api=${API}`, { waitUntil: "load", timeout: 90000 });
  await a.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 60000 });
  await loadingGone(a);
  // Wait for /rush to land (the sub gains the "rotates … your time" clock).
  await a.waitForFunction(() =>
    /rotates .+ your time/.test(document.getElementById("m-rush-sub")?.textContent ?? ""),
    { timeout: 20000, polling: 200 }).catch(() => {});
  const boardDay = await a.evaluate(() => document.getElementById("m-board-day")?.textContent ?? "");
  check(`board header names the SERVER's day ${SERVER_DAY}`, boardDay === SERVER_DAY, `got "${boardDay}"`);
  check("…and not the browser's UTC guess", boardDay !== LOCAL_DAY, `local would be ${LOCAL_DAY}`);
  const rushSub = await a.evaluate(() => document.getElementById("m-rush-sub")?.textContent ?? "");
  check("RUSH sub restates the flip in the viewer's clock", /rotates .+ your time/.test(rushSub), `"${rushSub}"`);
  const dailySub0 = await a.evaluate(() => document.getElementById("m-daily-sub")?.textContent ?? "");
  await a.screenshot({ path: "tools/_r2_serverday_menu.png" });
  console.log(`  daily sub: "${dailySub0}"`);
  await a.close();

  // ---- B: a card for the LIVE flipped daily is TODAY, not a closed day ----
  const b = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  b.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));
  await b.goto(`${BASE}/iso.html?noassets&api=${API}&c=${CARD}`, { waitUntil: "load", timeout: 90000 });
  await b.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 60000 });
  await loadingGone(b);
  // The flag is confirmed asynchronously against the server's day (≤3s).
  const gotToday = await b.waitForFunction(() =>
    (document.getElementById("m-daily-sub")?.textContent ?? "").includes("today's daily"),
    { timeout: 10000, polling: 200 }).then(() => true).catch(() => false);
  const cardSub = await b.evaluate(() => document.getElementById("m-daily-sub")?.textContent ?? "");
  check("the LIVE daily's card reads as TODAY (board is watching)", gotToday, `"${cardSub}"`);
  const accept = await b.evaluate(() => document.querySelector("#m-daily b")?.textContent ?? "");
  check("the tile is ACCEPT CHALLENGE (full band)", accept === "ACCEPT CHALLENGE", accept);
  // No horizontal scroll at 1366x768 with the suffixed sub.
  const noHScroll = await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check("no horizontal scrollbar at 1366x768", noHScroll);
  await b.screenshot({ path: "tools/_r2_serverday_card.png" });
  await b.close();
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILURE(S)` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
