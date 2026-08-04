// PAYDOWN ABLATION — where does the frame actually go, on THIS build, in the
// WORST real scene, on the owner's Intel iGPU.
//
// Design notes, all of them learned the hard way on this box:
//
//  * ONE browser session. This laptop crashed under concurrent headless
//    shells, and a "before" from one session vs an "after" from another are two
//    different machines. Every config below is applied and measured back to
//    back in the same tab, and the whole list repeats --reps times so drift
//    scales every row together instead of corrupting one row relative to
//    another. Report the MEDIAN across reps.
//
//  * GPU TIMER QUERIES ARE THE PRIMARY NUMBER. A sibling workflow holds this
//    box at 60-99% CPU, so wall-clock is an upper bound at best.
//    EXT_disjoint_timer_query_webgl2 measures what the GPU spent executing a
//    command range, and drops any sample the driver flags disjoint.
//
//  * The frame is cut into NON-OVERLAPPING segments (timer queries cannot
//    nest): entering a nested region ends the enclosing query and starts a new
//    one. Per-label ms therefore SUM to the composed frame's GPU cost.
//
//  * Uncapped (vsync off) on purpose: this tool measures RELATIVE cost. With
//    vsync on, deltas quantize to the 8.33 ms panel quantum and small ones
//    vanish. The CONTRACT number is measured separately, vsync ON, by
//    tools/perfbaseline.mjs.
//
// Usage: node tools/paydown.mjs --port 5282 [--reps 3] [--seconds 2.2]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const reps = Number(flag("--reps", 3));
const seconds = Number(flag("--seconds", 2.2));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const ring = Number(flag("--ring", 18));
const outDir = flag("--out", "tools/_paydown");
const url = flag("--url", `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`);
mkdirSync(outDir, { recursive: true });

const foreignLimit = Number(flag("--foreignlimit", 3));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Keep-alive before any page script: dropped in at floor 17 the crawler dies to
// a beam trap ~1.5 s in, and every sample would then describe the death card.
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

const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
console.log("GPU:", gpu, `| ${width}x${height} @dpr${dpr}`);
if (/SwiftShader|Software|llvmpipe/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

// READINESS: data-assets-settled is NOT playable — the boot card is still up
// while shader precompile and the PMREM bake run behind it.
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
  console.error("BOOT CARD STILL UP — MISSED"); await browser.close(); process.exit(1);
}

