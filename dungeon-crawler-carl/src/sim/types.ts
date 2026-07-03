import type { Rng } from "./rng";
import type { AbilityId, UpgradeOffer } from "./abilities";

export interface Vec2 {
  x: number;
  y: number;
}

export enum Tile {
  Wall = 0,
  Floor = 1,
  StairsDown = 2,
  DoorLocked = 3, // sealed door; not walkable until the floor key is picked up
}

export type TimerPhase = "safe" | "warning" | "collapse";

export interface Player {
  id: number; // stable per party member; 0 is the solo/first player
  name: string; // shown in announcer lines and (later) over the head
  pos: Vec2;
  facing: Vec2; // unit vector of last movement/attack direction
  hp: number;
  maxHp: number;
  speed: number;
  baseDamage: number;
  // Unified per-ability cooldowns (seconds remaining), keyed by AbilityId —
  // scales to any number of abilities without new fields.
  cd: Partial<Record<AbilityId, number>>;
  dashTime: number; // seconds of active dash remaining (i-frames + speed)
  novaFlash: number; // transient render flag: seconds remaining of nova ring effect
  orbitAngle: number; // current rotation of the orbit blades (radians)
  orbitTick: number; // seconds until the orbit blades' next damage tick
  // The Five (DESIGN.md 5.7): 4 active slots + 1 ultimate + a bench of known-
  // but-unslotted abilities, plus rank taken per upgrade node.
  abilities: {
    slots: (AbilityId | null)[]; // length 4
    ultimate: AbilityId | null;
    bench: AbilityId[];
    ranks: Record<string, number>;
  };
  critChance: number; // effective crit chance (base + equipment)
  level: number;
  xp: number;
  xpToNext: number;
  gold: number;
  weaponRarity: Rarity; // rarity of the currently-equipped weapon (for HUD/flavor)
  // Itemization. Effective baseDamage/maxHp/speed/critChance are recomputed as
  // intrinsic(level) + permanent bonuses + equipped affixes (see recomputeStats).
  equipment: { weapon: Item | null; armor: Item | null; trinket: Item | null };
  inventory: Item[];
  bonusDamage: number; // permanent buffs (loot boxes / sponsor rewards), outside equipment
  bonusMaxHp: number;
  bonusCrit: number; // permanent crit-chance buff
  alive: boolean;
  // transient render flag: seconds remaining to show an attack swing
  attackSwing: number;

  // Personal, non-blocking offers: the world keeps running while these pend.
  pendingUpgrades: UpgradeOffer[]; // level-up ability draft awaiting this player's pick
  upgradeDraftsOwed: number; // queued drafts from multiple level-ups
  pendingRewards: Reward[]; // sponsor draft awaiting this player's pick

  // Per-player achievement progress + flags its checks read.
  achievements: string[];
  goldSpent: number; // cumulative shop spending this run
  kills: number; // cumulative kill credit (killing blows) this run
  killsThisStep: number; // transient: kills credited to this player this step
  lowHpKill: boolean; // transient: killed something while below 10% HP

  // Cumulative combat stats for this run.
  damageDealt: number;
  damageTaken: number;

  // The Show, PER CRAWLER: everyone runs their own broadcast. Your crits and
  // kills grow YOUR audience; your near-death moments are your ratings gold.
  hype: number; // excitement meter (decays)
  viewers: number; // live audience count
  favorites: number; // sticky fans
  sponsors: number; // backers earned at favorite thresholds
}

// Enemy archetypes. Each spawns with distinct stats + behavior (see ai.ts / config.ts).
export type MonsterKind =
  | "grunt" | "swarmer" | "brute" | "ranged" | "boss"
  | "bomber" | "shaman" | "phantom";

