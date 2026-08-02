// ENCOUNTER-DESIGN AUDIT (critic round, read-only).
// Stages every roster boss on its own floor and censuses what it ACTUALLY
// does across a fight: telegraph labels, windup kinds, punish windows, phase
// reasons, and the split between the boss's OWN verb and shared chassis.
import { restoreGame, step } from "../src/sim/game";
import { CONFIG } from "../src/sim/config";
import {
  BOSS_POOL, allBossDefs, bandForBossFloor, pickBandBoss, rollBossMutators,
  pickArenaVariant,
} from "../src/sim/bosses";
import type { BossId, GameState, Monster } from "../src/sim/types";

const DT = 1 / 60;
const idle = () => ({ move: { x: 0, y: 0 }, useStairs: false });

function floorForBand(band: number): number {
  return band === 6 ? CONFIG.finalFloor : band * CONFIG.bossFloorEvery;
}

function seedForBoss(id: BossId, floor: number): number {
  const band = bandForBossFloor(floor);
  for (let seed = 1; seed < 200_000; seed++) if (pickBandBoss(seed, band).id === id) return seed;
  throw new Error("no seed for " + id);
}

function stage(id: BossId) {
  const def = allBossDefs().find((d) => d.id === id)!;
  const floor = floorForBand(def.band);
  const g = restoreGame({
    seed: seedForBoss(id, floor), floor,
    player: { hp: 5000, level: 20, xp: 0, xpToNext: 9e9, gold: 500, bonusMaxHp: 5000, bonusDamage: 60 },
  });
  const boss = g.monsters.find((m) => m.kind === "boss")!;
  g.monsters = g.monsters.filter((m) => m.kind === "boss" || m.tetherId === boss.id);
  boss.introduced = true;
  g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
  return { g, boss, def, floor };
}

interface Census {
  id: string;
  ask: string;
  telegraphs: Record<string, number>;
  windups: Record<string, number>;
  phases: string[];
  punishes: number;
  staggerSecs: number;
  hazardKinds: Record<string, number>;
  volleys: number;
  adds: number;
  ttk: number | null;
  dmgTaken: number;
}

function run(id: BossId, seconds: number, dps: number): Census {
  const { g, boss, def } = stage(id);
  const c: Census = {
    id, ask: def.ask, telegraphs: {}, windups: {}, phases: [], punishes: 0,
    staggerSecs: 0, hazardKinds: {}, volleys: 0, adds: 0, ttk: null, dmgTaken: 0,
  };
  const p = g.players[0];
  let lastWind: string | undefined;
  let seenHaz = new Set<number>();
  let seenBolt = new Set<number>();
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    p.hp = p.maxHp; p.alive = true; p.downedT = 0; g.status = "playing";
    if (boss.hp > 0 && Math.hypot(p.pos.x - boss.pos.x, p.pos.y - boss.pos.y) > 6) {
      p.pos = { x: boss.pos.x + 4, y: boss.pos.y };
    }
    // constant pressure so phases actually land
    if (boss.hp > 0) {
      if ((boss.shieldHp ?? 0) > 0) boss.shieldHp = Math.max(0, boss.shieldHp! - dps * DT * 2);
      else boss.hp = Math.max(1, boss.hp - dps * DT);
      if (boss.plates) for (const pl of boss.plates) if (!pl.broken) {
        pl.hp = Math.max(0, pl.hp - dps * DT * 0.5);
        if (pl.hp <= 0) pl.broken = true;
      }
    }
    step(g, idle(), DT);
    for (const h of g.hits) if (h.kind === "player") c.dmgTaken += h.amount;
    if (boss.windupKind && boss.windupKind !== lastWind) {
      c.windups[boss.windupKind] = (c.windups[boss.windupKind] ?? 0) + 1;
    }
    lastWind = boss.windupKind;
    if (boss.stagger > 0) c.staggerSecs += DT;
    for (const e of g.bossEvents ?? []) {
      if (e.kind === "telegraph" && e.label) c.telegraphs[e.label] = (c.telegraphs[e.label] ?? 0) + 1;
      if (e.kind === "punish") c.punishes++;
      if (e.kind === "phase") c.phases.push(String(e.reason));
    }
    for (const h of g.hazards) if (!seenHaz.has(h.id)) {
      seenHaz.add(h.id);
      c.hazardKinds[h.kind ?? "blast"] = (c.hazardKinds[h.kind ?? "blast"] ?? 0) + 1;
    }
    for (const b of g.projectiles ?? []) if (!seenBolt.has(b.id)) { seenBolt.add(b.id); c.volleys++; }
    c.adds = Math.max(c.adds, g.monsters.filter((m) => m.hp > 0 && m.kind !== "boss").length);
  }
  return c;
}

const which = process.argv[2];
const secs = Number(process.argv[3] ?? 75);
const dpsArg = Number(process.argv[4] ?? 0);
const ids = which && which !== "all" ? which.split(",") as BossId[] : allBossDefs().map((d) => d.id);
const rows: Census[] = [];
for (const id of ids) {
  const def = allBossDefs().find((d) => d.id === id)!;
  const dps = dpsArg || (def.band === 1 ? 22 : def.band * 60);
  rows.push(run(id, secs, dps));
}
for (const r of rows) {
  const tel = Object.entries(r.telegraphs).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}x${v}`).join(", ");
  const wu = Object.entries(r.windups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(",");
  const hz = Object.entries(r.hazardKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(",");
  console.log(`\n== ${r.id}  [ask=${r.ask}]`);
  console.log(`   telegraphs: ${tel || "(none)"}`);
  console.log(`   windups:    ${wu || "(none)"}`);
  console.log(`   hazards:    ${hz || "(none)"}   bolts:${r.volleys}  maxAdds:${r.adds}`);
  console.log(`   punish:${r.punishes} staggerS:${r.staggerSecs.toFixed(1)} phases:[${r.phases.join(",")}] dmgTaken:${Math.round(r.dmgTaken)}`);
}
