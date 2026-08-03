// ACCEPTANCE CRITIQUE r1, PASS B — the same ladder with the harness taken OUT
// of the measurement window.
//
// WHY. Pass A (tools/acc1_perf.mjs) drove each window from node: a
// page.waitForTimeout(120) poll loop plus a CDP key press every 1.2 s. Its
// quiet-room result — 8-20% of frames over 33 ms with NOTHING on screen — is
// either a real stutter or ~33 CDP round trips per window showing up as ~30
// long frames. Those two are the same number, so pass A cannot tell them apart
// and neither can anybody reading it.
//
// So here the ENTIRE window runs inside one page.evaluate: the rAF loop, the
// clock, and the attack input (a synthetic KeyboardEvent, which the host's
// window-level keydown listener takes exactly like a real one). Node does not
// speak to the browser between the start and the end of a window.
//
// It also answers the question pass A's rig probe could not: mesh.visible on a
// monster is the FOG test (renderer3d.ts: `mesh.visible = inVision(n.pos)`),
// not "on screen", so counting visible rigs says nothing about whether LOW's
// rigBudget=14 is demoting bodies the player is looking at. This reads the
// gate's own output — rigFullRate.size — against the in-frustum count the gate
// itself computed, every frame.
//
// Usage: node tools/acc1b_perf.mjs --adapter igpu|dgpu [--reps 3] [--secs 5]
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 3));
const secs = Number(flag("--secs", 5));
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
    cpu.set(r.ProcessId, (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 1e7);
  }
  const ours = (pid) => { let c = pid; for (let i = 0; i < 24; i++) { if (c === ownPid) return true; const p = parent.get(c); if (p === undefined || p === 0 || p === c) return false; c = p; } return false; };
  const BROWSER = /^(chrome|chrome-headless-shell|msedge|firefox)\.exe$/i;
  let own = 0, foreign = 0; const foreignCpu = new Map();
  for (const [pid, n] of name) {
    if (!BROWSER.test(n)) continue;
    if (ours(pid)) own++; else { foreign++; foreignCpu.set(pid, cpu.get(pid)); }
  }
  return { ok: true, own, foreign, foreignCpu, t: Date.now() };
}
function foreignLoadPct(a, b) {
  if (!a?.ok || !b?.ok) return null;
  let s = 0;
  for (const [pid, c] of b.foreignCpu) { const p = a.foreignCpu.get(pid); if (p !== undefined) s += Math.max(0, c - p); }
  const wall = (b.t - a.t) / 1000;
  return wall > 0 ? +(100 * s / wall).toFixed(1) : null;
}

const stats = (a, wallMs) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  return {
    n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99),
    mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2),
    max: +s[s.length - 1].toFixed(1),
    over16: +(100 * s.filter((x) => x > 16.7).length / s.length).toFixed(1),
    over33: +(100 * s.filter((x) => x > 33.3).length / s.length).toFixed(1),
    // THROUGHPUT. The statistic a player actually experiences, and the one the
    // file's own tuner comment says the median cannot see.
    fps: wallMs ? +(1000 * s.length / wallMs).toFixed(1) : null,
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

