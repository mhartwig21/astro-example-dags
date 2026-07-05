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
  private file: string | null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(file?: string) {
    this.file = file ?? null;
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, LbEntry[]>;
        for (const [day, entries] of Object.entries(raw)) {
          if (isValidDay(day) && Array.isArray(entries)) this.days.set(day, entries);
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

  private prune(): void {
    if (this.days.size <= MAX_DAYS_KEPT) return;
    const days = [...this.days.keys()].sort(); // ISO dates sort chronologically
    while (days.length > MAX_DAYS_KEPT) this.days.delete(days.shift()!);
  }

  /** Debounced, atomic-ish (tmp + rename), best-effort. */
  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const out: Record<string, LbEntry[]> = {};
        for (const [day, entries] of this.days) out[day] = entries;
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(out));
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
      const out: Record<string, LbEntry[]> = {};
      for (const [day, entries] of this.days) out[day] = entries;
      writeFileSync(this.file, JSON.stringify(out));
    } catch {
      /* best-effort */
    }
  }
}
