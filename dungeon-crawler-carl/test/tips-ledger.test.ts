import { describe, it, expect, beforeEach } from "vitest";
import { knownTips, loadRun, recordTips, seedTips, saveRun } from "../src/persist/save";
import { createGame, step } from "../src/sim/game";
import type { Intent } from "../src/sim/types";

// The browser-level seen-tips ledger (dcc:tips:v1): first-contact tips are
// once EVER, not once per run — a fresh character in a new run gets seeded
// with everything this browser has already been SHOWN. In-memory localStorage,
// same pattern as the career ledger's tests.
//
// r4 blocker 1 moved the write. `Player.tipsSeen` is the sim's within-run
// latch; the once-EVER ledger belongs to PRESENTATION, and only the host's
// card-display path (or an explicit refusal of the teaching) may write it.
// saveRun used to mirror tipsSeen into the ledger on every save, which spent
// tips the sim had merely GENERATED — cold runs were measured consuming
// `favorites` and `achievementClaim` without ever painting them, permanently.
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

  it("saveRun does NOT feed the ledger — only presentation does (r4 blocker 1)", () => {
    const run1 = createGame(31);
    (run1.players[0].tipsSeen ??= []).push("bolt");
    saveRun(run1);
    // The sim generated it. Nobody showed it. It is not spent.
    expect(knownTips()).not.toContain("bolt");

    // recordTips is what the card-display path calls, and it is the only
    // thing in the client that turns a tip into a once-EVER fact.
    recordTips(["bolt"]);
    expect(knownTips()).toContain("bolt");

    const run2 = createGame(32); // a brand-new run: fresh character
    expect(run2.players[0].tipsSeen ?? []).toEqual([]);
    seedTips(run2.players[0]);
    expect(run2.players[0].tipsSeen).toContain("bolt");
  });

  it("an UNSHOWN tip does not survive the run save either", () => {
    // The same wound one layer down: a refresh mid-run must not resume a
    // character who is already "done" with a rule nobody ever explained.
    const run = createGame(35);
    step(run, boltIntent, 1 / 60);
    expect(run.players[0].tipsSeen).toContain("bolt"); // the sim's within-run latch
    saveRun(run);
    expect(loadRun()!.player.tipsSeen ?? []).not.toContain("bolt");

    // Once it has actually been shown, the run save keeps it.
    recordTips(["bolt"]);
    saveRun(run);
    expect(loadRun()!.player.tipsSeen).toContain("bolt");
  });

  it("the user's complaint, end to end: a tip SHOWN last run never re-fires this run", () => {
    // Run 1: first bolt cast — the System files its courtesy explanation, and
    // the host paints the card (recordTips is that paint, in this test).
    const run1 = createGame(33);
    step(run1, boltIntent, 1 / 60);
    expect(run1.players[0].tipsSeen).toContain("bolt");
    const card = run1.announcements.find((a) => a.kind === "tip");
    expect(card).toBeTruthy();
    // The line carries the id presentation needs to spend it (r4).
    expect(card!.tipId).toBe("bolt");
    recordTips([card!.tipId!]);
    saveRun(run1);

    // Run 2 (new character, new dungeon): seeded from the ledger — silence.
    const run2 = createGame(34);
    seedTips(run2.players[0]);
    step(run2, boltIntent, 1 / 60);
    expect(run2.announcements.some((a) => a.kind === "tip")).toBe(false);
  });

  it("the other half: a tip NEVER shown gets another run to teach the concept", () => {
    // This is the whole point of r4 blocker 1. Run 1 generates the tip into a
    // display queue that dies with the run; run 2 must still be able to teach
    // it, because the concept was never actually delivered to anyone.
    const run1 = createGame(33);
    step(run1, boltIntent, 1 / 60);
    expect(run1.announcements.some((a) => a.kind === "tip")).toBe(true);
    saveRun(run1); // ...and no card ever painted.

    const run2 = createGame(34);
    seedTips(run2.players[0]);
    step(run2, boltIntent, 1 / 60);
    const again = run2.announcements.find((a) => a.kind === "tip");
    expect(again?.tipId).toBe("bolt");
  });

  it("every tip announcement carries its id — a card cannot spend what it can't name", () => {
    const run = createGame(37);
    step(run, boltIntent, 1 / 60);
    for (const a of run.announcements) {
      if (a.kind === "tip") expect(typeof a.tipId).toBe("string");
      else expect(a.tipId).toBeUndefined(); // nothing else may touch the ledger
    }
  });
});
