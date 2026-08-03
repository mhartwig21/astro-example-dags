// ACCEPTANCE CRITIQUE r1 — independent re-measurement of the LOW/MEDIUM/HIGH
// contracts. Owes the previous rounds nothing: every number here is taken by
// this file, on the GPU it asserts, with the preset it verifies was live.
//
// WHAT THIS ADDS OVER tools/trk_modes.mjs (which produced the shipped numbers):
//   1. RAW FRAME DELTAS ARE KEPT. The shipped table quotes p50/mean/p10/p95 of
//      per-sample summaries — a median of medians. A contract that says "60 fps"
//      is a claim about the distribution, so this pools every frame delta and
//      reports p50 / p90 / p99 and the SHARE OF FRAMES OVER 16.7 and OVER 33.3.
//   2. THE ACTIVE PRESET IS VERIFIED, NOT ASSUMED. Every sample fingerprints the
//      LIVE renderer (drawing buffer size, shadow map, rig budget, pixel ratio
//      cap, renderScale) at both ends, and counts quality changes fired during
//      the window. A mode that held its number by stepping itself down would
//      show up as a fingerprint that moved.
//   3. TWO SCENES. The dense pack (worst) and an empty room (quiet), in ONE page
//      session, so the ladder can be read against the scene it is charged for.
//   4. THE RIG GATE IS MEASURED AS A VISIBLE THING. LOW's rigBudget=14 demotes
//      ON-SCREEN bodies past the 14th nearest to 6 Hz. __rigrate() counts, per
//      visible monster, how many frames its skeleton actually moved — the
//      difference between "invisible CPU lever" and "the back of the pack
//      animates at 6 fps" is a measurement, not an opinion.
//   5. FOREIGN LOAD IS MEASURED IN CPU-SECONDS, not just process count. Ten
//      idle chrome.exe belonging to a minimised window are not contamination;
//      one busy one is.
//
// Usage: node tools/acc1_perf.mjs --adapter igpu|dgpu [--reps 3] [--secs 4]
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 3));
const secs = Number(flag("--secs", 4));
const port = Number(flag("--port", 5282));
const floor = Number(flag("--floor", 15));
const width = 1440, height = 852, dpr = 2;
const OUT = "tools/_acc1";
mkdirSync(OUT, { recursive: true });

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
const MODES = ["low", "medium", "high"];

// ---- CONTAMINATION METER: count AND cost -----------------------------------
function probe(ownPid = process.pid) {
  let rows;
  try {
    rows = JSON.parse(execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime | ConvertTo-Json -Compress\"",
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    ));
  } catch (e) { return { ok: false, err: String(e).slice(0, 120) }; }
  const parent = new Map(), name = new Map(), cpu = new Map();
  for (const r of rows) {
    parent.set(r.ProcessId, r.ParentProcessId); name.set(r.ProcessId, r.Name);
    cpu.set(r.ProcessId, (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 1e7); // 100ns ticks -> s
  }
  const ours = (pid) => { let c = pid; for (let i = 0; i < 24; i++) { if (c === ownPid) return true; const p = parent.get(c); if (p === undefined || p === 0 || p === c) return false; c = p; } return false; };
  const BROWSER = /^(chrome|chrome-headless-shell|msedge|firefox)\.exe$/i;
  let own = 0, foreign = 0; const foreignCpu = new Map(); const foreignPids = [];
  for (const [pid, n] of name) {
    if (!BROWSER.test(n)) continue;
    if (ours(pid)) own++; else { foreign++; foreignPids.push(pid); foreignCpu.set(pid, cpu.get(pid)); }
  }
  return { ok: true, own, foreign, foreignPids, foreignCpu, t: Date.now() };
}
/** CPU-seconds burned by foreign browsers between two probes, as % of one core. */
function foreignLoadPct(a, b) {
  if (!a?.ok || !b?.ok) return null;
  let s = 0;
  for (const [pid, c] of b.foreignCpu) { const p = a.foreignCpu.get(pid); if (p !== undefined) s += Math.max(0, c - p); }
  const wall = (b.t - a.t) / 1000;
  return wall > 0 ? +(100 * s / wall).toFixed(1) : null;
}

