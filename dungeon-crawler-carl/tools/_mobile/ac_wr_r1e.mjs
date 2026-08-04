// Deeper: during the post-cast dead window, is the controller still tracking
// (nub follows finger) and what do status/body/suspend say? Then: does the
// stick recover after 8s (reaper) or on re-press much later?
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
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 8, holdMs = 28, lift = true } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (lift) await this.up(id);
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&abilities=all&seed=9&safe=0,47,21,47`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const s = window.__dcc.state;
    for (const m of s.monsters) { m.hp = 0; m.alive = false; }
  });
  const sp = await page.evaluate(() => {
    const d = window.__dcc, z = d.touch.zones;
    for (const [dx, dy] of [[0, 0], [30, -20], [-25, 15]]) {
      const x = z.stickAnchor.x + dx, y = z.stickAnchor.y + dy;
      if (d.touch.controlAt(x, y)) continue;
      const e = document.elementFromPoint(x, y);
      if (e && e.tagName === "CANVAS" && e.id !== "minimap") return { x, y };
    }
    return null;
  });
  const chip = await page.evaluate(() => {
    const r = document.querySelector('#skills .skill[data-i="1"]').getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  const snap = () => page.evaluate(() => {
    const d = window.__dcc;
    return {
      pos: { x: +d.state.players[0].pos.x.toFixed(2), y: +d.state.players[0].pos.y.toFixed(2) },
      status: d.state.status,
      body: document.body.className,
      suspend: d.touch.suspendReasons?.(),
      nub: document.getElementById("t-nub2").style.transform,
      stickOp: getComputedStyle(document.getElementById("t-stick2")).opacity,
      clickTgt: d.touch.clickMoveTarget,
    };
  });
  await touch.down(1, sp.x, sp.y);
  for (let i = 0; i < 4; i++) { touch.tick(50); await touch.move(1, sp.x + 55, sp.y - 28); await new Promise((r) => setTimeout(r, 70)); }
  console.log("pre-aim:", JSON.stringify(await snap()));
  await touch.drag(chip.cx, chip.cy, chip.cx - 115, chip.cy - 45, { id: 2, steps: 7, holdMs: 28, lift: false });
  console.log("aiming:", JSON.stringify(await snap()));
  await touch.up(2);
  for (let i = 0; i < 4; i++) {
    touch.tick(150);
    await touch.move(1, sp.x + 55 + (i % 2 ? 15 : -15), sp.y - 28 - (i % 2 ? 10 : -10));
    await new Promise((r) => setTimeout(r, 300));
    console.log(`post-cast ${i}:`, JSON.stringify(await snap()));
  }
  // hold STILL past the 8s reaper window, then wiggle again
  await new Promise((r) => setTimeout(r, 8500));
  for (let i = 0; i < 4; i++) {
    touch.tick(150);
    await touch.move(1, sp.x + 60 + (i % 2 ? 10 : -10), sp.y - 25);
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("after 8.5s + wiggle:", JSON.stringify(await snap()));
  await touch.up(1);
} finally {
  await browser.close();
}
