// ACCEPTANCE R3 — the ladder, re-measured from scratch, on both adapters.
//
// Usage: node tools/acc3_modes.mjs --adapter igpu|dgpu [--scenes fight,quiet]
//                                  [--secs 6] [--reps 3] [--floor 15] [--tag a]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag, BUDGET } from "./acc3_lab.mjs";
import { census } from "./trk_census.mjs";

const adapter = flag("--adapter", "igpu");
const scenes = flag("--scenes", "fight,quiet").split(",");
const secs = Number(flag("--secs", 6));
const reps = Number(flag("--reps", 3));
const floor = Number(flag("--floor", 15));
const tag = flag("--tag", "a");
const out = flag("--out", `tools/_acc3_${tag}_${adapter}_f${floor}.json`);
const MODES = ["low", "medium", "high"];

const c0 = census();
console.log(`[census] at launch: own=${c0.own} FOREIGN=${c0.foreign} ${JSON.stringify(c0.foreignPids || [])}`);

const { browser, page, gpu } = await boot({ adapter, floor });
const R = { adapter, gpu, floor, secs, reps, censusAtLaunch: c0, scenes: {}, raw: [] };
try {
  await installProbe(page);
  const staged = await stage(page);
  R.staged = staged;

  for (const scene of scenes) {
    const runs = new Map(MODES.map((m) => [m, []]));
    for (let r = 0; r < reps; r++) {
      // Rotate the order every rep so no mode always follows the same mode.
      const order = MODES.map((_, i) => MODES[(i + r) % MODES.length]);
      for (const mode of order) {
        const got = await page.evaluate((m) => window.__setMode(m), mode);
        if (got !== mode) throw new Error(`setMode(${mode}) landed on ${got}`);
        await page.waitForTimeout(1200); // mode switch is a ~372 ms sync task
        const w = await window1(page, { secs, scene, budgetMs: BUDGET[mode] });
        w.mode = mode; w.scene = scene; w.rep = r;
        runs.get(mode).push(w);
        R.raw.push({ mode, scene, rep: r, shape: w.shape, gpuMs: w.gpuMs, gpuP90: w.gpuP90,
          foreign: w.foreign, fps: w.fps, visible: w.visible, visibleEnd: w.visibleEnd,
          liveStart: w.liveStart, liveEnd: w.liveEnd, calls: w.calls, programs: w.programs });
        const s = w.shape;
        console.log(
          `${scene.padEnd(6)} r${r} ${mode.padEnd(7)} ${String(s.fps).padStart(7)}fps del=${String(s.delivered).padStart(6)} `
          + `p50=${String(s.p50).padStart(6)} p90=${String(s.p90).padStart(7)} p99=${String(s.p99).padStart(7)} `
          + `>16.7=${String(s.over16).padStart(5)}% >33=${String(s.over33).padStart(5)}% `
          + `gpu=${String(w.gpuMs).padStart(6)} vis=${w.visible}->${w.visibleEnd} `
          + `presets=${w.fps.length} foreign=${w.foreign}`,
        );
        if (w.fps.length !== 1) {
          console.log(`  !! PRESET MOVED MID-WINDOW: ${w.fps.length} distinct fingerprints`);
          for (const f of w.fps) console.log(`     ${f}`);
        }
      }
    }
    R.scenes[scene] = {};
    console.log(`\n=== ${scene.toUpperCase()} — pooled, ${adapter} (${gpu}) ===`);
    for (const m of MODES) {
      const ws = runs.get(m);
      const p = pool(ws, BUDGET[m]);
      const fpSet = [...new Set(ws.flatMap((w) => w.fps))];
      R.scenes[scene][m] = {
        ...p, windows: ws.length,
        fpDistinct: fpSet.length, fp: fpSet,
        gpuMs: +(ws.reduce((a, w) => a + (w.gpuMs ?? 0), 0) / ws.length).toFixed(2),
        visible: +(ws.reduce((a, w) => a + w.visible, 0) / ws.length).toFixed(1),
        foreignMax: Math.max(...ws.map((w) => w.foreign)),
      };
      console.log(
        `${m.padEnd(7)} ${String(p.fps).padStart(7)} fps  delivered=${String(p.delivered).padStart(6)}ms  `
        + `p50=${String(p.p50).padStart(6)} p90=${String(p.p90).padStart(7)} p99=${String(p.p99).padStart(7)}  `
        + `>16.7ms=${String(p.over16).padStart(5)}%  >33ms=${String(p.over33).padStart(5)}%  `
        + `>budget(${BUDGET[m] ?? "-"})=${String(p.overBudget).padStart(5)}%  presets=${fpSet.length}`,
      );
    }
    console.log("");
  }
} finally {
  const cEnd = census();
  R.censusAtEnd = cEnd;
  console.log(`[census] at end: own=${cEnd.own} FOREIGN=${cEnd.foreign}`);
  writeFileSync(out, JSON.stringify(R, null, 2));
  console.log(`wrote ${out}`);
  await browser.close();
}
