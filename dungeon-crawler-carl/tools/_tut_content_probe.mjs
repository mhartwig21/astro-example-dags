// CONTENT-PASS probe (one-off, this round): seeds a mid-curriculum profile
// (obj.move done) so the card shows THE FIVE, then asserts the {token}
// labels substituted into LIVE binds — no literal brace ever on the glass.
// Port 5287 ONLY. One browser, closed at the end.
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
  // Seed BEFORE the app boots: enrolled + S1 done => card should open on THE FIVE.
  await page.addInitScript(() => {
    localStorage.setItem("dcc:tips:v1", JSON.stringify(["obj.enrolled", "obj.move"]));
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.keyboard.press("2"); // campfire farewell if up
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const go = document.getElementById("m-cast-go");
    if (go && go.offsetParent) go.click();
    else document.getElementById("m-daily")?.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById("m-cast-go")?.click());
  await page.waitForTimeout(2500);
  const snap = await page.evaluate(() => {
    const obj = document.getElementById("objectives");
    return {
      visible: obj && getComputedStyle(obj).display !== "none",
      text: obj?.textContent ?? "",
      tut: window.__dcc?.tut?.()?.objectives?.step?.id ?? null,
    };
  });
  console.log(`INFO card: "${snap.text}"`);
  ok(snap.visible, "objectives card visible mid-curriculum");
  ok(snap.tut === "obj.five", `current step is obj.five (got ${snap.tut})`);
  ok(/The Five/.test(snap.text), "card is titled THE FIVE");
  ok(!snap.text.includes("{"), "no literal {token} on the glass");
  ok(/Trade blows with .+/.test(snap.text), "strike item carries a live label");
  ok(/Dash with .+/.test(snap.text), "dash item carries a live label");
  ok(/Cast with .+/.test(snap.text), "cast item carries a live label");
  ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? "PROBE GREEN" : `PROBE RED: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);
