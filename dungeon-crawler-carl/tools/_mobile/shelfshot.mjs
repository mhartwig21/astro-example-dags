// The phone shop's SHELF pane, and the recap after a scroll — the two reads
// the round-2 layout seat could not get from the existing scene set.
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const OUT = flag("out", "tools/_mobile/lay2d"); mkdirSync(OUT, { recursive: true });
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const ready = async () => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(1500);
};
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
// force the SHELF segment
const seg = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("#saferoom .tp-seg button")].map((b) => b.textContent.trim());
  const b = [...document.querySelectorAll("#saferoom .tp-seg button")].find((x) => /shelf/i.test(x.textContent));
  if (b) b.click();
  return btns;
});
await page.waitForTimeout(900);
console.log("segments:", JSON.stringify(seg));
const shelf = await page.evaluate(() => {
  const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
  const s = document.getElementById("sr-shelf");
  const r = s.getBoundingClientRect();
  const tiles = [...s.querySelectorAll(".itile")].filter(shown);
  const onScreen = tiles.filter((t) => { const b = t.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
  const price = [...s.querySelectorAll(".iprice, .price, .cost")].filter(shown).slice(0, 3)
    .map((e) => ({ t: e.textContent.trim(), fs: parseFloat(getComputedStyle(e).fontSize) }));
  return { box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    scrollY: Math.round(s.scrollHeight - s.clientHeight), tiles: tiles.length, tilesFullyOnScreen: onScreen.length,
    tileSize: tiles[0] ? { w: Math.round(tiles[0].getBoundingClientRect().width), h: Math.round(tiles[0].getBoundingClientRect().height) } : null,
    price };
});
console.log("SHELF:", JSON.stringify(shelf));
await page.screenshot({ path: join(OUT, "iphone13-shop-shelf.png") });

// --- the recap, scrolled to where its buttons live ---
await page.goto(`${BASE}/iso.html?${TEST}&floor=6&level=16&seed=21&safe=0,47,21,47`, { waitUntil: "load", timeout: 180000 });
await ready();
await page.evaluate(() => {
  const d = window.__dcc, st = d.state, p = st.players[0];
  for (let i = 0; i < 3000 && st.status === "playing"; i++) { p.hp = 0; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 1 / 30); }
  if (st.status === "playing") st.status = "dead";
});
for (let i = 0; i < 30; i++) {
  const up = await page.evaluate(() => { const e = document.getElementById("recap");
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }).catch(() => false);
  if (up) break; await page.waitForTimeout(600);
}
const rec = await page.evaluate(() => {
  const p = document.querySelector("#recap .panel");
  const btns = [...document.querySelectorAll("#recap button")].filter((b) => getComputedStyle(b).display !== "none");
  const before = btns.map((b) => ({ t: b.textContent.trim().slice(0, 16), y: Math.round(b.getBoundingClientRect().y) }));
  const onScreenBefore = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).length;
  // is there ANY visual scroll cue? a scrollbar, a chevron, a gradient mask
  const sb = p.offsetWidth - p.clientWidth;
  return { scrollY: Math.round(p.scrollHeight - p.clientHeight), buttons: before, onScreenBefore, scrollbarWidthPx: sb, vh: innerHeight };
});
console.log("RECAP:", JSON.stringify(rec));
await browser.close();
