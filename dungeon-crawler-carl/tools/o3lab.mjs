// OPT-R3 MEASUREMENT LAB.
//
// What this changes about tools/r2lab.mjs, which every contract in quality.ts
// currently rests on:
//
//  1. THE SCENE IS THE ONE THE GAME IS PLAYED IN. r2lab's `__toPack` teleports
//     the crawler into the densest pack and PINS THEM ALIVE, standing still,
//     never swinging. Staging the same pack with the crawler attacking and
//     spending abilities degrades every mode 15-45% while showing FEWER bodies,
//     so the cost is the combat FX, not the density. `fight(page)` here drives
//     real input (slot1..4 + ultimate on their default binds) for the whole
//     window, and `__toPack` still runs so the pack is there to swing at.
//
//  2. THE CANARY IS A GPU PROBE. r2lab's canary swapped an empty scene into
//     the RenderPass and timed rAF — which leaves the GAME's entire per-frame
//     CPU running, so the reading rises with SCENE LOAD on a completely quiet
//     box (4-5 ms parked in the dense pack, 8-18 ms mid-fight, foreign
//     chrome.exe at 10 and idle). Against its 14 ms iGPU ceiling that
//     systematically discarded the expensive mode in the expensive scene:
//     every HIGH fight window, and every dGPU fight window. A canary that
//     evicts the hard cases biases the table toward the easy ones, which is
//     the same direction as every other error this round exists to fix.
//
//     `__gpucanary` here runs on its OWN WebGL2 context on an OWN canvas: a
//     fixed-cost fragment workload over a fixed 512x512 target, N draws, then
//     `fenceSync` + `clientWaitSync` to wall-clock the GPU rather than the
//     event loop. The game's CPU cannot enter it and the game's scene cannot
//     change it, so what it reports is what it claims to report: whether the
//     shared adapter is somebody else's right now.
//
//  3. IT SPLITS THE FRAME. `__phase` wraps renderer.update (host CPU) and
//     renderer.render (submission + post) and reports both per window next to
//     delivered time, so "CPU or GPU" stops being an inference from ablations.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

export const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };

export const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
export const has = (n) => process.argv.includes(n);

export function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
}

/**
 * The full statistical shape of one window.
 *
 * `overBudget` IS NEW AND IT IS THE POINT. MeasuredShape carried only `over33`,
 * and test/quality.test.ts graded EVERY mode's maxOverPct against it — including
 * LOW, whose budgetMs is 20. LOW's documented ceiling ("the SHARE of individual
 * frames allowed over budgetMs") was therefore never evaluated once; it was
 * graded against a threshold 66% looser than the field describes. A shape that
 * cannot express the mode's own budget cannot audit the mode's own contract.
 */
export function shape(deltas, wallMs, budgetMs = null) {
  const n = deltas.length;
  if (!n) return null;
  const sum = deltas.reduce((a, b) => a + b, 0);
  const over = (t) => +(100 * deltas.filter((d) => d > t).length / n).toFixed(1);
  return {
    n,
    fps: +(n / (wallMs / 1000)).toFixed(2),
    delivered: +(wallMs / n).toFixed(2),
    mean: +(sum / n).toFixed(2),
    p50: pct(deltas, 0.5),
    p90: pct(deltas, 0.9),
    p99: pct(deltas, 0.99),
    max: +Math.max(...deltas).toFixed(1),
    over16: over(16.7),
    over33: over(33.3),
    overBudget: budgetMs == null ? null : over(budgetMs),
  };
}

export function pool(windows, budgetMs = null) {
  const d = [];
  let wall = 0;
  for (const w of windows) { d.push(...w.deltas); wall += w.wallMs; }
  return shape(d, wall, budgetMs);
}

export const BUDGET = { low: 20, medium: 33.3, high: null };

