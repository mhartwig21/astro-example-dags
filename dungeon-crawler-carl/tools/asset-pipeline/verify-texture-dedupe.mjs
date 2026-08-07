/**
 * PROOF that texture deduplication changed no pixels.
 *
 * Screenshots of a live dungeon are weak evidence here: the beam phase, the
 * viewer counter and the collapse timer all move between runs, so a diff is
 * never zero and "looks the same" is a judgement call. But this change has a
 * property that admits a real proof — the image bytes were COPIED, not
 * re-encoded. So for every rewritten GLB we can take the image the file used to
 * embed (out of git, at HEAD) and check it is byte-identical to the /assets/tex
 * file the model now points at.
 *
 * Also asserts the referenced files exist and that every GLB still parses and
 * still declares the same number of images/materials/textures as before.
 */
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const parse = buf => {
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4), s = off + 8;
    if (t === 0x4e4f534a) json = JSON.parse(buf.slice(s, s + len).toString('utf8'));
    else if (t === 0x004e4942) bin = buf.slice(s, s + len);
    off = s + len; if (off % 4) off += 4 - (off % 4);
  }
  return { json, bin };
};
const regionOf = (g, bin, bvi) => {
  const bv = g.bufferViews[bvi];
  const mo = bv.extensions && bv.extensions.EXT_meshopt_compression;
  const off = mo ? (mo.byteOffset || 0) : (bv.byteOffset || 0);
  const len = mo ? mo.byteLength : bv.byteLength;
  return bin.slice(off, off + len);
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'public/assets'], { encoding: 'utf8' })
  .split('\n').filter(f => f.endsWith('.glb')).map(f => f.replace(/^dungeon-crawler-carl\//, ''));

let checked = 0, imagesProved = 0;
const fail = [];
for (const f of changed) {
  const oldBuf = execFileSync('git', ['show', `HEAD:./${f}`], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const newBuf = fs.readFileSync(f);
  const O = parse(oldBuf), N = parse(newBuf);

  if ((O.json.images || []).length !== (N.json.images || []).length) { fail.push(`${f}: image COUNT changed`); continue; }
  if ((O.json.materials || []).length !== (N.json.materials || []).length) { fail.push(`${f}: material count changed`); continue; }
  if ((O.json.textures || []).length !== (N.json.textures || []).length) { fail.push(`${f}: texture count changed`); continue; }
  if ((O.json.meshes || []).length !== (N.json.meshes || []).length) { fail.push(`${f}: mesh count changed`); continue; }
  if ((O.json.nodes || []).length !== (N.json.nodes || []).length) { fail.push(`${f}: node count changed`); continue; }
  if ((O.json.accessors || []).length !== (N.json.accessors || []).length) { fail.push(`${f}: accessor count changed`); continue; }

  // every image: same bytes, wherever they now live
  (O.json.images || []).forEach((oi, i) => {
    const ni = N.json.images[i];
    const oldBytes = oi.bufferView != null ? regionOf(O.json, O.bin, oi.bufferView) : null;
    if (!oldBytes) return;
    let newBytes;
    if (ni.bufferView != null) newBytes = regionOf(N.json, N.bin, ni.bufferView);
    else if (ni.uri && ni.uri.startsWith('../tex/')) {
      const p = path.join('public/assets/tex', ni.uri.slice('../tex/'.length));
      if (!fs.existsSync(p)) { fail.push(`${f}: image ${i} -> MISSING ${ni.uri}`); return; }
      newBytes = fs.readFileSync(p);
    } else { fail.push(`${f}: image ${i} has neither bufferView nor tex uri`); return; }
    if (sha(oldBytes) !== sha(newBytes)) fail.push(`${f}: image ${i} BYTES DIFFER`);
    else imagesProved++;
  });

  // every mesh accessor still resolves to the same bytes (geometry untouched)
  (O.json.accessors || []).forEach((oa, i) => {
    const na = N.json.accessors[i];
    if (oa.bufferView == null || na.bufferView == null) return;
    if (sha(regionOf(O.json, O.bin, oa.bufferView)) !== sha(regionOf(N.json, N.bin, na.bufferView)))
      fail.push(`${f}: accessor ${i} geometry bytes differ`);
  });
  checked++;
}

console.log(`GLBs rewritten and re-verified against HEAD: ${checked}`);
console.log(`embedded images proved byte-identical after externalisation: ${imagesProved}`);
console.log(`shared texture files on disk: ${fs.readdirSync('public/assets/tex').length}`);
// every tex file's name must equal 8 hex of its own sha256 (the cache contract)
for (const n of fs.readdirSync('public/assets/tex')) {
  const want = sha(fs.readFileSync(path.join('public/assets/tex', n))).slice(0, 8);
  if (n !== `t.${want}.webp`) fail.push(`tex/${n}: name does not match its content hash (want t.${want}.webp)`);
}
if (fail.length) { console.log(`\nFAILURES (${fail.length}):`); for (const f of fail.slice(0, 40)) console.log('  ' + f); process.exit(1); }
console.log('\nPASS — no image byte changed, no geometry byte changed, no count changed,');
console.log('       every /assets/tex file is named by its own content hash.');
