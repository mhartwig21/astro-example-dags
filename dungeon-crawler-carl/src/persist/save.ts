import type { GameState } from "../sim/types";

// Log on/off seam. In single-player we persist the whole run to localStorage so a
// page refresh resumes the character mid-dungeon. In multiplayer this same shape
// (seed + floor + character progression) is what the server would store per account
// and reload on login to rejoin the party's instance.

const KEY = "dcc:save:v1";

export interface SaveData {
  seed: number;
  floor: number;
  // Character progression only — the floor itself is regenerated from seed + floor,
  // so we never persist transient monster/loot/timer state.
  player: {
    hp: number;
    maxHp: number;
    baseDamage: number;
    level: number;
    xp: number;
    xpToNext: number;
    gold: number;
  };
  status: GameState["status"];
}

export function saveRun(state: GameState): void {
  try {
    const p = state.player;
    const data: SaveData = {
      seed: state.seed,
      floor: state.floor,
      player: {
        hp: p.hp,
        maxHp: p.maxHp,
        baseDamage: p.baseDamage,
        level: p.level,
        xp: p.xp,
        xpToNext: p.xpToNext,
        gold: p.gold,
      },
      status: state.status,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Persistence is best-effort in the slice; ignore quota/availability errors.
  }
}

export function loadRun(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (typeof data.seed !== "number" || typeof data.floor !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

export function clearRun(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