export async function boot({ adapter, port = 5282, w = 1440, h = 852, dpr = 2, url: urlOverride, vsync = false }) {
  const url = urlOverride
    ?? `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=high`;
  const args = [...ADAPTERS[adapter], "--enable-gpu-rasterization"];
  // vsync quantises everything to 8.33 ms multiples on this 120 Hz panel, so a
  // "median 25.0 ms" is really "somewhere in 16.7-25.0 ms of work". Off by
  // default; on when the question is what a PLAYER receives.
  if (!vsync) args.push("--disable-frame-rate-limit", "--disable-gpu-vsync");
  const browser = await chromium.launch({ headless: false, args });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.addInitScript(() => {
    let styled = false;
    setInterval(() => {
      if (!styled && document.head) {
        styled = true;
        const css = document.createElement("style");
        css.textContent = "#recap{display:none !important}";
        document.head.appendChild(css);
      }
      const s = window.__dcc?.state;
      if (!s?.players) return;
      for (const p of s.players) { p.hp = p.maxHp; p.alive = true; }
      if (s.status !== "playing") s.status = "playing";
    }, 60);
  });

  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(
    () => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); },
    { timeout: 240000 },
  );
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
  return { browser, context, page, gpu };
}

export async function installProbe(page) {
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;

    const S = { deltas: [], on: false, t0: 0, upd: 0, ren: 0, updN: 0, gpuSamples: [], gpuBad: 0 };
    window.__S = S;
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      if (S.on) S.deltas.push(n - last);
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // ---- PHASE SPLIT ----------------------------------------------------
    // The diagnosis this round inherits says "CPU-bound"; the previous rounds
    // treated the frame as a GPU budget. Neither was measured directly. These
    // two wrappers are the direct measurement: host per-frame JS on one side,
    // submission + post on the other.
    const realUpdate = r3d.update.bind(r3d);
    const realRender = r3d.render.bind(r3d);
    r3d.update = (...a) => {
      const t = performance.now();
      try { return realUpdate(...a); } finally { if (S.on) { S.upd += performance.now() - t; S.updN++; } }
    };
    r3d.render = (...a) => {
      const t = performance.now();
      try { return realRender(...a); } finally { if (S.on) S.ren += performance.now() - t; }
    };

    // ---- THE GPU CLOCK: EXT_disjoint_timer_query_webgl2 --------------
    //
    // THREE INSTRUMENTS WERE TRIED BEFORE THIS ONE AND ALL THREE LIED, which is
    // worth writing down because each failure looked like data:
    //
    //   rAF deltas, sandwiched   — the swap chain queues cheap callbacks and
    //     then blocks, so a window samples a BIMODAL distribution whose mode
    //     mix depends on when it opened. The SAME arm scored 0.884 and 1.431 in
    //     consecutive reps of one script.
    //   fenceSync + clientWaitSync — WebGL2 forbids a nonzero timeout, and
    //     busy-polling with timeout 0 stops Chrome ever submitting the
    //     commands, so the fence cannot signal. Every reading was the bail-out.
    //   gl.finish()              — returned in 0.007 ms while composer.render()
    //     itself blocked for 42.9 ms: the driver had already drained the queue
    //     inside the render call, so finish had nothing left to wait for and
    //     measured nothing.
    //
    // A TIME_ELAPSED query measures the GPU's own clock over the commands
    // between begin and end. It does not care how contended the CPU is, it does
    // not care how deep the swap chain is, and GPU_DISJOINT_EXT tells you when
    // the result is untrustworthy so those samples can be dropped rather than
    // averaged in. It is the only reading on this box that answers "did this
    // change make the frame cheaper" instead of "what were the neighbours
    // doing".
    const glctx = gl.getContext();
    const TQ = glctx.getExtension("EXT_disjoint_timer_query_webgl2");
    const qPending = [];
    const qFree = [];
    let qActive = false;
    const realRender2 = r3d.render.bind(r3d);
    r3d.render = (...a) => {
      const t = performance.now();
      let q = null;
      if (TQ && S.on && !qActive) {
        q = qFree.pop() || glctx.createQuery();
        glctx.beginQuery(TQ.TIME_ELAPSED_EXT, q);
        qActive = true;
      }
      try {
        realRender2(...a);
      } finally {
        if (q) { glctx.endQuery(TQ.TIME_ELAPSED_EXT); qActive = false; qPending.push(q); }
        if (S.on) { S.ren += performance.now() - t; }
        // Drain whatever the GPU has finished by now. Never blocks.
        while (qPending.length) {
          const head = qPending[0];
          if (!glctx.getQueryParameter(head, glctx.QUERY_RESULT_AVAILABLE)) break;
          qPending.shift();
          const disjoint = glctx.getParameter(TQ.GPU_DISJOINT_EXT);
          const ns = glctx.getQueryParameter(head, glctx.QUERY_RESULT);
          qFree.push(head);
          if (disjoint) { S.gpuBad++; continue; }
          S.gpuSamples.push(ns / 1e6);
        }
      }
    };
    window.__hasGpuTimer = () => !!TQ;

    window.__winStart = () => {
      S.deltas.length = 0; S.upd = S.ren = S.updN = 0;
      S.gpuSamples.length = 0; S.gpuBad = 0;
      S.on = true; S.t0 = performance.now();
    };
    window.__winEnd = () => {
      S.on = false;
      const n = Math.max(1, S.updN);
      const g = S.gpuSamples.slice().sort((a, b) => a - b);
      return {
        deltas: S.deltas.slice(), wallMs: performance.now() - S.t0,
        updateMs: +(S.upd / n).toFixed(3), renderMs: +(S.ren / n).toFixed(3),
        // The MEDIAN GPU sample, not the mean: a timer query that straddles a
        // rival process's work is a long sample, not a wrong one, and a median
        // over a few hundred frames rejects those without pretending they
        // did not happen (gpuN/gpuBad report how many there were).
        gpuMs: g.length ? +g[Math.floor(g.length / 2)].toFixed(3) : null,
        gpuP90: g.length ? +g[Math.floor(g.length * 0.9)].toFixed(3) : null,
        gpuN: g.length, gpuBad: S.gpuBad,
      };
    };

    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };

    window.__fp = () => {
      const raw = gl.getContext();
      const q = r3d.qualityProfile;
      return [
        q.name, raw.drawingBufferWidth, raw.drawingBufferHeight, q.shadowMapSize,
        q.shadowInterval, q.offscreenRigHz, r3d.renderScale, gl.getPixelRatio().toFixed(3),
      ].join("|");
    };

    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0, parked = 0;
      for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
      let nodes = 0, skinned = 0, bones = 0;
      r3d.scene.traverse((o) => { nodes++; if (o.isSkinnedMesh) skinned++; if (o.isBone) bones++; });
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      const info = gl.info;
      return {
        floor: s.floor, monsters: s.monsters.length, visible: vis, parked,
        nodes, skinned, bones, alive: !!you?.alive,
        calls: info.render.calls, tris: info.render.triangles,
        programs: info.programs ? info.programs.length : -1,
        geometries: info.memory.geometries, textures: info.memory.textures,
      };
    };

    window.__toPack = () => {
      const s = window.__dcc.state;
      const mobs = s.monsters.filter((m) => m.hp > 0);
      if (!mobs.length) return null;
      let bi = -1, bn = -1;
      for (let i = 0; i < mobs.length; i++) {
        let n = 0;
        for (let j = 0; j < mobs.length; j++) {
          const dx = mobs[i].pos.x - mobs[j].pos.x, dy = mobs[i].pos.y - mobs[j].pos.y;
          if (dx * dx + dy * dy <= 36) n++;
        }
        if (n > bn) { bn = n; bi = i; }
      }
      let cx = 0, cy = 0, n = 0;
      for (const m of mobs) {
        const dx = m.pos.x - mobs[bi].pos.x, dy = m.pos.y - mobs[bi].pos.y;
        if (dx * dx + dy * dy <= 36) { cx += m.pos.x; cy += m.pos.y; n++; }
      }
      const you = s.players[0];
      you.pos.x = cx / n; you.pos.y = cy / n;
      you.hp = you.maxHp; you.alive = true;
      // THE PACK HAS TO SURVIVE THE MEASUREMENT. A fight window kills bodies,
      // so without this the visible count walked 21 -> 2 across one sandwich
      // and every later arm was charged for a lighter scene than the earlier
      // ones — the exact defect r2lab was built to remove, reintroduced by
      // the act of actually fighting. Monsters are never spliced out of
      // state.monsters, so a full revive restores the staged density exactly.
      for (const m of s.monsters) { m.hp = m.maxHp; }
      return { packSize: bn };
    };

    /** Park the crawler as far from any live monster as the room allows. */
    window.__toQuiet = () => {
      const s = window.__dcc.state;
      const you = s.players[0];
      let best = null, bestD = -1;
      for (let i = 0; i < 600; i++) {
        const a = (i / 600) * Math.PI * 2, r = 6 + (i % 9) * 2.5;
        const x = you.pos.x + Math.cos(a) * r, y = you.pos.y + Math.sin(a) * r;
        let d = 1e9;
        for (const m of s.monsters) { if (m.hp <= 0) continue; const dx = m.pos.x - x, dy = m.pos.y - y; d = Math.min(d, dx * dx + dy * dy); }
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      if (best) { you.pos.x = best.x; you.pos.y = best.y; }
      return best;
    };

    // ---- ABLATIONS ------------------------------------------------------
    const passes = r3d.composer.passes;
    const byName = (n) => passes.find((p) => p.constructor.name === n);
    const emptyScene = new (r3d.scene.constructor)();
    const renderPass = byName("RenderPass");
    const gradePass = passes.find((p) => p.constructor.name === "ShaderPass" && p !== r3d.smaa);
    const outputPass = byName("OutputPass");
    const realComposerRender = r3d.composer.render.bind(r3d.composer);
    const AB = {
      smaa: (on) => { r3d.smaa.enabled = !on; },
      grade: (on) => { if (gradePass) gradePass.enabled = !on; },
      bloom: (on) => { r3d.bloom.enabled = !on; },
      gtao: (on) => { r3d.gtao.enabled = !on; },
      output: (on) => { if (outputPass) outputPass.enabled = !on; },
      nopost: (on) => {
        r3d.composer.render = on
          ? () => { gl.setRenderTarget(null); gl.render(r3d.scene, r3d.camera); }
          : realComposerRender;
      },
      noscene: (on) => { renderPass.scene = on ? emptyScene : r3d.scene; },
      halfres: (on) => { r3d.setRenderScale(on ? 0.5 : 1); },
      freezegraph: (on) => { r3d.scene.matrixWorldAutoUpdate = !on; },
      /** Skip the host's whole per-frame update: pure "is it the CPU" arm. */
      noupdate: (on) => { r3d.update = on ? () => {} : (...a) => {
        const t = performance.now();
        try { return realUpdate(...a); } finally { if (S.on) { S.upd += performance.now() - t; S.updN++; } }
      }; },
      /**
       * The key light's shadow PASS, off — without touching
       * `renderer.shadowMap.enabled`, which is a material define and would
       * recompile every program in the scene (a several-hundred-ms build, i.e.
       * exactly the thing being measured).
       */
      noshadow: (on) => { r3d.key.castShadow = !on; },
      // ---- OVERDRAW PROBES ----
      // The fight scene costs 15-45% more than the same pack standing still
      // while showing FEWER bodies, so the delta is the combat FX. These arms
      // hide by BLEND MODE rather than by group name, so nothing that draws a
      // transparent quad can hide from the measurement by living in a group the
      // harness has not heard of.
      //
      // THEY MOVE OBJECTS TO A LAYER, NOT `.visible`. renderer.update() rewrites
      // `.visible` on meshes every single frame, so a `.visible = false`
      // ablation survives exactly one frame and then silently measures nothing.
      // Nothing in the renderer touches `.layers`.
      noalpha: (on) => hideWhere(on, (m) => m.transparent === true),
      noadditive: (on) => hideWhere(on, (m) => m.blending === 2 /* AdditiveBlending */),
      nofx: (on) => hideRoots(on, ["fxp", "swingArcs", "ribbons", "decals", "shocks", "aoe", "bossFx", "ambientFx"]
        .map((n) => r3d[n]?.group ?? r3d[n])),
      nomonsters: (on) => hideRoots(on, [...r3d.monsters.values()]),
      nofloor: (on) => hideRoots(on, [r3d.floorGroup]),
      /**
       * THE FORWARD LIGHT LOOP. A forward PBR fragment shader evaluates EVERY
       * point light for EVERY fragment — 4 pooled impact lights + 8 pooled
       * torch lights + the hero lamp — and the world material covers the whole
       * screen. Hiding the lights changes NUM_POINT_LIGHTS, which forks the
       * program, so this arm pays one recompile and needs a long settle; that
       * is also exactly why it is not a per-mode lever today (quality.ts pins
       * the pool sizes identical across modes for this reason).
       */
      nopoint: (on) => {
        const lights = [];
        r3d.scene.traverse((o) => { if (o.isPointLight) lights.push(o); });
        for (const l of lights) l.visible = !on;
        return lights.length;
      },
      /** Half the point lights, the shape a per-mode pool cut would have. */
      halfpoint: (on) => {
        const lights = [];
        r3d.scene.traverse((o) => { if (o.isPointLight) lights.push(o); });
        lights.forEach((l, i) => { l.visible = on ? i % 2 === 0 : true; });
        return lights.length;
      },
      /** The generative PBR detail map's contribution, ALU only (fetch stays). */
      nodetail: (on) => {
        for (const k of ["floor", "wall", "prop", "canopy"]) {
          const v = r3d.wlDet?.[k]?.value;
          if (!v) continue;
          if (on) { v.__save = [v.y, v.z, v.w]; v.y = v.z = v.w = 0; }
          else if (v.__save) { [v.y, v.z, v.w] = v.__save; }
        }
      },
    };
    const hiddenLayer = [];
    function park(o) { hiddenLayer.push(o); o.layers.set(1); }
    function unpark() { for (const o of hiddenLayer) o.layers.set(0); hiddenLayer.length = 0; }
    function hideWhere(on, pred) {
      if (!on) return unpark();
      r3d.scene.traverse((o) => {
        if (!o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some(pred)) park(o);
      });
    }
    /** three.js keeps walking a parked group's CHILDREN, so park the subtree. */
    function hideRoots(on, roots) {
      if (!on) return unpark();
      for (const r of roots) { if (r?.traverse) r.traverse(park); }
    }
    window.__ab = (name, on) => { AB[name](on); return window.__fp(); };
    window.__abList = () => Object.keys(AB);

    // ---- A REAL GPU CANARY ----------------------------------------------
    //
    // Own canvas, own WebGL2 context, fixed workload, fenced. Nothing about the
    // game's scene or the game's CPU can move this number, which is exactly
    // what the old one could not say: it left the game's per-frame CPU running
    // and therefore rose with scene load on a quiet box, discarding the
    // expensive mode in the expensive scene.
    (() => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 512;
      const g = cv.getContext("webgl2", { antialias: false, depth: false, powerPreference: "high-performance" });
      if (!g) { window.__gpucanary = () => -1; return; }
      const vs = `#version 300 es
      void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0,1); }`;
      const fs = `#version 300 es
      precision highp float; out vec4 o; uniform float u;
      void main(){
        vec3 a = vec3(0.0); vec2 q = gl_FragCoord.xy * 0.01 + u;
        for (int i = 0; i < 96; i++) { q = abs(q) / dot(q,q) - 0.7; a += vec3(q, length(q)) * 0.01; }
        o = vec4(a, 1.0);
      }`;
      const mk = (t, s) => { const sh = g.createShader(t); g.shaderSource(sh, s); g.compileShader(sh); return sh; };
      const pr = g.createProgram();
      g.attachShader(pr, mk(g.VERTEX_SHADER, vs));
      g.attachShader(pr, mk(g.FRAGMENT_SHADER, fs));
      g.linkProgram(pr);
      g.useProgram(pr);
      const uu = g.getUniformLocation(pr, "u");
      const va = g.createVertexArray();
      g.bindVertexArray(va);
      const draw = (n) => {
        for (let i = 0; i < n; i++) { g.uniform1f(uu, i * 0.01); g.drawArrays(g.TRIANGLES, 0, 3); }
      };
      draw(4); g.finish(); // warm the program
      /** Wall ms for a fixed GPU workload. Quiet iGPU ~ its own floor; a
       *  contended one is a multiple of it. Returns ms for 24 draws. */
      // TWO WAYS OF WAITING FOR THE GPU THAT DO NOT WORK IN CHROME, both tried
      // here first, because the failure mode of each is a plausible-looking
      // number rather than an error:
      //
      //   clientWaitSync(sync, 0, timeout>0)  — WebGL2 forbids a nonzero
      //     timeout, so it returns TIMEOUT_EXPIRED immediately. This probe
      //     read 0.1 ms in every scene and "proved" the adapter was idle.
      //   busy-polling clientWaitSync(sync, 0, 0) — the JS thread spinning is
      //     exactly what stops Chrome's compositor thread from ever submitting
      //     the commands, so the fence cannot signal and every reading is the
      //     bail-out timeout. This one read 4000 ms in every arm.
      //
      // `finish()` is the one that does what it says: Chrome implements it as a
      // synchronous round trip to the GPU process ending in a real glFinish.
      window.__gpucanary = () => {
        const t0 = performance.now();
        draw(24);
        g.finish();
        return +(performance.now() - t0).toFixed(2);
      };
    })();
  });
}

