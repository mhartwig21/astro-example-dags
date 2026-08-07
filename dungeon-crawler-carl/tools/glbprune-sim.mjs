// Rebuild a GLB keeping only the named animation clips: drop the others, remap
// the surviving accessors, repack the BIN, and report raw + gzip + brotli.
// Returns the new container in `.buf`; it never writes into public/ itself —
// tools/asset-pipeline/prune-character-clips.mjs owns that.
//
// READ THIS BEFORE TRUSTING ITS NUMBERS. This is stage ONE of two, and on its
// own it dramatically UNDERSTATES what pruning saves. It copies each surviving
// bufferView's bytes verbatim, and in these files one EXT_meshopt_compression
// bufferView carries MANY clips' data — so a view is kept whole if even one of
// its accessors survives, and the dropped clips' bytes stay in the file. On
// skeleton_warrior that reads as 530 KB -> 479 KB gzipped (-10%), which looks
// like "clip pruning is not worth it". It is: run the output through
// gltf-transform dedup + meshopt and the same keep-set lands at 396 KB (-25%),
// because the re-encode is what actually rebuilds the buffers. Any report
// generated from this module alone (e.g. tools/prune-report.mjs) is measuring
// the false floor, not the achievable saving.
import fs from 'node:fs'; import zlib from 'node:zlib';

function readGLB(buf) {
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4);
    const s = off + 8;
    if (t === 0x4e4f534a) json = JSON.parse(buf.slice(s, s + len).toString('utf8'));
    else if (t === 0x004e4942) bin = buf.slice(s, s + len);
    off = s + len; if (off % 4) off += 4 - (off % 4);
  }
  return { json, bin };
}
function writeGLB(json, bin) {
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  let b = bin;
  if (b.length % 4) b = Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
  const total = 12 + 8 + js.length + (b.length ? 8 + b.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  if (b.length) {
    const o = 20 + js.length;
    out.writeUInt32LE(b.length, o); out.writeUInt32LE(0x004e4942, o + 4); b.copy(out, o + 8);
  }
  return out;
}

export function prune(file, keepFn) {
  const orig = fs.readFileSync(file);
  const { json: g0, bin } = readGLB(orig);
  const g = JSON.parse(JSON.stringify(g0));
  const kept = (g.animations || []).filter(a => keepFn(a.name));
  const droppedNames = (g.animations || []).filter(a => !keepFn(a.name)).map(a => a.name);
  g.animations = kept;

  // mark live accessors
  const liveAcc = new Set();
  const useAcc = i => { if (i != null) liveAcc.add(i); };
  for (const a of kept) for (const s of a.samplers || []) { useAcc(s.input); useAcc(s.output); }
  for (const m of g.meshes || []) for (const p of m.primitives || []) {
    for (const ai of Object.values(p.attributes || {})) useAcc(ai);
    useAcc(p.indices);
    for (const t of p.targets || []) for (const ai of Object.values(t)) useAcc(ai);
  }
  for (const s of g.skins || []) useAcc(s.inverseBindMatrices);

  // remap accessors
  const accMap = new Map();
  const newAcc = [];
  (g.accessors || []).forEach((a, i) => { if (liveAcc.has(i)) { accMap.set(i, newAcc.length); newAcc.push(a); } });

  // live bufferViews (from surviving accessors + images)
  const liveBV = new Set();
  for (const a of newAcc) if (a.bufferView != null) liveBV.add(a.bufferView);
  for (const img of g.images || []) if (img.bufferView != null) liveBV.add(img.bufferView);

  // repack BIN: copy each live bufferView's real bytes
  const bvMap = new Map();
  const newBV = [];
  const chunks = [];
  let cursor = 0;
  (g.bufferViews || []).forEach((bv, i) => {
    if (!liveBV.has(i)) return;
    const mo = bv.extensions && bv.extensions.EXT_meshopt_compression;
    const src = mo ? { off: mo.byteOffset || 0, len: mo.byteLength } : { off: bv.byteOffset || 0, len: bv.byteLength };
    const slice = bin.slice(src.off, src.off + src.len);
    let pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    const nbv = JSON.parse(JSON.stringify(bv));
    if (mo) { nbv.extensions.EXT_meshopt_compression.byteOffset = cursor; nbv.extensions.EXT_meshopt_compression.buffer = 0; }
    else { nbv.byteOffset = cursor; nbv.buffer = 0; }
    chunks.push(slice); cursor += slice.length;
    bvMap.set(i, newBV.length); newBV.push(nbv);
  });
  const newBin = Buffer.concat(chunks);

  for (const a of newAcc) if (a.bufferView != null) a.bufferView = bvMap.get(a.bufferView);
  for (const img of g.images || []) if (img.bufferView != null) img.bufferView = bvMap.get(img.bufferView);
  for (const a of kept) for (const s of a.samplers || []) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
  for (const m of g.meshes || []) for (const p of m.primitives || []) {
    for (const k of Object.keys(p.attributes || {})) p.attributes[k] = accMap.get(p.attributes[k]);
    if (p.indices != null) p.indices = accMap.get(p.indices);
    for (const t of p.targets || []) for (const k of Object.keys(t)) t[k] = accMap.get(t[k]);
  }
  for (const s of g.skins || []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
  g.accessors = newAcc; g.bufferViews = newBV;

  // buffers: keep meshopt fallback buffer declaration consistent
  const fallbackIdx = (g.buffers || []).findIndex(b => b.extensions && b.extensions.EXT_meshopt_compression && b.extensions.EXT_meshopt_compression.fallback);
  g.buffers = [{ byteLength: newBin.length }];
  if (fallbackIdx >= 0) {
    // recompute fallback size = sum of uncompressed bufferView lengths for meshopt views
    let fb = 0;
    for (const bv of newBV) { const mo = bv.extensions && bv.extensions.EXT_meshopt_compression; if (mo) { let p = (4 - (fb % 4)) % 4; fb += p + bv.byteLength; } }
    g.buffers.push({ byteLength: Math.max(fb, 4), extensions: { EXT_meshopt_compression: { fallback: true } } });
    for (const bv of newBV) { const mo = bv.extensions && bv.extensions.EXT_meshopt_compression; if (mo) bv.buffer = 1; }
    // reassign fallback offsets
    let fo = 0;
    for (const bv of newBV) { const mo = bv.extensions && bv.extensions.EXT_meshopt_compression; if (mo) { let p = (4 - (fo % 4)) % 4; fo += p; bv.byteOffset = fo; fo += bv.byteLength; } }
  }

  const out = writeGLB(g, newBin);
  const gz = b => zlib.gzipSync(b, { level: 9 }).length;
  const br = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  return {
    file, before: orig.length, after: out.length,
    beforeGz: gz(orig), afterGz: gz(out), beforeBr: br(orig), afterBr: br(out),
    clipsBefore: (g0.animations || []).length, clipsAfter: kept.length,
    dropped: droppedNames, buf: out,
  };
}
