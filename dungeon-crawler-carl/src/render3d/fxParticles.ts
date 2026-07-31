import * as THREE from "three";

// GPU PARTICLE SYSTEM (combat-FX round 2). Two pooled instanced-quad meshes
// (additive for light, alpha for chunks/gibs) share one shader: the CPU only
// writes spawn-time attributes (position, velocity, acceleration, size/color
// keyframes, spin, stretch, delay); every frame of motion, size, color and
// alpha is computed in the VERTEX shader from uTime. A ring buffer recycles
// the oldest slot when full, so heavy fights degrade gracefully (the oldest
// wisp vanishes a frame early) instead of dropping fresh impacts.
//
// Stretch: sparks align + elongate along their view-space velocity — the
// classic "hot metal streak" — while smoke/flash quads stay round billboards.
// A positive `delay` schedules a particle for the future (the shader hides
// t < 0), which powers cast-anticipation beats (gather in, THEN flash).

const VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec3 aAcc;
  attribute vec2 aTime;  // spawn, life
  attribute vec2 aSize;  // size0 -> size1
  attribute vec3 aCol0;
  attribute vec3 aCol1;
  attribute vec4 aMisc;  // rot0, spin, stretch, fadeIn (fraction of life)
  attribute float aTex;  // atlas tile index (0..3)
  uniform float uTime;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    float t = uTime - aTime.x;
    float life = max(aTime.y, 1e-4);
    float k = clamp(t / life, 0.0, 1.0);
    float alive = step(0.0, t) * (1.0 - step(life, t));
    vec3 wp = aPos + aVel * t + 0.5 * aAcc * t * t;
    // Size: ease-out toward size1 (impacts bloom fast then hold).
    float ez = 1.0 - (1.0 - k) * (1.0 - k);
    float size = mix(aSize.x, aSize.y, ez) * alive;
    // Alpha: quick fade-in (aMisc.w of life), soft power fade-out.
    float aIn = aMisc.w > 0.001 ? clamp(k / aMisc.w, 0.0, 1.0) : 1.0;
    float fadeOut = 1.0 - k;
    float alpha = aIn * fadeOut * fadeOut * (2.0 - fadeOut); // ~smooth out
    // Tile decode: >=99 = smoke FLIPBOOK (tiles 4-7 played over the lifetime);
    // a fractional part (e.g. tile+0.5) flags ember FLICKER (per-particle phase).
    float tile = aTex;
    float flick = 1.0;
    if (tile >= 99.0) {
      tile = tile - 100.0 + floor(min(k, 0.999) * 4.0);
    } else if (fract(tile) > 0.25) {
      flick = 0.68 + 0.32 * sin(uTime * 21.0 + aMisc.x * 53.0);
      tile = floor(tile);
    }
    vCol = vec4(mix(aCol0, aCol1, k), alpha * flick);
    vUv = vec2((uv.x + tile) * 0.125, uv.y); // 8-tile horizontal atlas
    vec4 mv = modelViewMatrix * vec4(wp, 1.0);
    vec2 corner = position.xy;
    float angq = aMisc.x + aMisc.y * t;
    float ca = cos(angq), sa = sin(angq);
    corner = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
    // Velocity stretch: align the quad to view-space velocity, elongate with
    // speed; ortho camera makes view-space xy exactly screen space.
    vec3 vvel = (modelViewMatrix * vec4(aVel + aAcc * t, 0.0)).xyz;
    float sl = length(vvel.xy);
    if (aMisc.z > 0.001 && sl > 0.08) {
      vec2 dir = vvel.xy / sl;
      vec2 perp = vec2(-dir.y, dir.x);
      float len = size * (1.0 + aMisc.z * min(sl, 16.0) * 0.16);
      mv.xy += dir * corner.x * len + perp * corner.y * size * 0.38;
    } else {
      mv.xy += corner * size;
    }
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vec4 tx = texture2D(uMap, vUv);
    float a = vCol.a * tx.a;
    if (a < 0.004) discard;
    // Texture rgb modulates the tint: flash tiles are pure white (no-op),
    // the smoke flipbook carries interior shading (lit crown, sooty base).
    gl_FragColor = vec4(vCol.rgb * tx.rgb, a);
  }`;

// Sprite SHAPE atlas (8 tiles, 64px each): authored silhouettes instead of one
// universal soft blob — the LoL rule that every effect needs shape language.
//   0 soft radial glow   1 spiked radial burst (impact star)
//   2 irregular smoke puff   3 hard hot core (tight falloff)
//   4-7 smoke FLIPBOOK: shaded rolling puff that swells + breaks up
export const TEX_SOFT = 0;
export const TEX_STAR = 1;
export const TEX_SMOKE = 2;
export const TEX_CORE = 3;
/** aTex flag: play atlas tiles 4-7 as a flipbook across the particle's life. */
export const TEX_SMOKE_FLIP = 104;
/** aTex flag: +0.5 on any plain tile = per-particle alpha flicker (embers). */
export const TEX_FLICKER = 0.5;

function atlasTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 64;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  // 0: soft radial glow.
  {
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.72)");
    grad.addColorStop(0.75, "rgba(255,255,255,0.18)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  // 1: spiked radial burst — 8 tapered spokes (alternating long/short) + core.
  {
    g.save();
    g.translate(96, 32);
    for (let i = 0; i < 8; i++) {
      const len = i % 2 === 0 ? 30 : 19;
      const wid = i % 2 === 0 ? 5.5 : 3.6;
      g.save();
      g.rotate((i / 8) * Math.PI * 2);
      const lg = g.createLinearGradient(0, 0, len, 0);
      lg.addColorStop(0, "rgba(255,255,255,0.95)");
      lg.addColorStop(0.55, "rgba(255,255,255,0.5)");
      lg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = lg;
      g.beginPath();
      g.moveTo(0, -wid);
      g.lineTo(len, 0);
      g.lineTo(0, wid);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.restore();
    const core = g.createRadialGradient(96, 32, 1, 96, 32, 13);
    core.addColorStop(0, "rgba(255,255,255,1)");
    core.addColorStop(0.6, "rgba(255,255,255,0.55)");
    core.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = core;
    g.fillRect(64, 0, 64, 64);
  }
  // 2: irregular smoke puff — clustered soft blobs, off-center, lumpy rim.
  {
    const blob = (bx: number, by: number, br: number, a: number): void => {
      const grad = g.createRadialGradient(bx, by, 1, bx, by, br);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.65, `rgba(255,255,255,${a * 0.5})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(bx - br, by - br, br * 2, br * 2);
    };
    blob(160, 34, 22, 0.5);
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 6 + rnd() * 13;
      blob(160 + Math.cos(a) * d, 33 + Math.sin(a) * d, 8 + rnd() * 9, 0.22 + rnd() * 0.3);
    }
  }
  // 3: hard hot core — tight, near-solid center with a fast falloff.
  {
    const grad = g.createRadialGradient(224, 32, 1, 224, 32, 26);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.42, "rgba(255,255,255,0.92)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.22)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(192, 0, 64, 64);
  }
  // 4-7: smoke flipbook — an evolving lumpy puff with INTERIOR SHADING baked
  // into rgb (lit crown, sooty underside; the shader multiplies tint by rgb).
  // Across the four frames the puff swells, goes ragged, and hollows out.
  for (let f = 0; f < 4; f++) {
    const ox = 256 + 64 * f;
    const shade = (bx: number, by: number, br: number, a: number): void => {
      // Higher blobs read lit-from-above; low blobs stay dark soot.
      const lift = Math.max(0, Math.min(1, (36 - by) / 26 + 0.3));
      const l = Math.round(88 + 130 * lift);
      const l2 = Math.round(l * 0.66);
      const grad = g.createRadialGradient(ox + bx, by - br * 0.2, 1, ox + bx, by, br);
      grad.addColorStop(0, `rgba(${l},${l},${l},${a})`);
      grad.addColorStop(0.62, `rgba(${l2},${l2},${Math.round(l2 * 1.04)},${a * 0.55})`);
      grad.addColorStop(1, "rgba(40,40,46,0)");
      g.fillStyle = grad;
      g.fillRect(ox + bx - br, by - br, br * 2, br * 2);
    };
    const R = 13 + f * 3.5;
    shade(32, 36 - f * 1.5, R, 0.5 - f * 0.07);
    const n = 8 + f * 2;
    for (let i = 0; i < n; i++) {
      const a2 = rnd() * Math.PI * 2;
      const d = (0.35 + 0.65 * rnd()) * R * (0.6 + f * 0.18);
      shade(
        32 + Math.cos(a2) * d,
        34 + Math.sin(a2) * d * 0.8,
        5.5 + rnd() * (6.5 + f * 1.6),
        (0.26 + rnd() * 0.24) * (1 - f * 0.12),
      );
    }
  }
  return new THREE.CanvasTexture(c);
}

