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
  mist?: number; // >0: thin ground-mist over EXPLORED space too (depth layering)
}

// Low layer: a dark atmospheric bank over unexplored space — it VEILS, it
// does not hide: the actual level geometry renders everywhere and sinks into
// the band's colored dark (renderer3d's fog tint), D2R-style; these planes
// only add drifting depth on top. High layer: thin fast wisps above the wall
// tops that sell the motion. Mist layer: an ankle-height haze that drifts
// over explored ground as well, so the revealed world keeps atmospheric depth.
// Opacities kept low enough that the murk-lit geometry beneath ALWAYS reads
// through (r5 issue #1: the unexplored 60-75% of frame must be dim
// architecture, not a flat navy cloud painted over it).
const LAYERS: LayerSpec[] = [
  { y: 0.55, opacity: 0.22, billowTiles: 9, driftA: [0.010, 0.006], driftB: [-0.006, 0.013] },
  { y: 1.35, opacity: 0.12, billowTiles: 5, driftA: [-0.016, 0.010], driftB: [0.011, -0.019] },
  { y: 0.16, opacity: 0.13, billowTiles: 6, driftA: [0.014, -0.008], driftB: [-0.009, 0.016], mist: 0.45 },
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
uniform float uMist;
varying vec2 vUv;
void main() {
  float m = texture2D(uMask, vUv).r; // bilinear -> soft ~1-tile frontier
  // Off-map is always fully fogged (edge texels could be clear if a room
  // touches the map border — don't let that clamp-smear to the horizon).
  float inside = step(0.0, vUv.x) * step(vUv.x, 1.0) * step(0.0, vUv.y) * step(vUv.y, 1.0);
  m = max(m, 1.0 - inside);
  float n1 = texture2D(uNoise, vUv * uScale + uDriftA * uTime).r;
  float n2 = texture2D(uNoise, vUv * uScale * 2.63 + uDriftB * uTime).r;
  float billow = n1 * 0.62 + n2 * 0.38;
  // ARCHITECTURAL frontier (r5 issue #1: the old 0.78 erosion smeared a
  // Gaussian ellipse over the map that ignored the walls): the band now hugs
  // the per-tile mask — whose bilinear ramp is already wall-shaped, cleared
  // room-by-room by the sim's flood-fill — with only a light curl of noise,
  // so the darkness edge lands ON doorways and wall lines, 1-2 tiles wide.
  float edge = m * smoothstep(0.34, 0.62, m + (billow - 0.5) * 0.30);
  // Ground mist: patchy haze over the EXPLORED map too (never past the edge).
  float base = uMist * smoothstep(0.42, 0.9, billow) * inside;
  // ---- THE FADE HAS TO HAVE ART IN IT (r3 major #9) ----------------------
  //
  // Acceptance: "30-50% of every frame is featureless fill. Unrevealed fog
  // areas and unlit ceiling slabs render as one flat colour with zero texture,
  // gradient or silhouette ... lol_10 fades its map edge into painted rock
  // forms and mist — the fade still has ART in it."
  //
  // The bank already drifted two octaves of billow, but every one of them fed
  // ALPHA and only a 0.25-0.85 smoothstep fed colour, so the composite over
  // near-black geometry landed inside about one value step: correctly animated,
  // and indistinguishable from a flat fill in a still frame.
  //
  // What a painted bank has is FORMS — crests that catch light and troughs that
  // fall away, with edges between them. Ridged noise (1 - |2n-1|) is exactly
  // that: it turns the smooth billow field into banded ridge lines, which read
  // as rolling forms rather than as a cloud. A third, faster octave breaks the
  // ridges up so they do not tile, and the crest term lifts colour as well as
  // alpha, so the bank finally has a value RANGE instead of a value.
  float n3 = texture2D(uNoise, vUv * uScale * 5.1 - uDriftA * uTime * 0.7).r;
  float ridge = 1.0 - abs(billow * 2.0 - 1.0);
  float form = smoothstep(0.30, 0.92, ridge * (0.72 + 0.56 * n3));
  float crest = smoothstep(0.52, 0.96, billow) * (0.45 + 0.55 * n3);
  // Both modulations are centred so the bank's MEAN value is unchanged: this
  // is a value RANGE, not a dimmer. The first cut used 0.74 + 0.46 * form and
  // 0.76 + 0.42 * form, which averages ~0.96 — it bought forms by spending
  // exposure, and the frame audit caught it (crushed 78.8% -> 84.3% mean over
  // the same five scenes). The build is already accused of underexposure; a
  // fix for one major must not feed another.
  float a = max(edge, base) * uOpacity * (0.8 + 0.2 * billow) * (0.80 + 0.44 * form);
  if (a < 0.012) discard;
  vec3 col = mix(uColA, uColB, smoothstep(0.25, 0.85, billow));
  col = mix(col, uColB * 1.55, crest * 0.55);  // lit crests
  col *= 0.86 + 0.40 * form;                    // troughs fall away
  gl_FragColor = vec4(col, a);
}`;

export class FogOfWar {
  readonly group = new THREE.Group();

  /** Per-tile animated fog alpha (1 = hidden, 0 = revealed), row-major over the
   * map. The renderer reads this to ease its instanced tile tint in sync with
   * the dissipating bank, so the reveal is one motion, not two. */
  get alphas(): Float32Array {
    return this.cur;
  }

  /** True while any tile's alpha is still animating toward its target. */
  get animating(): boolean {
    return this.settling;
  }

  /** The animated per-tile fog mask (R8, bilinear). World materials sample
   * this per fragment so the reveal frontier is a smooth ramp, never a
   * staircase of tile-sized rectangles. Null until the first rebuild. */
  get maskTexture(): THREE.DataTexture | null {
    return this.mask;
  }

  /** The tileable billow noise — shared with the world-lit materials so the
   * darkness frontier on the geometry erodes with the same texture the fog
   * planes drift. */
  get noiseTexture(): THREE.DataTexture {
    return this.noise;
  }

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

    // Murk colors: the band's clear color lifted toward its SHADOW hue (mood),
    // kept DEEP — the unexplored world underneath must read through the veil
    // as darkened geometry, so the bank is smoke-dark with only a whisper of
    // grey lift for the billow highlights. (Pale banks read as a grey canvas
    // painted over the frame — the exact "unfinished" tell.)
    const bg = new THREE.Color(theme.background);
    const shadow = new THREE.Color(theme.mood?.gradeShadow ?? 0x16132b);
    // READABLE murk (final pass, issue #1): the bank is a VEIL over geometry
    // that now keeps its own ~10% luminance floor — so it sits at the band's
    // shadow value instead of crushing toward black (the r2 crush stacked
    // with the vignette and buried 60%+ of every frame below 5% luminance).
    const colA = bg.clone().lerp(shadow, 0.75).multiplyScalar(1.1);
    const colB = bg.clone().lerp(shadow, 0.6).lerp(new THREE.Color(0xaab6cc), 0.07).multiplyScalar(1.25);

    for (const spec of LAYERS) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          // Map plane uv -> mask uv (tile x/w, y/h). The v axis is NEGATED:
          // PlaneGeometry's uv.y=1 edge lands at world z=-PAD after the
          // rotateX(-PI/2), i.e. plane v runs OPPOSITE to mask row order —
          // sampling it straight renders the explored set z-mirrored.
          uUvScale: { value: new THREE.Vector2((map.w + 2 * PAD) / map.w, -(map.h + 2 * PAD) / map.h) },
          uUvOff: { value: new THREE.Vector2(-PAD / map.w, (map.h + PAD) / map.h) },
          uMask: { value: this.mask },
          uNoise: { value: this.noise },
          uTime: { value: 0 },
          uOpacity: { value: spec.opacity },
          uScale: { value: map.w / spec.billowTiles },
          uDriftA: { value: new THREE.Vector2(...spec.driftA) },
          uDriftB: { value: new THREE.Vector2(...spec.driftB) },
          uColA: { value: colA },
          uColB: { value: colB },
          uMist: { value: spec.mist ?? 0 },
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

  /** Retarget the mask from the explored set (call when exploredVersion bumps).
   * `snap` stamps the mask instantly instead of easing — used right after a
   * SAME-WORLD rebuild (asset arrival, door opening), where re-fogging the
   * whole map and dissolving it back in reads as a full-screen dark flash. */
  setExplored(state: GameState, snap = false): void {
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
    if (snap && this.mask) {
      const data = this.mask.image.data as Uint8Array;
      for (let i = 0; i < this.target.length; i++) {
        this.cur[i] = this.target[i];
        data[i] = this.target[i] * 255;
      }
      this.mask.needsUpdate = true;
      this.settling = false;
      return;
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
