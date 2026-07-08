import type { GameState } from "../sim/types";
import type { RunMode } from "./save";

// Career ledger: a compact record of every FINISHED local run (win or wipe),
// kept in localStorage next to the save. This is the browser-local slice of
// meta-progression — personal bests + recent seasons — until accounts land
// and the server keeps the canonical copy.

const KEY = "dcc:history:v1";
const MAX_RUNS = 60; // newest first; older seasons scroll off the ledger

export interface RunRecord {
  endedAt: number; // wall-clock ms when the run ended
  mode: RunMode["kind"];
  day?: string; // daily runs remember which board they played
  name: string;
  won: boolean;
  floor: number; // deepest floor reached
  timeSec: number;
  level: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  gold: number; // banked at the end
  viewers: number;
  favorites: number;
  sponsors: number;
  seed: number;
}

export function loadHistory(): RunRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RunRecord[];
    return Array.isArray(list) ? list.filter((r) => typeof r?.floor === "number") : [];
  } catch {
    return [];
  }
}

/** Record a finished run (host calls this once on the status edge). */
export function recordRun(state: GameState, mode: RunMode, endedAt: number): void {
  try {
    const p = state.players[0];
    const rec: RunRecord = {
      endedAt,
      mode: mode.kind,
      day: mode.day,
      name: p.name,
      won: state.status === "won",
      floor: state.floor,
      timeSec: Math.round(state.elapsed),
      level: p.level,
      kills: p.kills,
      damageDealt: Math.round(p.damageDealt),
      damageTaken: Math.round(p.damageTaken),
      gold: p.gold,
      viewers: Math.round(p.viewers),
      favorites: Math.floor(p.favorites),
      sponsors: p.sponsors,
      seed: state.seed,
    };
    const list = [rec, ...loadHistory()].slice(0, MAX_RUNS);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // The ledger is a bonus, never a blocker.
  }
}

export interface CareerBests {
  runs: number;
  wins: number;
  bestFloor: number;
  fastestClearSec: number | null; // among wins only
  mostKills: number;
  peakViewers: number;
}

/** Pure aggregation — the menu's CAREER panel reads this. */
export function careerBests(history: RunRecord[]): CareerBests | null {
  if (history.length === 0) return null;
  const wins = history.filter((r) => r.won);
  return {
    runs: history.length,
    wins: wins.length,
    bestFloor: Math.max(...history.map((r) => r.floor)),
    fastestClearSec: wins.length ? Math.min(...wins.map((r) => r.timeSec)) : null,
    mostKills: Math.max(...history.map((r) => r.kills)),
    peakViewers: Math.max(...history.map((r) => r.viewers)),
  };
}
