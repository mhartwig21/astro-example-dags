import * as THREE from "three";
import { Tile, type GameState } from "../sim/types";
import type { FloorTheme } from "./floorThemes";
import { tileableFogNoise } from "../render/fogNoise";

// Fog of war as actual fog: two translucent planes blanket the map, alpha-masked
// per tile so explored ground is clear and unknown space rolls with drifting
// billows (tileable noise scrolled in the shader — a live fog bank, not a static
// texture stamp). The two layers move at different scales/directions for
// parallax depth. The per-tile mask animates toward its target, so newly
// explored tiles dissipate over ~half a second instead of popping.
//
// Colors derive from the floor theme's clear color, so each band keeps its
// identity in the murk: green rot in the sewers, ember haze in the ruins, cold
// steel-blue in the ironworks. Purely cosmetic — never touches the sim.

const NOISE_SIZE = 256;
const DISSIPATE_RATE = 4.2; // 1/s exponential approach (~0.55s to settle)
const PAD = 24; // tiles of fog past the map edge, so the bank never visibly ends

interface LayerSpec {
  y: number; // world height of the plane (walls are 1.0 tall)
  opacity: number;
  billowTiles: number; // approx tiles per large billow
  driftA: [number, number];
  driftB: [number, number];
}

// Low layer: the dense bank that actually hides the level. High layer: thin
// fast wisps above the wall tops that sell the motion.
const LAYERS: LayerSpec[] = [
  { y: 0.55, opacity: 0.9, billowTiles: 9, driftA: [0.010, 0.006], driftB: [-0.006, 0.013] },
  { y: 1.35, opacity: 0.4, billowTiles: 5, driftA: [-0.016, 0.010], driftB: [0.011, -0.019] },
];

const VERT = /* glsl */ `
uniform vec2 uUvScale;
uniform vec2 uUvOff;
varying vec2 vUv;
void main() {
  // Plane is padded past the map; remap so vUv = (0..1) exactly over the map.
  vUv = uv * uUvScale + uUvOff;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMask;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uOpacity;
uniform float uScale;
uniform vec2 uDriftA;
uniform vec2 uDriftB;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec2 vUv;
void main() {
  float m = texture2D(uMask, vUv).r; // bilinear -> soft ~1-tile frontier
  // Off-map is always fully fogged (edge texels could be clear if a room
  // touches the map border — don't let that clamp-smear to the horizon).
  float inside = step(0.0, vUv.x) * step(vUv.x, 1.0) * step(0.0, vUv.y) * step(vUv.y, 1.0);
  m = max(m, 1.0 - inside);
  if (m < 0.01) discard;
  float n1 = texture2D(uNoise, vUv * uScale + uDriftA * uTime).r;
  float n2 = texture2D(uNoise, vUv * uScale * 2.63 + uDriftB * uTime).r;
  float billow = n1 * 0.62 + n2 * 0.38;
  // Noise erodes the frontier so the edge curls instead of following tiles.
  float edge = m * smoothstep(0.18, 0.72, m + (billow - 0.5) * 0.5);
  vec3 col = mix(uColA, uColB, smoothstep(0.25, 0.85, billow));
  gl_FragColor = vec4(col, edge * uOpacity * (0.8 + 0.2 * billow));
}`;

export class FogOfWar {
  readonly group = new THREE.Group();

  private noise: THREE.DataTexture;
  private mask: THREE.DataTexture | null = null;
  private cur = new Float32Array(0); // animated per-tile fog alpha, 0..1
  private target = new Uint8Array(0); // 1 = fogged, 0 = revealed
  private mats: THREE.ShaderMaterial[] = [];
  private w = 0;
  private h = 0;
  private settling = false;

