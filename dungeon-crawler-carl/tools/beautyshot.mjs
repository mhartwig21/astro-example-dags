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
// Default is the shared dev server, but a perf branch needs to shoot its OWN
// production build on a private port — pass --base http://localhost:5295 (or
// set DCC_BASE) to point the whole suite at another origin.
const baseFlagIdx = process.argv.indexOf("--base");
const BASE_ORIGIN = (baseFlagIdx >= 0 ? process.argv[baseFlagIdx + 1] : process.env.DCC_BASE) ?? "http://localhost:5285";
const BASE = `${BASE_ORIGIN.replace(/\/$/, "")}/iso.html`;

import { mkdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
mkdirSync(OUT, { recursive: true });

// ---- SCENE GUARD (r6 blocker: beauty-f5 shipped as the ACQUIRING SIGNAL
// title card) — every saved frame must survive a luminance audit proving a
// rendered scene, not the loading screen or a void. Calibrated against the
// bad frame (mean 3.9%, 99.2% of pixels under 10% lum) vs the darkest good
// scene (f11: mean 9.0%, 81.7% under 10%). Decoder cloned from lumcheck.mjs.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error("unsupported PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = (y * (stride + 1)) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB;
      else if (filter === 1) v = rawB + a;
      else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

/** Mean luminance (0-100) + fraction of pixels at/above 10% luminance. */
function frameStats(path) {
  const { w, h, channels, px } = decodePng(readFileSync(path));
  const n = w * h;
  let sum = 0, lit = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const lum = channels >= 3
      ? 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]
      : px[o];
    sum += lum;
    if (lum >= 25.5) lit++;
  }
  return { mean: (sum / n / 255) * 100, litFrac: lit / n };
}

