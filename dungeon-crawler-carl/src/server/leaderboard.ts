import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { isValidDay } from "../sim/daily";

// Daily Crawl leaderboard. One board per UTC day; entries come from solo daily
// runs (the client submits on win/wipe). Storage is a single JSON file so the
// one always-on Fly machine keeps boards across restarts — a redeploy replaces
// the disk, which for a daily board is an acceptable v1 (DEPLOY.md notes the
// Postgres upgrade path alongside accounts).
//
// Trust model: solo runs execute client-side, so submissions are self-reported.
// We validate shape hard (this is an internet-facing endpoint) but accept the
// numbers — the board is bragging rights among crawlers, not an economy.

export interface LbEntry {
  name: string;
  floor: number; // deepest floor reached (18 + won = full clear)
  won: boolean;
  timeSec: number; // run time; tiebreak among winners (faster is better)
  kills: number;
  at: number; // server receipt time (ms)
}

export const MAX_ENTRIES_PER_DAY = 200;
export const MAX_DAYS_KEPT = 30;
const MAX_TIME_SEC = 6 * 3600; // longer than any real run
const MAX_KILLS = 100_000;

// All-time category boards (launch polish: overall leaderboards). Every
// finished run may submit; each keeps one best entry per crawler name.
export const ALLTIME_CATS = ["deepest", "fastest", "kills", "contracts"] as const;
export type AlltimeCat = (typeof ALLTIME_CATS)[number];
export const MAX_ALLTIME_ENTRIES = 200;

/** Per-category "is a better than b". fastest only ranks full clears. */
function catBetter(cat: AlltimeCat, a: LbEntry, b: LbEntry): boolean {
  switch (cat) {
    case "deepest": return better(a, b);
    case "fastest": return a.timeSec < b.timeSec;
    case "kills": return a.kills > b.kills;
    case "contracts": return a.timeSec < b.timeSec; // fastest RIVALS win
  }
}

/** Category gate: what counts as an entry at all. */
function catAccepts(cat: AlltimeCat, e: LbEntry): boolean {
  if (cat === "fastest" || cat === "contracts") return e.won && e.timeSec > 0;
  return true;
}

/** Higher is better: full clears first, then depth, then speed. */
function better(a: LbEntry, b: LbEntry): boolean {
  if (a.won !== b.won) return a.won;
  if (a.floor !== b.floor) return a.floor > b.floor;
  if (a.won && a.timeSec !== b.timeSec) return a.timeSec < b.timeSec;
  return a.kills > b.kills;
}

export function rankEntries(entries: LbEntry[]): LbEntry[] {
  return [...entries].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : a.at - b.at));
}

