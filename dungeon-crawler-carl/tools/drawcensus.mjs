// DRAW-CALL CENSUS. Not an estimate: hooks WebGLRenderer.renderBufferDirect —
// the single funnel every draw in three.js passes through, including the shadow
// map's depth pass, GTAO's normal G-buffer re-render, and every fullscreen post
// quad — and attributes each call to (phase, category).
//
// Phases are established by wrapping shadowMap.render, gtao.renderOverride and
// each composer pass's render(), so a call landing inside one is tagged with it.
//
// Also reports frustum-culling effectiveness: total meshes present vs meshes
// actually drawn, and for InstancedMeshes the fraction of INSTANCES whose
// world position falls inside the camera frustum (the 12- vs 36-tile chunk
// bucket tradeoff shows up here as instance waste).
//
// Usage: node tools/drawcensus.mjs "<url>" [--seconds 6] [--w 1440] [--h 852] [--dpr 2]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.goto(url, { waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);
// Walk so streamed dressing + monsters are live, then throw abilities so FX exist.
await page.keyboard.down("w"); await page.waitForTimeout(2200); await page.keyboard.up("w");
for (const k of ["Space", "q", "e", "c", "r"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }

// ---- install the hook ----
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const scene = R.scene;
  const THREE = window.__dcc.THREE || null;

  // ---------- category labelling ----------
  const labelCache = new WeakMap();
  // name every top-level scene child by the Renderer3D field that holds it
  const fieldName = new Map();
  const claim = (o, k) => { if (o && o.isObject3D && !fieldName.has(o)) fieldName.set(o, k); };
  for (const k of Object.keys(R)) {
    const v = R[k];
    if (!v) continue;
    if (v.isObject3D) claim(v, k);
    if (v.group && v.group.isObject3D) claim(v.group, k);
    // Maps/arrays of live scene objects: playerMeshes, mobMeshes, projectiles,
    // loot, telegraphs... these are where characters/monsters/FX actually live.
    if (v instanceof Map) for (const e of v.values()) {
      if (e && e.isObject3D) claim(e, k);
      else if (e && typeof e === "object") for (const s of Object.values(e)) claim(s, k);
    }
    if (Array.isArray(v)) for (const e of v) {
      if (e && e.isObject3D) claim(e, k);
      else if (e && typeof e === "object") for (const s of Object.values(e)) claim(s, k);
    }
  }
  const floorGroup = R.floorGroup;

  const geoKey = (g) => {
    if (!g) return "nogeo";
    const p = g.parameters;
    if (p) {
      const t = g.type.replace("Geometry", "");
      if (t === "Box") return `Box(${p.width},${p.height},${p.depth})`;
      if (t === "Plane") return `Plane(${p.width}x${p.height})`;
      return `${t}`;
    }
    const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    return `glTF[${n}]`;
  };

  // sub-label for direct children of floorGroup: geometry signature + shadow flag
  const floorSub = (o) => {
    if (o.isInstancedMesh) {
      const g = geoKey(o.geometry);
      // decompose average instance Y to separate ground kinds from wall kinds
      return `floorGroup/INST ${g} cast=${o.castShadow ? 1 : 0}`;
    }
    return `floorGroup/${o.isMesh ? "mesh" : o.type} ${geoKey(o.geometry)}`;
  };

  const labelOf = (o) => {
    let l = labelCache.get(o);
    if (l !== undefined) return l;
    // walk up to the top-level scene child
    let cur = o, topChild = null, underFloor = false, floorChild = null;
    while (cur) {
      if (cur.parent === scene) topChild = cur;
      if (cur.parent === floorGroup) { underFloor = true; floorChild = cur; }
      cur = cur.parent;
    }
    if (!topChild) l = `DETACHED/${o.type}`;
    else if (underFloor) l = floorSub(floorChild);
    else {
      const fn = fieldName.get(topChild);
      if (fn) l = `${fn}`;
      else if (topChild === o) l = `scene/${o.type}:${o.name || "-"}`;
      else l = `scene/${topChild.type}:${topChild.name || "-"}`;
    }
    labelCache.set(o, l);
    return l;
  };

  // ---------- phase tagging ----------
  let phase = "main";
  const wrap = (obj, key, name) => {
    if (!obj || typeof obj[key] !== "function" || obj["__wrapped_" + key]) return;
    const orig = obj[key].bind(obj);
    obj["__wrapped_" + key] = true;
    obj[key] = function (...a) {
      const prev = phase; phase = name;
      try { return orig(...a); } finally { phase = prev; }
    };
  };
  wrap(gl.shadowMap, "render", "SHADOW");
  if (R.gtao) {
    wrap(R.gtao, "renderOverride", "GTAO_GBUFFER");   // full scene re-render, normal override
    wrap(R.gtao, "renderPass", "GTAO_FSQUAD");        // ao + denoise + blend fullscreen quads
    wrap(R.gtao, "overrideVisibility", "GTAO_VISWALK");
    wrap(R.gtao, "restoreVisibility", "GTAO_VISWALK");
  }
  const passNames = [];
  (R.composer?.passes || []).forEach((p, i) => {
    const n = `PASS${i}:${p.constructor.name}`;
    passNames.push(n);
    if (p !== R.gtao) wrap(p, "render", n);
  });

  // ---------- the counter ----------
  const stats = new Map(); // key "phase|label" -> {calls, tris, frames}
  let frames = 0;
  const bump = (k, tris) => {
    let s = stats.get(k);
    if (!s) { s = { calls: 0, tris: 0 }; stats.set(k, s); }
    s.calls++; s.tris += tris;
  };
  const origRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (camera, sceneArg, geometry, material, object, group) {
    const idx = geometry.index ? geometry.index.count : (geometry.attributes.position ? geometry.attributes.position.count : 0);
    let tris = idx / 3;
    if (object && object.isInstancedMesh) tris *= object.count;
    let lbl;
    if (object && object.type === "Mesh" && !object.parent && !object.isInstancedMesh) lbl = "FULLSCREEN_QUAD";
    else lbl = labelOf(object);
    bump(phase + "|" + lbl, tris);
    return origRBD(camera, sceneArg, geometry, material, object, group);
  };

  // ---------- per-frame frustum accounting ----------
  const cull = { meshesTotal: 0, meshesInFrustum: 0, instTotal: 0, instInFrustum: 0, byBucket: {} };
  let cullSamples = 0;

  const origComposerRender = R.composer.render.bind(R.composer);
  R.composer.render = function (...a) { frames++; return origComposerRender(...a); };

  window.__census = {
    frames: () => frames,
    passNames,
    reset() { stats.clear(); frames = 0; },
    dump() {
      const rows = [];
      for (const [k, v] of stats) {
        const [ph, lbl] = k.split("|");
        rows.push({ phase: ph, label: lbl, callsPerFrame: +(v.calls / Math.max(1, frames)).toFixed(1), trisPerFrame: Math.round(v.tris / Math.max(1, frames)) });
      }
      rows.sort((a, b) => b.callsPerFrame - a.callsPerFrame);
      const byPhase = {};
      const byLabel = {};
      for (const r of rows) {
        byPhase[r.phase] = (byPhase[r.phase] || 0) + r.callsPerFrame;
        byLabel[r.label] = (byLabel[r.label] || 0) + r.callsPerFrame;
      }
      for (const k of Object.keys(byPhase)) byPhase[k] = +byPhase[k].toFixed(1);
      const labelRows = Object.entries(byLabel).map(([l, c]) => [l, +c.toFixed(1)]).sort((a, b) => b[1] - a[1]);
      return { frames, rows, byPhase, labelRows, info: { calls: gl.info.render.calls, tris: gl.info.render.triangles, programs: gl.info.programs.length, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures } };
    },
    // frustum-culling effectiveness, sampled live against the real camera
    cullAudit() {
      const T = R.camera.constructor; // not needed; use three via scene objects
      const cam = R.camera;
      cam.updateMatrixWorld();
      const projScreen = new (Object.getPrototypeOf(cam.projectionMatrix).constructor)();
      projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      // build frustum planes manually from the matrix (avoid needing THREE import)
      const me = projScreen.elements;
      const planes = [];
      const mk = (a, b, c, d) => { const l = Math.hypot(a, b, c); planes.push([a / l, b / l, c / l, d / l]); };
      mk(me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
      mk(me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
      mk(me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
      mk(me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
      mk(me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
      mk(me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
      const inFrustumPt = (x, y, z, r) => {
        for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
        return true;
      };
      const out = { groups: {}, floorChunks: [] };
      const tally = (bucket, o) => {
        const b = out.groups[bucket] || (out.groups[bucket] = { meshes: 0, drawn: 0, inst: 0, instIn: 0 });
        b.meshes++;
        // InstancedMesh carries its own (instance-spread) sphere; plain meshes
        // use the geometry's. three.js prefers the same order when culling.
        const s = (o.isInstancedMesh && o.boundingSphere) || (o.geometry && o.geometry.boundingSphere);
        let vis = true;
        if (s) {
          const c = s.center;
          const wm = o.matrixWorld.elements;
          const wx = wm[0] * c.x + wm[4] * c.y + wm[8] * c.z + wm[12];
          const wy = wm[1] * c.x + wm[5] * c.y + wm[9] * c.z + wm[13];
          const wz = wm[2] * c.x + wm[6] * c.y + wm[10] * c.z + wm[14];
          const sc = Math.max(Math.hypot(wm[0], wm[1], wm[2]), Math.hypot(wm[4], wm[5], wm[6]), Math.hypot(wm[8], wm[9], wm[10]));
          vis = inFrustumPt(wx, wy, wz, s.radius * sc);
        }
        if (vis && o.visible) b.drawn++;
        if (o.isInstancedMesh) {
          b.inst += o.count;
          const arr = o.instanceMatrix.array;
          let hit = 0;
          for (let i = 0; i < o.count; i++) {
            const off = i * 16;
            if (inFrustumPt(arr[off + 12], arr[off + 13], arr[off + 14], 0.9)) hit++;
          }
          b.instIn += hit;
        }
      };
      for (const child of scene.children) {
        const base = fieldName.get(child) || `scene/${child.type}:${child.name || "-"}`;
        child.traverse((o) => {
          if (!o.isMesh && !o.isPoints && !o.isSprite && !o.isLine) return;
          if (child === floorGroup) {
            let fc = o; while (fc.parent && fc.parent !== floorGroup) fc = fc.parent;
            tally(o.isInstancedMesh && fc === o ? floorSub(o) : "floorGroup/props", o);
          } else tally(base, o);
        });
      }
      return out;
    },
    shadowCfg() {
      const casters = [];
      let n = 0;
      scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.castShadow && o.visible) { n++; casters.push(labelOf(o)); } });
      const tallies = {};
      for (const c of casters) tallies[c] = (tallies[c] || 0) + 1;
      const lights = [];
      scene.traverse((o) => { if (o.isLight) lights.push({ type: o.type, castShadow: !!o.castShadow, visible: o.visible, map: o.shadow ? `${o.shadow.mapSize.x}x${o.shadow.mapSize.y}` : null }); });
      return { casterMeshes: n, byLabel: tallies, autoUpdate: gl.shadowMap.autoUpdate, needsUpdate: gl.shadowMap.needsUpdate, type: gl.shadowMap.type, lights: lights.filter((l) => l.castShadow || l.type === "DirectionalLight") , pointLights: lights.filter((l)=>l.type==="PointLight").length, pointVisible: lights.filter((l)=>l.type==="PointLight"&&l.visible).length };
    },
    sceneShape() {
      let objects = 0, meshes = 0, inst = 0, instances = 0, groups = 0, transparent = 0, sprites = 0, points = 0;
      scene.traverse((o) => {
        objects++;
        if (o.isInstancedMesh) { inst++; instances += o.count; meshes++; }
        else if (o.isMesh) meshes++;
        else if (o.isSprite) sprites++;
        else if (o.isPoints) points++;
        else if (o.type === "Group") groups++;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.transparent) transparent++;
      });
      // distinct materials + programs actually in the scene
      const mats = new Set(), geos = new Set(), texs = new Set();
      scene.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) { mats.add(m.uuid); if (m.map) texs.add(m.map.uuid); }
        if (o.geometry) geos.add(o.geometry.uuid);
      });
      return { objects, meshes, instancedMeshes: inst, instances, groups, transparent, sprites, points, distinctMaterials: mats.size, distinctGeometries: geos.size, distinctMapTextures: texs.size };
    },
  };
});

