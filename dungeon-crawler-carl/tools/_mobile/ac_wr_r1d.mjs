// Is the post-cast stick death the PAGE's fault or the touch stream's fault?
// Count delivered pointermoves per pointerId around the cast, and test whether
// a FRESH stick press revives movement.
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
    window.__ev = [];
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      document.addEventListener(t, (e) => window.__ev.push(`${t}#${e.pointerId}`), { capture: true, passive: true });
    }
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
  await touch.down(1, sp.x, sp.y);
  for (let i = 0; i < 4; i++) { touch.tick(50); await touch.move(1, sp.x + 55, sp.y - 28); await new Promise((r) => setTimeout(r, 70)); }
  await touch.drag(chip.cx, chip.cy, chip.cx - 115, chip.cy - 45, { id: 2, steps: 7, holdMs: 28, lift: false });
  await page.evaluate(() => { window.__ev.length = 0; });
  await touch.up(2);
  // wiggle finger 1 for 1.5s
  for (let i = 0; i < 6; i++) {
    touch.tick(120);
    await touch.move(1, sp.x + 55 + (i % 2 ? 12 : -12), sp.y - 28);
    await new Promise((r) => setTimeout(r, 200));
  }
  const evs = await page.evaluate(() => window.__ev.slice());
  const pos1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  console.log("events after cast-lift:", JSON.stringify(evs));
  // fresh press: lift finger 1, press again with id 3, move
  await touch.up(1);
  await new Promise((r) => setTimeout(r, 300));
  await touch.down(3, sp.x, sp.y);
  for (let i = 0; i < 6; i++) { touch.tick(100); await touch.move(3, sp.x + 55, sp.y - 28); await new Promise((r) => setTimeout(r, 200)); }
  const pos2 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  await touch.up(3);
  console.log("pos after wiggle-with-old-finger:", JSON.stringify(pos1));
  console.log("pos after fresh press:", JSON.stringify(pos2),
    "delta:", Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y).toFixed(2));
} finally {
  await browser.close();
}
