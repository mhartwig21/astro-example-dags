// HITCH PROBE — attributes every long frame to a CAUSE, shader or not.
//
// progtrace.mjs proved the multi-second stalls are NOT gl.linkProgram. This
// tool answers "then what". Three independent instruments run at once:
//
//  1. CDP Profiler (real JS sampling profile, 100us interval). Every sample
//     carries a timestamp, so we can slice the profile to EXACTLY the window
//     of a bad frame and aggregate self-time by function. This is the only
//     instrument that can name a synchronous stall in library code.
//  2. WebGL upload timing. three uploads textures/buffers lazily on first
//     draw; texImage2D of a 1024^2 RGBA + generateMipmap is a real multi-ms
//     synchronous driver stall, and it lands on the frame a monster first
//     becomes visible — indistinguishable from a shader hitch without this.
//  3. Frame clock + phase tags (same shape as progtrace) so the windows line
//     up with game events.
//
// Usage: node tools/hitchprobe.mjs "<url>" [--seconds 8] [--w 1440] [--h 852] [--dpr 2]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
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

await page.addInitScript(() => {
  const HP = { phase: "boot", frames: [], gl: [], long: [], net: [], t0: 0 };
  window.__HP = HP;
  HP.t0 = performance.timeOrigin;

  // --- 2. GL upload + sync-point timing -----------------------------------
  // Only calls that can plausibly block: texture uploads, mipmap generation,
  // buffer uploads, and the explicit sync points (finish/readPixels/getError
  // after a batch). Cheap calls are not wrapped, to keep overhead off the
  // measurement.
  const HEAVY = ["texImage2D", "texSubImage2D", "texStorage2D", "compressedTexImage2D",
    "generateMipmap", "bufferData", "bufferSubData", "readPixels", "finish",
    "texImage3D", "renderbufferStorageMultisample", "framebufferTexture2D",
    "blitFramebuffer", "drawArrays", "drawElements", "drawElementsInstanced"];
  function patchGL(proto) {
    if (!proto || proto.__hpPatched) return;
    proto.__hpPatched = true;
    for (const fn of HEAVY) {
      const raw = proto[fn];
      if (typeof raw !== "function") continue;
      proto[fn] = function (...a) {
        const t0 = performance.now();
        const r = raw.apply(this, a);
        const dt = performance.now() - t0;
        // 0.7ms threshold: below this it is noise, above it is a real stall.
        if (dt > 0.7) {
          let size = "";
          if (fn.startsWith("tex")) {
            // width/height sit at different arg slots per overload; grab the
            // two largest ints as a good-enough dimension guess.
            const ints = a.filter((v) => typeof v === "number" && v > 4).sort((x, y) => y - x);
            size = ints.slice(0, 2).join("x");
          } else if (fn.startsWith("buffer")) {
            const d = a.find((v) => v && v.byteLength !== undefined);
            if (d) size = `${(d.byteLength / 1024) | 0}KB`;
          }
          HP.gl.push({ t: t0, fn, ms: +dt.toFixed(2), size, phase: HP.phase, frame: HP.frames.length });
        }
        return r;
      };
    }
  }
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  // Shader links, so this tool's picture is complete on its own.
  function patchLink(proto) {
    if (!proto || proto.__hpLink) return;
    proto.__hpLink = true;
    const raw = proto.linkProgram;
    proto.linkProgram = function (p) {
      const t0 = performance.now();
      const r = raw.call(this, p);
      HP.gl.push({ t: t0, fn: "linkProgram", ms: +(performance.now() - t0).toFixed(2), size: "", phase: HP.phase, frame: HP.frames.length });
      return r;
    };
  }
  patchLink(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  patchLink(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  // --- network: when does each GLB/PNG actually land + decode? -------------
  const rawFetch = window.fetch;
  window.fetch = async function (...a) {
    const t0 = performance.now();
    const res = await rawFetch.apply(this, a);
    const u = String(typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "");
    HP.net.push({ t: t0, ms: +(performance.now() - t0).toFixed(2), url: u.split("/").pop(), phase: HP.phase });
    return res;
  };

  // --- long tasks (catches work outside rAF: decoders, GC, parsing) --------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        HP.long.push({ t: e.startTime, ms: +e.duration.toFixed(2), name: e.name, phase: HP.phase });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* not supported */ }

  // --- 3. frame clock -----------------------------------------------------
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    HP.frames.push({ t0: last, t: now, ms: +(now - last).toFixed(2), phase: HP.phase });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// --- 1. CDP sampling profiler ---------------------------------------------
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); // microseconds
await cdp.send("Profiler.start");

await page.goto(url, { waitUntil: "load", timeout: 60000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu, `  viewport ${width}x${height} @dpr${dpr} => ${width * dpr}x${height * dpr}`);

const phase = (p) => page.evaluate((v) => { window.__HP.phase = v; }, p);

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
await phase("panels");
// UI panels that render 3D or rebuild large DOM (inventory/character/map/skills)
for (const k of ["i", "p", "k", "m", "Tab", "b"]) {
  await page.keyboard.press(k).catch(() => {});
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}
await phase("post");
await page.waitForTimeout(2500);

const out = await page.evaluate(() => window.__HP);
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

// ---- profile indexing ------------------------------------------------------
// CDP timestamps are microseconds on the same monotonic clock as
// performance.timeOrigin; convert both to page-relative milliseconds.
const nodes = new Map();
for (const n of profile.nodes) nodes.set(n.id, n);
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);

const label = (id) => {
  const n = nodes.get(id);
  if (!n) return "?";
  const f = n.callFrame;
  const file = (f.url || "").split("/").pop().split("?")[0];
  return `${f.functionName || "(anon)"} @${file}:${f.lineNumber + 1}`;
};
const stackOf = (id) => {
  const out = [];
  let cur = id;
  for (let i = 0; i < 24 && cur !== undefined; i++) { out.push(label(cur)); cur = parent.get(cur); }
  return out;
};

// Rebuild absolute sample times (profile.timeDeltas are us gaps).
const samples = [];
{
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] || 0;
    samples.push({ t, id: profile.samples[i] });
  }
}
// Map CDP microsecond clock -> page performance.now() ms.
// Profiler.start happened just before goto, so profile.startTime ~ navigation.
// Anchor on the LAST frame instead: both clocks end at the same instant.
const lastFrame = out.frames[out.frames.length - 1];
const anchorCdp = profile.endTime;
const anchorPage = lastFrame ? lastFrame.t : 0;
const toPageMs = (usec) => (usec - anchorCdp) / 1000 + anchorPage;

const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
const REAL = new Set(["settled", "idle", "moving", "combat", "panels", "post"]);

console.log(`\n================ FRAME SUMMARY ================`);
for (const p of ["boot", "prewarm", "settled", "idle", "moving", "combat", "panels", "post"]) {
  const f = out.frames.filter((x) => x.phase === p);
  if (!f.length) continue;
  const ms = f.map((x) => x.ms);
  const over = ms.filter((m) => m > 100).length;
  console.log(`  ${p.padEnd(9)} n=${String(f.length).padStart(5)} median=${med(ms).toFixed(1)}ms  p95=${[...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.95)]?.toFixed(1)}ms  max=${Math.max(...ms).toFixed(1)}ms  frames>100ms=${over}`);
}

// ---- the bad frames, each attributed ---------------------------------------
const bad = out.frames.map((f, i) => ({ ...f, i }))
  .filter((f) => f.ms > 120 && f.phase !== "boot")
  .sort((a, b) => b.ms - a.ms).slice(0, 14);

console.log(`\n================ WORST FRAMES, ATTRIBUTED ================`);
for (const f of bad) {
  const glIn = out.gl.filter((g) => g.t >= f.t0 && g.t <= f.t);
  const glMs = glIn.reduce((a, g) => a + g.ms, 0);
  const byFn = {};
  for (const g of glIn) byFn[g.fn] = +((byFn[g.fn] || 0) + g.ms).toFixed(1);
  const netIn = out.net.filter((n) => n.t >= f.t0 && n.t <= f.t);

  console.log(`\n--- ${f.ms.toFixed(0)}ms frame (phase=${f.phase})`);
  console.log(`    GL accounted: ${glMs.toFixed(1)}ms of ${f.ms.toFixed(0)}ms  ${JSON.stringify(byFn)}`);
  if (netIn.length) console.log(`    fetches resolving in-frame: ${netIn.length} e.g. ${netIn.slice(0, 4).map((n) => n.url).join(", ")}`);

  // JS self-time inside the frame window, from the sampling profile.
  const inWin = samples.filter((s) => { const t = toPageMs(s.t); return t >= f.t0 && t <= f.t; });
  const self = new Map();
  for (const s of inWin) self.set(s.id, (self.get(s.id) || 0) + 1);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const perSample = inWin.length ? f.ms / inWin.length : 0;
  console.log(`    JS samples in window: ${inWin.length} (~${(inWin.length * perSample).toFixed(0)}ms of wall time covered)`);
  for (const [id, n] of top) {
    console.log(`      ${(n * perSample).toFixed(0)}ms  ${label(id)}`);
    console.log(`             <- ${stackOf(id).slice(1, 5).join(" <- ")}`);
  }
  if (!top.length) console.log(`      (NO JS SAMPLES — the stall was inside a native/driver call the profiler cannot sample, or the main thread was blocked outside JS)`);
}

// ---- aggregate GL upload cost ----------------------------------------------
console.log(`\n================ GL CALL STALLS (>0.7ms each) ================`);
const glReal = out.gl.filter((g) => REAL.has(g.phase));
const agg = {};
for (const g of glReal) {
  const k = g.fn;
  (agg[k] ||= { n: 0, ms: 0, sizes: new Set() });
  agg[k].n++; agg[k].ms += g.ms; agg[k].sizes.add(g.size);
}
for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`  ${k.padEnd(26)} n=${String(v.n).padStart(4)} total=${v.ms.toFixed(0)}ms  max sizes=${[...v.sizes].filter(Boolean).slice(0, 5).join(",")}`);
}
const byPhaseGl = {};
for (const g of glReal) byPhaseGl[g.phase] = +((byPhaseGl[g.phase] || 0) + g.ms).toFixed(0);
console.log(`  per-phase GL stall total: ${JSON.stringify(byPhaseGl)}`);

