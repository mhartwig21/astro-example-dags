// WHAT DOES THE MATRIX WALK ACTUALLY COST, on a LIVE floor 15?
//
// Round 0 said the walk was 7,566 nodes of which 4,664 were off-screen monster
// rigs. That census was taken on a run where the crawler was dead (see
// trk_live.mjs). With the crawler alive the graph is 2,769 nodes, ZERO of the
// 148 monster rigs are in it (r1's parking already removed them), and the
// waste has a completely different owner:
//
//   floorGroup   2,098 nodes   1,537 of them visible=false
//   monsters[]     506 nodes   (14 rigs, the ones actually in vision)
//   everything else ~165 nodes
//
// The 1,537 invisible nodes are prop subtrees the fog has not revealed, plus
// the source meshes of every batched prop ("The source mesh STAYS in the graph,
// invisible" — batchStaticProps). three.js's updateMatrixWorld does not look at
// `visible`; it recurses all of them, every frame.
//
// This ladder measures, inside ONE page load with variants interleaved so slow
// drift is shared:
//   baseline          — as shipped
//   frozen-matrices   — scene.matrixWorldAutoUpdate = false (the CEILING: the
//                       most any graph-culling could ever be worth)
//   park-hidden-props — the proposed change, applied from outside src/: every
//                       prop entry whose fog reveal has it hidden is detached
//                       from floorGroup into a root that is not in the scene
//   park-all-props    — diagnostic upper bound; changes pixels, not shippable
//
// Usage: node tools/trk_walk.mjs --adapter igpu|dgpu [--reps 4] [--secs 2.2]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 4));
const secs = Number(flag("--secs", 2.2));
const floor = Number(flag("--floor", 15));
const port = Number(flag("--port", 5282));
const tag = flag("--tag", "now");
const scene = flag("--scene", "combat");

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
const url = `http://localhost:${port}/iso.html?test&floor=${floor}&level=26&seed=41&abilities=all&debug=1&quality=high`;

