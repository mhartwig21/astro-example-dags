/**
 * TEXTURE DEDUPLICATION — props/environment asset round.
 *
 * The 240 zero-clip GLBs (dungeon props, environment, weapons, static
 * characters) embed 244 texture instances that are only 55 DISTINCT images:
 * one KayKit dungeon atlas is embedded 57 times, a cliff atlas 29 times, a
 * banner atlas 32. 76% of embedded texture bytes are byte-identical copies.
 *
 * Transport compression cannot see this. WebP is already compressed, and each
 * GLB is gzipped independently, so the duplicate copies are REAL wire cost.
 * The fix is to externalise the SHARED images to /assets/tex/ and let the HTTP
 * cache do the deduplication: 218 embedded copies become 29 downloads.
 *
 * Only images with 2+ users are externalised. Externalising a single-use image
 * would trade bytes-neutral for one extra round trip — strictly worse — so the
 * 26 single-use textures stay embedded exactly as they are.
 *
 * NAMING / URL CONTRACT (three constraints have to hold at once):
 *  - The URI must be RELATIVE. three's LoaderUtils.resolveURL does NOT special
 *    case a root-absolute path: it returns `path + url`, so "/assets/tex/x"
 *    loaded from /assets/dungeon/ would resolve to "/assets/dungeon//assets/
 *    tex/x" and 404. "../tex/x" resolves correctly, and both asset trees
 *    (dungeon/, characters/) sit at the same depth so one form serves both.
 *  - The filename carries 8 hex of its own sha256 (`t.<hash>.webp`), which
 *    makes it match gameServer's `selfDescribing` test and inherit
 *    `max-age=31536000, immutable` with no server change.
 *  - Because the name IS the content hash, vite.config.ts's asset-hashing
 *    plugin skips this tree — a second rename would break the relative URI
 *    baked into the GLB.
 *
 * Repacking is done by hand rather than through glTF-Transform because
 * node_modules here is a junction shared with sibling worktrees and must not
 * be mutated. The BIN chunk is rebuilt region by region: every bufferView that
 * addresses buffer 0 (directly, or via EXT_meshopt_compression's byteOffset
 * into it) is copied forward in original order with 4-byte alignment, minus
 * the dropped image regions. The EXT_meshopt_compression FALLBACK buffer
 * (buffer 1, no data) is left untouched.
 *
 * Usage: node tools/dedupe-textures.mjs [--apply]   (default is a dry run)
 */
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import zlib from 'node:zlib';

const APPLY = process.argv.includes('--apply');
const ROOT = 'public/assets';
const TEX_DIR = path.join(ROOT, 'tex');
const norm = p => p.split(path.sep).join('/');

function parseGlb(buf) {
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4), s = off + 8;
    if (t === 0x4e4f534a) json = JSON.parse(buf.slice(s, s + len).toString('utf8'));
    else if (t === 0x004e4942) bin = buf.slice(s, s + len);
    off = s + len; if (off % 4) off += 4 - (off % 4);
  }
  return { json, bin };
}
function writeGlb(json, bin) {
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  let bn = bin;
  if (bn.length % 4) bn = Buffer.concat([bn, Buffer.alloc(4 - (bn.length % 4), 0)]);
  const total = 12 + 8 + js.length + (bn.length ? 8 + bn.length : 0);
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii'); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
  if (bn.length) {
    const o = 20 + js.length;
    out.writeUInt32LE(bn.length, o); out.writeUInt32LE(0x004e4942, o + 4); bn.copy(out, o + 8);
  }
  return out;
}
/** Where a bufferView's bytes actually live inside the GLB BIN (buffer 0). */
function region(bv) {
  const mo = bv.extensions && bv.extensions.EXT_meshopt_compression;
  if (mo) return { start: mo.byteOffset || 0, len: mo.byteLength, set: o => { mo.byteOffset = o; } };
  if (bv.buffer === 0) return { start: bv.byteOffset || 0, len: bv.byteLength, set: o => { bv.byteOffset = o; } };
  return null; // addresses the meshopt fallback buffer; carries no real bytes
}