// Hue-preserving "hot" tint: toward white but never pure white, so additive
// stacking + ACES keeps a readable hue instead of clipping to a white smear.
const HOT = new THREE.Color();
function hot(hex: number, amt = 0.55): number {
  return HOT.setHex(hex).lerp(HOT2.setRGB(1, 1, 1), amt).getHex();
}
const HOT2 = new THREE.Color();

export interface FxSpawn {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  ax?: number; ay?: number; az?: number;
  life?: number;
  size0?: number; size1?: number;
  col0: number; col1?: number;
  rot?: number; spin?: number;
  stretch?: number; fadeIn?: number;
  delay?: number;
  dim?: number; // 0..1 brightness multiplier (additive: color IS intensity)
  blend?: "add" | "alpha";
  tex?: number; // atlas tile (TEX_SOFT default)
}

/** Per-ability 3-layer color signature: white-hot core, saturated mid, deep rim. */
export interface FxPalette { core: number; mid: number; rim: number }

class Pool {
  readonly mesh: THREE.Mesh;
  private head = 0;
  private readonly cap: number;
  private dirty = false;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private acc: THREE.InstancedBufferAttribute;
  private tim: THREE.InstancedBufferAttribute;
  private siz: THREE.InstancedBufferAttribute;
  private c0: THREE.InstancedBufferAttribute;
  private c1: THREE.InstancedBufferAttribute;
  private misc: THREE.InstancedBufferAttribute;
  private tex: THREE.InstancedBufferAttribute;

