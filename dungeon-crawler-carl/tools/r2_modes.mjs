// THE MODE LADDER, RE-CUT — and this time the statistic can express the promise.
//
// tools/trk_modes.mjs, which every number in quality.ts was transcribed from,
// had four defects the acceptance critic named and this replaces:
//
//  1. IT SHIPPED A MEDIAN OF PER-SAMPLE MEDIANS. It could not express p90, p99
//     or the share of frames over budget — i.e. it could not express the thing
//     the contract is about. quality.ts's own tuner comment says a median
//     "reads 10 ms, wonderful and never downgrades a machine running at 24 fps",
//     and then MEASURED[] was a median. Here the raw deltas survive to the end.
//
//  2. IT NEVER RE-STAGED between windows and never rotated mode order within a
//     rep, so the pack thinned as the ladder ran (22 -> 8 visible bodies in one
//     session) and the later modes were charged for a lighter scene. Every
//     window here re-teleports to the densest live pack, and the order rotates.
//
//  3. IT COULD NOT SEE THE TAIL IT WAS CAUSED BY. The [shader-guard] fires
//     after full readiness during ordinary play — each fire is a synchronous
//     program build worth hundreds of ms. Those are captured here and reported
//     next to the percentiles they produce.
//
//  4. IT QUOTED ONE SCENE. `--scene empty` parks the crawler away from the pack
//     so the quiet-room case — the one where MEDIUM's promise was measured
//     broken on one frame in five — is a first-class result, not an anecdote.
//
// Usage: node tools/r2_modes.mjs --adapter igpu|dgpu [--scene dense|empty]
//                                [--secs 4] [--reps 3] [--tag before]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, waitForQuietGpu, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "igpu");
const scene = flag("--scene", "dense");
const secs = Number(flag("--secs", 4));
const reps = Number(flag("--reps", 3));
const tag = flag("--tag", "now");
// Canary ceiling: the empty-scene post chain measured 9.3-9.5 ms on a quiet
// Intel part and ~2 ms on the RTX. Above these the shared GPU is somebody
// else's and the ladder would be measuring the neighbour.
const canaryMax = Number(flag("--canary", adapter === "igpu" ? 14 : 5));
const out = flag("--out", `tools/_r2modes_${tag}_${adapter}_${scene}.json`);
const MODES = ["low", "medium", "high"];

const { browser, page } = await boot({ adapter });
const guard = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard] program built AFTER boot")) guard.push({ at: Date.now(), text: t.split("\n")[0].slice(0, 160) });
});

