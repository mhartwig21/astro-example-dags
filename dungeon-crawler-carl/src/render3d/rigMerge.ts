import * as THREE from "three";

/**
 * MERGE A CHARACTER GLB'S SKINNED BODY PARTS INTO ONE MESH PER MATERIAL.
 *
 * WHY. A KayKit character ships as 6-12 separate SkinnedMesh nodes
 * (Cleric_Body, Cleric_Head, Cleric_ArmLeft, ...) which almost all reference
 * the SAME material and the SAME 23 bones. Each one is a draw call in the
 * colour pass and another in the shadow pass, and each one carries its own
 * THREE.Skeleton — hence its own bone texture, re-uploaded every frame the
 * body is on screen. On the floor-10 fight the draw-call census measured
 * ~231 monster draws from 24 drawn rigs (9-14 parts each) plus ~216 bone
 * texture uploads per frame. Both numbers are structural, not artistic: the
 * split exists because the artist modelled limbs separately, and nothing
 * downstream ever addresses a limb on its own.
 *
 * WHY IT ISN'T TRIVIAL. The shipped GLBs are gltfpack output with
 * KHR_mesh_quantization, and gltfpack gives every primitive its OWN skin whose
 * inverseBindMatrices carry that primitive's dequantization transform. So the
 * seven "identical" skins are not identical: they differ by a per-part
 * similarity matrix. Merging naively — which is what "just call
 * mergeGeometries" would do — reproduces the pose of exactly one part and
 * scatters the rest across the arena.
 *
 * THE MATH, AND WHY IT IS EXACT. three.js skins a vertex as
 *
 *     P(v) = W · Bm⁻¹ · Σ_j w_j · (bone_j.matrixWorld · bi[j]) · Bm · v
 *
 * with W = matrixWorld, Bm = bindMatrix, bi = skeleton.boneInverses. Take one
 * part as the reference (ref) and define, for every other part p,
 *
 *     Q_p := bi_ref[j]⁻¹ · bi_p[j]
 *
 * If Q_p is the SAME for every joint j — which is exactly what "the two skins
 * differ only by a dequantization" means, and which this code VERIFIES rather
 * than assumes — and if W·Bm⁻¹ agrees across the parts, then rewriting the
 * part's vertices as
 *
 *     v' = Bm_ref⁻¹ · Q_p · Bm_p · v
 *
 * and skinning them with the reference skeleton reproduces P(v) identically,
 * for every pose, for every clip. Measured on the shipped cast: Q_p is
 * joint-independent to ~2e-7 (float32 noise) and is always a pure uniform
 * scale + translation.
 *
 * WHAT IT REFUSES TO DO. Every precondition is checked and any group that
 * fails one is left exactly as the loader built it: mismatched attribute sets,
 * a non-uniform or rotating Q, a joint-dependent Q, differing bone arrays,
 * morph targets, multi-material meshes. A model that cannot be merged loses
 * nothing. Normals, UVs, skin indices and skin weights are copied RAW, bit for
 * bit, in their original quantized types — legal precisely because Q is a
 * uniform scale (directions and topology are untouched); only positions are
 * rewritten, and they widen to float32, which is strictly more precise than
 * the int16 grid they came from.
 *
 * WHAT IT MUST NOT BE POINTED AT. Models whose individual mesh nodes are
 * addressed by name and toggled — the hero and the armory GLBs, whose weapon
 * and shield nodes ATTACHMENT_NODES turns on and off, and which donate those
 * nodes as grafts to other rigs. The caller owns that policy (see assets.ts).
 * Bones are never touched, so every handslot graft and every clip still binds.
 */

/** Tolerance for the similarity/joint-independence checks (float32 noise). */
const EPS = 1e-4;

export interface RigMergeStats {
  /** Skinned meshes before. */
  before: number;
  /** Skinned meshes after. */
  after: number;
  /** Human-readable reasons a group was left alone (empty when all merged). */
  skipped: string[];
}

interface Part {
  mesh: THREE.SkinnedMesh;
  geo: THREE.BufferGeometry;
}

/** Raw (un-denormalized) component read that works for interleaved attributes. */
function rawComponent(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, c: number): number {
  const il = attr as THREE.InterleavedBufferAttribute;
  if (il.isInterleavedBufferAttribute) return il.data.array[il.offset + i * il.data.stride + c];
  return (attr as THREE.BufferAttribute).array[i * attr.itemSize + c];
}

