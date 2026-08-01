// PROGRAM WATCH — names every GL program the app links, and says WHEN.
//
// The hitch work needs more than "59 programs link at runtime": it needs to
// know WHICH ones so prewarm can build exactly those. three.js stamps every
// program it builds with `#define SHADER_NAME <name>` plus the full define
// block (USE_INSTANCING / NUM_POINT_LIGHTS / DEPTH_PACKING / USE_FOG / ...),
// which is the complete permutation key. So: capture shaderSource per shader,
// map shaders to programs via attachShader, and dump the key at linkProgram.
//
// Phases: boot (module eval) -> prewarm (assets settled) -> runtime (loading
// screen lifted). Anything in `runtime` is a mid-game compile = a hitch.
//
// Usage: node tools/progwatch.mjs "<url>" [--seconds 10]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 10));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const PW = { phase: "boot", progs: [], t0: performance.now() };
  window.__PW = PW;
  const src = new WeakMap();      // shader -> source
  const attached = new WeakMap(); // program -> [source, ...]

  // THE REAL PERMUTATION KEY. Two traps, both of which hid the actual forks
  // from an earlier version of this probe:
  //   1. The light counts are NOT defines. three.js string-REPLACES the token
  //      (`.replace(/NUM_POINT_LIGHTS/g, ...)`), so a 0-light and a 4-light
  //      program differ only in array sizes like `pointLights[ 4 ]`.
  //   2. `#define` also appears inside chunk bodies, so only the prefix block
  //      (the first ~140 lines, above the shader body) may be scanned.
  // Both shaders are unioned because OPAQUE/TONE_MAPPING live in the fragment
  // prefix while USE_INSTANCING/USE_SKINNING live in the vertex one.
  const ARRAYS = [
    "directionalLights", "pointLights", "spotLights", "hemisphereLights",
    "directionalShadowMap", "pointShadowMap", "spotShadowMap",
    "vDirectionalShadowCoord", "vPointShadowCoord",
  ];
  const keyOf = (sources) => {
    const set = new Set();
    for (const s of sources) {
      if (!s) continue;
      const head = s.split("\n").slice(0, 160).join("\n");
      for (const m of head.matchAll(/^#define (\w+)(?: +(\S.*?))?\s*$/gm)) {
        set.add(m[2] === undefined ? m[1] : `${m[1]}=${m[2]}`);
      }
      for (const a of ARRAYS) {
        const m = s.match(new RegExp("\\b" + a + "\\[ *(\\d+) *\\]"));
        if (m) set.add(`${a}[${m[1]}]`);
      }
    }
    return [...set].sort().join(" ") || "(raw shader)";
  };

  function patch(proto) {
    if (!proto || proto.__pwPatched) return;
    proto.__pwPatched = true;
    const rawSrc = proto.shaderSource;
    proto.shaderSource = function (sh, s) { src.set(sh, s); return rawSrc.call(this, sh, s); };
    const rawAtt = proto.attachShader;
    proto.attachShader = function (p, sh) {
      const list = attached.get(p) || [];
      list.push(src.get(sh) || "");
      attached.set(p, list);
      return rawAtt.call(this, p, sh);
    };
    const rawLink = proto.linkProgram;
    proto.linkProgram = function (p) {
      const r = rawLink.call(this, p);
      const list = attached.get(p) || [];
      let stack = "";
      try { stack = (new Error().stack || "").split("\n").slice(2, 7).map((x) => x.trim()).join(" <- "); } catch { /* noop */ }
      PW.progs.push({
        phase: PW.phase,
        t: +(performance.now() - PW.t0).toFixed(0),
        key: keyOf(list),
        bytes: list.reduce((a, s) => a + s.length, 0),
        stack,
      });
      return r;
    };
    // EVICTION. three.js refcounts programs and destroys one the moment its
    // last material is disposed — so a "already prewarmed" program can be
    // thrown away and have to be rebuilt (at full cost) mid-combat. If any
    // deletes land in the runtime phase, prewarming alone can never hold.
    const rawDel = proto.deleteProgram;
    proto.deleteProgram = function (p) {
      let stack = "";
      try { stack = (new Error().stack || "").split("\n").slice(2, 8).map((x) => x.trim()).join(" <- "); } catch { /* noop */ }
      (PW.deletes ||= []).push({ phase: PW.phase, t: +(performance.now() - PW.t0).toFixed(0), stack });
      return rawDel.call(this, p);
    };
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
}));

const phase = (p) => page.evaluate((v) => { window.__PW.phase = v; }, p);
const progCount = () => page.evaluate(() => window.__PW.progs.length);

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
await phase("prewarm");
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done") || el.style.display === "none" || getComputedStyle(el).opacity === "0";
}, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(1500);
await phase("runtime");
console.log("programs at loading-screen lift:", await progCount());

