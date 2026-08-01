// FILL-RATE / PASS-ABLATION PROBE.
//
// Same real-GPU setup as gpuprobe.mjs (headed Chromium, ANGLE D3D11, vsync off,
// real display 1440x852 @ dpr 2 => 2880x1704 backbuffer) but instead of one
// number per run it cycles a list of RUNTIME ablations against a single loaded
// page and reports ms per configuration.
//
// Nothing in src/ is edited: every knob below is reached through the live
// Renderer3D instance on window.__dcc.renderer (TS `private` is compile-time
// only, the fields are ordinary JS properties at runtime). That means these
// numbers come from the SHIPPED production bundle, not a scratch build.
//
// Configs are sampled INTERLEAVED and repeated (A,B,C,A,B,C,...) so machine
// drift from other agents hits every configuration equally; the reported number
// per config is the median across reps of the per-rep median frame time.
//
// Usage:
//   node tools/fillprobe.mjs --configs base,gtao_off,bloom_off --reps 3 --seconds 3
//   node tools/fillprobe.mjs --list
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const url = flag("--url", "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1");
const seconds = Number(flag("--seconds", 3));
const reps = Number(flag("--reps", 3));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const mode = flag("--mode", "idle"); // idle | combat
const configs = flag("--configs", "base").split(",").map((s) => s.trim()).filter(Boolean);

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
console.log("GPU:", gpu, `| ${width}x${height} @dpr${dpr} => ${width * dpr}x${height * dpr}`);
if (!/Intel|D3D11|NVIDIA|AMD/.test(gpu) || /SwiftShader|Software/i.test(gpu)) {
  console.error("REFUSING: not a real GPU:", gpu); await browser.close(); process.exit(1);
}

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(3000);

// KEEP-ALIVE. Without this the parked test crawler is dead inside ~15s and every
// later sample is really "static scene behind the death card" - which silently
// zeroes the combat-FX rows. Topping hp up from the debug hook keeps a real
// fight (and its particle load) running for the whole session.
if (has("--immortal")) {
  await page.evaluate(() => {
    setInterval(() => {
      const s = window.__dcc && window.__dcc.state;
      if (!s) return;
      for (const p of s.players) p.hp = p.maxHp;
    }, 100);
  });
}

// ---- in-page ablation kit ----
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  const size = () => ({ w: comp._width * comp._pixelRatio, h: comp._height * comp._pixelRatio });
  const fxGroups = () => [R.fxp, R.swingArcs, R.ribbons, R.decals, R.shocks, R.ambientFx]
    .map((o) => o && o.group).filter(Boolean);

  const K = {
    R, gl, comp,
    origComposerRender: comp.render.bind(comp),
    origShadowSize: R.key.shadow.mapSize.clone(),
    origBloomStrength: R.bloom.strength,
    origBlend: R.gtao.blendIntensity,
    origPasses: comp.passes.slice(),
    origGtaoSamples: R.gtao.gtaoMaterial.defines.SAMPLES,
    origPdSamples: R.gtao.pdSamples,
    reset() {
      comp.render = K.origComposerRender;
      comp.passes.length = 0;
      comp.passes.push(...K.origPasses);
      R.gtao.enabled = true;
      R.bloom.enabled = true;
      R.gradePass.enabled = true;
      R.bloom.strength = K.origBloomStrength;
      R.gtao.blendIntensity = K.origBlend;
      const { w, h } = size();
      R.gtao.setSize(w, h);
      R.bloom.setSize(w, h);
      R.gtao.updateGtaoMaterial({ samples: K.origGtaoSamples });
      R.gtao.updatePdMaterial({ samples: K.origPdSamples });
      gl.shadowMap.enabled = true;
      // SHIPPED STATE (step 1): autoUpdate is OFF and Renderer3D.render() arms
      // exactly one rebuild per composed frame. Restoring `true` here — as this
      // file used to — silently re-enables a shadow rebuild inside every one of
      // the ~20 internal renders a composed frame makes, i.e. it measures a
      // build nobody ships. Reset to what the constructor actually sets.
      gl.shadowMap.autoUpdate = false;
      if (R.key.shadow.mapSize.x !== K.origShadowSize.x) {
        R.key.shadow.mapSize.copy(K.origShadowSize);
        if (R.key.shadow.map) { R.key.shadow.map.dispose(); R.key.shadow.map = null; }
      }
      for (const g of fxGroups()) g.visible = true;
      if (R.fogBank) R.fogBank.group.visible = true;
      for (const rt of [comp.renderTarget1, comp.renderTarget2]) {
        if (rt.texture.type !== 1016) { rt.texture.type = 1016; rt.dispose(); } // HalfFloatType
      }
      // QUALITY-LADDER BUILDS (src/render3d/quality.ts): the preset owns MSAA,
      // the AO/bloom buffer scales, the shadow map and the pixel-ratio cap, so
      // resetting them one field at a time would fight it. Restore through the
      // preset API and let it re-derive everything. Older builds without the
      // ladder fall back to the hand-rolled restore.
      if (typeof R.setQuality === "function") R.setQuality("ultra");
      else K.setMsaa(4);
      R.setRenderScale(1);
    },
    setMsaa(n) {
      for (const rt of [comp.renderTarget1, comp.renderTarget2]) {
        if (rt && rt.samples !== n) { rt.samples = n; rt.dispose(); }
      }
    },
    setShadow(px) {
      if (px === 0) { gl.shadowMap.enabled = false; return; }
      gl.shadowMap.enabled = true;
      R.key.shadow.mapSize.set(px, px);
      if (R.key.shadow.map) { R.key.shadow.map.dispose(); R.key.shadow.map = null; }
    },
    fxOff() { for (const g of fxGroups()) g.visible = false; },
    fogOff() { if (R.fogBank) R.fogBank.group.visible = false; },
    size,
  };
  window.__fp = K;
});

