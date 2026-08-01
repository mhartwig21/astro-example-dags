// WHAT ACTUALLY COSTS CPU IN THE MAIN PASS? Runs at a tiny backbuffer so
// fill-rate cannot confound, then times the main RenderPass under variants that
// hold DRAW COUNT fixed while changing GL STATE, and vice versa:
//
//   overrideMat   — same draws, ONE program, no texture binds, no light uniforms
//   noPointLights — same draws, same materials, fewer light uniform uploads
//   halfDraws     — half the objects hidden (draw count down, state variety same)
//
// If overrideMat collapses the cost, the bottleneck is material/program state,
// not the number of draw calls, and "batch the geometry" is the wrong fix.
//
// Usage: node tools/statecost.mjs "<url>" [--reps 5] [--frames 90] [--w 640 --h 360 --dpr 1]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const reps = Number(flag("--reps", 5));
const nFrames = Number(flag("--frames", 90));
const width = Number(flag("--w", 640));
const height = Number(flag("--h", 360));
const dpr = Number(flag("--dpr", 1));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu, `@ ${width}x${height} dpr${dpr}`);
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.keyboard.down("w"); await page.waitForTimeout(2200); await page.keyboard.up("w");
for (const k of ["Space", "q", "e"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(100); }

await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const scene = R.scene;
  const renderPass = R.composer.passes[0];

  // time the main RenderPass + count its draws + count PROGRAM SWITCHES
  let t = [], calls = 0, progSwitches = 0, frames = 0, lastProg = null, active = false;
  const origUse = gl.getContext().useProgram.bind(gl.getContext());
  gl.getContext().useProgram = function (p) { if (active && p !== lastProg) { progSwitches++; lastProg = p; } return origUse(p); };
  const origRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (...a) { if (active) calls++; return origRBD(...a); };
  const origPass = renderPass.render.bind(renderPass);
  renderPass.render = function (...a) {
    active = true; lastProg = null;
    const t0 = performance.now();
    const r = origPass(...a);
    t.push(performance.now() - t0);
    active = false;
    return r;
  };
  // whole-frame composer time, so variants outside the main pass (GTAO) show up
  let ct = [];
  const origComposer = R.composer.render.bind(R.composer);
  R.composer.render = function (...a) {
    const t0 = performance.now();
    const r = origComposer(...a);
    ct.push(performance.now() - t0);
    frames++;
    return r;
  };

  let hidden = [];
  let casterOff = [];
  const savedAuto = gl.shadowMap.autoUpdate;
  const savedGbuf = R.gtao._renderGBuffer;
  const savedShadowSize = [R.key.shadow.mapSize.x, R.key.shadow.mapSize.y];
  const fieldRoots = (name) => {
    const v = R[name], out = [];
    const take = (e) => { if (!e || typeof e !== "object") return; if (e.isObject3D) { out.push(e); return; } for (const s of Object.values(e)) if (s && s.isObject3D) out.push(s); };
    if (!v) return out;
    if (v instanceof Map) for (const e of v.values()) take(e);
    else if (Array.isArray(v)) for (const e of v) take(e);
    else take(v);
    return out;
  };
  // rAF-to-rAF frame time, so full-res runs report the number the player feels
  let rt = [], lastRaf = performance.now();
  const rafTick = () => { const n = performance.now(); rt.push(n - lastRaf); lastRaf = n; requestAnimationFrame(rafTick); };
  requestAnimationFrame(rafTick);
  // A single flat material to override the whole scene with: clone whatever
  // standard material is already loaded and strip its maps, so the variant
  // measures "one program, no texture binds" against the same draw count.
  const oneMat = (() => {
    let m = null;
    scene.traverse((o) => { const mm = Array.isArray(o.material) ? o.material[0] : o.material; if (!m && mm && mm.isMeshStandardMaterial) m = mm; });
    if (!m) return null;
    const c = m.clone();
    for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap"]) c[k] = null;
    c.onBeforeCompile = () => {};
    c.transparent = false;
    c.needsUpdate = true;
    return c;
  })();

  const variants = {
    baseline: () => {},
    shadowSkip: () => { gl.shadowMap.autoUpdate = false; },
    gtaoGBufSkip: () => { R.gtao._renderGBuffer = false; },
    overrideMat: () => { if (oneMat) scene.overrideMaterial = oneMat; },
    noPointLights: () => { scene.traverse((o) => { if (o.isPointLight && o.visible) { hidden.push(o); o.visible = false; } }); },
    halfDraws: () => {
      let i = 0;
      scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible && (i++ & 1)) { hidden.push(o); o.visible = false; } });
    },
    quarterDraws: () => {
      let i = 0;
      scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible && (i++ & 3)) { hidden.push(o); o.visible = false; } });
    },
    // --- shadow-caster pruning (the shadow pass redraws most of the scene) ---
    castersCharsOnly: () => {
      scene.traverse((o) => { if (o.castShadow) { casterOff.push(o); o.castShadow = false; } });
      for (const n of ["monsters", "playerMeshes"]) for (const r of fieldRoots(n)) r.traverse((c) => { if (c.isMesh || c.isSkinnedMesh) c.castShadow = true; });
    },
    castersNoProps: () => {
      R.floorGroup.children.forEach((c) => { if (!c.isInstancedMesh) c.traverse((o) => { if (o.castShadow) { casterOff.push(o); o.castShadow = false; } }); });
    },
    castersNone: () => { scene.traverse((o) => { if (o.castShadow) { casterOff.push(o); o.castShadow = false; } }); },
    shadow1024: () => { R.key.shadow.mapSize.set(1024, 1024); R.key.shadow.map?.dispose(); R.key.shadow.map = null; },
    // SkeletonUtils.clone mints one Skeleton PER skinned mesh, so an 8-part rig
    // recomputes and re-uploads the same bone matrices 8x a frame. Rebind every
    // mesh in a rig to the first mesh's skeleton (same bones, same pose) and
    // see what the duplication was costing. NOT undone by restore() — it is a
    // strict improvement, so it is applied last in the variant order.
    shareSkeletons: () => {
      let rigs = 0, dropped = 0;
      for (const n of ["monsters", "playerMeshes", "breakableMeshes"]) {
        for (const root of fieldRoots(n)) {
          let first = null, ok = true;
          const meshes = [];
          root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) meshes.push(o); });
          if (meshes.length < 2) continue;
          first = meshes[0].skeleton;
          for (const m of meshes) if (m.skeleton.bones.length !== first.bones.length) ok = false;
          if (!ok) continue;
          rigs++;
          for (let i = 1; i < meshes.length; i++) { meshes[i].bind(first, meshes[i].bindMatrix); dropped++; }
        }
      }
      window.__scSkel = { rigs, skeletonsDropped: dropped };
    },
    // the combination the plan actually proposes
    gbufSkip_plus_charCasters: () => {
      R.gtao._renderGBuffer = false;
      scene.traverse((o) => { if (o.castShadow) { casterOff.push(o); o.castShadow = false; } });
      for (const n of ["monsters", "playerMeshes"]) for (const r of fieldRoots(n)) r.traverse((c) => { if (c.isMesh || c.isSkinnedMesh) c.castShadow = true; });
    },
  };

  window.__sc = {
    _basic: oneMat,
    list: Object.keys(variants),
    restore() {
      scene.overrideMaterial = null;
      gl.shadowMap.autoUpdate = savedAuto;
      gl.shadowMap.needsUpdate = true;
      R.gtao._renderGBuffer = savedGbuf;
      if (R.key.shadow.mapSize.x !== savedShadowSize[0]) { R.key.shadow.mapSize.set(savedShadowSize[0], savedShadowSize[1]); R.key.shadow.map?.dispose(); R.key.shadow.map = null; }
      for (const o of hidden) o.visible = true;
      for (const o of casterOff) o.castShadow = true;
      hidden = []; casterOff = [];
    },
    apply(name) { this.restore(); if (variants[name]) variants[name](); },
    reset() { t = []; ct = []; rt = []; calls = 0; progSwitches = 0; frames = 0; },
    result() {
      const md = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? +s[s.length >> 1].toFixed(2) : 0; };
      const mn = (v) => v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : 0;
      return { medianMs: md(t), meanMs: mn(t), composerMs: md(ct), rafMs: md(rt), composerMean: mn(ct),
        callsPerFrame: +(calls / Math.max(1, frames)).toFixed(1), progSwitchesPerFrame: +(progSwitches / Math.max(1, frames)).toFixed(1), frames, samples: t.length };
    },
    frames: () => frames,
  };
});