function sceneGuard(path) {
  const s = frameStats(path);
  const ok = s.mean >= 5.5 && s.litFrac >= 0.1;
  if (!ok) console.error(`GUARD REJECT ${path}: mean lum ${s.mean.toFixed(1)}%, lit frac ${(s.litFrac * 100).toFixed(1)}% — reads as title card / void, not a scene`);
  return ok;
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

// QUALITY PIN (--quality ultra|high|balanced|performance). This suite runs on
// SwiftShader at a few frames per second, so the renderer's auto-detect quite
// correctly walks the preset DOWN mid-capture — which would silently turn a
// "before/after at ULTRA" comparison into a comparison of two different rungs.
// `?quality=` overrides both storage and auto-detect for the life of the page.
const QUALITY = (() => { const i = process.argv.indexOf("--quality"); return i >= 0 ? process.argv[i + 1] : ""; })();

async function boot(url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(QUALITY ? `${url}&quality=${QUALITY}` : url, { waitUntil: "load", timeout: 60000 });
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
 * emit — pausing every animation pins them at their brightest keyframe.
 * r7 blocker root cause: seek-then-pause in one breath RACES under
 * SwiftShader — the pause committed at the live playhead (~85% = mid-fade
 * ghost numbers in every combat/boss frame) while currentTime READ back as
 * the seek value. Fix: pause first, await the ready promise so the pause
 * actually commits, THEN seek the held playhead, and verify via computed
 * progress with one retry. */
async function pauseDomAnims(page) {
  await page.evaluate(async () => {
    const anims = document.getAnimations();
    for (const a of anims) a.pause();
    await Promise.all(anims.map((a) => a.ready.catch(() => {})));
    for (let pass = 0; pass < 3; pass++) {
      let dirty = false;
      for (const a of anims) {
        const t = a.effect?.getComputedTiming();
        if (!t || !Number.isFinite(t.duration)) continue;
        const wantT = (t.delay ?? 0) + t.duration * 0.35;
        const prog = t.progress;
        if (prog === null || Math.abs(prog - 0.35) > 0.05) {
          a.currentTime = wantT;
          dirty = true;
        }
      }
      if (!dirty) break;
      await new Promise((r) => setTimeout(r, 120));
    }
  }).catch(() => {});
}

const want = (name) => !FILTER || name.includes(FILTER);
const saved = [];
async function snap(page, name) {
  const path = `${OUT}/${name}.png`;
  // r7 blocker: an achievement toast shipped inside the boss beauty frame.
  // Kill every toast (and the container) right before the composite.
  await page.evaluate(() => {
    const t = document.getElementById("toasts");
    if (t) t.style.display = "none";
    for (const el of document.querySelectorAll(".toast")) el.remove();
  }).catch(() => {});
  await page.screenshot({ path, timeout: 240000 });
  console.log("saved", path);
  saved.push(path);
  await page.close();
  return path;
}

/** snap + scene guard: a rejected frame is dropped from the manifest. */
async function snapGuarded(page, name) {
  const path = await snap(page, name);
  if (sceneGuard(path)) return true;
  saved.pop();
  return false;
}

/** ONE hero across the whole suite (r7 major: "green teardrop in f2, purple
 * wizard blob in f5, bald humanoid in f8" — identity must be constant). The
 * campfire pick overrides the seeded look and rebuilds the mesh in-place. */
async function pinHero(page) {
  await ev(page, `(() => {
    const p = window.__dcc.state.players[0];
    if (p && p.skin !== "knight") p.skin = "knight";
  })()`).catch(() => {});
  await page.waitForTimeout(700); // skin swap rebuilds the body next frame
}

// ---------------------------------------------------------------- (a) bands
// One frame per 3-floor band; keys walk the crawler off the spawn tile so the
// frame reads mid-run, not title-screen. Seeds picked for dressed rooms.
// view=close (r7 blocker: 60% dead frame): ~1.5x tighter ortho framing keeps
// the lit playspace dominant instead of an ocean of unexplored dark.
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
  // GUARDED CAPTURE (r6 blocker: f5 shipped as the loading card): each band
  // frame gets up to 3 full boots; a frame that fails the scene guard is
  // discarded and the whole stage re-runs on a fresh page.
  let landed = false;
  for (let attempt = 0; attempt < 3 && !landed; attempt++) {
    const page = await boot(
      `${BASE}?test&clean=1&debug=1&view=close&floor=${b.floor}&level=${b.level}&seed=${b.seed}&eagerassets`,
    );
    // Hard gate before any keys: the loading overlay must actually be gone.
    const live = await page.evaluate(() => {
      const el = document.getElementById("loading");
      return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
    }).catch(() => false);
    if (!live) {
      console.error(`${b.name}: loading overlay still up — rebooting (attempt ${attempt + 1})`);
      await page.close();
      continue;
    }
    await pinHero(page);
    for (const [k, hold] of b.keys) {
      await page.keyboard.down(k);
      await page.waitForTimeout(hold);
      await page.keyboard.up(k);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(2500);
    landed = await snapGuarded(page, b.name);
  }
  if (!landed) {
    console.error(`FAIL: ${b.name} never produced a live scene frame`);
    process.exitCode = 1;
  }
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
  // The pack punched the hero during staging — a hitFlash frozen at peak
  // under the virtual clock renders him as a fullbright white blob (r7
  // blocker: "the hero model eaten by the overexposed core").
  if (p.hitFlash) p.hitFlash = 0;
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.4).slice(0, 4);
  near.forEach((m, k) => {
    // Only the CRIT body flashes (r5 blocker: freezing every neighbor at
    // flash-peak under the virtual clock rendered the pack fullbright white).
    if (k === 1) m.hitFlash = 0.24;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: [34, 88, 123, 41][k % 4],
      kind: k === 1 ? "crit" : "enemy",
      dir: { x: (m.pos.x - p.pos.x) / 2, y: (m.pos.y - p.pos.y) / 2 } });
  });
})()`;
if (want("beauty-combat")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&view=close&floor=6&level=14&abilities=all&seed=77&eagerassets`,
  );
  await pinHero(page);
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
        // Flash the primary target only (r5 blocker: whole-pack flash frozen
        // at peak = fullbright white bodies in the captured frame).
        if (i === 0) m.hitFlash = 0.24;
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
    // Cool the impact flash off its nuclear peak while sparks and numbers are
    // still mid-life. SLICED (r7 blocker root cause: a single advance() is
    // eaten by the host's 0.1s MAX_FRAME clamp, so the lights were captured
    // near PEAK and fused into the yellow-white pool) — three slices land
    // ~150ms of real aging across actual rendered frames.
    for (let s = 0; s < 3; s++) {
      await page.evaluate(() => window.__vt && window.__vt.advance(50));
      await page.waitForTimeout(320);
    }
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
  if (!(await snapGuarded(page, "beauty-combat"))) process.exitCode = 1;
}

