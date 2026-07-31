// BEAUTYSHOT — the definitive showcase suite (final cinematic look pass).
// Shoots, with ?clean=1 (no tutorial cards, no courtesy toasts):
//   (a) six band beauty frames (one per 3-floor band, walked off spawn)
//   (b) a staged mid-combat frame: trails/impacts/damage numbers firing
//   (c) the boss reveal beat: arena rim lighting, telegraph charging, numbers
//   (d) a hero crowd-pop frame: the player amid an 8-strong pack, no FX crutch
// Every frame then goes through tools/lumcheck.mjs by the caller — standard
// floor shots must audit UNDER 35% of pixels below 5% luminance.
//
// Staging rides the ?debug=1 window.__dcc hook + the virtual-rAF clock trick
// from combatshot.mjs (SwiftShader composites seconds late; a frozen clock
// advanced in ~16ms slices lands FX mid-life on the captured frame).
// Usage: node tools/beautyshot.mjs [outDir] [nameFilter]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/beauty";
const FILTER = process.argv[3] ?? "";
const BASE = "http://localhost:5285/iso.html";

import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

async function boot(url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  // Two gates, one retry-reload (HMR storms from concurrent agents wedge boots).
  let ready = false;
  for (let attempt = 0; attempt < 2 && !ready; attempt++) {
    try {
      await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
      await page.waitForFunction(() => {
        const el = document.getElementById("loading");
        return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
      }, null, { timeout: 90000 });
      ready = true;
    } catch {
      if (attempt === 0) await page.reload({ waitUntil: "load", timeout: 60000 }).catch(() => {});
    }
  }
  if (!ready) console.error("WARN: boot never became ready; shooting anyway");
  await page.waitForTimeout(3500);
  return page;
}

/** Evaluate with retry — vite full-reloads can wipe window.__dcc mid-stage. */
async function ev(page, fn) {
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try {
      await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
      return await page.evaluate(fn);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(2000);
    }
  }
  throw lastErr;
}

// Idempotent virtual clock (see combatshot.mjs): freeze rAF time, advance on demand.
function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}

async function settleSlices(page, slices, ms) {
  for (let i = 0; i < slices; i++) {
    await page.evaluate((m) => window.__vt && window.__vt.advance(m), ms);
    await page.waitForTimeout(450);
  }
}

/** Freeze DOM damage numerals mid-arc: they ride the Web Animations API on
 * the REAL clock, and a SwiftShader screenshot composites seconds after the
 * emit — pausing every animation pins them at their brightest keyframe. */
async function pauseDomAnims(page) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming();
      // Pin mid-flight (35% through): scale settled, opacity 1, arc visible.
      if (t && Number.isFinite(t.duration)) a.currentTime = t.duration * 0.35;
      a.pause();
    }
  }).catch(() => {});
}

const want = (name) => !FILTER || name.includes(FILTER);
const saved = [];
async function snap(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, timeout: 240000 });
  console.log("saved", path);
  saved.push(path);
  await page.close();
}