const hasBasic = await page.evaluate(() => !!window.__sc._basic);
const names = await page.evaluate(() => window.__sc.list);
if (!hasBasic) console.log("(no standard material to clone; overrideMat will be skipped)");
const acc = {};
const accC = {};
const accR = {};
for (const n of names) { acc[n] = []; accC[n] = []; accR[n] = []; }
const meta = {};

for (let r = 0; r < reps; r++) {
  for (const n of names) {
    if (n === "overrideMat" && !hasBasic) continue;
    await page.evaluate((v) => window.__sc.apply(v), n);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__sc.reset());
    await page.waitForFunction((f) => window.__sc.frames() >= f, nFrames, { timeout: 60000 }).catch(() => {});
    const res = await page.evaluate(() => window.__sc.result());
    acc[n].push(res.medianMs);
    accC[n].push(res.composerMs);
    accR[n].push(res.rafMs);
    meta[n] = res;
  }
}
await page.evaluate(() => window.__sc.restore());

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log("\n=== CPU TIME, fill-rate neutralised (%dx%d dpr%d) ===", width, height, dpr);
console.log("variant".padEnd(26), "mainPass".padStart(9), "composer".padStart(9), "rAF".padStart(8), "dRAF".padStart(8), "calls/f".padStart(8), "  rAF reps");
const baseRaf = med(accR[names[0]]);
for (const n of names) {
  if (!acc[n].length) continue;
  console.log(n.padEnd(26), String(med(acc[n])).padStart(9), String(med(accC[n])).padStart(9),
    String(med(accR[n])).padStart(8), String(+(med(accR[n]) - baseRaf).toFixed(1)).padStart(8),
    String(meta[n].callsPerFrame).padStart(8), " ", accR[n].join(","));
}
await browser.close();