// Frame-time recorder for the whole runtime window.
await page.evaluate(() => {
  const F = { ms: [] };
  window.__PWF = F;
  let last = performance.now();
  const tick = () => { const n = performance.now(); F.ms.push(n - last); last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

const walk = async () => {
  for (const k of ["w", "d", "s", "a"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
};
const fight = async () => {
  for (let i = 0; i < 6; i++) {
    for (const k of ["Space", "Shift", "q", "c", "f", "x", "e", "r"]) {
      await page.keyboard.press(k).catch(() => {});
      await page.waitForTimeout(110);
    }
  }
};
await walk();
console.log("after walk:", await progCount());
await fight();
console.log("after fight:", await progCount());
await walk();
await fight();
await page.waitForTimeout(seconds * 100);
console.log("after 2nd pass:", await progCount());

const out = await page.evaluate(() => ({ progs: window.__PW.progs, frames: window.__PWF.ms, deletes: window.__PW.deletes || [] }));
await browser.close();

console.log(`\nPROGRAM DELETIONS (eviction): ${out.deletes.length}`);
for (const p of ["boot", "prewarm", "runtime"]) {
  const n = out.deletes.filter((d) => d.phase === p).length;
  if (n) console.log(`  ${p.padEnd(8)} ${n}`);
}
{
  const s = {};
  for (const d of out.deletes.filter((x) => x.phase === "runtime")) s[d.stack] = (s[d.stack] || 0) + 1;
  for (const [k, n] of Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`  n=${n} ${k}`);
}

const byPhase = (p) => out.progs.filter((r) => r.phase === p);
console.log(`\nTOTAL programs linked: ${out.progs.length}`);
for (const p of ["boot", "prewarm", "runtime"]) console.log(`  ${p.padEnd(8)} ${byPhase(p).length}`);

const f = out.frames.slice().sort((a, b) => a - b);
if (f.length) {
  const q = (x) => f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1);
  console.log(`\nRUNTIME FRAMES n=${f.length}  p50=${q(0.5)} p95=${q(0.95)} p99=${q(0.99)} worst=${f[f.length - 1].toFixed(0)}ms`);
  console.log(`  frames >200ms: ${f.filter((x) => x > 200).length}   >500ms: ${f.filter((x) => x > 500).length}`);
}

const rt = byPhase("runtime");
if (rt.length) {
  console.log(`\n=== ${rt.length} PROGRAMS BUILT DURING GAMEPLAY (each one is a hitch) ===`);
  const g = {};
  for (const r of rt) (g[r.key] ||= []).push(r);
  for (const [k, v] of Object.entries(g).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  n=${String(v.length).padStart(2)}  t=${v.map((x) => x.t).slice(0, 5).join(",")}  ${k}`);
  }
  // WHY did it fork? For each runtime key, find the prewarmed key sharing the
  // most tokens and print the symmetric difference. That names the axis the
  // prewarm missed (render-target vs canvas, light count, instancing, ...).
  console.log(`\n=== WHY EACH RUNTIME PROGRAM FORKED (vs nearest prewarmed) ===`);
  const warmKeys = [...new Set(out.progs.filter((r) => r.phase !== "runtime").map((r) => r.key))]
    .map((k) => ({ k, set: new Set(k.split(" ")) }));
  for (const k of Object.keys(g)) {
    const mine = new Set(k.split(" "));
    let best = null, bestScore = -1;
    for (const w of warmKeys) {
      let hit = 0;
      for (const t of mine) if (w.set.has(t)) hit++;
      const score = hit - (w.set.size - hit) * 0.5;
      if (score > bestScore) { bestScore = score; best = w; }
    }
    const missing = [...mine].filter((t) => !best.set.has(t));
    const extra = [...best.set].filter((t) => !mine.has(t));
    console.log(`  n=${g[k].length}`);
    console.log(`     runtime NEEDS but prewarm lacks: ${missing.join(" ") || "(none)"}`);
    console.log(`     prewarm built instead          : ${extra.join(" ") || "(none)"}`);
  }

  console.log(`\n--- callers ---`);
  const s = {};
  for (const r of rt) s[r.stack] = (s[r.stack] || 0) + 1;
  for (const [k, n] of Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  n=${n} ${k}`);
}

// The prewarm inventory, so a fix can be checked against what runtime wants.
console.log(`\n=== PREWARM+BOOT INVENTORY (${out.progs.length - rt.length}) ===`);
{
  const g = {};
  for (const r of out.progs) if (r.phase !== "runtime") g[r.key] = (g[r.key] || 0) + 1;
  for (const [k, n] of Object.entries(g).sort((a, b) => b[1] - a[1])) console.log(`  n=${String(n).padStart(2)}  ${k}`);
}