// ---------------------------------------------------------------- (a) bands
// One frame per 3-floor band; keys walk the crawler off the spawn tile so the
// frame reads mid-run, not title-screen. Seeds picked for dressed rooms.
const BANDS = [
  { name: "beauty-f2-undercroft", floor: 2, level: 4, seed: 11, keys: [["w", 900], ["d", 600]] },
  { name: "beauty-f5-sewers", floor: 5, level: 9, seed: 21, keys: [["w", 900], ["a", 600]] },
  { name: "beauty-f8-garden", floor: 8, level: 12, seed: 31, keys: [["s", 900], ["d", 600]] },
  { name: "beauty-f11-ruins", floor: 11, level: 15, seed: 41, keys: [["w", 900], ["d", 600]] },
  { name: "beauty-f14-ironworks", floor: 14, level: 18, seed: 51, keys: [["w", 900], ["a", 600]] },
  { name: "beauty-f17-approach", floor: 17, level: 21, seed: 61, keys: [["w", 900], ["d", 600]] },
];
for (const b of BANDS) {
  if (!want(b.name)) continue;
  const page = await boot(
    `${BASE}?test&clean=1&floor=${b.floor}&level=${b.level}&seed=${b.seed}&eagerassets`,
  );
  for (const [k, hold] of b.keys) {
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(2500);
  await snap(page, b.name);
}

// ------------------------------------------------------------- (b) mid-combat
// The combatshot.mjs impact recipe: teleport beside the densest pack, ring the
// five nearest, freeze the clock, land a crit killing blow + pack hits, then
// re-emit numbers right before capture so the DOM numerals are mid-arc.
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
  // Ring the nearest BIG silhouettes (swarmer-sized bodies read as scatter
  // props in a still — the showcase pack needs shoulders).
  const ring = live
    .filter((m) => m.kind !== "swarmer")
    .sort((a, b) =>
      Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
      Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 5);
  ring.forEach((m, k) => {
    const a = (k / Math.max(ring.length, 1)) * Math.PI * 2 + 2.6;
    m.pos.x = p.pos.x + Math.cos(a) * (1.5 + (k % 2) * 0.5);
    m.pos.y = p.pos.y + Math.sin(a) * (1.5 + (k % 2) * 0.5);
    m.hp = m.maxHp || m.hp;
  });
  return { packSize: bestN };
}
const REHIT = `(() => {
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
if (want("beauty-combat")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets`,
  );
  await ev(page, teleport);
  await page.waitForTimeout(4500); // aggro + camera settle
  // ENGAGEMENT CONTRACT (combatshot.mjs r5 rule): a combat frame with no
  // combat is an automatic blocker — restage until the pack actually held.
  let engaged = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await ev(page, `(() => {
      (${vclock.toString()})();
      (${teleport.toString()})();
      const dcc = window.__dcc;
      const st = dcc.state;
      const p = st.players[0];
      p.attackSwing = 0.15;
      const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
      const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
        Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.2);
      for (let i = 0; i < near.length; i++) {
        const m = near[i];
        m.hitFlash = 0.3;
        // NO killed/overkill flag: the death-beat FX light frozen at peak
        // under the virtual clock floods the frame with an orange wash.
        emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 88,
          kind: i === 0 ? "crit" : "enemy", dir: { x: -0.8, y: -0.4 } });
      }
    })()`);
    await settleSlices(page, 6, 15);
    // Age any incidental FX lights past their hot peak before the number
    // re-emit — impact sparks stay, the frame doesn't blow out.
    await page.evaluate(() => window.__vt && window.__vt.advance(420));
    await page.waitForTimeout(450);
    await ev(page, REHIT);
    await page.evaluate(() => window.__vt && window.__vt.advance(24));
    await page.waitForTimeout(280);
    await pauseDomAnims(page); // numerals pinned mid-arc for the composite
    engaged = await ev(page, `(() => {
      const st = window.__dcc.state;
      const p = st.players[0];
      return st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
        Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.6).length;
    })()`);
    if (engaged >= 2) break;
    console.error(`combat engagement lost (${engaged} in range) — restaging`);
  }
  if (engaged < 2) console.error("WARN: combat frame shipped under-engaged");
  await snap(page, "beauty-combat");
}

