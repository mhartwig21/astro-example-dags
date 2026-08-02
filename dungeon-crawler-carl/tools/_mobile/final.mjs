// The four claims that still need a measurement rather than a screenshot.
//  1. the RESTING STICK GHOST (§2.3): is #t-stick2 actually painted at idle?
//  2. the CANCEL BAND vs the MOVEMENT STICK ZONE: how much of the band, and
//     of the stick's own resting anchor, share pixels?
//  3. the SHOP DETAIL pane on compact/phone: are there any buy controls at
//     all, and where is the price?
//  4. PORTRAIT: what does a phone player see if they hold the phone the way
//     phones are held?
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const OUT = "tools/_mobile/ac4";
mkdirSync(OUT, { recursive: true });
const T = "test&debug=1&abilities=all&eagerassets&quality=performance";
const D = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,0,0" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0" },
  iphone13: { pw: "iPhone 13", safe: "47,0,34,0" },
};
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ready = async (page) => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || getComputedStyle(l).display === "none" || +getComputedStyle(l).opacity === 0; }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1800);
};

// ---- 1 + 2 : the stick ghost and the cancel band -------------------------
for (const dn of ["iphone13-land", "pixel5-land", "ipadpro11-land"]) {
  const ctx = await browser.newContext({ ...devices[D[dn].pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?${T}&floor=3&level=14&seed=21&safe=${D[dn].safe}`, { waitUntil: "load", timeout: 180000 });
  await ready(page);
  const r = await page.evaluate(() => {
    const g = (id) => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
      return { display: cs.display, opacity: +(+cs.opacity).toFixed(3), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const z = window.__dcc && window.__dcc.zones ? window.__dcc.zones : null;
    return { stick: g("t-stick"), ghost: g("t-stick2"), zone: g("t-stickzone"), cancel: g("t-cancel"),
      zones: z ? { stickZone: z.stickZone, cancelBand: z.cancelBand, stickAnchor: z.stickAnchor, worldZone: z.worldZone, cls: z.cls, safe: z.safe } : null,
      vp: { w: innerWidth, h: innerHeight } };
  });
  const inter = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return Math.round(x * y);
  };
  const zz = r.zones;
  const ov = zz ? inter(zz.cancelBand, zz.stickZone) : 0;
  const bandArea = zz ? Math.round(zz.cancelBand.w * zz.cancelBand.h) : 0;
  const anchorInBand = zz && zz.stickAnchor && zz.cancelBand
    ? (zz.stickAnchor.x >= zz.cancelBand.x && zz.stickAnchor.x <= zz.cancelBand.x + zz.cancelBand.w &&
       zz.stickAnchor.y >= zz.cancelBand.y && zz.stickAnchor.y <= zz.cancelBand.y + zz.cancelBand.h) : "n/a";
  console.log(`${dn}  idle stick ghost: ${JSON.stringify(r.ghost)} | #t-stick ${JSON.stringify(r.stick)}`);
  console.log(`${dn}  cancelBand ${JSON.stringify(zz && zz.cancelBand)} vs stickZone ${JSON.stringify(zz && zz.stickZone)}`);
  console.log(`${dn}  -> band inside stick zone: ${ov}/${bandArea} px2 = ${bandArea ? Math.round(ov / bandArea * 100) : "?"}% ; resting stickAnchor ${JSON.stringify(zz && zz.stickAnchor)} inside band = ${anchorInBand}`);
  console.log(`${dn}  worldZone ${JSON.stringify(zz && zz.worldZone)}  vp ${r.vp.w}x${r.vp.h}`);
  await ctx.close();
}

// ---- 3 : the shop DETAIL pane on each class ------------------------------
for (const dn of ["pixel5-land", "iphone13-land", "ipadpro11-land"]) {
  const ctx = await browser.newContext({ ...devices[D[dn].pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?${T}&floor=3&level=10&seed=21&safe=${D[dn].safe}`, { waitUntil: "load", timeout: 180000 });
  await ready(page);
  await page.evaluate(() => {
    const d = window.__dcc, st = d.state, p = st.players[0];
    p.gold = (p.gold ?? 0) + 6000;
    for (const m of st.monsters) m.hp = 0;
    p.alive = true; p.hp = p.maxHp; st.status = "playing";
    p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
  });
  await page.waitForFunction(() => {
    const d = window.__dcc; if (!d || d.state.safeRoom) return true;
    d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
    return !!d.state.safeRoom;
  }, null, { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const s = await page.evaluate(() => {
      const v = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
      return { draft: v("draft"), shop: v("saferoom") };
    }).catch(() => ({}));
    if (s.shop) break;
    if (s.draft) await page.evaluate(() => { document.querySelector("#draft-cards .reward")?.click(); }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => {
    const t = document.querySelector("#sr-shelf .itile:not(.locked):not(.soldout)") ?? document.querySelector("#sr-shelf .itile");
    if (t) t.click();
  }).catch(() => {});
  await page.waitForTimeout(1500);
  const shop = await page.evaluate(() => {
    const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && b.width > 0 && b.height > 0; };
    const R = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const det = document.getElementById("sr-detail");
    const onScreen = (e) => { const b = e.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth; };
    return {
      cls: document.body.dataset.uiclass,
      vp: { w: innerWidth, h: innerHeight },
      detail: det ? R(det) : null,
      detailScroll: det ? { sx: det.scrollWidth - det.clientWidth, sy: det.scrollHeight - det.clientHeight } : null,
      detailVisibleChildren: det ? [...det.querySelectorAll("*")].filter(vis).filter(onScreen)
        .map((e) => ({ t: (e.className && typeof e.className === "string" ? e.className.split(" ")[0] : e.tagName), txt: (e.textContent || "").trim().slice(0, 24), ...R(e) })).slice(0, 14) : null,
      buyButtons: [...document.querySelectorAll("#sr-detail button, #sr-shelf button")].filter(vis)
        .map((b) => ({ t: b.textContent.trim().slice(0, 12), ...R(b), onScreen: onScreen(b) })),
      descend: (() => { const d = document.getElementById("sr-descend"); return d && vis(d) ? R(d) : null; })(),
      segOn: [...document.querySelectorAll("#saferoom .tp-seg button")].map((b) => b.textContent.trim() + (b.classList.contains("on") ? "*" : "")),
    };
  });
  console.log(`${dn}  SHOP: ${JSON.stringify(shop, null, 0)}`);
  await page.screenshot({ path: join(OUT, `${dn}-shopdetail.png`), timeout: 180000 });
  await ctx.close();
}

// ---- 4 : portrait --------------------------------------------------------
{
  const ctx = await browser.newContext({ ...devices[D.iphone13.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?${T}&floor=3&level=14&seed=21&safe=${D.iphone13.safe}`, { waitUntil: "load", timeout: 180000 });
  await ready(page);
  const p = await page.evaluate(() => {
    const g = (id) => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
      return { display: cs.display, opacity: +cs.opacity, w: Math.round(b.width), h: Math.round(b.height) }; };
    return { rotate: g("rotate"), body: document.body.className, uiclass: document.body.dataset.uiclass, vp: { w: innerWidth, h: innerHeight },
      rotateText: (document.getElementById("rotate") || {}).textContent };
  });
  console.log(`iphone13 PORTRAIT: ${JSON.stringify(p)}`);
  await page.screenshot({ path: join(OUT, "iphone13-portrait-combat.png"), timeout: 180000 });
  await ctx.close();
}
await browser.close();
