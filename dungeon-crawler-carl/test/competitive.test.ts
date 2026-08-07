import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb, type PersistDb } from "../src/server/db";
import { CompetitiveApi } from "../src/server/competitiveApi";
import { TokenService } from "../src/server/tokens";
import { InlineExecutor } from "../src/server/verifyExecutor";
import { cpFor, dailyEvent, seasonIdFor, standingFor, TIER_MIN_ACCOUNTS, weeklyEvent } from "../src/server/season";
import { encodeProof, decodeProof, REPLAY_DT, type RunProof } from "../src/sim/replay";
import { RULES_HASH } from "../src/sim/rulesHash";
import type { DailyRuleId } from "../src/sim/dailyRules";
import { recordBotRun } from "../tools/replaycheck";

// COMPETITIVE.md: the verified-run layer end to end. Every test here is one of
// the failure modes the design names - a lie, a stale era, a flood, a deleted
// account - because the only thing that makes a seal worth anything is that
// these all behave the way the document says they do.

const DAY_MS = 86_400_000;

/** Bot runs are the expensive part; record a few once and reuse the bytes.
 *  `rule` deals TODAY'S RULE into the recording (NICHE.md §4.8) — a daily
 *  contract entry has to be the ruled game, because the submit path refuses
 *  a header off the event's pinned rule. */
