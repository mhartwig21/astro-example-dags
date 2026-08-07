// ENVIRONMENT batching probe (batch:environment round).
// Question: how many of the 49 propBatches colour draws are separated by a REAL
// material difference vs by a per-prop TINT that could ride an instanceColor?
// Also: do any prop geometries carry a `color` attribute (which would make
// material.vertexColors=true a visible change rather than a no-op)?
//
// Serve dist/ with the SHIPPING server on 5288 first. vite preview is banned.
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";

const PORT = 5288;
const URL_B = `http://localhost:${PORT}/iso.html?test&floor=10&level=14&abilities=all&gold=500&seed=42&debug=1`;
const URL_C = `http://localhost:${PORT}/iso.html?test&floor=4&seed=42&debug=1`;

const distHtml = readFileSync(new URL("../dist/iso.html", import.meta.url), "utf8");
const wantBundle = (distHtml.match(/iso-[A-Za-z0-9_-]+\.js/) || [])[0];
const servedHtml = await (await fetch(`http://localhost:${PORT}/iso.html`)).text();
const gotBundle = (servedHtml.match(/iso-[A-Za-z0-9_-]+\.js/) || [])[0];
if (gotBundle !== wantBundle) throw new Error(`FINGERPRINT MISMATCH served=${gotBundle} dist=${wantBundle}`);
const glbHead = await fetch(`http://localhost:${PORT}/assets/characters/adventurer.glb`, { headers: { "accept-encoding": "gzip" } });
if (glbHead.headers.get("content-encoding") !== "gzip") throw new Error("not the shipping server");
console.log(`[fp] bundle=${wantBundle} glb gzip ok`);

async function waitPlayable(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("#loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
  }, undefined, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, undefined, { timeout: 60000 });
}

