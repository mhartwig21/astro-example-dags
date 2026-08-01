// A MODIFIED ABILITY, FIRING. Same staging contract as tools/combatshot.mjs
// (virtual rAF clock, teleport into a pack, retry on vite reloads) but the
// subject is the ITEMIZATION-V2 modifier layer: the bolt slot is socketed with
// Splitfang + Arc-Splice, and the shot is taken on the frame the sim's own
// glyph riders have fired — forked bolts continuing outward, the arc link
// landing on a second body, and the cockpit chip wearing its glyph pips.
//
// The sim does the work: we never fake a projectile. We cast through
// __dcc.step() with a real intent and advance the sim until the fork exists.
// Usage: node tools/v2combatshot.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "tools/_v2shots";
const URL = "http://localhost:5285/iso.html" +
  "?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&gold=400&eagerassets";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });

async function ev(fn, arg) {
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
      return await page.evaluate(fn, arg);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(2500);
    }
  }
  throw lastErr;
}

// Idempotent virtual clock (see combatshot.mjs): freezes the rAF timestamp so
// 300ms FX survive a capture that takes seconds under SwiftShader.
function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}

// Stage the BUILD: the bolt slot runs Splitfang (forks on impact) + Arc-Splice
// (arcs to the nearest other body). Both are legal in one slot — different
// families — which is exactly the composition the layer is for.
const stage = await ev(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const idx = p.abilities.slots.indexOf("bolt");
  if (idx < 0) return null;
  p.glyphs.slots[idx] = ["splitfang", "arc_splice"];
  p.glyphs.bench = p.glyphs.bench.filter((g) => g !== "splitfang" && g !== "arc_splice");
  p.hp = p.maxHp;
  return { idx, glyphs: p.glyphs.slots[idx] };
});
if (!stage) { console.error("bolt is not slotted"); process.exit(1); }
console.log("bolt slot", stage.idx, "carries", stage.glyphs.join(" + "));

// Park the crawler in front of a pack, pulled into bolt range but not on top
// of it — the forks need room to continue outward.
const staged = await ev(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  if (live.length === 0) return null;
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3.5).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 4.6;
  p.pos.y = best.pos.y + 0.2;
  p.facing.x = -1; p.facing.y = 0;
  // A tight arc of bodies in front: fork targets and an arc-link neighbor.
  const ring = live
    .sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 5);
  ring.forEach((m, k) => {
    m.pos.x = p.pos.x - (3.4 + (k % 2) * 0.9);
    m.pos.y = p.pos.y + (k - 2) * 1.15;
    m.hp = m.maxHp; // nothing dies before the riders resolve
  });
  return { packSize: bestN, at: { x: p.pos.x, y: p.pos.y } };
});
if (!staged) { console.error("no live monsters"); process.exit(1); }
console.log("staged against", staged.packSize, "at", staged.at);
await page.waitForTimeout(4000); // fog reveal + camera settle

await ev(vclock);

