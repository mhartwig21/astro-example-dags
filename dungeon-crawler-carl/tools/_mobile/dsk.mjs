import { chromium } from "playwright";
const BASE = "http://localhost:5420";
const T = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=3&level=14&seed=7";
const b = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader","--enable-unsafe-swiftshader","--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto(`${BASE}/iso.html?${T}`, { waitUntil: "load", timeout: 180000 });
await p.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await p.waitForTimeout(2500);
await p.evaluate(()=>{const q=window.__dcc.state.players[0];q.hp=q.maxHp;q.alive=true;window.__dcc.state.status="playing";});
await p.keyboard.press("i"); await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(()=>{
  const coarse = matchMedia("(pointer: coarse)").matches;
  const g=(sel)=>{const e=document.querySelector(sel); if(!e) return null; const cs=getComputedStyle(e); const r=e.getBoundingClientRect();
    return {sel,disp:cs.display,bg:cs.backgroundColor,font:cs.fontFamily.split(",")[0],fs:cs.fontSize,w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y)};};
  return {coarse, bodyTouch:document.body.classList.contains("touch"),
    x:g("#inv .tp-x"), done:g("#inv .tp-done"), seg:g("#inv .tp-seg"), segBtn:g("#inv .tp-seg button"),
    panel:g("#inv .panel")};
}), null, 1));
await b.close();
