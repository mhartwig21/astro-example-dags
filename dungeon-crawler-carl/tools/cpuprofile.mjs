// Main-thread CPU profiler. Uses the DevTools Protocol Profiler domain against
// a REAL-GPU Chromium (ANGLE/D3D11, vsync off) so the samples come from the
// same engine the player runs. Unlike gpuprobe.mjs (frame times only) this
// attributes the frame budget to individual functions.
//
// Usage:
//   node tools/cpuprofile.mjs <url> [--seconds 10] [--w 640] [--h 360]
//                             [--dpr 1] [--interval 100] [--stage combat]
//                             [--json out.json] [--top 40]
//
// --interval is the V8 sampling interval in MICROseconds (100us = 10kHz).
// Profile at a TINY resolution to push GPU/fill cost out of the way and let
// the CPU floor dominate; profile at native size to see the whole picture.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const url = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 10));
const width = Number(flag("--w", 640));
const height = Number(flag("--h", 360));
const dpr = Number(flag("--dpr", 1));
const intervalUs = Number(flag("--interval", 100));
const stage = flag("--stage", "combat");
const topN = Number(flag("--top", 40));
const jsonOut = flag("--json", null);

// ---------------------------------------------------------------- buckets
// Each sample is attributed to the first ancestor (leaf -> root) that matches.
// Order matters: more specific rules first.
const BUCKETS = [
  ["gc", (f, u) => f === "(garbage collector)"],
  ["idle/program", (f) => f === "(idle)" || f === "(program)" || f === "(root)"],
  // --- three.js render submission -------------------------------------
  ["three:renderBufferDirect", (f) => /renderBufferDirect/.test(f)],
  ["three:setProgram/uniforms", (f) => /^(setProgram|refreshUniforms|setValueV|upload|setValue|WebGLUniforms)/.test(f)],
  ["three:projectObject/sort", (f) => /^(projectObject|renderObjects|painterSortStable|reversePainterSortStable)/.test(f)],
  ["three:shadowmap", (f) => /shadow/i.test(f)],
  ["three:updateMatrixWorld", (f) => /^(updateMatrixWorld|updateWorldMatrix|updateMatrix)$/.test(f)],
  ["three:skin/bones", (f) => /^(update|computeBoneTexture)$/.test(f) === false && /Skeleton|bindMatrix/.test(f)],
  ["three:animation", (f) => /^(AnimationMixer|_update|PropertyBinding|Interpolant|evaluate|apply)/.test(f)],
];

// -------------------------------------------------------- profile crunching
function crunch(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  // self time per node id from the sample stream (timeDeltas are microseconds)
  const selfUs = new Map();
  const { samples = [], timeDeltas = [] } = profile;
  let totalUs = 0;
  for (let i = 0; i < samples.length; i++) {
    // timeDeltas[i] is the delta BEFORE samples[i]; attribute it to samples[i-1]
    // per the V8 convention used by DevTools.
    const d = Math.max(0, timeDeltas[i] ?? 0);
    const id = samples[i > 0 ? i - 1 : 0];
    selfUs.set(id, (selfUs.get(id) ?? 0) + d);
    totalUs += d;
  }

  const key = (n) => {
    const cf = n.callFrame;
    const name = cf.functionName || "(anonymous)";
    const file = (cf.url || "").split("/").pop() || "-";
    return `${name} @ ${file}:${cf.lineNumber + 1}`;
  };

  // flat self-time table
  const flat = new Map();
  for (const [id, us] of selfUs) {
    const n = byId.get(id);
    if (!n) continue;
    const k = key(n);
    const e = flat.get(k) ?? { k, us: 0, name: n.callFrame.functionName, url: n.callFrame.url, hits: 0 };
    e.us += us;
    e.hits += n.hitCount ?? 0;
    flat.set(k, e);
  }

  // inclusive (total) time per function key: walk each sample's ancestor chain
  const ancestors = new Map(); // node id -> array of node ids root..self
  const chainOf = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const p = parent.get(id);
    const chain = p === undefined ? [id] : [...chainOf(p), id];
    ancestors.set(id, chain);
    return chain;
  };
  const incl = new Map();
  const bucket = new Map();
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, timeDeltas[i] ?? 0);
    const id = samples[i > 0 ? i - 1 : 0];
    const n = byId.get(id);
    if (!n) continue;
    const chain = chainOf(id);
    const seen = new Set();
    for (const cid of chain) {
      const cn = byId.get(cid);
      if (!cn) continue;
      const k = key(cn);
      if (seen.has(k)) continue; // recursion: count once
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + d);
    }
    // bucket: first matching ancestor from leaf upward
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

  return { flat: [...flat.values()].sort((a, b) => b.us - a.us), incl, bucket, totalUs };
}

