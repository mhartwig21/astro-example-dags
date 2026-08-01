import * as THREE from "three";

// Ambient atmosphere per floor band: one pooled point cloud of soft-edged,
// biome-colored sprites (radial-gradient texture, mostly additive so bloom
// catches them). Particles spawn ONLY inside the explored playable space —
// the renderer feeds a live list of candidate spawn points (explored floor
// tiles near the player, plus torch anchors for ember bias) — so the void
// stays void instead of reading as a starfield. Each particle lives a few
// seconds with a sine alpha envelope (fade in, drift, fade out), then
// respawns at a fresh candidate. Purely cosmetic, host-side only.

interface BandSpec {
  count: number;
  colors: number[]; // per-particle tint pool
  sizeMin: number; // gl_PointSize in CSS px (scaled by devicePixelRatio)
  sizeMax: number;
  opacity: number;
  additive: boolean; // embers/sparks/spores glow; ash shades
  riseMin: number; // world units/s, negative = falling
  riseMax: number;
  sway: number; // horizontal wander amplitude (units/s at peak)
  lifeMin: number; // seconds
  lifeMax: number;
  torchBias: number; // fraction of respawns anchored at torch positions
  yMin: number;
  yMax: number; // spawn height band
}

// Matches FLOOR_THEMES band order (undercroft, sewers, garden, ruins, ironworks, approach).
const BAND_SPECS: BandSpec[] = [
  { // undercroft: warm dust motes hanging in torchlight, stray embers at sconces
    count: 200, colors: [0xffb066, 0xe8d0a8, 0xffc890], sizeMin: 3.5, sizeMax: 8,
    opacity: 0.5, additive: true, riseMin: 0.05, riseMax: 0.22, sway: 0.16,
    lifeMin: 3.5, lifeMax: 7, torchBias: 0.6, yMin: 0.2, yMax: 1.6,
  },
  { // sewers: luminous marsh spores drifting up out of the muck
    count: 150, colors: [0x8fe07a, 0x4fae5a, 0xb8f0a0], sizeMin: 4, sizeMax: 9,
    opacity: 0.45, additive: true, riseMin: 0.1, riseMax: 0.3, sway: 0.22,
    lifeMin: 4, lifeMax: 8, torchBias: 0.25, yMin: 0.1, yMax: 1.4,
  },
  { // garden: fireflies and drifting pollen in the dusk
    count: 140, colors: [0xffe9a0, 0xd8e878, 0xfff4c8], sizeMin: 3.5, sizeMax: 8.5,
    opacity: 0.55, additive: true, riseMin: -0.06, riseMax: 0.14, sway: 0.4,
    lifeMin: 3, lifeMax: 6.5, torchBias: 0.3, yMin: 0.25, yMax: 2.0,
  },
  { // ruins: embers climbing off the smolder
    count: 210, colors: [0xff9a40, 0xff6a28, 0xffc060], sizeMin: 3, sizeMax: 7.5,
    opacity: 0.7, additive: true, riseMin: 0.3, riseMax: 0.7, sway: 0.28,
    lifeMin: 2.2, lifeMax: 4.5, torchBias: 0.55, yMin: 0.1, yMax: 1.8,
  },
  { // ironworks: furnace sparks lifting off the molten channels (r5 issue #3:
    // the warm half of the foundry story — the cyan stays in the work-lights)
    count: 170, colors: [0xffa050, 0xff6a1e, 0xffd080, 0x6fd8ff], sizeMin: 2.5, sizeMax: 6.5,
    opacity: 0.65, additive: true, riseMin: 0.22, riseMax: 0.6, sway: 0.26,
    lifeMin: 2, lifeMax: 4, torchBias: 0.35, yMin: 0.1, yMax: 1.8,
  },
  { // approach: slow blood-lit ash sifting down before the end
    count: 170, colors: [0xd8a0a0, 0xb87878, 0xe8c0b0], sizeMin: 3.5, sizeMax: 8,
    opacity: 0.34, additive: false, riseMin: -0.22, riseMax: -0.08, sway: 0.3,
    lifeMin: 4, lifeMax: 8, torchBias: 0.3, yMin: 0.4, yMax: 2.2,
  },
];

const HALF = 17; // horizontal half-extent around the player the cloud lives in

/** Soft radial sprite: bright core, long feathered falloff (reads as a glow
 * mote at any size; missing 2D context degrades to a square). */
function makeMoteTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.16)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vColor = color;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize;
}`;

const fragFor = (additive: boolean): string => /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha * uOpacity;
  ${additive
    ? "gl_FragColor = vec4(vColor * a, a);" // premultiplied for additive glow
    : "gl_FragColor = vec4(vColor, a);"}
}`;

export class AmbientParticles {
  readonly group = new THREE.Group();

  private tex = makeMoteTexture();
  private points: THREE.Points | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private alphaAttr: THREE.BufferAttribute | null = null;
  private world = new Float32Array(0); // world-space positions
  private phase = new Float32Array(0); // per-particle wander phase
  private rise = new Float32Array(0); // per-particle vertical speed
  private life = new Float32Array(0); // seconds lived
  private maxLife = new Float32Array(0);
  private spec: BandSpec | null = null;
  // Live spawn candidates, fed by the renderer: explored floor tiles near the
  // player (flat x,z pairs) and torch anchor positions for the ember bias.
  private spawnPts: Float32Array = new Float32Array(0);
  private spawnCount = 0;
  private torchPts: { x: number; y: number }[] = [];

