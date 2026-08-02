import * as THREE from "three";

// COMBAT-FX ROUND 2 support kit:
// - makeTelegraphMat / TELEGRAPH_GEO: the animated shader telegraph disc —
//   rotating rune ticks, a conic sweep that fills with the windup, a pulsing
//   edge-glow rim, and a heavier boss vocabulary (chevrons + collapsing
//   pressure rings) — replacing the flat fill+rim rings.
// - makeDissolving: injects an edge-glow erode (blocky hash dissolve, KayKit-
//   chunky) into a corpse's materials; the caller drives the returned uniform.
// - GroundDecals: pooled scorch/blood splats that cool from a hot tint and
//   fade over ~10s.
// - Shockwaves: pooled expanding rings for big deaths and crit impacts.

// ABILITY COLOR SIGNATURES (audit r3): every ability slot owns a 3-layer
// palette — white-hot core, saturated mid, deep rim — so FX read by hue at a
// glance (LoL rule: melee ember, magic violet, nova gold, airstrike arcane).
export interface AbilityPalette { core: number; mid: number; rim: number }
export const FX_PAL: Record<
  "strike" | "crit" | "magic" | "nova" | "cataclysm" | "airstrike" | "frost" | "heal" | "gold"
  // ABILITIES-V2 §3.2: the three new verbs each take a hue NOTHING else owns,
  // because the readability rule is per-ABILITY, not per-family — a brace that
  // borrowed "frost" and a pin that borrowed "magic" would be two more things
  // the player has to disambiguate mid-fight. `pull` is Collapse's GATHER,
  // deliberately violet against its own gold detonation: the two halves of one
  // cast have to read as two different events or the rework is invisible.
  | "brace" | "pin" | "stay" | "pull",
  AbilityPalette
> = {
  strike: { core: 0xfff1d0, mid: 0xffa03c, rim: 0xc23c10 }, // melee: ember orange
  crit: { core: 0xfff6d8, mid: 0xffd23e, rim: 0xb87400 }, // crit: hot gold
  magic: { core: 0xf0e4ff, mid: 0xa06bff, rim: 0x5426b8 }, // bolt: arcane violet
  nova: { core: 0xfff7dc, mid: 0xffce4a, rim: 0xc07818 }, // nova: radiant gold
  cataclysm: { core: 0xffe9c8, mid: 0xff8a3c, rim: 0xb03410 }, // ult crown: magma
  airstrike: { core: 0xf2e2ff, mid: 0xb277ff, rim: 0x5c22cc }, // sponsor ordnance: violet
  frost: { core: 0xe8f6ff, mid: 0x7fd4ff, rim: 0x2a5eb8 },
  heal: { core: 0xeaffe2, mid: 0x5fd08a, rim: 0x1e7a48 },
  gold: { core: 0xfff3d0, mid: 0xf2c14e, rim: 0x9a6a10 },
  brace: { core: 0xeaf4ff, mid: 0x8fb6e8, rim: 0x24457c }, // Bulwark: cold plate steel
  pin: { core: 0xe6fbff, mid: 0x46d2c4, rim: 0x115450 }, // Stage Cables: rigging teal
  stay: { core: 0xffe0d8, mid: 0xe0402e, rim: 0x5e0c07 }, // Injunction: court crimson
  pull: { core: 0xefe0ff, mid: 0x8b5cf0, rim: 0x2b1274 }, // Collapse's gather: void violet
};

export const TELEGRAPH_GEO = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);

