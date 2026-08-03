// ACCEPTANCE R2 — the mode ladder, re-measured from scratch on both adapters
// and in both scenes, in ONE page session per adapter.
//
// Usage: node tools/acc2_modes.mjs --adapter igpu|dgpu [--secs 5] [--reps 3]
//
// Every window carries: the LIVE pipeline readout it was taken with (asserted
// against the preset it claims), the canary at both ends, the visible body
// count, and the foreign-browser count. Nothing is discarded silently — the
// canary is reported per window and the pool is given both ungated and gated so
// a reader can see what the gate bought.
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, census, foreignLoad, flag } from "./acc2_lab.mjs";

const adapter = flag("--adapter", "igpu");
const secs = Number(flag("--secs", 5));
const reps = Number(flag("--reps", 3));
const canaryGate = Number(flag("--canary", adapter === "igpu" ? 14 : 5));
const out = flag("--out", `tools/_acc2_${adapter}.json`);
const MODES = ["low", "medium", "high"];
// "fight" is the scene the shipped contract never measured: the dense pack WITH
// the crawler swinging and spending abilities, i.e. combat particles, damage
// numbers and impact lights on top of the bodies. REFERENCE_SCENE describes a
// pack the crawler is "pinned alive" in, which is the pack standing still.
const SCENES = flag("--scenes", "dense,quiet").split(",");

console.log("=== CONTAMINATION, BEFORE THE BROWSER EXISTS ===");
const pre = census();
const load = foreignLoad(4000);
console.log(`foreign browser processes: ${pre.foreign} (own ${pre.own})`);
console.log(`foreign CPU: ${load.pctOfOneCore}% of one core — top: ${(load.top || []).map((t) => `${t.name}:${t.pct}%`).join(" ")}`);

const { browser, page, gpu } = await boot({ adapter });
const guard = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard] program built AFTER boot")) guard.push(t.split("\n")[0].slice(0, 160));
});

