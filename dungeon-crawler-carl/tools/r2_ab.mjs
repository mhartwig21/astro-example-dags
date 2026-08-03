// WHERE THE FRAME ACTUALLY GOES — ablation, judged on DELIVERED THROUGHPUT.
//
// The acceptance critic's blocker 3 says the Intel frame is ~100% fill: delivered
// frame time is proportional to backbuffer pixels with a ~zero intercept, which
// flatly contradicts quality.ts's "MOST OF THE FRAME IS CPU". Both claims were
// made from the SAME kind of evidence — a median of rAF deltas — and a median of
// a queue-ahead bimodal distribution is a description of the cheap mode only.
//
// So this measures throughput: frames delivered / wall seconds. A rAF callback
// that returns early because the swap chain is full still costs the player a
// frame; throughput counts it, a median does not.
//
// Usage: node tools/r2_ab.mjs --adapter igpu|dgpu [--mode high] [--secs 3.5] [--reps 3]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "high");
const secs = Number(flag("--secs", 3.5));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_r2ab_${adapter}_${mode}.json`);

const ARMS = ["base", "nopost", "noscene", "smaa", "grade", "bloom", "gtao", "halfres", "freezegraph"];

const { browser, page } = await boot({ adapter });
const results = new Map(ARMS.map((a) => [a, []]));
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  const staged = await stage(page);
  console.log(`[stage] STAGED ${JSON.stringify(staged)}  mode=${mode}`);
  console.log(`[fp] ${await page.evaluate(() => window.__fp())}`);

  for (let r = 0; r < reps; r++) {
    // ROTATE. A fixed arm order charges later arms for whatever drifted.
    const order = ARMS.map((_, i) => ARMS[(i + r) % ARMS.length]);
    for (const arm of order) {
      if (arm !== "base") await page.evaluate((a) => window.__ab(a, true), arm);
      let w;
      try {
        w = await window1(page, { secs });
      } finally {
        if (arm !== "base") await page.evaluate((a) => window.__ab(a, false), arm);
      }
      results.get(arm).push(w);
      const s = w.shape;
      console.log(
        `r${r} ${arm.padEnd(12)} fps=${String(s.fps).padStart(6)} delivered=${String(s.delivered).padStart(6)}ms `
        + `p50=${s.p50} p90=${s.p90} p99=${s.p99} over33=${s.over33}% vis=${w.visible} foreign=${w.foreign}`,
      );
    }
  }
} finally {
  await browser.close();
}

const table = {};
for (const arm of ARMS) table[arm] = pool(results.get(arm));
const baseMs = table.base.delivered;
console.log(`\n=== ${adapter} / ${mode} — pooled over ${reps} rotated reps ===`);
console.log("arm           fps  delivered   delta   p50    p90    p99  over33%");
for (const arm of ARMS) {
  const t = table[arm];
  const d = +(baseMs - t.delivered).toFixed(2);
  console.log(
    `${arm.padEnd(12)} ${String(t.fps).padStart(5)} ${String(t.delivered).padStart(9)} `
    + `${String(d > 0 ? `-${d}` : `+${-d}`).padStart(7)} ${String(t.p50).padStart(5)} `
    + `${String(t.p90).padStart(6)} ${String(t.p99).padStart(6)} ${String(t.over33).padStart(7)}`,
  );
}
writeFileSync(out, JSON.stringify({
  adapter, mode, secs, reps, table,
  windows: Object.fromEntries(ARMS.map((a) => [a, results.get(a).map((w) => ({
    fp: w.fp, visible: w.visible, rigFull: w.rigFull, foreign: w.foreign, shape: w.shape,
  }))])),
}, null, 2));
console.log(`\nwrote ${out}`);
