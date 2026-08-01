// A/B/C matrix profiler. Measures N renderer configurations inside ONE page
// load so they share the same scene, the same compiled programs and the same
// machine weather — cross-run noise on this box is larger than most of the
// effects we are chasing, so separate runs cannot resolve them.
//
// For each config it reports:
//   frameMs   rAF-to-rAF interval (what the player feels)
//   jsMs      time INSIDE the rAF callback (main thread busy, incl. blocking GL)
//   gpuMs     gl.finish() drain measured on every Nth frame (GPU catch-up)
//   calls     true draw calls per composed frame (info.autoReset disabled)
//
// Usage: node tools/cpumatrix.mjs <url> [--secs 4] [--w 640] [--h 360] [--dpr 1]
//                                 [--reps 2]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const secs = Number(flag("--secs", 4));
const width = Number(flag("--w", 640));
const height = Number(flag("--h", 360));
const dpr = Number(flag("--dpr", 1));
const reps = Number(flag("--reps", 2));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return gl.getParameter(d.UNMASKED_RENDERER_WEBGL);
}), `| ${width * dpr}x${height * dpr}px`);
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2000);

// stage combat
await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w");
await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
for (const k of ["Space", "q", "e", "r", "c"]) await page.keyboard.press(k).catch(() => {});

// install the harness + config switchboard
const setup = await page.evaluate(() => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  const scene = r3d.scene;
  gl.info.autoReset = false;
  const H = { calls: 0, frames: 0, js: [], iv: [], gpu: [] };
  window.__H = H;
  const orig = r3d.render.bind(r3d);
  let lastT = performance.now();
  let n = 0;
  r3d.render = function () {
    const t0 = performance.now();
    H.iv.push(t0 - lastT);
    lastT = t0;
    window.__mwHook?.();
    window.__shHook?.();
    gl.info.reset();
    orig();
    const t1 = performance.now();
    H.js.push(t1 - t0);
    H.calls += gl.info.render.calls;
    H.frames++;
    // Drain the GL queue every 8th frame: the extra wall time is the GPU
    // backlog this frame's submission left behind.
    if ((n++ & 7) === 0) {
      const c = gl.getContext();
      c.finish();
      H.gpu.push(performance.now() - t1);
    }
  };
  // Census of the top-level scene graph so configs can target real groups.
  const top = scene.children.map((c) => {
    let k = 0; c.traverse(() => k++);
    return { name: c.name || c.type, n: k };
  }).sort((a, b) => b.n - a.n).slice(0, 14);
  return { top, passes: r3d.composer.passes.map((p) => p.constructor.name) };
});
console.log("TOP-LEVEL SCENE GROUPS:", JSON.stringify(setup.top));
console.log("PASSES:", JSON.stringify(setup.passes));

