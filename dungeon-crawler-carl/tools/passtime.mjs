// PER-PASS GPU TIMER. Answers "how many ms does each composer pass cost at the
// REAL resolution" directly, instead of inferring it from ablation deltas.
//
// Method: every pass object in the live EffectComposer has its .render wrapped
// with performance.now() + gl.finish(). finish() drains the GL pipeline, so the
// time attributed to a pass is that pass's own GPU work, not the async queue.
// This SERIALISES the frame (total will exceed the un-instrumented frame time
// by a few ms), so read the SHARES and the relative magnitudes as truth and the
// sum as an upper bound. Crucially every pass is measured inside the SAME frame,
// so scene drift and machine noise from other agents scale all rows together
// instead of corrupting one config relative to another.
//
// Additionally wraps:
//   shadow   - WebGLShadowMap.render (the depth-only shadow passes)
//   gtaoNorm - GTAOPass.renderOverride (its FULL second scene pass with the
//              normal material — this is a whole extra geometry submission)
//
// Nothing in src/ is touched: reached via window.__dcc.renderer on the
// production bundle.
//
// Usage: node tools/passtime.mjs [--seconds 6] [--dpr 2] [--scale 1] [--config name]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1");
const seconds = Number(flag("--seconds", 6));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const scale = Number(flag("--scale", 1));
const config = flag("--config", "base");
const mode = flag("--mode", "idle");

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
console.log("GPU:", gpu, `| ${width}x${height} @dpr${dpr} scale${scale} => ${Math.round(width * dpr * scale)}x${Math.round(height * dpr * scale)}`);
if (/SwiftShader|Software/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(3000);

await page.evaluate(({ scale, config }) => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  if (scale !== 1) R.setRenderScale(scale);
  const s = () => ({ w: comp._width * comp._pixelRatio, h: comp._height * comp._pixelRatio });

  // --- optional pre-config so the same instrument can time a candidate preset
  const CFG = {
    base() {},
    gtao_half() { const { w, h } = s(); R.gtao.setSize(w / 2, h / 2); },
    gtao_half_s6() { const { w, h } = s(); R.gtao.setSize(w / 2, h / 2); R.gtao.updateGtaoMaterial({ samples: 6 }); R.gtao.updatePdMaterial({ samples: 4 }); },
    gtao_off() { R.gtao.enabled = false; },
    bloom_half() { const { w, h } = s(); R.bloom.setSize(w / 2, h / 2); },
    bloom_quarter() { const { w, h } = s(); R.bloom.setSize(w / 4, h / 4); },
    bloom_off() { R.bloom.enabled = false; },
    msaa_off() { for (const rt of [comp.renderTarget1, comp.renderTarget2]) { rt.samples = 0; rt.dispose(); } },
    fx_off() { for (const o of [R.fxp, R.swingArcs, R.ribbons, R.decals, R.shocks, R.ambientFx]) if (o && o.group) o.group.visible = false; if (R.fogBank) R.fogBank.group.visible = false; },
    shadow_off() { gl.shadowMap.enabled = false; },
    shadow_1024() { R.key.shadow.mapSize.set(1024, 1024); if (R.key.shadow.map) { R.key.shadow.map.dispose(); R.key.shadow.map = null; } },
    balanced() {
      const { w, h } = s();
      R.gtao.setSize(w / 2, h / 2); R.gtao.updateGtaoMaterial({ samples: 6 }); R.gtao.updatePdMaterial({ samples: 4 });
      R.bloom.setSize(w / 4, h / 4);
      for (const rt of [comp.renderTarget1, comp.renderTarget2]) { rt.samples = 0; rt.dispose(); }
      R.key.shadow.mapSize.set(1024, 1024); if (R.key.shadow.map) { R.key.shadow.map.dispose(); R.key.shadow.map = null; }
    },
  };
  (CFG[config] || CFG.base)();

  const ctx = gl.getContext();
  const rows = []; // one object per frame: { name: ms }
  let cur = null;
  const wrap = (obj, key, name) => {
    const orig = obj[key].bind(obj);
    obj[key] = function (...a) {
      const t = performance.now();
      const out = orig(...a);
      ctx.finish();
      if (cur) cur[name] = (cur[name] || 0) + (performance.now() - t);
      return out;
    };
    return () => { obj[key] = orig; };
  };

  const names = ["render", "gtao", "bloom", "output", "grade"];
  comp.passes.forEach((p, i) => {
    const n = p.constructor.name.replace("Pass", "").replace("World", "") || names[i] || `pass${i}`;
    wrap(p, "render", `${i}_${n}`);
  });
  wrap(gl.shadowMap, "render", "shadowMap");
  if (R.gtao.renderOverride) wrap(R.gtao, "renderOverride", "  gtaoNormalPass(scene re-render)");

  if (comp.copyPass) wrap(comp.copyPass, "render", "composer_copyPass");
  // setRenderTarget is where three resolves a multisampled RT (blitFramebuffer)
  // and where it lazily (re)allocates framebuffers - both are invisible to the
  // per-pass wrappers because they happen on the transitions between them.
  {
    const orig = gl.setRenderTarget.bind(gl);
    gl.setRenderTarget = function (...a) {
      const t = performance.now();
      const out = orig(...a);
      ctx.finish();
      if (cur) cur["setRenderTarget(incl MSAA resolve)"] = (cur["setRenderTarget(incl MSAA resolve)"] || 0) + (performance.now() - t);
      return out;
    };
  }

  const origComposerRender = comp.render.bind(comp);
  comp.render = function (...a) {
    cur = {};
    const t0 = performance.now();
    ctx.finish();
    cur["_preFinish(leftover queue)"] = performance.now() - t0;
    const t = performance.now();
    const out = origComposerRender(...a);
    ctx.finish();
    cur.TOTAL_composer = performance.now() - t;
    rows.push(cur);
    cur = null;
    return out;
  };

  window.__pt = {
    rows,
    info: gl.info,
    size: s(),
    reset() { rows.length = 0; },
  };
}, { scale, config });

