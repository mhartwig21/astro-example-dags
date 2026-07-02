// Seeded, deterministic PRNG (mulberry32). No Math.random anywhere in the sim —
// the RNG state is threaded through game state so runs are fully reproducible.

export interface Rng {
  state: number;
}

export function createRng(seed: number): Rng {
  // Force to a 32-bit unsigned integer.
  return { state: seed >>> 0 };
}

/** Advance the RNG and return a float in [0, 1). Mutates `rng`. */
export function nextFloat(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, max] inclusive. */
export function nextInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(nextFloat(rng) * (max - min + 1));
}

/** Random element of a non-empty array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[nextInt(rng, 0, arr.length - 1)];
}

/** True with probability p. */
export function chance(rng: Rng, p: number): boolean {
  return nextFloat(rng) < p;
}
