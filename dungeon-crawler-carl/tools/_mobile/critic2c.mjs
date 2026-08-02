// Part C: is the CRAWLER visible? plus cluster/HUD footprint per device, and
// the readability of the thing you are actually controlling.
import { chromium, devices } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const OUT = "tools/_mobile/c2c";
mkdirSync(OUT, { recursive: true });
const SPECS = {
  "iphone13-land": "iPhone 13 landscape",
  "iphone13promax-land": "iPhone 13 Pro Max landscape",
  "ipadpro11-land": "iPad Pro 11 landscape",
  "pixel5-land": "Pixel 5 landscape",
};
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const rep = [];
for (const [name, pw] of Object.entries(SPECS)) {
  const ctx = await browser.newContext({ ...devices[pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const d = window.__dcc, st = d.state, p = st.players[0], rr = d.renderer;
    const q = rr.worldToScreen(p.pos.x, 0.9, p.pos.y); const me = { x: Math.round(q.x), y: Math.round(q.y), vis: q.visible };
    const chipRects = [...document.querySelectorAll("#skills .skill, #flask-chip, #t-lock, #t-map, #t-stairs")]
      .map((e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display === "none" || !b.width ? null : { id: e.id || e.dataset.i, x: b.x, y: b.y, w: b.width, h: b.height }; }).filter(Boolean);
    const hudIds = ["cockpit", "hud-tl", "hud-tr", "skills", "banner", "show", "xpbar", "bossbar", "minimap-frame", "party"];
    const hudRects = hudIds.map((id) => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); if (cs.display === "none" || +cs.opacity === 0) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { id, x: b.x, y: b.y, w: b.width, h: b.height } : null; }).filter(Boolean);
    const inAny = (rs, x, y, pad = 0) => rs.some((q2) => x >= q2.x - pad && x <= q2.x + q2.w + pad && y >= q2.y - pad && y <= q2.y + q2.h + pad);
    // Crawler under a chip? Also: how much clear world is left?
    const hudArea = hudRects.reduce((a, b) => a + b.w * b.h, 0);
    const clusterArea = chipRects.reduce((a, b) => a + b.w * b.h, 0);
    const cl = chipRects.length ? {
      x0: Math.min(...chipRects.map((c) => c.x)), y0: Math.min(...chipRects.map((c) => c.y)),
      x1: Math.max(...chipRects.map((c) => c.x + c.w)), y1: Math.max(...chipRects.map((c) => c.y + c.h)),
    } : null;
    const z = d.touch.zones;
    return {
      vw: innerWidth, vh: innerHeight,
      crawler: me, crawlerUnderChip: inAny(chipRects, me.x, me.y),
      crawlerInClusterBox: !!cl && me.x >= cl.x0 && me.x <= cl.x1 && me.y >= cl.y0 && me.y <= cl.y1,
      crawlerUnderHud: inAny(hudRects, me.x, me.y),
      chips: chipRects.map((c) => ({ id: c.id, w: Math.round(c.w), h: Math.round(c.h), x: Math.round(c.x), y: Math.round(c.y) })),
      clusterBox: cl && { w: Math.round(cl.x1 - cl.x0), h: Math.round(cl.y1 - cl.y0), x: Math.round(cl.x0), y: Math.round(cl.y0), pctW: +((cl.x1 - cl.x0) / innerWidth * 100).toFixed(1), pctH: +((cl.y1 - cl.y0) / innerHeight * 100).toFixed(1) },
      hudPct: +(hudArea / (innerWidth * innerHeight) * 100).toFixed(1),
      chipInkPct: +(clusterArea / (innerWidth * innerHeight) * 100).toFixed(1),
      zones: { stick: z.stickZone, world: z.worldZone, cancelMode: z.cancelMode, aimThrow: Math.round(z.aimThrow), cancelRadius: Math.round(z.cancelRadius), stickRadius: Math.round(z.stickRadius) },
      cls: z.cls ?? null,
      // Where the camera puts you: how many CSS px of world are above/below you
      headroom: { above: Math.round(me.y), below: Math.round(innerHeight - me.y), left: Math.round(me.x), right: Math.round(innerWidth - me.x) },
    };
  });
  console.log(name, JSON.stringify(r, null, 1));
  rep.push({ device: name, ...r });
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await ctx.close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(rep, null, 2));
await browser.close();
