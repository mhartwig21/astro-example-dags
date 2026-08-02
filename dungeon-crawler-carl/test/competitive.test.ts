import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb, type PersistDb } from "../src/server/db";
import { CompetitiveApi } from "../src/server/competitiveApi";
import { TokenService } from "../src/server/tokens";
import { InlineExecutor } from "../src/server/verifyExecutor";
import { cpFor, dailyEvent, seasonIdFor, standingFor, TIER_MIN_ACCOUNTS } from "../src/server/season";
import { encodeProof, decodeProof, type RunProof } from "../src/sim/replay";
import { RULES_HASH } from "../src/sim/rulesHash";
import { recordBotRun } from "../tools/replaycheck";

// COMPETITIVE.md: the verified-run layer end to end. Every test here is one of
// the failure modes the design names - a lie, a stale era, a flood, a deleted
// account - because the only thing that makes a seal worth anything is that
// these all behave the way the document says they do.

const DAY_MS = 86_400_000;

/** Bot runs are the expensive part; record a few once and reuse the bytes. */
const cache = new Map<string, { proof: RunProof; bytes: Uint8Array }>();
function run(seed: number, floors = 3): { proof: RunProof; bytes: Uint8Array } {
  const key = seed + ":" + floors;
  let hit = cache.get(key);
  if (!hit) {
    const rec = recordBotRun(seed, floors);
    hit = { proof: rec.proof, bytes: encodeProof(rec.proof) };
    cache.set(key, hit);
  }
  // Fresh copies: submit() takes ownership of the buffer it is handed.
  return { proof: decodeProof(hit.bytes), bytes: new Uint8Array(hit.bytes) };
}

function reseal(proof: RunProof): Uint8Array {
  return encodeProof(proof);
}

interface Harness {
  dir: string;
  db: PersistDb;
  api: CompetitiveApi;
  tokens: TokenService;
  now: number;
  /** Give an account a linked provider identity - the price of the queue. */
  link(accountId: string): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dcc-comp-"));
  const db = openDb(join(dir, "t.sqlite"))!;
  const tokens = new TokenService("test-secret");
  const h: Harness = {
    dir, db, tokens, now: Date.UTC(2026, 7, 2, 12),
    api: null as unknown as CompetitiveApi,
    link(accountId: string) { db.linkIdentity("discord", "d-" + accountId, accountId, "Crawler", this.now); },
  };
  h.api = new CompetitiveApi({
    store: db.competitive, db, tokens, executor: new InlineExecutor(),
    budgetMsPerSec: 1000, // tests do not want the duty-cycle sleep
    now: () => h.now,
  });
  return h;
}

let H: Harness;
beforeEach(() => { H = makeHarness(); });
afterEach(() => { H.api.close(); H.db.close(); rmSync(H.dir, { recursive: true, force: true }); });

