// WHERE DOES THE TIME GO? The decisive adapter A/B, plus a main-thread
// breakdown, in ONE browser per adapter.
//
// The premise every previous round got wrong: this box has an Intel iGPU AND
// an RTX 5090 Laptop. `--use-angle=d3d11` alone selects the INTEL part, and the
// page's own `powerPreference:"high-performance"` does NOT override adapter
// selection. `--force_high_performance_gpu` selects the NVIDIA part.
//
// If the same scene costs the same on a laptop iGPU and a 5090, the frame is
// CPU-bound and no amount of shader/fill work will move it.
//
// Per scene it reports:
//   frameMs        rAF-to-rAF (vsync OFF, so this is real work not 8.33 steps)
//   updateMs       Renderer3D.update()  — scene graph walk, matrices, FX
//   renderMs       Renderer3D.render()  — composer submit (CPU side of GL)
//   restMs         frameMs - update - render = sim step + HUD/DOM + GC
//   gpuDrainMs     gl.finish() after render on sampled frames = GPU catch-up
//   heapMB         usedJSHeapSize at the end of the window
//   + draw calls, tris, scene census, alive monsters
//
// Usage: node tools/trk_where.mjs --adapter igpu|dgpu [--seconds 8]
//                                 [--port 5282] [--w 1440 --h 852 --dpr 2]
//                                 [--quality high] [--profile] [--json out]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const adapter = flag("--adapter", "igpu");
const seconds = Number(flag("--seconds", 8));
const port = Number(flag("--port", 5282));
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const quality = flag("--quality", "high");
const doProfile = has("--profile");
const jsonOut = flag("--json", `tools/_trkwhere_${adapter}.json`);

// ------------------------------------------------------- contamination meter
// A timing number taken while ANOTHER browser is live is contaminated, and the
// siblings run headless:false — so chrome.exe counts, not just
// chrome-headless-shell.exe. Own-vs-foreign is resolved by walking the process
// tree UP from each chrome pid to this node process.
function chromeCensus(ownPid) {
  let rows = [];
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' OR Name='chrome-headless-shell.exe' OR Name='msedge.exe'\\" | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out) rows = JSON.parse(out.startsWith("[") ? out : `[${out}]`);
  } catch { /* powershell unavailable -> report unknown */ return null; }
  const parentOf = new Map(rows.map((r) => [r.ProcessId, r.ParentProcessId]));
  // Parents outside the chrome set (e.g. the node process) are terminal.
  const rootsToNode = (pid) => {
    let cur = pid;
    for (let i = 0; i < 12; i++) {
      if (cur === ownPid) return true;
      const p = parentOf.get(cur);
      if (p === undefined) {
        // walk one level outside the chrome set
        try {
          const pp = execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${cur}').ParentProcessId"`,
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim();
          const n = Number(pp);
          if (!Number.isFinite(n) || n === 0 || n === cur) return false;
          cur = n;
          continue;
        } catch { return false; }
      }
      cur = p;
    }
    return false;
  };
  let own = 0, foreign = 0;
  for (const r of rows) (rootsToNode(r.ProcessId) ? own++ : foreign++);
  return { total: rows.length, own, foreign };
}

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };

