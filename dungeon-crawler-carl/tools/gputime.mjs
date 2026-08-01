// REAL GPU TIME PER PASS, via EXT_disjoint_timer_query_webgl2.
//
// Why this and not frame-time ablation: this box runs several agents at once and
// sits pinned at 100% CPU, so wall-clock frame times swing 2-3x between runs and
// ablation deltas are unusable. A GL timer query measures the time the GPU
// itself spent executing a command range - it does not care that the CPU is
// oversubscribed. Numbers from this tool are stable to a few percent run to run.
//
// The frame is cut into NON-OVERLAPPING segments (timer queries cannot nest):
// entering a nested region ends the enclosing segment's query and starts a new
// one, and leaving it resumes the enclosing label. Per-label ms therefore sum to
// the GPU cost of the whole composer frame.
//
// Segments: shadowMap / RenderPass(scene) / GTAO normal re-render / GTAO
// (AO + denoise + composite) / Bloom / OutputPass / Grade.
//
// Reads the live Renderer3D from window.__dcc.renderer - src/ is never edited,
// so these are the SHIPPED production bundle's costs.
//
// Usage:
//   node tools/gputime.mjs                       # native 2880x1704, stock chain
//   node tools/gputime.mjs --config gtao_half --scale 0.75 --dpr 2
//   node tools/gputime.mjs --dpr 1               # what a non-HiDPI machine pays
//   node tools/gputime.mjs --config fx_off --mode combat
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1");
const seconds = Number(flag("--seconds", 8));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const scale = Number(flag("--scale", 1));
const mode = flag("--mode", "idle");
const configs = flag("--config", "base").split(",").map((s) => s.trim());

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);
if (/SwiftShader|Software/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(3000);

// ---------- install the segment timer ----------
const installed = await page.evaluate(({ scale }) => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  const ctx = gl.getContext();
  const ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) return { ok: false };
  if (scale !== 1) R.setRenderScale(scale);

  const PASS_LABEL = ["1_RenderPass(scene)", "3_GTAO(ao+denoise+blend)", "4_Bloom", "5_OutputPass", "6_Grade"];

  let curLabel = null;
  let active = null;
  const pending = [];
  let frameIdx = 0;
  const perFrame = new Map(); // frameIdx -> {label: ns}

  const endActive = () => {
    if (!active) return;
    ctx.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(active);
    active = null;
  };
  const mark = (label) => {
    endActive();
    curLabel = label;
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
      ctx.deleteQuery(e.q);
      pending.splice(i, 1);
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
  region(gl.shadowMap, "render", "0_shadowMap");
  if (R.gtao.renderOverride) region(R.gtao, "renderOverride", "2_GTAO_normal_re-render(geometry)");

  const origRender = comp.render.bind(comp);
  const wall = [];
  comp.render = function (...a) {
    const t = performance.now();
    mark("_composer_overhead");
    try { return origRender(...a); } finally {
      mark(null);
      wall.push(performance.now() - t);
      frameIdx++;
      drain();
    }
  };

  const size = () => ({ w: comp._width * comp._pixelRatio, h: comp._height * comp._pixelRatio });
  // Snapshot every knob the config list can move, so multi-config runs in one
  // session start from a clean stock chain instead of stacking ablations.
  const STOCK = {
    shadow: R.key.shadow.mapSize.clone(),
    bloomS: R.bloom.strength,
    blend: R.gtao.blendIntensity,
    gtaoSamples: R.gtao.gtaoMaterial.defines.SAMPLES,
    pdSamples: R.gtao.pdSamples,
    samples: comp.renderTarget1.samples,
  };
  window.__gt = {
    perFrame, wall, R, gl, comp, size,
    restore() {
      R.setRenderScale(scale); // undo any scale_* config from a previous sample
      R.gtao.enabled = true; R.bloom.enabled = true; R.gradePass.enabled = true;
      R.gtao._renderGBuffer = true;
      R.bloom.strength = STOCK.bloomS; R.gtao.blendIntensity = STOCK.blend;
      const z = size();
      R.gtao.setSize(z.w, z.h); R.bloom.setSize(z.w, z.h);
      R.gtao.updateGtaoMaterial({ samples: STOCK.gtaoSamples });
      R.gtao.updatePdMaterial({ samples: STOCK.pdSamples });
      for (const rt of [comp.renderTarget1, comp.renderTarget2]) if (rt.samples !== STOCK.samples) { rt.samples = STOCK.samples; rt.dispose(); }
      gl.shadowMap.enabled = true; gl.shadowMap.autoUpdate = true;
      if (R.key.shadow.mapSize.x !== STOCK.shadow.x) {
        R.key.shadow.mapSize.copy(STOCK.shadow);
        if (R.key.shadow.map) { R.key.shadow.map.dispose(); R.key.shadow.map = null; }
      }
      for (const o of [R.fxp, R.swingArcs, R.ribbons, R.decals, R.shocks, R.ambientFx]) if (o && o.group) o.group.visible = true;
      if (R.fogBank) R.fogBank.group.visible = true;
    },
    reset() { perFrame.clear(); wall.length = 0; gl.info.autoReset = false; gl.info.reset(); },
  };
  return { ok: true };
}, { scale });
if (!installed.ok) { console.error("no EXT_disjoint_timer_query_webgl2"); await browser.close(); process.exit(1); }

