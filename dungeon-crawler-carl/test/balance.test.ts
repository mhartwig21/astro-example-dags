import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";

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
    let totalDamage = 0;
    for (const seed of SEEDS) {
      const g = createGame(seed);
      const r = runBot(g, 2);
      totalDamage += r.totalDamageTaken;
    }
    // Across all seeds the bot must have been hit for at least one starting
    // health bar in aggregate — if this fails, telegraphs/damage got too soft.
    expect(totalDamage).toBeGreaterThan(100);
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
