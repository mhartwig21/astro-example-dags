import { describe, it, expect, beforeEach } from "vitest";
import { careerBests, loadHistory, recordRun, type RunRecord } from "../src/persist/history";
import { createGame } from "../src/sim/game";

// The career ledger is browser-local; give the module an in-memory
// localStorage so record/load round-trips under node.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    endedAt: 0, mode: "random", name: "Carl", won: false, floor: 5, timeSec: 600,
    level: 8, kills: 40, damageDealt: 1000, damageTaken: 500, gold: 100,
    viewers: 2000, favorites: 10, sponsors: 1, seed: 1, ...over,
  };
}

describe("career ledger", () => {
  beforeEach(() => store.clear());

  it("records a finished run and loads it back, newest first", () => {
    const g = createGame(9);
    g.status = "dead";
    g.floor = 4;
    g.elapsed = 321.7;
    recordRun(g, { kind: "random" }, 1000);
    g.status = "won";
    recordRun(g, { kind: "daily", day: "2026-07-05" }, 2000);
    const h = loadHistory();
    expect(h).toHaveLength(2);
    expect(h[0].endedAt).toBe(2000);
    expect(h[0].mode).toBe("daily");
    expect(h[0].day).toBe("2026-07-05");
    expect(h[0].won).toBe(true);
    expect(h[1].won).toBe(false);
    expect(h[1].timeSec).toBe(322);
  });

  it("aggregates personal bests (fastest clear counts wins only)", () => {
    const bests = careerBests([
      rec({ floor: 12, kills: 300, viewers: 9000 }),
      rec({ won: true, floor: 18, timeSec: 2400 }),
      rec({ won: true, floor: 18, timeSec: 3000, kills: 500 }),
    ])!;
    expect(bests.runs).toBe(3);
    expect(bests.wins).toBe(2);
    expect(bests.bestFloor).toBe(18);
    expect(bests.fastestClearSec).toBe(2400);
    expect(bests.mostKills).toBe(500);
    expect(bests.peakViewers).toBe(9000);
  });

  it("has no bests with an empty ledger, and no fastest clear without a win", () => {
    expect(careerBests([])).toBeNull();
    expect(careerBests([rec({})])!.fastestClearSec).toBeNull();
  });
});
