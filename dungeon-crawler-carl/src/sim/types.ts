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
  level: number;
  xp: number;
  xpToNext: number;
  gold: number;
  alive: boolean;
  // transient render flag: seconds remaining to show an attack swing
  attackSwing: number;
}

export interface Monster {
  id: number;
  pos: Vec2;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  attackCooldown: number;
  xp: number;
  // transient render flag: seconds remaining to show a hit flash
  hitFlash: number;
}

export type LootKind = "gold" | "heal" | "weapon";

export interface Loot {
  id: number;
  pos: Vec2;
  kind: LootKind;
  amount: number; // gold value, heal amount, or bonus damage
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
}

export const NO_INTENT: Intent = {
  move: { x: 0, y: 0 },
  attack: false,
  useStairs: false,
};