const cache = new Map<string, { proof: RunProof; bytes: Uint8Array }>();
function run(seed: number, floors = 3, rule: DailyRuleId | null = null): { proof: RunProof; bytes: Uint8Array } {
  const key = seed + ":" + floors + ":" + (rule ?? "base");
  let hit = cache.get(key);
  if (!hit) {
    const rec = recordBotRun(seed, floors, 400000, rule);
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
    // THE REJECTION CARRIES BOTH SIDES OF EVERY FIELD IT REFUSED. The verifier
    // holds the claim and the replay at the moment it decides, and this used to
    // print `diffClaim`'s bare identifiers ("...: status") to the player on the
    // highest-stakes negative screen in the product. A debug token is not an
    // explanation (6.2 Beat 5).
    expect(row.rejectReason).toContain("you claimed floor 18");
    expect(row.rejectReason).toContain("the replay reached floor");
    expect(row.rejectReason).toContain("99,999 kills");
    expect(row.rejectReason).not.toContain("disagrees with the replay: status");
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

  /**
   * THE ERA GATE IS KEYED TO LOADABLE SIM MODULES, NEVER TO A STRING LIST
   * (2.6f, on the server this time). verifyWorker imports exactly one sim, and
   * it used to pass the caller's `eras[]` straight through as `availableEras`
   * while `assertPlayableEra` only checked list membership - so widening
   * `eras` to four (which is what CompetitiveApiOptions.eras says will happen)
   * would have replayed era-N-2 proofs against era-N rules: silent divergence
   * with no referee, false rejections of honest runs, and false
   * certifications wherever the divergence missed the six diffed fields.
   */
  it("declaring an era with no sim behind it does not make it executable", async () => {
    H.link("acct-5");
    const api = new CompetitiveApi({
      store: H.db.competitive, db: H.db, tokens: H.tokens,
      executor: new InlineExecutor(), budgetMsPerSec: 1000,
      eras: [RULES_HASH, "b".repeat(64)], now: () => H.now,
    });
    // The current era still verifies...
    const ok = await api.submit(run(11, 2).bytes, "acct-5", "Veteran", "2.2.2.3");
    if ("error" in ok) throw new Error("unexpected error");
    await api.queue.drain();
    expect(api.store.getRun(ok.runId)!.state).toBe("verified");

    // ...and the era the deployment merely NAMED is refused, as unverifiable
    // rather than as a rejection: the row keeps whatever it earned and the
    // player is told plainly instead of accused (2.6d).
    const { proof } = run(11, 2);
    proof.header.rulesHash = "b".repeat(64);
    const foreign = await api.submit(reseal(proof), "acct-5b", "Veteran", "2.2.2.4");
    if ("error" in foreign) throw new Error("unexpected error: " + foreign.error);
    expect(foreign.state).toBe("unverifiable");
    api.close();
  }, 60_000);

  it("the row is stamped with the era it was certified UNDER, not the box's", async () => {
    // 2.6c requires `rules_hash = H`. They coincide while eras holds one entry;
    // the job now carries the PROOF's hash so they keep coinciding for the
    // right reason once sim-eras widens the list.
    H.link("acct-era");
    const { proof, bytes } = run(101, 2);
    const out = await H.api.submit(bytes, "acct-era", "Carl", "2.9.9.9");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    expect(H.api.store.getRun(out.runId)!.rulesHash).toBe(proof.header.rulesHash);
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
  /** A ticket is STAMPED (3.2A): it is signed when the contract is signed, and
   *  the run submitted under it has to be the run that followed. An honest
   *  attempt therefore looks like "signed one run-length ago". */
  function signedAgo(proof: RunProof): number {
    return H.now - Math.round(proof.header.ticks * REPLAY_DT * 1000) - 1000;
  }
  function ticketedProof(accountId: string, attempt: number, floors = 3): Uint8Array {
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    // The honest client plays the PINNED rule (§4.8) — record the ruled game;
    // recordBotRun stamps the header, and the replay executes the same rule.
    const { proof } = run(evt.seed, floors, evt.dailyRule);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(evt.id, accountId, attempt, signedAgo(proof));
    return reseal(proof);
  }

  it("an event entry with the wrong seed is refused before any CPU is spent", async () => {
    H.link("acct-e1");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(101, 2);
    proof.header.eventId = evt.id; // but header.seed is still the bot seed
    proof.header.ticket = H.tokens.issueTicket(evt.id, "acct-e1", 1, signedAgo(proof));
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
    proof.header.dailyRule = evt.dailyRule ?? undefined; // match the pin; the refusal under test is the TICKET's
    const out = await H.api.submit(reseal(proof), "acct-e2", "Carl", "3.3.3.4");
    if ("error" in out) throw new Error("unexpected error: " + out.error);
    expect(out.queued).toBe(false);
    expect(out.reason).toContain("no attempt ticket");
    expect(H.db.competitive.seasonCp("acct-e2", seasonIdFor(H.now))).toBeNull();
  }, 60_000);

  it("a forged ticket does not verify", () => {
    const evt = dailyEvent(H.now);
    const real = H.tokens.issueTicket(evt.id, "acct-x", 1, H.now);
    expect(H.tokens.readTicket(real, evt.id, "acct-x")?.attemptNo).toBe(1);
    expect(H.tokens.readTicket(real, evt.id, "acct-x")?.issuedAtMs)
      .toBe(Math.floor(H.now / 1000) * 1000);
    // Same ticket, different account: the HMAC binds both.
    expect(H.tokens.readTicket(real, evt.id, "acct-y")).toBeNull();
    const parts = real.split(".");
    // The stamp is inside the signature too, so backdating a real ticket to
    // widen its window is a forgery like any other.
    expect(H.tokens.readTicket(`${parts[0]}.1.${Number(parts[2]) - 9999}.${parts[3]}`, evt.id, "acct-x"))
      .toBeNull();
    const forged = H.tokens.issueTicket(evt.id, "acct-x", 7, H.now).split(".");
    expect(H.tokens.readTicket(`${forged[0]}.1.${forged[2]}.${forged[3]}`, evt.id, "acct-x")).toBeNull();
  });

  /**
   * THE DODGE 3.2A IS DOCUMENTED AS CLOSING, actually closed.
   *
   * The ticket signed `eventId:accountId:attemptNo` and nothing else, and
   * readTicket was a pure signature check with no single-use marking - so the
   * honest-looking sequence was: call /start once, keep ticket #1, play twenty
   * runs entirely offline, submit the best. It arrived as attempt 1,
   * scoresCp: true, and the verdict screen printed "attempt 1 on this contract
   * — the run the ladder scores", a statement the server could not back.
   */
  it("an attempt-1 ticket is single-use", async () => {
    H.link("acct-t1");
    const first = await H.api.submit(ticketedProof("acct-t1", 1, 2), "acct-t1", "Carl", "7.0.0.1");
    if ("error" in first) throw new Error(first.error);
    expect(first.queued).toBe(true);
    await H.api.queue.drain();
    // The same signature, a second time. (Same bytes, same ticket.)
    const again = await H.api.submit(ticketedProof("acct-t1", 1, 2), "acct-t1", "Carl", "7.0.0.1");
    if ("error" in again) throw new Error(again.error);
    expect(again.queued).toBe(false);
    expect(again.reason).toContain("already been spent");
    expect(H.api.store.getRun(again.runId)!.attemptNo).toBeNull();
  }, 90_000);

  it("a ticket that went cold does not back an attempt-1 CP claim", async () => {
    H.link("acct-t2");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 2, evt.dailyRule);
    proof.header.eventId = evt.id;
    // Signed two hours ago: the window holds one run, not an afternoon of them.
    proof.header.ticket = H.tokens.issueTicket(evt.id, "acct-t2", 1, H.now - 2 * 3600_000);
    const out = await H.api.submit(reseal(proof), "acct-t2", "Carl", "7.0.0.2");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.reason).toContain("gone cold");
    // The row still exists - the run happened - it simply scores nothing.
    expect(H.api.store.getRun(out.runId)!.state).toBe("claimed");
    expect(H.db.competitive.seasonCp("acct-t2", seasonIdFor(H.now))).toBeNull();
  }, 60_000);

  it("a ticket younger than the run it carries is refused", async () => {
    H.link("acct-t3");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 3, evt.dailyRule);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(evt.id, "acct-t3", 1, H.now); // signed "just now"
    const out = await H.api.submit(reseal(proof), "acct-t3", "Carl", "7.0.0.3");
    if ("error" in out) throw new Error(out.error);
    expect(out.reason).toContain("younger than the run");
  }, 60_000);

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

describe("THE DEBUT IS NOT A CONTEST (TUTORIAL.md first-run mercy)", () => {
  it("a first-run header is refused a board slot, structurally and server-side", async () => {
    H.link("acct-debut");
    const { proof } = run(101, 3);
    // The one thing that makes this run different: floor 1 was played with a
    // stipend, a held clock and killing blows converted to knockdowns. The
    // client refuses to offer it; this is the refusal that does not depend on
    // the client, exactly like the test-mode start beside it.
    proof.header.firstRun = true;
    const out = await H.api.submit(reseal(proof), "acct-debut", "Rookie", "5.5.5.5");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.state).toBe("claimed");
    expect(out.reason).toContain("debut mercy");
    expect(H.api.queue.depth).toBe(0);
  }, 60_000);
});

