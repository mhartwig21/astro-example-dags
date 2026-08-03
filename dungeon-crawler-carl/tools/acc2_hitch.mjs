// WHAT DOES A MODE SWITCH COST, AGAINST A CONTROL THAT SWITCHES NOTHING.
//
// The switch probe measured 208-960 ms worst frames in the 900 ms after each
// setQuality() while building ZERO shader programs. That is only a finding if
// an identically-staged 900 ms window with NO switch in it is quiet, so this
// runs the two arms interleaved in one session, same staging, same cadence.
//
// It matters beyond the settings row: in AUTO the runtime tuner calls the same
// applyQuality() path, on a machine it has just judged too slow.
//
// Usage: node tools/acc2_hitch.mjs --adapter igpu|dgpu [--reps 6]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, census, pct, flag } from "./acc2_lab.mjs";

const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 6));
const out = flag("--out", `tools/_acc2hitch_${adapter}.json`);

const { browser, page } = await boot({ adapter, quality: "medium" });
try {
  await installProbe(page);
  await page.evaluate(() => {
    const T = [];
    let last = performance.now();
    const tick = () => { const n = performance.now(); T.push([n, n - last]); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__now = () => performance.now();
    window.__since = (t0) => {
      const w = T.filter((r) => r[0] >= t0).map((r) => r[1]);
      return { n: w.length, max: +Math.max(0, ...w).toFixed(1) };
    };
    window.__progCount = () => window.__dcc.renderer.renderer.info.programs.length;
  });
  await stage(page);

  const MODES = ["low", "medium", "high"];
  const arms = { switch: [], control: [] };
  console.log(`\narm       to        worst frame in the next 900 ms (programs built)`);
  for (let r = 0; r < reps; r++) {
    for (const arm of ["switch", "control"]) {
      const to = MODES[(r + (arm === "switch" ? 0 : 1)) % 3];
      await page.evaluate(() => window.__toPack());
      await page.waitForTimeout(1500);
      const pb = await page.evaluate(() => window.__progCount());
      const mark = await page.evaluate(() => window.__now());
      if (arm === "switch") await page.evaluate((m) => window.__setMode(m), to);
      await page.waitForTimeout(900);
      const w = await page.evaluate((t) => window.__since(t), mark);
      const pa = await page.evaluate(() => window.__progCount());
      arms[arm].push(w.max);
      console.log(`${arm.padEnd(9)} ${(arm === "switch" ? to : "-").padEnd(9)} ${String(w.max).padStart(8)} ms  (+${pa - pb})  frames=${w.n}`);
    }
  }
  const sum = (a) => ({ median: pct(a, 0.5), max: Math.max(...a), min: Math.min(...a), n: a.length });
  const res = { adapter, switch: sum(arms.switch), control: sum(arms.control), raw: arms, census: census() };
  console.log(`\nSWITCH  worst-frame median ${res.switch.median} ms  range ${res.switch.min}..${res.switch.max}`);
  console.log(`CONTROL worst-frame median ${res.control.median} ms  range ${res.control.min}..${res.control.max}`);
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
