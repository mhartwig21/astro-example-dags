// ACCEPTANCE ROUND 3 — INDEPENDENT MEASUREMENT LAB.
//
// Written from scratch rather than imported from tools/o3lab.mjs, because this
// pass is an audit of the numbers that lab produced. It shares only the
// contamination meter (tools/trk_census.mjs), which was read line by line first.
//
// What it does that o3lab does not:
//
//  1. IT AUDITS THE PRESET *DURING* THE WINDOW, NOT AT ITS ENDS. o3lab compares
//     a fingerprint before and after and throws if it moved. That cannot see a
//     preset that steps down and back up inside one window, and it cannot see
//     the levers it does not print. `__fpFull` samples the ENTIRE profile plus
//     the live pixel ratio, drawing buffer, render scale and quality CHOICE, on
//     a 250 ms interval for the whole window, and the window reports the set of
//     distinct fingerprints seen. One entry = the mode was active throughout.
//
//  2. IT REPORTS over16.7 AND over33.3 SIDE BY SIDE for every mode, not just
//     the mode's own budget, so the three rungs are comparable on one number.
//
//  3. IT CENSUSES THE BOX THREE TIMES PER WINDOW (open, mid, close) and keeps
//     the max, so a sibling browser that launches mid-window is not averaged
//     away by a before/after pair that both happened to be clean.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

export const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
export const BUDGET = { low: 20, medium: 33.3, high: null };

export const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
export const has = (n) => process.argv.includes(n);

export function pctl(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
}

