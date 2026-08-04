// DEATH IS A DOOR acceptance (NICHE.md 4.7) — the stomped racer's act at the
// moment of death, in a REAL race: two tabs, one browser (machine rule),
// against the local game server (:5281).
//
//   1. two crawlers join a fresh rivals code, both ready -> the gun fires
//   2. Alpha drops Bravo (pvp melee — the leader-bounty fight the doc names)
//   3. Bravo's death screen grows the two doors: KEEP FIGHTING (default,
//      bounty hint printed) and CONCEDE
//   4. CONCEDE -> the sim fact comes back in the snapshot: SEAT FREED card,
//      Alpha's standings chip reads OUT
//   5. RUN IT BACK -> lands in a solo run on ?runback=<seed>, no menu detour
//   6. no scrollbars at 1366x768 through all of it
//
// usage: node tools/_deathdoor_probe.mjs  (expects vite :5286 + server :5281)
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const CODE = "DOOR" + Math.floor(Math.random() * 100000);

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
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  // Wire tap: record outbound ws frames so "the client sent concede" is a fact.
  await ctx.addInitScript(() => {
    const orig = WebSocket.prototype.send;
    window.__wsSent = [];
    WebSocket.prototype.send = function (d) {
      try { window.__wsSent.push(String(d).slice(0, 60)); } catch { /* ignore */ }
      return orig.call(this, d);
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, String(e.message)));
  await page.goto(`${BASE}/iso.html?noassets&join=${CODE}&rivals&name=${name}`, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  return page;
}

const a = await boot("Alpha");
const b = await boot("Bravo");

// 1. Both ready at the gate; the gun fires.
for (const p of [a, b]) {
  await p.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), { timeout: 30000 });
  await p.click("#rushgate-ready");
}
await a.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), { timeout: 30000 });
await b.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), { timeout: 30000 });
check("the gun fired for both", true);

// 2. Alpha melees Bravo down. Both spawn within a tile of the floor entry;
// hold the swing while sweeping aim around the crawler until Bravo drops.
console.log("  the contract dispute begins…");
const t0 = Date.now();
let downed = false;
const cx = 683, cy = 384;
outer: while (Date.now() - t0 < 150000) {
  for (const [dx, dy] of [[40, 0], [28, 28], [0, 40], [-28, 28], [-40, 0], [-28, -28], [0, -40], [28, -28]]) {
    await a.mouse.move(cx + dx, cy + dy);
    await a.mouse.down();
    await a.waitForTimeout(900);
    await a.mouse.up();
    const state = await b.evaluate(() => document.getElementById("downed")?.dataset.mode ?? "");
    if (state === "downed" || state === "conceded") { downed = true; break outer; }
  }
}
check("Bravo is DOWN (pvp)", downed, `${Math.round((Date.now() - t0) / 1000)}s`);

if (downed) {
  // 3. The two doors, on the death screen, with the bounty hint.
  const doors = await b.evaluate(() => ({
    fight: !!document.getElementById("downed-fight"),
    concede: !!document.getElementById("downed-concede"),
    hint: document.querySelector("#downed .dhint")?.textContent ?? "",
    count: document.getElementById("downed-count")?.textContent ?? "",
  }));
  check("KEEP FIGHTING door (default)", doors.fight);
  check("CONCEDE door", doors.concede);
  check("the bounty comeback is stated", /bounty/i.test(doors.hint), doors.hint);
  check("the 15s clock is visible", Number(doors.count) > 0 && Number(doors.count) <= 15, doors.count);
  await b.screenshot({ path: "tools/_door_downed.png" });

  // 4. CONCEDE -> sim fact -> SEAT FREED + OUT in the rival's standings.
  // force: the countdown re-centers the box every second, which fails
  // Playwright's stability gate; the screenshot above already proves the
  // door is visibly there, and the assertions below prove it WORKS.
  await b.click("#downed-concede", { force: true, timeout: 5000 });
  await b.waitForTimeout(1200);
  const wire = await b.evaluate(() => ({
    sent: (window.__wsSent ?? []).filter((f) => f.includes("concede")),
    mode: document.getElementById("downed")?.dataset.mode ?? "",
  }));
  console.log(`  [wire] concede frames sent: ${wire.sent.length} (mode now: ${wire.mode})`);
  await b.waitForFunction(() => document.getElementById("downed")?.dataset.mode === "conceded", { timeout: 15000 });
  const freed = await b.evaluate(() => document.getElementById("downed").innerText);
  check("SEAT FREED card", /SEAT FREED/.test(freed) && /RUN IT BACK/.test(freed), freed.replace(/\n/g, " | ").slice(0, 120));
  await b.screenshot({ path: "tools/_door_conceded.png" });
  await a.waitForFunction(() => /OUT/.test(document.getElementById("party")?.innerText ?? ""), { timeout: 10000 });
  check("Alpha's standings chip reads OUT", true);
  const scroll = await b.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
    || document.documentElement.scrollHeight > document.documentElement.clientHeight);
  check("no scrollbars", !scroll);

  // 5. RUN IT BACK -> solo run on the same seed, no menu detour.
  await b.click("#downed-runback");
  await b.waitForFunction(() => /[?&]runback=\d+/.test(location.search), { timeout: 20000 });
  await b.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  await b.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  await b.waitForTimeout(2500);
  const back = await b.evaluate(() => ({
    url: location.search,
    menu: getComputedStyle(document.getElementById("menu")).display,
    log: document.getElementById("hud-log")?.innerText ?? "",
  }));
  check("landed on ?runback=<seed>", /[?&]runback=\d+/.test(back.url), back.url);
  check("no menu detour (run already live)", back.menu === "none", back.menu);
  await b.screenshot({ path: "tools/_door_runback.png" });
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(", ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
