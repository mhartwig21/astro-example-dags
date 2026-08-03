import * as THREE from "three";

// GENERATIVE PBR SURFACE MAPS.
//
// The measured material gap against any AAA reference was blunt: there is no
// normal, roughness, metalness or AO map file anywhere in public/assets, so
// every surface in the game is flat KayKit clay with shading faked on top of
// it. Downloading a PBR set would fight the art direction (KayKit is stylised,
// low-poly, hand-painted) and cost megabytes; BAKING one is both in-style and
// cheap, which is what this module does.
//
// ONE tileable RGBA texture is baked at boot and shared by the entire world —
// floor tiles, wall faces, props, cliffs. It is sampled BIPLANAR in world space
// (see renderer3d.worldLit), so it needs no UVs and works on instanced tiles
// and on glTF meshes alike:
//
//   R,G  tangent-space normal XY, 0..1 (Z is reconstructed in the shader)
//   B    roughness modulation, 0.5 = neutral
//   A    cavity / micro-AO, 1 = open surface, low = down in a crack
//
// The height field it is derived from is three layers with different jobs:
//   · plates    — a cellular (Worley) field whose CELL EDGES are the mortar
//                 courses and stone cracks. This is the layer that reads as
//                 masonry rather than as noise, and it is what carries the
//                 cavity channel.
//   · undulation— low-octave fbm, the broad "this stone is not machined flat"
//                 warp that keeps a long wall from reading as one plane.
//   · grain     — high-octave fbm, the micro-facet that makes torchlight
//                 specular crawl across a surface instead of sitting still.
//
// Determinism: this is host-side cosmetics, not sim, but it is written with an
// explicit integer seed and no Math.random anyway so two machines bake the same
// bytes and a screenshot diff means something.

export const SURFACE_MAP_SIZE = 256;

/** 2D integer hash -> 0..1. */
function hash2(ix: number, iy: number, seed: number): number {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that WRAPS at `period`, so the map tiles. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % period) + period) % period;
  const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tileable fbm: every octave doubles both frequency and lattice period. */
function fbm(x: number, y: number, period: number, seed: number, octaves: number): number {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + o * 7919);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Tileable cellular field. Returns the distance to the nearest jittered site
 * MINUS the distance to the second nearest, normalized — i.e. ~0 exactly on a
 * cell boundary (a crack / mortar seam) and ~1 in the middle of a plate.
 */
function plates(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let d1 = 1e9, d2 = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      // Stone courses, not a random scatter: sites jitter a lot along the
      // course and only a little across it, so plates come out brick-shaped.
      const jx = cx + 0.15 + 0.7 * hash2(wx, wy, seed);
      const jy = cy + 0.32 + 0.36 * hash2(wx, wy, seed ^ 0x5bf03635);
      const dx = jx - x, dy = jy - y;
      const d = dx * dx + dy * dy;
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
  }
  return Math.min(1, Math.sqrt(d2) - Math.sqrt(d1));
}

/** The height field the maps are derived from, in map-normalized coords. */
function height(u: number, v: number): number {
  // Cell-edge cracks. Sharpened so the seam is a narrow dark line, not a
  // smooth gradient — a wide soft seam reads as dirt, a narrow one as mortar.
  const p = plates(u * 6, v * 6, 6, 0x2f1a3d);
  const seam = Math.min(1, p / 0.22);
  const plateTop = seam * seam * (3 - 2 * seam);
  // Per-plate value step: neighbouring stones sit at slightly different depths.
  const step = vnoise(u * 6 + 0.5, v * 6 + 0.5, 6, 0x91ee27);
  const undulation = fbm(u * 3, v * 3, 3, 0x77c1b5, 3);
  const grain = fbm(u * 24, v * 24, 24, 0x1d9f43, 3);
  return 0.50 * plateTop + 0.14 * step + 0.22 * undulation + 0.14 * grain;
}

let cached: THREE.DataTexture | null = null;

/**
 * Bake (once) the shared world surface-detail map. RGBA8, tileable, mipmapped —
 * mips matter here: an unmipped detail normal sampled at the iso camera's
 * grazing angles is a shimmering mess, and the mip chain is also what makes the
 * detail fade out at distance instead of aliasing into noise.
 */
export function surfaceDetailMap(size = SURFACE_MAP_SIZE): THREE.DataTexture {
  if (cached) return cached;
  const px = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  const d = 1.25 * inv; // central-difference step, in normalized units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const h = height(u, v);
      const hx = height(u + d, v) - height(u - d, v);
      const hy = height(u, v + d) - height(u, v - d);
      // Slope -> tangent normal. The 2.6 sets how deep the relief reads; the
      // shader scales it again per surface family, so this is just the shape.
      const nx = -hx * 2.6, ny = -hy * 2.6;
      const len = Math.sqrt(nx * nx + ny * ny + 1);

      // Cavity: how far this texel sits below its LOCAL neighbourhood, which is
      // the crack/mortar network plus the low side of each plate. Multiplying
      // albedo by this is the "baked AO" that stops a flat face from reading as
      // one value under a single torch.
      const local = 0.25 * (height(u + 4 * d, v) + height(u - 4 * d, v) + height(u, v + 4 * d) + height(u, v - 4 * d));
      const cav = Math.max(0, Math.min(1, 0.72 + 1.5 * (h - local)));

      // Roughness modulation: cracks and grain are rough, the worn crowns of
      // plates polish smooth. 0.5 encodes "leave the material's own value".
      const rough = Math.max(0, Math.min(1, 0.5 + 0.42 * (0.55 - h) + 0.18 * (1 - cav)));

      const i = (y * size + x) * 4;
      px[i] = Math.round(255 * (nx / len * 0.5 + 0.5));
      px[i + 1] = Math.round(255 * (ny / len * 0.5 + 0.5));
      px[i + 2] = Math.round(255 * rough);
      px[i + 3] = Math.round(255 * cav);
    }
  }

  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1; // grazing-angle sharpness is not worth the fetch on an iGPU
  tex.colorSpace = THREE.NoColorSpace; // data, not colour — never sRGB-decoded
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

/** Test/teardown hook — drops the cached bake so a fresh one can be made. */
export function resetSurfaceDetailMap(): void {
  cached?.dispose();
  cached = null;
}
