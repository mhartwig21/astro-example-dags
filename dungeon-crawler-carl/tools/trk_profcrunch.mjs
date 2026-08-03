// Crunches the CDP profiles captured by trk_where.mjs into a per-frame budget
// attributed to the LAYERS of main3d.ts's frame():
//
//   sim        step() and everything under it (src/sim/*)
//   scenegraph Renderer3D.update + three's matrix/skeleton/animation walks
//   glsubmit   composer passes -> renderBufferDirect -> ANGLE
//   hud/dom    updateHud/updateSkills/drawMinimap/spawnDamageNumber/... + style
//   gc         (garbage collector)
//   idle       (idle)/(program) — the frame WAITING, i.e. not CPU-bound there
//
// Attribution is leaf->root: a sample lands in the first bucket its ancestor
// chain matches walking UP from the leaf, so `step()` calling into dmath still
// counts as sim, and three.js called from update() counts as scenegraph.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const topN = Number(process.argv.includes("--top") ? process.argv[process.argv.indexOf("--top") + 1] : 18);

// order matters: first match walking leaf->root wins
const BUCKETS = [
  ["gc", (f) => f === "(garbage collector)"],
  ["idle/program", (f) => f === "(idle)" || f === "(program)" || f === "(root)"],
  ["sim", (f, u) => /\/sim\//.test(u)],
  ["glsubmit", (f, u) => /renderBufferDirect|setProgram|refreshUniforms|WebGLUniforms|setValueV|bindTexture|useProgram|EffectComposer|Pass\.render|renderObjects|renderBufferImmediate/.test(f)],
  ["scenegraph", (f, u) => /updateMatrixWorld|updateWorldMatrix|updateMatrix$|projectObject|painterSort|Skeleton|computeBoneTexture|AnimationMixer|PropertyBinding|Interpolant|frustum|IntersectsObject|computeBoundingSphere/.test(f)],
  ["render3d(host)", (f, u) => /render3d\//.test(u)],
  ["hud/dom", (f, u) => /updateHud|updateSkills|drawMinimap|spawnDamageNumber|showAnnouncement|updateShowHud|updateBossBar|updateGhost|updateDowned|updateRoamUi|maybeShowRecap|innerHTML|esc$|uic$/.test(f)],
  ["three(other)", (f, u) => /three|Three/.test(u)],
  ["main3d(host)", (f, u) => /main3d/.test(u)],
  ["ui/audio/net", (f, u) => /\/ui\/|\/audio\/|\/net\/|\/input\/|\/persist\//.test(u)],
];

function crunch(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const chainCache = new Map();
  const chainOf = (id) => {
    if (chainCache.has(id)) return chainCache.get(id);
    const p = parent.get(id);
    const chain = p === undefined ? [id] : [...chainOf(p), id];
    chainCache.set(id, chain);
    return chain;
  };
  const key = (n) => {
    const cf = n.callFrame;
    return `${cf.functionName || "(anon)"} @ ${(cf.url || "-").split("/").pop()}:${cf.lineNumber + 1}`;
  };
  const bucket = new Map();
  const flat = new Map();
  const incl = new Map();
  let totalUs = 0;
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, timeDeltas[i] ?? 0);
    const id = samples[i > 0 ? i - 1 : 0];
    const n = byId.get(id);
    if (!n) continue;
    totalUs += d;
    const k = key(n);
    flat.set(k, (flat.get(k) ?? 0) + d);
    const chain = chainOf(id);
    const seen = new Set();
    for (const cid of chain) {
      const cn = byId.get(cid);
      if (!cn) continue;
      const ck = key(cn);
      if (seen.has(ck)) continue;
      seen.add(ck);
      incl.set(ck, (incl.get(ck) ?? 0) + d);
    }
    let b = "other";
    for (let j = chain.length - 1; j >= 0; j--) {
      const cn = byId.get(chain[j]);
      if (!cn) continue;
      const fn = cn.callFrame.functionName || "";
      const u = cn.callFrame.url || "";
      const m = BUCKETS.find(([, t]) => t(fn, u));
      if (m) { b = m[0]; break; }
    }
    bucket.set(b, (bucket.get(b) ?? 0) + d);
  }
  return { bucket, flat, incl, totalUs };
}

for (const f of files) {
  const doc = JSON.parse(readFileSync(f, "utf8"));
  console.log(`\n################ ${f}  (adapter=${doc.adapter}, ${doc.width}x${doc.height}@${doc.dpr}, quality=${doc.quality})`);
  for (const r of doc.results) {
    if (!r.profile) { console.log(`-- ${r.id}: no profile`); continue; }
    const { bucket, flat, incl, totalUs } = crunch(r.profile);
    const frames = r.frames || 1;
    const pf = (us) => (us / 1000 / frames).toFixed(2);
    const busyUs = totalUs - (bucket.get("idle/program") ?? 0);
    console.log(`\n--- ${r.id} · ${r.label}`);
    console.log(`    frames ${frames} · frameMs median ${r.frame.median} mean ${r.frame.mean} p95 ${r.frame.p95}`);
    console.log(`    sampled CPU ${(totalUs / 1000).toFixed(0)}ms; BUSY (non-idle) ${(busyUs / 1000).toFixed(0)}ms = ${(busyUs / 1000 / frames).toFixed(2)}ms/frame`);
    console.log(`    LAYER                ms/frame    % busy`);
    for (const [b, us] of [...bucket].sort((a, c) => c[1] - a[1])) {
      const pct = b === "idle/program" ? "-" : ((us / busyUs) * 100).toFixed(1) + "%";
      console.log(`    ${b.padEnd(20)} ${pf(us).padStart(8)}  ${String(pct).padStart(7)}`);
    }
    console.log(`    top self-time functions (ms/frame):`);
    for (const [k, us] of [...flat].sort((a, c) => c[1] - a[1]).slice(0, topN)) {
      if (/^\(idle\)|^\(program\)|^\(root\)/.test(k)) continue;
      console.log(`      ${pf(us).padStart(7)}  ${k}`);
    }
    const want = ["step @", "update @", "render @", "updateHud", "drawMinimap", "updateSkills", "spawnDamageNumber", "frame @ main3d"];
    console.log(`    inclusive time for named frame phases (ms/frame):`);
    for (const [k, us] of [...incl].sort((a, c) => c[1] - a[1])) {
      if (want.some((w) => k.startsWith(w) || k.includes(w))) console.log(`      ${pf(us).padStart(7)}  ${k}`);
    }
  }
}
