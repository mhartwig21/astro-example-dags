import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { dedupeSkeletons, mergeRigParts } from "../src/render3d/rigMerge";

// ===========================================================================
// THE CONTRACT. mergeRigParts collapses a character's skinned parts into one
// mesh per material. It is allowed to do that ONLY when the result is
// pose-identical — for every pose, for every clip — and it must refuse
// (silently, leaving the loader's meshes alone) whenever it cannot prove that.
//
// The hard case, and the reason this file exists: the shipped GLBs are
// gltfpack output, so every primitive owns a SEPARATE skin whose
// inverseBindMatrices carry that primitive's dequantization. The parts look
// interchangeable and are not. `part()` below reproduces exactly that shape.
// ===========================================================================

/** Two bones in a chain, posed by the caller. */
function makeBones(): THREE.Bone[] {
  const root = new THREE.Bone();
  const tip = new THREE.Bone();
  tip.position.set(0, 1, 0);
  root.add(tip);
  return [root, tip];
}

/**
 * One skinned part in its OWN quantized space: the geometry is authored as if
 * pre-multiplied by q⁻¹, and the skin's boneInverses absorb q — which is what
 * gltfpack emits and what a naive merge gets wrong.
 */
function part(
  bones: THREE.Bone[],
  baseInverses: THREE.Matrix4[],
  q: THREE.Matrix4,
  pts: number[],
  material: THREE.Material,
  name: string,
): THREE.SkinnedMesh {
  const qi = q.clone().invert();
  const local = new Float32Array(pts.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 3) {
    v.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(qi);
    local[i] = v.x; local[i + 1] = v.y; local[i + 2] = v.z;
  }
  const n = pts.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(local, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.577), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Uint16Array(n * 2).fill(32768), 2, true));
  const si = new Uint8Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = 0; si[i * 4 + 1] = 1;
    sw[i * 4] = 0.35; sw[i * 4 + 1] = 0.65;
  }
  geo.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  const idx = new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const inverses = baseInverses.map((m) => m.clone().multiply(q));
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = name;
  // The bindMatrix argument is NOT optional here: three's SkinnedMesh.bind()
  // calls skeleton.calculateInverses() when it is omitted, which would throw
  // away the authored per-part inverses this fixture exists to reproduce.
  mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
  return mesh;
}

/** CPU replica of three.js skinning, in world space. */
function skin(mesh: THREE.SkinnedMesh): number[] {
  const pos = mesh.geometry.getAttribute("position");
  const si = mesh.geometry.getAttribute("skinIndex");
  const sw = mesh.geometry.getAttribute("skinWeight");
  const bindInv = mesh.bindMatrix.clone().invert();
  const bm = mesh.skeleton.bones.map((b, j) =>
    new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[j]));
  const out: number[] = [];
  const v = new THREE.Vector3(), acc = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.bindMatrix);
    acc.set(0, 0, 0);
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (w === 0) continue;
      t.copy(v).applyMatrix4(bm[si.getComponent(i, c)]).multiplyScalar(w);
      acc.add(t);
    }
    acc.applyMatrix4(bindInv).applyMatrix4(mesh.matrixWorld);
    out.push(acc.x, acc.y, acc.z);
  }
  return out;
}

function scaleTrans(s: number, x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeScale(s, s, s).setPosition(x, y, z);
}

function buildRig(qs: THREE.Matrix4[], mats: THREE.Material[]): {
  root: THREE.Object3D; bones: THREE.Bone[]; parts: THREE.SkinnedMesh[];
} {
  const bones = makeBones();
  const base = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0, -1, 0)];
  const root = new THREE.Object3D();
  root.add(bones[0]);
  const parts = qs.map((q, i) =>
    part(bones, base, q, [0.1 * i, 0.2, 0.3, -0.4, 0.5 + i, 0.6, 0.7, -0.8, 0.9 * (i + 1)],
      mats[i], `part${i}`));
  for (const p of parts) root.add(p);
  root.updateMatrixWorld(true);
  return { root, bones, parts };
}

function pose(bones: THREE.Bone[], root: THREE.Object3D, k: number): void {
  bones[0].rotation.set(0.3 * k, -0.7 * k, 0.2);
  bones[1].rotation.set(-0.5, 0.4 * k, 0.9 * k);
  bones[1].position.set(0.05 * k, 1 + 0.1 * k, -0.02 * k);
  root.updateMatrixWorld(true);
}

