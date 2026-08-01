// DRAW-CALL EXPERIMENT RIG. Toggles one scene-graph / pass variable at a time
// on a LIVE production build and measures the real-GPU frame time delta, so
// "N draw calls removed" can be priced in milliseconds instead of guessed.
//
// Every variant is applied at runtime (no rebuild): pass.enabled, shadowMap
// flags, object visibility. Configs are measured in an interleaved A/B/A/B
// order and the MEDIAN of repeats is reported, because this box is noisy.
//
// Usage: node tools/dcexp.mjs "<url>" [--seconds 5] [--reps 3] [--w 1440] [--h 852] [--dpr 2]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 5));
const reps = Number(flag("--reps", 3));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const only = flag("--only", null);

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);
if (!/Intel|D3D11/i.test(gpu)) { console.error("NOT A REAL GPU CONTEXT — refusing to report timings"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2500);
// Walk into the dressed part of the floor and pull a fight, then stay there.
await page.keyboard.down("w"); await page.waitForTimeout(2200); await page.keyboard.up("w");
for (const k of ["Space", "q", "e", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(100); }
await page.waitForTimeout(800);

await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const scene = R.scene;
  const passes = R.composer.passes;
  const gtao = R.gtao;
  const saved = {};

  const collect = (pred) => { const out = []; scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh || o.isSprite || o.isPoints) && pred(o)) out.push(o); }); return out; };
  const fieldRoots = (name) => {
    const v = R[name];
    const out = [];
    if (!v) return out;
    const take = (e) => {
      if (!e || typeof e !== "object") return;
      if (e.isObject3D) { out.push(e); return; }
      for (const s of Object.values(e)) if (s && s.isObject3D) out.push(s);
    };
    if (v instanceof Map) for (const e of v.values()) take(e);
    else if (Array.isArray(v)) for (const e of v) take(e);
    else take(v);
    return out;
  };

  // Count draw calls for the CURRENT config by hooking one composer frame.
  let counting = false, callCount = 0;
  const origRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (...a) { if (counting) callCount++; return origRBD(...a); };
  const origRender = R.composer.render.bind(R.composer);
  R.composer.render = function (...a) {
    if (window.__exp && window.__exp._wantCount) { window.__exp._wantCount = false; counting = true; callCount = 0; const r = origRender(...a); counting = false; window.__exp._lastCalls = callCount; return r; }
    return origRender(...a);
  };

  const variants = {
    baseline: () => {},
    // --- pass-level ---
    noShadowPass: () => { gl.shadowMap.autoUpdate = false; },      // keeps the last shadow map, skips 1 full scene redraw
    shadowOff: () => { gl.shadowMap.enabled = false; },            // no shadow map at all (relights everything)
    shadow1024: () => { R.key.shadow.mapSize.set(1024, 1024); R.key.shadow.map?.dispose(); R.key.shadow.map = null; },
    noGtaoGBuffer: () => { gtao._renderGBuffer = false; },         // keeps AO math, skips the scene re-render
    gtaoOff: () => { gtao.enabled = false; },
    bloomOff: () => { for (const p of passes) if (/Bloom/i.test(p.constructor.name) || p === R.bloom) p.enabled = false; },
    postOff: () => { gtao.enabled = false; if (R.bloom) R.bloom.enabled = false; },
    // --- scene-graph-level ---
    monstersHidden: () => { for (const o of fieldRoots("monsters")) o.visible = false; },
    monstersNoShadow: () => { for (const o of fieldRoots("monsters")) o.traverse((c) => { c.castShadow = false; }); },
    propsNoShadow: () => { R.floorGroup.children.forEach((c) => { if (!c.isInstancedMesh) c.traverse((o) => { o.castShadow = false; }); }); },
    propsHidden: () => { R.floorGroup.children.forEach((c) => { if (!c.isInstancedMesh) c.visible = false; }); },
    foliageHidden: () => { R.floorGroup.children.forEach((c) => { if (c.isInstancedMesh && c.castShadow && c.geometry && !c.geometry.parameters) c.visible = false; }); },
    onlyGroundShadows: () => { scene.traverse((o) => { if (o.castShadow) o.castShadow = false; }); for (const o of fieldRoots("monsters")) o.traverse((c) => { if (c.isMesh) c.castShadow = true; }); for (const o of fieldRoots("playerMeshes")) o.traverse((c) => { if (c.isMesh) c.castShadow = true; }); },
    noShadowCasters: () => { scene.traverse((o) => { if (o.castShadow) o.castShadow = false; }); },
    // combined ceiling probe: what is actually left if draw submission stops mattering
    everythingOff: () => { gtao.enabled = false; if (R.bloom) R.bloom.enabled = false; gl.shadowMap.enabled = false; },
  };

  window.__exp = {
    _wantCount: false, _lastCalls: 0,
    list: Object.keys(variants),
    snapshot() {
      saved.shadowEnabled = gl.shadowMap.enabled;
      saved.shadowAuto = gl.shadowMap.autoUpdate;
      saved.shadowSize = [R.key.shadow.mapSize.x, R.key.shadow.mapSize.y];
      saved.gbuf = gtao._renderGBuffer;
      saved.passEnabled = passes.map((p) => p.enabled);
      saved.vis = []; saved.cast = [];
      scene.traverse((o) => { saved.vis.push([o, o.visible]); saved.cast.push([o, !!o.castShadow]); });
    },
    restore() {
      gl.shadowMap.enabled = saved.shadowEnabled;
      gl.shadowMap.autoUpdate = saved.shadowAuto;
      if (R.key.shadow.mapSize.x !== saved.shadowSize[0]) { R.key.shadow.mapSize.set(...saved.shadowSize); R.key.shadow.map?.dispose(); R.key.shadow.map = null; }
      gtao._renderGBuffer = saved.gbuf;
      passes.forEach((p, i) => { p.enabled = saved.passEnabled[i]; });
      for (const [o, v] of saved.vis) o.visible = v;
      for (const [o, c] of saved.cast) o.castShadow = c;
      gl.shadowMap.needsUpdate = true;
    },
    apply(name) { this.restore(); variants[name](); gl.shadowMap.needsUpdate = true; },
    calls() { this._wantCount = true; return new Promise((res) => { const t = () => { if (!this._wantCount) res(this._lastCalls); else requestAnimationFrame(t); }; requestAnimationFrame(t); }); },
    measure(secs) {
      return new Promise((resolve) => {
        const frames = []; let last = performance.now(); const start = last;
        const tick = () => {
          const now = performance.now(); frames.push(now - last); last = now;
          if (now - start < secs * 1000) requestAnimationFrame(tick);
          else { frames.sort((a, b) => a - b); resolve({ n: frames.length, median: +frames[frames.length >> 1].toFixed(2), p95: +frames[Math.floor(frames.length * 0.95)].toFixed(2) }); }
        };
        requestAnimationFrame(tick);
      });
    },
  };
  window.__exp.snapshot();
});

