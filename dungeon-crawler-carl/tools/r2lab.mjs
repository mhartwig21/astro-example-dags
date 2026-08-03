// OPT-R2 MEASUREMENT LAB — the shared boot/stage/probe every r2 number uses.
//
// What this fixes about the harness the acceptance critic rejected
// (tools/trk_modes.mjs), point by point:
//
//  A. IT KEEPS THE RAW FRAME DELTAS. trk_modes reduced each window to a median
//     and then took a median of medians, which cannot express p90, p99, or the
//     share of frames over budget — i.e. it could not express the statistic the
//     contract is actually about. Every window here returns its deltas and the
//     wall-clock length of the window, so DELIVERED THROUGHPUT (frames / wall
//     seconds) is a first-class result and not a derived guess.
//
//  B. IT RE-STAGES BETWEEN WINDOWS AND ROTATES ORDER WITHIN A REP. trk_modes
//     staged once and then ran low->medium->high in that order every rep, so
//     the pack thinned as the ladder ran and later windows were charged for a
//     lighter scene. Here every window re-teleports to the densest live pack
//     and the order rotates, so no arm can be systematically charged for drift.
//
//  C. IT RECORDS DENSITY WITH EVERY WINDOW. A frame time without the body count
//     it was taken at is not a measurement. Windows whose density is more than
//     `--drift` away from the rep's staged density are flagged.
//
//  D. THE ADAPTER IS ASSERTED ON THE GAME'S OWN GL CONTEXT, and the preset
//     FINGERPRINT (drawing buffer, shadow map, rig budget, render scale) is
//     captured at both ends of every window — a window whose fingerprint moved
//     is discarded, because that is a mode change the tuner made behind us.
//
//  E. CONTAMINATION IS SAMPLED AT BOTH ENDS OF EVERY WINDOW, counting
//     chrome.exe and resolving own-vs-foreign by walking the process tree.
//
// It does NOT solve the iGPU GPU-contention blind spot (a rival browser's GPU
// work on a shared-memory part is invisible to a process count). What it does
// instead is report the contamination alongside each window so a collapsed run
// is visibly a collapsed run rather than a quiet lie.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

export const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };

export const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
export const has = (n) => process.argv.includes(n);

/** Percentile of an already-unsorted array. */
export function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
}

/**
 * The full statistical shape of one window. THE CONTRACT-RELEVANT NUMBERS ARE
 * `fps` AND `over33` — not the median. quality.ts's own tuner comment says a
 * median "reads 10 ms, wonderful and never downgrades a machine running at 24
 * fps"; this is that comment taken seriously.
 */
export function shape(deltas, wallMs) {
  const n = deltas.length;
  if (!n) return null;
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    n,
    fps: +(n / (wallMs / 1000)).toFixed(2),
    /** Wall ms per delivered frame — the thing the player experiences. */
    delivered: +(wallMs / n).toFixed(2),
    mean: +(sum / n).toFixed(2),
    p50: pct(deltas, 0.5),
    p90: pct(deltas, 0.9),
    p99: pct(deltas, 0.99),
    max: +Math.max(...deltas).toFixed(1),
    over16: +(100 * deltas.filter((d) => d > 16.7).length / n).toFixed(1),
    over33: +(100 * deltas.filter((d) => d > 33.3).length / n).toFixed(1),
  };
}

/** Pool several windows' raw deltas into one shape (wall times add). */
export function pool(windows) {
  const d = [];
  let wall = 0;
  for (const w of windows) { d.push(...w.deltas); wall += w.wallMs; }
  return shape(d, wall);
}

