// Real-GPU, real-clock verification of the r1 combat beat: stage the melee
// crit kill and screenshot on the next few composited frames (~2 at 60fps
// lands mid-impact). No virtual clock — this is what a player's GPU draws.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/real";
console.log("[census]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(
  "http://localhost:5282/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets&quality=medium",
  { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || l.classList.contains("done") || l.style.display === "none" ||
    getComputedStyle(l).opacity === "0" || l.getBoundingClientRect().width === 0;
}, null, { timeout: 120000 });
await page.waitForTimeout(3500);
const gpu = await page.evaluate(() => {
  const g = window.__dcc.renderer.renderer.getContext();
  const d = g.getExtension("WEBGL_debug_renderer_info");
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GAME CONTEXT GPU:", gpu);
if (!/Intel/i.test(gpu)) { console.error("not the Intel part"); await browser.close(); process.exit(1); }

const STAGE = `(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  p.hp = p.maxHp || p.hp;
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 1.4; p.pos.y = best.pos.y + 0.4;
  p.facing.x = -1; p.facing.y = 0;
  const ring = live.sort((a, b) =>
    Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
    Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y)).slice(0, 5);
  ring.forEach((m, k) => {
    const a = (k / Math.max(ring.length, 1)) * Math.PI * 2 + 2.6;
    m.pos.x = p.pos.x + Math.cos(a) * (1.5 + (k % 2) * 0.5);
    m.pos.y = p.pos.y + Math.sin(a) * (1.5 + (k % 2) * 0.5);
  });
  const dcc = window.__dcc;
  p.attackSwing = 0.15;
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.2);
  near.slice(0, 3).forEach((m, i) => {
    m.hitFlash = 0.3;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: i === 0 ? 188 : 42,
      kind: i === 0 ? "crit" : "enemy", dir: { x: -0.9, y: -0.3 },
      killed: i === 0, overkill: i === 0 });
  });
})()`;

for (let shot = 0; shot < 3; shot++) {
  await page.waitForTimeout(1800); // settle between beats
  await page.evaluate(STAGE);
  await page.waitForTimeout(shot * 40 + 30); // land at ~30 / ~70 / ~110ms real
  await page.screenshot({ path: `${OUT}/real-${shot}.png`, timeout: 60000 });
  console.log("saved real-" + shot);
}
await browser.close();
console.log("[census end]", JSON.stringify(census()));
