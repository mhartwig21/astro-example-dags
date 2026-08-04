// Micro-probe: the sharesheet on iPhone 13 — is it scrollable/escapable by touch?
import { chromium, devices } from "playwright";
const BASE = "http://localhost:5286";
const rec = (n, v, det) => console.log(`[${v}] iphone13-land :: ${n} — ${det}`);

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
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, 50)); await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 26 } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      await this.up(id);
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=0,47,21,47`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
    if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
    p.hp = Math.min(p.hp, 40);
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const share = await page.evaluate(() => {
    const r = document.getElementById("recap-share").getBoundingClientRect();
    const el = document.getElementById("recap-share");
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), hit: !!at && (at === el || el.contains(at)) };
  });
  await touch.tap(share.cx, share.cy);
  await page.waitForTimeout(800);
  const open = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
  rec("sheet opens", open ? "PASS" : "FAIL", JSON.stringify(share));
  if (open) {
    const g = await page.evaluate(() => {
      const sh = document.getElementById("sharesheet");
      const panel = sh.querySelector(".panel") ?? sh;
      const cs = getComputedStyle(panel);
      const b = document.getElementById("share-copy").getBoundingClientRect();
      return { overflowY: cs.overflowY, scrollH: panel.scrollHeight, clientH: panel.clientHeight,
        copyY: Math.round(b.y), vh: innerHeight, panelTag: panel.id || panel.className };
    });
    rec("sheet geometry", "INFO", JSON.stringify(g));
    await touch.drag(375, 280, 375, 60, { steps: 8, holdMs: 30 });
    await page.waitForTimeout(500);
    const copy = await page.evaluate(() => {
      const el = document.getElementById("share-copy");
      const b = el.getBoundingClientRect();
      const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { y: Math.round(b.y), reachable: b.top >= 0 && b.bottom <= innerHeight && !!at && (at === el || el.contains(at)) };
    });
    rec("drag brings COPY reachable", copy.reachable ? "PASS" : "FAIL", JSON.stringify(copy));
    await touch.tap(40, 40); // backdrop
    await page.waitForTimeout(500);
    const still = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
    rec("backdrop tap closes", still ? "FAIL" : "PASS", `still open=${still}`);
    if (still) {
      // swipe down on the sheet header
      await touch.drag(375, 60, 375, 300, { steps: 8, holdMs: 30 });
      await page.waitForTimeout(500);
      const still2 = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
      rec("swipe-down closes", still2 ? "FAIL" : "PASS", `still open=${still2}`);
    }
  }
} finally {
  await browser.close();
}
