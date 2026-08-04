// Layout evidence: compact (default) vs large, and the locked-slot demotion.
import { chromium, devices } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:5280";
const browser = await chromium.launch({ headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
try {
  for (const [name, url] of [
    ["compact-l3", "?test&debug=1&quality=performance&floor=1&level=3&seed=41&safe=0,47,21,47"],
    ["compact-l12", "?test&debug=1&quality=performance&floor=6&level=12&abilities=all&seed=41&safe=0,47,21,47"],
    ["large-l12", "?test&debug=1&quality=performance&floor=6&level=12&abilities=all&seed=41&safe=0,47,21,47&preset=large"],
    ["compact-touchdebug", "?test&debug=1&quality=performance&floor=6&level=12&abilities=all&seed=41&safe=0,47,21,47&touchdebug=1"],
  ]) {
    const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/iso.html${url}&eagerassets`, { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
    await page.waitForFunction(() => {
      const l = document.getElementById("loading");
      if (!l) return true;
      const cs = getComputedStyle(l);
      return cs.display === "none" || +cs.opacity === 0 || l.classList.contains("done");
    }, null, { timeout: 240000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (url.includes("preset=large")) {
      await page.evaluate(() => { window.__dcc.touch.prefs.preset = "large"; window.__dcc.touch.relayout(); });
      await page.waitForTimeout(600);
    }
    if (name === "compact-touchdebug") {
      const client = await ctx.newCDPSession(page);
      const z = await page.evaluate(() => window.__dcc.touch.zones);
      const pts = [
        { x: Math.round(z.stickAnchor.x), y: Math.round(z.stickAnchor.y), id: 1, radiusX: 12, radiusY: 12, force: 1 },
        { x: Math.round(z.controls.slot2.cx), y: Math.round(z.controls.slot2.cy), id: 2, radiusX: 12, radiusY: 12, force: 1 },
      ];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pts[0]] });
      await page.waitForTimeout(120);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts });
      await page.waitForTimeout(350);
      await page.screenshot({ path: `tools/_mobile/compact-r1/${name}.png` });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [pts[1]] });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [pts[0]] });
    } else {
      await page.screenshot({ path: `tools/_mobile/compact-r1/${name}.png` });
    }
    await ctx.close();
  }
} finally { await browser.close(); }