describe("mergeRigParts", () => {
  const mat = new THREE.MeshStandardMaterial();

  it("is pose-exact when the parts differ only by a per-part quantization", () => {
    const qs = [scaleTrans(1, 0, 0, 0), scaleTrans(1.0169, -1.09, -0.63, 0.004), scaleTrans(0.3066, -0.16, -0.99, 0)];
    // Capture the truth from the ORIGINAL parts, across four poses, first.
    const truth: number[][] = [];
    for (let k = 0; k < 4; k++) {
      const { root, bones, parts } = buildRig(qs, [mat, mat, mat]);
      pose(bones, root, k);
      truth.push(parts.flatMap((p) => skin(p)));
    }
    // Now the merged rig, posed identically.
    for (let k = 0; k < 4; k++) {
      const { root, bones } = buildRig(qs, [mat, mat, mat]);
      const stats = mergeRigParts(root);
      expect(stats.skipped).toEqual([]);
      expect(stats.before).toBe(3);
      expect(stats.after).toBe(1);
      pose(bones, root, k);
      const merged: THREE.SkinnedMesh[] = [];
      root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) merged.push(o as THREE.SkinnedMesh); });
      expect(merged).toHaveLength(1);
      const got = skin(merged[0]);
      expect(got).toHaveLength(truth[k].length);
      for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(truth[k][i], 6);
    }
  });

  it("keeps one mesh per material and never crosses a material boundary", () => {
    const other = new THREE.MeshStandardMaterial();
    const qs = [scaleTrans(1, 0, 0, 0), scaleTrans(1.2, 0.1, 0.2, 0.3), scaleTrans(0.7, -0.3, 0, 0.1), scaleTrans(0.9, 0, 0.4, 0)];
    const { root } = buildRig(qs, [mat, mat, other, other]);
    expect(mergeRigParts(root).after).toBe(2);
    const seen = new Set<string>();
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) seen.add((sm.material as THREE.Material).uuid);
    });
    expect(seen).toEqual(new Set([mat.uuid, other.uuid]));
  });

  it("leaves named arsenal nodes whole so they stay toggleable", () => {
    const qs = [scaleTrans(1, 0, 0, 0), scaleTrans(1.1, 0, 0.2, 0), scaleTrans(0.8, 0.1, 0, 0)];
    const { root } = buildRig(qs, [mat, mat, mat]);
    root.children.find((c) => c.name === "part2")!.name = "1H_Sword";
    mergeRigParts(root, new Set(["1H_Sword"]));
    const names: string[] = [];
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) names.push(o.name); });
    expect(names).toContain("1H_Sword");
    expect(names).toHaveLength(2); // the sword + one merged body
  });

  it("REFUSES when the per-part delta rotates (raw normals would be wrong)", () => {
    const rot = new THREE.Matrix4().makeRotationY(0.4);
    const { root } = buildRig([scaleTrans(1, 0, 0, 0), rot], [mat, mat]);
    const stats = mergeRigParts(root);
    expect(stats.after).toBe(2);
    expect(stats.skipped.join(" ")).toMatch(/rotates or shears/);
  });

  it("REFUSES when a part's skin delta is not one transform across joints", () => {
    const bones = makeBones();
    const base = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0, -1, 0)];
    const root = new THREE.Object3D();
    root.add(bones[0]);
    const a = part(bones, base, scaleTrans(1, 0, 0, 0), [0, 0, 0, 1, 1, 1, 2, 0, 1], mat, "a");
    const b = part(bones, base, scaleTrans(1.3, 0, 0, 0), [0, 1, 0, 1, 0, 1, 2, 1, 1], mat, "b");
    // Poison ONE joint's inverse: no single Q can describe this part any more.
    b.skeleton.boneInverses[1].multiply(new THREE.Matrix4().makeTranslation(0.3, 0, 0));
    root.add(a, b);
    root.updateMatrixWorld(true);
    const stats = mergeRigParts(root);
    expect(stats.after).toBe(2);
    expect(stats.skipped.join(" ")).toMatch(/not a single transform/);
  });

  it("REFUSES when the parts are skinned to different bones", () => {
    const { root, parts } = buildRig([scaleTrans(1, 0, 0, 0), scaleTrans(1.1, 0, 0, 0)], [mat, mat]);
    const stray = makeBones();
    parts[1].bind(new THREE.Skeleton(stray, parts[1].skeleton.boneInverses), parts[1].bindMatrix);
    root.updateMatrixWorld(true);
    const stats = mergeRigParts(root);
    expect(stats.after).toBe(2);
    expect(stats.skipped.join(" ")).toMatch(/different bones/);
  });

  it("preserves UV and skin-weight data verbatim through the merge", () => {
    const qs = [scaleTrans(1, 0, 0, 0), scaleTrans(1.4, 0.2, 0, 0)];
    const { root } = buildRig(qs, [mat, mat]);
    mergeRigParts(root);
    let merged: THREE.SkinnedMesh | null = null;
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) merged = o as THREE.SkinnedMesh; });
    const g = merged!.geometry;
    const uv = g.getAttribute("uv");
    expect(uv.normalized).toBe(true);
    expect((uv.array as Uint16Array)[0]).toBe(32768);
    const sw = g.getAttribute("skinWeight");
    for (let i = 0; i < sw.count; i++) {
      expect(sw.getComponent(i, 0) + sw.getComponent(i, 1)).toBeCloseTo(1, 6);
    }
    expect(g.index!.count).toBe(6);
  });
});

describe("dedupeSkeletons", () => {
  it("collapses interchangeable skeletons and leaves different ones alone", () => {
    const bones = makeBones();
    const base = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0, -1, 0)];
    const root = new THREE.Object3D();
    root.add(bones[0]);
    const mat = new THREE.MeshStandardMaterial();
    const a = part(bones, base, scaleTrans(1, 0, 0, 0), [0, 0, 0], mat, "a");
    const b = part(bones, base, scaleTrans(1, 0, 0, 0), [1, 0, 0], mat, "b"); // same inverses
    const c = part(bones, base, scaleTrans(1.7, 0, 0, 0), [2, 0, 0], mat, "c"); // different
    root.add(a, b, c);
    root.updateMatrixWorld(true);
    expect(dedupeSkeletons(root)).toBe(1);
    expect(b.skeleton).toBe(a.skeleton);
    expect(c.skeleton).not.toBe(a.skeleton);
  });
});