describe("submit -> claimed -> verified", () => {
  it("replays the artifact and certifies the row with derived facts", async () => {
    H.link("acct-1");
    const { proof, bytes } = run(101, 4);
    const out = await H.api.submit(bytes, "acct-1", "Carl", "1.2.3.4");
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.queued).toBe(true);
    await H.api.queue.drain();

    const row = H.api.store.getRun(out.runId)!;
    expect(row.state).toBe("verified");
    expect(row.rulesHash).toBe(RULES_HASH);
    expect(row.verifiedAt).toBeGreaterThan(0);
    expect(row.floor).toBe(proof.claim.floor);
    expect(row.kills).toBe(proof.claim.kills);
    // The verifier DERIVED these; the client never asserted them.
    expect(row.bandSplits).not.toBeNull();
    expect(row.finalBuild).not.toBeNull();
    // Career stats move on a VERIFIED run and on nothing else.
    expect(H.db.getAccountStats("acct-1")?.runs).toBe(1);
  }, 60_000);

  it("a tampered claim is REJECTED, and the submitter cools down", async () => {
    H.link("acct-2");
    const { proof } = run(13, 3);
    // The classic devtools-console attack, now costed: claim a full clear.
    proof.claim.floor = 18;
    proof.claim.won = true;
    proof.claim.kills = 99999;
    proof.claim.status = "won";
    const out = await H.api.submit(reseal(proof), "acct-2", "Cheater", "9.9.9.9");
    if ("error" in out) throw new Error("expected the submit to be accepted: " + out.error);
    await H.api.queue.drain();
    const row = H.api.store.getRun(out.runId)!;
    expect(row.state).toBe("rejected");
    expect(row.rejectReason).toContain("claim disagrees with the replay");
    // A rejection costs time: the next submission is refused for a while.
    const again = await H.api.submit(run(13, 3).bytes, "acct-2", "Cheater", "9.9.9.9");
    if ("error" in again) throw new Error("unexpected error");
    expect(again.queued).toBe(false);
    expect(again.reason).toContain("cooling down");
  }, 60_000);

  it("you cannot claim a fast clear without submitting the ticks that clear it", async () => {
    H.link("acct-3");
    const { proof } = run(47, 3);
    proof.header.ticks = 60;
    proof.claim.ticks = 60;
    const out = await H.api.submit(reseal(proof), "acct-3", "Speedy", "1.1.1.1");
    // The frame stream no longer matches the tick count: shape rejects it on
    // the request thread, before a single tick of CPU is spent.
    expect("error" in out).toBe(true);
  }, 60_000);
});

describe("version drift (COMPETITIVE.md 2.6)", () => {
  it("a stale rules hash is UNVERIFIABLE, never rejected", async () => {
    H.link("acct-4");
    const { proof } = run(11, 2);
    proof.header.rulesHash = "a".repeat(64);
    const out = await H.api.submit(reseal(proof), "acct-4", "Veteran", "2.2.2.2");
    if ("error" in out) throw new Error("unexpected error: " + out.error);
    expect(out.state).toBe("unverifiable");
    expect(out.queued).toBe(false);
    // The player is told which era, plainly, and is not accused of anything.
    expect(out.reason).toContain("recorded under rules era aaaaaaa");
    expect(H.api.store.getRun(out.runId)!.state).toBe("unverifiable");
  }, 60_000);

  it("a build that carries the older era can still verify under it", async () => {
    // Same proof, but this server declares it can execute that era - which is
    // exactly what the sim-eras build step buys.
    H.link("acct-5");
    const api = new CompetitiveApi({
      store: H.db.competitive, db: H.db, tokens: H.tokens,
      executor: new InlineExecutor(), budgetMsPerSec: 1000,
      eras: [RULES_HASH, "b".repeat(64)], now: () => H.now,
    });
    const { bytes } = run(11, 2);
    const out = await api.submit(bytes, "acct-5", "Veteran", "2.2.2.3");
    if ("error" in out) throw new Error("unexpected error");
    await api.queue.drain();
    expect(api.store.getRun(out.runId)!.state).toBe("verified");
    api.close();
  }, 60_000);

  it("PATCH DAY freezes an event pinned to an era this build cannot run", () => {
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: "c".repeat(64) });
    const frozen = H.db.competitive.freezeStaleEvents(RULES_HASH);
    expect(frozen).toContain(evt.id);
    expect(H.db.competitive.getEvent(evt.id)!.frozen).toBe(true);
  });
});

