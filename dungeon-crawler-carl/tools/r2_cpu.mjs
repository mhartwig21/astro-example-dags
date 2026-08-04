// WHERE THE MAIN THREAD GOES — the arm set for a frame that is NOT fill-bound.
//
// tools/r2_post.mjs settled the discrete GPU: on the RTX 5090 at HIGH, killing
// the ENTIRE post chain (GTAO + bloom + grade + SMAA) moved delivered frame
// time by 0.29 ms of 12.0 — 2.4%. Nothing about the pixels is the wall there.
// So the dGPU ladder is a CPU/submission ladder and this is the arm set for it.
//
// Same sandwiched A/B as r2_post: every arm sits between two base windows.
//
// Usage: node tools/r2_cpu.mjs --adapter dgpu|igpu [--mode high] [--secs 2.5] [--reps 3]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, sandwich, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "dgpu");
const mode = flag("--mode", "high");
const secs = Number(flag("--secs", 2.5));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_r2cpu_${adapter}_${mode}.json`);

const ARMS = [
  "nodraw", "nopost", "noscene", "noshadow", "nomixer", "freezegraph",
  "nomonsters", "nofx",
];

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  await stage(page);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    const scene = r3d.scene;
    const passes = r3d.composer.passes;
    const renderPass = passes.find((p) => p.constructor.name === "RenderPass");
    const emptyScene = new (scene.constructor)();
    const realComposerRender = r3d.composer.render.bind(r3d.composer);
    const realUpdate = r3d.update.bind(r3d);
    // The whole scene-graph population, so a layer arm can hide a class of
    // object without knowing where in the graph it lives.
    const groupOf = (o) => { let c = o; while (c.parent && c.parent !== scene) c = c.parent; return c; };
    const hidden = [];
    const hideAll = (pred) => {
      scene.traverse((o) => {
        if (o.visible && pred(o)) { const g = groupOf(o); if (g.visible) { g.visible = false; hidden.push(g); } }
      });
    };
    const ARM = {
      /** Submit nothing at all: everything except drawing. */
      nodraw: () => { r3d.composer.render = () => {}; },
      /** Scene straight to the default framebuffer, no post chain. */
      nopost: () => { r3d.composer.render = () => { gl.setRenderTarget(null); gl.render(scene, r3d.camera); }; },
      /** Post chain over an empty scene: the fixed fullscreen cost, alone. */
      noscene: () => { renderPass.scene = emptyScene; },
      noshadow: () => { gl.shadowMap.enabled = false; },
      /** Every rig's AnimationMixer, off. Poses freeze; nothing else changes. */
      nomixer: () => {
        for (const [, m] of r3d.monsters) if (m.userData.animTick) { m.userData._at = m.userData.animTick; m.userData.animTick = () => {}; }
      },
      freezegraph: () => { scene.matrixWorldAutoUpdate = false; },
      nomonsters: () => { for (const [, m] of r3d.monsters) m.visible = false; },
      /** Props: the CLONED-mesh population under the 185-prop cap. */
      noprops: () => hideAll((o) => o.isMesh && /prop|dress|furn/i.test(o.name || "")),
      nofx: () => { hideAll((o) => o.isPoints || o.isSprite); },
      /** The host's per-frame DOM: HUD, minimap, skills, ticker. */
      nohud: () => { window.__dcc.state.status = "paused_measure"; },
      /** The sim step. Deterministic core, main thread. */
      nosim: () => { window.__dcc.state.__nosim = true; },
    };
    const RESTORE = {
      nodraw: () => { r3d.composer.render = realComposerRender; },
      nopost: () => { r3d.composer.render = realComposerRender; },
      noscene: () => { renderPass.scene = scene; },
      noshadow: () => { gl.shadowMap.enabled = true; },
      nomixer: () => { for (const [, m] of r3d.monsters) if (m.userData._at) { m.userData.animTick = m.userData._at; m.userData._at = null; } },
      freezegraph: () => { scene.matrixWorldAutoUpdate = true; },
      nomonsters: () => { for (const [, m] of r3d.monsters) m.visible = true; },
      noprops: () => {},
      nofx: () => {},
      nohud: () => { window.__dcc.state.status = "playing"; },
      nosim: () => { delete window.__dcc.state.__nosim; },
    };
    let armed = null;
    window.__arm = (n) => {
      if (armed) { RESTORE[armed](); for (const g of hidden) g.visible = true; hidden.length = 0; armed = null; }
      if (n) { ARM[n](); armed = n; }
      return true;
    };
    window.__realUpdate = realUpdate;
  });

  const res = await sandwich(page, ARMS, {
    secs, reps, label: `${adapter}/${mode} CPU ARMS`,
    apply: (p, arm) => p.evaluate((a) => window.__arm(a), arm),
  });
  writeFileSync(out, JSON.stringify({ adapter, mode, secs, reps, ...res }, null, 2));
  console.log(`\nwrote ${out}`);
} finally {
  await browser.close();
}