const ALL = {
  base: ["baseline", "0"],
  gtao: ["GTAO off", "__dcc.renderer.composer.passes[1].enabled=false"],
  bloom: ["bloom off", "__dcc.renderer.composer.passes[2].enabled=false"],
  gb: ["GTAO+bloom off", "__dcc.renderer.composer.passes[1].enabled=false,__dcc.renderer.composer.passes[2].enabled=false"],
  shadow: ["shadows off", "__dcc.renderer.renderer.shadowMap.enabled=false"],
  gbs: ["GTAO+bloom+shadow off", "__dcc.renderer.composer.passes[1].enabled=false,__dcc.renderer.composer.passes[2].enabled=false,__dcc.renderer.renderer.shadowMap.enabled=false"],
  hidden: ["scene hidden (traversal only)", "window.__hideAll(true)"],
  hiddenoff: ["all off + scene hidden", "__dcc.renderer.composer.passes[1].enabled=false,__dcc.renderer.composer.passes[2].enabled=false,__dcc.renderer.renderer.shadowMap.enabled=false,window.__hideAll(true)"],
  // ---- candidate fixes, measured not guessed -----------------------------
  shadowfreeze: ["shadowMap.autoUpdate=false", "window.__freezeShadow()"],
  novis: ["GTAO overrideVisibility stubbed", "window.__stubVis()"],
  nomwa: ["scene.matrixWorldAutoUpdate=false", "window.__manualMatrix()"],
  gtaohalf: ["GTAO prepass at 1/2 res", "window.__gtaoScale(0.5)"],
  nomwa2: ["matrixWorldAutoUpdate=false + 1 update/frame", "window.__manualMatrix()"],
  shadow2: ["shadow map every 2nd frame", "window.__shadowEvery(2)"],
  shadow4: ["shadow map every 4th frame", "window.__shadowEvery(4)"],
  best: ["shadow/2 + 1 matrix update/frame",
    "window.__shadowEvery(2),window.__manualMatrix()"],
  nocastdress: ["castShadow off on all InstancedMesh dressing", "window.__noCastInstanced()"],
  nocastsmall: ["castShadow off on <10-instance batches only", "window.__noCastSmall()"],
  combo: ["freeze shadow + no override-vis + manual matrix",
    "window.__freezeShadow(),window.__stubVis(),window.__manualMatrix()"],
};
const only = flag("--only", null);
const CONFIGS = only ? only.split(",").map((k) => ALL[k.trim()]).filter(Boolean) : Object.values(ALL);

await page.evaluate(() => {
  const scene = window.__dcc.renderer.scene;
  let saved = null;
  window.__hideAll = (on) => {
    if (on) {
      saved = scene.children.map((c) => c.visible);
      for (const c of scene.children) if (!c.isLight && !c.isCamera) c.visible = false;
    } else if (saved) {
      scene.children.forEach((c, i) => { c.visible = saved[i] ?? true; });
      saved = null;
    }
  };
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  const gtao = r3d.composer.passes[1];

  // --- candidate fixes, installed as reversible page-side patches ---------
  const origVis = gtao.overrideVisibility.bind(gtao);
  const origRestore = gtao.restoreVisibility?.bind(gtao);
  let stubbed = false, frozen = false, manual = false, scaled = 0;
  window.__freezeShadow = () => {
    gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true; frozen = true;
  };
  window.__stubVis = () => {
    gtao.overrideVisibility = () => {};
    if (origRestore) gtao.restoreVisibility = () => {};
    stubbed = true;
  };
  window.__manualMatrix = () => {
    scene.matrixWorldAutoUpdate = false;
    manual = true;
  };
  // With matrixWorldAutoUpdate off nothing would ever update, so drive it
  // ONCE per composed frame from the renderer wrapper instead of once per
  // scene-rendering WebGLRenderer.render() call (RenderPass + the GTAO
  // depth/normal prepass each trigger their own full traversal today).
  // NOTE: updateMatrixWorld() *without* force — passing true recomputes every
  // matrix unconditionally and measured WORSE than the default.
  window.__mwHook = () => { if (manual) scene.updateMatrixWorld(); };
  // Shadow cadence: re-render the shadow map every Nth frame instead of every
  // frame. Unlike a hard freeze this is shippable (moving shadows just update
  // at N/2 Hz), so it measures a real candidate fix.
  let sc = 0, sn = 0;
  window.__shadowEvery = (n) => {
    sn = n; gl.shadowMap.autoUpdate = false; frozen = true;
    window.__shHook = () => { if (sn) gl.shadowMap.needsUpdate = (sc++ % sn) === 0; };
  };
  // Shadow-caster diet. 1705 of 1935 meshes cast into a single directional
  // shadow map today; the instanced ground dressing is most of that count.
  let uncast = [];
  window.__noCastInstanced = () => {
    scene.traverse((o) => { if (o.isInstancedMesh && o.castShadow) { o.castShadow = false; uncast.push(o); } });
  };
  window.__noCastSmall = () => {
    scene.traverse((o) => { if (o.isInstancedMesh && o.castShadow && o.count < 10) { o.castShadow = false; uncast.push(o); } });
  };
  window.__gtaoScale = (s) => {
    const w = gl.domElement.width, h = gl.domElement.height;
    gtao.setSize?.(Math.round(w * s), Math.round(h * s));
    scaled = s;
  };
  window.__reset = () => {
    r3d.composer.passes.forEach((p) => { p.enabled = true; });
    gl.shadowMap.enabled = true;
    if (frozen) { gl.shadowMap.autoUpdate = true; gl.shadowMap.needsUpdate = true; frozen = false; sn = 0; window.__shHook = null; }
    if (stubbed) { gtao.overrideVisibility = origVis; if (origRestore) gtao.restoreVisibility = origRestore; stubbed = false; }
    if (manual) { scene.matrixWorldAutoUpdate = true; manual = false; }
    if (scaled) { gtao.setSize?.(gl.domElement.width, gl.domElement.height); scaled = 0; }
    for (const o of uncast) o.castShadow = true;
    uncast = [];
    window.__hideAll(false);
  };
});