describe("events, tickets and CP (COMPETITIVE.md 3.2)", () => {
  /** A REAL run of the day seed - the frames have to actually reproduce it,
   *  which is the entire point of the ticket path. */
  function ticketedProof(accountId: string, attempt: number, floors = 3): Uint8Array {
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, floors);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(evt.id, accountId, attempt);
    return reseal(proof);
  }

  it("an event entry with the wrong seed is refused before any CPU is spent", async () => {
    H.link("acct-e1");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(101, 2);
    proof.header.eventId = evt.id; // but header.seed is still the bot seed
    proof.header.ticket = H.tokens.issueTicket(evt.id, "acct-e1", 1);
    const out = await H.api.submit(reseal(proof), "acct-e1", "Carl", "3.3.3.3");
    expect("error" in out && out.error).toContain("seed does not match");
  }, 60_000);

  it("an event entry with no ticket earns no CP and is never queued", async () => {
    H.link("acct-e2");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(101, 2);
    proof.header.eventId = evt.id;
    proof.header.seed = evt.seed;
    const out = await H.api.submit(reseal(proof), "acct-e2", "Carl", "3.3.3.4");
    if ("error" in out) throw new Error("unexpected error: " + out.error);
    expect(out.queued).toBe(false);
    expect(out.reason).toContain("no attempt ticket");
    expect(H.db.competitive.seasonCp("acct-e2", seasonIdFor(H.now))).toBeNull();
  }, 60_000);

  it("a forged ticket does not verify", () => {
    const evt = dailyEvent(H.now);
    const real = H.tokens.issueTicket(evt.id, "acct-x", 1);
    expect(H.tokens.readTicket(real, evt.id, "acct-x")).toBe(1);
    // Same ticket, different account: the HMAC binds both.
    expect(H.tokens.readTicket(real, evt.id, "acct-y")).toBeNull();
    // Attempt number rewritten to 1 to look like a first try.
    const parts = real.split(".");
    expect(H.tokens.readTicket(parts[0] + ".1." + parts[2], evt.id, "acct-x")).toBe(1);
    const forged = H.tokens.issueTicket(evt.id, "acct-x", 7).split(".");
    expect(H.tokens.readTicket(forged[0] + ".1." + forged[2], evt.id, "acct-x")).toBeNull();
  });

  it("the board takes your BEST attempt; CP is scored on your FIRST", async () => {
    H.link("acct-e3");
    const evt = dailyEvent(H.now);
    const season = seasonIdFor(H.now);

    const first = await H.api.submit(ticketedProof("acct-e3", 1, 2), "acct-e3", "Carl", "4.4.4.4");
    if ("error" in first) throw new Error(first.error);
    await H.api.queue.drain();
    const cpAfterFirst = H.db.competitive.seasonCp("acct-e3", season);
    expect(cpAfterFirst?.cp).toBeGreaterThan(0);
    expect(H.db.competitive.firstScoredRun("acct-e3", evt.id)).toBe(first.runId);

    // A deeper second attempt: it takes the board row, and moves no CP.
    const second = await H.api.submit(ticketedProof("acct-e3", 2, 6), "acct-e3", "Carl", "4.4.4.4");
    if ("error" in second) throw new Error(second.error);
    await H.api.queue.drain();
    const rowB = H.api.store.getRun(second.runId)!;
    expect(rowB.state).toBe("verified");
    expect(rowB.attemptNo).toBe(2);
    expect(H.db.competitive.seasonCp("acct-e3", season)?.cp).toBe(cpAfterFirst?.cp);
    expect(H.db.competitive.firstScoredRun("acct-e3", evt.id)).toBe(first.runId);

    const board = H.api.store.board({ kind: "deepest", eventId: evt.id, verifiedOnly: true });
    expect(board[0].id).toBe(rowB.floor >= H.api.store.getRun(first.runId)!.floor ? second.runId : first.runId);
  }, 60_000);

  it("an attempt that does not beat your verified best is never replayed", async () => {
    H.link("acct-e4");
    const good = await H.api.submit(ticketedProof("acct-e4", 1, 6), "acct-e4", "Carl", "5.5.5.5");
    if ("error" in good) throw new Error(good.error);
    await H.api.queue.drain();
    const msAfter = H.api.queue.msTotal;
    const worse = await H.api.submit(ticketedProof("acct-e4", 2, 2), "acct-e4", "Carl", "5.5.5.5");
    if ("error" in worse) throw new Error(worse.error);
    expect(worse.queued).toBe(false);
    expect(worse.reason).toContain("did not beat your verified best");
    // The load-bearing consequence: the queue ceiling is a function of
    // IMPROVEMENTS, not of anyone's free time.
    expect(H.api.queue.msTotal).toBe(msAfter);
  }, 60_000);

  it("CP is a portfolio with a participation floor, and tiers respect population", () => {
    expect(cpFor(1, 100)).toBeGreaterThan(cpFor(50, 100));
    expect(cpFor(100, 100)).toBe(40); // last place still finished
    // THE FLOOR APPLIES TO THE WHOLE LADDER, not just the prestige names.
    // Handing BRONZE ENTRANT to the last-placed player of a twelve-account
    // season dresses twelve people in the costume of twelve hundred, and they
    // can count the entrants. Below the floor: CP and "rank 7 of 34".
    expect(standingFor(500, 1, 12, 5).tier).toBeNull();
    expect(standingFor(500, 12, 12, 5).tier).toBeNull();
    expect(standingFor(500, 12, 12, 5).tierFloor).toBe(TIER_MIN_ACCOUNTS);
    expect(standingFor(500, 20, 100, 5).tier).toBe("CHAMPION");
    expect(standingFor(900, 1, 400, 9).tier).toBe("THE SHOW");
    expect(standingFor(900, 1, 80, 9).tier).toBe("HEADLINER");
    // Placement: no tier until three events are banked.
    expect(standingFor(900, 1, 400, 2).tier).toBeNull();
    expect(standingFor(900, 1, 400, 2).placementRemaining).toBe(1);
  });
});

