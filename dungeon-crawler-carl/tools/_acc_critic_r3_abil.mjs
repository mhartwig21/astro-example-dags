// r3 acceptance: re-shoot #abil ACHIEVEMENTS with a real settle so the frame
// shows the panel, and measure the overflow that finding 3 was about.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-critic-r3";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => { report.push([k, v]); console.log(`--- ${k}\n${JSON.stringify(v)}`); };

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
try {
  for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(240000);
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3500);
    // open via key repeatedly until the panel reports open (SwiftShader boots slow)
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("t");
      const open = await page.waitForFunction(() => {
        const a = document.getElementById("abil");
        return a && getComputedStyle(a).display !== "none";
      }, null, { timeout: 2500 }).then(() => true).catch(() => false);
      if (open) break;
    }
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#abil .apage[data-page="ach"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.waitForTimeout(3000); // let the fade + SwiftShader compositor land
    const achFit = await page.evaluate(() => {
      const pane = document.getElementById("ach-section");
      if (!pane || getComputedStyle(pane).display === "none") return { error: "ach pane not visible" };
      const grid = pane.querySelector(".sr-ach-grid");
      const g = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
      const de = document.documentElement;
      return { paneClient: pane.clientHeight, paneScroll: pane.scrollHeight,
        overflowY: pane.scrollHeight - pane.clientHeight, columns: g,
        cards: pane.querySelectorAll(".sr-ach").length,
        docOverX: de.scrollWidth - de.clientWidth, docOverY: de.scrollHeight - de.clientHeight };
    });
    push(`abil ach refit ${tag}`, achFit);
    writeFileSync(`${OUT}/abil-ach2-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/abil-refit.json`, JSON.stringify(report, null, 1));
console.log("ABIL RESHOOT DONE");
