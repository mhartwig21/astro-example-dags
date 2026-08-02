// Nail the two-finger question: is "walk while the other thumb aims" a game bug
// or a harness artefact? Log every pointer event the PAGE receives.
import { chromium, devices } from "playwright";
import { touchDriver, DEVICE_SPECS } from "../mobileshot.mjs";

const BASE = "http://localhost:5420";
const devKey = process.argv[2] || "iphone13-land";
const spec = DEVICE_SPECS[devKey];
const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=21&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw] });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = touchDriver(client);
await page.addInitScript(() => {
  window.__ev = [];
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    window.addEventListener(t, (e) => { window.__ev.push(`${t}#${e.pointerId}@${Math.round(e.clientX)},${Math.round(e.clientY)}`); }, true);
  }
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true; const cs = getComputedStyle(l); return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0; }, null, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => !!document.querySelector('#skills .skill[data-i="3"]'), null, { timeout: 120000 });
await page.waitForTimeout(2000);
const V = page.viewportSize();
const settle = async (n = 4) => { await page.waitForTimeout(80); await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {}); };
await page.evaluate(() => { const s = window.__dcc.state; for (const m of s.monsters) m.hp = 0; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; s.status = "playing"; let best = null; for (const r of (s.map.rooms || [])) if (!best || r.w * r.h > best.w * best.h) best = r; if (best) { p.pos.x = best.x + best.w / 2; p.pos.y = best.y + best.h / 2; } });

const pos = () => page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
const mv = () => page.evaluate(() => { const t = window.__dcc.touch; return { zones: !!t.zones }; });
const sx = Math.round(V.width * 0.2), sy = Math.round(V.height * 0.6);
const c = await page.evaluate(() => { const e = document.querySelector('#skills .skill[data-i="3"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });

// PHASE 1: walk alone for 10 steps
await page.evaluate(() => { window.__ev = []; });
const p0 = await pos();
await touch.down(1, sx, sy);
for (let i = 0; i < 10; i++) { touch.tick(16); await touch.move(1, sx + 60, sy); await settle(2); }
const p1 = await pos();
console.log("phase 1 (walk alone):", Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(2), "tiles");

// PHASE 2: second finger presses the chip and DRAGS, first finger keeps pushing
await touch.down(2, c.x, c.y);
for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(2, c.x, c.y - i * 10); await touch.move(1, sx + 60, sy); await settle(2); }
const p2 = await pos();
console.log("phase 2 (walk + aim drag):", Math.hypot(p2.x - p1.x, p2.y - p1.y).toFixed(2), "tiles");
const evs = await page.evaluate(() => window.__ev.slice(-40));
console.log("last 40 pointer events:\n" + evs.join("\n"));
const st = await page.evaluate(() => { const t = window.__dcc.touch; return { reasons: t.suspendReasons ? t.suspendReasons() : null }; });
console.log("suspend reasons:", JSON.stringify(st));

// PHASE 3: release the chip, keep walking
await touch.up(2);
await settle(6);
const p3a = await pos();
for (let i = 0; i < 10; i++) { touch.tick(16); await touch.move(1, sx + 60, sy); await settle(2); }
const p3 = await pos();
console.log("phase 3 (after the chip lifts, finger 1 still down):", Math.hypot(p3.x - p3a.x, p3.y - p3a.y).toFixed(2), "tiles");
await touch.up(1);

// PHASE 4: control — second finger TAPS (no drag), as the author's battery does
await page.evaluate(() => { window.__ev = []; const p = window.__dcc.state.players[0]; p.hp = p.maxHp; });
await touch.down(1, sx, sy);
for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, sx + 60, sy); await settle(2); }
const q0 = await pos();
await touch.down(2, c.x, c.y);
touch.tick(90); await page.waitForTimeout(90);
await touch.up(2);
for (let i = 0; i < 10; i++) { touch.tick(16); await touch.move(1, sx + 60, sy); await settle(2); }
const q1 = await pos();
await touch.up(1);
console.log("phase 4 (walk + chip TAP):", Math.hypot(q1.x - q0.x, q1.y - q0.y).toFixed(2), "tiles");
const evs2 = await page.evaluate(() => window.__ev.slice(0, 20));
console.log("first 20 events of phase 4:\n" + evs2.join("\n"));
await browser.close();
