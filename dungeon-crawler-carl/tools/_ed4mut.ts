// ENCOUNTER-DESIGN CRITIC r4 — DOES THE MUTATOR LAYER CHANGE THE FIGHT?
//
// §4 Layer 2 is the layer that is supposed to answer "why is THIS run
// different?" for the SAME boss. Every previous round measured the DRAW (how
// often each mutator lands) and the mutator's own damage delta against a
// stationary punching bag. Nobody has measured the thing the claim is about:
// with the same boss, the same seed and the same competent player, does the
// mutator change WHAT IS POINTED AT THE PLAYER?
//
// Same instrument as _ed3census: a normalised threat vector over a bot-driven
// fight, compared by cosine. Clean vs each legal mutator. A mutator whose
// fight is cosine ~0.98 with the clean fight is a stat line wearing a chip on
// the name card, which is the exact thing BOSS_MUTATORS' own rule bans.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { allBossDefs, pickBandBoss, BOSS_MUTATORS } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId, BossMutator, GameState, Monster } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (b: number) => (b === 6 ? CONFIG.finalFloor : b * CONFIG.bossFloorEvery);
const SECS = Number(process.argv[3] ?? 60);
const NSEED = Number(process.argv[4] ?? 3);

function seedsFor(id: BossId, band: number, n: number): number[] {
  const out: number[] = [];
  for (let s = 1; s < 60000 && out.length < n; s++) if (pickBandBoss(s, band).id === id) out.push(s);
  return out;
}

interface Res { vec: Record<string, number>; taken: number; ttk: number; killed: boolean; punish: number; }

function fight(id: BossId, seed: number, floor: number, muts: BossMutator[]): Res | null {
  const g: GameState = createTestGame({
    seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000,
  });
  const boss = g.monsters.find((m) => m.kind === "boss") as Monster | undefined;
  if (!boss) return null;
  // FORCE the mutator list. Everything else about the encounter — the boss, the
  // arena, the floor, the seed, the crawler — is byte-identical across trials,
  // so the only variable is the chip on the name card.
  boss.bossMutators = muts.length ? [...muts] : undefined;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
  p.hp = p.maxHp;
  const mem = freshMemory();
  const res: Res = { vec: {}, taken: 0, ttk: 0, killed: false, punish: 0 };
  const bump = (k: string, n = 1) => { res.vec[k] = (res.vec[k] ?? 0) + n; };
  const dmg0 = p.damageTaken;
  const seenHaz = new Set<number>(), seenProj = new Set<number>(), seenMon = new Set<number>();
  let lastWindup: string | undefined;
  for (let i = 0; i < SECS * 60; i++) {
    if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
    if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6;
    step(g, botIntent(g, mem), DT);
    res.ttk += DT;
    const wk = boss.windupKind;
    if (wk && wk !== lastWindup) bump("w_" + wk);
    lastWindup = wk;
    for (const pr of g.projectiles) {
      if (pr.from !== "enemy" || seenProj.has(pr.id)) continue;
      seenProj.add(pr.id);
      const d = Math.hypot(pr.pos.x - boss.pos.x, pr.pos.y - boss.pos.y);
      bump(d < 1.6 ? "ch_volley" : "add_bolt");
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
    for (const e of g.bossEvents ?? []) if (e.kind === "punish") res.punish++;
    if (boss.hp <= 0) { res.killed = true; break; }
  }
  res.taken = p.damageTaken - dmg0;
  return res;
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

console.log("== DOES THE MUTATOR CHANGE THE FIGHT? (" + SECS + "s x " + NSEED + " seeds, bot-driven) ==");
console.log("cosine 1.00 = the mutator changed NOTHING the player has to react to.\n");
const allCos: number[] = [];
for (const def of defs) {
  const floor = floorFor(def.band);
  const seeds = seedsFor(def.id, def.band, NSEED);
  const legal = BOSS_MUTATORS.filter((m) => !m.legal || m.legal(def));
  const agg = (muts: BossMutator[]) => {
    const v: Record<string, number> = {};
    let taken = 0, ttk = 0, kills = 0, pun = 0, n = 0;
    for (const s of seeds) {
      const r = fight(def.id, s, floor, muts);
      if (!r) continue;
      n++;
      for (const [k, c] of Object.entries(r.vec)) v[k] = (v[k] ?? 0) + c;
      taken += r.taken; ttk += r.ttk; kills += r.killed ? 1 : 0; pun += r.punish;
    }
    return { v, taken: taken / (n || 1), ttk: ttk / (n || 1), kills, pun: pun / (n || 1) };
  };
  const base = agg([]);
  const bn = norm(base.v);
  console.log(`${def.name}  (${def.id}, ask=${def.ask}, floor ${floor})`);
  console.log(`   CLEAN            ttk ${base.ttk.toFixed(0)}s  dmgTaken ${Math.round(base.taken)}  punish ${base.pun.toFixed(1)}`);
  for (const mut of legal) {
    const r = agg([mut.id]);
    const c = cosine(bn, norm(r.v));
    allCos.push(c);
    const dTaken = base.taken > 0 ? (100 * (r.taken - base.taken) / base.taken) : 0;
    const dTtk = base.ttk > 0 ? (100 * (r.ttk - base.ttk) / base.ttk) : 0;
    const verdict = c >= 0.97 ? "  <-- SAME FIGHT" : c >= 0.90 ? "  (marginal)" : "";
    console.log(
      `   ${mut.label.padEnd(14)} cos ${c.toFixed(3)}  ttk ${r.ttk.toFixed(0)}s (${dTtk >= 0 ? "+" : ""}${dTtk.toFixed(0)}%)` +
      `  dmgTaken ${String(Math.round(r.taken)).padStart(5)} (${dTaken >= 0 ? "+" : ""}${dTaken.toFixed(0)}%)` +
      `  punish ${r.pun.toFixed(1)}${verdict}`);
  }
  console.log("");
}
const sorted = allCos.slice().sort((a, b) => a - b);
console.log(`MEDIAN mutator-vs-clean cosine: ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}`);
console.log(`mutator trials at cosine >= 0.97 ("same fight"): ` +
  `${allCos.filter((c) => c >= 0.97).length} / ${allCos.length}`);