// ------------------------------------------------------------------ driver
const browser = await chromium.launch({
  headless: false,
  args: [
    "--use-angle=d3d11",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { renderer: "NO WEBGL" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?" };
});
console.log("GPU:", gpu.renderer, `| canvas ${width}x${height} @dpr${dpr} = ${width * dpr}x${height * dpr}px`);
if (!/D3D11|Direct3D|Intel|NVIDIA|AMD/i.test(gpu.renderer)) {
  console.warn("!! NOT a hardware GPU string — timings are meaningless:", gpu.renderer);
}

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);

// ------------------------------------------- honest draw-call instrumentation
// EffectComposer runs N passes; three.js resets renderer.info at the START of
// every WebGLRenderer.render(), so reading info AFTER composer.render() reports
// only the LAST pass (a fullscreen quad => "calls: 1"). Turn autoReset off and
// accumulate across the whole composed frame instead.
const instrumented = await page.evaluate(() => {
  const r3d = window.__dcc?.renderer;
  const gl = r3d?.renderer;
  if (!r3d || !gl?.info) return { ok: false, why: "no __dcc.renderer.renderer.info" };
  gl.info.autoReset = false;
  const acc = { calls: 0, tris: 0, points: 0, lines: 0, frames: 0, passes: 0, programs: 0,
                shadowCalls: 0, mainCalls: 0 };
  window.__perfAcc = acc;
  const origRender = r3d.render.bind(r3d);
  r3d.render = function () {
    gl.info.reset();
    origRender();
    acc.calls += gl.info.render.calls;
    acc.tris += gl.info.render.triangles;
    acc.points += gl.info.render.points;
    acc.lines += gl.info.render.lines;
    acc.frames++;
    acc.programs = gl.info.programs?.length ?? 0;
  };
  // Per-pass split: count how many WebGLRenderer.render() invocations happen
  // inside one composed frame, and how many calls the shadow pass costs.
  const origGl = gl.render.bind(gl);
  gl.render = function (scene, cam) {
    origGl(scene, cam);
    acc.passes++;
  };
  // Per-composer-pass wall time + draw calls. performance.now() around each
  // pass is CPU-submission time (GL is async) but that is exactly the budget
  // we are hunting: the main thread's cost to submit the pass.
  const passes = r3d.composer?.passes ?? [];
  const stats = passes.map((p, i) => ({
    i, name: p.constructor?.name ?? "?", enabled: p.enabled, ms: 0, calls: 0, n: 0,
  }));
  window.__passStats = stats;
  passes.forEach((p, i) => {
    const orig = p.render.bind(p);
    p.render = function (...a) {
      const c0 = gl.info.render.calls;
      const t0 = performance.now();
      orig(...a);
      stats[i].ms += performance.now() - t0;
      stats[i].calls += gl.info.render.calls - c0;
      stats[i].n++;
    };
  });
  // Draw-call census: who actually issues the 1000+ calls? renderBufferDirect
  // is public on WebGLRenderer, so we can tally per object without patching
  // three itself.
  const cen = new Map();
  window.__census = cen;
  const origRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    let k = obj?.name || obj?.userData?.kind || obj?.type || "?";
    if (obj?.isInstancedMesh) k = `INSTANCED:${k}(x${obj.count})`;
    else if (obj?.isSkinnedMesh) k = `SKINNED:${k}`;
    cen.set(k, (cen.get(k) ?? 0) + 1);
    return origRBD(cam, scene, geo, mat, obj, group);
  };
  return { ok: true, passes: stats.map((s) => `${s.i}:${s.name}${s.enabled ? "" : "(off)"}`) };
});
console.log("instrumented:", JSON.stringify(instrumented));

