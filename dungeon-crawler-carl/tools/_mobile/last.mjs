// Last three measurements: the cancel band vs the movement stick zone (from
// the live DOM, since window.__dcc does not publish the zone table), the safe
// room's ABILITIES tab clip, and the recap's overflow.
import { chromium, devices } from "playwright";

const BASE = (process.argv[2] || "http://localhost:5420").replace(/\/$/, "");
const T = "test&debug=1&abilities=all&eagerassets&quality=performance";
const D = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,0,0" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0" },
};
function touchDriver(client) {
  const live = new Map();
  const pts = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: pts(), timestamp: clock });
  return { async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { live.set(id, { x, y }); await send("touchMove"); },
    async up(id) { live.delete(id); await send("touchEnd"); } };
}
const ready = async (page) => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || getComputedStyle(l).display === "none" || +getComputedStyle(l).opacity === 0; }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1800);
};
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });

for (const dn of Object.keys(D)) {
  const ctx = await browser.newContext({ ...devices[D[dn].pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?${T}&floor=3&level=14&seed=21&safe=${D[dn].safe}`, { waitUntil: "load", timeout: 180000 });
  await ready(page);
  // press a chip and drag past the slop so the band paints, then read both rects
  const c = await page.evaluate(() => { const e = document.querySelector('#skills .skill[data-i="2"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
  await touch.down(1, c.x, c.y);
  for (let i = 1; i <= 10; i++) { await touch.move(1, c.x - i * 14, c.y - i * 8); await page.waitForTimeout(35); }
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const R = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), op: +(+getComputedStyle(e).opacity).toFixed(2) }; };
    return { band: R("t-cancel"), zone: R("t-stickzone"), tut: R("tutorial"), vp: { w: innerWidth, h: innerHeight } };
  });
  await touch.up(1);
  const I = (a, b) => { if (!a || !b) return 0; const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)); const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); return Math.round(x * y); };
  const ba = g.band ? g.band.w * g.band.h : 0;
  console.log(`${dn} CANCEL BAND ${JSON.stringify(g.band)}  STICK ZONE ${JSON.stringify(g.zone)}  -> ${I(g.band, g.zone)}/${ba} px2 = ${ba ? Math.round(I(g.band, g.zone) / ba * 100) : "?"}% of the band is inside the movement thumb's zone`);
  await ctx.close();
}
await browser.close();
