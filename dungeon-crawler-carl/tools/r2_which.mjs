// WHICH OF THIS ROUND'S CHANGES COST WHAT — sandwiched A/B against the shipped
// build, one arm per change, so a net regression can be attributed instead of
// argued about.
//
// The first AFTER ladder on the RTX 5090 came back with HIGH at 78.4 fps
// against a 92.4 fps BEFORE. Three things had moved at once (the rig gate, the
// AO denoise resolution, the late-program catcher) and a pooled ladder cannot
// say which. This can.
//
// Usage: node tools/r2_which.mjs --adapter dgpu|igpu [--mode high] [--secs 2.5] [--reps 3]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, sandwich, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "dgpu");
const mode = flag("--mode", "high");
const secs = Number(flag("--secs", 2.5));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_r2which_${adapter}_${mode}.json`);

// Each arm REVERTS one of this round's changes, so a positive "saved" means
// that change is costing us and a zero means it is free.
// At HIGH the rig gate does not run at all (offscreenRigHz is Infinity), so
// only two of this round's three changes can be in the frame here.
const ARMS = ["nosweep", "aoFullDenoise"];

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  await stage(page);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const Q = r3d.qualityProfile;
    const AO = { radius: 0.55, distanceExponent: 1, thickness: 1, scale: 1.3, distanceFallOff: 1, screenSpaceRadius: false };
    const ARM = {
      // Revert the late-program catcher: no scan, no park, no compileAsync.
      nosweep: () => { r3d.matSweepArmed = false; },
      // Revert the AO denoise back to full resolution (the r4 arrangement).
      aoFullDenoise: () => r3d.gtao.setResolutionScales(Q.gtaoScale, 1),
    };
    const RESTORE = {
      nosweep: () => { r3d.matSweepArmed = true; },
      aoFullDenoise: () => r3d.gtao.setResolutionScales(Q.gtaoScale, Q.gtaoDenoiseScale),
    };
    let armed = null;
    window.__arm = (n) => {
      if (armed) { RESTORE[armed](); armed = null; }
      if (n) { ARM[n](); armed = n; }
      return true;
    };
    window.__sweep = () => ({ fires: r3d.matSweepFires, built: r3d.matSweepProgramsBuilt });
  });

  const s0 = await page.evaluate(() => window.__sweep());
  console.log(`[sweep] at start of measurement: ${JSON.stringify(s0)}`);
  const res = await sandwich(page, ARMS, {
    secs, reps, label: `${adapter}/${mode} WHICH CHANGE COSTS WHAT`,
    apply: (p, arm) => p.evaluate((a) => window.__arm(a), arm),
  });
  const s1 = await page.evaluate(() => window.__sweep());
  console.log(`[sweep] at end: ${JSON.stringify(s1)}  -> ${s1.fires - s0.fires} async compiles kicked, `
    + `${s1.built - s0.built} programs actually built during the run.`);
  console.log("  A catcher that fires many times and builds nothing has a broken key function.");
  writeFileSync(out, JSON.stringify({ adapter, mode, secs, reps, sweepStart: s0, sweepEnd: s1, ...res }, null, 2));
  console.log(`\nwrote ${out}`);
} finally {
  await browser.close();
}
