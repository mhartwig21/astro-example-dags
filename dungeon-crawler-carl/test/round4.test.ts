/**
 * ROUND 4 — the board is the gate, not the door.
 *
 * Every test here is a reproduction first: the failure it asserts against was
 * measured on the shipping tree with `tools/repro-r4.ts`, against a real server
 * on its own volume, and the numbers in the comments are that run's output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PersistDb } from "../src/server/db";
import { CompetitiveApi } from "../src/server/competitiveApi";
import { CompetitiveStore, compareDeepest, publicIdFor } from "../src/server/competitive";
import { TokenService } from "../src/server/tokens";
import { InlineExecutor } from "../src/server/verifyExecutor";
import { VerifyQueue } from "../src/server/verify";
import { FULL_CLEAR_TICKS, tickCostUs } from "../src/server/verifyWorker";
import { RULES_HASH } from "../src/sim/rulesHash";
import type { RunSummary } from "../src/sim/replay";

interface Harness {
  dir: string;
  db: PersistDb;
  api: CompetitiveApi;
  tokens: TokenService;
  now: number;
  store: CompetitiveStore;
  link(accountId: string): void;
}

let H: Harness;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dcc-r4-"));
  const db = openDb(join(dir, "t.sqlite"))!;
  const tokens = new TokenService("test-secret");
  H = {
    dir, db, tokens, now: Date.UTC(2026, 7, 2, 12), store: db.competitive,
    api: null as unknown as CompetitiveApi,
    link(accountId: string) { db.linkIdentity("discord", "d-" + accountId, accountId, "Crawler", this.now); },
  };
  H.api = new CompetitiveApi({
    store: db.competitive, db, tokens, executor: new InlineExecutor(),
    budgetMsPerSec: 1000, now: () => H.now,
  });
});
afterEach(() => { H.api.close(); H.db.close(); rmSync(H.dir, { recursive: true, force: true }); });

/** Drive the real router and collect what it wrote. No shortcuts through the
 *  handlers: the throttle and the cache live in `handle`, so a test that calls
 *  the projection directly proves nothing about either. */
async function get(path: string): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let chunk = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body?: string) { chunk = body ?? ""; return this; },
  } as unknown as import("node:http").ServerResponse;
  const handled = await H.api.handle(
    { url: path, method: "GET", headers: {}, socket: { remoteAddress: "9.9.9.9" } } as unknown as
      import("node:http").IncomingMessage,
    res,
  );
  expect(handled).toBe(true);
  return { status, body: chunk ? JSON.parse(chunk) : null };
}

/** A certified permadeath clear, exactly the shape the submit path produces. */
function sealedClear(id: string, name: string, at: number): void {
  H.store.insertRun({
    id, accountId: "acct-" + id, displayName: name, seed: 4242, rulesHash: RULES_HASH,
    mode: "coop", runKind: "race", partySize: 1, won: true, floor: 18, timeTicks: 54_398,
    kills: 1_180, level: 24, ultimate: "cataclysm", state: "verified", proofId: "p-" + id,
    createdAt: at,
  });
  H.store.certify(id, {
    won: true, floor: 18, timeTicks: 54_398, kills: 1_180, level: 24, ultimate: "cataclysm",
    bandSplits: [3200, 5100, 7400, 9800, 12_600, 16_298],
    bandComplete: [true, true, true, true, true, true],
    deathCause: null, finalBuild: null, damageDealt: 480_000, damageTaken: 96_000,
    goldSpent: 22_000, rulesHash: RULES_HASH,
  }, at + 1000);
}

