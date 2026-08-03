// OPT-R3 — CAN LOW REACH ITS CONTRACT, AND AT WHAT SOFTNESS?
//
// LOW promises 20 ms delivered with at most 10% of frames over 20 ms. In the
// FIGHT scene on the Intel part it measured 25.96 ms and 29.9%. The previous
// round retired LOW's 16.7 ms promise by showing the levers could not reach it
// in principle; this asks the same question of 20 ms, but with a real
// instrument and by sweeping the ONE lever that dominates — resolution — inside
// a single page session, so the answer is a curve rather than an opinion.
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const secs = Number(flag("--secs", 4));
const reps = Number(flag("--reps", 2));
const scales = flag("--scales", "1,0.85,0.7,0.6,0.5").split(",").map(Number);
const out = `tools/_o3lowfit_${adapter}.json`;

const { browser, page } = await boot({ adapter });
const R = { adapter, rows: [] };
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate(() => window.__setMode("low"));
  await page.waitForTimeout(900);
  const runs = new Map(scales.map((s) => [s, []]));
  for (let r = 0; r < reps; r++) {
    for (const s of scales.map((_, i) => scales[(i + r) % scales.length])) {
      // renderScale multiplies the preset's own pixelRatioCap, so this sweeps
      // the EFFECTIVE ratio without touching any other lever.
      await page.evaluate((x) => window.__dcc.renderer.setRenderScale(x), s);
      await page.waitForTimeout(700);
      const w = await window1(page, { secs, scene: "fight", budgetMs: 20 });
      runs.get(s).push(w);
      console.log(
        `r${r} scale=${String(s).padEnd(5)} ${String(w.shape.fps).padStart(6)} fps  del=${String(w.shape.delivered).padStart(6)}ms  `
        + `>20=${String(w.shape.overBudget).padStart(5)}%  GPU=${w.gpuMs}ms  vis=${w.visible} foreign=${w.foreign}`,
      );
    }
  }
  console.log("\nscale  effRatio  delivered  >20ms   GPUms   fps");
  for (const s of scales) {
    const ws = runs.get(s);
    const p = pool(ws, 20);
    const gpu = ws.map((w) => w.gpuMs).filter((x) => x != null).sort((a, b) => a - b);
    const row = { scale: s, effRatio: +(0.85 * s).toFixed(3), ...p, gpuMs: gpu.length ? gpu[Math.floor(gpu.length / 2)] : null };
    R.rows.push(row);
    console.log(
      `${String(s).padEnd(6)} ${String(row.effRatio).padEnd(9)} ${String(p.delivered).padStart(9)}  ${String(p.overBudget).padStart(5)}%  `
      + `${String(row.gpuMs).padStart(6)}  ${p.fps}`,
    );
  }
} finally {
  writeFileSync(out, JSON.stringify(R, null, 2));
  await browser.close();
}
