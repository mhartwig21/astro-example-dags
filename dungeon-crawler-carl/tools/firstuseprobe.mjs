// FIRST-USE PROBE — proves (or refutes) the deferred-compile hypothesis, and
// A/B tests the fix WITHOUT editing src/.
//
// HYPOTHESIS. three r0.169 defers the expensive half of program creation to
// WebGLProgram.onFirstUse(), reached only via getUniforms()/getAttributes() —
// i.e. the first time a material is actually DRAWN. onFirstUse calls
// gl.getProgramInfoLog + gl.getShaderInfoLog x2 + getProgramParameter(
// LINK_STATUS) (all gated on renderer.debug.checkShaderErrors, default TRUE).
// On ANGLE/D3D11 linkProgram is asynchronous — those queries are the sync
// point that forces the GLSL->HLSL translate + D3D compile.
// Renderer3D.prewarm() calls renderer.compile(), which LINKS every program but
// never calls getUniforms, so the whole compile bill is deferred past the
// loading screen and lands on the first frame that draws each material.
//
// INSTRUMENT: wrap exactly the four onFirstUse queries and attribute their
// cost per phase.
// FIX UNDER TEST (--flush): call those same queries immediately after
// linkProgram. That drags the ANGLE compile back to link time — which for the
// prewarmed programs is behind the opaque loading screen. Identical to the
// real fix (prewarm calling getUniforms() on every program), but achievable
// from an init script against the untouched production bundle.
//
// Usage: node tools/firstuseprobe.mjs "<url>" [--flush] [--seconds 8]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const FLUSH = process.argv.includes("--flush");
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 8));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript((doFlush) => {
  const FU = { phase: "boot", frames: [], q: [], links: 0, flushed: 0 };
  window.__FU = FU;

  function patch(proto) {
    if (!proto || proto.__fuPatched) return;
    proto.__fuPatched = true;

    // The four onFirstUse sync points.
    for (const fn of ["getProgramInfoLog", "getShaderInfoLog", "getProgramParameter", "getShaderParameter"]) {
      const raw = proto[fn];
      if (typeof raw !== "function") continue;
      proto[fn] = function (...a) {
        const t0 = performance.now();
        const r = raw.apply(this, a);
        const dt = performance.now() - t0;
        if (dt > 0.5) FU.q.push({ t: t0, fn, ms: +dt.toFixed(2), phase: FU.phase, frame: FU.frames.length });
        return r;
      };
    }

    const rawLink = proto.linkProgram;
    proto.linkProgram = function (program) {
      const r = rawLink.call(this, program);
      FU.links++;
      if (doFlush) {
        // Force ANGLE to finish translating + compiling NOW, while we are
        // still behind the loading screen, instead of on first draw.
        const t0 = performance.now();
        this.getProgramParameter(program, this.LINK_STATUS);
        this.getProgramInfoLog(program);
        for (const sh of this.getAttachedShaders(program) || []) this.getShaderInfoLog(sh);
        FU.flushed += performance.now() - t0;
      }
      return r;
    };
  }
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    FU.frames.push({ ms: +(now - last).toFixed(2), phase: FU.phase, t0: last, t: now });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, FLUSH);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log(`GPU: ${gpu}\nMODE: ${FLUSH ? "FLUSH-AT-LINK (fix under test)" : "BASELINE (shipped behaviour)"}`);

const phase = (p) => page.evaluate((v) => { window.__FU.phase = v; }, p);
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await phase("prewarm");
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done");
}, { timeout: 180000 }).catch(() => {});
await phase("settled");
await page.waitForTimeout(2500);
await phase("idle");
await page.waitForTimeout(seconds * 1000);
await phase("moving");
for (const k of ["w", "d", "s", "a"]) {
  await page.keyboard.down(k); await page.waitForTimeout(seconds * 350); await page.keyboard.up(k);
}
await phase("combat");
for (let i = 0; i < 6; i++) {
  for (const k of [" ", "Shift", "q", "c", "f", "x"]) {
    await page.keyboard.press(k === " " ? "Space" : k).catch(() => {});
    await page.waitForTimeout(160);
  }
  await page.keyboard.down("w"); await page.waitForTimeout(320); await page.keyboard.up("w");
}
await phase("post");
await page.waitForTimeout(2000);

const out = await page.evaluate(() => window.__FU);
await browser.close();

const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
const REAL = ["settled", "idle", "moving", "combat", "post"];

console.log(`\nlinkProgram calls: ${out.links}   forced-flush cost paid at link: ${out.flushed.toFixed(0)}ms`);

console.log(`\n=== onFirstUse SYNC-QUERY STALLS (>0.5ms) BY PHASE ===`);
const byPhase = {};
for (const q of out.q) {
  (byPhase[q.phase] ||= { n: 0, ms: 0 });
  byPhase[q.phase].n++; byPhase[q.phase].ms += q.ms;
}
for (const p of ["boot", "prewarm", ...REAL]) {
  const v = byPhase[p];
  if (!v) continue;
  console.log(`  ${p.padEnd(9)} n=${String(v.n).padStart(4)}  total=${v.ms.toFixed(0)}ms`);
}
const afterLoad = out.q.filter((q) => REAL.includes(q.phase));
console.log(`  >>> TOTAL STALL AFTER LOADING SCREEN: ${afterLoad.reduce((a, q) => a + q.ms, 0).toFixed(0)}ms in ${afterLoad.length} queries`);
console.log(`      worst: ${afterLoad.sort((a, b) => b.ms - a.ms).slice(0, 8).map((q) => `${q.ms.toFixed(0)}ms(${q.phase}/${q.fn})`).join(" ")}`);

console.log(`\n=== FRAME TIMES ===`);
for (const p of REAL) {
  const f = out.frames.filter((x) => x.phase === p).map((x) => x.ms);
  if (!f.length) continue;
  const s = [...f].sort((a, b) => a - b);
  console.log(`  ${p.padEnd(9)} n=${String(f.length).padStart(5)} median=${med(f).toFixed(1)}ms p95=${s[Math.floor(f.length * 0.95)].toFixed(1)}ms max=${Math.max(...f).toFixed(0)}ms  >100ms:${f.filter((m) => m > 100).length}  >500ms:${f.filter((m) => m > 500).length}`);
}
const all = out.frames.filter((x) => REAL.includes(x.phase)).map((x) => x.ms);
console.log(`  ALL POST-LOAD: n=${all.length} median=${med(all).toFixed(1)}ms  frames>100ms=${all.filter((m) => m > 100).length}  frames>500ms=${all.filter((m) => m > 500).length}  total hitch ms(>100)=${all.filter((m) => m > 100).reduce((a, b) => a + b, 0).toFixed(0)}ms  max=${Math.max(...all).toFixed(0)}ms`);
