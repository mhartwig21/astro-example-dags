// RUSH CORE acceptance probe (niche-impl phase 2 review).
//
// Drives the REAL app on the dev server (:5286) against a REAL local game
// server (:5281), two pages in ONE browser (machine rule):
//   1. page A joins a fresh DAILY-coded rivals race -> #rushgate holds, sim at
//      second zero (countdown visible, no run clock advancing)
//   2. page B joins the same code -> both gates list 2 seats
//   3. A readies -> B's seat list shows ALPHA READY, gate still holds
//   4. B readies -> the gun fires on both, gate card clears
//   5. TODAY'S RULE announced (the rule for today's date, from the sim pool)
//   6. both clients are in the same race (party chip shows both crawlers)
//   7. no scrollbars at 1366x768
//
// usage: node tools/_rushcore_accept.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const CODE = "DAILY-2026-08-04-REV" + Math.floor(Math.random() * 1000);
const urlFor = (name) =>
  `${BASE}/iso.html?noassets&join=${CODE}&rivals&name=${name}`;

const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

async function boot(name) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, String(e.message)));
  await page.goto(urlFor(name), { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  return page;
}

const gateState = (page) => page.evaluate(() => {
  const gate = document.getElementById("rushgate");
  const seats = [...document.querySelectorAll("#rushgate .gseat")].map((el) => el.textContent);
  return {
    on: gate?.classList.contains("on") ?? false,
    count: document.getElementById("rushgate-count")?.textContent ?? "",
    seats,
    banner: document.getElementById("headline")?.textContent ?? "",
    ticker: document.body.innerText.slice(0, 20000),
    scrollbars: document.documentElement.scrollWidth > document.documentElement.clientWidth
      || document.documentElement.scrollHeight > document.documentElement.clientHeight,
  };
});

try {
  const a = await boot("ALPHA");
  await a.waitForTimeout(2500);
  let ga = await gateState(a);
  check("A: gate holds a fresh DAILY rivals race", ga.on, `count=${ga.count}`);
  check("A: countdown is numeric and <= 60", /^\d+$/.test(ga.count) && Number(ga.count) <= 60, ga.count);
  check("A: no scrollbars at 1366x768 with gate up", !ga.scrollbars);
  const c1 = Number(ga.count);
  await a.waitForTimeout(2200);
  ga = await gateState(a);
  check("A: countdown actually counts down", Number(ga.count) < c1, `${c1} -> ${ga.count}`);

  const b = await boot("BRAVO");
  await b.waitForTimeout(2500);
  let gb = await gateState(b);
  ga = await gateState(a);
  check("B: gate holds for the second seat too", gb.on);
  check("both gates list 2 seats", ga.seats.length === 2 && gb.seats.length === 2,
    `A=${JSON.stringify(ga.seats)} B=${JSON.stringify(gb.seats)}`);

  await a.click("#rushgate-ready");
  await a.waitForTimeout(1500);
  gb = await gateState(b);
  check("B sees ALPHA ready, gate still holding",
    gb.on && gb.seats.some((s) => /ALPHA/.test(s) && /READY/.test(s)),
    JSON.stringify(gb.seats));

  await b.click("#rushgate-ready");
  await a.waitForTimeout(2000);
  ga = await gateState(a);
  gb = await gateState(b);
  check("gun fires on unanimous ready: gate clears on A", !ga.on);
  check("gun fires on unanimous ready: gate clears on B", !gb.on);
  const gunA = /THE GUN|gate is open/i.test(ga.ticker) || /THE GUN|gate is open/i.test(ga.banner);
  check("A: the System calls the start", gunA);
  const ruleRe = /TODAY'S RULE: (RUSH HOUR|OVERSTAFFED|HAIR TRIGGER)/i;
  check("A: TODAY'S RULE announced", ruleRe.test(ga.ticker), (ga.ticker.match(ruleRe) ?? [""])[0]);
  check("B: TODAY'S RULE announced", ruleRe.test(gb.ticker), (gb.ticker.match(ruleRe) ?? [""])[0]);

  const chipA = await a.evaluate(() => document.getElementById("party")?.textContent ?? "");
  const chipB = await b.evaluate(() => document.getElementById("party")?.textContent ?? "");
  check("both crawlers share the race (A chip)", /ALPHA/.test(chipA) && /BRAVO/.test(chipA), chipA.slice(0, 120));
  check("both crawlers share the race (B chip)", /ALPHA/.test(chipB) && /BRAVO/.test(chipB), chipB.slice(0, 120));
  check("no scrollbars after the gun", !ga.scrollbars && !gb.scrollbars);

  await a.screenshot({ path: "tools/_rushcore_a.png" });
  await b.screenshot({ path: "tools/_rushcore_b.png" });
} catch (err) {
  console.log("PROBE ERROR:", err);
  fails.push("probe crashed");
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAIL(S)` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