const SCENES = [
  {
    id: "A_empty_early",
    label: "EMPTY EARLY FLOOR (f1, standing still)",
    url: `/iso.html?test&floor=1&level=2&seed=7&abilities=all&debug=1&quality=${quality}`,
    stage: async () => { /* stand still: nothing */ },
    during: null,
  },
  {
    id: "B_dense_late",
    label: "DENSE LATE FLOOR (f15, walking, not fighting)",
    url: `/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=${quality}`,
    stage: async (page) => {
      await page.keyboard.down("w"); await page.waitForTimeout(900); await page.keyboard.up("w");
    },
    during: async (page, ms) => {
      // keep moving so streaming/culling/anim all stay live
      const end = Date.now() + ms;
      await page.keyboard.down("w");
      while (Date.now() < end) await page.waitForTimeout(200);
      await page.keyboard.up("w");
    },
  },
  {
    id: "C_heavy_combat",
    label: "HEAVY COMBAT (f15, in the pack, abilities firing)",
    url: `/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=${quality}`,
    stage: async (page) => {
      await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
      await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
      for (const k of ["Space", "q", "e", "r", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }
    },
    during: async (page, ms) => {
      const end = Date.now() + ms;
      const keys = ["Space", "q", "e", "r", "c", "Space", "Space"];
      let i = 0;
      while (Date.now() < end) {
        await page.keyboard.press(keys[i++ % keys.length]).catch(() => {});
        await page.waitForTimeout(220);
      }
    },
  },
];

// ------------------------------------------------------------ in-page harness
const HARNESS = () => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  const raw = gl.getContext();
  gl.info.autoReset = false;

  const S = {
    frame: [], update: [], render: [], drain: [],
    calls: 0, tris: 0, progs: 0, frames: 0, drains: 0,
  };
  window.__trk = S;

  const origUpdate = r3d.update.bind(r3d);
  r3d.update = function (...a) {
    const t0 = performance.now();
    const r = origUpdate(...a);
    S.update.push(performance.now() - t0);
    return r;
  };
  const origRender = r3d.render.bind(r3d);
  r3d.render = function (...a) {
    gl.info.reset();
    const t0 = performance.now();
    const r = origRender(...a);
    const t1 = performance.now();
    S.render.push(t1 - t0);
    S.calls += gl.info.render.calls;
    S.tris += gl.info.render.triangles;
    S.progs = gl.info.programs?.length ?? 0;
    S.frames++;
    // GPU catch-up on a 1-in-8 sample: if the GPU were the wall, finish()
    // would block here. Sampled, so the sync itself does not become the cost.
    if (S.frames % 8 === 0) {
      const d0 = performance.now();
      raw.finish();
      S.drain.push(performance.now() - d0);
      S.drains++;
    }
    return r;
  };

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    S.frame.push(now - last);
    last = now;
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);

  window.__trkReset = () => {
    S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.drain.length = 0;
    S.calls = 0; S.tris = 0; S.frames = 0; S.drains = 0;
    S.heap0 = performance.memory?.usedJSHeapSize ?? 0;
    S.t0 = performance.now();
  };
  const stat = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const sum = s.reduce((x, y) => x + y, 0);
    return {
      n: s.length,
      median: +s[s.length >> 1].toFixed(3),
      mean: +(sum / s.length).toFixed(3),
      p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(3),
      max: +s[s.length - 1].toFixed(3),
    };
  };
  window.__trkDump = () => {
    const st = window.__dcc.state;
    let objects = 0, meshes = 0, skinned = 0, instanced = 0, lights = 0;
    const mats = new Set(), geos = new Set();
    r3d.scene.traverse((o) => {
      objects++;
      if (o.isMesh) meshes++;
      if (o.isSkinnedMesh) skinned++;
      if (o.isInstancedMesh) instanced++;
      if (o.isLight) lights++;
      if (o.material) for (const m of [].concat(o.material)) mats.add(m.uuid);
      if (o.geometry) geos.add(o.geometry.uuid);
    });
    const wall = performance.now() - S.t0;
    const heap1 = performance.memory?.usedJSHeapSize ?? 0;
    return {
      wallMs: +wall.toFixed(0),
      frames: S.frames,
      frame: stat(S.frame), update: stat(S.update), render: stat(S.render), drain: stat(S.drain),
      callsPerFrame: +(S.calls / Math.max(1, S.frames)).toFixed(0),
      trisPerFrame: +(S.tris / Math.max(1, S.frames)).toFixed(0),
      programs: S.progs,
      heapStartMB: +(S.heap0 / 1048576).toFixed(1),
      heapEndMB: +(heap1 / 1048576).toFixed(1),
      heapGrowthMBPerMin: +(((heap1 - S.heap0) / 1048576) / (wall / 60000)).toFixed(1),
      pixelRatio: gl.getPixelRatio(),
      drawingBuffer: [raw.drawingBufferWidth, raw.drawingBufferHeight],
      quality: r3d.qualityProfile?.name ?? "?",
      scene: { objects, meshes, skinned, instanced, lights, materials: mats.size, geometries: geos.size },
      sim: {
        floor: st?.floor ?? null,
        monsters: st?.monsters?.length ?? null,
        alive: st?.monsters?.filter?.((m) => m.hp > 0).length ?? null,
        items: st?.items?.length ?? null,
      },
      dom: {
        nodes: document.getElementsByTagName("*").length,
        dmgNumbers: document.querySelectorAll("#dmg > *, .dmg, [class*=dmg]").length,
      },
    };
  };
};