describe("a ruleset the board does not rank never reaches it (blocker 1)", () => {
  it("a SOLO rivals contract holds no board position, above or below a certified clear", () => {
    // THE CHAIN, all of it reachable from the shipping menu:
    //   ?rivals=1&join=CODE with one player -> mode "rivals"
    //   handlePlayerDeath -> a 15s time-out, never a run end (no permadeath)
    //   tickInstanceBody  -> insertServerVouched on the win, state "verified"
    //   board()           -> no mode/runKind predicate at all
    // Measured on the shipping tree: floor 18 / 30,000 ticks / 2,400 kills /
    // proof_id NULL took rank 1 on DEEPEST, FASTEST, KILLS and CONTRACTS
    // simultaneously, above a certified 54,398-tick permadeath clear.
    sealedClear("honest", "KATIA", H.now - 60_000);
    H.store.insertServerVouched({
      id: "rivals-solo", accountId: "acct-exploit", displayName: "CARL", eventId: null,
      seed: 777, mode: "rivals", runKind: "race", partySize: 1, won: true, floor: 18,
      timeTicks: 30_000, kills: 2_400, level: 30, ultimate: "airstrike",
      state: "verified", rulesHash: RULES_HASH, createdAt: H.now,
    }, H.now);

    for (const kind of ["deepest", "fastest", "kills", "contracts"] as const) {
      const rows = H.store.board({ kind, verifiedOnly: true, limit: 25 });
      expect(rows.some((r) => r.id === "rivals-solo"), kind).toBe(false);
      expect(rows[0]?.id, kind).toBe("honest");
    }
    // ...and every OTHER consumer of the predicate agrees, which is the whole
    // reason it lives on the board rather than on one door.
    expect(H.store.holdsBoards("rivals-solo")).toEqual([]);
    expect(H.store.wouldRank("deepest", H.store.getRun("rivals-solo")!, 25)).toBe(false);
    expect(H.store.wouldRank("contracts", H.store.getRun("rivals-solo")!, 25)).toBe(false);
    // The row is not deleted and not hidden. It is simply not a board row.
    expect(H.store.getRun("rivals-solo")!.state).toBe("verified");
  });

  it("a REAL rivals contract still takes the contracts board, and only that board", () => {
    // 1.1: the one score the server vouches for itself. Two seats means there
    // was a race, and that is what makes it a contract rather than a lap.
    H.store.insertServerVouched({
      id: "rivals-real", accountId: "acct-pair", displayName: "MORDECAI", eventId: null,
      seed: 88, mode: "rivals", runKind: "race", partySize: 2, won: true, floor: 18,
      timeTicks: 41_000, kills: 900, level: 26, ultimate: "airstrike",
      state: "verified", rulesHash: RULES_HASH, createdAt: H.now,
    }, H.now);
    expect(H.store.board({ kind: "contracts", verifiedOnly: true, limit: 25 })
      .some((r) => r.id === "rivals-real")).toBe(true);
    for (const kind of ["deepest", "fastest", "kills"] as const) {
      expect(H.store.board({ kind, verifiedOnly: true, limit: 25 })
        .some((r) => r.id === "rivals-real"), kind).toBe(false);
    }
    expect(H.store.holdsBoards("rivals-real")).toEqual(["contracts"]);
  });

  it("a sealed row may not assert a ruleset it was not played under (blocker 2)", () => {
    // insertServerVouched never passed runKind and insertRun defaulted it to
    // "race", so a {rivals: true, roam: true} party wrote a VERIFIED row
    // claiming the race ruleset. Measured on the shipping tree: run_kind "race"
    // on a roam instance, holding CONTRACTS rank 1.
    const asItWasCalled = {
      id: "roam-vouched", accountId: "acct-roam", displayName: "GNAW", eventId: null,
      seed: 99, mode: "rivals", partySize: 2, won: true, floor: 18, timeTicks: 12_000,
      kills: 3_000, level: 30, ultimate: "airstrike", state: "verified" as const,
      rulesHash: RULES_HASH, createdAt: H.now,
      // NOTE: no runKind. That is the bug, verbatim.
    } as unknown as Parameters<CompetitiveStore["insertServerVouched"]>[0];
    expect(() => H.store.insertServerVouched(asItWasCalled, H.now))
      .toThrow(/which game it was played under/);

    // ...and when it IS stated, the roam row exists and reaches no board.
    H.store.insertServerVouched({
      ...(asItWasCalled as unknown as Record<string, unknown>), runKind: "roam",
    } as unknown as Parameters<CompetitiveStore["insertServerVouched"]>[0], H.now);
    expect(H.store.getRun("roam-vouched")!.runKind).toBe("roam");
    expect(H.store.holdsBoards("roam-vouched")).toEqual([]);
  });
});

