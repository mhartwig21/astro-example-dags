// OPT-R3 — THE LADDER, IN THE SCENE THE GAME IS PLAYED IN.
//
// Three things this does that tools/r2_modes.mjs (which every number in
// quality.ts was transcribed from) did not:
//
//  1. IT MEASURES THE FIGHT. r2_modes staged the densest pack and PINNED THE
//     CRAWLER ALIVE IN IT, standing still, never swinging. The same pack with
//     the crawler attacking and spending abilities is 15-45% worse in every
//     mode while showing FEWER bodies — so REFERENCE_SCENE was not the worst
//     scene, and every contract stated against it was stated against a scene
//     the game is not played in. `--scene fight` is the default here.
//
//  2. IT GRADES THE MODE'S OWN BUDGET. The shape carries `overBudget` — the
//     share of frames over THAT mode's budgetMs — next to `over33`. LOW's
//     budget is 20 ms, and the shipped test graded its 10% ceiling against the
//     share over 33.3 ms: a threshold 66% looser than the field documents, so
//     LOW's stated ceiling had never been evaluated once.
//
//  3. THE CANARY IS A GPU PROBE. r2lab's canary rendered the post chain over an
//     empty scene and timed rAF, which leaves the game's whole per-frame CPU
//     running — so it rose with SCENE LOAD on a quiet box and discarded exactly
//     the expensive mode in the expensive scene. This one runs a fixed
//     fragment workload on its own WebGL2 context and ends in glFinish.
//
// Usage: node tools/o3_modes.mjs --adapter igpu|dgpu [--scene fight|dense|quiet]
//                                [--secs 5] [--reps 3] [--tag after]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag, BUDGET } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const scenes = flag("--scene", "fight,dense,quiet").split(",");
const secs = Number(flag("--secs", 5));
const reps = Number(flag("--reps", 3));
const tag = flag("--tag", "now");
const canaryMax = Number(flag("--canary", adapter === "igpu" ? 0 : 0)); // 0 = report, never discard
const out = flag("--out", `tools/_o3modes_${tag}_${adapter}.json`);
const MODES = ["low", "medium", "high"];

const { browser, page } = await boot({ adapter });
const guard = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard] program built AFTER boot")) {
    guard.push({ at: Date.now(), name: (t.split(": ")[1] || "").split("\n")[0].slice(0, 60) });
  }
});

const R = { adapter, scenes: {}, guard: null, canary: [] };
try {
  await installProbe(page);
  await stage(page);
  const t0 = Date.now();
  const guard0 = guard.length;

  for (const scene of scenes) {
    const runs = new Map(MODES.map((m) => [m, []]));
    for (let r = 0; r < reps; r++) {
      const order = MODES.map((_, i) => MODES[(i + r) % MODES.length]);
      for (const mode of order) {
        const c0 = await page.evaluate(() => window.__gpucanary());
        await page.evaluate((m) => window.__setMode(m), mode);
        await page.waitForTimeout(900);
        const w = await window1(page, { secs, scene, budgetMs: BUDGET[mode] });
        w.canary = c0;
        R.canary.push({ scene, mode, canary: c0, foreign: w.foreign });
        runs.get(mode).push(w);
        const s = w.shape;
        console.log(
          `${scene.padEnd(6)} r${r} ${mode.padEnd(7)} ${String(s.fps).padStart(6)} fps  del=${String(s.delivered).padStart(6)}ms  `
          + `p50=${String(s.p50).padStart(5)} p90=${String(s.p90).padStart(6)} p99=${String(s.p99).padStart(7)}  `
          + `>33=${String(s.over33).padStart(5)}% >bud=${String(s.overBudget).padStart(5)}%  `
          + `upd=${String(w.updateMs).padStart(5)}  vis=${w.visible}->${w.visibleEnd} gpuCanary=${c0} foreign=${w.foreign}`,
        );
      }
    }
    R.scenes[scene] = {};
    console.log(`\n=== ${scene.toUpperCase()} (pooled, ${adapter}) ===`);
    for (const m of MODES) {
      const ws = runs.get(m);
      if (!ws.length) continue;
      const p = pool(ws, BUDGET[m]);
      R.scenes[scene][m] = {
        ...p, windows: ws.length,
        updateMs: +(ws.reduce((a, w) => a + w.updateMs, 0) / ws.length).toFixed(2),
        visible: +(ws.reduce((a, w) => a + w.visible, 0) / ws.length).toFixed(1),
      };
      console.log(
        `${m.padEnd(7)} ${String(p.fps).padStart(6)} fps  delivered=${String(p.delivered).padStart(6)}ms  `
        + `p50=${p.p50} p90=${p.p90} p99=${p.p99}  >33=${p.over33}%  >budget(${BUDGET[m] ?? "-"})=${p.overBudget}%`,
      );
    }
    console.log("");
  }

  const mins = (Date.now() - t0) / 60000;
  R.guard = {
    fires: guard.length - guard0, minutes: +mins.toFixed(2),
    perMin: +((guard.length - guard0) / Math.max(0.01, mins)).toFixed(2),
    names: [...new Set(guard.slice(guard0).map((g) => g.name))].slice(0, 20),
  };
  console.log(`[shader-guard] ${R.guard.fires} fires in ${R.guard.minutes} min = ${R.guard.perMin}/min`);
  console.log(`   distinct: ${R.guard.names.join(", ")}`);
} finally {
  writeFileSync(out, JSON.stringify(R, null, 2));
  console.log(`wrote ${out}`);
  await browser.close();
}
