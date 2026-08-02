// How much variety does the DRAW actually deliver across runs?
import { CONFIG } from "../src/sim/config";
import { drawBossEncounter, bandForBossFloor, BOSS_MUTATORS } from "../src/sim/bosses";

const floors = [3, 6, 9, 12, 15, 18];
const N = Number(process.argv[2] ?? 500);

console.log("floor | distinct boss | distinct (boss+muts+arena) | theoretical | top combo share");
for (const f of floors) {
  const bosses = new Map<string, number>();
  const combos = new Map<string, number>();
  const muts = new Map<string, number>();
  for (let seed = 1; seed <= N; seed++) {
    const d = drawBossEncounter(seed, f);
    bosses.set(d.def.id, (bosses.get(d.def.id) ?? 0) + 1);
    const key = `${d.def.id}|${[...d.mutators].sort().join("+")}|${d.arena}`;
    combos.set(key, (combos.get(key) ?? 0) + 1);
    for (const m of d.mutators) muts.set(m, (muts.get(m) ?? 0) + 1);
  }
  let theo = 0;
  for (const [id] of bosses) {
    // rough: bosses x legal mutator combos x legal arenas
    theo++;
  }
  const top = [...combos.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(
    `${String(f).padStart(5)} | ${String(bosses.size).padStart(13)} | ${String(combos.size).padStart(26)} |` +
    ` ${String(theo).padStart(11)} | ${top[0]} ${(100 * top[1] / N).toFixed(0)}%`);
  console.log(`        combos: ${[...combos.keys()].sort().join("  ;  ")}`);
  console.log(`        mutators seen: ${[...muts.entries()].map(([k, v]) => `${k}:${(100 * v / N).toFixed(0)}%`).join(", ")}`);
}

// Whole-run signature: how likely are two runs to share the entire 6-floor lineup?
const runs = new Map<string, number>();
for (let seed = 1; seed <= N; seed++) {
  runs.set(floors.map((f) => drawBossEncounter(seed, f).def.id).join(">"),
    (runs.get(floors.map((f) => drawBossEncounter(seed, f).def.id).join(">")) ?? 0) + 1);
}
console.log(`\ndistinct full 6-boss lineups over ${N} seeds: ${runs.size} (max 729)`);

// A short session is 1-3 floors. What does a player who only ever plays the
// first boss floor actually see?
const first = new Map<string, number>();
for (let seed = 1; seed <= N; seed++) {
  const d = drawBossEncounter(seed, 3);
  first.set(`${d.def.id}|${d.arena}`, (first.get(`${d.def.id}|${d.arena}`) ?? 0) + 1);
}
console.log(`floor-3 (the boss most players see most): ${first.size} distinct encounters`);
for (const [k, v] of [...first.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k}  ${(100 * v / N).toFixed(1)}%`);
}
console.log(`\nmutators declared: ${BOSS_MUTATORS.length}, gate floor ${CONFIG.bossMutatorFromFloor}, second from ${CONFIG.bossMutatorSecondFromFloor}`);
void bandForBossFloor;
