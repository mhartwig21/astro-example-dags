// PIXEL GATE for opt1-shader-prewarm-combat-variants.
// Two pinned scenes (floor 10 seed 42, floor 4 seed 42), idle at spawn, no
// input, eager assets, identical viewport/DPR. After the loading screen has
// truly left (HARNESS honesty rule 1) the rAF clock is FROZEN and advanced a
// fixed 992ms in 16ms slices, so FX/animation age by the same amount in both
// arms; only the pre-freeze phase can differ.
// Also dumps a STRUCTURAL census of the live scene (child count + mesh names +
// draw calls/tris/programs) — the real risk of a prewarm change is a leftover
// warm object, and that is a number, not a judgement call.
// Usage: node tools/_pixgate_wf.mjs <outDir>
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node tools/_pixgate_wf.mjs <outDir>"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const PORT = 5288;
const SCENES = [
  { id: "floor10", url: `http://localhost:${PORT}/iso.html?test&floor=10&seed=42&eagerassets&debug=1` },
  { id: "floor4", url: `http://localhost:${PORT}/iso.html?test&floor=4&seed=42&eagerassets&debug=1` },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--dcc-pixgate-5288"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const census = {};
try {
  for (const s of SCENES) {
    await page.goto(s.url, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => {
      const el = document.querySelector("#loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
    }, null, { timeout: 300000, polling: 500 });
    await page.waitForTimeout(3000);
    // ASSERT the loading card has no box (rule 1).
    const box = await page.evaluate(() => {
      const el = document.querySelector("#loading");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    });
    if (box) throw new Error(`${s.id}: loading card still has a box (${box}px2)`);
    await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.state, null, { timeout: 60000 });
    // Freeze, then age a fixed amount.
    await page.evaluate(() => {
      if (window.__vt) return;
      const raf = window.requestAnimationFrame.bind(window);
      let t = performance.now();
      window.__vt = { advance: (ms) => { t += ms; } };
      window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
    });
    for (let i = 0; i < 62; i++) {
      await page.evaluate(() => window.__vt.advance(16));
      await page.waitForTimeout(30);
    }
    await page.screenshot({ path: `${OUT}/${s.id}.png` });
    census[s.id] = await page.evaluate(() => {
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
      // LEFTOVER CHECK: the only way this change can touch a live frame is by
      // leaving a prewarm warm object in the scene. Name every survivor.
      const leftovers = [];
      r.scene.traverse((o) => {
        const m = o.material;
        const mats = Array.isArray(m) ? m : m ? [m] : [];
        for (const mm of mats) {
          const nm = mm.name || "";
          if (nm.startsWith("zoo_")) { leftovers.push(`zoo:${o.type}:${nm}`); return; }
          const u = mm.uniforms;
          if (u && (u.uShield || u.uTether || u.uPunish || u.uArena || u.uPlate || u.uSpore)) {
            leftovers.push(`bossmat:${o.type}`); return;
          }
        }
      });
      return {
        leftovers,
        childList: r.scene.children.map((c) => `${c.type}:${c.name || "-"}:${c.children.length}:${c.visible ? "v" : "h"}`),
        sceneChildren: r.scene.children.length,
        meshes, visibleMeshes, indexedTris: Math.round(tris),
        drawCalls: info.render.calls, renderTris: info.render.triangles,
        programs: info.programs.length,
        geometries: info.memory.geometries, textures: info.memory.textures,
        matNames: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
        playerPos: (() => { const p = window.__dcc.state.players[0]; return p ? [+p.pos.x.toFixed(4), +p.pos.y.toFixed(4)] : null; })(),
        monsters: window.__dcc.state.monsters.filter((m) => m.hp > 0).length,
        camera: [+window.__dcc.renderer.camera.position.x.toFixed(4),
          +window.__dcc.renderer.camera.position.y.toFixed(4),
          +window.__dcc.renderer.camera.position.z.toFixed(4)],
      };
    });
    console.log(s.id, JSON.stringify(census[s.id]).slice(0, 400));
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/census.json`, JSON.stringify(census, null, 2));
console.log("[pixgate] DONE ->", OUT);
