import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const p = await b.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
await p.goto(process.argv[2], { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(()=>{});
await p.waitForTimeout(4000);
const n = () => p.evaluate(() => window.__dcc?.renderer?.renderer?.info?.programs?.length ?? -1);
console.log("after boot:", await n());
for (const q of ["performance","balanced","high","ultra","performance","ultra"]) {
  await p.evaluate((v) => window.__dcc?.renderer?.setQuality?.(v), q);
  await p.waitForTimeout(1800);
  console.log(`  setQuality(${q.padEnd(11)}) -> programs ${await n()}`);
}
await b.close();
