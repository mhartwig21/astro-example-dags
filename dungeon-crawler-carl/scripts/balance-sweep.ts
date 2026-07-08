// Full-run balance sweep: drives the scripted balance bot (src/sim/bot.ts)
// from floor 1 to a win/death across N seeds and reports the aggregate win
// rate + where runs die. Not a test (no assertions) — a measurement tool for
// "how often does a competent bot clear the whole dungeon right now."
//
// Usage: npx tsx scripts/balance-sweep.ts [count] [startSeed]
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";

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
}

function runOne(seed: number): RunSummary {
  const g = createGame(seed);
  const r = runBot(g, CONFIG.finalFloor + 2, MAX_STEPS);
  const hitStepBudget = !r.won && !r.died && r.steps >= MAX_STEPS;
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
