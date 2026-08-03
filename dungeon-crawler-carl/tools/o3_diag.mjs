// OPT-R3 DIAGNOSIS — one session, four questions, in the scene the game is played in.
//
//  Q1  Is the new GPU canary actually independent of scene load? (The old one
//      was not, and that bias is blocker 7.) Read it parked, mid-fight, at each
//      mode, and print the spread.
//  Q2  What does each mode DELIVER in the FIGHT scene, split into host CPU
//      (renderer.update) and submission+post (renderer.render)?
//  Q3  Which layer is the frame? Sandwiched A/B in the fight scene, both the
//      CPU arm (skip the host update entirely) and the GPU arms.
//  Q4  How much does a quality-mode CHANGE cost, and is it shader builds?
//
// Usage: node tools/o3_diag.mjs --adapter igpu|dgpu [--secs 5] [--reps 2]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, sandwich, flag, has, BUDGET } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const secs = Number(flag("--secs", 5));
const reps = Number(flag("--reps", 2));
const out = flag("--out", `tools/_o3diag_${adapter}.json`);
const MODES = ["low", "medium", "high"];

const { browser, page } = await boot({ adapter });
const guard = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard]")) guard.push({ at: Date.now(), text: t.split("\n")[0].slice(0, 200) });
});

const R = { adapter, canary: {}, modes: {}, ab: null, modeSwitch: [], guard };
try {
  await installProbe(page);
  await stage(page);

  // ---- Q1: is the canary a GPU probe? --------------------------------------
  const canaryAt = async (label, fn) => {
    if (fn) await fn();
    const reads = [];
    for (let i = 0; i < 4; i++) reads.push(await page.evaluate(() => window.__gpucanary()));
    R.canary[label] = reads;
    console.log(`[canary] ${label.padEnd(18)} ${reads.join(" / ")} ms`);
    return Math.min(...reads);
  };
  await canaryAt("parked-quiet", async () => { await page.evaluate(() => window.__toQuiet()); await page.waitForTimeout(1500); });
  await canaryAt("dense-pinned", async () => { await page.evaluate(() => window.__toPack()); await page.waitForTimeout(1500); });
  for (const m of MODES) {
    await canaryAt(`dense-${m}`, async () => { await page.evaluate((x) => window.__setMode(x), m); await page.waitForTimeout(900); });
  }
  await page.evaluate(() => window.__setMode("high"));

  // ---- Q2: the ladder, in the fight scene ----------------------------------
  const runs = new Map(MODES.map((m) => [m, []]));
  for (let r = 0; r < reps; r++) {
    const order = MODES.map((_, i) => MODES[(i + r) % MODES.length]);
    for (const mode of order) {
      const c0 = await page.evaluate(() => window.__gpucanary());
      await page.evaluate((m) => window.__setMode(m), mode);
      await page.waitForTimeout(700);
      const w = await window1(page, { secs, scene: "fight", budgetMs: BUDGET[mode] });
      w.canary = c0;
      runs.get(mode).push(w);
      const s = w.shape;
      console.log(
        `r${r} ${mode.padEnd(7)} ${String(s.fps).padStart(6)} fps  delivered=${String(s.delivered).padStart(6)}ms  `
        + `p50=${String(s.p50).padStart(5)} p90=${String(s.p90).padStart(6)} p99=${String(s.p99).padStart(7)}  `
        + `>33=${String(s.over33).padStart(5)}% >budget=${String(s.overBudget).padStart(5)}%  `
        + `upd=${String(w.updateMs).padStart(6)} ren=${String(w.renderMs).padStart(6)}  `
        + `vis=${w.visible}->${w.visibleEnd} calls=${w.calls} canary=${c0} foreign=${w.foreign}`,
      );
    }
  }
  console.log("\n=== FIGHT SCENE LADDER (pooled) ===");
  for (const m of MODES) {
    const ws = runs.get(m);
    if (!ws.length) continue;
    const p = pool(ws, BUDGET[m]);
    const upd = +(ws.reduce((a, w) => a + w.updateMs, 0) / ws.length).toFixed(2);
    const ren = +(ws.reduce((a, w) => a + w.renderMs, 0) / ws.length).toFixed(2);
    R.modes[m] = { ...p, updateMs: upd, renderMs: ren, windows: ws.length,
      visible: +(ws.reduce((a, w) => a + w.visible, 0) / ws.length).toFixed(1) };
    console.log(
      `${m.padEnd(7)} ${String(p.fps).padStart(6)} fps  delivered=${String(p.delivered).padStart(6)}ms  `
      + `p50=${p.p50} p90=${p.p90} p99=${p.p99}  >33=${p.over33}% >budget=${p.overBudget}%  upd=${upd} ren=${ren}`,
    );
  }

  // ---- Q3: which layer ------------------------------------------------------
  if (!has("--noab")) {
    await page.evaluate(() => window.__setMode("medium"));
    await page.waitForTimeout(600);
    const arms = ["noupdate", "nopost", "gtao", "smaa", "halfres", "freezegraph", "noscene"];
    R.ab = await sandwich(page, arms, {
      secs: Math.max(3, secs - 1), reps, scene: "fight", label: `where the fight frame goes (${adapter}, MEDIUM)`,
      apply: async (pg, arm) => {
        if (arm) await pg.evaluate((a) => window.__ab(a, true), arm);
        else for (const a of arms) await pg.evaluate((x) => window.__ab(x, false), a);
      },
    });
  }

  // ---- Q4: what a mode change costs ----------------------------------------
  console.log("\n=== MODE-CHANGE COST ===");
  for (let i = 0; i < 6; i++) {
    const to = MODES[i % MODES.length];
    const r = await page.evaluate(async (m) => {
      const r3d = window.__dcc.renderer;
      const p0 = r3d.renderer.info.programs.length;
      // Wait a fresh frame so the sample is not sitting on a queued one.
      await new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d)));
      const t0 = performance.now();
      r3d.setQuality(m);
      const applied = performance.now() - t0;
      const frames = [];
      let last = performance.now();
      await new Promise((done) => {
        let n = 0;
        const tick = () => {
          const now = performance.now();
          frames.push(now - last); last = now;
          if (++n >= 8) { done(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { applied: +applied.toFixed(1), frames: frames.map((f) => +f.toFixed(1)), progs: r3d.renderer.info.programs.length - p0 };
    }, to);
    R.modeSwitch.push({ to, ...r });
    console.log(`-> ${to.padEnd(7)} applyQuality=${String(r.applied).padStart(7)}ms  next frames ${r.frames.join(", ")}  newPrograms=${r.progs}`);
    await page.waitForTimeout(1500);
  }
} finally {
  writeFileSync(out, JSON.stringify(R, null, 2));
  console.log(`\nwrote ${out}   [shader-guard] fires: ${guard.length}`);
  for (const g of guard.slice(0, 12)) console.log("  ", g.text);
  await browser.close();
}