const TEL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const TEL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProg; // windup progress 0..1 (1 = strike lands)
  uniform float uTime;
  uniform float uBoss; // 0 trash, 1 elite/boss (heavier vocabulary)
  // DEMOTION (BOSSES-V2 r3 minor). A boss fight draws TWO ground shapes at
  // once: this shared disc, and the ASK silhouette that says which fight it
  // is. The disc was winning — a dodge-the-lane capture led with a white ring
  // and the lanes came second. When an ask silhouette is live the disc drops
  // to a low-contrast BASE: the dark backing plate and the rim survive (they
  // are the reach promise), the glow layers step aside.
  uniform float uDemote;
  varying vec2 vUv;
  float telH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float telN(vec2 q) {
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = telH(q), b = telH(q + vec2(1.0, 0.0));
    float c = telH(q + vec2(0.0, 1.0)), d = telH(q + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float a01 = fract(ang / 6.2831853 + 0.5);
    float commit = smoothstep(0.78, 1.0, uProg);
    // PULSE TIMELINE (audit r3): the breath gets BRIGHTER and FASTER as
    // detonation approaches — urgency you can read in a single glance.
    float rate = mix(5.0, 14.0, uProg);
    float pulse = 0.6 + 0.4 * sin(uTime * rate - r * 5.0);
    // INTERIOR ENERGY (audit r4): scrolling 2-octave noise eroding the fill —
    // the zone churns like contained energy instead of sitting as flat vector
    // paint. Polar-mapped, drifting INWARD (energy converging on the strike).
    float nz = telN(vec2(a01 * 22.0, r * 9.0 + uTime * 2.4))
             * 0.65 + telN(vec2(a01 * 47.0 + 13.0, r * 19.0 + uTime * 4.1)) * 0.35;
    float churn = 0.45 + 1.15 * smoothstep(0.33, 0.85, nz);
    // SOFT PERIMETER (r6 major: "hard alpha edge"): every layer that reaches
    // the boundary dies over the last ~4% of radius, so the disc never ends
    // on a raw circle cut against the floor.
    float edgeF = 1.0 - smoothstep(0.955, 0.998, r);
    // TWO-TONE FILL: a translucent radial gradient deepening toward the rim —
    // the covered area reads as an authored danger zone, not a wire gizmo.
    float fillGrad = (0.06 + 0.36 * pow(r, 1.9)) * (0.45 + 0.55 * uProg)
                   * (0.75 + 0.45 * pulse * uProg) * churn * edgeF;
    // Conic sweep: the filled sector IS the clock; a hot line at the frontier.
    float fill = step(a01, uProg);
    float sweep = smoothstep(0.05, 0.004, abs(a01 - uProg));
    float fillA = fill * (0.09 + 0.13 * uProg);
    // BRIGHT RIM: thicker edge glow, breathing while arming, locking at commit.
    float rim = smoothstep(0.875, 0.95, r) * (1.0 - smoothstep(0.98, 1.0, r));
    float rimA = rim * (0.5 + 0.75 * uProg) * mix(pulse * 1.15, 1.4, commit);
    // Rotating rune ticks (bosses: fewer, heavier, counter-rotating).
    float seg = mix(18.0, 8.0, uBoss);
    float spin = mix(2.1, -1.1, uBoss);
    float ticks = smoothstep(0.25, 0.78, sin(ang * seg + uTime * spin));
    float band = smoothstep(0.70, 0.75, r) * (1.0 - smoothstep(0.84, 0.89, r));
    float runeA = band * ticks * (0.32 + 0.55 * uProg);
    // Boss-only: an inner rim + pressure rings collapsing toward the center.
    float rim2 = smoothstep(0.55, 0.59, r) * (1.0 - smoothstep(0.62, 0.66, r));
    float waves = 0.5 + 0.5 * sin((r + uTime * 0.55) * 26.0);
    float innerA = uBoss * (rim2 * 0.5 + waves * smoothstep(0.55, 0.08, r) * 0.2 * uProg);
    // READABILITY FLOOR: a dark backing plate under the interior pins local
    // contrast so the glow layers read over bright floors and FX bloom.
    float glowA = (rimA * 1.1 + (fillA * 1.4 + sweep * 0.95 + runeA * 1.2 + innerA + commit * 0.2) * edgeF + fillGrad)
                * mix(1.0, 0.3, uDemote);
    float darkA = (1.0 - smoothstep(0.88, 0.99, r)) * (0.24 + 0.16 * uProg);
    float alpha = clamp(glowA + darkA, 0.0, 0.94);
    // HDR rim (audit r4): the edge runs 2-3x over white at commit so the ring
    // FEEDS BLOOM — an emissive danger line, not a matte stroke.
    vec3 glowCol = uColor * (1.35 + sweep * 1.9 + commit * 1.6 + rim * (1.7 + 1.3 * uProg) + 0.4 * pulse * uProg);
    vec3 col = (glowCol * glowA + uColor * 0.06 * darkA) / max(alpha, 1e-4);
    gl_FragColor = vec4(col, alpha);
  }`;

// LANE telegraph (charger rush / lasher hook): same two-tone language as the
// disc — translucent gradient fill, bright breathing side rails, chevrons
// marching toward the far end faster as the rush commits (audit r3: the flat
// single-color strip read as a debug gizmo).
const LANE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProg;
  uniform float uTime;
  varying vec2 vUv;
  float lnH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float lnN(vec2 q) {
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = lnH(q), b = lnH(q + vec2(1.0, 0.0));
    float c = lnH(q + vec2(0.0, 1.0)), d = lnH(q + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    float cross = abs(vUv.y - 0.5) * 2.0; // 0 center -> 1 side edge
    float pulse = 0.62 + 0.38 * sin(uTime * (5.0 + 9.0 * uProg));
    // Side rails: bright, breathing, locking solid near commit.
    float rim = smoothstep(0.7, 0.9, cross) * (1.0 - smoothstep(0.96, 1.0, cross));
    float rimA = rim * (0.45 + 0.7 * uProg) * mix(pulse * 1.1, 1.3, smoothstep(0.78, 1.0, uProg));
    // Interior erosion (audit r4): streaming noise blown DOWN-LANE — the fill
    // reads as rushing energy, not a flat painted bar.
    float nz = lnN(vec2(vUv.x * 12.0 - uTime * (3.0 + 5.0 * uProg), vUv.y * 5.0)) * 0.65
             + lnN(vec2(vUv.x * 27.0 - uTime * (5.0 + 8.0 * uProg) + 7.0, vUv.y * 11.0)) * 0.35;
    float churn = 0.5 + 1.0 * smoothstep(0.35, 0.85, nz);
    // Gradient fill deepening toward the rails.
    float fillGrad = (0.07 + 0.3 * cross * cross) * (0.4 + 0.6 * uProg)
                   * (0.75 + 0.45 * pulse * uProg) * churn;
    // Chevrons pointing down-lane, marching faster as detonation nears.
    float ang = (vUv.x * 9.0 - cross * 0.5 - uTime * (2.2 + 5.0 * uProg)) * 6.2831853;
    float chevA = smoothstep(0.5, 0.95, sin(ang)) * (1.0 - cross) * (0.14 + 0.2 * uProg);
    // Hot origin core: the lane is brightest where the rush launches from.
    float coreA = smoothstep(0.35, 0.0, vUv.x) * (1.0 - cross) * (0.1 + 0.25 * uProg);
    // Soft caps so the strip never ends on a hard raw edge.
    float cap = smoothstep(0.0, 0.05, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
    float glowA = (rimA + fillGrad + chevA + coreA) * cap;
    // Dark backing plate pins local contrast under the glow (disc dialect).
    float darkA = 0.22 * cap * (0.6 + 0.4 * uProg);
    float alpha = clamp(glowA + darkA, 0.0, 0.9);
    // HDR rails feed bloom at commit — same emissive standard as the disc rim.
    vec3 col = (uColor * (1.25 + rim * (1.5 + 1.2 * uProg) + chevA * 1.4) * glowA + uColor * 0.05 * darkA) / max(alpha, 1e-4);
    gl_FragColor = vec4(col, alpha);
  }`;

export function makeLaneMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xff9a2e) },
      uProg: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: TEL_VERT,
    fragmentShader: LANE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function makeTelegraphMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xff5030) },
      uProg: { value: 0 },
      uTime: { value: 0 },
      uBoss: { value: 0 },
      uDemote: { value: 0 },
    },
    vertexShader: TEL_VERT,
    fragmentShader: TEL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// GROUND-ZONE POOL (r6 major: "flat red/orange floor tints with no emissive
