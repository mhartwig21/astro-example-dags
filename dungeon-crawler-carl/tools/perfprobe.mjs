// PERFPROBE — client performance baseline for the AAA refinement rounds.
// Loads /iso.html?test in headless Chromium (SwiftShader: absolute frame ms
// are inflated ~100x vs real GPUs — treat every number as a RELATIVE baseline,
// re-run this exact script to compare), then per scenario records:
//   - load-to-settled ms  (goto -> html[data-assets-settled=1], node wall clock)
//   - load-to-playable ms (goto -> loading overlay gone)
//   - renderer.info       (render.calls / render.triangles sampled across
//                          frames -> median+max; programs.length; memory.*)
//   - frame time          (performance.now deltas around the page's real rAF
//                          loop over ~5s of stepped play w/ movement keys held)
// Scenarios: floors 2 / 8 / 14 (test-mode, seed 41, level 16, abilities=all)
// plus a staged combat (combatshot.mjs teleport staging, floor 6 seed 77).
// Usage: node tools/perfprobe.mjs [outJson]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/perf-baseline.json";
const BASE = "http://localhost:5285/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

/** Boot a page and time the load gates (node wall clock, includes network+parse+assets). */
async function boot(url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
  const tSettled = Date.now() - t0;
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
  }, null, { timeout: 120000 });
  const tPlayable = Date.now() - t0;
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
  return { page, loadToSettledMs: tSettled, loadToPlayableMs: tPlayable };
}

/** Sample renderer.info + rAF deltas while the caller drives input.
 * three.js info.autoReset wipes render.calls/triangles at the END of every
 * render() — between frames the counters read ~0. The sampler disables
 * autoReset and resets manually each rAF tick, so each sample is one full
 * frame's accumulation across every pass. */
async function sample(page, ms, drive) {
  await page.evaluate(() => {
    const rec = { deltas: [], calls: [], tris: [], stop: false };
    window.__perf = rec;
    const r = window.__dcc.renderer;
    const info = r?.info ?? r?.renderer?.info;
    if (info) info.autoReset = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      rec.deltas.push(now - last);
      last = now;
      try {
        if (info) {
          rec.calls.push(info.render.calls);
          rec.tris.push(info.render.triangles);
          info.reset();
        }
      } catch {}
      if (!rec.stop) requestAnimationFrame(tick);
      else if (info) info.autoReset = true;
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  if (drive) await drive();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  return await page.evaluate(() => {
    window.__perf.stop = true;
    const { deltas, calls, tris } = window.__perf;
    const r = window.__dcc.renderer;
    const info = r?.info ?? r?.renderer?.info;
    return {
      deltas: deltas.slice(1), // first delta spans recorder install
      calls: calls.slice(1), // first sample predates the first manual reset
      tris: tris.slice(1),
      programs: info ? info.programs.length : null,
      geometries: info ? info.memory.geometries : null,
      textures: info ? info.memory.textures : null,
    };
  });
}

const stats = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: a.length,
    avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1),
    median: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +Math.max(...a).toFixed(1),
  };
};

/** Hold movement keys so the sampling window covers real stepped play. */
async function walk(page, seq) {
  for (const [k, hold] of seq) {
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(120);
  }
}

// combatshot.mjs staging: teleport beside the densest pack, ring 5 monsters.
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

const SCENARIOS = [
  { name: "floor2", url: `${BASE}?test&debug=1&clean=1&floor=2&level=16&seed=41&abilities=all&eagerassets` },
  { name: "floor8", url: `${BASE}?test&debug=1&clean=1&floor=8&level=16&seed=41&abilities=all&eagerassets` },
  { name: "floor14", url: `${BASE}?test&debug=1&clean=1&floor=14&level=16&seed=41&abilities=all&eagerassets` },
  { name: "combat-f6", url: `${BASE}?test&debug=1&clean=1&floor=6&level=14&seed=77&abilities=all&eagerassets`, combat: true },
];

const results = {
  capturedAt: new Date().toISOString(),
  note: "SwiftShader software GL — frame ms inflated vs real GPU; RELATIVE baseline only. Re-run tools/perfprobe.mjs with identical URLs to compare.",
  viewport: "1600x900@1",
  scenarios: {},
};

for (const sc of SCENARIOS) {
  console.log(`\n=== ${sc.name} ===`);
  const { page, loadToSettledMs, loadToPlayableMs } = await boot(sc.url);
  await page.waitForTimeout(2500); // camera + fog settle
  let staging = null;
  if (sc.combat) {
    staging = await page.evaluate(teleport);
    console.log("combat staged:", JSON.stringify(staging));
    await page.waitForTimeout(4000); // aggro: pack winds up and swings
  }
  const s = await sample(page, 12000, async () => {
    if (sc.combat) {
      // stay in the melee, poke movement so the hero animates + FX churn
      await walk(page, [["a", 700], ["d", 700], ["w", 600], ["s", 600], ["a", 700], ["d", 700], ["w", 600], ["s", 600]]);
    } else {
      await walk(page, [["w", 1400], ["d", 1100], ["w", 1100], ["a", 900], ["s", 900], ["d", 1100], ["w", 1100], ["a", 900]]);
    }
  });
  const frame = stats(s.deltas);
  results.scenarios[sc.name] = {
    url: sc.url,
    loadToSettledMs,
    loadToPlayableMs,
    frameMs: frame,
    fpsAvg: frame ? +(1000 / frame.avg).toFixed(2) : null,
    drawCalls: stats(s.calls),
    triangles: stats(s.tris),
    programs: s.programs,
    geometries: s.geometries,
    textures: s.textures,
    staging,
  };
  console.log(JSON.stringify(results.scenarios[sc.name], null, 2));
  await page.close();
}

await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log("\nwrote", OUT);
