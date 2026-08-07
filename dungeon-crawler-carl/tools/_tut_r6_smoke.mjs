// r6 SMOKE (plumbing check, not the acceptance battery): cold profile against
// the running dev server (port 5287 ONLY). Asserts:
//  - a run starts and the #objectives card paints with step 1's items
//  - the strip card, when one paints, wears MORDECAI's header
//  - the string "COURTESY EXPLANATION" never renders anywhere
//  - no page errors
// One browser, closed at the end. The real cold-profile battery (_tut_r6.mjs,
// the {key}-in-first-sentence pixel probe) is a follow-up round.
import { chromium } from "playwright";

const URL = "http://localhost:5287/iso.html?debug=1";
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // Cold profile: assert, don't assume (r4 probe habit).
  const cold = await page.evaluate(() => ({
    tips: localStorage.getItem("dcc:tips:v1"),
    hist: localStorage.getItem("dcc:history:v1"),
  }));
  ok(!cold.hist, `profile is cold (history=${cold.hist})`);
  // Enrollment key minted at boot for the fresh crawler.
  ok((cold.tips ?? "").includes("obj.enrolled"), `fresh crawler enrolled (tips=${cold.tips})`);

  // The menu: start a solo run. The campfire beat (B0) may be up — close it
  // via its farewell (digit 2 = "Let's go.") then click the daily/rush tile
  // fallback: press Enter on the menu CTA. Simplest robust path: the menu's
  // main CTA button.
  await page.keyboard.press("2"); // B0 farewell if the campfire is up
  await page.waitForTimeout(800);
  const started = await page.evaluate(() => {
    const go = document.getElementById("m-cast-go");
    if (go && go.offsetParent) { go.click(); return "m-cast-go"; }
    const daily = document.getElementById("m-daily");
    if (daily) { daily.click(); return "m-daily"; }
    return null;
  });
  console.log(`INFO clicked menu CTA: ${started}`);
  await page.waitForTimeout(1500);
  // If that landed on the casting stage, DESCEND starts the run.
  const go2 = await page.evaluate(() => {
    const go = document.getElementById("m-cast-go");
    if (go && go.offsetParent) { go.click(); return true; }
    return false;
  });
  if (go2) console.log("INFO clicked DESCEND");
  await page.waitForTimeout(2000);
  await page.keyboard.press("2"); // campfire farewell, if it appeared post-menu
  await page.waitForTimeout(1500);

  // Walk + fight a little so facts accrue and the strip has a reason to paint.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down("d");
    await page.waitForTimeout(450);
    await page.keyboard.up("d");
    await page.keyboard.down("w");
    await page.waitForTimeout(350);
    await page.keyboard.up("w");
  }

  const snap = await page.evaluate(() => {
    const obj = document.getElementById("objectives");
    const objVisible = obj && getComputedStyle(obj).display !== "none";
    const head = document.querySelector(".tut-head");
    return {
      objVisible,
      objText: obj?.textContent ?? "",
      objItems: obj?.querySelectorAll(".obj-items li").length ?? 0,
      stripHead: head?.textContent?.trim() ?? null,
      bodyHasCourtesy: document.body.innerHTML.includes("COURTESY EXPLANATION"),
      tut: window.__dcc?.tut?.() ?? null,
    };
  });
  console.log("INFO snapshot:", JSON.stringify(snap.tut));
  ok(snap.objVisible, `objectives card is visible (text="${snap.objText.slice(0, 60)}")`);
  ok(snap.objItems === 3, `step 1 shows 3 items (got ${snap.objItems})`);
  ok(/Get Moving/i.test(snap.objText), "step 1 is GET MOVING");
  ok(!snap.bodyHasCourtesy, "the string COURTESY EXPLANATION never renders");
  if (snap.stripHead !== null) {
    ok(/MORDECAI/.test(snap.stripHead), `strip header is Mordecai's (got "${snap.stripHead}")`);
  } else {
    console.log("INFO no strip card on the glass at sample time (pacing) — header check skipped");
  }
  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? "SMOKE GREEN" : `SMOKE RED: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);