describe("abuse guards (COMPETITIVE.md 2.7)", () => {
  it("an anonymous account can submit, but never enters the verify queue", async () => {
    // An account is FREE, so an unlinked one may not buy the box's CPU. It is
    // never shut out of the game - only out of the ladder.
    const out = await H.api.submit(run(101, 3).bytes, "anon-acct-1", "Nobody", "6.6.6.6");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.state).toBe("claimed");
    expect(out.reason).toContain("anonymous claim");
    // ...AND THE REFUSAL IS FLAGGED, NOT JUST WORDED (6.2 Beat 5). "LINK AN
    // IDENTITY" existed only as prose in the refusal string, so the verdict had
    // no way to render a control and shipped the demand with no button. A typed
    // flag is what a copy edit cannot silently take away.
    expect(out.needsIdentity).toBe(true);
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
    // ...and the wire's `playable` flag stays honest about distribution.
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
    const { proof } = run(evt.seed, 3, evt.dailyRule);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(
      evt.id, "acct-del", 1, H.now - Math.round(proof.header.ticks * REPLAY_DT * 1000) - 1000);
    const out = await H.api.submit(encodeProof(proof), "acct-del", "Wraith", "1.2.3.10");
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
      id: "deep", accountId: "a", displayName: "Deep", seed: 1, mode: "coop", runKind: "race",
      won: false, floor: 7,
      timeTicks: 9000, kills: 10, level: 5, state: "verified", createdAt: 1000,
    });
    before.competitive.insertRun({
      id: "shallow", accountId: "b", displayName: "Shallow", seed: 1, mode: "coop", runKind: "race",
      won: false, floor: 2,
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

  /**
   * THE KEEP-SET IS A UNION ACROSS EVERY BOARD. It used to be one ordering -
   * `won DESC, floor DESC, time_ticks ASC`, which is the DEEPEST board and only
   * that one - so the FASTEST and KILLS leaders had their proofs swept while
   * their rows still held rank 1, and RACE went inert on exactly the rows 2.4
   * Storage promises to keep playable.
   */
  it("the KILLS leader keeps its film even when it is not the deepest run", async () => {
    H.link("acct-r2");
    H.link("acct-r3");
    // A deep run from one account...
    const deep = await H.api.submit(run(101, 4).bytes, "acct-r2", "Deep", "1.2.3.30");
    if ("error" in deep) throw new Error(deep.error);
    // ...and a shallower one from another, which will hold a different board.
    H.now += 60_000;
    const other = await H.api.submit(run(13, 3).bytes, "acct-r3", "Killer", "1.2.3.31");
    if ("error" in other) throw new Error(other.error);
    await H.api.queue.drain();

    // Personal retention off entirely: only board position may keep a proof.
    H.db.competitive.sweepProofs(0, 25);
    const kills = H.db.competitive.board({ kind: "kills", eventId: null, verifiedOnly: true, limit: 25 });
    expect(kills.length).toBeGreaterThan(0);
    for (const row of kills) {
      expect(H.db.competitive.getProof(row.proofId!)).not.toBeNull();
    }
    void deep;
  }, 90_000);
});

describe("the wire never carries a credential (COMPETITIVE.md 2.7 / 8.2)", () => {
  /**
   * account_id IS the bearer token. POST /runs?token=... passes it straight in
   * as the account id and TokenService.isUsable authenticates that exact
   * string, so `publicRun` returning `accountId` meant one unauthenticated
   * GET /boards/deepest handed out a working credential for every ranked
   * crawler: burn their attempt counter so their first real run can never
   * score CP, flip their sealed run private, submit a tampered proof in their
   * name for the rejection cooldown, read their linked identity, or - for an
   * anonymous account - complete their FORGET ME.
   */
  it("no projection leaks the account token, and the public id is one-way", async () => {
    H.link("acct-leak");
    const out = await H.api.submit(run(101, 3).bytes, "acct-leak", "Marked", "5.5.5.5");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();

    const row = H.api.publicRun(H.api.store.getRun(out.runId)!);
    expect(row.accountId).toBeUndefined();
    expect(typeof row.publicId).toBe("string");
    expect(JSON.stringify(row)).not.toContain("acct-leak");

    const prof = H.api.profile("acct-leak", H.now);
    expect(prof.accountId).toBeUndefined();
    expect(JSON.stringify(prof)).not.toContain("acct-leak");

    H.db.competitive.follow("acct-leak", "acct-friend", H.now);
    expect(JSON.stringify(H.api.profile("acct-leak", H.now))).not.toContain("acct-friend");

    const rc = H.api.rivalContract("acct-leak", H.now);
    expect(JSON.stringify(rc)).not.toContain("acct-leak");

    // ...and the public id still round-trips to a profile, which is the ONE
    // thing a share link and a YOU/RIVAL tag actually need it for.
    expect(H.db.competitive.accountForPublicId(String(row.publicId))).toBe("acct-leak");
  }, 60_000);
});

describe("boards state their own honesty (COMPETITIVE.md 3.2B)", () => {
  it("verified and claimed rows arrive in separate arrays, and entries is proofs only", async () => {
    // The split used to be client-side only, in one renderer, while the API
    // response's own subtitle claims "every ranked row is a proof the server
    // re-executed" - so any second consumer (a /run/<id> share page, an embed,
    // a third party, a future mobile host) rendered a fabricated floor-18 row
    // inside a payload that advertises verification.
    H.link("acct-b1");
    const good = await H.api.submit(run(101, 3).bytes, "acct-b1", "Honest", "6.6.6.1");
    if ("error" in good) throw new Error(good.error);
    await H.api.queue.drain();
    // An unlinked account's row is stored CLAIMED and never replayed.
    const claimed = await H.api.submit(run(47, 3).bytes, "acct-b2", "Unproven", "6.6.6.2");
    if ("error" in claimed) throw new Error(claimed.error);

    const page = JSON.parse(JSON.stringify({
      verified: H.db.competitive.board({ kind: "deepest", eventId: null, limit: 50 })
        .filter((r) => r.state === "verified").map((r) => H.api.publicRun(r)),
      unproven: H.db.competitive.board({ kind: "deepest", eventId: null, limit: 50 })
        .filter((r) => r.state !== "verified").map((r) => H.api.publicRun(r)),
    })) as { verified: { id: string }[]; unproven: { id: string }[] };
    expect(page.verified.map((r) => r.id)).toContain(good.runId);
    expect(page.unproven.map((r) => r.id)).toContain(claimed.runId);
    expect(page.verified.map((r) => r.id)).not.toContain(claimed.runId);
  }, 90_000);
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
    // And the stored proof is a single-gzip artifact the verifier can read.
    const proof = H.db.competitive.getProof(row.proofId!)!;
    expect(proof.bytes[0]).toBe(0x1f);
  }, 60_000);

  it("the retired proof-download endpoint answers 410, politely, never a 500", async () => {
    // Ghost racing is removed (NICHE.md §5): proofs are verification evidence,
    // not a distribution surface. Old clients may still ask - the compat shim
    // states the retirement instead of erroring, and the artifact stays on the
    // server because the seal rests on it.
    H.link("acct-gate");
    const { bytes } = run(101, 3);
    const out = await H.api.submit(bytes, "acct-gate", "Sealed", "1.2.3.40");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    const row = H.api.store.getRun(out.runId)!;
    expect(row.state).toBe("verified");
    expect(H.db.competitive.getProof(row.proofId!)).not.toBeNull(); // the film still exists

    const ask = async (token?: string): Promise<{ status: number; body: string }> => {
      const chunks: string[] = [];
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; return res; },
        setHeader() { /* no-op */ },
        end(b?: unknown) { if (b) chunks.push(String(b)); },
      } as unknown as import("node:http").ServerResponse;
      const url = `/runs/${out.runId}?proof=1${token ? `&token=${token}` : ""}`;
      await H.api.handle({ method: "GET", url, headers: {}, socket: {} } as
        unknown as import("node:http").IncomingMessage, res);
      return { status, body: chunks.join("") };
    };

    // A sealed public run, its owner, a stranger: nobody is served the film.
    const stranger = await ask();
    expect(stranger.status).toBe(410);
    expect(stranger.body).toContain("RETIRED");
    expect((await ask("acct-gate")).status).toBe(410);
    // The metadata route is untouched - the verdict poll still works.
    const meta = await (async () => {
      const chunks: string[] = [];
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; return res; },
        setHeader() { /* no-op */ },
        end(b?: unknown) { if (b) chunks.push(String(b)); },
      } as unknown as import("node:http").ServerResponse;
      await H.api.handle({ method: "GET", url: `/runs/${out.runId}`, headers: {}, socket: {} } as
        unknown as import("node:http").IncomingMessage, res);
      return { status, body: chunks.join("") };
    })();
    expect(meta.status).toBe(200);
    expect(meta.body).toContain(out.runId);
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

