// LOOK SHOTS — the frames the appearance score is read off.
//
// One browser session, REAL GPU (ANGLE D3D11; SwiftShader frames are worthless
// and tools/shot.mjs still uses it, which is why this exists), one floor per
// band, captured QUIET: no ability spam, because a fullscreen telegraph disc
// under the camera turns a colour audit into a measurement of one FX (the first
// A/B run of this round produced exactly that — a control frame reading 100%
// chromatic because an ultimate happened to be mid-cast).
//
// Every shot is PROVEN before it is written: the boot card must have no box,
// the crawler must be alive, and the death/verdict panel must be off screen.
// A frame that does not contain what it claims is worse than a missing frame,
// so a scene that fails is recorded as MISSED and no PNG is passed off as one.
//
// Also writes a 2x-zoom CROP centred on the crawler for each floor: the surface
// detail this round adds is a 15-25 cm feature and it is not judgeable at
// 1440-wide-fit-to-page.
//
// Usage: node tools/lookshots.mjs [--port 5282] [--out tools/_look]
//                                 [--floors 2,5,8,11,14,17]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_look");
const floors = flag("--floors", "2,5,8,11,14,17").split(",").map(Number);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
const shaderErrors = [];
page.on("console", (m) => { const t = m.text(); if (/shader error|THREE\.WebGLProgram|ERROR: 0:/i.test(t)) shaderErrors.push(t.slice(0, 300)); });

await page.addInitScript(() => {
  const w = window;
  const pump = () => {
    try { const st = w.__dcc && w.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* not up */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const results = [];
for (const floor of floors) {
  const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}&abilities=all&seed=41&eagerassets&clean=1&debug=1`;
  console.log(`\n== floor ${floor}\n${url}`);
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.bringToFront();

  if (floor === floors[0]) {
    const gpu = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2");
      const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
    });
    console.log("GPU:", gpu);
    if (/SwiftShader|Software|llvmpipe/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }
  }

  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
    const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 12;
  }, { timeout: 120000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(3000);

  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (box && box.w > 0 && box.h > 0 && box.display !== "none" && box.opacity > 0.01) {
    console.error(`floor ${floor}: BOOT CARD STILL UP — MISSED`);
    results.push({ floor, status: "MISSED_BOOT_CARD" });
    continue;
  }

  // Walk into the room so the shot is a room, not the spawn nook. No abilities:
  // this frame is scored for the WORLD's colour, not for one telegraph.
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(700); await page.keyboard.up("d");
  await page.waitForTimeout(1600);

  // A frame must contain what it claims. Beyond "alive, not on the death card"
  // this also rejects the RINGSIDE INTRODUCTION splash and the cinematic
  // letterbox: the first run of this tool scored floor 8 at 16 hue bins over a
  // 210-degree arc, and the frame was an ELITE name card with gold type and
  // black bars over a blurred world. That is a measurement of the title card,
  // not of the district — laundering someone else's pixels into this round's
  // evidence. If the card is up, wait it out and retry rather than score it.
  const gameplayClaim = () => page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    const up = (id) => {
      const e = document.getElementById(id);
      if (!e) return false;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01;
    };
    return {
      hp: p ? p.hp : -1,
      recapUp: up("recap"),
      introUp: up("bossintro"),
      cine: document.body.classList.contains("cine"),
      explored: st.explored.reduce((a, b) => a + (b ? 1 : 0), 0),
    };
  });
  let claim = await gameplayClaim();
  for (let tries = 0; tries < 12 && (claim.recapUp || claim.introUp || claim.cine); tries++) {
    console.log(`floor ${floor}: overlay up (${JSON.stringify(claim)}) — waiting it out`);
    await page.waitForTimeout(1500);
    claim = await gameplayClaim();
  }
  if (!(claim.hp > 0) || claim.recapUp || claim.introUp || claim.cine) {
    console.error(`floor ${floor}: NOT A WORLD FRAME — MISSED ${JSON.stringify(claim)}`);
    results.push({ floor, status: "MISSED_NOT_GAMEPLAY", claim });
    continue;
  }

  const shot = `${outDir}/f${floor}.png`;
  await page.screenshot({ path: shot });
  // 2x crop around the crawler (screen centre-ish for the player-locked iso cam)
  await page.screenshot({ path: `${outDir}/f${floor}_zoom.png`, clip: { x: 520, y: 250, width: 400, height: 260 } });
  console.log(`floor ${floor}: OK  explored=${claim.explored}  -> ${shot}`);
  results.push({ floor, status: "OK", shot, claim });
}

writeFileSync(`${outDir}/look.json`, JSON.stringify({ results, shaderErrors }, null, 2));
console.log(`\n${results.filter((r) => r.status === "OK").length}/${results.length} scenes OK`);
if (shaderErrors.length) console.log("SHADER ERRORS:", shaderErrors.slice(0, 3));
await browser.close();
