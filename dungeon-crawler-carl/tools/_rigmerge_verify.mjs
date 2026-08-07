// Numerical proof that mergeRigParts is pose-exact on the SHIPPED GLBs.
//
// For a set of random poses, CPU-skins every vertex of every original part and
// every vertex of the merged result, then compares the two point CLOUDS
// (each merged vertex must coincide with the original vertex it came from —
// merge order is preserved, so the comparison is index-aligned per part).
//
// Run: npx tsx tools/_rigmerge_verify.mjs
import { readFileSync, readdirSync } from "node:fs";
class FakeImg {
  constructor() { this.width = 1; this.height = 1; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
  set src(_v) {} get src() { return ""; }
  addEventListener(e, f) { if (e === "load") setTimeout(f, 0); }
  removeEventListener() {}
}
globalThis.Image = FakeImg;
globalThis.document = { createElementNS: () => new FakeImg(), createElement: () => new FakeImg() };
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeRigParts, dedupeSkeletons } from "../src/render3d/rigMerge.ts";
import { ATTACHMENT_NODES } from "../src/render3d/weaponry.ts";
const ARSENAL = new Set(Object.values(ATTACHMENT_NODES).flat());

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/** CPU replica of three.js skinning: W · Bm⁻¹ · Σ w_j (bone_j.mW · bi_j) · Bm · v */
function skinPoints(mesh) {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const si = geo.getAttribute("skinIndex");
  const sw = geo.getAttribute("skinWeight");
  const bindInv = new THREE.Matrix4().copy(mesh.bindMatrix).invert();
  const bm = [];
  for (let j = 0; j < mesh.skeleton.bones.length; j++) {
    bm.push(new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[j].matrixWorld, mesh.skeleton.boneInverses[j]));
  }
  const out = new Float64Array(pos.count * 3);
  const v = new THREE.Vector3(), acc = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.bindMatrix);
    acc.set(0, 0, 0);
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (w === 0) continue;
      const j = si.getComponent(i, c);
      t.copy(v).applyMatrix4(bm[j]).multiplyScalar(w);
      acc.add(t);
    }
    acc.applyMatrix4(bindInv).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = acc.x; out[i * 3 + 1] = acc.y; out[i * 3 + 2] = acc.z;
  }
  return out;
}

function poseRandomly(root, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  root.traverse((o) => {
    if (!o.isBone) return;
    o.rotation.set(rnd() * 1.6, rnd() * 1.6, rnd() * 1.6);
    o.position.x += rnd() * 0.05;
  });
  root.updateMatrixWorld(true);
}

const dir = "public/assets/characters";
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.endsWith(".glb")).map((f) => `${dir}/${f}`);

let worstAll = 0, merged = 0, examined = 0, skippedGroups = 0;
const rows = [];
for (const f of files) {
  const buf = readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let gltf;
  try { gltf = await new Promise((res, rej) => loader.parse(ab, "", res, rej)); }
  catch (e) { rows.push([f.split("/").pop(), "PARSE FAIL", e.message]); continue; }
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const before = [];
  scene.traverse((o) => { if (o.isSkinnedMesh && !ARSENAL.has(o.name)) before.push(o); });
  const kept = [];
  scene.traverse((o) => { if (o.isSkinnedMesh && ARSENAL.has(o.name)) kept.push(o.name); });
  if (before.length < 2) continue;
  examined++;

  // Capture per-part vertex counts + a stable order so we can index-align.
  const stats = mergeRigParts(scene, ARSENAL);
  skippedGroups += stats.skipped.length;
  const after = [];
  scene.traverse((o) => { if (o.isSkinnedMesh && !ARSENAL.has(o.name)) after.push(o); });
  const dedup = dedupeSkeletons(scene);
  if (stats.after === stats.before) {
    rows.push([f.split("/").pop(), `${stats.before} -> ${stats.after}`, "no merge", stats.skipped.join("; ")]);
    continue;
  }
  merged++;

  // Verify over 4 random poses: for each merged mesh, its vertices must equal
  // the concatenation of the source parts' skinned vertices, in order.
  let worst = 0;
  for (let p = 0; p < 4; p++) {
    poseRandomly(scene, 12345 + p * 977);
    const orig = new Map();
    for (const m of before) orig.set(m, skinPoints(m));
    for (const m of after) {
      if (!m.name.endsWith("_merged")) continue;
      const src = before.filter((b) => b.material === m.material && !b.parent);
      const got = skinPoints(m);
      let w = 0;
      for (const s of src) {
        const exp = orig.get(s);
        for (let k = 0; k < exp.length; k++) {
          worst = Math.max(worst, Math.abs(got[w + k] - exp[k]));
        }
        w += exp.length;
      }
      if (w !== got.length) { worst = Infinity; }
    }
  }
  worstAll = Math.max(worstAll, worst);
  rows.push([f.split("/").pop(), `${stats.before} -> ${stats.after}`, `maxErr=${worst.toExponential(2)}`, `dedupSkel=${dedup}`, kept.length ? `KEPT: ${kept.join(",")}` : "", stats.skipped.join("; ")]);
}

for (const r of rows) console.log(r.filter(Boolean).join("  |  "));
console.log(`\nmodels examined=${examined} merged=${merged} groupsSkipped=${skippedGroups}`);
console.log(`WORST POSITION ERROR ACROSS EVERY MERGED MODEL AND POSE: ${worstAll.toExponential(3)} world units`);
console.log(worstAll < 1e-4 ? "PASS" : "FAIL");
