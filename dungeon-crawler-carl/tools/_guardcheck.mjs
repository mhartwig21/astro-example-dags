import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const logs = [];
p.on("console", (m) => { const t = m.text(); if (t.includes("shader-guard")) logs.push(t); });
await p.goto(process.argv[2], { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(()=>{});
await p.waitForTimeout(6000);
for (const k of ["w","d"]) { await p.keyboard.down(k); await p.waitForTimeout(800); await p.keyboard.up(k); }
for (let i=0;i<4;i++) for (const k of ["Space","q","c"]) { await p.keyboard.press(k).catch(()=>{}); await p.waitForTimeout(120); }
await p.waitForTimeout(2000);
console.log(logs.length ? logs.join("\n") : "(no shader-guard output)");
await b.close();
