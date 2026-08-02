// CRITIC ROUND 2, part E — CAN YOU SEE WHERE YOUR ABILITY IS GOING?
// For every ability slot and four aim directions, project the live telegraph
// and measure how much of it is inside the viewport. A telegraph that leaves
// the frame is a telegraph the player cannot read.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const OUT = "tools/_mobile/c2e";
const SPECS = {
  "iphone13-land": "iPhone 13 landscape",
  "iphone13promax-land": "iPhone 13 Pro Max landscape",
  "ipadpro11-land": "iPad Pro 11 landscape",
  "pixel5-land": "Pixel 5 landscape",
};
function td(client) {
  const live = new Map();
  const pts = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: pts(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) { const p = live.get(id); live.delete(id); await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock }); },
  };
}
const PROJ = () => {
  const d = window.__dcc, r = d.renderer, ind = r.aimIndicator;
  if (!ind || !ind.visible) return null;
  const cam = r.camera;
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0, inside = 0;
  const names = [];
  const walk = (o) => {
    o.updateWorldMatrix(true, true);
    o.traverse((q) => {
      if (!q.visible) return;
      const g = q.geometry; if (!g || !g.attributes || !g.attributes.position) return;
      const pos = g.attributes.position, e = q.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
        const wx = e[0] * vx + e[4] * vy + e[8] * vz + e[12];
        const wy = e[1] * vx + e[5] * vy + e[9] * vz + e[13];
        const wz = e[2] * vx + e[6] * vy + e[10] * vz + e[14];
        const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
        const sx = ((m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw * 0.5 + 0.5) * innerWidth;
        const sy = (-(m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw * 0.5 + 0.5) * innerHeight;
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        n++;
        if (sx >= 0 && sx <= innerWidth && sy >= 0 && sy <= innerHeight) inside++;
      }
    });
  };
  for (const c of ind.children) if (c.visible) { names.push(c.name || c.type); walk(c); }
  if (!n) return { verts: 0 };
  // the outermost point of the telegraph, relative to the crawler on screen
  const p = d.state.players[0];
  const s = r.worldToScreen(p.pos.x, 0, p.pos.y); const me = { x: Math.round(s.x), y: Math.round(s.y) };
  return {
    verts: n, insidePct: +(inside / n * 100).toFixed(1), shapes: names,
    box: { x0: Math.round(minX), y0: Math.round(minY), x1: Math.round(maxX), y1: Math.round(maxY) },
    me, vw: innerWidth, vh: innerHeight,
  };
};
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const rep = [];
const devs = (process.argv.includes("--devices") ? process.argv[process.argv.indexOf("--devices") + 1] : Object.keys(SPECS).join(",")).split(",");
for (const name of devs) {
  const ctx = await browser.newContext({ ...devices[SPECS[name]], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const t = td(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForFunction(() => { const c = document.querySelector("#skills .skill"); if (!c) return false; const b = c.getBoundingClientRect(); return b.width > 20 && +getComputedStyle(c).opacity > 0.6; }, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const settle = async (k = 4) => { await page.waitForTimeout(120); await page.evaluate((q) => new Promise((r) => { let i = 0; const f = () => (++i >= q ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), k).catch(() => {}); };
  await page.evaluate(() => { clearInterval(window.__k); window.__k = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; s.status = "playing"; for (const k in p.cd) p.cd[k] = 0; }, 150); });
  await settle(10);
  const abil = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { slots: p.abilities.slots, ult: p.abilities.ultimate }; });
  const rows = [];
  for (const slot of ["1", "2", "3", "4"]) {
    const c = await page.evaluate((k) => { const e = document.querySelector(`#skills .skill[data-i="${k}"]`); if (!e) return null; const b = e.getBoundingClientRect(); return b.width ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null; }, slot);
    if (!c) continue;
    for (const [dn, dx, dy] of [["up", 0, -1], ["down", 0, 1], ["inboard", -1, 0], ["outboard", 1, 0]]) {
      await settle(3);
      await t.down(1, c.x, c.y);
      await settle(2);
      for (let i = 1; i <= 12; i++) { await t.move(1, c.x + dx * i * 11, c.y + dy * i * 11); await settle(1); }
      await settle(3);
      const p = await page.evaluate(PROJ);
      await t.up(1);
      await settle(4);
      rows.push({ slot, ability: slot === "4" ? abil.ult : abil.slots[+slot], dir: dn, ...(p || { verts: 0 }) });
      console.log(`  ${name} slot${slot} ${String(abil.slots[+slot] ?? abil.ult)} drag ${dn}: ${p ? `${p.shapes.join("+")} inside ${p.insidePct}% box(${p.box.x0},${p.box.y0})-(${p.box.x1},${p.box.y1}) on ${p.vw}x${p.vh}, crawler at ${p.me.x},${p.me.y}` : "NO INDICATOR"}`);
    }
  }
  rep.push({ device: name, abilities: abil, rows });
  await ctx.close();
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(rep, null, 2));
console.log("-> " + join(OUT, "report.json"));
await browser.close();