describe("the contract board does not reward dying faster (blocker 4)", () => {
  const deaths: [string, number, number, number][] = [
    ["QUITTER", 1, 480, 0],       // eight seconds, nothing killed
    ["FIGHTER", 1, 26_400, 310],  // 7:20, three hundred and ten kills
    ["SCOUT", 1, 9_000, 74],
  ];

  function seedDeaths(evt: string): void {
    deaths.forEach(([name, floor, ticks, kills], i) => {
      const id = "d" + i;
      H.store.insertRun({
        id, accountId: "acct-" + id, displayName: name, eventId: evt, seed: 5,
        rulesHash: RULES_HASH, mode: "coop", runKind: "race", partySize: 1,
        won: false, floor, timeTicks: ticks, kills, level: 3, state: "verified",
        proofId: "p-" + id, createdAt: H.now - i * 1000,
      });
      H.store.certify(id, {
        won: false, floor, timeTicks: ticks, kills, level: 3, ultimate: null,
        bandSplits: [ticks], bandComplete: [false], deathCause: null, finalBuild: null,
        damageDealt: kills * 140, damageTaken: 900, goldSpent: 0, rulesHash: RULES_HASH,
      }, H.now);
    });
  }

  it("ranks the death that did more, and never the one that ended sooner", () => {
    // boardOrder("deepest") was `won DESC, floor DESC, time_ticks ASC` - correct
    // for a clear, INVERTED for a death. The daily and weekly standings render
    // from it and CP is paid on it, and at the deliberate ~40% win rate most of
    // a visible contract board is non-clears. Measured on the shipping tree:
    // rank 1 = QUITTER, floor 1, 8.00s, 0 kills, above a 310-kill run.
    // COMPETITIVE.md 3.3 found this exact shape on the BAND boards and fixed it
    // there, and left it on the board that carries the ladder.
    seedDeaths("daily-round4");
    const board = H.store.board({ kind: "deepest", eventId: "daily-round4", verifiedOnly: true, limit: 10 });
    expect(board.map((r) => r.displayName)).toEqual(["FIGHTER", "SCOUT", "QUITTER"]);
  });

  it("still puts every clear above every death, fastest clear first", () => {
    // The half that was RIGHT must survive the fix.
    seedDeaths("daily-round4");
    sealedClear("slow-walk", "SLOW WALKER", H.now - 9000);
    H.store.insertRun({
      id: "fast-walk", accountId: "acct-fast", displayName: "FAST WALKER", seed: 1,
      rulesHash: RULES_HASH, mode: "coop", runKind: "race", partySize: 1, won: true,
      floor: 18, timeTicks: 40_000, kills: 500, level: 22, ultimate: "cataclysm",
      state: "verified", proofId: "p-fast", createdAt: H.now - 8000,
    });
    H.store.certify("fast-walk", {
      won: true, floor: 18, timeTicks: 40_000, kills: 500, level: 22, ultimate: "cataclysm",
      bandSplits: [1, 1, 1, 1, 1, 1], bandComplete: [true, true, true, true, true, true],
      deathCause: null, finalBuild: null, damageDealt: 1, damageTaken: 1, goldSpent: 1,
      rulesHash: RULES_HASH,
    }, H.now);
    const all = H.store.board({ kind: "deepest", verifiedOnly: true, limit: 10 });
    expect(all.slice(0, 2).map((r) => r.displayName)).toEqual(["FAST WALKER", "SLOW WALKER"]);
  });

  it("the improvement test that buys CPU uses the same comparator", () => {
    seedDeaths("daily-round4");
    const quitter = H.store.getRun("d0")!;
    const fighter = H.store.getRun("d1")!;
    // A faster death is not an improvement, so it no longer purchases a verify.
    expect(compareDeepest(quitter, fighter)).toBeGreaterThan(0);
    expect(compareDeepest(fighter, quitter)).toBeLessThan(0);
  });
});

describe("an unverifiable row is kept where the screen said it would be (blocker 11)", () => {
  it("appears below the board rather than vanishing from the product", async () => {
    // board() selected `state IN ('verified','claimed')`, so an `unverifiable`
    // row was on no board AND on no UNPROVEN shelf - while
    // verdictSeal("unverifiable") tells the player, in as many words, that "the
    // row keeps whatever it earned".
    H.store.insertRun({
      id: "aged", accountId: "acct-aged", displayName: "ELDER", seed: 3,
      rulesHash: "deadbeefdeadbeef", mode: "coop", runKind: "race", partySize: 1,
      won: false, floor: 11, timeTicks: 30_000, kills: 300, level: 14,
      state: "unverifiable", createdAt: H.now,
    });
    H.store.setState("aged", "unverifiable", "recorded under rules era deadbee");
    const page = (await get("/boards/deepest")).body as {
      entries: { id: string }[]; unproven: { id: string; state: string }[];
    };
    // It holds no rank - `entries` is proofs only...
    expect(page.entries.some((r) => r.id === "aged")).toBe(false);
    // ...and it is on the shelf the verdict promised it would be on.
    expect(page.unproven.some((r) => r.id === "aged" && r.state === "unverifiable")).toBe(true);
  });
});

