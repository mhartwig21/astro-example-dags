/**
 * THE PLAYER-FACING COMPETITIVE ARITHMETIC (COMPETITIVE.md 3-6, 8).
 *
 * Written as the CLAIMS the post-run screen and the ladder make to a player,
 * not as coverage. Every case in the grade block was a real bug caught in the
 * screenshot pass, and each one is the kind that makes a ladder feel rigged.
 */
import { describe, expect, it } from "vitest";
import {
  bandSplitsFrom, bankedTicks, benchmark, boardsPhrase, decodeChallenge, deathContext,
  deathHeadline, deathName, encodeChallenge, ghostAt, gradeRun, leaderSplits, letterFor,
  masteryLevel, milestonesFrom, nextMilestone, playability, sealChip, signedTime,
  splitDelta, verdictSeal, worstBand,
  type BoardRun, type GhostState, type RunFacts,
} from "../src/ui/social";
import type { RunRecord } from "../src/persist/history";

const facts = (o: Partial<RunFacts> = {}): RunFacts => ({
  floor: 6, won: false, elapsedSec: 540, kills: 80, level: 14,
  damageTaken: 600, draftsClaimed: 4, draftsOffered: 5, floorsCleared: 5, ...o,
});

const history = (n: number): RunRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    endedAt: Date.now() - i * 3600_000, mode: "random" as const, name: "Carl",
    won: false, floor: 5 + (i % 4), timeSec: 500 + i * 10, level: 12, kills: 70,
    damageDealt: 4000, damageTaken: 700, gold: 100, viewers: 1000, favorites: 10,
    sponsors: 0, seed: i,
  }));

const boardRow = (o: Partial<BoardRun> = {}): BoardRun => ({
  id: "r", name: "R", publicId: "a", eventId: null, state: "verified", reason: null,
  rulesEra: "abc1234", playable: true, won: false, floor: 9, timeSec: 700, ticks: 42000,
  kills: 200, level: 20, ultimate: null, partySize: 1, attemptNo: 1, private: false,
  damageDealt: 0, damageTaken: 0, goldSpent: 0,
  bandSplits: null, death: null, build: null, verifiedAt: 1, at: 1, ...o,
});

