// GHOST REMOVAL acceptance probe (niche-impl phase 1).
//
// Asserts, in the real app on the real dev server:
//   1. the app boots with zero page errors (no orphaned getElementById etc.)
//   2. zero ghost UI exists in the DOM: #ghost, #ghostplate, #recap-race
//   3. a run starts; the verdict appears on death with RUN IT BACK present
//   4. R (RUN IT BACK) starts a NEW run on the SAME seed, with no ghost UI
//
// usage: node tools/_ghostgone.mjs [url]   (default http://localhost:5286)
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5286";
const URL = BASE + "/iso.html?noassets&debug=1&clean=1";

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

try {
  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  // Boot gate per HARNESS.md: #loading must actually leave.
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  await page.waitForTimeout(3000);

  // ---- 2. zero ghost UI in the DOM --------------------------------------
  const dom = await page.evaluate(() => ({
    ghost: !!document.getElementById("ghost"),
    ghostplate: !!document.getElementById("ghostplate"),
    recapRace: !!document.getElementById("recap-race"),
    raceButtons: document.body.innerHTML.includes("data-race"),
  }));
  check("no #ghost rail chip in DOM", !dom.ghost);
  check("no #ghostplate nameplate layer in DOM", !dom.ghostplate);
  check("no #recap-race button in DOM", !dom.recapRace);
  check("no data-race buttons anywhere", !dom.raceButtons);

  // ---- 3. start a solo run, then die ------------------------------------
  await page.click("#m-solo");
  await page.waitForTimeout(800);
  // The campfire cast screen may interpose; DESCEND if it is visible.
  const castGo = page.locator("#m-cast-go");
  if (await castGo.isVisible().catch(() => false)) await castGo.click();
  await page.waitForFunction(() => {
    const d = window.__dcc;
    return !!d?.state && d.state.status === "playing";
  }, { timeout: 30000 });
  const seedBefore = await page.evaluate(() => window.__dcc.state.seed);
  check("a run started (status=playing)", typeof seedBefore === "number", `seed ${seedBefore}`);

  // Kill the crawler: zero the pool and let the sim rule on it. If the sim
  // does not decide within 5s (no damage tick while idle), push status
  // directly - this probe is about the SCREEN's reachability, not the death.
  await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = 0.01; });
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.hp = 0;
    // give the sim a chance first; the fallback below runs after a wait
  });
  await page.waitForTimeout(3000);
  const decided = await page.evaluate(() => window.__dcc.state.status !== "playing");
  if (!decided) {
    await page.evaluate(() => { window.__dcc.state.status = "dead"; });
  }
  await page.waitForFunction(() => {
    const el = document.getElementById("recap");
    return el && getComputedStyle(el).display !== "none";
  }, { timeout: 15000 });
  const verdict = await page.evaluate(() => {
    const again = document.getElementById("recap-again");
    return {
      againVisible: !!again && getComputedStyle(again).display !== "none",
      againText: again ? again.textContent : "",
      race: !!document.getElementById("recap-race"),
      ghostOn: !!document.querySelector("#ghost.on"),
    };
  });
  check("verdict shows RUN IT BACK", verdict.againVisible && /RUN IT BACK/i.test(verdict.againText));
  check("verdict has no RACE THE LEADER", !verdict.race);

  // ---- 4. R = pure seed-replay -------------------------------------------
  await page.keyboard.press("r");
  await page.waitForFunction(() => {
    const d = window.__dcc;
    const recap = document.getElementById("recap");
    return d?.state?.status === "playing" && recap && getComputedStyle(recap).display === "none";
  }, { timeout: 30000 });
  const after = await page.evaluate(() => ({
    seed: window.__dcc.state.seed,
    ghostOn: !!document.querySelector("#ghost.on, #ghostplate.on"),
    hp: window.__dcc.state.players[0].hp,
  }));
  check("RUN IT BACK pinned the same seed", after.seed === seedBefore,
    `before ${seedBefore}, after ${after.seed}`);
  check("fresh run (crawler alive again)", after.hp > 0, `hp ${after.hp}`);
  check("no ghost UI during the rerun", !after.ghostOn);

  // ---- 1. zero errors, checked last so it covers the whole session -------
  check("zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const realConsoleErrors = consoleErrors.filter((t) =>
    !/net::|Failed to load resource|ERR_CONNECTION|404|WebSocket/i.test(t));
  check("zero console errors (network noise excluded)", realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? "\nALL CHECKS PASSED" : `\n${fails.length} CHECK(S) FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
