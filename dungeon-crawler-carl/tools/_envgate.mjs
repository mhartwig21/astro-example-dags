// PIXEL GATE for batch:environment (prop-batch tint -> per-instance colour).
// Two pinned scenes at the seeds the task names, idle at spawn, no input, eager
// assets, identical viewport/DPR. After the loading card has truly left the rAF
// clock is FROZEN at an ABSOLUTE base and advanced in fixed slices, so every
// time-driven FX ages identically in both arms (PERF-REPORT §7.4 — seeding from
// performance.now() made the gate fail on its own noise).
//
// Captures a SEQUENCE, not one still: batching failures that a single frame can
// hide (a tint applied on the wrong frame, a slot swap after a fog reveal, a
// shadow that only appears once the caster is in the map) show up as a frame
// that drifts while its neighbours match.
//
// Also dumps the structural census AND, when the build has per-instance prop
// tints, an EXACT arithmetic check: for every live batch instance,
//   batchMaterial.color * instanceColor[slot]  ==  sourceMesh.material.color
// The source mesh keeps its original tinted material (it is only hidden), so
// this compares the new product against the exact value the old build drew.
// Usage: node tools/_envgate.mjs <outDir>
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node tools/_envgate.mjs <outDir>"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const PORT = 5288;
const SCENES = [
  { id: "floor10", url: `http://localhost:${PORT}/iso.html?test&floor=10&level=14&abilities=all&seed=42&eagerassets&debug=1` },
  { id: "floor4", url: `http://localhost:${PORT}/iso.html?test&floor=4&seed=42&eagerassets&debug=1` },
];
const FRAMES = 5;      // stills per scene
const SLICE_MS = 16;   // virtual ms per advance
const PER_FRAME = 12;  // advances between stills (192 ms of virtual time)
const SETTLE = 62;     // advances before the first still

const distHtml = readFileSync(new URL("../dist/iso.html", import.meta.url), "utf8");
const wantBundle = (distHtml.match(/iso-[A-Za-z0-9_-]+\.js/) || [])[0];
const servedHtml = await (await fetch(`http://localhost:${PORT}/iso.html`)).text();
const gotBundle = (servedHtml.match(/iso-[A-Za-z0-9_-]+\.js/) || [])[0];
if (gotBundle !== wantBundle) throw new Error(`FINGERPRINT MISMATCH served=${gotBundle} dist=${wantBundle}`);
const glb = await fetch(`http://localhost:${PORT}/assets/characters/adventurer.glb`, { headers: { "accept-encoding": "gzip" } });
if (glb.headers.get("content-encoding") !== "gzip") throw new Error("not the shipping server (no gzip on glb)");
console.log(`[fp] bundle=${wantBundle} glb gzip ok`);

