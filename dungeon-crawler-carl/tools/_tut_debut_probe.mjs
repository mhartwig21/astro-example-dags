// THE DEBUT probe (TUTORIAL.md first-run mercy): does the HOST half of the
// gate actually fire for the person it is for? A cold profile, one browser,
// port 5287 only. Asserts the world the first descent builds is the merciful
// one (save.firstRun), that the production float is really in the crawler's
// pocket at second zero, and that the System said so on the glass.
import { chromium } from "playwright";

const URL = "http://localhost:5287/iso.html?debug=1";
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const cold = await page.evaluate(() => ({
    hist: localStorage.getItem("dcc:history:v1"),
    save: localStorage.getItem("dcc:save:v1"),
    tips: localStorage.getItem("dcc:tips:v1"),
  }));
  ok(!cold.hist && !cold.save, `profile is cold (history=${cold.hist} save=${cold.save})`);
  ok((cold.tips ?? "").includes("obj.enrolled"), "fresh crawler enrolled in the curriculum");

  await page.keyboard.press("2"); // campfire farewell, if B0 is up
  await page.waitForTimeout(800);
  // DESCEND is the cold boot's one door (#m-solo -> the casting stage). The
  // DAILY tile is deliberately NOT it: a daily is a comparison, and isDebutRun
  // refuses one, which is the gate working.
  await page.evaluate(() => { document.getElementById("m-solo")?.click(); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const go = document.getElementById("m-cast-go");
    if (go && go.offsetParent) go.click();
  });
  await page.waitForTimeout(2500);
  await page.keyboard.press("2");
  await page.waitForTimeout(2500);

  const seen = await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem("dcc:save:v1") ?? "null");
    return {
      firstRun: save?.firstRun ?? null,
      gold: save?.player?.gold ?? null,
      status: save?.status ?? null,
      body: document.body.innerText,
    };
  });
  ok(seen.firstRun === true, `the first descent built a DEBUT world (save.firstRun=${seen.firstRun})`);
  ok(seen.gold >= 40, `the production float is in the crawler's pocket (gold=${seen.gold})`);
  ok(/PRODUCTION FLOAT/i.test(seen.body), "the System announced the float on the glass");
  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);

  await page.screenshot({ path: "tools/_shots/debut_boot.png" });
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? "\nALL GREEN" : `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}`);
process.exit(fails.length === 0 ? 0 : 1);
