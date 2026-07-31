// Combat showcase capture: deterministically stages a fight via the ?debug=1
// window.__dcc hook (teleport next to a live pack, then fire the renderer's
// real edge-triggered FX paths off sim state) and grabs three frames:
//   1. mid-swing   — swing arc + sparks over the pack
//   2. mid-impact  — impact flash, hit-flash pop, shock ring, killing-blow decal
//   3. ability burst — nova ring + cast gather + burst
// SwiftShader renders seconds-per-frame, so each stage is (re)injected right
// before the screenshot: the next composited frame catches the FX mid-life.
// Robust against vite full-reloads (concurrent agents editing the checkout):
// every stage re-waits for the hook and re-teleports before firing.
// Usage: node tools/combatshot.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
const URL =
  "http://localhost:5285/iso.html?test&debug=1&floor=6&level=14&abilities=all&seed=77&eagerassets";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });

/** Evaluate with retry: a vite full-reload (other agents saving files) can
 * wipe window.__dcc at any moment — re-wait and re-run until it sticks. */
async function ev(fn) {
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
      return await page.evaluate(fn);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(2500);
    }
  }
  throw lastErr;
}

// Idempotent staging prologue, evaluated inside the page before every shot:
// teleport the crawler adjacent to the densest live pack and face it.
// (Deterministic: same seed -> same monsters -> same pick, even after reload.)
function teleport() {
  const st = window.__dcc.state;
  const p = st.players[0];
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
  return { x: best.pos.x, y: best.pos.y, packSize: bestN };
}

const staged = await ev(teleport);
if (!staged) { console.error("no live monsters to stage against"); process.exit(1); }
console.log("staged next to pack of", staged.packSize, "at", staged.x, staged.y);
// Let the sim notice (fog reveal, aggro, camera snap) and monsters wind up.
await page.waitForTimeout(5000);

async function shot(name, stage) {
  const path = `${OUT}/${name}.png`;
  // SwiftShader + concurrent captures on this box can push a single frame
  // past two minutes — retry the whole stage+capture rather than giving up.
  for (let i = 0; i < 3; i++) {
    try {
      await ev(stage);
      await page.screenshot({ path, timeout: 240000 });
      console.log("saved", path);
      return;
    } catch (e) {
      console.error(`shot ${name} attempt ${i + 1} failed:`, e.message.split("\n")[0]);
    }
  }
  throw new Error(`shot ${name} failed after retries`);
}

// 1) MID-SWING: bump the sim's swing timer (the renderer edge-detects the
// rise: swing arc + combo clip) and land two real enemy-hit events.
await shot("r2-fx-combat1", `(() => {
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.attackSwing = 0.15;
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 2.6);
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  for (const m of near.slice(0, 2)) {
    m.hitFlash = 0.12;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 34, kind: "enemy",
      dir: { x: -1, y: 0 } });
  }
})()`);

// 2) MID-IMPACT: a crit killing blow with overkill — impact flash, sparks,
// shock ring, bloom kick, blood decal, corpse launch claim.
await shot("r2-fx-combat2", `(() => {
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.attackSwing = 0.15;
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.2);
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  for (let i = 0; i < near.length; i++) {
    const m = near[i];
    m.hitFlash = 0.12;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 88,
      kind: i === 0 ? "crit" : "enemy", dir: { x: -0.8, y: -0.4 },
      killed: i === 0, overkill: i === 0 });
  }
})()`);

// 3) ABILITY BURST: light the nova flash (ring + burst + FX light) plus the
// cast-gather anticipation off the nova cooldown edge.
await shot("r2-fx-combat3", `(() => {
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.novaFlash = 0.4;
  p.cd.nova = (p.cd.nova ?? 0) + 6; // cd edge -> cast clip + gather burst
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 4);
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  for (const m of near) m.hitFlash = 0.12;
  for (const m of near) emit({
    pos: { x: m.pos.x, y: m.pos.y }, amount: 41, kind: "enemy",
    dir: { x: (m.pos.x - p.pos.x) / 3, y: (m.pos.y - p.pos.y) / 3 },
  });
})()`);

await browser.close();
console.log("combat panel done");
