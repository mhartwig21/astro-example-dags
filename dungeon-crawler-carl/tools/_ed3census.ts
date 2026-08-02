// ENCOUNTER-DESIGN CRITIC, round 3 — THE THREAT CENSUS.
//
// The claim: "18 named bosses, seeded selection, 8 mutators — the roster reads
// as VARIED in play; different bosses ask you to do different things."
//
// The way to falsify that is not to read the kit table (which is obviously
// different per boss) but to measure WHAT IS ACTUALLY POINTED AT THE PLAYER
// over a driven fight, and see how much of it is the same on every boss.
//
// Per (boss, seed) we build a THREAT VECTOR — every distinct thing that can
// hurt or move the crawler, counted — split into:
//   CHASSIS : melee windup, radial volley bolts, ground slam, hazard rain,
//             dark ritual, anti-kite chase  (identical code on all 18)
//   KIT     : the boss's own telegraphs + the hazards its own verbs laid
//   ARENA   : the room's own director verb
// and then compare bosses by cosine similarity of the normalised vector.
// Two bosses whose threat vectors are ~parallel play the same, whatever the
// name card says.
import { createTestGame, step } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { allBossDefs, bandForBossFloor, pickBandBoss, drawBossEncounter } from "../src/sim/bosses";
import { CONFIG } from "../src/sim/config";
import type { BossId, GameState, Monster } from "../src/sim/types";

const DT = 1 / 60;
const floorFor = (band: number) => (band === 6 ? CONFIG.finalFloor : band * CONFIG.bossFloorEvery);

function seedsFor(id: BossId, floor: number, n: number): number[] {
  const band = bandForBossFloor(floor);
  const out: number[] = [];
  for (let s = 1; s < 40000 && out.length < n; s++) {
    if (pickBandBoss(s, band).id === id) out.push(s);
  }
  return out;
}

interface Row {
  id: string; seed: number; secs: number; killed: boolean;
  dmgTaken: number; bossFrac: number;
  vec: Record<string, number>;      // threat vector (counts)
  labels: Record<string, number>;   // telegraph labels
  punish: number; punishSecs: number;
  phases: string[];
  addsSeen: number; addsKilled: number;
  meleeSecs: number; farSecs: number; meanDist: number;
  mutators: string[]; arena: string;
  hazSecs: number;                  // seconds the crawler stood on live ground
}

const CH_KEYS = ["ch_melee", "ch_volley", "ch_slam", "ch_rain", "ch_ritual"];

