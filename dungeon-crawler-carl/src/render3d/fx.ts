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
// - AoeBursts (r2 SPEND): the ability FOOTPRINT — layered ribbon fronts, a
//   rune inscription, mote sparkle and a DARK scorch core, with its per-pixel
//   energy divided by its own area so a big cast cannot become a bright cast.

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
    // GROUND READ (FX r2 #4 finding): a lane pointing along the camera axis
    // projects as a vertical card in iso, and at uniform brightness its HDR
    // rails+chevrons photographed as a "glitched gold UI rectangle" (it was
    // misread as detonation FX in G-fault-0). A gentle along-lane decay —
    // hottest at the launcher, cooler toward the reach cap — plus a heavier
    // backing plate keeps it reading as paint ON the floor at every angle.
    float ground = 0.72 + 0.28 * (1.0 - vUv.x);
    float glowA = (rimA + fillGrad + chevA + coreA) * cap * ground;
    // Dark backing plate pins local contrast under the glow (disc dialect).
    float darkA = 0.3 * cap * (0.6 + 0.4 * uProg);
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

// FAULT LINE FISSURE (FX r2). The sustain used to render through the generic
// pool shader, whose soft radial gradient photographed as "a shapeless red
// airbrush wash" (G-fault-1/3) — the floor-15 ENVIRONMENT seams had sharper
// crack language than the player's ultimate. This is authored broken ground:
// five jagged radial cracks (angular centerlines wiggled by radius-marching
// noise, arc-length width so they stay thin), each with its own reach, a
// molten core at the epicenter, hot ember flecks in the charred field, and
// the crack glow flickering like a live vent. Same uniform contract as the
// pool shader (uTime/uDry/uArm) so the hazard loop drives it unchanged.
const FISSURE_FRAG = /* glsl */ `
  uniform vec3 uColor; // deep rim hue (charred field)
  uniform vec3 uHot;   // molten crack hue
  uniform float uTime;
  uniform float uDry;  // 0 fresh -> 1 expiring
  uniform float uArm;
  uniform float uSeed; // per-cast crack layout
  varying vec2 vUv;
  float fsH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float fsN(vec2 q) {
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = fsH(q), b = fsH(q + vec2(1.0, 0.0));
    float c = fsH(q + vec2(0.0, 1.0)), d = fsH(q + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    // Wobbled boundary so the scar never ends on a compass circle.
    float a01 = fract(ang / 6.2831853 + 0.5);
    float en = fsN(vec2(a01 * 8.0 + uSeed, uSeed * 1.7)) * 0.18;
    float edge = 1.0 - smoothstep(0.72 - en, 0.98 - en, r);
    // FISSURE LINES: 5 radial cracks, each wiggling as it marches outward.
    float crack = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ca = uSeed + fi * 1.2566371; // 2pi/5 spokes
      // Centerline wiggle: noise sampled along the radius, per crack.
      float wig = (fsN(vec2(r * 4.5 + fi * 7.31, uSeed + fi * 3.7)) - 0.5) * 1.1;
      float dAng = abs(mod(ang - ca - wig * r + 3.14159265, 6.2831853) - 3.14159265);
      float d = dAng * max(r, 0.07); // arc length: constant world width
      float w = 0.055 * (1.0 - 0.5 * r); // cracks thin toward their tips
      float line = smoothstep(w, w * 0.2, d);
      // Per-crack reach: some cracks stop early — a hand-broken look.
      float reach = 0.62 + 0.36 * fsH(vec2(fi, uSeed * 11.0));
      line *= smoothstep(reach, reach - 0.16, r);
      crack = max(crack, line);
    }
    // Molten epicenter: the wound the cracks radiate from.
    float core = smoothstep(0.34, 0.0, r);
    // Ember flecks smoldering in the charred field between cracks.
    float fleck = smoothstep(0.82, 0.98, fsN(p * 7.0 + vec2(uSeed, -uSeed) + vec2(0.0, uTime * 0.15)));
    // Live-vent flicker on everything hot.
    float flick = 0.82 + 0.18 * sin(uTime * 7.0 + r * 9.0 + uSeed);
    // CHARRED FIELD: a dark plate that pins contrast under the glow — the
    // ground reads BROKEN, not tinted.
    float darkA = edge * 0.5;
    float hotA = (crack * 0.95 + core * 0.6 + fleck * 0.3 * edge) * flick;
    float alpha = clamp(darkA + hotA, 0.0, 0.94) * (1.0 - 0.75 * uDry);
    alpha *= mix(1.0, 0.35 + 0.15 * sin(uTime * 9.0), uArm);
    if (alpha < 0.004) discard;
    // Crack glow runs HDR (feeds bloom) exactly where the fissure line is;
    // the field stays near-black char with a deep-hue cast.
    vec3 col = uColor * 0.10 * darkA
             + uHot * (crack * (1.7 + 0.7 * core) + core * 0.9 + fleck * 0.45) * flick;
    gl_FragColor = vec4(col / max(alpha, 1e-4) * alpha, alpha);
  }`;

