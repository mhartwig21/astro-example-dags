import * as THREE from "three";

// BAKED LIGHT + OCCLUSION GRID — the D2R trick, done in 2D at floor build.
//
// Every floor bakes one RGBA texture over the tile grid (LM_RES texels/tile):
//   RGB — accumulated torch/lantern light with REAL 2D shadowing: each texel
//         raymarches the wall grid back to every light in range, so light
//         pools stop at walls instead of washing through them as screen-space
//         ellipses. Per-light hue/intensity/radius jitter keeps a corridor of
//         sconces from reading as a row of identical clipped blobs.
//   A   — a static occlusion/variation multiplier: chamfer-distance AO that
//         darkens floor toward every wall seam (grounding the junction),
//         soft contact shadows stamped under every placed prop/tree/rock,
//         low-frequency macro grime (moisture/tonal drift over ~8-10 tiles so
//         tiling never reads machine-perfect), and per-room stain decals.
//
// The world-lit materials (renderer3d.worldLit) sample this per fragment:
// A multiplies albedo, RGB adds as albedo-scaled emissive gated by fog of
// war and a global gutter-flicker uniform. Purely cosmetic, host-side only.

export const LM_RES = 6; // texels per tile
export const LM_SCALE = 2.5; // shader decode: rgb * LM_SCALE = light intensity
export const LM_AO_SCALE = 1.25; // shader decode: a * LM_AO_SCALE = multiplier

export interface BakeLight {
  x: number;
  y: number; // tile coords (sim x,y = world x,z)
  r: number; // radius in tiles
  color: { r: number; g: number; b: number }; // linear-ish 0..1
  intensity: number; // at the core, in LM units
  jitter?: boolean; // per-light hue/size variance (torches yes, portal no)
}

export interface BakeStamp {
  x: number;
  z: number;
  r: number; // world-unit contact radius
  s?: number; // strength 0..1 (default 0.5)
}

export interface BakeStain {
  x: number;
  z: number;
  r: number;
  s: number; // darkening strength 0..1
}

