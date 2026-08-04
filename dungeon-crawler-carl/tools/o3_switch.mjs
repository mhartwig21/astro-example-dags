// OPT-R3 — WHAT A QUALITY-MODE CHANGE COSTS, against a same-staging control.
//
// applyQuality's doc comment says "Everything touched here is reallocation of
// buffers or a pass toggle — deliberately NOT anything that changes a
// material's program". The first half of that sentence is the problem, not the
// reassurance: reallocating the composer's two HalfFloat targets, their depth
// textures, the GTAO buffers, the bloom mip chain, the SMAA targets and the
// shadow map is tens of megabytes of GPU allocation, and the driver does it on
// the frame that first binds them.
//
// So: sample the frames after a real setQuality() against the frames after a
// CONTROL that stages the identical work minus the reallocation, and count
// programs built across the switch to separate allocation from compilation.
//
// Usage: node tools/o3_switch.mjs --adapter igpu|dgpu [--n 8]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const n = Number(flag("--n", 8));
const out = flag("--out", `tools/_o3switch_${adapter}.json`);
const MODES = ["low", "medium", "high"];

const { browser, page } = await boot({ adapter });
const R = { adapter, switches: [], controls: [] };
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate(() => {
    window.__probeFrames = async (act, k) => {
      const r3d = window.__dcc.renderer;
      const p0 = r3d.renderer.info.programs.length;
      await new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d)));
      const t0 = performance.now();
      act();
      const applied = performance.now() - t0;
      const frames = [];
      let last = performance.now();
      await new Promise((done) => {
        let i = 0;
        const tick = () => {
          const now = performance.now();
          frames.push(+(now - last).toFixed(1)); last = now;
          if (++i >= k) { done(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { applied: +applied.toFixed(1), frames, progs: r3d.renderer.info.programs.length - p0 };
    };
  });

  for (let i = 0; i < n; i++) {
    const to = MODES[i % MODES.length];
    // CONTROL: identical staging, identical settle, no reallocation. What a
    // frame costs at this moment for reasons that are not the mode change.
    const ctl = await page.evaluate(() => window.__probeFrames(() => {}, 10));
    R.controls.push(ctl);
    await page.waitForTimeout(1200);
    const sw = await page.evaluate(async (m) => window.__probeFrames(() => window.__dcc.renderer.setQuality(m), 10), to);
    R.switches.push({ to, ...sw });
    console.log(
      `-> ${to.padEnd(7)} applyQuality=${String(sw.applied).padStart(6)}ms  worst=${Math.max(...sw.frames)}  `
      + `frames ${sw.frames.join(",")}  newPrograms=${sw.progs}   [control worst=${Math.max(...ctl.frames)}]`,
    );
    await page.waitForTimeout(1500);
  }
  const worst = (a) => a.map((x) => Math.max(...x.frames)).sort((p, q) => p - q);
  const sw = worst(R.switches), ct = worst(R.controls);
  const med = (a) => a[Math.floor(a.length / 2)];
  R.summary = {
    switchWorstMs: sw, controlWorstMs: ct,
    switchMedian: med(sw), controlMedian: med(ct),
    programsBuilt: R.switches.reduce((a, x) => a + x.progs, 0),
  };
  console.log(`\nworst frame after a mode change: median ${med(sw)} ms (${sw[0]}-${sw[sw.length - 1]})`);
  console.log(`worst frame after the control:    median ${med(ct)} ms (${ct[0]}-${ct[ct.length - 1]})`);
  console.log(`programs built across all ${n} switches: ${R.summary.programsBuilt}`);
} finally {
  writeFileSync(out, JSON.stringify(R, null, 2));
  console.log(`wrote ${out}`);
  await browser.close();
}
