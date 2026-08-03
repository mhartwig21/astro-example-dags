// ACCEPTANCE ROUND 2 — an INDEPENDENT measurement lab.
//
// Deliberately not tools/r2lab.mjs. The numbers in quality.ts were produced by
// that file and this pass exists to check them, so the instrument is rebuilt
// from the page's own live objects rather than reused.
//
// What it does that r2lab does not:
//
//  1. IT PROVES WHICH PRESET WAS ON THE CLOCK, from the LIVE PIPELINE and not
//     from `qualityProfile.name`. `liveState()` reads the renderer's actual
//     pixel ratio, the actual drawing-buffer size, the actual shadow map edge
//     on the DirectionalLight, the actual GTAO/bloom/SMAA pass enables and the
//     actual AO buffer dimensions, and the harness ASSERTS each of those
//     against the preset it asked for. A mode that quietly holds its number by
//     tuning itself down cannot survive that, because the number it would tune
//     is in the assertion.
//  2. IT COUNTS QUALITY CHANGES. `setQualityListener` is hooked and every
//     applyQuality() during a window is recorded; a window with any is void.
//  3. IT REPORTS BOTH >16.7 ms AND >33.3 ms SHARES, and vsync is off, so the
//     8.33 ms quantisation of the 120 Hz panel is not baked into the sample.
//  4. IT KEEPS EVERY RAW DELTA, and pools by concatenating deltas and adding
//     wall times — never a mean of means.
import { chromium } from "playwright";
import { execSync } from "node:child_process";

export const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };

export const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

// ---------------------------------------------------------------------------
// CONTAMINATION METER. Counts chrome.exe (siblings run headless:false), plus
// every other browser binary, and resolves own-vs-foreign by walking the
// process tree up to THIS node pid. Also reports foreign CPU, because on this
// box the frame is partly CPU and a pegged core is contamination a process
// count alone reads as "one more idle process".
// ---------------------------------------------------------------------------
const BROWSERS = /^(chrome|chrome-headless-shell|msedge|firefox)\.exe$/i;

export function census(ownPid = process.pid) {
  let rows;
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress\"",
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    rows = JSON.parse(out);
  } catch (e) { return { ok: false, err: String(e).slice(0, 140), foreign: -1 }; }
  const parent = new Map(), name = new Map();
  for (const r of rows) { parent.set(r.ProcessId, r.ParentProcessId); name.set(r.ProcessId, r.Name); }
  const ours = (pid) => {
    let cur = pid;
    for (let i = 0; i < 24; i++) {
      if (cur === ownPid) return true;
      const p = parent.get(cur);
      if (p === undefined || p === 0 || p === cur) return false;
      cur = p;
    }
    return false;
  };
  let own = 0, foreign = 0;
  const foreignPids = [];
  for (const [pid, n] of name) {
    if (!BROWSERS.test(n)) continue;
    if (ours(pid)) own++; else { foreign++; foreignPids.push(pid); }
  }
  return { ok: true, own, foreign, foreignPids };
}

/** Foreign CPU load as a % of ONE core, sampled over `ms`, excluding our tree. */
export function foreignLoad(ms = 4000, ownPid = process.pid) {
  const snap = () => {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_PerfRawData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime,Name | ConvertTo-Json -Compress\"",
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out);
  };
  const tree = () => {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress\"",
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    const rows = JSON.parse(out);
    const parent = new Map();
    for (const r of rows) parent.set(r.ProcessId, r.ParentProcessId);
    return (pid) => {
      let cur = pid;
      for (let i = 0; i < 24; i++) {
        if (cur === ownPid) return true;
        const p = parent.get(cur);
        if (p === undefined || p === 0 || p === cur) return false;
        cur = p;
      }
      return false;
    };
  };
  try {
    const isOurs = tree();
    const a = snap(); const t0 = Date.now();
    const wait = Date.now() + ms; while (Date.now() < wait) { /* busy-free spin via sync sleep */ execSync("powershell -NoProfile -Command \"Start-Sleep -Milliseconds 400\"", { stdio: "ignore" }); }
    const b = snap(); const dtMs = Date.now() - t0;
    const m = new Map();
    for (const r of a) m.set(r.IDProcess, Number(r.PercentProcessorTime));
    let foreign100ns = 0; const top = [];
    for (const r of b) {
      if (r.IDProcess === 0 || r.Name === "_Total" || r.Name === "Idle") continue;
      const prev = m.get(r.IDProcess);
      if (prev === undefined) continue;
      const d = Number(r.PercentProcessorTime) - prev;
      if (!(d > 0)) continue;
      if (isOurs(r.IDProcess)) continue;
      foreign100ns += d;
      top.push({ name: r.Name, pid: r.IDProcess, pct: +(100 * (d / 1e7) / (dtMs / 1000)).toFixed(1) });
    }
    top.sort((x, y) => y.pct - x.pct);
    return { pctOfOneCore: +(100 * (foreign100ns / 1e7) / (dtMs / 1000)).toFixed(1), top: top.slice(0, 6) };
  } catch (e) { return { pctOfOneCore: -1, err: String(e).slice(0, 120) }; }
}