// ---------------------------------------------------------------- census
const files = [];
(function w(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'tex') w(p); }
    else if (e.name.endsWith('.glb')) files.push(norm(p));
  }
})(ROOT);

const shaOf = b => crypto.createHash('sha256').update(b).digest('hex');
const users = new Map(); // sha -> {bytes, mime, uses:[{file, imageIndex}]}
const parsed = new Map();
for (const f of files) {
  const buf = fs.readFileSync(f);
  const { json: g, bin } = parseGlb(buf);
  // The animated rigs are the sibling stream's class — never touch them.
  if ((g.animations || []).length > 0) continue;
  parsed.set(f, { g, bin, size: buf.length });
  (g.images || []).forEach((img, i) => {
    let slice, external = false;
    if (img.bufferView != null) {
      const r = region(g.bufferViews[img.bufferView]);
      slice = bin.slice(r.start, r.start + r.len);
    } else if (img.uri && img.uri.startsWith('../tex/')) {
      // Already externalised by a previous run. Counting these is what makes
      // the script idempotent — otherwise a second run sees no duplicates left
      // and would happily regenerate an EMPTY prewarm list.
      const p = path.join(TEX_DIR, img.uri.slice('../tex/'.length));
      if (!fs.existsSync(p)) throw new Error(`${f} references missing ${img.uri}`);
      slice = fs.readFileSync(p); external = true;
    } else return;
    const sha = shaOf(slice);
    // An externalised image carries no mimeType of its own, so recover it from
    // the extension. (Parenthesised deliberately: `a || b ? x : y` binds as
    // `(a || b) ? x : y`, which would relabel a PNG as WebP.)
    const mime = img.mimeType
      || (/\.webp$/.test(img.uri || '') ? 'image/webp'
        : /\.png$/.test(img.uri || '') ? 'image/png' : 'image/jpeg');
    if (!users.has(sha)) users.set(sha, { bytes: slice.length, mime, data: slice, uses: [] });
    users.get(sha).uses.push({ file: f, imageIndex: i, external });
  });
}

const shared = [...users.entries()].filter(([, v]) => v.uses.length >= 2)
  .sort((a, b) => b[1].bytes * (b[1].uses.length - 1) - a[1].bytes * (a[1].uses.length - 1));
const names = new Map(); // sha -> filename
for (const [sha, v] of shared) {
  const ext = v.mime === 'image/webp' ? 'webp' : v.mime === 'image/png' ? 'png' : 'jpg';
  const name = `t.${sha.slice(0, 8)}.${ext}`;
  for (const [o, n] of names) if (n === name && o !== sha) throw new Error(`hash collision on ${name}`);
  names.set(sha, name);
}

const kb = b => (b / 1024).toFixed(1) + 'KB';
const mb = b => (b / 1048576).toFixed(2) + 'MB';
console.log(`scanned ${files.length} GLBs; ${parsed.size} are zero-clip (in scope)`);
console.log(`distinct embedded images in scope: ${users.size}; shared by 2+ files: ${shared.length}`);
console.log(`externalising ${shared.length} images used ${shared.reduce((a, [, v]) => a + v.uses.length, 0)} times`);
console.log(`  duplicate bytes removed: ${mb(shared.reduce((a, [, v]) => a + v.bytes * (v.uses.length - 1), 0))}`);
console.log(`  new files on disk      : ${mb(shared.reduce((a, [, v]) => a + v.bytes, 0))} across ${shared.length} requests`);

// ------------------------------------------------------------- rewrite
const touched = new Map(); // file -> {before, after}
const byFile = new Map();
for (const [sha, v] of shared) for (const u of v.uses) {
  if (u.external) continue; // already points at /assets/tex/ — nothing to do
  if (!byFile.has(u.file)) byFile.set(u.file, []);
  byFile.get(u.file).push({ imageIndex: u.imageIndex, sha });
}