const stats = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  return {
    n: s.length,
    p50: q(0.5), p90: q(0.9), p99: q(0.99),
    mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2),
    min: q(0), max: +s[s.length - 1].toFixed(1),
    over16: +(100 * s.filter((x) => x > 16.7).length / s.length).toFixed(1),
    over33: +(100 * s.filter((x) => x > 33.3).length / s.length).toFixed(1),
    stalls400: s.filter((x) => x > 400).length,
  };
};

const url = (q) => `http://localhost:${port}/iso.html?test&floor=${floor}&level=26&seed=41&abilities=all&debug=1&quality=${q}`;

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Keep the crawler alive and the post-run card off the glass, from the first
// tick — a level-26 test crawler on floor 15 dies before readiness finishes.
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

const cardUp = () => page.evaluate(() => {
  for (const id of ["recap", "loading", "sheet"]) {
    const e = document.getElementById(id);
    if (!e) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 200 && r.height > 200) return id;
  }
  return null;
});

async function readiness() {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 300000 });
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return { gone: true };
    const r = e.getBoundingClientRect();
    return { gone: r.width === 0 && r.height === 0, w: r.width, h: r.height };
  });
  if (!box.gone) throw new Error(`#loading still has a box: ${JSON.stringify(box)}`);
}

const PROBE = () => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  const S = { frame: [], update: [], render: [], calls: 0, frames: 0, qChanges: 0 };
  window.__M = S;
  gl.info.autoReset = false;
  const oU = r3d.update.bind(r3d);
  r3d.update = function (...a) { const t = performance.now(); const r = oU(...a); S.update.push(performance.now() - t); return r; };
  const oR = r3d.render.bind(r3d);
  r3d.render = function (...a) {
    gl.info.reset();
    const t = performance.now(); const r = oR(...a); S.render.push(performance.now() - t);
    S.calls += gl.info.render.calls; S.frames++;
    return r;
  };
  let last = performance.now();
  const tick = () => { const n = performance.now(); S.frame.push(n - last); last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  // A quality change DURING a sample is the thing that would invalidate it.
  r3d.setQualityListener(() => { S.qChanges++; });

  window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };
  // THE FINGERPRINT. Not the mode NAME — the levers, read off the live
  // pipeline. A mode that quietly stepped itself down shows up here.
  window.__fp = () => {
    const p = r3d.qualityProfile;
    const raw = gl.getContext();
    return {
      name: p.name, setting: r3d.qualitySetting,
      pixelRatioCap: p.pixelRatioCap, effPixelRatio: +gl.getPixelRatio().toFixed(3),
      buf: [raw.drawingBufferWidth, raw.drawingBufferHeight],
      shadowMapSize: p.shadowMapSize, shadowInterval: p.shadowInterval,
      rigBudget: p.rigBudget === Infinity ? "inf" : p.rigBudget,
      offscreenRigHz: p.offscreenRigHz === Infinity ? "inf" : p.offscreenRigHz,
      gtao: p.gtao, gtaoScale: p.gtaoScale, bloomScale: p.bloomScale,
      fxDensity: p.fxDensity, moteDensity: p.moteDensity,
      shadowMapActual: r3d.key?.shadow?.mapSize?.x ?? null,
      dpr: window.devicePixelRatio, qChanges: S.qChanges,
    };
  };
  window.__scene = () => {
    const s = window.__dcc.state;
    let vis = 0, parked = 0;
    for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
    let nodes = 0, skinned = 0, bones = 0;
    r3d.scene.traverse((o) => { nodes++; if (o.isSkinnedMesh) skinned++; if (o.isBone) bones++; });
    const you = s.players.find((p) => p.alive) ?? s.players[0];
    return { floor: s.floor, monsters: s.monsters.length, visible: vis, parked, nodes, skinned, bones, alive: !!you?.alive, hp: Math.round(you?.hp ?? 0) };
  };
  window.__zero = () => { S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.calls = 0; S.frames = 0; S.qChanges = 0; };
  window.__dump = () => ({
    frames: S.frames,
    frame: [...S.frame], update: [...S.update], render: [...S.render],
    calls: +(S.calls / Math.max(1, S.frames)).toFixed(0),
  });

  window.__toPack = () => {
    const s = window.__dcc.state, mobs = s.monsters;
    let bi = -1, bn = -1;
    for (let i = 0; i < mobs.length; i++) {
      let n = 0;
      for (let j = 0; j < mobs.length; j++) {
        const dx = mobs[i].pos.x - mobs[j].pos.x, dy = mobs[i].pos.y - mobs[j].pos.y;
        if (dx * dx + dy * dy <= 36) n++;
      }
      if (n > bn) { bn = n; bi = i; }
    }
    if (bi < 0) return null;
    let cx = 0, cy = 0, n = 0;
    for (const m of mobs) {
      const dx = m.pos.x - mobs[bi].pos.x, dy = m.pos.y - mobs[bi].pos.y;
      if (dx * dx + dy * dy <= 36) { cx += m.pos.x; cy += m.pos.y; n++; }
    }
    const you = s.players[0];
    you.pos.x = cx / n; you.pos.y = cy / n; you.hp = you.maxHp; you.alive = true;
    return { packSize: bn, at: [+you.pos.x.toFixed(1), +you.pos.y.toFixed(1)] };
  };
  // QUIET SCENE: the room centre furthest from any live monster.
  window.__toQuiet = () => {
    const s = window.__dcc.state;
    const rooms = s.map?.rooms ?? [];
    let best = null, bestD = -1;
    for (const r of rooms) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      let d = 1e9;
      for (const m of s.monsters) { const dx = m.pos.x - cx, dy = m.pos.y - cy; d = Math.min(d, dx * dx + dy * dy); }
      if (d > bestD) { bestD = d; best = [cx, cy]; }
    }
    if (!best) return null;
    const you = s.players[0];
    you.pos.x = best[0]; you.pos.y = best[1]; you.hp = you.maxHp; you.alive = true;
    return { at: [+best[0].toFixed(1), +best[1].toFixed(1)], nearestMob: +Math.sqrt(bestD).toFixed(1) };
  };

  // ---- HOW OFTEN DOES EACH VISIBLE BODY'S SKELETON ACTUALLY MOVE? ----------
  // Samples one bone's world matrix per visible monster every frame and counts
  // the frames on which it changed. Full-rate rigs approach 100%; a rig demoted
  // to offscreenRigHz shows offscreenRigHz/fps.
  window.__rigrate = (ms) => new Promise((resolve) => {
    const seen = new Map(); // id -> {frames, moved, last}
    let frames = 0;
    const t0 = performance.now();
    const step = () => {
      frames++;
      for (const [id, mesh] of r3d.monsters) {
        if (!mesh.visible || !mesh.parent) continue;
        let bone = null;
        mesh.traverse((o) => { if (!bone && o.isBone && o.children.length) bone = o; });
        if (!bone) continue;
        const e = bone.matrixWorld.elements;
        const sig = e[12].toFixed(5) + "," + e[13].toFixed(5) + "," + e[14].toFixed(5) + "," + e[0].toFixed(5) + "," + e[5].toFixed(5) + "," + e[1].toFixed(5);
        const rec = seen.get(id) ?? { frames: 0, moved: 0, last: null };
        rec.frames++;
        if (rec.last !== null && rec.last !== sig) rec.moved++;
        rec.last = sig;
        seen.set(id, rec);
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else {
        const rows = [...seen].map(([id, r]) => ({ id, frames: r.frames, moved: r.moved, pct: +(100 * r.moved / Math.max(1, r.frames - 1)).toFixed(1) }));
        rows.sort((a, b) => b.pct - a.pct);
        resolve({ frames, wallMs: +(performance.now() - t0).toFixed(0), rigs: rows });
      }
    };
    requestAnimationFrame(step);
  });
};