// ---- long tasks -------------------------------------------------------------
console.log(`\n================ LONG TASKS (post-boot) ================`);
const lt = out.long.filter((l) => REAL.has(l.phase)).sort((a, b) => b.ms - a.ms).slice(0, 12);
for (const l of lt) console.log(`  ${l.ms.toFixed(0)}ms  phase=${l.phase}  ${l.name}`);
console.log(`  total longtask ms after loading screen: ${out.long.filter((l) => REAL.has(l.phase)).reduce((a, l) => a + l.ms, 0).toFixed(0)}ms`);

// ---- global hot functions after the loading screen --------------------------
console.log(`\n================ HOTTEST JS AFTER LOADING SCREEN ================`);
const firstReal = out.frames.find((f) => REAL.has(f.phase));
const t0real = firstReal ? firstReal.t0 : 0;
const realSamples = samples.filter((s) => toPageMs(s.t) >= t0real);
const selfAll = new Map();
for (const s of realSamples) selfAll.set(s.id, (selfAll.get(s.id) || 0) + 1);
const span = (lastFrame ? lastFrame.t : 0) - t0real;
const per = realSamples.length ? span / realSamples.length : 0;
for (const [id, n] of [...selfAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${(n * per).toFixed(0)}ms (${(100 * n / realSamples.length).toFixed(1)}%)  ${label(id)}`);
}
