/* Throwaway: how many targets does an AoE actually catch, and AP/SP split. */
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { novaParams, cataclysmParams, meleeParams } from "../src/sim/abilities";
import { dist } from "../src/sim/combat";

const SEEDS = [21, 22, 23, 24, 25, 26, 27, 28];

for (const floor of [4, 8, 12]) {
  const level = floor === 4 ? 7 : floor === 8 ? 13 : 18;
  const hist: number[] = [];
  let ap = 0, sp = 0, hp = 0;
  for (const seed of SEEDS) {
    const g = createTestGame({ seed, floor, level, abilities: ["nova"] });
    const p = g.players[0];
    ap += p.attackPower; sp += p.spellPower; hp += p.maxHp;
    const r = novaParams(p).radius;
    const mem = freshMemory();
    for (let i = 0; i < 12_000 && g.status === "playing" && !g.safeRoom; i++) {
      step(g, botIntent(g, mem), 1 / 60);
      if (i % 30 !== 0) continue; // sample twice a second
      let n = 0;
      for (const m of g.monsters) if (m.hp > 0 && dist(p.pos, m.pos) <= r) n++;
      hist.push(n);
    }
  }
  hist.sort((a, b) => a - b);
  const q = (f: number) => hist[Math.floor(hist.length * f)] ?? 0;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const share = (k: number) => (hist.filter((n) => n >= k).length / hist.length * 100).toFixed(0);
  console.log(
    "floor " + floor + " (lvl " + level + "): AP " + (ap / SEEDS.length).toFixed(0) +
    " SP " + (sp / SEEDS.length).toFixed(0) + " HP " + (hp / SEEDS.length).toFixed(0) +
    " | enemies inside nova radius: mean " + mean.toFixed(2) +
    " median " + q(0.5) + " p90 " + q(0.9) + " p99 " + q(0.99) +
    " | >=3 targets " + share(3) + "% of the time, >=5 " + share(5) + "%",
  );
}

// AP/SP split spread across seeds: is a crawler's school a CHOICE or a drop?
console.log("\n=== school split across 16 seeds (floor 8, lvl 13, auto-equip) ===");
const splits: string[] = [];
for (let seed = 1; seed <= 16; seed++) {
  const g = createTestGame({ seed, floor: 8, level: 13 });
  const p = g.players[0];
  splits.push((p.attackPower / (p.attackPower + p.spellPower) * 100).toFixed(0) + "%AP");
}
console.log("  " + splits.join(" "));

// Melee cooldown floors: what does the rule-7 cap plus weapon class actually give?
console.log("\n=== melee cadence at floor 12 ===");
for (let seed = 1; seed <= 6; seed++) {
  const g = createTestGame({ seed, floor: 12, level: 18, abilities: "all" });
  const p = g.players[0];
  const mp = meleeParams(p);
  console.log("  seed " + seed + " weapon=" + (p.equipment.weapon?.name ?? "bare") +
    " cd=" + mp.cooldown.toFixed(3) + " dmgMult=" + mp.damageMult.toFixed(2) +
    " novaCd=" + novaParams(p).cooldown.toFixed(2) + " cataCd=" + cataclysmParams(p).cooldown.toFixed(1));
}