  constructor(cap: number, map: THREE.Texture, uTime: { value: number }, additive: boolean) {
    this.cap = cap;
    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    geo.instanceCount = cap;
    const attr = (n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.pos = attr(3); this.vel = attr(3); this.acc = attr(3);
    this.tim = attr(2); this.siz = attr(2);
    this.c0 = attr(3); this.c1 = attr(3); this.misc = attr(4);
    this.tex = attr(1);
    // Life 0 everywhere: every slot starts dead (alive=0 collapses the quad).
    geo.setAttribute("aPos", this.pos);
    geo.setAttribute("aVel", this.vel);
    geo.setAttribute("aAcc", this.acc);
    geo.setAttribute("aTime", this.tim);
    geo.setAttribute("aSize", this.siz);
    geo.setAttribute("aCol0", this.c0);
    geo.setAttribute("aCol1", this.c1);
    geo.setAttribute("aMisc", this.misc);
    geo.setAttribute("aTex", this.tex);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uMap: { value: map } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 11;
    this.mesh.userData.noAO = true;
  }

  write(now: number, o: FxSpawn): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.pos.setXYZ(i, o.x, o.y, o.z);
    this.vel.setXYZ(i, o.vx ?? 0, o.vy ?? 0, o.vz ?? 0);
    this.acc.setXYZ(i, o.ax ?? 0, o.ay ?? 0, o.az ?? 0);
    this.tim.setXY(i, now + (o.delay ?? 0), o.life ?? 0.4);
    const s0 = o.size0 ?? 0.2;
    this.siz.setXY(i, s0, o.size1 ?? s0);
    const dim = o.dim ?? 1;
    Pool.C.setHex(o.col0).multiplyScalar(dim);
    this.c0.setXYZ(i, Pool.C.r, Pool.C.g, Pool.C.b);
    Pool.C.setHex(o.col1 ?? o.col0).multiplyScalar(dim);
    this.c1.setXYZ(i, Pool.C.r, Pool.C.g, Pool.C.b);
    this.misc.setXYZW(i, o.rot ?? 0, o.spin ?? 0, o.stretch ?? 0, o.fadeIn ?? 0.08);
    this.tex.setX(i, o.tex ?? 0);
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.pos.needsUpdate = true; this.vel.needsUpdate = true; this.acc.needsUpdate = true;
    this.tim.needsUpdate = true; this.siz.needsUpdate = true;
    this.c0.needsUpdate = true; this.c1.needsUpdate = true; this.misc.needsUpdate = true;
    this.tex.needsUpdate = true;
  }