describe("the read path is not a free stall (blocker 9)", () => {
  it("throttles and caches every read endpoint, and publishes both", async () => {
    // allow() was called at exactly three places. GET /runs/:id, /boards/:kind,
    // /bands/:n, /crawler/:id and /events/current had no bucket, no token and
    // no cache, and gameServer.onRequest dispatches them onto the main loop -
    // one shared vCPU with a 33 ms budget per 30 Hz tick ACROSS EVERY LIVE
    // PARTY. Measured on the shipping tree: 120 of 120 concurrent
    // /boards/deepest?limit=100 answered, none throttled, none cached.
    sealedClear("cached", "CACHED", H.now);
    const codes: number[] = [];
    for (let i = 0; i < 80; i++) codes.push((await get("/boards/deepest?limit=100")).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    const stats = H.api.stats();
    expect(stats.read_throttled_total).toBeGreaterThan(0);
    // The bucket bounds ONE client; the cache is what bounds the sum.
    expect(stats.read_cache_hits).toBeGreaterThan(0);
    expect(stats.read_cache_misses).toBeLessThan(stats.read_cache_hits);
  });

  it("a write invalidates the cache, so a seal is never stale", async () => {
    const first = (await get("/boards/deepest")).body as { entries: unknown[] };
    expect(first.entries.length).toBe(0);
    sealedClear("fresh", "FRESH", H.now);
    H.api.onVerified(
      {
        runId: "fresh", proofId: "p-fresh", bytes: new Uint8Array(0), priority: 2, ticks: 1,
        accountId: "acct-fresh", ip: "x", hasHistory: false, enqueuedAt: H.now, rulesHash: RULES_HASH,
      },
      {
        won: true, floor: 18, ticks: 54_398, kills: 1_180, level: 24, status: "won",
        ultimate: "cataclysm", bandSplitTicks: [1, 1, 1, 1, 1, 1],
        bandComplete: [true, true, true, true, true, true], death: null, build: null,
        damageDealt: 1, damageTaken: 1, goldSpent: 1,
      } as unknown as RunSummary,
    );
    const second = (await get("/boards/deepest")).body as { entries: unknown[] };
    expect(second.entries.length).toBe(1);
  });
});

describe("GET /crawler/:id is not a token oracle (blocker 10)", () => {
  it("refuses a bearer token in the path, and answers /crawler/me for the owner", async () => {
    // `accountForPublicId(who[1]) ?? who[1]` passed an unresolved path segment
    // straight in as an ACCOUNT ID - and the account id IS the credential POST
    // /runs authenticates on. Unauthenticated and unthrottled, it answered
    // populated for a real token and empty for a wrong one. Measured on the
    // shipping tree: 200 / runs=1 / name=REPRO against 200 / runs=0 / name=null.
    const token = H.tokens.issueAnon();
    sealedClear("mine", "OWNER", H.now);
    H.store.insertRun({
      id: "tokenrow", accountId: token, displayName: "OWNER", seed: 1, rulesHash: null,
      mode: "coop", runKind: "race", partySize: 1, won: false, floor: 9,
      timeTicks: 20_000, kills: 120, level: 12, state: "claimed", createdAt: H.now,
    });

    const byToken = await get("/crawler/" + encodeURIComponent(token));
    const byWrong = await get("/crawler/" + encodeURIComponent("wrong-token-xyz"));
    expect(byToken.status).toBe(404);
    expect(byWrong.status).toBe(404);
    // Indistinguishable is the whole property: a different answer IS the oracle.
    expect(JSON.stringify(byToken.body)).toBe(JSON.stringify(byWrong.body));

    // The owner asks with the token AS a token, where isUsable decides.
    const me = await get("/crawler/me?token=" + encodeURIComponent(token));
    expect(me.status).toBe(200);
    expect((me.body as { runsSubmitted: number }).runsSubmitted).toBe(1);

    // ...and a stranger is still reachable by the one-way public id.
    const pid = publicIdFor("acct-mine");
    const pub = await get("/crawler/" + pid);
    expect(pub.status).toBe(200);
    expect((pub.body as { publicId: string }).publicId).toBe(pid);
  });
});

describe("the verify ledger is denominated in one unit (blocker 7)", () => {
  it("charges CPU ms, not wall clock including the duty-cycle sleeps", async () => {
    // estimateMs is CPU ms; the charge was `reply.msSpent`, which is Date.now()
    // wall clock and includes the duty sleeps. At the documented 250 ms/s that
    // is a 4x unit mismatch inside ONE ledger, so honest heavy players hit the
    // budget wall at a quarter of the stated allowance. Measured on the shipping
    // tree: charged / CPU actually burned = 4.00x.
    let charged = 0;
    let wall = 0;
    const q = new VerifyQueue({
      executor: {
        // 5,975 ms of CPU inside a 250 ms/s duty cycle: 23,900 ms of wall clock.
        run: async () => ({
          id: "x", ok: false as const, state: "unverifiable" as const,
          detail: "stub", msSpent: 23_900, cpuMs: 5_975,
        }),
        dispose: () => { /* nothing */ },
      },
      hooks: {
        onStart: () => { /* nothing */ },
        onResult: () => { /* nothing */ },
        onShed: () => { /* nothing */ },
        onSpend: (_j, cpuMs, wallMs) => { charged = cpuMs; wall = wallMs; },
      },
    });
    q.enqueue({
      runId: "x", proofId: "p", bytes: new Uint8Array(4), priority: 2, ticks: 54_398,
      accountId: "a", ip: "1.1.1.1", hasHistory: false, enqueuedAt: H.now, rulesHash: RULES_HASH,
    });
    await q.drain();
    expect(charged).toBe(5_975);
    expect(wall).toBe(23_900);
    q.close();
  });

  it("the cost model reproduces COMPETITIVE.md 2.3's own measured replay times", () => {
    // A single us/tick scalar cannot describe a cost dominated by MONSTER
    // COUNT: 2.3 measured 72 us/tick at 4,282 ticks and 240 at 48,265. The flat
    // 110 predicted 5.3 s of CPU for the run 2.3 measured at 11.6 s.
    const measured: [number, number][] = [
      [4_282, 72], [19_626, 141], [25_947, 143], [45_419, 230], [48_265, 240],
    ];
    for (const [ticks, us] of measured) {
      expect(Math.abs(tickCostUs(ticks, 1) - us) / us, `${ticks} ticks`).toBeLessThan(0.12);
    }
  });
});

describe("the certification ceiling is not one submitter's to move (blocker 8)", () => {
  it("survives a flood of deliberately expensive deep submissions", async () => {
    // usPerTick was ONE global mutable EMA shared by every account, and
    // certifiableTicks is inversely proportional to it. It converges in ~10
    // jobs, so a handful of deep submissions from one account dragged the
    // ceiling below full-clear length for EVERYBODY. Measured on the shipping
    // tree: 37,725 ticks after twelve 675 us/tick jobs - about ten sim-minutes,
    // which refuses every clear on the board.
    const q = new VerifyQueue({
      executor: {
        run: async (req) => ({
          id: req.id, ok: false as const, state: "unverifiable" as const, detail: "stub",
          // The worst per-tick cost 2.3 ever measured, on every single job.
          msSpent: ((48_000 * 675) / 1000) * 4, cpuMs: (48_000 * 675) / 1000,
        }),
        dispose: () => { /* nothing */ },
      },
      hooks: {
        onStart: () => { /* nothing */ }, onResult: () => { /* nothing */ },
        onShed: () => { /* nothing */ }, onSpend: () => { /* nothing */ },
      },
    });
    const before = q.certifiableTicks;
    for (let i = 0; i < 15; i++) {
      q.enqueue({
        runId: "j" + i, proofId: "p", bytes: new Uint8Array(4), priority: 2, ticks: 48_000,
        accountId: "attacker", ip: "6.6.6.6", hasHistory: false, enqueuedAt: H.now,
        rulesHash: RULES_HASH,
      });
    }
    await q.drain();
    expect(before).toBeGreaterThan(FULL_CLEAR_TICKS);
    expect(q.certifiableTicks).toBeGreaterThanOrEqual(FULL_CLEAR_TICKS);
    // ...and the number that moved it is on an operator surface, which is what
    // makes drift distinguishable from poisoning.
    expect(q.scale).toBeGreaterThan(1);
    q.close();
  });

  it("publishes the ceiling and the multiplier that sets it", () => {
    const s = H.api.stats();
    expect(s.verify_certifiable_ticks).toBeGreaterThan(0);
    expect(s.verify_cost_scale_milli).toBeGreaterThan(0);
    expect(s.verify_cpu_ms_total).toBeGreaterThanOrEqual(0);
  });
});
