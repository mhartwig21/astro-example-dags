// WHO ARE THE 149 RIGS? The census counts them; this names them.
//
// r1's parking (renderer3d.ts, `mtxLive`) is supposed to detach every monster
// the fog hides, and fogVisionRadius is 8.5 tiles — so on a floor with 148
// monsters almost all of them should be OUT of the graph. The census says 149
// rig subtrees are in it. One of those two things is wrong, and this says
// which: it walks scene.children, and for every top-level child that contains
// a SkinnedMesh it reports name/type/userData keys, plus the parking state of
// every mesh in renderer.monsters.
//
// Census, not a timing — contamination cannot invalidate it.
//
// Usage: node tools/trk_rigwho.mjs [--floor 15] [--port 5282]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const floor = Number(flag("--floor", 15));
const level = Number(flag("--level", 26));
const port = Number(flag("--port", 5282));
const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=${level}&seed=41&abilities=all&debug=1&quality=high`;

console.log("[contamination]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
let out = null;
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
  await page.waitForTimeout(3000);
  console.log("GPU:", await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
  }));
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.waitForTimeout(2500);

  // TIMELINE. The first run of this probe found a 2,262-node scene with one rig
  // where the census found 7,566 and 149 — so the scene's size is a function of
  // WHEN you look, and of whether the crawler is still alive. Sample it.
  for (let i = 0; i < 8; i++) {
    const s = await page.evaluate(() => {
      const r3d = window.__dcc.renderer, st = window.__dcc.state;
      let total = 0, rigs = 0;
      r3d.scene.traverse(() => total++);
      for (const c of r3d.scene.children) { let h = false; c.traverse((o) => { if (o.isSkinnedMesh) h = true; }); if (h) rigs++; }
      let inGraph = 0;
      for (const [, m] of r3d.monsters) if (m.parent) inGraph++;
      return {
        t: +(performance.now() / 1000).toFixed(1), total, rigs, inGraph,
        players: st.players.map((p) => `${p.alive ? "alive" : "DEAD"} hp=${Math.round(p.hp)}`),
        over: st.over ?? null, phase: st.phase ?? null, floor: st.floor,
        mons: st.monsters.length, monsAlive: st.monsters.filter((m) => m.hp > 0).length,
      };
    });
    console.log("[t]", JSON.stringify(s));
    await page.waitForTimeout(1000);
  }

  out = await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const st = window.__dcc.state;
    const scene = r3d.scene;
    const subtree = (o) => {
      let n = 0, b = 0, sm = 0, m = 0;
      o.traverse((c) => { n++; if (c.isBone) b++; else if (c.isSkinnedMesh) sm++; else if (c.isMesh) m++; });
      return { n, b, sm, m };
    };
    // top-level children that contain a skinned mesh
    const rigTops = [];
    for (const c of scene.children) {
      let has = false;
      c.traverse((o) => { if (o.isSkinnedMesh) has = true; });
      if (!has) continue;
      const s = subtree(c);
      rigTops.push({
        name: c.name || "(anon)", type: c.type, visible: c.visible,
        ud: Object.keys(c.userData || {}).slice(0, 14),
        ...s,
      });
    }
    // group identical shapes
    const groups = {};
    for (const r of rigTops) {
      const k = `${r.type}|${r.name}|ud:${r.ud.join(",")}`;
      groups[k] = groups[k] || { k, count: 0, nodes: 0, bones: 0, skinned: 0, visibleTrue: 0 };
      groups[k].count++; groups[k].nodes += r.n; groups[k].bones += r.b; groups[k].skinned += r.sm;
      if (r.visible) groups[k].visibleTrue++;
    }
    // monster parking state
    const mons = r3d.monsters;
    let inGraph = 0, parked = 0, visTrue = 0, orphanVis = 0;
    const parents = {};
    for (const [, mesh] of mons) {
      const p = mesh.parent;
      const pk = p === null ? "(none)" : p === scene ? "scene" : `${p.type}:${p.name || "anon"}`;
      parents[pk] = (parents[pk] ?? 0) + 1;
      if (p) inGraph++; else parked++;
      if (mesh.visible) visTrue++;
      if (!mesh.visible && p) orphanVis++;
    }
    // Distances of monsters from the nearest living player (fog radius is 8.5)
    const pls = st.players.filter((p) => p.alive);
    const d = st.monsters.map((mo) => {
      let best = 1e9;
      for (const pl of pls) best = Math.min(best, Math.hypot(mo.pos.x - pl.pos.x, mo.pos.y - pl.pos.y));
      return best;
    }).sort((a, b) => a - b);
    let total = 0;
    scene.traverse(() => total++);
    return {
      totalNodes: total,
      sceneChildren: scene.children.length,
      rigTopCount: rigTops.length,
      rigGroups: Object.values(groups).sort((a, b) => b.nodes - a.nodes).slice(0, 20),
      monsterMeshes: mons.size,
      monstersInGraph: inGraph,
      monstersParked: parked,
      monstersVisibleTrue: visTrue,
      monstersInGraphButInvisible: orphanVis,
      monsterMeshParents: parents,
      simMonsters: st.monsters.length,
      monDistWithin8_5: d.filter((x) => x <= 8.5).length,
      monDistQuartiles: [d[0], d[Math.floor(d.length * 0.25)], d[Math.floor(d.length * 0.5)], d[Math.floor(d.length * 0.75)], d[d.length - 1]],
    };
  });
  console.log(JSON.stringify(out, null, 1));
  await page.screenshot({ path: "tools/_trkrigwho.png" });
  console.log("overlays:", JSON.stringify(await page.evaluate(() => {
    const vis = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!el.id) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 200 && r.height > 150 && cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05) {
        vis.push(`${el.id}[${Math.round(r.width)}x${Math.round(r.height)}]`);
      }
    }
    return vis.slice(0, 25);
  })));
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkrigwho_f${floor}.json`, JSON.stringify(out, null, 1));
console.log("[contamination after]", JSON.stringify(census()));
