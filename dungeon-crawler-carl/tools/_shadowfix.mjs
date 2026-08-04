// BUG 2 — THE STUTTERING HERO SHADOW: measure the shipped fix.
//
// The fix: on presets with shadowInterval > 1 the hero stops casting into the
// cadenced key-light map (the stutter WAS the hero's cast shadow updating at
// half/quarter framerate welded to a full-rate body); the per-frame
// directional contact ellipse carries the motion instead. This script measures
// what that costs/saves by putting the STUTTER BACK (r3d.heroShadowLegacy =
// true) as a sandwiched arm inside one session — wall ratio and GPU-timer
// ratio, foreign browser count reported with every window.
//
// Also asserts the mechanism: on LOW/MEDIUM the hero's rig meshes must have
// castShadow=false while monsters still cast; on HIGH the hero must cast.
//
// Usage: node tools/_shadowfix.mjs --adapter igpu|dgpu --mode low|medium|high
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, sandwich, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "low");
const secs = Number(flag("--secs", 4));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_shadowfix_${adapter}_${mode}.json`);

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(800);

  // Mechanism assertion, after a few frames so the policy has run.
  const mech = await page.evaluate(() => {
    const r = window.__dcc.renderer;
    const q = r.qualityProfile;
    let heroCasters = 0, heroMeshes = 0;
    for (const mesh of r.playerMeshes.values()) {
      mesh.traverse((o) => { if (o.isMesh) { heroMeshes++; if (o.castShadow) heroCasters++; } });
    }
    let mobCasters = 0;
    for (const mesh of r.monsters.values()) {
      mesh.traverse((o) => { if (o.isMesh && o.castShadow) mobCasters++; });
    }
    const dirBlob = [...r.playerMeshes.values()].every((m) => !!m.userData.dirShadow);
    return { mode: q.name, interval: q.shadowInterval, heroCasters, heroMeshes, mobCasters, dirBlob };
  });
  console.log("mechanism:", JSON.stringify(mech));
  const wantHeroCast = mech.interval <= 1;
  if (!mech.dirBlob) throw new Error("dir contact shadow missing on a player mesh");
  if (wantHeroCast && mech.heroCasters === 0) throw new Error("HIGH: hero should cast into the map");
  if (!wantHeroCast && mech.heroCasters > 0) throw new Error(`cadence mode but hero still casts (${mech.heroCasters})`);
  if (!wantHeroCast && mech.mobCasters === 0) throw new Error("monsters lost their map shadows — policy over-reached");

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    window.__arm = (name, on) => {
      if (name === "heroLegacy") { r3d.heroShadowLegacy = !!on; return r3d.heroShadowLegacy; }
      return -1;
    };
  });

  const r = await sandwich(page, ["heroLegacy"], {
    secs, reps, scene: "fight", label: `hero shadow fix vs legacy stutter (${adapter} / ${mode})`,
    apply: async (pg, arm) => {
      await pg.evaluate(([on]) => window.__arm("heroLegacy", on), [arm === "heroLegacy"]);
      await pg.waitForTimeout(300); // policy lands on the next armed rebuild
    },
  });
  writeFileSync(out, JSON.stringify({ adapter, mode, mech, ...r }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
