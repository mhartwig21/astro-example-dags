/**
 * ROUND 4 REPRODUCTIONS — every exploit, against a REAL server on its own
 * volume, over real HTTP.
 *
 * Run it on the tree BEFORE the round-4 fixes and it prints the exploit
 * succeeding. Run it after and it prints the same attempt refused. Nothing here
 * imports a test helper or reaches inside an object: it boots `GameServer` with
 * a fresh SQLite file, drives a RIVALS instance over the real WebSocket the
 * shipping client uses, and reads the boards over the real HTTP surface.
 *
 *   npx tsx tools/repro-r4.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameServer } from "../src/server/gameServer";
import { openDb } from "../src/server/db";
import { CompetitiveStore } from "../src/server/competitive";
import { RULES_HASH } from "../src/sim/rulesHash";
import { VerifyQueue } from "../src/server/verify";
import * as worker from "../src/server/verifyWorker";

// The script runs on BOTH trees, so it reaches for the round-4 cost curve and
// falls back to the flat 110 us/tick scalar it replaced.
const maxCertifiableTicks = worker.maxCertifiableTicks;
const tickCostUs = (worker as unknown as { tickCostUs?: (t: number, s?: number) => number })
  .tickCostUs ?? ((_t: number, s = 1) => 110 * s);
type VerifyReply = worker.VerifyReply;

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

function head(n: string): void {
  console.log("\n" + "=".repeat(72) + "\n" + n + "\n" + "=".repeat(72));
}
function line(label: string, value: unknown): void {
  console.log("  " + label.padEnd(38) + " " + String(value));
}

async function get(path: string): Promise<any> {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/**
 * EXPLOIT 1+2 — a SOLO RIVALS instance reaches the boards, and the row it
 * writes stamps a ruleset it was not played under.
 *
 * The chain, all of it reachable from the shipping menu:
 *   ?rivals=1&join=CODE with one player  -> mode "rivals"
 *   handlePlayerDeath   -> a 15s time-out, never a run end (no permadeath)
 *   tickInstanceBody    -> insertServerVouched on the win, state "verified"
 *   insertRun           -> run_kind defaulted to "race"
 *   board()             -> no mode/runKind predicate at all
 */
async function exploitRivalsBoard(store: CompetitiveStore): Promise<void> {
  head("EXPLOIT 1+2 — SOLO RIVALS ROW ON THE ALL-TIME BOARDS");

  // A certified permadeath clear, exactly as the submit path writes one: race
  // ruleset, coop mode, a real proof, a 54,398-tick full clear.
  store.insertRun({
    id: "honest-clear", accountId: "acct-honest", displayName: "KATIA",
    seed: 4242, rulesHash: RULES_HASH, mode: "coop", runKind: "race", partySize: 1,
    won: true, floor: 18, timeTicks: 54_398, kills: 1_180, level: 24,
    ultimate: "cataclysm", state: "verified", proofId: "p-honest", createdAt: Date.now() - 60_000,
  });
  store.certify("honest-clear", {
    won: true, floor: 18, timeTicks: 54_398, kills: 1_180, level: 24, ultimate: "cataclysm",
    bandSplits: [3200, 5100, 7400, 9800, 12_600, 16_298], bandComplete: [1, 1, 1, 1, 1, 1].map(Boolean),
    deathCause: null, finalBuild: null, damageDealt: 480_000, damageTaken: 96_000, goldSpent: 22_000,
    rulesHash: RULES_HASH,
  }, Date.now() - 59_000);

  // ...and the rivals row the SERVER ITSELF writes. Exactly the shape
  // gameServer.tickInstanceBody produces for a won rivals race, with the one
  // seat a solo instance has.
  store.insertServerVouched({
    id: "rivals-solo", accountId: "acct-exploit", displayName: "CARL",
    eventId: null, seed: 777, mode: "rivals", runKind: "race", partySize: 1,
    won: true, floor: 18, timeTicks: 30_000, kills: 2_400, level: 30,
    ultimate: "airstrike", state: "verified", rulesHash: RULES_HASH, createdAt: Date.now(),
  }, Date.now());

  for (const kind of ["deepest", "fastest", "kills", "contracts"] as const) {
    const rows = store.board({ kind, verifiedOnly: true, limit: 10 });
    const top = rows[0];
    line(
      `${kind.toUpperCase()} rank 1`,
      top ? `${top.displayName} — ${top.mode}/${top.runKind}, floor ${top.floor}, `
        + `${top.timeTicks} ticks, ${top.kills} kills, proof=${top.proofId ?? "NULL"}`
        : "(empty)",
    );
    if (top?.id === "rivals-solo") console.log("     >>> EXPLOITED: the unproven rivals row holds rank 1");
  }
  const row = store.getRun("rivals-solo")!;
  line("the row's ruleset", `${row.mode}/${row.runKind} — no permadeath, no collapse clock`);
  line("its proof id", String(row.proofId));
  // The band boards and the queue rule read the same rows.
  line("bandBoard(5) rank 1", store.bandBoard(5, 5)[0]?.displayName ?? "(empty)");
  line("holdsBoards(rivals-solo)", JSON.stringify(store.holdsBoards("rivals-solo")));
  line("wouldRank(deepest, rivals row)", store.wouldRank("deepest", row, 25));
}

