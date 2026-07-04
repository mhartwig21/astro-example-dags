import { nextFloat, type Rng } from "./rng";
import type { Vec2 } from "./types";

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(v: Vec2): Vec2 {
  const m = Math.hypot(v.x, v.y);
  if (m === 0) return { x: 0, y: 0 };
  return { x: v.x / m, y: v.y / m };
}

/** Signed angle between two vectors, in radians [0, PI]. */
export function angleBetween(a: Vec2, b: Vec2): number {
  const am = Math.hypot(a.x, a.y);
  const bm = Math.hypot(b.x, b.y);
  if (am === 0 || bm === 0) return Math.PI;
  const dot = (a.x * b.x + a.y * b.y) / (am * bm);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** Default hit variance (monsters, and players with bare hands). */
export const DEFAULT_VARIANCE = 0.15;

/** Low/high bounds of a damage roll — the truth the character sheet prints. */
export function rollBounds(base: number, variance = DEFAULT_VARIANCE): { min: number; max: number } {
  return {
    min: Math.max(1, Math.round(base * (1 - variance))),
    max: Math.max(1, Math.round(base * (1 + variance))),
  };
}

/**
 * Roll damage with ± `variance` from the seeded RNG. Player hits pass their
 * weapon class's variance (see damageVariance in abilities.ts) — a maul is a
 * gamble per swing, a blade is a metronome. Monsters roll the default.
 */
export function rollDamage(rng: Rng, base: number, variance = DEFAULT_VARIANCE): number {
  const mult = 1 - variance + nextFloat(rng) * 2 * variance;
  return Math.max(1, Math.round(base * mult));
}

/**
 * Armor mitigation: reduction = armor / (armor + armorK), capped. Diminishing
 * returns by construction — every point helps, no point makes you immortal.
 * Pure so the character sheet can print the exact same estimate combat uses.
 */
export function armorReduction(armor: number, armorK: number, cap: number): number {
  if (armor <= 0) return 0;
  return Math.min(cap, armor / (armor + armorK));
}

/** Apply armor to an incoming hit (post-roll). A landed hit never drops below 1. */
export function mitigate(raw: number, reduction: number): number {
  return Math.max(1, Math.round(raw * (1 - reduction)));
}
