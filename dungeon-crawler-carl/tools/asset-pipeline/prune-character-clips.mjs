// Drop unreachable animation clips from the rigged character GLBs, then let
// glTF-Transform reclaim the space for real.
//
// WHY THIS EXISTS. A 2.5 MB KayKit character is ~94% animation: 95 clips, of
// which the host's animator can address at most 70 and typically plays 30. It
// ships the full rig library — bow draws, reload cycles, fishing, lockpicking —
// on a melee skeleton that can never play any of them.
//
// THE TRAP THAT MADE AN EARLIER PASS GIVE UP. Simply rewriting the container
// without the dropped animations saves almost nothing on the wire (~8%
// gzipped), which reads as "clip pruning isn't worth it". It is not: in these
// files a single EXT_meshopt_compression bufferView carries MANY clips' data,
// so dropping a clip's accessor leaves every byte of the shared view behind.
// The bytes only leave when the asset is decoded and RE-ENCODED, which is what
// the dedup + meshopt passes below do. Measured on skeleton_warrior:
//   drop clips only ............ 530 KB -> 479 KB gz   (-10%, the false floor)
//   drop clips + dedup + meshopt 530 KB -> 396 KB gz   (-25%, the real number)
// If you ever "optimise" this script by skipping the re-encode, you will
// silently give back three quarters of the win.
//
// SAFETY: the keep-set (clip-keepset.mjs) keeps every clip matching ANY regex
// in ANY of the three host consumers, so pick()'s answers cannot drift. This
// script refuses to write if driftCheck finds anything, if a clip the runtime
// census recorded would be dropped, or if the re-encode changes the vertex
// count, the extension set, or the texture payload.
//
// TOOLING: gltf-transform is NOT a project dependency (node_modules here is a
// junction shared with sibling worktrees — never npm install). It runs via
// npx, which caches outside the project.
//
// Usage:  node tools/asset-pipeline/prune-character-clips.mjs [--apply]
//         (default is a dry run into tools/_prunestage/)
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import zlib from 'node:zlib'; import { execFileSync } from 'node:child_process';
import { audit } from '../glbaudit.mjs';
import { prune as dropClips } from '../glbprune-sim.mjs';
import { keepFilter, driftCheck, consumerRegexes } from './clip-keepset.mjs';

const ROOT = 'public/assets/characters';
const STAGE = 'tools/_prunestage';
const APPLY = process.argv.includes('--apply');
const CLI = ['--yes', '@gltf-transform/cli@4.4.2'];

// Warm the npx cache once through the shell (the .cmd shim can't be execFile'd
// on Node 24), then drive the CLI's own entry point with plain `node` — two
// spawns per file, 50 npx bootstraps is minutes of pure overhead.
function resolveCLI() {
  execFileSync(`npx ${CLI.join(' ')} --version`, { stdio: 'pipe', shell: true });
  const root = path.join(os.homedir(), 'AppData/Local/npm-cache/_npx');
  const homes = process.platform === 'win32' ? [root] : [path.join(os.homedir(), '.npm/_npx')];
  for (const h of homes) {
    if (!fs.existsSync(h)) continue;
    for (const d of fs.readdirSync(h)) {
      const p = path.join(h, d, 'node_modules/@gltf-transform/cli/bin/cli.js');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('could not locate @gltf-transform/cli in the npx cache');
}
const CLI_JS = resolveCLI();
const gt = (...args) => execFileSync(process.execPath, [CLI_JS, ...args], { stdio: 'pipe' });
const gz = (b) => zlib.gzipSync(b, { level: 9 }).length;
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const mb = (b) => (b / 1048576).toFixed(2) + 'MB';

// Every clip name the instrumented playthrough actually bound or played.
// Anything here that the keep rule would drop is a hard stop.
const censusNames = (() => {
  const s = new Set();
  try {
    const c = JSON.parse(fs.readFileSync('tools/_census.json', 'utf8'));
    for (const k of [...Object.keys(c.bound), ...Object.keys(c.played)]) s.add(k.split('=').slice(1).join('='));
  } catch { console.warn('! tools/_census.json missing — census cross-check skipped'); }
  s.delete('MISSING');
  return s;
})();

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name).split(path.sep).join('/');
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.glb')) files.push(p);
  }
})(ROOT);

