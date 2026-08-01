// Combat showcase capture: deterministically stages a fight via the ?debug=1
// window.__dcc hook (teleport next to a live pack, then fire the renderer's
// real edge-triggered FX paths off sim state) and grabs three frames:
//   1. mid-swing   — swing arc + sparks over the pack
//   2. mid-impact  — impact flash, hit-flash pop, shock ring, killing-blow decal
//   3. ability burst — nova ring + cast gather + burst
// VIRTUAL CLOCK (audit r4): SwiftShader composites seconds after staging, so
// every 70-400ms FX was dead in the captured frame. Each stage now patches
// requestAnimationFrame with a near-frozen virtual timestamp (+0.4ms/frame),
// stages the fight under the frozen clock, then advances time in ~16ms slices
// across several real frames — the screenshot lands ~90ms into the impact,
// with trails grown, sparks mid-arc and hit-flash still hot.
// Robust against vite full-reloads (concurrent agents editing the checkout):
// every stage re-waits for the hook, re-teleports and re-patches the clock.
// Usage: node tools/combatshot.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
const URL =
  "http://localhost:5285/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets";

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

// Idempotent in-page virtual clock: freezes the rAF timestamp (+0.4ms/frame,
// never zero-dt) and exposes __vt.advance(ms) to age FX deterministically.
function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}

// Idempotent staging prologue, evaluated inside the page before every shot:
// teleport the crawler adjacent to the densest live pack, then PULL the five
// nearest live monsters into a tight ring around it (audit r4: packs kept
// scattering during the aggro wait, shipping near-empty "combat" frames).
// (Deterministic: same seed -> same monsters -> same pick, even after reload.)
function teleport() {
  const st = window.__dcc.state;
  const p = st.players[0];
  // Keep the staged crawler alive across stages (the pack we park next to
  // hits hard; a death screen would eat the later shots).
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
  return { x: best.pos.x, y: best.pos.y, packSize: bestN };
}

// HERO RIG GUARD (audit r5 blocker): concurrent-agent HMR storms can abort
// GLB fetches — assets "settle" with the capsule fallback and the combat
// shot ships a salmon capsule hero. Reload until the rigged model is live.
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

const staged = await ev(teleport);
if (!staged) { console.error("no live monsters to stage against"); process.exit(1); }
console.log("staged next to pack of", staged.packSize, "at", staged.x, staged.y);
// Let the sim notice (fog reveal, aggro, camera snap) and monsters wind up.
await page.waitForTimeout(5000);

/** Age the frozen scene in small slices across real frames: trails and
 * particle motion need several rAF ticks, not one 90ms jump. */
async function settle(slices, ms) {
  for (let i = 0; i < slices; i++) {
    await page.evaluate((m) => window.__vt && window.__vt.advance(m), ms);
    await page.waitForTimeout(450);
  }
}

// Re-emit the stage's hit events AFTER the slices, right before the shot:
// DOM damage numbers ride the real CSS clock, so numbers emitted at stage
// time are gone by capture — a fresh emit + hot hitFlash lands them (and a
// hot body flash) exactly on the captured frame.
const rehit = `(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.4).slice(0, 4);
  near.forEach((m, k) => {
    m.hitFlash = 0.3;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: [34, 88, 123, 41][k % 4],
      kind: k === 1 ? "crit" : "enemy",
      dir: { x: (m.pos.x - p.pos.x) / 2, y: (m.pos.y - p.pos.y) / 2 } });
  });
})()`;