describe("abuse guards (COMPETITIVE.md 2.7)", () => {
  it("an anonymous account can submit, but never enters the verify queue", async () => {
    // An account is FREE, so an unlinked one may not buy the box's CPU. It is
    // never shut out of the game - only out of the ladder.
    const out = await H.api.submit(run(101, 3).bytes, "anon-acct-1", "Nobody", "6.6.6.6");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.state).toBe("claimed");
    expect(out.reason).toContain("LINK AN IDENTITY");
    expect(H.api.queue.depth).toBe(0);
  }, 60_000);

  it("a client-invented anonymous token is not a rate-limiting subject; a server-issued one is", () => {
    const minted = H.tokens.issueAnon();
    expect(H.tokens.isServerIssued(minted)).toBe(true);
    expect(H.tokens.isServerIssued("i-made-this-up-myself")).toBe(false);
    // Grandfathered tokens still WORK - they just cannot be trusted as a subject.
    expect(H.tokens.isUsable("i-made-this-up-myself")).toBe(true);
    expect(H.tokens.isUsable("short")).toBe(false);
    expect(H.tokens.isUsable(12345)).toBe(false);
    // A tampered signature fails.
    expect(H.tokens.isServerIssued(minted.slice(0, -2) + "xy")).toBe(false);
  });

  it("over the daily verify-CPU budget, rows are stored claimed - the board never closes", async () => {
    H.link("acct-b1");
    const day = "2026-08-02";
    H.db.competitive.spendVerifyMs("acct:acct-b1", day, 10 * 60 * 60 * 1000);
    const out = await H.api.submit(run(101, 3).bytes, "acct-b1", "Grinder", "7.7.7.7");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.state).toBe("claimed");
    expect(out.reason).toContain("daily verification budget spent");
  }, 60_000);

  it("verify_budget is swept on a 48h window - it only LOOKS unbounded", () => {
    H.db.competitive.spendVerifyMs("ip:1.2.3.4", "2026-07-01", 500);
    H.db.competitive.spendVerifyMs("ip:1.2.3.4", "2026-08-02", 500);
    H.db.competitive.sweepVerifyBudget("2026-08-01");
    expect(H.db.competitive.verifyMsSpent("ip:1.2.3.4", "2026-07-01")).toBe(0);
    expect(H.db.competitive.verifyMsSpent("ip:1.2.3.4", "2026-08-02")).toBe(500);
  });

  it("an oversized or unreadable artifact is refused without a replay", async () => {
    H.link("acct-b2");
    const junk = await H.api.submit(gzipSync(Buffer.alloc(1024, 7)), "acct-b2", "Junk", "8.8.8.8");
    expect("error" in junk).toBe(true);
    expect(H.api.queue.msTotal).toBe(0);
  });

  it("the queue sheds its tail instead of closing when the backlog blows out", async () => {
    // A never-resolving executor so jobs pile up rather than drain.
    const stuck = {
      run: () => new Promise<never>(() => { /* deliberately never settles */ }),
      dispose: () => { /* nothing */ },
    };
    const api = new CompetitiveApi({
      store: H.db.competitive, db: H.db, tokens: H.tokens,
      executor: stuck as never, budgetMsPerSec: 1000, shedBacklogSec: 1,
      now: () => H.now,
    });
    H.link("acct-flood");
    H.link("acct-honest");
    const { bytes } = run(101, 3);
    const first = await api.submit(new Uint8Array(bytes), "acct-honest", "Honest", "1.0.0.1");
    for (let i = 0; i < 6; i++) {
      await api.submit(new Uint8Array(run(101, 3).bytes), "acct-flood", "Flood", "1.0.0.2");
      H.now += 1000;
    }
    // The board is still open, and something got shed rather than refused.
    expect(api.queue.shed).toBeGreaterThan(0);
    if (!("error" in first)) {
      const row = api.store.getRun(first.runId)!;
      expect(["verifying", "claimed"]).toContain(row.state);
    }
    api.close();
  }, 60_000);
});

