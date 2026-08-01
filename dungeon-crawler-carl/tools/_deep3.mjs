// Pass 3: real floor transition, campfire scene, and the shadowInterval lag.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const out = flag("--out", "tools/_deep3");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.text().includes("shader-guard] program")) console.log("GUARD:", m.text().slice(0, 220)); });

// ---- A. CAMPFIRE ---------------------------------------------------------
await page.goto(`${base}/iso.html?debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button,div,a,span")]
    .find((e) => /new run/i.test(e.textContent || "") && e.offsetParent !== null);
  (el?.closest("button,[role=button],div") ?? el)?.click();
});
await page.waitForTimeout(10000);
await page.screenshot({ path: `${out}/A-campfire.png` });

// ---- B. FLOOR TRANSITION -------------------------------------------------
await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.__dcc.renderer.setQuality("ultra"));
await page.waitForTimeout(1200);
const snap = () => page.evaluate(() => {
  const r = window.__dcc.renderer, s = window.__dcc.state;
  return {
    floor: s.floor, monsters: s.monsters.length,
    player: `${s.players[0].pos.x.toFixed(1)},${s.players[0].pos.y.toFixed(1)}`,
    stairs: `${s.map.stairs.x},${s.map.stairs.y}`,
    explored: s.explored.reduce((a, b) => a + (b ? 1 : 0), 0),
    children: r.scene.children.length, tex: r.renderer.info.memory.textures,
    geo: r.renderer.info.memory.geometries, programs: r.renderer.info.programs.length,
  };
});
console.log("BEFORE:", JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/B1-floor5.png` });
await page.evaluate(() => {
  const s = window.__dcc.state;
  s.players[0].pos.x = s.map.stairs.x; s.players[0].pos.y = s.map.stairs.y;
});
await page.waitForTimeout(800);
for (let i = 0; i < 10; i++) { await page.keyboard.press("e"); await page.waitForTimeout(350); }
await page.waitForTimeout(4000);
console.log("AFTER :", JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/B2-after-descent.png` });
await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/B3-after-descent-moved.png` });
console.log("MOVED :", JSON.stringify(await snap()));

// ---- C. SHADOW CADENCE LAG ----------------------------------------------
// PERFORMANCE rebuilds the key shadow map every 3rd composed frame. Static
// geometry is fine (the matrix is stale in lockstep with the map) but MOVING
// characters' shadows lag by up to 2 frames. Capture mid-run on each preset.
for (const p of ["ultra", "performance"]) {
  await page.evaluate((q) => window.__dcc.renderer.setQuality(q), p);
  await page.waitForTimeout(1200);
  await page.keyboard.down("d");
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/C-run-${p}.png` });
  await page.keyboard.up("d");
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/C-still-${p}.png` });
}
await browser.close();