export function shape(deltas, wallMs, budgetMs = null) {
  const n = deltas.length;
  if (!n) return null;
  const over = (t) => +(100 * deltas.filter((d) => d > t).length / n).toFixed(1);
  return {
    n,
    fps: +(n / (wallMs / 1000)).toFixed(2),
    delivered: +(wallMs / n).toFixed(2),
    mean: +(deltas.reduce((a, b) => a + b, 0) / n).toFixed(2),
    p50: pctl(deltas, 0.5),
    p90: pctl(deltas, 0.9),
    p99: pctl(deltas, 0.99),
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

export async function boot({ adapter, port = 5282, w = 1440, h = 852, dpr = 2, quality = "high",
  floor = 15, level = 26, seed = 41, vsync = false }) {
  const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=${level}&seed=${seed}`
    + `&abilities=all&debug=1&quality=${quality}`;
  const args = [...ADAPTERS[adapter], "--enable-gpu-rasterization"];
  if (!vsync) args.push("--disable-frame-rate-limit", "--disable-gpu-vsync");
  const browser = await chromium.launch({ headless: false, args });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  // Keep the crawler alive so a 5 s fight window is not a 5 s death screen.
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
  // data-assets-settled is NOT playable: the boot card still runs shader
  // precompile behind it. Wait, then demand the loading element has no box.
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
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log(`GAME CONTEXT GPU (${adapter}): ${gpu}`);
  return { browser, context, page, gpu };
}

export async function installProbe(page) {
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    const S = { deltas: [], on: false, t0: 0, gpu: [], gpuBad: 0, fps: new Set() };
    window.__S = S;

    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      if (S.on) S.deltas.push(n - last);
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // ---- GPU CLOCK ----
    const glctx = gl.getContext();
    const TQ = glctx.getExtension("EXT_disjoint_timer_query_webgl2");
    const pending = [], free = [];
    let active = false;
    const realRender = r3d.render.bind(r3d);
    r3d.render = (...a) => {
      let q = null;
      if (TQ && S.on && !active) {
        q = free.pop() || glctx.createQuery();
        glctx.beginQuery(TQ.TIME_ELAPSED_EXT, q);
        active = true;
      }
      try { return realRender(...a); } finally {
        if (q) { glctx.endQuery(TQ.TIME_ELAPSED_EXT); active = false; pending.push(q); }
        while (pending.length) {
          const h = pending[0];
          if (!glctx.getQueryParameter(h, glctx.QUERY_RESULT_AVAILABLE)) break;
          pending.shift();
          const disjoint = glctx.getParameter(TQ.GPU_DISJOINT_EXT);
          const ns = glctx.getQueryParameter(h, glctx.QUERY_RESULT);
          free.push(h);
          if (disjoint) { S.gpuBad++; continue; } else S.gpu.push(ns / 1e6);
        }
      }
    };

    // ---- THE FULL PRESET FINGERPRINT ----
    // Every field of the live profile, plus what the pipeline is actually
    // configured to right now. If any of this moves mid-window, the number the
    // window produced does not belong to the mode it claims.
    window.__fpFull = () => {
      const raw = gl.getContext();
      const q = r3d.qualityProfile;
      return JSON.stringify({
        name: q.name,
        choice: r3d.qualitySetting,
        pr: +gl.getPixelRatio().toFixed(4),
        bw: raw.drawingBufferWidth, bh: raw.drawingBufferHeight,
        rs: r3d.renderScale,
        prCap: q.pixelRatioCap, smaa: q.smaa, msaa: q.msaaSamples,
        gtao: q.gtao, gs: q.gtaoScale, gds: q.gtaoDenoiseScale,
        gsam: q.gtaoSamples, gdsam: q.gtaoDenoiseSamples,
        bloom: q.bloom, bs: q.bloomScale,
        sms: q.shadowMapSize, si: q.shadowInterval,
        rig: q.offscreenRigHz, fx: q.fxDensity, mote: q.moteDensity,
        fxl: q.fxLights, torch: q.torchLights,
        // live pipeline state, not the profile's opinion of it
        gtaoOn: !!r3d.gtao?.enabled, bloomOn: !!r3d.bloom?.enabled, smaaOn: !!r3d.smaa?.enabled,
        shadowOn: !!r3d.renderer.shadowMap.enabled, keyShadow: !!r3d.key?.castShadow,
        shadowMap: r3d.key?.shadow?.mapSize?.width ?? null,
      });
    };

    window.__winStart = () => {
      S.deltas.length = 0; S.gpu.length = 0; S.gpuBad = 0;
      S.fps = new Set([window.__fpFull()]);
      S.on = true; S.t0 = performance.now();
      S.poll = setInterval(() => S.fps.add(window.__fpFull()), 250);
    };
    window.__winEnd = () => {
      S.on = false;
      clearInterval(S.poll);
      S.fps.add(window.__fpFull());
      const g = S.gpu.slice().sort((a, b) => a - b);
      return {
        deltas: S.deltas.slice(), wallMs: performance.now() - S.t0,
        gpuMs: g.length ? +g[Math.floor(g.length / 2)].toFixed(3) : null,
        gpuP90: g.length ? +g[Math.floor(g.length * 0.9)].toFixed(3) : null,
        gpuN: g.length, gpuBad: S.gpuBad,
        fps: [...S.fps],
      };
    };

    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };

    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0;
      for (const [, mesh] of r3d.monsters) if (mesh.visible) vis++;
      let nodes = 0;
      r3d.scene.traverse(() => { nodes++; });
      const info = gl.info;
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      return {
        floor: s.floor, monsters: s.monsters.length, liveMonsters: s.monsters.filter((m) => m.hp > 0).length,
        visible: vis, nodes, alive: !!you?.alive,
        calls: info.render.calls, tris: info.render.triangles,
        programs: info.programs ? info.programs.length : -1,
      };
    };

    // Teleport into the densest live cluster and revive it, so a fight window
    // cannot be charged for a pack it just killed.
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
      for (const m of s.monsters) m.hp = m.maxHp;
      return { packSize: bn };
    };

    window.__toQuiet = () => {
      const s = window.__dcc.state;
      const you = s.players[0];
      let best = null, bestD = -1;
      for (let i = 0; i < 600; i++) {
        const a = (i / 600) * Math.PI * 2, r = 6 + (i % 9) * 2.5;
        const x = you.pos.x + Math.cos(a) * r, y = you.pos.y + Math.sin(a) * r;
        let d = 1e9;
        for (const m of s.monsters) {
          if (m.hp <= 0) continue;
          const dx = m.pos.x - x, dy = m.pos.y - y;
          d = Math.min(d, dx * dx + dy * dy);
        }
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      if (best) { you.pos.x = best.x; you.pos.y = best.y; }
      return best;
    };
  });
}

export async function fightStart(page) {
  await page.evaluate(() => {
    if (window.__fightT) return;
    const keys = [" ", "Shift", "q", "c", "f"];
    let i = 0;
    const send = (type, key) => {
      const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      window.dispatchEvent(ev); document.dispatchEvent(ev);
    };
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

/** One measurement window. Censuses the box at open, middle and close. */
export async function window1(page, { secs, scene = "fight", settleMs = 1300, budgetMs = null }) {
  if (scene === "quiet") await page.evaluate(() => window.__toQuiet());
  else await page.evaluate(() => window.__toPack());
  await page.waitForTimeout(settleMs);
  if (scene === "fight") await fightStart(page);
  const cA = census();
  const before = await page.evaluate(() => window.__scene());
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(Math.round(secs * 500));
  const cB = census();
  await page.waitForTimeout(Math.round(secs * 500));
  const raw = await page.evaluate(() => window.__winEnd());
  const after = await page.evaluate(() => window.__scene());
  if (scene === "fight") await fightStop(page);
  const cC = census();
  return {
    ...raw,
    visible: before.visible, visibleEnd: after.visible,
    liveStart: before.liveMonsters, liveEnd: after.liveMonsters,
    nodes: after.nodes, calls: after.calls, tris: after.tris, programs: after.programs,
    foreign: Math.max(cA.foreign ?? -1, cB.foreign ?? -1, cC.foreign ?? -1),
    shape: shape(raw.deltas, raw.wallMs, budgetMs),
  };
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
    console.log(`[stage] try ${i + 1}: visible=${st.visible} live=${st.liveMonsters} nodes=${st.nodes} alive=${st.alive}`);
    if (st.visible >= minMobs) break;
  }
  if (!st?.alive) throw new Error("crawler dead at staging time");
  return st;
}