async function shot(name, stage, slices = 6, sliceMs = 15, finale = null) {
  const path = `${OUT}/${name}.png`;
  // SwiftShader + concurrent captures on this box can push a single frame
  // past two minutes — retry the whole stage+capture rather than giving up.
  for (let i = 0; i < 3; i++) {
    try {
      await ev(stage);
      await settle(slices, sliceMs);
      await ev(rehit);
      await page.evaluate(() => window.__vt && window.__vt.advance(24));
      await page.waitForTimeout(450); // one composited frame with numbers up
      // FINALE restage (audit r5): sim-owned content (projectiles, windups)
      // ages on the REAL clock during the slices — anything staged up front
      // is dead by capture. The finale re-arms it seconds before the shot,
      // then a short real-time wait lets ribbons grow from rendered frames.
      if (finale) {
        await ev(finale);
        await page.waitForTimeout(1300);
      }
      // COMBAT CONTRACT (audit r5 blocker): a combat shot with no combat is
      // an automatic review blocker — verify the engagement actually held
      // (staging can silently vanish under a vite full-reload mid-slice).
      const engaged = await ev(() => {
        const st = window.__dcc.state;
        const p = st.players[0];
        return st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
          Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.6).length;
      });
      if (engaged < 2) throw new Error(`engagement lost (only ${engaged} enemies in range)`);
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
  (${vclock.toString()})();
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.attackSwing = 0.15;
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 2.6);
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  for (const m of near.slice(0, 2)) {
    m.hitFlash = 0.3;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 34, kind: "enemy",
      dir: { x: -1, y: 0 } });
  }
})()`, 5, 16);

// 2) MID-IMPACT: a crit killing blow with overkill — impact flash, sparks,
// shock ring, bloom kick, blood decal, corpse launch claim.
await shot("r2-fx-combat2", `(() => {
  (${vclock.toString()})();
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
    m.hitFlash = 0.3;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 88,
      kind: i === 0 ? "crit" : "enemy", dir: { x: -0.8, y: -0.4 },
      killed: i === 0, overkill: i === 0 });
  }
})()`, 6, 15);

// 3) ABILITY BURST: light the nova flash (ring + burst + FX light) plus the
// cast-gather anticipation off the nova cooldown edge.
await shot("r2-fx-combat3", `(() => {
  (${vclock.toString()})();
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.novaFlash = 0.4;
  p.cd.nova = (p.cd.nova ?? 0) + 6; // cd edge -> cast clip + gather burst
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 4);
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  for (const m of near) m.hitFlash = 0.3;
  for (const m of near) emit({
    pos: { x: m.pos.x, y: m.pos.y }, amount: 41, kind: "enemy",
    dir: { x: (m.pos.x - p.pos.x) / 3, y: (m.pos.y - p.pos.y) / 3 },
  });
})()`, 6, 15);

// 4) ORDNANCE IN FLIGHT: real sim projectiles (magic bolt + enemy shot) so the
// core/glow-shell/ribbon/ember anatomy is verifiable in a still, plus a
// charger LANE telegraph on the farthest live monster. The projectiles and
// the lane are (re)staged in the FINALE — sim content rides the real clock,
// so anything armed before the slices is dead by capture time (audit r5:
// the old shot shipped two leftovers and no lane).
const ordnance = `(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  st.projectiles = st.projectiles.filter((pr) => pr.id < 990000);
  st.projectiles.push(
    { id: 990001, pos: { x: p.pos.x - 4.4, y: p.pos.y - 2.2 }, vel: { x: 2.6, y: 1.3 },
      damage: 10, ttl: 4, from: "player", ownerId: p.id, school: "magic" },
    { id: 990002, pos: { x: p.pos.x + 4.6, y: p.pos.y + 2.4 }, vel: { x: -2.4, y: -1.2 },
      damage: 8, ttl: 4, from: "enemy" },
    { id: 990003, pos: { x: p.pos.x - 2.6, y: p.pos.y + 3.8 }, vel: { x: 1.7, y: -2.4 },
      damage: 10, ttl: 4, from: "player", ownerId: p.id, school: "magic", chill: 0.3 },
  );
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let far = null, farD = -1;
  for (const m of live) {
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d > farD && d < 9) { farD = d; far = m; }
  }
  if (far) {
    const d = Math.hypot(p.pos.x - far.pos.x, p.pos.y - far.pos.y) || 1;
    far.windupKind = "charge";
    far.chargeDir = { x: (p.pos.x - far.pos.x) / d, y: (p.pos.y - far.pos.y) / d };
    far.windupTotal = 2.4;
    far.windup = 2.1;
  }
})()`;
await shot("r2-fx-combat4", `(() => {
  (${vclock.toString()})();
  (${teleport.toString()})();
  ${ordnance};
})()`, 4, 18, ordnance);

await browser.close();
console.log("combat panel done");
