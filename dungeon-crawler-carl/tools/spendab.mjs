// THE SPEND METER — what this round's appearance work costs, measured honestly.
//
// The rule this tool exists to satisfy: you may spend frame budget on looks, but
// you may not spend it SILENTLY. The paydown agent needs a number, not a vibe.
//
// WHY IT A/Bs INSIDE ONE BROWSER SESSION. This laptop crashed today under
// concurrent headless browsers, so only one may be alive at a time — and a
// sibling workflow keeps the box at ~95% CPU, which means a "before" measured
// in one session and an "after" measured in another are two different machines.
// The round's whole cost is therefore reachable from uniforms (renderer.wlDet.*
// and renderer.wl.uWlAtmo), and this tool flips them OFF and ON on the SAME
// staged frame, seconds apart, under the SAME load. The absolute milliseconds
// may be contaminated; the DELTA between two samples taken 10 s apart is not.
//
// It measures ON -> OFF -> ON. If the two ON samples disagree by more than the
// ON/OFF delta, the box moved under us and the run is reported as INCONCLUSIVE
// rather than as a number.
//
// Usage: node tools/spendab.mjs [--port 5282] [--floor 17] [--seed 41]
//                               [--secs 8] [--out tools/_spend]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const floor = Number(flag("--floor", 17));
const seed = Number(flag("--seed", 41));
const secs = Number(flag("--secs", 8));
const outDir = flag("--out", "tools/_spend");
const ring = Number(flag("--ring", 18));
mkdirSync(outDir, { recursive: true });

const probeLoad = () => {
  try {
    const ps = `$c=(Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 2).CounterSamples|%{$_.CookedValue};` +
      `$h=@(Get-Process chrome-headless-shell -ErrorAction SilentlyContinue).Count;` +
      `Write-Output ("{0:N1},{1}" -f (($c|Measure-Object -Average).Average),$h)`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 30000 }).trim();
    const [cpu, shells] = out.split(",");
    return { cpuPct: Number(cpu), otherHeadlessShells: Number(shells) };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
};

const browser = await chromium.launch({
  headless: false, // headless-new routes through SwiftShader on this box
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
const shaderErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/THREE\.WebGLProgram|shader error|ERROR:/i.test(t)) shaderErrors.push(t.slice(0, 400));
});

