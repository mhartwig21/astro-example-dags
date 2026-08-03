// OPT-R3 — WHERE THE FIGHT FRAME GOES, split finer than "scene vs post".
//
// o3_diag put 63% of the MEDIUM fight frame in the SCENE PASS and 37% in the
// post chain, and halving the backbuffer bought 50%. That is enough to know the
// frame is pixel-bound on the Intel part but not enough to know WHICH pixels.
// These arms answer that: transparent overdraw (the combat FX the fight scene
// adds and the dense-pinned scene does not), the shadow pass, the bodies, the
// floor, and each post pass on its own.
//
// Usage: node tools/o3_where.mjs --adapter igpu|dgpu [--mode medium] [--secs 4] [--reps 2]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, sandwich, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "medium");
const scene = flag("--scene", "fight");
const secs = Number(flag("--secs", 4));
const reps = Number(flag("--reps", 2));
const out = flag("--out", `tools/_o3where_${adapter}_${mode}_${scene}.json`);

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(800);
  const arms = (flag("--arms", "noalpha,noadditive,nofx,noshadow,nomonsters,nofloor,gtao,bloom,smaa,grade,output,halfres")).split(",");
  const r = await sandwich(page, arms, {
    secs, reps, scene, label: `${adapter} / ${mode} / ${scene}`,
    apply: async (pg, arm) => {
      if (arm) await pg.evaluate((a) => window.__ab(a, true), arm);
      else for (const a of arms) await pg.evaluate((x) => window.__ab(x, false), a);
    },
  });
  writeFileSync(out, JSON.stringify({ adapter, mode, scene, ...r }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