const gameGpu = await page.evaluate(() => {
  try {
    const ctx = window.__dcc.renderer.renderer.getContext();
    const d = ctx.getExtension("WEBGL_debug_renderer_info");
    return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch (e) { return `ERR ${e.message}`; }
});
console.log("GAME CONTEXT GPU:", gameGpu);
if (!/Intel/i.test(gameGpu)) console.warn("!! NOT the integrated Intel part — the budget is written against the iGPU");

// Walk so streamed dressing is live, then stage the crowd.
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
  return { placed: used.length, liveTotal: live.length };
}, ring);
console.log("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2500);

// ---- install the harness: segmented GPU timers + ablation switches ----
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  const ctx = gl.getContext();
  const ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
  const PASS_LABEL = ["1_Render", "3_GTAO", "4_Bloom", "5_Output", "6_Grade", "7_SMAA"];
  let curLabel = null, active = null, frameIdx = 0;
  const pending = [];
  let perFrame = new Map();
  const endActive = () => { if (!active) return; ctx.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; };
  const mark = (label) => {
    endActive(); curLabel = label;
    if (!label) return;
    const q = ctx.createQuery();
    ctx.beginQuery(ext.TIME_ELAPSED_EXT, q);
    active = { q, label, f: frameIdx };
  };
  const drain = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i];
      if (!ctx.getQueryParameter(e.q, ctx.QUERY_RESULT_AVAILABLE)) continue;
      const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = ctx.getQueryParameter(e.q, ctx.QUERY_RESULT);
      ctx.deleteQuery(e.q); pending.splice(i, 1);
      if (disjoint) continue;
      let row = perFrame.get(e.f);
      if (!row) { row = {}; perFrame.set(e.f, row); }
      row[e.label] = (row[e.label] || 0) + ns / 1e6;
    }
  };
  const region = (obj, key, label) => {
    const orig = obj[key].bind(obj);
    obj[key] = function (...a) {
      const prev = curLabel;
      if (prev !== null) mark(label);
      try { return orig(...a); } finally { if (prev !== null) mark(prev); }
    };
  };
  comp.passes.forEach((p, i) => region(p, "render", PASS_LABEL[i] || `pass${i}`));
  region(gl.shadowMap, "render", "0_shadow");
  if (R.gtao && R.gtao.renderOverride) region(R.gtao, "renderOverride", "2_GTAO_gbuf");
  const wall = [];
  let lastT = 0;
  // JS-side cost of the host's own update and render. GPU timer queries cannot
  // see this, and on an idle box it is ~14 ms of the frame (upd 6.2 + ren 8.5 on
  // the worst scene) against a ~14 ms GPU frame — so CPU, not fill, is what the
  // budget is actually spent on here.
  const upd = [], ren = [];
  const origUpdate = R.update.bind(R);
  R.update = function (...a) { const t = performance.now(); origUpdate(...a); upd.push(performance.now() - t); };
  const origHostRender = R.render.bind(R);
  R.render = function (...a) { const t = performance.now(); origHostRender(...a); ren.push(performance.now() - t); };
  const origRender = comp.render.bind(comp);
  comp.render = function (...a) {
    const t = performance.now();
    if (lastT) wall.push(t - lastT);
    lastT = t;
    mark("_overhead");
    try { return origRender(...a); } finally { mark(null); frameIdx++; drain(); }
  };

  // ---------- ablation switches ----------
  // Every switch is REVERSIBLE and touches only host-side presentation.
  const saved = {};
  const A = {
    base() { /* nothing */ },
    // Point lights: the forward renderer bakes the scene's light count into
    // every lit program, so this also answers "what does the light COUNT cost".
    nolights() {
      saved.lights = [];
      R.scene.traverse((o) => {
        if (o.isPointLight && o.visible) { saved.lights.push(o); o.visible = false; }
      });
    },
    // Props: cloned glTF Object3Ds under floorGroup (the census says ~94 main
    // + 51 shadow draw calls for ~65k triangles).
    noprops() {
      saved.props = [];
      for (const e of R.propEntries || []) if (e.obj.visible) { saved.props.push(e.obj); e.obj.visible = false; }
    },
    nomonsters() {
      saved.mons = [];
      for (const m of R.monsters.values()) if (m.visible) { saved.mons.push(m); m.visible = false; }
    },
    noshadow() { saved.sm = gl.shadowMap.enabled; gl.shadowMap.enabled = false; },
    nogtao() { saved.gtao = R.gtao.enabled; R.gtao.enabled = false; },
    nosmaa() {
      saved.post = [];
      comp.passes.forEach((p, i) => { if (i >= 5 && p.enabled) { saved.post.push(p); p.enabled = false; } });
    },
    // The whole r1 SPEND, from uniforms (surface detail relief/cavity/roughness
    // to zero AND the world scale to zero so the fetch is cache-served, plus
    // the atmosphere radiance to black). This is what the previous round added.
    nospend() {
      saved.det = {};
      for (const k of ["floor", "wall", "prop", "canopy"]) { saved.det[k] = R.wlDet[k].clone(); R.wlDet[k].set(0, 0, 0, 0); }
      saved.atmo = R.wl.uWlAtmo.value.clone();
      R.wl.uWlAtmo.value.setRGB(0, 0, 0);
    },
    // Fill: halve the backbuffer. Answers "is this fragment-bound".
    halfres() { saved.pr = gl.getPixelRatio(); gl.setPixelRatio(saved.pr * 0.707); },
    // STATIC MATRICES. Nothing in src/render3d sets matrixAutoUpdate=false, so
    // three.js recomposes position/quaternion/scale into a matrix for EVERY
    // object every frame — and the floor group alone holds ~1150 prop meshes
    // that never move. This probe answers "what would freezing them be worth"
    // before anyone writes the real thing.
    nopropmatrix() {
      saved.mtx = [];
      R.floorGroup.traverse((o) => {
        if (o.matrixAutoUpdate) { saved.mtx.push(o); o.updateMatrix(); o.matrixAutoUpdate = false; }
      });
    },
    // THE PAYDOWN CHANGE ITSELF, put back the way it was. Restores three.js's
    // default matrixAutoUpdate everywhere this build now freezes it: the scene
    // root, the floor group (props + instanced chunks) and every monster rig.
    // Paired against base inside ONE session this prices the change without
    // asking two different machine states — which is exactly what defeated a
    // cross-session before/after here: the same scene, same 621 draw calls,
    // read 14.9 ms GPU early in the session and 21.2 ms after two full test
    // suites had heated the package.
    oldmatrix() {
      saved.old = [];
      saved.oldScene = R.scene.matrixAutoUpdate;
      R.scene.matrixAutoUpdate = true;
      const thaw = (o) => { if (!o.matrixAutoUpdate) { saved.old.push(o); o.matrixAutoUpdate = true; } };
      R.floorGroup.traverse(thaw);
      for (const m of R.monsters.values()) { m.traverse(thaw); m.userData.mtxLive = undefined; }
    },
    // The per-frame loop in updateFogTint that writes visible+scale on every one
    // of the ~920 prop entries whether or not its fog alpha moved.
    nofogproploop() {
      saved.fog = R.updateFogTint.bind(R);
      R.updateFogTint = function (state, px, pz) {
        const entries = R.propEntries; R.propEntries = [];
        try { return saved.fog(state, px, pz); } finally { R.propEntries = entries; }
      };
    },
  };
  const RESTORE = {
    base() {},
    nolights() { for (const o of saved.lights || []) o.visible = true; },
    noprops() { for (const o of saved.props || []) o.visible = true; },
    nomonsters() { for (const o of saved.mons || []) o.visible = true; },
    noshadow() { gl.shadowMap.enabled = saved.sm; },
    nogtao() { R.gtao.enabled = saved.gtao; },
    nosmaa() { for (const p of saved.post || []) p.enabled = true; },
    nospend() {
      for (const k of ["floor", "wall", "prop", "canopy"]) R.wlDet[k].copy(saved.det[k]);
      R.wl.uWlAtmo.value.copy(saved.atmo);
    },
    halfres() { gl.setPixelRatio(saved.pr); },
    nopropmatrix() { for (const o of saved.mtx || []) o.matrixAutoUpdate = true; },
    oldmatrix() {
      for (const o of saved.old || []) o.matrixAutoUpdate = false;
      R.scene.matrixAutoUpdate = saved.oldScene;
      for (const m of R.monsters.values()) m.userData.mtxLive = undefined;
    },
    nofogproploop() { R.updateFogTint = saved.fog; },
  };

  window.__pd = {
    apply(name) { A[name](); },
    restore(name) { RESTORE[name](); },
    reset() { perFrame = new Map(); wall.length = 0; lastT = 0; frameIdx = 0; upd.length = 0; ren.length = 0; },
    harvest() {
      const rows = [...perFrame.values()].filter((r) => Object.keys(r).length >= 3);
      const keys = [...new Set(rows.flatMap(Object.keys))].sort();
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0; };
      const out = {};
      for (const k of keys) out[k] = med(rows.map((r) => r[k] || 0));
      out.TOTAL = med(rows.map((r) => Object.values(r).reduce((a, b) => a + b, 0)));
      const w = wall.filter((x) => x > 0);
      return {
        gpu: out, gpuFrames: rows.length,
        wallMedian: med(w), wallFrames: w.length,
        cpuUpdate: med(upd), cpuRender: med(ren),
        calls: gl.info.render.calls, tris: gl.info.render.triangles,
      };
    },
  };
});