export interface Monster {
  id: number;
  kind: MonsterKind;
  pos: Vec2;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  attackRange: number; // contact range (melee) or preferred standoff (ranged)
  attackCooldown: number; // melee swing / ranged shot cooldown remaining
  shootCd: number; // secondary timer: boss radial volley
  healCd: number; // shaman: seconds until it can heal a wounded ally again
  blinkCd: number; // phantom: seconds until its next blink toward a player
  xp: number;
  // transient render flag: seconds remaining to show a hit flash
  hitFlash: number;
  lastHitBy?: number; // player id credited with the killing blow (loot boxes)
  elite?: boolean; // neighborhood boss: beefed-up named archetype with loot
  eliteName?: string; // announcer name for elites and city bosses
  exploded?: boolean; // bomber: detonation already fired (prevents a double blast)
  hasKey?: boolean; // carries the key to the locked stairs district (drops it on death)
}

export type LootKind = "gold" | "heal" | "item" | "tome" | "key";
export type Rarity = "common" | "magic" | "rare" | "epic";
export type ItemSlot = "weapon" | "armor" | "trinket";

// Stat modifiers granted by an equipped item. All optional; summed across equipment.
export interface Affixes {
  damage?: number;
  maxHp?: number;
  speed?: number; // tiles/sec
  crit?: number; // added crit chance (0..1)
}

export interface Item {
  id: number;
  slot: ItemSlot;
  rarity: Rarity;
  name: string;
  affixes: Affixes;
}

export interface Loot {
  id: number;
  pos: Vec2;
  kind: LootKind;
  amount: number; // gold value or heal amount
  item?: Item; // present when kind === "item"
  rarity?: Rarity; // convenience for render tint (mirrors item.rarity)
  ability?: AbilityId; // present when kind === "tome": the ability it teaches
}

// Safe-room shop: gold sinks offered between floors (see generateSafeRoom in game.ts).
export type ShopKind = "heal" | "item" | "maxHp" | "time" | "tome" | "mystery";

export interface ShopItem {
  id: number;
  kind: ShopKind;
  title: string;
  desc: string;
  price: number;
  item?: Item; // present when kind === "item"
  ability?: AbilityId; // present when kind === "tome"
  sold: boolean;
}

// The between-floors safe room. While non-null, the sim is paused: shop, then
// leaveSafeRoom() drops the crawler onto `nextFloor`.
export interface SafeRoom {
  nextFloor: number;
  stock: ShopItem[];
  tip: string; // Mordecai-style manager advice about the next floor
  bonusTime?: number; // purchased stabilizer seconds, applied when the floor builds
  ready: number[]; // player ids who hit DESCEND; the party leaves when all are ready
}

// Sponsor draft: a reward offered between floors. `apply` semantics live in game.ts.
export type RewardKind =
  | "healFull" | "maxHp" | "damage" | "crit" | "item" | "gold" | "bonusTime";

export interface Reward {
  id: number;
  kind: RewardKind;
  title: string;
  desc: string;
  amount: number;
  item?: Item; // present when kind === "item"
}

// Projectiles: player bolts and enemy shots share one system.
export interface Projectile {
  id: number;
  pos: Vec2;
  vel: Vec2; // tiles/sec
  damage: number;
  ttl: number; // seconds before it despawns
  from: "player" | "enemy";
  ownerId?: number; // firing player's id (crit rolls + kill credit)
  pierce?: number; // remaining enemies this projectile can pass through (player bolts)
  hitIds?: number[]; // monsters already struck (so a piercing bolt hits each once)
}

/** Axis-aligned room rectangle in tile coordinates (interior tiles only). */
export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Room intent tags (mission-lite): every room means something. The sim uses
// them for spawn pacing and rewards; the renderer for rule-based dressing.
export type RoomRole =
  | "entrance" // spawn room: safe, no monsters
  | "stairs" // exit room (sealed by doors on deep floors)
  | "landmark" // the floor's big set-piece hall: pillars, the neighborhood boss
  | "vault" // off-path treasure detour: guaranteed loot + a guardian
  | "combat"; // everything else

export interface FloorMap {
  w: number;
  h: number;
  tiles: Uint8Array; // row-major, length w*h, values from Tile
  spawn: Vec2; // player entry point
  stairs: Vec2; // stairs-down location
  rooms: RoomRect[]; // generated room rectangles (rooms[0] contains the spawn)
  roles: RoomRole[]; // intent tag per room (parallel to rooms)
  depths: number[]; // 0..1 progress along the critical path per room (pacing)
  cycles: number; // extra loop corridors carved beyond the spanning chain
  locked: boolean; // the stairs room is sealed behind DoorLocked tiles
  lockedRoomIdx: number; // index into rooms of the sealed stairs room; -1 when unlocked
}