/**
 * THE TWO EXPLOITS THIS ROUND CLOSED, AND THE BLIND SPOT THAT ALLOWED THEM.
 *
 * `grep -n 'roam|runKind|partySize' test/competitive.test.ts` returned NOTHING
 * before this block, and test/replay.test.ts uses `runKind: "race"` in both
 * places it appears. Forty excellent tests, and the one dimension the verifier
 * never checked was the one dimension nothing asserted. A three-line case in a
 * file that already builds proofs would have caught both.
 */
describe("which GAME a row was played under (COMPETITIVE.md 2.5 step 2)", () => {
  it("an unverified RULESET never reaches a board that presents as verified", async () => {
    // MEASURED, not reasoned: the shipped bot on seed 2024, recorded twice with
    // a 40k-step cap and run through the real verifyArtifact, ended a RACE dead
    // on floor 5 with 115 kills and ended a ROAM on floor 16 with 171 kills and
    // a roam-only ultimate - `ok: true`, CERTIFIED. Roam floors have no boss
    // gate and a flat 30-minute budget instead of floorTimeBudget, so the same
    // policy walks about four times as far. That row takes DEEPEST, owns KILLS
    // outright, and takes every band board - the boards 3.3 calls the most
    // winnable - at roughly 2x pace. `validateProofShape` never looked at
    // `header.runKind`, and `ReplaySession` builds the world straight from it.
    H.link("acct-roam");
    const { proof } = run(101, 3);
    proof.header.runKind = "roam";
    const out = await H.api.submit(reseal(proof), "acct-roam", "Wanderer", "7.7.7.1");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.reason).toContain("ROAM");
    expect(H.api.queue.depth).toBe(0);
    expect(H.api.store.getRun(out.runId)!.state).toBe("claimed");
  }, 60_000);

  it("the worker refuses the same header even if the door is bypassed", async () => {
    // The gate is applied in BOTH places on purpose: a hand-rolled artifact
    // must never reach ReplaySession, which would happily build a roam world.
    const { verifyArtifact } = await import("../src/server/verifyWorker");
    const { proof } = run(101, 2);
    proof.header.runKind = "roam";
    const v = await verifyArtifact({ id: "r", bytes: reseal(proof), budgetMsPerSec: 1000 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("ROAM");
  }, 60_000);

  it("stores WHICH GAME on the row, so a certified row can be audited later", async () => {
    H.link("acct-kind");
    const out = await H.api.submit(run(101, 3).bytes, "acct-kind", "Carl", "7.7.7.2");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    const row = H.api.store.getRun(out.runId)!;
    expect(row.runKind).toBe("race");
    expect(row.mode).toBe("coop");
  }, 60_000);

  it("party size is never a self-reported field on a proof-verified row", async () => {
    // `partySize: Number(q.get("size") ?? 1)` was stored, returned on the wire
    // and printed as "party of N" beside the gold seal - and NOTHING in
    // ReplaySession.summary() or VerifiedFacts derives or contradicts it, while
    // board({partySize}) filters on it and splitEntrants counts it toward
    // opening the co-op split boards 7.4 defines. Worse than merely unverified:
    // MUST-3 does not record party runs at all, so every "party of N>1" on a
    // proof-verified row was necessarily fabricated. POST /runs?size=6 put a
    // solo run on the 5-6 board with the gold seal.
    H.link("acct-party");
    const { Readable } = await import("node:stream");
    const res = {
      writeHead() { return res; }, setHeader() { /* no-op */ }, end() { /* no-op */ },
    } as unknown as import("node:http").ServerResponse;
    const body = Buffer.from(run(101, 3).bytes);
    const req = Object.assign(
      new Readable({ read() { this.push(body); this.push(null); } }),
      { method: "POST", url: "/runs?token=acct-party&name=Solo&size=6", headers: {}, socket: {} },
    ) as unknown as import("node:http").IncomingMessage;
    await H.api.handle(req, res);
    await H.api.queue.drain();
    const rows = H.api.store.runsByAccount("acct-party", 5);
    expect(rows.length).toBe(1);
    expect(rows[0].partySize).toBe(1);
  }, 60_000);
});

describe("a capability failure is UNVERIFIABLE, never REJECTED (2.6d)", () => {
  it("running out of verification clock does not accuse the player", async () => {
    // `rejected` is the state reserved for "the claim was false": it prints THE
    // SYSTEM DISAGREES WITH YOU / REFUSED and costs the account a ten-minute
    // cooldown. It was returned for the wall-clock ceiling, a replay throw, a
    // worker crash, a closed executor and a failed spawn. `spent()` is WALL
    // CLOCK including the duty sleeps, so the ceiling is not theoretical -
    // there is a run length past which this ladder called honest players
    // cheats, and nothing stated it.
    const { verifyArtifact, maxCertifiableTicks } = await import("../src/server/verifyWorker");
    const v = await verifyArtifact({
      id: "slow", bytes: run(101, 4).bytes, budgetMsPerSec: 1000, ceilingMs: 1,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.state).toBe("unverifiable");
      expect(v.detail).toMatch(/sim-minutes/);
    }
    // ...and the boundary is a number the product can print, not folklore.
    //
    // The third argument is the box-speed MULTIPLIER now, not an absolute
    // us/tick: per-tick cost is a function of DEPTH (2.3: 20 us in a boss
    // arena, 675 us on floor 16), so a scalar described the last thing
    // submitted rather than the machine, and every submitter could move it
    // (round-4 blocker 8). These assertions are STRICTLY STRONGER than the two
    // they replace - the monotonicity is still required, and it is now required
    // to hold WITHOUT the ceiling ever falling below a full clear.
    expect(maxCertifiableTicks(250, 120_000, 1)).toBeGreaterThan(60_000);
    // A genuinely slower box still certifies less, at a budget where the
    // full-clear floor is not the binding constraint.
    expect(maxCertifiableTicks(250, 20_000, 2))
      .toBeLessThan(maxCertifiableTicks(250, 20_000, 0.5));
    // ...but no measurement, however extreme, takes the PRODUCTION ceiling
    // below the length of a full clear. This is the half that was missing.
    expect(maxCertifiableTicks(250, 120_000, 50)).toBeGreaterThanOrEqual(60_000);
  }, 60_000);

  it("an over-long run is refused at the door, before the clock is spent", async () => {
    H.link("acct-long");
    const api = new CompetitiveApi({
      store: H.db.competitive, db: H.db, tokens: H.tokens, executor: new InlineExecutor(),
      budgetMsPerSec: 1000, ceilingMs: 1, now: () => H.now,
    });
    try {
      const out = await api.submit(run(101, 3).bytes, "acct-long", "Marathon", "8.8.8.1");
      if ("error" in out) throw new Error(out.error);
      expect(out.state).toBe("unverifiable");
      expect(out.reason).toContain("sim-minutes");
      expect(out.reason).not.toMatch(/claim|cheat|disagree/i);
    } finally {
      api.close();
    }
  }, 60_000);
});

describe("TODAY'S RULE is the event's, never the header's (NICHE.md §4.8)", () => {
  // The attack this kills: the header's `dailyRule` decides which game the
  // verifier replays, so an unchecked header let a doctored client record
  // today's daily seed under whatever rule sweeps easiest, pass byte-exact
  // verification, and take a SEALED row on a board where every honest client
  // played the pinned rule — the self-reported-difficulty hole, on the one
  // surface whose pitch is "results the server can prove".
  function ticketFor(accountId: string, proof: RunProof, eventId: string): void {
    proof.header.eventId = eventId;
    proof.header.ticket = H.tokens.issueTicket(
      eventId, accountId, 1, H.now - Math.round(proof.header.ticks * REPLAY_DT * 1000) - 1000);
  }

  it("a base-game recording of a ruled day's seed is refused at the door", async () => {
    H.link("acct-r1");
    const evt = dailyEvent(H.now);
    // Load-bearing precondition: the rotation is live and today deals a rule.
    expect(evt.dailyRule).not.toBeNull();
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 2); // base game — the doctored client's chosen difficulty
    ticketFor("acct-r1", proof, evt.id);
    const out = await H.api.submit(reseal(proof), "acct-r1", "Doctored", "8.1.1.1");
    expect("error" in out && out.error).toContain("today's rule does not match");
    // Nothing was stored and no CPU was spent — same class as a seed mismatch.
    expect(H.api.store.runsByAccount("acct-r1", 10)).toEqual([]);
  }, 60_000);

  it("a header claiming a rule the day did not deal is refused the same way", async () => {
    H.link("acct-r2");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const wrong: DailyRuleId = evt.dailyRule === "rush_hour" ? "hair_trigger" : "rush_hour";
    const { proof } = run(evt.seed, 2, wrong);
    ticketFor("acct-r2", proof, evt.id);
    const out = await H.api.submit(reseal(proof), "acct-r2", "Doctored", "8.1.1.2");
    expect("error" in out && out.error).toContain("today's rule does not match");
  }, 60_000);

  it("the honest ruled run verifies and takes the daily board", async () => {
    H.link("acct-r3");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 2, evt.dailyRule);
    ticketFor("acct-r3", proof, evt.id);
    const out = await H.api.submit(reseal(proof), "acct-r3", "Honest", "8.1.1.3");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(true);
    await H.api.queue.drain();
    expect(H.api.store.getRun(out.runId)!.state).toBe("verified");
    expect(H.api.store.board({ kind: "deepest", eventId: evt.id, verifiedOnly: true })
      .some((r) => r.id === out.runId)).toBe(true);
  }, 60_000);

  it("the PIN outranks a live recompute: a grown rotation cannot re-deal today", async () => {
    // The deploy hazard: dailyRuleFor is modulo the rotation length, so
    // growing DAILY_RULE_ROTATION would re-deal the CURRENT day mid-day and
    // split the board across two rules. The event row pinned at creation is
    // the truth; a second upsert (a later ensureEvents) must not move it,
    // and submit must check the ROW, not the calendar.
    H.link("acct-r4");
    const evt = dailyEvent(H.now);
    const pinned: DailyRuleId = evt.dailyRule === "overstaffed" ? "rush_hour" : "overstaffed";
    // The row as "yesterday's build" pinned it, before the rotation grew...
    H.db.competitive.upsertEvent({ ...evt, dailyRule: pinned, rulesHash: RULES_HASH });
    // ...and today's ensureEvents-shaped upsert does not re-deal it.
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    expect(H.db.competitive.getEvent(evt.id)!.dailyRule).toBe(pinned);

    // The live recompute's rule is refused — the board stays one game...
    const recomputed = run(evt.seed, 2, evt.dailyRule);
    ticketFor("acct-r4", recomputed.proof, evt.id);
    const refused = await H.api.submit(reseal(recomputed.proof), "acct-r4", "Late", "8.1.1.4");
    expect("error" in refused && refused.error).toContain("today's rule does not match");

    // ...and the pinned rule verifies, replayed under the pin.
    const honest = run(evt.seed, 2, pinned);
    ticketFor("acct-r4", honest.proof, evt.id);
    const out = await H.api.submit(reseal(honest.proof), "acct-r4", "Early", "8.1.1.4");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    expect(H.api.store.getRun(out.runId)!.state).toBe("verified");
  }, 90_000);

  it("a ruled run with no contract attached holds no rank on the museum", async () => {
    // OVERSTAFFED alone deals a second elite per floor — free kills against
    // every base-game row on the all-time KILLS board. A ruled run counts on
    // its day's contract or nowhere; the row is kept, told plainly, unranked.
    H.link("acct-r5");
    const { proof } = run(101, 3, "overstaffed");
    const out = await H.api.submit(reseal(proof), "acct-r5", "Freelancer", "8.1.1.5");
    if ("error" in out) throw new Error(out.error);
    expect(out.queued).toBe(false);
    expect(out.reason).toContain("counts on its day's contract");
    expect(H.api.store.getRun(out.runId)!.state).toBe("claimed");
    expect(H.api.store.board({ kind: "kills", verifiedOnly: true })
      .some((r) => r.id === out.runId)).toBe(false);
  }, 60_000);

  it("the weekly contract pins the base game", () => {
    const wk = weeklyEvent(H.now);
    expect(wk.dailyRule).toBeNull();
    H.db.competitive.upsertEvent({ ...wk, rulesHash: RULES_HASH });
    expect(H.db.competitive.getEvent(wk.id)!.dailyRule).toBeNull();
  });
});