// ---- experiment hook: arbitrary JS run in-page BEFORE staging/profiling ----
// e.g. --tweak "window.__dcc.renderer.composer.passes[1].enabled=false"
const tweak = flag("--tweak", null);
if (tweak) console.log("TWEAK:", tweak, "=>", JSON.stringify(await page.evaluate(tweak)));

// ------------------------------------------------------------------ staging
async function stageCombat() {
  // Walk into the level so streaming/dressing is resident, then fight.
  await page.keyboard.down("w");
  await page.waitForTimeout(1200);
  await page.keyboard.up("w");
  await page.keyboard.down("d");
  await page.waitForTimeout(900);
  await page.keyboard.up("d");
  for (const k of ["Space", "q", "e", "r", "c"]) { await page.keyboard.press(k).catch(() => {}); }
}
if (stage === "combat") await stageCombat();
else if (stage === "moving") { await page.keyboard.down("w"); }

// Optionally wait until shader-program compilation has SETTLED, so the profile
// measures the steady-state floor instead of smearing compile hitches into it.
if (has("--settle")) {
  const deadline = Date.now() + 120000;
  let last = -1, stableSince = Date.now();
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => window.__dcc?.renderer?.renderer?.info?.programs?.length ?? -1);
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 6000) break;
    await page.waitForTimeout(500);
  }
  console.log(`SETTLED at ${last} programs after ${((Date.now() - stableSince) / 1000).toFixed(0)}s stable`);
}

// scene census before profiling
const census = await page.evaluate(() => {
  const r3d = window.__dcc?.renderer;
  const st = window.__dcc?.state;
  let objs = 0, meshes = 0, skinned = 0, lights = 0, instanced = 0, mats = new Set(), geos = new Set();
  r3d?.scene?.traverse?.((o) => {
    objs++;
    if (o.isMesh) meshes++;
    if (o.isSkinnedMesh) skinned++;
    if (o.isInstancedMesh) instanced++;
    if (o.isLight) lights++;
    if (o.material) for (const m of [].concat(o.material)) mats.add(m.uuid);
    if (o.geometry) geos.add(o.geometry.uuid);
  });
  return {
    objects: objs, meshes, skinned, instanced, lights,
    materials: mats.size, geometries: geos.size,
    monsters: st?.monsters?.length ?? null,
    aliveMonsters: st?.monsters?.filter?.((m) => m.hp > 0).length ?? null,
    players: st?.players?.length ?? null,
  };
});
console.log("SCENE:", JSON.stringify(census));

// ------------------------------------------------------------------ profile
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: intervalUs });

