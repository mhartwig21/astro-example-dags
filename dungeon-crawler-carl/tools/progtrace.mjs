// SHADER PROGRAM TRACER — attributes every runtime GLSL program link to a
// phase, a frame, and a material identity.
//
// Why this shape: three.js only calls gl.linkProgram() on a WebGLPrograms cache
// MISS, i.e. exactly once per NEW program variant. Patching linkProgram at page
// init therefore gives a complete, exact log of "a shader was built right here"
// with ZERO source edits — it runs against the untouched production bundle, so
// the numbers describe the shipped build and not a debug build that shifted the
// timing. At link time the shader objects are already attached and sourced, so
// gl.getAttachedShaders + gl.getShaderSource recovers the full prelude: three
// stamps #define SHADER_NAME / SHADER_TYPE plus the whole feature-define block
// (USE_INSTANCING, USE_SKINNING, NUM_DIR_LIGHTS, DEPTH_PACKING, ...), which is
// the material variant identity we need to fix the prewarm.
//
// Usage: node tools/progtrace.mjs "<url>" [--seconds 8] [--w 1920] [--h 1080]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 8));
const width = Number(flag("--w", 1920));
const height = Number(flag("--h", 1080));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const PT = { phase: "boot", links: [], frames: [] };
  window.__PT = PT;

  // Pull the identity out of three's injected shader prelude.
  const INTERESTING = /^#define\s+(SHADER_NAME|SHADER_TYPE|USE_\w+|NUM_\w+|DEPTH_PACKING|MAX_BONES|FLIP_SIDED|DOUBLE_SIDED|TONE_MAPPING|OPAQUE|ALPHATEST|GTAO\w*|PERSPECTIVE_CAMERA|ORTHOGRAPHIC_CAMERA)\b(.*)$/;
  function identify(gl, program) {
    let name = "", type = "", defines = [], uniforms = [], bytes = 0, hash = 0;
    const lights = {};
    try {
      for (const sh of gl.getAttachedShaders(program) || []) {
        const src = gl.getShaderSource(sh) || "";
        bytes += src.length;
        // FNV-1a over the full source. Two links with the same hash are the
        // byte-identical program: proof of release/re-acquire THRASH rather
        // than a genuinely new variant.
        for (let i = 0; i < src.length; i++) { hash ^= src.charCodeAt(i); hash = Math.imul(hash, 16777619); }
        const isVert = /gl_Position/.test(src);
        for (const line of src.split("\n")) {
          const m = INTERESTING.exec(line.trim());
          if (!m) continue;
          if (m[1] === "SHADER_NAME") { name = m[2].trim(); continue; }
          if (m[1] === "SHADER_TYPE") { type = m[2].trim(); continue; }
          const d = (m[1] + m[2]).trim();
          if (!defines.includes(d)) defines.push(d);
        }
        // CRITICAL: three does NOT #define the light counts — it TEXTUALLY
        // substitutes NUM_POINT_LIGHTS etc. into the chunk source
        // (WebGLProgram: .replace(/NUM_POINT_LIGHTS/g, parameters.numPointLights)).
        // They are nonetheless part of getProgramCacheKey, so every distinct
        // light count is a distinct program for EVERY material. Recover them
        // from the declared uniform array sizes.
        const grab = (re, key) => { const m = re.exec(src); if (m) lights[key] = +m[1]; };
        grab(/uniform PointLight pointLights\[\s*(\d+)\s*\]/, "point");
        grab(/uniform DirectionalLight directionalLights\[\s*(\d+)\s*\]/, "dir");
        grab(/uniform HemisphereLight hemisphereLights\[\s*(\d+)\s*\]/, "hemi");
        grab(/uniform DirectionalLightShadow directionalLightShadows\[\s*(\d+)\s*\]/, "dirShadow");
        grab(/uniform PointLightShadow pointLightShadows\[\s*(\d+)\s*\]/, "pointShadow");
        if (isVert) {
          for (const um of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)) {
            if (!uniforms.includes(um[1])) uniforms.push(um[1]);
          }
        }
      }
    } catch { /* context may be lost */ }
    return { name, type, defines, lights, uniforms: uniforms.slice(0, 10), bytes, hash: (hash >>> 0).toString(16) };
  }

  function patch(proto) {
    if (!proto || proto.__ptPatched) return;
    proto.__ptPatched = true;
    const rawLink = proto.linkProgram;
    proto.linkProgram = function (program) {
      const id = identify(this, program);
      const t0 = performance.now();
      const r = rawLink.call(this, program);
      const t1 = performance.now();
      let stack = "";
      try { stack = (new Error().stack || "").split("\n").slice(2, 7).join(" | "); } catch { /* noop */ }
      PT.links.push({ t: t1, phase: PT.phase, linkMs: +(t1 - t0).toFixed(2), frame: PT.frames.length, ...id, stack });
      return r;
    };
    // ANGLE/D3D11 defers the real HLSL translate+compile; the stall usually
    // surfaces when three asks for LINK_STATUS, so time that separately.
    const rawParam = proto.getProgramParameter;
    proto.getProgramParameter = function (program, pname) {
      const t0 = performance.now();
      const r = rawParam.call(this, program, pname);
      const dt = performance.now() - t0;
      if (dt > 1 && PT.links.length) {
        const last = PT.links[PT.links.length - 1];
        last.statusMs = +((last.statusMs || 0) + dt).toFixed(2);
      }
      return r;
    };
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  // Continuous frame clock so a link can be tied to the frame it stalled.
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    PT.frames.push({ t: now, ms: +(now - last).toFixed(2), phase: PT.phase });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);