/** Copy an attribute verbatim into a fresh, non-interleaved buffer of the same type. */
function copyRaw(
  parts: Part[],
  name: string,
  total: number,
): THREE.BufferAttribute {
  const first = parts[0].geo.getAttribute(name);
  const itemSize = first.itemSize;
  const Ctor = (first as THREE.BufferAttribute).array.constructor as
    { new (n: number): THREE.TypedArray };
  const out = new Ctor(total * itemSize);
  let w = 0;
  for (const p of parts) {
    const a = p.geo.getAttribute(name);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < itemSize; c++) out[w++] = rawComponent(a, i, c);
    }
  }
  return new THREE.BufferAttribute(out, itemSize, first.normalized);
}

/** Positions: denormalize, transform by the part's rewrite matrix, widen to float32. */
function buildPositions(parts: Part[], mats: THREE.Matrix4[], total: number): THREE.BufferAttribute {
  const out = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  let w = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const a = parts[pi].geo.getAttribute("position");
    const m = mats[pi];
    for (let i = 0; i < a.count; i++) {
      v.set(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(m);
      out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
    }
  }
  return new THREE.BufferAttribute(out, 3);
}

/** True when the matrix's upper 3x3 is a positive uniform scale (no rotation, no shear). */
function isUniformScale(m: THREE.Matrix4): boolean {
  const e = m.elements;
  const s = e[0];
  if (!(s > 1e-6)) return false;
  const want = [s, 0, 0, 0, s, 0, 0, 0, s];
  const got = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
  for (let i = 0; i < 9; i++) if (Math.abs(got[i] - want[i]) > EPS * Math.max(1, s)) return false;
  return true;
}

function matNear(a: THREE.Matrix4, b: THREE.Matrix4, eps = EPS): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > eps) return false;
  return true;
}

/** Attribute signature: merging requires an exact match across the group. */
function attrSig(geo: THREE.BufferGeometry): string {
  return Object.keys(geo.attributes).sort().map((k) => {
    const a = geo.getAttribute(k);
    return `${k}:${(a as THREE.BufferAttribute).array.constructor.name}:${a.itemSize}:${a.normalized ? 1 : 0}`;
  }).join("|");
}

/**
 * @param keepNames Mesh nodes that must survive as their own objects because
 *   something addresses them by name — the arsenal nodes ATTACHMENT_NODES
 *   toggles and donates as grafts. A merged body that swallowed `1H_Sword`
 *   would vanish the moment `hideAllAttachments` hid it.
 */