// ------------------------------------------------------------ (c) boss beat
// Floor-3 boss (The Crypt Concierge): wait out the RINGSIDE intro cinematic,
// step the party into the crimson ritual glow, charge a slam telegraph on the
// boss, and land pack damage so numbers arc clear of the action.
if (want("beauty-boss")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&view=close&floor=3&level=8&seed=41&eagerassets`,
  );
  await pinHero(page);
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
  // r7 blocker: the last "boss" frame contained NO boss. The staging eval now
  // RETURNS whether a live boss was actually posed (retried), the boss sits at
  // 65% HP so the nameplate reads mid-fight, and the hero holds a swing pose.
  let bossStaged = false;
  for (let attempt = 0; attempt < 3 && !bossStaged; attempt++) {
    bossStaged = await ev(page, `(() => {
    (${vclock.toString()})();
    const dcc = window.__dcc;
    const st = dcc.state;
    const p = st.players[0];
    const boss = st.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return false;
    // The boss fights in REAL TIME until this freeze lands — flush any
    // in-flight ordnance so the composite doesn't pin a mid-detonation
    // ultimate at peak (r6 reject: the psychedelic blast-wash frame).
    st.hazards.length = 0;
    st.projectiles.length = 0;
    boss.hp = Math.max(1, Math.round((boss.maxHp || boss.hp) * 0.65));
    p.hp = p.maxHp;
    p.pos.x = boss.pos.x - 0.4;
    p.pos.y = boss.pos.y + 2.6;
    p.facing.x = 0.2; p.facing.y = -1;
    p.attackSwing = 0.16; // mid-action, not idle
    // Telegraph FIRING during the beat: the boss charges a slam.
    boss.windupKind = "slam";
    boss.windupTotal = 2.2;
    boss.windup = 1.4;
    // NO frozen hitFlash on the boss (r6 major: the flash pinned at peak
    // under the virtual clock washed the silhouette into a pale blob).
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
    // Numbers ARC AWAY from the boss body (r6 major: "168!" covered the
    // boss's head) — the crit anchors off the shoulder, pushed outward.
    emit({ pos: { x: boss.pos.x - 1.6, y: boss.pos.y + 0.7 }, amount: 214, kind: "crit",
      dir: { x: -0.8, y: 0.3 } });
    minions.forEach((m) => emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 47,
      kind: "enemy", dir: { x: (m.pos.x - p.pos.x) / 2, y: (m.pos.y - p.pos.y) / 2 } }));
    return true;
  })()`);
    if (!bossStaged) await page.waitForTimeout(2000);
  }
  if (!bossStaged) console.error("WARN: no live boss found to stage");
  await settleSlices(page, 5, 16);
  // Age any detonation FX (flashes, shock rings, screen-space punch) that
  // fired before the freeze well past their peak; the final eval below
  // re-arms the slam telegraph to its hero moment afterwards.
  await page.evaluate(() => window.__vt && window.__vt.advance(650));
  await page.waitForTimeout(500);
  await ev(page, `(() => {
    const dcc = window.__dcc;
    const st = dcc.state;
    const boss = st.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return;
    boss.windupKind = "slam";
    boss.windupTotal = 2.2;
    boss.windup = 1.1;
    const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
    // Off the body, arcing outward — never over the boss's face (r6 major).
    emit({ pos: { x: boss.pos.x - 1.6, y: boss.pos.y + 0.7 }, amount: 168, kind: "crit",
      dir: { x: -0.8, y: 0.3 } });
  })()`);
  // Cool any incidental flashes off peak; DOM numerals ride the real clock
  // and are pinned mid-arc by pauseDomAnims regardless. Sliced (r7: single
  // advances are eaten by the 0.1s MAX_FRAME clamp).
  for (let s = 0; s < 3; s++) {
    await page.evaluate(() => window.__vt && window.__vt.advance(50));
    await page.waitForTimeout(320);
  }
  await pauseDomAnims(page); // numerals pinned mid-arc for the composite
  // FINAL SUBJECT GUARD: a boss beauty frame without a live on-screen boss is
  // an automatic reject (r7 blocker — the empty-room "boss" shot).
  const bossVis = await ev(page, `(() => {
    const dcc = window.__dcc;
    const boss = dcc.state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return false;
    const s = dcc.renderer.worldToScreen(boss.pos.x, 1.0, boss.pos.y);
    return s.x > 140 && s.x < 1460 && s.y > 100 && s.y < 800;
  })()`).catch(() => false);
  if (!bossVis) {
    console.error("FAIL: beauty-boss has no live boss in frame — dropped");
    await snap(page, "beauty-boss-REJECTED");
    saved.pop();
    process.exitCode = 1;
  } else if (!(await snapGuarded(page, "beauty-boss"))) process.exitCode = 1;
}

// ------------------------------------------------------- (d) hero crowd pop
// The proof frame for silhouette authority: the hero parked dead-center in an
// 8-strong pack, NO combat FX to lean on — the cool rim, class trim glow and
// value/saturation authority have to do the work in 0.2s.
if (want("beauty-crowd")) {
  const page = await boot(
    `${BASE}?test&debug=1&clean=1&view=close&floor=6&level=14&seed=77&eagerassets`,
  );
  await pinHero(page);
  const ringUp = `(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    p.hp = p.maxHp;
    // LIT POCKET (r5 blocker: "5 barely-lit characters in near-darkness"):
    // stage in the biggest non-entrance ROOM — rooms carry torch dressing;
    // corridor junctions are where crowd shots go to die in the dark.
    const mapW = st.map.w;
    const rooms = st.map.rooms || [];
    const roles = st.map.roles || [];
    let bestRoom = null, bestA = -1;
    // LIT-POCKET SCORE (r6 blocker: "no focal light at all"): the renderer's
    // torch pool only lights anchors, so the winning room is the biggest
    // combat room WITH sconces near its center — size x (1 + torches nearby).
    const anchors = (window.__dcc.renderer && window.__dcc.renderer.torchAnchors) || [];
    for (let ri = 0; ri < rooms.length; ri++) {
      const r = rooms[ri];
      // Plain COMBAT rooms only: vaults/shrines park gold loot beacons whose
      // frozen bloom nukes the exposure (r5 lesson — the gold blob frame).
      if (roles[ri] !== "combat") continue;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (st.map.tiles[Math.floor(cy) * mapW + Math.floor(cx)] !== 1) continue;
      const glowy = (st.loot || []).some((l) =>
        l.pos.x >= r.x - 1 && l.pos.x <= r.x + r.w + 1 &&
        l.pos.y >= r.y - 1 && l.pos.y <= r.y + r.h + 1);
      if (glowy) continue;
      const lit = anchors.filter((t) => Math.hypot(t.x - cx, t.y - cy) < 5.5).length;
      const a = r.w * r.h * (1 + lit * 2);
      if (a > bestA) { bestA = a; bestRoom = { cx, cy }; }
    }
    // Fallback (r7: the crowd died at an unlit intersection when no combat
    // room qualified): ANY biggest non-entrance room beats the spawn corridor.
    if (!bestRoom) {
      for (let ri = 0; ri < rooms.length; ri++) {
        if (roles[ri] === "entrance") continue;
        const r = rooms[ri];
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        if (st.map.tiles[Math.floor(cy) * mapW + Math.floor(cx)] !== 1) continue;
        const a = r.w * r.h;
        if (a > bestA) { bestA = a; bestRoom = { cx, cy }; }
      }
    }
    if (bestRoom) { p.pos.x = bestRoom.cx; p.pos.y = bestRoom.cy; }
    p.facing.x = 0; p.facing.y = 1;
    // A REAL crowd (r5 blocker): pull 12 bodies from ANYWHERE on the floor,
    // big silhouettes first — swarmers read as scatter props in a still.
    const live = st.monsters.filter((m) => !m.dormant && m.hp > 0 && m.kind !== "boss");
    live.sort((a, b) => (a.kind === "swarmer" ? 1 : 0) - (b.kind === "swarmer" ? 1 : 0));
    const ring = live.slice(0, 12);
    // Ring spots must be WALKABLE — a spot inside a wall gets separation-
    // clamped by the next sim step and the pose scatters (r6 lesson). The
    // tile value under the player is walkable by definition.
    const okVal = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
    const spots = [];
    for (let ri = 0; ri < 4 && spots.length < 12; ri++) {
      const r = 1.4 + ri * 0.7;
      for (let k = 0; k < 14 && spots.length < 12; k++) {
        const a = (k / 14) * Math.PI * 2 + 0.4 + ri * 0.33;
        // Keep the camera-side wedge clear (the iso camera looks along -x,-y):
        // a mob on the near diagonal stands between the lens and the hero.
        if (Math.cos(a - Math.PI / 4) > 0.74) continue;
        const x = p.pos.x + Math.cos(a) * r;
        const y = p.pos.y + Math.sin(a) * r;
        if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== okVal) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.85)) continue;
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
    if (posed >= 9) break;
    console.error(`crowd thinned (${posed} in ring) — restaging`);
  }
  if (posed < 9) console.error("WARN: crowd frame shipped thin");
  // DE-FX the pose (r5): the ringed pack ATTACKS the hero during staging —
  // frozen impact lights pile into a white-hot ball that swallows the hero,
  // and frozen slam rings read as FX crutch. Age the lights past their peak,
  // then kill windups + reheal so the frame is a clean silhouette proof.
  await page.evaluate(() => window.__vt && window.__vt.advance(430));
  await page.waitForTimeout(450);
  await ev(page, `(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    p.hp = p.maxHp;
    if (p.hitFlash) p.hitFlash = 0;
    for (const m of st.monsters) {
      if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) > 6) continue;
      m.windup = 0;
      m.windupKind = undefined;
      if (m.hitFlash) m.hitFlash = 0;
    }
    // STREAK ROOT CAUSE (r6 blocker: the stray gold beam at the top edge):
    // a projectile mid-flight when the clock froze leaves its trail ribbon
    // parked across the frame — the ribbon mesh sits at the ORIGIN with
    // world-space geometry, so the top-strip cull below never catches it.
    // Clear every projectile + hazard, then advance enough sim time for the
    // released ribbons to shrivel into their heads (~160ms fade).
    if (st.projectiles) st.projectiles.length = 0;
    if (st.hazards) st.hazards.length = 0;
  })()`);
  await page.evaluate(() => window.__vt && window.__vt.advance(240));
  await page.waitForTimeout(400);
  // GATHERING LIGHT (r7 major: "~4 NPCs standing in near-total darkness"):
  // two warm practicals staged over the pack — the brazier glow of a lit hub
  // — so the crowd reads as layered silhouettes, not murk-drowned blobs.
  await ev(page, `(() => {
    const r = window.__dcc.renderer;
    const p = window.__dcc.state.players[0];
    let proto = null;
    r.scene.traverse((o) => { if (!proto && o.isPointLight) proto = o; });
    if (!proto) return false;
    for (const spec of [[1.4, -0.9, 9.0], [-1.6, 1.2, 6.0]]) {
      const L = proto.clone();
      L.color.setHex(0xffb066);
      L.intensity = spec[2];
      L.distance = 9;
      L.decay = 2;
      L.visible = true;
      L.position.set(p.pos.x + spec[0], 1.3, p.pos.y + spec[1]);
      r.scene.add(L);
    }
    return true;
  })()`);
  await page.waitForTimeout(500);
  // STREAK CULL (r7 major: a hard-edged bright beam clipped the top of the
  // crowd frame): every visible additive/high-emissive object projecting into
  // the top screen strip is HIDDEN for this composite (loot beams, stray
  // portal swirls) — logged so the source stays identifiable.
  const suspects = await ev(page, `(() => {
    const r = window.__dcc.renderer;
    const out = [];
    r.scene.traverse((o) => {
      if (!o.visible || (!o.isMesh && !o.isSprite)) return;
      const m = o.material;
      if (!m) return;
      const additive = m.blending === 2;
      const emissive = m.emissiveIntensity !== undefined && m.emissiveIntensity > 0.3;
      if (!additive && !emissive) return;
      const v = new (Object.getPrototypeOf(o.position).constructor)();
      o.getWorldPosition(v);
      const s = r.worldToScreen(v.x, v.y, v.z);
      if (s.y > 140 || s.y < -40 || s.x < -100 || s.x > 1700) return;
      if (v.x === 0 && v.y === 0 && v.z === 0) return; // origin-parked rigs
      o.visible = false; // cull the artifact from the beauty composite
      out.push({ type: o.type, name: o.name || o.parent?.name || "", key: o.userData?.modelKey ?? o.parent?.userData?.modelKey ?? "",
        mat: m.type, ro: o.renderOrder, world: [v.x.toFixed(1), v.y.toFixed(1), v.z.toFixed(1)], screen: [Math.round(s.x), Math.round(s.y)] });
    });
    return out.slice(0, 20);
  })()`);
  console.log("top-strip suspects (culled):", JSON.stringify(suspects));
  // Final de-FX: mobs restart windups during the staging beats above — kill
  // any fresh telegraph ring so the frame stays a clean silhouette proof.
  await ev(page, `(() => {
    const st = window.__dcc.state;
    for (const m of st.monsters) { m.windup = 0; m.windupKind = undefined; }
    if (st.hazards) st.hazards.length = 0;
  })()`);
  await page.evaluate(() => window.__vt && window.__vt.advance(50));
  await page.waitForTimeout(600);
  if (!(await snapGuarded(page, "beauty-crowd"))) process.exitCode = 1;
}

await browser.close();
console.log("beautyshot done:", saved.length, "frames");
for (const p of saved) console.log(" ", p);
