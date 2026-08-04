// Focused check: TODAY'S RULE line reaches both the creating seat and a late
// joiner of a DAILY race, and the solo daily deals the same rule.
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const CODE = "DAILY-2026-08-04-RA" + Math.floor(Math.random() * 10000);
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};
const ruleRe = /TODAY'S RULE: (RUSH HOUR|OVERSTAFFED|HAIR TRIGGER)/i;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

// Poll the whole body for the rule line for up to N ms, sampling fast so a
// transient banner can't slip between screenshots.
async function watchForRule(page, ms) {
  try {
    await page.waitForFunction(
      () => /TODAY'S RULE: (RUSH HOUR|OVERSTAFFED|HAIR TRIGGER)/i.test(document.body.innerText),
      { timeout: ms, polling: 100 },
    );
    return await page.evaluate(() =>
      (document.body.innerText.match(/TODAY'S RULE: (RUSH HOUR|OVERSTAFFED|HAIR TRIGGER)/i) ?? [""])[0]);
  } catch {
    return null;
  }
}

async function boot(url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  return page;
}

try {
  // 1. creating seat of a DAILY race
  const a = await boot(`${BASE}/iso.html?noassets&join=${CODE}&rivals&name=ALPHA`);
  const ra = await watchForRule(a, 25000);
  check("creating seat hears TODAY'S RULE", !!ra, ra ?? "never appeared in 25s");

  // 2. late joiner (gate still holding)
  const b = await boot(`${BASE}/iso.html?noassets&join=${CODE}&rivals&name=BRAVO`);
  const rb = await watchForRule(b, 25000);
  check("late joiner hears TODAY'S RULE", !!rb, rb ?? "never appeared in 25s");
  await a.close(); await b.close();

  // 3. solo daily (menu -> DAILY tile). Use the menu's daily entry.
  const s = await boot(`${BASE}/iso.html?noassets`);
  await s.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  await s.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  await s.waitForTimeout(2000);
  // menu -> DAILY CRAWL -> casting -> DESCEND
  await s.click("#m-daily");
  await s.waitForTimeout(800);
  await s.click("#m-cast-go");
  const rs = await watchForRule(s, 25000);
  check("solo daily deals the same rule", !!rs && (!ra || rs.toUpperCase() === ra.toUpperCase()),
    `solo=${rs} race=${ra}`);
  await s.screenshot({ path: "tools/_ruleannounce_solo.png" });
} catch (err) {
  console.log("PROBE ERROR:", err);
  fails.push("probe crashed");
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAIL(S)` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
