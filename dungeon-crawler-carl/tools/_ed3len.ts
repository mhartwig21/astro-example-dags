// ENCOUNTER-DESIGN CRITIC r3 — fight LENGTH and whether the learnable beat
// actually happens inside it. §6.2's target is 45-90s (120s for the finale).
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { allBossDefs, bandForBossFloor, pickBandBoss } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (b: number) => (b === 6 ? CONFIG.finalFloor : b * CONFIG.bossFloorEvery);
const NSEED = Number(process.argv[2] ?? 6);
const CAP = Number(process.argv[3] ?? 180);

function seedsFor(id: BossId, band: number, n: number): number[] {
  const out: number[] = [];
  for (let s = 1; s < 40000 && out.length < n; s++) if (pickBandBoss(s, band).id === id) out.push(s);
  return out;
}

console.log("id             band  ttk (per seed)                       | punish windows | mech-phase | intermissions | first punish at");
for (const def of allBossDefs()) {
  const floor = floorFor(def.band);
  const seeds = seedsFor(def.id, def.band, NSEED);
  const ttks: string[] = [];
  let punTot = 0, mech = 0, inter = 0, firstPun: number[] = [], noPun = 0;
  for (const seed of seeds) {
    const g = createTestGame({ seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000 });
    const boss = g.monsters.find((m) => m.kind === "boss");
    if (!boss) continue;
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
    const mem = freshMemory();
    let t = 0, pun = 0, fp = -1, saw = false;
    for (let i = 0; i < CAP * 60; i++) {
      if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
      if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6;
      step(g, botIntent(g, mem), DT);
      t += DT;
      for (const e of g.bossEvents ?? []) {
        if (e.kind === "punish") { pun++; if (fp < 0) fp = t; }
        if (e.kind === "phase" && e.reason === "mechanic") saw = true;
        if (e.kind === "intermission") inter++;
      }
      if (boss.hp <= 0) break;
    }
    ttks.push(boss.hp <= 0 ? t.toFixed(0) + "s" : ">" + CAP + "s");
    punTot += pun; if (saw) mech++; if (fp < 0) noPun++; else firstPun.push(fp);
  }
  const meanFp = firstPun.length ? (firstPun.reduce((a, b) => a + b, 0) / firstPun.length).toFixed(0) + "s" : "never";
  console.log(
    `${def.id.padEnd(14)} ${def.band}   ${ttks.join(" ").padEnd(36)} | ` +
    `${(punTot / seeds.length).toFixed(1).padStart(4)}/fight   | ` +
    `${mech}/${seeds.length}       | ${(inter / seeds.length).toFixed(1).padStart(4)}         | ${meanFp}` +
    (noPun ? `  (NO WINDOW in ${noPun}/${seeds.length})` : ""));
}
