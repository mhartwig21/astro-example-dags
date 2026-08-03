// MEMORY: is the heap growing without bound, and are we allocating in hot
// loops? The owner's read is "CPU and memory bound"; this is the memory half.
//
// Three questions, three instruments:
//   1. LEAK      — forced GC checkpoints. Retained heap AFTER a full GC, taken
//                  at intervals. If that line rises without plateauing, the
//                  run leaks; if it flattens, the growth was garbage, not a leak.
//   2. CHURN     — HeapProfiler allocation sampling, attributed to call sites.
//                  This is what names the per-frame allocations in hot loops.
//   3. GC PAUSES — longtask observer + rAF spike log, so a pause shows up as
//                  the hitch a player actually feels.
//
// Usage: node tools/trk_mem.mjs [--adapter igpu|dgpu] [--minutes 4] [--port 5282]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const adapter = flag("--adapter", "igpu");
const minutes = Number(flag("--minutes", 4));
const port = Number(flag("--port", 5282));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const quality = flag("--quality", "high");

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
const url = `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=${quality}`;

console.log("[contamination] at launch:", JSON.stringify(census()));

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit",
    "--disable-gpu-vsync", "--js-flags=--expose-gc"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
let doc = null;
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return { gone: true };
    const r = e.getBoundingClientRect();
    return { gone: r.width === 0 && r.height === 0, w: r.width, h: r.height };
  });
  if (!box.gone) throw new Error(`#loading still has a box: ${JSON.stringify(box)}`);
  const gpu = await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but game context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);

  // in-page: frame spikes + long tasks
  await page.evaluate(() => {
    window.__M = { spikes: [], longtasks: [], frames: 0, worst: 0, t0: performance.now() };
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      const d = n - last; last = n;
      window.__M.frames++;
      if (d > 50) window.__M.spikes.push({ at: +(n - window.__M.t0).toFixed(0), ms: +d.toFixed(1) });
      if (d > window.__M.worst) window.__M.worst = +d.toFixed(1);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__M.longtasks.push({ at: +e.startTime.toFixed(0), ms: +e.duration.toFixed(1), name: e.name });
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* no longtask support */ }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Performance.enable");

  const metrics = async () => {
    const { metrics: m } = await cdp.send("Performance.getMetrics");
    const g = (n) => m.find((x) => x.name === n)?.value ?? 0;
    return {
      usedMB: +(g("JSHeapUsedSize") / 1048576).toFixed(1),
      totalMB: +(g("JSHeapTotalSize") / 1048576).toFixed(1),
      nodes: g("Nodes"), listeners: g("JSEventListeners"), docs: g("Documents"),
      layoutCount: g("LayoutCount"), recalcCount: g("RecalcStyleCount"),
      layoutDurS: +g("LayoutDuration").toFixed(2), recalcDurS: +g("RecalcStyleDuration").toFixed(2),
      taskDurS: +g("TaskDuration").toFixed(2), scriptDurS: +g("ScriptDuration").toFixed(2),
    };
  };

  // stage combat
  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(2000);

  const checkpoint = async (label) => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(700);
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(700);
    const m = await metrics();
    console.log(`  [${label}] retained-after-GC ${m.usedMB} MB (total ${m.totalMB}) · DOM nodes ${m.nodes} · listeners ${m.listeners} · layouts ${m.layoutCount} (${m.layoutDurS}s) · recalcs ${m.recalcCount} (${m.recalcDurS}s)`);
    return { label, ...m, wallS: +((Date.now() - startedAt) / 1000).toFixed(0), contamination: census().foreign };
  };

  const startedAt = Date.now();
  const checkpoints = [];
  const samples = [];
  console.log(`\n=== MEMORY SOAK · ${adapter.toUpperCase()} · ${minutes} min of combat ===`);
  checkpoints.push(await checkpoint("t=0"));

  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 8192 });

  const totalMs = minutes * 60000;
  const end = Date.now() + totalMs;
  const keys = ["Space", "q", "e", "c", "Space", "f", "Space", "x"];
  let i = 0;
  let nextSample = Date.now();
  let nextCheckpoint = Date.now() + totalMs / 4;
  let cp = 1;
  while (Date.now() < end) {
    await page.keyboard.press(keys[i++ % keys.length]).catch(() => {});
    // keep moving so the world streams and the pack re-forms
    if (i % 6 === 0) { await page.keyboard.down("w"); await page.waitForTimeout(400); await page.keyboard.up("w"); }
    else if (i % 6 === 3) { await page.keyboard.down("a"); await page.waitForTimeout(400); await page.keyboard.up("a"); }
    else await page.waitForTimeout(220);
    if (Date.now() >= nextSample) {
      nextSample = Date.now() + 3000;
      const m = await metrics();
      const sim = await page.evaluate(() => {
        const s = window.__dcc.state;
        return { floor: s.floor, alive: s.monsters.filter((x) => x.hp > 0).length, mobs: s.monsters.length, tick: s.tick ?? null };
      });
      samples.push({ tS: +((Date.now() - startedAt) / 1000).toFixed(0), ...m, ...sim });
    }
    if (Date.now() >= nextCheckpoint && cp < 4) {
      nextCheckpoint = Date.now() + totalMs / 4;
      checkpoints.push(await checkpoint(`t=${cp * (minutes / 4)}min`));
      cp++;
    }
  }

  const { profile: allocProfile } = await cdp.send("HeapProfiler.stopSampling");
  checkpoints.push(await checkpoint(`t=${minutes}min`));
  const play = await page.evaluate(() => ({ ...window.__M }));

  // ---- allocation profile: fold the sampling tree into self-bytes per site
  const alloc = new Map();
  const walk = (node) => {
    const cf = node.callFrame;
    const k = `${cf.functionName || "(anon)"} @ ${(cf.url || "-").split("/").pop()}:${cf.lineNumber + 1}`;
    const self = (node.selfSize ?? 0);
    if (self) alloc.set(k, (alloc.get(k) ?? 0) + self);
    for (const c of node.children ?? []) walk(c);
  };
  walk(allocProfile.head);
  const totalAlloc = [...alloc.values()].reduce((a, b) => a + b, 0);
  const wallS = (Date.now() - startedAt) / 1000;

  console.log(`\n--- HEAP OVER TIME (sampled every 3s) ---`);
  console.log("   t(s)   usedMB  totalMB   nodes  listeners  floor  alive  layouts  recalcs");
  for (const s of samples.filter((_, i2) => i2 % 3 === 0)) {
    console.log(String(s.tS).padStart(7), String(s.usedMB).padStart(8), String(s.totalMB).padStart(8),
      String(s.nodes).padStart(7), String(s.listeners).padStart(10), String(s.floor).padStart(6),
      String(s.alive).padStart(6), String(s.layoutCount).padStart(8), String(s.recalcCount).padStart(8));
  }

  const first = checkpoints[0], last = checkpoints[checkpoints.length - 1];
  console.log(`\n--- LEAK VERDICT ---`);
  console.log(`retained-after-GC: ${first.usedMB} MB -> ${last.usedMB} MB over ${(wallS / 60).toFixed(1)} min ` +
    `= ${(((last.usedMB - first.usedMB) / (wallS / 60))).toFixed(2)} MB/min`);
  console.log(`DOM nodes: ${first.nodes} -> ${last.nodes}   listeners: ${first.listeners} -> ${last.listeners}`);
  console.log(`checkpoints: ${checkpoints.map((c) => `${c.label}=${c.usedMB}MB`).join("  ")}`);

  console.log(`\n--- ALLOCATION CHURN (${(totalAlloc / 1048576).toFixed(0)} MB sampled over ${wallS.toFixed(0)}s ` +
    `= ${(totalAlloc / 1048576 / (wallS / 60)).toFixed(0)} MB/min, ${(totalAlloc / Math.max(1, play.frames) / 1024).toFixed(1)} KB/frame) ---`);
  console.log("   MB     MB/min   %   site");
  for (const [k, b] of [...alloc].sort((a, c) => c[1] - a[1]).slice(0, 22)) {
    console.log(`${(b / 1048576).toFixed(1).padStart(6)} ${(b / 1048576 / (wallS / 60)).toFixed(1).padStart(9)} ${((b / totalAlloc) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }

  console.log(`\n--- PAUSES --- frames ${play.frames} · worst rAF gap ${play.worst}ms`);
  console.log(`rAF spikes >50ms: ${play.spikes.length}  (${(play.spikes.length / (wallS / 60)).toFixed(1)}/min)`);
  const ls = play.longtasks;
  if (ls.length) {
    const sorted = ls.map((l) => l.ms).sort((a, b) => a - b);
    console.log(`longtasks: ${ls.length} (${(ls.length / (wallS / 60)).toFixed(0)}/min) · median ${sorted[sorted.length >> 1]}ms · p95 ${sorted[Math.floor(sorted.length * 0.95)]}ms · max ${sorted[sorted.length - 1]}ms`);
  }
  console.log(`worst 10 rAF spikes: ${play.spikes.sort((a, b) => b.ms - a.ms).slice(0, 10).map((s) => `${s.ms}ms@${(s.at / 1000).toFixed(0)}s`).join(", ")}`);
  console.log(`[contamination] at end: ${JSON.stringify(census())}`);

  doc = { adapter, gpu, minutes, samples, checkpoints, play, alloc: [...alloc].sort((a, c) => c[1] - a[1]).slice(0, 120), totalAlloc, wallS };
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkmem_${adapter}.json`, JSON.stringify(doc, null, 1));
console.log(`wrote tools/_trkmem_${adapter}.json`);
