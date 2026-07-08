import type { GameState, Item, Player } from "../sim/types";

// Log on/off seam. In single-player we persist the whole run to localStorage so a
// page refresh resumes the character mid-dungeon. In multiplayer this same shape
// (seed + floor + character progression + equipment) is what the server would
// store per account and reload on login to rejoin the party's instance.

const KEY = "dcc:save:v1";

/** How this run was seeded. Daily runs remember their day so a resumed run
 *  still submits to the right board when it ends. */
export interface RunMode {
  kind: "random" | "daily";
  day?: string; // YYYY-MM-DD (daily only)
}

export interface SaveData {
  seed: number;
  floor: number;
  mode?: RunMode; // absent on pre-menu saves: treated as a random run
  // Character progression only — the floor itself is regenerated from seed + floor,
  // so we never persist transient monster/loot/timer state. Effective stats
  // (maxHp/baseDamage/…) are recomputed from level + bonuses + equipment on load.
  player: {
    name?: string; // chosen at the check-in menu; pre-menu saves default to "Carl"
    hp: number;
    level: number;
    xp: number;
    xpToNext: number;
    gold: number;
    bonusDamage: number;
    bonusSpell?: number; // optional: pre-schools saves default to 0 on load
    bonusMaxHp: number;
    bonusCrit: number;
    bonusArmor?: number; // optional: pre-armor saves default to 0 on load
    equipment: Player["equipment"];
    inventory: Item[];
    abilities?: Player["abilities"];
    achievements?: string[];
    goldSpent?: number;
    kills?: number;
    damageDealt?: number;
    damageTaken?: number;
    materials?: Player["materials"];
    revisions?: string[]; // CLASS REVISIONS taken (optional: pre-revision saves)
  };
  show: { hype: number; viewers: number; favorites: number; sponsors: number };
  status: GameState["status"];
}

export function saveRun(state: GameState, mode?: RunMode): void {
  try {
    // Single-player persistence: the local player's progression (players[0]).
    const p = state.players[0];
    const data: SaveData = {
      seed: state.seed,
      floor: state.floor,
      mode,
      player: {
        name: p.name,
        hp: p.hp,
        level: p.level,
        xp: p.xp,
        xpToNext: p.xpToNext,
        gold: p.gold,
        bonusDamage: p.bonusDamage,
        bonusSpell: p.bonusSpell,
        bonusMaxHp: p.bonusMaxHp,
        bonusCrit: p.bonusCrit,
        bonusArmor: p.bonusArmor,
        equipment: p.equipment,
        inventory: p.inventory,
        abilities: p.abilities,
        achievements: p.achievements,
        goldSpent: p.goldSpent,
        kills: p.kills,
        damageDealt: p.damageDealt,
        damageTaken: p.damageTaken,
        materials: p.materials,
        revisions: p.revisions,
      },
      show: {
        hype: p.hype,
        viewers: p.viewers,
        favorites: p.favorites,
        sponsors: p.sponsors,
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
