import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(()=>{});
await page.waitForFunction(() => { const e=document.getElementById("loading"); return !e||e.classList.contains("done"); }, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(3000);
await page.evaluate(() => { const S=window.__perf.PERFSTATS; S.pass={}; S.frames=0; });
await page.keyboard.down("w"); await page.waitForTimeout(6000); await page.keyboard.up("w");
const r = await page.evaluate(() => { const S=window.__perf.PERFSTATS; return { frames:S.frames, pass:S.pass, calls:S.calls, tris:S.tris }; });
const n = r.frames || 1;
console.log("frames sampled:", n);
for (const [k,v] of Object.entries(r.pass).sort((a,b)=>b[1].ms-a[1].ms)) {
  console.log(`${k.padEnd(16)} ms/frame=${(v.ms/n).toFixed(2).padStart(6)}  calls/frame=${Math.round(v.calls/n).toString().padStart(5)}  tris/frame=${Math.round(v.tris/n).toString().padStart(9)}`);
}
await browser.close();
