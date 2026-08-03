// THE BUDGET NUMBER — worst real scene, vsync on, scene held constant.
//
// WHY THIS EXISTS AND _r2profile.mjs DOES NOT ANSWER IT. The first A/B of the
// r2 paydown was thrown away: the "before" run finished its 14 s window with 11
// live monsters inside 10 tiles and the "after" run with 69, because the staged
// ring is a real fight — mobs die, wander and re-aggro — and 14 s is long enough
// for the two runs to be looking at different scenes. Every millisecond of that
// comparison was about the crowd, not about the build. So this harness PINS the
// scene:
//
//   * the crawler is immortal (init script, armed before the first page script)
//   * so is every monster: hp is pumped every frame, so the fight never thins
//   * the ring is RE-STAGED on a fixed cadence, so the crowd cannot disperse
//   * `nearN` is sampled every 250 ms across the whole window and reported as
//     min/median/max — if two runs' crowd curves differ, the comparison is void
//     and the numbers say so instead of pretending
//
// VSYNC IS ON. This is the budget instrument, so it measures what the player
// gets: median <= 16.7 ms and p99 <= 33 ms. Throughput questions ("how much did
// subsystem X cost") belong to _r2ablate.mjs, which runs uncapped; the two are
// not interchangeable and their numbers must never be quoted against each other.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const seconds = Number(flag("--seconds", 12));
const ring = Number(flag("--ring", 18));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const tag = flag("--tag", "run");
const outDir = flag("--out", "tools/_r2pay");
const url = flag("--url", `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
// The renderer's own program guard reports any shader built after prewarm, by
// name and cache key. A program built mid-fight is a stall of hundreds of ms on
// this driver, so these lines are evidence, not noise.
const guardLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard]")) guardLines.push(t.replace(/\s+/g, " ").slice(0, 220));
});

// NOBODY DIES. The crawler dies to a beam trap ~1.5 s after a floor-17 drop-in,
// and the staged crowd dies to the crawler over the sample window; either one
// silently turns "dense combat" into "an empty room with a recap over it".
await page.addInitScript(() => {
  const BIG = 1e9;
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st) {
        if (st.players) for (const p of st.players) { p.maxHp = BIG; p.hp = BIG; }
        if (window.__holdMobs && st.monsters) {
          for (const m of st.monsters) if (m.hp > 0) m.hp = m.maxHp || m.hp;
        }
      }
    } catch { /* not up yet */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.bringToFront();

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
if (loadingBox && loadingBox.w > 0 && loadingBox.display !== "none" && Number(loadingBox.opacity) > 0.01) {
  console.error("BOOT CARD STILL UP — MISSED:", JSON.stringify(loadingBox));
  await browser.close(); process.exit(1);
}

const gameGpu = await page.evaluate(() => {
  try {
    const ctx = window.__dcc.renderer.renderer.getContext();
    const d = ctx.getExtension("WEBGL_debug_renderer_info");
    return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch (e) { return `ERR ${e.message}`; }
});
console.log("GAME CONTEXT GPU:", gameGpu);
if (/SwiftShader|Software|llvmpipe/i.test(gameGpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

// Walk so the streamed dressing is resident, then install the stager.
await page.keyboard.down("w"); await page.waitForTimeout(2000); await page.keyboard.up("w");
await page.evaluate((ring) => {
  window.__holdMobs = true;
  window.__stage = () => {
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
    used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
    return used.length;
  };
  window.__stage();
}, ring);
await page.waitForTimeout(2000);

// ---- scene census, including the prop batches ---------------------------
const scene = await page.evaluate(() => {
  const r3d = window.__dcc.renderer;
  const st = window.__dcc.state;
  const p = st.players[0];
  const batches = r3d.propBatches ?? [];
  return {
    preset: r3d.qualityProfile?.name, pixelRatioCap: r3d.qualityProfile?.pixelRatioCap,
    backbuffer: { w: r3d.renderer.domElement.width, h: r3d.renderer.domElement.height },
    propEntries: r3d.propEntries?.length ?? null,
    visibleProps: (r3d.propEntries ?? []).filter((e) => e.obj.visible).length,
    propBatches: batches.length,
    batchedLeaves: (r3d.propEntries ?? []).reduce((a, e) => a + (e.leaves?.length ?? 0), 0),
    liveBatchInstances: batches.reduce((a, b) => a + b.count, 0),
    unbatchedPropMeshes: (r3d.propEntries ?? []).reduce((a, e) => {
      let n = 0;
      e.obj.traverse((o) => { if (o.isMesh && o.visible) n++; });
      return a + n;
    }, 0),
    programs: r3d.renderer.info.programs?.length ?? 0,
    monsterMeshes: r3d.monsters?.size ?? null,
    visibleMonsterMeshes: [...(r3d.monsters?.values?.() ?? [])].filter((m) => m.visible).length,
    near10: st.monsters.filter((m) => m.hp > 0 && !m.dormant && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length,
  };
});
console.log("SCENE:", JSON.stringify(scene));

// ---- sample -------------------------------------------------------------
await page.evaluate(() => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  gl.info.autoReset = false;
  const acc = { upd: [], ren: [], calls: [], tris: [] };
  window.__acc = acc;
  const oU = r3d.update.bind(r3d);
  r3d.update = function (...a) { const t = performance.now(); oU(...a); acc.upd.push(performance.now() - t); };
  const oR = r3d.render.bind(r3d);
  r3d.render = function () {
    const t = performance.now();
    gl.info.reset();
    oR();
    acc.ren.push(performance.now() - t);
    acc.calls.push(gl.info.render.calls); acc.tris.push(gl.info.render.triangles);
  };
  // WHO ISSUES THE CALLS. renderBufferDirect is the single funnel every draw in
  // three.js passes through — shadow depth pass and post quads included.
  const cen = new Map();
  window.__census = cen;
  const oRBD = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    let k = obj?.name || obj?.userData?.kind || obj?.type || "?";
    if (obj?.isInstancedMesh) k = `INST:${k}(x${obj.count})`;
    else if (obj?.isSkinnedMesh) k = `SKIN:${k}`;
    cen.set(k, (cen.get(k) ?? 0) + 1);
    return oRBD(cam, scene, geo, mat, obj, group);
  };
  window.__ft = []; window.__near = []; window.__prog = [];
  let last = performance.now();
  const t = () => { const n = performance.now(); window.__ft.push(n - last); last = n; window.__raf = requestAnimationFrame(t); };
  window.__raf = requestAnimationFrame(t);
  window.__crowd = setInterval(() => {
    const st = window.__dcc.state, p = st.players[0];
    window.__near.push(st.monsters.filter((m) => m.hp > 0 && !m.dormant && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 10).length);
    window.__prog.push(window.__dcc.renderer.renderer.info.programs?.length ?? 0);
  }, 250);
});

// Optional V8 CPU profile over the SAME held scene. _r2profile.mjs samples a
// free-running fight, which is why its two runs disagreed about the crowd.
let cdp = null;
if (process.argv.includes("--profile")) {
  cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
}

const load0 = probeLoad();
const t0 = Date.now();
let nextStage = 0;
while (Date.now() - t0 < seconds * 1000) {
  await page.keyboard.press("Space").catch(() => {});
  if (Date.now() - t0 > nextStage) { await page.evaluate(() => window.__stage()); nextStage += 1200; }
  await page.waitForTimeout(400);
}
let cpuTop = null;
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const flat = new Map();
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n) => `${n.callFrame.functionName || "(anon)"} @${(n.callFrame.url || "").split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const incl = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const d = Math.max(0, profile.timeDeltas[i] ?? 0);
    total += d;
    const n = byId.get(profile.samples[i > 0 ? i - 1 : 0]);
    if (!n) continue;
    flat.set(key(n), (flat.get(key(n)) ?? 0) + d);
    const seen = new Set();
    for (let cur = n.id; cur !== undefined; cur = parent.get(cur)) {
      const cn = byId.get(cur); if (!cn) continue;
      const k = key(cn); if (seen.has(k)) continue;
      seen.add(k); incl.set(k, (incl.get(k) ?? 0) + d);
    }
  }
  cpuTop = {
    totalMs: +(total / 1000).toFixed(0),
    self: [...flat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, +(v / 1000).toFixed(0)]),
    incl: [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, +(v / 1000).toFixed(0)]),
  };
}
const load1 = probeLoad();
const foreign = foreignLoadPct(load0, load1);

