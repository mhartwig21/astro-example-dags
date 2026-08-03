// IS HIGH VISIBLY BETTER THAN MEDIUM? — photograph one frame under all three
// presets and let a pixel say so.
//
// THE SIM IS FROZEN FIRST. step() early-returns on any status other than
// "playing" (sim/game.ts), so parking the status and disarming the keep-alive
// pins bodies, camera and lights exactly where they are; the only thing still
// moving between the three exposures is animation-mixer pose, and in the quiet
// scene not even that. Without this the diff would be dominated by monsters
// walking, which is a picture of the sim, not of the preset.
//
// Shots are page screenshots, i.e. the COMPOSITED result at deviceScaleFactor
// 2 — MEDIUM's 1.4x backbuffer upscaled to the display exactly as a player
// sees it. Comparing raw backbuffers would compare different-sized images and
// hide the entire cost of the upscale.
//
// Usage: node tools/acc2_shots.mjs --adapter dgpu [--out tools/_acc2shots]
import { mkdirSync, writeFileSync } from "node:fs";
import { boot, installProbe, stage, flag } from "./acc2_lab.mjs";

const adapter = flag("--adapter", "dgpu");
const dir = flag("--out", "tools/_acc2shots");
mkdirSync(dir, { recursive: true });
const MODES = ["low", "medium", "high"];

const { browser, page } = await boot({ adapter, quality: "high" });
try {
  await installProbe(page);
  await stage(page);

  const meta = { adapter, scenes: {} };
  for (const scene of ["worst", "quiet"]) {
    if (scene === "worst") await page.evaluate(() => window.__toPack());
    else await page.evaluate(() => window.__toQuiet());
    await page.waitForTimeout(2600);
    // FREEZE.
    await page.evaluate(() => {
      window.__freeze = true;
      window.__dcc.state.status = "frozen";
    });
    await page.waitForTimeout(700);
    const s = await page.evaluate(() => window.__scene());
    meta.scenes[scene] = { visible: s.visible, nodes: s.nodes, modes: {} };
    console.log(`\n[${scene}] visible=${s.visible} nodes=${s.nodes} — frozen`);
    // THE ORDER CARRIES ITS OWN CONTROL. Freezing the sim pins bodies and
    // camera, but AnimationMixers still advance on the frame clock, so some of
    // any high-vs-medium difference is a monster's arm. `highB` is a SECOND
    // HIGH exposure taken one more interval later, so high-vs-highB is that
    // motion alone, measured with the preset held still. A preset difference is
    // only real if it is bigger than its own control.
    for (const m of [...MODES, "high"]) {
      const tag = m === "high" && meta.scenes[scene].modes.high ? "highB" : m;
      await page.evaluate((mm) => window.__setMode(mm), m);
      await page.waitForTimeout(1500); // let the shadow map rebuild + AO settle
      const live = await page.evaluate(() => window.__live());
      await page.screenshot({ path: `${dir}/${adapter}_${scene}_${tag}.png` });
      meta.scenes[scene].modes[tag] = live;
      console.log(`  ${tag.padEnd(7)} px=${live.pixelRatio} buf=${live.bufW}x${live.bufH} shadow=${live.shadowMap} ao=${live.aoW}x${live.aoH}`);
    }
    await page.evaluate(() => {
      window.__freeze = false;
      window.__dcc.state.status = "playing";
    });
    await page.waitForTimeout(400);
  }
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`\nwrote ${dir}`);
} finally {
  await browser.close();
}