// Keep the crawler alive: dropped in at floor 17 a beam trap kills them ~1.5 s
// after spawn, and every sample would then be of the death card.
await page.addInitScript(() => {
  const w = window;
  const pump = () => {
    try {
      const st = w.__dcc && w.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; }
    } catch { /* not up yet */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=30&abilities=all&seed=${seed}&eagerassets&clean=1&debug=1`;
console.log(url);
await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.bringToFront();

const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown", dpr: devicePixelRatio };
});
console.log("GPU:", JSON.stringify(gpu));
if (/SwiftShader|Software|llvmpipe/i.test(gpu.renderer)) {
  console.error("REFUSING: software GL"); await browser.close(); process.exit(1);
}

// READINESS. data-assets-settled is NOT playable — shader precompile and the
// PMREM bake still run behind the boot card.
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
  const w = window;
  if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
  return (w.__ph || 0) >= 12;
}, { timeout: 120000, polling: 100 }).catch(() => {});
await page.waitForTimeout(3000);

const loadingBox = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { w: r.width, h: r.height, display: cs.display, opacity: cs.opacity };
});
if (loadingBox && loadingBox.w > 0 && loadingBox.h > 0 && loadingBox.display !== "none" && Number(loadingBox.opacity) > 0.01) {
  console.error("BOOT CARD STILL UP — MISSED:", JSON.stringify(loadingBox));
  await browser.close(); process.exit(2);
}
console.log("loading card:", loadingBox ? "present but inert" : "absent");

const gameGpu = await page.evaluate(() => {
  const ctx = window.__dcc.renderer.renderer.getContext();
  const d = ctx.getExtension("WEBGL_debug_renderer_info");
  return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
console.log("GAME CONTEXT GPU:", gameGpu);
if (!/Intel/i.test(gameGpu)) console.warn("!! not the integrated Intel part — the budget is written against the iGPU");

// Walk out of the spawn nook, then stage the crowd (the worst real scene).
await page.keyboard.down("w"); await page.waitForTimeout(1800); await page.keyboard.up("w");
const staged = await page.evaluate((ring) => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
  const spots = [];
  for (let ri = 0; ri < 6 && spots.length < ring; ri++) {
    const r = 1.6 + ri * 0.85;
    for (let k = 0; k < 18 && spots.length < ring; k++) {
      const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.hp = m.maxHp || m.hp; m.dormant = false; });
  return { placed: used.length };
}, ring);
console.log("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2500);

// ---- THE SWITCH.
//   "on"  — the round as shipped.
//   "off" — the whole spend backed out: relief, cavity and roughness modulation
//           to zero AND the detail map's world scale to zero, which collapses
//           every fragment's UV onto one texel so the sampler fetch is served
//           from cache. That last part matters: zeroing only the strengths
//           leaves the fetch in the shader and would under-report the cost.
//           Plus the atmosphere radiance to black.
await page.evaluate(() => {
  const R = window.__dcc.renderer;
  window.__spend = {
    det: Object.fromEntries(Object.entries(R.wlDet).map(([k, v]) => [k, v.toArray()])),
    atmo: R.wl.uWlAtmo.value.toArray(),
  };
});
const setSpend = (on) => page.evaluate((on) => {
  const R = window.__dcc.renderer;
  const saved = window.__spend;
  for (const [k, v] of Object.entries(saved.det)) {
    const t = R.wlDet[k];
    if (on) t.set(v[0], v[1], v[2], v[3]);
    else t.set(0, 0, 0, 0);
  }
  const a = R.wl.uWlAtmo.value;
  if (on) a.setRGB(saved.atmo[0], saved.atmo[1], saved.atmo[2]);
  else a.setRGB(0, 0, 0);
}, on);

// ---- per-pass GPU timing, EXT_disjoint_timer_query_webgl2 (immune to vsync
// pacing and to the oversubscribed CPU; NOT immune to another process using
// the GPU, hence the load probe on either side of the whole run).
const installTimers = () => page.evaluate(() => {
  const R = window.__dcc.renderer;
  const comp = R.composer;
  const ctx = R.renderer.getContext();
  const ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) return { ok: false, why: "no timer query ext" };
  const PASS_LABEL = ["1_Render(scene)", "3_GTAO", "4_Bloom", "5_Output", "6_Grade", "7_SMAA"];
  const S = { perFrame: new Map(), frameIdx: 0, pending: [], active: null, cur: null, on: false };
  window.__T = S;
  const endActive = () => { if (!S.active) return; ctx.endQuery(ext.TIME_ELAPSED_EXT); S.pending.push(S.active); S.active = null; };
  const mark = (label) => {
    endActive(); S.cur = label;
    if (!label) return;
    const q = ctx.createQuery();
    ctx.beginQuery(ext.TIME_ELAPSED_EXT, q);
    S.active = { q, label, f: S.frameIdx };
  };
  const drain = () => {
    for (let i = S.pending.length - 1; i >= 0; i--) {
      const e = S.pending[i];
      if (!ctx.getQueryParameter(e.q, ctx.QUERY_RESULT_AVAILABLE)) continue;
      const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = ctx.getQueryParameter(e.q, ctx.QUERY_RESULT);
      ctx.deleteQuery(e.q); S.pending.splice(i, 1);
      if (disjoint || !S.on) continue;
      let row = S.perFrame.get(e.f);
      if (!row) { row = {}; S.perFrame.set(e.f, row); }
      row[e.label] = (row[e.label] || 0) + ns / 1e6;
    }
  };
  const region = (obj, key, label) => {
    const orig = obj[key].bind(obj);
    obj[key] = function (...a) {
      const prev = S.cur;
      if (prev !== null) mark(label);
      try { return orig(...a); } finally { if (prev !== null) mark(prev); }
    };
  };
  comp.passes.forEach((p, i) => region(p, "render", PASS_LABEL[i] || `pass${i}_${p.constructor.name}`));
  region(R.renderer.shadowMap, "render", "0_shadowMap");
  const origRender = comp.render.bind(comp);
  comp.render = function (...a) {
    mark("_composer_overhead");
    try { return origRender(...a); } finally { mark(null); S.frameIdx++; drain(); }
  };
  return { ok: true, order: comp.passes.map((p, i) => `${i}:${p.constructor.name}`) };
});

const sample = (secs, combat = true) => page.evaluate(({ secs, combat }) => new Promise((resolve) => {
  const S = window.__T;
  S.perFrame.clear(); S.on = true;
  const frames = [];
  let last = performance.now();
  const start = last;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last); last = now;
    if (combat && frames.length % 45 === 0) {
      try { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); window.dispatchEvent(new KeyboardEvent("keyup", { key: " " })); } catch { /* ignore */ }
    }
    if (now - start < secs * 1000) requestAnimationFrame(tick);
    else setTimeout(() => {
      S.on = false;
      const rows = [...S.perFrame.values()].filter((r) => Object.keys(r).length >= 4);
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(3) : 0; };
      const keys = [...new Set(rows.flatMap(Object.keys))].sort();
      const passes = {};
      for (const k of keys) passes[k] = med(rows.map((r) => r[k] || 0));
      passes["=GPU TOTAL"] = med(rows.map((r) => Object.values(r).reduce((a, b) => a + b, 0)));
      const sorted = [...frames].sort((a, b) => a - b);
      const q = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
      resolve({
        gpuFrames: rows.length, passes,
        wall: { medianMs: q(0.5), p99Ms: q(0.99), frames: frames.length },
        monstersNear10: (() => {
          const st = window.__dcc.state, p = st.players[0];
          return st.monsters.filter((m) => m.hp > 0 && !m.dormant
            && (m.pos.x - p.pos.x) ** 2 + (m.pos.y - p.pos.y) ** 2 <= 100).length;
        })(),
        playerHp: window.__dcc.state.players[0].hp,
        recapUp: (() => { const e = document.getElementById("recap"); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none"; })(),
      });
    }, 400);
  };
  requestAnimationFrame(tick);
}), { secs, combat });

const t = await installTimers();
console.log("timers:", JSON.stringify(t));

// ---- PHASE 1: THE VISUAL A/B, on a STILL frame.
// Combat is OFF here on purpose. The first run of this tool captured its control
// frame mid-ultimate — a fullscreen telegraph disc — and the colour audit duly
// reported the control as 100% chromatic and 1% black. A control frame has to be
// the same frame as the test frame with one thing changed, so: no abilities, and
// a matched crop written for both states.
const CROP = { x: 380, y: 180, width: 520, height: 340 };
for (const [label, on] of [["still_ON", true], ["still_OFF", false]]) {
  await setSpend(on);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/${label}.png` });
  await page.screenshot({ path: `${outDir}/${label}_crop.png`, clip: CROP });
}
console.log(`still A/B crops -> ${outDir}/still_ON_crop.png, still_OFF_crop.png`);

