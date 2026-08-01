// When do the ~40 mid-game shader compiles happen? Walk first (no combat),
// then fight. If programs only climb once damage lands, the per-material
// hitflash/dissolve program variants are the cause.
import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const ctx = await b.newContext({ viewport:{width:640,height:360}, deviceScaleFactor:1 });
const p = await ctx.newPage();
await p.goto("http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1",{waitUntil:"load",timeout:60000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",{timeout:180000}).catch(()=>{});
const N = () => p.evaluate(()=>({ prog: window.__dcc.renderer.renderer.info.programs.length,
  keys: window.__dcc.renderer.renderer.info.programs.map(x=>x.cacheKey?.slice(-42)).filter(k=>/hitflash|dissolve/.test(k||"")).length }));
const mark = async (label) => console.log(label.padEnd(34), JSON.stringify(await N()));
await p.waitForTimeout(1500); await mark("after loading screen (prewarm done)");
for (let i=0;i<8;i++){ await p.keyboard.down(["w","d","s","a"][i%4]); await p.waitForTimeout(900); await p.keyboard.up(["w","d","s","a"][i%4]); }
await mark("after 7s of WALKING only");
await p.keyboard.press("Space"); await p.waitForTimeout(1500); await mark("after 1st basic attack");
for (const k of ["q","e","r","c","f"]) { await p.keyboard.press(k).catch(()=>{}); await p.waitForTimeout(1200); }
await mark("after each ability fired once");
for (let i=0;i<12;i++){ await p.keyboard.press("Space"); await p.waitForTimeout(400); }
await mark("after sustained melee (kills)");
for (let i=0;i<6;i++){ await p.keyboard.down("w"); await p.waitForTimeout(700); await p.keyboard.up("w"); for(const k of ["Space","q","e"]) await p.keyboard.press(k).catch(()=>{}); }
await mark("after roaming into new mobs");
await b.close();