function fight(id: BossId, seed: number, floor: number, secs: number): Row | null {
  const g: GameState = createTestGame({
    seed, floor, level: Math.min(30, 6 + floor), abilities: "all", gold: 4000,
  });
  const boss = g.monsters.find((m) => m.kind === "boss");
  if (!boss) return null;
  const p = g.players[0];
  p.pos = { x: boss.pos.x + 6, y: boss.pos.y + 6 };
  p.hp = p.maxHp;
  const draw = drawBossEncounter(seed, floor);
  const mem = freshMemory();
  const row: Row = {
    id, seed, secs: 0, killed: false, dmgTaken: 0, bossFrac: 1,
    vec: {}, labels: {}, punish: 0, punishSecs: 0, phases: [],
    addsSeen: 0, addsKilled: 0, meleeSecs: 0, farSecs: 0, meanDist: 0,
    mutators: draw.mutators.map(String), arena: draw.arena, hazSecs: 0,
  };
  const bump = (k: string, n = 1) => { row.vec[k] = (row.vec[k] ?? 0) + n; };
  const dmg0 = p.damageTaken;
  const seenHaz = new Set<number>();
  const seenProj = new Set<number>();
  const seenMon = new Set<number>();
  let lastWindup: string | undefined;
  let distAcc = 0, distN = 0;
  const steps = Math.round(secs * 60);
  for (let i = 0; i < steps; i++) {
    if (g.status !== "playing") { p.hp = Math.max(1, p.hp); p.alive = true; p.downedT = 0; g.status = "playing"; }
    if (p.hp <= p.maxHp * 0.05) p.hp = p.maxHp * 0.6; // survive to measure the whole fight
    step(g, botIntent(g, mem), DT);
    row.secs += DT;

    // --- what did the BOSS commit this step? -------------------------------
    const wk = (boss as Monster).windupKind;
    if (wk && wk !== lastWindup) {
      if (wk === "melee" || wk === "punch") bump("ch_melee");
      else if (wk === "slam") bump("ch_slam");
      else if (wk === "ritual") bump("ch_ritual");
      else if (wk === "punish") { /* counted via bossEvents */ }
      else bump("kit_windup_" + wk);
    }
    lastWindup = wk;

    // --- radial volley: enemy bolts leaving the boss ------------------------
    for (const pr of g.projectiles) {
      if (pr.from !== "enemy" || seenProj.has(pr.id)) continue;
      seenProj.add(pr.id);
      const d = Math.hypot(pr.pos.x - boss.pos.x, pr.pos.y - boss.pos.y);
      if (d < 1.6) bump("ch_volley"); else bump("add_bolt");
    }

    // --- hazards, bucketed by shape ----------------------------------------
    for (const h of g.hazards) {
      if (seenHaz.has(h.id) || h.ownerId != null) continue;
      seenHaz.add(h.id);
      const k = h.kind ?? "blast";
      if (k === "blast" && h.flavor === "debris" && Math.abs(h.radius - CONFIG.bossHazardRadius) < 0.01) {
        bump("ch_rain");
      } else bump("haz_" + k + (h.flavor ? ":" + h.flavor : ""));
    }
    // is the crawler standing on live ground right now?
    for (const h of g.hazards) {
      if (h.ownerId != null) continue;
      if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= h.radius) { row.hazSecs += DT; break; }
    }

    for (const m of g.monsters) {
      if (m.id === boss.id) continue;
      if (!seenMon.has(m.id)) { seenMon.add(m.id); row.addsSeen++; }
    }

    for (const e of g.bossEvents ?? []) {
      if (e.kind === "telegraph" && e.label) row.labels[e.label] = (row.labels[e.label] ?? 0) + 1;
      if (e.kind === "punish") { row.punish++; row.punishSecs += e.duration ?? 0; }
      if (e.kind === "phase") row.phases.push(String(e.reason));
    }

    const d = Math.hypot(boss.pos.x - p.pos.x, boss.pos.y - p.pos.y);
    distAcc += d; distN++;
    if (d <= boss.attackRange + 0.3) row.meleeSecs += DT;
    if (d > 9) row.farSecs += DT;

    if (boss.hp <= 0) { row.killed = true; break; }
  }
  row.addsKilled = row.addsSeen - g.monsters.filter((m) => m.hp > 0 && m.id !== boss.id).length;
  row.dmgTaken = p.damageTaken - dmg0;
  row.bossFrac = Math.max(0, boss.hp / boss.maxHp);
  row.meanDist = distN ? distAcc / distN : 0;
  return row;
}