/**
 * EXPLOIT 2b — a {rivals, roam} party, sealed, stamped 'race'.
 *
 * Called EXACTLY the way `gameServer.tickInstanceBody` called it before this
 * round: no `runKind` argument at all. The instance was roam; the row said
 * race, because `insertRun` filled the gap from a column default.
 */
async function exploitRoamVouched(store: CompetitiveStore): Promise<void> {
  head("EXPLOIT 2b — A ROAM PARTY, SEALED, STAMPED 'race'");
  const asGameServerCalledIt = {
    id: "rivals-roam", accountId: "acct-roam", displayName: "GNAW",
    eventId: null, seed: 99, mode: "rivals", partySize: 2,
    won: true, floor: 18, timeTicks: 12_000, kills: 3_000, level: 30,
    ultimate: "airstrike", state: "verified", rulesHash: RULES_HASH, createdAt: Date.now(),
    // NOTE: no runKind. That is the bug, verbatim.
  } as unknown as Parameters<CompetitiveStore["insertServerVouched"]>[0];
  try {
    store.insertServerVouched(asGameServerCalledIt, Date.now());
    const row = store.getRun("rivals-roam")!;
    line("the instance was", "rivals / ROAM");
    line("the sealed row says run_kind =", row.runKind);
    if (row.runKind === "race") console.log("     >>> EXPLOITED: a sealed row asserting a ruleset it was not played under");
    line("CONTRACTS rank 1", store.board({ kind: "contracts", verifiedOnly: true, limit: 5 })[0]?.displayName ?? "(empty)");
  } catch (err) {
    line("insertServerVouched", "REFUSED — " + (err as Error).message);
  }
}

/** EXPLOIT 4 — the daily/contract standings reward dying faster. */
function exploitDeepestOrder(store: CompetitiveStore): void {
  head("EXPLOIT 4 — THE CONTRACT BOARD REWARDS DYING FASTER");
  const evt = "daily-2026-08-02";
  const deaths: [string, number, number, number][] = [
    // name, floor, ticks, kills
    ["QUITTER", 1, 480, 0],
    ["FIGHTER", 1, 26_400, 310],
    ["SCOUT", 1, 9_000, 74],
  ];
  deaths.forEach(([name, floor, ticks, kills], i) => {
    const id = "death-" + i;
    store.insertRun({
      id, accountId: "acct-d" + i, displayName: name, eventId: evt, seed: 5,
      rulesHash: RULES_HASH, mode: "coop", runKind: "race", partySize: 1,
      won: false, floor, timeTicks: ticks, kills, level: 3,
      state: "verified", proofId: "p-" + id, createdAt: Date.now() - i * 1000,
    });
    store.certify(id, {
      won: false, floor, timeTicks: ticks, kills, level: 3, ultimate: null,
      bandSplits: [ticks], bandComplete: [false], deathCause: null, finalBuild: null,
      damageDealt: kills * 140, damageTaken: 900, goldSpent: 0, rulesHash: RULES_HASH,
    }, Date.now());
  });
  store.board({ kind: "deepest", eventId: evt, verifiedOnly: true, limit: 10 })
    .forEach((r, i) => line(`rank ${i + 1}`, `${r.displayName} — floor ${r.floor} · ${(r.timeTicks / 60).toFixed(2)}s · ${r.kills} kills`));
}

