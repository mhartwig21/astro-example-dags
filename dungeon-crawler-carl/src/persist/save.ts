import type { GameState, Item, Player } from "../sim/types";
import { toRoamSave, type RoamSaveState } from "../sim/npc";

// Log on/off seam. In single-player we persist the whole run to localStorage so a
// page refresh resumes the character mid-dungeon. In multiplayer this same shape
// (seed + floor + character progression + equipment) is what the server would
// store per account and reload on login to rejoin the party's instance.

const KEY = "dcc:save:v1";
const TIPS_KEY = "dcc:tips:v1";

// First-contact tips (tips.ts) are once-EVER, not once-per-run: this browser-
// level ledger outlives individual saves (a new run mints a fresh character,
// and the run save dies with the run). Hosts seed it into new characters via
// seedTips; the multiplayer client sends it on join so the server's
// account-level ledger and this one converge.
//
// WHO WRITES IT (r4 blocker 1). Only PRESENTATION does — the host calls
// recordTips when a card actually paints (or when the player declines the
// teaching outright). saveRun used to mirror `player.tipsSeen` here on every
// save, which spent tips the sim had merely GENERATED: display is a paced,
// modal-aware queue, so `favorites` and `achievementClaim` were measured being
// consumed, permanently ledgered, and never once shown. A once-EVER ledger
// that records unseen lines does not teach a concept, it deletes it.

/** Tip ids whose CARD this browser has actually painted. */

export function knownTips(): string[] {
  try {
    const raw = localStorage.getItem(TIPS_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Remember tips as seen forever (union — the ledger only grows). */
export function recordTips(ids: string[] | undefined): void {
  if (!ids?.length) return;
  try {
    const merged = new Set(knownTips());
    const before = merged.size;
    for (const id of ids) merged.add(id);
    if (merged.size > before) localStorage.setItem(TIPS_KEY, JSON.stringify([...merged]));
  } catch {
    // Best-effort, like the run save.
  }
}

/** Mark every previously-seen tip as already delivered to this character. */
export function seedTips(p: Player): void {
  const merged = new Set([...(p.tipsSeen ?? []), ...knownTips()]);
  if (merged.size) p.tipsSeen = [...merged];
}

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
  // BACKLOG #11: which run this is. Absent on pre-Roam saves — the codebase's
  // optional-field + load-time-default convention; restoreGame defaults to
  // "race", so old saves resume exactly as before.
  runKind?: GameState["runKind"];
  // Roam campaigns: quest progress, consumed vendor stock, smashed hoards
  // (#25) — overlaid onto the deterministically rebuilt floor on CONTINUE.
  roam?: RoamSaveState;
  // Character progression only — the floor itself is regenerated from seed + floor,
  // so we never persist transient monster/loot/timer state. Effective stats
  // (maxHp/baseDamage/…) are recomputed from level + bonuses + equipment on load.
  player: {
    name?: string; // chosen at the check-in menu; pre-menu saves default to "Carl"
    skin?: string; // chosen campfire look (CRAWLER_SKINS); absent = seeded fallback
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
    unclaimedAchievements?: string[]; // achievement loot boxes not yet opened
    goldSpent?: number;
    kills?: number;
    damageDealt?: number;
    damageTaken?: number;
    materials?: Player["materials"];
    revisions?: string[]; // CLASS REVISIONS taken (optional: pre-revision saves)
    tipsSeen?: string[]; // first-contact tips delivered (optional: pre-tips saves)
    glyphs?: Player["glyphs"]; // glyph sockets + bench (optional: pre-glyph saves)
  };
  show: { hype: number; viewers: number; favorites: number; sponsors: number };
  status: GameState["status"];
}

/**
 * Build the persisted shape for one player. Pure (no DOM) — shared by the
 * localStorage save below and the server's per-account SQLite saves, which is
 * exactly the dual use the comment at the top of this file promised.
 */
export function toSaveData(state: GameState, p: Player, mode?: RunMode): SaveData {
  return {
      seed: state.seed,
      floor: state.floor,
      mode,
      runKind: state.runKind,
      roam: state.runKind === "roam" ? toRoamSave(state) : undefined,
      player: {
        name: p.name,
        skin: p.skin,
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
        unclaimedAchievements: p.unclaimedAchievements,
        goldSpent: p.goldSpent,
        kills: p.kills,
        damageDealt: p.damageDealt,
        damageTaken: p.damageTaken,
        materials: p.materials,
        revisions: p.revisions,
        tipsSeen: p.tipsSeen,
        glyphs: p.glyphs,
      },
      show: {
        hype: p.hype,
        viewers: p.viewers,
        favorites: p.favorites,
        sponsors: p.sponsors,
      },
      status: state.status,
  };
}

export function saveRun(state: GameState, mode?: RunMode): void {
  try {
    // Single-player persistence: the local player's progression (players[0]).
    const data = toSaveData(state, state.players[0], mode);
    // The run save carries the sim's latch, MINUS anything the player has not
    // actually been shown (r4 blocker 1). A refresh mid-run would otherwise
    // resume a character who is "done" with a rule nobody ever explained — the
    // same permanent silence, one layer down. Unshown ids drop, the sim
    // regenerates them on the resumed run, and the card gets another chance.
    const shown = new Set(knownTips());
    const seen = data.player.tipsSeen?.filter((id) => shown.has(id));
    localStorage.setItem(KEY, JSON.stringify({ ...data, player: { ...data.player, tipsSeen: seen } }));
    // NO recordTips here. Presentation owns the once-EVER ledger.
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
