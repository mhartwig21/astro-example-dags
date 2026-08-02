
// ABILITIES-V2 §1.0c/d, re-run honestly.
//
// The tables §1.0c and §1.0d originally shipped were n=8 and driven by a
// GREEDY bot that pressed every slot on cooldown -- which is exactly the
// instrument §1.0e condemns: a bot firing Collapse into a median of zero
// targets cannot be trusted to condemn Collapse. §7 slice 1 pre-committed to
// replacing them with an n>=30 re-run under the POLICY bot before any ability
// change was defended, and pre-registered the outcomes:
//
//   * "no 4th slot separates from noise" is a claim about SPREAD, so this
//     reports the 10th and 90th percentile beside every mean. A column whose
//     p10..p90 band overlaps the empty slot's band has not moved anything.
//   * "if Collapse stops being a trap once a competent policy stops wasting
//     it, R1 shrinks from a rework to a base-gather change and this document
//     will say so in writing."
//
// This is a MEASUREMENT tool, not a test: no assertions, and it prints the
// markdown the design document quotes.
//
// Usage: npx tsx scripts/kit-sweep.ts [seeds] [startSeed]

import { createTestGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";
import type { AbilityId } from "../src/sim/abilities";

const SEEDS = Number(process.argv[2] ?? 30);
const START = Number(process.argv[3] ?? 4200);
const FLOOR = 8;
const LEVEL = 13;
const MAX_STEPS = 18_000; // ~5 sim-minutes; longer than any floor-8 budget

interface Row {
  cleared: number;
  died: number;
  seconds: number[];
  damage: number[];
  kills: number[];
}

/** 10th/90th percentile by nearest rank (n>=30, so no interpolation games). */
function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const band = (xs: number[]): string => `${mean(xs).toFixed(0)} [${pct(xs, 0.1).toFixed(0)}–${pct(xs, 0.9).toFixed(0)}]`;

/** One floor-8 fixture with `extra` in the 4th slot and `ult` as the ultimate. */
function run(seed: number, extra: AbilityId | null, ult: AbilityId | null): void {
  const learn: AbilityId[] = ["dash", "bolt"];
  if (extra) learn.push(extra);
  if (ult) learn.push(ult);
  const g = createTestGame({ seed, floor: FLOOR, level: LEVEL, abilities: learn });
  const p = g.players[0];
  const before = { dmg: p.damageTaken, kills: p.kills, elapsed: g.elapsed };
  const r = runBot(g, 1, MAX_STEPS);
  const row = rows.get(key)!;

  if (r.died) row.died++;
  // Clear time is only defined for a CLEAR. The first draft's table averaged
  // deaths into it, which made a column that died at 11s look fast.
  if (r.floorsCleared > 0) { row.cleared++; row.seconds.push(g.elapsed - before.elapsed); }
  row.damage.push(p.damageTaken - before.dmg);
  row.kills.push(p.kills - before.kills);
}

const rows = new Map<string, Row>();
let key = "";
function column(name: string, extra: AbilityId | null, ult: AbilityId | null): void {
  key = name;
  rows.set(name, { cleared: 0, died: 0, seconds: [], damage: [], kills: [] });
  for (let i = 0; i < SEEDS; i++) run(START + i, extra, ult);
}

// ---- §1.0c: only the 4th slot changes (no ultimate, so the slot is alone) ----
const FOURTH: [string, AbilityId | null][] = [
  ["*(empty)*", null],
  ["Collapse (nova)", "nova"],
  ["orbit", "orbit"],
  ["stance", "stance"],
  ["Breaker (overcharge)", "overcharge"],
  ["Blindside (cutto)", "cutto"],
  ["Extradition (crowdsurf)", "crowdsurf"],
  ["Stunt Double", "stuntdouble"],
  ["Bulwark", "bulwark"],
  ["Stage Cables", "cables"],
];
for (const [name, id] of FOURTH) column(name, id, null);

console.log(`\n### 1.0c — the 4th slot (policy bot, floor ${FLOOR} lvl ${LEVEL}, n=${SEEDS}, mean [p10–p90])\n`);
console.log("| 4th slot | cleared | died | clear s | dmg taken | kills |");
console.log("|---|---|---|---|---|---|");
for (const [name] of FOURTH) {
  const r = rows.get(name)!;
  console.log(`| ${name} | ${r.cleared}/${SEEDS} | ${r.died} | ${band(r.seconds)} | ${band(r.damage)} | ${band(r.kills)} |`);
}

// ---- §1.0d: only the ultimate changes (4th slot held at Collapse) ----
rows.clear();
const ULTS: [string, AbilityId | null][] = [
  ["*(none)*", null],
  ["Sponsor Barrage (airstrike)", "airstrike"],
  ["Fault Line (cataclysm)", "cataclysm"],
  ["Bullet Time", "bullettime"],
  ["Injunction", "injunction"],
];
for (const [name, id] of ULTS) column(name, "nova", id);


console.log(`\n### 1.0d — the ultimate (same fixture, 4th slot = Collapse, n=${SEEDS})\n`);
console.log("| ultimate | cleared | died | clear s | dmg taken | kills |");
console.log("|---|---|---|---|---|---|");
for (const [name] of ULTS) {
  const r = rows.get(name)!;
  console.log(`| ${name} | ${r.cleared}/${SEEDS} | ${r.died} | ${band(r.seconds)} | ${band(r.damage)} | ${band(r.kills)} |`);
}

// ---- The ABLATION: the pre-registered branch, actually tested ----
//
// §7 slice 1 pre-registered "if Nova stops being a trap once a competent
// policy stops wasting it, R1 shrinks from a rework to a base-gather change."
// That branch cannot be tested by re-running the shipped build, because R1
// already landed -- the shipped Nova is gone. So ABLATE the thing R1 added:
// §3.1 states the buff over shipped Nova is "entirely in N, not in per-target
// damage", so a Collapse with novaGatherMult = 0 is behaviourally the old
// Nova (blast only, no drag) under the new policy bot. Three columns, same
// seeds: no 4th slot at all, Collapse, and Collapse with the gather removed.
rows.clear();
const gatherMult = CONFIG.novaGatherMult;
column("*(empty)*", null, null);
column("Collapse (gather ON)", "nova", null);
CONFIG.novaGatherMult = 0; // ablation: the blast without the drag = shipped Nova
column("Collapse (gather OFF = shipped Nova)", "nova", null);
CONFIG.novaGatherMult = gatherMult;

console.log(`\n### 1.0c-ablation — is the GATHER the fix, or was the policy? (n=${SEEDS})\n`);
console.log("| 4th slot | cleared | died | clear s | dmg taken | kills |");
console.log("|---|---|---|---|---|---|");
for (const name of ["*(empty)*", "Collapse (gather ON)", "Collapse (gather OFF = shipped Nova)"]) {
  const r = rows.get(name)!;
  console.log(`| ${name} | ${r.cleared}/${SEEDS} | ${r.died} | ${band(r.seconds)} | ${band(r.damage)} | ${band(r.kills)} |`);
}
