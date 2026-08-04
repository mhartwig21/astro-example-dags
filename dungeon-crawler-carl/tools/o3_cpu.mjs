// OPT-R3 — WHERE THE MAIN THREAD GOES IN A FIGHT.
//
// The resolution sweep (tools/o3_lowfit.mjs) is why this exists: at LOW the GPU
// clock halved from 15.1 ms to 7.1 ms across the sweep and DELIVERED time did
// not move (15.19 ms at full scale, 14.96 ms at half). A frame whose GPU cost
// you can halve for free is not a GPU-bound frame — so LOW is bound by the main
// thread, and no lever in quality.ts spends the main thread.
//
// V8 sampling profiler over the same fight window the ladder is measured in,
// bucketed by SELF time.
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, fightStart, fightStop, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "low");
const secs = Number(flag("--seconds", 12));
const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.evaluate(() => window.__toPack());
  await page.waitForTimeout(1200);
  await fightStart(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 120 });
  await cdp.send("Profiler.start");
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(secs * 1000);
  const w = await page.evaluate(() => window.__winEnd());
  const { profile } = await cdp.send("Profiler.stop");
  await fightStop(page);

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  let total = 0;
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, timeDeltas[i] ?? 0);
    const id = samples[i > 0 ? i - 1 : 0];
    selfUs.set(id, (selfUs.get(id) ?? 0) + d);
    total += d;
  }
  const flat = new Map();
  for (const [id, us] of selfUs) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame;
    const k = `${cf.functionName || "(anon)"} @ ${(cf.url || "-").split("/").pop()}:${cf.lineNumber + 1}`;
    flat.set(k, (flat.get(k) ?? 0) + us);
  }
  const rows = [...flat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const frames = w.deltas.length;
  console.log(`\nmode=${mode} frames=${frames} delivered=${(w.wallMs / frames).toFixed(2)}ms `
    + `rendererUpdate=${w.updateMs}ms rendererRender=${w.renderMs}ms GPU(median)=${w.gpuMs}ms`);
  console.log(`profile total ${(total / 1000).toFixed(0)} ms over ${frames} frames = ${(total / 1000 / frames).toFixed(2)} ms/frame\n`);
  console.log("  ms/frame   %  function");
  for (const [k, us] of rows) {
    console.log(`  ${(us / 1000 / frames).toFixed(3).padStart(8)}  ${((100 * us) / total).toFixed(1).padStart(4)}  ${k}`);
  }
  writeFileSync(`tools/_o3cpu_${adapter}_${mode}.json`, JSON.stringify({ mode, adapter, window: { ...w, deltas: undefined }, rows }, null, 2));
} finally {
  await browser.close();
}
