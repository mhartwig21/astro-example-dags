// The most-drawn mutator in the game, measured.
//
// SPONSORED lands on 90.6% of runs and 26% of every mutator slot drawn (r5
// gave the ask-changers three tickets and this is the only one legal almost
// everywhere). Its counterplay sentence is "a hazard-immune bubble it must be
// PULLED OUT OF. Move the fight, not just yourself." That sentence is only a
// verb if the boss actually sits in the bubble — a boss that chases the player
// leaves its own bubble unaided, and then the most common encounter modifier
// in the game asks the player for nothing at all.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";
import { allBossDefs, bandForBossFloor, pickBandBoss } from "../src/sim/bosses";
import type { BossId, BossMutator } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (band: number) => (band === 6 ? CONFIG.finalFloor : band * CONFIG.bossFloorEvery);

function seedFor(id: BossId, floor: number, n = 1): number[] {
  const band = bandForBossFloor(floor);
  const out: number[] = [];
  for (let s = 1; s < 20000 && out.length < n; s++) if (pickBandBoss(s, band).id === id) out.push(s);
  return out;
}

function run(id: BossId, seed: number, floor: number, muts: BossMutator[], secs: number) {
  const g = createTestGame({ seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000 });
  const boss = g.monsters.find((m) => m.kind === "boss");
  if (!boss) return null;
  boss.bossMutators = [...muts];
  boss.home = undefined;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
  const mem = freshMemory();
  let bubble = 0, live = 0;
  const hp0 = boss.hp;
  const dmg0 = p.damageTaken;
  for (let i = 0; i < secs * 60; i++) {
    if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
    if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6;
    step(g, botIntent(g, mem), DT);
    if (boss.hp <= 0) break;
    live += DT;
    if (boss.home && Math.hypot(boss.pos.x - boss.home.x, boss.pos.y - boss.home.y) <= CONFIG.sponsoredBubbleRadius) bubble += DT;
  }
  return {
    live, bubble, hpLostFrac: (hp0 - Math.max(0, boss.hp)) / boss.maxHp,
    dmgTaken: p.damageTaken - dmg0, killed: boss.hp <= 0,
  };
}

const SECS = 60;
console.log("boss            | clean hpLost dmgTaken | SPONSORED hpLost dmgTaken bubble% | mitigation");
for (const def of allBossDefs()) {
  const floor = floorFor(def.band);
  const [seed] = seedFor(def.id, floor);
  const a = run(def.id, seed, floor, [], SECS);
  const b = run(def.id, seed, floor, ["sponsored"], SECS);
  if (!a || !b) continue;
  const mit = a.hpLostFrac > 0 ? (1 - b.hpLostFrac / a.hpLostFrac) * 100 : 0;
  console.log(
    `${def.id.padEnd(15)} | ${(a.hpLostFrac * 100).toFixed(0).padStart(5)}% ${String(Math.round(a.dmgTaken)).padStart(8)} | ` +
    `${(b.hpLostFrac * 100).toFixed(0).padStart(14)}% ${String(Math.round(b.dmgTaken)).padStart(8)} ` +
    `${(100 * b.bubble / Math.max(0.001, b.live)).toFixed(0).padStart(6)}% | ${mit.toFixed(0).padStart(4)}% less boss HP lost`);
}