const result = { adapter, gpu, secs, reps, canaryGate, preCensus: pre, preLoad: load, scenes: {} };
try {
  await installProbe(page);
  await stage(page);
  const t0 = Date.now();

  for (const scene of SCENES) {
    if (scene === "quiet") {
      await page.evaluate(() => window.__toQuiet());
      await page.waitForTimeout(2500);
    }
    const runs = new Map(MODES.map((m) => [m, []]));
    console.log(`\n--- ${adapter} / ${scene} ---`);
    for (let r = 0; r < reps; r++) {
      const order = MODES.map((_, i) => MODES[(i + r) % MODES.length]);
      for (const mode of order) {
        await page.evaluate((m) => window.__setMode(m), mode);
        await page.waitForTimeout(900);
        const c0 = await page.evaluate((ms) => window.__canary(ms), 800);
        let w;
        // COMBAT IS DRIVEN WITH AS LITTLE CDP TRAFFIC AS POSSIBLE: the mouse is
        // held down for the whole window (one message at each end) and the
        // ability keys are tapped a handful of times. Per-frame driving would
        // be measuring the harness.
        const fighting = scene === "fight";
        try {
          if (fighting) {
            await page.evaluate(() => window.__toPack());
            await page.waitForTimeout(1400);
            await page.mouse.move(760, 380);
            await page.mouse.down();
          }
          const spam = fighting
            ? (async () => {
              for (let i = 0; i < secs * 2; i++) {
                await page.keyboard.press(String((i % 4) + 1));
                await page.waitForTimeout(480);
              }
            })()
            : null;
          w = await window1(page, { secs, mode, restage: scene === "dense" });
          if (spam) await spam.catch(() => {});
        } catch (e) {
          console.log(`!! ${mode} r${r}: ${e.message}`);
          if (fighting) await page.mouse.up().catch(() => {});
          continue;
        }
        if (fighting) await page.mouse.up();
        if (scene === "quiet") {
          // Keep the crawler out of the pack: the keep-alive can re-aggro.
          await page.evaluate(() => window.__toQuiet());
        }
        const c1 = await page.evaluate((ms) => window.__canary(ms), 800);
        w.canary = [c0, c1];
        w.foreign = census().foreign;
        runs.get(mode).push(w);
        const s = w.shape;
        console.log(
          `r${r} ${mode.padEnd(6)} ${String(s.fps).padStart(6)}fps del=${String(s.delivered).padStart(6)} `
          + `p50=${String(s.p50).padStart(5)} p90=${String(s.p90).padStart(6)} p99=${String(s.p99).padStart(7)} `
          + `>16.7=${String(s.over16).padStart(5)}% >33=${String(s.over33).padStart(5)}% `
          + `vis=${w.visible}->${w.visibleEnd} rigFull=${w.rigFull} px=${w.live.pixelRatio} buf=${w.live.bufW}x${w.live.bufH} `
          + `sm=${w.live.shadowMap} ao=${w.live.aoW}x${w.live.aoH} canary=${c0}/${c1} foreign=${w.foreign}`,
        );
      }
    }
    const table = {}, gated = {};
    console.log(`\n== ${adapter} / ${scene}: pooled over ${reps} rotated reps ==`);
    console.log("mode     fps  delivered   p50    p90     p99   >16.7%  >33.3%   mean   windows");
    for (const m of MODES) {
      const ws = runs.get(m);
      if (!ws.length) { console.log(`${m}: NOTHING MEASURED`); continue; }
      const p = pool(ws);
      table[m] = { ...p, windows: ws.length, live: ws[0].live, visible: ws.map((w) => w.visible), canary: ws.map((w) => w.canary) };
      const q = ws.filter((w) => Math.max(...w.canary) <= canaryGate);
      gated[m] = q.length ? { ...pool(q), windows: q.length } : null;
      console.log(
        `${m.padEnd(7)} ${String(p.fps).padStart(6)} ${String(p.delivered).padStart(10)} `
        + `${String(p.p50).padStart(5)} ${String(p.p90).padStart(6)} ${String(p.p99).padStart(7)} `
        + `${String(p.over16).padStart(7)} ${String(p.over33).padStart(7)} ${String(p.mean).padStart(6)}   ${ws.length}`,
      );
    }
    console.log("(canary-gated subset)");
    for (const m of MODES) {
      const g = gated[m];
      if (!g) { console.log(`${m.padEnd(7)} no window passed the canary gate`); continue; }
      console.log(
        `${m.padEnd(7)} ${String(g.fps).padStart(6)} ${String(g.delivered).padStart(10)} `
        + `${String(g.p50).padStart(5)} ${String(g.p90).padStart(6)} ${String(g.p99).padStart(7)} `
        + `${String(g.over16).padStart(7)} ${String(g.over33).padStart(7)} ${String(g.mean).padStart(6)}   ${g.windows}`,
      );
    }
    result.scenes[scene] = {
      table, gated,
      windows: Object.fromEntries(MODES.map((m) => [m, runs.get(m).map((w) => ({
        shape: w.shape, live: w.live, visible: w.visible, visibleEnd: w.visibleEnd,
        rigFull: w.rigFull, canary: w.canary, foreign: w.foreign, nodes: w.nodes,
        deltas: w.deltas.map((d) => +d.toFixed(2)), wallMs: +w.wallMs.toFixed(1),
      }))])),
    };
  }

  const mins = (Date.now() - t0) / 60000;
  result.minutes = +mins.toFixed(1);
  result.guardFired = guard.length;
  result.guardPerMin = +(guard.length / Math.max(0.01, mins)).toFixed(2);
  result.postCensus = census();
  console.log(`\n[shader-guard] ${guard.length} synchronous program builds in ${mins.toFixed(1)} min (${result.guardPerMin}/min)`);
  for (const g of guard.slice(0, 12)) console.log(`  ${g}`);
  console.log(`foreign browsers after: ${result.postCensus.foreign}`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
