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
  attackCooldown: number; // seconds remaining until next attack allowed
  dashCd: number; // dash skill cooldown remaining
  dashTime: number; // seconds of active dash remaining (i-frames + speed)
  boltCd: number; // ranged-bolt skill cooldown remaining
  novaCd: number; // nova skill cooldown remaining (only used once learned)
  novaFlash: number; // transient render flag: seconds remaining of nova ring effect
  orbitAngle: number; // current rotation of the orbit blades (radians)
  orbitTick: number; // seconds until the orbit blades' next damage tick
  // Ability tree: which abilities are learned + rank taken per upgrade node.
  abilities: { known: AbilityId[]; ranks: Record<string, number> };
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
}

// Enemy archetypes. Each spawns with distinct stats + behavior (see ai.ts / config.ts).
export type MonsterKind = "grunt" | "swarmer" | "brute" | "ranged" | "boss";

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
  xp: number;
  // transient render flag: seconds remaining to show a hit flash
  hitFlash: number;
  lastHitBy?: number; // player id credited with the killing blow (loot boxes)
}

export type LootKind = "gold" | "heal" | "item" | "tome";
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

export interface FloorMap {
  w: number;
  h: number;
  tiles: Uint8Array; // row-major, length w*h, values from Tile
  spawn: Vec2; // player entry point
  stairs: Vec2; // stairs-down location
}

export type RunStatus = "playing" | "dead" | "won";

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

  // The Show — audience economy.
  hype: number; // excitement meter (decays); drives viewers
  viewers: number; // live audience count
  favorites: number; // sticky fans (a slice of viewers convert on hype)
  sponsors: number; // backers earned at favorite thresholds
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
  attack: boolean; // attempt a melee attack this step
  aim?: Vec2; // optional aim direction for the attack (falls back to facing)
  useStairs: boolean; // attempt to descend if standing on stairs
  dash?: boolean; // dash skill (blink in facing direction, brief i-frames)
  bolt?: boolean; // ranged-bolt skill (fire a projectile in facing/aim direction)
  nova?: boolean; // nova skill (radial shockwave; requires the ability to be learned)
}

export const NO_INTENT: Intent = {
  move: { x: 0, y: 0 },
  attack: false,
  useStairs: false,
  dash: false,
  bolt: false,
  nova: false,
};

/** Per-player intents for one step, keyed by player id. Missing ids = NO_INTENT. */
export type PartyIntents = Record<number, Intent>;
