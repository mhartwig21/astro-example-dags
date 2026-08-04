// COMBAT FX r1 filmstrip v2 — contamination-bounded protocol.
// v1 lesson (capture honesty): under a frozen virtual clock, real composited
// frames accumulate render-side energy while FX lifetimes stand still, so a
// shot's wash grows with how LONG the harness dawdled — the later frames of a
// v1 strip photograph the harness, not the game. v2 flushes all live FX
// (+1.6s virtual) then restages the beat fresh for EVERY offset, so each shot
// carries the same small real-frame budget and offsets are comparable.
// Usage: node tools/_r1strip2.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/strip2";
const URL =
  "http://localhost:5282/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets&quality=medium";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || l.classList.contains("done") || l.style.display === "none" ||
    getComputedStyle(l).opacity === "0" || l.getBoundingClientRect().width === 0;
}, null, { timeout: 120000 });
await page.waitForTimeout(5000);

function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}

function teleport() {
  const st = window.__dcc.state;
  const p = st.players[0];
  p.hp = p.maxHp || p.hp;
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  if (live.length === 0) return null;
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 1.4;
  p.pos.y = best.pos.y + 0.4;
  p.facing.x = -1; p.facing.y = 0;
  const ring = live
    .sort((a, b) =>
      Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
      Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 5);
  ring.forEach((m, k) => {
    const a = (k / Math.max(ring.length, 1)) * Math.PI * 2 + 2.6;
    m.pos.x = p.pos.x + Math.cos(a) * (1.5 + (k % 2) * 0.5);
    m.pos.y = p.pos.y + Math.sin(a) * (1.5 + (k % 2) * 0.5);
  });
  return { packSize: bestN };
}

const MELEE = `(() => {
  (${vclock.toString()})();
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
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

async function jump(ms) {
  await page.evaluate((m) => window.__vt && window.__vt.advance(m), ms);
  await page.waitForTimeout(500);
}

for (const off of [8, 40, 80, 140, 220]) {
  // Flush: age everything out, in a few composited slices.
  for (let i = 0; i < 4; i++) await jump(400);
  await page.evaluate(MELEE);
  const engaged = await page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    return st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
      Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.6).length;
  });
  if (engaged < 2) { console.error(`offset ${off}: ENGAGEMENT LOST (${engaged})`); continue; }
  await jump(off);
  await page.screenshot({ path: `${OUT}/melee-${String(off).padStart(3, "0")}ms.png`, timeout: 240000 });
  console.log(`saved melee-${off}ms (engaged ${engaged})`);
}

await browser.close();
console.log("strip2 done");
