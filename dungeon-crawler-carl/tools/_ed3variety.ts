// ENCOUNTER-DESIGN CRITIC, round 3 — VARIETY ACROSS RUNS, as a player feels it.
//
// The design claim is not "the draw is uniform". It is "a player playing short
// sessions over and over does not see the same fight". So measure the thing the
// player experiences: a CHAIN of consecutive runs with the shipped anti-repeat
// ledger in place, and count what they actually meet.
import {
  BOSS_POOL, drawBossEncounter, pickBandBoss, rollBossMutators, pickArenaVariant, bossDef,
} from "../src/sim/bosses";
import type { BossId } from "../src/sim/types";

const FLOORS = [3, 6, 9, 12, 15, 18];
const band = (f: number) => FLOORS.indexOf(f) + 1;

// --- 1. The chain: N consecutive runs from one browser profile ---------------
// Each run picks a fresh random-ish seed (the shipping default), the previous
// run's lineup steps the draw off a repeat, and the ledger merges forward.
function chain(runs: number, startSeed: number) {
  let prev: Record<string, BossId> = {};
  const seen: Record<number, BossId[]> = {};
  for (let r = 0; r < runs; r++) {
    const seed = (startSeed * 2654435761 + r * 40503) >>> 0 % 1000000 || (startSeed + r);
    const line: Record<string, BossId> = {};
    for (const f of FLOORS) {
      const d = drawBossEncounter(seed, f, prev, {});
      line[String(band(f))] = d.def.id;
      (seen[band(f)] ??= []).push(d.def.id);
    }
    prev = { ...prev, ...line };
  }
  return seen;
}

console.log("== 1. WHAT A PLAYER MEETS OVER CONSECUTIVE RUNS (anti-repeat ledger ON) ==");
for (const runsN of [2, 3, 5, 8]) {
  const distinct: Record<number, number[]> = {};
  const repeatBackToBack: Record<number, number> = {};
  const TRIALS = 3000;
  for (let t = 1; t <= TRIALS; t++) {
    const seen = chain(runsN, t);
    for (const b of Object.keys(seen).map(Number)) {
      (distinct[b] ??= []).push(new Set(seen[b]).size);
      for (let i = 1; i < seen[b].length; i++) {
        if (seen[b][i] === seen[b][i - 1]) repeatBackToBack[b] = (repeatBackToBack[b] ?? 0) + 1;
      }
    }
  }
  const line = Object.keys(distinct).map(Number).sort().map((b) => {
    const arr = distinct[b];
    return `band${b}: ${(arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(2)}`;
  }).join("  ");
  const rb = Object.keys(distinct).map(Number).sort()
    .map((b) => `${((repeatBackToBack[b] ?? 0) / (TRIALS * (runsN - 1)) * 100).toFixed(1)}%`).join(" ");
  console.log(`  after ${runsN} runs — mean DISTINCT bosses of 3 per band: ${line}`);
  console.log(`      back-to-back repeats: ${rb}`);
}

// --- 2. Floor 3 is the boss EVERY short session meets ------------------------
console.log("\n== 2. THE FLOOR-3 SLOT (the one every session reaches) ==");
for (const d of BOSS_POOL[1]) {
  const arenas = new Set<string>();
  let muts = 0;
  for (let s = 1; s <= 20000; s++) {
    if (pickBandBoss(s, 1).id !== d.id) continue;
    arenas.add(pickArenaVariant(s, d));
    muts += rollBossMutators(s, 3, d).length;
  }
  console.log(`  ${d.id.padEnd(14)} ask=${d.ask.padEnd(7)} arenas drawn: ${[...arenas].join("/")}   mutator slots: ${muts}`);
}

// --- 3. Same boss, different run: how different IS it? -----------------------
console.log("\n== 3. THE SAME BOSS ACROSS RUNS: distinct (mutators x arena) fingerprints ==");
for (const f of FLOORS) {
  for (const d of BOSS_POOL[band(f)]) {
    const fps = new Map<string, number>();
    let n = 0;
    for (let s = 1; s <= 30000; s++) {
      if (pickBandBoss(s, band(f)).id !== d.id) continue;
      n++;
      const fp = (rollBossMutators(s, f, d).slice().sort().join("+") || "none") + " / " + pickArenaVariant(s, d);
      fps.set(fp, (fps.get(fp) ?? 0) + 1);
    }
    const top = [...fps].sort((a, b) => b[1] - a[1]);
    const modal = top[0];
    console.log(`  f${String(f).padStart(2)} ${d.id.padEnd(14)} ${String(fps.size).padStart(2)} distinct fingerprints; ` +
      `most common ${(100 * modal[1] / n).toFixed(0)}% = ${modal[0]}`);
  }
}

// --- 4. How much of the LINEUP is decided by things the player can name? -----
console.log("\n== 4. WHOLE-RUN LINEUP ENTROPY ==");
const lineups = new Set<string>();
const mutlineups = new Set<string>();
for (let s = 1; s <= 20000; s++) {
  const ids: string[] = [], full: string[] = [];
  for (const f of FLOORS) {
    const d = drawBossEncounter(s, f);
    ids.push(d.def.id);
    full.push(d.def.id + ":" + (d.mutators.slice().sort().join("+") || "-") + ":" + d.arena);
  }
  lineups.add(ids.join(","));
  mutlineups.add(full.join(","));
}
console.log(`  distinct 6-boss NAME lineups over 20k seeds: ${lineups.size} (ceiling 729)`);
console.log(`  distinct full fingerprint lineups:           ${mutlineups.size}`);

// --- 5. Does the ASK actually vary within a run? -----------------------------
const askRuns = new Map<string, number>();
for (let s = 1; s <= 20000; s++) {
  const asks = FLOORS.map((f) => bossDef(drawBossEncounter(s, f).def.id)!.ask);
  const k = [...new Set(asks)].sort().join(",");
  askRuns.set(k, (askRuns.get(k) ?? 0) + 1);
}
console.log("\n== 5. THE SET OF ASKS A SINGLE RUN SHOWS (top 8 of " + askRuns.size + ") ==");
for (const [k, n] of [...askRuns].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${(100 * n / 20000).toFixed(1).padStart(5)}%  ${k}`);
}
