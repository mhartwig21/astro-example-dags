// Full-run balance sweep: drives the scripted balance bot (src/sim/bot.ts)
// from floor 1 to a win/death across N seeds and reports the aggregate win
// rate + where runs die. Not a test (no assertions) — a measurement tool for
// "how often does a competent bot clear the whole dungeon right now."
//
// Also logs each run's FINAL build (weapon class + ability loadout) and
// correlates it with the outcome. The bot follows one fixed shop ladder and
// always takes the first draft offer, so builds aren't deliberately varied —
// this is passive correlation over the incidental RNG variance (loot rolls,
// which draft options come up first) across seeds, not a controlled A/B.
//
// Usage: npx tsx scripts/balance-sweep.ts [count] [startSeed]
//   DCC_RULE=<dailyRuleId> forces TODAY'S RULE on every run — the pool
//   discipline sweep (sim/dailyRules.ts): a rule enters rotation only if a
//   forced sweep lands inside the same 25-55% band as the base game.
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";
import { DAILY_RULES, type DailyRuleId } from "../src/sim/dailyRules";
import { weaponClassOf, type WeaponClass } from "../src/sim/items";
import { GLYPH_INFO, type GlyphId } from "../src/sim/glyphs";
import type { AbilityId } from "../src/sim/abilities";

const COUNT = Number(process.argv[2] ?? 100);
const START_SEED = Number(process.argv[3] ?? 1);
const MAX_STEPS = 3_000_000; // ~13.9 sim-hours of budget; a full 18-floor clear uses a fraction of this

interface RunSummary {
  seed: number;
  won: boolean;
  died: boolean;
  deathFloor: number | null;
  floorsCleared: number;
  steps: number;
  damageTaken: number;
  kills: number;
  hitStepBudget: boolean;
  weaponClass: WeaponClass | null;
  loadout: AbilityId[]; // final 4 slots + ultimate, whatever was equipped at run end
  glyphs: GlyphId[]; // stones SOCKETED at run end (the bench is not the build)
}

const FORCED_RULE: DailyRuleId | null = (() => {
  const r = process.env.DCC_RULE ?? "";
  if (!r) return null;
  if (!(r in DAILY_RULES)) throw new Error(`unknown DCC_RULE "${r}"`);
  return r as DailyRuleId;
})();
if (FORCED_RULE) console.log(`TODAY'S RULE forced for every run: ${FORCED_RULE}`);

function runOne(seed: number): RunSummary {
  const g = createGame(seed, "coop", "race", FORCED_RULE);
  const r = runBot(g, CONFIG.finalFloor + 2, MAX_STEPS);
  const hitStepBudget = !r.won && !r.died && r.steps >= MAX_STEPS;
  const p = g.players[0];
  const loadout = [...p.abilities.slots, p.abilities.ultimate].filter((a): a is AbilityId => a != null);
  // Only what is SOCKETED counts: a stone on the bench modified nothing.
  const glyphs: GlyphId[] = [];
  if (p.glyphs) {
    for (const arr of [...p.glyphs.slots, p.glyphs.ultimate]) {
      for (const g of arr) if (g) glyphs.push(g);
    }
  }
  return {
    seed,
    won: r.won,
    died: r.died,
    deathFloor: r.died ? g.floor : null,
    floorsCleared: r.floorsCleared,
    steps: r.steps,
    damageTaken: r.totalDamageTaken,
    kills: r.totalKills,
    hitStepBudget,
    weaponClass: weaponClassOf(p.equipment.weapon),
    loadout,
    glyphs,
  };
}

const results: RunSummary[] = [];
const t0 = Date.now();
for (let i = 0; i < COUNT; i++) {
  const seed = START_SEED + i;
  const r = runOne(seed);
  results.push(r);
  const tag = r.won ? "WON" : r.hitStepBudget ? "STUCK" : `died f${r.deathFloor}`;
  process.stdout.write(`  seed ${seed}: ${tag} (${r.floorsCleared} floors, ${r.kills} kills, ${r.steps} steps)\n`);
}
const elapsedS = (Date.now() - t0) / 1000;

const wins = results.filter((r) => r.won).length;
const deaths = results.filter((r) => r.died).length;
const stuck = results.filter((r) => r.hitStepBudget).length;
const winRate = (wins / COUNT) * 100;

const deathFloors = new Map<number, number>();
for (const r of results) {
  if (r.deathFloor != null) deathFloors.set(r.deathFloor, (deathFloors.get(r.deathFloor) ?? 0) + 1);
}

