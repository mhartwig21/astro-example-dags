// ENCOUNTER-DESIGN CRITIC r4 — THE OWNER'S QUESTION, ASKED DIRECTLY.
//
// "The game is built for SHORT SESSIONS PLAYED OVER AND OVER, so the same boss
// appearing every run is the enemy. Variety across runs is the design problem."
//
// Every measurement so far has compared DIFFERENT bosses. This compares the
// SAME boss on different runs — the case the player actually hits, because the
// pool is three deep and a player replaying floor 3 meets each candidate about
// every third run. Natural draws only: whatever mutator and arena the shipping
// seed hands out, exactly as a player receives them.
//
// The number that matters: WITHIN-boss run-to-run cosine vs BETWEEN-boss
// cosine. If seeing the same boss again is as different as seeing a different
// boss, the variety layers are doing their job. If within-boss is ~1.0, then
// layers 2 and 3 (mutators, arenas) are decoration and only the 1-in-3 name
// draw is real variety.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { allBossDefs, pickBandBoss, drawBossEncounter } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId, GameState, Monster } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (b: number) => (b === 6 ? CONFIG.finalFloor : b * CONFIG.bossFloorEvery);
const SECS = Number(process.argv[3] ?? 60);
const NSEED = Number(process.argv[4] ?? 6);

function seedsFor(id: BossId, band: number, n: number): number[] {
  const out: number[] = [];
  for (let s = 1; s < 60000 && out.length < n; s++) if (pickBandBoss(s, band).id === id) out.push(s);
  return out;
}

function fight(seed: number, floor: number): Record<string, number> | null {
  const g: GameState = createTestGame({
    seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000,
  });
  const boss = g.monsters.find((m) => m.kind === "boss") as Monster | undefined;
  if (!boss) return null;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
  p.hp = p.maxHp;
  const mem = freshMemory();
  const vec: Record<string, number> = {};
  const bump = (k: string, n = 1) => { vec[k] = (vec[k] ?? 0) + n; };
  const seenHaz = new Set<number>(), seenProj = new Set<number>(), seenMon = new Set<number>();
  let lastWindup: string | undefined;
  for (let i = 0; i < SECS * 60; i++) {
    if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
    if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6;
    step(g, botIntent(g, mem), DT);
    const wk = boss.windupKind;
    if (wk && wk !== lastWindup) bump("w_" + wk);
    lastWindup = wk;
    for (const pr of g.projectiles) {
      if (pr.from !== "enemy" || seenProj.has(pr.id)) continue;
      seenProj.add(pr.id);
      bump(Math.hypot(pr.pos.x - boss.pos.x, pr.pos.y - boss.pos.y) < 1.6 ? "ch_volley" : "add_bolt");
    }
    for (const h of g.hazards) {
      if (seenHaz.has(h.id) || h.ownerId != null) continue;
      seenHaz.add(h.id);
      bump("haz_" + (h.kind ?? "blast") + (h.flavor ? ":" + h.flavor : ""));
    }
    for (const m of g.monsters) {
      if (m.id === boss.id || seenMon.has(m.id)) continue;
      seenMon.add(m.id); bump("body_" + m.kind);
    }
    if (boss.hp <= 0) break;
  }
  return vec;
}

function norm(v: Record<string, number>) {
  const t = Object.values(v).reduce((a, b) => a + b, 0) || 1;
  return new Map(Object.entries(v).map(([k, n]) => [k, n / t]));
}
function cosine(a: Map<string, number>, b: Map<string, number>) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const only = (process.argv[2] ?? "all").split(",").filter(Boolean);
const defs = allBossDefs().filter((d) => only[0] === "all" || only.includes(d.id));

console.log("== THE SAME BOSS, DIFFERENT RUNS (" + SECS + "s, " + NSEED + " natural seeds each) ==");
console.log("Every run below is the shipping draw: whatever mutator + arena that seed gives.\n");
const within: number[] = [];
const byBoss = new Map<string, Map<string, number>[]>();
for (const def of defs) {
  const floor = floorFor(def.band);
  const seeds = seedsFor(def.id, def.band, NSEED);
  const vs: Map<string, number>[] = [];
  const tags: string[] = [];
  for (const s of seeds) {
    const v = fight(s, floor);
    if (!v) continue;
    vs.push(norm(v));
    const d = drawBossEncounter(s, floor);
    tags.push((d.mutators.join("+") || "none") + "/" + d.arena);
  }
  byBoss.set(def.id, vs);
  const cs: number[] = [];
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) cs.push(cosine(vs[i], vs[j]));
  cs.forEach((c) => within.push(c));
  const mean = cs.reduce((a, b) => a + b, 0) / (cs.length || 1);
  const lo = Math.min(...cs), hi = Math.max(...cs);
  console.log(`${def.id.padEnd(15)} ask=${def.ask.padEnd(7)} run-to-run cosine  mean ${mean.toFixed(3)}  min ${lo.toFixed(3)}  max ${hi.toFixed(3)}`);
  console.log(`     runs drawn: ${tags.join("  |  ")}`);
}

// The control: how different is a DIFFERENT boss in the same band?
const between: number[] = [];
for (const a of defs) for (const b of defs) {
  if (a.id >= b.id || a.band !== b.band) continue;
  const va = byBoss.get(a.id) ?? [], vb = byBoss.get(b.id) ?? [];
  for (const x of va) for (const y of vb) between.push(cosine(x, y));
}
const m = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / (xs.length || 1);
console.log("\n---------------------------------------------------------------");
console.log(`SAME boss, different run   : mean cosine ${m(within).toFixed(3)}  (n=${within.length})`);
if (between.length) {
  console.log(`DIFFERENT boss, same band  : mean cosine ${m(between).toFixed(3)}  (n=${between.length})`);
  console.log(`\nVARIETY HEADROOM the mutator + arena layers buy: ` +
    `${(m(between) - m(within)).toFixed(3)} of cosine is the NAME draw; ` +
    `${(1 - m(within)).toFixed(3)} is everything else combined.`);
}