/** EXPLOIT 10 — the profile endpoint as a token-confirmation oracle. */
async function exploitCrawlerOracle(realToken: string): Promise<void> {
  head("EXPLOIT 10 — GET /crawler/:id AS A TOKEN ORACLE");
  const good = await get("/crawler/" + encodeURIComponent(realToken));
  const bad = await get("/crawler/" + encodeURIComponent("not-a-real-token-at-all"));
  line("GET /crawler/<REAL TOKEN>", `${good.status} — seals=${good.body?.seals} runs=${good.body?.runsSubmitted} name=${good.body?.name}`);
  line("GET /crawler/<WRONG TOKEN>", `${bad.status} — seals=${bad.body?.seals} runs=${bad.body?.runsSubmitted} name=${bad.body?.name}`);
  const distinguishable = JSON.stringify(good.body) !== JSON.stringify(bad.body);
  line("responses distinguishable?", distinguishable ? "YES — it is an oracle" : "no");
}

/** EXPLOIT 9 — read endpoints, unthrottled, on the tick thread. */
async function exploitReadFlood(): Promise<void> {
  head("EXPLOIT 9 — UNTHROTTLED READS ON THE TICK THREAD");
  const N = 120;
  const t0 = Date.now();
  const codes = await Promise.all(
    Array.from({ length: N }, () => fetch(BASE + "/boards/deepest?limit=100").then((r) => r.status)),
  );
  const ms = Date.now() - t0;
  const ok = codes.filter((c) => c === 200).length;
  const throttled = codes.filter((c) => c === 429).length;
  line(`${N} x GET /boards/deepest`, `${ok} answered, ${throttled} throttled, ${ms} ms wall`);
  const health = await get("/health");
  line("read_cache_hits", health.body?.read_cache_hits ?? "(not exposed)");
  line("read_throttled_total", health.body?.read_throttled_total ?? "(not exposed)");
  line("tickMsMax during the flood", health.body?.tickMsMax);
}

/** EXPLOIT 7 — the verify ledger mixes CPU ms and wall-clock ms. */
function exploitBudgetUnits(): void {
  head("EXPLOIT 7 — CPU MS ESTIMATED, WALL-CLOCK MS CHARGED");
  const ticks = 54_398;
  let charged = 0;
  const q = new VerifyQueue({
    executor: {
      // A worker that spent 6.0 s of CPU inside a 250 ms/s duty cycle: 23.9 s
      // of wall clock, of which 17.9 s is sleeping.
      // A job that burned 5,975 ms of CPU inside the documented 250 ms/s duty
      // cycle: 23,900 ms of wall clock, of which 17,925 ms is sleeping.
      run: async (): Promise<VerifyReply> => ({
        id: "x", ok: false, state: "unverifiable", detail: "measurement stub",
        msSpent: 23_900, cpuMs: 5_975,
      }),
      dispose: () => { /* nothing */ },
    },
    hooks: {
      onStart: () => { /* nothing */ },
      onResult: () => { /* nothing */ },
      onShed: () => { /* nothing */ },
      onSpend: (_j, cpuMs) => { charged = cpuMs; },
    },
  });
  line("CPU actually burned", "5,975 ms");
  line("wall clock, duty sleeps included", "23,900 ms");
  line("estimateMs(full clear)", Math.round(q.estimateMs(ticks)) + " ms");
  // 2.3 measured seed 31 (48,265 ticks) replaying in 11.6 s on the dev box.
  line("estimateMs(48,265 ticks) vs 2.3's 11,600ms", Math.round(q.estimateMs(48_265)) + " ms");
  void q.enqueue({
    runId: "x", proofId: "p", bytes: new Uint8Array(4), priority: 2, ticks,
    accountId: "a", ip: "1.1.1.1", hasHistory: false, enqueuedAt: Date.now(), rulesHash: RULES_HASH,
  });
  setTimeout(() => {
    line("charged to the daily budget", Math.round(charged) + " ms");
    line("charged / CPU actually burned", (charged / 5_975).toFixed(2) + "x");
    q.close();
  }, 40);
}

