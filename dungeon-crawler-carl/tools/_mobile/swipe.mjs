import { chromium, devices } from "playwright";
import { DEVICE_SPECS, touchDriver } from "../mobileshot.mjs";
const spec = DEVICE_SPECS["iphone13-land"];
const url = `http://localhost:5420/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=77&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = touchDriver(client);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForTimeout(1500);
const settle = async (n=6) => { await page.waitForTimeout(120); await page.evaluate((k)=>new Promise(r=>{let i=0;const t=()=>(++i>=k?r(null):requestAnimationFrame(t));requestAnimationFrame(t);}),n).catch(()=>{}); };
await page.keyboard.press("i");
await settle(10);
const info = await page.evaluate(() => {
  const box = document.querySelector("#inv > .panel");
  const cs = getComputedStyle(box);
  window.__ev = [];
  for (const t of ["pointerdown","pointermove","pointerup","pointercancel","touchstart","touchmove","touchend","touchcancel","scroll"]) {
    box.addEventListener(t, (e) => window.__ev.push(`${t}:${e.pointerType||""}:${Math.round(e.clientY||box.scrollTop)}`), true);
  }
  const r = box.getBoundingClientRect();
  return { touchAction: cs.touchAction, overflowY: cs.overflowY, scrollTop: box.scrollTop, scrollH: box.scrollHeight, clientH: box.clientHeight, wired: box.dataset.touchWired, r:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] };
});
console.log("panel", JSON.stringify(info));
const x = info.r[0] + Math.round(info.r[2]/2), y = info.r[1] + 26;
await touch.down(1, x, y); await settle(2);
for (let i=1;i<=10;i++){ await touch.move(1, x, y + i*20); await settle(1); }
await touch.up(1); await settle(10);
console.log("events", JSON.stringify(await page.evaluate(() => window.__ev.slice(0,40))));
console.log("still open", await page.evaluate(() => { const e=document.getElementById("inv"); return !!e && getComputedStyle(e).display!=="none" && e.getBoundingClientRect().width>0; }));
await browser.close();
