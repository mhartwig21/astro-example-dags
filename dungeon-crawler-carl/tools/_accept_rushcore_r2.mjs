// Acceptance critique r2 — independent drive of Rush core in the REAL app.
// One Chromium, multiple pages in the same browser (machine rule).
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const DAY = new Date().toISOString().slice(0, 10);
const CODE = `DAILY-${DAY}-ACC${Math.floor(Math.random() * 100000)}`;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({ headless: true });

async function boot(name, code, rivals, vw = 1600, vh = 900) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on("pageerror", (e) => console.log(`[pageerror ${name}]`, String(e.message)));
  const q = `${BASE}/iso.html?noassets&join=${code}${rivals ? "&rivals" : ""}&name=${name}`;
  await page.goto(q, { waitUntil: "load", timeout: 90000 });
  // playable readiness: #loading gone (HARNESS honesty)
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || getComputedStyle(l).display === "none" || !l.offsetParent;
  }, { timeout: 60000 }).catch(() => {});
  return page;
}

const gateVisible = (page) => page.evaluate(() => {
  const g = document.getElementById("rushgate");
  return !!g && g.classList.contains("on") && g.getBoundingClientRect().width > 0;
});
const gateInfo = (page) => page.evaluate(() => {
  const rule = document.getElementById("rushgate-rule");
  const cs = rule ? getComputedStyle(rule) : null;
  const rr = rule ? rule.getBoundingClientRect() : { width: 0, height: 0 };
  return {
    count: document.getElementById("rushgate-count")?.textContent ?? "",
    seats: [...document.querySelectorAll("#rushgate .gseat")].map((s) => s.textContent),
    ruleVisible: !!rule && cs.display !== "none" && parseFloat(cs.opacity) > 0.5 && rr.width > 50 && rr.height > 10,
    ruleText: rule?.textContent ?? "",
  };
});
const noScroll = (page) => page.evaluate(() => ({
  x: document.documentElement.scrollWidth <= window.innerWidth,
  y: document.documentElement.scrollHeight <= window.innerHeight,
}));

try {
  // ---- 1. Creator at 1366x768 (tightest viewport): DAILY rivals race ----
  const a = await boot("ALPHA", CODE, true, 1366, 768);
  await a.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), { timeout: 30000 });
  check("creator: #rushgate visible on a fresh DAILY rivals race", await gateVisible(a));
  let ga = await gateInfo(a);
  check("creator: TODAY'S RULE visibly on the READY card", ga.ruleVisible && /TODAY'S RULE/i.test(ga.ruleText), ga.ruleText.slice(0, 90));
  const c1 = Number(ga.count);
  check("creator: countdown is a real number", Number.isFinite(c1) && c1 > 0 && c1 <= 60, ga.count);
  const s1 = await noScroll(a);
  check("creator: no scrollbars at 1366x768 with gate up", s1.x && s1.y, JSON.stringify(s1));
  await a.screenshot({ path: "tools/_accept_gate_1366.png" });

  // Held sim: countdown moves, clock does not.
  await a.waitForTimeout(3000);
  ga = await gateInfo(a);
  const c2 = Number(ga.count);
  check("creator: countdown ticks down during hold", c2 < c1, `${c1} -> ${c2}`);

  // ---- 2. Late joiner, same browser ----
  const b = await boot("BRAVO", CODE, false, 1600, 900);
  await b.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), { timeout: 30000 });
  await a.waitForFunction(() => document.querySelectorAll("#rushgate .gseat").length === 2, { timeout: 10000 });
  const gb = await gateInfo(b);
  check("joiner: sees BOTH seats on the card", gb.seats.length === 2, JSON.stringify(gb.seats));
  check("joiner: TODAY'S RULE visibly on the READY card too", gb.ruleVisible && /TODAY'S RULE/i.test(gb.ruleText));
  await b.screenshot({ path: "tools/_accept_gate_joiner.png" });

  // ---- 3. One READY is not a gun; readiness propagates ----
  await a.click("#rushgate-ready");
  await b.waitForFunction(() => [...document.querySelectorAll("#rushgate .gseat")].some((s) => /READY/.test(s.textContent)), { timeout: 8000 });
  check("one READY: still held (joiner gate up, one seat READY)", await gateVisible(b));
  check("one READY: creator button disabled (no double-ready)", await a.evaluate(() => document.getElementById("rushgate-ready").disabled));

  // ---- 4. Second READY fires the gun on both ----
  await b.click("#rushgate-ready");
  await a.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), { timeout: 8000 });
  await b.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), { timeout: 8000 });
  check("gun: gate cleared on both clients", true);
  // Log lines are PACED onto the rail — poll, don't snapshot.
  const gunA = await a.waitForFunction(() => /THE GUN/i.test(document.getElementById("hud-log")?.innerText ?? ""),
    { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
  const ruleB = await b.waitForFunction(() => /TODAY'S RULE/i.test(document.getElementById("hud-log")?.innerText ?? ""),
    { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
  check("gun: THE GUN called on the rail (creator log)", gunA);
  check("durability: TODAY'S RULE findable in joiner's #hud-log after the gun", ruleB);
  await a.screenshot({ path: "tools/_accept_postgun.png" });
  await a.close(); await b.close();

  // ---- 5. Private (non-DAILY) rivals race: gate yes, rule box no ----
  const CODE2 = `ACCPRIV${Math.floor(Math.random() * 100000)}`;
  const c = await boot("CHARLIE", CODE2, true);
  await c.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), { timeout: 30000 });
  const gc = await gateInfo(c);
  check("private race: gated, but NO rule box (base game)", !gc.ruleVisible, gc.ruleText.slice(0, 60));
  await c.close();

  // ---- 6. Co-op party: never gated ----
  const d = await boot("DELTA", `ACCCOOP${Math.floor(Math.random() * 100000)}`, false);
  await d.waitForTimeout(4000);
  check("co-op: no gate ever", !(await gateVisible(d)));
  await d.close();
} catch (e) {
  console.log("SCRIPT ERROR:", e.message);
  fails.push("script error");
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