/** Tiny stateless hash noise, bilinear, 0..1. */
function vnoise(x: number, y: number, seed: number): number {
  const h = (ix: number, iy: number): number => {
    let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) ^ seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function bakeLightGrid(opts: {
  w: number;
  h: number;
  isWall: (x: number, y: number) => boolean;
  lights: BakeLight[];
  stamps: BakeStamp[];
  stains: BakeStain[];
  seed: number;
}): THREE.DataTexture {
  const { w, h, isWall, seed } = opts;
  const W = w * LM_RES;
  const H = h * LM_RES;
  const n = W * H;

  // Tile-res wall mask (hot loop reads this, not the closure).
  const wall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) wall[y * w + x] = isWall(x, y) ? 1 : 0;
  }

  // ---- A channel: chamfer distance-to-wall AO + macro noise + stamps ----
  // Two-pass 3-4 chamfer over texels (walls = 0). Distances in texel units.
  const BIG = 1e5;
  const dist = new Float32Array(n);
  for (let ty = 0; ty < H; ty++) {
    const my = (ty / LM_RES) | 0;
    for (let tx = 0; tx < W; tx++) {
      const mx = (tx / LM_RES) | 0;
      dist[ty * W + tx] = wall[my * w + mx] ? 0 : BIG;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - W] + 3);
        if (x > 0) d = Math.min(d, dist[i - W - 1] + 4);
        if (x < W - 1) d = Math.min(d, dist[i - W + 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = dist[i];
      if (x < W - 1) d = Math.min(d, dist[i + 1] + 3);
      if (y < H - 1) {
        d = Math.min(d, dist[i + W] + 3);
        if (x < W - 1) d = Math.min(d, dist[i + W + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + W - 1] + 4);
      }
      dist[i] = d;
    }
  }

  const ao = new Float32Array(n).fill(1);
  const AO_REACH = LM_RES * 0.95 * 3; // chamfer units (x3): ~1 tile of falloff
  for (let ty = 0; ty < H; ty++) {
    const my = (ty / LM_RES) | 0;
    const wy = (ty + 0.5) / LM_RES;
    for (let tx = 0; tx < W; tx++) {
      const mx = (tx / LM_RES) | 0;
      const i = ty * W + tx;
      const wx = (tx + 0.5) / LM_RES;
      // Macro variation everywhere (walls too): two octaves of value noise at
      // an 8-10 tile wavelength plus a tighter grime octave — tiling drift.
      const macro =
        0.9 +
        0.2 * vnoise(wx * 0.115, wy * 0.115, seed) +
        0.08 * (vnoise(wx * 0.45, wy * 0.45, seed ^ 0x9e37) - 0.5);
      if (wall[my * w + mx]) {
        // Wall texels: the wall shader's own base gradient handles junctions;
        // only the macro drift applies (keeps hilltops/wall tops varied).
        ao[i] = macro;
      } else {
        const t = Math.min(1, dist[i] / AO_REACH);
        const junction = 0.6 + 0.4 * (t * t * (3 - 2 * t));
        ao[i] = junction * macro;
      }
    }
  }
  // Stain decals: irregular dark patches (moisture/soot/old blood), noise-
  // modulated so they read organic instead of airbrushed discs.
  for (const st of opts.stains) {
    const r = Math.max(0.2, st.r);
    const x0 = Math.max(0, Math.floor((st.x - r) * LM_RES));
    const x1 = Math.min(W - 1, Math.ceil((st.x + r) * LM_RES));
    const y0 = Math.max(0, Math.floor((st.z - r) * LM_RES));
    const y1 = Math.min(H - 1, Math.ceil((st.z + r) * LM_RES));
    for (let ty = y0; ty <= y1; ty++) {
      const wy = (ty + 0.5) / LM_RES;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = (tx + 0.5) / LM_RES;
        const d = Math.hypot(wx - st.x, wy - st.z) / r;
        if (d >= 1) continue;
        const shape = (1 - d * d) * (0.45 + 0.9 * vnoise(wx * 1.7, wy * 1.7, seed ^ 0x51ab));
        ao[ty * W + tx] *= 1 - Math.min(0.85, st.s * Math.min(1, shape));
      }
    }
  }
  // Contact shadows under every placed prop/tree/rock: a soft dark disc in
  // the bake — crisper than transparent quads and free at render time.
  for (const sp of opts.stamps) {
    const r = Math.max(0.12, sp.r);
    const s = sp.s ?? 0.5;
    const x0 = Math.max(0, Math.floor((sp.x - r) * LM_RES));
    const x1 = Math.min(W - 1, Math.ceil((sp.x + r) * LM_RES));
    const y0 = Math.max(0, Math.floor((sp.z - r) * LM_RES));
    const y1 = Math.min(H - 1, Math.ceil((sp.z + r) * LM_RES));
    for (let ty = y0; ty <= y1; ty++) {
      const wy = (ty + 0.5) / LM_RES;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = (tx + 0.5) / LM_RES;
        const d = Math.hypot(wx - sp.x, wy - sp.z) / r;
        if (d >= 1) continue;
        const k = 1 - d * d; // parabolic falloff, darkest at the root
        ao[ty * W + tx] *= 1 - s * k * k;
      }
    }
  }

  // ---- RGB: shadowed light accumulation ----
  const acc = new Float32Array(n * 3);
  const lights = opts.lights.slice(0, 48);
  const STEP = 0.3; // ray march step, tiles
  for (let li = 0; li < lights.length; li++) {
    const L = lights[li];
    // Per-light variance: warmer/cooler lean, size and punch jitter.
    let cr = L.color.r;
    let cg = L.color.g;
    let cb = L.color.b;
    let radius = L.r;
    let punch = L.intensity;
    if (L.jitter !== false) {
      const h1 = vnoise(li * 3.7, 0.5, seed ^ 0xbeef);
      const h2 = vnoise(li * 3.7, 7.5, seed ^ 0xbeef);
      const warm = (h1 - 0.5) * 0.24;
      cr = Math.min(1, cr * (1 + warm));
      cb = Math.max(0, cb * (1 - warm * 0.8));
      radius *= 0.85 + 0.3 * h2;
      punch *= 0.82 + 0.36 * h1;
    }
    const x0 = Math.max(0, Math.floor((L.x - radius) * LM_RES));
    const x1 = Math.min(W - 1, Math.ceil((L.x + radius) * LM_RES));
    const y0 = Math.max(0, Math.floor((L.y - radius) * LM_RES));
    const y1 = Math.min(H - 1, Math.ceil((L.y + radius) * LM_RES));
    for (let ty = y0; ty <= y1; ty++) {
      const wy = (ty + 0.5) / LM_RES;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = (tx + 0.5) / LM_RES;
        const dx = wx - L.x;
        const dy = wy - L.y;
        const d = Math.hypot(dx, dy);
        if (d >= radius) continue;
        // LOS march: walls between light and texel block the light. The march
        // skips the first 0.35 tiles (the sconce hugs its wall) and the last
        // 0.45 (so wall FACES still catch the pool in front of them).
        let blocked = false;
        if (d > 0.8) {
          const steps = Math.floor((d - 0.45) / STEP);
          const ux = dx / d;
          const uy = dy / d;
          for (let si = 1; si <= steps; si++) {
            const t = 0.35 + si * STEP;
            if (t >= d - 0.45) break;
            const mx = Math.floor(L.x + ux * t);
            const my = Math.floor(L.y + uy * t);
            if (mx < 0 || my < 0 || mx >= w || my >= h || wall[my * w + mx]) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;
        const f = 1 - d / radius;
        const att = punch * f * f * (0.55 + 0.45 * f); // hot near, long soft tail
        const i3 = (ty * W + tx) * 3;
        acc[i3] += cr * att;
        acc[i3 + 1] += cg * att;
        acc[i3 + 2] += cb * att;
      }
    }
  }

  // ---- Encode ----
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.min(255, Math.round((acc[i * 3] / LM_SCALE) * 255));
    data[i * 4 + 1] = Math.min(255, Math.round((acc[i * 3 + 1] / LM_SCALE) * 255));
    data[i * 4 + 2] = Math.min(255, Math.round((acc[i * 3 + 2] / LM_SCALE) * 255));
    data[i * 4 + 3] = Math.min(255, Math.round((Math.max(0.12, Math.min(LM_AO_SCALE, ao[i])) / LM_AO_SCALE) * 255));
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Neutral 1x1 fallback (no light, AO = 1) for frames before the first bake. */
export function neutralLightGrid(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, Math.round((1 / LM_AO_SCALE) * 255)]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}