const post = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf); clearInterval(window.__crowd);
  const acc = window.__acc;
  const srt = (a) => [...a].filter((x) => x > 0).sort((x, y) => x - y);
  const q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : 0);
  const f = srt(window.__ft);
  const near = srt(window.__near);
  const recap = document.getElementById("recap");
  let recapUp = false;
  if (recap) { const r = recap.getBoundingClientRect(); const cs = getComputedStyle(recap); recapUp = r.width > 0 && cs.display !== "none" && Number(cs.opacity) > 0.01; }
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0);
  return {
    frames: f.length, median: q(f, 0.5), p90: q(f, 0.9), p95: q(f, 0.95), p99: q(f, 0.99),
    max: f.length ? +f[f.length - 1].toFixed(2) : 0, mean: mean(f),
    over16: +((f.filter((x) => x > 16.7).length / Math.max(1, f.length)) * 100).toFixed(1),
    over33: +((f.filter((x) => x > 33).length / Math.max(1, f.length)) * 100).toFixed(1),
    calls: Math.round(mean(acc.calls)), ktris: Math.round(mean(acc.tris) / 1000),
    cpuUpdate: q(srt(acc.upd), 0.5), cpuRender: q(srt(acc.ren), 0.5),
    cpuUpdateP95: q(srt(acc.upd), 0.95), cpuRenderP95: q(srt(acc.ren), 0.95),
    nearMin: near[0] ?? 0, nearMed: q(near, 0.5), nearMax: near[near.length - 1] ?? 0,
    programsStart: window.__prog[0] ?? 0, programsEnd: window.__prog[window.__prog.length - 1] ?? 0,
    census: [...window.__census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
      .map(([k, v]) => [k, +(v / Math.max(1, acc.calls.length)).toFixed(1)]),
    censusFrames: acc.calls.length,
    playerHp: window.__dcc.state.players[0].hp, recapUp,
  };
});

