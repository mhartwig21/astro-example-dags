// ENCOUNTER-DESIGN CRITIC, round 2 — ABLATION.
//
// The design claim under test: "18 named bosses, seeded selection, 8 mutators
// — the roster reads as varied in play". The cheapest way to falsify it is to
// DELETE each boss's identity and see whether the fight notices. If a fight
// with the boss's own kit stubbed out plays within noise of the real one, the
// identity is decoration and the player is fighting the chassis in 18 hats.
//
// A REAL crawler drives it (bot.ts botIntent), so adds get killed, hazards get
// dodged, and mechanic-completion edges have a chance to fire.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { BOSS_KITS } from "../src/sim/ai";
import { allBossDefs, bandForBossFloor, pickBandBoss, drawBossEncounter } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (band: number) => (band === 6 ? CONFIG.finalFloor : band * CONFIG.bossFloorEvery);

function seedsFor(id: BossId, floor: number, n: number): number[] {
  const band = bandForBossFloor(floor);
  const out: number[] = [];
  for (let s = 1; s < 20000 && out.length < n; s++) {
    if (pickBandBoss(s, band).id === id) out.push(s);
  }
  return out;
}

function stage(seed: number, floor: number) {
  const g = createTestGame({
    seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000,
  });
  const boss = g.monsters.find((m) => m.kind === "boss");
  if (!boss) return null;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
  p.hp = p.maxHp;
  return { g, boss, p };
}

interface Row {
  id: string; seed: number; ablate: boolean;
  secs: number; dmgTaken: number; bossFrac: number; killed: boolean;
  telegraphs: Record<string, number>; phases: string[]; punishes: number;
  hazards: number; adds: number; bubbleSecs: number; enrage: number;
}

function fight(id: BossId, seed: number, floor: number, secs: number, ablate: boolean): Row | null {
  const saved = BOSS_KITS[id];
  if (ablate) (BOSS_KITS as Record<string, unknown>)[id] = () => false;
  try {
    const st = stage(seed, floor);
    if (!st) return null;
    const { g, boss, p } = st;
    const mem = freshMemory();
    const row: Row = {
      id, seed, ablate, secs: 0, dmgTaken: 0, bossFrac: 1, killed: false,
      telegraphs: {}, phases: [], punishes: 0, hazards: 0, adds: 0,
      bubbleSecs: 0, enrage: 0,
    };
    const dmg0 = p.damageTaken;
    const seenHaz = new Set<number>();
    const steps = Math.round(secs * 60);
    for (let i = 0; i < steps; i++) {
      if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
      if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6; // survive to measure the whole fight
      step(g, botIntent(g, mem), DT);
      row.secs += DT;
      for (const e of g.bossEvents ?? []) {
        if (e.kind === "telegraph" && e.label) row.telegraphs[e.label] = (row.telegraphs[e.label] ?? 0) + 1;
        if (e.kind === "punish") row.punishes++;
        if (e.kind === "phase") row.phases.push(String(e.reason));
        if (e.kind === "enrage") row.enrage++;
      }
      for (const h of g.hazards) if (!seenHaz.has(h.id)) { seenHaz.add(h.id); row.hazards++; }
      row.adds = Math.max(row.adds, g.monsters.filter((m) => m.hp > 0 && m.id !== boss.id).length);
      if (boss.home && Math.hypot(boss.pos.x - boss.home.x, boss.pos.y - boss.home.y) <= CONFIG.sponsoredBubbleRadius) {
        row.bubbleSecs += DT;
      }
      if (boss.hp <= 0) { row.killed = true; break; }
    }
    row.dmgTaken = p.damageTaken - dmg0;
    row.bossFrac = Math.max(0, boss.hp / boss.maxHp);
    return row;
  } finally {
    (BOSS_KITS as Record<string, unknown>)[id] = saved as unknown;
  }
}

const SECS = Number(process.argv[3] ?? 70);
const NSEED = Number(process.argv[4] ?? 3);
const only = (process.argv[2] ?? "all").split(",").filter(Boolean);
const defs = allBossDefs().filter((d) => only[0] === "all" || only.includes(d.id));

console.log("id             ask      | REAL  dmgTaken bossHP% ttk  tele phases punish | ABLATED dmgTaken bossHP% | delta");
for (const def of defs) {
  const floor = floorFor(def.band);
  const seeds = seedsFor(def.id, floor, NSEED);
  const agg = (rows: (Row | null)[]) => {
    const r = rows.filter(Boolean) as Row[];
    const n = r.length || 1;
    return {
      dmg: r.reduce((a, x) => a + x.dmgTaken, 0) / n,
      hp: r.reduce((a, x) => a + x.bossFrac, 0) / n,
      killed: r.filter((x) => x.killed).length,
      secs: r.reduce((a, x) => a + x.secs, 0) / n,
      tele: r.reduce((a, x) => a + Object.values(x.telegraphs).reduce((s, v) => s + v, 0), 0) / n,
      haz: r.reduce((a, x) => a + x.hazards, 0) / n,
      pun: r.reduce((a, x) => a + x.punishes, 0) / n,
      phases: [...new Set(r.flatMap((x) => x.phases))].join("/") || "-",
      adds: Math.max(...r.map((x) => x.adds), 0),
      labels: [...new Set(r.flatMap((x) => Object.keys(x.telegraphs)))],
    };
  };
  const real = agg(seeds.map((s) => fight(def.id, s, floor, SECS, false)));
  const abl = agg(seeds.map((s) => fight(def.id, s, floor, SECS, true)));
  const dd = real.dmg === 0 ? 0 : (real.dmg - abl.dmg) / real.dmg;
  const dh = (abl.hp - real.hp);
  console.log(
    `${def.id.padEnd(14)} ${def.ask.padEnd(8)} | ${String(Math.round(real.dmg)).padStart(6)} ` +
    `${(real.hp * 100).toFixed(0).padStart(4)}% ${real.secs.toFixed(0).padStart(3)}s ` +
    `${real.tele.toFixed(0).padStart(4)} ${real.phases.padEnd(14)} ${real.pun.toFixed(1).padStart(4)} | ` +
    `${String(Math.round(abl.dmg)).padStart(7)} ${(abl.hp * 100).toFixed(0).padStart(5)}% | ` +
    `dmg ${(dd * 100).toFixed(0).padStart(4)}%  hp ${(dh * 100).toFixed(0).padStart(4)}pt  ` +
    `kills ${real.killed}/${seeds.length} vs ${abl.killed}/${seeds.length}`);
  console.log(`   labels: ${real.labels.join(", ") || "(none)"}`);
  console.log(`   ablated labels: ${abl.labels.join(", ") || "(none)"}   maxAdds ${real.adds}/${abl.adds}  haz ${real.haz.toFixed(0)}/${abl.haz.toFixed(0)}`);
}
void drawBossEncounter;
