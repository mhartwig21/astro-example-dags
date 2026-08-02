import { chromium, devices } from "playwright";
const BASE = "http://localhost:5370";
const T = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77";
const browser = await chromium.launch();
for (const [pw, safe] of [["Pixel 5 landscape", "0,24,0,0"], ["iPhone 13 landscape", "0,47,21,47"]]) {
  const ctx = await browser.newContext({ ...devices[pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?${T}&safe=${safe}`, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll("#skills .skill").length > 0, null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  const out = await page.evaluate(() => {
    const t = window.__dcc.touch, z = t.zones;
    const rows = [];
    for (const el of document.querySelectorAll("#skills .skill")) {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      rows.push({
        id: el.id || "slot" + el.dataset.i,
        dom: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        route: t.route(cx, cy),
        elAt: (() => { const e = document.elementFromPoint(cx, cy); return e ? (e.id || e.className || e.tagName) : null; })(),
        table: z.controls["slot" + el.dataset.i] ? [Math.round(z.controls["slot" + el.dataset.i].x), Math.round(z.controls["slot" + el.dataset.i].y)] : null,
      });
    }
    return { vp: [innerWidth, innerHeight], cls: z.cls, rows,
      charges: window.__dcc.state.players[0].dashCharges,
      slots: window.__dcc.state.players[0].abilities.slots };
  });
  console.log("###", pw, JSON.stringify(out.vp), out.cls, "dashCharges=" + out.charges, JSON.stringify(out.slots));
  for (const r of out.rows) console.log("  ", r.id.padEnd(10), "dom", JSON.stringify(r.dom), "table", JSON.stringify(r.table), "route", JSON.stringify(r.route), "elAt", r.elAt);
  await ctx.close();
}
await browser.close();
