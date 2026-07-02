import type { Rng } from "./rng";

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
  bonusDamage: number; // permanent buffs (e.g. loot boxes), outside equipment
  bonusMaxHp: number;
  alive: boolean;
  // transient render flag: seconds remaining to show an attack swing
  attackSwing: number;
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
}

export type LootKind = "gold" | "heal" | "item";
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
}

// Projectiles: player bolts and enemy shots share one system.
export interface Projectile {
  id: number;
  pos: Vec2;
  vel: Vec2; // tiles/sec
  damage: number;
  ttl: number; // seconds before it despawns
  from: "player" | "enemy";
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
  player: Player;
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
}

export const NO_INTENT: Intent = {
  move: { x: 0, y: 0 },
  attack: false,
  useStairs: false,
  dash: false,
  bolt: false,
};
