// WHAT FILLS THE SCREEN — the fill fit, and the per-layer ablation.
//
// Two questions, one page session:
//
//  1. IS THE FRAME FILL-BOUND, AND BY HOW MUCH? Sweep renderScale and fit
//     delivered ms against backbuffer megapixels. A near-zero intercept means
//     the frame IS the pixels; a large intercept means it is not. This is the
//     measurement quality.ts got backwards, and it is settled by DELIVERED
//     throughput rather than by a median of a queue-ahead distribution.
//
//  2. WHICH LAYER IS DOING THE FILLING? Hide each top-level scene child in turn
//     and measure. A layer that costs nothing when hidden is not the frame, no
//     matter how many objects it contains.
//
// Usage: node tools/r2_fill.mjs --adapter igpu|dgpu [--mode high] [--secs 3] [--reps 2]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "high");
const secs = Number(flag("--secs", 3));
const reps = Number(flag("--reps", 2));
const out = flag("--out", `tools/_r2fill_${adapter}_${mode}.json`);

const SCALES = [1, 0.8, 0.65, 0.5];

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  await stage(page);

  // ---- census: what IS in the top level of the scene ----------------------
  const census = await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    return r3d.scene.children.map((c, i) => {
      let n = 0, tris = 0;
      c.traverse((o) => {
        n++;
        const g = o.geometry;
        if (g && o.visible) {
          const idx = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
          tris += idx / 3;
        }
      });
      return { i, name: c.name || "(unnamed)", type: c.type, nodes: n, tris: Math.round(tris), visible: c.visible };
    }).filter((c) => c.visible);
  });
  console.log("\n[census] top-level scene children (visible only):");
  for (const c of census) console.log(`  #${String(c.i).padStart(3)} ${(c.name || c.type).padEnd(26)} ${c.type.padEnd(14)} nodes=${String(c.nodes).padStart(5)} tris=${c.tris}`);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    window.__hide = (i) => {
      const c = r3d.scene.children[i];
      if (!c) return false;
      c.visible = false;
      return true;
    };
    window.__show = (i) => { const c = r3d.scene.children[i]; if (c) c.visible = true; };
  });

  // Only layers with real geometry are worth an arm; lights/cameras are not.
  const layers = census.filter((c) => c.nodes > 1 || c.tris > 0).slice(0, 14);

  const fillRuns = new Map(SCALES.map((s) => [s, []]));
  const layerRuns = new Map(layers.map((l) => [l.i, []]));
  const baseRuns = [];

  for (let r = 0; r < reps; r++) {
    // --- fill sweep (rotated) ---
    const order = SCALES.map((_, i) => SCALES[(i + r) % SCALES.length]);
    for (const s of order) {
      await page.evaluate((v) => window.__dcc.renderer.setRenderScale(v), s);
      await page.waitForTimeout(400);
      const w = await window1(page, { secs });
      fillRuns.get(s).push(w);
      const [, bw, bh] = w.fp.split("|");
      const mpx = (bw * bh) / 1e6;
      console.log(`r${r} scale=${s} buf=${bw}x${bh} (${mpx.toFixed(2)} Mpx) delivered=${w.shape.delivered}ms fps=${w.shape.fps} vis=${w.visible} foreign=${w.foreign}`);
    }
    await page.evaluate(() => window.__dcc.renderer.setRenderScale(1));
    await page.waitForTimeout(400);

    // --- layer ablation (rotated) ---
    const lorder = layers.map((_, i) => layers[(i + r) % layers.length]);
    const b = await window1(page, { secs });
    baseRuns.push(b);
    console.log(`r${r} ${"BASE".padEnd(26)} delivered=${b.shape.delivered}ms fps=${b.shape.fps} vis=${b.visible}`);
    for (const l of lorder) {
      await page.evaluate((i) => window.__hide(i), l.i);
      let w;
      try { w = await window1(page, { secs }); } finally { await page.evaluate((i) => window.__show(i), l.i); }
      layerRuns.get(l.i).push(w);
      console.log(`r${r} hide ${(l.name || l.type).padEnd(21)} delivered=${w.shape.delivered}ms fps=${w.shape.fps} vis=${w.visible} foreign=${w.foreign}`);
    }
  }

  // ---- fit delivered ms = c + k * Mpx over the scale sweep ----------------
  const pts = [];
  for (const s of SCALES) {
    const ws = fillRuns.get(s);
    const p = pool(ws);
    const [, bw, bh] = ws[0].fp.split("|");
    pts.push({ scale: s, mpx: +((bw * bh) / 1e6).toFixed(3), ms: p.delivered, fps: p.fps, shape: p });
  }
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.mpx, 0), sy = pts.reduce((a, p) => a + p.ms, 0);
  const sxx = pts.reduce((a, p) => a + p.mpx * p.mpx, 0), sxy = pts.reduce((a, p) => a + p.mpx * p.ms, 0);
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const c = (sy - k * sx) / n;
  console.log(`\n=== ${adapter}/${mode} FILL FIT (delivered ms vs backbuffer Mpx) ===`);
  for (const p of pts) console.log(`  ${p.mpx.toFixed(3)} Mpx -> ${p.ms} ms  (${p.fps} fps, ${(p.ms / p.mpx).toFixed(2)} ms/Mpx)`);
  console.log(`  fit: ms = ${c.toFixed(2)} + ${k.toFixed(2)} * Mpx   (intercept = the part that is NOT pixels)`);

  const baseMs = pool(baseRuns).delivered;
  console.log(`\n=== ${adapter}/${mode} LAYER ABLATION (base ${baseMs} ms delivered) ===`);
  const layerTable = [];
  for (const l of layers) {
    const p = pool(layerRuns.get(l.i));
    const saved = +(baseMs - p.delivered).toFixed(2);
    layerTable.push({ ...l, delivered: p.delivered, saved, pctOfFrame: +(100 * saved / baseMs).toFixed(1) });
  }
  layerTable.sort((a, b) => b.saved - a.saved);
  for (const l of layerTable) {
    console.log(`  ${(l.name || l.type).padEnd(26)} saved ${String(l.saved).padStart(7)} ms  (${String(l.pctOfFrame).padStart(5)}% of frame)  tris=${l.tris}`);
  }

  writeFileSync(out, JSON.stringify({ adapter, mode, census, fit: { c, k, pts }, baseMs, layerTable }, null, 2));
  console.log(`\nwrote ${out}`);
} finally {
  await browser.close();
}