const APPLY = {
  base: () => {},
  // --- GTAO ---
  gtao_off: (K) => { K.R.gtao.enabled = false; },
  gtao_half: (K) => { const s = K.size(); K.R.gtao.setSize(s.w / 2, s.h / 2); },
  gtao_quarter: (K) => { const s = K.size(); K.R.gtao.setSize(s.w / 4, s.h / 4); },
  gtao_s6: (K) => { K.R.gtao.updateGtaoMaterial({ samples: 6 }); },
  gtao_half_s6: (K) => { const s = K.size(); K.R.gtao.setSize(s.w / 2, s.h / 2); K.R.gtao.updateGtaoMaterial({ samples: 6 }); K.R.gtao.updatePdMaterial({ samples: 4 }); },
  gtao_nogbuf: (K) => { K.R.gtao._renderGBuffer = false; }, // skips the FULL scene normal re-render
  // --- Bloom ---
  bloom_off: (K) => { K.R.bloom.enabled = false; },
  bloom_half: (K) => { const s = K.size(); K.R.bloom.setSize(s.w / 2, s.h / 2); },
  bloom_quarter: (K) => { const s = K.size(); K.R.bloom.setSize(s.w / 4, s.h / 4); },
  // --- misc post ---
  grade_off: (K) => { K.R.gradePass.enabled = false; },
  msaa_off: (K) => { K.setMsaa(0); },
  msaa2: (K) => { K.setMsaa(2); },
  no_gtao_no_bloom: (K) => { K.R.gtao.enabled = false; K.R.bloom.enabled = false; },
  post_off: (K) => {
    K.comp.render = () => { K.gl.setRenderTarget(null); K.gl.render(K.R.scene, K.R.camera); };
  },
  // --- shadows ---
  shadow_off: (K) => K.setShadow(0),
  shadow_1024: (K) => K.setShadow(1024),
  shadow_512: (K) => K.setShadow(512),
  shadow_static: (K) => { K.gl.shadowMap.autoUpdate = false; },
  shadow_off_1024: (K) => { K.setShadow(1024); K.gl.shadowMap.autoUpdate = false; },
  // --- transparents / overdraw ---
  fx_off: (K) => K.fxOff(),
  fog_off: (K) => K.fogOff(),
  fx_fog_off: (K) => { K.fxOff(); K.fogOff(); },
  // --- stacking on top of the MSAA fix (the dominant lever) ---
  m0: (K) => K.setMsaa(0),
  m0_gtaohalf: (K) => { K.setMsaa(0); const s = K.size(); K.R.gtao.setSize(s.w / 2, s.h / 2); },
  m0_gtaooff: (K) => { K.setMsaa(0); K.R.gtao.enabled = false; },
  m0_gtaooff_shadow1k: (K) => { K.setMsaa(0); K.R.gtao.enabled = false; K.setShadow(1024); },
  m0_gtaooff_shadowoff: (K) => { K.setMsaa(0); K.R.gtao.enabled = false; K.setShadow(0); },
  m0_gtaooff_bloomoff: (K) => { K.setMsaa(0); K.R.gtao.enabled = false; K.R.bloom.enabled = false; },
  m0_fxoff: (K) => { K.setMsaa(0); K.fxOff(); K.fogOff(); },
  // _renderGBuffer=false keeps GTAO's fill cost but skips its FULL second scene
  // pass, isolating "GTAO's extra 480 draw calls" from "GTAO's pixel cost".
  m0_gtaonogbuf: (K) => { K.setMsaa(0); K.R.gtao._renderGBuffer = false; },
  m0_gtaohalf_s6: (K) => { K.setMsaa(0); const s = K.size(); K.R.gtao.setSize(s.w / 2, s.h / 2); K.R.gtao.updateGtaoMaterial({ samples: 6 }); K.R.gtao.updatePdMaterial({ samples: 4 }); },
  m0_bloomoff: (K) => { K.setMsaa(0); K.R.bloom.enabled = false; },
  m0_bloomquarter: (K) => { K.setMsaa(0); const s = K.size(); K.R.bloom.setSize(s.w / 4, s.h / 4); },
  m0_fogoff: (K) => { K.setMsaa(0); K.fogOff(); },
  m0_partoff: (K) => { K.setMsaa(0); K.fxOff(); },
  // Render scale IS the pixel-ratio policy: dpr2 + scale 0.5 gives byte-for-byte
  // the same backbuffer as capping setPixelRatio at 1.
  scale075: (K) => K.R.setRenderScale(0.75),
  scale050: (K) => K.R.setRenderScale(0.5),
  m0_scale100: (K) => { K.setMsaa(0); K.R.setRenderScale(1); },
  m0_scale075: (K) => { K.setMsaa(0); K.R.setRenderScale(0.75); },
  m0_scale050: (K) => { K.setMsaa(0); K.R.setRenderScale(0.5); },
  // Is the MSAA cliff about SAMPLES, or about a multisampled HALF-FLOAT target?
  // 8 bytes/px x 4 samples x 4.9Mpx = 157 MB of shared memory traffic per frame
  // on an iGPU. Swapping the type to RGBA8 (2 bytes/px) isolates bandwidth.
  msaa4_rgba8: (K) => {
    for (const rt of [K.comp.renderTarget1, K.comp.renderTarget2]) { rt.texture.type = 1009; rt.samples = 4; rt.dispose(); }
  },
  msaa0_rgba8: (K) => {
    for (const rt of [K.comp.renderTarget1, K.comp.renderTarget2]) { rt.texture.type = 1009; rt.samples = 0; rt.dispose(); }
  },
  // Dropping RT MSAA means a POST AA has to replace it. We cannot import SMAA
  // into the page, but the grade pass is exactly the right proxy: one fullscreen
  // LDR shader over the whole 4.9Mpx buffer. Re-running it N extra times prices
  // "one more fullscreen pass", which is what FXAA (1) / SMAA (~3) cost.
  m0_grade_x2: (K) => { K.setMsaa(0); K.comp.passes.push(K.R.gradePass); },
  m0_grade_x4: (K) => { K.setMsaa(0); for (let i = 0; i < 3; i++) K.comp.passes.push(K.R.gradePass); },
  // --- the SHIPPED preset ladder (src/render3d/quality.ts) ---
  // These drive the real API, so what they measure is what a player gets when
  // they pick that row in the SYSTEM menu — including the pixel-ratio cap,
  // which the hand-rolled configs below could only approximate via renderScale.
  Q_ultra: (K) => K.R.setQuality("ultra"),
  Q_high: (K) => K.R.setQuality("high"),
  Q_balanced: (K) => K.R.setQuality("balanced"),
  Q_performance: (K) => K.R.setQuality("performance"),
  // ULTRA minus SMAA, to price the AA pass on its own.
  Q_ultra_noaa: (K) => { K.R.setQuality("ultra"); K.R.smaa.enabled = false; },
  // ULTRA with the OLD 4x MSAA target back on top, i.e. the pre-ladder build.
  Q_ultra_msaa4: (K) => { K.R.setQuality("ultra"); K.setMsaa(4); },

  // --- the proposed preset ladder (pre-implementation ablations) ---
  P_ultra_today: () => {},
  P_ultra: (K) => { K.setMsaa(0); },
  P_high: (K) => {
    K.setMsaa(0); const s = K.size();
    K.R.gtao.setSize(s.w / 2, s.h / 2); K.R.gtao.updateGtaoMaterial({ samples: 8 }); K.R.gtao.updatePdMaterial({ samples: 6 });
    K.R.bloom.setSize(s.w / 2, s.h / 2);
  },
  P_balanced: (K) => {
    K.setMsaa(0); const s = K.size();
    K.R.gtao.enabled = false;
    K.R.bloom.setSize(s.w / 2, s.h / 2); K.setShadow(1024);
  },
  P_performance: (K) => {
    K.setMsaa(0); K.R.gtao.enabled = false; K.setShadow(1024);
    K.R.setRenderScale(0.75);
    const s = K.size(); K.R.bloom.setSize(s.w / 2, s.h / 2);
    K.fogOff();
  },
};

