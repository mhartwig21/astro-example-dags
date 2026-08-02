import { drawBossEncounter, BOSS_MUTATORS } from "../src/sim/bosses";
const floors = [3, 6, 9, 12, 15, 18];
const N = 4000;
const askCount = new Map<string, number>();
const distinct = new Map<number, number>();
const mutTotal = new Map<string, number>();
let slots = 0;
for (let s = 1; s <= N; s++) {
  const asks: string[] = [];
  for (const f of floors) {
    const d = drawBossEncounter(s, f);
    asks.push(d.def.ask);
    askCount.set(d.def.ask, (askCount.get(d.def.ask) ?? 0) + 1);
    slots++;
    for (const m of d.mutators) mutTotal.set(m, (mutTotal.get(m) ?? 0) + 1);
  }
  const k = new Set(asks).size;
  distinct.set(k, (distinct.get(k) ?? 0) + 1);
}
console.log("ASK share across all 6 slots, all seeds:");
for (const [a, c] of [...askCount].sort((x, y) => y[1] - x[1])) {
  console.log(`   ${a.padEnd(8)} ${(100 * c / slots).toFixed(1)}%`);
}
console.log("\ndistinct ASKS a single 6-boss run shows:");
for (const k of [...distinct.keys()].sort()) {
  console.log(`   ${k} of 6 asks: ${(100 * distinct.get(k)! / N).toFixed(1)}%`);
}
const mutSlots = [...mutTotal.values()].reduce((a, b) => a + b, 0);
console.log("\nmutator share of all mutator SLOTS drawn in a run:");
for (const [m, c] of [...mutTotal].sort((x, y) => y[1] - x[1])) {
  const info = BOSS_MUTATORS.find((z) => z.id === m);
  console.log(`   ${m.padEnd(13)} ${(100 * c / mutSlots).toFixed(1)}%  ${info?.changesAsk ? "[ask-changer]" : ""}`);
}
// How often does a run carry SPONSORED on at least one boss?
let anySponsored = 0, sponsoredSlots = 0, mutSlotsPerRun = 0;
for (let s = 1; s <= N; s++) {
  let hit = false;
  for (const f of floors) {
    const d = drawBossEncounter(s, f);
    mutSlotsPerRun += d.mutators.length;
    if (d.mutators.includes("sponsored")) { hit = true; sponsoredSlots++; }
  }
  if (hit) anySponsored++;
}
console.log(`\nruns whose 6-boss lineup contains SPONSORED at least once: ${(100 * anySponsored / N).toFixed(1)}%`);
console.log(`SPONSORED slots per run (of ${(mutSlotsPerRun / N).toFixed(1)} mutator slots): ${(sponsoredSlots / N).toFixed(2)}`);
