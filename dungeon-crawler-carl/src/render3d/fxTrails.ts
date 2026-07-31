import * as THREE from "three";

// TRAILS (combat-FX round 2): melee swing arcs and projectile ribbons.
//
// SwingArcs — a pooled shader arc swept in front of the attacker: the sweep
// position animates across the arc over ~130ms with a hot leading edge and a
// decaying wake, replacing the old static ring that just faded. Additive and
// bright enough to catch bloom.
//
// TrailRibbons — continuous tapered ribbons following projectiles: a short
// history of head positions rebuilt into a camera-facing triangle strip each
// frame (a handful of verts per live projectile — cheap), colored per school,
// fading toward the tail; replaces the gappy puff chains.

const ARC_SEG = 36;

function arcGeometry(): THREE.BufferGeometry {
  // Flat arc in XZ centered on +Z (the facing axis): uv.x runs along the arc,
  // uv.y across it (inner -> outer edge).
  const inner = 0.42, outer = 1.32;
  const a0 = -1.18, a1 = 1.18;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= ARC_SEG; i++) {
    const a = a0 + ((a1 - a0) * i) / ARC_SEG;
    for (let j = 0; j <= 1; j++) {
      const r = inner + (outer - inner) * j;
      pos.push(Math.sin(a) * r, 0, Math.cos(a) * r);
      uv.push(i / ARC_SEG, j);
    }
    if (i < ARC_SEG) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const ARC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const ARC_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProg; // sweep position 0..1 along the arc
  varying vec2 vUv;
  void main() {
    float d = vUv.x - uProg;
    // Hot leading edge at the sweep frontier.
    float lead = smoothstep(0.05, 0.0, abs(d)) * 1.7;
    // Wake behind the frontier, decaying with distance.
    float wake = d < 0.0 ? smoothstep(-0.55, -0.015, d) : 0.0;
    // Soft radial edges (no hard ring borders).
    float rad = smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
    float dampen = 1.0 - uProg * uProg * 0.7; // whole arc dies as the swing lands
    float a = (wake * 0.55 + lead) * rad * dampen;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + lead * 1.4), a);
  }`;

interface ArcSlot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  max: number;
}

export class SwingArcs {
  readonly group = new THREE.Group();
  private slots: ArcSlot[] = [];
  private geo = arcGeometry();

  /** Fire a swing arc at (x,z) facing `yaw`; mirror flips the sweep direction
   * (alternate per combo swing so back-and-forth slashes read). */
  spawn(x: number, z: number, yaw: number, hex: number, scale = 1, mirror = false): void {
    let slot: ArcSlot | null = null;
    for (const s of this.slots) if (s.life >= s.max) { slot = s; break; }
    if (!slot) {
      if (this.slots.length >= 10) {
        slot = this.slots[0];
        for (const s of this.slots) if (s.life > slot.life) slot = s;
      } else {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color() }, uProg: { value: 0 } },
          vertexShader: ARC_VERT,
          fragmentShader: ARC_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.renderOrder = 12;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.slots.push(slot);
      }
    }
    slot.life = 0;
    slot.max = 0.14;
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(hex);
    slot.mat.uniforms.uProg.value = 0;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.74, z);
    slot.mesh.rotation.y = yaw;
    slot.mesh.scale.set(mirror ? -scale : scale, scale, scale);
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      // Ease-out sweep: fastest at launch, landing soft.
      s.mat.uniforms.uProg.value = 1 - (1 - t) * (1 - t);
      if (s.life >= s.max) s.mesh.visible = false;
    }
  }
}

// ---- Projectile ribbons ----

const RIB_PTS = 12;
const RIB_POOL = 28;

const RIB_VERT = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const RIB_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFade;
  varying float vT;
  void main() {
    float a = pow(1.0 - vT, 1.7) * uFade * 0.85;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + (1.0 - vT) * 0.9), a);
  }`;

interface Ribbon {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  posAttr: THREE.BufferAttribute;
  pts: Float32Array; // head-first xyz history
  n: number;
  width: number;
  active: boolean;
  fade: number;
  id: number;
}

export class TrailRibbons {
  readonly group = new THREE.Group();
  private byId = new Map<number, Ribbon>();
  private pool: Ribbon[] = [];
  private cam = new THREE.Vector3(1, 1, 1).normalize();
  private static A = new THREE.Vector3();
  private static B = new THREE.Vector3();

  setCamDir(x: number, y: number, z: number): void {
    this.cam.set(x, y, z).normalize();
  }