if (has("--list")) { console.log(Object.keys(APPLY).join("\n")); await browser.close(); process.exit(0); }

const applyIn = async (name) => {
  await page.evaluate((n) => {
    const K = window.__fp;
    K.reset();
    // eslint-disable-next-line no-eval
    (window.__applyMap[n])(K);
  }, name);
};
// ship the apply functions into the page once
await page.evaluate((src) => {
  window.__applyMap = {};
  for (const [k, v] of Object.entries(src)) window.__applyMap[k] = new Function("K", `return (${v})(K);`);
}, Object.fromEntries(Object.entries(APPLY).map(([k, v]) => [k, v.toString()])));

const setScale = async (s) => { await page.evaluate((v) => window.__dcc.renderer.setRenderScale(v), s); };
const scale = Number(flag("--scale", 1));
if (scale !== 1) await setScale(scale);

const sample = async () => page.evaluate((secs) => new Promise((resolve) => {
  const info = window.__fp.gl.info;
  info.autoReset = false;
  info.reset();
  const frames = [];
  let last = performance.now();
  const start = last;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (now - start < secs * 1000) requestAnimationFrame(tick);
    else {
      const n = frames.length;
      const elapsed = now - start;
      frames.sort((a, b) => a - b);
      const q = (p) => +frames[Math.min(n - 1, Math.floor(n * p))].toFixed(2);
      // MEAN IS THE HEADLINE, NOT THE MEDIAN. vsync and the frame-rate limiter
      // are both off, so rAF runs ahead of the GPU and queues cheap frames
      // until the swap chain fills, then blocks for a long one. The frame-time
      // distribution is BIMODAL and the median only samples the cheap mode —
      // it will happily report 10 ms on a configuration delivering 24 fps.
      // Wall-clock throughput cannot be gamed that way.
      const r = {
        n, mean: +(elapsed / n).toFixed(2), fps: +((n * 1000) / elapsed).toFixed(1),
        med: q(0.5), p90: q(0.90), p95: q(0.95), worst: +frames[n - 1].toFixed(0),
        calls: Math.round(info.render.calls / n), tris: Math.round(info.render.triangles / n),
      };
      info.autoReset = true;
      resolve(r);
    }
  };
  requestAnimationFrame(tick);
}), seconds);

