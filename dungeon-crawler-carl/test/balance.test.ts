import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGame, restoreGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";

// Playability invariants, measured by the scripted balance bot (src/sim/bot.ts).
// These are the regression net for tuning: if a damage/timer/economy change
// makes the early game unclearable (or trivial), this file fails — no manual
// playtest required. Seeds are fixed and the sim is deterministic, so results
// are exactly reproducible; when a deliberate balance change shifts an
// assertion band, re-tune the band consciously in the same commit.

const SEEDS = [11, 47, 101, 555, 2024, 90210];

describe("determinism guard", () => {
  it("keeps wall-clock and unseeded randomness out of src/sim/", () => {
    const simDir = join(__dirname, "..", "src", "sim");
    for (const file of readdirSync(simDir)) {
      if (!file.endsWith(".ts")) continue;
      // Strip comments first — rng.ts legitimately SAYS "no Math.random".
      const source = readFileSync(join(simDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const banned of [/Math\.random/, /Date\.now/, /performance\.now/]) {
        expect(
          banned.test(source),
          `${file} uses ${banned} — sim code must stay deterministic (seeded RNG + dt only)`,
        ).toBe(false);
      }
    }
  });
});

describe("balance bot: early-game playability", () => {
  it("a competent bot survives and clears floors 1-2 before collapse (all seeds)", () => {
    for (const seed of SEEDS) {
      const g = createGame(seed);
      const r = runBot(g, 2);
      expect(r.died, `seed ${seed}: bot died on floor ${g.floor}`).toBe(false);
      expect(r.floorsCleared, `seed ${seed}: cleared ${r.floorsCleared}/2 floors in ${r.steps} steps`).toBe(2);
      for (const f of r.floors) {
        expect(f.timeRemaining, `seed ${seed}: floor ${f.floor} cleared after collapse started`).toBeGreaterThan(0);
      }
    }
  });

  it("the dungeon still bites: the bot takes real damage on the way down", () => {
    // Three floors, not two: a competent dodging bot gets through floors 1-2
    // nearly clean (that's telegraphs working), but by floor 3 the archetype
    // mix + elite affixes must be landing real hits. Measured baseline ~500.
    let totalDamage = 0;
    for (const seed of SEEDS) {
      const g = createGame(seed);
      const r = runBot(g, 3);
      totalDamage += r.totalDamageTaken;
    }
    expect(totalDamage).toBeGreaterThan(150);
  });

  it("progress is fueled by combat, not corridor-running", () => {
    const g = createGame(SEEDS[0]);
    const r = runBot(g, 2);
    expect(r.totalKills).toBeGreaterThan(5);
  });

  it("emits per-floor metrics for tuning sweeps", () => {
    const g = createGame(SEEDS[1]);
    const r = runBot(g, 2);
    expect(r.floors).toHaveLength(2);
    for (const f of r.floors) {
      expect(f.simSeconds).toBeGreaterThan(0);
      expect(f.kills).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("balance bot: boss difficulty", () => {
  // Reference builds measured from successful deep bot runs: the level /
  // effective damage / max HP a shopping player brings to each boss arena.
  // The invariant is "never killed FAST" — a bot that dies trying passes;
  // a boss that folds under the minimum time is the regression (that's the
  // one-shot bug class this suite was built after).
  const ARENAS = [
    { floor: 6, level: 11, dmg: 110, hp: 550, minTtk: 12 },
    { floor: 12, level: 16, dmg: 195, hp: 900, minTtk: 15 },
    { floor: CONFIG.finalFloor, level: 19, dmg: 315, hp: 1100, minTtk: 20 },
  ];

  function arena(seed: number, b: (typeof ARENAS)[number]) {
    const intrinsicDmg = CONFIG.playerBaseDamage + (b.level - 1) * CONFIG.damagePerLevel;
    const intrinsicHp = CONFIG.playerMaxHp + (b.level - 1) * CONFIG.hpPerLevel;
    const g = restoreGame({
      seed, floor: b.floor,
      player: {
        hp: b.hp, level: b.level, xp: 0, xpToNext: 99999, gold: 0,
        bonusDamage: Math.max(0, b.dmg - intrinsicDmg),
        bonusMaxHp: Math.max(0, b.hp - intrinsicHp),
      },
    });
    return runBot(g, 1, 40_000);
  }

  it("boss arenas are fights, not screenshots (reference builds, fixed seeds)", () => {
    for (const seed of [7, 99]) {
      for (const b of ARENAS) {
        const r = arena(seed, b);
        const boss = r.encounters.find((e) => e.kind === "boss");
        if (!boss) {
          // The boss won. Brutal, but the opposite failure from "too easy".
          expect(r.died, `seed ${seed} floor ${b.floor}: no boss fight recorded and the bot survived?`).toBe(true);
          continue;
        }
        expect(
          boss.ttk,
          `seed ${seed} floor ${b.floor}: boss died in ${boss.ttk.toFixed(1)}s — under the ${b.minTtk}s floor`,
        ).toBeGreaterThanOrEqual(b.minTtk);
      }
    }
  });

  it("bosses hit back: reference fights cost real health", () => {
    let totalLost = 0;
    for (const b of ARENAS) {
      const r = arena(99, b);
      const boss = r.encounters.find((e) => e.kind === "boss");
      if (boss) totalLost += boss.hpLost;
    }
    expect(totalLost).toBeGreaterThan(100);
  });

  it("early elites are never one-shot (first encounter of a fresh run)", () => {
    for (const seed of [101, 2024]) {
      const g = createGame(seed);
      const r = runBot(g, 4);
      const first = r.encounters.find((e) => e.kind === "elite");
      if (!first) continue; // bot bypassed or died before the first elite — other tests cover survival
      expect(
        first.ttk,
        `seed ${seed}: first elite (floor ${first.floor}) died in ${first.ttk.toFixed(1)}s`,
      ).toBeGreaterThanOrEqual(2.5);
    }
  });
});
