// WHERE THE r3 FRAME GOES — one browser session, three instruments.
//
// r3 paydown. The r2 paydown left the worst scene at median ~31-41 ms and named
// the next lever ("rigged monsters at NINE draw calls each") without pricing it.
// The r3 SPEND then added fog fetches, a character pow()+mix(), an AoE
// inscription and 18 decorated plates. This tool re-prices the whole frame on
// the CURRENT build so the paydown is aimed at what is actually expensive.
//
// ONE session, because the laptop crashed under concurrent browsers:
//   1. scene + draw census (who issues the calls, by label)
//   2. a V8 CPU profile with buckets that ACTUALLY MATCH the bundled names
//      (r2's bucket list scored animation at 6.5 ms across a 14 s window while
//      the same profile's own rows put animTick at 1.54 SECONDS inclusive —
//      the regex looked for `AnimationMixer` and the bundle emits `update`,
//      `evaluate`, `slerpFlat`, `_setValue_fromArray_...`. Buckets here match
//      on the CALL CHAIN, not the leaf name.)
//   3. an ablation ladder, interleaved and repeated, vsync OFF so a 2 ms
//      subsystem is resolvable at all.
//
// VSYNC IS OFF here: these are THROUGHPUT numbers for ranking subsystems. The
// budget contract (median <= 16.7, p99 <= 33) is measured separately, WITH
// vsync, by _accept2.mjs. The two are not interchangeable.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeLoad, foreignLoadPct, waitForIdle } from "./_boxload.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_r4diag");
const ring = Number(flag("--ring", 22));
const reps = Number(flag("--reps", 3));
const seconds = Number(flag("--seconds", 3));
const skipIdle = process.argv.includes("--no-gate");
const only = flag("--only", "");
mkdirSync(outDir, { recursive: true });

const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };
const flush = () => writeFileSync(`${outDir}/diag.log`, log.join("\n"));