if (mode === "combat") for (const k of ["Space", "q", "c", "f"]) await page.keyboard.press(k).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate((secs) => new Promise((resolve) => {
  window.__pt.reset();
  const info = window.__pt.info; info.autoReset = false; info.reset();
  const start = performance.now();
  const tick = () => {
    if (performance.now() - start < secs * 1000) requestAnimationFrame(tick);
    else {
      const rows = window.__pt.rows.slice(2); // drop warm-up frames
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const med = (a) => { const s2 = [...a].sort((x, y) => x - y); return +(s2[Math.floor(s2.length / 2)] || 0).toFixed(2); };
      const res = {};
      for (const k of keys) res[k] = med(rows.map((r) => r[k] || 0));
      info.autoReset = true;
      resolve({ frames: rows.length, size: window.__pt.size, callsPerFrame: Math.round(info.render.calls / Math.max(1, rows.length)), trisPerFrame: Math.round(info.render.triangles / Math.max(1, rows.length)), passes: res });
    }
  };
  requestAnimationFrame(tick);
}), seconds);

console.log(`\nframes=${out.frames} buffer=${Math.round(out.size.w)}x${Math.round(out.size.h)} (${(out.size.w * out.size.h / 1e6).toFixed(2)}Mpx) calls/frame=${out.callsPerFrame} tris/frame=${out.trisPerFrame}`);
const total = out.passes.TOTAL_composer || 0;
for (const [k, v] of Object.entries(out.passes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(38)} ${String(v).padStart(8)} ms  ${total ? ((v / total) * 100).toFixed(1).padStart(5) : ""}%`);
}
console.log("RESULT " + JSON.stringify({ config, dpr, scale, ...out }));
await browser.close();
