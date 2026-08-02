import { BOSS_POOL, pickBandBoss, rollBossMutators, pickArenaVariant } from "../src/sim/bosses";
for (const d of BOSS_POOL[1]) {
  const m = new Map<string, number>(); let n = 0;
  for (let s = 1; s <= 30000; s++) {
    if (pickBandBoss(s, 1).id !== d.id) continue; n++;
    const k = rollBossMutators(s, 3, d).join("+") || "none";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  console.log(d.id.padEnd(14), [...m].sort((a,b)=>b[1]-a[1]).map(([k,c])=>`${k} ${(100*c/n).toFixed(0)}%`).join("  "));
}
