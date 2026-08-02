import type { BossId, GameState, Item, Player } from "../sim/types";
import { toRoamSave, type RoamSaveState } from "../sim/npc";

// Log on/off seam. In single-player we persist the whole run to localStorage so a
// page refresh resumes the character mid-dungeon. In multiplayer this same shape
// (seed + floor + character progression + equipment) is what the server would
// store per account and reload on login to rejoin the party's instance.

const KEY = "dcc:save:v1";
const TIPS_KEY = "dcc:tips:v1";
const BOSS_KEY = "dcc:bosses:v1";

// ---------------------------------------------------------------------------
// BOSSES V2 §4.1/§4.4 — THE CROSS-RUN BOSS MEMORY (acceptance r5, blocker).
//
// The sim has always READ `save.bosses` (restoreGame) and MAINTAINED
// `state.bossLineup` / `state.bossDefeats` (applyBossDraw / reapDead), and no
// host had ever written either one back. `grep -rn '\.bosses\s*=' src/`
// returned zero hits, so two of the four variety layers — Layer 1's anti-repeat
// rule (`pickBandBoss`'s `prevId`) and Layer 4's 2nd/5th-meeting escalation —
// were inert code. With a fresh seed per run the draw is uniform 1-in-3 per
// band: a player replaying floor 3 sees the same boss back-to-back one run in
// three, which is the exact case the anti-repeat rule exists to kill and the
// owner's stated problem ("the same boss appearing every run is the enemy").
//
// It is a BROWSER-LEVEL ledger, exactly like the first-contact tips above and
// for the same reason: the run save dies with the run, and "which boss did the
// LAST run serve" has to outlive it. It is tiny (six band slots + eighteen
// counters), it is a read-only input to a PURE draw, and a browser with no
// ledger gets precisely the shipped seeded lineup.
// ---------------------------------------------------------------------------

export interface BossMemory {
  lastLineup?: Record<string, BossId>;
  defeats?: Record<string, number>;
}

/** What this browser remembers about bosses across runs. */
export function bossMemory(): BossMemory {
  try {
    const raw = localStorage.getItem(BOSS_KEY);
    if (!raw) return {};
    const m = JSON.parse(raw) as BossMemory;
    return {
      lastLineup: m.lastLineup && typeof m.lastLineup === "object" ? m.lastLineup : undefined,
      defeats: m.defeats && typeof m.defeats === "object" ? m.defeats : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Hand the memory to a freshly created run, BEFORE its first boss floor is
 * built. `restoreGame` already does this for a resumed run from the save's own
 * copy; this is the other half — a NEW run, which is the only case the
 * anti-repeat rule was ever about.
 */
export function seedBossMemory(state: GameState): void {
  const m = bossMemory();
  if (m.lastLineup) state.bossPrevLineup = { ...m.lastLineup };
  if (m.defeats) state.bossDefeats = { ...m.defeats };
}

/**
 * Fold this run's lineup and defeat counts back into the ledger. Merged, never
 * replaced: a run that reached floor 3 and stopped must not erase what the
 * previous run learned about floor 18.
 */
export function recordBossMemory(state: GameState): void {
  try {
    const prev = bossMemory();
    const lastLineup = { ...(prev.lastLineup ?? {}), ...(state.bossLineup ?? {}) };
    const defeats = { ...(prev.defeats ?? {}), ...(state.bossDefeats ?? {}) };
    if (Object.keys(lastLineup).length === 0 && Object.keys(defeats).length === 0) return;
    localStorage.setItem(BOSS_KEY, JSON.stringify({ lastLineup, defeats }));
  } catch {
    // Best-effort, like the run save.
  }
}

// First-contact tips (tips.ts) are once-EVER, not once-per-run: this browser-
// level ledger outlives individual saves (a new run mints a fresh character,
// and the run save dies with the run). Hosts seed it into new characters via
// seedTips and it grows on every saveRun; the multiplayer client sends it on
// join so the server's account-level ledger and this one converge.

/** Tip ids this browser has ever been shown (across all runs and characters). */
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
  // BOSSES V2 §4 — the cross-run memory, round-tripped so a RESUMED run keeps
  // the anti-repeat lineup and the defeat counts it was drawn against. The
  // browser ledger above is what carries it between runs; this is what carries
  // it across a page refresh mid-run.
  bosses?: BossMemory;
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
      // The run save persists the draw's INPUTS (bossPrevLineup), never its
      // outputs: `restoreGame` regenerates the floor from (seed, floor), so
      // handing a resume this run's OWN lineup as "last run's" would step the
      // anti-repeat rule off it and rebuild the floor around a different boss.
      // The browser ledger below is where the outputs go.
      bosses: {
        lastLineup: state.bossPrevLineup ? { ...state.bossPrevLineup } : undefined,
        defeats: state.bossDefeats ? { ...state.bossDefeats } : undefined,
      },
  };
}

export function saveRun(state: GameState, mode?: RunMode): void {
  try {
    // Single-player persistence: the local player's progression (players[0]).
    const data = toSaveData(state, state.players[0], mode);
    localStorage.setItem(KEY, JSON.stringify(data));
    recordTips(data.player.tipsSeen); // the once-ever ledger outlives this save
    recordBossMemory(state); // ...and so does the boss lineup (§4.1 anti-repeat)
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
