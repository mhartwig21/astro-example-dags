// Two claims in the shipped artefact, checked directly.
//
//  1. quality.ts: `SHADER_BUILDS_PER_MIN = { before: 2.75, after: 0 }` —
//     "[shader-guard] fires per minute of ordinary floor-15 play, AFTER full
//     readiness". Measured here with NOTHING touching the quality mode, so a
//     fire is the game's own, not the harness's.
//
//  2. renderer3d.applyQuality: "Everything touched here is reallocation of
//     buffers or a pass toggle — deliberately NOT anything that changes a
//     material's program." Measured here by counting programs and guard fires
//     across each individual mode switch, and by the worst rAF delta in the
//     600 ms after it.
//
// Usage: node tools/acc2_guard.mjs --adapter igpu|dgpu [--playsecs 150]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, census, flag } from "./acc2_lab.mjs";

const adapter = flag("--adapter", "igpu");
const playsecs = Number(flag("--playsecs", 150));
const out = flag("--out", `tools/_acc2guard_${adapter}.json`);

const { browser, page } = await boot({ adapter, quality: "medium" });
const fires = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard] program built AFTER boot")) {
    const name = (t.match(/frame hitch\): (.*)/) || [, ""])[1].trim();
    const key = (t.match(/cacheKey: (.*)/) || [, ""])[1].trim().slice(0, 90);
    fires.push({ at: Date.now(), name: name || "(unnamed)", key });
  }
});

const res = { adapter, playsecs };
try {
  await installProbe(page);
  await page.evaluate(() => {
    window.__progCount = () => window.__dcc.renderer.renderer.info.programs.length;
    // Continuous delta trace so a hitch can be attributed to the moment it hit.
    const T = [];
    window.__T = T;
    let last = performance.now();
    const tick = () => { const n = performance.now(); T.push([n, n - last]); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__since = (t0) => {
      const w = T.filter((r) => r[0] >= t0).map((r) => r[1]);
      return { n: w.length, max: +Math.max(0, ...w).toFixed(1), sum: +w.reduce((a, b) => a + b, 0).toFixed(1) };
    };
    window.__now = () => performance.now();
  });
  await stage(page);

  // ---- 1. ORDINARY PLAY, MODE UNTOUCHED --------------------------------
  const p0 = await page.evaluate(() => window.__progCount());
  const f0 = fires.length;
  const t0 = Date.now();
  console.log(`\n=== ORDINARY PLAY, mode pinned MEDIUM, ${playsecs}s — quality is never touched ===`);
  console.log(`programs at start: ${p0}, foreign browsers: ${census().foreign}`);
  const keys = ["w", "d", "s", "a"];
  let k = 0;
  while ((Date.now() - t0) / 1000 < playsecs) {
    // Roam AND fight: walk a leg, then re-enter the pack and swing.
    const key = keys[k++ % keys.length];
    await page.keyboard.down(key); await page.waitForTimeout(900); await page.keyboard.up(key);
    await page.mouse.click(700, 400);
    await page.waitForTimeout(400);
    if (k % 4 === 0) { await page.evaluate(() => window.__toPack()); await page.waitForTimeout(1200); }
  }
  const mins = (Date.now() - t0) / 60000;
  const p1 = await page.evaluate(() => window.__progCount());
  res.play = {
    minutes: +mins.toFixed(2), fires: fires.length - f0,
    firesPerMin: +((fires.length - f0) / mins).toFixed(2),
    programsBefore: p0, programsAfter: p1, programsBuilt: p1 - p0,
    detail: fires.slice(f0).map((f) => ({ name: f.name, key: f.key })),
  };
  console.log(`ORDINARY PLAY: ${res.play.fires} guard fires in ${res.play.minutes} min = ${res.play.firesPerMin}/min`);
  console.log(`programs ${p0} -> ${p1} (+${p1 - p0})`);
  for (const d of res.play.detail) console.log(`   ${d.name}  ${d.key}`);

  // ---- 2. WHAT ONE MODE SWITCH COSTS ------------------------------------
  console.log(`\n=== ONE MODE SWITCH AT A TIME ===`);
  const seq = ["low", "medium", "high", "low", "high", "medium", "low", "medium", "high"];
  const switches = [];
  for (const m of seq) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(1500);
    const pb = await page.evaluate(() => window.__progCount());
    const fb = fires.length;
    const mark = await page.evaluate(() => window.__now());
    await page.evaluate((mm) => window.__setMode(mm), m);
    await page.waitForTimeout(900);
    const w = await page.evaluate((t) => window.__since(t), mark);
    const pa = await page.evaluate(() => window.__progCount());
    const built = pa - pb;
    const fired = fires.length - fb;
    switches.push({ to: m, programsBuilt: built, guardFires: fired, worstFrameMs: w.max, frames: w.n });
    console.log(`-> ${m.padEnd(7)} programs +${String(built).padStart(2)}  guard +${fired}  worst frame in the 900 ms after = ${w.max} ms`);
  }
  res.switches = switches;
  const firstVisit = switches.slice(0, 3);
  res.switchSummary = {
    programsBuiltOnFirstVisitOfEachMode: firstVisit.reduce((a, s) => a + s.programsBuilt, 0),
    worstSwitchFrameMs: Math.max(...switches.map((s) => s.worstFrameMs)),
    totalProgramsBuilt: switches.reduce((a, s) => a + s.programsBuilt, 0),
    totalGuardFires: switches.reduce((a, s) => a + s.guardFires, 0),
  };
  console.log(JSON.stringify(res.switchSummary));
  res.postCensus = census();
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
