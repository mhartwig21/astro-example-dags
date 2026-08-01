// ENV-PANEL COMBAT BEAUTY SHOT — a single frame that must prove combat
// readability in the environment review: 4+ enemies engaged around the
// crawler, an active swing arc AND a Bolt projectile in flight, hit-flash +
// damage numbers on struck enemies, a live telegraph, and the player's HP
// visibly below max. Stages via the ?debug=1 window.__dcc hook like
// tools/combatshot.mjs, under the same VIRTUAL CLOCK (audit r4): rAF time is
// frozen the moment combat is staged, then advanced in ~16ms slices so the
// SwiftShader-composited frame catches every FX mid-life instead of seconds
// after they died. The pack is PULLED into a ring around the player (audit
// r4: teleporting to "the densest pack" kept shipping combat-free frames
// when the pack had scattered by composite time).
// Usage: node tools/envcombatshot.mjs <out.png> [base-url]
import { chromium } from "playwright";

const out = process.argv[2];
if (!out) { console.error("usage: node tools/envcombatshot.mjs <out.png> [base]"); process.exit(1); }
const BASE = process.argv[3] ?? "http://localhost:5285/iso.html";
const URL = `${BASE}?test&debug=1&floor=8&level=16&abilities=all&seed=41&eagerassets`;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });

/** Evaluate with retry — vite full-reloads (concurrent agents) wipe __dcc. */
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

// Idempotent in-page virtual clock (see combatshot.mjs).
function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}

// Sanity prologue: any live monsters at all? (Also reveals the map region.)
const live0 = await ev(() => {
  const st = window.__dcc.state;
  st.players[0].hp = st.players[0].maxHp || st.players[0].hp;
  return st.monsters.filter((m) => !m.dormant && m.hp > 0).length;
});
if (!live0) { console.error("no live monsters to stage against"); process.exit(1); }
console.log(live0, "live monsters on the floor");
// HERO RIG GUARD (audit r5 blocker): HMR storms can abort GLB fetches and
// "settle" on the capsule fallback — a review shot must show the real rig.
for (let i = 0; i < 6; i++) {
  const rig = await ev(() => {
    const r = window.__dcc.renderer;
    const mesh = [...r.playerMeshes.values()][0];
    // The fallback capsule tags userData.body; "none" = first frame pending.
    return mesh ? (mesh.userData.body ? "fallback" : "rigged") : "none";
  });
  if (rig === "rigged") break;
  if (rig === "none") { await page.waitForTimeout(1500); continue; }
  if (i === 5) { console.error("hero rig never loaded"); process.exit(1); }
  console.log("hero is the fallback capsule — reloading for real assets");
  await page.reload({ waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
}
await page.waitForTimeout(4000); // fog reveal, camera settle

for (let i = 0; i < 3; i++) {
  try {
    await ev(`(() => {
      (${vclock.toString()})();
      const dcc = window.__dcc;
      const st = dcc.state;
      const p = st.players[0];
      // Mid-fight truth: HP visibly down (the HUD reads sim state directly).
      p.hp = Math.max(1, Math.floor((p.maxHp || 100) * 0.58));
      p.facing.x = -1; p.facing.y = 0;
      // PULL THE FIGHT TO THE CRAWLER: ring the 5 nearest live monsters
      // around the player so the engagement is guaranteed in frame.
      const live = st.monsters.filter((m) => !m.dormant && m.hp > 0)
        .sort((a, b) =>
          Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
          Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
        .slice(0, 5);
      live.forEach((m, k) => {
        const a = (k / Math.max(live.length, 1)) * Math.PI * 2 + 0.5;
        m.pos.x = p.pos.x + Math.cos(a) * (1.5 + (k % 2) * 0.5);
        m.pos.y = p.pos.y + Math.sin(a) * (1.5 + (k % 2) * 0.5);
      });
      // One committed windup: the shader telegraph arms mid-ring.
      if (live[3]) { live[3].windupKind = "slam"; live[3].windupTotal = 1.2; live[3].windup = 0.55; }
      // Active swing (renderer edge-detects the rise -> arc + combo clip).
      p.attackSwing = 0.15;
      // A Bolt in flight, crossing the frame toward the pack.
      st.projectiles.push({
        id: 990101, pos: { x: p.pos.x + 2.2, y: p.pos.y + 1.1 },
        vel: { x: -5.2, y: -2.4 }, damage: 12, ttl: 2.5,
        from: "player", ownerId: p.id, school: "magic",
      });
      // Hit-flash + real hit events (damage numbers) on the nearest enemies.
      const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
      live.slice(0, 3).forEach((m, k) => {
        m.hitFlash = 0.3;
        emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 28 + k * 9,
          kind: k === 0 ? "crit" : "enemy", dir: { x: -0.9, y: -0.3 } });
      });
      // The player takes one on the chin too (screen-edge damage feedback).
      emit({ pos: { x: p.pos.x, y: p.pos.y }, amount: 17, kind: "player",
        dir: { x: 0.8, y: 0.4 } });
    })()`);
    // Age the frozen fight ~96ms across real frames: sparks mid-arc, swing
    // arc mid-sweep, ribbon grown, hit-flash still hot.
    for (let s = 0; s < 6; s++) {
      await page.evaluate((m) => window.__vt && window.__vt.advance(m), 16);
      await page.waitForTimeout(450);
    }
    // Re-emit the hits right before capture: DOM damage numbers ride the
    // real CSS clock and the first batch expired during the slices.
    await ev(`(() => {
      const dcc = window.__dcc;
      const st = dcc.state;
      const p = st.players[0];
      const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
      st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
        Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.2).slice(0, 3)
        .forEach((m, k) => {
          m.hitFlash = 0.3;
          emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 28 + k * 9,
            kind: k === 0 ? "crit" : "enemy", dir: { x: -0.9, y: -0.3 } });
        });
      emit({ pos: { x: p.pos.x, y: p.pos.y }, amount: 17, kind: "player",
        dir: { x: 0.8, y: 0.4 } });
    })()`);
    await page.evaluate(() => window.__vt && window.__vt.advance(24));
    await page.waitForTimeout(450); // one composited frame with numbers up
    // COMBAT CONTRACT (audit r5 blocker): verify the ring actually held — a
    // vite full-reload mid-slice wipes the staging and ships an empty frame.
    const engaged = await ev(() => {
      const st = window.__dcc.state;
      const p = st.players[0];
      return st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
        Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.6).length;
    });
    if (engaged < 2) throw new Error(`engagement lost (only ${engaged} enemies in range)`);
    await page.screenshot({ path: out, timeout: 240000 });
    console.log("saved", out);
    break;
  } catch (e) {
    console.error(`attempt ${i + 1} failed:`, e.message.split("\n")[0]);
    if (i === 2) process.exit(1);
  }
}
await browser.close();