/**
 * THE FIGHT WINDOW. Drives the crawler's real input for the whole measurement:
 * every ability slot on cooldown plus a held basic attack.
 */
export async function fightStart(page) {
  await page.evaluate(() => {
    if (window.__fightT) return;
    const keys = [" ", "Shift", "q", "c", "f"];
    let i = 0;
    const send = (type, key) => {
      const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
    };
    // slot1 (space) stays DOWN — the basic swing is held in real play.
    send("keydown", " ");
    window.__fightT = setInterval(() => {
      const k = keys[++i % keys.length];
      if (k === " ") return;
      send("keydown", k);
      setTimeout(() => send("keyup", k), 90);
    }, 260);
  });
}

export async function fightStop(page) {
  await page.evaluate(() => {
    if (!window.__fightT) return;
    clearInterval(window.__fightT);
    window.__fightT = null;
    for (const k of [" ", "Shift", "q", "c", "f"]) {
      const ev = new KeyboardEvent("keyup", { key: k, bubbles: true });
      window.dispatchEvent(ev); document.dispatchEvent(ev);
    }
  });
}

/**
 * Measure ONE window. `scene` is "dense" (pinned, standing still — the r2
 * REFERENCE_SCENE), "fight" (same pack, swinging) or "quiet".
 */
export async function window1(page, { secs, scene = "fight", settleMs = 1200, budgetMs = null }) {
  if (scene === "quiet") { await page.evaluate(() => window.__toQuiet()); }
  else { await page.evaluate(() => window.__toPack()); }
  await page.waitForTimeout(settleMs);
  if (scene === "fight") await fightStart(page);
  const c0 = census();
  const fp0 = await page.evaluate(() => window.__fp());
  const before = await page.evaluate(() => window.__scene());
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(secs * 1000);
  const raw = await page.evaluate(() => window.__winEnd());
  const fp1 = await page.evaluate(() => window.__fp());
  const after = await page.evaluate(() => window.__scene());
  if (scene === "fight") await fightStop(page);
  const c1 = census();
  if (fp0 !== fp1) throw new Error(`fingerprint moved mid-window: ${fp0} -> ${fp1}`);
  return {
    ...raw,
    fp: fp0,
    visible: before.visible,
    visibleEnd: after.visible,
    nodes: after.nodes,
    calls: after.calls,
    tris: after.tris,
    foreign: Math.max(c0.foreign ?? 0, c1.foreign ?? 0),
    shape: shape(raw.deltas, raw.wallMs, budgetMs),
  };
}

