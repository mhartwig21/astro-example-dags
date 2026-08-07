// CLOSING VISUAL CHECK, LARGE SCALE. At the game camera a crawler is ~60-80px;
// the casting call is the ONE place these rigs render big, so it is where a
// degraded skin, a lost texture or a frozen clip would actually be visible.
// Steps every hero in the lineup and shoots each one full-frame + cropped.
import { mkdirSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5285";
const out = "tools/_abshots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--disable-frame-rate-limit"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const bad = [], errs = [], warns = [];
page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") warns.push(`${m.type()}: ${m.text().slice(0, 140)}`); });
await page.goto(`${base}/iso.html?eagerassets&clean=1`, { waitUntil: "commit", timeout: 180000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/menu-00.png` });
await page.click("#m-solo");
await page.waitForTimeout(3000);
for (let i = 0; i < 8; i++) {
  await page.screenshot({ path: `${out}/lineup-${String(i).padStart(2, "0")}.png` });
  await page.screenshot({ path: `${out}/lineup-${String(i).padStart(2, "0")}-crop.png`, clip: { x: 440, y: 120, width: 560, height: 560 } });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1400);
}
console.log(`4xx: ${bad.length ? bad.join(",") : 0}`);
console.log(`pageerrors: ${errs.length ? errs.join(" | ") : 0}`);
console.log(`console warn/err (${warns.length}):`);
for (const w of [...new Set(warns)].slice(0, 12)) console.log(`  ${w}`);
await page.close(); await ctx.close(); await browser.close();
