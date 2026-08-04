// IS THE GAME STILL BUILDING SHADER PROGRAMS WHILE YOU FIGHT?
//
// The r2 paydown CPU profile put 44.5% of ALL main-thread self time in
// gl.getProgramInfoLog, reached through setProgram -> WebGLProgram.getUniforms
// -> onFirstUse. That is three.js's DEFERRED LINK CHECK: the first time a
// program is actually used, three asks the driver for the program info log,
// which forces ANGLE to finish linking on the calling thread. It is paid once
// per program — so 21 ms/frame averaged over a 12 s window means programs are
// being first-used CONTINUOUSLY, in a scene that is supposed to be prewarmed.
//
// A previous round rejected `checkShaderErrors = false` on the grounds that it
// "only moves the stall to first USE of the program". That is true and is
// exactly why this tool does not measure that flag: it measures whether NEW
// PROGRAMS ARE BEING CREATED AT ALL during play, which is the thing that has to
// stop. Three independent counters, because one of them alone can be explained
// away:
//   1. renderer.info.programs.length sampled on a timer (does the cache grow?)
//   2. every gl.getProgramInfoLog / gl.linkProgram / gl.compileShader call,
//      counted AND timed (what does the driver actually block on, and when?)
//   3. the build's own [shader-guard] console warnings, which name the
//      permutation prewarm missed.
//
// Usage: node tools/_r2shaders.mjs [--port 5282] [--seconds 25] [--ring 18]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const seconds = Number(flag("--seconds", 25));
const ring = Number(flag("--ring", 18));
const outDir = flag("--out", "tools/_r2pay");
const url = flag("--url", `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const guard = [];
page.on("console", (m) => { const t = m.text(); if (/shader-guard/.test(t)) guard.push(t.slice(0, 300)); });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Count and TIME the three GL entry points that can block on the shader
// compiler, from before any page script so nothing is missed.
await page.addInitScript(() => {
  const BIG = 1e9;
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = BIG; p.hp = BIG; } } catch { /* not up */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);

  window.__gl = { infoLog: { n: 0, ms: 0 }, link: { n: 0, ms: 0 }, compile: { n: 0, ms: 0 }, createProgram: 0, timeline: [] };
  const wrap = (proto) => {
    if (!proto || proto.__dccWrapped) return;
    proto.__dccWrapped = true;
    const patch = (name, bucket) => {
      const orig = proto[name];
      if (typeof orig !== "function") return;
      proto[name] = function (...a) {
        const t = performance.now();
        const r = orig.apply(this, a);
        const d = performance.now() - t;
        const b = window.__gl[bucket];
        b.n++; b.ms += d;
        if (d > 4) window.__gl.timeline.push({ at: +performance.now().toFixed(0), call: name, ms: +d.toFixed(1) });
        return r;
      };
    };
    patch("getProgramInfoLog", "infoLog");
    patch("linkProgram", "link");
    patch("compileShader", "compile");
    const oc = proto.createProgram;
    if (typeof oc === "function") proto.createProgram = function (...a) { window.__gl.createProgram++; return oc.apply(this, a); };
  };
  wrap(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  wrap(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
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

const box = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { w: r.width, display: cs.display, opacity: cs.opacity };
});
if (box && box.w > 0 && box.display !== "none" && Number(box.opacity) > 0.01) { console.error("BOOT CARD STILL UP — MISSED"); await browser.close(); process.exit(1); }

const gameGpu = await page.evaluate(() => {
  const ctx = window.__dcc.renderer.renderer.getContext();
  const d = ctx.getExtension("WEBGL_debug_renderer_info");
  return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
console.log("GAME CONTEXT GPU:", gameGpu);

const atBoot = await page.evaluate(() => ({
  programs: window.__dcc.renderer.renderer.info.programs.length,
  gl: JSON.parse(JSON.stringify(window.__gl)),
}));
console.log(`AT BOOT (readiness gate open): programs=${atBoot.programs} createProgram=${atBoot.gl.createProgram} ` +
  `getProgramInfoLog n=${atBoot.gl.infoLog.n} ${atBoot.gl.infoLog.ms.toFixed(0)}ms | linkProgram n=${atBoot.gl.link.n} ${atBoot.gl.link.ms.toFixed(0)}ms`);
console.log(`shader-guard lines so far: ${guard.length}`);

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
console.log("staged:", JSON.stringify(staged));
await page.waitForTimeout(2500);

// ---- the window: sample every second while a fight runs ----
const mark = await page.evaluate(() => ({ programs: window.__dcc.renderer.renderer.info.programs.length, gl: JSON.parse(JSON.stringify(window.__gl)) }));
const guardAtStart = guard.length;
const load0 = probeLoad();
const rows = [];
for (let s = 0; s < seconds; s++) {
  await page.keyboard.press("Space").catch(() => {});
  if (s % 4 === 1) await page.keyboard.press("q").catch(() => {});
  if (s % 4 === 3) await page.keyboard.press("e").catch(() => {});
  await page.waitForTimeout(1000);
  const r = await page.evaluate(() => ({
    programs: window.__dcc.renderer.renderer.info.programs.length,
    gl: JSON.parse(JSON.stringify(window.__gl)),
    materials: (() => { const s = new Set(); window.__dcc.renderer.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) s.add(m.uuid); }); return s.size; })(),
  }));
  rows.push(r);
}
const load1 = probeLoad();
const foreign = foreignLoadPct(load0, load1);

console.log(`\nFOREIGN BROWSER LOAD DURING THE WINDOW: ${foreign}% of the box`);
console.log("\n  t  programs  materials  | getProgramInfoLog   linkProgram   compileShader   createProgram");
console.log("            (cache)              n /   ms          n /   ms       n /   ms");
let prev = mark;
rows.forEach((r, i) => {
  const d = (a, b, k) => `${String(b.gl[k].n - a.gl[k].n).padStart(4)} / ${String((b.gl[k].ms - a.gl[k].ms).toFixed(0)).padStart(5)}`;
  console.log(`${String(i + 1).padStart(3)}  ${String(r.programs).padStart(8)}  ${String(r.materials).padStart(9)}  |  ${d(prev, r, "infoLog")}   ${d(prev, r, "link")}   ${d(prev, r, "compile")}   ${String(r.gl.createProgram - prev.gl.createProgram).padStart(6)}`);
  prev = r;
});

const last = rows[rows.length - 1];
console.log(`\nOVER THE WHOLE ${seconds}s FIGHT WINDOW:`);
console.log(`  programs in cache      ${mark.programs} -> ${last.programs}   (delta ${last.programs - mark.programs})`);
console.log(`  gl.createProgram       ${last.gl.createProgram - mark.gl.createProgram}`);
console.log(`  gl.linkProgram         ${last.gl.link.n - mark.gl.link.n} calls, ${(last.gl.link.ms - mark.gl.link.ms).toFixed(0)} ms`);
console.log(`  gl.compileShader       ${last.gl.compile.n - mark.gl.compile.n} calls, ${(last.gl.compile.ms - mark.gl.compile.ms).toFixed(0)} ms`);
console.log(`  gl.getProgramInfoLog   ${last.gl.infoLog.n - mark.gl.infoLog.n} calls, ${(last.gl.infoLog.ms - mark.gl.infoLog.ms).toFixed(0)} ms  <-- the deferred link check`);
console.log(`  [shader-guard] lines   ${guard.length - guardAtStart} during the window (${guard.length} total)`);
for (const g of guard.slice(0, 12)) console.log("    ", g.replace(/\n/g, " | ").slice(0, 220));

const slow = last.gl.timeline.filter((t) => t.ms > 8).slice(-25);
console.log(`\n  individual GL calls over 8 ms (last 25 of ${last.gl.timeline.length} over 4 ms):`);
for (const t of slow) console.log(`    t=${t.at}ms  ${t.call}  ${t.ms} ms`);

writeFileSync(`${outDir}/shaders.json`, JSON.stringify({ url, gameGpu, atBoot, mark, rows, guard, foreignLoadPct: foreign, staged }, null, 2));
console.log(`\nWROTE ${outDir}/shaders.json`);
await browser.close();
