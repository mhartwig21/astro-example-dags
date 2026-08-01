// Pass 2: a REAL in-game floor transition (state.map.stairs), the campfire
// character-select scene (reached through NEW RUN), and a high-rep count of
// frames that compose with a NULL key shadow map after a preset switch.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const out = flag("--out", "tools/_deep2");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const log = [];
let armed = false;
page.on("console", (m) => {
  const s = m.text();
  if (s.includes("shader-guard] armed")) armed = true;
  if (m.type() === "error" || /shader-guard] program|THREE\.WebGL|GL_INVALID/i.test(s)) {
    log.push(`[${m.type()}] ${s}`); console.log("CONSOLE:", s.slice(0, 300));
  }
});
page.on("pageerror", (e) => { log.push(`[pageerror] ${e.message}`); console.error("PAGE ERROR:", e.message); });

// ---- A. CAMPFIRE CHARACTER SELECT (shadowMap.autoUpdate is off globally) --
await page.goto(`${base}/iso.html?debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(9000);
await page.getByText("NEW RUN", { exact: false }).first().click().catch((e) => console.log("click NEW RUN failed", e.message));
await page.waitForTimeout(9000);
await page.screenshot({ path: `${out}/A-campfire.png` });
console.log("CAMPFIRE:", JSON.stringify(await page.evaluate(() => {
  const r = window.__dcc?.renderer;
  return { auto: r?.renderer?.shadowMap?.autoUpdate, enabled: r?.renderer?.shadowMap?.enabled };
})));

// ---- B. IN-GAME FLOOR TRANSITION ---------------------------------------
await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
for (let i = 0; i < 120 && !armed; i++) await page.waitForTimeout(500);
await page.evaluate(() => window.__dcc.renderer.setQuality("ultra"));
await page.waitForTimeout(2000);

const snap = () => page.evaluate(() => {
  const r = window.__dcc.renderer, s = window.__dcc.state;
  // Every mesh the renderer parks per-entity, however it tags them.
  let tagged = 0;
  r.scene.traverse((o) => { if (o.userData && Object.keys(o.userData).some((k) => /id$/i.test(k))) tagged++; });
  return {
    floor: s.floor, seed: s.seed ?? null,
    mapSize: `${s.map.w}x${s.map.h}`,
    stairs: `${s.map.stairs.x},${s.map.stairs.y}`,
    player: `${s.players[0].pos.x.toFixed(1)},${s.players[0].pos.y.toFixed(1)}`,
    monsters: s.monsters.length,
    explored: s.explored ? s.explored.reduce((a, b) => a + (b ? 1 : 0), 0) : null,
    taggedMeshes: tagged, sceneChildren: r.scene.children.length,
    tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries,
    programs: r.renderer.info.programs.length,
  };
});
console.log("BEFORE:", JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/B1-before.png` });

console.log("teleport:", await page.evaluate(() => {
  const s = window.__dcc.state;
  s.players[0].pos.x = s.map.stairs.x + 0.5;
  s.players[0].pos.y = s.map.stairs.y + 0.5;
  return `${s.players[0].pos.x},${s.players[0].pos.y}`;
}));
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/B2-on-stairs.png` });
for (let i = 0; i < 8; i++) { await page.keyboard.press("e"); await page.waitForTimeout(400); }
await page.waitForTimeout(4000);
console.log("AFTER :", JSON.stringify(await snap()));
await page.screenshot({ path: `${out}/B3-after-descent.png` });
await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/B4-after-descent-moved.png` });
console.log("MOVED :", JSON.stringify(await snap()));

// ---- C. 40 PRESET SWITCHES: how many composed frames see a NULL shadow map?
const nullFrames = await page.evaluate(async () => {
  const r = window.__dcc.renderer;
  let frames = 0, nulls = 0, switches = 0;
  const orig = r.render.bind(r);
  r.render = function () { orig(); frames++; if (!r.key.shadow.map) nulls++; };
  const order = ["ultra", "high", "balanced", "performance"];
  for (let i = 0; i < 40; i++) {
    r.setQuality(order[i % 4]); switches++;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }
  r.render = orig;
  return { frames, nulls, switches };
});
console.log("NULL-SHADOW-MAP FRAMES:", JSON.stringify(nullFrames));

writeFileSync(`${out}/console.log`, log.join("\n"));
console.log(`CONSOLE LINES: ${log.length}`);
await browser.close();
