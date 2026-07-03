// Tileable fractal value noise shared by both fog-of-war looks: the 2D canvas
// host bakes it into a repeating pattern, the 3D host uploads it as a texture
// and scrolls it in a shader. Pure math — no DOM, no three.js — so either host
// (or a test) can call it. Deliberately NOT the sim RNG: fog is cosmetic and
// must never touch deterministic game state.

/** Tiny local PRNG (same shape as render3d's cosmeticRng, kept dependency-free). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * size×size fractal value noise in [0,1], seamless on both axes (every octave's
 * lattice wraps), so it can repeat as a pattern/texture without visible seams.
 */
export function tileableFogNoise(size: number, seed: number): Float32Array {
  const rnd = prng(seed);
  const acc = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  // Octaves from big billows (4 cells across) down to fine wisps (32 cells).
  for (let cells = 4; cells <= 32; cells *= 2) {
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy) % cells;
      const y1 = (y0 + 1) % cells;
      const fy = smooth(gy - Math.floor(gy));
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx) % cells;
        const x1 = (x0 + 1) % cells;
        const fx = smooth(gx - Math.floor(gx));
        const a = lattice[y0 * cells + x0];
        const b = lattice[y0 * cells + x1];
        const c = lattice[y1 * cells + x0];
        const d = lattice[y1 * cells + x1];
        acc[y * size + x] += (a + (b - a) * fx + (c - a + (a - b + d - c) * fx) * fy) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= total;
  return acc;
}
