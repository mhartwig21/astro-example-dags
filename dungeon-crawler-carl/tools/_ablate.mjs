// WALL-CLOCK ABLATION LADDER, interleaved in ONE page session.
//
// Why not tools/passtime.mjs: that instrument calls gl.finish() between passes,
// and on ANGLE/D3D11 the FIRST finish() of a frame absorbs whatever the driver
// had queued, so it attributes the whole frame to whichever pass happens to
// sync first. It reported "shadowMap = 91% of the frame" and then disabling the
// shadow pass entirely changed the frame time by 3%. Attribution by ablation of
// wall-clock throughput cannot lie that way.
//
// Why one session: this box is noisy (other agents build/probe concurrently).
// Configs are applied and measured back-to-back in the same tab and the whole
// list is repeated --reps times, so drift scales every row together instead of
// corrupting one config relative to another. Report the MEDIAN of the reps.
//
// Usage: node tools/_ablate.mjs --url ... --seconds 4 --reps 3 [--mode combat]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5321/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1&eagerassets&quality=ultra");
const seconds = Number(flag("--seconds", 4));
const reps = Number(flag("--reps", 3));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const only = flag("--only", "");

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
console.log("GPU:", gpu, `| ${width}x${height} @dpr${dpr}`);
if (/SwiftShader|Software/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  const size = () => ({ w: Math.round(comp._width * comp._pixelRatio), h: Math.round(comp._height * comp._pixelRatio) });
  window.__cfg = {
    base() {},
    shadow_off() { gl.shadowMap.enabled = false; },
    gtao_off() { R.gtao.enabled = false; },
    bloom_off() { R.bloom.enabled = false; },
    smaa_off() { const p = comp.passes[comp.passes.length - 1]; p.enabled = false; },
    grade_off() { R.gradePass.enabled = false; },
    output_off() { for (const p of comp.passes) if (p.constructor.name.includes("Output") || p.toneMapping !== undefined) p.enabled = false; },
    post_all_off() { for (let i = 1; i < comp.passes.length; i++) comp.passes[i].enabled = false; },
    world_only() { for (let i = 1; i < comp.passes.length; i++) comp.passes[i].enabled = false; gl.shadowMap.enabled = false; },
    half_res() { R.setRenderScale(0.707); },
    quarter_res() { R.setRenderScale(0.5); },
    fx_off() { for (const o of [R.fxp, R.swingArcs, R.ribbons, R.decals, R.shocks, R.ambientFx]) if (o && o.group) o.group.visible = false; if (R.fogBank) R.fogBank.group.visible = false; },
    no_depth_tex() { for (const rt of [comp.renderTarget1, comp.renderTarget2]) { rt.depthTexture = null; rt.dispose(); } },
    // Is the world pass BANDWIDTH-bound on the RGBA16F (8 byte/px) surface?
    // LDR halves the write traffic. Colours will clip — this measures only.
    rt_ldr() { for (const rt of [comp.renderTarget1, comp.renderTarget2]) { rt.texture.type = 1009 /* UnsignedByteType */; rt.dispose(); } },
    // AO buffer scales: the AO march is already half-res; the DENOISE/upsample
    // (pd) pass is the one running at full 4.91 Mpx with 8 taps.
    gtao_dn_half() { const { w, h } = size(); R.gtao.setResolutionScales(0.5, 0.5); R.gtao.setSize(w, h); },
    gtao_dn_075() { const { w, h } = size(); R.gtao.setResolutionScales(0.5, 0.75); R.gtao.setSize(w, h); },
    gtao_ao_quarter() { const { w, h } = size(); R.gtao.setResolutionScales(0.25, 0.5); R.gtao.setSize(w, h); },
    gtao_s6() { R.gtao.updateGtaoMaterial({ samples: 6 }); R.gtao.updatePdMaterial({ samples: 4 }); },
    // Shadow cadence: the map persists between rebuilds, so skipping the pass
    // on odd frames IS what shadowInterval 2 does.
    shadow_int2() { window.__skipShadow = 2; },
    shadow_int3() { window.__skipShadow = 3; },
    // Forward-renderer light count: every point light is evaluated per fragment
    // in every lit program. Needs a long settle — flipping visibility changes
    // numPointLights, which recompiles.
    lights_none() {
      R.scene.traverse((o) => { if (o.isPointLight) o.visible = false; });
    },
    lights_half() {
      let i = 0;
      R.scene.traverse((o) => { if (o.isPointLight && (i++ % 2)) o.visible = false; });
    },
  };
  window.__reset = () => {
    const p = R.qualityProfile;
    R.gtao.setResolutionScales(p.gtaoScale, p.gtaoDenoiseScale);
    R.gtao.setSize(size().w, size().h);
    R.gtao.updateGtaoMaterial({ samples: p.gtaoSamples });
    R.gtao.updatePdMaterial({ samples: p.gtaoDenoiseSamples });
    window.__skipShadow = 1;
    R.scene.traverse((o) => { if (o.isPointLight) o.visible = true; });
    gl.shadowMap.enabled = true;
    R.gtao.enabled = R.qualityProfile.gtao;
    R.bloom.enabled = true;
    R.gradePass.enabled = true;
    for (const p of comp.passes) p.enabled = true;
    R.setRenderScale(1);
    for (const o of [R.fxp, R.swingArcs, R.ribbons, R.decals, R.shocks, R.ambientFx]) if (o && o.group) o.group.visible = true;
    if (R.fogBank) R.fogBank.group.visible = true;
  };
  window.__size = size;
  // Shadow-cadence hook, installed once. The map persists between rebuilds, so
  // skipping shadowMap.render on N-1 of every N frames is exactly what
  // QualityProfile.shadowInterval does.
  window.__skipShadow = 1;
  {
    const orig = gl.shadowMap.render.bind(gl.shadowMap);
    let n = 0;
    gl.shadowMap.render = function (...a) {
      if (n++ % (window.__skipShadow || 1) !== 0) return undefined;
      return orig(...a);
    };
  }
});

