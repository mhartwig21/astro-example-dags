// REAL-TIME burst capture (no virtual clock): drive a genuine melee fight on a
// real GPU and grab N frames back-to-back, so short-lived FX (0.19s swing arc,
// 0.07s impact core, projectile ribbons) either appear in a frame or provably
// do not. Usage:
//   node burst.mjs --base http://localhost:5410 --out DIR --n 14 --gap 90
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = flag("--base", "http://localhost:5410").replace(/\/$/, "");
const OUT = flag("--out", "");
const N = Number(flag("--n", 14));
const GAP = Number(flag("--gap", 90));
if (!OUT) { console.error("--out required"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${BASE}/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets`,
  { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return gl.getParameter(d.UNMASKED_RENDERER_WEBGL);
}));

await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
// Park the crawler in the densest pack; no monster teleporting, no clock patch.
const info = await page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  if (!live.length) return null;
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 1.2; p.pos.y = best.pos.y + 0.3;
  p.facing.x = -1; p.facing.y = 0;
  return { n: bestN };
});
if (!info) { console.error("no pack"); process.exit(1); }
await page.waitForTimeout(2500);

// Real attack input: hold the melee key so the sim swings on its own cadence.
await page.mouse.move(500, 330);
await page.keyboard.down(" ");
for (let i = 0; i < N; i++) {
  await page.screenshot({ path: `${OUT}/burst${String(i).padStart(2, "0")}.png`, timeout: 120000 });
  await page.waitForTimeout(GAP);
}
await page.keyboard.up(" ");
await browser.close();
console.log("burst done");
