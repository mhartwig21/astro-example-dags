// Measure the LIVE onramp card during a real fresh run on Pixel 5.
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5286";
function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 100) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 60)));
      await this.up(id);
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["Pixel 5 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?debug=1&noassets&quality=performance&safe=0,24,24,0`, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(4000);
  const solo = await page.evaluate(() => {
    const r = document.getElementById("m-solo").getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  });
  await touch.tap(solo.cx, solo.cy);
  await page.waitForTimeout(1200);
  const go = await page.evaluate(() => {
    const r = document.getElementById("m-cast-go").getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  });
  await touch.tap(go.cx, go.cy);
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => {
    const t = document.getElementById("tutorial");
    return t && (t.textContent ?? "").includes("COURTESY");
  }, null, { timeout: 30000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const t = document.getElementById("tutorial");
    const r = t.getBoundingClientRect();
    const btn = t.querySelector("button");
    const br = btn ? btn.getBoundingClientRect() : null;
    const at = br ? document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2) : null;
    const clippedEls = [...t.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 4)
      .map((e) => `${e.tagName}.${[...e.classList].join(".")} sh=${e.scrollHeight} ch=${e.clientHeight}`);
    return { card: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      clippedEls, text: (t.textContent ?? "").slice(0, 130),
      gotIt: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height),
        onGlass: br.y >= 0 && br.y + br.height <= innerHeight,
        hit: !!at && (at === btn || btn.contains(at)) } : null };
  });
  await page.screenshot({ path: "tools/_mobile/ac-wr-r2/pixel5-onramp.png" });
  console.log(JSON.stringify(m, null, 1));
} finally {
  await browser.close();
}