const results = {};
for (const c of configs) results[c] = [];

for (let rep = 0; rep < reps; rep++) {
  for (const c of configs) {
    await applyIn(c);
    if (scale !== 1) await setScale(scale); // reset() does not touch render scale, but resize might
    if (mode === "combat") {
      for (const k of ["Space", "q", "c", "f"]) await page.keyboard.press(k).catch(() => {});
    }
    await page.waitForTimeout(900); // let the swap settle / shaders compile
    const r = await sample();
    results[c].push(r);
    console.log(`rep${rep} ${c.padEnd(18)} ${JSON.stringify(r)}`);
  }
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
console.log("\n=== MEDIAN OF REPS — mean ms is the headline, see sample() ===");
const base = results[configs[0]] ? med(results[configs[0]].map((r) => r.mean)) : null;
const summary = {};
for (const c of configs) {
  const mean = med(results[c].map((r) => r.mean));
  const fps = med(results[c].map((r) => r.fps));
  const m = med(results[c].map((r) => r.med));
  const p95 = med(results[c].map((r) => r.p95));
  const calls = med(results[c].map((r) => r.calls));
  summary[c] = { mean, fps, med: m, p95, calls, deltaVsFirst: base ? +(mean - base).toFixed(2) : null, pct: base ? +(((mean - base) / base) * 100).toFixed(1) : null };
  console.log(`${c.padEnd(18)} mean=${String(mean).padStart(7)} fps=${String(fps).padStart(6)}  med=${String(m).padStart(6)}  p95=${String(p95).padStart(7)}  calls=${String(calls).padStart(5)}  delta=${String(summary[c].deltaVsFirst).padStart(7)}  (${summary[c].pct}%)`);
}
console.log("RESULT " + JSON.stringify({ url, mode, width, height, dpr, scale, summary }));
await browser.close();
