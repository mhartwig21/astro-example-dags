// THE MEASUREMENT ALL THE PREVIOUS ONES SHOULD HAVE BEEN: the crawler is ALIVE.
//
// WHY THIS TOOL EXISTS. `?test&floor=15&level=26&seed=41` drops a level-26
// crawler into the middle of a floor-15 population of 148 monsters and, if you
// stand still the way every harness in tools/ stands still, it is SHOT DEAD in
// about 6.8 seconds of run time — verified by screenshot: the IN MEMORIAM recap
// card ("SHOT - 152 damage, from 16% HP", "5s alive, no floor cleared") covers
// the whole 1440x852 viewport. Once the crawler is dead there are no living
// players, so the renderer's fog test `inVision` is false for everything, and
// r1's parking detaches EVERY monster from the scene. Measured on the dead run:
// 2,270 scene nodes, 1 rig, 0 of 148 monster meshes in the graph.
//
// Every harness in this tool directory boots, waits for readiness, walks for
// ~1.5s and then measures for several seconds — which straddles the moment of
// death. So a "dense floor 15" number is some unknown blend of a populated
// scene, a depopulating scene, and a full-screen DOM card.
//
// THE FIX IS A PIN, NOT A SIM CHANGE. A rAF hook restores hp/alive on the
// live state object through the existing ?debug=1 hook. src/sim is untouched;
// determinism is a property of step(), and nothing here is replayed. The pin
// also produces the scene we actually want to optimise for: an immortal
// standing target pulls the floor's monsters onto itself, which is the honest
// worst case a real player meets in a boss room or a swarm.
//
// It asserts, at both ends of every window: the crawler is alive, the recap
// card has no box, the game context is the adapter that was asked for.
//
// Usage: node tools/trk_live.mjs --adapter igpu|dgpu [--secs 8] [--floor 15]
//                                [--scene walk|combat|both] [--census]
//                                [--tag before] [--port 5282]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census as procCensus } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const adapter = flag("--adapter", "igpu");
const secs = Number(flag("--secs", 8));
const floor = Number(flag("--floor", 15));
const level = Number(flag("--level", 26));
const sceneArg = flag("--scene", "both");
const port = Number(flag("--port", 5282));
const quality = flag("--quality", "high");
const tag = flag("--tag", "now");
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=${level}&seed=41&abilities=all&debug=1&quality=${quality}`;

// ---------------------------------------------------------------- in-page ---
const PIN = () => {
  // KEEP THE CRAWLER ALIVE. Runs before the frame loop's own rAF work each
  // frame; hp is topped up and `alive` forced, so the death path never fires
  // and the recap card never mounts.
  const pin = () => {
    const st = window.__dcc.state;
    for (const p of st.players) { p.hp = p.maxHp; p.alive = true; p.downedT = 0; }
    window.__pinRaf = requestAnimationFrame(pin);
  };
  window.__pinRaf = requestAnimationFrame(pin);
};

const HARNESS = () => {
  const r3d = window.__dcc.renderer;
  const gl = r3d.renderer;
  const raw = gl.getContext();
  gl.info.autoReset = false;
  const S = { frame: [], update: [], render: [], drain: [], calls: 0, tris: 0, frames: 0 };
  window.__S = S;
  const oU = r3d.update.bind(r3d);
  r3d.update = function (...a) { const t = performance.now(); const r = oU(...a); S.update.push(performance.now() - t); return r; };
  const oR = r3d.render.bind(r3d);
  r3d.render = function (...a) {
    gl.info.reset();
    const t = performance.now(); const r = oR(...a); S.render.push(performance.now() - t);
    S.calls += gl.info.render.calls; S.tris += gl.info.render.triangles; S.frames++;
    if (S.frames % 8 === 0) { const d = performance.now(); raw.finish(); S.drain.push(performance.now() - d); }
    return r;
  };
  let last = performance.now();
  const tick = () => { const n = performance.now(); S.frame.push(n - last); last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__reset = () => {
    S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.drain.length = 0;
    S.calls = 0; S.tris = 0; S.frames = 0; S.t0 = performance.now();
    S.heap0 = performance.memory?.usedJSHeapSize ?? 0;
  };
  const stat = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const sum = s.reduce((x, y) => x + y, 0);
    return {
      n: s.length, median: +s[s.length >> 1].toFixed(2), mean: +(sum / s.length).toFixed(2),
      p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(2), max: +s[s.length - 1].toFixed(2),
    };
  };
  window.__dump = () => {
    const st = window.__dcc.state;
    const rest = [];
    for (let i = 0; i < Math.min(S.frame.length, S.update.length, S.render.length); i++) {
      rest.push(Math.max(0, S.frame[i] - S.update[i] - S.render[i]));
    }
    let nodes = 0, bones = 0, skinned = 0, meshes = 0, sprites = 0, visFalse = 0;
    r3d.scene.traverse((o) => {
      nodes++;
      if (o.isBone) bones++;
      else if (o.isSkinnedMesh) skinned++;
      else if (o.isSprite) sprites++;
      else if (o.isMesh) meshes++;
      if (!o.visible) visFalse++;
    });
    let monInGraph = 0;
    for (const [, m] of r3d.monsters) if (m.parent) monInGraph++;
    const alive = st.players.filter((p) => p.alive).length;
    const rc = document.getElementById("recap");
    const rcBox = rc ? rc.getBoundingClientRect() : null;
    return {
      frames: S.frames, wallMs: +(performance.now() - S.t0).toFixed(0),
      frame: stat(S.frame), update: stat(S.update), render: stat(S.render),
      rest: stat(rest), drain: stat(S.drain),
      callsPerFrame: +(S.calls / Math.max(1, S.frames)).toFixed(0),
      trisPerFrame: +(S.tris / Math.max(1, S.frames)).toFixed(0),
      sceneNodes: nodes, bones, skinnedMeshes: skinned, meshes, sprites, visibleFalse: visFalse,
      monsterMeshes: r3d.monsters.size, monstersInGraph: monInGraph,
      simMonsters: st.monsters.length, simMonstersAlive: st.monsters.filter((m) => m.hp > 0).length,
      playersAlive: alive,
      recapVisible: !!(rcBox && rcBox.width > 0 && rcBox.height > 0),
      heapMB: +((performance.memory?.usedJSHeapSize ?? 0) / 1048576).toFixed(1),
      drawingBuffer: [raw.drawingBufferWidth, raw.drawingBufferHeight],
      pixelRatio: gl.getPixelRatio(),
    };
  };
};

// -------------------------------------------------------------------- run ---
const before = procCensus();
console.log("[contamination BEFORE]", JSON.stringify(before));
const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
const results = {};
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
  // PIN FIRST, THEN SETTLE. The 3-second readiness soak is itself long enough
  // to kill an unpinned crawler on floor 15.
  await page.evaluate(PIN);
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return { gone: true };
    const r = e.getBoundingClientRect();
    return { gone: r.width === 0 && r.height === 0, w: r.width, h: r.height };
  });
  if (!box.gone) throw new Error(`#loading still has a box: ${JSON.stringify(box)}`);
  const gpu = await page.evaluate(() => {
    const g = window.__dcc.renderer.renderer.getContext();
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);
  await page.evaluate(HARNESS);

  const scenes = sceneArg === "both" ? ["walk", "combat"] : [sceneArg];
  for (const sc of scenes) {
    // stage
    await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
    if (sc === "combat") {
      await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
      for (const k of ["Space", "q", "e", "r", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }
    }
    await page.waitForTimeout(1200);
    const pre = await page.evaluate(() => ({
      alive: window.__dcc.state.players.filter((p) => p.alive).length,
      recap: (() => { const e = document.getElementById("recap"); const r = e && e.getBoundingClientRect(); return !!(r && r.width > 0); })(),
    }));
    if (pre.alive < 1 || pre.recap) throw new Error(`scene ${sc}: pin failed (${JSON.stringify(pre)})`);
    await page.evaluate(() => window.__reset());
    const end = Date.now() + secs * 1000;
    const keys = ["Space", "q", "e", "r", "c", "Space", "Space"];
    let i = 0;
    if (sc === "walk") { await page.keyboard.down("w"); }
    while (Date.now() < end) {
      if (sc === "combat") await page.keyboard.press(keys[i++ % keys.length]).catch(() => {});
      await page.waitForTimeout(sc === "combat" ? 220 : 200);
    }
    if (sc === "walk") { await page.keyboard.up("w"); }
    const d = await page.evaluate(() => window.__dump());
    if (d.playersAlive < 1 || d.recapVisible) throw new Error(`scene ${sc}: crawler died mid-window (${d.playersAlive} alive, recap=${d.recapVisible})`);
    results[sc] = d;
    console.log(`\n=== ${sc.toUpperCase()} · ${adapter} · floor ${floor} · ${tag} ===`);
    console.log(`frame   ${JSON.stringify(d.frame)}`);
    console.log(`update  ${JSON.stringify(d.update)}`);
    console.log(`render  ${JSON.stringify(d.render)}`);
    console.log(`rest    ${JSON.stringify(d.rest)}`);
    console.log(`drain   ${JSON.stringify(d.drain)}`);
    console.log(`nodes ${d.sceneNodes} (bones ${d.bones}, skinned ${d.skinnedMeshes}, mesh ${d.meshes}, sprite ${d.sprites}, vis=false ${d.visibleFalse})`);
    console.log(`monsters in graph ${d.monstersInGraph}/${d.monsterMeshes} · sim alive ${d.simMonstersAlive}/${d.simMonsters} · players alive ${d.playersAlive}`);
    console.log(`calls/frame ${d.callsPerFrame} · tris/frame ${d.trisPerFrame} · buf ${d.drawingBuffer} · heap ${d.heapMB}MB`);
  }
  // ---- PROOF THAT THE CULL CANNOT CHANGE A PIXEL -------------------------
  // Screenshots drift (torch flicker, shader time), so the load-bearing check
  // is EXACT and animation-independent: freeze the sim, count draw calls and
  // triangles for 60 frames with the shipped parking, then force every parked
  // prop back into floorGroup and count 60 more. A parked prop was invisible,
  // so if the cull removed anything the renderer wanted, these differ.
  if (has("--proof")) {
    await page.keyboard.press("p"); // character sheet: the sim stops, drawing does not
    await page.waitForTimeout(900);
    // STUB THE FOG LOOP FIRST. The character sheet stops the SIM, not the
    // renderer — updateFogTint still runs every frame, and it re-parked every
    // prop inside the 500ms between unparking and sampling. The first version of
    // this proof therefore compared the parked state with itself and reported a
    // triumphant IDENTICAL that meant nothing. With the loop stubbed, prop
    // visibility and batch membership are frozen for both samples and the only
    // thing that differs is graph membership, which is the thing under test.
    await page.evaluate(() => { window.__dcc.renderer.updateFogTint = () => {}; });
    await page.waitForTimeout(200);
    const sample = async () => page.evaluate(() => new Promise((res) => {
      const gl = window.__dcc.renderer.renderer;
      const calls = [], tris = [];
      let n = 0;
      const tick = () => {
        calls.push(gl.info.render.calls); tris.push(gl.info.render.triangles);
        if (++n < 60) requestAnimationFrame(tick);
        else {
          const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
          res({ calls: med(calls), tris: med(tris) });
        }
      };
      requestAnimationFrame(tick);
    }));
    const parkedState = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      let n = 0; r.scene.traverse(() => n++);
      return { nodes: n, offGraph: r.propEntries.filter((e) => e.obj.parent !== r.floorGroup).length, props: r.propEntries.length };
    });
    const withPark = await sample();
    await page.screenshot({ path: `tools/_trklive_${adapter}_parked.png` });
    await page.evaluate(() => {
      const r = window.__dcc.renderer;
      for (const e of r.propEntries) if (e.obj.parent !== r.floorGroup) r.floorGroup.add(e.obj);
    });
    await page.waitForTimeout(500);
    const unparked = await page.evaluate(() => { let n = 0; window.__dcc.renderer.scene.traverse(() => n++); return n; });
    const withoutPark = await sample();
    await page.screenshot({ path: `tools/_trklive_${adapter}_unparked.png` });
    results.proof ={ parkedState, unparkedNodes: unparked, withPark, withoutPark };
    console.log(`\n=== PROOF · ${adapter} ===`);
    console.log(`props off-graph ${parkedState.offGraph}/${parkedState.props} · nodes parked ${parkedState.nodes} vs unparked ${unparked}`);
    console.log(`draw calls  parked ${withPark.calls}  unparked ${withoutPark.calls}   ${withPark.calls === withoutPark.calls ? "IDENTICAL" : "*** DIFFER ***"}`);
    console.log(`triangles   parked ${withPark.tris}  unparked ${withoutPark.tris}   ${withPark.tris === withoutPark.tris ? "IDENTICAL" : "*** DIFFER ***"}`);
  }
} finally {
  await browser.close();
}
const after = procCensus();
console.log("\n[contamination AFTER]", JSON.stringify(after));
const out = { adapter, floor, quality, tag, secs, gpuExpect: String(EXPECT[adapter]), contamination: { before, after }, results };
writeFileSync(`tools/_trklive_${adapter}_${tag}.json`, JSON.stringify(out, null, 1));
console.log(`wrote tools/_trklive_${adapter}_${tag}.json`);