function norm(v: Record<string, number>): Map<string, number> {
  const tot = Object.values(v).reduce((a, b) => a + b, 0) || 1;
  return new Map(Object.entries(v).map(([k, n]) => [k, n / tot]));
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const SECS = Number(process.argv[3] ?? 75);
const NSEED = Number(process.argv[4] ?? 2);
const only = (process.argv[2] ?? "all").split(",").filter(Boolean);
const defs = allBossDefs().filter((d) => only[0] === "all" || only.includes(d.id));

const profiles = new Map<string, { def: (typeof defs)[number]; rows: Row[] }>();
console.log("== PER-BOSS THREAT CENSUS (" + SECS + "s x " + NSEED + " seeds, bot-driven) ==\n");
console.log("id             ask      ttk   killed dmgTkn | CHASSIS share  KIT share  ARENA/other | punish  phases            | melee% far% haz% adds");
for (const def of defs) {
  const floor = floorFor(def.band);
  const seeds = seedsFor(def.id, floor, NSEED);
  const rows = seeds.map((s) => fight(def.id, s, floor, SECS)).filter(Boolean) as Row[];
  if (rows.length === 0) continue;
  profiles.set(def.id, { def, rows });
  const agg: Record<string, number> = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.vec)) agg[k] = (agg[k] ?? 0) + n / rows.length;
  const tot = Object.values(agg).reduce((a, b) => a + b, 0) || 1;
  const chassis = CH_KEYS.reduce((a, k) => a + (agg[k] ?? 0), 0);
  const kit = Object.entries(agg).filter(([k]) => k.startsWith("kit_")).reduce((a, [, n]) => a + n, 0);
  const other = tot - chassis - kit;
  const mean = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const phases = [...new Set(rows.flatMap((r) => r.phases))].join("/") || "-";
  console.log(
    `${def.id.padEnd(14)} ${def.ask.padEnd(8)} ${mean((r) => r.secs).toFixed(0).padStart(3)}s ` +
    `${rows.filter((r) => r.killed).length}/${rows.length}    ${String(Math.round(mean((r) => r.dmgTaken))).padStart(6)} | ` +
    `${(100 * chassis / tot).toFixed(0).padStart(6)}%  ${(100 * kit / tot).toFixed(0).padStart(8)}%  ${(100 * other / tot).toFixed(0).padStart(10)}% | ` +
    `${mean((r) => r.punish).toFixed(1).padStart(5)}  ${phases.padEnd(17)} | ` +
    `${(100 * mean((r) => r.meleeSecs) / mean((r) => r.secs)).toFixed(0).padStart(4)}% ` +
    `${(100 * mean((r) => r.farSecs) / mean((r) => r.secs)).toFixed(0).padStart(3)}% ` +
    `${(100 * mean((r) => r.hazSecs) / mean((r) => r.secs)).toFixed(0).padStart(3)}% ` +
    `${mean((r) => r.addsSeen).toFixed(0).padStart(4)}`);
  const labels = Object.entries(rows.reduce((a, r) => {
    for (const [k, n] of Object.entries(r.labels)) a[k] = (a[k] ?? 0) + n; return a;
  }, {} as Record<string, number>)).sort((x, y) => y[1] - x[1]);
  console.log("   labels: " + (labels.map(([k, n]) => k + "x" + n).join(", ") || "(none)"));
  console.log("   vector: " + Object.entries(agg).sort((x, y) => y[1] - x[1])
    .map(([k, n]) => k + ":" + n.toFixed(0)).join(" "));
  console.log("   mutators: " + (rows.map((r) => r.id + "@" + r.seed + "[" + (r.mutators.join("+") || "none") + "/" + r.arena + "]").join("  ")));
}

// ---- SIMILARITY: is the roster 18 fights or 1 fight in 18 hats? ------------
console.log("\n== PAIRWISE THREAT SIMILARITY (cosine of the normalised threat vector) ==");
const ids = [...profiles.keys()];
const vecs = new Map(ids.map((id) => {
  const agg: Record<string, number> = {};
  const rows = profiles.get(id)!.rows;
  for (const r of rows) for (const [k, n] of Object.entries(r.vec)) agg[k] = (agg[k] ?? 0) + n;
  return [id, norm(agg)] as const;
}));
console.log("     " + ids.map((i) => i.slice(0, 4).padStart(5)).join(""));
for (const a of ids) {
  console.log(a.slice(0, 4).padEnd(5) + ids.map((b) => (a === b ? "    -" : cosine(vecs.get(a)!, vecs.get(b)!).toFixed(2).padStart(5))).join(""));
}
const pairs: [string, string, number][] = [];
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  pairs.push([ids[i], ids[j], cosine(vecs.get(ids[i])!, vecs.get(ids[j])!)]);
}
pairs.sort((a, b) => b[2] - a[2]);
console.log("\nMOST ALIKE (top 12):");
for (const [a, b, c] of pairs.slice(0, 12)) {
  const da = profiles.get(a)!.def, db = profiles.get(b)!.def;
  console.log(`   ${c.toFixed(3)}  ${a}(${da.ask}) ~ ${b}(${db.ask})${da.band === db.band ? "   [SAME BAND]" : ""}`);
}
console.log("\nLEAST ALIKE (bottom 6):");
for (const [a, b, c] of pairs.slice(-6)) console.log(`   ${c.toFixed(3)}  ${a} ~ ${b}`);
const med = pairs.map((p) => p[2]).sort((a, b) => a - b)[Math.floor(pairs.length / 2)];
console.log(`\nMEDIAN pairwise similarity across the roster: ${med.toFixed(3)}`);
