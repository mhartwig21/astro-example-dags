#!/usr/bin/env node
// Read-only GLB byte-attribution audit. Parses the GLB container directly so it
// reports ACTUAL on-disk bytes per bufferView (honouring EXT_meshopt_compression's
// compressed byteLength), then attributes each bufferView to animation / geometry /
// skin / image / other by walking who references it.
import fs from 'node:fs';
import path from 'node:path';

function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, binLen = 0;
  while (off < total && off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) binLen = len;
    off = start + len + ((4 - (len % 4)) % 4) * 0;
    off = start + len;
    if (off % 4) off += 4 - (off % 4);
  }
  return { json, binLen };
}

// actual stored size of a bufferView
function bvBytes(bv) {
  const mo = bv.extensions && bv.extensions.EXT_meshopt_compression;
  if (mo) return mo.byteLength; // compressed bytes actually stored
  return bv.byteLength;
}

export function audit(file) {
  const buf = fs.readFileSync(file);
  const { json: g } = parseGLB(buf);
  const bvs = g.bufferViews || [];
  const accs = g.accessors || [];
  const sizes = bvs.map(bvBytes);
  const owner = new Array(bvs.length).fill(null);
  const claim = (i, kind) => {
    if (i == null || i < 0 || i >= bvs.length) return;
    if (owner[i] == null) owner[i] = kind;
    else if (owner[i] !== kind) owner[i] = 'shared:' + owner[i] + '+' + kind;
  };
  const accBV = (ai) => (accs[ai] ? accs[ai].bufferView : null);

  // images
  for (const img of g.images || []) claim(img.bufferView, 'image');

  // animations
  let animAccessors = 0, animKeyframes = 0, animChannels = 0;
  const clips = [];
  for (const anim of g.animations || []) {
    let clipBytes = 0, kf = 0;
    const seen = new Set();
    for (const s of anim.samplers || []) {
      for (const ai of [s.input, s.output]) {
        const bi = accBV(ai);
        claim(bi, 'animation');
        if (!seen.has(ai)) { seen.add(ai); animAccessors++; }
      }
      if (accs[s.input]) kf = Math.max(kf, accs[s.input].count);
    }
    // per-clip byte estimate: sum of its accessors' bufferView slices
    for (const ai of seen) {
      const a = accs[ai];
      if (!a) continue;
      const bi = a.bufferView;
      if (bi == null) continue;
      // proportional share when accessors pack into one bufferView
      const compTypeSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] || 4;
      const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type] || 1;
      clipBytes += a.count * compTypeSize * numComp;
    }
    animChannels += (anim.channels || []).length;
    clips.push({ name: anim.name || '(unnamed)', channels: (anim.channels || []).length, keyframes: kf, rawBytes: clipBytes });
    animKeyframes += kf;
  }

  // meshes
  let vtx = 0, tri = 0;
  const attrPrecision = new Map();
  for (const mesh of g.meshes || []) {
    for (const p of mesh.primitives || []) {
      for (const [name, ai] of Object.entries(p.attributes || {})) {
        claim(accBV(ai), 'geometry');
        const a = accs[ai];
        if (a) {
          if (name === 'POSITION') vtx += a.count;
          const ct = { 5120: 'i8', 5121: 'u8', 5122: 'i16', 5123: 'u16', 5125: 'u32', 5126: 'f32' }[a.componentType];
          attrPrecision.set(name, `${ct}${a.normalized ? 'n' : ''}`);
        }
      }
      if (p.indices != null) {
        claim(accBV(p.indices), 'geometry');
        const a = accs[p.indices];
        if (a) tri += a.count / 3;
      }
      for (const t of p.targets || []) for (const ai of Object.values(t)) claim(accBV(ai), 'morph');
    }
  }
  for (const sk of g.skins || []) claim(accBV(sk.inverseBindMatrices), 'skin');

  const by = {};
  let unclaimed = 0;
  sizes.forEach((s, i) => {
    const k = owner[i] || 'unreferenced';
    if (!owner[i]) unclaimed += s;
    by[k] = (by[k] || 0) + s;
  });

  // textures
  const textures = (g.images || []).map((img, i) => ({
    mime: img.mimeType || (img.uri ? 'uri' : '?'),
    bytes: img.bufferView != null ? sizes[img.bufferView] : 0,
    name: img.name || `image${i}`,
  }));

  return {
    file, size: buf.length,
    generator: g.asset && g.asset.generator,
    extRequired: g.extensionsRequired || [],
    extUsed: g.extensionsUsed || [],
    nodes: (g.nodes || []).length,
    meshes: (g.meshes || []).length,
    materials: (g.materials || []).length,
    vertices: vtx, triangles: Math.round(tri),
    attrPrecision: Object.fromEntries(attrPrecision),
    animCount: (g.animations || []).length,
    animChannels, animAccessors,
    clips,
    textures,
    bytes: by,
    unclaimed,
    jsonBytes: buf.length - (g.buffers || []).reduce((s, b) => s + (b.byteLength || 0), 0),
  };
}

// CLI — only when invoked directly, never on import.
const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('glbaudit.mjs');
const args = isMain ? process.argv.slice(2) : [];
const mode = args[0] === '--clips' ? 'clips' : 'summary';
const files = (mode === 'clips' ? args.slice(1) : args);
const rows = [];
for (const f of files) {
  try {
    const r = audit(f);
    rows.push(r);
  } catch (e) { console.error('FAIL', f, e.message); }
}
if (mode === 'clips') {
  for (const r of rows) {
    console.log(`\n### ${r.file}  ${(r.size / 1048576).toFixed(2)} MB  ${r.animCount} clips`);
    for (const c of r.clips.slice().sort((a, b) => b.rawBytes - a.rawBytes))
      console.log(`  ${(c.rawBytes / 1024).toFixed(1).padStart(8)} KB  ch=${String(c.channels).padStart(3)}  kf=${String(c.keyframes).padStart(5)}  ${c.name}`);
  }
} else {
  console.log(JSON.stringify(rows, null, 1));
}