export function makeFissureMat(bodyHex: number, hotHex: number, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(bodyHex) },
      uHot: { value: new THREE.Color(hotHex) },
      uTime: { value: 0 },
      uDry: { value: 0 },
      uArm: { value: 0 },
      uSeed: { value: (seed % 97) * 0.61 },
    },
    vertexShader: TEL_VERT,
    fragmentShader: FISSURE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// PLAYER ANCHOR RING (FX r2). In every dense floor-15 frame the crawler was
// unfindable — no rim, no outline, no kit-color mark survives a 12-body mob.
// This is the genre's answer (LoL's player circle): a persistent kit-colored
// ground ring under YOUR crawler only. A dark under-plate pins contrast on
// molten floors, the bright ring breathes gently, and a hot notch orbits so
// the eye can re-acquire the anchor even when half the ring is under bodies.
const ANCHOR_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float pulse = 0.86 + 0.14 * sin(uTime * 2.4);
    // Bright kit-color ring.
    float ring = smoothstep(0.72, 0.84, r) * (1.0 - smoothstep(0.9, 0.99, r));
    // Orbiting hot notch: motion the eye locks onto in a static crowd.
    float notch = smoothstep(0.35, 0.0, abs(mod(ang - uTime * 1.6 + 3.14159265, 6.2831853) - 3.14159265));
    // Soft inner wash keeps the disc from reading as a bare wireframe.
    float inner = (1.0 - smoothstep(0.1, 0.75, r)) * 0.05;
    // Dark under-plate: contrast insurance against bright/molten floors.
    float darkA = smoothstep(0.6, 0.8, r) * (1.0 - smoothstep(0.95, 1.0, r)) * 0.30;
    float glowA = ring * (0.5 + 0.4 * notch) * pulse + inner;
    float alpha = clamp(glowA + darkA, 0.0, 0.85);
    if (alpha < 0.004) discard;
    vec3 col = uColor * (1.25 + ring * (0.6 + 1.1 * notch)) * glowA + uColor * 0.05 * darkA;
    gl_FragColor = vec4(col / max(alpha, 1e-4) * alpha, alpha);
  }`;

export function makeAnchorMat(hex: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uTime: { value: 0 } },
    vertexShader: TEL_VERT,
    fragmentShader: ANCHOR_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

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

/**
 * THE SCORCH MARK STOPS BEING A DISC OF PAINT (r3 blockers #4 and #10).
 *
 * The old texture was WHITE with an alpha shape: an unlit MeshBasicMaterial
 * then multiplied it by the effect's hot hue, so every mark rendered as a flat
 * region of one near-max-luminance colour at 0.74 opacity, with a "crisp
 * falloff ... near-solid interior". A radius-4.2 mark (the Injunction's) is
 * ~8.4 world units across, which on the gameplay camera is a large fraction of
 * the frame — and acceptance photographed exactly that: "a single AoE floods
 * 40-60% of the screen with flat, near-max-luminance orange and every floor
 * tile, prop and mob inside it is value-crushed to white", and separately "our
 * AoE discs are solid orange circles ... uniform blown-out interiors".
 *
 * The reference it is scored against (lol_04) has a TRANSLUCENT interior you
 * can still see terrain through, with the light confined to inscribed rings.
 * That is a value structure, and a value structure can live in the texture:
 * this bake writes STRUCTURE into RGB rather than flat white, so the tint the
 * caller passes is multiplied by a curve instead of by 1.0 everywhere.
 *
 *   · the interior is BURNT — RGB ~0.06-0.14, i.e. the hot hue rendered nearly
 *     black. A scorch is a hole in the floor, not a lamp on it.
 *   · the light lives in one ember BAND at ~0.72 of the radius plus ember
 *     speckle, so what the eye reads is a ring, and what bloom sees is thin.
 *   · alpha is LOW over the interior (~0.3) and high only in the band, so the
 *     floor tiles, props and bodies standing in the mark keep their own value.
 *
 * The shape stays irregular (a lobed radius, not a circle) and the falloff
 * stays crisp — the original note about soft skirts reading as fog smear is
 * still right. What changed is that the mark now has an inside and an edge.
 */
function splatTexture(): THREE.Texture {
  const N = 128;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  const img = g.createImageData(N, N);
  const d = img.data;
  const hash = (x: number, y: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const smooth = (a: number, b: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const nx = (px + 0.5) / N * 2 - 1, ny = (py + 0.5) / N * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const ang = Math.atan2(ny, nx);
      // Lobed perimeter: three harmonics, so no mark is ever a compass circle.
      const lobe = 0.94 + 0.055 * Math.sin(ang * 3 + 0.7)
        + 0.035 * Math.sin(ang * 7 - 1.9) + 0.022 * Math.sin(ang * 13 + 3.1);
      const rr = r / lobe; // 0 at the centre, 1 at the perimeter
      const i = (py * N + px) * 4;
      if (rr >= 1) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
      // Burn grain: two octaves of cell hash, so the char is blotchy.
      const grain = hash(Math.floor(px / 5), Math.floor(py / 5)) * 0.6
        + hash(Math.floor(px / 13) + 31, Math.floor(py / 13) + 17) * 0.4;
      // The ember band, and a second fainter one inside it — the "layered
      // inner circle geometry" of the reference, baked instead of built.
      const band = Math.exp(-(((rr - 0.74) / 0.115) ** 2));
      const band2 = Math.exp(-(((rr - 0.44) / 0.085) ** 2)) * 0.45;
      const speck = Math.max(0, hash(Math.floor(px / 3) + 7, Math.floor(py / 3) + 5) - 0.86) * 7
        * (0.25 + 0.75 * grain);
      // VALUE: burnt floor, an ember ring, cinders. Never 1.0 across an area.
      const v = Math.min(1, 0.055 + 0.09 * grain + 0.82 * band + 0.34 * band2 + 0.5 * speck);
      // ALPHA: the interior only tints, the band commits. Crisp outer cut.
      const a = (0.30 + 0.16 * grain + 0.55 * band + 0.16 * band2 + 0.4 * speck)
        * (1 - smooth(0.80, 1.0, rr));
      const q = Math.round(Math.max(0, Math.min(1, v)) * 255);
      d[i] = d[i + 1] = d[i + 2] = q;
      d[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

interface DecalSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  energy: number; // REF_R / radius — the same area-division rule as AoeBursts
  hot: THREE.Color;
  cold: THREE.Color;
}

export class GroundDecals {
  readonly group = new THREE.Group();
  private slots: DecalSlot[] = [];
  private geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private tex = splatTexture();
  // AFTERMATH BUDGET (r2 SPEND). Acceptance: "no blood, scorch, debris or
  // corpse marks survive a fight" — and they did not, because the callers
  // stamped 10-second marks while a floor-17 pull lasts a minute. Marks now
  // last ~34 s and there are more slots to hold them, so walking back through
  // a room you cleared shows that you cleared it. 28 pooled quads at ~1-4
  // world units is the fill-rate ceiling this buys; see the commit message.
  private static MAX = 28;
  /** The radius whose ink is "1" — a kill mark. Bigger marks divide down. */
  private static REF_R = 1.4;

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
        slot = { mesh, mat, life: 1, max: 1, energy: 1, hot: new THREE.Color(), cold: new THREE.Color() };
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
    // AREA DIVISION, the same rule AoeBursts already enforces and for the same
    // reason: a radius-4.2 Injunction mark covers ~40x the ground a radius-0.7
    // kill mark does, so painting both at one opacity means the big one owns
    // the frame. The caller cannot opt out — it is derived from the radius it
    // asked for, not passed in.
    slot.energy = Math.max(0.34, Math.min(1, GroundDecals.REF_R / Math.max(r, 0.5)));
    slot.mesh.visible = true;
    // Tiny per-slot lift so stacked decals never z-fight.
    slot.mesh.position.set(x, 0.02 + 0.002 * this.slots.indexOf(slot), z);
    slot.mesh.rotation.z = Math.random() * Math.PI * 2;
    slot.mesh.scale.setScalar(r);
    slot.mat.color.copy(slot.hot);
    slot.mat.opacity = 0.78 * slot.energy;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      // COOL FAST. 8% of a 34 s mark is 2.7 SECONDS of a big disc held at its
      // hot hue, which is long enough for a screenshot of an ordinary fight to
      // catch it — 2 of acceptance's 4 floor-14 samples did. An ember cools in
      // about a second whatever the mark's lifetime is, so the hot phase is now
      // absolute rather than a fraction of a lifetime that grew tenfold.
      const cool = Math.min(1, s.life / 0.9);
      s.mat.color.lerpColors(s.hot, s.cold, cool);
      // HOLD, THEN GO. `1 - t*t` spends 60% of a long life nearly invisible,
      // which is how a 34 s mark would still read as "nothing survived a
      // fight". A mark now keeps its ink until the last third.
      s.mat.opacity = 0.74 * s.energy * Math.min(1, 2.8 * (1 - t));
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

// ---- AoE bursts (r2 SPEND: the fullscreen-wash blocker and the flat-gradient
// blocker are the SAME object seen from two sides) ----
//
// WHAT WAS WRONG. An ability detonation was drawn as: one additive ground ring
// at the ability's full radius, a 14-unit-tall glow column, a size-2 impact
// flash and a point light. Every one of those scales UP with the ability, none
// of them divides by the area it covers, and the sum is HDR. Acceptance caught
// the end state exactly: floor 17, an ordinary Injunction cast, "the entire
// world goes flat pink-red ... black 0.1%, meanLuma 0.2165" — the frame the
// player fights in had no readable monster, prop or telegraph in it. The same
// object judged as ART read as "a single flat radial gradient with a bright rim
// — one hue, one layer, no inscribed geometry, no dark core, no directionality".
// Those are one defect, and this class is the one fix.
//
// THE TWO RULES IT ENCODES.
//
//  1. ENERGY IS DIVIDED BY AREA, NOT MULTIPLIED BY RADIUS. `uEnergy` is set on
//     the CPU to REF_R / worldRadius (clamped): a radius-7 ultimate paints each
//     of its pixels at ~37% of what a radius-2.6 nova paints its own. A bigger
//     cast then covers more ground WITHOUT being brighter — which is what a
//     bigger cast physically is, and is the only way a screen-filling effect can
//     coexist with a bloom pass. The old stack did the exact opposite.
//
//  2. THE BRIGHT PART IS THIN. Everything over ~1.0 lives in the leading ribbon
//     FRONT, a few percent of the radius wide. The interior is a DARK scorch
//     plate that holds value contrast under the fight, so the disc reads as a
//     hole burned in the floor with hot edges, not as a lamp. Bloom then sees
//     thin hot lines (which it should) instead of a full disc (which fogged the
//     frame).
//
// The rest is the layering the LoL reference sheet actually shows: three ribbon
// fronts at different speeds rather than one rim, a rune inscription that burns
// off, motes that sparkle inside the front, a hue ramp rim -> mid -> core across
// the fronts, and a directional stretch so a footprint is never a compass circle.
const AOE_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uMid;
  uniform vec3 uRim;
  uniform float uProg;   // 0 detonation -> 1 gone
  uniform float uTime;
  uniform float uEnergy; // REF_R / worldRadius: the area-division rule
  uniform float uSeed;
  uniform float uDir;    // impact heading, radians (directional stretch)
  varying vec2 vUv;
  float aoH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float aoN(vec2 q) {
    vec2 f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    float a = aoH(q), b = aoH(q + vec2(1.0, 0.0));
    float c = aoH(q + vec2(0.0, 1.0)), d = aoH(q + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  // One ribbon front: a travelling band, wide and soft at birth, thin and hard
  // as it runs out of energy. sp staggers the three fronts.
  float aoFront(float r, float p, float sp, float w0) {
    float fr = p * sp;
    float w = mix(w0, w0 * 0.34, p);
    return smoothstep(w, 0.0, abs(r - fr)) * (1.0 - smoothstep(0.82, 1.0, p));
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float ang = atan(p.y, p.x);
    // DIRECTIONALITY: the footprint stretches ~12% along the impact heading, so
    // a blast that came from somewhere looks like it did.
    float aniso = 1.0 + 0.12 * cos(ang - uDir);
    float r = length(p) / aniso;
    if (r > 1.0) discard;
    float ease = 1.0 - pow(1.0 - uProg, 2.2); // fronts move fastest at birth

    // ---- THE DARK CORE. A scorch plate that DARKENS the interior: the value
    // structure the critique said was missing, and the reason the hot fronts
    // read as edges instead of dissolving into their own glow.
    float burn = aoN(p * 3.1 + uSeed) * 0.6 + aoN(p * 8.7 - uSeed * 1.7) * 0.4;
    float core = (1.0 - smoothstep(0.10, 0.86, r)) * (0.55 + 0.45 * burn);
    float darkA = core * 0.5 * (1.0 - smoothstep(0.45, 1.0, uProg));

    // ---- THREE RIBBON FRONTS, not one rim. Different speeds and widths, so
    // the shape is a layered pressure wave rather than a single circle.
    float f1 = aoFront(r, ease, 1.00, 0.085);
    float f2 = aoFront(r, ease, 0.78, 0.055) * 0.7;
    float f3 = aoFront(r, ease, 0.55, 0.032) * 0.45;
    float ribbon = f1 + f2 + f3;

    // ---- RUNE INSCRIPTION: a tick band plus radial spokes inside the leading
    // front, burning off over the first third of the life.
    float insR = max(ease * 0.86, 1e-3);
    float rn = r / insR;
    float band = smoothstep(0.30, 0.36, rn) * (1.0 - smoothstep(0.62, 0.70, rn));
    float ticks = smoothstep(0.30, 0.85, sin(ang * 14.0 + uTime * 1.6 + uSeed * 6.28));
    float spokes = smoothstep(0.55, 0.95, sin(ang * 6.0 - uTime * 0.9)) * smoothstep(0.9, 0.2, rn);
    float rune = (band * ticks * 0.9 + spokes * 0.35) * (1.0 - smoothstep(0.05, 0.42, uProg));

    // ---- MOTE SPARKLE: hash cells twinkling just behind the leading front —
    // the "mote" layer of the reference sheet, with no particles to pay for.
    float mh = aoH(floor(vUv * 46.0) + uSeed * 17.0);
    float tw = step(0.965, fract(mh * 7.3 + uTime * 1.9));
    float motes = tw * smoothstep(0.22, 0.0, abs(r - ease * 0.9)) * (1.0 - uProg);

    // ---- INNER INSCRIPTION, HELD (r3 major #10). The reference (lol_04) has
    // layered CONCENTRIC geometry inside the leading front, not just the front:
    // a rune ring, an inner circle, and glyph ticks that stay legible while the
    // wave runs past them. The "rune" term above burns off in the first 40%
    // and rides the moving front, so once the wave passed there was nothing
    // left inside the disc but the flat interior acceptance photographed. This
    // band is at a FIXED radius and holds through the middle of the life.
    float insBand = smoothstep(0.055, 0.0, abs(r - 0.52));
    float glyph = smoothstep(0.15, 0.75, sin(ang * 9.0 - uTime * 0.55 + uSeed * 6.28));
    float inner = insBand * (0.35 + 0.65 * glyph) * (1.0 - smoothstep(0.55, 0.95, uProg));
    float innerRing = smoothstep(0.028, 0.0, abs(r - 0.30)) * (1.0 - smoothstep(0.6, 1.0, uProg));

    // ---- SOFT PERIMETER: no layer ever ends on a raw circle cut.
    float edgeF = 1.0 - smoothstep(0.94, 0.999, r);
    float glowA = (ribbon + rune * 0.5 + motes * 0.8 + inner * 0.55 + innerRing * 0.7) * edgeF * uEnergy;
    // ALPHA CEILING (r3 blocker #4). 0.9 over an area is opaque enough that the
    // floor tiles, props and bodies inside the footprint are gone — acceptance:
    // "every floor tile, prop and mob inside it is value-crushed to white",
    // against a reference that puts a fully saturated fire beam across NEAR-
    // WHITE SNOW and the snow stays readable underneath. 0.62 keeps the ground
    // visible THROUGH the effect, which is the whole difference between a
    // painted effect and a coat of paint.
    float alpha = clamp(glowA + darkA * edgeF, 0.0, 0.62);
    if (!(alpha >= 0.004)) discard;

    // ---- HUE RAMP across the fronts: deep rim behind, saturated mid in the
    // body, white-hot only in the leading edge. hdr is where bloom is fed and
    // it is deliberately confined to f1.
    //
    // uEnergy MULTIPLIES THE HDR TERM TOO, and leaving it out of this one line
    // was the whole of the second wash. Measured after the first cut of this
    // shader: an Injunction (radius 7) still produced black 0.7% / meanLuma
    // 0.109, and the ablation showed why — a thin front is thin in RADIUS but
    // 2*pi*7 = 44 world units LONG, so "a few percent of the radius" is still
    // an enormous count of above-knee pixels, and a radius-0.7 five-mip blur
    // turns that into a fullscreen tint. With the rule applied here, a big
    // cast's fronts sit UNDER the bloom knee and only a tight cast punches
    // over it — which is the correct answer twice over: the small explosion
    // near your feet is the one that should flare.
    float hdr = f1 * (1.4 + 0.8 * (1.0 - uProg)) * uEnergy;
    vec3 hue = mix(uRim, uMid, clamp(ribbon * 1.6, 0.0, 1.0));
    hue = mix(hue, uCore, clamp(hdr * 0.55 + motes, 0.0, 1.0));
    vec3 glowCol = hue * (0.9 + hdr) * uEnergy;
    // The scorch plate contributes a near-black, faintly hue-tinted colour.
    vec3 col = (glowCol * glowA + uRim * 0.035 * darkA + hue * 0.55 * (inner + innerRing)) / max(alpha, 1e-4);
    // VALUE CEILING, AND WHY IT IS A CEILING AND NOT A GAIN (r3 blocker #4).
    // Every term above is already area-divided, and the frame acceptance
    // rejected STILL had 40-60% of its pixels at near-max luminance. Dividing
    // by alpha is what does it: this shader emits un-premultiplied colour, so a
    // thin-alpha fragment carrying real energy resolves to an ENORMOUS rgb, and
    // nothing downstream was bounded. The reference frames keep their hottest
    // FX pixels a clear step under paper white and let bloom do the rest; this
    // clamps the un-premultiplied result so a single fragment can never exceed
    // ~2.6x the tone-map knee, which is exactly enough to bloom and not enough
    // to crush everything sharing the pixel.
    float cMx = max(col.r, max(col.g, col.b));
    col *= mix(1.0, 2.6 / max(cMx, 1e-4), step(2.6, cMx));
    gl_FragColor = vec4(col, alpha);
  }`;

