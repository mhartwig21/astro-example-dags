import type Database from "better-sqlite3";

// THE CRAWL LEDGER (NICHE.md 4.3): losing banks something. The median run is
// a death on floors 4-8 and it used to yield nothing durable. Every run now
// deposits into an ACCOUNT-level, server-side ledger. Three deposits, ZERO
// power (§5 bans unlock-gated power — the ledger pays identity, never stats):
//
//   1. SYSTEM CONTRACTS — three short account-level objectives, rerolled on
//      completion, completable by dead runs. Rewards: TITLES. Flavor, never
//      stats.
//   2. MASTERY STAMPS — first-time-ever accomplishments per ability and per
//      glyph: the 16x25 build space becomes a visible collection filling in.
//   3. A FORGIVING STREAK — consecutive days with >=1 daily RUN (not clear).
//      One missed day shielded per week. Nothing lost that one evening can't
//      restore, and a lapse is never announced (no dark-pattern pressure).
//
// Pure checks against the run summary the server already has — no sim
// changes, exactly as the doc prices it.

/** The slice of a run summary the ledger reads. Both ingestion paths (solo
 *  POST /telemetry and the party run_end edge) normalize into this. */
export interface LedgerRun {
  won: boolean;
  floor: number;
  /** Daily day (YYYY-MM-DD) when the run was a daily; null otherwise. */
  day: string | null;
  kills: number;
  level: number;
  damageTaken: number;
  gold: number;
  /** Ability ids fielded (slots + ultimate, nulls dropped). */
  abilities: string[];
  /** Glyph ids socketed at run end. */
  glyphs: string[];
}

export interface ContractDef {
  id: string;
  name: string;
  desc: string;
  /** The title the completion pays. Identity, never stats. */
  title: string;
  target: number;
  /** Progress this run adds (0 = none). Completable by dead runs BY DESIGN —
   *  a contract only a winner can touch would miss the median player. */
  gain: (r: LedgerRun) => number;
}

/** The authored pool. Order matters: rerolls walk it deterministically. */
export const CONTRACT_POOL: ContractDef[] = [
  { id: "sewers_tourist", name: "SEE THE SEWERS", title: "TOURIST",
    desc: "Reach floor 4 — THE SEWERS — in any run. Dying there counts. Obviously.",
    target: 1, gain: (r) => (r.floor >= 4 ? 1 : 0) },
  { id: "body_count_40", name: "MAKE IT INTERESTING", title: "THE ENTERTAINER",
    desc: "Bank 40 kills in a single run. The System counts. The System always counts.",
    target: 1, gain: (r) => (r.kills >= 40 ? 1 : 0) },
  { id: "daily_pilgrim", name: "THE PILGRIMAGE", title: "REGULAR",
    desc: "Run the daily three times. Winning is not mentioned in this paperwork.",
    target: 3, gain: (r) => (r.day ? 1 : 0) },
  { id: "garden_party", name: "CRASH THE GARDEN", title: "UNINVITED GUEST",
    desc: "Reach floor 7 — THE GARDEN. The topiary is expecting you.",
    target: 1, gain: (r) => (r.floor >= 7 ? 1 : 0) },
  { id: "tank_bill", name: "EAT THE BILL", title: "THE SPONGE",
    desc: "Absorb 500 damage in one run and still reach floor 5. Health is a budget.",
    target: 1, gain: (r) => (r.damageTaken >= 500 && r.floor >= 5 ? 1 : 0) },
  { id: "glyph_dressed", name: "DRESS FOR THE OCCASION", title: "ACCESSORIZED",
    desc: "Finish a run with three or more glyphs socketed. Dead is a way to finish.",
    target: 1, gain: (r) => (r.glyphs.length >= 3 ? 1 : 0) },
  { id: "deep_deaths", name: "DIE WITH AMBITION", title: "REPEAT OFFENDER",
    desc: "Die on floor 6 or deeper, twice. The System admires consistency of error.",
    target: 2, gain: (r) => (!r.won && r.floor >= 6 ? 1 : 0) },
  { id: "level_nine", name: "GROW UP FAST", title: "THE PROSPECT",
    desc: "End any run at level 9 or higher. The exit interview notes your potential.",
    target: 1, gain: (r) => (r.level >= 9 ? 1 : 0) },
  { id: "gold_hoard", name: "DIE RICH", title: "THE ESTATE",
    desc: "End a run holding 250 gold. It goes to the dungeon. It always goes to the dungeon.",
    target: 1, gain: (r) => (r.gold >= 250 ? 1 : 0) },
  { id: "kills_150", name: "THE LONG CULL", title: "EXTERMINATOR",
    desc: "150 kills, across as many runs as it takes.",
    target: 150, gain: (r) => Math.max(0, Math.min(r.kills, 1000)) },
];

const SLOTS = 3;
const STREAK_MILESTONES = [3, 7, 14, 30];

/** Day string -> whole days since epoch (UTC). Strings are validated at the
 *  wire; a malformed one returns NaN and the streak simply doesn't move. */
function dayIndex(day: string): number {
  return Math.floor(Date.parse(day + "T00:00:00Z") / 86400000);
}