const SNAP = () => {
  const R = window.__dcc.renderer;
  const sig = (m) => {
    const t = (x) => (x ? x.uuid : "-");
    return [
      m.type, m.transparent ? 1 : 0, m.opacity, m.alphaTest, m.side, m.depthWrite ? 1 : 0,
      m.depthTest ? 1 : 0, m.blending, m.roughness, m.metalness,
      m.emissive ? m.emissive.getHexString() : "-", m.emissiveIntensity,
      m.flatShading ? 1 : 0, m.vertexColors ? 1 : 0, m.toneMapped ? 1 : 0,
      m.wireframe ? 1 : 0, m.envMapIntensity, m.aoMapIntensity, m.normalScale ? `${m.normalScale.x},${m.normalScale.y}` : "-",
      t(m.map), t(m.normalMap), t(m.emissiveMap), t(m.alphaMap), t(m.aoMap),
      t(m.roughnessMap), t(m.metalnessMap), t(m.lightMap), t(m.bumpMap), t(m.displacementMap),
      m.customProgramCacheKey ? m.customProgramCacheKey() : "-",
      // shader-stage identity: worldLit's onBeforeCompile closes over dim/det.
      // Compare the function OBJECT and the source text; different closures of
      // the same source are flagged separately below.
      m.onBeforeCompile ? m.onBeforeCompile.toString().length : 0,
    ].join("|");
  };

  // ---- prop batches ----
  const batches = (R.propBatches || []).map((b) => {
    const im = b.mesh, m = im.material, g = im.geometry;
    return {
      name: im.name, geo: g.uuid, mat: m.uuid,
      hasColorAttr: !!g.attributes.color,
      hasUv1: !!g.attributes.uv1,
      color: m.color ? m.color.getHexString() : "-",
      colorLin: m.color ? [m.color.r, m.color.g, m.color.b] : null,
      sigNoColor: sig(m),
      cs: im.castShadow ? 1 : 0, rs: im.receiveShadow ? 1 : 0, ro: im.renderOrder,
      cap: im.instanceMatrix.count, count: im.count,
      obc: m.onBeforeCompile ? 1 : 0,
      mapName: m.map ? (m.map.name || "") : "",
    };
  });

  const groupsNow = new Set(batches.map((b) => `${b.geo}|${b.mat}|${b.cs}${b.rs}|${b.ro}`)).size;
  const groupsDedupTint = new Set(batches.map((b) => `${b.geo}|${b.sigNoColor}|${b.cs}${b.rs}|${b.ro}`)).size;
  const groupsDedupAll = new Set(batches.map((b) => `${b.geo}|${b.sigNoColor}|${b.color}|${b.cs}${b.rs}|${b.ro}`)).size;

  // Do the batches that would merge differ ONLY by color? report per group.
  const byTintGroup = new Map();
  for (const b of batches) {
    const k = `${b.geo}|${b.sigNoColor}|${b.cs}${b.rs}|${b.ro}`;
    let e = byTintGroup.get(k);
    if (!e) { e = { n: 0, colors: new Set(), cap: 0, count: 0, map: b.mapName, obc: new Set() }; byTintGroup.set(k, e); }
    e.n++; e.colors.add(b.color); e.cap += b.cap; e.count += b.count; e.obc.add(b.obc);
  }
  const tintGroups = [...byTintGroup.entries()].map(([k, e]) => ({
    batches: e.n, distinctColors: e.colors.size, colors: [...e.colors], cap: e.cap, live: e.count, map: e.map,
  })).sort((a, b) => b.batches - a.batches);

  // ---- unbatched prop leaves (would they clear PROP_BATCH_MIN after regroup?) ----
  const leaves = [];
  const colorAttrGeos = new Set();
  let propMeshes = 0;
  for (const e of R.propEntries || []) {
    e.obj.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return;
      propMeshes++;
      const m = Array.isArray(o.material) ? null : o.material;
      const g = o.geometry;
      if (g.attributes.color) colorAttrGeos.add(g.uuid);
      if (!m || m.transparent) return;
      leaves.push({
        geo: g.uuid, mat: m.uuid, color: m.color ? m.color.getHexString() : "-",
        sigNoColor: sig(m), cs: o.castShadow ? 1 : 0, rs: o.receiveShadow ? 1 : 0, ro: o.renderOrder,
        batched: !!(e.leaves || []).find((l) => l.mesh === o),
      });
    });
  }
  const countKeys = (rows, keyFn) => {
    const c = new Map();
    for (const r of rows) c.set(keyFn(r), (c.get(keyFn(r)) || 0) + 1);
    return c;
  };
  const MIN = 4;
  const kNow = countKeys(leaves, (r) => `${r.geo}|${r.mat}|${r.cs}${r.rs}|${r.ro}`);
  const kNew = countKeys(leaves, (r) => `${r.geo}|${r.sigNoColor}|${r.cs}${r.rs}|${r.ro}`);
  const batchedNow = [...kNow.values()].filter((v) => v >= MIN);
  const batchedNew = [...kNew.values()].filter((v) => v >= MIN);

  // ---- floorGroup instanced chunk census ----
  const chunks = new Map();
  let fgInst = 0, fgInstances = 0, fgOther = 0;
  R.floorGroup.traverse((o) => {
    if (o.isInstancedMesh) {
      if (o.name.startsWith("propbatch:")) return;
      fgInst++; fgInstances += o.count;
      const k = `${o.geometry.uuid}|${o.material.uuid}`;
      chunks.set(k, (chunks.get(k) || 0) + 1);
    } else if (o.isMesh || o.isSprite) fgOther++;
  });

  return {
    propBatchCount: batches.length,
    groupsNow, groupsDedupTint, groupsDedupAll,
    tintGroups,
    anyBatchGeoHasColorAttr: batches.some((b) => b.hasColorAttr),
    propGeosWithColorAttr: colorAttrGeos.size,
    propMeshes,
    unbatchedLeaves: leaves.filter((l) => !l.batched).length,
    keysNow: kNow.size, keysNew: kNew.size,
    meshesBatchedNow: batchedNow.reduce((a, b) => a + b, 0), batchesNow: batchedNow.length,
    meshesBatchedNew: batchedNew.reduce((a, b) => a + b, 0), batchesNew: batchedNew.length,
    floorGroup: { instancedMeshes: fgInst, instances: fgInstances, otherMeshes: fgOther, geoMatFamilies: chunks.size, chunksPerFamily: [...chunks.values()].sort((a, b) => b - a) },
    batches: batches.slice(0, 60),
  };
};

const browser = await chromium.launch({ headless: true, args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--dcc-envprobe-5288"] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const out = { bundle: wantBundle };
try {
  for (const [id, url] of [["floor10", URL_B], ["floor4", URL_C]]) {
    await page.goto(url, { waitUntil: "load", timeout: 180000 });
    await waitPlayable(page);
    await page.waitForTimeout(2500);
    out[id] = await page.evaluate(SNAP);
    const r = out[id];
    console.log(`[env] ${id}: propBatches=${r.propBatchCount} groupsNow=${r.groupsNow} dedupTint=${r.groupsDedupTint} dedupAll=${r.groupsDedupAll} colorAttrGeos=${r.propGeosWithColorAttr} unbatchedLeaves=${r.unbatchedLeaves} batchesNow=${r.batchesNow}(${r.meshesBatchedNow} meshes) batchesNew=${r.batchesNew}(${r.meshesBatchedNew} meshes) fgInst=${r.floorGroup.instancedMeshes}/${r.floorGroup.geoMatFamilies} fam`);
  }
} finally {
  await browser.close();
}
writeFileSync(new URL("./_envprobe.out.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("[env] DONE -> tools/_envprobe.out.json");