const shape = await page.evaluate(() => window.__census.sceneShape());
const shadow = await page.evaluate(() => window.__census.shadowCfg());
const cullA = await page.evaluate(() => window.__census.cullAudit());

// measure over N frames of live play
await page.evaluate(() => window.__census.reset());
await page.keyboard.down("w");
await page.waitForTimeout(1500);
await page.keyboard.up("w");
for (const k of ["Space", "q", "e"]) { await page.keyboard.press(k).catch(() => {}); }
await page.waitForTimeout(2500);
const dump = await page.evaluate(() => window.__census.dump());

console.log("=== SCENE SHAPE ===");
console.log(JSON.stringify(shape, null, 1));
console.log("=== SHADOW ===");
console.log(JSON.stringify(shadow, null, 1));
console.log("=== DRAW CALLS PER FRAME BY PHASE ===");
console.log(JSON.stringify(dump.byPhase, null, 1));
console.log("frames sampled:", dump.frames, "info.calls(last frame):", dump.info.calls, "tris:", dump.info.tris, "programs:", dump.info.programs);
console.log("=== DRAW CALLS PER FRAME BY CATEGORY (summed over all phases) ===");
for (const [l, c] of dump.labelRows) { if (c >= 0.4) console.log(String(c).padStart(7), " ", l); }
console.log("=== DRAW CALLS PER FRAME BY (PHASE, CATEGORY) ===");
for (const r of dump.rows) {
  if (r.callsPerFrame < 0.4) continue;
  console.log(String(r.callsPerFrame).padStart(7), String(r.trisPerFrame).padStart(9), " ", r.phase, " ", r.label);
}
console.log("=== FRUSTUM CULLING AUDIT (snapshot) ===");
const rows = Object.entries(cullA.groups).sort((a, b) => b[1].meshes - a[1].meshes);
for (const [k, v] of rows) {
  console.log(`${String(v.meshes).padStart(5)} meshes  ${String(v.drawn).padStart(5)} in-frustum  inst ${String(v.inst).padStart(6)} -> ${String(v.instIn).padStart(6)} in-frustum (${v.inst ? Math.round(100 * v.instIn / v.inst) : "-"}%)  ${k}`);
}
await browser.close();