const before = census();
console.log("[contamination BEFORE]", JSON.stringify(before));
const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const page = await context.newPage();
let pixelAB = null;
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
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return { gone: true };
    const r = e.getBoundingClientRect();
    return { gone: r.width === 0 && r.height === 0 };
  });
  if (!box.gone) throw new Error("#loading still has a box");
  const gpu = await page.evaluate(() => {
    const g = window.__dcc.renderer.renderer.getContext();
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but the GAME context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);

  // stage: walk in, then stand in the pack (the pin keeps the crawler alive, so
  // the floor's monsters converge and the scene stops drifting on its own)
  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  if (scene === "combat") {
    await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  }
  await page.waitForTimeout(1500);
  // FREEZE THE SIM so a 90-second ladder is not charged for the world moving.
  await page.keyboard.press("p");
  await page.waitForTimeout(1000);
  console.log("FREEZE: #sheet display =", await page.evaluate(() => document.getElementById("sheet")?.style.display));

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    const raw = gl.getContext();
    gl.info.autoReset = false;
    const S = { frame: [], update: [], render: [], drain: [], calls: 0, frames: 0 };
    window.__S = S;
    const oU = r3d.update.bind(r3d);
    r3d.update = function (...a) { const t = performance.now(); const r = oU(...a); S.update.push(performance.now() - t); return r; };
    const oR = r3d.render.bind(r3d);
    r3d.render = function (...a) {
      gl.info.reset();
      const t = performance.now(); const r = oR(...a); S.render.push(performance.now() - t);
      S.calls += gl.info.render.calls; S.frames++;
      if (S.frames % 8 === 0) { const d = performance.now(); raw.finish(); S.drain.push(performance.now() - d); }
      return r;
    };
    let last = performance.now();
    const tick = () => { const n = performance.now(); S.frame.push(n - last); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    // A root that is NOT in the scene. Its world matrix is floorGroup's, so a
    // subtree parked under it computes exactly the matrixWorld it had.
    const park = new (r3d.scene.constructor)();
    park.matrixAutoUpdate = false;
    park.matrixWorldAutoUpdate = false;
    park.matrix.copy(r3d.floorGroup.matrix);
    park.matrixWorld.copy(r3d.floorGroup.matrixWorld);
    let parked = [];
    const unpark = () => { for (const o of parked) r3d.floorGroup.add(o); parked = []; };
    const saved = { autoMat: r3d.scene.matrixWorldAutoUpdate };

    window.__reset = () => {
      r3d.scene.matrixWorldAutoUpdate = saved.autoMat;
      unpark();
    };
    window.__apply = (v) => {
      window.__reset();
      if (v === "baseline") return;
      if (v === "frozen-matrices") { r3d.scene.matrixWorldAutoUpdate = false; return; }
      if (v === "park-hidden-props" || v === "park-all-props") {
        const all = v === "park-all-props";
        for (const e of r3d.propEntries) {
          if (!all && e.obj.visible) continue;
          if (e.obj.parent !== r3d.floorGroup) continue;
          park.add(e.obj);
          parked.push(e.obj);
        }
        return;
      }
    };
    window.__reset2 = () => { S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.drain.length = 0; S.calls = 0; S.frames = 0; };
    window.__nodes = () => {
      let n = 0, invis = 0;
      r3d.scene.traverse((o) => { n++; if (!o.visible) invis++; });
      return { n, invis, parked: parked.length, props: r3d.propEntries.length };
    };
    window.__dump = () => {
      const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
      return {
        frames: S.frames, frame: st(S.frame), update: st(S.update), render: st(S.render),
        drain: st(S.drain), calls: +(S.calls / Math.max(1, S.frames)).toFixed(0),
      };
    };
  });

  const VARIANTS = (flag("--variants", null) ?? "baseline,frozen-matrices,park-hidden-props,park-all-props").split(",");
  const acc = new Map(VARIANTS.map((v) => [v, []]));
  const nodeCounts = {};
  for (let rep = 0; rep <= reps; rep++) {
    // rotate so no variant always follows baseline
    const order = VARIANTS.map((_, i) => VARIANTS[(i + rep) % VARIANTS.length]);
    for (const v of order) {
      await page.evaluate((vv) => window.__apply(vv), v);
      await page.waitForTimeout(350);           // let the change settle
      await page.evaluate(() => window.__reset2());
      await page.waitForTimeout(secs * 1000);
      const d = await page.evaluate(() => window.__dump());
      if (!nodeCounts[v]) nodeCounts[v] = await page.evaluate(() => window.__nodes());
      if (rep > 0) acc.get(v).push(d);          // rep 0 is warm-up, discarded
    }
  }
  await page.evaluate(() => window.__reset());

  // ---- SAME PIXELS? ----------------------------------------------------
  // The claim the cull rests on is that a fog-hidden prop was already drawing
  // nothing, so removing it from the graph cannot change a pixel. Prove it
  // against a CONTROL: two grabs of the identical state still differ (torch
  // flicker, motes, shader time), so the question is not "is the diff zero" but
  // "is the park-vs-unpark diff any bigger than the frame-to-frame diff".
  if (has("--pixels")) {
    const grab = async () => (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 852 } })).toString("base64");
    const a1 = await grab();
    await page.waitForTimeout(400);                // SAME gap as the real pair,
    const a2 = await grab();                       // else the control under-reads
    await page.evaluate(() => {                    // put every parked prop back
      const r3d = window.__dcc.renderer;
      for (const e of r3d.propEntries) if (e.obj.parent !== r3d.floorGroup) r3d.floorGroup.add(e.obj);
    });
    await page.waitForTimeout(400);
    const b = await grab();
    const diff = await page.evaluate(async ([x, y, z]) => {
      const load = (b64) => new Promise((res) => {
        const im = new Image();
        im.onload = () => {
          const c = document.createElement("canvas");
          c.width = im.width; c.height = im.height;
          const g = c.getContext("2d");
          g.drawImage(im, 0, 0);
          res(g.getImageData(0, 0, im.width, im.height).data);
        };
        im.src = "data:image/png;base64," + b64;
      });
      const [A, B, C] = await Promise.all([load(x), load(y), load(z)]);
      const mad = (p, q) => {
        let s = 0, n = 0, worst = 0;
        for (let i = 0; i < p.length; i += 4) {
          const d = Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
          s += d; n++; if (d > worst) worst = d;
        }
        return { meanAbsDiff: +(s / n / 3).toFixed(4), maxPixelDiff: worst };
      };
      return { control: mad(A, B), parkVsUnpark: mad(A, C) };
    }, [a1, a2, b]);
    console.log("\nPIXEL A/B (0-255 per channel):");
    console.log("  control  (same state, 120ms apart) :", JSON.stringify(diff.control));
    console.log("  park vs unpark                     :", JSON.stringify(diff.parkVsUnpark));
    pixelAB = diff;
    // leave the scene unparked; the ladder is over
  }

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
  out = { adapter, floor, scene, tag, reps, secs, gpu, contamination: { before }, pixelAB, rows: {} };
  console.log(`\n=== MATRIX-WALK LADDER · ${adapter} · floor ${floor} · ${scene} · ${tag} ===`);
  console.log("variant".padEnd(20), "frame", " update", " render", "  drain", " calls", "  nodes", " invis", "parked");
  const base = {};
  for (const v of VARIANTS) {
    const rs = acc.get(v);
    const row = {
      frame: med(rs.map((r) => r.frame)), update: med(rs.map((r) => r.update)),
      render: med(rs.map((r) => r.render)), drain: med(rs.map((r) => r.drain ?? 0)),
      calls: med(rs.map((r) => r.calls)), ...nodeCounts[v],
    };
    out.rows[v] = row;
    if (v === "baseline") Object.assign(base, row);
    const d = (k) => (v === "baseline" ? "" : ` (${(row[k] - base[k]) >= 0 ? "+" : ""}${(row[k] - base[k]).toFixed(2)})`);
    console.log(
      v.padEnd(20),
      String(row.frame).padStart(6) + d("frame"),
      String(row.update).padStart(6) + d("update"),
      String(row.render).padStart(6) + d("render"),
      String(row.drain).padStart(6),
      String(row.calls).padStart(5),
      String(row.n).padStart(6), String(row.invis).padStart(6), String(row.parked).padStart(6),
    );
  }
} finally {
  await browser.close();
}
const after = census();
console.log("[contamination AFTER]", JSON.stringify(after));
if (out) { out.contamination.after = after; writeFileSync(`tools/_trkwalk_${adapter}_${tag}.json`, JSON.stringify(out, null, 1)); }
