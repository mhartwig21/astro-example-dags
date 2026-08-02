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
import type Database from "better-sqlite3";

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

export interface RunRow {
  id: string;
  accountId: string;
  displayName: string;
  eventId: string | null;
  seed: number;
  rulesHash: string | null;
  mode: string;
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
  mode?: string;
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
  mode          TEXT NOT NULL DEFAULT 'solo',
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
`;

interface RawRun {
  id: string; account_id: string; display_name: string; event_id: string | null;
  seed: number; rules_hash: string | null; mode: string; party_size: number;
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
    seed: r.seed, rulesHash: r.rules_hash, mode: r.mode, partySize: r.party_size,
    won: !!r.won, floor: r.floor, timeTicks: r.time_ticks, kills: r.kills, level: r.level,
    ultimate: r.ultimate, bandSplits: parse<number[]>(r.band_splits),
    deathCause: parse<unknown>(r.death_cause), finalBuild: parse<unknown>(r.final_build),
    damageDealt: r.damage_dealt ?? 0, damageTaken: r.damage_taken ?? 0, goldSpent: r.gold_spent ?? 0,
    attemptNo: r.attempt_no, private: !!r.private, state: r.state,
    rejectReason: r.reject_reason, verifiedAt: r.verified_at, proofId: r.proof_id,
    createdAt: r.created_at,
  };
}

/** ORDER BY fragment per board. `fastest` and `contracts` only rank clears;
 *  the WHERE that enforces that lives in boardWhere. */
function boardOrder(kind: BoardKind): string {
  switch (kind) {
    case "deepest": return "won DESC, floor DESC, time_ticks ASC, created_at ASC";
    case "fastest": return "time_ticks ASC, created_at ASC";
    case "kills": return "kills DESC, created_at ASC";
    case "contracts": return "time_ticks ASC, created_at ASC";
  }
}

function boardWhere(kind: BoardKind): string {
  return kind === "fastest" || kind === "contracts" ? " AND won = 1 AND time_ticks > 0" : "";
}

export interface BoardQuery {
  kind: BoardKind;
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
    const info = this.db.prepare(
      `DELETE FROM run_proofs WHERE id NOT IN (
         SELECT proof_id FROM runs WHERE proof_id IS NOT NULL AND id IN (
           SELECT id FROM runs WHERE state = 'verified'
           ORDER BY won DESC, floor DESC, time_ticks ASC LIMIT ?
         )
         UNION
         SELECT proof_id FROM (
           SELECT proof_id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC) rn
           FROM runs WHERE proof_id IS NOT NULL
         ) WHERE rn <= ?
       )`,
    ).run(boardDepth, keepPerAccount);
    return info.changes;
  }

  // ---- runs --------------------------------------------------------------

  insertRun(r: NewRun): void {
    this.db.prepare(
      `INSERT INTO runs (id, account_id, display_name, event_id, seed, rules_hash, mode, party_size,
                         won, floor, time_ticks, kills, level, ultimate, attempt_no, private, state, proof_id, created_at)
       VALUES (@id, @accountId, @displayName, @eventId, @seed, @rulesHash, @mode, @partySize,
               @won, @floor, @timeTicks, @kills, @level, @ultimate, @attemptNo, @private, @state, @proofId, @createdAt)`,
    ).run({
      ...r,
      eventId: r.eventId ?? null,
      rulesHash: r.rulesHash ?? null,
      mode: r.mode ?? "solo",
      partySize: r.partySize ?? 1,
      won: r.won ? 1 : 0,
      ultimate: r.ultimate ?? null,
      attemptNo: r.attemptNo ?? null,
      private: r.private ? 1 : 0,
      proofId: r.proofId ?? null,
    });
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
    let where = "state IN ('verified','claimed')";
    if (q.verifiedOnly) where = "state = 'verified'";
    if (q.eventId !== undefined) {
      if (q.eventId === null) { where += " AND event_id IS NULL"; }
      else { where += " AND event_id = ?"; args.push(q.eventId); }
    }
    where += boardWhere(q.kind);
    if (q.archetype && this.splitOpen("ultimate", q.archetype, q.eventId ?? null)) {
      where += " AND ultimate = ?";
      args.push(q.archetype);
    }
    if (q.partySize && this.splitOpen("party_size", String(q.partySize), q.eventId ?? null)) {
      where += " AND party_size = ?";
      args.push(q.partySize);
    }
    // Best row per account: rank within the account, then order the winners.
    const sql =
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY ${boardOrder(q.kind)}) rn
         FROM runs WHERE ${where}
       ) WHERE rn = 1
       ORDER BY state = 'verified' DESC, ${boardOrder(q.kind)}
       LIMIT ?`;
    args.push(limit);
    return (this.db.prepare(sql).all(...args) as RawRun[]).map(toRow);
  }

  /** Has this split earned its own board yet? Shown, not hidden: the System
   *  says "THE SPONSOR BOARD OPENS AT 20 ENTRANTS. CURRENT: 17." */
  splitEntrants(column: "ultimate" | "party_size", value: string, eventId: string | null): number {
    const evt = eventId === null ? "event_id IS NULL" : "event_id = ?";
    const args: unknown[] = eventId === null ? [value] : [value, eventId];
    return (this.db.prepare(
      `SELECT COUNT(DISTINCT account_id) c FROM runs WHERE state = 'verified' AND ${column} = ? AND ${evt}`,
    ).get(...args) as { c: number }).c;
  }

  splitOpen(column: "ultimate" | "party_size", value: string, eventId: string | null): boolean {
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
    if (kind === "fastest" || kind === "contracts") {
      if (!candidate.won || candidate.timeTicks <= 0) return false;
    }
    const rows = this.board({ kind, eventId: candidate.eventId ?? null, verifiedOnly: true, limit: depth });
    if (rows.length < depth) return true;
    const worst = rows[rows.length - 1];
    switch (kind) {
      case "deepest":
        if (candidate.won !== worst.won) return candidate.won;
        if (candidate.floor !== worst.floor) return candidate.floor > worst.floor;
        return candidate.timeTicks < worst.timeTicks;
      case "fastest":
      case "contracts":
        return candidate.timeTicks < worst.timeTicks;
      case "kills":
        return candidate.kills > worst.kills;
    }
  }

  /** This account best VERIFIED row on an event - the improvement test. */
  bestVerifiedOnEvent(accountId: string, eventId: string): RunRow | null {
    const r = this.db.prepare(
      `SELECT * FROM runs WHERE account_id = ? AND event_id = ? AND state = 'verified'
       ORDER BY won DESC, floor DESC, time_ticks ASC LIMIT 1`,
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
  eventBests(accountId: string): { eventId: string; won: boolean; floor: number; ticks: number }[] {
    return (this.db.prepare(
      `SELECT event_id, won, floor, time_ticks FROM (
         SELECT event_id, won, floor, time_ticks,
           ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY won DESC, floor DESC, time_ticks ASC) rn
         FROM runs WHERE account_id = ? AND state = 'verified' AND event_id IS NOT NULL
       ) WHERE rn = 1`,
    ).all(accountId) as { event_id: string; won: number; floor: number; time_ticks: number }[])
      .map((r) => ({ eventId: r.event_id, won: !!r.won, floor: r.floor, ticks: r.time_ticks }));
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
    });
    tx();
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