const CONFIGS = ["oldmatrix"];
const only = flag("--only", "");
const LIST = only ? only.split(",") : CONFIGS;

const loadBefore = probeLoad();
console.log("box load BEFORE:", JSON.stringify(loadBefore));

// ---- ADJACENT-PAIR DIFFERENCING, and it is load-bearing.
//
// The first version of this ran every config once per rep in a fixed order and
// reported the median of the reps. On a box whose load drifts monotonically
// during the run, that attributes the drift to whichever config sits late in
// the list: it reported "disabling SMAA makes RenderPass 11 ms cheaper", which
// is impossible — a post pass cannot change the cost of the scene pass that
// runs before it. The number was the sibling workflow going quiet.
//
// So each config is measured as a BASE/CONFIG pair taken back to back, and the
// estimate is the MEDIAN OF THE PER-PAIR DIFFERENCES. Drift between pairs
// cancels; only drift WITHIN a ~4 s pair survives, and that shows up as spread
// in the MAD rather than as a fake effect.
const sample = async (cfg) => {
  if (cfg !== "base") await page.evaluate((c) => window.__pd.apply(c), cfg);
  await page.waitForTimeout(450); // driver settle + any program rebuild
  await page.evaluate(() => window.__pd.reset());
  await page.waitForTimeout(seconds * 1000);
  const r = await page.evaluate(() => window.__pd.harvest());
  if (cfg !== "base") await page.evaluate((c) => window.__pd.restore(c), cfg);
  return r;
};

const pairs = {};
const baseSamples = [];
for (const c of LIST) pairs[c] = [];

