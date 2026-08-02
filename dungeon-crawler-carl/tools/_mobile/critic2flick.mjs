// Does flick-to-dash actually fire? Five profiles, real CDP touch.
import { chromium, devices } from "playwright";
const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
function td(client) {
  const live = new Map();
  const pts = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: pts(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { live.set(id, { x, y }); await send("touchMove"); },
    async up(id) { const p = live.get(id); live.delete(id); await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock }); },
  };
}
for (const dev of ["iPhone 13 landscape", "iPad Pro 11 landscape"]) {
  const ctx = await browser.newContext({ ...devices[dev], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const t = td(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const V = page.viewportSize();
  const R = await page.evaluate(() => window.__dcc.touch.zones.stickRadius);
  const clear = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.86, 0.78, 0.66]) for (const fx of [0.30, 0.22, 0.38]) {
      const x = Math.round(w * fx), y = Math.round(h * fy);
      if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") return { x, y };
    }
    return { x: Math.round(w * 0.3), y: Math.round(h * 0.86) };
  }, [V.width, V.height]);
  const settle = async (n = 6) => { await page.waitForTimeout(150); await page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n).catch(() => {}); };
  console.log(`== ${dev} R=${R} clear=${JSON.stringify(clear)} needs >= ${(12 * R).toFixed(0)} px/s and >= ${(0.25 * R).toFixed(0)} px/sample`);
  const profiles = [
    { name: "4x34px @16ms (2125 px/s)", steps: 4, px: 34, ms: 16 },
    { name: "3x60px @12ms (5000 px/s)", steps: 3, px: 60, ms: 12 },
    { name: "6x25px @8ms (3125 px/s)", steps: 6, px: 25, ms: 8 },
    { name: "2x90px @16ms (5625 px/s)", steps: 2, px: 90, ms: 16 },
    { name: "5x40px @16ms + real waits", steps: 5, px: 40, ms: 16, real: true },
  ];
  for (const p of profiles) {
    await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.hp = q.maxHp; q.dashCharges = 2; for (const k in q.cd) q.cd[k] = 0; });
    await settle(4);
    const a = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0, x: q.pos.x, y: q.pos.y }; });
    await t.down(1, clear.x, clear.y);
    await settle(2);
    for (let i = 1; i <= p.steps; i++) {
      t.tick(p.ms);
      await t.move(1, clear.x + i * p.px, clear.y);
      if (p.real) await new Promise((r) => setTimeout(r, p.ms));
    }
    await settle(6);
    const b = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0, x: q.pos.x, y: q.pos.y }; });
    await t.up(1);
    await settle(4);
    const c = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
    const fired = c.dc < a.dc || c.cd > a.cd;
    console.log(`  [${fired ? "DASH" : "no  "}] ${p.name} — charges ${a.dc}->${c.dc}, cd ${a.cd.toFixed(2)}->${c.cd.toFixed(2)}, crawler moved ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} tiles`);
  }
  // FALSE POSITIVE risk: ordinary fast steering
  await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.dashCharges = 2; for (const k in q.cd) q.cd[k] = 0; });
  const a2 = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
  await t.down(1, clear.x, clear.y);
  for (let i = 0; i < 24; i++) { t.tick(16); const ang = (i / 24) * Math.PI * 2; await t.move(1, clear.x + Math.cos(ang) * 55, clear.y + Math.sin(ang) * 55); await new Promise((r) => setTimeout(r, 16)); }
  await settle(6);
  await t.up(1);
  await settle(4);
  const b2 = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
  console.log(`  [${b2.dc < a2.dc || b2.cd > a2.cd ? "FALSE POSITIVE" : "clean"}] ordinary circling steer at ~215 px/s — charges ${a2.dc}->${b2.dc}`);
  await ctx.close();
}
await browser.close();
