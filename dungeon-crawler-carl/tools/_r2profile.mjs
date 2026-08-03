// WHERE DOES THE MAIN THREAD GO — r2 paydown, worst real scene.
//
// The r1 paydown established that this frame is not purely fill-bound: on the
// worst scene it read cpuUpdate 6.2 ms + cpuRender 8.5 ms against a ~14 ms GPU
// frame. GPU timer queries cannot see JS, and paydown.mjs can only price a
// subsystem someone already suspected. This tool answers the open question
// instead: a V8 CPU profile of the REAL config (1440x852 @ dpr 2, ANGLE/D3D11
// Intel, the game's own context asserted), attributed to functions, plus a
// draw-call census by object so "621 calls" becomes a list of who issued them.
//
// Everything the briefs insist on is enforced rather than assumed:
//   * headless:false + ANGLE d3d11; the GAME's context is asserted, not a probe
//     canvas (this laptop has two adapters and the budget is the iGPU's).
//   * readiness is the boot card LEAVING, not data-assets-settled, then the
//     program cache going quiet, then 3 s, then an ASSERTION that #loading has
//     no box. A number taken over the boot card is a number about a loading
//     card.
//   * the crawler is kept alive from before the first page script (dropped in
//     at floor 17 it dies to a beam trap ~1.5 s in, and every sample after that
//     describes the death recap).
//   * foreign browser load is measured across the profiled window with the
//     shared meter and REPORTED with the result. A profile taken while a
//     sibling burns 60% of the box still ranks functions correctly, but its
//     absolute ms/frame are inflated — so the ranking is what gets used and the
//     inflation is stated instead of hidden.
//
// Usage: node tools/_r2profile.mjs [--port 5282] [--seconds 12] [--ring 18]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const seconds = Number(flag("--seconds", 12));
const ring = Number(flag("--ring", 18));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const intervalUs = Number(flag("--interval", 100));
const topN = Number(flag("--top", 45));
const outDir = flag("--out", "tools/_r2pay");
const url = flag("--url", `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- buckets
// A sample is attributed to the first ancestor (leaf -> root) that matches, so
// "this sample was inside AnimationMixer.update, which was inside our monster
// loop" lands on animation rather than on the loop.
const BUCKETS = [
  ["gc", (f) => f === "(garbage collector)"],
  ["idle/program", (f) => f === "(idle)" || f === "(program)" || f === "(root)"],
  ["three:animation/skinning", (f) => /AnimationMixer|PropertyBinding|Interpolant|_update|AnimationAction|calculateWeight|_scheduleFading|Skeleton|computeBoneTexture|normalizeSkinWeights/.test(f)],
  ["three:renderBufferDirect", (f) => /renderBufferDirect/.test(f)],
  ["three:setProgram/uniforms", (f) => /setProgram|refreshUniforms|setValueV|WebGLUniforms|upload|setOptional/.test(f)],
  ["three:projectObject/sort", (f) => /projectObject|renderObjects|painterSortStable|reversePainterSortStable|renderScene/.test(f)],
  ["three:shadowmap", (f) => /shadow/i.test(f)],
  ["three:matrix", (f) => /^(updateMatrixWorld|updateWorldMatrix|updateMatrix|compose|decompose|multiplyMatrices)$/.test(f)],
  ["three:frustum/cull", (f) => /Frustum|intersectsObject|setFromProjectionMatrix|computeBoundingSphere/.test(f)],
  ["dom/style", (f, u) => /style|getBoundingClientRect|setProperty|appendChild/i.test(f)],
  ["canvas2d", (f) => /fillText|strokeText|measureText|getContext|clearRect|drawImage/.test(f)],
];

function crunch(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n) => {
    const f = n.callFrame;
    const u = (f.url || "").split("/").pop() || "";
    return `${f.functionName || "(anonymous)"} @${u}:${f.lineNumber + 1}`;
  };
  const chainOf = (id) => { const c = []; let cur = id; while (cur !== undefined) { c.push(cur); cur = parent.get(cur); } return c.reverse(); };
  const { samples = [], timeDeltas = [] } = profile;
  const flat = new Map();
  const incl = new Map();
  const bucket = new Map();
  let totalUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, timeDeltas[i] ?? 0);
    totalUs += d;
    const id = samples[i > 0 ? i - 1 : 0];
    const n = byId.get(id);
    if (!n) continue;
    const k = key(n);
    flat.set(k, (flat.get(k) ?? 0) + d);
    const chain = chainOf(id);
    const seen = new Set();
    for (const cid of chain) {
      const cn = byId.get(cid); if (!cn) continue;
      const ck = key(cn); if (seen.has(ck)) continue;
      seen.add(ck); incl.set(ck, (incl.get(ck) ?? 0) + d);
    }
    let b = "other";
    for (let j = chain.length - 1; j >= 0; j--) {
      const cn = byId.get(chain[j]); if (!cn) continue;
      const fn = cn.callFrame.functionName || "";
      const m = BUCKETS.find(([, t]) => t(fn, cn.callFrame.url || ""));
      if (m) { b = m[0]; break; }
    }
    bucket.set(b, (bucket.get(b) ?? 0) + d);
  }
  return { flat: [...flat.entries()].sort((a, b) => b[1] - a[1]), incl, bucket, totalUs };
}

// ------------------------------------------------------------------ driver
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Keep-alive armed BEFORE any page script: the crawler dies to a beam trap
// ~1.5 s after a floor-17 drop-in, long before any readiness gate can open.
await page.addInitScript(() => {
  const BIG = 1e9;
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = BIG; p.hp = BIG; }
    } catch { /* not up yet */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.bringToFront();

// ---- READINESS (the gate that has bitten every agent on this project) ----
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
  const w = window;
  if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
  return (w.__ph || 0) >= 12;
}, { timeout: 120000, polling: 100 }).catch(() => {});
await page.waitForTimeout(3000);

const loadingBox = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { w: r.width, h: r.height, display: cs.display, opacity: cs.opacity };
});
if (loadingBox && loadingBox.w > 0 && loadingBox.display !== "none" && Number(loadingBox.opacity) > 0.01) {
  console.error("BOOT CARD STILL UP — MISSED:", JSON.stringify(loadingBox));
  await browser.close(); process.exit(1);
}
console.log("loading card:", loadingBox ? "present but inert" : "absent");

const gameGpu = await page.evaluate(() => {
  try {
    const ctx = window.__dcc.renderer.renderer.getContext();
    const d = ctx.getExtension("WEBGL_debug_renderer_info");
    return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch (e) { return `ERR ${e.message}`; }
});
console.log("GAME CONTEXT GPU:", gameGpu);
if (/SwiftShader|Software|llvmpipe/i.test(gameGpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }
if (!/Intel/i.test(gameGpu)) console.warn("!! NOT the integrated Intel part — the budget is written against the iGPU");

// ---- stage: walk so streamed dressing is resident, then ring the crowd ----
await page.keyboard.down("w"); await page.waitForTimeout(2000); await page.keyboard.up("w");
const staged = await page.evaluate((ring) => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
  const spots = [];
  for (let ri = 0; ri < 6 && spots.length < ring; ri++) {
    const r = 1.6 + ri * 0.85;
    for (let k = 0; k < 18 && spots.length < ring; k++) {
      const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.hp = m.maxHp || m.hp; m.dormant = false; });
  return { placed: used.length, liveTotal: live.length, totalMonsters: st.monsters.length };
}, ring);
console.log("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2500);

// ---- instrumentation: per-pass submit cost + draw-call census by object ----
const instrumented = await page.evaluate(() => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  gl.info.autoReset = false;
  const acc = { calls: 0, tris: 0, frames: 0, upd: [], ren: [] };
  window.__acc = acc;
  const origUpdate = r3d.update.bind(r3d);
  r3d.update = function (...a) { const t = performance.now(); origUpdate(...a); acc.upd.push(performance.now() - t); };
  const origRender = r3d.render.bind(r3d);
  r3d.render = function () {
    const t = performance.now();
    gl.info.reset();
    origRender();
    acc.ren.push(performance.now() - t);
    acc.calls += gl.info.render.calls; acc.tris += gl.info.render.triangles; acc.frames++;
  };
  const passes = r3d.composer?.passes ?? [];
  const stats = passes.map((p, i) => ({ i, name: p.constructor?.name ?? "?", enabled: p.enabled, ms: 0, calls: 0, n: 0 }));
  window.__passStats = stats;
  passes.forEach((p, i) => {
    const orig = p.render.bind(p);
    p.render = function (...a) {
      const c0 = gl.info.render.calls; const t0 = performance.now();
      orig(...a);
      stats[i].ms += performance.now() - t0; stats[i].calls += gl.info.render.calls - c0; stats[i].n++;
    };
  });
  // WHO ISSUES THE CALLS. renderBufferDirect is the single funnel every draw
  // in three.js passes through — shadow depth pass, GTAO's normal re-render and
  // every fullscreen post quad included.
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
  return { passes: stats.map((s) => `${s.i}:${s.name}${s.enabled ? "" : "(off)"}`) };
});
console.log("passes:", instrumented.passes.join(" -> "));

// ---- scene census -------------------------------------------------------
const scene = await page.evaluate(() => {
  const r3d = window.__dcc.renderer;
  const st = window.__dcc.state;
  let objs = 0, meshes = 0, skinned = 0, instanced = 0, lights = 0, visMesh = 0, autoMtx = 0;
  const mats = new Set(), geos = new Set();
  r3d.scene.traverse((o) => {
    objs++;
    if (o.matrixAutoUpdate) autoMtx++;
    if (o.isMesh) { meshes++; if (o.visible) visMesh++; }
    if (o.isSkinnedMesh) skinned++;
    if (o.isInstancedMesh) instanced++;
    if (o.isLight) lights++;
    if (o.material) for (const m of [].concat(o.material)) mats.add(m.uuid);
    if (o.geometry) geos.add(o.geometry.uuid);
  });
  const p = st.players[0];
  return {
    objects: objs, meshes, visibleMeshes: visMesh, skinned, instanced, lights,
    materials: mats.size, geometries: geos.size, autoUpdatingMatrices: autoMtx,
    simMonsters: st.monsters.length,
    liveMonsters: st.monsters.filter((m) => m.hp > 0).length,
    monsterMeshes: r3d.monsters?.size ?? null,
    visibleMonsterMeshes: [...(r3d.monsters?.values?.() ?? [])].filter((m) => m.visible).length,
    riggedMonsterMeshes: [...(r3d.monsters?.values?.() ?? [])].filter((m) => m.userData?.mixer).length,
    riggedVisible: [...(r3d.monsters?.values?.() ?? [])].filter((m) => m.visible && m.userData?.mixer).length,
    propEntries: r3d.propEntries?.length ?? null,
    visibleProps: (r3d.propEntries ?? []).filter((e) => e.obj.visible).length,
    near10: st.monsters.filter((m) => m.hp > 0 && !m.dormant && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length,
    preset: r3d.qualityProfile?.name, pixelRatioCap: r3d.qualityProfile?.pixelRatioCap,
    backbuffer: { w: r3d.renderer.domElement.width, h: r3d.renderer.domElement.height },
    dmgElements: document.querySelectorAll(".dmg").length,
    plateElements: document.querySelectorAll("[class*='plate'],[class*='mobbar'],[class*='nameplate']").length,
  };
});
console.log("SCENE:", JSON.stringify(scene, null, 1));

// ------------------------------------------------------------------ profile
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: intervalUs });

await page.evaluate(() => {
  const acc = window.__acc; acc.calls = 0; acc.tris = 0; acc.frames = 0; acc.upd.length = 0; acc.ren.length = 0;
  for (const s of window.__passStats) { s.ms = 0; s.calls = 0; s.n = 0; }
  window.__census.clear();
  window.__fts = [];
  let last = performance.now();
  const t = () => { const n = performance.now(); window.__fts.push(n - last); last = n; window.__raf = requestAnimationFrame(t); };
  window.__raf = requestAnimationFrame(t);
});

const load0 = probeLoad();
await cdp.send("Profiler.start");
// keep the fight alive across the window
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(750);
}
const { profile } = await cdp.send("Profiler.stop");
const load1 = probeLoad();
const foreign = foreignLoadPct(load0, load1);

const post = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf);
  const acc = window.__acc;
  const f = [...window.__fts].filter((x) => x > 0).sort((a, b) => a - b);
  const q = (p) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(2) : 0);
  const med = (a) => (a.length ? +[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : 0);
  const st = window.__dcc.state;
  const p = st.players[0];
  const recap = document.getElementById("recap");
  let recapUp = false;
  if (recap) { const r = recap.getBoundingClientRect(); const cs = getComputedStyle(recap); recapUp = r.width > 0 && cs.display !== "none" && Number(cs.opacity) > 0.01; }
  return {
    frames: f.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: f.length ? +f[f.length - 1].toFixed(2) : 0,
    callsPerFrame: acc.frames ? Math.round(acc.calls / acc.frames) : 0,
    ktrisPerFrame: acc.frames ? Math.round(acc.tris / acc.frames / 1000) : 0,
    composedFrames: acc.frames,
    cpuUpdateMedian: med(acc.upd), cpuRenderMedian: med(acc.ren),
    cpuUpdateP95: acc.upd.length ? +[...acc.upd].sort((a, b) => a - b)[Math.floor(acc.upd.length * 0.95)].toFixed(2) : 0,
    passStats: window.__passStats,
    census: [...window.__census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
    playerHp: p.hp, recapUp,
    near10: st.monsters.filter((m) => m.hp > 0 && !m.dormant && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length,
  };
});

await page.screenshot({ path: `${outDir}/profile_scene.png` });

const { flat, incl, bucket, totalUs } = crunch(profile);
const frames = Math.max(1, post.composedFrames);
const perFrame = (us) => (us / 1000 / frames).toFixed(2);

console.log(`\n==== SCENE VALID: ${post.playerHp > 0 && !post.recapUp ? "OK" : "*** MISSED ***"}  hp=${post.playerHp} recap=${post.recapUp} near10=${post.near10}`);
console.log(`FOREIGN BROWSER LOAD DURING THE PROFILE: ${foreign}% of the box` +
  (foreign > 3 ? "  <-- CONTAMINATED: absolute ms/frame are INFLATED; use the RANKING, not the magnitudes" : "  (clean)"));
console.log(`frames ${post.frames} | median ${post.medianMs} p95 ${post.p95Ms} p99 ${post.p99Ms} max ${post.maxMs} ms`);
console.log(`calls/frame ${post.callsPerFrame} | ktris ${post.ktrisPerFrame} | cpuUpdate ${post.cpuUpdateMedian} (p95 ${post.cpuUpdateP95}) | cpuRender ${post.cpuRenderMedian}`);

console.log("\n--- COMPOSER PASSES (CPU submit ms/frame, draw calls/frame) -------");
for (const s of post.passStats.filter((x) => x.n > 0).sort((a, b) => b.ms - a.ms)) {
  console.log(`${(s.ms / frames).toFixed(2).padStart(7)}ms ${(s.calls / frames).toFixed(0).padStart(6)} calls  #${s.i} ${s.name}`);
}

