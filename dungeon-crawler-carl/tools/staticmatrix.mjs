// VERIFY THE STATIC-TRANSFORM CHANGE, on facts that contamination cannot move.
//
// The box is shared with a sibling workflow that can take 99% of it, so timings
// today are unreliable. These checks are not timings — they are counts and
// positions, which are identical whether the box is idle or on fire:
//
//   1. props are FROZEN            (matrixWorldAutoUpdate === false)
//   2. props are WHERE THEY BELONG (world position != origin, spread over the
//      map) — the specific way this change could break is a frozen prop whose
//      world matrix was never computed, which parks it at the map corner
//   3. props still REVEAL          (walking into an unexplored room still eases
//      their scale up from 0.72*base to base)
//   4. matrix work per frame actually DROPPED — counted by instrumenting
//      Object3D.prototype.updateMatrix, not inferred
//
// Usage: node tools/staticmatrix.mjs --port 5282
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const url = `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1`;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE ERROR:", m.text().slice(0, 200)); });

await page.addInitScript(() => {
  // Count matrix recompositions per frame, from before any page script runs.
  const w = window;
  w.__mtx = { updateMatrix: 0, frames: 0 };
  // __dcc does not expose the THREE namespace, so reach Object3D.prototype by
  // walking up from a live scene object to whichever prototype owns updateMatrix.
  const install = () => {
    const R = w.__dcc && w.__dcc.renderer;
    if (!R || !R.scene || w.__mtxInstalled) return;
    let proto = Object.getPrototypeOf(R.scene);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "updateMatrix")) proto = Object.getPrototypeOf(proto);
    if (!proto) return;
    w.__mtxInstalled = true;
    const orig = proto.updateMatrix;
    proto.updateMatrix = function () { w.__mtx.updateMatrix++; return orig.call(this); };
  };
  const pump = () => {
    install();
    try {
      const st = w.__dcc && w.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; }
    } catch { /* not up yet */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.bringToFront();

const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
});
console.log("GPU:", gpu);
if (/SwiftShader|Software|llvmpipe/i.test(gpu)) { console.error("REFUSING: software GL"); await browser.close(); process.exit(1); }

await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(3000);

const box = await page.evaluate(() => {
  const e = document.getElementById("loading");
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { w: r.width, h: r.height, display: getComputedStyle(e).display };
});
if (box && box.w > 0 && box.display !== "none") { console.error("BOOT CARD STILL UP — MISSED"); await browser.close(); process.exit(1); }
console.log("loading card:", box ? "present but inert" : "absent");

// ---- 1 + 2: frozen, and placed where they belong ----
const placement = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const props = R.propEntries || [];
  let frozen = 0, atOrigin = 0, identityWorld = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const v = window.__dcc.renderer.camera.position.clone();
  for (const e of props) {
    if (e.obj.matrixAutoUpdate === false) frozen++;
    v.setFromMatrixPosition(e.obj.matrixWorld);
    if (Math.abs(v.x) < 1e-6 && Math.abs(v.z) < 1e-6) atOrigin++;
    const el = e.obj.matrixWorld.elements;
    if (el[0] === 1 && el[5] === 1 && el[10] === 1 && el[12] === 0 && el[13] === 0 && el[14] === 0) identityWorld++;
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  let chunksFrozen = 0, chunksTotal = 0;
  for (const c of R.floorGroup.children) {
    if (c.isInstancedMesh) { chunksTotal++; if (c.matrixAutoUpdate === false) chunksFrozen++; }
  }
  return { props: props.length, frozen, atOrigin, identityWorld, chunksTotal, chunksFrozen,
    spreadX: +(maxX - minX).toFixed(1), spreadZ: +(maxZ - minZ).toFixed(1) };
});
console.log("PLACEMENT:", JSON.stringify(placement));

// ---- 4: matrix recompositions per frame ----
const matrixRate = await page.evaluate(() => new Promise((resolve) => {
  const w = window;
  const start = w.__mtx.updateMatrix;
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    else resolve({ perFrame: +((w.__mtx.updateMatrix - start) / frames).toFixed(1), frames, instrumented: !!w.__mtxInstalled });
  };
  requestAnimationFrame(tick);
}));
console.log("MATRIX RECOMPOSITIONS PER FRAME (standing still):", JSON.stringify(matrixRate));