// frame counter across exactly the profiled window
await page.evaluate(() => {
  window.__fc = 0;
  window.__fts = [];
  let last = performance.now();
  const t = () => {
    const now = performance.now();
    window.__fc++;
    window.__fts.push(now - last);
    last = now;
    window.__fcRaf = requestAnimationFrame(t);
  };
  window.__fcRaf = requestAnimationFrame(t);
});
const accBefore = await page.evaluate(() => {
  for (const s of window.__passStats ?? []) { s.ms = 0; s.calls = 0; s.n = 0; }
  window.__census?.clear?.();
  return { ...window.__perfAcc, programs0: window.__dcc.renderer.renderer.info.programs.length };
});
await cdp.send("Profiler.start");
const t0 = Date.now();
await page.waitForTimeout(seconds * 1000);
const { profile } = await cdp.send("Profiler.stop");
const wallMs = Date.now() - t0;
const post = await page.evaluate(() => {
  cancelAnimationFrame(window.__fcRaf);
  const f = window.__fts.slice().sort((a, b) => a - b);
  return {
    frames: window.__fc,
    medianMs: +f[Math.floor(f.length / 2)].toFixed(2),
    p95Ms: +f[Math.floor(f.length * 0.95)].toFixed(2),
    worstMs: +f[f.length - 1].toFixed(2),
    acc: { ...window.__perfAcc },
    passStats: (window.__passStats ?? []).map((s) => ({ ...s })),
    census: [...(window.__census ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, 25),
  };
});
const accAfter = post.acc;
const dFrames = accAfter.frames - accBefore.frames;
const drawPerFrame = dFrames > 0 ? (accAfter.calls - accBefore.calls) / dFrames : 0;
const trisPerFrame = dFrames > 0 ? (accAfter.tris - accBefore.tris) / dFrames : 0;
const passesPerFrame = dFrames > 0 ? (accAfter.passes - accBefore.passes) / dFrames : 0;

const { flat, incl, bucket, totalUs } = crunch(profile);
const frames = post.frames || 1;
const perFrame = (us) => (us / 1000 / frames).toFixed(2);

console.log("\n==================================================================");
console.log(`WINDOW ${(wallMs / 1000).toFixed(1)}s · ${frames} frames · median ${post.medianMs}ms ` +
  `· p95 ${post.p95Ms}ms · worst ${post.worstMs}ms · ${(1000 / post.medianMs).toFixed(1)} fps`);
console.log(`DRAW CALLS/frame ${drawPerFrame.toFixed(0)} · TRIS/frame ${(trisPerFrame / 1000).toFixed(0)}k ` +
  `· renderer.render() passes/frame ${passesPerFrame.toFixed(1)} · programs ${accAfter.programs}`);
console.log(`CPU sampled ${(totalUs / 1000).toFixed(0)}ms over ${(wallMs).toFixed(0)}ms wall ` +
  `=> ${(totalUs / 1000 / frames).toFixed(2)}ms CPU/frame`);
console.log(`PROGRAMS ${accBefore.programs0} -> ${accAfter.programs} ` +
  `(+${accAfter.programs - accBefore.programs} compiled DURING the window)`);

console.log("\n--- COMPOSER PASSES (ms/frame submitted, draw calls/frame) --------");
for (const s of post.passStats.filter((x) => x.n > 0).sort((a, b) => b.ms - a.ms)) {
  console.log(`${(s.ms / frames).toFixed(2).padStart(7)}ms ${(s.calls / frames).toFixed(0).padStart(6)} calls  ` +
    `#${s.i} ${s.name}`);
}
{
  const tot = post.passStats.reduce((a, s) => a + s.ms, 0);
  const totC = post.passStats.reduce((a, s) => a + s.calls, 0);
  console.log(`${(tot / frames).toFixed(2).padStart(7)}ms ${(totC / frames).toFixed(0).padStart(6)} calls  TOTAL (pass-attributed)`);
}

console.log("\n--- DRAW CALLS BY OBJECT (calls/frame, top 20) --------------------");
for (const [k, n] of post.census.slice(0, 20)) {
  console.log(`${(n / frames).toFixed(1).padStart(7)}  ${k}`);
}

console.log("\n--- BUCKETS (ms/frame) -------------------------------------------");
for (const [b, us] of [...bucket].sort((a, b2) => b2[1] - a[1])) {
  console.log(`${perFrame(us).padStart(7)}  ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${b}`);
}

console.log("\n--- SELF TIME (ms/frame), top " + topN + " ------------------------");
console.log("  ms/f     %   function");
for (const e of flat.slice(0, topN)) {
  console.log(`${perFrame(e.us).padStart(7)} ${((e.us / totalUs) * 100).toFixed(1).padStart(5)}%  ${e.k}`);
}

console.log("\n--- TOTAL (inclusive) TIME (ms/frame), top " + topN + " -----------");
const inclArr = [...incl].sort((a, b) => b[1] - a[1]).slice(0, topN);
for (const [k, us] of inclArr) {
  console.log(`${perFrame(us).padStart(7)} ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${k}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    url, width, height, dpr, seconds, gpu: gpu.renderer, census,
    frames, medianMs: post.medianMs, p95Ms: post.p95Ms, worstMs: post.worstMs,
    drawPerFrame, trisPerFrame, passesPerFrame, programs: accAfter.programs,
    totalUs, buckets: [...bucket], self: flat.slice(0, 200), incl: inclArr,
    profile,
  }));
  console.log("\nwrote", jsonOut);
}
await browser.close();
