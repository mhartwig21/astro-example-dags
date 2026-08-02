// Two targeted questions round 2 raised:
//  1. does the DONE bar survive a scroll, or is it an absolutely-positioned
//     child of a scroller (which scrolls away with the content)?
//  2. what does the phone shop's DETAIL pane actually SAY about the item?
//  3. which shop controls miss the "every control clears 44px" rule, and why?
import { chromium, devices } from "playwright";
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const ready = async () => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(1500);
};
const alive = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing"; });

// ---- 1 + 3: inventory DONE bar under scroll -----------------------------
await page.goto(`${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21&safe=0,47,21,47`, { waitUntil: "load", timeout: 180000 });
await ready();
for (let i = 0; i < 4; i++) { await alive(); await page.keyboard.press("i"); await page.waitForTimeout(900);
  const up = await page.evaluate(() => { const e = document.getElementById("inv"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
  if (up) break; }
const doneBefore = await page.evaluate(() => {
  const b = document.querySelector("#inv .tp-done"), p = document.querySelector("#inv .panel");
  return { done: b && b.getBoundingClientRect(), panel: p && p.getBoundingClientRect(), scrollY: p.scrollHeight - p.clientHeight, vh: innerHeight };
});
await page.evaluate(() => { const p = document.querySelector("#inv .panel"); p.scrollTop = p.scrollHeight; });
await page.waitForTimeout(400);
const doneAfter = await page.evaluate(() => {
  const b = document.querySelector("#inv .tp-done"), p = document.querySelector("#inv .panel");
  const r = b.getBoundingClientRect(), pr = p.getBoundingClientRect();
  const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  const x = document.querySelector("#inv .tp-x").getBoundingClientRect();
  return { done: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    visibleInPanel: r.bottom > pr.top && r.top < pr.bottom,
    hitAtCentre: el ? (el.className || el.tagName).toString().slice(0, 24) : "none",
    xRect: { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height) },
    scrollTop: Math.round(p.scrollTop) };
});
console.log("INV done-bar before scroll:", JSON.stringify(doneBefore.done && { y: Math.round(doneBefore.done.y), h: Math.round(doneBefore.done.height) }), "scrollable", doneBefore.scrollY);
console.log("INV done-bar after scroll-to-bottom:", JSON.stringify(doneAfter));

// ---- 2: the shop detail pane's actual content ---------------------------
await page.goto(`${BASE}/iso.html?${TEST}&floor=3&level=10&seed=21&safe=0,47,21,47`, { waitUntil: "load", timeout: 180000 });
await ready();
await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  p.gold += 6000; for (const m of st.monsters) m.hp = 0;
  p.alive = true; p.hp = p.maxHp; st.status = "playing";
  p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
  clearInterval(window.__k);
  window.__k = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0];
    if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; } }, 200);
});
await page.waitForFunction(() => { const d = window.__dcc; if (!d || d.state.safeRoom) return true;
  d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60); return !!d.state.safeRoom; }, null, { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 24; i++) {
  const st = await page.evaluate(() => { const vis = (id) => { const e = document.getElementById(id);
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
    return { draft: vis("draft"), shop: vis("saferoom") }; }).catch(() => ({}));
  if (st.shop) break;
  if (st.draft) { const ok = await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (!c) return false; c.click(); return true; }); if (!ok) await page.keyboard.press("1"); }
  await page.waitForTimeout(700);
}
const shop = await page.evaluate(() => {
  const shown = (e) => { if (!e) return false; const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
  const tiles = [...document.querySelectorAll("#sr-shelf .itile")];
  const first = tiles.find((t) => !t.classList.contains("locked") && !t.classList.contains("soldout")) ?? tiles[0];
  if (first) first.click();
  const d = document.getElementById("sr-detail");
  const rows = [...d.querySelectorAll("*")].filter(shown)
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .map((e) => ({ cls: (e.className || e.tagName).toString().split(" ")[0], t: e.textContent.trim().slice(0, 46),
      fs: parseFloat(getComputedStyle(e).fontSize), h: Math.round(e.getBoundingClientRect().height) }));
  const r = d.getBoundingClientRect();
  // shelf view too
  const shelfTiles = tiles.filter(shown).map((t) => { const b = t.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; });
  // every control under 44 in the whole panel, with its selector chain
  const under = [...document.querySelectorAll("#saferoom button, #saferoom .tab, #saferoom .itile, #saferoom [data-act], #saferoom .item")]
    .filter(shown).map((e) => { const b = e.getBoundingClientRect();
      return { sel: (e.id || e.className.toString()).slice(0, 34), w: Math.round(b.width), h: Math.round(b.height),
        minH: getComputedStyle(e).minHeight }; })
    .filter((n) => n.w < 44 || n.h < 44);
  return { detail: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    scrollY: Math.round(d.scrollHeight - d.clientHeight) }, rows, shelfTiles: shelfTiles.slice(0, 6), under };
});
console.log("SHOP detail box:", JSON.stringify(shop.detail));
console.log("SHOP detail text rows:", JSON.stringify(shop.rows, null, 1));
console.log("SHOP shelf tiles:", JSON.stringify(shop.shelfTiles));
console.log("SHOP controls under 44px:", JSON.stringify(shop.under, null, 1));
await browser.close();
