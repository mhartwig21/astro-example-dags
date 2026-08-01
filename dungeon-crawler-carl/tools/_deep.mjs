// Deep correctness pass, real GPU.
//  1. Shadow-map state across a preset switch (applyQuality nulls key.shadow.map
//     but render() only re-arms it every shadowInterval frames).
//  2. A REAL in-game floor transition (teleport onto the stairs, press E) —
//     stale monsters / fog / dressing after a floor rebuild.
//  3. A boss floor.
//  4. The campfire character-select scene (shadowMap.autoUpdate is off globally;
//     charSelect now arms its own rebuild).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const out = flag("--out", "tools/_deep");
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
  if (m.type() === "error" || /shader-guard] program|THREE\.WebGL|GL_INVALID|NaN/i.test(s)) {
    log.push(`[${m.type()}] ${s}`); console.log("CONSOLE:", s.slice(0, 300));
  }
});
page.on("pageerror", (e) => { log.push(`[pageerror] ${e.message}`); console.error("PAGE ERROR:", e.message); });

await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
for (let i = 0; i < 120 && !armed; i++) await page.waitForTimeout(500);
console.log("guard armed:", armed);
await page.waitForTimeout(1500);

// ---- 1. SHADOW MAP ACROSS PRESET SWITCHES ------------------------------
for (const [from, to] of [["ultra", "balanced"], ["balanced", "performance"], ["performance", "ultra"]]) {
  const t = await page.evaluate(async ([a, b]) => {
    const r = window.__dcc.renderer;
    r.setQuality(a);
    await new Promise((res) => setTimeout(res, 700));
    const trace = [];
    const orig = r.render.bind(r);
    r.render = function () {
      const before = r.key.shadow.map ? "map" : "NULL";
      orig();
      trace.push(`${before}->${r.key.shadow.map ? `${r.key.shadow.map.width}` : "NULL"}`);
    };
    r.setQuality(b);
    await new Promise((res) => setTimeout(res, 400));
    r.render = orig;
    return trace.slice(0, 10);
  }, [from, to]);
  console.log(`SHADOW ${from}->${to}: ${t.join("  ")}`);
}
await page.evaluate(() => window.__dcc.renderer.setQuality("ultra"));
await page.waitForTimeout(800);

// ---- 2. REAL FLOOR TRANSITION ------------------------------------------
const worldSnap = () => page.evaluate(() => {
  const r = window.__dcc.renderer, s = window.__dcc.state;
  let mobMeshes = 0, dressing = 0;
  r.scene.traverse((o) => {
    if (o.userData?.mobId !== undefined || o.userData?.entityId !== undefined) mobMeshes++;
    if (o.isInstancedMesh) dressing += o.count;
  });
  return {
    floor: s.floor?.index ?? s.floorNo ?? s.floor,
    monsters: s.monsters?.length ?? null,
    aliveMonsters: s.monsters?.filter?.((m) => m.hp > 0).length ?? null,
    exploredTrue: s.explored ? [...s.explored].filter(Boolean).length : null,
    mobMeshes, dressingInstances: dressing,
    sceneChildren: r.scene.children.length,
    tex: r.renderer.info.memory.textures, geo: r.renderer.info.memory.geometries,
    programs: r.renderer.info.programs.length,
  };
});
console.log("BEFORE DESCENT:", JSON.stringify(await worldSnap()));
await page.screenshot({ path: `${out}/1-before-descent.png` });

const teleported = await page.evaluate(() => {
  const s = window.__dcc.state;
  const st = s.floor?.stairs;
  const p = s.players?.[0];
  if (!st || !p) return false;
  p.pos.x = st.x + 0.5; p.pos.y = st.y + 0.5;
  return true;
});
console.log("teleported to stairs:", teleported);
await page.waitForTimeout(900);
for (let i = 0; i < 6; i++) { await page.keyboard.press("e"); await page.waitForTimeout(450); }
await page.waitForTimeout(3500);
console.log("AFTER DESCENT :", JSON.stringify(await worldSnap()));
await page.screenshot({ path: `${out}/2-after-descent.png` });

// Walk a little so stale-position bugs show as mobs sliding/frozen.
await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w");
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/3-after-descent-moved.png` });

// ---- 3. BOSS FLOOR ------------------------------------------------------
await page.goto(`${base}/iso.html?test&floor=6&level=20&seed=3&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.__dcc.renderer.setQuality("ultra"));
for (let i = 0; i < 10; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(500); await page.keyboard.up("w");
  for (const k of ["Space", "q", "c", "f"]) await page.keyboard.press(k).catch(() => {});
  await page.waitForTimeout(400);
}
await page.waitForTimeout(1200);
console.log("BOSS FLOOR    :", JSON.stringify(await worldSnap()));
await page.screenshot({ path: `${out}/4-boss.png` });

// ---- 4. CAMPFIRE CHARACTER SELECT --------------------------------------
await page.goto(`${base}/iso.html?debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: `${out}/5-charselect.png` });
const cs = await page.evaluate(() => {
  const r = window.__dcc?.renderer;
  return { shadowAuto: r?.renderer?.shadowMap?.autoUpdate, shadowEnabled: r?.renderer?.shadowMap?.enabled };
});
console.log("CHARSELECT:", JSON.stringify(cs));

writeFileSync(`${out}/console.log`, log.join("\n"));
console.log(`\nCONSOLE LINES: ${log.length}`);
await browser.close();