// -------------------------------------------------------------------- driver
const ownPid = process.pid;
const c0 = chromeCensus(ownPid);
console.log(`[contamination] before launch: ${JSON.stringify(c0)}`);

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const results = [];
try {
  for (const scene of SCENES) {
    const url = `http://localhost:${port}${scene.url}`;
    await page.goto(url, { waitUntil: "load", timeout: 60000 });

    // READINESS. data-assets-settled is NOT playable — the boot card still runs
    // shader precompile behind it. Poll #loading out, wait, assert no box.
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
    await page.waitForFunction(() => {
      const e = document.getElementById("loading");
      return !e || e.classList.contains("done");
    }, { timeout: 240000 });
    await page.waitForTimeout(3000);
    const box = await page.evaluate(() => {
      const e = document.getElementById("loading");
      if (!e) return { gone: true };
      const r = e.getBoundingClientRect();
      return { gone: r.width === 0 && r.height === 0, w: r.width, h: r.height, display: getComputedStyle(e).display };
    });
    if (!box.gone) throw new Error(`#loading still has a box: ${JSON.stringify(box)} — not playable`);

    // ASSERT THE ADAPTER ON THE GAME'S OWN CONTEXT, not a scratch canvas.
    const gpu = await page.evaluate(() => {
      const gl = window.__dcc.renderer.renderer.getContext();
      const d = gl.getExtension("WEBGL_debug_renderer_info");
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
    });
    if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but game context is "${gpu}" — refusing`);
    if (results.length === 0) console.log(`GAME CONTEXT GPU: ${gpu}`);

    await page.evaluate(HARNESS);
    await scene.stage(page);

    // Let shader compilation settle: programs stable for 4s.
    let lastP = -1, stable = Date.now(), deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const n = await page.evaluate(() => window.__dcc.renderer.renderer.info.programs.length);
      if (n !== lastP) { lastP = n; stable = Date.now(); } else if (Date.now() - stable > 4000) break;
      await page.waitForTimeout(400);
    }

    const cdp = doProfile ? await context.newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    }
    await page.evaluate(() => window.__trkReset());
    if (cdp) await cdp.send("Profiler.start");
    if (scene.during) await scene.during(page, seconds * 1000);
    else await page.waitForTimeout(seconds * 1000);
    const prof = cdp ? (await cdp.send("Profiler.stop")).profile : null;
    const d = await page.evaluate(() => window.__trkDump());
    const cDuring = chromeCensus(ownPid);

    d.id = scene.id;
    d.label = scene.label;
    d.adapter = adapter;
    d.gpu = gpu;
    d.contamination = cDuring;
    d.restMs = +(d.frame.median - d.update.median - d.render.median).toFixed(3);
    if (prof) d.profile = prof;
    results.push(d);

    console.log(`\n=== ${adapter.toUpperCase()} · ${scene.label} ===`);
    console.log(`  gpu             ${gpu}`);
    console.log(`  contamination   ${JSON.stringify(cDuring)}`);
    console.log(`  buffer          ${d.drawingBuffer.join("x")} @ pixelRatio ${d.pixelRatio} · preset ${d.quality}`);
    console.log(`  frames          ${d.frames} in ${d.wallMs}ms  (${(1000 / d.frame.median).toFixed(0)} fps at median)`);
    console.log(`  frameMs         median ${d.frame.median}  mean ${d.frame.mean}  p95 ${d.frame.p95}  max ${d.frame.max}`);
    console.log(`  updateMs        median ${d.update.median}  mean ${d.update.mean}  p95 ${d.update.p95}`);
    console.log(`  renderMs        median ${d.render.median}  mean ${d.render.mean}  p95 ${d.render.p95}`);
    console.log(`  restMs (sim+DOM+GC) ${d.restMs}`);
    console.log(`  gpuDrainMs      median ${d.drain?.median}  mean ${d.drain?.mean}  p95 ${d.drain?.p95}  (gl.finish, 1-in-8)`);
    console.log(`  draws/frame     ${d.callsPerFrame}   tris/frame ${(d.trisPerFrame / 1000).toFixed(0)}k   programs ${d.programs}`);
    console.log(`  scene           ${JSON.stringify(d.scene)}`);
    console.log(`  sim             ${JSON.stringify(d.sim)}`);
    console.log(`  heap            ${d.heapStartMB} -> ${d.heapEndMB} MB  (${d.heapGrowthMBPerMin} MB/min)`);
  }
} finally {
  await browser.close();
}
writeFileSync(jsonOut, JSON.stringify({ adapter, width, height, dpr, quality, seconds, results }, null, 1));
console.log(`\nwrote ${jsonOut}`);
const cEnd = chromeCensus(ownPid);
console.log(`[contamination] after close: ${JSON.stringify(cEnd)}`);
