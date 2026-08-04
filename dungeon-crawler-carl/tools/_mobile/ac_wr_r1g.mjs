// MAP chip: controlAt(centre) says null. Does a real touch tap still expand
// the minimap, and does it avoid leaking a world move/lock?
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5286";
function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 50)));
      await this.up(id);
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const dev of ["iPhone 13 landscape", "Pixel 5 landscape"]) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&abilities=all&seed=9&safe=0,47,21,47`,
      { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
    await page.waitForTimeout(4000);
    const before = await page.evaluate(() => {
      const d = window.__dcc;
      const c = d.touch.zones.controls.map;
      return { cx: Math.round(c.cx), cy: Math.round(c.cy),
        at: (() => { const e = document.elementFromPoint(c.cx, c.cy); return e ? `${e.tagName}#${e.id}` : "none"; })(),
        route: d.touch.controlAt(c.cx, c.cy),
        expanded: document.body.classList.contains("map-big") || (document.getElementById("minimap-frame")?.classList.contains("big") ?? false),
        mmW: Math.round(document.getElementById("minimap-frame")?.getBoundingClientRect().width ?? 0),
        tap: JSON.stringify(d.touch.lastWorldTap),
        pos: { ...d.state.players[0].pos } };
    });
    await touch.tap(before.cx, before.cy, 1, 100);
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => {
      const d = window.__dcc;
      return { expanded: document.body.classList.contains("map-big") || (document.getElementById("minimap-frame")?.classList.contains("big") ?? false),
        mmW: Math.round(document.getElementById("minimap-frame")?.getBoundingClientRect().width ?? 0),
        tap: JSON.stringify(d.touch.lastWorldTap),
        pos: { ...d.state.players[0].pos },
        clickTgt: d.touch.clickMoveTarget, locked: d.touch.lockedTargetId };
    });
    console.log(dev, "before:", JSON.stringify(before));
    console.log(dev, "after:", JSON.stringify(after),
      "worldLeak:", before.tap !== after.tap, "mapToggled:", before.mmW !== after.mmW || before.expanded !== after.expanded);
    await ctx.close();
  }
} finally {
  await browser.close();
}