  private static C = new THREE.Color();
}

export class FxParticles {
  readonly group = new THREE.Group();
  private uTime = { value: 0 };
  private now = 0;
  private addPool: Pool;
  private alphaPool: Pool;

  constructor() {
    const map = atlasTexture();
    this.addPool = new Pool(1536, map, this.uTime, true);
    this.alphaPool = new Pool(512, map, this.uTime, false);
    this.group.add(this.addPool.mesh, this.alphaPool.mesh);
  }

  /** Advance the clock + upload any spawns since last frame. */
  update(time: number): void {
    this.now = time;
    this.uTime.value = time;
    this.addPool.flush();
    this.alphaPool.flush();
  }

  spawn(o: FxSpawn): void {
    (o.blend === "alpha" ? this.alphaPool : this.addPool).write(this.now, o);
  }

  // ---- Convenience emitters (each spawn is event-driven, not per-frame) ----

  /** Radial impact spray: hot core chunks arcing out under gravity. */
  burst(x: number, z: number, hex: number, count: number, dir?: { x: number; y: number }): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * 2.8;
      this.spawn({
        x, y: 0.55 + Math.random() * 0.3, z,
        vx: Math.cos(a) * sp + (dir?.x ?? 0) * 2.4, vy: 2 + Math.random() * 2.6,
        vz: Math.sin(a) * sp + (dir?.y ?? 0) * 2.4,
        ay: -10,
        life: 0.4 + Math.random() * 0.3,
        size0: 0.13 + Math.random() * 0.1, size1: 0.05,
        col0: hot(hex), col1: hex, dim: 0.85,
        rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 12,
      });
    }
  }

  /** Hot metal sparks: stretched additive streaks, fast and short.
   * Cores run hue-hot (not white) so the streaks keep their school color. */
  sparks(x: number, y: number, z: number, hex: number, count: number, dir?: { x: number; y: number }): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3.2 + Math.random() * 4.5;
      this.spawn({
        x, y: y + (Math.random() - 0.5) * 0.3, z,
        vx: Math.cos(a) * sp + (dir?.x ?? 0) * 3, vy: 1.2 + Math.random() * 3,
        vz: Math.sin(a) * sp + (dir?.y ?? 0) * 3,
        ay: -14,
        life: 0.2 + Math.random() * 0.18,
        size0: 0.07 + Math.random() * 0.05, size1: 0.02,
        col0: hot(hex, 0.45), col1: hex,
        stretch: 1.4, fadeIn: 0.02, dim: 0.9,
      });
    }
  }

  /** IMPACT FRAME, 3-layer (audit r3): a TINY white-hot core, a saturated
   * mid-hue spiked star (the authored silhouette), and a deep-hue rim halo.
   * Each layer is dimmed under the bloom knee so the hue SURVIVES the pass —
   * the flash reads as "orange strike" / "violet blast", never a white blob. */
  flash3(x: number, y: number, z: number, pal: FxPalette, size: number): void {
    // BRIGHTNESS BUDGET (critic r2 blocker): the three layers peak at
    // ~0.45+0.4+0.14 ≈ 0.9 pre-tonemap at the shared center, UNDER the ACES
    // clip and the bloom knee — the hue survives instead of smearing white.
    // White-hot core: TINY, hard falloff, hands off to color in ~60ms.
    this.spawn({
      x, y, z, life: 0.06, size0: size * 0.15, size1: size * 0.22,
      col0: pal.core, col1: pal.mid, fadeIn: 0.02, dim: 0.45, tex: TEX_CORE,
    });
    // Saturated mid: the spiked star IS the shape language; slight spin-in.
    this.spawn({
      x, y, z, life: 0.16, size0: size * 0.5, size1: size * 0.95,
      col0: pal.mid, col1: pal.rim, fadeIn: 0.02, dim: 0.4,
      rot: Math.random() * 6.28, tex: TEX_STAR,
    });
    // Deep rim: a dim narrow halo that grounds the flash in its school color.
    this.spawn({
      x, y, z, life: 0.24, size0: size * 0.55, size1: size * 1.1,
      col0: pal.mid, col1: pal.rim, fadeIn: 0.04, dim: 0.14, tex: TEX_SOFT,
    });
  }

  /** Back-compat impact frame: 2-layer hue flash (small core + halo). */
  impactFlash(x: number, y: number, z: number, hex: number, size: number): void {
    this.flash3(x, y, z, { core: hot(hex, 0.8), mid: hex, rim: hex }, size);
  }

  /** Rolling smoke: alpha-blended flipbook puffs (tiles 4-7 play over the
   * lifetime — swell, go ragged, hollow out) with baked interior shading.
   * The tint is LIFTED because the tile rgb darkens the interior itself. */
  smoke(x: number, y: number, z: number, count: number, tint = 0x2c2a30): void {
    const lit = hot(tint, 0.5);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn({
        x: x + Math.cos(a) * 0.2, y: y + Math.random() * 0.25, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * 0.35, vy: 0.55 + Math.random() * 0.5, vz: Math.sin(a) * 0.35,
        ay: 0.25,
        life: 0.9 + Math.random() * 0.7,
        size0: 0.35 + Math.random() * 0.2, size1: 1.0 + Math.random() * 0.4,
        col0: lit, col1: tint,
        rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 1.4,
        blend: "alpha", fadeIn: 0.22, tex: TEX_SMOKE_FLIP, dim: 1,
      });
    }
  }

  /** Drifting embers: small hue-hot motes that float up, FLICKER (per-particle
   * phase in the shader), and wink out — the linger after a blast. */
  embers(x: number, z: number, hex: number, count: number, radius = 0.5): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      this.spawn({
        x: x + Math.cos(a) * r, y: 0.15 + Math.random() * 0.4, z: z + Math.sin(a) * r,
        vx: (Math.random() - 0.5) * 0.6, vy: 0.9 + Math.random() * 1.4, vz: (Math.random() - 0.5) * 0.6,
        ay: -1.0,
        life: 0.7 + Math.random() * 0.8,
        size0: 0.09 + Math.random() * 0.06, size1: 0.03,
        col0: hot(hex, 0.4), col1: hex, fadeIn: 0.12, dim: 0.8,
        rot: Math.random() * 6.28, tex: TEX_SOFT + TEX_FLICKER,
      });
    }
  }

  /** NOVA shape language: a ring of stretched radial slash-streaks bursting
   * outward at blade height — the ability reads as arcs, not a puff. */
  radialStreaks(x: number, y: number, z: number, hex: number, count: number, radius: number): void {
    const dur = 0.22;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.35;
      const sp = (radius / dur) * (0.85 + Math.random() * 0.3);
      this.spawn({
        x: x + Math.cos(a) * 0.3, y: y + (Math.random() - 0.5) * 0.2, z: z + Math.sin(a) * 0.3,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp,
        life: dur + Math.random() * 0.08,
        size0: 0.3, size1: 0.1,
        col0: hot(hex, 0.35), col1: hex,
        stretch: 1.6, fadeIn: 0.05, dim: 0.6,
      });
    }
  }

  /** IMPLOSION vortex: a ring of stretched motes spiraling INTO the center —
   * replaces the old milky cone mesh (it read as an untextured placeholder). */
  vortex(x: number, z: number, hex: number, radius: number): void {
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const r = radius * (0.75 + Math.random() * 0.35);
      const life = 0.2 + Math.random() * 0.08;
      const dy = 0.15 + Math.random() * 0.9;
      this.spawn({
        x: x + Math.cos(a) * r, y: dy, z: z + Math.sin(a) * r,
        vx: -Math.cos(a) * (r / life), vy: (0.55 - dy) / life, vz: -Math.sin(a) * (r / life),
        life, size0: 0.2, size1: 0.06,
        col0: hex, col1: hot(hex, 0.6),
        stretch: 1.1, fadeIn: 0.25, dim: 0.8,
      });
    }
  }

  /** Cast anticipation: sparks CONVERGE onto the caster's hands over ~140ms,
   * then a delayed hand flash pops right as the ability fires. */
  gatherBurst(x: number, y: number, z: number, hex: number): void {
    const life = 0.14;
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + Math.random() * 0.5;
      const r = 0.8 + Math.random() * 0.45;
      const dy = (Math.random() - 0.5) * 0.7;
      this.spawn({
        x: x + Math.cos(a) * r, y: y + dy, z: z + Math.sin(a) * r,
        vx: -Math.cos(a) * (r / life), vy: -dy / life, vz: -Math.sin(a) * (r / life),
        life, size0: 0.16, size1: 0.05, col0: hex, col1: hot(hex, 0.6),
        stretch: 0.8, fadeIn: 0.25,
      });
    }
    this.spawn({ x, y, z, delay: 0.11, life: 0.1, size0: 0.3, size1: 0.65, col0: hot(hex, 0.6), col1: hex, fadeIn: 0.05, dim: 0.6, tex: TEX_STAR });
  }

  /** Monster windup gather: a couple of motes drawn into the body per call
   * (call on a short timer while the tell runs; intensity 0..1 = progress). */
  gather(x: number, y: number, z: number, hex: number, intensity: number): void {
    const n = 1 + Math.round(intensity * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.7 + Math.random() * 0.5;
      const life = 0.22;
      const dy = 0.3 + Math.random() * 0.8;
      this.spawn({
        x: x + Math.cos(a) * r, y: y + dy - 0.5, z: z + Math.sin(a) * r,
        vx: -Math.cos(a) * (r / life), vy: (0.5 - dy + 0.5) / life * 0.5, vz: -Math.sin(a) * (r / life),
        life, size0: 0.12 + intensity * 0.1, size1: 0.04,
        col0: hex, col1: hot(hex, 0.55), stretch: 0.6, fadeIn: 0.3,
      });
    }
  }

  /** Death gibs: chunky alpha-blended debris, launched and tumbling. */
  gibs(x: number, z: number, hex: number, count: number, dir?: { x: number; y: number }): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 2.4;
      this.spawn({
        x, y: 0.5 + Math.random() * 0.4, z,
        vx: Math.cos(a) * sp + (dir?.x ?? 0) * 2.6, vy: 2.6 + Math.random() * 2.4,
        vz: Math.sin(a) * sp + (dir?.y ?? 0) * 2.6,
        ay: -11,
        life: 0.5 + Math.random() * 0.35,
        size0: 0.16 + Math.random() * 0.12, size1: 0.1,
        col0: hex, col1: 0x14090a,
        rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 16,
        blend: "alpha", fadeIn: 0.03,
      });
    }
  }

  /** Rising ember column (elite death beat / big casts). */
  column(x: number, z: number, hex: number, count: number, height: number): void {
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.5, y: 0.2, z: z + (Math.random() - 0.5) * 0.5,
        vy: (height + Math.random()) * (1.4 + Math.random() * 0.8),
        life: 0.5 + Math.random() * 0.4,
        size0: 0.2 + Math.random() * 0.15, size1: 0.05,
        col0: hot(hex), col1: hex, fadeIn: 0.1, dim: 0.85,
      });
    }
  }
}
