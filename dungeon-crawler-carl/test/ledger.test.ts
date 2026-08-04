/**
 * THE CRAWL LEDGER (NICHE.md 4.3) — losing banks something, and exactly what
 * the doc specifies: three contracts (rerolled, dead-run-completable),
 * first-time-ever mastery stamps, and a forgiving streak (one missed day
 * shielded per week, milestones pay cosmetics, nothing an evening can't
 * restore). Zero power anywhere — every reward here is a string.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CONTRACT_POOL, LedgerStore, ledgerRunFrom, type LedgerRun } from "../src/server/ledger";

const store = (): LedgerStore => new LedgerStore(new Database(":memory:"));

const run = (o: Partial<LedgerRun> = {}): LedgerRun => ({
  won: false, floor: 3, day: null, kills: 10, level: 4,
  damageTaken: 200, gold: 30, abilities: ["melee", "bolt"], glyphs: [], ...o,
});

describe("system contracts", () => {
  it("three are posted on first contact, straight from the authored pool", () => {
    const s = store();
    const v = s.view("acct", 0);
    expect(v.contracts.length).toBe(3);
    expect(v.contracts.map((c) => c.id)).toEqual(CONTRACT_POOL.slice(0, 3).map((c) => c.id));
  });

  it("a DEAD run completes a contract, pays a TITLE (never stats), and rerolls the slot", () => {
    const s = store();
    // sewers_tourist: reach floor 4 — dying there counts, by design.
    const lines = s.applyRun("acct", run({ floor: 4, won: false }), 1000);
    expect(lines.some((l) => /CONTRACT COMPLETE — SEE THE SEWERS/.test(l))).toBe(true);
    expect(lines.some((l) => /Title earned: TOURIST/.test(l))).toBe(true);
    const v = s.view("acct", 2000);
    expect(v.titles).toContain("TOURIST");
    // The slot rerolled to a fresh contract; the completed one never returns.
    expect(v.contracts.length).toBe(3);
    expect(v.contracts.map((c) => c.id)).not.toContain("sewers_tourist");
  });

  it("multi-run contracts accumulate progress across runs", () => {
    const s = store();
    // daily_pilgrim: run the daily three times (a clear is never required).
    s.applyRun("a", run({ day: "2026-08-01" }), 1);
    s.applyRun("a", run({ day: "2026-08-02" }), 2);
    let v = s.view("a", 3);
    expect(v.contracts.find((c) => c.id === "daily_pilgrim")?.progress).toBe(2);
    const lines = s.applyRun("a", run({ day: "2026-08-03" }), 3);
    expect(lines.some((l) => /CONTRACT COMPLETE — THE PILGRIMAGE/.test(l))).toBe(true);
    v = s.view("a", 4);
    expect(v.contracts.map((c) => c.id)).not.toContain("daily_pilgrim");
  });

  it("a run that moves nothing deposits nothing — the ledger never manufactures", () => {
    const s = store();
    s.applyRun("a", run(), 1); // floor 3, 10 kills: stamps land, contracts don't complete
    const second = s.applyRun("a", run(), 2); // identical again: nothing new anywhere
    expect(second).toEqual([]);
  });
});

describe("mastery stamps", () => {
  it("are first-time-EVER per ability and glyph, then silent forever", () => {
    const s = store();
    const first = s.applyRun("a", run({ abilities: ["melee"], glyphs: ["swiftness"] }), 1);
    expect(first.some((l) => /MASTERY STAMP/.test(l) || /NEW MASTERY STAMPS/.test(l))).toBe(true);
    const again = s.applyRun("a", run({ abilities: ["melee"], glyphs: ["swiftness"] }), 2);
    expect(again.filter((l) => /MASTERY/.test(l))).toEqual([]);
    const v = s.view("a", 3);
    expect(v.stamps).toContain("ability:melee");
    expect(v.stamps).toContain("glyph:swiftness");
  });
});

describe("the forgiving streak", () => {
  const daily = (s: LedgerStore, day: string, at: number) =>
    s.applyRun("a", run({ day }), at);

  it("counts consecutive days with >=1 daily RUN — clears not required, same-day reruns free", () => {
    const s = store();
    daily(s, "2026-08-01", 1);
    daily(s, "2026-08-01", 2); // second run same day: no double-count
    daily(s, "2026-08-02", 3);
    const lines = daily(s, "2026-08-03", 4);
    expect(lines.some((l) => /DAILY STREAK 3/.test(l))).toBe(true);
    expect(lines.some((l) => /MILESTONE — 3 days/.test(l))).toBe(true);
    expect(s.view("a", 5).streak.count).toBe(3);
    expect(s.view("a", 5).titles).toContain("3-DAY REGULAR");
  });

  it("shields exactly one missed day per week, silently spent, honestly reported", () => {
    const s = store();
    daily(s, "2026-08-03", 1); // Monday
    const bridged = daily(s, "2026-08-05", 2); // skipped Tuesday — shield eats it
    expect(bridged.some((l) => /Shield spent/.test(l))).toBe(true);
    expect(s.view("a", 3).streak.count).toBe(2);
    // A second gap the same week is a genuine lapse: fresh start, no scolding.
    const lapsed = daily(s, "2026-08-07", 4);
    expect(lapsed.some((l) => /Shield/.test(l))).toBe(false);
    expect(s.view("a", 5).streak.count).toBe(1);
    expect(s.view("a", 5).streak.best).toBe(2); // best survives the lapse
  });

  it("a two-day gap without a shield resets quietly — no dark-pattern scolding line", () => {
    const s = store();
    daily(s, "2026-08-03", 1);
    daily(s, "2026-08-04", 2);
    daily(s, "2026-08-06", 3); // gap bridged (shield)
    const reset = daily(s, "2026-08-09", 4); // 3-day gap: nothing can bridge it
    expect(s.view("a", 5).streak.count).toBe(1);
    // The reset is silent on the lapse itself: no line mentions losing anything.
    expect(reset.every((l) => !/lost|broke|lapsed/i.test(l))).toBe(true);
  });

  it("non-daily runs never touch the streak", () => {
    const s = store();
    daily(s, "2026-08-01", 1);
    s.applyRun("a", run({ day: null }), 2);
    expect(s.view("a", 3).streak.count).toBe(1);
  });
});

describe("wire normalization", () => {
  it("builds a LedgerRun from the run_end payload shape, dropping junk", () => {
    const r = ledgerRunFrom({
      status: "dead", floor: 6, day: "2026-08-04",
      player: {
        kills: 41, level: 9, damageTaken: 512.4, gold: 260,
        slots: ["melee", null, "orbit", 42], ultimate: "airstrike",
        glyphs: ["swiftness", 7, "x".repeat(99)],
      },
    });
    expect(r).not.toBeNull();
    expect(r!.won).toBe(false);
    expect(r!.abilities).toEqual(["melee", "orbit", "airstrike"]);
    expect(r!.glyphs).toEqual(["swiftness"]);
    expect(r!.day).toBe("2026-08-04");
    expect(ledgerRunFrom({ status: "dead", floor: 1, day: null, player: null })).toBeNull();
    // A malformed day never reaches the streak.
    expect(ledgerRunFrom({ status: "dead", floor: 1, day: "yesterday-ish", player: { kills: 1 } })!.day).toBeNull();
  });
});