const phase = (p) => page.evaluate((v) => { window.__PT.phase = v; }, p);

// NOTE ON THE PHASE BOUNDARY: data-assets-settled is stamped by assets.ts the
// moment the GLB manifest resolves, which is BEFORE main3d calls
// renderer.prewarm(). Using it as the "loading over" marker mis-attributes the
// entire prewarm to runtime. The honest boundary is the loading overlay
// getting class "done" (main3d, right after prewarm resolves).
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await phase("prewarm");
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done");
}, { timeout: 180000 }).catch(() => {});
await phase("settled");
await page.waitForTimeout(2500);

const run = async (label, fn) => {
  await phase(label);
  await fn();
};

await run("idle", () => page.waitForTimeout(seconds * 1000));
await run("moving", async () => {
  await page.keyboard.down("w");
  await page.waitForTimeout(seconds * 700);
  await page.keyboard.up("w");
  await page.keyboard.down("d");
  await page.waitForTimeout(seconds * 700);
  await page.keyboard.up("d");
});
// Exercise EVERY ability slot repeatedly: slot1=Space slot2=Shift slot3=q
// slot4=c ultimate=f flask=x. One press is not enough — cooldowns mean a
// single pass only ever fires a couple of them.
await run("combat", async () => {
  for (let i = 0; i < 6; i++) {
    for (const k of [" ", "Shift", "q", "c", "f", "x"]) {
      await page.keyboard.press(k === " " ? "Space" : k).catch(() => {});
      await page.waitForTimeout(160);
    }
    await page.keyboard.down("w"); await page.waitForTimeout(320); await page.keyboard.up("w");
  }
});
await run("post", () => page.waitForTimeout(2000));

const out = await page.evaluate(() => window.__PT);
await browser.close();

const FREE = new Set(["boot", "prewarm"]); // hidden behind the opaque loading screen
const runtime = out.links.filter((l) => !FREE.has(l.phase));
const bootN = out.links.filter((l) => l.phase === "boot").length;
const preN = out.links.filter((l) => l.phase === "prewarm").length;
console.log(`\nTOTAL links: ${out.links.length}  (boot ${bootN} + prewarm ${preN} = ${bootN + preN} FREE, AFTER LOADING SCREEN ${runtime.length})`);

