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
  "strike" | "crit" | "magic" | "nova" | "cataclysm" | "airstrike" | "frost" | "heal" | "gold",
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
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float a01 = fract(ang / 6.2831853 + 0.5);
    float commit = smoothstep(0.78, 1.0, uProg);
    // Outer rim: sharp edge glow, breathing while arming, locking at commit.
    float pulse = 0.7 + 0.3 * sin(uTime * 9.0 - r * 4.0);
    float rim = smoothstep(0.90, 0.965, r) * (1.0 - smoothstep(0.985, 1.0, r));
    float rimA = rim * (0.35 + 0.65 * uProg) * mix(pulse, 1.2, commit);
    // Conic sweep: the filled sector IS the clock; a hot line at the frontier.
    float fill = step(a01, uProg);
    float sweep = smoothstep(0.05, 0.004, abs(a01 - uProg));
    float fillA = fill * (0.10 + 0.15 * uProg);
    // Rune ticks, slowly rotating (bosses: fewer, heavier, counter-rotating).
    float seg = mix(20.0, 8.0, uBoss);
    float spin = mix(1.6, -0.9, uBoss);
    float ticks = smoothstep(0.15, 0.75, sin(ang * seg + uTime * spin));
    float band = smoothstep(0.70, 0.75, r) * (1.0 - smoothstep(0.83, 0.88, r));
    float runeA = band * ticks * (0.25 + 0.45 * uProg);
    // Boss-only: an inner rim + pressure rings collapsing toward the center.
    float rim2 = smoothstep(0.55, 0.59, r) * (1.0 - smoothstep(0.62, 0.66, r));
    float waves = 0.5 + 0.5 * sin((r + uTime * 0.55) * 26.0);
    float innerA = uBoss * (rim2 * 0.5 + waves * smoothstep(0.55, 0.08, r) * 0.2 * uProg);
    // READABILITY FLOOR (audit r3): the telegraph must survive FX bloom on top
    // of it. A dark backing plate under the interior pins local contrast, the
    // rim and sweep run brighter and more saturated than before.
    float glowA = rimA * 1.05 + fillA * 1.5 + sweep * 0.9 + runeA * 1.15 + innerA + commit * 0.14;
    float darkA = (1.0 - smoothstep(0.9, 0.99, r)) * (0.22 + 0.16 * uProg);
    float alpha = clamp(glowA + darkA, 0.0, 0.92);
    vec3 glowCol = uColor * (1.35 + sweep * 1.5 + commit * 1.0 + rim * 0.9);
    vec3 col = (glowCol * glowA + uColor * 0.06 * darkA) / max(alpha, 1e-4);
    gl_FragColor = vec4(col, alpha);
  }`;

export function makeTelegraphMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xff5030) },
      uProg: { value: 0 },
      uTime: { value: 0 },
      uBoss: { value: 0 },
    },
    vertexShader: TEL_VERT,
    fragmentShader: TEL_FRAG,
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
  const blob = (bx: number, by: number, br: number, a: number): void => {
    const grad = g.createRadialGradient(bx, by, 1, bx, by, br);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.7, `rgba(255,255,255,${a * 0.45})`);
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
