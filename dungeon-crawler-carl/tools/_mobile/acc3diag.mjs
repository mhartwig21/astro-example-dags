// Why is body.modal up during play? Poll the authority for 25 s with no input.
import { chromium, devices } from "playwright";
const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=16&gold=9000&seed=77&safe=0,47,21,47`, { waitUntil: "load", timeout: 180000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
for (let i = 0; i < 14; i++) {
  const s = await page.evaluate(() => {
    const open = [];
    for (const e of document.querySelectorAll("[data-overlay], #loading, #rotate, #banner, #tutorial, #draft, #recap, #consent, #menu")) {
      const st = getComputedStyle(e), r = e.getBoundingClientRect();
      if (st.display === "none" || st.visibility === "hidden" || r.width < 2) continue;
      open.push(`${e.id || e.className}[${Math.round(r.width)}x${Math.round(r.height)} op${(+st.opacity).toFixed(2)} ov=${e.dataset.overlay ?? "-"}]`);
    }
    return {
      body: document.body.className,
      reasons: window.__dcc.touch.suspendReasons ? window.__dcc.touch.suspendReasons() : "n/a",
      status: window.__dcc.state.status,
      layer: getComputedStyle(document.getElementById("t-layer")).display,
      open,
    };
  });
  console.log(i, JSON.stringify(s));
  await page.waitForTimeout(1800);
}
await browser.close();