const lstr = (L) => `dir=${L.dir ?? 0} point=${L.point ?? 0} hemi=${L.hemi ?? 0} dirShadow=${L.dirShadow ?? 0}`;
const feats = (l) => l.defines.filter((d) => !/^(TONE_MAPPING|OPAQUE|PERSPECTIVE_CAMERA|ORTHOGRAPHIC_CAMERA)/.test(d)).join(" ");

const byPhase = {};
for (const l of runtime) (byPhase[l.phase] ||= []).push(l);
for (const [p, ls] of Object.entries(byPhase)) {
  console.log(`\n=== PHASE ${p.toUpperCase()} — ${ls.length} new programs ===`);
  for (const l of ls) {
    console.log(`  type=${l.type || "?"} name=${l.name || "-"} | LIGHTS ${lstr(l.lights)}`);
    console.log(`      defines: ${feats(l) || "(none)"}`);
  }
}

// How much of the churn is PURELY light-count permutation? Group by the
// material identity with light counts stripped; any group of size > 1 is the
// same material recompiled only because the scene's light census changed.
console.log(`\n=== CHURN ANALYSIS (runtime only) ===`);
const groups = new Map();
for (const l of runtime) {
  const k = `${l.type}|${l.name}|${feats(l)}`;
  const g = groups.get(k) || { n: 0, lights: new Set() };
  g.n++; g.lights.add(lstr(l.lights));
  groups.set(k, g);
}
let pureLightChurn = 0;
for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (g.n > 1) pureLightChurn += g.n - 1;
  console.log(`  x${g.n}  ${k}`);
  if (g.lights.size > 1) console.log(`        light variants: ${[...g.lights].join("  //  ")}`);
}
console.log(`\n  distinct material identities: ${groups.size}`);
console.log(`  links attributable to LIGHT-COUNT permutation alone: ${pureLightChurn} / ${runtime.length}`);

// Byte-identical re-links = the program was RELEASED (material disposed) and
// rebuilt from scratch. Pure waste, independent of the prewarm's coverage.
const hashCount = new Map();
for (const l of runtime) hashCount.set(l.hash, (hashCount.get(l.hash) || 0) + 1);
const relinks = [...hashCount.values()].reduce((a, n) => a + n - 1, 0);
console.log(`  UNIQUE programs actually needed at runtime: ${hashCount.size}`);
console.log(`  wasted RE-LINKS of a byte-identical program (thrash): ${relinks} / ${runtime.length}`);
const bootHashes = new Set(out.links.filter((l) => FREE.has(l.phase)).map((l) => l.hash));
const neverPrewarmed = [...hashCount.keys()].filter((h) => !bootHashes.has(h));
console.log(`  unique programs the PREWARM never built: ${neverPrewarmed.length} / ${hashCount.size}`);
console.log(`  unique programs the prewarm DID build but were thrown away and rebuilt: ${hashCount.size - neverPrewarmed.length}`);
const allLights = new Set(runtime.map((l) => lstr(l.lights)));
console.log(`  distinct light censuses seen at runtime: ${allLights.size}`);
for (const s of allLights) console.log(`     ${s}`);

// Correlate: how bad were the frames in which links happened?
const frames = out.frames;
const linkFrames = new Set(runtime.map((l) => l.frame));
const hitched = frames.filter((f, i) => linkFrames.has(i));
const clean = frames.filter((f, i) => !linkFrames.has(i) && f.phase !== "boot" && f.phase !== "settled");
const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
console.log(`\nFRAMES WITH A LINK: n=${hitched.length} medianMs=${med(hitched.map((f) => f.ms)).toFixed(1)} maxMs=${Math.max(0, ...hitched.map((f) => f.ms)).toFixed(1)}`);
console.log(`FRAMES WITHOUT:     n=${clean.length} medianMs=${med(clean.map((f) => f.ms)).toFixed(1)} maxMs=${Math.max(0, ...clean.map((f) => f.ms)).toFixed(1)}`);
const worst = [...frames].sort((a, b) => b.ms - a.ms).slice(0, 8);
console.log(`WORST FRAMES: ${worst.map((f) => `${f.ms}ms(${f.phase})`).join(" ")}`);