const keep = keepFilter();
console.log(`${consumerRegexes().length} host regexes parsed; census pins ${censusNames.size} clip names`);
{
  const uncovered = [...censusNames].filter((n) => !keep(n));
  if (uncovered.length) { console.error('ABORT: census clips the keep rule would drop:', uncovered); process.exit(1); }
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipprune-'));

const T = { rawB: 0, rawA: 0, gzB: 0, gzA: 0, brB: 0, brA: 0, cB: 0, cA: 0 };
const rows = [];
const skipped = [];
for (const f of files) {
  const a0 = audit(f);
  const orig = fs.readFileSync(f);
  const rel = f.slice(ROOT.length + 1);
  if (a0.animCount === 0) { // untouched: no clips to reclaim, no reason to re-encode
    T.rawB += orig.length; T.rawA += orig.length; T.gzB += gz(orig); T.gzA += gz(orig);
    T.brB += br(orig); T.brA += br(orig);
    continue;
  }
  const names = a0.clips.map((c) => c.name);
  const drift = driftCheck(names, keep);
  if (drift.length) { console.error(`ABORT: slot drift in ${rel}:`, drift); process.exit(1); }

  const dropped = dropClips(f, keep);
  const t0 = path.join(tmp, 'a.glb'), t1 = path.join(tmp, 'b.glb'), t2 = path.join(tmp, 'c.glb');
  fs.writeFileSync(t0, dropped.buf);
  gt('dedup', t0, t1);            // collapse now-duplicate accessors/samplers
  gt('meshopt', t1, t2, '--level', 'high'); // REPACK — this is where the bytes leave
  const out = fs.readFileSync(t2);

  // --- integrity gate: the re-encode must change nothing but animation count
  const a1 = audit(t2);
  const keptNames = names.filter(keep);
  const got = a1.clips.map((c) => c.name);
  const bad = [];
  if (got.length !== keptNames.length || keptNames.some((n) => !got.includes(n)))
    bad.push(`clip list mismatch: expected ${keptNames.length}, got ${got.length}`);
  if (a1.vertices !== a0.vertices) bad.push(`vertex count ${a0.vertices} -> ${a1.vertices}`);
  if (a1.triangles !== a0.triangles) bad.push(`triangles ${a0.triangles} -> ${a1.triangles}`);
  const tex = (r) => r.textures.map((t) => `${t.mime}:${t.bytes}`).sort().join(',');
  if (tex(a1) !== tex(a0)) bad.push(`textures [${tex(a0)}] -> [${tex(a1)}]`);
  const ext = (r) => [...r.extRequired].sort().join(',');
  if (ext(a1) !== ext(a0)) bad.push(`extensionsRequired [${ext(a0)}] -> [${ext(a1)}]`);
  if (bad.length) { console.error(`ABORT: ${rel}:`, bad.join('; ')); process.exit(1); }

  // IDEMPOTENCE. Run this on already-pruned files and there is nothing left to
  // drop, so the re-encode is pure churn — it lands within a few bytes either
  // way (once, 0.1% across 21 files). Rewriting them anyway would change 21
  // content hashes and evict every one from every warm cache to save ~10 KB, so
  // demand a real gain before touching a file. The tool has to be safe to
  // re-run: the coverage test tells people to. Every genuine first-pass saving
  // measured was >=4%, so 1% cleanly separates signal from churn.
  if (out.length > orig.length * 0.99) {
    skipped.push(rel);
    T.rawB += orig.length; T.rawA += orig.length; T.gzB += gz(orig); T.gzA += gz(orig);
    T.brB += br(orig); T.brA += br(orig); T.cB += names.length; T.cA += names.length;
    continue;
  }

  fs.mkdirSync(path.join(STAGE, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(STAGE, rel), out);
  rows.push({ rel, c: `${names.length}->${keptNames.length}`, raw: [orig.length, out.length], g: [gz(orig), gz(out)] });
  T.rawB += orig.length; T.rawA += out.length; T.gzB += gz(orig); T.gzA += gz(out);
  T.brB += br(orig); T.brA += br(out); T.cB += names.length; T.cA += keptNames.length;
}
fs.rmSync(tmp, { recursive: true, force: true });

const kb = (b) => (b / 1024).toFixed(0) + 'KB';
console.log('\nfile'.padEnd(35), 'clips'.padStart(9), 'raw'.padStart(20), 'gzip (the wire)'.padStart(22));
for (const r of rows.sort((a, b) => (b.g[0] - b.g[1]) - (a.g[0] - a.g[1])))
  console.log(r.rel.padEnd(34), r.c.padStart(9),
    `${kb(r.raw[0])}->${kb(r.raw[1])} (-${(100 - r.raw[1] / r.raw[0] * 100).toFixed(0)}%)`.padStart(20),
    `${kb(r.g[0])}->${kb(r.g[1])} (-${(100 - r.g[1] / r.g[0] * 100).toFixed(0)}%)`.padStart(22));
console.log(`\n${rows.length} animated GLBs rewritten, ${files.length - rows.length} untouched. clips ${T.cB} -> ${T.cA}`);
console.log(`CLASS TOTAL (all ${files.length} character GLBs)`);
for (const [l, b, a] of [['raw   ', T.rawB, T.rawA], ['gzip  ', T.gzB, T.gzA], ['brotli', T.brB, T.brA]])
  console.log(`  ${l} ${mb(b)} -> ${mb(a)}  saves ${mb(b - a)} (-${(100 - a / b * 100).toFixed(1)}%)`);

if (APPLY) {
  for (const r of rows) fs.copyFileSync(path.join(STAGE, r.rel), path.join(ROOT, r.rel));
  console.log(`\nAPPLIED to ${ROOT}`);
} else {
  console.log(`\nDRY RUN — staged in ${STAGE}/. Re-run with --apply to write into ${ROOT}.`);
}
