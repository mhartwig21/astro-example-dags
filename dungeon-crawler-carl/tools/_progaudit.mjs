// Does renderer.info.programs actually go FLAT after boot?
// Samples the program count on a timer from navigation through combat, and
// captures the [shader-guard] console lines the build emits under ?debug.
import { chromium } from "playwright";
const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2];
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const guard = [];
page.on("console", (m) => {
  const t = m.text();
  if (/shader-guard|program|compil/i.test(t)) guard.push(t);
});
const t0 = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const timeline = [];
const snap = async (tag) => {
  const n = await page.evaluate(() => window.__dcc?.renderer?.renderer?.info?.programs?.length ?? null);
  timeline.push({ t: Date.now() - t0, tag, programs: n });
  return n;
};
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await snap("assetsSettled");
for (let i = 0; i < 12; i++) { await page.waitForTimeout(1000); await snap("idle+" + (i + 1) + "s"); }
await page.keyboard.down("w");
for (let i = 0; i < 6; i++) { await page.waitForTimeout(1000); await snap("moving+" + (i + 1) + "s"); }
await page.keyboard.up("w");
for (const k of ["Space", "q", "c", "e", "r", "f"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(700); await snap("cast:" + k); }
for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); await snap("combat+" + (i + 1) + "s"); }
console.log("TIMELINE:");
for (const r of timeline) console.log(`  ${String(r.t).padStart(6)}ms  ${r.tag.padEnd(16)} programs=${r.programs}`);
const first = timeline[0].programs, last = timeline[timeline.length - 1].programs;
console.log(`DELTA-AFTER-BOOT: ${first} -> ${last}  (+${last - first})`);
console.log("GUARD-LINES:", guard.length);
for (const g of guard.slice(0, 40)) console.log("  ", g.slice(0, 300));
await browser.close();
