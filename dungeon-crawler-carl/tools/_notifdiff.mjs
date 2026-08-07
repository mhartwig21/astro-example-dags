#!/usr/bin/env node
/**
 * tools/_notifdiff.mjs — the NOTIFICATION half of the mix round, before vs
 * after, off tools/_mixbrowser.mjs's raw.json dumps. Read-only.
 *
 * Why this exists and _mixbstat.mjs is not enough: _mixbstat counts every
 * overlay element the same. The climax lock's whole claim is that the lines
 * left on the glass during a boss fight are the FIGHT'S OWN — so the number
 * that matters is "boss bar up AND an UNRELATED line on screen", which needs
 * the per-node kinds reconstructed against the per-frame samples. It also
 * separates the "+N more" OVERFLOW CHIP from real lines: the chip is one
 * fixed slot that replaces a growing column, and counting it as a notification
 * would flatter the rate while hiding the cap.
 *
 * Usage: node tools/_notifdiff.mjs BEFORE_DIR AFTER_DIR
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [BEFORE, AFTER] = process.argv.slice(2);
const load = (d) => JSON.parse(readFileSync(join(d, "raw.json"), "utf8"));
const A = load(BEFORE), B = load(AFTER);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");

/** Is this DOM node a real line, or the overflow chip / a boss-fight line? */
const isChip = (n) => n.kind === "more" || /toast-more/.test(n.cls || "");
const isFightLine = (n) => n.kind === "boss";

function stats(r) {
  if (!r || !r.frames || !r.nodes) return null;
  const f = r.frames;
  const sim = f[f.length - 1].e - f[0].e;
  const wall = (f[f.length - 1].t - f[0].t) / 1000;
  const lines = r.nodes.filter((n) => n.zone !== "feed" && !isChip(n));
  const chips = r.nodes.filter((n) => n.zone !== "feed" && isChip(n));
  // Reconstruct, per frame, how many UNRELATED lines were live.
  const liveAt = (t, pred) => {
    let n = 0;
    for (const l of lines) if (l.add <= t && (l.rm === null || l.rm > t) && pred(l)) n++;
    return n;
  };
  const bossF = f.filter((x) => x.boss);
  const deadF = f.filter((x) => x.dead);
  const unrelatedOverBoss = bossF.filter((x) => liveAt(x.t, (l) => !isFightLine(l)) >= 1).length;
  // ...and the same count with the HEADLINE BANNER zone excluded. #headline is
  // the System's one-at-a-time exclusive zone and it already steps down out of
  // the plate's pixels (body.bossplate #headline). AAA-AUDIT #7's own next
  // action names "normal-priority toasts/achievements" — a high-priority
  // headline is not what buried the fight. This row is the toast/card wall.
  const chatterOverBoss = bossF.filter((x) =>
    liveAt(x.t, (l) => !isFightLine(l) && l.zone !== "banner") >= 1).length;
  const threeOverBoss = bossF.filter((x) => x.toasts + x.banners + x.cards >= 3).length;
  const unrelatedOverDeath = deadF.filter((x) => liveAt(x.t, () => true) >= 1).length;
  const stack = f.map((x) => x.toasts + x.banners + x.cards);
  // Repetition: the biggest single shape in the toast channel.
  const shape = (t) => t.toLowerCase().replace(/\d[\d,.]*/g, "#").replace(/\s+/g, " ").trim();
  const byShape = {};
  for (const l of lines) if (l.zone === "toast") byShape[shape(l.text)] = (byShape[shape(l.text)] || 0) + 1;
  const worst = Object.entries(byShape).sort((a, b) => b[1] - a[1])[0] || ["-", 0];
  const toastLines = lines.filter((l) => l.zone === "toast").length;
  return {
    sim, wall,
    linesPerSimMin: +((lines.length / sim) * 60).toFixed(1),
    toastPerSimMin: +((toastLines / sim) * 60).toFixed(1),
    chipEvents: chips.length,
    maxStack: Math.max(...stack),
    occ3: pct(f.filter((x) => x.toasts + x.banners + x.cards >= 3).length, f.length),
    bossFrames: bossF.length,
    bossWithUnrelated: pct(unrelatedOverBoss, bossF.length),
    bossWithChatter: pct(chatterOverBoss, bossF.length),
    bossWith3plus: pct(threeOverBoss, bossF.length),
    deadFrames: deadF.length,
    deadWithAnyLine: pct(unrelatedOverDeath, deadF.length),
    worstShape: `${worst[1]}x "${worst[0].slice(0, 46)}"`,
    worstShapeShare: pct(worst[1], toastLines),
  };
}

const KEYS = ["f03_pack", "f13_pack", "f15_pack", "f17_pack", "f15_elite", "f15_boss",
  "climax_boss", "climax_death"];
const ROWS = ["linesPerSimMin", "toastPerSimMin", "maxStack", "occ3",
  "bossWithUnrelated", "bossWithChatter", "bossWith3plus", "deadWithAnyLine", "worstShape", "worstShapeShare"];

for (const k of KEYS) {
  const a = stats(A[k]), b = stats(B[k]);
  if (!a && !b) continue;
  console.log(`\n=== ${k}`);
  if (a) console.log(`    (sim ${a.sim.toFixed(1)}s before / ${b ? b.sim.toFixed(1) : "?"}s after)`);
  for (const row of ROWS) {
    const av = a ? a[row] : "-", bv = b ? b[row] : "-";
    if (av === "-" && bv === "-") continue;
    console.log(`  ${row.padEnd(20)} ${String(av).padEnd(52)} ->  ${bv}`);
  }
  if (b) console.log(`  ${"overflowChipEvents".padEnd(20)} ${String(a ? a.chipEvents : "-").padEnd(52)} ->  ${b.chipEvents}`);
}