describe("the grade (COMPETITIVE.md 6.2 Beat 1)", () => {

  it("cannot be farmed by dying instantly", () => {
    // The bug this exists to prevent: a run that ends eight seconds into floor
    // 1 clears no floors slowly and is barely hit, so THREE of the four parts
    // rewarded it. It scored a B. Two fixes hold it down now - the metrics
    // themselves (below) and the depth ceiling (next test).
    const g = gradeRun(
      facts({
        floor: 1, elapsedSec: 8, kills: 0, damageTaken: 100,
        floorsCleared: 0, draftsOffered: 0, draftsClaimed: 0,
      }),
      history(30), null, 100,
    );
    expect(g.letter).toBe("D");
    const depth = g.parts.find((p) => p.key === "DEPTH")!;
    expect(g.score).toBeLessThanOrEqual(depth.score + 25);
  });

  it("the depth ceiling binds when the other parts get generous, and says so", () => {
    // A career of slow, heavily-punished runs makes an instant death look
    // untouchable on SURVIVAL. Depth is still 1, so the letter still is not.
    const punished = history(30).map((r) => ({ ...r, damageTaken: 7000 }));
    const g = gradeRun(
      facts({
        floor: 1, elapsedSec: 8, kills: 0, damageTaken: 5,
        floorsCleared: 0, draftsOffered: 0, draftsClaimed: 0,
      }),
      punished, null, 100,
    );
    expect(g.parts.find((p) => p.key === "SURVIVAL")!.score).toBe(100);
    expect(g.basis).toContain("CAPPED BY DEPTH");
    expect(g.letter).toBe("D");
  });

  it("names the comparison set it actually had, and never one it did not", () => {
    expect(gradeRun(facts(), [], null, 100).basis).toContain("HOUSE CURVE");
    expect(gradeRun(facts(), history(27), null, 100).basis).toContain("YOUR 27 RUNS");
    const board = Array.from({ length: 9 }, (_, i) => boardRow({ id: String(i) }));
    const full = gradeRun(facts(), history(27), board, 100);
    expect(full.basis).toContain("YOUR 27 RUNS");
    expect(full.basis).toContain("9");
  });

  it("a clear is never worse than an A, however scrappy it was", () => {
    const g = gradeRun(
      facts({ floor: 18, won: true, elapsedSec: 5400, damageTaken: 9000, floorsCleared: 18 }),
      history(20), null, 100,
    );
    expect(["S", "A"]).toContain(g.letter);
  });

  it("...but the letter still SAYS something: a scrappy clear is not an S", () => {
    // The old floor was `score = max(score, 76)`, which pinned EVERY clear to
    // exactly A - so the biggest glyph on the screen carried no information on
    // the one result that matters most. A clear now spends the top of the
    // scale, and has to earn the top of it.
    const scrappy = gradeRun(
      facts({ floor: 18, won: true, elapsedSec: 5400, kills: 30, damageTaken: 12000, floorsCleared: 18,
        draftsClaimed: 0, draftsOffered: 8 }),
      history(20), null, 100,
    );
    const dominant = gradeRun(
      facts({ floor: 18, won: true, elapsedSec: 900, kills: 900, damageTaken: 200, floorsCleared: 18,
        draftsClaimed: 9, draftsOffered: 9 }),
      history(20), null, 100,
    );
    expect(scrappy.score).toBeGreaterThanOrEqual(76); // still never worse than A
    expect(dominant.score).toBeGreaterThan(scrappy.score);
    expect(dominant.letter).toBe("S");
    expect(scrappy.letter).toBe("A");
  });

  it("a HANDED depth scores the meter, not just the caption (test chamber)", () => {
    // The tile's DETAIL string used to be rewritten to "started here, not
    // walked" while its SCORE stayed at 100, so a gold 100/100 DEPTH meter sat
    // forty pixels above a red TEST CHAMBER - NOT RANKED banner. Two elements
    // asserting opposite things about the same number, on a grade the design
    // calls auditable.
    const handed = gradeRun(
      facts({ floor: 18, won: true, elapsedSec: 8, floorsCleared: 0, startedAtDepth: true }),
      history(30), null, 100,
    );
    const depth = handed.parts.find((p) => p.key === "DEPTH")!;
    expect(depth.detail).toContain("started here, not walked");
    expect(depth.score).toBeLessThan(20);
    // ...and a handed clear does not collect the clear's letter either.
    expect(handed.letter).not.toBe("S");
  });

  it("TEMPO refuses to divide by floors nobody walked (test-chamber start)", () => {
    // Dropped at floor 13 and dead five seconds later: twelve floors were
    // never cleared, so the pace is not 0s per floor - there is no pace.
    const g = gradeRun(facts({ floor: 13, elapsedSec: 5, floorsCleared: 0, kills: 0 }), history(30), null, 700);
    const tempo = g.parts.find((p) => p.key === "TEMPO")!;
    expect(tempo.detail).toContain("no floor cleared");
    expect(tempo.score).toBeLessThan(50);
  });

  it("SURVIVAL is how long a health bar lasted, so a fast death scores badly", () => {
    const g = gradeRun(facts({ floor: 1, elapsedSec: 8, damageTaken: 100, floorsCleared: 0 }), [], null, 100);
    const s = g.parts.find((p) => p.key === "SURVIVAL")!;
    expect(s.detail).toContain("lasted you 8s");
    expect(s.score).toBeLessThan(20);
  });

  it("letters are ordered and total", () => {
    expect(letterFor(100)).toBe("S");
    expect(letterFor(0)).toBe("D");
    expect(letterFor(74)).toBe("A");
    expect(letterFor(73)).toBe("B");
  });
});