/** ISO-week key for the streak shield ("one missed day shielded per WEEK"). */
function weekKey(day: string): string {
  return String(Math.floor((dayIndex(day) + 4) / 7)); // epoch was a Thursday
}

export interface LedgerView {
  contracts: { id: string; name: string; desc: string; title: string; progress: number; target: number }[];
  stamps: string[]; // "ability:<id>" | "glyph:<id>"
  titles: string[];
  streak: { count: number; best: number; shieldAvailable: boolean; lastDay: string | null };
}

export class LedgerStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec(`
CREATE TABLE IF NOT EXISTS ledger_contracts (
  account_id  TEXT NOT NULL,
  slot        INTEGER NOT NULL,
  contract_id TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, slot)
);
CREATE TABLE IF NOT EXISTS ledger_stamps (
  account_id TEXT NOT NULL,
  stamp_id   TEXT NOT NULL,
  earned_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, stamp_id)
);
CREATE TABLE IF NOT EXISTS ledger_streak (
  account_id  TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  best        INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT,
  shield_week TEXT,
  updated_at  INTEGER NOT NULL
);`);
  }

  /** Every stamp (mastery + titles) this account holds. */
  private stampSet(accountId: string): Set<string> {
    const rows = this.db.prepare("SELECT stamp_id FROM ledger_stamps WHERE account_id = ?")
      .all(accountId) as { stamp_id: string }[];
    return new Set(rows.map((r) => r.stamp_id));
  }

  private addStamp(accountId: string, id: string, now: number): boolean {
    const r = this.db.prepare(
      "INSERT OR IGNORE INTO ledger_stamps (account_id, stamp_id, earned_at) VALUES (?, ?, ?)",
    ).run(accountId, id, now);
    return r.changes > 0;
  }

  /** The three active contracts, assigning fresh ones into empty slots.
   *  Assignment walks the authored pool in order, skipping contracts that are
   *  active in another slot or already completed (their title stamp exists). */
  private activeContracts(accountId: string, now: number): { slot: number; def: ContractDef; progress: number }[] {
    const rows = this.db.prepare(
      "SELECT slot, contract_id, progress FROM ledger_contracts WHERE account_id = ? ORDER BY slot",
    ).all(accountId) as { slot: number; contract_id: string; progress: number }[];
    const done = this.stampSet(accountId);
    const active = new Map<number, { def: ContractDef; progress: number }>();
    for (const r of rows) {
      const def = CONTRACT_POOL.find((c) => c.id === r.contract_id);
      if (def) active.set(r.slot, { def, progress: r.progress });
    }
    for (let slot = 0; slot < SLOTS; slot++) {
      if (active.has(slot)) continue;
      const taken = new Set([...active.values()].map((a) => a.def.id));
      const next = CONTRACT_POOL.find((c) => !taken.has(c.id) && !done.has("title:" + c.id));
      if (!next) continue; // pool exhausted: the System is drafting new paperwork
      this.db.prepare(
        `INSERT INTO ledger_contracts (account_id, slot, contract_id, progress, assigned_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(account_id, slot) DO UPDATE SET contract_id = excluded.contract_id,
           progress = 0, assigned_at = excluded.assigned_at`,
      ).run(accountId, slot, next.id, now);
      active.set(slot, { def: next, progress: 0 });
    }
    return [...active.entries()].map(([slot, a]) => ({ slot, ...a })).sort((a, b) => a.slot - b.slot);
  }

  /**
   * Deposit one finished run. Returns the System-voiced lines the player
   * should hear — empty when nothing moved (silence is honest; the ledger
   * never manufactures a deposit).
   */
  applyRun(accountId: string, run: LedgerRun, now: number): string[] {
    const lines: string[] = [];

    // 1. CONTRACTS — progress, complete, pay the title, reroll.
    for (const { slot, def, progress } of this.activeContracts(accountId, now)) {
      const gain = def.gain(run);
      if (gain <= 0) continue;
      const next = Math.min(def.target, progress + gain);
      if (next >= def.target) {
        this.db.prepare("DELETE FROM ledger_contracts WHERE account_id = ? AND slot = ?")
          .run(accountId, slot);
        this.addStamp(accountId, "title:" + def.id, now);
        lines.push(`LEDGER: CONTRACT COMPLETE — ${def.name}. Title earned: ${def.title}. New paperwork is already posted.`);
      } else {
        this.db.prepare(
          "UPDATE ledger_contracts SET progress = ? WHERE account_id = ? AND slot = ?",
        ).run(next, accountId, slot);
        lines.push(`LEDGER: ${def.name} — ${next}/${def.target}.`);
      }
    }
    // Refill any slot the completions above emptied.
    this.activeContracts(accountId, now);

    // 2. MASTERY STAMPS — first-time-ever per ability and glyph.
    let newStamps = 0;
    let lastStamp = "";
    for (const a of run.abilities) {
      if (this.addStamp(accountId, "ability:" + a, now)) { newStamps++; lastStamp = a.toUpperCase(); }
    }
    for (const g of run.glyphs) {
      if (this.addStamp(accountId, "glyph:" + g, now)) { newStamps++; lastStamp = g.toUpperCase(); }
    }
    if (newStamps === 1) lines.push(`LEDGER: MASTERY STAMP — ${lastStamp}. First time fielded; the collection notices.`);
    else if (newStamps > 1) lines.push(`LEDGER: ${newStamps} NEW MASTERY STAMPS. The collection grows.`);

    // 3. THE STREAK — daily runs only; a run counts, a clear is not required.
    if (run.day && Number.isFinite(dayIndex(run.day))) {
      const row = this.db.prepare(
        "SELECT count, best, last_day, shield_week FROM ledger_streak WHERE account_id = ?",
      ).get(accountId) as { count: number; best: number; last_day: string | null; shield_week: string | null } | undefined;
      const prevDay = row?.last_day ?? null;
      const gap = prevDay ? dayIndex(run.day) - dayIndex(prevDay) : Infinity;
      let count = row?.count ?? 0;
      let shieldWeek = row?.shield_week ?? null;
      let moved = false;
      if (gap === 0) {
        // Same day again: the streak already has today.
      } else if (gap === 1) {
        count += 1; moved = true;
      } else if (gap === 2 && shieldWeek !== weekKey(run.day)) {
        // THE SHIELD: one missed day per week is forgiven, silently spent.
        count += 1; shieldWeek = weekKey(run.day); moved = true;
        lines.push("LEDGER: the System pretends yesterday didn't happen. Shield spent; streak intact.");
      } else if (gap > 1) {
        count = 1; moved = true; // a fresh start is a deposit, not a scolding
      }
      const best = Math.max(row?.best ?? 0, count);
      this.db.prepare(
        `INSERT INTO ledger_streak (account_id, count, best, last_day, shield_week, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET count = excluded.count, best = excluded.best,
           last_day = excluded.last_day, shield_week = excluded.shield_week, updated_at = excluded.updated_at`,
      ).run(accountId, count, best, run.day, shieldWeek, now);
      if (moved && count > 1) lines.push(`LEDGER: DAILY STREAK ${count}.`);
      if (moved && STREAK_MILESTONES.includes(count)) {
        this.addStamp(accountId, `title:streak_${count}`, now);
        lines.push(`LEDGER: STREAK MILESTONE — ${count} days. Title earned: ${count}-DAY REGULAR.`);
      }
    }

    return lines;
  }

  /** Everything the L-panel renders. */
  view(accountId: string, now: number): LedgerView {
    const contracts = this.activeContracts(accountId, now).map(({ def, progress }) => ({
      id: def.id, name: def.name, desc: def.desc, title: def.title,
      progress, target: def.target,
    }));
    const all = [...this.stampSet(accountId)];
    const row = this.db.prepare(
      "SELECT count, best, last_day, shield_week FROM ledger_streak WHERE account_id = ?",
    ).get(accountId) as { count: number; best: number; last_day: string | null; shield_week: string | null } | undefined;
    const titles = all.filter((s) => s.startsWith("title:")).map((s) => {
      const id = s.slice(6);
      if (id.startsWith("streak_")) return `${id.slice(7)}-DAY REGULAR`;
      return CONTRACT_POOL.find((c) => c.id === id)?.title ?? id.toUpperCase();
    });
    return {
      contracts,
      stamps: all.filter((s) => !s.startsWith("title:")),
      titles,
      streak: {
        count: row?.count ?? 0,
        best: row?.best ?? 0,
        lastDay: row?.last_day ?? null,
        // The shield is available while this week hasn't spent it.
        shieldAvailable: !row?.shield_week || row.shield_week !== weekKey(new Date(now).toISOString().slice(0, 10)),
      },
    };
  }

  /** FORGET ME cascade (right-to-be-forgotten). */
  deleteAccount(accountId: string): void {
    this.db.prepare("DELETE FROM ledger_contracts WHERE account_id = ?").run(accountId);
    this.db.prepare("DELETE FROM ledger_stamps WHERE account_id = ?").run(accountId);
    this.db.prepare("DELETE FROM ledger_streak WHERE account_id = ?").run(accountId);
  }
}

/** Normalize either ingestion path's player summary into a LedgerRun. */
export function ledgerRunFrom(data: {
  status?: unknown; floor?: unknown; day?: unknown;
  player?: { kills?: unknown; level?: unknown; damageTaken?: unknown; gold?: unknown;
    slots?: unknown; ultimate?: unknown; glyphs?: unknown } | null;
}): LedgerRun | null {
  const p = data.player;
  if (!p) return null;
  const num = (v: unknown, cap: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(cap, n)) : 0;
  };
  const strs = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 32).slice(0, max) : [];
  const day = typeof data.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.day) ? data.day : null;
  return {
    won: data.status === "won",
    floor: num(data.floor, 99),
    day,
    kills: num(p.kills, 100000),
    level: num(p.level, 99),
    damageTaken: num(p.damageTaken, 1e7),
    gold: num(p.gold, 1e7),
    abilities: strs(p.slots, 8).concat(typeof p.ultimate === "string" ? [p.ultimate] : []),
    glyphs: strs(p.glyphs, 16),
  };
}
