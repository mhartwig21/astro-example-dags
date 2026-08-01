// (a) Is the floor-rebuild texture growth a REGRESSION or pre-existing?
//     Same 20 forced rebuilds on the shipped build and on mine.
// (b) The campfire character-select scene, reached by clicking the NEW RUN card
//     (shadowMap.autoUpdate is now off globally; charSelect arms its own).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
mkdirSync("tools/_final", { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});

async function rebuildLeak(name, base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error(`${name} PAGE ERROR:`, e.message));
  await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&eagerassets&debug=1`, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
  await page.waitForTimeout(14000); // let prewarm + streaming quiesce
  const read = () => page.evaluate(() => {
    const r = window.__dcc.renderer;
    return { tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries };
  });
  const a = await read();
  await page.waitForTimeout(6000);
  const drift = await read(); // baseline drift with NO rebuilds
  await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) { window.__dcc.renderer.scheduleAssetRefresh(); await new Promise((r) => setTimeout(r, 250)); }
  });
  await page.waitForTimeout(6000);
  const b = await read();
  console.log(`${name.padEnd(9)} baseline ${JSON.stringify(a)} -> 6s idle drift ${JSON.stringify(drift)} -> after 20 rebuilds ${JSON.stringify(b)}`);
  await page.close();
}
await rebuildLeak("SHIPPED", "http://localhost:5291");
await rebuildLeak("MINE", "http://localhost:5294");

// ---- CAMPFIRE ------------------------------------------------------------
for (const [name, base] of [["shipped", "http://localhost:5291"], ["mine", "http://localhost:5294"]]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error(`${name} PAGE ERROR:`, e.message));
  await page.goto(`${base}/iso.html?debug=1&eagerassets`, { waitUntil: "load", timeout: 90000 });
  await page.waitForTimeout(14000);
  await page.mouse.click(571, 390); // the NEW RUN card
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `tools/_final/campfire-${name}.png` });
  console.log(`campfire-${name} captured`);
  await page.close();
}
await browser.close();
