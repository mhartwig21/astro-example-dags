import { chromium, devices } from "playwright";
const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77`, { waitUntil: "load", timeout: 120000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
await page.waitForTimeout(3000);

console.log(JSON.stringify(await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  const s = st.map.stairs;
  p.pos.x = s.x + 0.5; p.pos.y = s.y + 0.5;
  const ti = Math.floor(p.pos.y) * st.map.w + Math.floor(p.pos.x);
  return { stairs: s, tileAt: st.map.tiles[ti], mapW: st.map.w, runKind: st.runKind, status: st.status,
    tileCounts: (() => { const c = {}; for (const t of st.map.tiles) c[t] = (c[t] || 0) + 1; return c; })(),
    sealed: st.map.sealed ?? null, doors: st.map.doors ? st.map.doors.length : null };
}), null, 1));
await page.waitForTimeout(2000);
console.log(JSON.stringify(await page.evaluate(() => {
  const e = document.getElementById("t-stairs");
  const st = window.__dcc.state, p = st.players[0];
  const ti = Math.floor(p.pos.y) * st.map.w + Math.floor(p.pos.x);
  return { cls: e.className, disp: getComputedStyle(e).display, pos: { x: p.pos.x, y: p.pos.y }, tileAt: st.map.tiles[ti], status: st.status };
})));
// now find an actual StairsDown tile by scanning
console.log(JSON.stringify(await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  const target = st.map.tiles[Math.floor(st.map.stairs.y) * st.map.w + Math.floor(st.map.stairs.x)];
  // scan for the rarest tile value, likely the stairs
  const c = {}; for (const t of st.map.tiles) c[t] = (c[t] || 0) + 1;
  const rare = Object.entries(c).sort((a, b) => a[1] - b[1])[0];
  let idx = st.map.tiles.indexOf(+rare[0]);
  p.pos.x = (idx % st.map.w) + 0.5; p.pos.y = Math.floor(idx / st.map.w) + 0.5;
  return { rareTile: rare, movedTo: { x: p.pos.x, y: p.pos.y }, stairsTileValue: target };
})));
await page.waitForTimeout(2500);
console.log(JSON.stringify(await page.evaluate(() => {
  const e = document.getElementById("t-stairs");
  const r = e.getBoundingClientRect();
  return { cls: e.className, disp: getComputedStyle(e).display, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})));
await browser.close();
