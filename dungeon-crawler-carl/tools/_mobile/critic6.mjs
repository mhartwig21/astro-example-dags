// Multi-touch, driven correctly. The repo's touchDriver re-sends every live
// point on touchStart, and Chromium responds by ENDING the first finger and
// re-creating it (observed: pointerup#5 immediately after pointerdown#6). This
// driver keeps one authoritative point list and never reuses an id.
import { chromium, devices } from "playwright";
import { DEVICE_SPECS } from "../mobileshot.mjs";

const BASE = "http://localhost:5420";
const devKey = process.argv[2] || "iphone13-land";
const spec = DEVICE_SPECS[devKey];
const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=21&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;

function driver(client) {
  const live = new Map();
  let clock = Date.now() / 1000;
  const all = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  const send = (type, pts) => client.send("Input.dispatchTouchEvent", { type, touchPoints: pts, timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart", all()); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove", all()); },
    async up(id) { const p = live.get(id); live.delete(id); await send("touchEnd", p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : []); },
  };
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw] });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = driver(client);
await page.addInitScript(() => {
  window.__ev = [];
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) window.addEventListener(t, (e) => { window.__ev.push(`${t}#${e.pointerId}@${Math.round(e.clientX)},${Math.round(e.clientY)}`); }, true);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true; const cs = getComputedStyle(l); return cs.display === "none" || +cs.opacity === 0; }, null, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => !!document.querySelector('#skills .skill[data-i="3"]'), null, { timeout: 120000 });
await page.waitForTimeout(1500);

const V = page.viewportSize();
const settle = async (n = 4) => { await page.waitForTimeout(80); await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {}); };
const pos = () => page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
const cds = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.state.players[0].cd || {})));
await page.evaluate(() => { const s = window.__dcc.state; for (const m of s.monsters) m.hp = 0; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; s.status = "playing"; for (const k of Object.keys(p.cd || {})) p.cd[k] = 0; let best = null; for (const r of (s.map.rooms || [])) if (!best || r.w * r.h > best.w * best.h) best = r; if (best) { p.pos.x = best.x + best.w / 2; p.pos.y = best.y + best.h / 2; } window.__keep = setInterval(() => { const q = window.__dcc.state.players[0]; q.hp = q.maxHp; q.alive = true; window.__dcc.state.status = "playing"; }, 150); });

const sx = Math.round(V.width * 0.2), sy = Math.round(V.height * 0.6);
const c = await page.evaluate(() => { const e = document.querySelector('#skills .skill[data-i="3"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });

await page.evaluate(() => { window.__ev = []; });
const p0 = await pos();
await touch.down(1, sx, sy);
for (let i = 0; i < 10; i++) { touch.tick(16); await touch.move(1, sx + 60 + (i % 2), sy); await settle(2); }
const p1 = await pos();
console.log("phase 1 walk alone:", Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(2), "tiles");

const park = () => page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; let best = null; for (const r of (s.map.rooms || [])) if (!best || r.w * r.h > best.w * best.h) best = r; if (best) { p.pos.x = best.x + best.w / 2; p.pos.y = best.y + best.h / 2; } return { ...p.pos }; });
await park();
const pp = await pos();
const cd0 = await cds();
await touch.down(2, c.x, c.y);
for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(2, c.x, c.y - i * 10); await touch.move(1, sx + 60 + (i % 2), sy); await settle(2); }
const p2 = await pos();
console.log("phase 2 (re-parked first):", Math.hypot(p2.x - pp.x, p2.y - pp.y).toFixed(2), "tiles from the park point");
console.log("phase 2 walk WHILE aim-dragging:", Math.hypot(p2.x - p1.x, p2.y - p1.y).toFixed(2), "tiles");
await touch.up(2);
await settle(8);
const cd1 = await cds();
console.log("aimed cast fired:", Object.keys(cd1).filter((k) => (cd1[k] || 0) > (cd0[k] || 0)).join(",") || "NONE");
const pp3 = await park();
for (let i = 0; i < 8; i++) { touch.tick(16); await touch.move(1, sx + 60 + (i % 2), sy); await settle(2); }
const p3 = await pos();
console.log("phase 3 walk after the chip lifts (re-parked):", Math.hypot(p3.x - pp3.x, p3.y - pp3.y).toFixed(2), "tiles");
await touch.up(1);
console.log("events:\n" + (await page.evaluate(() => window.__ev.slice(0, 8).concat(["..."], window.__ev.slice(-14)))).join("\n"));
await browser.close();
