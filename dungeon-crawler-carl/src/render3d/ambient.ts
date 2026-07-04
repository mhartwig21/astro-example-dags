import * as THREE from "three";

// Ambient atmosphere per floor band: one pooled THREE.Points cloud drifting in
// a player-relative box. Particles are world-fixed (they don't ride the camera)
// but wrap per-axis whenever they leave the box, so a few hundred points
// blanket wherever the player goes — the same trick big worlds use for
// rain/snow. Purely cosmetic, host-side only; the sim never sees it.

interface BandSpec {
  count: number;
  color: number;
  size: number; // gl_PointSize in device px (sizeAttenuation off — ortho camera)
  opacity: number;
  additive: boolean; // embers/sparks glow; dust/ash shade
  riseSpeed: number; // world units/s, negative = falling
  sway: number; // horizontal wander amplitude
}

// Matches FLOOR_THEMES band order (undercroft, sewers, garden, ruins, ironworks, approach).
const BAND_SPECS: BandSpec[] = [
  { count: 320, color: 0xb8b0a0, size: 5.0, opacity: 0.26, additive: false, riseSpeed: 0.04, sway: 0.12 }, // dust motes
  { count: 300, color: 0x9fd98f, size: 5.5, opacity: 0.32, additive: false, riseSpeed: 0.12, sway: 0.18 }, // marsh spores
  { count: 260, color: 0xd8a848, size: 6.0, opacity: 0.42, additive: false, riseSpeed: -0.1, sway: 0.4 }, // falling leaves
  { count: 240, color: 0xffa050, size: 5.5, opacity: 0.8, additive: true, riseSpeed: 0.5, sway: 0.25 }, // rising embers
  { count: 280, color: 0xa8ccff, size: 4.5, opacity: 0.45, additive: true, riseSpeed: -0.3, sway: 0.3 }, // cold sparks
  { count: 340, color: 0xc9a0a0, size: 5.5, opacity: 0.38, additive: false, riseSpeed: -0.16, sway: 0.25 }, // drifting ash
];

const HALF = 17; // horizontal half-extent of the box (covers the iso viewport)
const Y_MIN = 0.15;
const Y_MAX = 2.4;

/** Soft radial dot sprite (drawn once; missing 2D context degrades to a square). */
function makeDotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

export class AmbientParticles {
  readonly group = new THREE.Group();

  private tex = makeDotTexture();
  private points: THREE.Points | null = null;
  private attr: THREE.BufferAttribute | null = null;
  private world = new Float32Array(0); // world-space positions
  private phase = new Float32Array(0); // per-particle wander phase
  private speedMul = new Float32Array(0);
  private spec: BandSpec | null = null;

  /** Swap to the band's particle population (call per floor build). */
  rebuild(band: number, anchorX: number, anchorZ: number): void {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = null;
    }
    const spec = (this.spec = BAND_SPECS[band] ?? BAND_SPECS[0]);

    this.world = new Float32Array(spec.count * 3);
    this.phase = new Float32Array(spec.count);
    this.speedMul = new Float32Array(spec.count);
    for (let i = 0; i < spec.count; i++) {
      this.world[i * 3] = anchorX + (Math.random() * 2 - 1) * HALF;
      this.world[i * 3 + 1] = Y_MIN + Math.random() * (Y_MAX - Y_MIN);
      this.world[i * 3 + 2] = anchorZ + (Math.random() * 2 - 1) * HALF;
      this.phase[i] = Math.random() * Math.PI * 2;
      this.speedMul[i] = 0.6 + Math.random() * 0.8;
    }

    const geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(new Float32Array(spec.count * 3), 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.attr);
    const mat = new THREE.PointsMaterial({
      color: spec.color,
      map: this.tex,
      size: spec.size,
      sizeAttenuation: false,
      transparent: true,
      opacity: spec.opacity,
      depthWrite: false,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    // Positions are rewritten anchor-relative every frame; skip stale culling
    // and draw after the fog bank so embers read as floating above the murk.
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.group.add(this.points);
  }

  /** Advance drift/sway and wrap escapees back into the box around the player. */
  update(anchorX: number, anchorZ: number, dt: number, time: number): void {
    const spec = this.spec;
    if (!spec || !this.points || !this.attr) return;
    const out = this.attr.array as Float32Array;
    const ySpan = Y_MAX - Y_MIN;
    for (let i = 0; i < spec.count; i++) {
      const j = i * 3;
      const ph = this.phase[i];
      const mul = this.speedMul[i];
      let x = this.world[j] + Math.sin(time * 0.7 * mul + ph) * spec.sway * dt;
      let y = this.world[j + 1] + spec.riseSpeed * mul * dt;
      let z = this.world[j + 2] + Math.cos(time * 0.6 * mul + ph * 1.7) * spec.sway * dt;
      // Per-axis wrap around the anchor: leaving one face re-enters the other.
      if (x < anchorX - HALF) x += HALF * 2; else if (x > anchorX + HALF) x -= HALF * 2;
      if (z < anchorZ - HALF) z += HALF * 2; else if (z > anchorZ + HALF) z -= HALF * 2;
      if (y < Y_MIN) y += ySpan; else if (y > Y_MAX) y -= ySpan;
      this.world[j] = x;
      this.world[j + 1] = y;
      this.world[j + 2] = z;
      // Anchor-relative in the buffer so the object's position (= the anchor)
      // gives the transparent-sort a truthful depth for the whole cloud.
      out[j] = x - anchorX;
      out[j + 1] = y;
      out[j + 2] = z - anchorZ;
    }
    this.points.position.set(anchorX, 0, anchorZ);
    this.attr.needsUpdate = true;
  }
}