// ---------------------------------------------------------------------------
export function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
}

export function shape(deltas, wallMs) {
  const n = deltas.length;
  if (!n) return null;
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    n,
    fps: +(n / (wallMs / 1000)).toFixed(2),
    delivered: +(wallMs / n).toFixed(2),
    mean: +(sum / n).toFixed(2),
    p50: pct(deltas, 0.5),
    p90: pct(deltas, 0.9),
    p99: pct(deltas, 0.99),
    max: +Math.max(...deltas).toFixed(1),
    over16: +(100 * deltas.filter((d) => d > 16.7).length / n).toFixed(1),
    over33: +(100 * deltas.filter((d) => d > 33.3).length / n).toFixed(1),
    // ModeContract.maxOverPct is documented as "the SHARE of individual frames
    // allowed over `budgetMs`" — and LOW's budgetMs is 20, not 33.3. The
    // shipped test checks over33 for every mode, so LOW's documented ceiling
    // has never actually been evaluated. These are it, evaluated.
    over20: +(100 * deltas.filter((d) => d > 20).length / n).toFixed(1),
  };
}

/** Share of frames over an arbitrary budget — the contract as written. */
export const overBudget = (deltas, ms) =>
  +(100 * deltas.filter((d) => d > ms).length / deltas.length).toFixed(1);

export function pool(windows) {
  const d = []; let wall = 0;
  for (const w of windows) { d.push(...w.deltas); wall += w.wallMs; }
  return shape(d, wall);
}

export async function boot({ adapter, port = 5282, w = 1440, h = 852, dpr = 2, quality = "high", url: over }) {
  const url = over
    ?? `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=${quality}`;
  const browser = await chromium.launch({
    headless: false,
    args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
  });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  // Keep-alive armed before the page's scripts: a level-26 crawler dropped into
  // floor 15 dies before readiness polling finishes.
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
      // __freeze lets a caller stop the sim (step() early-returns on any status
      // other than "playing") without the keep-alive immediately undoing it —
      // the only way to photograph the SAME frame under three presets.
      if (window.__freeze) return;
      for (const p of s.players) { p.hp = p.maxHp; p.alive = true; }
      if (s.status !== "playing") s.status = "playing";
    }, 60);
  });
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 });
  await page.waitForFunction(
    () => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); },
    { timeout: 300000 },
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
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log(`GAME CONTEXT GPU (${adapter}): ${gpu}`);
  return { browser, context, page, gpu };
}

export async function installProbe(page) {
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;

    const S = { deltas: [], on: false, t0: 0 };
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      if (S.on) S.deltas.push(n - last);
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__winStart = () => { S.deltas.length = 0; S.on = true; S.t0 = performance.now(); };
    window.__winEnd = () => { S.on = false; return { deltas: S.deltas.slice(), wallMs: performance.now() - S.t0 }; };

    // EVERY applyQuality() IS COUNTED. If the number a mode reports was taken
    // while something moved the pipeline, the window is void.
    window.__qc = [];
    r3d.setQualityListener((p) => window.__qc.push({ t: performance.now(), name: p.name }));
    window.__qcCount = () => window.__qc.length;

    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };

    /**
     * WHAT IS ACTUALLY IN THE PIPELINE, read from the live objects. Nothing
     * here is copied off qualityProfile except `claimed`, which is the thing
     * being checked rather than the evidence.
     */
    window.__live = () => {
      const raw = gl.getContext();
      const aoRT = r3d.gtao.gtaoRenderTarget ?? r3d.gtao.renderTargetGTAO ?? null;
      return {
        claimed: r3d.qualityProfile.name,
        pixelRatio: +gl.getPixelRatio().toFixed(4),
        bufW: raw.drawingBufferWidth,
        bufH: raw.drawingBufferHeight,
        mpx: +((raw.drawingBufferWidth * raw.drawingBufferHeight) / 1e6).toFixed(3),
        shadowMap: r3d.key?.shadow?.mapSize?.x ?? -1,
        shadowOn: !!gl.shadowMap?.enabled,
        gtao: !!r3d.gtao.enabled,
        aoW: aoRT ? aoRT.width : -1,
        aoH: aoRT ? aoRT.height : -1,
        bloom: !!r3d.bloom.enabled,
        smaa: !!r3d.smaa.enabled,
        renderScale: r3d.renderScale ?? null,
        dpr: devicePixelRatio,
      };
    };

    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0, parked = 0;
      for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
      let nodes = 0, skinned = 0;
      r3d.scene.traverse((o) => { nodes++; if (o.isSkinnedMesh) skinned++; });
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      return {
        floor: s.floor, monsters: s.monsters.length, visible: vis, parked, nodes, skinned,
        alive: !!you?.alive, rigFull: r3d.rigFullRate ? r3d.rigFullRate.size : -1,
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
        for (const m of s.monsters) { if (m.hp <= 0) continue; const dx = m.pos.x - x, dy = m.pos.y - y; d = Math.min(d, dx * dx + dy * dy); }
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      if (best) { you.pos.x = best.x; you.pos.y = best.y; }
      return best;
    };

    // GPU CONTENTION CANARY: the post chain over an empty scene — almost no CPU
    // in it, so a high reading is the shared package being spent elsewhere.
    const passes = r3d.composer.passes;
    const renderPass = passes.find((p) => p.constructor.name === "RenderPass");
    const emptyScene = new (r3d.scene.constructor)();
    window.__canary = async (ms) => {
      const prev = renderPass.scene;
      renderPass.scene = emptyScene;
      const t0 = performance.now();
      let n = 0;
      await new Promise((done) => {
        const t = () => { n++; if (performance.now() - t0 >= ms) { done(); return; } requestAnimationFrame(t); };
        requestAnimationFrame(t);
      });
      renderPass.scene = prev;
      return +((performance.now() - t0) / Math.max(1, n)).toFixed(2);
    };
  });
}

