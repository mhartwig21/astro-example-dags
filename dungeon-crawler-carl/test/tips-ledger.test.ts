import { describe, it, expect, beforeEach } from "vitest";
import { knownTips, recordTips, seedTips, saveRun } from "../src/persist/save";
import { createGame, step } from "../src/sim/game";
import type { Intent } from "../src/sim/types";

// The browser-level seen-tips ledger (dcc:tips:v1): first-contact tips are
// once EVER, not once per run — a fresh character in a new run gets seeded
// with everything this browser has already been shown. In-memory localStorage,
// same pattern as the career ledger's tests.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const boltIntent: Intent = { move: { x: 0, y: 0 }, useStairs: false, bolt: true, aim: { x: 1, y: 0 } };

describe("seen-tips ledger (browser-level, outlives runs)", () => {
  beforeEach(() => store.clear());

  it("records union, never dupes, survives garbage", () => {
    expect(knownTips()).toEqual([]);
    recordTips(["bolt", "stagger"]);
    recordTips(["bolt", "lowhp"]);
    expect(knownTips().sort()).toEqual(["bolt", "lowhp", "stagger"]);
    store.set("dcc:tips:v1", "{not json");
    expect(knownTips()).toEqual([]); // corrupt ledger degrades to empty, not a crash
  });

  it("saveRun feeds the ledger; seedTips hands it to the next character", () => {
    const run1 = createGame(31);
    (run1.players[0].tipsSeen ??= []).push("bolt");
    saveRun(run1);
    expect(knownTips()).toContain("bolt");

    const run2 = createGame(32); // a brand-new run: fresh character
    expect(run2.players[0].tipsSeen ?? []).toEqual([]);
    seedTips(run2.players[0]);
    expect(run2.players[0].tipsSeen).toContain("bolt");
  });

  it("the user's complaint, end to end: a tip shown last run never re-fires this run", () => {
    // Run 1: first bolt cast — the System files its courtesy explanation.
    const run1 = createGame(33);
    step(run1, boltIntent, 1 / 60);
    expect(run1.players[0].tipsSeen).toContain("bolt");
    expect(run1.announcements.some((a) => a.kind === "tip")).toBe(true);
    saveRun(run1);

    // Run 2 (new character, new dungeon): seeded from the ledger — silence.
    const run2 = createGame(34);
    seedTips(run2.players[0]);
    step(run2, boltIntent, 1 / 60);
    expect(run2.announcements.some((a) => a.kind === "tip")).toBe(false);
  });
});
