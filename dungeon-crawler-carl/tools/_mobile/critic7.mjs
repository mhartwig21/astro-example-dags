// The shop loop, with a finger. Tap a shelf tile, read the detail pane, tap BUY,
// verify against gold/bag/stock. Then compare with a synthetic click().
import { chromium, devices } from "playwright";
import { DEVICE_SPECS } from "../mobileshot.mjs";

const BASE = "http://localhost:5420";
const devKey = process.argv[2] || "iphone13-land";
const spec = DEVICE_SPECS[devKey];
const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=3&level=10&seed=21&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;

function driver(client) {
  const live = new Map();
  let clock = Date.now() / 1000;
  const all = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  const send = (type, pts) => client.send("Input.dispatchTouchEvent", { type, touchPoints: pts, timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart", all()); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove", all()); },
    async up(id) { const p = live.get(id); live.delete(id); await send("touchEnd", p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : []); },
    async tap(x, y, hold = 90) { await api.down(1, x, y); api.tick(hold); await new Promise((r) => setTimeout(r, hold)); await api.up(1); },
  };
  return api;
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw] });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = driver(client);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true; const cs = getComputedStyle(l); return cs.display === "none" || +cs.opacity === 0; }, null, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(1500);
const settle = async (n = 6) => { await page.waitForTimeout(120); await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {}); };

await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  p.gold = 9000;
  for (const m of st.monsters) m.hp = 0;
  p.alive = true; p.downedT = 0; p.hp = p.maxHp; st.status = "playing";
  p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
  window.__keep = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0]; if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; } }, 200);
});
await page.waitForFunction(() => { const d = window.__dcc; if (!d || d.state.safeRoom) return true; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60); return !!d.state.safeRoom; }, null, { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 20; i++) {
  const st = await page.evaluate(() => { const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }; return { draft: vis("draft"), shop: vis("saferoom") }; });
  if (st.shop) break;
  if (st.draft) await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); });
  await page.waitForTimeout(600);
}
console.log("shop open:", await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }));
console.log("segmented panes:", await page.evaluate(() => [...document.querySelectorAll("#saferoom .tp-seg button, #saferoom .tp-seg .seg")].map((e) => `${e.textContent.trim()}${e.classList.contains("on") || e.getAttribute("aria-selected") === "true" ? "*" : ""}`)));

const tiles = await page.evaluate(() => [...document.querySelectorAll("#saferoom .itile")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; }).slice(0, 5).map((e, i) => { const r = e.getBoundingClientRect(); return { i, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), cls: e.className, txt: e.textContent.trim().slice(0, 26) }; }));
console.log("on-screen shelf tiles:", JSON.stringify(tiles));

for (const t of tiles.slice(0, 3)) {
  const before = await page.evaluate(() => ({ detail: (document.getElementById("sr-detail") || {}).textContent?.trim().slice(0, 40), gold: window.__dcc.state.players[0].gold, bag: (window.__dcc.state.players[0].bag || []).length }));
  await touch.tap(t.x, t.y, 110);
  await settle(8);
  // ...then try the DETAIL segment, in case selection and viewing are two steps
  const segBtn = await page.evaluate(() => { const e = [...document.querySelectorAll("#saferoom .tp-seg button, #saferoom .tp-seg .seg")].find((b) => /detail/i.test(b.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; });
  if (segBtn) { await touch.tap(segBtn.x, segBtn.y, 110); await settle(8); console.log("   tapped DETAIL segment", JSON.stringify(segBtn)); }
  const after = await page.evaluate(() => {
    const d = document.getElementById("sr-detail");
    const buy = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0];
    const r = buy && buy.getBoundingClientRect();
    return {
      detail: d ? d.textContent.trim().slice(0, 60) : null,
      buy: buy ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: buy.textContent.trim(), dis: !!buy.disabled, visibleInPanel: r.top >= 0 && r.bottom <= innerHeight } : null,
      seg: [...document.querySelectorAll("#saferoom .tp-seg button, #saferoom .tp-seg .seg")].map((e) => `${e.textContent.trim()}${e.className.includes("on") ? "*" : ""}`),
    };
  });
  const clicked = await page.evaluate((i) => { const t = [...document.querySelectorAll("#saferoom .itile")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; })[i]; if (t) t.click(); return true; }, t.i); await settle(8); const afterClick = await page.evaluate(() => { const d = document.getElementById("sr-detail"); const b = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0]; return { detail: d ? d.textContent.trim().slice(0, 50) : null, buy: b ? b.textContent.trim() : null }; }); console.log("   synthetic .click() on the same tile →", JSON.stringify(afterClick));
  console.log(`tap tile ${t.i} "${t.txt}" (${t.cls}) → detail "${after.detail}" · seg ${JSON.stringify(after.seg)} · BUY ${JSON.stringify(after.buy)}`);
  if (after.buy && !after.buy.dis) {
    const a = await page.evaluate(() => ({ gold: window.__dcc.state.players[0].gold, bag: (window.__dcc.state.players[0].bag || []).length }));
    await touch.tap(after.buy.x, after.buy.y, 120);
    await settle(10);
    const b = await page.evaluate(() => ({ gold: window.__dcc.state.players[0].gold, bag: (window.__dcc.state.players[0].bag || []).length, stamp: (document.getElementById("sr-stamp") || {}).textContent }));
    console.log(`   FINGER tap on BUY → gold ${a.gold}→${b.gold}, bag ${a.bag}→${b.bag}, stamp "${(b.stamp || "").trim().slice(0, 40)}"`);
    if (b.gold === a.gold && b.bag === a.bag) {
      const c = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0];
        if (btn) btn.click();
        return { gold: window.__dcc.state.players[0].gold, bag: (window.__dcc.state.players[0].bag || []).length };
      });
      await settle(8);
      const d = await page.evaluate(() => ({ gold: window.__dcc.state.players[0].gold, bag: (window.__dcc.state.players[0].bag || []).length }));
      console.log(`   synthetic .click() on the same BUY → gold ${a.gold}→${d.gold}, bag ${a.bag}→${d.bag}  ${d.gold !== a.gold ? "(so the handler works; the TOUCH path is what failed)" : "(the handler did nothing either — not a touch problem)"}`);
    }
    break;
  }
}
await page.screenshot({ path: `tools/_mobile/c7-${devKey}.png` });
await browser.close();
