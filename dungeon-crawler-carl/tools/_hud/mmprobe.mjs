import { chromium, devices } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices["iPad Pro 11 landscape"], hasTouch: true, isMobile: true });
const p = await ctx.newPage();
await p.goto("http://localhost:5370/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77&safe=24,0,20,0", { waitUntil: "load", timeout: 90000 });
await p.waitForFunction(() => document.querySelectorAll("#skills .skill").length > 0, null, { timeout: 300000 });
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(() => {
  const e = document.getElementById("minimap-frame");
  const cs = getComputedStyle(e);
  const r = e.getBoundingClientRect();
  const root = getComputedStyle(document.documentElement);
  return {
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    vw: innerWidth,
    right: cs.right, left: cs.left, top: cs.top, bottom: cs.bottom,
    transform: cs.transform, origin: cs.transformOrigin, position: cs.position,
    offsetW: e.offsetWidth, offsetH: e.offsetHeight,
    gutR: root.getPropertyValue("--gut-r"), saR: root.getPropertyValue("--sa-r"),
    pad: root.getPropertyValue("--hud-pad"), xpTop: root.getPropertyValue("--xp-top"),
    uiclass: document.body.dataset.uiclass,
  };
}), null, 1));
await b.close();
