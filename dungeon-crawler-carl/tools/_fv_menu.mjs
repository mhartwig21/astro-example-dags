// FINAL VERIFICATION — surface (b): THE MAIN MENU. One browser, closed at the end.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=d3d11", "--force_high_performance_gpu"],
});
const results = {};
for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(`${BASE}?eagerassets`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
  // The boot splash (#loading, z29) sits over the menu until the audio bank
  // settles. Wait for it to be GONE — a screenshot of the splash is not a
  // screenshot of the menu.
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (l && getComputedStyle(l).display !== "none" && +getComputedStyle(l).opacity > 0.02) return false;
    const m = document.getElementById("menu");
    return !!m && getComputedStyle(m).display !== "none" && m.getBoundingClientRect().height > 100;
  }, { timeout: 180000 });
  await page.waitForTimeout(3000);

  const m = await page.evaluate(() => {
    const out = { buttons: [], tokens: {}, viewport: { w: innerWidth, h: innerHeight } };
    const menu = document.getElementById("menu");
    const tiles = menu?.querySelector(".m-tiles");
    if (tiles) {
      const cs = getComputedStyle(tiles);
      for (const k of ["--hero-h", "--pri-h", "--pri-title", "--pri-cut", "--pri-prow"]) {
        out.tokens[k] = cs.getPropertyValue(k).trim();
      }
    }
    // Every top-level clickable plate in the menu's command stack.
    const sel = ".m-primary, .m-mode, .m-featured, .m-foot button, .m-tiles button, .m-tiles a";
    const seen = new Set();
    for (const el of menu.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const title = el.querySelector("b") || el.querySelector(".m-mode-t") || el;
      const tcs = getComputedStyle(title);
      out.buttons.push({
        cls: el.className,
        id: el.id || null,
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
        h: +r.height.toFixed(1),
        w: +r.width.toFixed(1),
        area: Math.round(r.width * r.height),
        titleFont: +parseFloat(tcs.fontSize).toFixed(2),
        titleText: (title.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30),
      });
    }
    return out;
  });
  results[`${vp.width}x${vp.height}`] = m;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/menu-${vp.width}.png`, Buffer.from(data, "base64"));
  await page.close();
}
writeFileSync(`${OUT}/menu.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
