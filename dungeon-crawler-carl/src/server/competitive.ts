/**
 * THE COMPETITIVE STORE - runs, proofs, events, ladders, CP (COMPETITIVE.md
 * MUST-4). SQLite on the Fly volume that Litestream already replicates.
 *
 * Two things changed shape versus the JSON leaderboard this replaces, and both
 * are load-bearing:
 *
 * 1. ROWS KEY ON account_id, NOT ON NAME. Names are squattable and
 *    impersonatable, there was no continuity between a board row and a profile,
 *    and - the live privacy bug - FORGET ME could not reach the boards at all,
 *    so a deleted account name stayed public forever. The display name is now a
 *    SNAPSHOT taken at submit time, which also makes a moderation rename one
 *    UPDATE by account id.
 * 2. EVERY ROW CARRIES A STATE: claimed -> verifying -> verified | rejected |
 *    unverifiable. Only verified rows are eligible for the top 3, for season CP,
 *    or as a rival contract. A claimed row may still be shown, visibly unproven.
 *
 * Single-machine by construction: one SQLite file, synchronous better-sqlite3,
 * no queue service, no cache tier, nothing that wants a second process.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * THE PUBLIC NAME OF AN ACCOUNT. `account_id` is the bearer token itself -
 * `POST /runs?token=...` passes it straight in as the account id and
 * `TokenService.isUsable` authenticates that exact string - so a board row that
 * carried `accountId` was handing every reader a working credential for every
 * ranked crawler: burn their attempt counter, flip their sealed run private,
 * submit a tampered proof in their name, read their linked identity, or
 * complete their FORGET ME. One-way, 16 hex characters, stable for the life of
 * the account, and the only thing the client ever needs it for is the YOU /
 * RIVAL tag on a row.
 */
export function publicIdFor(accountId: string): string {
  return createHash("sha256").update("dcc:public:" + accountId).digest("hex").slice(0, 16);
}

/** Lifecycle of a board row (COMPETITIVE.md 2.4 rule 3). */
export type RunState = "claimed" | "verifying" | "verified" | "rejected" | "unverifiable";

/** All-time board categories, unchanged from the JSON boards they replace. */
export const BOARD_KINDS = ["deepest", "fastest", "kills", "contracts"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/** Below this many verified entries a split board collapses into its parent
 *  (COMPETITIVE.md 3.4). A board with two rows does not read as winnable, it
 *  reads as abandoned - and which one you get is purely entrants per board. */
export const SPLIT_GATE_ENTRIES = 20;

/** Board depth kept per category, and how many rows a caller may ask for. */
export const MAX_BOARD_ROWS = 100;

/** The reason a row was stored unproven purely because the board was full when
 *  it arrived. A CONSTANT, not prose matched twice: `reconsiderRankRefused`
 *  finds these rows by this exact prefix, and a copy edit must not quietly
 *  strand every near miss. */
export const RANK_REFUSED_REASON =
  "stored, unproven - it would not reach a board top 25 as the board stands.";

export interface RunRow {
  id: string;
  accountId: string;
  displayName: string;
  eventId: string | null;
  seed: number;
  rulesHash: string | null;
  mode: string;
  runKind: string;
  partySize: number;
  won: boolean;
  floor: number;
  timeTicks: number;
  kills: number;
  level: number;
  ultimate: string | null;
  bandSplits: number[] | null;
  deathCause: unknown;
  finalBuild: unknown;
  damageDealt: number;
  damageTaken: number;
  goldSpent: number;
  attemptNo: number | null;
  private: boolean;
  state: RunState;
  rejectReason: string | null;
  verifiedAt: number | null;
  proofId: string | null;
  createdAt: number;
}

export interface NewRun {
  id: string;
  accountId: string;
  displayName: string;
  eventId?: string | null;
  seed: number;
  rulesHash?: string | null;
  /**
   * WHICH GAME WAS PLAYED - REQUIRED, NOT DEFAULTED (blocker 12).
   *
   * These were `mode?: string` / `runKind?: string` with `?? "coop"` / `??
   * "race"` filled in by `insertRun`, and `insertServerVouched` passed neither
   * `runKind` nor, for a roam party, a truthful `mode`. So EVERY server-vouched
   * row was stamped `run_kind = 'race'` whatever was actually played - a
   * `{rivals: true, roam: true}` instance included - and the row was written
   * `verified` at the same moment. A sealed row asserting the wrong ruleset is
   * strictly worse than one asserting nothing: the audit column exists so a
   * board, a share page or a future host can say which game a row came from,
   * and a default silently answers that question with a guess.
   *
   * TypeScript is the enforcement. There is no value of these fields the store
   * can infer, so there is no value it may invent.
   */
  mode: string;
  runKind: string;
  partySize?: number;
  won: boolean;
  floor: number;
  timeTicks: number;
  kills: number;
  level: number;
  ultimate?: string | null;
  attemptNo?: number | null;
  private?: boolean;
  state: RunState;
  proofId?: string | null;
  createdAt: number;
}

/** What the verifier derived while replaying, written onto the row ONCE at
 *  certification time (COMPETITIVE.md 2.5.5) so the row stays informative long
 *  after its proof stops being executable. A photograph instead of a film. */
export interface VerifiedFacts {
  won: boolean;
  floor: number;
  timeTicks: number;
  kills: number;
  level: number;
  ultimate: string | null;
  bandSplits: number[];
  /** Per band: did the run TRAVERSE it (see RunSummary.bandComplete)? Only a
   *  traversed band is eligible for the band board. */
  bandComplete: boolean[];
  deathCause: unknown;
  finalBuild: unknown;
  damageDealt: number;
  damageTaken: number;
  goldSpent: number;
  rulesHash: string;
}

export const COMPETITIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_proofs (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  rules_hash  TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  event_id    TEXT,
  ticks       INTEGER NOT NULL,
  bytes       BLOB NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proofs_account ON run_proofs (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  event_id      TEXT,
  seed          INTEGER NOT NULL,
  rules_hash    TEXT,
  -- WHICH GAME, not just which numbers. The era chip answers "under what rules
  -- was this computed"; nothing answered "which ruleset was played" - and a
  -- ROAM header replayed cleanly into a certified floor-16 row (see
  -- verifyWorker.rulesetRefusal). Even after the submit path starts refusing
  -- roam, an existing certified row has to be auditable and labellable, and no
  -- consumer - board, share page, band board, a future mobile host - could say
  -- which game a row was played under.
  mode          TEXT NOT NULL DEFAULT 'coop',
  run_kind      TEXT NOT NULL DEFAULT 'race',
  party_size    INTEGER NOT NULL DEFAULT 1,
  won           INTEGER NOT NULL DEFAULT 0,
  floor         INTEGER NOT NULL,
  time_ticks    INTEGER NOT NULL,
  kills         INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  ultimate      TEXT,
  band_splits   TEXT,
  death_cause   TEXT,
  final_build   TEXT,
  damage_dealt  INTEGER NOT NULL DEFAULT 0,
  damage_taken  INTEGER NOT NULL DEFAULT 0,
  gold_spent    INTEGER NOT NULL DEFAULT 0,
  attempt_no    INTEGER,
  private       INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK(state IN ('claimed','verifying','verified','rejected','unverifiable')),
  reject_reason TEXT,
  verified_at   INTEGER,
  proof_id      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_event ON runs (event_id, state, won DESC, floor DESC, time_ticks ASC);
CREATE INDEX IF NOT EXISTS idx_runs_account ON runs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state, created_at);
CREATE TABLE IF NOT EXISTS run_bands (
  run_id   TEXT NOT NULL,
  band     INTEGER NOT NULL,
  ticks    INTEGER NOT NULL,
  -- 1 only when the run TRAVERSED the band: every floor entered and the last
  -- one left. A partial band is a true ledger entry (the recap shows it) and is
  -- NEVER a record.
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, band)
);
-- The index over (band, complete, ticks) is created in migrate(), NOT here: on
-- a volume that still has the pre-completeness table this statement would run
-- against a column that does not exist yet and take the whole boot with it.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  day        TEXT NOT NULL,
  seed       INTEGER NOT NULL,
  rules_hash TEXT NOT NULL,
  opens_at   INTEGER NOT NULL,
  closes_at  INTEGER NOT NULL,
  frozen     INTEGER NOT NULL DEFAULT 0,
  season     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS event_attempts (
  account_id          TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  first_scored_run_id TEXT,
  PRIMARY KEY (account_id, event_id)
);
CREATE TABLE IF NOT EXISTS season_results (
  account_id TEXT NOT NULL,
  season     TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  cp         INTEGER NOT NULL,
  run_id     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_season_results ON season_results (season, account_id);
CREATE TABLE IF NOT EXISTS season_cp (
  account_id     TEXT NOT NULL,
  season         TEXT NOT NULL,
  cp             INTEGER NOT NULL DEFAULT 0,
  events_counted INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (account_id, season)
);
CREATE INDEX IF NOT EXISTS idx_season_cp ON season_cp (season, cp DESC);
CREATE TABLE IF NOT EXISTS mastery (
  account_id TEXT NOT NULL,
  ultimate   TEXT NOT NULL,
  xp         INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, ultimate)
);
CREATE TABLE IF NOT EXISTS follows (
  account_id TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, target_id)
);
CREATE TABLE IF NOT EXISTS verify_budget (
  subject TEXT NOT NULL,
  day     TEXT NOT NULL,
  ms      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);
