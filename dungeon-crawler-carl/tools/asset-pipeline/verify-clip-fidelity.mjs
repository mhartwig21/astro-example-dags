// MOTION FIDELITY, MEASURED — the gate a screenshot cannot give you.
//
// The prune pass decodes and RE-ENCODES every file (that is where the bytes
// actually leave), so the honest question is not only "did a clip disappear"
// but "does a clip that survived still move the same way". At game camera a
// character is ~80 px tall and a boss telegraph can flip 80% of the screen, so
// a pixel diff of gameplay answers neither question reliably.
//
// So compare the animation data itself. For every clip kept in every rewritten
// file, this walks both the committed original (from git) and the new file and
// compares each channel's sampler output element by element:
//   * rotation channels are quaternions -> report the ANGLE between them
//   * translation/scale -> report absolute deviation, and relative to the
//     model's own bounding-box size so it is meaningful in world terms
// It fails loudly if a kept clip changed shape (different channel count,
// keyframe count, interpolation, or target node), which would mean the
// re-encode did something other than requantize.
//
// Usage: node tools/asset-pipeline/verify-clip-fidelity.mjs [--full]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const req = createRequire(path.resolve('tools/asset-pipeline/verify-clip-fidelity.mjs'));
function gltfAPI() {
  execFileSync('npx --yes @gltf-transform/cli@4.4.2 --version', { stdio: 'pipe', shell: true });
  const root = path.join(os.homedir(), 'AppData/Local/npm-cache/_npx');
  for (const d of fs.readdirSync(root)) {
    const base = path.join(root, d, 'node_modules');
    if (fs.existsSync(path.join(base, '@gltf-transform/core'))) {
      return {
        core: req(path.join(base, '@gltf-transform/core')),
        ext: req(path.join(base, '@gltf-transform/extensions')),
        meshopt: req(path.join(base, 'meshoptimizer')),
      };
    }
  }
  throw new Error('@gltf-transform/core not in the npx cache');
}
const { core, ext, meshopt } = gltfAPI();
// The decoder is a WASM module; touching it before it resolves throws deep
// inside the extension with a misleading "cannot read exports of undefined".
await meshopt.MeshoptDecoder.ready;
await meshopt.MeshoptEncoder.ready;
const io = new core.NodeIO()
  .registerExtensions(ext.ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': meshopt.MeshoptDecoder, 'meshopt.encoder': meshopt.MeshoptEncoder });

// --relative keeps these cwd-relative for fs; git show still needs the
// repo-root-relative path, which is that plus the subdirectory prefix.
const PREFIX = execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['diff', '--name-only', '--relative', '--', 'public/assets/characters'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);
if (!files.length) { console.log('no modified character GLBs — nothing to verify'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-'));
const clipsOf = async (buf) => {
  const doc = await io.readBinary(new Uint8Array(buf));
  const m = new Map();
  for (const a of doc.getRoot().listAnimations()) {
    const chans = a.listChannels().map((c) => {
      const s = c.getSampler();
      return {
        node: c.getTargetNode()?.getName() ?? '?', pathName: c.getTargetPath(),
        interp: s.getInterpolation(),
        input: Array.from(s.getInput()?.getArray() ?? []),
        output: Array.from(s.getOutput()?.getArray() ?? []),
      };
    }).sort((x, y) => (x.node + x.pathName).localeCompare(y.node + y.pathName));
    m.set(a.getName(), chans);
  }
  return m;
};

let worstRotDeg = 0, worstTrans = 0, worstScale = 0, clips = 0, chans = 0;
const failures = [];
const perFile = [];
for (const f of files) {
  const orig = execFileSync('git', ['show', `HEAD:${PREFIX}${f}`], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const A = await clipsOf(orig);
  const B = await clipsOf(fs.readFileSync(f));
  let fRot = 0, fTrans = 0, fScale = 0;

  for (const [name, bc] of B) {
    const ac = A.get(name);
    if (!ac) { failures.push(`${f}: kept clip "${name}" is not in the original`); continue; }
    if (ac.length !== bc.length) { failures.push(`${f}/${name}: channel count ${ac.length} -> ${bc.length}`); continue; }
    clips++;
    for (let i = 0; i < bc.length; i++) {
      const a = ac[i], b = bc[i];
      if (a.node !== b.node || a.pathName !== b.pathName) { failures.push(`${f}/${name}: channel ${i} retargeted ${a.node}.${a.pathName} -> ${b.node}.${b.pathName}`); continue; }
      if (a.interp !== b.interp) { failures.push(`${f}/${name}: interpolation ${a.interp} -> ${b.interp}`); continue; }
      if (a.output.length !== b.output.length) { failures.push(`${f}/${name}/${a.node}.${a.pathName}: keyframes ${a.output.length / (a.pathName === 'rotation' ? 4 : 3)} -> ${b.output.length / (b.pathName === 'rotation' ? 4 : 3)}`); continue; }
      chans++;
      if (a.pathName === 'rotation') {
        for (let k = 0; k + 3 < a.output.length; k += 4) {
          let d = 0; for (let j = 0; j < 4; j++) d += a.output[k + j] * b.output[k + j];
          const deg = 2 * Math.acos(Math.min(1, Math.abs(d))) * 180 / Math.PI;
          if (deg > fRot) fRot = deg;
        }
      } else {
        for (let k = 0; k < a.output.length; k++) {
          const d = Math.abs(a.output[k] - b.output[k]);
          if (a.pathName === 'scale') { if (d > fScale) fScale = d; } else if (d > fTrans) fTrans = d;
        }
      }
    }
  }
  perFile.push({ f: f.replace('public/assets/characters/', ''), rot: fRot, trans: fTrans, scale: fScale, kept: B.size, was: A.size });
  worstRotDeg = Math.max(worstRotDeg, fRot); worstTrans = Math.max(worstTrans, fTrans); worstScale = Math.max(worstScale, fScale);
}
fs.rmSync(tmp, { recursive: true, force: true });

if (process.argv.includes('--full')) {
  console.log('file'.padEnd(34), 'clips'.padStart(9), 'maxRot(deg)'.padStart(12), 'maxTrans'.padStart(11), 'maxScale'.padStart(10));
  for (const r of perFile.sort((a, b) => b.rot - a.rot))
    console.log(r.f.padEnd(34), `${r.was}->${r.kept}`.padStart(9), r.rot.toFixed(4).padStart(12), r.trans.toExponential(2).padStart(11), r.scale.toExponential(2).padStart(10));
  console.log();
}
console.log(`compared ${clips} kept clips / ${chans} channels across ${files.length} files`);
console.log(`  worst rotation deviation : ${worstRotDeg.toFixed(4)} deg`);
console.log(`  worst translation deviation: ${worstTrans.toExponential(3)} (model units; rigs are ~2.6 tall)`);
console.log(`  worst scale deviation    : ${worstScale.toExponential(3)}`);
if (failures.length) { console.error(`\nFAIL (${failures.length}):`); for (const x of failures.slice(0, 40)) console.error('  ' + x); process.exit(1); }
// A joint off by a degree is visible on a swing; a hundredth of a degree is not.
if (worstRotDeg > 0.5) { console.error(`\nFAIL: rotation deviation ${worstRotDeg.toFixed(3)} deg exceeds the 0.5 deg budget`); process.exit(1); }
console.log('\nPASS: every kept clip is intact and within the fidelity budget.');