export type RunStatus = "playing" | "dead" | "won";

// A scheduled ultimate impact (Sponsor Airstrike shells in flight).
export interface Strike {
  pos: Vec2;
  t: number; // seconds until impact
  ownerId: number; // caster (kill credit)
}

// Transient combat/feedback events emitted during a single step. Hosts turn these
// into floating damage numbers, particles, camera shake, and announcer lines. They
// are derived deterministically from the sim (the RNG that rolls a crit is the same
// seeded stream), so replays reproduce them exactly.
export type HitKind = "enemy" | "crit" | "player" | "heal" | "gold" | "weapon";

export interface HitEvent {
  pos: Vec2;
  amount: number;
  kind: HitKind;
}

export interface GameState {
  rng: Rng;
  seed: number;
  floor: number; // 1-indexed current floor
  map: FloorMap;
  // Fog of war: 1 = explored, row-major like map.tiles. Reset per floor.
  // Shared by the party; revealed around every living player.
  explored: Uint8Array;
  exploredVersion: number; // bumped whenever new tiles are revealed (render diffing)
  // Bumped whenever the tile grid itself changes (floor build, doors unlocking) so
  // renderers that cache floor geometry know to rebuild.
  mapVersion: number;
  // The party (1-6). Solo play is a party of one; players[0] is the local player
  // in the browser hosts. Order is stable and intents are applied in id order so
  // the RNG stream stays reproducible.
  players: Player[];
  monsters: Monster[];
  loot: Loot[];
  projectiles: Projectile[];
  nextEntityId: number;

  // Collapse timer
  timeBudget: number; // total seconds allotted for this floor
  timeRemaining: number; // seconds left; can go negative once collapsing
  phase: TimerPhase;
  collapseElapsed: number; // seconds spent in the collapse phase

  status: RunStatus;
  // Event messages produced during the last step (consumed by host for the log/HUD).
  events: string[];
  // Announcer lines in the DCC "System" game-show voice (a curated subset of drama).
  announcements: string[];
  // Combat/feedback events for this step (floating numbers, particles, shake).
  hits: HitEvent[];
  killCount: number; // monsters killed this run (drives loot-box milestones)
  lootBoxes: number; // loot boxes awarded this run

  // Ultimate side-state: scheduled airstrike impacts + bullet-time remaining.
  strikes: Strike[];
  bulletTimeLeft: number;

  // Safe room between floors (null while crawling). The whole instance is "between
  // floors" while non-null: the sim idles until every player readies up.
  safeRoom: SafeRoom | null;

  // Party-level per-step flags (per-player progress lives on Player).
  killsThisStep: number; // transient: party kills reaped this step (combo hype)
  escapedCollapse: boolean; // transient: descended while the floor was collapsing

  elapsed: number; // total seconds elapsed this run (for stats/display)
}

/** Intent produced by a host (client input, script, or agent) for one sim step. */
export interface Intent {
  move: Vec2; // desired movement direction (need not be normalized); zero = stand still
  attack?: boolean; // legacy: cast the slot holding melee (see cast below)
  aim?: Vec2; // optional aim direction for the attack (falls back to facing)
  useStairs: boolean; // attempt to descend if standing on stairs
  // Slot casts: indices 0-3 = the four ability slots, 4 = the ultimate slot.
  cast?: boolean[];
  // Legacy convenience flags (tests/bots): each maps to "cast the slot currently
  // holding that ability" — a no-op if it isn't slotted.
  dash?: boolean;
  bolt?: boolean;
  nova?: boolean;
}

export const NO_INTENT: Intent = {
  move: { x: 0, y: 0 },
  useStairs: false,
};

/** Per-player intents for one step, keyed by player id. Missing ids = NO_INTENT. */
export type PartyIntents = Record<number, Intent>;
