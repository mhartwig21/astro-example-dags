/**
 * DEATH IS A DOOR (NICHE.md 4.7) — the sim rule and the race-end arithmetic.
 *
 * The claims, as the doc states them: in-race death is a timeout, never a run
 * end; CONCEDE is a second door available exactly while downed; conceding is
 * terminal (no revive) and deterministic (a sim rule, not a host courtesy);
 * the race only ends by forfeit when EVERY seat has walked; and every seat —
 * conceded included — leaves the race with a superlative, all different.
 */
import { describe, expect, it } from "vitest";
import { addPlayer, concedeRival, createGame, handlePlayerDeath, step } from "../src/sim/game";
import { serialize } from "../src/sim/snapshot";
import { NO_INTENT, type GameState } from "../src/sim/types";
import { raceSuperlatives, headlineLine, type SeatSummary } from "../src/server/superlatives";

function race(seed = 4207): GameState {
  const g = createGame(seed, "rivals", "race");
  addPlayer(g, "Donut");
  return g;
}

const tick = (g: GameState, n: number): void => {
  for (let i = 0; i < n; i++) step(g, { 1: NO_INTENT, 2: NO_INTENT }, 1 / 30);
};

describe("CONCEDE, the sim rule", () => {
  it("is a door that only exists while downed, in rivals", () => {
    const g = race();
    const [carl, donut] = g.players;
    expect(concedeRival(g, carl.id)).toBe(false); // alive: no door
    handlePlayerDeath(g, donut, "test");
    expect(g.status).toBe("playing"); // rivals death is a timeout, not a run end
    expect(donut.downedT).toBeGreaterThan(0);
    expect(concedeRival(g, donut.id)).toBe(true);
    expect(donut.conceded).toBe(true);
    expect(concedeRival(g, donut.id)).toBe(false); // already out — idempotent
    // Co-op has no concede: the party stabilizes you or descends.
    const coop = createGame(7, "coop", "race");
    handlePlayerDeath(coop, coop.players[0], "test");
    expect(concedeRival(coop, coop.players[0].id)).toBe(false);
  });

  it("is terminal: the 15-second clock stops and no revive ever comes", () => {
    const g = race();
    const donut = g.players[1];
    handlePlayerDeath(g, donut, "test");
    concedeRival(g, donut.id);
    expect(donut.downedT).toBe(0);
    tick(g, 30 * 20); // 20 sim-seconds — past any revive timer
    expect(donut.alive).toBe(false);
    expect(donut.conceded).toBe(true);
    expect(g.status).toBe("playing"); // the race runs on without them
  });

  it("keeps fighting as the default: an untouched downed rival still revives", () => {
    const g = race();
    const donut = g.players[1];
    handlePlayerDeath(g, donut, "test");
    tick(g, 30 * 20);
    expect(donut.alive).toBe(true); // KEEP FIGHTING costs no input at all
  });

  it("ends the race by forfeit only when EVERY seat concedes", () => {
    const g = race();
    const [carl, donut] = g.players;
    handlePlayerDeath(g, donut, "test");
    concedeRival(g, donut.id);
    expect(g.status).toBe("playing");
    handlePlayerDeath(g, carl, "test");
    concedeRival(g, carl.id);
    expect(g.status).toBe("dead");
    expect(g.announcements.some((a) => /FORFEIT/i.test(a.text))).toBe(true);
  });

  it("is deterministic: two identical races with the same concede diverge nowhere", () => {
    const run = (): string => {
      const g = race(991);
      tick(g, 60);
      handlePlayerDeath(g, g.players[1], "test");
      concedeRival(g, g.players[1].id);
      tick(g, 120);
      return serialize(g);
    };
    expect(run()).toBe(run());
  });
});

describe("race-end superlatives (4.7: four seats, four different headlines)", () => {
  const seat = (o: Partial<SeatSummary>): SeatSummary => ({
    id: 1, name: "A", won: false, floor: 3, kills: 10, damageDealt: 500,
    damageTaken: 300, gold: 40, level: 5, conceded: false, ...o,
  });

  it("every seat gets one, all different, and the winner gets the crown", () => {
    const seats = [
      seat({ id: 1, name: "Carl", won: true, floor: 18, kills: 200 }),
      seat({ id: 2, name: "Donut", floor: 9, kills: 120, damageDealt: 9000 }),
      seat({ id: 3, name: "Imani", floor: 7, kills: 80, damageTaken: 4000 }),
      seat({ id: 4, name: "Katia", floor: 4, kills: 20, gold: 900 }),
    ];
    const s = raceSuperlatives(seats);
    expect(s.size).toBe(4);
    expect(s.get(1)).toMatch(/^TOOK THE DUNGEON/);
    expect(new Set(s.values()).size).toBe(4); // four DIFFERENT headlines
  });

  it("a conceded seat still leaves with a line, wearing the doc's exact framing", () => {
    const s = raceSuperlatives([
      seat({ id: 1, won: true }),
      seat({ id: 2, name: "Quitter", conceded: true, damageDealt: 9999 }),
    ]);
    expect(s.get(2)).toMatch(/^DIED EARLY, DIED SPECTACULARLY: /);
    // ...and the next-session delivery line is System-addressed.
    expect(headlineLine("Quitter", s.get(2)!)).toMatch(/^THE SYSTEM, RE: QUITTER'S LAST RACE — DIED EARLY/);
  });

  it("a seat that leads nothing is respected for attendance, never blank", () => {
    const s = raceSuperlatives([
      seat({ id: 1, floor: 9, kills: 50, damageDealt: 5000, damageTaken: 2000, gold: 500, level: 12 }),
      seat({ id: 2, name: "Fresh", floor: 0, kills: 0, damageDealt: 0, damageTaken: 0, gold: 0, level: 0 }),
    ]);
    expect(s.get(2)).toBe("SHOWED UP. THE SYSTEM RESPECTS ATTENDANCE.");
    expect(s.get(1)).toBeTruthy();
  });

  it("depth always carries its scale (OF 18) when it is the headline", () => {
    const s = raceSuperlatives([
      seat({ id: 1, floor: 11 }),
      seat({ id: 2, kills: 999, floor: 2 }),
    ]);
    expect(s.get(1)).toContain("FLOOR 11 OF 18");
  });
});