const measure = async (secs) => page.evaluate((s) => new Promise((res) => {
  const f = [];
  let last = performance.now();
  const t0 = last;
  const tick = () => {
    const now = performance.now();
    f.push(now - last); last = now;
    if (now - t0 < s * 1000) requestAnimationFrame(tick);
    else {
      const el = now - t0;
      f.sort((a, b) => a - b);
      res({
        n: f.length,
        median: +f[Math.floor(f.length / 2)].toFixed(2),
        mean: +(el / f.length).toFixed(2),
        p95: +f[Math.floor(f.length * 0.95)].toFixed(2),
        worst: +f[f.length - 1].toFixed(2),
      });
    }
  };
  requestAnimationFrame(tick);
}), secs);

const CONFIGS = only ? only.split(",") : [
  "base", "shadow_off", "gtao_off", "bloom_off", "smaa_off", "grade_off",
  "post_all_off", "world_only", "half_res", "quarter_res", "fx_off",
];

// Combat: hold an ability rotation going so the sample is not an empty room.
await page.keyboard.press("Space").catch(() => {});

const acc = {};
for (let r = 0; r < reps; r++) {
  for (const c of CONFIGS) {
    await page.evaluate((n) => { window.__reset(); window.__cfg[n](); }, c);
    // Long settle: the light-count configs change numPointLights, which forces
    // a program rebuild. That compile must land OUTSIDE the sample window.
    await page.waitForTimeout(c.startsWith("lights") ? 4000 : 900);
    for (const k of ["Space", "q", "c"]) await page.keyboard.press(k).catch(() => {});
    const m = await measure(seconds);
    (acc[c] ||= []).push(m);
    console.log(`rep${r} ${c.padEnd(14)} mean=${String(m.mean).padStart(7)} median=${String(m.median).padStart(7)} p95=${String(m.p95).padStart(7)} worst=${m.worst}`);
  }
}
await page.evaluate(() => window.__reset());

const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
console.log("\n--- MEDIAN OF REPS ---");
const baseMean = med(acc[CONFIGS[0]].map((x) => x.mean));
for (const c of CONFIGS) {
  const mm = med(acc[c].map((x) => x.mean));
  const md = med(acc[c].map((x) => x.median));
  const p95 = med(acc[c].map((x) => x.p95));
  const delta = (((mm - baseMean) / baseMean) * 100).toFixed(0);
  console.log(`${c.padEnd(14)} mean=${String(mm).padStart(7)}  median=${String(md).padStart(7)}  p95=${String(p95).padStart(7)}  vs base ${delta > 0 ? "+" : ""}${delta}%`);
}
console.log("RESULTJSON", JSON.stringify(Object.fromEntries(CONFIGS.map((c) => [c, med(acc[c].map((x) => x.mean))]))));
await browser.close();
