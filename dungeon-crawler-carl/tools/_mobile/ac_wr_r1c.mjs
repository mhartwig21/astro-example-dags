// Post-cast stick diagnosis on iPhone 13: is the movement thumb dead after an
// aimed cast, or was that hit-stop / sampling? Empty the room first.
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
  // empty the room: no kills possible => no hit-stop
  await page.evaluate(() => {
    const s = window.__dcc.state;
    for (const m of s.monsters) { m.hp = 0; m.alive = false; }
    s.players[0].hp = s.players[0].maxHp;
  });
  await page.waitForTimeout(800);
  const z = await page.evaluate(() => window.__dcc.touch.zones);
  const sp = await page.evaluate(() => {
    const d = window.__dcc, z = d.touch.zones;
    for (const [dx, dy] of [[0, 0], [30, -20], [-25, 15], [45, 10]]) {
      const x = z.stickAnchor.x + dx, y = z.stickAnchor.y + dy;
      if (d.touch.controlAt(x, y)) continue;
      const e = document.elementFromPoint(x, y);
      if (e && e.tagName === "CANVAS" && e.id !== "minimap") return { x, y };
    }
    return null;
  });
  const chip = await page.evaluate(() => {
    const e = document.querySelector('#skills .skill[data-i="1"]');
    const r = e.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  // stick down, moving
  await touch.down(1, sp.x, sp.y);
  for (let i = 0; i < 4; i++) { touch.tick(50); await touch.move(1, sp.x + 55, sp.y - 28); await new Promise((r) => setTimeout(r, 70)); }
  const p0 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  // aim + cast with finger 2
  await touch.drag(chip.cx, chip.cy, chip.cx - 115, chip.cy - 45, { id: 2, steps: 7, holdMs: 28, lift: false });
  await new Promise((r) => setTimeout(r, 300));
  const p1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  await touch.up(2); // cast
  // keep the stick held and deflected; sample for 3s
  const samples = [];
  for (let i = 0; i < 12; i++) {
    touch.tick(120);
    await touch.move(1, sp.x + 55 + (i % 2 ? 10 : -10), sp.y - 28);
    await new Promise((r) => setTimeout(r, 250));
    samples.push(await page.evaluate(() => {
      const d = window.__dcc;
      return { x: +d.state.players[0].pos.x.toFixed(2), y: +d.state.players[0].pos.y.toFixed(2),
        stickVis: getComputedStyle(document.getElementById("t-stick2")).opacity };
    }));
  }
  await touch.up(1);
  const pEnd = samples[samples.length - 1];
  console.log("preAim -> mid:", JSON.stringify(p0), JSON.stringify(p1));
  console.log("post-cast samples:", JSON.stringify(samples));
  console.log("post-cast distance:", Math.hypot(pEnd.x - p1.x, pEnd.y - p1.y).toFixed(2));
} finally {
  await browser.close();
}