describe("privacy (COMPETITIVE.md 8.1) and FORGET ME", () => {
  it("a private run RANKS but is never distributed", async () => {
    H.link("acct-p1");
    const out = await H.api.submit(run(101, 3).bytes, "acct-p1", "Shy", "1.2.3.9", { private: true });
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    const row = H.api.store.getRun(out.runId)!;
    expect(row.state).toBe("verified");
    expect(row.private).toBe(true);
    // It takes its rightful place on the board...
    const board = H.api.store.board({ kind: "deepest", verifiedOnly: true });
    expect(board.some((r) => r.id === out.runId)).toBe(true);
    // ...and is never offered as a ghost.
    expect(H.api.publicRun(row).playable).toBe(false);
    // The toggle is owner-only.
    expect(H.api.store.setPrivate(out.runId, "someone-else", false)).toBe(false);
    expect(H.api.store.setPrivate(out.runId, "acct-p1", false)).toBe(true);
    expect(H.api.publicRun(H.api.store.getRun(out.runId)!).playable).toBe(true);
  }, 60_000);

  it("FORGET ME erases proofs, board rows, CP, mastery and follows", async () => {
    H.link("acct-del");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 3);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(evt.id, "acct-del", 1);
    const out = await H.api.submit(encodeProof(proof), "acct-del", "Ghost", "1.2.3.10");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();

    H.db.competitive.follow("acct-del", "acct-other", H.now);
    H.db.competitive.follow("acct-other", "acct-del", H.now);
    H.db.competitive.bumpMastery("acct-del", "airstrike", 100, H.now);
    H.db.recordTips("acct-del", ["lowhp"], H.now);

    const season = seasonIdFor(H.now);
    const row = H.api.store.getRun(out.runId)!;
    expect(row.state).toBe("verified");
    expect(H.db.competitive.seasonCp("acct-del", season)).not.toBeNull();
    expect(H.db.competitive.getProof(row.proofId!)).not.toBeNull();
    expect(H.api.store.board({ kind: "deepest" }).some((r) => r.accountId === "acct-del")).toBe(true);

    H.db.deleteAccount("acct-del");

    // Everything, and this is the part the JSON boards never did.
    expect(H.api.store.getRun(out.runId)).toBeNull();
    expect(H.db.competitive.getProof(row.proofId!)).toBeNull();
    expect(H.db.competitive.seasonCp("acct-del", season)).toBeNull();
    expect(H.db.competitive.masteryOf("acct-del")).toEqual([]);
    expect(H.db.competitive.following("acct-del")).toEqual([]);
    expect(H.db.competitive.following("acct-other")).toEqual([]); // the reverse edge too
    expect(H.db.competitive.attemptsOf("acct-del", evt.id)).toBe(0);
    expect(H.db.getAccountStats("acct-del")).toBeNull();
    expect(H.db.identitiesOf("acct-del")).toEqual([]);
    expect(H.db.getTips("acct-del")).toEqual([]);
    expect(H.api.store.board({ kind: "deepest" }).some((r) => r.accountId === "acct-del")).toBe(false);
  }, 60_000);

  it("a moderation rename is one UPDATE, because rows key on the account", async () => {
    H.link("acct-name");
    const out = await H.api.submit(run(101, 3).bytes, "acct-name", "BadName", "1.2.3.11");
    if ("error" in out) throw new Error(out.error);
    H.db.competitive.renameAccount("acct-name", "Crawler #1234");
    expect(H.api.store.getRun(out.runId)!.displayName).toBe("Crawler #1234");
  }, 60_000);

  it("names are sanitized at ingress, on every row", async () => {
    H.link("acct-clean");
    const out = await H.api.submit(run(101, 3).bytes, "acct-clean", "  ​​ ", "1.2.3.12");
    if ("error" in out) throw new Error(out.error);
    expect(H.api.store.getRun(out.runId)!.displayName).toBe("Crawler");
  }, 60_000);
});

