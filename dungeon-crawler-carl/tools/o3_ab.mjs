// OPT-R3 — WHAT THIS ROUND'S CHANGES ARE WORTH, as the delivered-time ratio
// you get by REVERTING each of them inside ONE page session.
//
// Cross-session absolutes are not evidence on this box (quality.ts AB_REVERT
// documents a false 15% regression alarm that a same-session A/B of the
// identical change turned into a 9.2% win), so every claim this round makes
// about a change is measured the same way: arm window sandwiched between two
// baseline windows, scored against the mean of its own two neighbours, order
// rotated across reps.
//
// AND THE VERDICT IS THE GPU CLOCK, NOT THE WALL CLOCK. Sandwiching alone was
// not enough: the same arm scored 0.884 and 1.431 in consecutive reps of this
// very script, because a wall-clock window on this box is a sample of whatever
// the other sixteen browsers were doing. Every window here also carries the
// median of EXT_disjoint_timer_query_webgl2 TIME_ELAPSED over the composed
// frame — the GPU's own clock over the game's own commands — and that is what
// the ratio is taken on. The wall ratio is printed beside it so the two can
// disagree in public.
//
// The arms:
//   wlLegacy   — put the world-lit fragment shader back: two R8 fetches for
//                fog + walk distance instead of one RG8, and the murk /
//                atmosphere / glint block evaluated on explored ground where it
//                multiplies out to zero. Costs one recompile of the ~40 world
//                materials per flip, so this arm gets a long settle.
//   matSweep30 — put the late-program catcher's sweep cadence back to every 30
//                frames from every frame.
//
// Usage: node tools/o3_ab.mjs --adapter igpu|dgpu [--mode medium] [--secs 4] [--reps 3]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, sandwich, window1, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "medium");
const scene = flag("--scene", "fight");
const secs = Number(flag("--secs", 4));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_o3ab_${adapter}_${mode}_${scene}.json`);

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    window.__arm = async (name, on) => {
      if (name === "wlLegacy") return r3d.setWorldShaderLegacy(!!on);
      if (name === "matSweep30") { r3d.matSweepEvery = on ? 30 : 1; return r3d.matSweepEvery; }
      return -1;
    };
  });
  await stage(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(800);

  const arms = ["wlLegacy", "matSweep30"];
  const r = await sandwich(page, arms, {
    secs, reps, scene, label: `opt-r3 reverts (${adapter} / ${mode} / ${scene})`,
    apply: async (pg, arm) => {
      // Restore BOTH first, then set the one arm — an arm left on would be
      // charged to the next baseline.
      for (const a of arms) await pg.evaluate(([n]) => window.__arm(n, false), [a]);
      if (arm) {
        const n = await pg.evaluate(([x]) => window.__arm(x, true), [arm]);
        if (arm === "wlLegacy") console.log(`     [wlLegacy on] ${n} world materials queued for recompile`);
      }
      // The shader flip is a synchronous program build per world material.
      // Let it land before the window opens or the arm measures the compile.
      await pg.waitForTimeout(arm === "wlLegacy" || !arm ? 2500 : 300);
    },
  });
  writeFileSync(out, JSON.stringify({ adapter, mode, scene, ...r }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
