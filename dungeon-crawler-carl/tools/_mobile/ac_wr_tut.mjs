// Is the tutorial/onramp card clipped on compact? Measure text overflow and
// the GOT IT button's hit-testability on Pixel 5 + iPhone 13.
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5286";
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, dev, safe] of [["pixel5", "Pixel 5 landscape", "0,24,24,0"], ["iphone13", "iPhone 13 landscape", "0,47,21,47"]]) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&abilities=all&seed=9&safe=${safe}`,
      { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
    await page.waitForTimeout(5000);
    const m = await page.evaluate(() => {
      const t = document.getElementById("tutorial");
      if (!t || getComputedStyle(t).display === "none") return { visible: false };
      const r = t.getBoundingClientRect();
      const body = t.querySelector(".tut-body, .tut-text, p, div:not(.tut-head)");
      const btn = t.querySelector("button");
      const br = btn ? btn.getBoundingClientRect() : null;
      const at = br ? document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2) : null;
      const clipped = [...t.querySelectorAll("*")].some((e) => e.scrollHeight > e.clientHeight + 4);
      return { visible: true, card: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        cardScroll: { sh: t.scrollHeight, ch: t.clientHeight },
        anyClipped: clipped,
        text: (t.textContent ?? "").slice(0, 90),
        gotIt: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height),
          onGlass: br.y >= 0 && br.y + br.height <= innerHeight && br.x >= 0 && br.x + br.width <= innerWidth,
          hit: !!at && (at === btn || btn.contains(at)) } : null };
    });
    console.log(name, JSON.stringify(m));
    await ctx.close();
  }
} finally {
  await browser.close();
}