await page.screenshot({ path: `${outDir}/${tag}_scene.png` });
await browser.close();

const valid = post.playerHp > 0 && !post.recapUp && post.nearMed >= 8;
console.log(`\n==== ${tag} — FLOOR 17, STAGED CROWD, VSYNC ON ====`);
console.log(`GPU ${gameGpu}`);
console.log(`backbuffer ${scene.backbuffer.w}x${scene.backbuffer.h}  preset ${scene.preset} @ ${scene.pixelRatioCap}`);
console.log(`SCENE VALID: ${valid ? "OK" : "*** MISSED ***"}  hp=${post.playerHp} recap=${post.recapUp}`);
console.log(`crowd inside 10 tiles across the window: min ${post.nearMin} / med ${post.nearMed} / max ${post.nearMax}`);
console.log(`programs ${post.programsStart} -> ${post.programsEnd} (a rise is a mid-fight shader build)`);
console.log(`foreign browser load: ${foreign}% of box`);
console.log(`\n  median ${post.median} ms   p90 ${post.p90}   p95 ${post.p95}   p99 ${post.p99}   max ${post.max}   mean ${post.mean}`);
console.log(`  frames over 16.7 ms: ${post.over16}%    over 33 ms: ${post.over33}%`);
console.log(`  draw calls ${post.calls}   ktris ${post.ktris}`);
console.log(`  cpu update ${post.cpuUpdate} (p95 ${post.cpuUpdateP95})   cpu render ${post.cpuRender} (p95 ${post.cpuRenderP95})`);
console.log(`  BUDGET median<=16.7 ${post.median <= 16.7 ? "PASS" : "MISS"}   p99<=33 ${post.p99 <= 33 ? "PASS" : "MISS"}`);
console.log("  draws per frame, by object:");
for (const [k, v] of post.census) console.log(`    ${String(v).padStart(6)}  ${k}`);
if (guardLines.length) {
  console.log(`\n  SHADER GUARD (${guardLines.length} lines) — each post-boot build is a frame hitch:`);
  for (const l of guardLines.slice(0, 24)) console.log(`    ${l}`);
}
if (cpuTop) {
  const per = (v) => (v / Math.max(1, post.frames)).toFixed(2);
  console.log(`\n  CPU PROFILE over the same held scene (${cpuTop.totalMs} ms sampled, ${post.frames} frames)`);
  console.log("  --- inclusive ms/frame ---");
  for (const [k, v] of cpuTop.incl.slice(0, 22)) console.log(`    ${String(per(v)).padStart(6)}  ${k}`);
  console.log("  --- self ms/frame ---");
  for (const [k, v] of cpuTop.self.slice(0, 16)) console.log(`    ${String(per(v)).padStart(6)}  ${k}`);
}
writeFileSync(`${outDir}/${tag}_budget.json`, JSON.stringify({ tag, url, gameGpu, scene, post, foreign, seconds, ring, guardLines, cpuTop }, null, 1));