for (const [f, list] of byFile) {
  const { g, bin, size } = parsed.get(f);
  const dropBv = new Set(list.map(l => g.images[l.imageIndex].bufferView));

  // 1. rebuild BIN, dropping the externalised image regions
  const regions = [];
  g.bufferViews.forEach((bv, i) => {
    const r = region(bv);
    if (r) regions.push({ ...r, i });
  });
  regions.sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;
  for (const r of regions) {
    if (dropBv.has(r.i)) continue;
    if (cursor % 4) { const pad = 4 - (cursor % 4); chunks.push(Buffer.alloc(pad)); cursor += pad; }
    chunks.push(bin.slice(r.start, r.start + r.len));
    r.set(cursor);
    cursor += r.len;
  }
  const newBin = Buffer.concat(chunks);

  // 2. drop the bufferViews and remap every index that referenced one
  const remap = new Map();
  const kept = [];
  g.bufferViews.forEach((bv, i) => { if (!dropBv.has(i)) { remap.set(i, kept.length); kept.push(bv); } });
  g.bufferViews = kept;
  for (const a of g.accessors || []) if (a.bufferView != null) a.bufferView = remap.get(a.bufferView);
  for (const img of g.images || []) if (img.bufferView != null) img.bufferView = remap.get(img.bufferView);

  // 3. point the images at the shared file (relative — see header)
  for (const l of list) {
    const img = g.images[l.imageIndex];
    delete img.bufferView;
    img.uri = `../tex/${names.get(l.sha)}`;
  }

  g.buffers[0].byteLength = newBin.length;
  const out = writeGlb(g, newBin);
  touched.set(f, { before: size, after: out.length, buf: out });
}

const before = [...touched.values()].reduce((a, r) => a + r.before, 0);
const after = [...touched.values()].reduce((a, r) => a + r.after, 0);
console.log(`\n${touched.size} GLBs rewritten: ${mb(before)} -> ${mb(after)} raw (${mb(before - after)} removed)`);

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); process.exit(0); }

fs.mkdirSync(TEX_DIR, { recursive: true });
for (const [sha, v] of shared) fs.writeFileSync(path.join(TEX_DIR, names.get(sha)), v.data);
for (const [f, r] of touched) fs.writeFileSync(f, r.buf);

// The prewarm list, as a BUNDLED constant rather than a fetched manifest.
// Externalising alone made the boot WORSE, not better: all ~260 GLBs parse
// concurrently, so 218 texture requests were in flight before any response
// landed and the HTTP cache never got the chance to dedupe them (measured:
// +217 requests, +0.19 MB — a net loss). The loader now warms these few files
// first, so the 218 later requests are cache hits. Shipping the list inside the
// JS bundle keeps that from costing a manifest round trip of its own.
const listing = [...shared].sort((a, b) => names.get(a[0]) < names.get(b[0]) ? -1 : 1);
fs.writeFileSync('src/render3d/sharedTextures.ts',
  `// GENERATED by tools/dedupe-textures.mjs — do not edit by hand.\n` +
  `//\n` +
  `// Textures shared by 2+ GLBs, extracted to /assets/tex/ so the same atlas is\n` +
  `// downloaded once instead of once per prop (the dungeon atlas was embedded in\n` +
  `// 57 separate models). Named by 8 hex of their own sha256, so the name changes\n` +
  `// when the bytes do and the server can serve them immutable for a year.\n` +
  `//\n` +
  `// The loader prewarms these BEFORE the model wave — see startModelLoad().\n` +
  `export const SHARED_TEXTURES: readonly string[] = [\n` +
  listing.map(([sha, v]) => `  "/assets/tex/${names.get(sha)}", // ${(v.bytes / 1024).toFixed(1)} KB, ${v.uses.length} models`).join('\n') +
  `\n];\n`);

console.log(`\nWROTE ${shared.length} textures to ${norm(TEX_DIR)}/, ${touched.size} GLBs, and src/render3d/sharedTextures.ts.`);
for (const [sha, v] of shared.slice(0, 12))
  console.log(`  ${names.get(sha)}  ${kb(v.bytes).padStart(8)} x${String(v.uses.length).padStart(3)} users  (${v.mime})`);