describe("the death, named (6.2 Beat 3)", () => {
  it("prefers the announcer name and humanizes a raw sim id", () => {
    expect(deathName({ by: "brute", dmg: 1, hpBefore: 1, maxHp: 1 })).toBe("BRUTE");
    expect(deathName({ by: "brute", label: "The Foreman", dmg: 1, hpBefore: 1, maxHp: 1 }))
      .toBe("THE FOREMAN");
    // A database row is not a memorable sentence.
    expect(deathName({ by: "hazard:blast", dmg: 1, hpBefore: 1, maxHp: 1 })).toBe("A BLAST TRAP");
  });

  it("reports the damage against the bar it came off", () => {
    expect(deathHeadline({ by: "brute", label: "THE FOREMAN", dmg: 340, hpBefore: 212, maxHp: 340 }))
      .toBe("THE FOREMAN — 340 damage, from 62% HP.");
    expect(deathHeadline(null)).toBe("");
  });

  it("never pads: an empty context says so instead of inventing a lesson", () => {
    expect(deathContext({ ready: [], flasks: 0, unclaimedDrafts: 0 })).toContain("nothing left");
    expect(deathContext({ ready: ["Dash"], flasks: 2, unclaimedDrafts: 1 }))
      .toBe("Dash was up. You died holding 2 flasks and 1 unclaimed draft.");
  });
});

describe("splits and ghosts (3.3, 4.1)", () => {
  it("bands the floor-entry ticks the same way the verifier does", () => {
    const entries = new Array<number>(18).fill(-1);
    entries[0] = 0; entries[1] = 600; entries[2] = 1500; entries[3] = 2400;
    const bands = bandSplitsFrom(entries, 3000);
    expect(bands[0]).toBe(2400); // floors 1-3
    expect(bands[1]).toBe(600); // floor 4 to the end of the run
    expect(bands.slice(2).every((b) => b === 0)).toBe(true);
  });

  it("names the band where the run was lost, and nothing when there is no reference", () => {
    const mk = (band: number, ticks: number, pb: number | null) =>
      ({ band, name: "B", ticks, pbTicks: pb, leaderTicks: null });
    expect(worstBand([mk(0, 900, 800), mk(1, 2000, 1200)])).toBe(1);
    expect(worstBand([mk(0, 900, null), mk(1, 2000, null)])).toBe(-1);
  });

  it("LOST HERE is measured against the FIELD as well as against yourself", () => {
    // Beat 4 is "your time per band vs your PB vs the board leader". With
    // leaderTicks hardcoded null, the worst band could only ever be the one
    // you had a bad day on - never the one the field walks and you crawl.
    const rows = [
      { band: 0, name: "A", ticks: 1000, pbTicks: 950, leaderTicks: 900 },
      { band: 1, name: "B", ticks: 1400, pbTicks: 1390, leaderTicks: 600 },
    ];
    expect(worstBand(rows)).toBe(1); // 800 behind the leader beats 50 behind your PB
  });

  it("the leader's splits come off a SEALED row in the CURRENT era, or not at all", () => {
    const splits = [600, 700, 0, 0, 0, 0];
    // A claim is not a benchmark...
    expect(leaderSplits([boardRow({ state: "claimed", bandSplits: splits })], "abc1234")
      .every((t) => t === null)).toBe(true);
    // ...and neither is a row sealed under numbers this build no longer runs.
    expect(leaderSplits([boardRow({ rulesEra: "0000000", bandSplits: splits })], "abc1234")
      .every((t) => t === null)).toBe(true);
    const ok = leaderSplits([boardRow({ bandSplits: splits })], "abc1234");
    expect(ok[0]).toBe(600);
    expect(ok[2]).toBeNull(); // a band the leader never walked is not a zero
  });

  it("a ghost that has finished its run is off the floor, not frozen on it", () => {
    const g: GhostState = {
      label: "RIVAL", ticks: 60,
      track: { hz: 10, x: [1, 2], y: [3, 4], floor: [1, 1] },
      floorEntryTicks: [0, 600, -1],
    };
    expect(ghostAt(g, 0)).toEqual({ x: 1, y: 3, floor: 1 });
    expect(ghostAt(g, 600)).toBeNull();
    // Positive is BEHIND; a floor they never reached has no number at all.
    expect(splitDelta(g, 2, 900)).toBe(5);
    expect(splitDelta(g, 3, 900)).toBeNull();
    expect(signedTime(75)).toBe("+1:15");
    expect(signedTime(-4)).toContain("4.0s");
  });
});