/** What each preset MUST look like in the live pipeline at dpr 2. */
export const EXPECTED = {
  low: { pixelRatio: 1, shadowMap: 1024, gtao: true, bloom: true, smaa: true },
  medium: { pixelRatio: 1.4, shadowMap: 1536, gtao: true, bloom: true, smaa: true },
  high: { pixelRatio: 2, shadowMap: 2048, gtao: true, bloom: true, smaa: true },
};

export function assertPreset(mode, live) {
  const e = EXPECTED[mode];
  const bad = [];
  if (live.claimed !== mode) bad.push(`claimed=${live.claimed}`);
  if (Math.abs(live.pixelRatio - e.pixelRatio) > 1e-3) bad.push(`pixelRatio=${live.pixelRatio} want ${e.pixelRatio}`);
  if (live.shadowMap !== e.shadowMap) bad.push(`shadowMap=${live.shadowMap} want ${e.shadowMap}`);
  if (live.gtao !== e.gtao) bad.push(`gtao=${live.gtao}`);
  if (live.bloom !== e.bloom) bad.push(`bloom=${live.bloom}`);
  if (live.smaa !== e.smaa) bad.push(`smaa=${live.smaa}`);
  if (live.renderScale !== 1) bad.push(`renderScale=${live.renderScale}`);
  return bad;
}

export async function window1(page, { secs, mode, restage = true, settleMs = 1400 }) {
  if (restage) { await page.evaluate(() => window.__toPack()); await page.waitForTimeout(settleMs); }
  const qc0 = await page.evaluate(() => window.__qcCount());
  const live0 = await page.evaluate(() => window.__live());
  const s0 = await page.evaluate(() => window.__scene());
  const bad = assertPreset(mode, live0);
  if (bad.length) throw new Error(`preset ${mode} is NOT what is in the pipeline: ${bad.join(", ")}`);
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(secs * 1000);
  const raw = await page.evaluate(() => window.__winEnd());
  const live1 = await page.evaluate(() => window.__live());
  const s1 = await page.evaluate(() => window.__scene());
  const qc1 = await page.evaluate(() => window.__qcCount());
  if (qc1 !== qc0) throw new Error(`quality changed ${qc1 - qc0}x DURING the ${mode} window`);
  const drift = assertPreset(mode, live1);
  if (drift.length) throw new Error(`preset ${mode} drifted mid-window: ${drift.join(", ")}`);
  return {
    ...raw, mode, live: live0,
    visible: s0.visible, visibleEnd: s1.visible, rigFull: s1.rigFull, nodes: s1.nodes,
    alive: s1.alive, shape: shape(raw.deltas, raw.wallMs),
  };
}

export async function stage(page, { minMobs = 12 } = {}) {
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(1200);
  let st = null;
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(2200);
    st = await page.evaluate(() => window.__scene());
    console.log(`[stage] attempt ${i + 1}: visible=${st.visible} nodes=${st.nodes} alive=${st.alive}`);
    if (st.visible >= minMobs) break;
  }
  if (!st?.alive) throw new Error("crawler dead at staging time");
  return st;
}