// gradient, flicker, or edge treatment"): every lingering hazard zone (acid,
// sludge, roots, bone shards, consecrated ground) renders as a living pool —
// a noise-wobbled boundary instead of a compass circle, interior churn that
// crawls, a hot luminous core cooling to a dark ember rim, and a gentle
// full-pool flicker. uDry fades it out as the zone expires; uArm ghosts the
// arming telegraph with a pulse.
const POOL_FRAG = /* glsl */ `
  uniform vec3 uColor; // body hue
  uniform vec3 uHot;   // hot-core hue (pre-lightened on the CPU)
  uniform float uTime;
  uniform float uDry;  // 0 fresh -> 1 expiring
  uniform float uArm;  // 1 while the arming telegraph ghosts
  varying vec2 vUv;
  float plH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float plN(vec2 q) {
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = plH(q), b = plH(q + vec2(1.0, 0.0));
    float c = plH(q + vec2(0.0, 1.0)), d = plH(q + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a01 = fract(atan(p.y, p.x) / 6.2831853 + 0.5);
    // Wobbled boundary: the pool's edge is drawn by noise, never a circle.
    float en = plN(vec2(a01 * 9.0, uTime * 0.35)) * 0.16;
    float edge = 1.0 - smoothstep(0.74 - en, 0.97 - en, r);
    // Interior churn: two octaves crawling in opposite directions.
    float nz = plN(p * 2.6 + vec2(uTime * 0.22, -uTime * 0.17)) * 0.6
             + plN(p * 6.4 + vec2(-uTime * 0.4, uTime * 0.31)) * 0.4;
    float churn = smoothstep(0.28, 0.85, nz);
    // Hot core cooling outward to a dark ember rim; the whole pool breathes.
    float core = smoothstep(0.8, 0.0, r);
    float flick = 0.86 + 0.14 * sin(uTime * 6.5 + nz * 9.0);
    vec3 col = mix(uColor * 0.5, uHot * (1.25 + 0.9 * core), core * (0.35 + 0.65 * churn)) * flick;
    float emberRim = smoothstep(0.5, 0.92, r);
    col = mix(col, uColor * 0.16, emberRim * 0.65);
    float a = edge * (0.66 - 0.34 * uDry) * (0.55 + 0.45 * churn);
    a *= mix(1.0, 0.32 + 0.16 * sin(uTime * 9.0), uArm);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makePoolMat(bodyHex: number): THREE.ShaderMaterial {
  const body = new THREE.Color(bodyHex);
  const hot = body.clone().lerp(new THREE.Color(1, 1, 1), 0.45);
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: body },
      uHot: { value: hot },
      uTime: { value: 0 },
      uDry: { value: 0 },
      uArm: { value: 0 },
    },
    vertexShader: TEL_VERT,
    fragmentShader: POOL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Death dissolve: clone every standard material under `root` (carrying any
 * injected shader stages — rim light, affix tints), add a blocky edge-glow
 * erode driven by the returned uniform (0 = whole, 1 = gone). The chunky
 * hash cells match the KayKit look; the edge burns in the given color.
 */
export function makeDissolving(root: THREE.Object3D, edgeHex: number): { value: number } {
  const uD = { value: 0 };
  const edge = new THREE.Color(edgeHex);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || mesh.userData.noAO) return;
    const swap = (m: THREE.Material): THREE.Material => {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) return m;
      const c = std.clone();
      const prevOBC = Object.prototype.hasOwnProperty.call(std, "onBeforeCompile")
        ? std.onBeforeCompile
        : null;
      const prevKey = Object.prototype.hasOwnProperty.call(std, "customProgramCacheKey")
        ? std.customProgramCacheKey.bind(std)
        : null;
      c.onBeforeCompile = (shader, renderer) => {
        if (prevOBC) prevOBC.call(c, shader, renderer);
        shader.uniforms.uDissolve = uD;
        shader.uniforms.uDissolveEdge = { value: edge };
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vDsPos;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvDsPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying vec3 vDsPos;\nuniform float uDissolve;\nuniform vec3 uDissolveEdge;\nfloat dsEdge = 0.0;\n" +
              "float dsHash(vec3 q) { return fract(sin(dot(floor(q), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }",
          )
          .replace(
            "#include <color_fragment>",
            "#include <color_fragment>\n{\n  float dsN = mix(dsHash(vDsPos * 9.0), dsHash(vDsPos * 31.0), 0.35);\n" +
              "  float dsT = uDissolve * 1.18;\n  if (dsN < dsT) discard;\n" +
              "  dsEdge = smoothstep(dsT + 0.16, dsT, dsN) * step(0.001, uDissolve);\n}",
          )
          .replace(
            "#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n  totalEmissiveRadiance += uDissolveEdge * dsEdge * 2.4;",
          );
      };
      c.customProgramCacheKey = () => `${prevKey ? prevKey() : ""}|dissolve`;
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return uD;
}

/** Irregular white splat texture (alpha shaped) — tinted by material color. */
function splatTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  let seed = 13;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  // CRISP falloff (audit r3): scorch marks hold a near-solid interior and cut
  // off fast at the edge — a soft wide skirt reads as fog smear, not a mark.
  const blob = (bx: number, by: number, br: number, a: number): void => {
    const grad = g.createRadialGradient(bx, by, 1, bx, by, br);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.72, `rgba(255,255,255,${a * 0.55})`);
    grad.addColorStop(0.9, `rgba(255,255,255,${a * 0.12})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(bx - br, by - br, br * 2, br * 2);
  };
  blob(64, 64, 42, 0.9);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 14 + rnd() * 44;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 4 + rnd() * 12, 0.28 + rnd() * 0.5);
  }
  return new THREE.CanvasTexture(c);
}

