// PER-ROW COLD-BOOT CENSUS. _abfinal.mjs aggregates; this keeps the rows, because
// two of the classes need the distinction: `decodedBodySize` is reported for a
// CACHE HIT too, so summing it over all references counts the shared-texture pool
// 246 times instead of 29. Distinct-decoded = sum over rows that actually hit the
// network; that is the number comparable to the baseline's on-disk census.
import { writeFileSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5285";
const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--disable-frame-rate-limit"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => performance.setResourceTimingBufferSize(6000));
await page.goto(`${base}/iso.html`, { waitUntil: "commit", timeout: 180000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
await page.waitForFunction(() => { const el = document.getElementById("loading"); return !el || el.classList.contains("done") || getComputedStyle(el).display === "none"; }, null, { timeout: 300000 }).catch(() => {});
await page.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n >= 3 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
const c = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    rows: performance.getEntriesByType("resource").filter((e) => e.name.startsWith(location.origin))
      .map((e) => ({ p: new URL(e.name).pathname, t: e.transferSize, d: e.decodedBodySize })),
    doc: { p: "/iso.html", t: nav.transferSize, d: nav.decodedBodySize },
  };
});
const rows = [c.doc, ...c.rows];
const cls = (p) => { const e = (p.match(/\.[a-z0-9]+$/i) ?? [""])[0].toLowerCase();
  return e === ".glb" ? "models" : (e === ".ogg" || e === ".wav") ? "audio" : (e === ".woff2" || e === ".ttf") ? "fonts"
    : e === ".js" ? "js" : (e === ".webp" || e === ".png") ? "textures" : e === ".svg" ? "icons" : e === ".html" ? "docs" : "other"; };
const t = {};
for (const r of rows) { const k = cls(r.p); t[k] = t[k] ?? { ref: 0, net: 0, wire: 0, dAll: 0, dNet: 0 };
  t[k].ref++; t[k].dAll += r.d; if (r.t > 0) { t[k].net++; t[k].wire += r.t; t[k].dNet += r.d; } }
console.log(`${"class".padEnd(9)} ${"refs".padStart(5)} ${"net".padStart(5)} ${"wire MB".padStart(9)} ${"distinct decoded MB".padStart(20)} ${"decoded incl. cache hits".padStart(24)}`);
let W = 0, D = 0, N = 0, R = 0;
for (const [k, v] of Object.entries(t).sort((a, b) => b[1].dNet - a[1].dNet)) {
  console.log(`${k.padEnd(9)} ${String(v.ref).padStart(5)} ${String(v.net).padStart(5)} ${(v.wire / 1e6).toFixed(3).padStart(9)} ${(v.dNet / 1e6).toFixed(3).padStart(20)} ${(v.dAll / 1e6).toFixed(3).padStart(24)}`);
  W += v.wire; D += v.dNet; N += v.net; R += v.ref; }
console.log(`${"TOTAL".padEnd(9)} ${String(R).padStart(5)} ${String(N).padStart(5)} ${(W / 1e6).toFixed(3).padStart(9)} ${(D / 1e6).toFixed(3).padStart(20)}`);
const heavy = rows.filter((r) => r.t > 0).sort((a, b) => b.t - a.t).slice(0, 12);
console.log("\nheaviest ON THE WIRE:");
for (const h of heavy) console.log(`  ${(h.t / 1e3).toFixed(1).padStart(8)} kB wire  ${(h.d / 1e3).toFixed(1).padStart(9)} kB decoded  ${h.p}`);
writeFileSync("tools/_abshots/rows.json", JSON.stringify({ rows, byClass: t }, null, 1));
await page.close(); await ctx.close(); await browser.close();