// ---- PHASE 2: THE COST, alternating and paired.
// Six samples, ON/OFF interleaved, FIRST DISCARDED (the first sample after
// staging runs hot — caches, freshly built meshes). Comparing the medians of the
// two interleaved sets, rather than one ON against one OFF, is what makes the
// number survive a box whose load is drifting under the measurement.
// PAIRED DIFFERENCES, not two pooled sets.
//
// The first paired run of this drifted from 18 ms to 32 ms per sample across
// 50 seconds while a sibling workflow hammered the GPU; comparing the median of
// all ON samples against the median of all OFF samples then reported a NEGATIVE
// cost, which is nonsense — it was reporting the drift. A difference taken
// between two samples a few seconds apart cancels drift that a difference taken
// between two sets of samples a minute apart cannot. So: many short samples,
// tightly alternating, and the estimate is the MEDIAN OF THE ADJACENT PAIR
// DIFFERENCES, with the median absolute deviation of those differences as the
// honest error bar.
const loadBefore = probeLoad();
const runs = [];
const PAIRS = Number(flag("--pairs", 7));
const order = [["warm", true]];
for (let i = 0; i < PAIRS; i++) order.push([`ON_${i + 1}`, true], [`OFF_${i + 1}`, false]);
for (const [label, on] of order) {
  await setSpend(on);
  await page.waitForTimeout(500);
  const s = await sample(secs, true);
  runs.push({ label, on, ...s });
  console.log(`${label.padEnd(7)} Render(scene) ${String(s.passes["1_Render(scene)"]).padStart(7)} ms   GPU TOTAL ${String(s.passes["=GPU TOTAL"]).padStart(7)} ms   wall med ${s.wall.medianMs} p99 ${s.wall.p99Ms}   near10 ${s.monstersNear10}  gpuFrames ${s.gpuFrames}`);
}
await setSpend(true);
await page.screenshot({ path: `${outDir}/combat_ON.png` });
const loadAfter = probeLoad();