interface DecalSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  hot: THREE.Color;
  cold: THREE.Color;
}

export class GroundDecals {
  readonly group = new THREE.Group();
  private slots: DecalSlot[] = [];
  private geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private tex = splatTexture();
  private static MAX = 22;

  /** Stamp a splat at (x,z): cools from hotHex to coldHex, fades over `max`s. */
  spawn(x: number, z: number, r: number, coldHex: number, hotHex: number, max = 10): void {
    let slot: DecalSlot | null = null;
    for (const s of this.slots) if (s.life >= s.max) { slot = s; break; }
    if (!slot) {
      if (this.slots.length < GroundDecals.MAX) {
        const mat = new THREE.MeshBasicMaterial({
          map: this.tex, transparent: true, depthWrite: false,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.renderOrder = 1;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1, hot: new THREE.Color(), cold: new THREE.Color() };
        this.slots.push(slot);
      } else {
        slot = this.slots[0]; // oldest-progress slot gets recycled
        for (const s of this.slots) if (s.life / s.max > slot.life / slot.max) slot = s;
      }
    }
    slot.life = 0;
    slot.max = max;
    slot.hot.setHex(hotHex);
    slot.cold.setHex(coldHex);
    slot.mesh.visible = true;
    // Tiny per-slot lift so stacked decals never z-fight.
    slot.mesh.position.set(x, 0.02 + 0.002 * this.slots.indexOf(slot), z);
    slot.mesh.rotation.z = Math.random() * Math.PI * 2;
    slot.mesh.scale.setScalar(r);
    slot.mat.color.copy(slot.hot);
    slot.mat.opacity = 0.78;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      // Cool fast (first ~8% of life), then fade slow.
      const cool = Math.min(1, s.life / (s.max * 0.08));
      s.mat.color.lerpColors(s.hot, s.cold, cool);
      s.mat.opacity = 0.78 * (1 - t * t);
      if (s.life >= s.max) s.mesh.visible = false;
    }
  }
}

