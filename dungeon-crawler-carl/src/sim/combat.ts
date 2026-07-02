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

/**
 * Roll damage with ±15% variance from the seeded RNG. Kept intentionally simple
 * for the slice; the seam is here to grow into weapon/armor mitigation later.
 */
export function rollDamage(rng: Rng, base: number): number {
  const variance = 0.85 + nextFloat(rng) * 0.3; // 0.85 .. 1.15
  return Math.max(1, Math.round(base * variance));
}