// Each PAIR is additionally gated on a quiet box and thrown away if a foreign
// browser worked during it. Pairing already cancels slow drift; the gate is what
// stops a sibling that spikes for four seconds from landing inside one pair and
// being reported as that subsystem's cost.
let discarded = 0;
for (let rep = 0; rep < reps; rep++) {
  for (const cfg of LIST) {
    let d = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitForIdle(`rep${rep} ${cfg} pair`, { limitPct: foreignLimit });
      const p0 = probeLoad();
      const b0 = await sample("base");
      const c0 = await sample(cfg);
      const p1 = probeLoad();
      const fl = foreignLoadPct(p0, p1);
      if (fl !== null && fl > foreignLimit) {
        discarded++;
        console.warn(`rep${rep} ${cfg.padEnd(11)} DISCARDED — foreign browsers burned ${fl}% of the box during the pair`);
        continue;
      }
      baseSamples.push(b0);
      d = {
        total: +(c0.gpu.TOTAL - b0.gpu.TOTAL).toFixed(2),
        render: +((c0.gpu["1_Render"] ?? 0) - (b0.gpu["1_Render"] ?? 0)).toFixed(2),
        wall: +(c0.wallMedian - b0.wallMedian).toFixed(2),
        cpuUpd: +(c0.cpuUpdate - b0.cpuUpdate).toFixed(2),
        cpuRen: +(c0.cpuRender - b0.cpuRender).toFixed(2),
        baseTotal: b0.gpu.TOTAL, cfgTotal: c0.gpu.TOTAL, foreignLoadPct: fl,
      };
      break;
    }
    if (!d) { console.warn(`rep${rep} ${cfg} — no clean pair in 3 attempts, skipping`); continue; }
    pairs[cfg].push(d);
    console.log(`rep${rep} ${cfg.padEnd(11)} base ${String(d.baseTotal).padStart(6)} -> ${String(d.cfgTotal).padStart(6)}  dTotal ${String(d.total).padStart(7)}  dRender ${String(d.render).padStart(7)}  dWall ${String(d.wall).padStart(7)}  foreign ${d.foreignLoadPct}%`);
  }
}
console.log(`\npairs discarded to contamination: ${discarded}`);

// Verify the scene was gameplay for the whole run, not a death card.
const claim = await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const recap = document.getElementById("recap");
  let recapUp = false;
  if (recap) {
    const r = recap.getBoundingClientRect();
    const cs = getComputedStyle(recap);
    recapUp = r.width > 0 && cs.display !== "none" && Number(cs.opacity) > 0.01;
  }
  const near = st.monsters.filter((m) => m.hp > 0 && !m.dormant
    && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length;
  return { playerHp: p.hp, recapUp, monstersNear10: near, monstersLive: st.monsters.filter((m) => m.hp > 0).length };
});
const loadAfter = probeLoad();
console.log("box load AFTER:", JSON.stringify(loadAfter));
console.log("SCENE:", JSON.stringify(claim), claim.playerHp > 0 && !claim.recapUp ? "OK" : "*** MISSED ***");

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0; };
// Median absolute deviation: the honest way to say "how far can this number be
// trusted" on a box whose load is not ours to control. An effect smaller than
// its own MAD is NOT RESOLVABLE and must be reported as such, not as a win.
const mad = (a) => { const m = med(a); return med(a.map((x) => Math.abs(x - m))); };

const summary = {};
for (const c of LIST) {
  const t = pairs[c].map((p) => p.total);
  const r = pairs[c].map((p) => p.render);
  const w = pairs[c].map((p) => p.wall);
  const cu = pairs[c].map((p) => p.cpuUpd);
  const cr = pairs[c].map((p) => p.cpuRen);
  summary[c] = {
    dTotal: med(t), dTotalMad: mad(t),
    dRender: med(r), dRenderMad: mad(r),
    dWall: med(w),
    dCpuUpdate: med(cu), dCpuUpdateMad: mad(cu),
    dCpuRender: med(cr), dCpuRenderMad: mad(cr),
    n: t.length,
    resolvable: Math.abs(med(t)) > mad(t),
  };
}
const baseTotals = baseSamples.map((b) => b.gpu.TOTAL);
console.log(`\nBASE, all ${baseTotals.length} interleaved samples: median ${med(baseTotals)} ms GPU, MAD ${mad(baseTotals)}, range ${Math.min(...baseTotals)}..${Math.max(...baseTotals)}`);
console.log("\n=== PAIRED A/B, median of per-pair differences (negative = this subsystem COSTS that much) ===");
console.log("config          dGpuTotal  (MAD)  dRenderPass  (MAD)   dCpuUpd  (MAD)   dCpuRen  (MAD)    dWall");
for (const c of LIST) {
  const s = summary[c];
  console.log(
    c.padEnd(15) +
    String(s.dTotal).padStart(8) + String(s.dTotalMad).padStart(7) +
    String(s.dRender).padStart(13) + String(s.dRenderMad).padStart(7) +
    String(s.dCpuUpdate).padStart(10) + String(s.dCpuUpdateMad).padStart(7) +
    String(s.dCpuRender).padStart(10) + String(s.dCpuRenderMad).padStart(7) +
    String(s.dWall).padStart(9),
  );
}
console.log("\nA row whose |median| is smaller than its own MAD is NOT RESOLVABLE on this box today; say so rather than banking it.");
writeFileSync(`${outDir}/paydown.json`, JSON.stringify({ url, gpu, gameGpu, staged, claim, loadBefore, loadAfter, reps, seconds, pairs, baseTotals, summary }, null, 2));
await page.screenshot({ path: `${outDir}/scene.png` });
console.log(`\nWROTE ${outDir}/paydown.json`);
await browser.close();
