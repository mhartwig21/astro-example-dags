// Does a mutator change what the player DOES? Force each legal mutator onto a
// boss and measure the fight, vs the same boss clean.
import { restoreGame, step, damageMonster } from "../src/sim/game";
import { CONFIG } from "../src/sim/config";
import { allBossDefs, bandForBossFloor, pickBandBoss, BOSS_MUTATORS } from "../src/sim/bosses";
import type { BossId, BossMutator } from "../src/sim/types";

const DT = 1 / 60;
const idle = () => ({ move: { x: 0, y: 0 }, useStairs: false });
const floorForBand = (b: number) => (b === 6 ? CONFIG.finalFloor : b * CONFIG.bossFloorEvery);

function seedFor(id: BossId, band: number) {
  for (let s = 1; s < 200_000; s++) if (pickBandBoss(s, band).id === id) return s;
  throw new Error("x");
}

function trial(id: BossId, muts: BossMutator[], secs = 60) {
  const def = allBossDefs().find((d) => d.id === id)!;
  const floor = floorForBand(def.band);
  const g = restoreGame({
    seed: seedFor(id, def.band), floor,
    player: { hp: 6000, level: 22, xp: 0, xpToNext: 9e9, gold: 0, bonusMaxHp: 6000, bonusDamage: 0 },
  });
  const boss = g.monsters.find((m) => m.kind === "boss")!;
  boss.bossMutators = muts.length ? muts : undefined;
  boss.introduced = true;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 3, y: boss.pos.y };
  let dealt = 0, taken = 0, bodies = 0, hazards = 0;
  const seen = new Set<number>();
  const hp0 = boss.hp;
  for (let i = 0; i < secs * 60; i++) {
    p.hp = p.maxHp; p.alive = true; p.downedT = 0; g.status = "playing";
    if (boss.hp > 0 && Math.hypot(p.pos.x - boss.pos.x, p.pos.y - boss.pos.y) > 4) {
      p.pos = { x: boss.pos.x + 3, y: boss.pos.y };
    }
    // A fixed, honest DPS source: 200 raw per second, physical.
    if (i % 6 === 0 && boss.hp > 0) {
      const before = boss.hp + (boss.shieldHp ?? 0);
      damageMonster(g, p, boss, 20, { school: "physical" });
      dealt += before - (boss.hp + (boss.shieldHp ?? 0));
    }
    step(g, idle(), DT);
    for (const h of g.hits) if (h.kind === "player") taken += h.amount;
    for (const h of g.hazards) if (!seen.has(h.id)) { seen.add(h.id); hazards++; }
    bodies = Math.max(bodies, g.monsters.filter((m) => m.hp > 0 && m.id !== boss.id).length);
  }
  const eff = dealt / Math.max(1, secs * 200) ; // fraction of raw damage that landed
  return {
    dmgLanded: Math.round(dealt), effectiveness: eff, hpFrac: boss.hp / hp0,
    taken: Math.round(taken), bodies, hazards, enraged: boss.enrageStacks ?? 0,
    fightT: Math.round(boss.fightT ?? 0),
  };
}

const ids = (process.argv[2] || "greasetrap,topiary,marshal").split(",") as BossId[];
for (const id of ids) {
  const def = allBossDefs().find((d) => d.id === id)!;
  const base = trial(id, []);
  console.log(`\n== ${id} (band ${def.band}, stationary=${!!def.stationary})`);
  console.log(`   CLEAN      landed=${base.dmgLanded} eff=${base.effectiveness.toFixed(2)} bossHp=${(100 * base.hpFrac).toFixed(0)}% taken=${base.taken} bodies=${base.bodies} haz=${base.hazards} enrage=${base.enraged}`);
  for (const m of BOSS_MUTATORS) {
    if (m.legal && !m.legal(def)) { console.log(`   ${m.id.padEnd(11)} (illegal on this boss)`); continue; }
    const t = trial(id, [m.id]);
    const d = (n: number, b: number) => (b === 0 ? "n/a" : ((100 * (n - b)) / b).toFixed(0) + "%");
    console.log(`   ${m.id.padEnd(11)}landed=${t.dmgLanded} (${d(t.dmgLanded, base.dmgLanded)}) bossHp=${(100 * t.hpFrac).toFixed(0)}% taken=${t.taken} (${d(t.taken, base.taken)}) bodies=${t.bodies} haz=${t.hazards} (${d(t.hazards, base.hazards)}) enrage=${t.enraged}`);
  }
}
