// FX r2: Fault Line detonation re-check after the footprint height cap.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";
import { mkdirSync } from "node:fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/trk-look/dungeon-crawler-carl/tools/_fxr2";
mkdirSync(OUT, { recursive: true });
console.log("[census BEFORE]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.goto("http://localhost:5282/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets&quality=medium", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => !!window.__dcc?.state, null, { timeout: 240000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || l.classList.contains("done") || l.style.display === "none" ||
    getComputedStyle(l).opacity === "0" || l.getBoundingClientRect().width === 0;
}, null, { timeout: 120000 });
await page.waitForFunction(() => !!window.__dcc.renderer, null, { timeout: 90000 });
await page.evaluate(() => {
  const pin = () => {
    const st = window.__dcc?.state;
    if (st) for (const p of st.players) { p.hp = p.maxHp; p.alive = true; }
    requestAnimationFrame(pin);
  };
  requestAnimationFrame(pin);
});
await page.bringToFront();
await page.waitForTimeout(3000);
const gpu = await page.evaluate(() => {
  const g = window.__dcc.renderer.renderer.getContext();
  const d = g.getExtension("WEBGL_debug_renderer_info");
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
});
if (!/Intel/i.test(gpu)) throw new Error("not Intel: " + gpu);
console.log("GPU ok:", gpu.slice(0, 40));

const aim = await page.evaluate(`(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let pick = live[0], bestScore = -1e9;
  for (const m of live) {
    const n = live.filter((o) => o !== m && Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4).length;
    if (-n > bestScore) { bestScore = -n; pick = m; }
  }
  p.pos.x = pick.pos.x + 4.0; p.pos.y = pick.pos.y + 0.3;
  p.facing.x = -1; p.facing.y = 0;
  const s = window.__dcc.renderer.worldToScreen(pick.pos.x, 0.9, pick.pos.y);
  return { sx: s.x, sy: s.y, vis: s.visible };
})()`);
await page.waitForTimeout(200);
if (aim.vis) await page.mouse.move(aim.sx, aim.sy);
await page.keyboard.down("f");
await page.waitForTimeout(150);
await page.keyboard.up("f");
for (const [i, wait] of [[0, 100], [1, 300], [2, 400], [3, 500]].values()) {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/G3-fault-${i}.png`, timeout: 60000 });
}
console.log("saved G3-fault 0..3; hazards:", await page.evaluate(() => window.__dcc.state.hazards.map((h) => h.kind).join(",")));
await browser.close();
console.log("[census AFTER]", JSON.stringify(census()));
