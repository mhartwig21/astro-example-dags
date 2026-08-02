// Does the ASK printed on the name card predict how the fight is PLAYED?
// Measures the concurrent body count and the ground/lane pressure a fight puts
// on the crawler, grouped by the ask the card claims.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { allBossDefs, pickBandBoss } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (b: number) => (b === 6 ? CONFIG.finalFloor : b * CONFIG.bossFloorEvery);
const N = Number(process.argv[2] ?? 3), SECS = Number(process.argv[3] ?? 60);
function seedsFor(id: BossId, band: number, n: number) {
  const o: number[] = [];
  for (let s = 1; s < 40000 && o.length < n; s++) if (pickBandBoss(s, band).id === id) o.push(s);
  return o;
}
const rows: { ask: string; id: string; peak: number; mean: number; lane: number; ground: number; killedAdds: number }[] = [];
for (const def of allBossDefs()) {
  const floor = floorFor(def.band);
  let peak = 0, meanA = 0, lane = 0, ground = 0, kill = 0, n = 0;
  for (const seed of seedsFor(def.id, def.band, N)) {
    const g = createTestGame({ seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000 });
    const boss = g.monsters.find((m) => m.kind === "boss"); if (!boss) continue;
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
    const mem = freshMemory();
    let acc = 0, steps = 0, laneS = 0, groundS = 0, k0 = p.kills;
    for (let i = 0; i < SECS * 60; i++) {
      if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
      if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6;
      step(g, botIntent(g, mem), DT);
      const live = g.monsters.filter((m) => m.hp > 0 && m.id !== boss.id && !m.dormant).length;
      peak = Math.max(peak, live); acc += live; steps++;
      let onLane = false, onGround = false;
      for (const h of g.hazards) {
        if (h.ownerId != null) continue;
        const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
        if (d <= h.radius) { if (h.kind === "beam") onLane = true; else onGround = true; }
      }
      if (onLane) laneS += DT; if (onGround) groundS += DT;
      if (boss.hp <= 0) break;
    }
    meanA += acc / Math.max(1, steps); lane += laneS; ground += groundS; kill += p.kills - k0; n++;
  }
  n = n || 1;
  rows.push({ ask: def.ask, id: def.id, peak, mean: meanA / n, lane: lane / n, ground: ground / n, killedAdds: kill / n });
}
console.log("ask      id             peakLiveAdds meanLiveAdds addsKilled  secsOnLane secsOnGround");
for (const r of rows.sort((a, b) => a.ask.localeCompare(b.ask) || a.id.localeCompare(b.id))) {
  console.log(`${r.ask.padEnd(8)} ${r.id.padEnd(14)} ${String(r.peak).padStart(9)} ${r.mean.toFixed(1).padStart(12)} ${r.killedAdds.toFixed(0).padStart(10)} ${r.lane.toFixed(1).padStart(11)} ${r.ground.toFixed(1).padStart(12)}`);
}
console.log("\nBY ASK (mean of its bosses):");
const byAsk = new Map<string, typeof rows>();
for (const r of rows) (byAsk.get(r.ask) ?? byAsk.set(r.ask, []).get(r.ask)!).push(r);
for (const [ask, rs] of byAsk) {
  const m = (f: (r: typeof rs[number]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  console.log(`  ${ask.padEnd(8)} peak ${m((r) => r.peak).toFixed(1).padStart(5)}  mean ${m((r) => r.mean).toFixed(1).padStart(5)}  killed ${m((r) => r.killedAdds).toFixed(0).padStart(4)}  lane ${m((r) => r.lane).toFixed(1).padStart(5)}s  ground ${m((r) => r.ground).toFixed(1).padStart(5)}s`);
}
