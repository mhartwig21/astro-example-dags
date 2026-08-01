// Scene-cost census: walks the live scene graph and attributes draw calls and
// triangles to the subsystem that owns them, so "2.1M triangles a frame" can be
// split into floor / dressing / canopy / characters / FX.
//
// Runs against any build exposing window.__dcc (?debug=1). Identifies top-level
// groups by object reference against the Renderer3D fields where those survive
// minification, and falls back to structural labels otherwise.
//
// Usage: node tools/scenecensus.mjs "<url>"
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) { console.error("need a url"); process.exit(1); }

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(3000);
// Walk a little so streamed dressing and monsters are actually in the scene.
await page.keyboard.down("w"); await page.waitForTimeout(2500); await page.keyboard.up("w");

const census = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const scene = R.scene;
  // Name the top-level groups by identity where the field survives minify.
  const labels = new Map();
  for (const k of Object.keys(R)) {
    const v = R[k];
    if (v && v.isObject3D && v.parent === scene) labels.set(v, k);
    if (v && v.group && v.group.isObject3D && v.group.parent === scene) labels.set(v.group, k + ".group");
  }
  const triOf = (g) => {
    if (!g) return 0;
    const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    return idx / 3;
  };
  const rows = [];
  for (const child of scene.children) {
    let meshes = 0, instanced = 0, tris = 0, casters = 0, transparent = 0, visible = 0;
    child.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isSprite && !o.isLine) return;
      meshes++;
      if (o.visible) visible++;
      if (o.castShadow) casters++;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.transparent) transparent++;
      const per = triOf(o.geometry);
      if (o.isInstancedMesh) { instanced++; tris += per * o.count; } else tris += per;
    });
    if (meshes === 0) continue;
    rows.push({
      label: labels.get(child) || `${child.type}:${child.name || "-"}`,
      meshes, instancedMeshes: instanced, drawCallsApprox: meshes,
      tris: Math.round(tris), casters, transparent, visible,
    });
  }
  rows.sort((a, b) => b.tris - a.tris);
  const info = R.renderer.info;
  return {
    rows,
    totals: {
      meshes: rows.reduce((a, r) => a + r.meshes, 0),
      tris: rows.reduce((a, r) => a + r.tris, 0),
      casters: rows.reduce((a, r) => a + r.casters, 0),
      programs: info.programs.length,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    },
    lights: (() => {
      let dir = 0, point = 0, hemi = 0, amb = 0, shadowed = 0, visP = 0;
      scene.traverse((o) => {
        if (!o.isLight) return;
        if (o.isDirectionalLight) dir++;
        else if (o.isPointLight) { point++; if (o.visible) visP++; }
        else if (o.isHemisphereLight) hemi++;
        else if (o.isAmbientLight) amb++;
        if (o.castShadow) shadowed++;
      });
      return { dir, point, pointVisible: visP, hemi, amb, shadowed };
    })(),
    shadow: (() => {
      const k = R.key;
      return k ? { mapSize: `${k.shadow.mapSize.x}x${k.shadow.mapSize.y}`, autoUpdate: R.renderer.shadowMap.autoUpdate, type: R.renderer.shadowMap.type } : null;
    })(),
  };
});

console.log(JSON.stringify(census, null, 1));
await browser.close();