const names = only ? only.split(",") : await page.evaluate(() => window.__exp.list);
const results = {};
for (const n of names) results[n] = { med: [], calls: null };

for (let r = 0; r < reps; r++) {
  for (const n of names) {
    await page.evaluate((v) => window.__exp.apply(v), n);
    await page.waitForTimeout(500); // settle: let the new config's programs compile
    if (r === 0) results[n].calls = await page.evaluate(() => window.__exp.calls());
    const m = await page.evaluate((s) => window.__exp.measure(s), seconds);
    results[n].med.push(m.median);
    process.stdout.write(`rep${r} ${n}: ${m.median}ms (p95 ${m.p95})\n`);
  }
}
await page.evaluate(() => window.__exp.restore());

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const base = med(results[names[0]].med);
console.log("\n=== RESULT (median of reps, real GPU, %dx%d @dpr%d) ===", width, height, dpr);
console.log("variant".padEnd(20), "medMs".padStart(8), "calls".padStart(7), "dVsBase".padStart(9), "reps");
for (const n of names) {
  const m = med(results[n].med);
  console.log(n.padEnd(20), String(m).padStart(8), String(results[n].calls).padStart(7),
    String((+(m - base).toFixed(2))).padStart(9), " ", results[n].med.join(","));
}
await browser.close();
