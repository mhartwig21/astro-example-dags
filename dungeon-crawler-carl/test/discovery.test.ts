import { describe, it, expect } from "vitest";
import { ABILITY_INFO, unknownAbilities } from "../src/sim/abilities";
import { CONFIG } from "../src/sim/config";
import { createGame } from "../src/sim/game";

// Ultimates are the late-run spike: every discovery pool (tome drops,
// safe-room tomes, loot-box skill chips) reads unknownAbilities, so gating it
// gates them all.

describe("ultimate discovery gate", () => {
  it("keeps ultimates out of the pool before ultimateMinFloor", () => {
    const p = createGame(7).players[0];
    const early = unknownAbilities(p, CONFIG.ultimateMinFloor - 1);
    expect(early.length).toBeGreaterThan(0); // actives still drop early
    expect(early.every((a) => ABILITY_INFO[a].tier !== "ultimate")).toBe(true);
  });

  it("opens the pool at ultimateMinFloor", () => {
    const p = createGame(7).players[0];
    const late = unknownAbilities(p, CONFIG.ultimateMinFloor);
    expect(late.some((a) => ABILITY_INFO[a].tier === "ultimate")).toBe(true);
  });
});
