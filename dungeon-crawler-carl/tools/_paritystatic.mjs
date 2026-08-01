// STATIC PARITY FRAME — the controlled experiment the beauty suite cannot be.
//
// The beauty frames walk the hero, so the camera lands a few pixels apart on
// every run and a pixel diff between two builds is dominated by staging noise.
// This boots the SAME seeded floor, moves NOTHING, freezes the animation clock
// at a fixed offset, and shoots. Two builds shot this way differ ONLY by the
// renderer, so a per-pixel diff is meaningful.
// Usage: node tools/_paritystatic.mjs <outDir> <tag> --base URL [--quality Q]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2];
const TAG = process.argv[3];
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : ""; };
const BASE = (arg("--base") || "http://localhost:5285").replace(/\/$/, "");
const Q = arg("--quality");
// --dpr 2 reproduces the owner's actual panel (HiDPI). It is the ONLY way to
// see what a preset's pixelRatioCap costs: at deviceScaleFactor 1 every cap at
// or above 1 is inert, so a capped preset shot at dpr 1 looks free when on the
// real display it is rendering at a fraction of native and being upscaled.
const DPR = +(arg("--dpr") || 1);
// A single scene by name, so the expensive HiDPI passes do not shoot all three.
const ONLY = arg("--only");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

const SCENES = [
  { name: "static-f2", floor: 2, level: 4, seed: 11 },
  { name: "static-f14", floor: 14, level: 18, seed: 51 },
  { name: "static-f8", floor: 8, level: 12, seed: 31 },
];

for (const s of SCENES) {
  if (ONLY && s.name !== ONLY) continue;
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: DPR });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  const url = `${BASE}/iso.html?test&clean=1&debug=1&view=close&floor=${s.floor}&level=${s.level}&seed=${s.seed}&eagerassets${Q ? `&quality=${Q}` : ""}`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
  }, null, { timeout: 120000 }).catch(() => {});
  // Pin the hero to the room centre so the camera is a pure function of the
  // seed, then let the fog reveal and the camera ease settle.
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    if (p.skin !== "knight") p.skin = "knight";
    p.facing.x = 0; p.facing.y = 1;
    // Nothing moves: no monsters chasing, no telegraphs, no FX lights.
    for (const m of st.monsters) { m.dormant = true; m.windup = 0; m.windupKind = undefined; }
    if (st.projectiles) st.projectiles.length = 0;
    if (st.hazards) st.hazards.length = 0;
  }).catch(() => {});
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const t = document.getElementById("toasts");
    if (t) t.style.display = "none";
    for (const el of document.querySelectorAll(".toast")) el.remove();
    for (const a of document.getAnimations()) a.pause();
  }).catch(() => {});
  const path = `${OUT}/${s.name}-${TAG}.png`;
  await page.screenshot({ path, timeout: 240000 });
  console.log("saved", path);
  await page.close();
}

await browser.close();
