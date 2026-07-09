import { createRequire } from "node:module";
import type Database from "better-sqlite3";

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
-- P2 (hibernate/restore) writes this; created now so the schema is complete.
CREATE TABLE IF NOT EXISTS instance_snapshots (
  party_code TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class PersistDb {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
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

  upsertMember(code: string, accountId: string, playerId: number, saveJson: string, now: number): void {
    this.db.prepare(
      `INSERT INTO party_members (party_code, account_id, player_id, save_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(party_code, account_id) DO UPDATE SET player_id = excluded.player_id,
         save_json = excluded.save_json, updated_at = excluded.updated_at`,
    ).run(code, accountId, playerId, saveJson, now);
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
