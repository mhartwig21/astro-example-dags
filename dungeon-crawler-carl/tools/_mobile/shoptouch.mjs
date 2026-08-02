import { chromium, devices } from "playwright";
import { DEVICE_SPECS, touchDriver } from "../mobileshot.mjs";
const BASE = "http://localhost:5420";
const devKey = process.argv[2] || "iphone13-land";
const spec = DEVICE_SPECS[devKey];
const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=3&level=10&seed=21&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw] });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = touchDriver(client);
page.on("pageerror", (e) => console.log("PAGEEXC", String(e).slice(0, 300)));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  p.gold = 9000; for (const m of st.monsters) m.hp = 0;
  p.alive = true; p.downedT = 0; p.hp = p.maxHp; st.status = "playing";
  p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
});
await page.waitForFunction(() => { const d = window.__dcc; if (!d || d.state.safeRoom) return true; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1/60); return !!d.state.safeRoom; }, null, { timeout: 60000 }).catch(()=>{});
for (let i = 0; i < 20; i++) {
  const st = await page.evaluate(() => { const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width>0; }; return { draft: vis("draft"), shop: vis("saferoom") }; });
  if (st.shop) break;
  if (st.draft) await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); });
  await page.waitForTimeout(500);
}
const settle = async (n=8) => { await page.waitForTimeout(150); await page.evaluate((k)=>new Promise(r=>{let i=0;const t=()=>(++i>=k?r(null):requestAnimationFrame(t));requestAnimationFrame(t);}), n).catch(()=>{}); };
// log every pointer/click on the shelf
await page.evaluate(() => {
  window.__ev = [];
  for (const t of ["pointerdown","pointerup","click","touchstart","touchend"]) {
    document.getElementById("sr-shelf").addEventListener(t, (e) => window.__ev.push(t + ":" + (e.target.className||e.target.tagName)), true);
  }
});
const boxes = await page.evaluate(() => {
  const g = (id) => { const e = document.getElementById(id) || document.querySelector(id); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; };
  return { panel: g("#saferoom > .panel"), body: g("sr-page-shop"), shelfcol: g("#saferoom .shelf-col"), shelf: g("sr-shelf"), descend: g("#saferoom .descend"), seg: g("#saferoom .tp-seg"), vh: innerHeight, vw: innerWidth };
});
console.log("boxes", JSON.stringify(boxes));
console.log("css", JSON.stringify(await page.evaluate(() => {
  const b = document.querySelector("#saferoom .shop-body");
  const cs = getComputedStyle(b);
  const hits = []; let nsheets = 0, nrules = 0, nsel = 0;
  for (const sh of document.styleSheets) {
    nsheets++; let rules; try { rules = sh.cssRules; } catch (e) { hits.push({err:String(e).slice(0,60)}); continue; }
    const walk = (list, media) => { for (const r of list) {
      if (!r.selectorText) { if (r.cssRules) walk(r.cssRules, (media?media+" && ":"") + (r.conditionText||"")); continue; }
      nrules++; if (/shop-body/.test(r.selectorText)) nsel++;
      if (!/shop-body/.test(r.selectorText)) continue;
      if (!/display/.test(r.style.cssText)) continue;
      hits.push({ sel: r.selectorText.slice(0,90), disp: r.style.display, media: media||null, matches: b.matches(r.selectorText) });
    } };
    walk(rules, null);
  }
  return { uiclass: document.body.dataset.uiclass, cls: document.body.className, disp: cs.display, cols: cs.gridTemplateColumns, nsheets, nrules, nsel, hits };
})));
const tile = await page.evaluate(() => {
  for (const t of document.querySelectorAll("#sr-shelf .itile[data-id]")) {
    const r = t.getBoundingClientRect(); if (r.width <= 0) continue;
    const cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
    const hit = document.elementFromPoint(cx, cy);
    if (hit && t.contains(hit)) return { id: t.dataset.id, x: cx, y: cy, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] };
  }
  return null;
});
console.log("tile", JSON.stringify(tile));
console.log("under finger:", await page.evaluate(([x,y]) => { const e=document.elementFromPoint(x,y); return e? e.tagName+"."+e.className : "none"; }, [tile.x, tile.y]));
await touch.tap(tile.x, tile.y, 1, 110);
await settle(10);
console.log("events:", JSON.stringify(await page.evaluate(() => window.__ev)));
console.log("after tap:", JSON.stringify(await page.evaluate(() => {
  const d = document.getElementById("sr-detail");
  const b = document.querySelector("#saferoom [data-buy]");
  const br = b && b.getBoundingClientRect();
  return { detail: d.textContent.trim().slice(0,50), detailDisp: getComputedStyle(d).display,
    seg: [...document.querySelectorAll("#saferoom .tp-seg button")].map(x=>x.textContent+(x.className.includes("on")?"*":"")),
    buy: b ? { txt: b.textContent, r: [Math.round(br.x),Math.round(br.y),Math.round(br.width),Math.round(br.height)], onScreen: br.top>=0&&br.bottom<=innerHeight } : null,
    detailScroll: [d.scrollHeight - d.clientHeight, d.clientHeight] };
})));
await browser.close();