// CAST, then step the sim in small slices until the glyph riders have visibly
// fired: Splitfang forks on first impact, so the projectile count JUMPS. That
// jump is the shot — we stop the moment it happens.
const fired = await ev(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  // Pick a firing LANE with clear line of fire: projectiles die on wall tiles,
  // so an arbitrary -x lane can eat the bolt before it ever reaches a body
  // (and a bolt that never lands forks nothing). Scan 16 headings for ~10
  // tiles of open floor, then stand the pack up along the winner.
  const map = st.map;
  const tileAt = (x, y) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return 0;
    const t = map.tiles[ty * map.w + tx];
    return t === 0 || t === 3 ? 0 : 1;
  };
  let aim = { x: -1, y: 0 }, bestClear = -1;
  for (let a = 0; a < 16; a++) {
    const th = (a / 16) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    let clear = 0;
    for (let d = 0.5; d <= 10; d += 0.5) {
      if (!tileAt(p.pos.x + dx * d, p.pos.y + dy * d)) break;
      clear = d;
    }
    if (clear > bestClear) { bestClear = clear; aim = { x: dx, y: dy }; }
  }
  const px = -aim.y, py = aim.x; // lane-perpendicular, for the flanks
  // One body in the firing lane (the fork point) and the rest set back and
  // wide, so both forks stay in flight for the capture instead of being eaten
  // by the pack a frame later.
  const lane = [[3.0, 0], [5.2, -2.1], [5.2, 2.1], [6.6, -0.8], [6.6, 1.0]];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0)
    .sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 5);
  live.forEach((m, k) => {
    const [fwd, side] = lane[k % lane.length];
    m.pos.x = p.pos.x + aim.x * Math.min(fwd, bestClear - 0.6) + px * side;
    m.pos.y = p.pos.y + aim.y * Math.min(fwd, bestClear - 0.6) + py * side;
    m.hp = m.maxHp;
    m.windup = 0;
  });
  p.facing.x = aim.x; p.facing.y = aim.y;
  p.cd.bolt = 0;
  const hold = { move: { x: 0, y: 0 }, useStairs: false, aim };
  dcc.step({ [p.id]: { ...hold, bolt: true } }, 1 / 60);
  const start = st.projectiles.filter((pr) => pr.from === "player").length;
  let peak = start, steps = 0, sinceFork = 0;
  for (let i = 0; i < 120; i++) {
    dcc.step({ [p.id]: hold }, 1 / 60);
    steps++;
    const n = st.projectiles.filter((pr) => pr.from === "player").length;
    if (n > peak) { peak = n; sinceFork = 0; }
    if (peak > start) {
      sinceFork++;
      // A few frames after the fork: both forks are clear of the body they
      // split on, still in flight, ribbons grown.
      if (sinceFork >= 2) break;
    }
  }
  return {
    aim: { x: +aim.x.toFixed(2), y: +aim.y.toFixed(2) }, clear: bestClear, mons: live.length,
    start, peak, steps,
    forks: st.projectiles.filter((pr) => pr.forked).length,
    live: st.projectiles.filter((pr) => pr.from === "player").length,
  };
});
console.log("cast:", JSON.stringify(fired));

// Let the renderer draw the frame the sim just produced (trails need a few
// rAF ticks to grow), then re-emit the impact feedback so it is HOT at capture
// time — DOM damage numbers and the arc link ride the real CSS clock, so
// anything emitted at cast time is long gone by the time SwiftShader composites.
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.__vt && window.__vt.advance(13));
  await page.waitForTimeout(380);
}
await ev(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  const near = st.monsters
    .filter((m) => !m.dormant && m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 9)
    .sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 4);
  near.forEach((m, k) => {
    m.hitFlash = 0.3;
    dcc.hit({
      pos: { x: m.pos.x, y: m.pos.y }, amount: [118, 47, 44, 51][k % 4],
      kind: k === 0 ? "crit" : "enemy", killed: false,
      school: "magic",
      dir: { x: (m.pos.x - p.pos.x) / 3, y: (m.pos.y - p.pos.y) / 3 },
    });
  });
  // ARC-SPLICE's link, redrawn: the rider already fired in the sim (that is
  // what dealt the 40% hit) — this re-emits the same "chain" event the sim
  // emits, so the link is visible on the captured frame.
  if (near.length >= 2) {
    // emitHits, not dcc.hit: the link is world FX only — a 0 damage number
    // would be a capture artifact the real hit path never produces.
    dcc.renderer.emitHits([{ pos: { x: near[0].pos.x, y: near[0].pos.y }, amount: 0, kind: "chain",
      to: { x: near[1].pos.x, y: near[1].pos.y } }]);
  }
});
await page.evaluate(() => window.__vt && window.__vt.advance(20));
await page.waitForTimeout(380);
await page.screenshot({ path: `${OUT}/v2-combat.png`, timeout: 240000 });
console.log("saved", `${OUT}/v2-combat.png`);
await browser.close();