let out = null;
try {
  await page.goto(url("high"), { waitUntil: "load", timeout: 90000 });
  await readiness();
  const gpu = await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);

  await page.evaluate(PROBE);
  const fp0 = await page.evaluate(() => window.__fp());
  console.log("[fingerprint@boot]", JSON.stringify(fp0));
  if (fp0.dpr !== 2) throw new Error(`devicePixelRatio is ${fp0.dpr}, expected 2`);

  // ---- STAGE THE WORST SCENE ----------------------------------------------
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(1200);
  let placed = null;
  for (let i = 0; i < 6; i++) {
    placed = await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => window.__scene());
    console.log(`[stage] try ${i + 1}: pack=${placed?.packSize} -> visible=${st.visible} alive=${st.alive} nodes=${st.nodes}`);
    if (st.visible >= 14) break;
  }
  const stagedWorst = await page.evaluate(() => window.__scene());
  console.log("[stage] WORST:", JSON.stringify(stagedWorst));
  if (!stagedWorst.alive) throw new Error("crawler dead at staging");
  const cov = await cardUp();
  if (cov) throw new Error(`#${cov} covers the scene`);

  const results = {};
  const scenesLog = {};

  async function ladder(sceneName, swings) {
    const acc = new Map(MODES.map((m) => [m, { frame: [], update: [], render: [], calls: [], fps: [], samples: [] }]));
    let warmed = false;
    for (let r = 0; r < reps + 1; r++) {
      for (const m of MODES) {
        const got = await page.evaluate((mm) => window.__setMode(mm), m);
        if (got !== m) throw new Error(`setQuality("${m}") landed on "${got}"`);
        await page.waitForTimeout(900);
        const fpA = await page.evaluate(() => window.__fp());
        const cA = probe();
        await page.evaluate(() => window.__zero());
        const t0 = Date.now(); let sw = 0;
        while (Date.now() - t0 < secs * 1000) {
          if (swings && Date.now() - t0 > sw * 1200) { sw++; await page.keyboard.press("Space").catch(() => {}); }
          await page.waitForTimeout(120);
        }
        const d = await page.evaluate(() => window.__dump());
        const fpB = await page.evaluate(() => window.__fp());
        const cB = probe();
        const sc = await page.evaluate(() => window.__scene());
        const covm = await cardUp();
        if (covm) throw new Error(`#${covm} appeared mid-ladder`);
        if (!warmed) { warmed = true; continue; }
        const drift = JSON.stringify({ ...fpA, qChanges: 0 }) !== JSON.stringify({ ...fpB, qChanges: 0 });
        const rec = acc.get(m);
        rec.frame.push(...d.frame.slice(1));
        rec.update.push(...d.update.slice(1));
        rec.render.push(...d.render.slice(1));
        rec.calls.push(d.calls);
        rec.samples.push({ fpA, fpB, drift, qChanges: fpB.qChanges, scene: sc, foreign: cB.foreign, foreignPct: foreignLoadPct(cA, cB) });
        const s = stats(d.frame.slice(1));
        console.log(`  [${sceneName}] ${m.padEnd(6)} p50=${String(s.p50).padStart(6)} p90=${String(s.p90).padStart(6)} p99=${String(s.p99).padStart(7)}`
          + ` >16.7=${String(s.over16).padStart(5)}% >33=${String(s.over33).padStart(5)}% n=${s.n}`
          + ` buf=${fpB.buf.join("x")} vis=${sc.visible} drift=${drift} qch=${fpB.qChanges} foreign=${cB.foreign}/${foreignLoadPct(cA, cB)}%`);
      }
    }
    const rows = MODES.map((m) => {
      const rec = acc.get(m);
      return {
        mode: m, scene: sceneName,
        frame: stats(rec.frame), update: stats(rec.update), render: stats(rec.render),
        calls: Math.round(rec.calls.reduce((a, b) => a + b, 0) / Math.max(1, rec.calls.length)),
        samples: rec.samples,
        anyDrift: rec.samples.some((s) => s.drift),
        qChanges: rec.samples.reduce((a, s) => a + s.qChanges, 0),
        foreignMax: Math.max(0, ...rec.samples.map((s) => s.foreign)),
        foreignPctMax: Math.max(0, ...rec.samples.map((s) => s.foreignPct ?? 0)),
        visible: Math.round(rec.samples.reduce((a, s) => a + s.scene.visible, 0) / Math.max(1, rec.samples.length)),
      };
    });
    return rows;
  }

  console.log(`\n=== WORST SCENE (floor ${floor}, dense pack) · ${adapter} ===`);
  results.worst = await ladder("worst", true);
  scenesLog.worst = stagedWorst;

  // ---- RIG RATE, per mode, in the worst scene -----------------------------
  console.log("\n=== RIG RATE (share of frames each VISIBLE body's skeleton moved) ===");
  const rigRates = {};
  for (const m of MODES) {
    await page.evaluate((mm) => window.__setMode(mm), m);
    await page.waitForTimeout(1200);
    const rr = await page.evaluate(() => window.__rigrate(2500));
    const pcts = rr.rigs.map((r) => r.pct);
    rigRates[m] = { frames: rr.frames, wallMs: rr.wallMs, rigs: rr.rigs, count: rr.rigs.length, below50: pcts.filter((p) => p < 50).length, below25: pcts.filter((p) => p < 25).length };
    console.log(`  ${m.padEnd(6)} visible rigs=${rr.rigs.length} frames=${rr.frames} pcts=[${pcts.slice(0, 30).join(", ")}]`);
  }

  // ---- SCREENSHOTS in the worst scene ------------------------------------
  for (const m of MODES) {
    await page.evaluate((mm) => window.__setMode(mm), m);
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${adapter}_worst_${m}.png` });
  }

  // ---- QUIET SCENE --------------------------------------------------------
  const quiet = await page.evaluate(() => window.__toQuiet());
  await page.waitForTimeout(3000);
  const stagedQuiet = await page.evaluate(() => window.__scene());
  console.log(`\n[stage] QUIET: ${JSON.stringify(quiet)} -> ${JSON.stringify(stagedQuiet)}`);
  console.log(`=== QUIET SCENE · ${adapter} ===`);
  results.quiet = await ladder("quiet", false);
  scenesLog.quiet = stagedQuiet;
  for (const m of MODES) {
    await page.evaluate((mm) => window.__setMode(mm), m);
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${adapter}_quiet_${m}.png` });
  }

  // ---- DOES THE SHIPPED DEFAULT (AUTO) HOLD ITS MODE? ---------------------
  // Separate page load in the SAME browser: ?quality=auto un-freezes the tuner.
  console.log("\n=== AUTO TUNER, live, in the dense pack (90 s) ===");
  const autoLog = [];
  page.on("console", (msg) => { const t = msg.text(); if (/quality|mode|LOW|MEDIUM|HIGH/i.test(t)) autoLog.push(t.slice(0, 200)); });
  await page.goto(url("auto"), { waitUntil: "load", timeout: 90000 });
  await readiness();
  await page.evaluate(PROBE);
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => window.__scene());
    if (st.visible >= 14) break;
  }
  const autoTrack = [];
  const tAuto = Date.now();
  while (Date.now() - tAuto < 90000) {
    const fp = await page.evaluate(() => window.__fp());
    const sc = await page.evaluate(() => window.__scene());
    autoTrack.push({ t: Math.round((Date.now() - tAuto) / 1000), name: fp.name, setting: fp.setting, buf: fp.buf.join("x"), visible: sc.visible });
    await page.keyboard.press("Space").catch(() => {});
    await page.waitForTimeout(3000);
  }
  const seq = autoTrack.map((a) => a.name);
  console.log("  auto mode sequence:", seq.join(" -> "));
  console.log("  console lines:", autoLog.slice(0, 12).join(" | ") || "(none)");

  out = { adapter, gpu, floor, reps, secs, width, height, dpr, fp0, scenes: scenesLog, results, rigRates, auto: { track: autoTrack, seq, log: autoLog } };
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc1_${adapter}.json`, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT}/acc1_${adapter}.json`);

// ---- TABLE ------------------------------------------------------------------
for (const scene of ["worst", "quiet"]) {
  const rows = out.results[scene];
  if (!rows) continue;
  console.log(`\n=== ${adapter.toUpperCase()} · ${scene.toUpperCase()} · pooled raw frames ===`);
  console.log("mode     n      p50    fps50     p90      p99    mean   >16.7%   >33%  draws  vis  drift  qch  fgn%");
  for (const r of rows) {
    const f = r.frame;
    console.log(
      r.mode.padEnd(7), String(f.n).padStart(6), String(f.p50).padStart(8),
      (1000 / f.p50).toFixed(1).padStart(7), String(f.p90).padStart(8), String(f.p99).padStart(8),
      String(f.mean).padStart(7), String(f.over16).padStart(7), String(f.over33).padStart(7),
      String(r.calls).padStart(6), String(r.visible).padStart(4),
      String(r.anyDrift).padStart(6), String(r.qChanges).padStart(4), String(r.foreignPctMax).padStart(5),
    );
  }
}