const CENSUS = () => {
  const r = window.__dcc.renderer;
  const info = r.renderer.info;
  let meshes = 0, visibleMeshes = 0, tris = 0;
  const names = new Map();
  r.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
    meshes++;
    if (o.visible) visibleMeshes++;
    const n = (o.material && o.material.name) || o.name || o.type;
    names.set(n, (names.get(n) ?? 0) + 1);
    const g = o.geometry;
    if (g && g.index) tris += g.index.count / 3;
  });

  // ---- prop batches: shape + the tint-equivalence proof ----
  const batches = r.propBatches || [];
  let live = 0, drawn = 0, withColor = 0, checked = 0, maxErr = 0;
  const mismatches = [];
  let castShadow = 0, receiveShadow = 0;
  for (const b of batches) {
    const im = b.mesh;
    live += b.count;
    if (im.visible && b.count > 0) drawn++;
    if (im.castShadow) castShadow++;
    if (im.receiveShadow) receiveShadow++;
    const ic = im.instanceColor;
    if (!ic) continue;
    withColor++;
    const bc = im.material.color;
    for (let s = 0; s < b.count; s++) {
      const leaf = b.members[s];
      if (!leaf) continue;
      const src = leaf.mesh.material;
      if (!src || !src.color) continue;
      checked++;
      const e = Math.max(
        Math.abs(bc.r * ic.array[s * 3] - src.color.r),
        Math.abs(bc.g * ic.array[s * 3 + 1] - src.color.g),
        Math.abs(bc.b * ic.array[s * 3 + 2] - src.color.b),
      );
      if (e > maxErr) maxErr = e;
      if (e > 1e-6 && mismatches.length < 8) {
        mismatches.push({
          batch: im.name, slot: s,
          want: [src.color.r, src.color.g, src.color.b],
          got: [bc.r * ic.array[s * 3], bc.g * ic.array[s * 3 + 1], bc.b * ic.array[s * 3 + 2]],
        });
      }
    }
  }
  return {
    sceneChildren: r.scene.children.length,
    meshes, visibleMeshes, indexedTris: Math.round(tris),
    drawCalls: info.render.calls, renderTris: info.render.triangles,
    programs: info.programs.length,
    geometries: info.memory.geometries, textures: info.memory.textures,
    propBatches: batches.length, propBatchesDrawn: drawn, propInstancesLive: live,
    propBatchesWithInstanceColor: withColor,
    propBatchCastShadow: castShadow, propBatchReceiveShadow: receiveShadow,
    tintChecked: checked, tintMaxErr: maxErr, tintMismatches: mismatches,
    matNames: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
    playerPos: (() => { const p = window.__dcc.state.players[0]; return p ? [+p.pos.x.toFixed(4), +p.pos.y.toFixed(4)] : null; })(),
    monsters: window.__dcc.state.monsters.filter((m) => m.hp > 0).length,
    camera: [+r.camera.position.x.toFixed(4), +r.camera.position.y.toFixed(4), +r.camera.position.z.toFixed(4)],
  };
};

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--dcc-envgate-5288"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const census = { bundle: wantBundle };
try {
  for (const s of SCENES) {
    await page.goto(s.url, { waitUntil: "load", timeout: 180000 });
    await page.waitForFunction(() => {
      const el = document.querySelector("#loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
    }, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(3000);
    const box = await page.evaluate(() => {
      const el = document.querySelector("#loading");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    });
    if (box) throw new Error(`${s.id}: loading card still has a box (${box}px2)`);
    await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.state, null, { timeout: 60000 });
    await page.evaluate(() => {
      if (window.__vt) return;
      const raf = window.requestAnimationFrame.bind(window);
      let t = 1e6; // ABSOLUTE, see PERF-REPORT §7.4
      window.__vt = { advance: (ms) => { t += ms; } };
      window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
    });
    for (let i = 0; i < SETTLE; i++) {
      await page.evaluate((ms) => window.__vt.advance(ms), SLICE_MS);
      await page.waitForTimeout(30);
    }
    for (let f = 0; f < FRAMES; f++) {
      await page.screenshot({ path: `${OUT}/${s.id}_f${f}.png` });
      if (f === 0) census[s.id] = await page.evaluate(CENSUS);
      for (let i = 0; i < PER_FRAME; i++) {
        await page.evaluate((ms) => window.__vt.advance(ms), SLICE_MS);
        await page.waitForTimeout(30);
      }
    }
    census[`${s.id}_end`] = await page.evaluate(CENSUS);
    const c = census[s.id];
    console.log(`[gate] ${s.id}: draws=${c.drawCalls} tris=${c.renderTris} batches=${c.propBatches} drawn=${c.propBatchesDrawn} live=${c.propInstancesLive} instColor=${c.propBatchesWithInstanceColor} tintChecked=${c.tintChecked} maxErr=${c.tintMaxErr} mismatches=${c.tintMismatches.length} progs=${c.programs}`);
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/census.json`, JSON.stringify(census, null, 2));
console.log("[gate] DONE ->", OUT);