describe("schema migration from the existing DB", () => {
  it("adds the competitive tables to a live volume with no data movement", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcc-mig-"));
    const file = join(dir, "old.sqlite");
    // A "v1" database: accounts, saves, stats - the shape production runs today.
    const before = openDb(file)!;
    before.touchAccount("acct-old", "Carl", 1000);
    before.upsertParty("OLD-1", "coop", "race", 4, 1000);
    before.upsertMember("OLD-1", "acct-old", 0, "{}", 1000);
    before.bumpAccountStats("acct-old", { won: true, floor: 9, kills: 40, timeSec: 600 }, 1000);
    before.close();

    // Reopening runs the competitive schema over it, in place.
    const after = openDb(file)!;
    expect(after.getAccountStats("acct-old")).toEqual({ runs: 1, wins: 1, deepest: 9, kills: 40, timeSec: 600 });
    expect(after.getMember("OLD-1", "acct-old")).not.toBeNull();
    expect(after.competitive.countByState("verified")).toBe(0);

    // And the retired JSON board imports ONCE, as claimed rows with no era.
    const legacy = [
      { name: "Princess Donut", floor: 18, won: true, timeSec: 900, kills: 500, at: 1000 },
      { name: "Carl", floor: 12, won: false, timeSec: 700, kills: 300, at: 1001 },
    ];
    expect(after.competitive.importLegacyBoard(legacy, 60)).toBe(2);
    expect(after.competitive.importLegacyBoard(legacy, 60)).toBe(0); // idempotent
    const rows = after.competitive.board({ kind: "deepest" });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // History, not evidence: recorded under pre-dmath rules by clients whose
      // Math.sin we now know disagreed across engines.
      expect(r.state).toBe("claimed");
      expect(r.rulesHash).toBeNull();
    }
    expect(rows[0].displayName).toBe("Princess Donut");
    after.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("band records require TRAVERSAL, not attendance (COMPETITIVE.md 3.3)", () => {
  it("ranks a band the run walked out of, and never one it died inside", async () => {
    H.link("acct-b1");
    // A bot run that ends on floor 4: it TRAVERSED band 0 (floors 1-3) and
    // merely entered band 1. Under the old rule its band-1 split - a few
    // seconds of dying - was a record, and the optimal play for any band board
    // was to step into the band and stop.
    const out = await H.api.submit(run(224, 6).bytes, "acct-b1", "Carl", "1.2.3.40");
    expect("error" in out).toBe(false);
    await H.api.queue.drain();
    if ("error" in out) return;
    const row = H.db.competitive.getRun(out.runId)!;
    expect(row.state).toBe("verified");
    expect(row.won).toBe(false);
    // Bands the run got OUT of are records; the one it stopped in is not, and
    // is not even stored - the predicate is applied at write time so a
    // forgotten WHERE on some future read cannot resurrect it.
    const dyingBand = Math.floor((row.floor - 1) / 3);
    expect(dyingBand).toBeGreaterThan(0); // the fixture has to cross a band
    const bests = H.db.competitive.bandBests("acct-b1");
    for (let b = 0; b < 6; b++) {
      const board = H.db.competitive.bandBoard(b);
      if (b < dyingBand) {
        expect(board.map((r) => r.id)).toContain(out.runId);
        expect(board[0].bandTicks).toBeGreaterThan(0);
        expect(bests[b]).toBeGreaterThan(0);
      } else {
        expect(board).toHaveLength(0);
        expect(bests[b]).toBeNull();
      }
    }
  });

  it("bandBests is the same query the board runs, so the profile cannot disagree", async () => {
    H.link("acct-b2");
    const out = await H.api.submit(run(221, 6).bytes, "acct-b2", "Donut", "1.2.3.41");
    await H.api.queue.drain();
    if ("error" in out) return;
    const board = H.db.competitive.bandBoard(0).find((r) => r.accountId === "acct-b2")!;
    expect(H.db.competitive.bandBests("acct-b2")[0]).toBe(board.bandTicks);
    // ...and the profile projection carries it, so the career panel has no
    // reason to keep a ledger of its own.
    const prof = H.api.profile("acct-b2", H.now) as { bandBests: (number | null)[] };
    expect(prof.bandBests[0]).toBe(board.bandTicks);
  });

  it("ties are broken by an order the board can print, not by luck", async () => {
    H.link("acct-t1");
    H.link("acct-t2");
    // The SAME seed played by two accounts: identical splits to the tick.
    const a = await H.api.submit(run(222, 6).bytes, "acct-t1", "Elle", "1.2.3.42");
    await H.api.queue.drain();
    H.now += 60_000;
    const b = await H.api.submit(run(222, 6).bytes, "acct-t2", "Ferdinand", "1.2.3.43");
    await H.api.queue.drain();
    if ("error" in a || "error" in b) return;
    const rows = H.db.competitive.bandBoard(0);
    expect(rows).toHaveLength(2);
    expect(rows[0].bandTicks).toBe(rows[1].bandTicks); // a real tie
    // Earliest CERTIFICATION wins it. Deterministic, and stated on the board.
    expect(rows[0].id).toBe(a.runId);
    expect(rows[0].verifiedAt!).toBeLessThanOrEqual(rows[1].verifiedAt!);
  });

  it("backfills and purges an existing run_bands table on migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dcc-band-"));
    const file = join(dir, "old.sqlite");
    const before = openDb(file)!;
    before.competitive.insertRun({
      id: "deep", accountId: "a", displayName: "Deep", seed: 1, won: false, floor: 7,
      timeTicks: 9000, kills: 10, level: 5, state: "verified", createdAt: 1000,
    });
    before.competitive.insertRun({
      id: "shallow", accountId: "b", displayName: "Shallow", seed: 1, won: false, floor: 2,
      timeTicks: 300, kills: 1, level: 1, state: "verified", createdAt: 1000,
    });
    before.close();

    // Rewind run_bands to the PRE-MIGRATION shape - no completeness column -
    // and fill it the way the old build did: any band the run merely entered.
    const Sqlite = (await import("better-sqlite3")).default;
    const raw = new Sqlite(file);
    raw.exec("DROP TABLE run_bands");
    raw.exec(
      "CREATE TABLE run_bands (run_id TEXT NOT NULL, band INTEGER NOT NULL, ticks INTEGER NOT NULL,"
      + " PRIMARY KEY (run_id, band))",
    );
    const ins = raw.prepare("INSERT INTO run_bands (run_id, band, ticks) VALUES (?, ?, ?)");
    ins.run("deep", 0, 5000); // walked out of band 0
    ins.run("shallow", 0, 300); // died inside it, with a "record" split
    raw.close();

    const after = openDb(file)!;
    const rows = after.competitive.bandBoard(0);
    expect(rows.map((r) => r.id)).toEqual(["deep"]);
    // The unqualifiable row is GONE, not merely hidden: it was written by a
    // build that did not know the difference between a split and a record.
    const check = new Sqlite(file);
    expect((check.prepare("SELECT COUNT(*) c FROM run_bands").get() as { c: number }).c).toBe(1);
    check.close();
    after.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("proof retention (COMPETITIVE.md 2.4 Storage)", () => {
  it("keeps board rows and your own last 10, and evicts the rest", async () => {
    H.link("acct-r1");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await H.api.submit(run(101, 3).bytes, "acct-r1", "Keeper", "1.2.3.13");
      if ("error" in out) throw new Error(out.error);
      ids.push(out.runId);
      H.now += 60_000;
    }
    await H.api.queue.drain();
    const kept = H.db.competitive.sweepProofs(10, 100);
    expect(kept).toBe(0); // all three are recent AND on the board
    for (const id of ids) {
      const row = H.api.store.getRun(id)!;
      expect(H.db.competitive.getProof(row.proofId!)).not.toBeNull();
    }
    // With retention of one, the older two lose their film - the ROW and every
    // verifier-derived fact on it survive. A photograph instead of a film.
    H.db.competitive.sweepProofs(1, 0);
    const oldest = H.api.store.getRun(ids[0])!;
    expect(oldest.state).toBe("verified");
    expect(oldest.bandSplits).not.toBeNull();
    expect(H.db.competitive.getProof(oldest.proofId!)).toBeNull();
    expect(H.api.publicRun(oldest).playable).toBe(true);
  }, 60_000);
});

describe("the numbers on the wire", () => {
  it("a whole run is a few tens of KB, and the ladder says which era it is from", async () => {
    H.link("acct-w1");
    const { bytes } = run(101, 6);
    expect(bytes.length).toBeLessThan(128 * 1024);
    const out = await H.api.submit(bytes, "acct-w1", "Carl", "1.2.3.14");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    const pub = H.api.publicRun(H.api.store.getRun(out.runId)!);
    expect(pub.rulesEra).toBe(RULES_HASH.slice(0, 7));
    expect(pub.state).toBe("verified");
    expect(pub.timeSec).toBeGreaterThan(0);
    expect(H.api.stats().verify_ms_total).toBeGreaterThan(0);
    void DAY_MS;
  }, 60_000);
});

describe("FORGET ME is harder to trigger than knowing a token (COMPETITIVE.md 2.7)", () => {
  it("an anonymous delete needs a two-step confirm nonce", () => {
    const t = new TokenService("s");
    expect(t.checkDeleteNonce("garbage", "acct-1", Date.now())).toBe(false);
    const nonce = t.issueDeleteNonce("acct-1", Date.now());
    expect(t.checkDeleteNonce(nonce, "acct-1", Date.now())).toBe(true);
    // Bound to the account, and short-lived.
    expect(t.checkDeleteNonce(nonce, "acct-2", Date.now())).toBe(false);
    expect(t.checkDeleteNonce(nonce, "acct-1", Date.now() + 10 * 60_000)).toBe(false);
  });
});

describe("the wire path the browser actually uses", () => {
  it("a GZIPPED upload verifies (the artifact is inflated once, not stored twice)", async () => {
    // Regression guard for a bug that cost an honest run its seal: the client
    // compresses the container, the server stored the bytes AS SENT and gzipped
    // them again, and the worker - which inflates exactly once - then rejected a
    // perfectly good proof for "bad magic". Rejecting an honest run over an
    // encoding detail is the worst failure this subsystem can have.
    H.link("acct-gz");
    const { bytes } = run(101, 3);
    const out = await H.api.submit(gzipSync(Buffer.from(bytes)), "acct-gz", "Carl", "1.2.3.20");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(true);
    await H.api.queue.drain();
    const row = H.api.store.getRun(out.runId)!;
    expect(row.rejectReason).toBeNull();
    expect(row.state).toBe("verified");
    // And the stored proof is a single-gzip artifact the ghost path can read.
    const proof = H.db.competitive.getProof(row.proofId!)!;
    expect(proof.bytes[0]).toBe(0x1f);
  }, 60_000);

  it("the worker executor and the inline one produce the same verdict", async () => {
    const { verifyArtifact } = await import("../src/server/verifyWorker");
    const { bytes } = run(13, 3);
    const a = await verifyArtifact({ id: "a", bytes, budgetMsPerSec: 1000 });
    const b = await verifyArtifact({ id: "b", bytes: gzipSync(Buffer.from(bytes)), budgetMsPerSec: 1000 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.summary).toEqual(a.summary);
  }, 60_000);
});
