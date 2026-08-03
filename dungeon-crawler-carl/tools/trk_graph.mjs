// WHAT IS THE MATRIX WALK WALKING? A census, not a timing — so it is immune to
// the sibling browsers that make every timing on this box suspect.
//
// The ablation says freezing scene.matrixWorldAutoUpdate is the single biggest
// lever in the frame. This asks the follow-up: how many nodes are in the walk,
// what KIND are they, and how many of them belong to something that is actually
// drawn this frame? A bone on a monster three rooms away costs a matrix compose
// and a bone-texture upload and contributes nothing.
//
// Usage: node tools/trk_graph.mjs [--floor 15] [--adapter igpu] [--port 5282]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const floor = Number(flag("--floor", 15));
const level = Number(flag("--level", 26));
const adapter = flag("--adapter", "igpu");
const port = Number(flag("--port", 5282));

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=${level}&seed=41&abilities=all&debug=1&quality=high`;

console.log("[contamination]", JSON.stringify(census()), "(a census is not a timing — this does not invalidate it)");
const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
let out = null;
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
  await page.waitForTimeout(3000);
  const boxGone = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    const r = e.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  });
  if (!boxGone) throw new Error("#loading still has a box");
  console.log("GPU:", await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
  }));
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.waitForTimeout(2500);

  out = await page.evaluate(() => {
    const THREEFrustum = window.__dcc.renderer.camera;
    const r3d = window.__dcc.renderer;
    const cam = r3d.camera;
    cam.updateMatrixWorld();
    // build a frustum without importing three: reuse the projection*view matrix
    // and test each object's bounding sphere by hand.
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = m.elements;
    const planes = [];
    const push = (a, b, c, d) => {
      const len = Math.hypot(a, b, c);
      planes.push([a / len, b / len, c / len, d / len]);
    };
    push(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
    push(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
    push(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
    push(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
    push(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
    push(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
    const inFrustum = (obj) => {
      if (!obj.geometry) return null;
      if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
      const bs = obj.geometry.boundingSphere;
      if (!bs) return null;
      const c = bs.center.clone().applyMatrix4(obj.matrixWorld);
      const s = obj.matrixWorld.getMaxScaleOnAxis?.() ?? 1;
      const r = bs.radius * s;
      for (const p of planes) if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r) return false;
      return true;
    };

    const byType = {};
    const bump = (k) => { byType[k] = (byType[k] ?? 0) + 1; };
    let total = 0, bones = 0, groups = 0, meshes = 0, skinned = 0, instanced = 0, lights = 0;
    let autoMat = 0, visibleFalse = 0;
    let skinnedInFrustum = 0, skinnedOut = 0, meshInFrustum = 0, meshOut = 0;
    let boneUnderVisibleSkin = 0, boneUnderCulledSkin = 0;
    const skinRoots = [];
    r3d.scene.traverse((o) => {
      total++;
      bump(o.type);
      if (o.matrixAutoUpdate) autoMat++;
      if (!o.visible) visibleFalse++;
      if (o.isBone) bones++;
      else if (o.isInstancedMesh) instanced++;
      else if (o.isSkinnedMesh) { skinned++; const f = inFrustum(o); if (f) skinnedInFrustum++; else skinnedOut++; }
      else if (o.isMesh) { meshes++; const f = inFrustum(o); if (f) meshInFrustum++; else meshOut++; }
      else if (o.isLight) lights++;
      else if (o.type === "Group" || o.type === "Object3D") groups++;
    });
    // per-rig accounting: for every subtree containing a SkinnedMesh, is ANY
    // part of it on screen?
    const rigs = [];
    r3d.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      let root = o;
      while (root.parent && root.parent !== r3d.scene && !root.parent.userData?.rigRoot) root = root.parent;
      if (!skinRoots.includes(root)) skinRoots.push(root);
    });
    for (const root of skinRoots) {
      let n = 0, b = 0, sm = 0, anyVisible = false;
      root.traverse((o) => {
        n++;
        if (o.isBone) b++;
        if (o.isSkinnedMesh) { sm++; if (inFrustum(o)) anyVisible = true; }
      });
      rigs.push({ nodes: n, bones: b, skinnedMeshes: sm, onScreen: anyVisible });
    }
    const onScreenRigs = rigs.filter((r) => r.onScreen);
    const offScreenRigs = rigs.filter((r) => !r.onScreen);
    const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);

    const st = window.__dcc.state;
    const gl = r3d.renderer;
    return {
      totalNodes: total,
      byType,
      bones, groups, meshes, skinned, instanced, lights,
      matrixAutoUpdateOn: autoMat,
      visibleFalse,
      meshInFrustum, meshOut, skinnedInFrustum, skinnedOut,
      rigCount: rigs.length,
      rigsOnScreen: onScreenRigs.length,
      rigsOffScreen: offScreenRigs.length,
      nodesInOnScreenRigs: sum(onScreenRigs, "nodes"),
      nodesInOffScreenRigs: sum(offScreenRigs, "nodes"),
      bonesInOnScreenRigs: sum(onScreenRigs, "bones"),
      bonesInOffScreenRigs: sum(offScreenRigs, "bones"),
      monsters: st.monsters.length,
      monstersAlive: st.monsters.filter((m2) => m2.hp > 0).length,
      drawCallsLastFrame: gl.info.render.calls,
      programs: gl.info.programs.length,
      textures: gl.info.memory.textures,
      geometriesGpu: gl.info.memory.geometries,
    };
  });

  console.log(`\n=== SCENE GRAPH CENSUS · floor ${floor} ===`);
  console.log(`total nodes in the per-frame matrix walk : ${out.totalNodes}`);
  console.log(`  bones                                  : ${out.bones}`);
  console.log(`  groups/Object3D                        : ${out.groups}`);
  console.log(`  meshes (non-skinned, non-instanced)    : ${out.meshes}   (${out.meshInFrustum} in frustum, ${out.meshOut} out)`);
  console.log(`  skinned meshes                         : ${out.skinned}   (${out.skinnedInFrustum} in frustum, ${out.skinnedOut} out)`);
  console.log(`  instanced meshes                       : ${out.instanced}`);
  console.log(`  lights                                 : ${out.lights}`);
  console.log(`  nodes with matrixAutoUpdate ON         : ${out.matrixAutoUpdateOn}  <- these recompose every frame`);
  console.log(`  nodes with visible=false               : ${out.visibleFalse}`);
  console.log(`\nRIGS (animated character subtrees)`);
  console.log(`  rigs total / on screen / off screen    : ${out.rigCount} / ${out.rigsOnScreen} / ${out.rigsOffScreen}`);
  console.log(`  nodes in ON-screen rigs                : ${out.nodesInOnScreenRigs}  (bones ${out.bonesInOnScreenRigs})`);
  console.log(`  nodes in OFF-screen rigs               : ${out.nodesInOffScreenRigs}  (bones ${out.bonesInOffScreenRigs})  <- walked+animated for nothing`);
  console.log(`\nsim monsters ${out.monstersAlive}/${out.monsters} · draw calls last frame ${out.drawCallsLastFrame} · programs ${out.programs} · GPU textures ${out.textures} · geometries ${out.geometriesGpu}`);
  console.log(`\nnode types: ${JSON.stringify(out.byType)}`);
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkgraph_f${floor}.json`, JSON.stringify(out, null, 1));
console.log(`wrote tools/_trkgraph_f${floor}.json`);
