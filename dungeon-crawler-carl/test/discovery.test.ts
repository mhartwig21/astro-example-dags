import { describe, it, expect } from "vitest";
import { ABILITY_INFO, DISCOVERABLE_ABILITIES, tomeSchedule, unknownAbilities } from "../src/sim/abilities";
import { CONFIG } from "../src/sim/config";
import { createGame } from "../src/sim/game";

// Ultimates are the late-run spike: every discovery pool (tome drops,
// safe-room tomes, loot-box skill chips) reads unknownAbilities, so gating it
// gates them all. Pacing (tomeSchedule) is a SEPARATE, level-based gate on top
// of the ultimate floor gate — see abilities.ts.

describe("ultimate discovery gate", () => {
  it("keeps ultimates out of the pool before ultimateMinFloor", () => {
    const p = createGame(7).players[0];
    p.level = 30; // past every schedule threshold, so only the floor gate is in play
    const early = unknownAbilities(p, CONFIG.ultimateMinFloor - 1, 7);
    expect(early.length).toBeGreaterThan(0); // actives still drop early
    expect(early.every((a) => ABILITY_INFO[a].tier !== "ultimate")).toBe(true);
  });

  it("opens the pool at ultimateMinFloor", () => {
    const p = createGame(7).players[0];
    p.level = 30;
    const late = unknownAbilities(p, CONFIG.ultimateMinFloor, 7);
    expect(late.some((a) => ABILITY_INFO[a].tier === "ultimate")).toBe(true);
  });
});

describe("tome pacing (level-gated discovery)", () => {
  it("gates discovery by level: nothing is eligible before the schedule opens", () => {
    const p = createGame(11).players[0];
    p.level = 1;
    const pool = unknownAbilities(p, 1, 11);
    expect(pool.length).toBe(0);
  });

  it("opens roughly every ~2 levels, with jitter — not all at once", () => {
    const schedule = tomeSchedule(11);
    const levels = DISCOVERABLE_ABILITIES.map((a) => schedule[a]!).sort((a, b) => a - b);
    expect(levels).toHaveLength(DISCOVERABLE_ABILITIES.length);
    // Spacing between consecutive unlocks should vary (some faster, some
    // slower) — not a rigid fixed cadence.
    const gaps = levels.slice(1).map((l, i) => l - levels[i]);
    expect(new Set(gaps).size).toBeGreaterThan(1);
    // Full constellation lands well within a full 18-floor run's leveling curve
    // (worst case: 10 unlocks x up to 3 levels of jitter each, from a floor of 1).
    expect(levels[levels.length - 1]).toBeLessThan(32);
  });

  it("is deterministic per seed", () => {
    expect(tomeSchedule(42)).toEqual(tomeSchedule(42));
  });

  it("everything is discoverable by a sufficiently high level (no orphaned abilities)", () => {
    const p = createGame(23).players[0];
    p.level = 30;
    const pool = unknownAbilities(p, CONFIG.ultimateMinFloor, 23);
    expect(pool.length).toBe(DISCOVERABLE_ABILITIES.length);
  });
});