// ------------------------------------------------------------ (c) boss beat
// Floor-3 boss (The Crypt Concierge): wait out the RINGSIDE intro cinematic,
// step the party into the crimson ritual glow, charge a slam telegraph on the
// boss, and land pack damage so numbers arc clear of the action.
if (want("beauty-boss")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&floor=3&level=8&seed=41&eagerassets`,
  );
  // Teleport TO the arena — proximity trips the boss intro.
  await ev(page, `(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    const boss = st.monsters.find((m) => m.kind === "boss");
    if (boss) { p.pos.x = boss.pos.x; p.pos.y = boss.pos.y + 3.2; p.hp = p.maxHp; }
  })()`);
  // Let the intro cinematic fully END (boss bar back, camera returned).
  await page
    .waitForFunction(() => document.getElementById("bossintro")?.classList.contains("show"), null, { timeout: 30000 })
    .catch(() => {});
  await page
    .waitForFunction(() => !document.getElementById("bossintro")?.classList.contains("show"), null, { timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await ev(page, `(() => {
    (${vclock.toString()})();
    const dcc = window.__dcc;
    const st = dcc.state;
    const p = st.players[0];
    const boss = st.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return;
    p.hp = p.maxHp;
    p.pos.x = boss.pos.x - 0.4;
    p.pos.y = boss.pos.y + 2.6;
    p.facing.x = 0.2; p.facing.y = -1;
    // Telegraph FIRING during the beat: the boss charges a slam.
    boss.windupKind = "slam";
    boss.windupTotal = 2.2;
    boss.windup = 1.4;
    boss.hitFlash = 0.3;
    // Minions step into the arena glow so the rim/kick lighting has a cast.
    const minions = st.monsters
      .filter((m) => m !== boss && !m.dormant && m.hp > 0)
      .sort((a, b) =>
        Math.hypot(a.pos.x - boss.pos.x, a.pos.y - boss.pos.y) -
        Math.hypot(b.pos.x - boss.pos.x, b.pos.y - boss.pos.y))
      .slice(0, 3);
    minions.forEach((m, k) => {
      const a = 2.2 + k * 1.15;
      m.pos.x = boss.pos.x + Math.cos(a) * 2.6;
      m.pos.y = boss.pos.y + Math.sin(a) * 2.4;
    });
    const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
    emit({ pos: { x: boss.pos.x, y: boss.pos.y }, amount: 214, kind: "crit",
      dir: { x: 0.2, y: -0.7 } });
    minions.forEach((m) => emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 47,
      kind: "enemy", dir: { x: (m.pos.x - p.pos.x) / 2, y: (m.pos.y - p.pos.y) / 2 } }));
  })`);
  await settleSlices(page, 5, 16);
  await ev(page, `(() => {
    const dcc = window.__dcc;
    const st = dcc.state;
    const boss = st.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return;
    boss.windupKind = "slam";
    boss.windupTotal = 2.2;
    boss.windup = 1.1;
    const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
    emit({ pos: { x: boss.pos.x, y: boss.pos.y }, amount: 168, kind: "crit",
      dir: { x: -0.3, y: -0.6 } });
  })()`);
  await page.evaluate(() => window.__vt && window.__vt.advance(24));
  await page.waitForTimeout(300);
  await pauseDomAnims(page); // numerals pinned mid-arc for the composite
  await snap(page, "beauty-boss");
}

// ------------------------------------------------------- (d) hero crowd pop
// The proof frame for silhouette authority: the hero parked dead-center in an
// 8-strong pack, NO combat FX to lean on — the cool rim, class trim glow and
// value/saturation authority have to do the work in 0.2s.
if (want("beauty-crowd")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&floor=6&level=14&seed=77&eagerassets`,
  );
  const ringUp = `(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    p.hp = p.maxHp;
    const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
    if (live.length === 0) return 0;
    let best = live[0], bestN = -1;
    for (const m of live) {
      const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4).length;
      if (n > bestN) { bestN = n; best = m; }
    }
    p.pos.x = best.pos.x;
    p.pos.y = best.pos.y + 0.2;
    p.facing.x = 0; p.facing.y = 1;
    const ring = live
      .sort((a, b) =>
        Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
        Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
      .slice(0, 8);
    // Ring spots must be WALKABLE — a spot inside a wall gets separation-
    // clamped by the next sim step and the pose scatters (r6 lesson). The
    // tile value under the player is walkable by definition.
    const mapW = st.map.w;
    const okVal = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
    const spots = [];
    for (let ri = 0; ri < 3 && spots.length < 8; ri++) {
      const r = 1.5 + ri * 0.75;
      for (let k = 0; k < 12 && spots.length < 8; k++) {
        const a = (k / 12) * Math.PI * 2 + 0.4 + ri * 0.3;
        // Keep the camera-side wedge clear (the iso camera looks along -x,-y):
        // a mob on the near diagonal stands between the lens and the hero.
        if (Math.cos(a - Math.PI / 4) > 0.74) continue;
        const x = p.pos.x + Math.cos(a) * r;
        const y = p.pos.y + Math.sin(a) * r;
        if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== okVal) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.9)) continue;
        spots.push({ x, y });
      }
    }
    ring.forEach((m, k) => {
      const s = spots[k];
      if (!s) return;
      m.pos.x = s.x;
      m.pos.y = s.y;
      m.hp = m.maxHp || m.hp; // nobody dies mid-pose
    });
    return Math.min(ring.length, spots.length);
  })()`;
  // Phase 1 on the REAL clock: teleport + ring so fog reveals and the camera
  // arrives; phase 2 freezes the clock, re-rings (the pack chased during the
  // reveal), and advances just enough for idle poses — the pack HOLDS.
  await ev(page, ringUp);
  await page.waitForTimeout(3000);
  let posed = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await ev(page, `(() => { (${vclock.toString()})(); ${ringUp}; })()`);
    await settleSlices(page, 3, 16);
    posed = await ev(page, `(() => {
      const st = window.__dcc.state;
      const p = st.players[0];
      return st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
        Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.4).length;
    })()`);
    if (posed >= 5) break;
    console.error(`crowd thinned (${posed} in ring) — restaging`);
  }
  if (posed < 5) console.error("WARN: crowd frame shipped thin");
  await snap(page, "beauty-crowd");
}

await browser.close();
console.log("beautyshot done:", saved.length, "frames");
for (const p of saved) console.log(" ", p);
