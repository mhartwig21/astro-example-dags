// WHERE DOES THE FLOOR-17 FRAME GO — ablation ladder, one session, interleaved.
//
// r2 paydown. The r1 paydown left the worst scene at median 23-27 ms / GPU
// ~21 ms and named two suspects it could not price: draw calls (621-1005) and
// the world RenderPass. quality.ts's own ablation table was taken on FLOOR 8,
// where there are ~13 monsters and a fraction of the dressing; it fits
// mean ~= 1.6 + 9.65 ms/Mpx, and floor 17 measures ~17 ms/Mpx. So the floor-8
// table does not describe the scene the budget is written against, and this
// tool re-runs the ablation on the scene that does.
//
// METHOD, and why each choice:
//  * ONE page session, configs applied back-to-back and the whole ladder
//    repeated --reps times. This laptop is shared with a sibling workflow; drift
//    then scales every row together instead of corrupting one row relative to
//    the others. Report the MEDIAN across reps and the spread.
//  * VSYNC OFF (--disable-gpu-vsync) so the numbers are THROUGHPUT. A
//    vsync-paced median quantises to 16.7 ms steps and cannot resolve a 3 ms
//    subsystem. Absolute budget compliance is measured separately, WITH vsync,
//    by _r2budget.mjs — these two tools answer different questions and their
//    numbers are not interchangeable.
//  * the strict readiness gate (boot card LEAVING, program cache quiet, 3 s,
//    then an assertion that #loading has no box), and the crawler kept alive
//    from before the first page script.
//  * foreign browser load is measured across EVERY rep with the shared meter
//    and reported per rep, so a contaminated rep can be seen rather than
//    averaged in silently.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const seconds = Number(flag("--seconds", 3));
const reps = Number(flag("--reps", 3));
const ring = Number(flag("--ring", 18));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const outDir = flag("--out", "tools/_r2pay");
const only = flag("--only", "");
const url = flag("--url", `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  const BIG = 1e9;
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = BIG; p.hp = BIG; }
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

// ---- stage the worst real scene ---------------------------------------
await page.keyboard.down("w"); await page.waitForTimeout(2000); await page.keyboard.up("w");
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
  return { placed: used.length, liveTotal: live.length };
}, ring);
console.log("staged crowd:", JSON.stringify(staged));
await page.waitForTimeout(2000);

// ---- the ladder --------------------------------------------------------
const conds = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const comp = R.composer;
  const S = {};
  window.__S = S;
  const passByName = (re) => comp.passes.filter((p) => re.test(p.constructor?.name ?? ""));
  window.__cfg = {
    base() {},
    // WHO DRAWS: the two populations this scene is made of.
    props_hidden() {
      S.props = [];
      for (const e of R.propEntries ?? []) if (e.obj.visible) { S.props.push(e.obj); e.obj.visible = false; }
    },
    monsters_hidden() {
      S.mobs = [];
      for (const m of R.monsters?.values?.() ?? []) if (m.visible) { S.mobs.push(m); m.visible = false; }
    },
    // WHAT COSTS: the passes.
    shadow_off() { S.shadow = gl.shadowMap.enabled; gl.shadowMap.enabled = false; },
    gtao_off() { S.gtao = R.gtao.enabled; R.gtao.enabled = false; },
    bloom_off() { S.bloom = R.bloom.enabled; R.bloom.enabled = false; },
    smaa_off() { S.smaa = passByName(/SMAA/).map((p) => [p, p.enabled]); for (const [p] of S.smaa) p.enabled = false; },
    post_all_off() { S.post = comp.passes.slice(1).map((p) => [p, p.enabled]); for (const [p] of S.post) p.enabled = false; },
    // WHAT THE r2 SPEND COSTS: its pooled FX groups, hidden as a block.
    fx_off() {
      S.fx = [];
      const groups = [R.decals, R.aoe, R.ribbons, R.shocks, R.swingArcs, R.fxp]
        .map((s) => s?.group ?? s?.mesh ?? null).filter(Boolean);
      for (const g of groups) if (g.visible) { S.fx.push(g); g.visible = false; }
    },
    // Half resolution: the ladder's only real lever, as a reference row.
    half_res() { S.pr = comp._pixelRatio; comp.setPixelRatio(comp._pixelRatio * 0.707); },
  };
  window.__restore = () => {
    for (const o of S.props ?? []) o.visible = true; S.props = null;
    for (const m of S.mobs ?? []) m.visible = true; S.mobs = null;
    if (S.shadow !== undefined) { gl.shadowMap.enabled = S.shadow; S.shadow = undefined; }
    if (S.gtao !== undefined) { R.gtao.enabled = S.gtao; S.gtao = undefined; }
    if (S.bloom !== undefined) { R.bloom.enabled = S.bloom; S.bloom = undefined; }
    for (const [p, v] of S.smaa ?? []) p.enabled = v; S.smaa = null;
    for (const [p, v] of S.post ?? []) p.enabled = v; S.post = null;
    for (const g of S.fx ?? []) g.visible = true; S.fx = null;
    if (S.pr !== undefined) { comp.setPixelRatio(S.pr); S.pr = undefined; }
  };
  return Object.keys(window.__cfg);
});
const ladder = only ? conds.filter((c) => c === "base" || only.split(",").includes(c)) : conds;
console.log("ladder:", ladder.join(", "));

async function measure(name) {
  await page.evaluate((n) => { window.__restore(); window.__cfg[n](); }, name);
  await page.waitForTimeout(350); // let the config settle before sampling
  await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer;
    gl.info.autoReset = false;
    window.__ft = []; window.__cl = []; let last = performance.now();
    const t = () => {
      const n = performance.now();
      window.__ft.push(n - last); last = n;
      window.__cl.push(gl.info.render.calls); gl.info.reset();
      window.__raf = requestAnimationFrame(t);
    };
    window.__raf = requestAnimationFrame(t);
  });
  await page.waitForTimeout(seconds * 1000);
  return page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    const f = window.__ft.slice(3).filter((x) => x > 0).sort((a, b) => a - b);
    const c = window.__cl.slice(3);
    const q = (p) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(2) : 0);
    return {
      n: f.length, mean: +(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)).toFixed(2),
      p50: q(0.5), p90: q(0.9),
      calls: c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : 0,
    };
  });
}

const rows = new Map(ladder.map((c) => [c, []]));
const loads = [];
for (let r = 0; r < reps; r++) {
  const l0 = probeLoad();
  for (const c of ladder) {
    const m = await measure(c);
    rows.get(c).push(m);
    process.stdout.write(`  rep${r} ${c.padEnd(20)} mean ${String(m.mean).padStart(7)} ms  p50 ${String(m.p50).padStart(6)}  calls ${m.calls}\n`);
  }
  const l1 = probeLoad();
  loads.push(foreignLoadPct(l0, l1));
  console.log(`  rep${r} foreign load ${loads[r]}% of box`);
}
await page.evaluate(() => window.__restore());

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const summary = ladder.map((c) => {
  const ms = rows.get(c).map((m) => m.mean);
  return { cond: c, meanMed: +med(ms).toFixed(2), reps: ms, calls: med(rows.get(c).map((m) => m.calls)) };
});
const base = summary.find((s) => s.cond === "base")?.meanMed ?? 0;
console.log("\n==== FLOOR 17, STAGED CROWD, VSYNC OFF (THROUGHPUT) ====");
console.log(`GPU: ${gameGpu}`);
console.log(`foreign load per rep: ${loads.join("%, ")}%`);
console.log("cond                     mean(median of reps)   delta vs base   calls");
for (const s of summary) {
  const d = base ? (((s.meanMed - base) / base) * 100).toFixed(0) : "?";
  console.log(`${s.cond.padEnd(24)} ${String(s.meanMed).padStart(8)} ms        ${String(d).padStart(5)}%      ${s.calls}`);
}
writeFileSync(`${outDir}/ablate.json`, JSON.stringify({ url, gameGpu, staged, loads, summary, reps, seconds }, null, 1));
await browser.close();