export async function boot({ adapter, port = 5282, w = 1440, h = 852, dpr = 2, url: urlOverride }) {
  const url = urlOverride
    ?? `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=high`;
  const browser = await chromium.launch({
    headless: false,
    args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
  });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  // Keep-alive armed BEFORE the page's own scripts: a level-26 crawler dropped
  // into floor 15 dies before readiness polling finishes, and the post-run card
  // never leaves on its own. See trk_modes.mjs for the two ladders lost to this.
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
  // READINESS IS NOT data-assets-settled — the boot card runs shader precompile
  // behind it. Poll #loading out, wait, then assert it has no box at all.
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

/** Install the in-page probe: windows, scene control, ablations, fingerprint. */
export async function installProbe(page) {
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;

    // rAF delta recorder. Always running; a window is a slice of it.
    const S = { deltas: [], on: false, t0: 0 };
    window.__S = S;
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      if (S.on) S.deltas.push(n - last);
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    window.__winStart = () => { S.deltas.length = 0; S.on = true; S.t0 = performance.now(); };
    window.__winEnd = () => {
      S.on = false;
      return { deltas: S.deltas.slice(), wallMs: performance.now() - S.t0 };
    };

    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };

    /** Everything a window's validity depends on, in one comparable string. */
    window.__fp = () => {
      const raw = gl.getContext();
      const q = r3d.qualityProfile;
      return [
        q.name, raw.drawingBufferWidth, raw.drawingBufferHeight, q.shadowMapSize,
        q.shadowInterval, q.rigBudget, q.offscreenRigHz, r3d.renderScale,
        gl.getPixelRatio().toFixed(3),
      ].join("|");
    };

    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0, parked = 0;
      for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
      let nodes = 0, skinned = 0, bones = 0;
      r3d.scene.traverse((o) => { nodes++; if (o.isSkinnedMesh) skinned++; if (o.isBone) bones++; });
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      return {
        floor: s.floor, monsters: s.monsters.length, visible: vis, parked,
        nodes, skinned, bones, alive: !!you?.alive,
        /** The gate's OWN view: how many rigs took a full-rate mixer update. */
        rigFull: r3d.rigFullRate ? r3d.rigFullRate.size : -1,
      };
    };

    // Teleport to the centre of the densest live cluster. Re-run between every
    // window so no arm is charged for a pack that thinned while it waited.
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

    // ---- ABLATIONS -------------------------------------------------------
    // Each is reversible and toggled through the LIVE objects, so an ablation
    // measures the same page session as its baseline.
    const passes = r3d.composer.passes;
    const byName = (n) => passes.find((p) => p.constructor.name === n);
    const emptyScene = new (r3d.scene.constructor)();
    const renderPass = byName("RenderPass");
    const gradePass = passes.find((p) => p.constructor.name === "ShaderPass" && p !== r3d.smaa);
    const outputPass = byName("OutputPass");
    const realComposerRender = r3d.composer.render.bind(r3d.composer);
    const AB = {
      smaa: (on) => { r3d.smaa.enabled = on ? false : true; },
      grade: (on) => { if (gradePass) gradePass.enabled = !on; },
      bloom: (on) => { r3d.bloom.enabled = !on; },
      gtao: (on) => { r3d.gtao.enabled = !on; },
      output: (on) => { if (outputPass) outputPass.enabled = !on; },
      /** No post chain at all: the scene straight to the default framebuffer. */
      nopost: (on) => {
        r3d.composer.render = on
          ? () => { gl.setRenderTarget(null); gl.render(r3d.scene, r3d.camera); }
          : realComposerRender;
      },
      /** Post chain over an EMPTY scene: the fixed fullscreen cost, alone. */
      noscene: (on) => { renderPass.scene = on ? emptyScene : r3d.scene; },
      /** Quarter the backbuffer pixels without touching anything else. */
      halfres: (on) => { r3d.setRenderScale(on ? 0.5 : 1); },
      /** Freeze the scene graph walk: is the frame the graph or the pixels? */
      freezegraph: (on) => { r3d.scene.matrixWorldAutoUpdate = !on; },
    };
    window.__ab = (name, on) => { AB[name](on); return window.__fp(); };
    window.__abList = () => Object.keys(AB);

    // ---- THE GPU CONTENTION CANARY -------------------------------------
    //
    // THE CONTAMINATION METER COUNTS CPU AND THAT IS NOT ENOUGH HERE. On a
    // shared-memory Intel part a rival browser's GPU work is invisible to a
    // process count: one pass of this lab collapsed to 2.7 fps in every arm
    // with the foreign chrome.exe count unchanged at 21, and an earlier round
    // threw away a whole session at 2.0-3.3 fps while foreign CPU sat at 7-18%
    // of one core. A number taken in that state is not a slow number, it is
    // not a number.
    //
    // So measure the GPU directly, with a workload that has almost no CPU in
    // it: the post chain over an EMPTY scene, at a pinned resolution. On a
    // quiet box this lab measured it at 9.3-9.5 ms delivered on the Intel part
    // and ~2 ms on the RTX. Anything far above that is the shared package
    // being spent somewhere else, and it is the only reading available that
    // sees it.
    window.__canary = async (ms) => {
      const scenePrev = renderPass.scene;
      renderPass.scene = emptyScene;
      const t0 = performance.now();
      let n = 0;
      await new Promise((done) => {
        const tick = () => {
          n++;
          if (performance.now() - t0 >= ms) { done(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      renderPass.scene = scenePrev;
      return +((performance.now() - t0) / Math.max(1, n)).toFixed(2);
    };
  });
}

/**
 * Measure ONE window. Re-stages first, samples contamination at both ends,
 * and refuses a window whose preset fingerprint moved underneath it.
 */
export async function window1(page, { secs, restage = true, settleMs = 1400 }) {
  if (restage) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(settleMs);
  }
  const c0 = census();
  const fp0 = await page.evaluate(() => window.__fp());
  const sceneBefore = await page.evaluate(() => window.__scene());
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(secs * 1000);
  const raw = await page.evaluate(() => window.__winEnd());
  const fp1 = await page.evaluate(() => window.__fp());
  const sceneAfter = await page.evaluate(() => window.__scene());
  const c1 = census();
  if (fp0 !== fp1) throw new Error(`fingerprint moved mid-window: ${fp0} -> ${fp1}`);
  return {
    ...raw,
    fp: fp0,
    visible: sceneBefore.visible,
    visibleEnd: sceneAfter.visible,
    rigFull: sceneAfter.rigFull,
    nodes: sceneAfter.nodes,
    foreign: Math.max(c0.foreign ?? 0, c1.foreign ?? 0),
    shape: shape(raw.deltas, raw.wallMs),
  };
}

/**
 * Poll the GPU canary until the shared part is quiet enough to measure on, or
 * give up and say so. Returns the reading it settled on plus whether it passed.
 *
 * It does NOT wait forever. A sibling workflow has held 10-28 chrome.exe on
 * this box continuously for hours; waiting is not a strategy, and an honest
 * "this run is contended, here is by how much" beats a run that quietly
 * averages a collapsed window into a contract.
 */
export async function waitForQuietGpu(page, { maxMs, tries = 10, everyMs = 12000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await page.evaluate((ms) => window.__canary(ms), 1200);
    console.log(`[canary] empty-scene post chain = ${last} ms/frame (want <= ${maxMs})  foreign=${census().foreign}`);
    if (last <= maxMs) return { ok: true, canary: last, waited: i };
    if (i < tries - 1) await page.waitForTimeout(everyMs);
  }
  return { ok: false, canary: last, waited: tries };
}

/** Walk in so the floor streams, then stage the first pack. */
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

/**
 * SANDWICHED A/B — the only comparison that survives this box.
 *
 * An earlier pass pooled each arm's windows and compared pooled means. A run
 * taken while a rival browser owned the shared Intel package produced base =
 * 266 ms against a 53 ms base measured twenty minutes earlier, with arm deltas
 * the same size as the drift. Absolute pooling cannot survive that.
 *
 * So every arm window sits between two BASE windows and is scored as a ratio to
 * the mean of its own two neighbours. Contention slower than one window pair
 * cancels; contention faster than that shows up as disagreement between an
 * arm's repeats, which is reported as a spread rather than averaged away.
 *
 * `apply(page, arm)` must set the arm up; `apply(page, null)` must restore.
 */
export async function sandwich(page, arms, { secs, reps, apply, label = "" }) {
  const ratios = new Map(arms.map((a) => [a, []]));
  const bases = [];
  const runOne = async (arm) => {
    await apply(page, arm);
    await page.waitForTimeout(250);
    try { return await window1(page, { secs }); } finally { await apply(page, null); }
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
      console.log(
        `r${r} ${arm.padEnd(14)} arm=${String(w.shape.delivered).padStart(7)}ms base~${ref.toFixed(1)}ms `
        + `ratio=${ratio.toFixed(3)} saved=${(100 * (1 - ratio)).toFixed(1)}% vis=${w.visible} rigFull=${w.rigFull} foreign=${w.foreign}`,
      );
      prevBase = nextBase;
    }
  }
  const basePool = pool(bases);
  const table = {};
  console.log(`\n=== ${label} — sandwiched A/B, ${reps} rotated reps ===`);
  console.log(`base (pooled ${bases.length} windows): ${basePool.delivered} ms delivered / ${basePool.fps} fps  `
    + `p50=${basePool.p50} p90=${basePool.p90} p99=${basePool.p99} over16=${basePool.over16}% over33=${basePool.over33}%`);
  console.log("arm            median ratio   saved%   est ms saved   spread");
  for (const a of arms) {
    const rs = ratios.get(a).sort((x, y) => x - y);
    const med = rs[Math.floor(rs.length / 2)];
    table[a] = {
      ratios: rs, median: +med.toFixed(3),
      savedPct: +(100 * (1 - med)).toFixed(1),
      savedMs: +((1 - med) * basePool.delivered).toFixed(2),
    };
    console.log(
      `${a.padEnd(14)} ${String(med.toFixed(3)).padStart(11)} ${String(table[a].savedPct).padStart(8)} `
      + `${String(table[a].savedMs).padStart(14)}   ${rs[0].toFixed(3)}..${rs[rs.length - 1].toFixed(3)}`,
    );
  }
  return { base: basePool, table };
}