const VP = { width: 1440, height: 852 }, DPR = 2;
const url = `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: VP, deviceScaleFactor: DPR });
const page = await context.newPage();
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));

// crawler kept alive from before the first page script (it dies to a floor-17
// beam trap ~1.5 s in otherwise, and every sample after that is a death recap)
await page.addInitScript(() => {
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; }
    } catch { /* not up yet */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const out = { url, ring, reps, seconds };

await page.goto(url, { waitUntil: "load", timeout: 180000 });
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => say("(assets-settled timeout)"));
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => say("(loading card never left)"));
await page.waitForFunction(() => {
  const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
  const w = window;
  if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
  return (w.__ph || 0) >= 14;
}, { timeout: 180000, polling: 100 }).catch(() => say("(program count never settled)"));
await page.waitForTimeout(3200);

const box = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
});
if (box && box.w > 0 && box.h > 0 && box.display !== "none" && box.opacity > 0.01) {
  say("BOOT CARD STILL UP — refusing:", JSON.stringify(box)); flush(); await browser.close(); process.exit(1);
}
out.gameGpu = await page.evaluate(() => {
  const ctx = window.__dcc.renderer.renderer.getContext();
  const d = ctx.getExtension("WEBGL_debug_renderer_info");
  return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
say("GAME CONTEXT GPU:", out.gameGpu);
if (/SwiftShader|Software|llvmpipe/i.test(out.gameGpu)) { say("REFUSING: software GL"); flush(); await browser.close(); process.exit(2); }

// ------------------------------------------------------- stage the worst scene
await page.keyboard.down("w"); await page.waitForTimeout(2000); await page.keyboard.up("w");
out.staged = await page.evaluate((n) => {
  const st = window.__dcc.state, p = st.players[0], mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
  const spots = [];
  for (let ri = 0; ri < 7 && spots.length < n; ri++) {
    const r = 1.8 + ri * 0.8;
    for (let k = 0; k < 20 && spots.length < n; k++) {
      const a = (k / 20) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((q) => Math.hypot(q.x - x, q.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
  // PIN THE SCENE. r2 threw an A/B away because its two arms held 11 and 69
  // monsters; the staged ring is a live fight and mobs die and wander.
  const hold = () => {
    try {
      const s2 = window.__dcc.state, pl = s2.players[0];
      const near = s2.monsters.filter((m) => m.hp > 0)
        .map((m) => ({ m, d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) }))
        .sort((a, b) => a.d - b.d);
      near.forEach((e, i) => { if (i < n) { e.m.maxHp = Math.max(e.m.maxHp || 1, 5e5); e.m.hp = 5e5; e.m.dormant = false; } });
    } catch { /* */ }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
  return { placed: used.length, liveTotal: live.length };
}, ring);
say("staged:", JSON.stringify(out.staged));
await page.waitForTimeout(2500);

// burn off first-use shader compiles before anything is measured
const keys = ["Space", "Shift", "q", "c", "f"];
const fireFor = async (ms) => {
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) { await page.keyboard.press(keys[i++ % keys.length], { delay: 30 }); await page.waitForTimeout(130); }
};
await fireFor(7000);

if (!skipIdle) {
  const g = await waitForIdle("diag", { log: say, maxWaitMs: 1200000 });
  out.idleGate = { idle: g.idle, foreignLoadPct: g.foreignLoadPct };
}

// ================================================================= 1. CENSUS
say("\n===== SCENE + DRAW CENSUS =====");
await page.evaluate(() => {
  const R = window.__dcc.renderer, gl = R.renderer, scene = R.scene;
  const name = new Map();
  for (const c of scene.children) name.set(c, c.name || c.type);
  const labelOf = (o) => {
    if (!o) return "(none)";
    let top = o, chain = [];
    while (top) { chain.push(top); if (name.has(top)) break; top = top.parent; }
    const root = chain[chain.length - 1];
    const base = name.get(root) || root?.type || "?";
    // rigged bodies: attribute to the monster kind, not the part
    let mk = o; while (mk && !mk.userData?.simKind) mk = mk.parent;
    if (mk) return `mob:${mk.userData.simKind}`;
    if (o.isInstancedMesh) return `inst:${base}:${o.name || o.geometry?.name || "-"}`;
    return `${base}:${o.name || o.type}`;
  };
  const stats = new Map();
  let frames = 0;
  const orig = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (camera, sc, geometry, material, object, group) {
    const lbl = (object && object.type === "Mesh" && !object.parent) ? "FULLSCREEN_QUAD" : labelOf(object);
    const e = stats.get(lbl) || { calls: 0, tris: 0 };
    e.calls++;
    const idx = geometry?.index ? geometry.index.count : (geometry?.attributes?.position?.count ?? 0);
    e.tris += (idx / 3) * (object?.isInstancedMesh ? object.count : 1);
    stats.set(lbl, e);
    return orig(camera, sc, geometry, material, object, group);
  };
  const origC = R.composer.render.bind(R.composer);
  R.composer.render = function (...a) { frames++; return origC(...a); };
  window.__cen = {
    reset() { stats.clear(); frames = 0; },
    dump() {
      const rows = [...stats].map(([label, v]) => ({ label, calls: +(v.calls / Math.max(1, frames)).toFixed(1), ktris: Math.round(v.tris / Math.max(1, frames) / 1000) }))
        .sort((a, b) => b.calls - a.calls);
      return { frames, total: +rows.reduce((a, r) => a + r.calls, 0).toFixed(1), rows: rows.slice(0, 30) };
    },
    shape() {
      const R2 = window.__dcc.renderer, s = R2.scene, st = window.__dcc.state;
      let objects = 0, meshes = 0, skinned = 0, inst = 0, instances = 0, lights = 0, pointLights = 0, visPoint = 0;
      const mats = new Set(), geos = new Set();
      let autoMtx = 0;
      s.traverse((o) => {
        objects++;
        if (o.matrixAutoUpdate) autoMtx++;
        if (o.isInstancedMesh) { inst++; instances += o.count; meshes++; }
        else if (o.isSkinnedMesh) { skinned++; meshes++; }
        else if (o.isMesh) meshes++;
        if (o.isLight) { lights++; if (o.type === "PointLight") { pointLights++; if (o.visible) visPoint++; } }
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) mats.add(m.uuid);
        if (o.geometry) geos.add(o.geometry.uuid);
      });
      const mobs = [...(R2.monsters?.values?.() ?? [])];
      const p = st.players[0];
      return {
        objects, meshes, skinnedMeshes: skinned, instancedMeshes: inst, instances,
        lights, pointLights, visiblePointLights: visPoint,
        materials: mats.size, geometries: geos.size, autoUpdatingMatrices: autoMtx,
        simMonsters: st.monsters.length,
        liveMonsters: st.monsters.filter((m) => m.hp > 0).length,
        monsterMeshes: mobs.length,
        visibleMonsterMeshes: mobs.filter((m) => m.visible).length,
        riggedMonsterMeshes: mobs.filter((m) => m.userData.mixer).length,
        riggedVisible: mobs.filter((m) => m.visible && m.userData.mixer).length,
        near11: st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 11).length,
        preset: R2.qualityProfile?.name, pixelRatio: R2.renderer.getPixelRatio(),
        backbuffer: `${R2.renderer.getContext().drawingBufferWidth}x${R2.renderer.getContext().drawingBufferHeight}`,
        dmgElements: document.querySelectorAll(".dmg").length,
        plateElements: document.querySelectorAll(".mobplate,.plate,[class*=plate]").length,
        passes: R2.composer.passes.map((x) => `${x.constructor.name}:${x.enabled ? "on" : "off"}`),
        rtType: R2.composer.renderTarget1?.texture?.type,
      };
    },
  };
});
out.shape = await page.evaluate(() => window.__cen.shape());
say("shape:", JSON.stringify(out.shape));
await page.evaluate(() => window.__cen.reset());
await fireFor(4000);
out.census = await page.evaluate(() => window.__cen.dump());
say(`draw calls/frame: ${out.census.total} over ${out.census.frames} frames`);
for (const r of out.census.rows) say(`   ${String(r.calls).padStart(6)}  ${String(r.ktris).padStart(5)} ktri  ${r.label}`);
flush();

// ================================================================ 2. PROFILE
if (only === "" || only.includes("profile")) {
  say("\n===== CPU PROFILE =====");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  const l0 = probeLoad();
  await cdp.send("Profiler.start");
  await fireFor(12000);
  const { profile } = await cdp.send("Profiler.stop");
  const l1 = probeLoad();
  await cdp.send("Profiler.disable");
  out.profileForeignLoadPct = foreignLoadPct(l0, l1);

  // Buckets match on the CALL CHAIN root-to-leaf; first match from the LEAF up
  // wins, so a sample inside AnimationMixer.update inside our monster loop
  // lands on animation. Names are what the BUNDLE emits, verified against the
  // r2 profile's own rows.
  const BUCKETS = [
    ["gc", (f) => /garbage collector/.test(f)],
    ["idle", (f) => /^\(idle\)/.test(f)],
    ["animation(mixer/skinning)", (f) => /animTick|AnimationMixer|_setValue_fromArray|slerpFlat|^evaluate |PropertyBinding|Interpolant|animateRigged|Skeleton\.update|computeBoneTexture/.test(f)],
    ["gl:setProgram/uniforms", (f) => /setProgram|refreshUniforms|WebGLUniforms|^upload |setValueV|getUniforms|onFirstUse|getProgramInfoLog/.test(f)],
    ["gl:renderBufferDirect", (f) => /renderBufferDirect/.test(f)],
    ["gl:projectObject/sort", (f) => /projectObject|renderObjects|renderObject |PainterSort|renderScene/.test(f)],
    ["gl:matrixWorld", (f) => /updateMatrixWorld|updateWorldMatrix|multiplyMatrices|setFromRotationMatrix|^compose |decompose/.test(f)],
    ["gl:shadowmap", (f) => /shadow/i.test(f)],
    ["gl:texture upload", (f) => /texSubImage|texImage|texStorage|uploadTexture/.test(f)],
    ["sim:step", (f) => /@game\.ts|@ai\.ts|@floor\.ts|@abilities\.ts|@items\.ts/.test(f)],
    ["host:plates/hud", (f) => /refreshPlateHudRects|plateHud|refreshHud|updateHud|touchShell|shown @/.test(f)],
    ["host:damage numbers", (f) => /paintNumeral|dmgMeasure|spawnNumeral|placeNumeral/.test(f)],
    ["host:renderer3d.update", (f) => /@renderer3d\.ts/.test(f)],
    ["host:main3d", (f) => /@main3d\.ts/.test(f)],
    ["fx", (f) => /@fx\.ts|@fxParticles\.ts|@fxTrails\.ts|@bossFx\.ts|@fogOfWar\.ts/.test(f)],
  ];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n) => {
    const f = n.callFrame;
    const u = (f.url || "").split("/").pop().split("?")[0] || "";
    return `${f.functionName || "(anonymous)"} @${u}:${f.lineNumber + 1}`;
  };
  const self = new Map(), incl = new Map(), bucket = new Map();
  let totalUs = 0;
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, timeDeltas[i] ?? 0);
    totalUs += d;
    const n = byId.get(samples[i]); if (!n) continue;
    const k = key(n);
    self.set(k, (self.get(k) || 0) + d);
    // chain leaf -> root
    const seen = new Set(); let cur = samples[i]; let bkt = null;
    while (cur !== undefined) {
      const nn = byId.get(cur); if (!nn) break;
      const kk = key(nn);
      if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) || 0) + d); }
      if (!bkt) for (const [bn, test] of BUCKETS) if (test(kk)) { bkt = bn; break; }
      cur = parent.get(cur);
    }
    bkt = bkt || "other";
    bucket.set(bkt, (bucket.get(bkt) || 0) + d);
  }
  const frames = out.census.frames || 1;
  const framesProfiled = await page.evaluate(() => window.__cen.frames?.() ?? 0);
  const nf = await page.evaluate(() => { const f = window.__dcc.renderer; return f.frameNo; });
  out.profile = {
    totalMs: +(totalUs / 1000).toFixed(1),
    foreignLoadPct: out.profileForeignLoadPct,
    buckets: [...bucket].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 1000).toFixed(0)]),
    self: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, +(v / 1000).toFixed(0)]),
    incl: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, +(v / 1000).toFixed(0)]),
  };
  say(`profiled ${out.profile.totalMs} ms wall, foreign load ${out.profileForeignLoadPct}%`);
  say("-- buckets (ms of wall) --");
  for (const [k, v] of out.profile.buckets) say(`   ${String(v).padStart(6)}  ${k}`);
  say("-- self top --");
  for (const [k, v] of out.profile.self) say(`   ${String(v).padStart(6)}  ${k}`);
  say("-- inclusive top --");
  for (const [k, v] of out.profile.incl) say(`   ${String(v).padStart(6)}  ${k}`);
  flush();
}

// ================================================================ 3. ABLATION
if (only === "" || only.includes("ablate")) {
  say("\n===== ABLATION LADDER (vsync off = throughput) =====");
  const conds = await page.evaluate(() => {
    const R = window.__dcc.renderer, gl = R.renderer, comp = R.composer;
    const S = {}; window.__S = S;
    window.__cfg = {
      base() {},
      // THE CANDIDATE: mixers tick for every monster in state.monsters, visible
      // or not. This row prices skipping the invisible ones.
      anim_visible_only() {
        S.anim = [];
        for (const m of R.monsters.values()) {
          const ud = m.userData; if (!ud.animTick || ud.__wrapped) continue;
          const orig = ud.animTick; ud.__orig = orig; ud.__wrapped = true;
          ud.animTick = (dt) => { if (m.visible) orig(dt); };
          S.anim.push(m);
        }
      },
      // The same lever from the other side: NOTHING animates.
      anim_all_off() {
        S.anim = [];
        for (const m of R.monsters.values()) {
          const ud = m.userData; if (!ud.animTick || ud.__wrapped) continue;
          ud.__orig = ud.animTick; ud.__wrapped = true; ud.animTick = () => {};
          S.anim.push(m);
        }
      },
      post_all_off() { S.post = comp.passes.slice(1).map((p) => [p, p.enabled]); for (const [p] of S.post) p.enabled = false; },
      gtao_off() { S.gtao = R.gtao.enabled; R.gtao.enabled = false; },
      bloom_off() { S.bloom = R.bloom.enabled; R.bloom.enabled = false; },
      smaa_off() { S.smaa = comp.passes.filter((p) => /SMAA/.test(p.constructor.name)).map((p) => [p, p.enabled]); for (const [p] of S.smaa) p.enabled = false; },
      half_res() { S.pr = comp._pixelRatio; comp.setPixelRatio(comp._pixelRatio * 0.707); },
      quarter_res() { S.pr = comp._pixelRatio; comp.setPixelRatio(comp._pixelRatio * 0.5); },
      // Shadow by CADENCE, not by capability: gl.shadowMap.enabled is in
      // three's program cache key and toggling it rebuilds every material.
      shadow_cadence_off() { S.si = R.quality.shadowInterval; R.quality = { ...R.quality, shadowInterval: 100000 }; },
      // The r3 SPEND's fullscreen fog planes.
      fog_off() { S.fog = []; const g = R.fogBank?.group ?? R.fogBank?.mesh; if (g && g.visible) { g.visible = false; S.fog.push(g); } },
      // The r3 SPEND's decorated plates + the damage numerals (DOM/layout).
      hud_off() {
        S.hud = [];
        for (const sel of [".mobplate", ".dmg", "#plates", "#mobplates"]) {
          for (const e of document.querySelectorAll(sel)) { if (e.style.display !== "none") { S.hud.push([e, e.style.display]); e.style.display = "none"; } }
        }
      },
    };
    window.__restore = () => {
      for (const m of S.anim ?? []) { const ud = m.userData; if (ud.__wrapped) { ud.animTick = ud.__orig; ud.__wrapped = false; } } S.anim = null;
      for (const [p, v] of S.post ?? []) p.enabled = v; S.post = null;
      if (S.gtao !== undefined) { R.gtao.enabled = S.gtao; S.gtao = undefined; }
      if (S.bloom !== undefined) { R.bloom.enabled = S.bloom; S.bloom = undefined; }
      for (const [p, v] of S.smaa ?? []) p.enabled = v; S.smaa = null;
      if (S.pr !== undefined) { R.composer.setPixelRatio(S.pr); S.pr = undefined; }
      if (S.si !== undefined) { R.quality = { ...R.quality, shadowInterval: S.si }; S.si = undefined; }
      for (const g of S.fog ?? []) g.visible = true; S.fog = null;
      for (const [e, v] of S.hud ?? []) e.style.display = v; S.hud = null;
    };
    return Object.keys(window.__cfg);
  });
  const ladder = conds;
  say("ladder:", ladder.join(", "));

  const measure = async (name) => {
    await page.evaluate((n) => { window.__restore(); window.__cfg[n](); }, name);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const gl = window.__dcc.renderer.renderer;
      gl.info.autoReset = false;
      window.__ft = []; window.__cl = []; let last = performance.now();
      const t = () => {
        const n = performance.now(); window.__ft.push(n - last); last = n;
        window.__cl.push(gl.info.render.calls); gl.info.reset();
        window.__raf = requestAnimationFrame(t);
      };
      window.__raf = requestAnimationFrame(t);
    });
    await page.waitForTimeout(seconds * 1000);
    return page.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      const f = window.__ft.slice(4).filter((x) => x > 0).sort((a, b) => a - b);
      const c = window.__cl.slice(4);
      const q = (p) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(2) : 0);
      const st = window.__dcc.state, pl = st.players[0];
      return {
        n: f.length, p50: q(0.5), p90: q(0.9),
        mean: +(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)).toFixed(2),
        calls: c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : 0,
        crowd: st.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) <= 11).length,
      };
    });
  };

  const rows = new Map(ladder.map((c) => [c, []]));
  for (let r = 0; r < reps; r++) {
    const l0 = probeLoad();
    for (const c of ladder) {
      const m = await measure(c);
      rows.get(c).push(m);
      say(`  rep${r} ${c.padEnd(22)} p50 ${String(m.p50).padStart(7)}  mean ${String(m.mean).padStart(7)}  calls ${String(m.calls).padStart(5)}  crowd ${m.crowd}`);
    }
    const l1 = probeLoad();
    say(`  rep${r} foreign load ${foreignLoadPct(l0, l1)}%`);
    flush();
  }
  await page.evaluate(() => window.__restore());

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const basep = med(rows.get("base").map((m) => m.p50));
  out.ablate = [...rows].map(([k, v]) => ({
    cond: k, p50: med(v.map((m) => m.p50)), mean: med(v.map((m) => m.mean)),
    calls: med(v.map((m) => m.calls)), crowd: med(v.map((m) => m.crowd)),
    deltaPct: +(((med(v.map((m) => m.p50)) - basep) / basep) * 100).toFixed(1),
  })).sort((a, b) => a.p50 - b.p50);
  say("\n-- LADDER (median of reps, p50 ms) --");
  for (const r of out.ablate) say(`   ${String(r.p50).padStart(7)} ms  ${String(r.deltaPct).padStart(6)}%  calls ${String(r.calls).padStart(5)}  crowd ${String(r.crowd).padStart(3)}  ${r.cond}`);
}

writeFileSync(`${outDir}/diag.json`, JSON.stringify(out, null, 2));
flush();
await browser.close();
say("done.");
flush();