-- SPENT EVENT TICKETS (COMPETITIVE.md 3.2A). A signature is a one-shot key:
-- readTicket is a pure HMAC check, so without this table the same attempt-1
-- ticket backs an unlimited number of submissions forever. Swept on the same
-- 48h window as verify_budget - a ticket outlives its usefulness in minutes.
CREATE TABLE IF NOT EXISTS spent_tickets (
  sig        TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  used_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spent_tickets ON spent_tickets (used_at);
-- THE PUBLIC NAME OF AN ACCOUNT (COMPETITIVE.md 2.7 / 8.2). account_id IS the
-- bearer token - POST /runs authenticates on that exact string - so it can
-- never appear on a wire projection. Every crawler therefore has a derived,
-- one-way public id, and this is the only place the two are ever seen
-- together. Deleted with the account, like everything else.
CREATE TABLE IF NOT EXISTS account_public (
  public_id  TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE
);
`;

interface RawRun {
  id: string; account_id: string; display_name: string; event_id: string | null;
  seed: number; rules_hash: string | null; mode: string; run_kind: string; party_size: number;
  won: number; floor: number; time_ticks: number; kills: number; level: number;
  ultimate: string | null; band_splits: string | null; death_cause: string | null;
  final_build: string | null; damage_dealt: number; damage_taken: number;
  gold_spent: number; attempt_no: number | null; private: number;
  state: RunState; reject_reason: string | null; verified_at: number | null;
  proof_id: string | null; created_at: number;
}

function parse<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function toRow(r: RawRun): RunRow {
  return {
    id: r.id, accountId: r.account_id, displayName: r.display_name, eventId: r.event_id,
    seed: r.seed, rulesHash: r.rules_hash, mode: r.mode, runKind: r.run_kind ?? "race",
    partySize: r.party_size,
    won: !!r.won, floor: r.floor, timeTicks: r.time_ticks, kills: r.kills, level: r.level,
    ultimate: r.ultimate, bandSplits: parse<number[]>(r.band_splits),
    deathCause: parse<unknown>(r.death_cause), finalBuild: parse<unknown>(r.final_build),
    damageDealt: r.damage_dealt ?? 0, damageTaken: r.damage_taken ?? 0, goldSpent: r.gold_spent ?? 0,
    attemptNo: r.attempt_no, private: !!r.private, state: r.state,
    rejectReason: r.reject_reason, verifiedAt: r.verified_at, proofId: r.proof_id,
    createdAt: r.created_at,
  };
}

/**
 * THE DEEPEST ORDERING, WHICH IS NOT ONE ORDERING (blocker 4).
 *
 * `won DESC, floor DESC, time_ticks ASC` is correct for a clear and INVERTED
 * for a death: among two runs that ended on the same floor without walking out,
 * it ranks the one that ended SOONER. The daily and weekly contract standings
 * render from this ordering and CP is paid on it, and at the deliberate ~40%
 * win rate (3.1) most of a visible contract board is non-clears - so the
 * optimal play to top today's contract was to die faster. Measured live: rank 1
 * on the daily was floor 1 / 0:08 / 0 kills, above every run that fought.
 *
 * COMPETITIVE.md 3.3 found and fixed exactly this shape on the BAND boards
 * ("under the naive rule the optimal play for a band record is to step into the
 * band and die immediately") and left it standing on the board that carries the
 * ladder.
 *
 * So the clock only ever decides a CLEAR. Among deaths at equal depth the board
 * ranks the run that did more on the way - and it deliberately does not use
 * time in either direction there, because `time DESC` would pay a crawler for
 * standing still on floor 1 exactly as surely as `time ASC` pays them for
 * jumping into the first pit.
 */
const DEEPEST_ORDER =
  "won DESC, floor DESC, "
  + "CASE WHEN won = 1 THEN time_ticks ELSE 0 END ASC, "
  + "CASE WHEN won = 1 THEN 0 ELSE kills END DESC, "
  + "created_at ASC";

/** The same order in TypeScript, for the callers that compare two rows in
 *  memory (the improvement test, the head-to-head ledger). Negative when `a`
 *  outranks `b`. One definition, so the ladder and the ledger cannot disagree. */
export function compareDeepest(
  a: { won: boolean; floor: number; timeTicks: number; kills: number },
  b: { won: boolean; floor: number; timeTicks: number; kills: number },
): number {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.floor !== b.floor) return b.floor - a.floor;
  if (a.won) return a.timeTicks - b.timeTicks;
  return b.kills - a.kills;
}

/** ORDER BY fragment per board. `fastest` and `contracts` only rank clears;
 *  the WHERE that enforces that lives in boardWhere. */
function boardOrder(kind: BoardKind): string {
  switch (kind) {
    case "deepest": return DEEPEST_ORDER;
    case "fastest": return "time_ticks ASC, created_at ASC";
    case "kills": return "kills DESC, created_at ASC";
    case "contracts": return "time_ticks ASC, created_at ASC";
  }
}

/**
 * WHICH RULESET A BOARD MAY RANK - AS A PREDICATE ON THE BOARD, NOT A CHECK AT
 * ONE DOOR (blocker 13).
 *
 * `rulesetRefusal` is applied twice on the submit path and never on the path
 * that writes a row VERIFIED with no proof at all: `insertServerVouched`. So a
 * RIVALS instance - which is reachable from the shipping menu with no second
 * player, and in which `handlePlayerDeath` turns death into a 15-second
 * time-out instead of ending the run (`game.ts`, `state.mode === "rivals"`) -
 * produced a row that took rank 1 on DEEPEST, FASTEST, KILLS and CONTRACTS
 * simultaneously, above certified permadeath clears, with `proof_id NULL`.
 * Measured: floor 18, 30,000 ticks, 2,400 kills, ranked #1 on all three
 * all-time boards over a 54,398-tick certified clear.
 *
 * That is the ROAM exploit of 2.5 resurrected through the one door that never
 * calls the gate. Gating the door again would fix this door and leave the next
 * one open, so the predicate lives HERE, on the board, where every consumer -
 * `board`, `wouldRank`, `bandBoard`, `holdsBoards`, retention - reads it:
 *
 *  - Every board ranks the ruleset a proof reproduces: `run_kind = 'race'`
 *    played in the shared-world `coop` mode a solo descent uses.
 *  - CONTRACTS additionally ranks the one score the server vouches for itself
 *    (1.1) - a RIVALS race - and only when there was a race: `party_size >= 2`.
 *    A solo rivals instance is a contract against nobody, and a ruleset with no
 *    permadeath and no collapse clock has nothing to say to a board of runs
 *    that had both.
 */
const RANKED_SOLO_RULESET = "run_kind = 'race' AND mode = 'coop'";
const VOUCHED_CONTRACT_RULESET =
  "run_kind = 'race' AND mode = 'rivals' AND party_size >= 2 AND proof_id IS NULL";

export function boardRuleset(kind: BoardKind): string {
  return kind === "contracts"
    ? ` AND ((${RANKED_SOLO_RULESET}) OR (${VOUCHED_CONTRACT_RULESET}))`
    : ` AND (${RANKED_SOLO_RULESET})`;
}

/** The same predicate for a row already in hand - `wouldRank` must refuse a
 *  ruleset the board would not show, before it spends a board query on it. */
export function rulesetRanks(
  kind: BoardKind,
  r: { mode: string; runKind: string; partySize: number; proofId?: string | null },
): boolean {
  if (r.runKind !== "race") return false;
  if (r.mode === "coop") return true;
  return kind === "contracts" && r.mode === "rivals" && r.partySize >= 2 && !r.proofId;
}

function boardWhere(kind: BoardKind): string {
  return (kind === "fastest" || kind === "contracts" ? " AND won = 1 AND time_ticks > 0" : "")
    + boardRuleset(kind);
}

export interface BoardQuery {
  kind: BoardKind;
  /**
   * THE SCOPE, IN THREE STATES, and collapsing it to two is what emptied the
   * museum. `null` meant `event_id IS NULL`, and `/boards/:kind` with no
   * `event` param passed `null` - so every event run was excluded from the
   * all-time boards BY CONSTRUCTION. Live consequence: a sealed daily run was
   * told by the verdict that it holds a position on DEEPEST and KILLS while
   * both of those boards returned zero entries and THE STANDINGS printed "this
   * museum is empty". On the one product whose whole pitch is that the server
   * does not lie about what a run is worth, the trust element made a claim the
   * next screen refuted.
   *
   *  - `undefined` (absent) - THE MUSEUM: every scope, contracts included.
   *  - `null` - free seeds only.
   *  - a string - that event alone.
   */
  eventId?: string | null;
  /** Only verified rows. Boards show claimed rows below the seal line by
   *  default so a fresh board is not empty on day one (COMPETITIVE.md 3.2B). */
  verifiedOnly?: boolean;
  archetype?: string | null;
  partySize?: number | null;
  limit?: number;
}

export class CompetitiveStore {
  constructor(private db: Database.Database) {
    db.exec(COMPETITIVE_SCHEMA);
    this.migrate();
  }

  /**
   * FORWARD MIGRATION on a live volume. CREATE TABLE IF NOT EXISTS does nothing
   * to a file that already has the old shape, and the band board's honesty now
   * depends on a column that shape does not have - so the columns are added
   * here and the existing run_bands rows are BACKFILLED with the same predicate
   * the verifier applies, rather than being grandfathered in.
   */
  private migrate(): void {
    const cols = (t: string): Set<string> =>
      new Set((this.db.prepare("PRAGMA table_info(" + t + ")").all() as { name: string }[]).map((c) => c.name));
    const runCols = cols("runs");
    for (const c of ["damage_dealt", "damage_taken", "gold_spent"]) {
      if (!runCols.has(c)) this.db.exec("ALTER TABLE runs ADD COLUMN " + c + " INTEGER NOT NULL DEFAULT 0");
    }
    // WHICH GAME WAS PLAYED. Rows written before the column are backfilled to
    // 'race' because that is the only ruleset the shipping client ever
    // recorded, and the submit path now refuses every other one at the door.
    if (!runCols.has("run_kind")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'race'");
    }
    if (!cols("run_bands").has("complete")) {
      this.db.exec("ALTER TABLE run_bands ADD COLUMN complete INTEGER NOT NULL DEFAULT 0");
      // BACKFILL, not bless. Floors are entered strictly in order on a verified
      // (fresh-start) run, so "the run reached a floor past this band" IS the
      // traversal predicate, and it is derivable from the row alone.
      this.db.exec(
        `UPDATE run_bands SET complete = 1 WHERE EXISTS (
           SELECT 1 FROM runs r WHERE r.id = run_bands.run_id
             AND (r.floor > (run_bands.band * 3 + 3)
                  OR (r.won = 1 AND (run_bands.band * 3 + 3) >= r.floor))
         )`,
      );
      // Anything the predicate cannot certify is PURGED rather than shown: it
      // was written by a build that did not know the difference between a split
      // and a record, and it is not evidence of anything.
      this.db.exec("DELETE FROM run_bands WHERE complete = 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_run_bands_c ON run_bands (band, complete, ticks ASC)");
    // Backfill the public-id map for every account already holding a row, so a
    // volume that predates the derived id resolves a profile link on boot
    // rather than on the account's next submission.
    for (const r of this.db.prepare("SELECT DISTINCT account_id FROM runs").all() as { account_id: string }[]) {
      this.linkPublicId(r.account_id);
    }
  }

  // ---- public identity ---------------------------------------------------

  /** Record the derived public id for an account. Idempotent; called on every
   *  insert so the reverse lookup a profile link needs always exists. */
  linkPublicId(accountId: string): string {
    const pid = publicIdFor(accountId);
    this.db.prepare(
      "INSERT INTO account_public (public_id, account_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    ).run(pid, accountId);
    return pid;
  }

  /** The only direction that needs storage: public id -> account. The forward
   *  direction is a hash and never touches the database. */
  accountForPublicId(publicId: string): string | null {
    const r = this.db.prepare("SELECT account_id FROM account_public WHERE public_id = ?")
      .get(publicId) as { account_id: string } | undefined;
    return r?.account_id ?? null;
  }

  // ---- proofs ------------------------------------------------------------

  putProof(p: {
    id: string; accountId: string; rulesHash: string; seed: number;
    eventId: string | null; ticks: number; bytes: Uint8Array; now: number;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO run_proofs (id, account_id, rules_hash, seed, event_id, ticks, bytes, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.accountId, p.rulesHash, p.seed, p.eventId, p.ticks, Buffer.from(p.bytes), p.bytes.length, p.now);
  }

  getProof(id: string): { bytes: Buffer; accountId: string; rulesHash: string } | null {
    const r = this.db.prepare("SELECT bytes, account_id, rules_hash FROM run_proofs WHERE id = ?").get(id) as
      { bytes: Buffer; account_id: string; rules_hash: string } | undefined;
    return r ? { bytes: r.bytes, accountId: r.account_id, rulesHash: r.rules_hash } : null;
  }

  /**
   * RETENTION (COMPETITIVE.md 2.4 Storage). Keep a proof only while its row is
   * on a board, plus each account own last `keepPerAccount` runs. Everything
   * else is evicted with its row - the row and the verifier-derived facts on it
   * are permanent, the film is not. An expired row becomes a photograph.
   */
  sweepProofs(keepPerAccount = 10, boardDepth = 100): number {
    // THE KEEP-SET IS A UNION ACROSS EVERY BOARD, not the DEEPEST ordering.
    // One `ORDER BY won DESC, floor DESC, time_ticks ASC` is the deepest board
    // and only the deepest board, so the FASTEST and KILLS leaders - and every
    // band record holder - had their proofs swept while their rows still held
    // rank 1, and RACE went inert on exactly the rows 2.4 Storage promises to
    // keep playable.
    const keep = new Set<string>();
    for (const kind of BOARD_KINDS) {
      const rows = this.db.prepare(
        `SELECT proof_id FROM runs
         WHERE state = 'verified' AND proof_id IS NOT NULL${boardWhere(kind)}
         ORDER BY ${boardOrder(kind)} LIMIT ?`,
      ).all(boardDepth) as { proof_id: string }[];
      for (const r of rows) keep.add(r.proof_id);
    }
    // ...and the band boards, which are their own six ladders (3.3) and are the
    // rows most likely to be shallow, cheap runs that no all-time board holds.
    for (let band = 0; band < 6; band++) {
      const rows = this.db.prepare(
        `SELECT r.proof_id AS proof_id FROM run_bands b JOIN runs r ON r.id = b.run_id
         WHERE b.band = ? AND b.complete = 1 AND r.state = 'verified' AND r.proof_id IS NOT NULL
           AND r.run_kind = 'race' AND r.mode = 'coop'
         ORDER BY b.ticks ASC, r.verified_at ASC, r.id ASC LIMIT ?`,
      ).all(band, boardDepth) as { proof_id: string }[];
      for (const r of rows) keep.add(r.proof_id);
    }
    // Plus each account's own last N, regardless of board position (2.4).
    const mine = this.db.prepare(
      `SELECT proof_id FROM (
         SELECT proof_id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC) rn
         FROM runs WHERE proof_id IS NOT NULL
       ) WHERE rn <= ?`,
    ).all(keepPerAccount) as { proof_id: string }[];
    for (const r of mine) keep.add(r.proof_id);

    const all = this.db.prepare("SELECT id FROM run_proofs").all() as { id: string }[];
    const doomed = all.filter((p) => !keep.has(p.id)).map((p) => p.id);
    if (doomed.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM run_proofs WHERE id = ?");
    const tx = this.db.transaction((ids: string[]) => { for (const id of ids) del.run(id); });
    tx(doomed);
    return doomed.length;
  }

  /**
   * WHICH BOARDS DOES THIS ROW ACTUALLY HOLD? The verdict screen weights its
   * seal on this (6.2: a run holding a board position gets the gold, a run that
   * ranks nowhere gets the hairline), and it used to answer the question by
   * looking only at today's daily-contract deepest board - so a free-seed run
   * taking rank 1 all-time was told "it ranks nowhere, and it is still true".
   */
  holdsBoards(runId: string, depth = 25): string[] {
    const run = this.getRun(runId);
    if (!run || run.state !== "verified") return [];
    const out: string[] = [];
    // BOTH SCOPES, AND THE PHRASE ON THE SEAL NAMES WHICH ONE. An event run can
    // hold a position on its contract board AND - now that the museum is not
    // free-seeds-only - on the all-time board beside it. The `break` here used
    // to stop at the contract, so the seal printed a bare board name and the
    // player clicked through to the OTHER board of that name and found it empty.
    for (const kind of BOARD_KINDS) {
      for (const scope of run.eventId ? [run.eventId, undefined] : [undefined]) {
        const rows = this.board({ kind, eventId: scope, verifiedOnly: true, limit: depth });
        if (rows.some((r) => r.id === runId)) out.push(scope ? kind + "@" + scope : kind);
      }
    }
    for (let band = 0; band < 6; band++) {
      if (this.bandBoard(band, depth).some((r) => r.id === runId)) out.push("band" + band);
    }
    return out;
  }

  // ---- runs --------------------------------------------------------------

  insertRun(r: NewRun): void {
    // THE TYPE IS ERASED AT RUNTIME AND THE ROW IS NOT (blocker 12). Requiring
    // `mode`/`runKind` in `NewRun` stops the compiler letting a caller omit
    // them; this stops a JS caller, a stale build or a future refactor doing it
    // anyway and getting `run_kind = 'race'` from a column default. A row that
    // cannot say which game it was played under is not a row this store knows
    // how to keep - a sealed one asserting the WRONG ruleset is worse than no
    // row at all, and that is exactly what the vouched path used to write.
    if (!r.mode || !r.runKind) {
      throw new Error(
        "a run row must state which game it was played under — mode and runKind are not defaultable "
        + `(got mode=${String(r.mode)}, runKind=${String(r.runKind)})`,
      );
    }
    this.db.prepare(
      `INSERT INTO runs (id, account_id, display_name, event_id, seed, rules_hash, mode, run_kind, party_size,
                         won, floor, time_ticks, kills, level, ultimate, attempt_no, private, state, proof_id, created_at)
       VALUES (@id, @accountId, @displayName, @eventId, @seed, @rulesHash, @mode, @runKind, @partySize,
               @won, @floor, @timeTicks, @kills, @level, @ultimate, @attemptNo, @private, @state, @proofId, @createdAt)`,
    ).run({
      ...r,
      eventId: r.eventId ?? null,
      rulesHash: r.rulesHash ?? null,
      partySize: r.partySize ?? 1,
      won: r.won ? 1 : 0,
      ultimate: r.ultimate ?? null,
      attemptNo: r.attemptNo ?? null,
      private: r.private ? 1 : 0,
      proofId: r.proofId ?? null,
    });
    this.linkPublicId(r.accountId); // the row now has a public name to be seen under
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RawRun | undefined;
    return r ? toRow(r) : null;
  }

  setState(id: string, state: RunState, reason?: string): void {
    this.db.prepare("UPDATE runs SET state = ?, reject_reason = ? WHERE id = ?").run(state, reason ?? null, id);
  }

  /**
   * CERTIFY: the one-time stamp (COMPETITIVE.md 2.6c). Overwrites the claimed
   * numbers with the REPLAYED ones and writes the derived facts onto the row.
   * We never re-verify and never revoke on a patch - the era stays pinned here.
   */
  certify(id: string, f: VerifiedFacts, now: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE runs SET state = 'verified', verified_at = ?, rules_hash = ?, won = ?, floor = ?,
           time_ticks = ?, kills = ?, level = ?, ultimate = ?, band_splits = ?, death_cause = ?,
           final_build = ?, damage_dealt = ?, damage_taken = ?, gold_spent = ?, reject_reason = NULL
         WHERE id = ?`,
      ).run(now, f.rulesHash, f.won ? 1 : 0, f.floor, f.timeTicks, f.kills, f.level, f.ultimate,
        JSON.stringify(f.bandSplits), JSON.stringify(f.deathCause ?? null), JSON.stringify(f.finalBuild ?? null),
        Math.round(f.damageDealt), Math.round(f.damageTaken), Math.round(f.goldSpent), id);
      this.db.prepare("DELETE FROM run_bands WHERE run_id = ?").run(id);
      // Only TRAVERSED bands are stored at all. Keeping partials and filtering
      // on read is one forgotten predicate away from a floor-1 death at the top
      // of a board, and there is no way back once a player has seen that.
      const ins = this.db.prepare("INSERT INTO run_bands (run_id, band, ticks, complete) VALUES (?, ?, ?, 1)");
      f.bandSplits.forEach((ticks, band) => {
        if (ticks > 0 && f.bandComplete[band]) ins.run(id, band, ticks);
      });
    });
    tx();
  }

  runsByAccount(accountId: string, limit = 20): RunRow[] {
    return (this.db.prepare(
      "SELECT * FROM runs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(accountId, limit) as RawRun[]).map(toRow);
  }

  /** Rows stored `claimed` purely because the board was full when they arrived,
   *  and whose film is still on disk. The board moves; the verdict on these
   *  should be allowed to move with it. */
  rankRefused(limit = 8): RunRow[] {
    return (this.db.prepare(
      `SELECT * FROM runs
       WHERE state = 'claimed' AND proof_id IS NOT NULL
         AND reject_reason LIKE ? || '%'
       ORDER BY created_at DESC LIMIT ?`,
    ).all(RANK_REFUSED_REASON, limit) as RawRun[]).map(toRow);
  }

  countByState(state: RunState): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM runs WHERE state = ?").get(state) as { c: number }).c;
  }

  // ---- boards ------------------------------------------------------------

  /**
   * One board, best row per ACCOUNT (not per name - that was the squatting and
   * FORGET-ME hole). Split dimensions collapse into the parent below the
   * entrant gate, so nothing is ever empty: rows still exist, they are just
   * shown on the parent and tagged (COMPETITIVE.md 3.4).
   */
  board(q: BoardQuery): RunRow[] {
    const limit = Math.min(q.limit ?? 50, MAX_BOARD_ROWS);
    const args: unknown[] = [];
    // `unverifiable` IS ON THE SHELF, BECAUSE THE SCREEN PROMISED IT WOULD BE
    // (blocker 11). 2.6d says an era we can no longer execute leaves the row
    // holding "whatever stamp it earned", and `verdictSeal("unverifiable")`
    // tells the player in as many words that "the row keeps whatever it
    // earned" - while this predicate dropped the row off every board AND off
    // the UNPROVEN shelf under it, so the run the System had just promised to
    // keep was on no surface in the product. It ranks nowhere (the API splits
    // on `state === 'verified'`); it is simply visible, which is the whole
    // difference between keeping something and saying you did.
    let where = "state IN ('verified','claimed','unverifiable')";
    if (q.verifiedOnly) where = "state = 'verified'";
    if (q.eventId !== undefined) {
      if (q.eventId === null) { where += " AND event_id IS NULL"; }
      else { where += " AND event_id = ?"; args.push(q.eventId); }
    }
    where += boardWhere(q.kind);
    if (q.archetype && this.splitOpen("ultimate", q.archetype, q.eventId)) {
      where += " AND ultimate = ?";
      args.push(q.archetype);
    }
    if (q.partySize && this.splitOpen("party_size", String(q.partySize), q.eventId)) {
      where += " AND party_size = ?";
      args.push(q.partySize);
    }
    // Best row per account: rank within the account, then order the winners.
    //
    // A PROOF OUTRANKS A CLAIM INSIDE THE ACCOUNT TOO. The outer ORDER BY put
    // verified rows above claimed ones, but the PARTITION did not - so when a
    // crawler had two rows with identical numbers (the same run submitted once
    // before linking an identity and once after), `created_at ASC` picked the
    // EARLIER one, the unproven row became the account's representative, and
    // the account vanished from a verified-only board while its own sealed run
    // sat in the table. Reproduced live: a certified daily row holding
    // deepest@daily and kills@daily returned zero entries on that board.
    const sql =
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY account_id ORDER BY state = 'verified' DESC, ${boardOrder(q.kind)}) rn
         FROM runs WHERE ${where}
       ) WHERE rn = 1
       ORDER BY state = 'verified' DESC, ${boardOrder(q.kind)}
       LIMIT ?`;
    args.push(limit);
    return (this.db.prepare(sql).all(...args) as RawRun[]).map(toRow);
  }

  /** Has this split earned its own board yet? Shown, not hidden: the System
   *  says "THE SPONSOR BOARD OPENS AT 20 ENTRANTS. CURRENT: 17." */
  splitEntrants(column: "ultimate" | "party_size", value: string, eventId?: string | null): number {
    const evt = eventId === undefined ? "1 = 1" : eventId === null ? "event_id IS NULL" : "event_id = ?";
    const args: unknown[] = typeof eventId === "string" ? [value, eventId] : [value];
    return (this.db.prepare(
      `SELECT COUNT(DISTINCT account_id) c FROM runs WHERE state = 'verified' AND ${column} = ? AND ${evt}`,
    ).get(...args) as { c: number }).c;
  }

  splitOpen(column: "ultimate" | "party_size", value: string, eventId?: string | null): boolean {
    return this.splitEntrants(column, value, eventId) >= SPLIT_GATE_ENTRIES;
  }

  /**
   * THE QUEUE RULE (COMPETITIVE.md 2.4 rule 2). Verification costs CPU on a
   * one-machine box, so a submission is replayed only if, TAKEN AT FACE VALUE,
   * it would land in the top `depth` of a board it targets - or beat this
   * account current verified best on an open event. Clause (b) is the
   * load-bearing one: dailies allow unlimited attempts, so without it event
   * volume equals attempts by every player rather than improvements.
   */
  wouldRank(kind: BoardKind, candidate: RunRow, depth = 25): boolean {
    // A RULESET NO BOARD RANKS BUYS NO CPU. The queue rule is "would this land
    // in the top 25 of a board it targets", and a row the board predicate will
    // never show targets no board at all.
    if (!rulesetRanks(kind, candidate)) return false;
    if (kind === "fastest" || kind === "contracts") {
      if (!candidate.won || candidate.timeTicks <= 0) return false;
    }
    const rows = this.board({ kind, eventId: candidate.eventId ?? undefined, verifiedOnly: true, limit: depth });
    if (rows.length < depth) return true;
    const worst = rows[rows.length - 1];
    switch (kind) {
      case "deepest":
        // The board's own comparator, not a second copy of it that could drift
        // out of agreement with the ORDER BY it is supposed to predict.
        return compareDeepest(candidate, worst) < 0;
      case "fastest":
      case "contracts":
        return candidate.timeTicks < worst.timeTicks;
      case "kills":
        return candidate.kills > worst.kills;
    }
  }

  /** This account best VERIFIED row on an event - the improvement test. Same
   *  ordering as the board, so "your verified best" and "the row above you on
   *  the contract" can never be two different runs. */
  bestVerifiedOnEvent(accountId: string, eventId: string): RunRow | null {
    const r = this.db.prepare(
      `SELECT * FROM runs WHERE account_id = ? AND event_id = ? AND state = 'verified'
       ORDER BY ${DEEPEST_ORDER} LIMIT 1`,
    ).get(accountId, eventId) as RawRun | undefined;
    return r ? toRow(r) : null;
  }

  /**
   * Per-band board (COMPETITIVE.md 3.3): fastest verified TRAVERSAL of a band.
   *
   * Three rules, and every one of them was wrong once:
   *  - `b.complete = 1`. Without it the optimal play for a band record is to
   *    enter the band and die on the threshold, and the top of the board fills
   *    with eight-second deaths.
   *  - The tie-break is EXPLICIT and printed on the board. Splits collide
   *    constantly at this population, so the order is ticks ASC, then the
   *    earliest run to be CERTIFIED, then the row id - deterministic, and
   *    stated in the subtitle instead of left for the reader to guess.
   *  - A window function instead of GROUP BY + HAVING MIN, which relied on
   *    SQLite's bare-column behaviour to return the matching row.
   */
  bandBoard(band: number, limit = 25): (RunRow & { bandTicks: number })[] {
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT r.*, b.ticks AS band_ticks,
           ROW_NUMBER() OVER (PARTITION BY r.account_id
             ORDER BY b.ticks ASC, r.verified_at ASC, r.id ASC) rn
         FROM run_bands b JOIN runs r ON r.id = b.run_id
         WHERE b.band = ? AND b.complete = 1 AND r.state = 'verified'
           AND r.run_kind = 'race' AND r.mode = 'coop'
       ) WHERE rn = 1
       ORDER BY band_ticks ASC, verified_at ASC, id ASC LIMIT ?`,
    ).all(band, Math.min(limit, MAX_BOARD_ROWS)) as (RawRun & { band_ticks: number })[];
    return rows.map((r) => ({ ...toRow(r), bandTicks: r.band_ticks }));
  }

  /**
   * THIS ACCOUNT'S band personal bests, off the SAME rows and the SAME
   * predicate as the board. The career panel used to read a localStorage ledger
   * with its own rules, so the profile and the board disagreed about the same
   * record; two sources of truth is one too many for anything competitive.
   */
  bandBests(accountId: string): (number | null)[] {
    const out = new Array<number | null>(6).fill(null);
    const rows = this.db.prepare(
      `SELECT b.band AS band, MIN(b.ticks) AS ticks
       FROM run_bands b JOIN runs r ON r.id = b.run_id
       WHERE r.account_id = ? AND b.complete = 1 AND r.state = 'verified'
         AND r.run_kind = 'race' AND r.mode = 'coop'
       GROUP BY b.band`,
    ).all(accountId) as { band: number; ticks: number }[];
    for (const r of rows) if (r.band >= 0 && r.band < out.length) out[r.band] = r.ticks;
    return out;
  }

  // ---- events + tickets --------------------------------------------------

  /** An event PINS ITS ERA at creation (COMPETITIVE.md 2.6e): deploying a sim
   *  change mid-event freezes it rather than invalidating honest entries. */
  upsertEvent(e: {
    id: string; kind: string; day: string; seed: number; rulesHash: string;
    opensAt: number; closesAt: number; season: string;
  }): void {
    this.db.prepare(
      `INSERT INTO events (id, kind, day, seed, rules_hash, opens_at, closes_at, frozen, season)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(e.id, e.kind, e.day, e.seed, e.rulesHash, e.opensAt, e.closesAt, e.season);
  }

  getEvent(id: string): {
    id: string; kind: string; day: string; seed: number; rulesHash: string;
    opensAt: number; closesAt: number; frozen: boolean; season: string;
  } | null {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as {
      id: string; kind: string; day: string; seed: number; rules_hash: string;
      opens_at: number; closes_at: number; frozen: number; season: string;
    } | undefined;
    return r ? {
      id: r.id, kind: r.kind, day: r.day, seed: r.seed, rulesHash: r.rules_hash,
      opensAt: r.opens_at, closesAt: r.closes_at, frozen: !!r.frozen, season: r.season,
    } : null;
  }

  /** PATCH DAY: an event whose era no longer matches the running build closes
   *  early. Verified entries stand; new submissions are refused. */
  freezeStaleEvents(currentRulesHash: string): string[] {
    const stale = this.db.prepare(
      "SELECT id FROM events WHERE frozen = 0 AND rules_hash <> ?",
    ).all(currentRulesHash) as { id: string }[];
    if (stale.length) {
      this.db.prepare("UPDATE events SET frozen = 1 WHERE frozen = 0 AND rules_hash <> ?").run(currentRulesHash);
    }
    return stale.map((s) => s.id);
  }

  /** Issue the next attempt number for an account on an event. The START is
   *  observed, which is what closes "play offline, retry, submit the winner as
   *  attempt 1" - the ticket carries this integer (COMPETITIVE.md 3.2A). */
  nextAttempt(accountId: string, eventId: string): number {
    this.db.prepare(
      `INSERT INTO event_attempts (account_id, event_id, attempts) VALUES (?, ?, 1)
       ON CONFLICT(account_id, event_id) DO UPDATE SET attempts = attempts + 1`,
    ).run(accountId, eventId);
    return (this.db.prepare(
      "SELECT attempts FROM event_attempts WHERE account_id = ? AND event_id = ?",
    ).get(accountId, eventId) as { attempts: number }).attempts;
  }

  /**
   * SPEND A TICKET SIGNATURE. Returns false when it has already been spent.
   *
   * `readTicket` is a pure HMAC check with no side effect, which is why the
   * same attempt-1 ticket validated an unlimited number of times: the contract
   * "one signature, one submission" existed only in the documentation. It is a
   * row now.
   */
  consumeTicket(sig: string, accountId: string, eventId: string, attemptNo: number, now: number): boolean {
    const info = this.db.prepare(
      `INSERT INTO spent_tickets (sig, account_id, event_id, attempt_no, used_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(sig) DO NOTHING`,
    ).run(sig, accountId, eventId, attemptNo, now);
    return info.changes > 0;
  }

  /** Tickets are useful for minutes; keep them for a day and drop the rest. */
  sweepSpentTickets(before: number): number {
    return this.db.prepare("DELETE FROM spent_tickets WHERE used_at < ?").run(before).changes;
  }

  attemptsOf(accountId: string, eventId: string): number {
    const r = this.db.prepare(
      "SELECT attempts FROM event_attempts WHERE account_id = ? AND event_id = ?",
    ).get(accountId, eventId) as { attempts: number } | undefined;
    return r?.attempts ?? 0;
  }

  /** The run CP was scored on. Set once, by the FIRST ticketed attempt. */
  firstScoredRun(accountId: string, eventId: string): string | null {
    const r = this.db.prepare(
      "SELECT first_scored_run_id FROM event_attempts WHERE account_id = ? AND event_id = ?",
    ).get(accountId, eventId) as { first_scored_run_id: string | null } | undefined;
    return r?.first_scored_run_id ?? null;
  }

  markScored(accountId: string, eventId: string, runId: string): void {
    this.db.prepare(
      `INSERT INTO event_attempts (account_id, event_id, attempts, first_scored_run_id)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(account_id, event_id) DO UPDATE SET
         first_scored_run_id = COALESCE(first_scored_run_id, excluded.first_scored_run_id)`,
    ).run(accountId, eventId, runId);
  }

  // ---- season CP ---------------------------------------------------------

  /** Entrants on an event, for the CP denominator. */
  eventEntrants(eventId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(DISTINCT account_id) c FROM runs WHERE event_id = ? AND state = 'verified'",
    ).get(eventId) as { c: number }).c;
  }

  /** 1-based rank of a run among verified entries on its event. */
  eventRank(eventId: string, runId: string): number {
    const rows = this.board({ kind: "deepest", eventId, verifiedOnly: true, limit: MAX_BOARD_ROWS });
    const i = rows.findIndex((r) => r.id === runId);
    return i < 0 ? rows.length + 1 : i + 1;
  }

  /** Record CP for one event result and roll up the season total. The season
   *  score is the sum of your BEST 10 event results - a golf-tour portfolio,
   *  not a rating, which is why there is no decay (COMPETITIVE.md 3.2C). */
  recordCp(accountId: string, season: string, eventId: string, cp: number, runId: string, now: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO season_results (account_id, season, event_id, cp, run_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, event_id) DO UPDATE SET cp = excluded.cp, run_id = excluded.run_id,
           updated_at = excluded.updated_at`,
      ).run(accountId, season, eventId, cp, runId, now);
      const best = this.db.prepare(
        "SELECT cp FROM season_results WHERE account_id = ? AND season = ? ORDER BY cp DESC LIMIT 10",
      ).all(accountId, season) as { cp: number }[];
      const total = best.reduce((a, b) => a + b.cp, 0);
      this.db.prepare(
        `INSERT INTO season_cp (account_id, season, cp, events_counted, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, season) DO UPDATE SET cp = excluded.cp,
           events_counted = excluded.events_counted, updated_at = excluded.updated_at`,
      ).run(accountId, season, total, best.length, now);
    });
    tx();
  }

  seasonCp(accountId: string, season: string): { cp: number; eventsCounted: number } | null {
    const r = this.db.prepare(
      "SELECT cp, events_counted FROM season_cp WHERE account_id = ? AND season = ?",
    ).get(accountId, season) as { cp: number; events_counted: number } | undefined;
    return r ? { cp: r.cp, eventsCounted: r.events_counted } : null;
  }

  /** The whole season ladder, sorted. One array; tiers are percentile bands
   *  computed over it (COMPETITIVE.md 3.2C) - no hidden MMR, no decay. */
  seasonLadder(season: string, limit = MAX_BOARD_ROWS): { accountId: string; cp: number; eventsCounted: number }[] {
    return (this.db.prepare(
      "SELECT account_id, cp, events_counted FROM season_cp WHERE season = ? ORDER BY cp DESC LIMIT ?",
    ).all(season, limit) as { account_id: string; cp: number; events_counted: number }[])
      .map((r) => ({ accountId: r.account_id, cp: r.cp, eventsCounted: r.events_counted }));
  }

  seasonSize(season: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM season_cp WHERE season = ?").get(season) as { c: number }).c;
  }

  seasonRank(season: string, accountId: string): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) + 1 c FROM season_cp WHERE season = ? AND cp > (
         SELECT COALESCE(cp, -1) FROM season_cp WHERE season = ? AND account_id = ?)`,
    ).get(season, season, accountId) as { c: number };
    return r.c;
  }

  // ---- mastery, follows, verify budget -----------------------------------

  bumpMastery(accountId: string, ultimate: string, xp: number, now: number): void {
    this.db.prepare(
      `INSERT INTO mastery (account_id, ultimate, xp, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, ultimate) DO UPDATE SET xp = xp + excluded.xp, updated_at = excluded.updated_at`,
    ).run(accountId, ultimate, Math.max(0, Math.round(xp)), now);
  }

  masteryOf(accountId: string): { ultimate: string; xp: number }[] {
    return (this.db.prepare(
      "SELECT ultimate, xp FROM mastery WHERE account_id = ? ORDER BY xp DESC",
    ).all(accountId) as { ultimate: string; xp: number }[]);
  }

  /** One-directional follow, capped. No requests, no accept flow, no DMs -
   *  following needs no consent surface, which deletes a whole class of
   *  moderation work (COMPETITIVE.md 8.2). */
  follow(accountId: string, targetId: string, now: number, cap = 100): boolean {
    const n = (this.db.prepare("SELECT COUNT(*) c FROM follows WHERE account_id = ?")
      .get(accountId) as { c: number }).c;
    if (n >= cap) return false;
    this.db.prepare(
      "INSERT OR IGNORE INTO follows (account_id, target_id, created_at) VALUES (?, ?, ?)",
    ).run(accountId, targetId, now);
    return true;
  }

  unfollow(accountId: string, targetId: string): void {
    this.db.prepare("DELETE FROM follows WHERE account_id = ? AND target_id = ?").run(accountId, targetId);
  }

  following(accountId: string): string[] {
    return (this.db.prepare("SELECT target_id FROM follows WHERE account_id = ?")
      .all(accountId) as { target_id: string }[]).map((r) => r.target_id);
  }

  /**
   * VERIFY-CPU ACCOUNTING (COMPETITIVE.md 2.7.3). The existing per-IP bucket
   * counts REQUESTS; the scarce resource is MILLISECONDS. Over budget, a
   * submission is still accepted and stored claimed - it is just never queued,
   * so a flood degrades the flooder own entries and nobody else.
   */
  spendVerifyMs(subject: string, day: string, ms: number): number {
    this.db.prepare(
      `INSERT INTO verify_budget (subject, day, ms) VALUES (?, ?, ?)
       ON CONFLICT(subject, day) DO UPDATE SET ms = ms + excluded.ms`,
    ).run(subject, day, Math.max(0, Math.round(ms)));
    return this.verifyMsSpent(subject, day);
  }

  verifyMsSpent(subject: string, day: string): number {
    const r = this.db.prepare("SELECT ms FROM verify_budget WHERE subject = ? AND day = ?")
      .get(subject, day) as { ms: number } | undefined;
    return r?.ms ?? 0;
  }

  /** verify_budget is the only unbounded-LOOKING table, and it is not: rows
   *  are keyed by day and swept on a 48h window. */
  sweepVerifyBudget(cutoffDay: string): void {
    this.db.prepare("DELETE FROM verify_budget WHERE day < ?").run(cutoffDay);
  }

  // ---- privacy -----------------------------------------------------------

  /** Owner-only PRIVATE toggle. A private run is STILL VERIFIED AND STILL
   *  RANKS - competitive integrity does not depend on distribution; the flag
   *  governs distribution only (COMPETITIVE.md 8.1). */
  setPrivate(runId: string, accountId: string, isPrivate: boolean): boolean {
    const info = this.db.prepare("UPDATE runs SET private = ? WHERE id = ? AND account_id = ?")
      .run(isPrivate ? 1 : 0, runId, accountId);
    return info.changes > 0;
  }

  /**
   * This account's BEST VERIFIED run on every event it ever entered, in the
   * board's own order. The head-to-head ledger is built from two of these: on
   * one machine, at this population, two indexed scans beat any denormalized
   * rivalry table that could drift out of agreement with the boards.
   */
  eventBests(accountId: string): {
    eventId: string; won: boolean; floor: number; ticks: number; kills: number;
  }[] {
    return (this.db.prepare(
      `SELECT event_id, won, floor, time_ticks, kills FROM (
         SELECT event_id, won, floor, time_ticks, kills,
           ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ${DEEPEST_ORDER}) rn
         FROM runs WHERE account_id = ? AND state = 'verified' AND event_id IS NOT NULL
       ) WHERE rn = 1`,
    ).all(accountId) as
      { event_id: string; won: number; floor: number; time_ticks: number; kills: number }[])
      .map((r) => ({
        eventId: r.event_id, won: !!r.won, floor: r.floor, ticks: r.time_ticks, kills: r.kills,
      }));
  }

  /** Every display name this account has ever put on a board row. FORGET ME
   *  needs it: the retired JSON boards key on NAME, so an account id alone
   *  cannot reach them, and a deleted crawler's name would stay public. */
  displayNamesOf(accountId: string): string[] {
    return (this.db.prepare(
      "SELECT DISTINCT display_name FROM runs WHERE account_id = ?",
    ).all(accountId) as { display_name: string }[]).map((r) => r.display_name);
  }

  /** Moderation: replace a display name everywhere by account id. ONE UPDATE,
   *  because names are snapshotted per row and rows key on the account. */
  renameAccount(accountId: string, displayName: string): void {
    this.db.prepare("UPDATE runs SET display_name = ? WHERE account_id = ?").run(displayName, accountId);
  }

  /**
   * FORGET ME, for real this time. The JSON boards this replaces were never
   * touched by deleteAccount, so a deleted account name stayed on public boards
   * forever - a LIVE privacy gap, not a future one. Every table below hangs off
   * the account and every one of them goes.
   */
  deleteAccount(accountId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM run_bands WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)").run(accountId);
      this.db.prepare("DELETE FROM run_proofs WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM runs WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM event_attempts WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM season_results WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM season_cp WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM mastery WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM follows WHERE account_id = ? OR target_id = ?").run(accountId, accountId);
      this.db.prepare("DELETE FROM verify_budget WHERE subject = ?").run("acct:" + accountId);
      this.db.prepare("DELETE FROM spent_tickets WHERE account_id = ?").run(accountId);
      // ...and the one row that knows the account existed at all.
      this.db.prepare("DELETE FROM account_public WHERE account_id = ?").run(accountId);
    });
    tx();
  }

  /**
   * FORGET ME HAS TO REACH THE ROWS THAT HAVE NO ACCOUNT.
   *
   * `importLegacyBoard` copies every retired JSON board row into this store
   * keyed `accountId = "legacy:" + name`, and it runs unconditionally at boot.
   * `deleteAccount` deletes `WHERE account_id = ?` and the name-based cascade
   * reached only the JSON file - so after a FORGET ME the JSON row went and the
   * SQLite copy of the same crawler survived forever, publicly, in the UNPROVEN
   * shelf on THE STANDINGS. That is exactly the gap 1.2 calls "a LIVE privacy
   * gap, not a future one", re-opened by the migration that was supposed to
   * close it.
   *
   * Names match case-insensitively on the legacy key AND on the snapshotted
   * display name, the same way `Leaderboard.forgetNames` matches them, so the
   * two halves of the cascade cannot disagree about who was forgotten.
   */
  deleteByDisplayNames(names: readonly string[]): number {
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
    if (wanted.size === 0) return 0;
    const rows = this.db.prepare(
      "SELECT id, account_id, display_name FROM runs WHERE account_id LIKE 'legacy:%'",
    ).all() as { id: string; account_id: string; display_name: string }[];
    const doomed = rows.filter((r) =>
      wanted.has(r.display_name.trim().toLowerCase())
      || wanted.has(r.account_id.slice("legacy:".length).trim().toLowerCase()));
    if (doomed.length === 0) return 0;
    const tx = this.db.transaction(() => {
      const delBands = this.db.prepare("DELETE FROM run_bands WHERE run_id = ?");
      const delRun = this.db.prepare("DELETE FROM runs WHERE id = ?");
      const delPublic = this.db.prepare("DELETE FROM account_public WHERE account_id = ?");
      for (const r of doomed) {
        delBands.run(r.id);
        delRun.run(r.id);
        delPublic.run(r.account_id);
      }
    });
    tx();
    return doomed.length;
  }

  /**
   * A ROW THE SERVER VOUCHES FOR ITSELF (COMPETITIVE.md 1.1). A RIVALS contract
   * is decided by the AUTHORITATIVE sim on this box - it is the one score that
   * needs no proof because the server watched every tick of it - and it used to
   * be written to the retired JSON board, whose every response is stamped
   * "UNSEALED · LEGACY — self-reported rows from before verification". The only
   * genuinely authoritative row in the product was wearing the label reserved
   * for forgeries.
   *
   * It lands here instead, VERIFIED, era-stamped, with no proof id: the film
   * does not exist (nobody recorded a party run), and the row's chip says so
   * plainly instead of pretending a proof aged out.
   *
   * WHAT IT MAY NOT DO IS LIE ABOUT WHICH GAME IT WAS (blocker 12). It stamps
   * `mode` and `runKind` from the AUTHORITATIVE INSTANCE, and `NewRun` now
   * requires both, so a `{rivals, roam}` party writes a row that says `roam`
   * and is therefore ranked by no board (see `boardRuleset`) instead of a row
   * that says `race` and outranks certified permadeath clears.
   */
  insertServerVouched(r: NewRun & { rulesHash: string }, now: number): void {
    this.insertRun({ ...r, state: "verified" });
    this.db.prepare(
      "UPDATE runs SET state = 'verified', verified_at = ?, rules_hash = ? WHERE id = ?",
    ).run(now, r.rulesHash, r.id);
  }

  // ---- one-time migration ------------------------------------------------

  /**
   * Import the retired leaderboard.json ONCE, and import every row as CLAIMED
   * with a NULL rules_hash - never verified, never era-stamped. Those rows were
   * recorded under pre-dmath rules by clients whose Math.sin we now know
   * disagreed across engines; they are history, not evidence. Shipping this
   * before MUST-0 would silently bless unverifiable rows as verified, and there
   * is no way back from that (COMPETITIVE.md MUST-0 ordering constraint 2).
   */
  importLegacyBoard(
    entries: { name: string; floor: number; won: boolean; timeSec: number; kills: number; at: number }[],
    tickRate: number,
  ): number {
    const done = this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_board_imported'").get() as
      { value: string } | undefined;
    if (done) return 0;
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        // A legacy row has no account: it is keyed on the name it was submitted
        // under, in a namespace no real account can collide with.
        const accountId = "legacy:" + e.name;
        this.insertRun({
          id: "legacy-" + n + "-" + e.at,
          accountId,
          displayName: e.name,
          seed: 0,
          rulesHash: null,
          // The retired JSON board only ever held solo race runs; it had no
          // other door. Stated rather than defaulted, like every other row.
          mode: "coop",
          runKind: "race",
          won: e.won,
          floor: e.floor,
          timeTicks: Math.round(e.timeSec * tickRate),
          kills: e.kills,
          level: 1,
          state: "claimed",
          createdAt: e.at,
        });
        n++;
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_board_imported', ?)")
        .run(String(Date.now()));
    });
    tx();
    return n;
  }
}