let out = null;
try {
  await page.goto(url("high"), { waitUntil: "load", timeout: 90000 });
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
  const gpu = await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    gl.info.autoReset = false;
    // The gate's own output, sampled where it is produced.
    const G = { rigFull: [], inFrustum: [], calls: [] };
    window.__G = G;
    const oU = r3d.update.bind(r3d);
    r3d.update = function (...a) {
      const r = oU(...a);
      G.rigFull.push(r3d.rigFullRate.size);
      // The gate populated rigFrustum this frame (unless the mode has both
      // levers at Infinity, in which case there is no cap to measure anyway).
      let inF = 0;
      for (const mon of window.__dcc.state.monsters) {
        const mesh = r3d.monsters.get(mon.id);
        if (!mesh || !mesh.visible || !mesh.parent) continue;   // fog test
        r3d.rigSphere.center.set(mon.pos.x, 0.9, mon.pos.y);
        if (r3d.rigFrustum.intersectsSphere(r3d.rigSphere)) inF++;
      }
      G.inFrustum.push(inF);
      return r;
    };
    const oR = r3d.render.bind(r3d);
    r3d.render = function (...a) { gl.info.reset(); const r = oR(...a); G.calls.push(gl.info.render.calls); return r; };

    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };
    window.__fp = () => {
      const p = r3d.qualityProfile, raw = gl.getContext();
      return {
        name: p.name, setting: r3d.qualitySetting, pixelRatioCap: p.pixelRatioCap,
        effPixelRatio: +gl.getPixelRatio().toFixed(3), buf: [raw.drawingBufferWidth, raw.drawingBufferHeight],
        shadowMapSize: p.shadowMapSize, shadowInterval: p.shadowInterval,
        shadowMapActual: r3d.key?.shadow?.mapSize?.x ?? null,
        rigBudget: p.rigBudget === Infinity ? "inf" : p.rigBudget,
        offscreenRigHz: p.offscreenRigHz === Infinity ? "inf" : p.offscreenRigHz,
        gtaoScale: p.gtaoScale, bloomScale: p.bloomScale, dpr: window.devicePixelRatio,
      };
    };
    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0, parked = 0;
      for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
      let nodes = 0, bones = 0;
      r3d.scene.traverse((o) => { nodes++; if (o.isBone) bones++; });
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      return { monsters: s.monsters.length, visible: vis, parked, nodes, bones, alive: !!you?.alive };
    };
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
      return { packSize: bn };
    };
    window.__toQuiet = () => {
      const s = window.__dcc.state, rooms = s.map?.rooms ?? [];
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
      return { nearestMob: +Math.sqrt(bestD).toFixed(1) };
    };

    // THE WINDOW. Entirely in-page: no CDP traffic between its ends.
    window.__win = (ms, swing) => new Promise((resolve) => {
      const G = window.__G;
      G.rigFull.length = 0; G.inFrustum.length = 0; G.calls.length = 0;
      const frames = [];
      let last = performance.now();
      const t0 = last;
      let swings = 0;
      const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true }));
      const tick = () => {
        const n = performance.now();
        frames.push(n - last); last = n;
        if (swing && n - t0 > swings * 1200) { swings++; key("keydown"); setTimeout(() => key("keyup"), 60); }
        if (n - t0 < ms) requestAnimationFrame(tick);
        else resolve({ frames, wallMs: n - t0, rigFull: [...G.rigFull], inFrustum: [...G.inFrustum], calls: [...G.calls], swings });
      };
      requestAnimationFrame(tick);
    });
  });
  const fp0 = await page.evaluate(() => window.__fp());
  if (fp0.dpr !== 2) throw new Error(`devicePixelRatio ${fp0.dpr}`);

  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__toPack());
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => window.__scene());
    console.log(`[stage] try ${i + 1} -> visible=${st.visible} alive=${st.alive}`);
    if (st.visible >= 14) break;
  }
  const stagedWorst = await page.evaluate(() => window.__scene());
  console.log("[stage] WORST:", JSON.stringify(stagedWorst));

  const results = {};
  async function ladder(sceneName, swing) {
    const acc = new Map(MODES.map((m) => [m, { frames: [], wall: 0, warmFrames: [], warmWall: 0, rigFull: [], inFrustum: [], calls: [], meta: [] }]));
    for (let r = 0; r < reps + 1; r++) {
      for (const m of MODES) {
        const got = await page.evaluate((mm) => window.__setMode(mm), m);
        if (got !== m) throw new Error(`setQuality("${m}") -> "${got}"`);
        // 2.5 s of settle: buffer reallocation AND any program relink the new
        // target sizes provoke happen here, not inside the clock.
        await page.waitForTimeout(2500);
        const fpA = await page.evaluate(() => window.__fp());
        const cA = probe();
        const w = await page.evaluate(([ms, sw]) => window.__win(ms, sw), [secs * 1000, swing]);
        const cB = probe();
        const fpB = await page.evaluate(() => window.__fp());
        const sc = await page.evaluate(() => window.__scene());
        if (JSON.stringify(fpA) !== JSON.stringify(fpB)) throw new Error(`the preset MOVED during the window: ${JSON.stringify(fpA)} -> ${JSON.stringify(fpB)}`);
        if (r === 0) continue;  // warm-up rep, discarded
        const rec = acc.get(m);
        rec.frames.push(...w.frames.slice(1));
        rec.wall += w.wallMs;
        // The same window with its first second thrown away — the honest test
        // of "is the tail warm-up or is it steady state".
        const cut = w.frames.findIndex((_, i) => w.frames.slice(0, i + 1).reduce((a, b) => a + b, 0) > 1000);
        rec.warmFrames.push(...w.frames.slice(Math.max(1, cut)));
        rec.warmWall += w.wallMs - 1000;
        rec.rigFull.push(...w.rigFull); rec.inFrustum.push(...w.inFrustum); rec.calls.push(...w.calls);
        rec.meta.push({ fp: fpB, scene: sc, foreign: cB.foreign, foreignPct: foreignLoadPct(cA, cB), swings: w.swings });
        const s = stats(w.frames.slice(1), w.wallMs);
        console.log(`  [${sceneName}] ${m.padEnd(6)} fps=${String(s.fps).padStart(5)} p50=${String(s.p50).padStart(6)} p90=${String(s.p90).padStart(7)} p99=${String(s.p99).padStart(7)}`
          + ` >16.7=${String(s.over16).padStart(5)}% >33=${String(s.over33).padStart(5)}% n=${String(s.n).padStart(4)}`
          + ` buf=${fpB.buf.join("x")} vis=${sc.visible} frustum~${Math.round(w.inFrustum.reduce((a, b) => a + b, 0) / Math.max(1, w.inFrustum.length))}`
          + ` rigFull~${Math.round(w.rigFull.reduce((a, b) => a + b, 0) / Math.max(1, w.rigFull.length))}`
          + ` fgn=${cB.foreign}/${foreignLoadPct(cA, cB)}%`);
      }
    }
    return MODES.map((m) => {
      const rec = acc.get(m);
      const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
      const capped = rec.rigFull.filter((v, i) => rec.inFrustum[i] > v).length;
      return {
        mode: m, scene: sceneName,
        frame: stats(rec.frames, rec.wall),
        frameAfter1s: stats(rec.warmFrames, rec.warmWall),
        rigFullAvg: avg(rec.rigFull), inFrustumAvg: avg(rec.inFrustum),
        // THE RIG CAP, MEASURED: share of frames on which the gate ran out of
        // full-rate slots while bodies were still inside the camera frustum.
        rigCappedPct: rec.rigFull.length ? +(100 * capped / rec.rigFull.length).toFixed(1) : null,
        rigFullMax: Math.max(0, ...rec.rigFull), inFrustumMax: Math.max(0, ...rec.inFrustum),
        callsAvg: avg(rec.calls),
        foreignMax: Math.max(0, ...rec.meta.map((x) => x.foreign)),
        foreignPctMax: Math.max(0, ...rec.meta.map((x) => x.foreignPct ?? 0)),
        visibleAvg: avg(rec.meta.map((x) => x.scene.visible)),
        fp: rec.meta[0]?.fp,
      };
    });
  }

  console.log(`\n=== WORST (floor ${floor} dense pack) · ${adapter} · in-page windows ===`);
  results.worst = await ladder("worst", true);
  await page.evaluate(() => window.__toQuiet());
  await page.waitForTimeout(3000);
  const stagedQuiet = await page.evaluate(() => window.__scene());
  console.log(`\n[stage] QUIET: ${JSON.stringify(stagedQuiet)}`);
  console.log(`=== QUIET · ${adapter} · in-page windows ===`);
  results.quiet = await ladder("quiet", false);

  out = { adapter, gpu, floor, reps, secs, fp0, stagedWorst, stagedQuiet, results };
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc1b_${adapter}.json`, JSON.stringify(out, null, 1));

for (const scene of ["worst", "quiet"]) {
  console.log(`\n=== ${adapter.toUpperCase()} · ${scene.toUpperCase()} · pooled, in-page windows ===`);
  console.log("mode     fps      p50      p90      p99     mean   >16.7%    >33%    n   draws  frustum  rigFull  capped%  fgn%");
  for (const r of out.results[scene]) {
    const f = r.frame;
    console.log(
      r.mode.padEnd(7), String(f.fps).padStart(5), String(f.p50).padStart(8), String(f.p90).padStart(8),
      String(f.p99).padStart(8), String(f.mean).padStart(8), String(f.over16).padStart(7),
      String(f.over33).padStart(7), String(f.n).padStart(6), String(r.callsAvg).padStart(6),
      String(r.inFrustumAvg).padStart(7), String(r.rigFullAvg).padStart(8), String(r.rigCappedPct).padStart(7),
      String(r.foreignPctMax).padStart(5),
    );
  }
  console.log("same windows with the first second of each dropped:");
  for (const r of out.results[scene]) {
    const f = r.frameAfter1s;
    console.log(" ", r.mode.padEnd(6), `fps=${f.fps}`.padStart(10), `p50=${f.p50}`.padStart(10), `p90=${f.p90}`.padStart(11), `p99=${f.p99}`.padStart(12), `>16.7=${f.over16}%`.padStart(13), `>33=${f.over33}%`.padStart(11));
  }
}
console.log(`\nwrote ${OUT}/acc1b_${adapter}.json`);
