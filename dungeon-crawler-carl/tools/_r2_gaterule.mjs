// Rush core r2 — the critic's MAJOR 2 repro, inverted into an acceptance:
// a LATE JOINER of a gated DAILY race must SEE today's rule while the gate
// holds (on the READY card itself — the banner dies behind the modal), and
// must be able to find it in #hud-log after the gun.
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const DAY = new Date().toISOString().slice(0, 10);
const CODE = `DAILY-${DAY}-GR${Math.floor(Math.random() * 10000)}`;
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));
  await page.goto(`${BASE}/iso.html?noassets&join=${CODE}&rivals&name=${name}`, {
    waitUntil: "load", timeout: 90000,
  });
  return page;
}

// The rule text must be VISIBLY on the READY card: element rendered, real
// box, non-zero opacity, and the text present — not merely in the DOM.
async function ruleOnCard(page, ms) {
  try {
    await page.waitForFunction(() => {
      const gate = document.getElementById("rushgate");
      const rule = document.getElementById("rushgate-rule");
      if (!gate || !rule || !gate.classList.contains("on")) return false;
      const cs = getComputedStyle(rule);
      const r = rule.getBoundingClientRect();
      return cs.display !== "none" && parseFloat(cs.opacity) > 0.5
        && r.width > 50 && r.height > 10
        && /TODAY'S RULE/i.test(rule.textContent ?? "");
    }, { timeout: ms, polling: 100 });
    return await page.evaluate(() => document.getElementById("rushgate-rule").textContent);
  } catch {
    return null;
  }
}

try {
  const a = await boot("ALPHA");
  const ra = await ruleOnCard(a, 30000);
  check("creator sees TODAY'S RULE on the READY card", !!ra, ra ?? "not visible in 30s");

  // Let the creator sit ~8s (the critic's race: the first gate frame killed
  // the banner sighting) — the CARD copy must still be there.
  await a.waitForTimeout(8000);
  const raStill = await ruleOnCard(a, 2000);
  check("…and it is STILL there 8s into the hold", !!raStill);

  const b = await boot("BRAVO");
  const rb = await ruleOnCard(b, 30000);
  check("late joiner sees TODAY'S RULE on the READY card", !!rb, rb ?? "not visible in 30s");
  await b.screenshot({ path: "tools/_r2_gate_rule.png" });

  // Both ready -> the gun. The late joiner must find the rule in #hud-log.
  await a.click("#rushgate-ready");
  await b.click("#rushgate-ready");
  await b.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"),
    { timeout: 15000 });
  const inLog = await b.waitForFunction(() => {
    const log = document.getElementById("hud-log");
    return log && /TODAY'S RULE/i.test(log.innerText);
  }, { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
  check("late joiner finds the rule in #hud-log after the gun", inLog);
  await b.screenshot({ path: "tools/_r2_gate_gun.png" });

  await a.close();
  await b.close();
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