const CFG = {
  base: "() => {}",
  gtao_off: "(R,gl,c,s)=>{R.gtao.enabled=false;}",
  gtao_half: "(R,gl,c,s)=>{const z=s();R.gtao.setSize(z.w/2,z.h/2);}",
  gtao_quarter: "(R,gl,c,s)=>{const z=s();R.gtao.setSize(z.w/4,z.h/4);}",
  gtao_half_s6: "(R,gl,c,s)=>{const z=s();R.gtao.setSize(z.w/2,z.h/2);R.gtao.updateGtaoMaterial({samples:6});R.gtao.updatePdMaterial({samples:4});}",
  gtao_s6: "(R,gl,c,s)=>{R.gtao.updateGtaoMaterial({samples:6});}",
  gtao_nogbuf: "(R,gl,c,s)=>{R.gtao._renderGBuffer=false;}",
  bloom_off: "(R,gl,c,s)=>{R.bloom.enabled=false;}",
  bloom_half: "(R,gl,c,s)=>{const z=s();R.bloom.setSize(z.w/2,z.h/2);}",
  bloom_quarter: "(R,gl,c,s)=>{const z=s();R.bloom.setSize(z.w/4,z.h/4);}",
  grade_off: "(R,gl,c,s)=>{R.gradePass.enabled=false;}",
  msaa_off: "(R,gl,c,s)=>{for(const rt of [c.renderTarget1,c.renderTarget2]){rt.samples=0;rt.dispose();}}",
  msaa2: "(R,gl,c,s)=>{for(const rt of [c.renderTarget1,c.renderTarget2]){rt.samples=2;rt.dispose();}}",
  shadow_off: "(R,gl,c,s)=>{gl.shadowMap.enabled=false;}",
  shadow_1024: "(R,gl,c,s)=>{R.key.shadow.mapSize.set(1024,1024);if(R.key.shadow.map){R.key.shadow.map.dispose();R.key.shadow.map=null;}}",
  shadow_512: "(R,gl,c,s)=>{R.key.shadow.mapSize.set(512,512);if(R.key.shadow.map){R.key.shadow.map.dispose();R.key.shadow.map=null;}}",
  shadow_static: "(R,gl,c,s)=>{gl.shadowMap.autoUpdate=false;}",
  fx_off: "(R,gl,c,s)=>{for(const o of [R.fxp,R.swingArcs,R.ribbons,R.decals,R.shocks,R.ambientFx]) if(o&&o.group) o.group.visible=false;}",
  fog_off: "(R,gl,c,s)=>{if(R.fogBank) R.fogBank.group.visible=false;}",
  fx_fog_off: "(R,gl,c,s)=>{for(const o of [R.fxp,R.swingArcs,R.ribbons,R.decals,R.shocks,R.ambientFx]) if(o&&o.group) o.group.visible=false; if(R.fogBank) R.fogBank.group.visible=false;}",
  // Render scale == pixel-ratio policy: dpr2+scale0.5 and dpr1+scale1.0 produce
  // the IDENTICAL 1440x852 backbuffer, so these rows also measure capping
  // setPixelRatio.
  scale_100: "(R,gl,c,s)=>{R.setRenderScale(1);}",
  scale_085: "(R,gl,c,s)=>{R.setRenderScale(0.85);}",
  scale_075: "(R,gl,c,s)=>{R.setRenderScale(0.75);}",
  scale_050: "(R,gl,c,s)=>{R.setRenderScale(0.5);}",
  // candidate presets
  high: "(R,gl,c,s)=>{const z=s();R.gtao.setSize(z.w/2,z.h/2);R.gtao.updateGtaoMaterial({samples:8});R.gtao.updatePdMaterial({samples:6});R.bloom.setSize(z.w/2,z.h/2);}",
  balanced: "(R,gl,c,s)=>{const z=s();R.gtao.setSize(z.w/2,z.h/2);R.gtao.updateGtaoMaterial({samples:6});R.gtao.updatePdMaterial({samples:4});R.bloom.setSize(z.w/4,z.h/4);for(const rt of [c.renderTarget1,c.renderTarget2]){rt.samples=0;rt.dispose();}R.key.shadow.mapSize.set(1024,1024);if(R.key.shadow.map){R.key.shadow.map.dispose();R.key.shadow.map=null;}}",
  perf: "(R,gl,c,s)=>{R.gtao.enabled=false;const z=s();R.bloom.setSize(z.w/4,z.h/4);for(const rt of [c.renderTarget1,c.renderTarget2]){rt.samples=0;rt.dispose();}R.key.shadow.mapSize.set(1024,1024);if(R.key.shadow.map){R.key.shadow.map.dispose();R.key.shadow.map=null;}gl.shadowMap.autoUpdate=false;}",
};