const avgFloorsCleared = results.reduce((s, r) => s + r.floorsCleared, 0) / COUNT;
const avgKills = results.reduce((s, r) => s + r.kills, 0) / COUNT;
const avgDamage = results.reduce((s, r) => s + r.damageTaken, 0) / COUNT;

console.log("\n=== balance sweep ===");
console.log(`runs: ${COUNT} (seeds ${START_SEED}..${START_SEED + COUNT - 1}), ${elapsedS.toFixed(1)}s wall-clock`);
console.log(`win rate: ${wins}/${COUNT} (${winRate.toFixed(1)}%)`);
console.log(`deaths: ${deaths}/${COUNT}  stuck-on-step-budget: ${stuck}/${COUNT}`);
console.log(`avg floors cleared: ${avgFloorsCleared.toFixed(2)} / ${CONFIG.finalFloor}`);
console.log(`avg kills/run: ${avgKills.toFixed(1)}   avg damage taken/run: ${avgDamage.toFixed(0)}`);
console.log("\ndeath floor histogram:");
const floors = [...deathFloors.keys()].sort((a, b) => a - b);
for (const f of floors) {
  const n = deathFloors.get(f)!;
  const bar = "#".repeat(n);
  console.log(`  floor ${String(f).padStart(2)}: ${bar} (${n})`);
}
if (stuck > 0) {
  console.log(`\n${stuck} run(s) hit the step budget without winning or dying — likely a bot pathing wedge, not a real balance signal.`);
  for (const r of results.filter((x) => x.hitStepBudget)) console.log(`  seed ${r.seed}: stalled on floor ${r.floorsCleared + 1}`);
}

// Passive build correlation: NOT a controlled experiment (see header comment)
// — small groups (few seeds landed on a given weapon class) are noise, not signal.
function winRateTable(groups: Map<string, RunSummary[]>): void {
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, runs] of rows) {
    const w = runs.filter((r) => r.won).length;
    const pct = ((w / runs.length) * 100).toFixed(0);
    console.log(`  ${key.padEnd(14)} n=${String(runs.length).padStart(4)}  win rate ${pct.padStart(3)}%`);
  }
}

const byWeapon = new Map<string, RunSummary[]>();
for (const r of results) {
  const key = r.weaponClass ?? "(none)";
  if (!byWeapon.has(key)) byWeapon.set(key, []);
  byWeapon.get(key)!.push(r);
}
console.log("\nwin rate by final weapon class (passive correlation, not a controlled A/B):");
winRateTable(byWeapon);

const byAbility = new Map<string, RunSummary[]>();
for (const r of results) {
  for (const a of r.loadout) {
    if (!byAbility.has(a)) byAbility.set(a, []);
    byAbility.get(a)!.push(r);
  }
}
console.log("\nwin rate by ability present in final loadout (a run counts toward every ability it had equipped):");
winRateTable(byAbility);

// The MODIFIER LAYER, measured the same way. Two failure modes matter here and
// neither shows up in a win rate alone: a stone nobody ever ends a run WEARING
// is dead weight (it never dropped, or the socket policy scored it at or below
// zero everywhere), and a stone that shows up in most deep runs is doing the
// carrying. `n` counts RUNS, not copies — one run wearing two Arc-Splices
// still counts once.
const byGlyph = new Map<string, RunSummary[]>();
for (const r of results) {
  for (const g of new Set(r.glyphs)) {
    const key = GLYPH_INFO[g].name;
    if (!byGlyph.has(key)) byGlyph.set(key, []);
    byGlyph.get(key)!.push(r);
  }
}
console.log("\nglyphs SOCKETED at run end (usage share + how deep those runs got):");
for (const [key, runs] of [...byGlyph.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const share = ((runs.length / COUNT) * 100).toFixed(0);
  const depth = runs.reduce((acc, r) => acc + r.floorsCleared, 0) / runs.length;
  console.log(`  ${key.padEnd(22)} n=${String(runs.length).padStart(4)}  ${share.padStart(3)}% of runs  avg floors ${depth.toFixed(1)}`);
}
const cold = (Object.keys(GLYPH_INFO) as GlyphId[]).filter((g) => !byGlyph.has(GLYPH_INFO[g].name));
console.log(`  never socketed (${cold.length}): ${cold.map((g) => GLYPH_INFO[g].name).join(", ") || "none"}`);
