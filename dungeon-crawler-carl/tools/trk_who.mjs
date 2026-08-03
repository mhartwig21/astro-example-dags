// WHO IS IN THE GRAPH, on a run where the crawler is ALIVE (see trk_live.mjs
// for why that qualifier is load-bearing).
//
// With the keep-alive pin the floor-15 scene is 2,791 nodes, not the 7,566 the
// round-0 census reported, and 0 of the 148 monster rigs are in it — r1's
// parking already removed them. But 1,575 of those 2,791 nodes are
// visible=false, and three.js recurses every one of them. This names them:
// every top-level scene child, grouped by identity, with node count, how many
// of its nodes are invisible, and whether the whole subtree is dark.
//
// Census, not a timing — contamination cannot invalidate it.
//
// Usage: node tools/trk_who.mjs [--floor 15] [--port 5282]
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
  await page.evaluate(() => {
    const pin = () => {
      for (const p of window.__dcc.state.players) { p.hp = p.maxHp; p.alive = true; p.downedT = 0; }
      requestAnimationFrame(pin);
    };
    requestAnimationFrame(pin);
  });
  await page.waitForTimeout(3000);
  console.log("GPU:", await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
  }));
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(2000);

  out = await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const scene = r3d.scene;
    // name every top-level child by the renderer field that owns it, so the
    // report says "laneStrips" rather than "Group".
    const owner = new Map();
    for (const k of Object.keys(r3d)) {
      const v = r3d[k];
      if (v && v.isObject3D) owner.set(v, k);
      else if (v instanceof Map) { for (const [, o] of v) if (o && o.isObject3D) owner.set(o, `${k}[]`); }
      else if (Array.isArray(v)) { for (const o of v) if (o && o.isObject3D) owner.set(o, `${k}[]`); }
      else if (v instanceof Set) { for (const o of v) if (o && o.isObject3D) owner.set(o, `${k}[]`); }
    }
    const rows = [];
    for (const c of scene.children) {
      let n = 0, invis = 0, mesh = 0, sprite = 0, bone = 0, skinned = 0, inst = 0, pts = 0, autoMat = 0;
      c.traverse((o) => {
        n++;
        if (!o.visible) invis++;
        if (o.matrixAutoUpdate) autoMat++;
        if (o.isBone) bone++;
        else if (o.isSkinnedMesh) skinned++;
        else if (o.isInstancedMesh) inst++;
        else if (o.isSprite) sprite++;
        else if (o.isPoints) pts++;
        else if (o.isMesh) mesh++;
      });
      rows.push({
        own: owner.get(c) ?? "(unowned)", name: c.name || "", type: c.type,
        vis: c.visible, n, invis, mesh, sprite, bone, skinned, inst, pts, autoMat,
        ud: Object.keys(c.userData || {}).slice(0, 8).join(","),
      });
    }
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.own}|${r.type}|${r.name}`;
      const g = groups.get(k) ?? { k, count: 0, n: 0, invis: 0, mesh: 0, sprite: 0, bone: 0, skinned: 0, inst: 0, autoMat: 0, rootHidden: 0 };
      g.count++; g.n += r.n; g.invis += r.invis; g.mesh += r.mesh; g.sprite += r.sprite;
      g.bone += r.bone; g.skinned += r.skinned; g.inst += r.inst; g.autoMat += r.autoMat;
      if (!r.vis) g.rootHidden++;
      groups.set(k, g);
    }
    let total = 0, invisTotal = 0, autoTotal = 0;
    scene.traverse((o) => { total++; if (!o.visible) invisTotal++; if (o.matrixAutoUpdate) autoTotal++; });
    // How many nodes sit under a root whose own `visible` is already false?
    // Those are pure waste: three.js recurses them and draws none of them.
    let underDarkRoot = 0;
    for (const c of scene.children) if (!c.visible) c.traverse(() => underDarkRoot++);
    const st = window.__dcc.state;
    return {
      totalNodes: total, invisibleNodes: invisTotal, matrixAutoUpdateOn: autoTotal,
      sceneChildren: scene.children.length,
      nodesUnderAnAlreadyHiddenRoot: underDarkRoot,
      playersAlive: st.players.filter((p) => p.alive).length,
      monstersInGraph: [...r3d.monsters.values()].filter((m) => m.parent).length,
      monsterMeshes: r3d.monsters.size,
      drawCalls: r3d.renderer.info.render.calls,
      rows: [...groups.values()].sort((a, b) => b.n - a.n),
    };
  });
  console.log(`\nplayersAlive=${out.playersAlive}  totalNodes=${out.totalNodes}  invisible=${out.invisibleNodes}  underHiddenRoot=${out.nodesUnderAnAlreadyHiddenRoot}  autoMat=${out.matrixAutoUpdateOn}  sceneChildren=${out.sceneChildren}  monstersInGraph=${out.monstersInGraph}/${out.monsterMeshes}`);
  console.log("\n owner/type/name".padEnd(52), "cnt", "nodes", "invis", "mesh", "sprt", "bone", "skin", "inst", "auto", "darkRoots");
  for (const r of out.rows) {
    if (r.n < 3) continue;
    console.log(
      ` ${r.k}`.slice(0, 52).padEnd(52),
      String(r.count).padStart(3), String(r.n).padStart(5), String(r.invis).padStart(5),
      String(r.mesh).padStart(4), String(r.sprite).padStart(4), String(r.bone).padStart(4),
      String(r.skinned).padStart(4), String(r.inst).padStart(4), String(r.autoMat).padStart(4),
      String(r.rootHidden).padStart(6),
    );
  }
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkwho_f${floor}.json`, JSON.stringify(out, null, 1));
console.log("[contamination after]", JSON.stringify(census()));