export function mergeRigParts(root: THREE.Object3D, keepNames?: ReadonlySet<string>): RigMergeStats {
  root.updateMatrixWorld(true);

  const all: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton || Array.isArray(sm.material)) return;
    if (keepNames?.has(sm.name)) return;
    all.push(sm);
  });
  const stats: RigMergeStats = { before: all.length, after: all.length, skipped: [] };
  if (all.length < 2) return stats;

  // The whole rig is rewritten into ONE skeleton's space, not one per material
  // group, so a body + its glass/glow shell end up sharing bone matrices.
  const ref = all[0];
  const refBones = ref.skeleton.bones;
  const refBindInv = new THREE.Matrix4().copy(ref.bindMatrix).invert();
  const refA = new THREE.Matrix4().copy(ref.matrixWorld).multiply(refBindInv);

  // Group by material identity + the flags that would make two draws differ.
  const groups = new Map<string, THREE.SkinnedMesh[]>();
  for (const m of all) {
    const mat = m.material as THREE.Material;
    const key = `${mat.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}${m.visible ? 1 : 0}|${m.renderOrder}|${m.frustumCulled ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g.push(m); else groups.set(key, [m]);
  }

  const q = new THREE.Matrix4();
  const q0 = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const why = (r: string): void => { stats.skipped.push(`${group[0].name || "?"}(x${group.length}): ${r}`); };

    // BLENDED GEOMETRY IS NEVER MERGED. Merging is pixel-exact for opaque
    // surfaces — same fragments, same depth, one draw — but for transparent
    // ones it dissolves the per-object painter's sort the renderer relies on,
    // which is the classic way a batching change quietly changes what you see.
    // The shipped cast pays nothing for this rule: every BLEND material in the
    // character GLBs (the clerics' holy water, the lorekeeper's lenses, the
    // marksman's face net) is a single part, so there was never a group here
    // to merge. Kept as a hard refusal so a future asset cannot smuggle one in.
    if ((group[0].material as THREE.Material).transparent) { why("transparent material"); continue; }

    // ---- preconditions -----------------------------------------------------
    const sig = attrSig(group[0].geometry);
    let ok = true;
    const rewrite: THREE.Matrix4[] = [];
    for (const m of group) {
      const geo = m.geometry;
      if (attrSig(geo) !== sig) { why("attribute sets differ"); ok = false; break; }
      if (!geo.getAttribute("position") || !geo.index) { why("no position or not indexed"); ok = false; break; }
      if (geo.morphAttributes && Object.keys(geo.morphAttributes).length) { why("morph targets"); ok = false; break; }
      const bones = m.skeleton.bones;
      if (bones.length !== refBones.length || bones.some((b, i) => b !== refBones[i])) {
        why("skeleton binds different bones"); ok = false; break;
      }
      // Q must be the same for every joint...
      let qOk = true;
      for (let j = 0; j < bones.length; j++) {
        q.copy(ref.skeleton.boneInverses[j]).invert().multiply(m.skeleton.boneInverses[j]);
        if (j === 0) q0.copy(q);
        else if (!matNear(q, q0, 1e-3)) { qOk = false; break; }
      }
      if (!qOk) { why("per-joint skin delta is not a single transform"); ok = false; break; }
      // ...a pure uniform scale (so raw normals/tangents stay valid)...
      if (!isUniformScale(q0)) { why("skin delta rotates or shears"); ok = false; break; }
      // ...and the part must sit in the reference's world/bind frame.
      tmp.copy(m.matrixWorld).multiply(new THREE.Matrix4().copy(m.bindMatrix).invert());
      if (!matNear(tmp, refA)) { why("world/bind frame differs from the reference"); ok = false; break; }
      // v' = Bm_ref⁻¹ · Q · Bm_p
      rewrite.push(new THREE.Matrix4().copy(refBindInv).multiply(q0).multiply(m.bindMatrix));
    }
    if (!ok) continue;

    // ---- build the merged geometry ----------------------------------------
    const parts: Part[] = group.map((m) => ({ mesh: m, geo: m.geometry }));
    let total = 0;
    let idxTotal = 0;
    for (const p of parts) { total += p.geo.getAttribute("position").count; idxTotal += p.geo.index!.count; }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", buildPositions(parts, rewrite, total));
    for (const name of Object.keys(parts[0].geo.attributes)) {
      if (name === "position") continue;
      merged.setAttribute(name, copyRaw(parts, name, total));
    }
    const IdxCtor = total > 65535 ? Uint32Array : Uint16Array;
    const idx = new IdxCtor(idxTotal);
    let iw = 0;
    let base = 0;
    for (const p of parts) {
      const src = p.geo.index!;
      for (let i = 0; i < src.count; i++) idx[iw++] = src.getX(i) + base;
      base += p.geo.getAttribute("position").count;
    }
    merged.setIndex(new THREE.BufferAttribute(idx, 1));
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    // ---- swap it in --------------------------------------------------------
    const first = group[0];
    const out = new THREE.SkinnedMesh(merged, first.material as THREE.Material);
    out.name = `${first.name}_merged`;
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.renderOrder = first.renderOrder;
    out.frustumCulled = first.frustumCulled;
    out.visible = first.visible;
    out.position.copy(first.position);
    out.quaternion.copy(first.quaternion);
    out.scale.copy(first.scale);
    out.userData = { ...first.userData };
    out.bindMode = ref.bindMode;
    out.bind(ref.skeleton, ref.bindMatrix);
    first.parent?.add(out);
    for (const m of group) m.parent?.remove(m);
    stats.after -= group.length - 1;
  }
  return stats;
}

/**
 * COLLAPSE DUPLICATE SKELETONS INSIDE ONE CLONED RIG.
 *
 * SkeletonUtils.clone mints a fresh THREE.Skeleton per SkinnedMesh even when
 * the source meshes shared one, and three.js gives every Skeleton its own
 * bone texture that it re-uploads each frame the body renders. After
 * mergeRigParts a body is 2-3 meshes over the same bones with the same
 * inverses, so the clone's skeletons are interchangeable by construction —
 * verified here element by element rather than assumed. Sharing them is
 * mathematically identical (Skeleton.update is a pure function of bones and
 * boneInverses) and the renderer only updates a shared skeleton once per
 * frame, so it removes both the duplicate upload and the duplicate texture.
 */
export function dedupeSkeletons(root: THREE.Object3D): number {
  const seen: THREE.SkinnedMesh[] = [];
  let saved = 0;
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton) return;
    for (const other of seen) {
      const a = sm.skeleton, b = other.skeleton;
      if (a === b) return;
      if (a.bones.length !== b.bones.length) continue;
      if (a.bones.some((bone, i) => bone !== b.bones[i])) continue;
      if (!sm.bindMatrix.equals(other.bindMatrix)) continue;
      if (a.boneInverses.some((mi, i) => !matNear(mi, b.boneInverses[i], 1e-6))) continue;
      sm.bind(b, other.bindMatrix);
      saved++;
      return;
    }
    seen.push(sm);
  });
  return saved;
}