describe("seals, eras and what may be raced (2.4, 2.6f)", () => {
  it("a private run ranks with a lock, and is never handed out", () => {
    expect(sealChip("verified", "abc1234", true).label).toContain("PRIVATE");
    expect(playability(boardRow({ private: true }), "abc1234").ok).toBe(false);
  });

  it("refuses a foreign era LOUDLY, with the era named on the button", () => {
    const p = playability(boardRow({ rulesEra: "0000000" }), "abc1234");
    expect(p.ok).toBe(false);
    expect(p.why).toContain("RULES ERA 0000000");
    expect(p.why).toContain("abc1234");
  });

  it("an unproven row is shown, and says so", () => {
    expect(sealChip("claimed", null).label).toBe("CLAIMED");
    expect(playability(boardRow({ state: "claimed" }), "abc1234").ok).toBe(false);
    expect(sealChip("unverifiable", "0000000").title).toContain("keeps whatever it earned");
  });

  it("the verdict's seal is a BLOCK with a sentence, not a chip with a tooltip", () => {
    // 6 Beat 5: watching the seal land is "two genuinely satisfying seconds
    // ... the moment the trust model becomes something the player can feel".
    // A 10.5px label swap is not a way to say that, and a rejection whose only
    // explanation lives in a title= attribute is how honest players conclude
    // the ladder is rigged.
    const sealed = verdictSeal("verified", "abc1234", false, true);
    expect(sealed.word).toBe("SEALED");
    expect(sealed.line).toContain("board position");
    expect(sealed.line).toContain("abc1234");
    expect(sealed.terminal).toBe(true);
    // A certified run that ranks nowhere is true and is not a trophy.
    expect(verdictSeal("verified", "abc1234", false, false).line).toContain("ranks nowhere");
    expect(verdictSeal("verified", "abc1234", true, true).word).toContain("PRIVATE");
    // VERIFYING is the only non-terminal state: it breathes, it never stamps.
    expect(verdictSeal("verifying", null).terminal).toBe(false);
    // The refusal, and its reason, on the DEFAULT face.
    const no = verdictSeal("rejected", null, false, false, "cooling down after a rejected submission");
    expect(no.word).toBe("REFUSED");
    expect(no.line).toContain("cooling down");
  });
});

describe("sharing (8.2)", () => {
  it("round-trips a challenge in about a chat message", () => {
    const c = {
      seed: 2698932116, ev: "daily-2026-08-02", by: "Donut Holes", floor: 18,
      won: true, timeSec: 902, kills: 641, level: 34, ult: "airstrike", run: "seed-1",
    };
    const code = encodeChallenge(c);
    expect(code.length).toBeLessThan(140);
    expect(decodeChallenge(code)).toEqual(c);
  });

  it("refuses garbage rather than launching a wrong dungeon", () => {
    expect(decodeChallenge("not-a-code")).toBeNull();
    expect(decodeChallenge(btoa("[9,1]"))).toBeNull();
  });
});

describe("career surfaces (5.2)", () => {
  it("mastery levels come fast and then slow down", () => {
    expect(masteryLevel(0)).toEqual({ level: 0, into: 0, need: 60 });
    expect(masteryLevel(60).level).toBe(1);
    expect(masteryLevel(1180).level).toBeGreaterThan(4);
  });

  it("milestones are dated, newest first, and only fire once", () => {
    const h = history(6).map((r, i) => ({ ...r, floor: i < 3 ? 3 : 7, endedAt: 1000 + i }));
    const m = milestonesFrom(h);
    expect(m.filter((x) => x.title === "FIRST FLOOR 3")).toHaveLength(1);
    expect(m[0].at).toBeGreaterThanOrEqual(m[m.length - 1].at);
  });
});