interface ShockSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  r: number;
}

export class Shockwaves {
  readonly group = new THREE.Group();
  private slots: ShockSlot[] = [];
  private geo = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);

  /** Expanding ground ring: big deaths, crit punctuation. */
  spawn(x: number, z: number, hex: number, maxR: number, dur = 0.45): void {
    let slot: ShockSlot | null = null;
    for (const s of this.slots) if (s.life >= s.max) { slot = s; break; }
    if (!slot) {
      if (this.slots.length >= 10) {
        slot = this.slots[0];
        for (const s of this.slots) if (s.life > slot.life) slot = s;
      } else {
        const mat = new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.renderOrder = 10;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1, r: 1 };
        this.slots.push(slot);
      }
    }
    slot.life = 0;
    slot.max = dur;
    slot.r = maxR;
    slot.mat.color.setHex(hex);
    slot.mesh.position.set(x, 0.09, z);
    slot.mesh.visible = true;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      s.mesh.scale.setScalar(Math.max(0.05, s.r * eased));
      // Kept under the bloom knee: the ring reads as a hue-tinted pressure
      // front, not a white halo (critic r2 — additive stack was clipping).
      s.mat.opacity = 0.55 * (1 - t) * (1 - t);
      if (s.life >= s.max) s.mesh.visible = false;
    }
  }
}
