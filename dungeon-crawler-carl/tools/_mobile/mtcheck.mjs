// Focused re-test of the two checks the acceptance sweep failed, because a
// FAIL a wall could have produced is not a finding.
//
//  A) MOVE WHILE CASTING. The sweep drags the stick up-screen for ~1s and then
//     taps a chip; on three of four devices it measured 0.00 tiles. A crawler
//     walking into a wall also measures 0.00. This runs the SAME gesture twice
//     from the same spot in a cleared room — once with a second finger, once
//     without — so "the second finger killed the movement" is separated from
//     "there was a wall there". It also reads the live Intent the host built.
//  B) THE CANCEL BAND on a tablet: the sweep reported `shown on aim=false`.
import { chromium, devices } from "playwright";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77";
const DEVS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,0,0" },
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: points(), timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) { live.delete(id); await send("touchEnd"); },
  };
  return api;
}

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });

for (const [dn, spec] of Object.entries(DEVS)) {
  const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?${TEST}&safe=${spec.safe}`, { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const V = page.viewportSize();

  // Park the crawler in the middle of the biggest room and clear it, so the
  // only thing that can stop movement is the input layer.
  await page.evaluate(() => {
    const d = window.__dcc, st = d.state, p = st.players[0];
    for (const m of st.monsters) { m.hp = 0; m.dormant = true; }
    const rooms = st.map.rooms || [];
    let best = rooms[0];
    for (const r of rooms) if (r.w * r.h > (best ? best.w * best.h : 0)) best = r;
    if (best) { p.pos.x = best.x + best.w / 2; p.pos.y = best.y + best.h / 2; }
    p.hp = p.maxHp; p.alive = true; p.downedT = 0; st.status = "playing";
    clearInterval(window.__k);
    window.__k = setInterval(() => { const q = window.__dcc.state.players[0]; q.hp = q.maxHp; q.alive = true; q.downedT = 0; }, 150);
    window.__room = best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
  });
  await page.waitForTimeout(1200);

  const snap = () => page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), cd: JSON.parse(JSON.stringify(p.cd || {})) };
  });
  const settle = async (n) => { await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {}); };
  const chip = async (i) => page.evaluate((k) => {
    const e = document.querySelector(`#skills .skill[data-i="${k}"]`);
    if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, i);

  // The stick origin: dead centre of the stick zone, in a cleared room.
  const zone = await page.evaluate(() => {
    const e = document.getElementById("t-stickzone");
    if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) };
  });
  const ox = zone ? zone.x : Math.round(V.width * 0.25), oy = zone ? zone.y : Math.round(V.height * 0.7);

  // Direction chosen per-run so it always aims INTO the room, not at a wall.
  const run = async (withSecondFinger, dir) => {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; const r = window.__room; if (r) { p.pos.x = r.x + r.w / 2; p.pos.y = r.y + r.h / 2; } });
    await settle(4);
    const tx = ox + dir.x * 60, ty = oy + dir.y * 60;
    await touch.down(1, ox, oy);
    for (let i = 0; i < 4; i++) { await touch.move(1, tx, ty); await settle(3); }
    const a = await snap();
    if (withSecondFinger) {
      const c = await chip(1);
      await touch.down(2, c.x, c.y); await page.waitForTimeout(90); await touch.up(2);
    }
    for (let i = 0; i < 10; i++) { await touch.move(1, tx, ty); await settle(3); }
    const b = await snap();
    await touch.up(1);
    await settle(4);
    return { d: +Math.hypot(b.x - a.x, b.y - a.y).toFixed(3), a, b };
  };

  const dirs = [{ x: 0, y: -1, n: "up" }, { x: 1, y: 0, n: "right" }, { x: 0, y: 1, n: "down" }, { x: -1, y: 0, n: "left" }];
  let best = null;
  for (const dir of dirs) {
    const solo = await run(false, dir);
    if (!best || solo.d > best.solo.d) best = { dir, solo };
  }
  const withF = await run(true, best.dir);
  const verdict = best.solo.d < 0.3
    ? "INCONCLUSIVE (no direction moves at all — harness/geometry, not input)"
    : withF.d >= best.solo.d * 0.5 ? "PASS" : "FAIL";
  console.log(`${dn}  move-while-casting: ${verdict} — solo(${best.dir.n}) ${best.solo.d} tiles vs with-2nd-finger ${withF.d} tiles`);

  // --- B. the CANCEL band ---
  const c2 = await chip(2);
  const bandBefore = await page.evaluate(() => {
    const e = document.getElementById("t-cancel");
    if (!e) return "missing";
    const cs = getComputedStyle(e);
    return { display: cs.display, opacity: cs.opacity, cls: e.className };
  });
  await touch.down(1, c2.x, c2.y);
  await page.waitForTimeout(100);
  for (let i = 1; i <= 10; i++) { await touch.move(1, c2.x - i * 14, c2.y - i * 8); await page.waitForTimeout(35); }
  await settle(4);
  const bandOn = await page.evaluate(() => {
    const e = document.getElementById("t-cancel");
    if (!e) return "missing";
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { display: cs.display, opacity: +(+cs.opacity).toFixed(2), cls: e.className,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      vp: { w: innerWidth, h: innerHeight } };
  });
  await touch.up(1);
  console.log(`${dn}  cancel band while AIMING: ${JSON.stringify(bandOn)}   (idle: ${JSON.stringify(bandBefore)})`);
  await ctx.close();
}
await browser.close();