/** Poll the real GPU canary until the adapter is ours, or say it never was. */
export async function waitForQuietGpu(page, { maxMs, tries = 8, everyMs = 10000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const reads = [];
    for (let k = 0; k < 3; k++) reads.push(await page.evaluate(() => window.__gpucanary()));
    last = Math.min(...reads);
    console.log(`[gpucanary] ${last} ms (of ${reads.join("/")}) — want <= ${maxMs}, foreign=${census().foreign}`);
    if (last <= maxMs) return { ok: true, canary: last, waited: i };
    if (i < tries - 1) await page.waitForTimeout(everyMs);
  }
  return { ok: false, canary: last, waited: tries };
}

export async function stage(page, { minMobs = 12 } = {}) {
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(1200);
  let st = null;
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(2000);
    st = await page.evaluate(() => window.__scene());
    console.log(`[stage] attempt ${i + 1}: visible=${st.visible} nodes=${st.nodes} alive=${st.alive} calls=${st.calls}`);
    if (st.visible >= minMobs) break;
  }
  if (!st?.alive) throw new Error("crawler dead at staging time");
  return st;
}

/** Sandwiched A/B — every arm scored against the mean of its own neighbours. */
export async function sandwich(page, arms, { secs, reps, apply, scene = "fight", label = "" }) {
  const ratios = new Map(arms.map((a) => [a, []]));
  const gpuRatios = new Map(arms.map((a) => [a, []]));
  const bases = [];
  const runOne = async (arm) => {
    await apply(page, arm);
    await page.waitForTimeout(250);
    try { return await window1(page, { secs, scene }); } finally { await apply(page, null); }
  };
  let prevBase = await runOne(null);
  console.log(`warm base delivered=${prevBase.shape.delivered}ms`);
  for (let r = 0; r < reps; r++) {
    const order = arms.map((_, i) => arms[(i + r) % arms.length]);
    for (const arm of order) {
      const w = await runOne(arm);
      const nextBase = await runOne(null);
      bases.push(prevBase, nextBase);
      const ref = (prevBase.shape.delivered + nextBase.shape.delivered) / 2;
      const ratio = w.shape.delivered / ref;
      ratios.get(arm).push(ratio);
      if (w.gpuMs != null && prevBase.gpuMs && nextBase.gpuMs) {
        gpuRatios.get(arm).push(w.gpuMs / ((prevBase.gpuMs + nextBase.gpuMs) / 2));
      }
      console.log(
        `r${r} ${arm.padEnd(14)} arm=${String(w.shape.delivered).padStart(7)}ms base~${ref.toFixed(1)}ms `
        + `wall=${ratio.toFixed(3)}  GPU ${String(w.gpuMs).padStart(6)}ms vs ${((prevBase.gpuMs + nextBase.gpuMs) / 2).toFixed(2)}ms `
        + `= ${(w.gpuMs / ((prevBase.gpuMs + nextBase.gpuMs) / 2)).toFixed(3)}  `
        + `upd=${w.updateMs} n=${w.gpuN}/bad${w.gpuBad} vis=${w.visible} foreign=${w.foreign}`,
      );
      prevBase = nextBase;
    }
  }
  const basePool = pool(bases);
  const table = {};
  console.log(`\n=== ${label} — sandwiched A/B, ${reps} rotated reps, scene=${scene} ===`);
  console.log(`base (pooled ${bases.length} windows): ${basePool.delivered} ms delivered / ${basePool.fps} fps  `
    + `p50=${basePool.p50} p90=${basePool.p90} p99=${basePool.p99} over16=${basePool.over16}% over33=${basePool.over33}%`);
  for (const a of arms) {
    const rs = ratios.get(a).sort((x, y) => x - y);
    const med = rs[Math.floor(rs.length / 2)];
    const gs = gpuRatios.get(a).sort((x, y) => x - y);
    const gmed = gs.length ? gs[Math.floor(gs.length / 2)] : null;
    table[a] = {
      ratios: rs, median: +med.toFixed(3),
      savedPct: +(100 * (1 - med)).toFixed(1),
      savedMs: +((1 - med) * basePool.delivered).toFixed(2),
      gpuRatios: gs, gpuMedian: gmed == null ? null : +gmed.toFixed(3),
    };
    console.log(
      `${a.padEnd(14)} ratio=${med.toFixed(3)} saved=${String(table[a].savedPct).padStart(6)}% `
      + `(${table[a].savedMs} ms)  gpuRatio=${gmed == null ? "-" : gmed.toFixed(3)}  `
      + `spread ${rs[0].toFixed(3)}..${rs[rs.length - 1].toFixed(3)}`,
    );
  }
  return { base: basePool, table };
}
