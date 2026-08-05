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
  deathHeadline, deathName, encodeChallenge, gradeRun, leaderSplits, letterFor,
  masteryLevel, milestonesFrom, nextMilestone, sealChip, signedTime,
  verdictSeal, worstBand,
  boardLeader, count, provenanceOf, rulesetLabel,
  sealHoldMs, SEAL_CASCADE_MS, SEAL_MIN_PENDING_MS,
  resultCardText, raceCardText, claimBanner, claimVerdict,
  type BoardRun, type RunFacts,
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
    // ...and the caveat names what the PLAYER can see. It used to read
    // "CAPPED BY DEPTH", a note about the composite score — which is no longer
    // rendered on any surface since the letter left THE VERDICT, so it was a
    // caveat about a number that does not exist in the product.
    expect(g.basis).toContain("THE OTHER MEASURES FLATTER IT");
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

describe("band splits (3.3)", () => {
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

  it("the signed clock keeps its sign and its sub-minute precision", () => {
    expect(signedTime(75)).toBe("+1:15");
    expect(signedTime(-4)).toContain("4.0s");
  });
});

describe("seals and eras (2.4, 2.6f)", () => {
  it("a private run ranks with a lock", () => {
    expect(sealChip("verified", "abc1234", true).label).toContain("PRIVATE");
  });

  it("an unproven row is shown, and says so", () => {
    expect(sealChip("claimed", null).label).toBe("CLAIMED");
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
      won: true, timeSec: 902, kills: 641, level: 34, ult: "airstrike",
    };
    const code = encodeChallenge(c);
    expect(code.length).toBeLessThan(140);
    expect(decodeChallenge(code)).toEqual(c);
  });

  it("still opens a pre-removal code that carried a ghost run id", () => {
    // Old links embedded an eleventh tuple entry (a sealed run id to race).
    // The ghost layer is gone; the entry is ignored, the dungeon still opens.
    const legacy = btoa(JSON.stringify([
      1, 2698932116, "daily-2026-08-02", "Donut Holes", 18, 1, 902, 641, 34, "airstrike", "run-abc123",
    ])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const ch = decodeChallenge(legacy);
    expect(ch).not.toBeNull();
    expect(ch!.seed).toBe(2698932116);
    expect(ch!.by).toBe("Donut Holes");
    expect("run" in ch!).toBe(false);
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

  it("never prints a bare board name that is not the board the player will find", () => {
    // `b.split("@")[0]` threw the SCOPE away, so the seal read "it holds a
    // position on DEEPEST, KILLS" about rows on the DAILY CONTRACT boards -
    // and the player clicked through to STANDINGS > ALL-TIME > DEEPEST and read
    // "this museum is empty". The trust element made a claim the very next
    // screen refuted, on the one product whose whole pitch is that the server
    // does not lie about what a run is worth.
    expect(boardsPhrase([])).toBe("");
    expect(boardsPhrase(null)).toBe("");
    expect(boardsPhrase(["fastest@daily-2026-08-02"])).toBe("FASTEST — TODAY'S CONTRACT");
    expect(boardsPhrase(["fastest"])).toBe("FASTEST — ALL-TIME");
    expect(boardsPhrase(["deepest@weekly-2026-07-27"])).toBe("DEEPEST — THE WEEKLY CONTRACT");
    expect(boardsPhrase(["band0"])).toContain("BAND BOARD");
    // Two scopes of the same board are two DIFFERENT boards, and the phrase
    // must not fold them into one word - it names both, grouped, so the thing
    // worth reading (WHAT you took) is not buried in repetition.
    expect(boardsPhrase(["fastest@daily-2026-08-02", "fastest"]))
      .toBe("FASTEST — TODAY'S CONTRACT AND ALL-TIME");
    expect(boardsPhrase(["deepest", "kills", "band0", "band3"])).toContain("and 1 more");
  });

  it("a rivals row is sealed WITHOUT a film, and never claims one aged out", () => {
    // The row is inserted verified with proofId = null because nobody records
    // a party run. Its chip must say the honest sentence (the authoritative
    // sim decided it) and never imply a re-execution or a film that expired.
    const row = boardRow({ film: "never" as const, playable: false });
    expect(provenanceOf(row)).toBe("vouched");
    const chip = sealChip("verified", "abc1234", false, "ranked", provenanceOf(row));
    expect(chip.label).toContain("SERVER-RUN");
    expect(chip.title).not.toMatch(/aged out/i);
    expect(chip.title).toContain("no film");
    // ...and the verdict has a state for it, so the one genuinely
    // server-authoritative score in the product is shown being earned.
    const seal = verdictSeal("vouched", "abc1234");
    expect(seal.word).toBe("SEALED");
    expect(seal.line).toMatch(/authoritative sim/);
  });

  it("a refusal that demands an action arrives with the control", () => {
    // "LINK AN IDENTITY" existed in exactly one place in the tree: as a server
    // refusal string. No button, no link, no OAuth affordance on the verdict.
    expect(verdictSeal("claimed", null, false, false, "unsealed.", null, true).action?.kind)
      .toBe("link");
    expect(verdictSeal("claimed", null, false, false, "unsealed.").action).toBeNull();
    // A state the player cannot act on never grows a button.
    expect(verdictSeal("rejected", null, false, false, "you claimed floor 18", null, true).action)
      .toBeNull();
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


// ===========================================================================
// ROUND 4 — the screen stops asserting what the row does not carry
// ===========================================================================

describe("a seal says how it was earned (round-4 blocker 3)", () => {
  it("does not promise a re-execution for a row that was never re-executed", () => {
    // `verified` covers two different events and the chip printed the SAME
    // sentence for both. A server-vouched RIVALS contract is inserted verified
    // with proof_id NULL - it was never re-executed, because it never left the
    // server - and the tooltip asserted "the server re-executed this run and
    // certified it" on a board whose entire pitch is that every ranked row is a
    // proof. The only existing tell was "party of N", which reads 1 on a solo
    // rivals row.
    const replayed = boardRow({ state: "verified", film: "retained" });
    const vouched = boardRow({ state: "verified", film: "never", mode: "rivals" });
    expect(provenanceOf(replayed)).toBe("replayed");
    expect(provenanceOf(vouched)).toBe("vouched");

    const a = sealChip(replayed.state, replayed.rulesEra, false, "ranked", provenanceOf(replayed));
    const b = sealChip(vouched.state, vouched.rulesEra, false, "ranked", provenanceOf(vouched));
    expect(a.title).toContain("re-executed");
    expect(b.title).not.toContain("re-executed this run and certified");
    expect(b.title).toContain("never left the server");
    expect(b.label).not.toBe(a.label);
  });

  it("names the ruleset on the row, and stays quiet about the plain descent", () => {
    // mode/runKind have been on the wire since the roam gate shipped and no
    // surface rendered either, so a ruleset with no permadeath was
    // indistinguishable on the board from the descent every other row is.
    expect(rulesetLabel({ mode: "coop", runKind: "race" })).toBeNull();
    expect(rulesetLabel({ mode: "rivals", runKind: "race" })).toMatch(/time-out/);
    expect(rulesetLabel({ mode: "coop", runKind: "roam" })).toMatch(/no collapse clock/);
  });
});

describe("the verdict does not name the player as their own rival (round-4 blocker 5)", () => {
  const me = { floor: 6, won: false, elapsedSec: 400 };

  it("compares against somebody else, and says so when nobody else is there", () => {
    // THE MARK printed "CARL / FLOOR 1 / level with the leader" on the player's
    // OWN row. The component already knew how to say it correctly - the
    // unlinked branch prints "YOUR OWN DEEPEST" - it was simply never told
    // which rows were mine.
    const mine = boardRow({ id: "mine", publicId: "ME", name: "Carl", floor: 6, state: "verified" });
    const solo = benchmark(me, [mine], 4, "ME");
    expect(solo!.who).not.toBe("CARL");
    expect(solo!.gap).not.toMatch(/level with the leader/);
    expect(solo!.who).toMatch(/YOU HOLD THE MARK/);
  });

  it("compares against rank 2 when the player holds rank 1, and calls it rank 2", () => {
    const mine = boardRow({ id: "mine", publicId: "ME", name: "Carl", floor: 18, won: true, state: "verified" });
    const other = boardRow({ id: "k", publicId: "KAT", name: "Katia", floor: 5, state: "verified" });
    const b = benchmark(me, [mine, other], 4, "ME");
    expect(b!.who).toBe("KATIA");
    // ...and it does not call the crawler BELOW the player "the leader".
    expect(b!.gap).not.toMatch(/the leader/);
    expect(b!.gap).toMatch(/rank 2/);
    expect(b!.source).toMatch(/you hold rank 1/);
  });

  it("one definition of #1, shared by the mark and the scoreboard column", () => {
    // Held-TAB headed the scoreboard column "#1 — KATIA" while THE STANDINGS,
    // which ranks sealed rows only, showed Katia at rank 2. Both surfaces read
    // this function now.
    const claim = boardRow({ id: "c", publicId: "C", name: "Claim", state: "claimed" });
    const sealed = boardRow({ id: "s", publicId: "S", name: "Katia", state: "verified" });
    const top = boardLeader([claim, sealed], "ME");
    expect(top!.row.name).toBe("Katia");
    expect(top!.rank).toBe(1);
    expect(top!.mine).toBe(false);
    expect(boardLeader([], "ME")).toBeNull();
  });
});

describe("precision and copy (round-4 blocker 15)", () => {
  it("never prints '1 kills'", () => {
    expect(count(1, "kill")).toBe("1 kill");
    expect(count(0, "kill")).toBe("0 kills");
    expect(count(1200, "kill")).toBe("1,200 kills");
  });

  it("does not credit a seven-second run with a minute in the dungeon", () => {
    // `Math.max(1, Math.round(timeSec / 60))` rounded every run up to a minute
    // and printed a bare "+1" beside a value in minutes: "377 min +1" on a
    // 7.76-second death.
    const rows = bankedTicks(history(30), 30, { kills: 3, timeSec: 7.76, floor: 1 });
    const time = rows.find((r) => r.label === "TIME IN THE DUNGEON")!;
    expect(time.delta).toBe("+8s");
    const long = bankedTicks(history(30), 30, { kills: 3, timeSec: 640, floor: 9 });
    expect(long.find((r) => r.label === "TIME IN THE DUNGEON")!.delta).toBe("+11 min");
  });

  it("does not tell a floor-13 death that the cameras were still warming up", () => {
    // DEPTH being the WEAKEST of four parts is not the same claim as "you went
    // nowhere", and this line fired on a floor-13 death - deeper than most runs
    // ever get.
    const deep = gradeRun(
      facts({ floor: 13, elapsedSec: 1400, kills: 400, floorsCleared: 12 }), [], null, 0);
    expect(deep.line).not.toMatch(/still warming up/);
    const shallow = gradeRun(
      facts({ floor: 2, elapsedSec: 90, kills: 4, floorsCleared: 1 }), [], null, 0);
    expect(shallow.letter).toBeTruthy();
  });

  it("never insults a run that has no weak measure", () => {
    // THE VERDICT stopped showing a letter (owner, polish r1: "the grade
    // doesn't mean anything"), which left `line` as the ONLY performance
    // readout on the default face — and it was keyed purely on the weakest of
    // four parts, which four scores always have. So a dominant clear (18
    // floors at 50s each, i.e. FASTER than the house-curve median, barely
    // scratched, every draft claimed) told the player "Slowly. The audience
    // had time to order food." A false claim is worse than a meaningless
    // letter. No part below NAG_FLOOR, no telling-off.
    const dominant = gradeRun(
      facts({
        floor: 18, won: true, elapsedSec: 900, kills: 900, damageTaken: 120,
        floorsCleared: 18, draftsOffered: 12, draftsClaimed: 12,
      }),
      [], null, 100,
    );
    expect(dominant.parts.every((p) => p.score >= 55)).toBe(true);
    expect(dominant.line).not.toMatch(/Slowly|dawdled|Bleeding|Underpowered|On paper/);
    // ...and it still says something specific, keyed on a measure the drill-down
    // shows, so the praise is as auditable as the criticism was.
    expect(dominant.line.length).toBeGreaterThan(10);

    // The criticism still fires when a measure is genuinely weak: the same
    // clear, dragged out and bled all the way, gets told about it.
    const scrappy = gradeRun(
      facts({
        floor: 18, won: true, elapsedSec: 9000, kills: 200, damageTaken: 9000,
        floorsCleared: 18, draftsOffered: 12, draftsClaimed: 2,
      }),
      [], null, 100,
    );
    expect(scrappy.parts.some((p) => p.score < 55)).toBe(true);
    expect(scrappy.line).toMatch(/Slowly|Bleeding|Underpowered|On paper/);
  });
});

describe("the seal moment happens on screen (round-4 blocker 6)", () => {
  // Instrumented on the shipping build: `vseal pending` at t+0 while the card
  // was still at opacity 0 mid-entrance, `vseal verified ranked` by t+900ms. No
  // `verifying` frame was ever painted, so 6.2 Beat 5 - "watching the seal land
  // is two genuinely satisfying seconds" - was skipped entirely. The strike
  // animation was staged correctly and had nothing to land ON.
  const CARD = 10_000; // performance.now() when the verdict card was displayed
  const RISEN = CARD + SEAL_CASCADE_MS;

  it("holds a verdict that arrives before the block is even visible", () => {
    // The measured case: the card lands at CARD, the block finishes rising
    // 1.4s later, and the submit answers 300ms after the card - i.e. while the
    // thing the player is supposed to watch is still at opacity 0.
    const hold = sealHoldMs(CARD + 300, CARD, CARD + SEAL_CASCADE_MS, true, true);
    expect(hold).toBe(SEAL_MIN_PENDING_MS + SEAL_CASCADE_MS - 300);
    // ...and the verdict is painted only once the block has been READABLE for
    // the full floor, never at the moment it merely became opaque.
    expect(sealHoldMs(RISEN + SEAL_MIN_PENDING_MS, CARD, RISEN, true, true)).toBe(0);
    expect(sealHoldMs(RISEN + SEAL_MIN_PENDING_MS - 1, CARD, RISEN, true, true)).toBe(1);
  });

  it("never holds a screen that OPENS on a terminal verdict", () => {
    // A rehearsal or a refused recording has no pending state to honour, and
    // making the player wait 2.6 seconds for a sentence that was always going
    // to say UNSEALED is the opposite of a beat.
    expect(sealHoldMs(CARD + 10, CARD, CARD, true, false)).toBe(0);
  });

  it("never holds a pending verdict, and never holds before the card is up", () => {
    expect(sealHoldMs(CARD + 10, CARD, CARD, false, true)).toBe(0);
    // verdictVisibleAt 0 means the card has not been displayed yet; the first
    // paint happens during the Beat 0 freeze and must not be deferred.
    expect(sealHoldMs(CARD + 10, 0, 0, true, true)).toBe(0);
  });
});

describe("THE RESULT CARD (NICHE.md 4.2): a link a stranger can read", () => {
  // The two legibility rules, held as tests: every number carries its scale,
  // and the System grades the claim in exactly one line.
  const card = (o: Partial<Parameters<typeof resultCardText>[0]> = {}) => resultCardText({
    name: "Meatshield", won: false, floor: 7, timeSec: 372, kills: 41,
    letter: "B", url: "https://dungeon-crawler-claude.fly.dev/iso.html?c=XYZ", ...o,
  });

  it("every number carries its scale: FLOOR 7 alone is an in-joke, OF 18 is a story", () => {
    const c = card();
    expect(c).toContain("FLOOR 7 OF 18");
    expect(c).toContain("6:12");
    expect(c).toContain("41 KILLS");
    expect(c).toContain("MEATSHIELD");
    // A clear states the whole scale too — "ALL 18 FLOORS", never a bare 18.
    expect(card({ won: true, timeSec: 702 })).toContain("ALL 18 FLOORS");
  });

  it("the System grades the claim — one line, from the audited letter", () => {
    expect(card()).toContain("THE SYSTEM RATES THIS CLAIM: RESPECTABLE. BARELY.");
    expect(card({ letter: "S" })).toMatch(/RATES THIS CLAIM/);
    // An ungraded run (no grade yet) carries no rating line rather than a fake one.
    expect(card({ letter: null })).not.toMatch(/RATES THIS CLAIM/);
  });

  it("ends in the door, and the door is a ?c= seed link — not a recording", () => {
    const c = card();
    const last = c.split("\n").slice(-1)[0];
    expect(last).toMatch(/^beat it → .*\?c=/);
    // §5: the card must never carry pace-delta furniture.
    expect(c).not.toMatch(/BEHIND|AHEAD OF/);
  });

  it("a daily card names the day — the claim is against everyone on that dungeon", () => {
    expect(card({ day: "2026-08-04" })).toContain("THE DAILY 2026-08-04");
  });

  it("the race card is crew-flavored and its door is a live rematch, not a chase", () => {
    const c = raceCardText({
      winner: "Meatshield", seats: 4, timeSec: 702,
      joinUrl: "https://dungeon-crawler-claude.fly.dev/iso.html?join=AB2CD&rivals=1",
    });
    expect(c).toContain("MEATSHIELD TOOK THE DUNGEON — 3 CRAWLERS ATE FLOOR");
    expect(c.split("\n").slice(-1)[0]).toMatch(/^rematch → .*\?join=/);
    expect(c).not.toContain("?c="); // the race door is the party, never a solo chase
    // Two-seat race reads correctly in the singular.
    expect(raceCardText({ winner: "A", seats: 2, timeSec: 100, joinUrl: "u" }))
      .toContain("1 CRAWLER ATE FLOOR");
  });

  it("the inbound claim is a static goal at the start and one comparison at the end", () => {
    const ch = { seed: 1, by: "Meatshield", floor: 7, won: false, timeSec: 372, kills: 41, level: 12, ult: null };
    expect(claimBanner(ch)).toBe("MEATSHIELD CLAIMS FLOOR 7 OF 18 IN 6:12. OUTLIVE THEM.");
    // Deeper beats shallower; a clear beats any death; two clears settle on the clock.
    const you = { name: "You", won: false, floor: 9, timeSec: 500, kills: 10 };
    expect(claimVerdict(ch, you)).toMatch(/^CLAIM SETTLED/);
    expect(claimVerdict(ch, { ...you, floor: 5 })).toMatch(/^CLAIM STANDS/);
    expect(claimVerdict({ ...ch, won: true, timeSec: 700 }, { ...you, won: true, timeSec: 650 }))
      .toMatch(/^CLAIM SETTLED/);
    expect(claimVerdict({ ...ch, won: true, timeSec: 600 }, { ...you, won: true, timeSec: 650 }))
      .toMatch(/^CLAIM STANDS/);
    // Same-floor deaths settle on kills — and the sentence never carries a live delta.
    expect(claimVerdict(ch, { ...you, floor: 7, kills: 50 })).toMatch(/^CLAIM SETTLED/);
    expect(claimVerdict(ch, { ...you, floor: 7, kills: 30 })).toMatch(/^CLAIM STANDS/);
  });
});