describe("the museum is not free-seeds-only (COMPETITIVE.md 3.2B)", () => {
  it("a sealed contract run appears on the all-time board the seal names", async () => {
    // `eventId: null` compiled to `event_id IS NULL`, and /boards/:kind with no
    // `event` param passed null - so EVERY event run was excluded from every
    // all-time board by construction. Live: the verdict said the run holds a
    // position on DEEPEST and KILLS while both boards answered `entries: 0` and
    // THE STANDINGS printed "this museum is empty".
    H.link("acct-museum");
    const evt = dailyEvent(H.now);
    H.db.competitive.upsertEvent({ ...evt, rulesHash: RULES_HASH });
    const { proof } = run(evt.seed, 3, evt.dailyRule);
    proof.header.eventId = evt.id;
    proof.header.ticket = H.tokens.issueTicket(
      evt.id, "acct-museum", 1,
      H.now - Math.round(proof.header.ticks * REPLAY_DT * 1000) - 1000);
    const out = await H.api.submit(reseal(proof), "acct-museum", "Carl", "9.1.1.1");
    if ("error" in out) throw new Error(out.error);
    await H.api.queue.drain();
    expect(H.api.store.getRun(out.runId)!.state).toBe("verified");

    // THE MUSEUM: every scope.
    const museum = H.db.competitive.board({ kind: "deepest", verifiedOnly: true, limit: 25 });
    expect(museum.some((r) => r.id === out.runId)).toBe(true);
    // ...and the seal names BOTH boards it holds, each with its scope, so the
    // player finds what the phrase promised.
    const boards = H.db.competitive.holdsBoards(out.runId);
    expect(boards).toContain("deepest");
    expect(boards).toContain("deepest@" + evt.id);
    // Free-seeds-only is still expressible; it is just not the default.
    expect(H.db.competitive.board({ kind: "deepest", eventId: null, verifiedOnly: true }).length)
      .toBe(0);
  }, 60_000);
});

describe("FORGET ME reaches the rows that have no account", () => {
  it("deletes the imported legacy copy, not just the JSON row", () => {
    // importLegacyBoard keys every imported row `legacy:<name>` and runs
    // unconditionally at boot; deleteAccount only ever matched account_id, and
    // the name cascade reached the JSON file alone. So after a FORGET ME the
    // JSON row went and the SQLite copy of the same crawler survived forever,
    // publicly, in the UNPROVEN shelf on THE STANDINGS - 1.2's "LIVE privacy
    // gap", re-opened by the migration that was supposed to close it.
    const store = H.db.competitive;
    const n = store.importLegacyBoard([
      { name: "Departed", floor: 7, won: false, timeSec: 300, kills: 40, at: H.now },
      { name: "Kept", floor: 5, won: false, timeSec: 200, kills: 20, at: H.now },
    ], 60);
    expect(n).toBe(2);
    expect(store.deleteByDisplayNames(["departed"])).toBe(1); // case-insensitive
    const left = store.board({ kind: "deepest", limit: 50 });
    expect(left.some((r) => r.displayName === "Departed")).toBe(false);
    expect(left.some((r) => r.displayName === "Kept")).toBe(true);
  });
});