  private makeRibbon(): Ribbon {
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(RIB_PTS * 2 * 3), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const at = new Float32Array(RIB_PTS * 2);
    const idx: number[] = [];
    for (let i = 0; i < RIB_PTS; i++) {
      at[i * 2] = at[i * 2 + 1] = i / (RIB_PTS - 1);
      if (i < RIB_PTS - 1) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    geo.setAttribute("position", posAttr);
    geo.setAttribute("aT", new THREE.BufferAttribute(at, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uFade: { value: 1 } },
      vertexShader: RIB_VERT,
      fragmentShader: RIB_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    mesh.userData.noAO = true;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, posAttr, pts: new Float32Array(RIB_PTS * 3), n: 0, width: 0.12, active: false, fade: 0, id: -1 };
  }

  /** Start (or keep) a ribbon for entity `id`. */
  claim(id: number, hex: number, width: number): void {
    if (this.byId.has(id)) return;
    let r: Ribbon | null = null;
    for (const c of this.pool) if (!c.active && c.fade <= 0) { r = c; break; }
    if (!r) {
      if (this.pool.length < RIB_POOL) {
        r = this.makeRibbon();
        this.pool.push(r);
      } else {
        // Steal the most-faded inactive ribbon; if all are live, skip (degrade).
        for (const c of this.pool) if (!c.active && (!r || c.fade < r.fade)) r = c;
        if (!r) return;
        this.byId.delete(r.id);
      }
    }
    r.active = true;
    r.fade = 1;
    r.n = 0;
    r.id = id;
    r.width = width;
    (r.mat.uniforms.uColor.value as THREE.Color).setHex(hex);
    r.mat.uniforms.uFade.value = 1;
    this.byId.set(id, r);
  }

  /** Push the current head position (call once per frame per live entity). */
  push(id: number, x: number, y: number, z: number): void {
    const r = this.byId.get(id);
    if (!r) return;
    r.pts.copyWithin(3, 0, (RIB_PTS - 1) * 3);
    r.pts[0] = x; r.pts[1] = y; r.pts[2] = z;
    r.n = Math.min(r.n + 1, RIB_PTS);
    // Backfill on first push so the strip starts as a point, not garbage.
    if (r.n === 1) for (let i = 1; i < RIB_PTS; i++) { r.pts[i * 3] = x; r.pts[i * 3 + 1] = y; r.pts[i * 3 + 2] = z; }
    this.rebuild(r);
    r.mesh.visible = true;
  }

  /** The entity is gone: let the ribbon fade out in place. */
  release(id: number): void {
    const r = this.byId.get(id);
    if (!r) return;
    r.active = false;
    this.byId.delete(id);
    r.id = -1;
  }

  private rebuild(r: Ribbon): void {
    const arr = r.posAttr.array as Float32Array;
    const A = TrailRibbons.A, B = TrailRibbons.B;
    for (let i = 0; i < RIB_PTS; i++) {
      const i3 = i * 3;
      const px = r.pts[i3], py = r.pts[i3 + 1], pz = r.pts[i3 + 2];
      // Tangent from neighbors; perpendicular = tangent x cameraDir keeps the
      // strip camera-facing under the fixed iso view.
      const j3 = Math.min(i + 1, RIB_PTS - 1) * 3;
      const k3 = Math.max(i - 1, 0) * 3;
      A.set(r.pts[k3] - r.pts[j3], r.pts[k3 + 1] - r.pts[j3 + 1], r.pts[k3 + 2] - r.pts[j3 + 2]);
      if (A.lengthSq() < 1e-8) A.set(1, 0, 0);
      B.crossVectors(A, this.cam).normalize();
      const w = r.width * (1 - (i / (RIB_PTS - 1)) * 0.88) * 0.5;
      arr[i * 6] = px + B.x * w; arr[i * 6 + 1] = py + B.y * w; arr[i * 6 + 2] = pz + B.z * w;
      arr[i * 6 + 3] = px - B.x * w; arr[i * 6 + 4] = py - B.y * w; arr[i * 6 + 5] = pz - B.z * w;
    }
    r.posAttr.needsUpdate = true;
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (r.active) continue;
      if (r.fade <= 0) { r.mesh.visible = false; continue; }
      r.fade = Math.max(0, r.fade - dt / 0.16);
      r.mat.uniforms.uFade.value = r.fade;
      if (r.fade <= 0) { r.mesh.visible = false; r.mat.uniforms.uFade.value = 1; }
    }
  }
}