if (mode === "combat") for (const k of ["Space", "q", "c", "f"]) await page.keyboard.press(k).catch(() => {});

const runOne = async (cfgName) => {
  await page.evaluate(({ src }) => {
    const K = window.__gt;
    K.restore();
    // eslint-disable-next-line no-new-func
    new Function("R", "gl", "c", "s", `return (${src})(R,gl,c,s);`)(K.R, K.gl, K.comp, K.size);
    K.reset();
  }, { src: CFG[cfgName] || CFG.base });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__gt.reset());
  return page.evaluate((secs) => new Promise((res) => {
    const K = window.__gt;
    const start = performance.now();
    const tick = () => {
      if (performance.now() - start < secs * 1000) requestAnimationFrame(tick);
      else setTimeout(() => {
        const rows = [...K.perFrame.values()].filter((r) => Object.keys(r).length >= 3);
        const keys = [...new Set(rows.flatMap(Object.keys))].sort();
        const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0; };
        const out = {};
        for (const k of keys) out[k] = med(rows.map((r) => r[k] || 0));
        out["=GPU TOTAL"] = med(rows.map((r) => Object.values(r).reduce((a, b) => a + b, 0)));
        const w = [...K.wall].sort((a, b) => a - b);
        K.gl.info.autoReset = true;
        res({
          gpuFrames: rows.length,
          wallMedMs: w.length ? +w[Math.floor(w.length / 2)].toFixed(2) : 0,
          size: K.size(),
          calls: Math.round(K.gl.info.render.calls / Math.max(1, K.wall.length)),
          tris: Math.round(K.gl.info.render.triangles / Math.max(1, K.wall.length)),
          passes: out,
        });
      }, 300);
    };
    requestAnimationFrame(tick);
  }), seconds);
};

const all = {};
for (const c of configs) {
  const r = await runOne(c);
  all[c] = r;
  console.log(`\n--- ${c}  buffer=${Math.round(r.size.w)}x${Math.round(r.size.h)} (${(r.size.w * r.size.h / 1e6).toFixed(2)}Mpx) dpr=${dpr} scale=${scale}`);
  console.log(`    gpuFrames=${r.gpuFrames} wallMed=${r.wallMedMs}ms calls/frame=${r.calls} tris/frame=${r.tris}`);
  for (const [k, v] of Object.entries(r.passes)) console.log(`    ${k.padEnd(36)} ${String(v).padStart(7)} ms GPU`);
}
console.log("\nRESULT " + JSON.stringify({ dpr, scale, mode, all }));
await browser.close();