const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

// PAIRED measurement. This box drifts hard (other agents running): inside one
// 3-rep sweep the SAME config measured first vs last differed by 2x, which
// systematically penalised whatever ran late in the list. So every config is
// measured immediately after a fresh baseline sample and reported as a RATIO
// against that adjacent baseline — the drift cancels out of the ratio.
async function measure(js) {
  await page.evaluate(() => window.__reset());
  if (js !== "0") await page.evaluate(`(()=>{${js.split(",").map((s) => s.trim()).join(";")};})()`);
  await page.waitForTimeout(500);
  await page.evaluate(() => { const H = window.__H; H.calls = 0; H.frames = 0; H.js = []; H.iv = []; H.gpu = []; });
  await page.waitForTimeout(secs * 1000);
  return page.evaluate(() => {
    const H = window.__H;
    const m = (a) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.floor(s.length / 2)] ?? 0).toFixed(2); };
    return { frames: H.frames, frameMs: m(H.iv), jsMs: m(H.js),
      calls: H.frames ? Math.round(H.calls / H.frames) : 0 };
  });
}

const results = new Map();
for (let r = 0; r < reps; r++) {
  for (const [name, js] of CONFIGS) {
    if (name === "baseline") continue;
    const b = await measure("0");
    const c = await measure(js);
    if (!results.has(name)) results.set(name, []);
    results.get(name).push({ b, c, ratio: c.frameMs / b.frameMs, jsRatio: c.jsMs / b.jsMs });
  }
  console.log(`-- rep ${r + 1}/${reps} done`);
}
await page.evaluate(() => window.__reset());

console.log("\n config                              base   cfg  delta    x    jsBase jsCfg  jsX  calls");
for (const [name, runs] of results) {
  const rb = med(runs.map((x) => x.b.frameMs));
  const rc = med(runs.map((x) => x.c.frameMs));
  console.log(
    ` ${name.padEnd(34)} ${rb.toFixed(1).padStart(5)} ${rc.toFixed(1).padStart(5)} ` +
    `${(rc - rb).toFixed(1).padStart(6)} ${med(runs.map((x) => x.ratio)).toFixed(2).padStart(5)} ` +
    `${med(runs.map((x) => x.b.jsMs)).toFixed(1).padStart(6)} ${med(runs.map((x) => x.c.jsMs)).toFixed(1).padStart(6)} ` +
    `${med(runs.map((x) => x.jsRatio)).toFixed(2).padStart(5)} ${med(runs.map((x) => x.c.calls)).toFixed(0).padStart(6)}`);
}
console.log("\nratios/rep:", JSON.stringify([...results].map(([k, v]) => [k, v.map((x) => +x.ratio.toFixed(2))])));
await browser.close();
