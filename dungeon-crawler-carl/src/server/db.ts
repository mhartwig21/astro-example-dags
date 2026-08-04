import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { CompetitiveStore } from "./competitive";

// PERSISTENCE.md P1: SQLite on the Fly volume. One file (DB_FILE, prod:
// /data/dcc.sqlite) holds accounts, party membership, and per-character saves,
// so deploys and dropped instances stop eating progression. The API is sync
// (better-sqlite3) on purpose: checkpoint writes are a few KB at most every
// ~60s per instance — microseconds against the 33ms tick budget.
//
// Trust model matches the leaderboard's: friends-scale. The account id is an
// anonymous bearer token minted by the server and kept by the client; it is
// stored plain for now — hash it when strangers arrive.

/** Expiry horizons per run kind: a Roam campaign spans up to a month of real
 *  time (plus slack); race-style parties that go quiet for a week are done. */
export const EXPIRY_MS: Record<string, number> = {
  roam: 45 * 24 * 3600 * 1000,
  race: 7 * 24 * 3600 * 1000,
};

export interface StoredParty {
  mode: string;
  runKind: string;
  floor: number;
}

export interface StoredMember {
  playerId: number;
  saveJson: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS parties (
  code       TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  run_kind   TEXT NOT NULL DEFAULT 'race',
  floor      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS party_members (
  party_code TEXT NOT NULL,
  account_id TEXT NOT NULL,
  player_id  INTEGER NOT NULL,
  save_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (party_code, account_id)
);
-- First-contact tips (sim/tips.ts) are once-EVER per account, not once per
-- character: party_members saves die with the run (clearParty), so seen tips
-- live here and get seeded into every fresh character the account starts.
CREATE TABLE IF NOT EXISTS account_tips (
  account_id TEXT NOT NULL,
  tip_id     TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, tip_id)
);
-- P2 (hibernate/restore) writes this; created now so the schema is complete.
CREATE TABLE IF NOT EXISTS instance_snapshots (
  party_code TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Usage/balance telemetry: one append-only row per notable moment
-- (session_start/session_end/floor/run_end), with a JSON payload carrying
-- build summaries. Litestream replicates the whole file, so this is the
-- long-term record balance questions get answered from. Never swept.
CREATE TABLE IF NOT EXISTS usage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  party_code TEXT NOT NULL,
  account_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_kind_ts ON usage_events (kind, ts);
-- OAuth identities: a provider identity recovers exactly one account (the
-- anonymous token), which is how sign-in gives cross-device saves. An account
-- may hold several identities (Discord AND Google).
CREATE TABLE IF NOT EXISTS account_identities (
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  display     TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON account_identities (account_id);
-- Career aggregates per account (crawler profiles). Bumped on run submits.
CREATE TABLE IF NOT EXISTS account_stats (
  account_id TEXT PRIMARY KEY,
  runs       INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  deepest    INTEGER NOT NULL DEFAULT 0,
  kills      INTEGER NOT NULL DEFAULT 0,
  time_sec   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

export class PersistDb {
  private db: Database.Database;
  /** Runs, proofs, ladders, events, CP (COMPETITIVE.md MUST-4). Same file,
   *  same transaction scope, so FORGET ME can erase a career atomically. */
  readonly competitive: CompetitiveStore;

  constructor(db: Database.Database) {
    this.db = db;
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    // schema_version 2 adds the competitive tables. The bump is informational:
    // every CREATE is IF NOT EXISTS, so an existing volume upgrades in place
    // with no downtime and no data movement.
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
    this.competitive = new CompetitiveStore(db);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')").run();
  }

  touchAccount(id: string, name: string, now: number): void {
    this.db.prepare(
      `INSERT INTO accounts (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
    ).run(id, name, now, now);
  }

  getParty(code: string): StoredParty | null {
    const row = this.db.prepare("SELECT mode, run_kind, floor FROM parties WHERE code = ?").get(code) as
      | { mode: string; run_kind: string; floor: number }
      | undefined;
    return row ? { mode: row.mode, runKind: row.run_kind, floor: row.floor } : null;
  }

  upsertParty(code: string, mode: string, runKind: string, floor: number, now: number): void {
    const expires = now + (EXPIRY_MS[runKind] ?? EXPIRY_MS.race);
    this.db.prepare(
      `INSERT INTO parties (code, mode, run_kind, floor, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET floor = excluded.floor, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    ).run(code, mode, runKind, floor, now, now, expires);
  }

  getMember(code: string, accountId: string): StoredMember | null {
    const row = this.db.prepare(
      "SELECT player_id, save_json FROM party_members WHERE party_code = ? AND account_id = ?",
    ).get(code, accountId) as { player_id: number; save_json: string } | undefined;
    return row ? { playerId: row.player_id, saveJson: row.save_json } : null;
  }

  /** Every account's seat in a party — the join handler keeps other members'
   *  (possibly offline) characters off-limits to drop-in strangers. */
  memberSeats(code: string): { accountId: string; playerId: number }[] {
    const rows = this.db.prepare(
      "SELECT account_id, player_id FROM party_members WHERE party_code = ?",
    ).all(code) as { account_id: string; player_id: number }[];
    return rows.map((r) => ({ accountId: r.account_id, playerId: r.player_id }));
  }

  /** THE STARTING GUN's restart honesty: has any member of this party saved
   *  progress past floor 1? False = the race never really started (or only
   *  ever stood at the gate), so a regenerated instance may hold it again.
   *  True = mid-race restart; re-firing a gun into floor 7 would be absurd. */
  partyUnderway(code: string): boolean {
    const rows = this.db.prepare(
      "SELECT save_json FROM party_members WHERE party_code = ?",
    ).all(code) as { save_json: string }[];
    for (const r of rows) {
      try {
        const save = JSON.parse(r.save_json) as { floor?: number; player?: { level?: number } };
        // Depth is the clean signal; level covers rivals states whose classic
        // floor slot lags the racers' personal floors.
        if ((save.floor ?? 1) > 1 || (save.player?.level ?? 1) > 2) return true;
      } catch {
        // Unreadable save: treat as underway — never re-gate what we can't read.
        return true;
      }
    }
    return false;
  }

  upsertMember(code: string, accountId: string, playerId: number, saveJson: string, now: number): void {
    this.db.prepare(
      `INSERT INTO party_members (party_code, account_id, player_id, save_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(party_code, account_id) DO UPDATE SET player_id = excluded.player_id,
         save_json = excluded.save_json, updated_at = excluded.updated_at`,
    ).run(code, accountId, playerId, saveJson, now);
  }

  /** Every tip this account has ever been shown, on any character. */
  getTips(accountId: string): string[] {
    const rows = this.db.prepare("SELECT tip_id FROM account_tips WHERE account_id = ?")
      .all(accountId) as { tip_id: string }[];
    return rows.map((r) => r.tip_id);
  }

  /** Remember tips as seen forever (idempotent — the ledger only grows). */
  recordTips(accountId: string, tipIds: string[], now: number): void {
    if (!tipIds.length) return;
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO account_tips (account_id, tip_id, seen_at) VALUES (?, ?, ?)",
    );
    for (const id of tipIds) ins.run(accountId, id, now);
  }

  getSnapshot(code: string): { version: number; snapshot: string } | null {
    const row = this.db.prepare(
      "SELECT version, snapshot FROM instance_snapshots WHERE party_code = ?",
    ).get(code) as { version: number; snapshot: string } | undefined;
    return row ?? null;
  }

  saveSnapshot(code: string, version: number, snapshot: string, now: number): void {
    this.db.prepare(
      `INSERT INTO instance_snapshots (party_code, version, snapshot, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(party_code) DO UPDATE SET version = excluded.version,
         snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
    ).run(code, version, snapshot, now);
  }

  /** The run ended (won/wiped): forget the campaign so the next join under
   *  this code starts a fresh dungeon instead of resuming a finished one. */
  clearParty(code: string): void {
    this.db.prepare("DELETE FROM party_members WHERE party_code = ?").run(code);
    this.db.prepare("DELETE FROM instance_snapshots WHERE party_code = ?").run(code);
    this.db.prepare("DELETE FROM parties WHERE code = ?").run(code);
  }

  /** Append a usage/balance event (see SCHEMA note). Payload is plain data. */
  logEvent(kind: string, partyCode: string, accountId: string | null, data: unknown, now: number): void {
    this.db.prepare(
      "INSERT INTO usage_events (ts, kind, party_code, account_id, data) VALUES (?, ?, ?, ?, ?)",
    ).run(now, kind, partyCode, accountId, JSON.stringify(data));
  }

  /** Read usage events (newest first) — analysis scripts and tests. */
  listEvents(kind?: string, limit = 100): { ts: number; kind: string; partyCode: string; accountId: string | null; data: unknown }[] {
    const rows = (kind
      ? this.db.prepare("SELECT ts, kind, party_code, account_id, data FROM usage_events WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
      : this.db.prepare("SELECT ts, kind, party_code, account_id, data FROM usage_events ORDER BY id DESC LIMIT ?").all(limit)
    ) as { ts: number; kind: string; party_code: string; account_id: string | null; data: string }[];
    return rows.map((r) => ({ ts: r.ts, kind: r.kind, partyCode: r.party_code, accountId: r.account_id, data: JSON.parse(r.data) }));
  }

  // ---- OAuth identities + career stats (release infra) ----

  /** The account a provider identity recovers, if it was ever linked. */
  findIdentity(provider: string, providerId: string): string | null {
    const row = this.db.prepare(
      "SELECT account_id FROM account_identities WHERE provider = ? AND provider_id = ?",
    ).get(provider, providerId) as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  linkIdentity(provider: string, providerId: string, accountId: string, display: string, now: number): void {
    this.db.prepare(
      `INSERT INTO account_identities (provider, provider_id, account_id, display, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_id) DO UPDATE SET display = excluded.display`,
    ).run(provider, providerId, accountId, display, now);
    this.db.prepare(
      `INSERT INTO accounts (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(accountId, display, now, now);
  }

  identitiesOf(accountId: string): { provider: string; display: string | null }[] {
    return (this.db.prepare(
      "SELECT provider, display FROM account_identities WHERE account_id = ?",
    ).all(accountId) as { provider: string; display: string | null }[]);
  }

  bumpAccountStats(
    accountId: string,
    run: { won: boolean; floor: number; kills: number; timeSec: number },
    now: number,
  ): void {
    this.db.prepare(
      `INSERT INTO account_stats (account_id, runs, wins, deepest, kills, time_sec, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         runs = runs + 1,
         wins = wins + excluded.wins,
         deepest = MAX(deepest, excluded.deepest),
         kills = kills + excluded.kills,
         time_sec = time_sec + excluded.time_sec,
         updated_at = excluded.updated_at`,
    ).run(accountId, run.won ? 1 : 0, run.floor, run.kills, run.timeSec, now);
  }

  getAccountStats(accountId: string): { runs: number; wins: number; deepest: number; kills: number; timeSec: number } | null {
    const row = this.db.prepare(
      "SELECT runs, wins, deepest, kills, time_sec FROM account_stats WHERE account_id = ?",
    ).get(accountId) as { runs: number; wins: number; deepest: number; kills: number; time_sec: number } | undefined;
    return row ? { runs: row.runs, wins: row.wins, deepest: row.deepest, kills: row.kills, timeSec: row.time_sec } : null;
  }

  /**
   * Right-to-be-forgotten: the account and EVERYTHING hanging off it.
   *
   * The old version stopped at identities, stats, party seats and the account
   * row - it never reached the leaderboard, so a deleted account name stayed
   * on a public board forever. That was a live privacy gap, not a future one,
   * and it is why board rows had to move onto account ids first. One
   * transaction, so a crash mid-delete cannot leave half a career behind.
   */
  deleteAccount(accountId: string, alsoNames: readonly string[] = []): void {
    // Captured BEFORE the transaction: competitive.deleteAccount is about to
    // remove the only record of what this account was ever called, and the
    // retired JSON boards can only be purged by name.
    //
    // `alsoNames` is the crawler name the CLIENT knows. The legacy rows predate
    // accounts entirely, so for an account with no sealed run there is no link
    // in the database at all - the browser holding the name is the only thing
    // that can point at those rows, and refusing to accept it would mean
    // telling someone their name is unreachable.
    const names = [...new Set([...this.competitive.displayNamesOf(accountId), ...alsoNames])];
    this.db.transaction(() => {
      this.competitive.deleteAccount(accountId);
      this.db.prepare("DELETE FROM account_identities WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM account_stats WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM account_tips WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM party_members WHERE account_id = ?").run(accountId);
      // Telemetry is ANONYMIZED rather than deleted: usage_events is the
      // balance record (never swept), and the only personal thing in it is
      // the account id. Nulling it keeps the balance history and removes the
      // person from it, which is what the request actually asks for.
      this.db.prepare("UPDATE usage_events SET account_id = NULL WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    })();
    // ...and out to anything that lives outside SQLite. The JSON board is a
    // separate file with a separate save cycle, so it cannot ride the
    // transaction; it can only be told, and it must be told.
    try { this.onAccountDeleted?.(accountId, names); } catch { /* never block a deletion */ }
  }

  /** Set by the game server so FORGET ME cascades past SQLite into the retired
   *  leaderboard.json (COMPETITIVE.md 1.2). */
  onAccountDeleted: ((accountId: string, names: string[]) => void) | null = null;

  /** False once close() has run — writes after that would throw. */
  isOpen(): boolean {
    return this.db.open;
  }

  /** A checkpoint is one transaction: the party row plus every member's save. */
  checkpoint(fn: () => void): void {
    this.db.transaction(fn)();
  }

  /** Drop expired parties and everything hanging off them. Run at boot; tables
   *  stay tiny at this scale, so no index on expires_at is needed. */
  sweepExpired(now: number): void {
    this.db.prepare(
      "DELETE FROM party_members WHERE party_code IN (SELECT code FROM parties WHERE expires_at < ?)",
    ).run(now);
    this.db.prepare(
      "DELETE FROM instance_snapshots WHERE party_code IN (SELECT code FROM parties WHERE expires_at < ?)",
    ).run(now);
    this.db.prepare("DELETE FROM parties WHERE expires_at < ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the persistence DB. Returns null — with a loud log — if the
 * native module or the file is unusable, so a packaging surprise degrades to
 * "no persistence" instead of taking the game server down.
 */
export function openDb(file: string): PersistDb | null {
  try {
    const require_ = createRequire(import.meta.url);
    const Sqlite = require_("better-sqlite3") as typeof Database;
    return new PersistDb(new Sqlite(file));
  } catch (err) {
    console.error(`PERSISTENCE DISABLED: could not open ${file}:`, err);
    return null;
  }
}