export class Leaderboard {
  private days = new Map<string, LbEntry[]>();
  private alltime = new Map<AlltimeCat, LbEntry[]>();
  private file: string | null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(file?: string) {
    this.file = file ?? null;
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
        // v2 wraps {days, alltime}; a v1 file was a flat day -> entries map.
        const days = (raw.days ?? raw) as Record<string, LbEntry[]>;
        for (const [day, entries] of Object.entries(days)) {
          if (isValidDay(day) && Array.isArray(entries)) this.days.set(day, entries);
        }
        const at = (raw.alltime ?? {}) as Record<string, LbEntry[]>;
        for (const cat of ALLTIME_CATS) {
          if (Array.isArray(at[cat])) this.alltime.set(cat, at[cat]);
        }
      } catch {
        // Corrupt file: start clean rather than crash the game server.
      }
    }
  }

  get(day: string): LbEntry[] {
    return rankEntries(this.days.get(day) ?? []);
  }

  /**
   * Validate + record a run. Keeps each crawler's BEST entry per day (retrying
   * the daily all day is playing the game, not cheating). Returns the 1-based
   * rank of the crawler's entry on the day's board, or null if rejected.
   */
  submit(day: string, raw: unknown, nowMs: number): number | null {
    if (!isValidDay(day)) return null;
    // Accept "today" with slack for timezones/midnight rollovers, nothing older.
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || Math.abs(nowMs - dayMs) > 2 * 86400_000) return null;

    const o = (raw ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim().slice(0, 24);
    const floor = Math.floor(Number(o.floor));
    const timeSec = Number(o.timeSec);
    const kills = Math.floor(Number(o.kills));
    if (!name) return null;
    if (!Number.isInteger(floor) || floor < 1 || floor > 18) return null;
    if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > MAX_TIME_SEC) return null;
    if (!Number.isInteger(kills) || kills < 0 || kills > MAX_KILLS) return null;
    const entry: LbEntry = { name, floor, won: o.won === true, timeSec: Math.round(timeSec), kills, at: nowMs };

    const entries = this.days.get(day) ?? [];
    const mine = entries.findIndex((e) => e.name === name);
    if (mine >= 0) {
      if (better(entry, entries[mine])) entries[mine] = entry; // improved
    } else {
      if (entries.length >= MAX_ENTRIES_PER_DAY) {
        // Board full: only enter by beating the current worst.
        const ranked = rankEntries(entries);
        const worst = ranked[ranked.length - 1];
        if (!better(entry, worst)) return null;
        entries.splice(entries.indexOf(worst), 1);
      }
      entries.push(entry);
    }
    this.days.set(day, entries);
    this.prune();
    this.scheduleSave();
    const rank = rankEntries(entries).findIndex((e) => e.name === name);
    return rank + 1;
  }

  getAlltime(cat: AlltimeCat): LbEntry[] {
    const entries = this.alltime.get(cat) ?? [];
    return [...entries].sort((a, b) =>
      catBetter(cat, a, b) ? -1 : catBetter(cat, b, a) ? 1 : a.at - b.at);
  }

  /**
   * Record a finished run on every all-time board it qualifies for. One best
   * entry per crawler name per category. Returns the categories where this
   * run now sits in the top 10 (the client turns those into headlines).
   */
  submitAlltime(raw: unknown, nowMs: number, contracts = false): AlltimeCat[] {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim().slice(0, 24);
    const floor = Math.floor(Number(o.floor));
    const timeSec = Number(o.timeSec);
    const kills = Math.floor(Number(o.kills));
    if (!name) return [];
    if (!Number.isInteger(floor) || floor < 1 || floor > 18) return [];
    if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > MAX_TIME_SEC) return [];
    if (!Number.isInteger(kills) || kills < 0 || kills > MAX_KILLS) return [];
    const entry: LbEntry = { name, floor, won: o.won === true, timeSec: Math.round(timeSec), kills, at: nowMs };

    const headlines: AlltimeCat[] = [];
    const cats: AlltimeCat[] = contracts ? ["contracts"] : ["deepest", "fastest", "kills"];
    for (const cat of cats) {
      if (!catAccepts(cat, entry)) continue;
      const entries = this.alltime.get(cat) ?? [];
      const mine = entries.findIndex((e) => e.name === name);
      if (mine >= 0) {
        if (!catBetter(cat, entry, entries[mine])) continue;
        entries[mine] = entry;
      } else if (entries.length >= MAX_ALLTIME_ENTRIES) {
        const ranked = this.getAlltime(cat);
        const worst = ranked[ranked.length - 1];
        if (!catBetter(cat, entry, worst)) continue;
        entries.splice(entries.indexOf(worst), 1);
        entries.push(entry);
      } else {
        entries.push(entry);
      }
      this.alltime.set(cat, entries);
      if (this.getAlltime(cat).findIndex((e) => e.name === name) < 10) headlines.push(cat);
    }
    if (headlines.length > 0 || cats.some((c) => this.alltime.has(c))) this.scheduleSave();
    return headlines;
  }

  private prune(): void {
    if (this.days.size <= MAX_DAYS_KEPT) return;
    const days = [...this.days.keys()].sort(); // ISO dates sort chronologically
    while (days.length > MAX_DAYS_KEPT) this.days.delete(days.shift()!);
  }

  /** v2 file shape: {days, alltime}. The loader still reads v1 flat files. */
  private serialize(): string {
    const days: Record<string, LbEntry[]> = {};
    for (const [day, entries] of this.days) days[day] = entries;
    const alltime: Record<string, LbEntry[]> = {};
    for (const [cat, entries] of this.alltime) alltime[cat] = entries;
    return JSON.stringify({ days, alltime });
  }

  /** Debounced, atomic-ish (tmp + rename), best-effort. */
  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, this.serialize());
        renameSync(tmp, this.file!);
      } catch {
        // Disk trouble must never take down the game.
      }
    }, 1000);
    this.saveTimer.unref?.();
  }

  /** Flush now (tests / shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file) return;
    try {
      writeFileSync(this.file, this.serialize());
    } catch {
      /* best-effort */
    }
  }
}