  /** Renderer feed: where particles are ALLOWED to exist right now. */
  setSpawnSources(tiles: Float32Array, count: number, torches: { x: number; y: number }[]): void {
    this.spawnPts = tiles;
    this.spawnCount = count;
    this.torchPts = torches;
  }

  /** Swap to the band's particle population (call per floor build). */
  rebuild(band: number, pixelRatio: number): void {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = null;
    }
    const spec = (this.spec = BAND_SPECS[band] ?? BAND_SPECS[0]);
    this.spawnCount = 0; // stale candidates belong to the previous floor
    this.torchPts = [];

    const n = spec.count;
    this.world = new Float32Array(n * 3);
    this.phase = new Float32Array(n);
    this.rise = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      this.phase[i] = Math.random() * Math.PI * 2;
      this.rise[i] = spec.riseMin + Math.random() * (spec.riseMax - spec.riseMin);
      // Everyone starts DEAD with a staggered clock, so the cloud fades in
      // particle by particle as the floor reveals — no opening-frame swarm.
      this.maxLife[i] = spec.lifeMin + Math.random() * (spec.lifeMax - spec.lifeMin);
      this.life[i] = this.maxLife[i] + Math.random() * 2;
      sizes[i] = (spec.sizeMin + Math.random() * (spec.sizeMax - spec.sizeMin)) * pixelRatio;
      col.set(spec.colors[(Math.random() * spec.colors.length) | 0]);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aAlpha", this.alphaAttr);
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: fragFor(spec.additive),
      uniforms: { uMap: { value: this.tex }, uOpacity: { value: spec.opacity } },
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    // Positions are rewritten anchor-relative every frame; skip stale culling
    // and draw after the fog bank so motes read as floating above the murk.
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.userData.noAO = true;
    this.group.add(this.points);
  }

  /** Pick a fresh spawn spot from the live candidates (null = stay dead). */
  private respawn(i: number, spec: BandSpec): boolean {
    let x: number;
    let z: number;
    if (this.torchPts.length > 0 && Math.random() < spec.torchBias) {
      const t = this.torchPts[(Math.random() * this.torchPts.length) | 0];
      x = t.x + (Math.random() - 0.5) * 1.3;
      z = t.y + (Math.random() - 0.5) * 1.3;
    } else if (this.spawnCount > 0) {
      const s = (Math.random() * this.spawnCount) | 0;
      x = this.spawnPts[s * 2] + (Math.random() - 0.5) * 0.9;
      z = this.spawnPts[s * 2 + 1] + (Math.random() - 0.5) * 0.9;
    } else {
      return false;
    }
    const j = i * 3;
    this.world[j] = x;
    this.world[j + 1] = spec.yMin + Math.random() * (spec.yMax - spec.yMin);
    this.world[j + 2] = z;
    this.life[i] = 0;
    this.maxLife[i] = spec.lifeMin + Math.random() * (spec.lifeMax - spec.lifeMin);
    return true;
  }

  /** Advance drift/sway, age the envelope, respawn the expired. */
  update(anchorX: number, anchorZ: number, dt: number, time: number): void {
    const spec = this.spec;
    if (!spec || !this.points || !this.posAttr || !this.alphaAttr) return;
    const out = this.posAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < spec.count; i++) {
      const j = i * 3;
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        if (!this.respawn(i, spec)) {
          alphas[i] = 0;
          out[j + 1] = -10; // parked below the floor until candidates exist
          continue;
        }
      }
      const ph = this.phase[i];
      let x = this.world[j] + Math.sin(time * 0.7 + ph) * spec.sway * dt;
      const y = this.world[j + 1] + this.rise[i] * dt;
      let z = this.world[j + 2] + Math.cos(time * 0.6 + ph * 1.7) * spec.sway * dt;
      this.world[j] = x;
      this.world[j + 1] = y;
      this.world[j + 2] = z;
      // Outside the camera box (or off the height band): finish early by
      // aging out fast — no wrap, wrapping is what scattered motes over void.
      const oob =
        x < anchorX - HALF || x > anchorX + HALF ||
        z < anchorZ - HALF || z > anchorZ + HALF ||
        y < 0.02 || y > 2.8;
      if (oob) this.life[i] = Math.max(this.life[i], this.maxLife[i] - 0.001);
      // Sine envelope: fade in, hold soft, fade out.
      const t = this.life[i] / this.maxLife[i];
      alphas[i] = Math.pow(Math.sin(Math.min(1, Math.max(0, t)) * Math.PI), 0.75);
      // Anchor-relative in the buffer so the object's position (= the anchor)
      // gives the transparent-sort a truthful depth for the whole cloud.
      out[j] = x - anchorX;
      out[j + 1] = y;
      out[j + 2] = z - anchorZ;
    }
    this.points.position.set(anchorX, 0, anchorZ);
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}