console.log("\n--- DRAW CALLS BY OBJECT (calls/frame, top 30) --------------------");
for (const [k, n] of post.census) console.log(`${(n / frames).toFixed(1).padStart(8)}  ${k}`);

console.log("\n--- BUCKETS (ms/frame) -------------------------------------------");
for (const [b, us] of [...bucket].sort((a, b2) => b2[1] - a[1])) {
  console.log(`${perFrame(us).padStart(7)}  ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${b}`);
}

console.log(`\n--- SELF TIME (ms/frame), top ${topN} ----------------------------`);
for (const [k, us] of flat.slice(0, topN)) console.log(`${perFrame(us).padStart(7)} ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${k}`);

console.log(`\n--- INCLUSIVE TIME (ms/frame), top ${topN} -----------------------`);
const inclArr = [...incl].sort((a, b) => b[1] - a[1]).slice(0, topN);
for (const [k, us] of inclArr) console.log(`${perFrame(us).padStart(7)} ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${k}`);

writeFileSync(`${outDir}/profile.json`, JSON.stringify({
  url, gameGpu, staged, scene, post, foreignLoadPct: foreign, load0, load1,
  seconds, frames, buckets: [...bucket], self: flat.slice(0, 200), incl: inclArr,
}, null, 2));
console.log(`\nWROTE ${outDir}/profile.json`);
await browser.close();
