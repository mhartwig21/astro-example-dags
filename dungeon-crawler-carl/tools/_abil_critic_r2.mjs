// Critic probe: #abil ACH pane fit + clips at three viewports (standing item 3).
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-critic-r2";
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
    await page.goto(`${BASE}/iso.html?test&floor=3&level=12&abilities=all&gold=5000&seed=42&eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);
    await page.keyboard.press("t");
    await page.waitForFunction(() => {
      const a = document.getElementById("abil");
      return a && getComputedStyle(a).display !== "none";
    }, null, { timeout: 10000 });
    await page.evaluate(() => document.querySelector('#abil .apage[data-page="ach"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.waitForTimeout(600);
    const scan = await page.evaluate(() => {
      const root = document.getElementById("abil");
      const sec = document.getElementById("ach-section");
      const grid = document.getElementById("ach-grid");
      const de = document.documentElement;
      const scrollers = [];
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2)
          scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, over: el.scrollHeight - el.clientHeight });
      }
      const gcols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
      const clipped = [];
      for (const el of sec.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
        if (!ownText) continue;
        if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY === "hidden")
          clipped.push({ sel: `.${String(el.className).split(" ")[0]}`, cut: el.scrollHeight - el.clientHeight, text: (el.textContent || "").trim().slice(0, 40) });
      }
      const pr = root.querySelector(".panel").getBoundingClientRect();
      const sr = sec.getBoundingClientRect();
      return {
        docOverY: de.scrollHeight - de.clientHeight,
        panel: { y: Math.round(pr.y), h: Math.round(pr.height), bottom: Math.round(pr.bottom) },
        section: { h: Math.round(sr.height), scrollOver: sec.scrollHeight - sec.clientHeight },
        gridCols: gcols, cards: grid ? grid.children.length : 0,
        liveScrollers: scrollers, clippedText: clipped,
        viewportOverflow: Math.round(pr.bottom - innerHeight),
      };
    });
    push(`abil ach ${tag}`, scan);
    writeFileSync(`${OUT}/abil-ach-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/abil-probe.json`, JSON.stringify(report, null, 1));
console.log("ABIL PROBE DONE");
