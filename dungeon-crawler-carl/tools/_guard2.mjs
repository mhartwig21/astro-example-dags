// What exactly does the project's own shader tripwire catch in ordinary play,
// and does a forced FLOOR REBUILD (scheduleAssetRefresh — the same path an
// arriving GLB takes) leave anything stale?
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const floor = flag("--floor", "5");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const guard = [];
let armed = false;
page.on("console", (m) => {
  const s = m.text();
  if (s.includes("shader-guard] armed")) armed = true;
  if (s.includes("shader-guard] program")) guard.push(s.replace(/\s+/g, " "));
});
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${base}/iso.html?test&floor=${floor}&level=18&seed=41&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
for (let i = 0; i < 120 && !armed; i++) await page.waitForTimeout(500);
await page.waitForTimeout(2500);
const p0 = await page.evaluate(() => window.__dcc.renderer.renderer.info.programs.length);

// Walk the map so unexplored dressing/monsters come into view.
for (const k of ["d", "s", "a", "w", "d", "s"]) {
  await page.keyboard.down(k); await page.waitForTimeout(1500); await page.keyboard.up(k);
  for (const a of ["Space", "q", "c"]) await page.keyboard.press(a).catch(() => {});
  await page.waitForTimeout(500);
}
const p1 = await page.evaluate(() => window.__dcc.renderer.renderer.info.programs.length);
console.log(`programs after boot: ${p0} -> after roaming/fighting: ${p1}`);
console.log(`GUARD HITS: ${guard.length}`);
for (const g of guard) {
  const m = g.match(/cacheKey: ([^ ]*(?: [^ ]*)*?) Prewarm/);
  const key = (m ? m[1] : g).trim();
  const parts = key.split(",");
  console.log(`  ${parts[0]} | numPointLights=${parts[parts.length - 9]} depthPacking=${parts[parts.length - 4]} masks=${parts[parts.length - 3]},${parts[parts.length - 2]}`);
}

// ---- FLOOR REBUILD (the debounced path every streamed GLB arrival takes) ---
const before = await page.evaluate(() => {
  const r = window.__dcc.renderer;
  return { children: r.scene.children.length, tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries };
});
await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__dcc.renderer.scheduleAssetRefresh(); });
await page.waitForTimeout(4000);
const after = await page.evaluate(() => {
  const r = window.__dcc.renderer;
  return { children: r.scene.children.length, tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries };
});
console.log("FLOOR REBUILD before:", JSON.stringify(before), "after:", JSON.stringify(after));
await page.screenshot({ path: "tools/_deep3/D-after-floor-rebuild.png" });

// Rebuild 20x to see whether anything accumulates.
await page.evaluate(async () => {
  for (let i = 0; i < 20; i++) {
    window.__dcc.renderer.scheduleAssetRefresh();
    await new Promise((r) => setTimeout(r, 200));
  }
});
await page.waitForTimeout(5000);
console.log("AFTER 20 REBUILDS:", JSON.stringify(await page.evaluate(() => {
  const r = window.__dcc.renderer;
  return { children: r.scene.children.length, tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries };
})));
await page.screenshot({ path: "tools/_deep3/E-after-20-rebuilds.png" });
await browser.close();