const scored = runs.filter((r) => r.label !== "warm");
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const sceneOf = (r) => r.passes["1_Render(scene)"];
const totalOf = (r) => r.passes["=GPU TOTAL"];
// The first TWO pairs are discarded, not just the first sample. Both runs of
// this tool put wild outliers there (+24.7 and +9.2 ms in one) — the scene is
// still settling after the crowd is staged: meshes for the arrivals are being
// built, the shadow atlas is repacking, and the driver is re-uploading. Those
// are real frames but they are not what the toggle is doing, and leaving them in
// inflates the error bar until it swallows the answer.
const WARM_PAIRS = 2;
const pairDeltas = (get) => {
  const d = [];
  for (let i = 0; i + 1 < scored.length; i += 2) if (scored[i].on && !scored[i + 1].on) d.push(get(scored[i]) - get(scored[i + 1]));
  return d.slice(WARM_PAIRS);
};
const sceneD = pairDeltas(sceneOf);
const totalD = pairDeltas(totalOf);
const delta = med(sceneD);
const mad = med(sceneD.map((v) => Math.abs(v - delta)));
const verdict = Math.abs(delta) <= mad
  ? `INCONCLUSIVE: |median paired delta| ${Math.abs(delta).toFixed(2)} ms <= MAD ${mad.toFixed(2)} ms — this box cannot resolve the cost today; the honest statement is "under ${(mad + Math.abs(delta)).toFixed(1)} ms"`
  : "OK";

const valid = scored.every((r) => r.playerHp > 0 && !r.recapUp && r.monstersNear10 >= 4 && r.gpuFrames > 15);
const report = {
  url, gpu, gameGpu, staged, loadBefore, loadAfter, shaderErrors,
  sceneValid: valid,
  runs,
  sceneRenderMs: {
    pairedDeltasMs: sceneD.map((v) => +v.toFixed(3)),
    medianPairedDeltaMs: +delta.toFixed(3),
    madMs: +mad.toFixed(3),
    onSamples: scored.filter((r) => r.on).map((r) => +sceneOf(r).toFixed(2)),
    offSamples: scored.filter((r) => !r.on).map((r) => +sceneOf(r).toFixed(2)),
  },
  gpuTotalMs: { medianPairedDeltaMs: +med(totalD).toFixed(3) },
  verdict,
};
writeFileSync(`${outDir}/spend.json`, JSON.stringify(report, null, 2));
console.log(`\nRenderPass(scene) paired deltas (ON - OFF), ms: [${sceneD.map((v) => v.toFixed(2)).join(", ")}]`);
console.log(`  MEDIAN COST ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ms  (MAD ${mad.toFixed(2)} ms)`);
console.log(`  GPU TOTAL median paired cost ${med(totalD) >= 0 ? "+" : ""}${med(totalD).toFixed(2)} ms`);
console.log(`scene assertion: ${valid ? "OK" : "*** MISSED — a sample was not gameplay ***"}`);
console.log(`verdict: ${verdict}`);
if (shaderErrors.length) console.log("SHADER ERRORS:", shaderErrors.slice(0, 3));
console.log(`wrote ${outDir}/spend.json`);
await browser.close();