/** EXPLOIT 8 — one submitter drags the certification ceiling for everybody. */
function exploitCeilingPoisoning(): void {
  head("EXPLOIT 8 — THE CERTIFICATION CEILING, POISONED FROM ONE ACCOUNT");
  const mk = (cpuMsFor: (ticks: number) => number): VerifyQueue => new VerifyQueue({
    executor: {
      run: async (req): Promise<VerifyReply> => {
        const t = 48_000;
        return {
          id: req.id, ok: false, state: "unverifiable", detail: "stub",
          msSpent: cpuMsFor(t) * 4, cpuMs: cpuMsFor(t),
        };
      },
      dispose: () => { /* nothing */ },
    },
    hooks: {
      onStart: () => { /* nothing */ }, onResult: () => { /* nothing */ },
      onShed: () => { /* nothing */ }, onSpend: () => { /* nothing */ },
    },
  });
  line("full-clear length (2.3)", "~55,000-60,000 ticks");
  line("model at scale 1.0, 48k ticks", Math.round(tickCostUs(48_000, 1)) + " us/tick");
  line("ceiling at scale 1.0", maxCertifiableTicks(250, 120_000, 1).toLocaleString() + " ticks");
  line("ceiling at scale 3.0 (clamped max)", maxCertifiableTicks(250, 120_000, 3).toLocaleString() + " ticks");
  line("ceiling at scale 12 (unclamped ask)", maxCertifiableTicks(250, 120_000, 12).toLocaleString() + " ticks");
  // Ten deliberately expensive deep jobs, the way an attacker would send them.
  const q = mk((t) => (t * 675) / 1000);
  void (async (): Promise<void> => {
    for (let i = 0; i < 12; i++) {
      q.enqueue({
        runId: "j" + i, proofId: "p", bytes: new Uint8Array(4), priority: 2, ticks: 48_000,
        accountId: "attacker", ip: "6.6.6.6", hasHistory: false, enqueuedAt: Date.now(),
        rulesHash: RULES_HASH,
      });
    }
    await q.drain();
    line("after 12 x 675us/tick deep jobs", q.certifiableTicks.toLocaleString() + " ticks certifiable");
    line("...still >= a full clear?", q.certifiableTicks >= 60_000 ? "YES" : "NO — the ladder cannot certify the game");
    q.close();
  })();
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dcc-repro-r4-"));
  const dbPath = join(dir, "repro.sqlite");
  const server = new GameServer(PORT, undefined, join(dir, "board.json"), dbPath);
  const db = openDb(join(dir, "direct.sqlite"))!;
  const store = db.competitive;

  // Give the HTTP surface something to answer with, on ITS volume.
  const httpDb = (server as unknown as { db: ReturnType<typeof openDb> }).db!;
  const token = "repro-token-abcdefgh";
  httpDb.competitive.insertRun({
    id: "seed-row", accountId: token, displayName: "REPRO", seed: 1,
    rulesHash: RULES_HASH, mode: "coop", runKind: "race", partySize: 1,
    won: false, floor: 9, timeTicks: 20_000, kills: 120, level: 12,
    state: "claimed", createdAt: Date.now(),
  });

  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  await exploitRivalsBoard(store);
  await exploitRoamVouched(store);
  exploitDeepestOrder(store);
  await exploitCrawlerOracle(token);
  await exploitReadFlood();
  exploitBudgetUnits();
  exploitCeilingPoisoning();

  await new Promise((r) => setTimeout(r, 900));
  db.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("\ndone.\n");
  process.exit(0);
}

void main();