try {
  await installProbe(page);
  await stage(page);
  if (scene === "empty") {
    // WALK OUT OF THE PACK. The critic's quiet-room case is the one that broke
    // MEDIUM's promise, so it has to be a scene the ladder can actually stage.
    await page.evaluate(() => {
      const s = window.__dcc.state;
      const you = s.players[0];
      // Farthest point from any live monster inside the current room bounds.
      let best = null, bestD = -1;
      for (let i = 0; i < 400; i++) {
        const a = (i / 400) * Math.PI * 2, r = 6 + (i % 7) * 2.5;
        const x = you.pos.x + Math.cos(a) * r, y = you.pos.y + Math.sin(a) * r;
        let d = 1e9;
        for (const m of s.monsters) { if (m.hp <= 0) continue; const dx = m.pos.x - x, dy = m.pos.y - y; d = Math.min(d, dx * dx + dy * dy); }
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      if (best) { you.pos.x = best.x; you.pos.y = best.y; }
    });
    await page.waitForTimeout(2500);
  }
  let rejected = 0;
  const quiet = await waitForQuietGpu(page, { maxMs: canaryMax, tries: 4, everyMs: 8000 });
  if (!quiet.ok) {
    console.log(`!! THE GPU IS CONTENDED (canary ${quiet.canary} ms vs ${canaryMax} ms ceiling). `
      + "Every absolute below describes a shared package and MUST NOT be transcribed into a contract.");
  }
  const guard0 = guard.length;
  const t0 = Date.now();

  const runs = new Map(MODES.map((m) => [m, []]));
  const canaryTries = Number(flag("--canarytries", 6));
  for (let r = 0; r < reps; r++) {
    // ROTATE WITHIN THE REP. A fixed low->medium->high order charges the later
    // modes for everything that drifted since the first.
    const order = MODES.map((_, i) => MODES[(i + r) % MODES.length]);
    for (const mode of order) {
      await page.evaluate((m) => window.__setMode(m), mode);
      await page.waitForTimeout(700);
      // PER-WINDOW CANARY GATE. The box fluctuates: the same session read 61.6
      // ms and 18.6 ms on the same empty-scene workload eight minutes apart.
      // A session-level gate therefore either rejects everything or accepts a
      // window that went bad afterwards. Gate each window at BOTH ends and
      // retry it, so what survives is the quiet minutes rather than the mean of
      // quiet and contended ones.
      let w = null;
      for (let attempt = 0; attempt < canaryTries; attempt++) {
        const c0 = await page.evaluate((ms) => window.__canary(ms), 900);
        if (c0 > canaryMax) {
          console.log(`   [canary] ${c0} ms before ${mode} window — waiting (attempt ${attempt + 1}/${canaryTries})`);
          await page.waitForTimeout(8000);
          continue;
        }
        const cand = await window1(page, { secs, restage: scene === "dense" });
        const c1 = await page.evaluate((ms) => window.__canary(ms), 900);
        cand.canary = [c0, c1];
        if (c1 <= canaryMax) { w = cand; break; }
        console.log(`   [canary] ${c1} ms AFTER the ${mode} window — discarding it (attempt ${attempt + 1}/${canaryTries})`);
        rejected++;
      }
      if (!w) { console.log(`!! no quiet window for ${mode} in rep ${r} — skipped`); continue; }
      runs.get(mode).push(w);
      const s = w.shape;
      console.log(
        `r${r} ${mode.padEnd(7)} ${String(s.fps).padStart(6)} fps  delivered=${String(s.delivered).padStart(6)}ms  `
        + `p50=${String(s.p50).padStart(5)} p90=${String(s.p90).padStart(6)} p99=${String(s.p99).padStart(7)}  `
        + `>33=${String(s.over33).padStart(5)}%  vis=${w.visible} rigFull=${w.rigFull} foreign=${w.foreign}  fp=${w.fp}`,
      );
    }
  }

  const mins = (Date.now() - t0) / 60000;
  const table = {};
  console.log(`\n=== ${adapter} / ${scene} scene — pooled over ${reps} rotated, re-staged reps ===`);
  console.log("mode      fps  delivered   p50    p90     p99   >16.7%  >33.3%   mean");
  console.log(`[canary] ${rejected} windows discarded for GPU contention.`);
  for (const m of MODES) {
    if (!runs.get(m).length) { console.log(`${m}: NO QUIET WINDOW — not measured`); continue; }
    const p = pool(runs.get(m));
    table[m] = { ...p, fp: runs.get(m)[0].fp, visible: runs.get(m).map((w) => w.visible) };
    console.log(
      `${m.padEnd(7)} ${String(p.fps).padStart(6)} ${String(p.delivered).padStart(10)} `
      + `${String(p.p50).padStart(5)} ${String(p.p90).padStart(6)} ${String(p.p99).padStart(7)} `
      + `${String(p.over16).padStart(7)} ${String(p.over33).padStart(7)} ${String(p.mean).padStart(6)}`,
    );
  }
  const fired = guard.length - guard0;
  console.log(`\n[shader-guard] ${fired} synchronous program builds in ${mins.toFixed(1)} min of measured play `
    + `(${(fired / Math.max(0.01, mins)).toFixed(1)}/min). Each is a p99 the modes cannot touch.`);
  for (const g of guard.slice(guard0, guard0 + 30)) console.log(`   ${g.text}`);

  writeFileSync(out, JSON.stringify({
    adapter, scene, secs, reps, tag, table, guardFired: fired, guard: guard.slice(guard0),
    canary: quiet.canary, canaryMax, gpuQuiet: quiet.ok, rejectedWindows: rejected,
    windows: Object.fromEntries(MODES.map((m) => [m, runs.get(m).map((w) => ({ fp: w.fp, visible: w.visible, rigFull: w.rigFull, foreign: w.foreign, shape: w.shape }))])),
  }, null, 2));
  console.log(`\nwrote ${out}`);
} finally {
  await browser.close();
}