interface AoeSlot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  max: number;
}

/**
 * Pooled ability footprints. `spawn` takes the ability's own 3-colour palette
 * (FX_PAL) and its WORLD radius; the class does the area division itself, so no
 * caller can reintroduce "bigger cast = brighter cast" by passing a bigger
 * number.
 */
export class AoeBursts {
  readonly group = new THREE.Group();
  private slots: AoeSlot[] = [];
  private static MAX = 6;
  /** The radius whose energy is "1". Nova sits near here by design. */
  private static REF_R = 2.6;

  spawn(x: number, z: number, pal: AbilityPalette, radius: number, dur = 0.6, dir = 0): void {
    let slot: AoeSlot | null = null;
    for (const s of this.slots) if (s.life >= s.max) { slot = s; break; }
    if (!slot) {
      if (this.slots.length < AoeBursts.MAX) {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uCore: { value: new THREE.Color() },
            uMid: { value: new THREE.Color() },
            uRim: { value: new THREE.Color() },
            uProg: { value: 0 },
            uTime: { value: 0 },
            uEnergy: { value: 1 },
            uSeed: { value: 0 },
            uDir: { value: 0 },
          },
          vertexShader: TEL_VERT,
          fragmentShader: AOE_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(TELEGRAPH_GEO, mat);
        mesh.renderOrder = 3; // over the decals, under the ribbons/numbers
        mesh.userData.noAO = true;
        mesh.visible = false;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.slots.push(slot);
      } else {
        slot = this.slots[0];
        for (const s of this.slots) if (s.life / s.max > slot.life / slot.max) slot = s;
      }
    }
    const u = slot.mat.uniforms;
    (u.uCore.value as THREE.Color).setHex(pal.core);
    (u.uMid.value as THREE.Color).setHex(pal.mid);
    (u.uRim.value as THREE.Color).setHex(pal.rim);
    // RULE 1, in one line. Clamped at both ends: a tiny burst must not become a
    // flare, and a huge one must still be visible.
    u.uEnergy.value = Math.max(0.18, Math.min(1, AoeBursts.REF_R / Math.max(radius, 0.6)));
    u.uSeed.value = Math.random() * 10;
    u.uDir.value = dir;
    u.uProg.value = 0;
    slot.life = 0;
    slot.max = dur;
    slot.mesh.position.set(x, 0.055, z);
    slot.mesh.scale.setScalar(Math.max(0.4, radius));
    slot.mesh.visible = true;
  }

  update(dt: number, time: number): void {
    for (const s of this.slots) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      s.mat.uniforms.uProg.value = Math.min(1, s.life / s.max);
      s.mat.uniforms.uTime.value = time;
      if (s.life >= s.max) s.mesh.visible = false;
    }
  }
}