  constructor() {
    const src = tileableFogNoise(NOISE_SIZE, 0xf09b17);
    const px = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
    for (let i = 0; i < px.length; i++) px[i] = Math.round(src[i] * 255);
    this.noise = new THREE.DataTexture(px, NOISE_SIZE, NOISE_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.noise.wrapS = this.noise.wrapT = THREE.RepeatWrapping;
    this.noise.magFilter = this.noise.minFilter = THREE.LinearFilter;
    this.noise.unpackAlignment = 1;
    this.noise.needsUpdate = true;
  }

  /** Rebuild the blanket for a new floor (full fog until setExplored runs). */
  rebuild(map: { w: number; h: number }, theme: FloorTheme): void {
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.group.clear();
    this.mask?.dispose();

    this.w = map.w;
    this.h = map.h;
    const n = map.w * map.h;
    this.cur = new Float32Array(n).fill(1);
    this.target = new Uint8Array(n).fill(1);
    const data = new Uint8Array(n).fill(255);
    this.mask = new THREE.DataTexture(data, map.w, map.h, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = this.mask.minFilter = THREE.LinearFilter;
    this.mask.unpackAlignment = 1;
    this.mask.needsUpdate = true;
    this.settling = false;

    // The band's clear color lifted toward pale grey: murk base + billow highlight.
    const bg = new THREE.Color(theme.background);
    const colA = bg.clone().lerp(new THREE.Color(0x8a93ad), 0.24);
    const colB = bg.clone().lerp(new THREE.Color(0xc9d2e4), 0.34);

    for (const spec of LAYERS) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uUvScale: { value: new THREE.Vector2((map.w + 2 * PAD) / map.w, (map.h + 2 * PAD) / map.h) },
          uUvOff: { value: new THREE.Vector2(-PAD / map.w, -PAD / map.h) },
          uMask: { value: this.mask },
          uNoise: { value: this.noise },
          uTime: { value: 0 },
          uOpacity: { value: spec.opacity },
          uScale: { value: map.w / spec.billowTiles },
          uDriftA: { value: new THREE.Vector2(...spec.driftA) },
          uDriftB: { value: new THREE.Vector2(...spec.driftB) },
          uColA: { value: colA },
          uColB: { value: colB },
        },
      });
      const geo = new THREE.PlaneGeometry(map.w + 2 * PAD, map.h + 2 * PAD);
      geo.rotateX(-Math.PI / 2);
      const plane = new THREE.Mesh(geo, mat);
      plane.position.set(map.w / 2, spec.y, map.h / 2);
      this.group.add(plane);
      this.mats.push(mat);
    }
  }

  /** Retarget the mask from the explored set (call when exploredVersion bumps). */
  setExplored(state: GameState): void {
    const { explored, map } = state;
    if (map.w !== this.w || map.h !== this.h) return; // rebuild lands first
    for (let i = 0; i < this.target.length; i++) {
      let lit = !!explored[i];
      if (!lit && map.tiles[i] === Tile.Wall) {
        // Match applyFog: a wall clears when any adjacent floor is explored.
        const x = i % this.w;
        const y = (i / this.w) | 0;
        lit =
          (x > 0 && !!explored[i - 1]) || (x < this.w - 1 && !!explored[i + 1]) ||
          (y > 0 && !!explored[i - this.w]) || (y < this.h - 1 && !!explored[i + this.w]);
      }
      this.target[i] = lit ? 0 : 1;
    }
    this.settling = true;
  }

  /** Per-frame: drift the billows and dissipate freshly revealed tiles. */
  update(dt: number, time: number): void {
    for (const m of this.mats) m.uniforms.uTime.value = time;
    if (!this.settling || !this.mask) return;
    const k = 1 - Math.exp(-DISSIPATE_RATE * dt);
    const data = this.mask.image.data as Uint8Array;
    let moving = false;
    for (let i = 0; i < this.cur.length; i++) {
      const t = this.target[i];
      const c = this.cur[i];
      if (Math.abs(c - t) < 0.005) {
        if (c !== t) {
          this.cur[i] = t;
          data[i] = t * 255;
        }
        continue;
      }
      this.cur[i] = c + (t - c) * k;
      data[i] = Math.round(this.cur[i] * 255);
      moving = true;
    }
    this.mask.needsUpdate = true;
    if (!moving) this.settling = false;
  }
}