// WHERE THE REMAINING COMPOSES COME FROM. Every object still carrying
// matrixAutoUpdate=true is one matrix compose per frame, so counting them by
// owning subsystem predicts the per-frame cost exactly — and, unlike a timing,
// the count is identical whether the box is idle or at 99%.
const liveMatrices = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const scene = R.scene;
  const owner = new Map();
  for (const c of scene.children) owner.set(c, c.name || c.type);
  // name the top-level children by the Renderer3D field that holds them
  for (const k of Object.keys(R)) {
    const v = R[k];
    if (!v) continue;
    if (v.isObject3D && owner.has(v)) owner.set(v, k);
    if (v instanceof Map) for (const e of v.values()) { if (e && e.isObject3D && e.parent === scene) owner.set(e, k); }
    if (Array.isArray(v)) for (const e of v) { if (e && e.isObject3D && e.parent === scene) owner.set(e, k); }
  }
  const tally = {};
  let total = 0, live = 0;
  for (const top of scene.children) {
    const label = owner.get(top) || top.type;
    let n = 0, t = 0;
    top.traverse((o) => { t++; if (o.matrixAutoUpdate) n++; });
    total += t; live += n;
    tally[label] = (tally[label] || 0) + n;
  }
  const rows = Object.entries(tally).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { objectsInScene: total, stillAutoUpdating: live, top: rows };
});
console.log("LIVE MATRIX OBJECTS BY OWNER:", JSON.stringify(liveMatrices, null, 1));

// ---- 3: reveal still works. Walk into unexplored space and watch a prop's
// scale climb from the 0.72 floor toward its placed base.
const reveal = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  let hidden = 0, mid = 0, full = 0;
  for (const e of R.propEntries || []) {
    if (!e.base) continue;
    const r = e.obj.scale.x / (e.base.x || 1);
    if (!e.obj.visible) hidden++;
    else if (r < 0.995) mid++;
    else full++;
  }
  return { hidden, easing: mid, full };
});
console.log("REVEAL STATE before walking:", JSON.stringify(reveal));

await page.keyboard.down("w"); await page.waitForTimeout(2500); await page.keyboard.up("w");
await page.waitForTimeout(1200);

const reveal2 = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  let hidden = 0, mid = 0, full = 0, moved = 0;
  const v = window.__dcc.renderer.camera.position.clone();
  for (const e of R.propEntries || []) {
    if (!e.base) continue;
    const r = e.obj.scale.x / (e.base.x || 1);
    if (!e.obj.visible) hidden++;
    else if (r < 0.995) mid++;
    else full++;
    v.setFromMatrixPosition(e.obj.matrixWorld);
    if (Math.abs(v.x) > 1e-6 || Math.abs(v.z) > 1e-6) moved++;
  }
  return { hidden, easing: mid, full, placedAwayFromOrigin: moved };
});
console.log("REVEAL STATE after walking: ", JSON.stringify(reveal2));

// Does the FROZEN prop's world matrix actually track the reveal scale? Compare
// the scale baked into matrixWorld against the scale property; a frozen object
// whose matrix was not recomputed would disagree.
const coherent = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  let checked = 0, mismatched = 0, worst = 0;
  const v = window.__dcc.renderer.camera.position.clone();
  for (const e of R.propEntries || []) {
    if (!e.obj.visible) continue;
    v.setFromMatrixScale(e.obj.matrixWorld);
    const d = Math.abs(v.x - e.obj.scale.x);
    checked++;
    if (d > 1e-4) { mismatched++; worst = Math.max(worst, d); }
  }
  return { checked, mismatched, worstDelta: +worst.toFixed(6) };
});
console.log("MATRIX/SCALE COHERENCE:", JSON.stringify(coherent));

// ---- 5: VISIBLE monsters must still be transformed correctly. The skip is
// only sound if every body that IS drawn has a world matrix agreeing with the
// position the host wrote for it, and with the sim position it stands on.
const mons = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const st = window.__dcc.state;
  const byId = new Map(st.monsters.map((m) => [m.id, m]));
  const v = R.camera.position.clone();
  let visible = 0, invisible = 0, skipped = 0, mismatchWorld = 0, mismatchSim = 0, worst = 0;
  let bonesLive = 0;
  for (const [id, mesh] of R.monsters) {
    if (!mesh.visible) {
      invisible++;
      if (mesh.matrixAutoUpdate === false) skipped++;
      continue;
    }
    visible++;
    v.setFromMatrixPosition(mesh.matrixWorld);
    // scene is at the identity, so matrixWorld translation must equal position
    const dw = Math.hypot(v.x - mesh.position.x, v.y - mesh.position.y, v.z - mesh.position.z);
    if (dw > 1e-4) mismatchWorld++;
    worst = Math.max(worst, dw);
    const m = byId.get(id);
    // sim (x,y) maps to world (x,z); separation/knockback are display offsets,
    // so allow a small slack rather than demanding exact equality
    if (m && Math.hypot(v.x - m.pos.x, v.z - m.pos.y) > 1.2) mismatchSim++;
    mesh.traverse((o) => { if (o.matrixAutoUpdate) bonesLive++; });
  }
  return { visible, invisible, invisibleSkipped: skipped, mismatchWorld, mismatchSim,
    worstWorldDelta: +worst.toFixed(6), nodesUnderVisibleMonsters: bonesLive };
});
console.log("MONSTER TRANSFORMS:", JSON.stringify(mons));

await page.screenshot({ path: "tools/_staticmatrix.png" });
console.log("wrote tools/_staticmatrix.png");
await browser.close();