describe("the seal is weighted by what it CERTIFIES (6.2)", () => {
  it("names the boards a sealed run actually holds", () => {
    // `ranked` used to mean "is my run id in todaysBoard", and todaysBoard is
    // the DAILY CONTRACT deepest board - so a free-seed run taking rank 1
    // all-time got the plain hairline and the line "It ranks nowhere, and it
    // is still true", which is false about the run that most deserved the
    // gold. The server now answers with the board keys the row occupies.
    const held = verdictSeal("verified", "abc1234", false, true, null,
      ["deepest", "kills@daily-2026-08-02", "band0"]);
    expect(held.cls).toContain("ranked");
    expect(held.line).toContain("DEEPEST");
    expect(held.line).toContain("THE UNDERCROFT");

    const nowhere = verdictSeal("verified", "abc1234", false, false, null, []);
    expect(nowhere.cls).not.toContain("ranked");
    expect(nowhere.line).toContain("It ranks nowhere");
  });

  it("does not spend the word SEALED on a recording nobody has seen", () => {
    // The pre-submit kicker read "THE RECORDING IS SEALED AGAINST THE RUN"
    // ninety pixels above the word the whole trust model rests on - spending
    // the one term that means "the server re-executed this" on "hashed
    // locally, nothing sent".
    const pending = verdictSeal("unsubmitted", null);
    expect(pending.word).toBe("READY TO SUBMIT");
    expect(pending.kicker).not.toMatch(/SEAL/i);
    expect(pending.line).not.toMatch(/sealed/i);
  });

  it("boardsPhrase reads board keys as words, and says nothing about nothing", () => {
    expect(boardsPhrase([])).toBe("");
    expect(boardsPhrase(null)).toBe("");
    expect(boardsPhrase(["fastest@daily-2026-08-02", "fastest"])).toBe("FASTEST");
    expect(boardsPhrase(["deepest", "kills", "band0", "band3"])).toContain("and 1 more");
  });
});

describe("the default state compares you to somebody (6 Beat 2)", () => {
  it("uses the sealed leader of today's contract when there is one", () => {
    const b = benchmark({ floor: 3, won: false, elapsedSec: 120 },
      [boardRow({ name: "Donut Holes", floor: 9, kills: 200 })], 7)!;
    expect(b.who).toBe("DONUT HOLES");
    expect(b.gap).toContain("6 floors short");
    expect(b.ahead).toBe(false);
    expect(b.source).toContain("sealed rows only");
  });

  it("never treats an unproven row as the mark", () => {
    const b = benchmark({ floor: 3, won: false, elapsedSec: 120 },
      [boardRow({ state: "claimed", floor: 18 })], 7)!;
    expect(b.who).toBe("YOUR OWN DEEPEST");
  });

  it("falls back to your own ledger offline, and names that population", () => {
    const b = benchmark({ floor: 9, won: false, elapsedSec: 400 }, null, 7)!;
    expect(b.who).toBe("YOUR OWN DEEPEST");
    expect(b.gap).toBe("2 floors past it");
    expect(b.ahead).toBe(true);
    expect(b.source).toContain("this browser");
    // Nothing to compare against at all is a state, not a fabricated one.
    expect(benchmark({ floor: 1, won: false, elapsedSec: 4 }, null, 0)).toBeNull();
  });
});

describe("every run banks something (6 Beat 5)", () => {
  it("always ticks the episode, even when the run banked nothing else", () => {
    // A floor-3 death produced "+0 CP", "It ranks nowhere" and "no personal
    // bests this run": three of the four blocks saying nothing happened.
    const t = bankedTicks(history(4), 31, { kills: 0, timeSec: 40, floor: 3 });
    expect(t[0]).toEqual({ label: "EPISODE", value: "#31", delta: "filed" });
    expect(t.length).toBeGreaterThanOrEqual(2);
    // No kills means no kill line - a "+0" tick is the thing this exists to
    // stop, not a thing to add more of.
    expect(t.some((x) => x.label === "CAREER KILLS")).toBe(false);
    expect(bankedTicks(history(4), 31, { kills: 12, timeSec: 40, floor: 3 })
      .find((x) => x.label === "CAREER KILLS")?.delta).toBe("+12");
  });

  it("names the next thing to aim at instead of an empty ledger", () => {
    expect(nextMilestone(0, false).title).toBe("REACH FLOOR 3");
    expect(nextMilestone(7, false).title).toBe("REACH FLOOR 9");
    expect(nextMilestone(18, false).title).toBe("WALK OUT AGAIN, FASTER");
    expect(nextMilestone(4, true).title).toBe("WALK OUT AGAIN, FASTER");
  });
});
