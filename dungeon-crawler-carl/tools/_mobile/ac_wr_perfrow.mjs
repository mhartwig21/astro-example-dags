// Perf-mode row on Pixel 5, with settled scroll drags and one retry allowance.
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
    async tap(x, y, id = 1, holdMs = 100) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 60)));
      await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 8, holdMs = 24, lift = true, settle = true } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (settle) { this.tick(240); await this.move(id, tx, ty); await new Promise((r) => setTimeout(r, 220)); }
      if (lift) await this.up(id);
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["Pixel 5 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=5&seed=9&safe=0,24,24,0`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(4000);
  const hit = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return { ok: false };
    const r = e.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return { ok: !!at && (at === e || e.contains(at)), cx: Math.round(cx), cy: Math.round(cy),
      on: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
  }, sel);
  const tb = await hit("#tb-system");
  await touch.tap(tb.cx, tb.cy, 1, 110);
  await page.waitForTimeout(500);
  const krow = await page.evaluate(() => {
    const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
    const b = r.getBoundingClientRect();
    return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
  });
  await touch.tap(krow.cx, krow.cy, 1, 110);
  await page.waitForTimeout(700);
  const opts = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".kb-tabs button")].find((x) => x.textContent.includes("OPTIONS"));
    const r = b.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  });
  await touch.tap(opts.cx, opts.cy);
  await page.waitForTimeout(400);
  let pm = await hit("#kb-perfmode");
  for (let i = 0; i < 6 && !(pm.on && pm.ok); i++) {
    const mid = await page.evaluate(() => {
      const p = document.querySelector("#keys .panel");
      const r = p.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width / 2), cy: Math.round(Math.min(r.y + r.height - 30, innerHeight - 40)) };
    });
    await touch.drag(mid.cx, mid.cy, mid.cx, Math.max(60, mid.cy - 150), { steps: 8, holdMs: 24, settle: true });
    await page.waitForTimeout(400);
    pm = await hit("#kb-perfmode");
  }
  console.log("perf row:", JSON.stringify(pm));
  const before = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
  let after = before, retried = false;
  await touch.tap(pm.cx, pm.cy);
  await page.waitForTimeout(500);
  after = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
  if (after === before) {
    retried = true;
    const pm2 = await hit("#kb-perfmode");
    await touch.tap(pm2.cx, pm2.cy);
    await page.waitForTimeout(500);
    after = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
  }
  console.log(`cycle: ${before} -> ${after} retried=${retried}`);
} finally {
  await browser.close();
}
