import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { Tile, type GameState, type HitEvent, type Player, type Vec2 } from "../sim/types";
import { DEFAULT_MOOD, THEME, type BandMood } from "./theme";
import { ELITE_TEXTURES, startModelLoad, type LoadedModel } from "./assets";
import { roomTemplateById } from "../content/rooms";
import { mobDefById } from "../content/mobs";
import type { CustomMobDef } from "../content/types";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { cataclysmParams, novaParams, orbitBladePos, orbitParams, rank, slotted } from "../sim/abilities";
import { weaponClassOf } from "../sim/items";
import { heroSkin, type CrawlerSkin } from "../sim/game";
import { CharSelectScene } from "./charSelect";
import { CONFIG, floorBand } from "../sim/config";
import { cosmeticRng, themeForFloor, tileHash, type FloorTheme } from "./floorThemes";
import { burstPeriod, residentAct } from "./staging";
import { assignRoomPurposes } from "../sim/roomPurposes";
import { dressRoomPurpose, spillPurposeDoorways, type DressEnv } from "./dressing";
import { ATTACHMENT_NODES, CANONICAL_LOADOUT, groundVisualFor, loadoutFor, rarityGlow } from "./weaponry";
import { FogOfWar } from "./fogOfWar";
import { AmbientParticles } from "./ambient";
import { bakeLightGrid, neutralLightGrid, LM_SCALE, LM_AO_SCALE, type BakeLight, type BakeStain } from "./lightGrid";

// Isometric 3D renderer. Maps the deterministic sim's tile grid + entity positions
// into a Three.js scene viewed through a fixed, pitched orthographic camera — the
// technique every modern ARPG (Diablo 3/4, PoE, Last Epoch) uses for its
// "isometric" look. Meshes are procedural low-poly stand-ins; drop CC0 glTF packs
// into /public/assets (see ASSETS.md) and they replace the primitives with no
// gameplay changes, because the sim knows nothing about rendering.

// Sim coordinate mapping: sim (x, y) tile units -> world (x, 0, y). Sim's vertical
// screen axis (y) becomes world Z; the ground is the XZ plane, up is +Y.

function flat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05, ...opts });
}

// Final display-space grade: per-band split-tone (darks lift toward the
// district's shadow hue — colored dark, never true black — brights tint toward
// its highlight), gentle saturation, and a film vignette tinted to the band's
// void color. Runs AFTER OutputPass (tone map + sRGB), so it grades the same
// values the player sees.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uShadow: { value: new THREE.Color(DEFAULT_MOOD.gradeShadow) },
    uHighlight: { value: new THREE.Color(DEFAULT_MOOD.gradeHighlight) },
    uSaturation: { value: DEFAULT_MOOD.gradeSaturation },
    uVignette: { value: DEFAULT_MOOD.vignette },
    uVigColor: { value: new THREE.Color(DEFAULT_MOOD.voidOuter) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uShadow;
    uniform vec3 uHighlight;
    uniform float uSaturation;
    uniform float uVignette;
    uniform vec3 uVigColor;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Shadow lift: raise the blacks toward the band hue — a WHISPER of
      // color in the dark, not a wash (a strong lift floats the whole
      // darkness up to a flat lavender sheet).
      c.rgb += uShadow * (1.0 - smoothstep(0.0, 0.3, l)) * 0.45;
      // Highlight tint: pre-normalized to luma 1 CPU-side, so this shifts hue
      // without changing exposure.
      c.rgb *= mix(vec3(1.0), uHighlight, smoothstep(0.35, 1.0, l) * 0.4);
      c.rgb = mix(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), c.rgb, uSaturation);
      // Film vignette, tinted toward the band's void rather than dead black.
      float d = length(vUv - 0.5) * 1.4142;
      float vig = 1.0 - uVignette * smoothstep(0.42, 1.08, d);
      c.rgb = mix(uVigColor, c.rgb, vig);
      gl_FragColor = c;
    }`,
};

// GTAO with the cosmetic transparents excluded from its G-buffer: the fog
// bank, glow sprites, and ambient motes must never carve occlusion into the
// world (a fog plane over the map would AO-shade everything under it).
class WorldGTAOPass extends GTAOPass {
  overrideVisibility(): void {
    const cache = (this as unknown as { _visibilityCache: Map<THREE.Object3D, boolean> })._visibilityCache;
    this.scene.traverse((o: THREE.Object3D) => {
      cache.set(o, o.visible);
      const anyO = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; material?: THREE.Material | THREE.Material[] };
      if (anyO.isPoints || anyO.isLine || anyO.isSprite || o.userData.noAO) {
        o.visible = false;
      } else if (anyO.material && !Array.isArray(anyO.material) && anyO.material.transparent) {
        o.visible = false;
      }
    });
  }
}

// One open-air cluster piece (tree/rock) registered for camera courtesy:
// where it stands, which instanced-mesh slot draws it, and its shrink easing.
interface CanopyEntry {
  mesh: THREE.InstancedMesh;
  index: number;
  base: THREE.Matrix4;
  x: number;
  z: number;
  f: number; // current scale factor (eased)
  target: number; // 1 = full size, 0.12 = stepped aside for the camera
}

// Which clip a committed windup PREFERS (falls back to "attack" if the rig
// doesn't have it baked — see attachClipAnimator's fuzzy clip picker).
// DAMAGED STATE (furniture-feel): blocking furniture at 1 hp swaps to the
// kit's broken counterpart where one exists; the rest get the tilt-and-sink
// treatment at build time (see the smashables sync).
const BREAKABLE_DAMAGED: Record<string, string> = {
  table_round_medium: "table_medium_broken",
};

const WINDUP_CLIP: Record<string, string> = {
  shot: "shoot",
  slam: "spin", // the 2H overhead spin reads as a wide AoE, not a jab
  ritual: "cast_long", // channelled cast — the long wind-up IS the interrupt window
  spit: "throw",
  raise: "cast_raise",
  punch: "punch", // lineworker piston — the unarmed haymaker
  aim: "idle_deadeye", // sentinel lock-on: sighting down the barrel (looping)
  vent: "spin", // slagbreaker heat dump: the big 2H wind-out
  hook: "attack", // lasher whip: the 1H slash sells the snap
  morph: "transform", // understudy: KayKit's EXPERIMENTAL transform clip, at last
  hex: "cast_long", // briar witch: the long channelled curse
  lunge: "melee_d", // cutpurse: the 1H stab IS a lunge
  heal: "cast_raise", // shaman channel — arms up, interrupt the medic
  summon: "cast_raise", // summoner elite / broodmother calling the add down
  consecrate: "cast_summon", // ruins cleric: call the light down
  sweep: "cast_long", // archivist: the channel holds while the beam sweeps
};

// Elite affix body glow. The affix is gameplay-critical (warded vs armored
// decides which build hurts it), so each gets a semantic emissive color per
// STYLEGUIDE.md — arcane for magic-resist, ember for physical-resist,
// lore-blue for frost, blood for reflect. Size alone said "elite"; the tint
// says WHICH elite before the intro card ever shows.
const AFFIX_TINT: Record<string, number> = {
  swift: 0xffe066, // crit-yellow: speed reads as urgency
  shielded: 0xaab2bd, // iron: it blocks
  volatile: 0xff5a2e, // about-to-explode orange (matches the bomber's read)
  summoner: 0x8a5cff, // necromancer violet: it makes more of them
  splitter: 0x8bd450, // swarmer green: it becomes more of them
  thorns: 0xc0392f, // blood: touching it hurts you back
  armored: 0xd98e4a, // ember: the physical school bounces off
  warded: 0x9a6bd0, // arcane: the magic school bounces off
  chilling: 0x5a87c6, // lore-blue frost (+ aura ring at the true slow radius)
  linked: 0x50d4c0, // soul-teal: the pack is one pool — thin it first
  vampiric: 0xa01830, // deep blood: it drinks what it hits
  juggernaut: 0x6e6e78, // dead iron: your CC bounces off
  mortar: 0xe07830, // shellfire orange: cover stops being safe
  berserking: 0xff4040, // rage red: it gets WORSE as it dies
  executioner: 0x902020, // headsman crimson: don't fight it wounded
};

export class Renderer3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private ambientLight: THREE.AmbientLight;
  private rim: THREE.DirectionalLight; // cool accent from behind-left (no shadow)

  // Post chain: Render -> GTAO -> Bloom -> Output (ACES + sRGB) -> Grade.
  private composer: EffectComposer;
  private gtao: WorldGTAOPass;
  private bloom: UnrealBloomPass;
  private gradePass: ShaderPass;

  // Environment light: PMREM'd per-band gradient sky, cached by band index.
  private pmrem: THREE.PMREMGenerator | null = null;
  private envCache = new Map<number, THREE.Texture>();

  // Shadow texel snapping: the key light's ortho frustum is fixed-size, so
  // snapping its position to shadow-texel increments kills the crawl/shimmer
  // as the camera follows the player. Basis vectors cached (dir is constant).
  private shadowRight = new THREE.Vector3();
  private shadowUp = new THREE.Vector3();

  // The band's colored dark (unexplored tiles tint toward this, never black).
  private fogDark = new THREE.Color(DEFAULT_MOOD.fogDark);

  // WORLD LIGHT (per-fragment fog + falloff): every floor tile, wall face and
  // placed prop samples the fog bank's animated mask texture (bilinear — the
  // reveal frontier is a smooth ramp, never a staircase of tile rectangles)
  // and a player-centered distance falloff computed per FRAGMENT, replacing
  // the old per-instance tile tint whose tile-sized quantization was plainly
  // visible at 1080p. Uniform objects are SHARED across every injected
  // material, so per-frame updates are one write here.
  private wl = {
    uWlMask: { value: null as THREE.Texture | null },
    uWlMapInv: { value: new THREE.Vector2(1, 1) },
    uWlPlayer: { value: new THREE.Vector2(0, 0) },
    uWlDark: { value: new THREE.Color(DEFAULT_MOOD.fogDark) },
    // x = falloff start (tiles), y = falloff width, z = far luminance floor.
    uWlFall: { value: new THREE.Vector3(4.5, 12, 0.12) },
    // Baked light/AO grid (lightGrid.ts): RGB = wall-shadowed torch pools,
    // A = junction AO + contact shadows + macro grime. uWlFlick is the global
    // firelight gutter on the baked pools; uWlNoise/uWlTime erode the fog
    // frontier so darkness reads as drifting fog, not an airbrushed mask.
    uWlLm: { value: neutralLightGrid() as THREE.Texture },
    uWlFlick: { value: 1 },
    uWlNoise: { value: null as THREE.Texture | null },
    uWlTime: { value: 0 },
  };
  // The live baked grid for the current floor (disposed on rebuild).
  private lightGridTex: THREE.DataTexture | null = null;
  // Prop materials already swapped for their world-lit clone this build
  // (original -> clone), so shared loader-cache materials clone exactly once.
  private wlPropCache = new Map<THREE.Material, THREE.Material>();

  /** Clone a material and inject the world-light fragment stage (fog mask +
   * distance falloff), optionally the wall base-gradient + lit top bevel
   * ("base") or the canopy sky-gradient ("canopy"). Clones are tracked in
   * floorMats and disposed on the next floor rebuild. */
  private worldLit<T extends THREE.Material | THREE.Material[]>(
    mat: T,
    opts: { dim?: number; base?: boolean; canopy?: boolean } = {},
  ): T {
    const dim = opts.dim ?? 1;
    const one = (m: THREE.Material): THREE.Material => {
      const c = m.clone();
      c.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.wl, { uWlDim: { value: dim } });
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vWlPos;")
          .replace(
            "#include <project_vertex>",
            "#include <project_vertex>\n#ifdef USE_INSTANCING\n  vWlPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#else\n  vWlPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif",
          );
        const head =
          "#include <common>\nvarying vec3 vWlPos;\nfloat wlK;\nvec3 wlBake;\nuniform sampler2D uWlMask;\nuniform sampler2D uWlLm;\nuniform sampler2D uWlNoise;\nuniform vec2 uWlMapInv;\nuniform vec2 uWlPlayer;\nuniform vec3 uWlDark;\nuniform vec3 uWlFall;\nuniform float uWlDim;\nuniform float uWlFlick;\nuniform float uWlTime;";
        let stage = "#include <color_fragment>\n{\n";
        if (opts.base) {
          // Masonry: darken toward the ground line, then a LIT top-edge bevel
          // band — the 2-tone wall (dark face, bright rim) that separates a
          // carved wall from an unlit extrusion.
          stage +=
            "  float wallShade = 0.7 + 0.3 * smoothstep(-0.06, 0.85, vWlPos.y);\n" +
            "  wallShade += 0.55 * smoothstep(0.80, 0.95, vWlPos.y);\n" +
            "  diffuseColor.rgb *= wallShade;\n";
        }
        if (opts.canopy) {
          // Canopy tone bands: cool shadowed underside -> mid -> warm sunned
          // crown, so a tree never reads as one flat green value.
          stage +=
            "  float f1 = smoothstep(0.05, 0.9, vWlPos.y);\n" +
            "  float f2 = smoothstep(1.1, 2.3, vWlPos.y);\n" +
            "  vec3 tone = mix(vec3(0.52, 0.60, 0.74), vec3(0.94, 0.96, 0.9), f1);\n" +
            "  tone = mix(tone, vec3(1.22, 1.12, 0.88), f2);\n" +
            "  diffuseColor.rgb *= tone;\n";
        }
        stage +=
          // Fog sample biased INWARD along the face normal (screen-space
          // derivative normal — works flat-shaded): a wall face at the
          // room|rock boundary reads the WALL tile's own fog (cleared when
          // the room is explored), so the camera-facing side of a lit room's
          // wall is carved and lit instead of bleeding half into the murk.
          "  vec3 wlN = cross(dFdx(vWlPos), dFdy(vWlPos));\n" +
          "  float wlNl = length(wlN);\n" +
          "  if (wlNl > 1e-6) wlN /= wlNl; else wlN = vec3(0.0);\n" +
          "  vec2 wUv = (vWlPos.xz - wlN.xz * 0.38) * uWlMapInv;\n" +
          "  float wFog = texture2D(uWlMask, wUv).r;\n" +
          "  if (wUv.x < -0.001 || wUv.x > 1.001 || wUv.y < -0.001 || wUv.y > 1.001) wFog = 1.0;\n" +
          // Noise-eroded, slowly drifting frontier: the darkness boundary on
          // the GEOMETRY curls like the fog bank above it instead of reading
          // as a soft-brush mask stamped on the map.
          "  float wNz = texture2D(uWlNoise, vWlPos.xz * 0.045 + vec2(uWlTime * 0.010, uWlTime * -0.007)).r;\n" +
          "  wFog = clamp(smoothstep(0.10, 0.92, wFog + (wNz - 0.5) * 0.44 * wFog * (1.9 - wFog)), 0.0, 1.0);\n" +
          "  float wD = distance(vWlPos.xz, uWlPlayer);\n" +
          "  float wT = clamp((wD - uWlFall.x) / uWlFall.y, 0.0, 1.0);\n" +
          "  float wFall = uWlFall.z + (1.0 - uWlFall.z) * (1.0 - wT * wT * (3.0 - 2.0 * wT));\n" +
          "  float wLit = 1.0 - wFog;\n" +
          // Baked light/AO grid: sample biased OUTWARD (wall faces read the
          // lit floor in front of them); AO multiplies albedo, the shadowed
          // torch pools add back at the emissive stage (fog-gated, guttering).
          "  vec2 wUvL = (vWlPos.xz + wlN.xz * 0.42) * uWlMapInv;\n" +
          "  vec4 wLm = texture2D(uWlLm, wUvL);\n" +
          "  float wAo = wLm.a * " + LM_AO_SCALE.toFixed(3) + ";\n" +
          "  diffuseColor.rgb *= wAo;\n" +
          "  vec3 wAlb = diffuseColor.rgb;\n" +
          "  wlK = wFall * uWlDim * wLit + 0.03 * wFog;\n" +
          "  diffuseColor.rgb = wAlb * wlK + uWlDark * (0.30 + 0.45 * min(wAo, 1.0)) * wFog;\n" +
          "  wlBake = wAlb * wLm.rgb * (" + LM_SCALE.toFixed(3) + " * uWlFlick) * wLit * (0.4 + 0.6 * wFall);\n}";
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", head)
          .replace("#include <color_fragment>", stage)
          // Emissives (doors, water sheen) are gated by the same stage, so
          // nothing glows through unexplored fog; the baked torch pools add
          // back here as albedo-scaled radiance.
          .replace(
            "#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n  totalEmissiveRadiance *= min(1.0, wlK * 1.6);\n  totalEmissiveRadiance += wlBake;",
          );
      };
      c.customProgramCacheKey = () => `wl${opts.base ? "b" : ""}${opts.canopy ? "c" : ""}`;
      this.floorMats.push(c);
      return c;
    };
    return (Array.isArray(mat) ? mat.map(one) : one(mat)) as T;
  }

  /** Swap every standard material under a placed prop for its world-lit clone
   * (cached per source material, so a hundred barrels cost two clones). Props
   * then sink into the fog and the distance falloff exactly like the ground
   * they stand on, instead of floating full-bright over the murk. */
  private worldLitProp(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const swap = (m: THREE.Material): THREE.Material => {
        if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
        let c = this.wlPropCache.get(m);
        if (!c) {
          c = this.worldLit(m);
          this.wlPropCache.set(m, c);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  // FIGURE-GROUND RIM: a cool fresnel edge-light injected into character
  // materials (cloned once per source material + strength variant, cached
  // for the session) — silhouettes pop off any floor wash without the draw
  // calls of inverted-hull outlines. Ortho camera: view direction is
  // constant, so the rim reads as a stable screen-edge accent.
  private rimCache = new Map<string, THREE.Material>();
  private applyRimLight(g: THREE.Object3D, hex: number, strength: number): void {
    const col = new THREE.Color(hex);
    const glsl =
      `{ vec3 rimV = normalize(vViewPosition);\n` +
      `  float rimF = pow(1.0 - clamp(dot(normal, rimV), 0.0, 1.0), 3.0);\n` +
      `  totalEmissiveRadiance += vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)}) * (rimF * ${strength.toFixed(3)}); }`;
    const variant = `${hex}:${strength}`;
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material || mesh.userData.noAO) return;
      const swap = (m: THREE.Material): THREE.Material => {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) return m;
        const key = `${m.uuid}:${variant}`;
        let c = this.rimCache.get(key);
        if (!c) {
          c = m.clone();
          c.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>\n${glsl}`,
            );
          };
          c.customProgramCacheKey = () => `rim${variant}`;
          this.rimCache.set(key, c);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  // Procedural stone texture for the solid-rock wall mass: offset block
  // courses with per-block value jitter and darker mortar seams. Grayscale on
  // purpose — the theme's wall tint colors it. One texture, every band.
  private stoneTex: THREE.Texture | null = null;
  private stoneTexture(): THREE.Texture {
    if (this.stoneTex) return this.stoneTex;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#9c9c9c";
      g.fillRect(0, 0, 128, 128);
      const courses = 4;
      const ch = 128 / courses;
      let seed = 7;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let row = 0; row < courses; row++) {
        const y = row * ch;
        const off = (row % 2) * 32;
        for (let x = -32; x < 128; x += 64) {
          const v = 152 + Math.floor(rnd() * 58); // per-block value jitter
          g.fillStyle = `rgb(${v},${v},${v})`;
          g.fillRect(x + off + 2, y + 2, 60, ch - 4);
          // A subtle top-lit edge on each block face.
          g.fillStyle = "rgba(255,255,255,0.12)";
          g.fillRect(x + off + 2, y + 2, 60, 3);
          g.fillStyle = "rgba(0,0,0,0.16)";
          g.fillRect(x + off + 2, y + ch - 6, 60, 4);
        }
      }
      // Mortar seams.
      g.fillStyle = "rgba(20,18,24,0.45)";
      for (let row = 0; row <= courses; row++) g.fillRect(0, row * ch - 1, 128, 2);
      for (let row = 0; row < courses; row++) {
        const off = (row % 2) * 32;
        for (let x = -32; x < 128; x += 64) g.fillRect(x + off, row * ch, 2, ch);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.stoneTex = tex;
    return tex;
  }

  // Out-of-bounds treatment: a huge radial-gradient ground disc that follows
  // the player, so beyond the map reads as depth falling away — not a black
  // starfield.
  private voidPlane: THREE.Mesh | null = null;

  // Transient FX lights: a tiny pool of pooled point lights with lifetime
  // intensity envelopes — explosions and magic actually illuminate the world.
  private fxLights: { light: THREE.PointLight; life: number; max: number; peak: number }[] = [];
  private static FX_LIGHT_POOL = 4;

  // Ambient-mote spawn candidates (explored floor tiles near the player),
  // refreshed on a short timer + on explored changes. Flat x,z pairs.
  private atmoTiles = new Float32Array(512 * 2);
  private atmoRefresh = 0;

  private floorGroup = new THREE.Group();
  // Render-side position smoothing: the sim ticks at a fixed 60Hz while the
  // display can run faster — applying raw sim positions makes movement (and
  // especially hand-grafted weapons) judder on high-refresh screens, and dash
  // reads as a hard cut. Meshes chase sim positions with a stiff exponential
  // lerp (~40ms of sub-frame lag), which hides tick quantization at any Hz and
  // turns teleports into 2-frame glides. Big jumps (floor change) snap.
  private static SMOOTH_RATE = 22;
  private static SNAP_DIST = 8;
  private smoothTo(mesh: THREE.Object3D, x: number, y: number, z: number, dt: number): void {
    const dx = x - mesh.position.x, dz = z - mesh.position.z;
    if (dx * dx + dz * dz > Renderer3D.SNAP_DIST * Renderer3D.SNAP_DIST || !mesh.visible) {
      mesh.position.set(x, y, z);
      return;
    }
    const a = 1 - Math.exp(-Renderer3D.SMOOTH_RATE * Math.min(dt, 0.1));
    mesh.position.x += dx * a;
    mesh.position.y = y;
    mesh.position.z += dz * a;
  }

  // Facing gets the same treatment: the sim flips `facing` instantly, and a
  // hero who snaps 180° in one frame reads as jitter, not agility (playtest
  // feedback asked for turn rate 16). Shortest arc, exponential chase.
  private static TURN_RATE = 16;
  private turnTo(mesh: THREE.Object3D, target: number, dt: number): void {
    let d = target - mesh.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const a = 1 - Math.exp(-Renderer3D.TURN_RATE * Math.min(dt, 0.1));
    mesh.rotation.set(0, mesh.rotation.y + d * a, 0);
  }

  // Torch LIGHT POOL: torch meshes are everywhere, but only a handful of real
  // point lights exist — reassigned each frame to the anchors nearest the
  // player. Constant lighting cost regardless of floor size (forward-renderer
  // fragment cost scales with light count).
  private torchAnchors: { x: number; y: number; seed: number }[] = [];
  private torchPool: THREE.PointLight[] = [];
  // Per-light repark state: which anchor it holds and its 0..1 fade level —
  // reassignments fade out/in over ~0.3s instead of popping between sconces.
  private torchState: { anchor: number; level: number; wanted: boolean }[] = [];
  private torchOrder: number[] = []; // scratch: anchor indices by distance
  private torchDesired = new Set<number>(); // scratch: the pool-sized near set
  private torchBase = 2.2;
  private static TORCH_POOL_SIZE = 8; // enough live lights that a lit room's walls actually catch fire-light

  /** Layered torch flicker: two incommensurate sines + smoothed hash noise —
   * firelight gutter, not a metronome. */
  private static torchFlicker(time: number, seed: number): number {
    const s1 = Math.sin(time * 7.3 + seed);
    const s2 = Math.sin(time * 2.9 + seed * 1.7);
    const k = time * 9 + seed;
    const i0 = Math.floor(k);
    const h = (n: number): number => {
      const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const fr = k - i0;
    const sm = fr * fr * (3 - 2 * fr);
    return 0.74 + 0.14 * s1 * s2 + 0.12 * (h(i0) * (1 - sm) + h(i0 + 1) * sm);
  }

  // Party rendering: one mesh per player id. The camera follows localPlayerId.
  private playerMeshes = new Map<number, THREE.Group>();
  private decoyMeshes = new Map<number, THREE.Group>(); // stunt doubles (ghost copies)
  private breakableMeshes = new Map<number, THREE.Object3D>(); // smashable dressing (phase 5)
  private stagingAnchors = new Map<string, Vec2>(); // purpose -> social anchor (resident facing)
  private npcMesh: THREE.Group | null = null; // Roam: the settlement's one resident
  localPlayerId = 0;
  private monsters = new Map<number, THREE.Group>();
  private keyMarkers = new Map<number, THREE.Mesh>(); // floating marker over key carriers
  private telegraphs = new Map<number, THREE.Group>(); // ground telegraphs (dim fill + bright rim) under winding-up monsters
  private laneStrips = new Map<number, THREE.Mesh>(); // LANE telegraphs: charger rush + lasher hook
  private statusRings = new Map<number, THREE.Mesh>(); // faint ring under statused monsters (5.11)
  private hazardRings = new Map<number, THREE.Mesh>(); // volatile-corpse blast telegraphs
  private pingRings = new Map<number, THREE.Mesh>(); // party pings: gold ground pulses
  private reviveRings = new Map<number, THREE.Mesh>(); // revive channel under downed crawlers
  private curseRings = new Map<number, THREE.Mesh>(); // briar-witch mark under cursed crawlers
  private moveMarker: THREE.Mesh | null = null; // click-to-move destination (host-local)
  private aimIndicator: THREE.Group | null = null; // drag-to-aim telegraph (touch/pad)
  // Corpses linger briefly so deaths read (death clip / tumble) instead of popping.
  private dying: {
    mesh: THREE.Group; t: number; rigged: boolean;
    // Overkill: the corpse is LAUNCHED — velocity + tumble applied while the
    // death clip plays. KayKit physics: comedic, committed, correct.
    fling?: { vx: number; vy: number; vz: number; spin: number };
  }[] = [];
  // Recent overkill killing blows (from emitHits) waiting to claim the corpse
  // the next reconcile removes near their position. Short-lived by design.
  private overkillMarks: { x: number; y: number; dir?: Vec2; t: number }[] = [];
  private loot = new Map<number, THREE.Object3D>();
  private projectiles = new Map<number, THREE.Object3D>();

  private models: Record<string, LoadedModel> = {};
  private builtFloor = -1;
  private builtMapVersion = -1;
  private builtSeed = -1;
  private aspect = 1;

  private floorMats: THREE.Material[] = []; // per-build cloned mats (world-lit clones)
  // Camera courtesy (open-air): tree/rock instances between the camera and an
  // entity shrink away so the shot stays clear. Grid-keyed by ground tile.
  private canopy: Map<number, CanopyEntry[]> | null = null;
  private canopyGridW = 0;
  // The visible fog bank over unexplored space (drifting planes; see fogOfWar.ts).
  private fogBank = new FogOfWar();
  // Band-themed atmosphere (dust/spores/embers/sparks/ash; see ambient.ts).
  private ambientFx = new AmbientParticles();
  // base = the prop's placed scale; reveal eases it in as its tile's fog
  // dissipates (no more visibility popping).
  private propEntries: { obj: THREE.Object3D; tile: number; base?: THREE.Vector3 }[] = [];
  private stairsObj: THREE.Object3D | null = null;
  private stairsTile = -1;
  // Same-world rebuild tracking (survives scheduleAssetRefresh's builtFloor
  // reset): when a rebuild re-creates the fog bank for a world the player is
  // already exploring, the first setExplored SNAPS instead of easing — no
  // full-screen dark flash on every streamed-asset refresh.
  private builtKey = "";
  private fogSnap = false;
  // The descent gate's live energy surface (animated in update) + the one-shot
  // portal FX triggers: departure (safe room opens) and arrival (floor+1 built).
  private portalSwirl: THREE.Mesh | null = null;
  private portalCore: THREE.Mesh | null = null;
  private portalPos: Vec2 | null = null;
  private wasInSafeRoom = false;
  private lastExploredVersion = -1;

  // Ability visuals, per player id.
  private orbitBlades = new Map<number, THREE.Group[]>();
  private hazardBombs = new Map<number, THREE.Group>(); // blast-hazard bomb, by hazard id
  private windupFx = new Map<number, THREE.Group>(); // spit lob / fuse bomb, by monster id
  private novaRings = new Map<number, THREE.Object3D>();
  // Which ult a player's live novaFlash belongs to (nova vs cataclysm share
  // the flag; the cd EDGE at fresh-cast time disambiguates).
  private fxPrevCata = new Map<number, number>();
  private fxPrevCutto = new Map<number, number>(); // Blindside teleport edge
  // Short-lived props that fade and vanish (Blindside smokebomb, detonation
  // stars, the implosion cone). grow scales per second (negative = collapse).
  private fadeProps: {
    obj: THREE.Object3D; mats: THREE.Material[]; life: number; max: number;
    spin: number; grow: number; s0: number; pop: boolean;
  }[] = [];
  // Level-up ring (D4-style halo): fire-and-forget, host-local — not tied to
  // sim state, unlike the persistent pingRings/reviveRings pools. One ring
  // per emitLevelUp call, expanding + fading over its lifetime then dropped.
  private levelRings: { mesh: THREE.Mesh; life: number; max: number }[] = [];

  // Animation / juice state (all host-side cosmetics; sim stays pure).
  // Last-frame combat state per player: the clip machine fires on EDGES
  // (cooldowns jumping up = a cast; overcharge falling = the spend; etc.).
  private animPrev = new Map<number, {
    swing: number; dash: number; alive: boolean; overcharged: boolean;
    cd: Partial<Record<string, number>>; flask?: number;
  }>();
  // Sponsor Slurp™: seconds the potion prop stays in the off hand.
  private potionShow = new Map<number, number>();
  // Continuous body-FX emitters (banked states + status effects), per player:
  // seconds until the next glow puff.
  private playerFxTick = new Map<number, number>();
  // The Briar Witch's mark: a violet sigil over the cursed crawler.
  private hexMarks = new Map<number, THREE.Mesh>();
  private prevLootBoxes = -1; // loot-box grant edge (-1 = first frame, no drop)
  // Floor-clear celebration edge (monster count > 0 -> 0 while still playing).
  private prevMonsterCount = -1;
  private prevStatus = "playing";
  private loadoutKeys = new Map<number, string>(); // player id -> applied weapon/shield key
  // Extradition stow: hands go to the chain, the weapon vanishes 'til the cast
  // is done (seconds left, per player). Restored explicitly — applyLoadout's
  // same-key early-return means nothing else would flip visibility back.
  private weaponStow = new Map<number, number>();
  private prevTime = 0;
  // Trauma-based screen shake: hits add trauma (clamped 0..1), the applied
  // amplitude is trauma SQUARED — chip damage barely whispers, boss slams and
  // airstrikes kick — and trauma decays linearly so shakes settle fast.
  private trauma = 0;
  private static SHAKE_MAX = 0.5; // world-unit amplitude at full trauma
  private addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  private particles: {
    mesh: THREE.Mesh;
    vx: number; vy: number; vz: number; life: number; max: number;
  }[] = [];
  private sharedParticleGeo = new THREE.TetrahedronGeometry(0.09, 0);
  // Additive glow sprites (projectile trails, magic bursts). The texture is a
  // canvas radial gradient — procedural, so the FX layer needs no image assets.
  private fxSprites: { sprite: THREE.Sprite; life: number; max: number; grow: number }[] = [];
  // Extradition chains: a run of iron links strung caster -> anchor (plus the
  // gavel head at the far end), fading fast as one.
  private chainFx: { group: THREE.Group; mats: THREE.Material[]; life: number; max: number }[] = [];
  private sharedLinkGeo = new THREE.BoxGeometry(0.22, 0.05, 0.1);
  private glowTex: THREE.Texture | null = null;
  // Contact-shadow blobs: shared geometry + material for the soft dark discs
  // grounding every character, monster and prop (cheap, guaranteed under
  // software GL where the shadow map alone can read faint).
  private blobGeo: THREE.BufferGeometry | null = null;
  private blobMat: THREE.MeshBasicMaterial | null = null;
  // Torch flame glow cores (one per anchor), flickered per frame + fog-gated.
  private flameSprites: { s: THREE.Sprite; seed: number; base: number; tile: number; role: 0 | 1 | 2; baseOp: number }[] = [];
  private strikeMeshes: THREE.Object3D[] = []; // falling airstrike shells (pooled)
  private prevStrikeCount = 0;
  private prevStrikePos: { x: number; y: number }[] = [];

  private glowTexture(): THREE.Texture {
    if (this.glowTex) return this.glowTex;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.glowTex = new THREE.CanvasTexture(c);
    return this.glowTex;
  }

  /** Shared soft-disc resources for contact blobs (radial alpha, black). */
  private blobResources(): { geo: THREE.BufferGeometry; mat: THREE.MeshBasicMaterial } {
    if (!this.blobGeo) this.blobGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    if (!this.blobMat) {
      this.blobMat = new THREE.MeshBasicMaterial({
        map: this.glowTexture(), color: 0x000000, transparent: true,
        opacity: 0.36, depthWrite: false,
      });
    }
    return { geo: this.blobGeo, mat: this.blobMat };
  }

  /** Ground an entity: a soft contact-shadow disc child at its feet, sized in
   * WORLD units (compensates the group's current uniform scale). */
  private addBlobShadow(g: THREE.Object3D, worldR: number): void {
    const gs = g.scale.x || 1;
    const { geo, mat } = this.blobResources();
    const blob = new THREE.Mesh(geo, mat);
    blob.position.y = 0.028 / gs;
    blob.scale.setScalar(worldR / gs);
    blob.renderOrder = 1;
    blob.userData.noAO = true;
    g.add(blob);
  }

  private makeGlow(color: number, size: number): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture(), color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.scale.setScalar(size);
    return s;
  }

  /** Fire-and-forget glow puff (trails, bursts). */
  private spawnGlow(x: number, y: number, z: number, color: number, size: number, max = 0.35, grow = 0): void {
    if (this.fxSprites.length > 240) return; // cap
    const sprite = this.makeGlow(color, size);
    sprite.position.set(x, y, z);
    this.scene.add(sprite);
    this.fxSprites.push({ sprite, life: 0, max, grow });
  }

  /** Radial burst of glow puffs (novas, impacts). */
  private burst(x: number, z: number, color: number, count: number, size: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      this.spawnGlow(x + Math.cos(a) * radius * 0.3, 0.5 + Math.random() * 0.4, z + Math.sin(a) * radius * 0.3,
        color, size * (0.7 + Math.random() * 0.6), 0.4 + Math.random() * 0.25, radius * 2.2);
    }
  }

  /** White additive HIT-FLASH on a struck monster: its body materials are
   * cloned lazily on the first hit (after every other cloning — elite skins,
   * affix tints — has already run) and emissive is driven straight from the
   * sim's hitFlash timer, so for ~2-3 frames the struck body is the
   * brightest thing in the frame and the bloom pass catches it. */
  private applyHitFlash(mesh: THREE.Group, hitFlash: number): void {
    const ud = mesh.userData;
    if (hitFlash > 0 && !ud.flashMats) {
      const list: { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] = [];
      mesh.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh || !mm.material || mm.userData.noAO) return;
        const swap = (m: THREE.Material): THREE.Material => {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.isMeshStandardMaterial) return m;
          const c = std.clone();
          // Material.clone() drops injected shader stages — carry the rim
          // light (applyRimLight) through, or the first hit would strip a
          // monster's silhouette pop for the rest of its life.
          if (Object.prototype.hasOwnProperty.call(std, "onBeforeCompile")) {
            c.onBeforeCompile = std.onBeforeCompile;
            c.customProgramCacheKey = std.customProgramCacheKey.bind(std);
          }
          list.push({ m: c, e: c.emissive.clone(), i: c.emissiveIntensity });
          return c;
        };
        mm.material = Array.isArray(mm.material) ? mm.material.map(swap) : swap(mm.material);
      });
      ud.flashMats = list;
    }
    const list = ud.flashMats as { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] | undefined;
    if (!list) return;
    const f = hitFlash > 0 ? Math.min(1, hitFlash / 0.12) : 0;
    const on = f > 0;
    if (!on && !ud.flashOn) return; // settled — nothing to restore
    ud.flashOn = on;
    for (const it of list) {
      if (on) {
        it.m.emissive.setRGB(1, 1, 1);
        it.m.emissiveIntensity = it.i + 1.15 * f;
      } else {
        it.m.emissive.copy(it.e);
        it.m.emissiveIntensity = it.i;
      }
    }
  }

  // Melee weapon trail: a short-lived additive arc swept in front of the
  // attacker on every swing — the swing has a SHAPE now, not just a lunge.
  private meleeTrails: { mesh: THREE.Mesh; life: number; max: number }[] = [];
  private meleePrevSwing = new Map<number, number>();
  private trailGeo: THREE.BufferGeometry | null = null;
  private spawnMeleeTrail(anchor: THREE.Object3D): void {
    if (this.meleeTrails.length > 6) return;
    if (!this.trailGeo) {
      // Arc centered on local +Z (the facing axis), lying flat.
      this.trailGeo = new THREE.RingGeometry(0.5, 1.25, 24, 1, -Math.PI / 2 - 1.05, 2.1).rotateX(-Math.PI / 2);
    }
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe9b8, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const trail = new THREE.Mesh(this.trailGeo, mat);
    trail.position.set(anchor.position.x, 0.72, anchor.position.z);
    trail.rotation.y = anchor.rotation.y;
    trail.scale.setScalar(0.82);
    this.scene.add(trail);
    this.meleeTrails.push({ mesh: trail, life: 0, max: 0.16 });
  }

  // LOOK EXPERIMENT (iso.html?look=lived&view=close): "lived" densifies the
  // dungeon with the KayKit Dungeon Remastered modular pieces — doorway
  // arches at room mouths, gated/window wall variants, corridor grates,
  // interior pillars, Sewers water pools, a higher prop budget. "close"
  // zooms the camera in by a third so the furnishing fills the frame.
  // (A near-overhead "top" view was tried 2026-07-10 and rejected — the iso
  // pitch stays.) Cosmetic only.
  private look: "lived" | null = null;
  private viewClose = false;

  /** Toggle the close (1/3 tighter) framing at runtime — the K-panel setting.
   *  Callers follow up with resize() so the frustum recomputes. */
  setCloseView(on: boolean): void {
    this.viewClose = on;
  }

  constructor(canvas: HTMLCanvasElement, opts: { look?: "lived"; view?: "close" } = {}) {
    this.look = opts.look ?? null;
    this.viewClose = opts.view === "close";
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic pipeline: linear HDR through the composer, ACES + sRGB applied by
    // OutputPass (and by the renderer itself for direct-to-screen renders like
    // the campfire select scene, which shares this GL context).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = THEME.toneExposure;

    this.scene.background = new THREE.Color(THEME.background);
    this.scene.fog = new THREE.Fog(THEME.fog, THEME.fogNear, THEME.fogFar);

    // Fixed orthographic iso camera (frustum set in resize()).
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    // Lighting: colored ambient + hemisphere fill, one shadow-casting warm key,
    // a cool rim accent from behind-left, torches + FX lights pooled per floor.
    this.ambientLight = new THREE.AmbientLight(THEME.ambient, THEME.ambientIntensity);
    this.scene.add(this.ambientLight);
    this.hemi = new THREE.HemisphereLight(THEME.hemiSky, THEME.hemiGround, THEME.hemiIntensity);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(THEME.keyLight, THEME.keyIntensity);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.normalBias = 0.035; // kills acne without peter-panning at this scale
    const c = this.key.shadow.camera as THREE.OrthographicCamera;
    c.left = -18; c.right = 18; c.top = 18; c.bottom = -18; c.near = 1; c.far = 60;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    // Shadow-space basis for texel snapping (key offset is constant: +8,20,+6).
    const lightDir = new THREE.Vector3(-8, -20, -6).normalize();
    this.shadowRight.crossVectors(lightDir, new THREE.Vector3(0, 1, 0)).normalize();
    this.shadowUp.crossVectors(this.shadowRight, lightDir).normalize();
    this.rim = new THREE.DirectionalLight(DEFAULT_MOOD.rim, DEFAULT_MOOD.rimIntensity);
    this.scene.add(this.rim);
    this.scene.add(this.rim.target);

    // The void disc: out-of-bounds ground gradient (retinted per band).
    {
      const geo = new THREE.CircleGeometry(140, 48).rotateX(-Math.PI / 2);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uInner: { value: new THREE.Color(DEFAULT_MOOD.voidInner) },
          uOuter: { value: new THREE.Color(DEFAULT_MOOD.voidOuter) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vPos;
          void main() {
            vPos = position.xz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uInner;
          uniform vec3 uOuter;
          varying vec2 vPos;
          void main() {
            float t = smoothstep(4.0, 34.0, length(vPos));
            gl_FragColor = vec4(mix(uInner, uOuter, t), 1.0);
          }`,
      });
      this.voidPlane = new THREE.Mesh(geo, mat);
      this.voidPlane.position.y = -0.22;
      this.voidPlane.renderOrder = -5;
      this.voidPlane.userData.noAO = true;
      this.scene.add(this.voidPlane);
    }

    this.scene.add(this.floorGroup);
    this.scene.add(this.fogBank.group);
    this.scene.add(this.ambientFx.group);
    // World-lit materials erode their fog frontier with the bank's own noise.
    this.wl.uWlNoise.value = this.fogBank.noiseTexture;

    // Post chain. The composer target is multisampled (WebGL2) so geometry AA
    // survives; HalfFloat keeps the pipeline HDR until OutputPass tone-maps.
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      samples: this.renderer.capabilities.isWebGL2 ? 4 : 0,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new WorldGTAOPass(this.scene, this.camera, 2, 2);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({
      radius: 0.55, distanceExponent: 1, thickness: 1, scale: 1.3,
      samples: 12, distanceFallOff: 1, screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({
      lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4,
      radiusExponent: 1, rings: 2, samples: 8,
    });
    this.composer.addPass(this.gtao);
    // Thresholded above the tone-map knee: only emissives, torch cores, and
    // additive FX bloom — the frame itself stays crisp. Wide soft kernel so
    // flames BLEED into the dark instead of halting at a tight halo.
    // Threshold above the tone-map knee so only true emitters bloom, and a
    // modest strength — flame cores are TINTED sprites now, so the pass
    // spreads colored light instead of flattening cores to white discs.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.5, 0.7, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
  }

  async init(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    // Streaming load: init resolves after the PRIORITY wave (hero + core
    // dungeon shell — a few files), so boot is near-instant. The remaining
    // ~200 GLBs stream behind the running game; each arrival schedules a
    // debounced refresh that swaps procedural stand-ins for the real thing.
    const store = startModelLoad(onProgress);
    this.models = store.models; // LIVE record — fills in as assets land
    store.onArrive = () => this.scheduleAssetRefresh();
    await store.ready;
    this.scheduleAssetRefresh();
  }

  /**
   * A background asset landed: drop cached meshes built from stand-ins and
   * force a floor rebuild, all debounced so a burst of arrivals costs one
   * refresh. Mirrors the mid-fight morph path — markers/telegraphs keyed by
   * entity id survive; only the body meshes rebuild on the next update.
   */
  private assetRefresh: ReturnType<typeof setTimeout> | null = null;
  private scheduleAssetRefresh(): void {
    if (this.assetRefresh !== null) clearTimeout(this.assetRefresh);
    this.assetRefresh = setTimeout(() => {
      this.assetRefresh = null;
      this.builtFloor = -1; // next update() rebuilds the floor with real tiles
      for (const mesh of this.playerMeshes.values()) this.scene.remove(mesh);
      this.playerMeshes.clear();
      for (const mesh of this.decoyMeshes.values()) this.scene.remove(mesh);
      this.decoyMeshes.clear();
      for (const mesh of this.breakableMeshes.values()) this.scene.remove(mesh);
      this.breakableMeshes.clear();
      for (const mesh of this.monsters.values()) this.scene.remove(mesh);
      this.monsters.clear();
    }, 350);
  }

  /** The campfire check-in scene shares this renderer's GL context + streamed
   *  models (empty slots fill as GLBs arrive). main3d drives it while the
   *  menu is open instead of rendering the game world. */
  createCharSelect(initial: CrawlerSkin): CharSelectScene {
    // Getter, not snapshot: `this.models` is reassigned when streaming starts.
    return new CharSelectScene(this.renderer, () => this.models, initial);
  }

  /** Clone a loaded glTF model if present, else null (caller falls back to primitives). */
  private modelInstance(key: string): THREE.Group | null {
    const m = this.models[key];
    if (!m) return null;
    // SkeletonUtils.clone: a plain .clone() leaves skinned meshes bound to the
    // source skeleton, which renders as a mangled/collapsed pose.
    const g = cloneSkinned(m.scene) as THREE.Group;
    // KayKit characters ship their whole class arsenal visible at once; show one
    // clean canonical loadout instead (players get theirs from equipment).
    const attachments = ATTACHMENT_NODES[key];
    if (attachments) {
      const canonical = CANONICAL_LOADOUT[key] ?? [];
      for (const name of attachments) {
        const node = g.getObjectByName(name);
        if (node) node.visible = canonical.includes(name);
      }
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    if (m.animations.length) this.attachClipAnimator(g, m.animations);
    return g;
  }

  /** Scale a model so its bounding-box height matches the given world height. */
  private normalizeHeight(g: THREE.Group, target: number): void {
    const box = new THREE.Box3().setFromObject(g);
    const h = box.max.y - box.min.y;
    if (h > 1e-4) g.scale.multiplyScalar(target / h);
  }

  /**
   * Wire an AnimationMixer over the full KayKit moveset (clip names matched
   * fuzzily so any humanoid pack works; missing clips simply aren't registered).
   * Exposes on userData:
   *   mixer               — for external ticking (corpses)
   *   play(name, force?)  — crossfade to a clip; one-shots clamp and set `busy`
   *   playFirst(...names) — play the first name that exists (fallback chains)
   *   hasClip(name)       — availability probe
   *   animTick(dt)        — advance mixer + drain the busy timer
   *   animBusy()          — seconds left of the current one-shot (0 = interruptible)
   */
  private attachClipAnimator(g: THREE.Group, clips: THREE.AnimationClip[]): void {
    const pick = (...res: RegExp[]) => {
      for (const re of res) {
        const c = clips.find((c) => re.test(c.name));
        if (c) return c;
      }
      return null;
    };
    // Two clip-name generations coexist: the 1.0 packs baked into characters
    // ("1H_Melee_Attack_Chop", "Spellcast_Shoot") and the shared rig libraries
    // ("Melee_1H_Attack_Chop", "Ranged_Magic_Shoot") attached at load time to
    // the newer animation-less characters. Every pick chains both spellings.
    const found: Record<string, THREE.AnimationClip | null> = {
      // Locomotion + idles (looping)
      idle: pick(/^idle$/i, /^idle_a$/i, /^idle/i, /idle/i),
      idle_brawler: pick(/2H_Melee_Idle/i, /Melee_2H_Idle/i, /Idle_Combat/i), // stance: weapon up
      idle_deadeye: pick(/1H_Ranged_Aiming/i, /Ranged_1H_Aiming/i), // stance: sighting down the barrel
      walk: pick(/^walking_a$/i, /^walk/i, /walk/i, /^run/i, /run/i),
      run: pick(/^running_a$/i, /^run/i),
      walk_back: pick(/Walking_Backwards/i),
      strafe_left: pick(/Running_Strafe_Left/i),
      strafe_right: pick(/Running_Strafe_Right/i),
      // Attacks (one-shot). melee_a..d cycle as a swing combo.
      attack: pick(/melee.*attack/i, /attack/i, /slice|chop|stab|slash|slam/i),
      melee_a: pick(/1H_Melee_Attack_Chop/i, /Melee_1H_Attack_Chop/i, /Melee_1H_Slash/i),
      melee_b: pick(/1H_Melee_Attack_Slice_Diagonal/i, /Melee_1H_Attack_Slice_Diagonal/i, /Melee_1H_Stab/i),
      melee_c: pick(/1H_Melee_Attack_Slice_Horizontal/i, /Melee_1H_Attack_Slice_Horizontal/i),
      melee_d: pick(/1H_Melee_Attack_Stab/i, /Melee_1H_Attack_Stab/i),
      spin: pick(/2H_Melee_Attack_Spin\b/i, /Melee_2H_Attack_Spin\b/i, /Spinning/i), // overcharged swings
      shoot: pick(/1H_Ranged_Shoot$/i, /Spellcast_Shoot/i, /Ranged_Magic_Shoot$/i, /Ranged_1H_Shoot$/i, /Ranged_Bow_Release$/i),
      cast_raise: pick(/Spellcast_Raise/i, /Ranged_Magic_Raise/i), // nova: raise-and-burst
      cast_long: pick(/Spellcast_Long/i, /Spellcasting/i, /Ranged_Magic_Shooting/i), // overcharge: banking power
      cast_summon: pick(/Spellcast_Summon/i, /Spellcast_Raise/i, /Ranged_Magic_Raise/i), // ultimates: call it down
      block: pick(/^Block$/i, /^Blocking$/i, /^Melee_Block$/i, /^Melee_Blocking$/i), // stance-swap flourish
      blocking: pick(/^Melee_Blocking$/i, /^Blocking$/i), // shieldbearer's held guard (looping)
      block_hit: pick(/Block_Hit/i), // shielded elites soak hits on the shield (both gens contain this)
      dodge: pick(/Dodge_Forward/i, /Dodge_Right/i), // dash
      throw: pick(/^Throw$/i), // melee-class sidearm bolt
      extradition: pick(/^Extradition$/i), // crowdsurf cast: crouch, grab the chain, heave (AI-retargeted clip)
      drink: pick(/^Flask_Drink$/i), // Sponsor Slurp™: the crawler actually drinks
      summon_double: pick(/^Stunt_Double_Cast$/i), // a gentleman's bow as the professional takes the stage
      spellshoot: pick(/^Spellcast_Shoot$/i, /^Ranged_Magic_Shoot$/i), // arcane bolt (magic missiles)
      // Reactions + exits (one-shot)
      hit: pick(/^hit_a$/i, /^hit/i, /hit|impact|react/i),
      hit_b: pick(/^Hit_B$/i),
      death: pick(/^death_a$/i, /^death/i, /death|die/i),
      death_b: pick(/^Death_B$/i),
      // Theater (one-shot)
      awaken: pick(/Skeletons_Awaken_Floor$/i, /^Spawn_Ground$/i, /^Skeletons_Spawn_Ground$/i), // rise on first reveal
      taunt: pick(/Taunt_Longer/i, /^Taunt$/i, /Skeletons_Taunt$/i), // ringside introductions
      cheer: pick(/^Cheer/i), // floor clear / victory lap
      // The Drum Sergeant's beat: General's Interact reads as pounding the
      // wardrum when looped (Use_Item is the fallback gesture).
      drum: pick(/^Interact$/i, /^Use_Item$/i),
      // Lineworker/greeter piston punch (unarmed haymaker; kick as variety).
      punch: pick(/Unarmed_Attack_Punch/i, /Unarmed_Attack_Kick/i),
      // MovementAdvanced pack: the unnoticed Repo Rat creeps, it doesn't stroll.
      sneak: pick(/^Sneaking$/i),
      // The transformation act, both rigs: the understudy's morph (medium)
      // and the boss phase-up (large) — clips bind by rig, so one key serves.
      transform: pick(/EXPERIMENTAL_Medium_Transform/i, /Large_Transform/i),
      // Dormancy poses (Special library): ambush packs LIE on the floor among
      // the bones; greeters STAND perfectly still among the props.
      dormant_floor: pick(/Skeletons_Inactive_Floor_Pose/i),
      dormant_stand: pick(/Skeletons_Inactive_Standing_Pose/i, /^T-Pose$/i),
      // RESIDENT STAGING (PHYSICALITY.md §2): the simulation + tools
      // libraries put real verbs in the idle slot — dinner, sleep, the
      // forge's hammer, kitchen prep, drills. Medium rig only; large-rig
      // residents (brutes) gracefully fall through to plain idle.
      stage_sit: pick(/^Sit_Floor_Idle$/i, /^Sit_Chair_Idle$/i),
      stage_lie: pick(/^Lie_Idle$/i),
      stage_hammer: pick(/^Hammering$/i, /^Hammer$/i),
      stage_chop: pick(/^Chopping$/i, /^Chop$/i),
      stage_work_a: pick(/^Working_A$/i, /^Work_A$/i),
      stage_work_b: pick(/^Working_B$/i, /^Work_B$/i),
      stage_hold: pick(/^Holding_B$/i, /^Holding_A$/i),
      stage_pushups: pick(/^Push_Ups$/i),
      stage_idle_b: pick(/^Idle_B$/i),
      stage_sit_chair: pick(/^Sit_Chair_Idle$/i),
      // THE RISE (staging v2): scene-break stand-up transitions. One-shots —
      // the busy timer holds locomotion off until the actor is upright.
      stage_rise_sit: pick(/^Sit_Floor_StandUp$/i, /^Sit_Chair_StandUp$/i),
      stage_rise_chair: pick(/^Sit_Chair_StandUp$/i, /^Sit_Floor_StandUp$/i),
      stage_rise_lie: pick(/^Lie_StandUp$/i),
    };
    // Everything except locomotion/idles plays once then yields via the busy timer.
    const LOOPING = new Set([
      "idle", "idle_brawler", "idle_deadeye", "walk", "run", "walk_back",
      "strafe_left", "strafe_right", "drum", "dormant_floor", "dormant_stand",
      "sneak", "blocking",
      // Staged resident verbs hold their loop until the scene breaks.
      "stage_sit", "stage_sit_chair", "stage_lie", "stage_hammer", "stage_chop",
      "stage_work_a", "stage_work_b", "stage_hold", "stage_pushups", "stage_idle_b",
    ]);
    // Retime one-shots to combat tempo (seconds); unlisted one-shots run natural.
    const TARGET: Record<string, number> = {
      attack: 0.3, melee_a: 0.32, melee_b: 0.32, melee_c: 0.32, melee_d: 0.32,
      spin: 0.5, shoot: 0.3, throw: 0.3, spellshoot: 0.35, extradition: 0.55,
      drink: 0.8, summon_double: 0.9,
      cast_raise: 0.5, cast_long: 0.6, cast_summon: 0.6,
      block: 0.35, dodge: 0.35, awaken: 0.9, cheer: 1.4,
    };
    const mixer = new THREE.AnimationMixer(g);
    const actions: Record<string, THREE.AnimationAction> = {};
    const durations: Record<string, number> = {};
    for (const [name, clip] of Object.entries(found)) {
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      if (!LOOPING.has(name)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true; // hold the last frame; the next play() resets pose
        if (TARGET[name]) a.timeScale = Math.max(1, clip.duration / TARGET[name]);
      }
      durations[name] = clip.duration / (a.timeScale || 1);
      actions[name] = a;
    }
    let current = "";
    let busy = 0;
    g.userData.mixer = mixer;
    g.userData.hasClip = (name: string) => !!actions[name];
    const play = (name: string, force = false) => {
      const next = actions[name];
      if (!next || (current === name && !force)) return;
      const prev = actions[current];
      next.reset().play();
      if (prev && prev !== next) prev.crossFadeTo(next, 0.12, false);
      current = name;
      if (!LOOPING.has(name)) busy = durations[name];
    };
    g.userData.play = play;
    g.userData.playFirst = (...names: string[]) => {
      for (const n of names) if (actions[n]) { play(n, true); return; }
    };
    g.userData.animTick = (dt: number) => {
      mixer.update(dt);
      if (busy > 0) busy = Math.max(0, busy - dt);
      const hold = g.userData.locoHold as number | undefined;
      if (hold && hold > 0) g.userData.locoHold = Math.max(0, hold - dt);
    };
    g.userData.animBusy = () => busy;
  }

  /**
   * Drive a rigged player's clips from sim-state EDGES: a dash starts a dodge,
   * each swing advances the melee combo (an overcharged spend becomes the spin),
   * casts map per ability, and locomotion picks run/backpedal/strafe from where
   * the feet actually go vs where the body faces. One-shots own the rig until
   * their busy timer drains, so nothing gets stomped mid-swing.
   */
  private animateRiggedPlayer(mesh: THREE.Group, pl: Player, plSpeed: number, move: Vec2, dt: number): void {
    const ud = mesh.userData;
    const play = ud.play as (n: string, force?: boolean) => void;
    const playFirst = ud.playFirst as (...n: string[]) => void;
    const hasClip = ud.hasClip as (n: string) => boolean;
    const prev = this.animPrev.get(pl.id) ?? { swing: 0, dash: 0, alive: true, overcharged: false, cd: {}, flask: pl.flaskCharges };
    const cds = pl.cd as Partial<Record<string, number>>;
    const cdRose = (a: string) => (cds[a] ?? 0) > (prev.cd[a] ?? 0) + 1e-6;

    if (!pl.alive) {
      if (prev.alive) {
        ud.deathClip = Math.random() < 0.5 && hasClip("death_b") ? "death_b" : "death";
      }
      play(ud.deathClip as string ?? "death");
    } else {
      if (!prev.alive) play("idle", true); // revived on descent: stand back up
      const spentCharge = prev.overcharged && !pl.overcharged;
      if (cdRose("crowdsurf")) {
        // Extradition: one chain, two verbs. Checked before the dash branch —
        // the heavy-target verb bumps dashTime too and would read as a dodge.
        playFirst("extradition", "throw", "attack");
        this.weaponStow.set(pl.id, 0.55); // both hands on the chain
      } else if (pl.flaskCharges < (prev.flask ?? pl.flaskCharges)) {
        // Sponsor Slurp™: weapon away, bottle up. The potion prop rides the
        // off hand for the sip (toggled by the same stow-style timer).
        playFirst("drink", "cast_raise");
        this.weaponStow.set(pl.id, 0.8);
        this.potionShow.set(pl.id, 0.8);
      } else if (cdRose("stuntdouble")) {
        // The production hires a professional: a gentleman's bow as the
        // double takes the stage.
        playFirst("summon_double", "cast_summon", "taunt");
      } else if (pl.dashTime > prev.dash + 1e-6) {
        playFirst("dodge");
      } else if (pl.attackSwing > prev.swing + 1e-6) {
        if (spentCharge && hasClip("spin")) {
          play("spin", true); // the banked swing is a different animal
        } else {
          const combo = ["melee_a", "melee_b", "melee_c", "melee_d"].filter(hasClip);
          if (combo.length > 0) {
            ud.combo = (((ud.combo as number | undefined) ?? -1) + 1) % combo.length;
            play(combo[ud.combo as number], true);
          } else {
            play("attack", true);
          }
        }
      } else if (cdRose("bolt")) {
        // The cast matches the weapon: casters conjure, melee crawlers THROW.
        const wc = weaponClassOf(pl.equipment.weapon);
        if (wc === "arcane") playFirst("spellshoot", "shoot", "attack");
        else if (wc === "ballistic" || wc === null) playFirst("shoot", "attack");
        else playFirst("throw", "shoot", "attack");
      }
      else if (cdRose("nova")) playFirst("cast_raise", "attack");
      else if (cdRose("overcharge")) playFirst("cast_long", "cast_raise");
      else if (cdRose("stance")) playFirst("block");
      else if (cdRose("airstrike") || cdRose("cataclysm") || cdRose("bullettime")) playFirst("cast_summon", "cast_raise");
      else if ((ud.animBusy as () => number)() <= 0) this.playLocomotion(mesh, pl, plSpeed, move);
    }
    this.animPrev.set(pl.id, {
      swing: pl.attackSwing, dash: pl.dashTime, alive: pl.alive,
      overcharged: pl.overcharged, cd: { ...cds }, flask: pl.flaskCharges,
    });
    (ud.animTick as (dt: number) => void)(dt);
  }

  /**
   * Per-frame velocity of the SMOOTHED mesh, EMA'd over ~100ms (stored on
   * userData). This is what the eye tracks, it is nonzero on every frame while
   * moving, and the smoothing means no boundary in the clip machine ever sees
   * frame-to-frame noise. Teleport-sized samples (floor change, respawn snap)
   * reset the average instead of polluting it.
   */
  private smoothedVel(mesh: THREE.Group, dt: number): Vec2 {
    const ud = mesh.userData;
    const ix = ud.lastX === undefined ? 0 : (mesh.position.x - (ud.lastX as number)) / dt;
    const iz = ud.lastZ === undefined ? 0 : (mesh.position.z - (ud.lastZ as number)) / dt;
    ud.lastX = mesh.position.x;
    ud.lastZ = mesh.position.z;
    if (Math.hypot(ix, iz) > 25) {
      ud.velX = 0; ud.velZ = 0; // teleport, not movement
    } else {
      const k = Math.min(1, dt / 0.1);
      ud.velX = ((ud.velX as number) ?? 0) + (ix - ((ud.velX as number) ?? 0)) * k;
      ud.velZ = ((ud.velZ as number) ?? 0) + (iz - ((ud.velZ as number) ?? 0)) * k;
    }
    return { x: ud.velX as number, y: ud.velZ as number };
  }

  /**
   * Feet vs facing: forward run/walk, backpedal when retreating under aim,
   * strafes sideways. Every boundary (idle/moving, walk/run, direction) has
   * hysteresis, and a switched-to clip is held for a beat — a locomotion cycle
   * that can't complete a stride reads as stutter, not animation.
   */
  private playLocomotion(mesh: THREE.Group, pl: Player, speed: number, move: Vec2): void {
    const ud = mesh.userData;
    const play = ud.play as (n: string, force?: boolean) => void;
    const hasClip = ud.hasClip as (n: string) => boolean;
    ud.locoMoving = (ud.locoMoving as boolean) ? speed > 0.5 : speed > 0.9;
    let target: string;
    if (!ud.locoMoving) {
      // Idle broadcasts the stance: Brawler squares up, Deadeye sights the lane.
      target = pl.abilities.slots.includes("stance")
        ? (pl.stance === "melee" ? "idle_brawler" : "idle_deadeye")
        : "idle";
      if (!hasClip(target)) target = "idle";
    } else {
      const mx = move.x / speed, my = move.y / speed;
      const forward = mx * pl.facing.x + my * pl.facing.y;
      const side = pl.facing.x * my - pl.facing.y * mx; // >0: drifting left of facing
      // Direction only changes on a CLEAR read; inside the deadband keep the last.
      let cat = (ud.locoCat as string) ?? "fwd";
      if (forward > 0.65) cat = "fwd";
      else if (forward < -0.65) cat = "back";
      else if (Math.abs(side) > 0.75) cat = side > 0 ? "left" : "right";
      ud.locoCat = cat;
      ud.locoRun = (ud.locoRun as boolean) ? speed > 2.6 : speed > 3.4;
      target =
        cat === "back" ? "walk_back" :
        cat === "left" ? "strafe_left" :
        cat === "right" ? "strafe_right" :
        ud.locoRun ? "run" : "walk";
      if (!hasClip(target)) target = "walk";
    }
    if (target !== ud.locoClip) {
      if (((ud.locoHold as number) ?? 0) > 0) return; // let the current cycle breathe
      ud.locoClip = target;
      ud.locoHold = 0.25;
    }
    play(target);
  }

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /**
   * Map a canvas-space mouse position to sim coordinates by casting through the
   * iso camera onto the ground plane. Powers mouse-targeted attacks/bolts.
   */
  screenToGround(x: number, y: number): Vec2 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return { x: hit.x, y: hit.z };
  }

  /** Show/hide the click-to-move destination chip (null hides it). */
  setMoveMarker(pos: Vec2 | null): void {
    if (!pos) {
      if (this.moveMarker) this.moveMarker.visible = false;
      return;
    }
    if (!this.moveMarker) {
      this.moveMarker = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.3, 24),
        new THREE.MeshBasicMaterial({
          color: 0x5a87c6, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      this.moveMarker.rotation.x = -Math.PI / 2;
      this.scene.add(this.moveMarker);
    }
    this.moveMarker.visible = true;
    this.moveMarker.position.set(pos.x, 0.06, pos.y);
  }

  /**
   * Drag-to-aim ground telegraph (touch/controller): a gold line, ring, or
   * arrow from the player. kind null hides it. dir need not be normalized.
   */
  setAimIndicator(kind: "line" | "ring" | "arrow" | null, from?: Vec2, dir?: Vec2): void {
    if (!kind || !from) {
      if (this.aimIndicator) this.aimIndicator.visible = false;
      return;
    }
    if (!this.aimIndicator) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xc9a24b, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
      });
      const g = new THREE.Group();
      const line = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.2), mat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(2.1, 0, 0); // extends along +x from the player
      line.name = "line";
      const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.2, 40), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.name = "ring";
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.22), mat);
      shaft.rotation.x = -Math.PI / 2;
      shaft.position.set(1.1, 0, 0);
      const tip = new THREE.Mesh(new THREE.CircleGeometry(0.34, 3), mat);
      tip.rotation.x = -Math.PI / 2;
      tip.position.set(2.35, 0, 0);
      arrow.add(shaft, tip);
      arrow.name = "arrow";
      g.add(line, ring, arrow);
      g.position.y = 0.07;
      this.aimIndicator = g;
      this.scene.add(g);
    }
    const ind = this.aimIndicator;
    ind.visible = true;
    ind.position.set(from.x, 0.07, from.y);
    for (const child of ind.children) child.visible = child.name === kind;
    if (dir && (dir.x !== 0 || dir.y !== 0)) ind.rotation.y = -Math.atan2(dir.y, dir.x);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    // The composer multiplies by its own pixel ratio (captured from the
    // renderer at construction), so pass CSS pixels — same as setSize above.
    this.composer.setSize(w, h);
    this.aspect = w / h;
    // "close" view: a third more zoomed in — furnishing and character read
    // bigger; you see less of the floor at once.
    const hh = THEME.camOrthoHalfHeight * (this.viewClose ? 0.67 : 1);
    const hw = hh * this.aspect;
    this.camera.left = -hw; this.camera.right = hw;
    this.camera.top = hh; this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  // ---- Procedural meshes (placeholders for CC0 glTF art) ----

  // Hero skins (heroSkin in sim/game.ts): model key per skin id. Barbarian/
  // mage/rogue ride the armory_* GLBs (the 1.0 adventurers that also source
  // weapon meshes) — monsters wear the newer KayKit cast now, so hero skins
  // no longer overlap with the menagerie. CHOSEN campfire looks (Player.skin,
  // CRAWLER_SKINS) are namespaced `c:` — same names, different generation of
  // model — so a knight-by-choice never collides with a knight-by-seed.
  private static readonly SKIN_MODEL: Record<string, string> = {
    knight: "player", barbarian: "armory_axes", mage: "armory_arcana",
    rogue: "armory_knives", hooded: "hero_hooded",
    "c:knight": "crawler_knight", "c:barbarian": "crawler_barbarian",
    "c:druid": "crawler_druid", "c:engineer": "crawler_engineer",
    "c:mage": "crawler_mage", "c:ranger": "crawler_ranger",
    "c:rogue": "crawler_rogue", "c:hooded": "crawler_hooded",
  };

  /** The render skin id for a player: their campfire pick, else the seeded look. */
  static skinIdFor(pl: { id: number; skin?: string }, seed: number): string {
    return pl.skin && `c:${pl.skin}` in Renderer3D.SKIN_MODEL ? `c:${pl.skin}` : heroSkin(seed, pl.id);
  }

  private buildPlayerMesh(skin: string): THREE.Group {
    const model =
      this.modelInstance(Renderer3D.SKIN_MODEL[skin] ?? "player") ?? this.modelInstance("player");
    if (model) {
      this.normalizeHeight(model, 1.35);
      this.addBlobShadow(model, 0.42);
      // Hero rim, a touch warmer/stronger than the mobs': the player must
      // read FIRST in any wash (the all-green f5 complaint).
      this.applyRimLight(model, 0xcfe0ff, 0.5);
      model.userData.skinId = skin;
      return model;
    }
    const g = new THREE.Group();
    g.userData.skinId = skin;
    this.addBlobShadow(g, 0.42);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.5, 4, 8), flat(THEME.player));
    body.position.y = 0.55; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), flat(THEME.playerTrim));
    head.position.y = 1.05; head.castShadow = true;
    // Weapon along local +Z (forward) so it reads as "facing".
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.7), flat(THEME.weapon, { metalness: 0.4, roughness: 0.3 }));
    weapon.position.set(0.28, 0.6, 0.25); weapon.rotation.x = Math.PI / 2.6; weapon.castShadow = true;
    g.add(body, head, weapon);
    // Refs + rest pose used by the procedural animator (see animatePlayer).
    g.userData.body = body;
    g.userData.weapon = weapon;
    g.userData.weaponRestX = weapon.rotation.x;
    return g;
  }

  /**
   * Show the weapon/shield meshes matching a player's equipment. Native nodes
   * (the Knight's swords/shields) toggle visibility; foreign weapons (an axe
   * from the barbarian GLB) are cloned once and grafted onto the handslot.r
   * bone, where they ride the hand through every animation clip.
   */
  /**
   * Show one attachment on this rig: the native node if this skin's GLB ships
   * it, else a cached graft cloned from the source model onto the requested
   * hand bone. All adventurers share the KayKit rig, so a grafted node's local
   * transform relative to its own handslot carries over 1:1.
   */
  private showAttachment(mesh: THREE.Group, srcKey: string, node: string, hand: "l" | "r"): THREE.Object3D | null {
    let obj: THREE.Object3D | null =
      (node !== "*" ? mesh.getObjectByName(node) : null) ?? mesh.getObjectByName(`graft_${srcKey}_${node}`) ?? null;
    if (!obj) {
      // node "*": the whole GLB is the weapon (standalone Fantasy Weapons mesh,
      // grip modeled at origin — same convention as the rigs' handslot children).
      const srcNode = node === "*" ? this.models[srcKey]?.scene : this.models[srcKey]?.scene.getObjectByName(node);
      // GLTFLoader sanitizes node names ("handslot.r" -> "handslotr").
      const handObj = mesh.getObjectByName(`handslot${hand}`) ?? mesh.getObjectByName(`handslot.${hand}`);
      if (srcNode && handObj) {
        obj = srcNode.clone(true);
        obj.name = `graft_${srcKey}_${node}`;
        handObj.add(obj);
        const grafts = (mesh.userData.grafts as THREE.Object3D[]) ?? [];
        grafts.push(obj);
        mesh.userData.grafts = grafts;
      }
    }
    if (obj) obj.visible = true;
    return obj;
  }

  private applyLoadout(mesh: THREE.Group, pl: Player): void {
    const { weapon, shield } = loadoutFor(pl);
    const key = `${weapon.srcKey}/${weapon.node}/${shield ?? "-"}/${pl.equipment.weapon?.rarity ?? "-"}`;
    if (this.loadoutKeys.get(pl.id) === key) return;
    this.loadoutKeys.set(pl.id, key);

    // Hide every known attachment across ALL rigs — each skin ships its own
    // default arsenal, and a barbarian's axe must not photobomb your Blade —
    // plus any previous grafts.
    for (const name of Object.values(ATTACHMENT_NODES).flat()) {
      const node = mesh.getObjectByName(name);
      if (node) node.visible = false;
    }
    for (const g of (mesh.userData.grafts as THREE.Object3D[]) ?? []) g.visible = false;

    // Shield (armor slot) rides the off hand, unless the weapon needs both.
    if (shield) this.showAttachment(mesh, "player", shield, "l");
    // Weapon: native to this skin's rig, or a cached cross-model graft.
    const weaponObj = this.showAttachment(mesh, weapon.srcKey, weapon.node, "r");
    mesh.userData.weaponObj = weaponObj; // stow/restore handle (Extradition)
    // Idle ground-clearance: lift the blade a hair at the grip so long
    // weapons stop shaving the floor in the rest pose (once per graft).
    if (weaponObj && !weaponObj.userData.idleTilt) {
      weaponObj.userData.idleTilt = true;
      weaponObj.rotateX(-0.16);
    }

    // Rarity flair: emissive tint on the weapon's materials.
    if (weaponObj) {
      const glow = rarityGlow(pl.equipment.weapon?.rarity);
      weaponObj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        if (glow) {
          mat.emissive = new THREE.Color(glow.color);
          mat.emissiveIntensity = glow.intensity;
        } else {
          mat.emissive = new THREE.Color(0x000000);
          mat.emissiveIntensity = 0;
        }
        m.material = mat;
      });
    }
  }

  // Crafted-def alternate textures, loaded once per url (glTF convention:
  // flipY off, sRGB — same as the elite B-variants below).
  private defTex = new Map<string, THREE.Texture>();
  private defTexFor(url: string): THREE.Texture {
    let t = this.defTex.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      this.defTex.set(url, t);
    }
    return t;
  }

  // Elite B-variant textures, loaded once and shared (same UV atlas as the
  // embedded texture, recolored — glTF convention: flipY off, sRGB).
  private eliteTex = new Map<string, THREE.Texture>();
  private eliteTexFor(kind: string): THREE.Texture | null {
    const url = ELITE_TEXTURES[kind];
    if (!url) return null;
    let t = this.eliteTex.get(kind);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      this.eliteTex.set(kind, t);
    }
    return t;
  }

  /** Elite affix read: the pack's B-variant skin (a different individual),
   * an emissive tint in the affix's semantic color, and the chilling aura's
   * TRUE slow radius as a faint ring. Materials are cloned per elite — model
   * clones share materials, and trash mobs must stay unchanged. */
  private applyAffixVisual(mesh: THREE.Group, affix: string | undefined, kind?: string): void {
    const tint = affix ? AFFIX_TINT[affix] : undefined;
    if (tint === undefined) return;
    const skin = kind ? this.eliteTexFor(kind) : null;
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material || m.userData.noAO) return; // skip blob shadows
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
        const c = (mat as THREE.MeshStandardMaterial).clone();
        if (skin && c.map) c.map = skin; // recolor only textured surfaces
        c.emissive = new THREE.Color(tint);
        c.emissiveIntensity = 0.32;
        return c;
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    });
    if (affix === "chilling") {
      // The aura is spatial gameplay (you are slowed INSIDE it) — show the
      // actual radius, compensating for the parent's elite scale.
      const bs = mesh.scale.x || 1;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(CONFIG.chillingAuraRadius - 0.14, CONFIG.chillingAuraRadius, 40),
        new THREE.MeshBasicMaterial({
          color: 0x5a87c6, transparent: true, opacity: 0.22,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.scale.setScalar(1 / bs);
      mesh.add(ring);
    }
  }

  private buildMonsterMesh(kind: keyof typeof THEME.archetype, floor: number, elite?: boolean, def?: CustomMobDef): THREE.Group {
    const spec = THEME.archetype[kind];
    // A crafted def's chosen body wins; then a floor-named menace (city
    // bosses + the finale), then an elite skin variant when one exists (the
    // Creepy animatronic), then the archetype model, then the fallbacks.
    const model =
      (def?.skin ? this.modelInstance(def.skin) : null) ??
      (kind === "boss" ? this.modelInstance(`monster_boss_${floor}`) : null) ??
      (elite ? this.modelInstance(`monster_${kind}_elite`) : null) ??
      this.modelInstance(`monster_${kind}`) ??
      this.modelInstance("skeleton") ??
      this.modelInstance("monster");
    const g = model ?? new THREE.Group();
    if (model) this.normalizeHeight(model, 1.1);
    // The Drum Sergeant carries its actual instrument: wardrum in the off
    // hand, stick in the main — the same handslot graft the player armory
    // uses, so both props ride the Interact "drumming" loop.
    if (model && kind === "drummer") {
      const drum = this.showAttachment(g, "orc_wardrum", "*", "l");
      if (drum) drum.scale.setScalar(0.8);
      this.showAttachment(g, "orc_wardrum_stick", "*", "r");
    }
    // The Shieldbearer carries an actual tower shield + blade (player armory
    // grafts) — the frontal guard has to LOOK like a wall.
    if (model && kind === "shieldbearer") {
      this.showAttachment(g, "player", "Rectangle_Shield", "l");
      this.showAttachment(g, "weapon_sword_a", "*", "r");
    }
    // The Repo Rat carries the goods (Resource Bits pile, off hand); shown
    // only while mon.carry > 0 — the per-frame toggle lives in the update loop.
    if (model && kind === "filcher") {
      const loot = this.showAttachment(g, "money_pile_medium", "*", "l");
      if (loot) { loot.scale.setScalar(0.45); loot.visible = false; }
      g.userData.lootProp = loot;
    }
    if (!model) {
      const isBoss = kind === "boss";
      const body = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.4, isBoss ? 1 : 0),
        flat(spec.color, isBoss ? { emissive: 0x400000, emissiveIntensity: 0.5 } : {}),
      );
      body.position.y = 0.42; body.castShadow = true;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), flat(0x120000, { emissive: 0x330000 }));
      eye.position.set(0, 0.5, 0.32);
      g.add(body, eye);
    }
    // Fold the archetype size onto whatever scale the model normalization set
    // (a crafted def's scale multiplies on top).
    const base = (model ? g.scale.x : 1) * spec.scale * (def?.scale ?? 1);
    g.scale.setScalar(base);
    g.userData.baseScale = base;
    this.addBlobShadow(g, 0.44 * spec.scale);
    // Crafted alternate texture (the elites' B-skin mechanism, def-driven):
    // swap the map on textured surfaces so the same body reads as a
    // different individual. Cloned materials — trash mobs stay unchanged.
    if (def?.texture && model) {
      const tex = this.defTexFor(def.texture);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material || m.userData.noAO) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        if (mat.map) mat.map = tex;
        m.material = mat;
      });
    }
    // Crafted tint: the def's emissive accent on cloned materials.
    if (def?.tint !== undefined && model) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material || m.userData.noAO) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.emissive = new THREE.Color(def.tint!);
        mat.emissiveIntensity = 0.3;
        m.material = mat;
      });
    }
    // Figure-ground rim (LoL rule): a cool fresnel edge so a pack reads as
    // individuals against any floor wash instead of one silhouette soup.
    this.applyRimLight(g, 0x9fc4ff, 0.4);
    return g;
  }

  /** Roam mode (SETTLEMENTS.md v1): the settlement's one static resident. */
  private buildNpcMesh(): THREE.Group {
    const model = this.modelInstance("npc_settlement");
    const g = model ?? new THREE.Group();
    if (model) this.normalizeHeight(model, 1.1);
    if (!model) {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.35, 0.7, 4, 8),
        flat(0x6da356, {}), // verdant: the STYLEGUIDE's "friendly" semantic hue
      );
      body.position.y = 0.55; body.castShadow = true;
      g.add(body);
    }
    this.addBlobShadow(g, 0.45);
    return g;
  }

  /**
   * Ground-drop visuals: REAL models per loot kind — a coin (or stack) for
   * gold, a potion bottle for heals, the dungeon key, the mage's spellbook for
   * tomes, and for equipment the ACTUAL weapon/shield mesh you'd equip, tinted
   * by rarity. Anything without a model falls back to the classic octahedron.
   */
  private buildLootMesh(l: GameState["loot"][number]): THREE.Object3D {
    const fallback = (): THREE.Mesh => {
      const col = l.kind === "item" && l.rarity ? THEME.rarity[l.rarity] : this.lootColor(l.kind);
      return new THREE.Mesh(
        new THREE.OctahedronGeometry(0.2, 0),
        flat(col, { emissive: col, emissiveIntensity: 0.6 }),
      );
    };
    let obj: THREE.Object3D | null = null;
    let scale = 0.5;
    if (l.kind === "gold") {
      obj = this.modelInstance(l.amount > 10 ? "coin_stack_small" : "coin");
      scale = l.amount > 10 ? 0.45 : 0.55;
    } else if (l.kind === "heal") {
      obj = this.modelInstance("bottle_A_green");
      scale = 0.55;
    } else if (l.kind === "key") {
      obj = this.modelInstance("key");
      scale = 0.6;
    } else if (l.kind === "tome") {
      const book = this.models["armory_arcana"]?.scene.getObjectByName("Spellbook");
      if (book) { obj = book.clone(true); scale = 0.8; }
    } else if (l.kind === "shrine") {
      // System Shrine (floor event): a standing lantern reads as a fixture,
      // not a pickup — the purple halo below marks it as a System offer.
      obj = this.modelInstance("lantern_standing");
      scale = 0.85;
    } else if (l.kind === "service") {
      // A rolled System contract beside the furniture: this room takes
      // customers (roomPurposes phase 4). Gold halo = commerce.
      obj = this.modelInstance("map_rolled");
      scale = 0.5;
    } else if (l.kind === "item" && l.item) {
      const vis = groundVisualFor(l.item);
      const node = vis
        ? (vis.node === "*" ? this.models[vis.srcKey]?.scene : this.models[vis.srcKey]?.scene.getObjectByName(vis.node))
        : null;
      if (node) {
        obj = node.clone(true);
        scale = 0.8;
      } else if (l.item.slot === "trinket" || l.item.slot === "charm") {
        // No wearable mesh for these — they drop as a cut gem (Resource Bits).
        obj = this.modelInstance("gem_medium");
        scale = 0.55;
      }
      if (obj) {
        // Rarity tint on CLONED materials (the source scene keeps its own).
        const glow = rarityGlow(l.item.rarity);
        obj.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          if (glow) { mat.emissive = new THREE.Color(glow.color); mat.emissiveIntensity = glow.intensity; }
          mesh.material = mat;
        });
      }
    }
    if (!obj) return fallback();
    obj.scale.setScalar(scale);
    obj.rotation.z = l.kind === "item" ? Math.PI / 2.6 : 0; // weapons lie at an angle
    const group = new THREE.Group();
    group.add(obj);
    // A soft ground glow so drops read at a glance (gold for currency,
    // rarity-tinted for gear).
    const col = l.kind === "item" && l.rarity ? THEME.rarity[l.rarity] : this.lootColor(l.kind);
    const halo = this.makeGlow(col, 0.9);
    halo.position.y = -0.2;
    group.add(halo);
    // The ARPG loot beam: worthwhile drops throw a light pillar you can spot
    // across the room. Gear above common + ability tomes; commons stay quiet
    // so the beam keeps meaning.
    const beams = (l.kind === "item" && l.rarity && l.rarity !== "common") || l.kind === "tome";
    if (beams) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.13, 2.8, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.38,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      beam.position.y = 1.4;
      group.add(beam);
    }
    return group;
  }

  private lootColor(kind: string): number {
    if (kind === "tome") return 0x66f0c8; // ability tome: unmistakable teal
    if (kind === "key") return 0xffd23e; // stairs-district key: bright gold
    if (kind === "shrine") return 0xc58cff; // System Shrine: bargain purple
    if (kind === "service") return 0xc9a24b; // service contract: System gold
    return kind === "gold" ? THEME.gold : kind === "heal" ? THEME.heal : THEME.weaponLoot;
  }

  // ---- Floor geometry (rebuilt on descent) ----

  /**
   * Compressed GLBs (scripts/compress-assets.mjs) store attributes as
   * NORMALIZED integers — positions Int16, normals Int8, uvs Uint16 — with the
   * dequantize scale on the node matrix (KHR_mesh_quantization). Baking a
   * matrix into such an attribute renormalizes on write and CLAMPS at the ±1
   * quantization box, crushing any model larger than ~2 units into a spiky
   * blob (this blacked out the whole Garden band's trees). Expand to Float32
   * first so applyMatrix4 has real numbers to write into.
   */
  private static dequantize(src: THREE.BufferGeometry): THREE.BufferGeometry {
    const geo = src.clone();
    for (const name of Object.keys(geo.attributes)) {
      const a = geo.getAttribute(name);
      if (!a.normalized) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        out[i * a.itemSize] = a.getX(i); // getX/getY/… denormalize on read
        if (a.itemSize > 1) out[i * a.itemSize + 1] = a.getY(i);
        if (a.itemSize > 2) out[i * a.itemSize + 2] = a.getZ(i);
        if (a.itemSize > 3) out[i * a.itemSize + 3] = a.getW(i);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
    }
    return geo;
  }

  /**
   * Pull the largest mesh out of a manifest model as an instancing source, with a
   * scale that normalizes its footprint to one tile. Null when the model is absent.
   */
  private tileSource(key: string): { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; scale: number; box: THREE.Box3 } | null {
    const m = this.models[key];
    if (!m) return null;
    m.scene.updateMatrixWorld(true);
    let best: THREE.Mesh | null = null;
    let bestVol = -1;
    m.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const b = new THREE.Box3().setFromObject(mesh);
      const s = b.getSize(new THREE.Vector3());
      const vol = s.x * s.y * s.z;
      if (vol > bestVol) { bestVol = vol; best = mesh; }
    });
    if (!best) return null;
    const picked = best as THREE.Mesh;
    const geo = Renderer3D.dequantize(picked.geometry as THREE.BufferGeometry).applyMatrix4(picked.matrixWorld);
    geo.computeBoundingBox();
    const box = geo.boundingBox!.clone();
    const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    return { geo, mat: picked.material, scale: fp > 1e-4 ? 1 / fp : 1, box };
  }

  /**
   * Apply the band's cinematic mood: the 3-point rig (colored ambient fill,
   * warm key, cool rim), scene fog + background, the display grade
   * (split-tone + vignette), the void gradient, and the PMREM environment.
   */
  private applyMood(theme: FloorTheme, band: number): void {
    const mood: BandMood = theme.mood ?? DEFAULT_MOOD;
    this.ambientLight.color.set(mood.ambient);
    this.ambientLight.intensity = mood.ambientIntensity;
    this.hemi.color.set(mood.hemiSky);
    this.hemi.groundColor.set(mood.hemiGround);
    this.hemi.intensity = mood.hemiIntensity;
    this.key.color.set(mood.key);
    this.key.intensity = mood.keyIntensity;
    this.rim.color.set(mood.rim);
    this.rim.intensity = mood.rimIntensity;
    this.fogDark.set(mood.fogDark);

    this.scene.background = new THREE.Color(theme.background);
    (this.scene.fog as THREE.Fog).color.set(theme.background);

    const g = this.gradePass.uniforms;
    (g.uShadow.value as THREE.Color).set(mood.gradeShadow);
    const hi = g.uHighlight.value as THREE.Color;
    hi.set(mood.gradeHighlight);
    const luma = hi.r * 0.2126 + hi.g * 0.7152 + hi.b * 0.0722;
    if (luma > 1e-4) hi.multiplyScalar(1 / luma); // hue shift only, not exposure
    g.uSaturation.value = mood.gradeSaturation;
    g.uVignette.value = mood.vignette;
    (g.uVigColor.value as THREE.Color).set(mood.voidOuter);

    if (this.voidPlane) {
      const u = (this.voidPlane.material as THREE.ShaderMaterial).uniforms;
      (u.uInner.value as THREE.Color).set(mood.voidInner);
      (u.uOuter.value as THREE.Color).set(mood.voidOuter);
    }

    // Environment: a tiny gradient sky PMREM'd per band — metals and weapon
    // sheen pick up the district's palette at low intensity, keeping the flat
    // KayKit look while grounding speculars.
    let env = this.envCache.get(band) ?? null;
    if (!env) {
      if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
      const w = 16;
      const h = 8;
      const data = new Uint8Array(w * h * 4);
      const sky = new THREE.Color(mood.hemiSky);
      const horizon = new THREE.Color(mood.envHorizon);
      const ground = new THREE.Color(mood.ambient).multiplyScalar(0.35);
      const row = new THREE.Color();
      for (let y = 0; y < h; y++) {
        const v = y / (h - 1); // 0 = top of sky
        if (v < 0.5) row.copy(sky).lerp(horizon, v * 2);
        else row.copy(horizon).lerp(ground, (v - 0.5) * 2);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          data[i] = Math.round(row.r * 255);
          data[i + 1] = Math.round(row.g * 255);
          data[i + 2] = Math.round(row.b * 255);
          data[i + 3] = 255;
        }
      }
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      env = this.pmrem.fromEquirectangular(tex).texture;
      tex.dispose();
      this.envCache.set(band, env);
    }
    this.scene.environment = env;
    this.scene.environmentIntensity = mood.envIntensity;
  }

  private buildFloor(state: GameState): void {
    // Release the previous floor's GPU buffers. Tile geometries are per-build
    // clones (tileSource) or per-build boxes, so disposing them is safe; prop
    // meshes share the loader cache and are skipped.
    this.floorGroup.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) { im.dispose(); im.geometry.dispose(); }
    });
    this.floorGroup.clear();
    this.torchAnchors = [];
    for (const m of this.floorMats) m.dispose();
    this.floorMats = [];
    this.wlPropCache.clear(); // clones died with floorMats; next build re-clones

    const map = state.map;

    // Theme band for this depth (art set + palette), plus a cosmetic per-floor
    // rng so floors within a band differ (mix ratio, props, tint jitter).
    // Roam floor numbers grow open-endedly, but themeForFloor already clamps
    // via floorBand (same as Race) — and now that Roam's tribe identity also
    // tracks floorBand (roamTribeId), visuals and tribe always agree.
    const theme: FloorTheme = themeForFloor(state.floor);
    const frng = cosmeticRng((state.seed ^ Math.imul(state.floor, 0x9e3779b1)) >>> 0);
    const altPct = Math.round(theme.altRatio * (0.6 + frng() * 0.9) * 1000); // vs tileHash % 1000
    const tintJitter = 0.93 + frng() * 0.12;
    this.applyMood(theme, floorBand(state.floor));

    // Open-air districts (BIOMES.md): terrain instead of masonry. Sky light up,
    // sun a touch warmer — dusk rather than noon, so fog of war still reads.
    // Degrades to the interior treatment when the terrain models are absent.
    const oa = theme.openAir;
    type Src = NonNullable<ReturnType<Renderer3D["tileSource"]>>;
    const notNull = (s: Src | null): s is Src => !!s;
    const cliffSrcs = (oa?.cliffSides ?? []).map((k) => this.tileSource(k)).filter(notNull);
    const clusterSrcs = (oa?.clusterKeys ?? []).map((k) => this.tileSource(k)).filter(notNull);
    const accentSrcs = (oa?.accentKeys ?? []).map((k) => this.tileSource(k)).filter(notNull);
    const pathSrc = oa ? this.tileSource(oa.pathKey) : null;
    const openAir = !!oa && cliffSrcs.length > 0 && clusterSrcs.length > 0;
    if (openAir) {
      // Open sky overrides the interior rig's fill/key strength.
      this.hemi.intensity = oa!.hemiIntensity;
      this.key.intensity = oa!.keyIntensity;
    }

    // Real glTF tiles when present (instanced for perf), procedural boxes otherwise.
    const floorSrc = this.tileSource(theme.floorKey) ?? this.tileSource("floor");
    const altSrc = this.tileSource(theme.floorAltKey);
    const alt2Src = theme.floorAlt2Key ? this.tileSource(theme.floorAlt2Key) : null;
    const alt2Pct = Math.round((theme.alt2Ratio ?? 0) * (0.6 + frng() * 0.9) * 1000);
    const wallSrc = this.tileSource(theme.wallKey) ?? this.tileSource("wall");
    // LIVED look: extra modular variety mixed into the instanced tile kinds.
    const lived = this.look === "lived" && !openAir;
    const winSrc = lived ? this.tileSource("wall_window_open") : null;
    const winGatedSrc = lived ? this.tileSource("wall_archedwindow_gated") : null;
    const gatedSrc = lived ? this.tileSource("wall_gated") : null;
    const grateSrc = lived ? this.tileSource("floor_tile_grate") : null;
    const grateOpenSrc = lived ? this.tileSource("floor_tile_grate_open") : null;
    // Solid rock stays a dark box mass. The glTF wall is a thin PANEL meant to
    // dress a wall face, so it only goes on faces that border walkable floor.
    // The fill box is slightly shorter than the panels so their top/side surfaces
    // are never coplanar (coplanar faces z-fight and flicker as the camera moves).
    const wallHeight = 1.0;
    const fillHeight = wallHeight - 0.04;

    const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < map.w && y < map.h;
    const isFloorAt = (x: number, y: number) => inBounds(x, y) && map.tiles[y * map.w + x] !== Tile.Wall;
    // Corridor mask: walkable tiles outside every room rect. Open-air bands
    // render these as trodden earth (corridors are carved TWO wide, so any
    // neighbor-counting heuristic misses them).
    const roomMask = new Uint8Array(map.w * map.h);
    for (const r of map.rooms) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) roomMask[y * map.w + x] = 1;
      }
    }
    const DIRS = [
      { dx: 0, dz: 1 }, { dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
    ];

    // BAKED AO: floor tiles hugging walls darken toward the seam (orthogonal
    // walls weigh more than diagonal), folded into the per-instance lit color
    // so every wall-floor junction reads grounded for free. Props darken their
    // tile a touch more after dressing (below).
    const aoGrid = new Float32Array(map.w * map.h).fill(1);
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const idx = y * map.w + x;
        if (map.tiles[idx] === Tile.Wall) continue;
        let occ = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            const wall = !inBounds(nx, ny) || map.tiles[ny * map.w + nx] === Tile.Wall;
            // Light touch: the baked light grid's chamfer AO (lightGrid.ts)
            // now carries the junction shadow per FRAGMENT; this per-tile
            // term only seasons the instance tint.
            if (wall) occ += dx !== 0 && dy !== 0 ? 0.02 : 0.045;
          }
        }
        aoGrid[idx] = 1 - Math.min(0.18, occ);
      }
    }

    // Tiles are bucketed into CHUNK x CHUNK regions, one InstancedMesh per
    // (chunk, tile kind). A single map-wide instanced mesh defeats frustum
    // culling — the camera sees ~1/6 of a 72x72 floor, and per-chunk meshes let
    // three.js skip the rest (the dominant cost: 1M+ shaded triangles under
    // many lights). Draw calls rise slightly; shaded fragments drop ~5x.
    const CHUNK = 12;
    const chunkCols = Math.ceil(map.w / CHUNK);
    // Kinds are dynamic: interior bands use floor/alt/fill/panel/door; open-air
    // bands add a trodden path plus per-variant cliff facades and tree clusters.
    type Bucket = Map<string, { m: THREE.Matrix4; tile: number }[]>;
    const buckets = new Map<number, Bucket>();
    const push = (kind: string, x: number, y: number, tile: number, mat: THREE.Matrix4) => {
      const key = Math.floor(y / CHUNK) * chunkCols + Math.floor(x / CHUNK);
      let b = buckets.get(key);
      if (!b) {
        b = new Map();
        buckets.set(key, b);
      }
      let list = b.get(kind);
      if (!list) {
        list = [];
        b.set(kind, list);
      }
      list.push({ m: mat.clone(), tile });
    };

    const m = new THREE.Matrix4();
    const placeFloor = (src: typeof floorSrc, x: number, y: number) => {
      if (!src) { m.makeTranslation(x + 0.5, -0.1, y + 0.5); return; }
      const s = src.scale;
      const cx = (src.box.min.x + src.box.max.x) / 2;
      const cz = (src.box.min.z + src.box.max.z) / 2;
      m.makeScale(s, s, s).setPosition(x + 0.5 - cx * s, -src.box.max.y * s, y + 0.5 - cz * s);
    };
    // Panel placement: length spans the tile edge, height stretched to the fill
    // boxes, face flush with the wall/floor boundary, rotated toward the floor.
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const placePanel = (src: Src, x: number, y: number, dx: number, dz: number) => {
      const s = src.scale;
      const sy = wallHeight / Math.max(1e-4, src.box.max.y - src.box.min.y);
      const halfThick = ((src.box.max.z - src.box.min.z) / 2) * s;
      // Nudge the panel a hair out of the fill box so their faces never share a plane.
      const off = 0.5 - halfThick + 0.01;
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
      const cx = (src.box.min.x + src.box.max.x) / 2;
      const cz = (src.box.min.z + src.box.max.z) / 2;
      const centerOff = new THREE.Vector3(cx * s, 0, cz * s).applyQuaternion(quat);
      pos.set(x + 0.5 + dx * off - centerOff.x, -src.box.min.y * sy, y + 0.5 + dz * off - centerOff.z);
      scl.set(s, sy, s);
      m.compose(pos, quat, scl);
    };
    // Open-air wall tile rendered as WOODS. Piece 0 is ALWAYS a tall tree
    // planted near the tile center — blocked ground must read blocked even
    // before its companions fill in; extras mix in low accents for texture.
    const placeCluster = (x: number, y: number, tile: number, count: number, baseY: number) => {
      for (let i = 0; i < count; i++) {
        const h = tileHash(x * 5 + i * 13 + 1, y * 3 + i * 7 + 2, state.floor);
        const accent = i > 0 && accentSrcs.length > 0 && h % 3 === 0;
        const srcs = accent ? accentSrcs : clusterSrcs;
        const v = h % srcs.length;
        const src = srcs[v];
        const jitter = i === 0 ? 0.24 : 0.62; // anchor tree stays centered
        const sMin = i === 0 ? 1.0 : 0.8;
        const s = src.scale * oa!.clusterScale * (sMin + ((h >> 3) % 100) / 300);
        quat.setFromAxisAngle(UP, ((h >> 1) % 628) / 100);
        pos.set(
          x + 0.5 + (((h >> 2) % 100) / 100 - 0.5) * jitter,
          baseY - src.box.min.y * s,
          y + 0.5 + (((h >> 5) % 100) / 100 - 0.5) * jitter,
        );
        scl.set(s, s, s);
        m.compose(pos, quat, scl);
        push(`${accent ? "accent" : "cluster"}${v}`, x, y, tile, m);
      }
    };

    // Landmark set-piece tiles (sim-blocked pillars/pedestal): drawn as their
    // MODEL standing on ordinary ground — the generic rock fill would swallow
    // it. The props themselves are placed with the dressing below.
    const pillarSet = new Set<number>(map.pillars ?? []);
    if ((map.pedestal ?? -1) >= 0) pillarSet.add(map.pedestal);

    // Track which map tile sits behind each instance so fog of war can tint it.
    // Wall instances key off the tile itself; panels key off the floor tile they
    // face (a wall face lights up when the room it borders is explored).
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const idx = y * map.w + x;
        const t = map.tiles[idx];
        if (t === Tile.Wall && pillarSet.has(idx)) {
          // Ground under the set piece, no fill box, no wall panels.
          if (openAir) {
            m.makeTranslation(x + 0.5, 0.001, y + 0.5);
          } else {
            placeFloor(floorSrc, x, y);
          }
          push("floor", x, y, idx, m);
          continue;
        }
        if (t === Tile.DoorLocked) {
          // The door block sits over its tile; opening triggers a full rebuild
          // (mapVersion bump), so just draw floor + door now.
          m.makeTranslation(x + 0.5, 1.1 / 2 - 0.02, y + 0.5);
          push("door", x, y, idx, m);
        }
        if (t === Tile.Wall && openAir) {
          // Terrain, not masonry: UNDERBRUSH ground (clearly darker than the
          // walkable meadow, so blocked ground never reads as path even where
          // the pieces on it are sparse), edge tiles are cliff facades or tree
          // masses, deep tiles are grass-topped hill mass with the odd canopy.
          m.makeTranslation(x + 0.5, 0.001, y + 0.5);
          push("brush", x, y, idx, m);
          const facing = DIRS.filter((d) => isFloorAt(x + d.dx, y + d.dz));
          const h = tileHash(x, y, state.floor + 101);
          if (facing.length === 0) {
            m.makeTranslation(x + 0.5, fillHeight / 2, y + 0.5);
            push("fill", x, y, idx, m);
            if (h < 140) placeCluster(x, y, idx, 1, fillHeight - 0.05);
          } else if (h < oa!.clusterRatio * 1000 || facing.length >= 3) {
            // Woods hem this stretch (thin walls and outcrops always go woods —
            // a cliff facade can't sell a 1-tile-thick ridge).
            placeCluster(x, y, idx, 3, 0);
          } else {
            m.makeTranslation(x + 0.5, fillHeight / 2, y + 0.5);
            push("fill", x, y, idx, m);
            for (const d of facing) {
              const v = tileHash(x + d.dx * 7, y + d.dz * 7, state.floor) % cliffSrcs.length;
              placePanel(cliffSrcs[v], x, y, d.dx, d.dz);
              push(`cliff${v}`, x, y, (y + d.dz) * map.w + (x + d.dx), m);
            }
          }
        } else if (t === Tile.Wall) {
          m.makeTranslation(x + 0.5, fillHeight / 2, y + 0.5);
          push("fill", x, y, idx, m);
          if (wallSrc) {
            for (const d of DIRS) {
              if (!isFloorAt(x + d.dx, y + d.dz)) continue;
              // Lived look: a seeded slice of wall faces carry windows or a
              // portcullis gate — masonry with a history, not wallpaper.
              const hv = lived ? tileHash(x * 3 + d.dx, y * 3 + d.dz, state.floor + 55) : 999;
              const variant = hv < 45 && winSrc ? { src: winSrc, kind: "panelWin" }
                : hv < 85 && winGatedSrc ? { src: winGatedSrc, kind: "panelWinG" }
                : hv < 115 && gatedSrc ? { src: gatedSrc, kind: "panelGate" }
                : null;
              placePanel(variant ? variant.src : wallSrc, x, y, d.dx, d.dz);
              // Fog keys panels off the floor tile they FACE.
              push(variant ? variant.kind : "panel", x, y, (y + d.dz) * map.w + (x + d.dx), m);
            }
          }
        } else if (openAir) {
          // Grass everywhere; the corridors between clearings show trodden earth.
          if (pathSrc && !roomMask[idx]) {
            placeFloor(pathSrc, x, y);
            push("path", x, y, idx, m);
          } else {
            m.makeTranslation(x + 0.5, 0.001, y + 0.5);
            push(tileHash(x, y, state.floor) < 450 ? "alt" : "floor", x, y, idx, m);
          }
        } else {
          // Lived look: corridors drain through floor grates here and there.
          const hg = lived && !roomMask[idx] ? tileHash(x, y, state.floor + 77) : 999;
          if (hg < 40 && grateSrc) {
            placeFloor(grateSrc, x, y);
            push("grate", x, y, idx, m);
            continue;
          }
          if (hg < 60 && grateOpenSrc) {
            placeFloor(grateOpenSrc, x, y);
            push("grateO", x, y, idx, m);
            continue;
          }
          // Mix primary/alt/alt2 ground per tile (stable hash: same tile,
          // same look). Three noise-blended variants kill the wallpaper read
          // of a single repeated stamp.
          const hMix = tileHash(x, y, state.floor);
          const useAlt = altSrc
            ? hMix < altPct
            : !floorSrc && (x + y) % 2 !== 0;
          if (alt2Src && hMix >= 1000 - alt2Pct) {
            placeFloor(alt2Src, x, y);
            push("alt2", x, y, idx, m);
          } else if (useAlt) {
            placeFloor(altSrc, x, y);
            push("alt", x, y, idx, m);
          } else {
            placeFloor(floorSrc, x, y);
            push("floor", x, y, idx, m);
          }
        }
      }
    }

    // Shared per-build geometry/material per kind (chunk meshes reuse them).
    // Every kind's material is a WORLD-LIT clone (per-fragment fog + falloff;
    // see worldLit above); `dim` grades a kind's explored brightness (rock
    // tops sit below walkable ground) and `lit` is the static instance tint
    // (theme color x baked AO x per-tile jitter), stamped once at build.
    const floorLit = new THREE.Color(theme.floorTint).multiplyScalar(tintJitter);
    const wallLitColor = new THREE.Color(theme.wallTint).multiplyScalar(tintJitter);
    const wallFillLit = wallLitColor.clone().multiplyScalar(0.92);
    const fillGeo = new THREE.BoxGeometry(1, fillHeight, 1);
    // Solid rock gets REAL masonry: procedural stone courses + the base
    // gradient + lit top bevel — a featureless black extrusion no more.
    const fillMat = this.worldLit(flat(THEME.wall, { map: this.stoneTexture() }), { dim: 0.74, base: true }) as THREE.Material;
    const fallbackFloorGeo = floorSrc && altSrc ? null : new THREE.BoxGeometry(1, 0.2, 1);
    const doorGeo = new THREE.BoxGeometry(0.96, 1.1, 0.96);
    const doorMat = this.worldLit(flat(0xc9a24b, { emissive: 0x5a3f08, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.35 }));
    const kindSpec: Record<string, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; lit: THREE.Color; cast: boolean } | null> = {
      floor: { geo: floorSrc?.geo ?? fallbackFloorGeo!, mat: this.worldLit(floorSrc?.mat ?? flat(THEME.floor)), lit: floorLit, cast: false },
      alt: { geo: altSrc?.geo ?? fallbackFloorGeo!, mat: this.worldLit(altSrc?.mat ?? flat(THEME.floorAlt)), lit: floorLit, cast: false },
      alt2: alt2Src ? { geo: alt2Src.geo, mat: this.worldLit(alt2Src.mat), lit: floorLit, cast: false } : null,
      fill: { geo: fillGeo, mat: fillMat, lit: wallFillLit, cast: true },
      panel: wallSrc ? { geo: wallSrc.geo, mat: this.worldLit(wallSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      door: { geo: doorGeo, mat: doorMat, lit: new THREE.Color(1, 1, 1), cast: true },
      panelWin: winSrc ? { geo: winSrc.geo, mat: this.worldLit(winSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      panelWinG: winGatedSrc ? { geo: winGatedSrc.geo, mat: this.worldLit(winGatedSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      panelGate: gatedSrc ? { geo: gatedSrc.geo, mat: this.worldLit(gatedSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      grate: grateSrc ? { geo: grateSrc.geo, mat: this.worldLit(grateSrc.mat), lit: floorLit, cast: false } : null,
      grateO: grateOpenSrc ? { geo: grateOpenSrc.geo, mat: this.worldLit(grateOpenSrc.mat), lit: floorLit, cast: false } : null,
    };
    if (openAir) {
      // Ground is flat grass mats (white material; the LIT color carries the
      // green so fog-of-war darkening keeps working), hill mass is grass-dark,
      // cliff/cluster variants get their own instanced kinds.
      const grassGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      const grassMat = this.worldLit(flat(0xffffff));
      kindSpec.floor = { geo: grassGeo, mat: grassMat, lit: new THREE.Color(oa!.grass).multiplyScalar(tintJitter), cast: false };
      kindSpec.alt = { geo: grassGeo, mat: grassMat, lit: new THREE.Color(oa!.grassAlt).multiplyScalar(tintJitter), cast: false };
      kindSpec.alt2 = null;
      // Trodden earth: desaturated + a value step below the old pink-tinged
      // checker, so the trail reads without outshining the hero.
      if (pathSrc) kindSpec.path = { geo: pathSrc.geo, mat: this.worldLit(pathSrc.mat), lit: new THREE.Color(0xbcaa8e).multiplyScalar(tintJitter), cast: false };
      kindSpec.fill = { geo: fillGeo, mat: this.worldLit(flat(0xffffff), { dim: 0.62, base: true }) as THREE.Material, lit: new THREE.Color(oa!.grass).multiplyScalar(0.5 * tintJitter), cast: true };
      // Underbrush: the ground beneath wall tiles, darker than any meadow.
      kindSpec.brush = { geo: grassGeo, mat: this.worldLit(flat(0xffffff), { dim: 0.6 }), lit: new THREE.Color(oa!.grass).multiplyScalar(0.55 * tintJitter), cast: false };
      cliffSrcs.forEach((src, i) => { kindSpec[`cliff${i}`] = { geo: src.geo, mat: this.worldLit(src.mat, { base: true }), lit: wallLitColor, cast: true }; });
      clusterSrcs.forEach((src, i) => { kindSpec[`cluster${i}`] = { geo: src.geo, mat: this.worldLit(src.mat, { canopy: true }), lit: new THREE.Color(tintJitter, tintJitter, tintJitter), cast: true }; });
      accentSrcs.forEach((src, i) => { kindSpec[`accent${i}`] = { geo: src.geo, mat: this.worldLit(src.mat, { canopy: true }), lit: new THREE.Color(tintJitter, tintJitter, tintJitter), cast: true }; });
    }

    this.canopy = openAir ? new Map() : null;
    this.canopyGridW = map.w;
    // Ground kinds carry the baked tile AO; also indexed by tile so the prop
    // pass below can darken the floor under clutter (contact shadow feel).
    const GROUND_KINDS = new Set(["floor", "alt", "alt2", "path", "grate", "grateO", "brush"]);
    const groundByTile = new Map<number, { cols: Float32Array; i: number }[]>();
    // Contact-shadow blobs: soft dark discs stamped under every canopy/rock
    // cluster piece (and, below, under every placed prop) so nothing floats.
    const blobSpots: { x: number; z: number; r: number }[] = [];
    // Static per-instance tints, stamped once after the prop pass (which
    // still darkens the ground under clutter for the contact-shadow feel).
    const litByMesh: { mesh: THREE.InstancedMesh; cols: Float32Array }[] = [];
    for (const bucket of buckets.values()) {
      for (const [kind, list] of bucket) {
        const spec = kindSpec[kind];
        if (list.length === 0 || !spec) continue;
        const mesh = new THREE.InstancedMesh(spec.geo, spec.mat, list.length);
        for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i].m);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = spec.cast;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere(); // per-chunk sphere -> real frustum culling
        this.floorGroup.add(mesh);
        if (kind.startsWith("cluster") || kind.startsWith("accent")) {
          for (let i = 0; i < list.length; i++) {
            const e = list[i].m.elements;
            // Ground-level pieces only (hilltop canopies sit on the fill mass).
            if (e[13] > 0.5) continue;
            const s = Math.hypot(e[0], e[1], e[2]); // decomposed uniform scale
            blobSpots.push({ x: e[12], z: e[14], r: Math.min(1.1, 0.42 * s + 0.18) });
          }
        }
        const ground = GROUND_KINDS.has(kind);
        const foliage = kind.startsWith("cluster") || kind.startsWith("accent");
        const litColors = new Float32Array(list.length * 3);
        for (let i = 0; i < list.length; i++) {
          // Per-tile value jitter (+ baked AO) so a field of identical tiles
          // never reads as one flat albedo sheet.
          const jit = ground ? 0.92 + 0.16 * (tileHash(list[i].tile % map.w, (list[i].tile / map.w) | 0, state.floor + 7) / 1000) : 1;
          const ao = (ground ? aoGrid[list[i].tile] : 1) * jit;
          litColors[i * 3] = spec.lit.r * ao;
          litColors[i * 3 + 1] = spec.lit.g * ao;
          litColors[i * 3 + 2] = spec.lit.b * ao;
          if (foliage) {
            // Per-tree hue/value jitter (~±15%): a forest of one saturated
            // green reads painted-on; individuals read grown.
            const hj = tileHash(list[i].tile % map.w, (list[i].tile / map.w) | 0, state.floor + 19 + i);
            const v = 0.85 + 0.28 * (hj / 1000);
            const w = ((((hj * 7) % 1000) / 1000) - 0.5) * 0.2; // warm<->cool lean
            litColors[i * 3] *= v * (1 + w);
            litColors[i * 3 + 1] *= v;
            litColors[i * 3 + 2] *= v * (1 - w * 0.8);
          }
          if (ground) {
            let cell = groundByTile.get(list[i].tile);
            if (!cell) { cell = []; groundByTile.set(list[i].tile, cell); }
            cell.push({ cols: litColors, i });
          }
        }
        // Instance tints are STATIC now (theme x AO x jitter) — the per-frame
        // fog reveal + distance falloff moved into the world-lit materials,
        // sampled per fragment (no more tile-quantized light steps). Colors
        // are stamped after the prop pass below (it darkens ground under
        // clutter), via groundByTile / litByMesh.
        litByMesh.push({ mesh, cols: litColors });
        if (this.canopy && (kind.startsWith("cluster") || kind.startsWith("accent"))) {
          // Register cluster pieces for camera courtesy (world pos from matrix).
          for (let i = 0; i < list.length; i++) {
            const e = list[i].m.elements;
            const gx = Math.floor(e[12]), gz = Math.floor(e[14]);
            const key = gz * map.w + gx;
            let cell = this.canopy.get(key);
            if (!cell) { cell = []; this.canopy.set(key, cell); }
            cell.push({ mesh, index: i, base: list[i].m.clone(), x: e[12], z: e[14], f: 1, target: 1 });
          }
        }
      }
    }
    this.lastExploredVersion = -1; // force a fog re-tint on the new floor
    const worldKey = `${state.floor}:${state.seed}`;
    this.fogSnap = this.builtKey === worldKey; // same world re-dressed -> snap, don't re-dissolve
    this.builtKey = worldKey;
    this.fogBank.rebuild(map, theme);
    // World-light uniforms for the new floor: the fog bank's animated mask,
    // the map->uv scale, the band's colored dark, and the falloff shape —
    // open-air bands get a wider, higher-floored feather (2-3 tile gradient,
    // not a cliff of darkness at the treeline).
    this.wl.uWlMask.value = this.fogBank.maskTexture;
    this.wl.uWlMapInv.value.set(1 / map.w, 1 / map.h);
    this.wl.uWlDark.value.copy(this.fogDark);
    if (openAir) this.wl.uWlFall.value.set(5.5, 16, 0.18);
    else this.wl.uWlFall.value.set(4.5, 12, 0.12);
    this.ambientFx.rebuild(floorBand(state.floor), this.renderer.getPixelRatio());
    this.atmoRefresh = 0; // feed the mote cloud fresh spawn candidates now

    if (openAir) {
      // The world past the playfield: a dark meadow skirt and a dim treeline
      // silhouette ring, so the map edge reads as forest under mist, not void.
      // Fixed dim colors (never fog-tinted); the rolling fog planes above do
      // the atmospheric work. InstancedMesh throughout so the rebuild's
      // dispose pass reclaims the geometry.
      const SKIRT_PAD = 24; // matches the fog bank's overhang
      const skirt = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(map.w + SKIRT_PAD * 2, map.h + SKIRT_PAD * 2).rotateX(-Math.PI / 2),
        flat(new THREE.Color(oa!.grassAlt).multiplyScalar(0.3).getHex()),
        1,
      );
      skirt.setMatrixAt(0, new THREE.Matrix4().makeTranslation(map.w / 2, -0.08, map.h / 2));
      skirt.instanceMatrix.needsUpdate = true;
      skirt.receiveShadow = true;
      skirt.computeBoundingSphere();
      this.floorGroup.add(skirt);
      const skirtSrcs = oa!.skirtKeys.map((k) => this.tileSource(k)).filter(notNull);
      if (skirtSrcs.length > 0) {
        const srng = cosmeticRng((state.seed ^ Math.imul(state.floor, 0x51a917)) >>> 0);
        const dim = new THREE.Color(0.3, 0.36, 0.32);
        const perSrc: THREE.Matrix4[][] = skirtSrcs.map(() => []);
        for (let i = 0; i < 110; i++) {
          const side = i % 4;
          const along = srng() * (side < 2 ? map.w + 24 : map.h + 24) - 12;
          const out = 1.5 + srng() * 11;
          const px = side === 0 || side === 1 ? along : side === 2 ? -out : map.w + out;
          const pz = side === 2 || side === 3 ? along : side === 0 ? -out : map.h + out;
          const si = Math.floor(srng() * skirtSrcs.length);
          const src = skirtSrcs[si];
          const s = src.scale * (oa!.clusterScale ?? 1.5) * (0.9 + srng() * 0.9);
          quat.setFromAxisAngle(UP, srng() * Math.PI * 2);
          pos.set(px, -0.08 - src.box.min.y * s, pz);
          scl.set(s, s, s);
          perSrc[si].push(new THREE.Matrix4().compose(pos, quat, scl));
        }
        perSrc.forEach((mats, si) => {
          if (mats.length === 0) return;
          const mesh = new THREE.InstancedMesh(skirtSrcs[si].geo, this.worldLit(skirtSrcs[si].mat, { canopy: true }) as THREE.Material, mats.length);
          mats.forEach((mm, i) => {
            mesh.setMatrixAt(i, mm);
            mesh.setColorAt(i, dim);
          });
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
          this.floorGroup.add(mesh);
        });
      }
    }

    // The descent gate IS the stairs (playtest: arch + staircase stacked on
    // one tile read as clutter). One group: the System's portal arch with a
    // live energy surface filling the opening — the sim tile is still called
    // "stairs", only the dressing changed. Missing arch model → a gold ring.
    const gate = new THREE.Group();
    gate.position.set(map.stairs.x, 0, map.stairs.y);
    // Face the opening across the stairs' approach axis (widest open side).
    gate.rotation.y = Math.PI / 2;
    const arch = this.modelInstance("descent_portal");
    if (arch) {
      const box = new THREE.Box3().setFromObject(arch);
      const size = box.getSize(new THREE.Vector3());
      arch.scale.multiplyScalar(2.3 / Math.max(size.y, 1e-3)); // arch ~2.3 world units
      arch.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.emissive = new THREE.Color(0xc9a24b); // System gold: the exit sells itself
        mat.emissiveIntensity = 0.18;
        m.material = mat;
      });
      gate.add(arch);
    } else {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.85, 0.08, 8, 28),
        flat(THEME.stairs, { emissive: 0x3a2c00, emissiveIntensity: 0.6 }),
      );
      ring.position.y = 1.05;
      gate.add(ring);
    }
    // The energy surface: a full disc + a broken bright ring, counter-rotating
    // (a broken ring is what makes the spin readable). Additive, no depth
    // write — same recipe as the loot beams.
    const swirl = new THREE.Mesh(
      new THREE.CircleGeometry(0.72, 28),
      new THREE.MeshBasicMaterial({
        color: 0xc9a24b, transparent: true, opacity: 0.38,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    swirl.position.y = 1.05;
    const core = new THREE.Mesh(
      new THREE.RingGeometry(0.14, 0.5, 24, 1, 0, Math.PI * 1.55),
      new THREE.MeshBasicMaterial({
        color: 0xf5e6bf, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    core.position.set(0, 1.05, 0.02); // proud of the disc so they never z-fight
    gate.add(swirl, core);
    this.portalSwirl = swirl;
    this.portalCore = core;
    this.portalPos = { x: map.stairs.x, y: map.stairs.y };
    this.floorGroup.add(gate);
    this.stairsObj = gate;
    this.stairsTile = Math.floor(map.stairs.y) * map.w + Math.floor(map.stairs.x);
    this.propEntries = []; // reset BEFORE the stamps below register into it
    // CRAFTED ROOM props: each stamp the mapgen recorded places its
    // template's cosmetic dressing (the WALLS are already real tiles; these
    // are the barrels and clutter that make the design read). Footprint-
    // normalized to WORLD scale (raw GLB scale rendered barrels at 4x a
    // character and lied about the space) and registered as prop entries so
    // fog of war grades them in with the geometry instead of leaving set
    // dressing floating full-bright on the murk.
    for (const stamp of map.stamps ?? []) {
      const t = roomTemplateById(stamp.id);
      if (!t) continue;
      for (const p of t.props) {
        const obj = this.modelInstance(p.key);
        if (!obj) continue;
        this.worldLitProp(obj);
        const box = new THREE.Box3().setFromObject(obj);
        const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
        obj.scale.multiplyScalar((0.62 * (p.scale ?? 1)) / fp);
        obj.rotation.y = p.rot ?? 0;
        const scaled = new THREE.Box3().setFromObject(obj);
        const sx = stamp.x + p.x, sy = stamp.y + p.y;
        obj.position.set(
          sx - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
          -scaled.min.y + 0.004,
          sy - (scaled.min.z + scaled.max.z) / 2 + obj.position.z,
        );
        this.floorGroup.add(obj);
        this.propEntries.push({
          obj,
          tile: Math.min(map.tiles.length - 1, Math.max(0, Math.floor(sy) * map.w + Math.floor(sx))),
        });
      }
    }

    // RULE-BASED DRESSING (intent over noise): torches line room walls with the
    // lights anchored to the visible meshes; banners flank locked doors; clutter
    // clusters live in corners; the LANDMARK hall gets a pillar colonnade and an
    // altar; the VAULT gets its treasure hoard. Cosmetic only; sim never sees it.
    const clear = (x: number, y: number, spawnR = 2.5, stairsR = 2.5): boolean => {
      const i = Math.floor(y) * map.w + Math.floor(x);
      if (map.tiles[i] !== Tile.Floor) return false;
      if (map.blocked?.[i]) return false; // furniture owns that tile (entity-drawn)
      if (Math.hypot(x - map.spawn.x, y - map.spawn.y) < spawnR) return false;
      if (Math.hypot(x - map.stairs.x, y - map.stairs.y) < stairsR) return false;
      return ![i - 1, i + 1, i - map.w, i + map.w].some((n) => map.tiles[n] === Tile.DoorLocked);
    };
    const PROP_CAP = lived ? 480 : 430; // density pass: no lit room ships as an empty plane
    const place = (key: string, x: number, y: number, opts: { scale?: number; rot?: number; jitter?: number; onWall?: boolean; elevate?: number } = {}): boolean => {
      // onWall: landmark set pieces stand ON sim-blocked pillar tiles — the
      // one case where a prop belongs on a non-Floor tile (looks = collision).
      // elevate: lift after the ground snap (wall-mounted decor, tabletop items).
      if (this.propEntries.length > PROP_CAP || (!opts.onWall && !clear(x, y))) return false;
      const obj = this.modelInstance(key);
      if (!obj) return false;
      // Props share the world-lit stage with the ground they stand on: they
      // sink into fog and the distance falloff instead of floating full-bright.
      this.worldLitProp(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
      const themed = theme.propScale?.[key];
      obj.scale.multiplyScalar((opts.scale ?? (themed ? themed * (0.85 + frng() * 0.3) : 0.55 + frng() * 0.2)) / fp);
      const scaled = new THREE.Box3().setFromObject(obj);
      const j = opts.jitter ?? 0.25;
      obj.position.set(
        x + (frng() - 0.5) * j - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
        -scaled.min.y + 0.004 + (opts.elevate ?? 0),
        y + (frng() - 0.5) * j - (scaled.min.z + scaled.max.z) / 2 + obj.position.z,
      );
      obj.rotation.y = opts.rot ?? frng() * Math.PI * 2;
      this.floorGroup.add(obj);
      this.propEntries.push({ obj, tile: Math.floor(y) * map.w + Math.floor(x) });
      return true;
    };

    // 1) Torch anchors along room walls (every ~4 perimeter tiles), lights riding
    //    the meshes. Replaces the old free-floating torch light sampling.
    const torchAnchors: Vec2[] = [];
    for (let ri = 0; ri < map.rooms.length && torchAnchors.length < 14; ri++) {
      const r = map.rooms[ri];
      let steps = 0;
      const tryTorch = (x: number, y: number) => {
        if (torchAnchors.length >= 14) return;
        if (steps++ % 4 !== 0) return;
        const i = Math.floor(y) * map.w + Math.floor(x);
        if (map.tiles[i] !== Tile.Floor) return;
        // Which neighbor is the wall? The torch HUGS that face instead of
        // standing mid-lane (a walk-through torch in the walking lane was
        // part of the "props lie about the path" complaint).
        const wallDir = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
          .find(([dx, dy]) => map.tiles[i + dy * map.w + dx] === Tile.Wall);
        if (!wallDir || !clear(x, y)) return;
        // Open-air districts light their paths with standing lanterns, not
        // wall torches — there is no masonry to mount a torch on.
        const torchKey = openAir ? "lantern_standing" : "torch_lit";
        const tx = x + wallDir[0] * 0.33, ty = y + wallDir[1] * 0.33;
        if (place(torchKey, tx, ty, { scale: openAir ? 0.7 : 0.55, jitter: 0.05 })) torchAnchors.push({ x: tx, y: ty });
      };
      for (let x = r.x; x < r.x + r.w; x++) { tryTorch(x + 0.5, r.y + 0.5); tryTorch(x + 0.5, r.y + r.h - 0.5); }
      for (let y = r.y + 1; y < r.y + r.h - 1; y++) { tryTorch(r.x + 0.5, y + 0.5); tryTorch(r.x + r.w - 0.5, y + 0.5); }
    }
    this.addTorches(theme, torchAnchors, 0.85 + frng() * 0.3);

    // 2) Theme props flanking locked doors (a gate should look like a gate) —
    //    banners in the stone districts, standing lanterns in the Garden.
    let banners = 0;
    for (let i = 0; i < map.tiles.length && banners < 6; i++) {
      if (map.tiles[i] !== Tile.DoorLocked) continue;
      const x = (i % map.w) + 0.5, y = Math.floor(i / map.w) + 0.5;
      for (const [dx, dy] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]] as const) {
        if (place(theme.doorFlankKey, x + dx, y + dy, { scale: 0.8, rot: Math.atan2(-dx, -dy), jitter: 0 })) {
          banners++;
          break;
        }
      }
    }

    // 3) Corner clutter clusters (2 corners per room, 1-2 props each). The pool
    //    is role-keyed: the landmark hall clutters with its own set-dressing,
    //    the entrance gets a soft camp, everything else uses the band props.
    for (let ri = 0; ri < map.rooms.length; ri++) {
      const role = map.roles[ri];
      const pool = role === "entrance" ? theme.entranceProps
        : role === "landmark" ? theme.landmark.props
        : role === "settlement" ? theme.entranceProps // reuse the "soft camp" dressing
        : theme.props;
      if (pool.length === 0) continue;
      const r = map.rooms[ri];
      const corners: Vec2[] = [
        { x: r.x + 1.2, y: r.y + 1.2 }, { x: r.x + r.w - 1.2, y: r.y + 1.2 },
        { x: r.x + 1.2, y: r.y + r.h - 1.2 }, { x: r.x + r.w - 1.2, y: r.y + r.h - 1.2 },
      ];
      const start = Math.floor(frng() * 4);
      // Lived look: three corners cluttered instead of two, one more piece each.
      for (let c = 0; c < (lived ? 3 : 2); c++) {
        const corner = corners[(start + c * (lived ? 1 : 2)) % 4];
        const n = (lived ? 2 : 1) + Math.floor(frng() * 2);
        for (let k = 0; k < n; k++) {
          const key = pool[Math.floor(frng() * pool.length)];
          place(key, corner.x + (frng() - 0.5) * 0.8, corner.y + (frng() - 0.5) * 0.8);
        }
      }
      // 3b) WALL-HUG CLUTTER (interiors): stretches of room wall between the
      //     torches get small props tucked against the face — crates against
      //     masonry, junk along the skirting — so a lit room's edges read
      //     furnished instead of shipping as a bare plane with two slabs.
      if (!openAir) {
        const hug = (x: number, y: number, dx: number, dy: number): void => {
          if (frng() > 0.32) return;
          const key = pool[Math.floor(frng() * pool.length)];
          place(key, x + dx * 0.3, y + dy * 0.3, {
            jitter: 0.18, rot: Math.atan2(-dx, -dy) + (frng() - 0.5) * 0.6,
            scale: 0.34 + frng() * 0.22,
          });
        };
        for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) {
          if (!isFloorAt(x, r.y - 1)) hug(x + 0.5, r.y + 0.5, 0, -1);
          if (!isFloorAt(x, r.y + r.h)) hug(x + 0.5, r.y + r.h - 0.5, 0, 1);
        }
        for (let y = r.y + 1; y < r.y + r.h - 1; y += 2) {
          if (!isFloorAt(r.x - 1, y)) hug(r.x + 0.5, y + 0.5, -1, 0);
          if (!isFloorAt(r.x + r.w, y)) hug(r.x + r.w - 0.5, y + 0.5, 1, 0);
        }
      }
    }

    // LIVED look one-offs (few per floor, so not instanced):
    if (lived) {
      // 1) DOORWAY ARCHES: a modular wall_doorway piece over corridor tiles at
      //    room mouths — the walkable gap now reads as a built doorway. The
      //    piece's opening spans the tile, so the path never lies.
      let arches = 0;
      for (let y = 1; y < map.h - 1 && arches < 14; y++) {
        for (let x = 1; x < map.w - 1 && arches < 14; x++) {
          const idx = y * map.w + x;
          if (map.tiles[idx] !== Tile.Floor || roomMask[idx]) continue;
          const wl = map.tiles[idx - 1] === Tile.Wall, wr = map.tiles[idx + 1] === Tile.Wall;
          const wu = map.tiles[idx - map.w] === Tile.Wall, wd = map.tiles[idx + map.w] === Tile.Wall;
          const gateNS = wl && wr && !wu && !wd; // corridor runs north-south
          const gateEW = wu && wd && !wl && !wr;
          if (!gateNS && !gateEW) continue;
          const mouth = gateNS
            ? roomMask[idx - map.w] || roomMask[idx + map.w]
            : roomMask[idx - 1] || roomMask[idx + 1];
          if (!mouth || tileHash(x, y, state.floor + 91) > 700) continue;
          const arch = this.modelInstance("wall_doorway");
          if (!arch) break;
          arch.rotation.y = gateNS ? 0 : Math.PI / 2; // wall plane across travel
          const box = new THREE.Box3().setFromObject(arch);
          const across = gateNS ? box.max.x - box.min.x : box.max.z - box.min.z;
          const s = 1.0 / Math.max(across, 1e-4);
          const sy = 1.0 / Math.max(box.max.y - box.min.y, 1e-4);
          arch.scale.set(arch.scale.x * s, arch.scale.y * sy, arch.scale.z * s);
          const b2 = new THREE.Box3().setFromObject(arch);
          arch.position.set(
            x + 0.5 - (b2.min.x + b2.max.x) / 2 + arch.position.x,
            -b2.min.y,
            y + 0.5 - (b2.min.z + b2.max.z) / 2 + arch.position.z,
          );
          this.floorGroup.add(arch);
          this.propEntries.push({ obj: arch, tile: idx });
          arches++;
        }
      }
      // 2) INTERIOR PILLARS: big rooms get a pair inset at opposite corners
      //    (low-traffic ground; place() still respects clearance + cap).
      for (const r of map.rooms) {
        if (r.w < 7 || r.h < 6) continue;
        const h = tileHash(r.x, r.y, state.floor + 33);
        if (h > 750) continue;
        const key = ["pillar", "pillar_decorated", "column"][h % 3];
        place(key, r.x + 1.6, r.y + 1.6, { scale: 1.5, rot: 0, jitter: 0.05 });
        place(key, r.x + r.w - 1.6, r.y + r.h - 1.6, { scale: 1.5, rot: 0, jitter: 0.05 });
      }
      // 3) WATER POOLS (THE SEWERS band): a translucent standing-water sheet
      //    inset along a room edge. Cosmetic and walkable — shallow water.
      if (floorBand(state.floor) === 1) {
        for (const r of map.rooms) {
          const h = tileHash(r.x * 3, r.y * 5, state.floor + 13);
          if (h > 400 || r.w < 6 || r.h < 6) continue;
          const pw = Math.min(3.5, r.w - 3.5), ph = Math.min(2.5, r.h - 3.5);
          const pool = new THREE.Mesh(
            new THREE.PlaneGeometry(pw, ph),
            new THREE.MeshStandardMaterial({
              color: 0x2e8b8b, transparent: true, opacity: 0.7, roughness: 0.2,
              metalness: 0.15, emissive: 0x0f3d3d, emissiveIntensity: 0.4,
            }),
          );
          pool.rotation.x = -Math.PI / 2;
          pool.position.set(r.x + 1.25 + pw / 2, 0.045, r.y + 1.25 + ph / 2);
          this.floorGroup.add(pool);
          this.propEntries.push({ obj: pool, tile: Math.floor(r.y + 1) * map.w + Math.floor(r.x + 1) });
        }
      }
    }

    // 3.5) ROOM PURPOSES (vignette grammar phase 1 — see floorThemes.ts):
    //    a seeded slice of ordinary combat rooms is dressed as a PLACE the
    //    dungeon's inhabitants use — storage, mess, archive, guard post —
    //    through anchored arrangements instead of scatter: wall runs, wall-
    //    mounted decor, a furnished table, a corner hoard. This is the KayKit
    //    sample-render technique. Cosmetic only; interiors only (the Garden's
    //    open-air districts have no walls worth furnishing).
    if (!openAir) {
      // The grammar itself (wall runs, mounts, table sets, condition damage,
      // corridor spill) lives in dressing.ts, SHARED with the builder's
      // dressing-preview tab — the env adapts it to this build's place()/rng.
      const dressEnv: DressEnv = {
        frng,
        isFloor: (x, y) => map.tiles[Math.floor(y) * map.w + Math.floor(x)] === Tile.Floor,
        isWall: (x, y) => map.tiles[Math.floor(y) * map.w + Math.floor(x)] === Tile.Wall,
        clear,
        place: (key, x, y, opts) =>
          place(key, x, y, opts) ? this.propEntries[this.propEntries.length - 1].obj : null,
        canTorch: () => this.torchAnchors.length < 20,
        addTorch: (x, y) => this.torchAnchors.push({ x, y, seed: this.torchAnchors.length * 1.7 }),
      };
      // The dressing plan comes from the SIM-SHARED assignment: same seed,
      // same rooms, same purposes for the renderer and for spawnMonsters —
      // which is what lets the mess pack actually sit at the mess table.
      const dressings = assignRoomPurposes(state.seed, state.floor, map).dressings;
      // Staging (PHYSICALITY.md §2): remember each purpose's social anchor so
      // seated residents can face the table they were dressed around.
      this.stagingAnchors.clear();
      for (const d of dressings) {
        if (d.anchor) this.stagingAnchors.set(d.purposeId, { x: d.anchor.x, y: d.anchor.y });
      }
      for (const d of dressings) dressRoomPurpose(dressEnv, map.rooms[d.roomIdx], d);
      // CORRIDOR TISSUE: the job leaks out the door so corridors read as
      // paths BETWEEN places rather than filler.
      for (const d of dressings) spillPurposeDoorways(dressEnv, map.rooms[d.roomIdx], d.purpose);
    }

    // 4) LANDMARK hall: colonnade + centerpiece on the SIM's set-piece tiles
    //    (map.pillars / map.pedestal — real Wall tiles the player cannot walk
    //    through; the mapgen owns the layout so looks and collision agree).
    //    Band-flavored models: bookcases in the Undercroft library, columns in
    //    the cistern, dead trees at the Garden crypt (FLOOR_THEMES.landmark).
    //    Centerpiece note: table_small_decorated_A stays out — its model has
    //    candles baked in, and candles are banned from the floors.
    {
      const lm = theme.landmark;
      for (const ti of map.pillars ?? []) {
        const px = (ti % map.w) + 0.5, py = Math.floor(ti / map.w) + 0.5;
        // Fill the tile: the visual footprint should MATCH the blocked tile.
        place(lm.pillarKey, px, py, { scale: Math.max(0.9, lm.pillarScale), rot: 0, jitter: 0, onWall: true });
      }
      if ((map.pedestal ?? -1) >= 0) {
        const px = (map.pedestal % map.w) + 0.5, py = Math.floor(map.pedestal / map.w) + 0.5;
        place(lm.centerpieceKey, px, py, { scale: Math.max(0.95, lm.centerpieceScale), rot: 0, jitter: 0, onWall: true });
      }
    }

    // 5) VAULT: the hoard around the guardian's treasure. One vault in four
    //    keeps its gold in a MIMIC — cosmetic foreshadowing only, the sim
    //    doesn't know; it just reads as "this dungeon bites."
    const vaultIdx = map.roles.indexOf("vault");
    if (vaultIdx >= 0) {
      const r = map.rooms[vaultIdx];
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const chestKey = frng() < 0.25 ? "chest_mimic" : "chest_large_gold";
      if (!place(chestKey, cx, cy + 1, { scale: 0.85, rot: Math.PI, jitter: 0 })) {
        place("chest_gold", cx, cy + 1, { scale: 0.7, rot: Math.PI, jitter: 0 });
      }
      place("gems_pile_large", cx - 1.2, cy, { scale: 0.6 });
      place("gold_bars_stack_medium", cx + 1.2, cy - 0.4, { scale: 0.5 });
      place("money_pile_medium", cx + 0.5, cy + 0.4, { scale: 0.5 });
      place("coin_stack_large", cx - 0.5, cy - 0.8, { scale: 0.4 });
      place("gems_chest", cx - 1.6, cy + 1.2, { scale: 0.6 });
    }

    // 6) Boss arenas are summoning sites: a ritual circle under the menace
    //    marks where the System put it down. The finale's is DemonLord-sized.
    const boss = state.monsters.find((mo) => mo.kind === "boss");
    if (boss) {
      place("summoning_circle", boss.pos.x, boss.pos.y, {
        scale: state.floor >= CONFIG.finalFloor ? 3.2 : 2.0,
        rot: 0,
        jitter: 0,
      });
    }

    // 6.5) SCATTER-KIT CLUMPS (D2R debris density): a few clustered piles of
    //    themed junk per room — bones, rubble, mushrooms, workshop spill —
    //    with rotation/scale jitter. Keys correlate per clump (a bone pile is
    //    bones, not one of everything), so the dressing reads as history.
    if (theme.scatter) {
      const sc = theme.scatter;
      for (const r of map.rooms) {
        if (r.w < 5 || r.h < 5) continue;
        const clumps = sc.clumpsPerRoom[0] + Math.floor(frng() * (sc.clumpsPerRoom[1] - sc.clumpsPerRoom[0] + 1));
        for (let c = 0; c < clumps; c++) {
          const cx = r.x + 1.4 + frng() * (r.w - 2.8);
          const cy = r.y + 1.4 + frng() * (r.h - 2.8);
          // 1-2 correlated keys per clump.
          const kA = sc.keys[Math.floor(frng() * sc.keys.length)];
          const kB = frng() < 0.45 ? sc.keys[Math.floor(frng() * sc.keys.length)] : kA;
          const n = sc.perClump[0] + Math.floor(frng() * (sc.perClump[1] - sc.perClump[0] + 1));
          for (let k = 0; k < n; k++) {
            const ang = frng() * Math.PI * 2;
            const rad = 0.25 + frng() * 0.85;
            place(k % 2 === 0 ? kA : kB, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, {
              jitter: 0.3, scale: 0.3 + frng() * 0.3,
            });
          }
        }
      }
    }

    // 7) A sprinkle of theme props elsewhere for texture (the intentional
    //    placements carry the look; this keeps corridors from going sterile).
    const density = theme.propDensity * 0.7 * (0.6 + frng() * 0.9);
    for (let y = 1; y < map.h - 1 && this.propEntries.length < PROP_CAP; y++) {
      for (let x = 1; x < map.w - 1 && this.propEntries.length < PROP_CAP; x++) {
        if (map.tiles[y * map.w + x] !== Tile.Floor) continue;
        // Open-air: keep scatter off the trodden paths so the tracks stay
        // readable — a bush in the middle of the trail unreads the trail.
        if (openAir && !roomMask[y * map.w + x]) continue;
        if (frng() > density) continue;
        const key = theme.props[Math.floor(frng() * theme.props.length)];
        place(key, x + 0.5, y + 0.5, { jitter: 0.4 });
      }
    }

    // Contact grounding under clutter: the floor tile beneath every placed
    // prop darkens a touch in the baked lit color, and each prop records its
    // placed scale so the fog reveal can ease it in instead of popping it.
    for (const e of this.propEntries) {
      e.base = e.obj.scale.clone();
      const cell = groundByTile.get(e.tile);
      if (!cell) continue;
      // Whisper only — the baked contact stamp does the real grounding now.
      for (const { cols, i } of cell) {
        cols[i * 3] *= 0.94;
        cols[i * 3 + 1] *= 0.94;
        cols[i * 3 + 2] *= 0.94;
      }
    }

    // Stamp the finished static instance tints (one-time — per-frame light
    // now happens per fragment in the world-lit materials).
    {
      const col = new THREE.Color();
      for (const { mesh, cols } of litByMesh) {
        for (let i = 0; i < mesh.count; i++) {
          col.setRGB(cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2]);
          mesh.setColorAt(i, col);
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    // CONTACT SHADOWS: every placed prop joins the cluster pieces collected
    // above — stamped into the baked light grid's AO channel below (crisper
    // than transparent quads and free at render time), so nothing in the
    // frame floats; the shadow-mapped key light layers real cast shadows on top.
    {
      const propBox = new THREE.Box3();
      const propSize = new THREE.Vector3();
      for (const e of this.propEntries) {
        propBox.setFromObject(e.obj);
        propBox.getSize(propSize);
        if (propSize.y < 0.12) continue; // flat sheets (water pools) cast nothing
        blobSpots.push({
          x: (propBox.min.x + propBox.max.x) / 2,
          z: (propBox.min.z + propBox.max.z) / 2,
          r: Math.min(1.15, Math.max(0.16, 0.55 * Math.max(propSize.x, propSize.z))),
        });
      }
    }

    // TORCH FLAMES: a LAYERED emitter at every sconce/lantern — small hot
    // core (tinted, never clipped white), saturated colored mid-glow, wide
    // subtle halo — with per-light size variance, flickered per frame in
    // update() and fog-gated. The flame reads as a fire, not a white disc.
    this.flameSprites = [];
    {
      const torchC = new THREE.Color(theme.torchColor);
      const coreC = torchC.clone().lerp(new THREE.Color(0xfff3dc), 0.55).getHex();
      const midC = torchC.getHex();
      const haloC = torchC.clone().lerp(new THREE.Color(theme.mood.gradeShadow), 0.15).getHex();
      const flameY = openAir ? 1.12 : 0.98;
      for (const a of this.torchAnchors) {
        const v = 0.85 + 0.3 * (((Math.imul((a.seed * 97) | 0, 2654435761) >>> 8) % 1000) / 1000);
        const tile = Math.min(map.tiles.length - 1, Math.max(0, Math.floor(a.y) * map.w + Math.floor(a.x)));
        const layers: { c: number; size: number; op: number; role: 0 | 1 | 2 }[] = [
          { c: coreC, size: 0.26 * v, op: 0.88, role: 0 },
          { c: midC, size: 0.62 * v, op: 0.5, role: 1 },
          { c: haloC, size: 1.6 * v, op: 0.13, role: 2 },
        ];
        for (const l of layers) {
          const s = this.makeGlow(l.c, l.size);
          s.position.set(a.x, flameY + (l.role === 2 ? 0.12 : 0), a.y);
          s.userData.noAO = true;
          (s.material as THREE.SpriteMaterial).opacity = l.op;
          this.floorMats.push(s.material);
          this.floorGroup.add(s);
          this.flameSprites.push({ s, seed: a.seed, base: l.size, tile, role: l.role, baseOp: l.op });
        }
      }
    }

    // BAKE the light/AO grid: wall-shadowed torch pools + junction AO +
    // contact shadows + macro grime + per-room stains (see lightGrid.ts).
    {
      const torchTint = new THREE.Color(theme.torchColor);
      const lights: BakeLight[] = this.torchAnchors.map((a) => ({
        x: a.x, y: a.y, r: openAir ? 4.2 : 4.8,
        color: { r: torchTint.r, g: torchTint.g, b: torchTint.b },
        intensity: theme.torchIntensity * 0.42,
      }));
      // The descent gate glows System gold.
      lights.push({
        x: map.stairs.x, y: map.stairs.y, r: 3.4,
        color: { r: 0.79, g: 0.64, b: 0.29 }, intensity: 0.85, jitter: false,
      });
      const stains: BakeStain[] = [];
      for (const r of map.rooms) {
        const count = 1 + Math.floor(frng() * 3);
        for (let i = 0; i < count; i++) {
          stains.push({
            x: r.x + 1 + frng() * Math.max(1, r.w - 2),
            z: r.y + 1 + frng() * Math.max(1, r.h - 2),
            r: 0.7 + frng() * 1.3,
            s: 0.10 + frng() * 0.16,
          });
        }
      }
      this.lightGridTex?.dispose();
      this.lightGridTex = bakeLightGrid({
        w: map.w, h: map.h,
        isWall: (x, y) => map.tiles[y * map.w + x] === Tile.Wall,
        lights,
        stamps: blobSpots.map((b) => ({ x: b.x, z: b.z, r: b.r, s: 0.5 })),
        stains,
        seed: (state.seed ^ Math.imul(state.floor, 0x1f7b)) | 0,
      });
      this.wl.uWlLm.value = this.lightGridTex;
    }

    this.builtFloor = state.floor;
    this.builtMapVersion = state.mapVersion;
    this.builtSeed = state.seed;
  }

  /** Point lights anchored where torch meshes were placed (light = source). */
  private addTorches(theme: FloorTheme, anchors: Vec2[], intensityJitter: number): void {
    // Demoted to fill: the baked light grid carries the pools (with real 2D
    // wall shadows); these dynamic lights exist to flicker, to catch moving
    // characters, and to give walls a specular kiss — so they stay small,
    // or their unshadowed wash would bleed through walls again.
    this.torchBase = theme.torchIntensity * intensityJitter * 0.55;
    this.torchAnchors = anchors.map((s, i) => ({ x: s.x, y: s.y, seed: i * 1.7 }));
    if (this.torchPool.length === 0) {
      for (let i = 0; i < Renderer3D.TORCH_POOL_SIZE; i++) {
        const light = new THREE.PointLight(0xffffff, 0, THEME.torchDistance, 2);
        this.scene.add(light);
        this.torchPool.push(light);
      }
    }
    for (const light of this.torchPool) {
      light.color.set(theme.torchColor);
      light.intensity = 0;
    }
    this.torchState = this.torchPool.map(() => ({ anchor: -1, level: 0, wanted: false }));
  }

  // ---- Fog of war ----

  /**
   * Per-frame world-light drive: the heavy lifting (fog reveal + distance
   * falloff) happens per FRAGMENT in the world-lit materials — here we only
   * feed the shared uniforms and run the cheap prop-reveal ease. The reveal
   * frontier is the fog bank's bilinear mask, so light-to-dark is a smooth
   * vignette, never a staircase of tile-sized rectangles.
   */
  private updateFogTint(state: GameState, px: number, pz: number): void {
    const { map } = state;
    this.wl.uWlPlayer.value.set(px, pz);
    const alphas = this.fogBank.alphas;
    if (alphas.length !== map.w * map.h) return; // rebuild in flight
    // Props ride the same animated alpha: they scale in as their tile's fog
    // dissipates instead of visibility-popping into the frame.
    for (const e of this.propEntries) {
      const a = alphas[e.tile] ?? 1;
      const f = 1 - a;
      e.obj.visible = f > 0.04;
      if (e.base) {
        if (f < 0.999) e.obj.scale.copy(e.base).multiplyScalar(0.72 + 0.28 * f);
        else e.obj.scale.copy(e.base);
      }
    }
    if (this.stairsObj) this.stairsObj.visible = (alphas[this.stairsTile] ?? 1) < 0.6;
  }

  // ---- Ability visuals (orbit blades + nova ring) ----

  /** Sponsor Airstrike: shells render as falling KEGS (sponsor-branded
   * ordnance); each impact pops an orange burst where it lands. */
  private updateStrikeFx(state: GameState): void {
    const strikes = state.strikes ?? [];
    // Impacts: the count dropped — burst at the previous positions that landed.
    if (strikes.length < this.prevStrikeCount) {
      for (const pos of this.prevStrikePos.slice(strikes.length)) {
        this.burst(pos.x, pos.y, 0xffa040, 14, 0.9, CONFIG.ultAirstrikeRadius);
        // Debris ring under the impact: the crater the keg leaves behind.
        this.spawnFadeProp("fx_blast_star", pos.x, 0.04, pos.y, CONFIG.ultAirstrikeRadius * 0.8, 0.4,
          { tint: 0xffa040, spin: 0.6, grow: 1.6, footprint: true, pop: true });
        this.addTrauma(0.45); // sponsor ordnance lands with authority
        this.spawnFxLight(pos.x, pos.y, 0xff9a40, 15, 0.5, 1.0);
      }
    }
    this.prevStrikeCount = strikes.length;
    this.prevStrikePos = strikes.map((s) => ({ x: s.pos.x, y: s.pos.y }));
    for (let i = 0; i < Math.max(this.strikeMeshes.length, strikes.length); i++) {
      const s = strikes[i];
      let mesh = this.strikeMeshes[i];
      if (!s) { if (mesh) mesh.visible = false; continue; }
      const kind = s.kind ?? "shell";
      if (!mesh || mesh.userData.strikeKind !== kind) {
        // Kind-aware pool: an Aftermath echo is a ground pulse, not falling
        // sponsor ordnance — it must never render as the airstrike keg.
        if (mesh) this.scene.remove(mesh);
        if (kind === "echo") {
          mesh = this.buildFxRing("cataclysm");
          this.scene.remove(mesh); // buildFxRing adds; re-add via the pool below
        } else {
          // Real sponsor ordnance at last; the tavern keg was always a loaner.
          mesh = this.modelInstance("sponsor_shell") ?? this.modelInstance("keg") ?? new THREE.Mesh(
            new THREE.ConeGeometry(0.18, 0.5, 6), flat(0xb0742c, { emissive: 0x662200, emissiveIntensity: 0.4 }));
          mesh.scale.multiplyScalar(0.5);
        }
        mesh.userData.strikeKind = kind;
        this.scene.add(mesh);
        this.strikeMeshes[i] = mesh;
      }
      mesh.visible = true;
      if (kind === "echo") {
        // The ground remembers where you stood: the crown tightens in place,
        // spinning slowly until the echo detonates.
        const r = (s.radius ?? 2) * 0.85;
        mesh.position.set(s.pos.x, 0.02, s.pos.y);
        mesh.scale.setScalar(((mesh.userData.baseScale as number) ?? 1) * r);
        if (mesh.userData.model) mesh.rotation.y += 0.03;
        for (const mat of (mesh.userData.mats as THREE.Material[]) ?? []) {
          (mat as THREE.MeshBasicMaterial).opacity = 0.75;
        }
      } else {
        mesh.position.set(s.pos.x, 0.3 + s.t * 14, s.pos.y); // falls as t runs out
        mesh.rotation.x += 0.2;
        mesh.rotation.z += 0.13;
      }
    }
  }

  /** Which real mesh a projectile flies as, or null for the glow orb: a
   * ballistic crawler's shot is a fletched arrow. Monster shots are all
   * casts — the "ranged" archetype is a skeleton MAGE — so every enemy
   * bolt stays a glowing missile, as does the players' magic. */
  private projectileModelKey(pr: GameState["projectiles"][number], state: GameState): string | null {
    if (pr.from === "enemy") return null;
    if (pr.school === "magic") return null;
    const owner = state.players.find((p) => p.id === pr.ownerId);
    return owner && weaponClassOf(owner.equipment.weapon) === "ballistic" ? "weapon_arrow_a" : null;
  }

  /** FX that live inside a monster's tell: the spitter's thorn arcs toward its
   * committed splash point, the bomber hoists its bomb overhead. Both vanish
   * the moment the windup resolves or is interrupted; damage never lives here. */
  private updateWindupFx(state: GameState): void {
    const seen = new Set<number>();
    for (const m of state.monsters) {
      const total = m.windupTotal ?? 0;
      if (!m.windupKind || m.windup === undefined || total <= 0) continue;
      const k = Math.min(1, Math.max(0, 1 - m.windup / total)); // 0 at commit -> 1 at resolve
      if (m.windupKind === "spit" && m.spitTarget) {
        const fx = this.windupFxFor(m.id, "plant_warrior_arrow", 0.8);
        if (fx) {
          seen.add(m.id);
          const x = m.pos.x + (m.spitTarget.x - m.pos.x) * k;
          const z = m.pos.y + (m.spitTarget.y - m.pos.y) * k;
          fx.position.set(x, 0.9 + Math.sin(k * Math.PI) * 1.1, z);
          fx.rotation.y = Math.atan2(m.spitTarget.x - m.pos.x, m.spitTarget.y - m.pos.y);
          // The thorn's rest pose already lies nose-forward (+Z); just pitch
          // it over the arc as it flies.
          (fx.children[0] as THREE.Object3D).rotation.x = (k - 0.5) * 1.1;
          fx.visible = true;
        }
      } else if (m.windupKind === "fuse") {
        const fx = this.windupFxFor(m.id, "clown_bomb", 0.5);
        if (fx) {
          seen.add(m.id);
          fx.position.set(m.pos.x, 1.9 + 0.1 * Math.sin(k * 24), m.pos.y);
          fx.rotation.y = k * 9; // frantic little spin as the fuse runs down
          fx.visible = true;
        }
      }
    }
    for (const [id, fx] of this.windupFx) {
      if (!seen.has(id)) { this.scene.remove(fx); this.windupFx.delete(id); }
    }
  }

  /** Get-or-build the windup FX group for a monster; null if the model pack
   * is absent (the telegraph ring still tells the story on its own). */
  private windupFxFor(monsterId: number, key: string, scale: number): THREE.Group | null {
    let fx = this.windupFx.get(monsterId) ?? null;
    if (!fx) {
      const model = this.modelInstance(key);
      if (!model) return null;
      model.scale.setScalar(scale);
      fx = new THREE.Group();
      fx.add(model);
      this.scene.add(fx);
      this.windupFx.set(monsterId, fx);
    }
    return fx;
  }

  /** Orbit blade: a real knife (the Fantasy Weapons dagger) laid flat so the
   * yaw set each frame noses it along its orbit; gem fallback if no model. */
  private buildOrbitBlade(): THREE.Group {
    const group = new THREE.Group();
    const dagger = this.models["weapon_dagger_a"]?.scene.clone(true);
    if (dagger) {
      dagger.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        // Emissive tint on CLONED materials (the source scene keeps its own).
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.emissive = new THREE.Color(0x2f7d99);
        mat.emissiveIntensity = 0.7;
        mesh.material = mat;
      });
      dagger.rotation.x = Math.PI / 2; // grip-up rest pose -> blade forward (+Z)
      dagger.scale.setScalar(0.7);
      group.add(dagger);
    } else {
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.16, 0),
        flat(0x9fe8ff, { emissive: 0x2f7d99, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.3 }),
      );
      gem.castShadow = true;
      group.add(gem);
    }
    return group;
  }

  private updateAbilityFx(state: GameState): void {
    this.updateStrikeFx(state);
    // A loot box GRANTED is a delivery: the System sets the box down at the
    // crawler's feet for a beat. (Opening it stays in the menu — meta layer.)
    if (state.lootBoxes > this.prevLootBoxes && this.prevLootBoxes >= 0) {
      const pb = state.players.find((pl) => pl.alive) ?? state.players[0];
      if (pb) this.spawnFadeProp("system_loot_box", pb.pos.x, 0.08, pb.pos.y, 0.6, 1.2, { spin: 1.6 });
    }
    this.prevLootBoxes = state.lootBoxes;
    for (const p of state.players) {
      // Orbit blades: only while SLOTTED (matches updateOrbit in the sim —
      // a benched orbit spins no steel).
      const op = slotted(p, "orbit") && p.alive ? orbitParams(p) : null;
      const want = op ? op.blades : 0;
      let blades = this.orbitBlades.get(p.id);
      if (!blades) { blades = []; this.orbitBlades.set(p.id, blades); }
      while (blades.length < want) {
        const blade = this.buildOrbitBlade();
        this.scene.add(blade);
        blades.push(blade);
      }
      while (blades.length > want) this.scene.remove(blades.pop()!);
      if (op) {
        for (let i = 0; i < blades.length; i++) {
          // Shared with the sim's hit test (incl. Corkscrew spiral radii).
          const bp = orbitBladePos(p, i);
          blades[i].position.set(bp.x, 0.75, bp.y);
          // Nose along the direction of travel (tangent to the ring).
          blades[i].rotation.y = -Math.atan2(bp.y - p.pos.y, bp.x - p.pos.x);
        }
      }
      // Nova/Cataclysm ring: the two ults SHARE the novaFlash flag; the
      // cataclysm cd edge at cast time decides which effect (and radius)
      // this flash is — previously cataclysm reused nova's ring at nova's
      // radius and was indistinguishable from a common nova.
      const cataRose = (p.cd.cataclysm ?? 0) > (this.fxPrevCata.get(p.id) ?? 0) + 1e-6;
      this.fxPrevCata.set(p.id, p.cd.cataclysm ?? 0);
      let ring = this.novaRings.get(p.id) ?? null;
      if (p.novaFlash > 0) {
        const fresh = !ring || !ring.visible;
        if (fresh) {
          const kind = cataRose ? "cataclysm" : "nova";
          if (!ring || ring.userData.kind !== kind) {
            if (ring) this.scene.remove(ring);
            ring = this.buildFxRing(kind);
            this.novaRings.set(p.id, ring);
          }
          ring.userData.radius = kind === "cataclysm" ? cataclysmParams(p).radius : novaParams(p).radius;
          ring.userData.flashTotal = p.novaFlash;
          // IMPLOSION capstone: the drag-inward gets a collapsing vortex cone
          // a beat before the shockwave reads outward.
          if (kind === "nova" && rank(p, "nova.implode") > 0) {
            this.spawnFadeProp("fx_implosion_cone", p.pos.x, 0.05, p.pos.y,
              (ring.userData.radius as number) * 0.7, 0.3,
              { tint: 0x8fd8ff, spin: 9, grow: -2.6, footprint: true });
          }
          const color = kind === "cataclysm" ? 0xff8a3c : 0x8fd8ff;
          // Additive puffs stack hot over a big radius — cataclysm gets more
          // of them but SMALLER, or the whole arena washes to white.
          this.burst(p.pos.x, p.pos.y, color, kind === "cataclysm" ? 22 : 18,
            kind === "cataclysm" ? 0.65 : 0.7, ring.userData.radius as number);
          // Layered secondary: the crown's blast kicks up a debris ring too.
          if (kind === "cataclysm") {
            this.spawnFadeProp("fx_blast_star", p.pos.x, 0.03, p.pos.y,
              (ring.userData.radius as number) * 0.55, 0.45,
              { tint: 0xff8a3c, spin: 0.8, grow: 1.4, footprint: true });
          }
          this.addTrauma(kind === "cataclysm" ? 0.45 : 0.3);
          // The blast lights the arena: pooled FX light with a decay envelope.
          this.spawnFxLight(p.pos.x, p.pos.y, color,
            kind === "cataclysm" ? 17 : 11, kind === "cataclysm" ? 0.6 : 0.45, 1.0);
        }
        const total = (ring!.userData.flashTotal as number) || 0.3;
        const prog = Math.min(1, Math.max(0, 1 - p.novaFlash / total));
        // Ease-out expansion: a shockwave moves fastest at birth and lands
        // soft — linear reads mechanical. Opacity holds through the front
        // half so the shape is SEEN, then drops away.
        const eased = 1 - Math.pow(1 - prog, 2.4);
        const radius = (ring!.userData.radius as number) ?? novaParams(p).radius;
        ring!.visible = true;
        const cata = ring!.userData.kind === "cataclysm";
        // The crown ERUPTS: it rises out of the floor over the first beats.
        ring!.position.set(p.pos.x, cata ? -0.3 + 0.32 * Math.min(1, prog * 2.5) : 0.15, p.pos.y);
        ring!.scale.setScalar(((ring!.userData.baseScale as number) ?? 1) * Math.max(0.05, radius * eased));
        if (ring!.userData.model) ring!.rotation.y += 0.05; // slow rune spin (mesh only)
        for (const mat of ring!.userData.mats as THREE.Material[]) {
          (mat as THREE.MeshBasicMaterial).opacity = 1 - Math.pow(prog, 2.2);
        }
      } else if (ring) {
        ring.visible = false;
      }
    }
  }

  /** Spell-FX ring (GENERATION-BACKLOG 3b): the generated effect mesh with an
   * emissive fade treatment, or the classic bare torus when the file is
   * absent. Normalized so scale.setScalar(r) puts the rim at world radius r. */
  private buildFxRing(kind: "nova" | "cataclysm"): THREE.Object3D {
    const color = kind === "cataclysm" ? 0xff8a3c : 0x8fd8ff;
    const model = this.modelInstance(kind === "cataclysm" ? "fx_cataclysm_crown" : "fx_nova_ring");
    const mats: THREE.Material[] = [];
    let obj: THREE.Object3D;
    let baseScale = 1;
    if (model) {
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      baseScale = 2 / Math.max(size.x, size.z, 1e-3); // unit-radius footprint
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.transparent = true;
        mat.depthWrite = false;
        mat.emissive = new THREE.Color(color);
        mat.emissiveIntensity = 0.55;
        m.material = mat;
        mats.push(mat);
      });
      obj = model;
      obj.userData.model = true;
    } else {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 8, 40), mat);
      torus.rotation.x = -Math.PI / 2;
      mats.push(mat);
      obj = torus;
    }
    obj.userData.kind = kind;
    obj.userData.mats = mats;
    obj.userData.baseScale = baseScale;
    this.scene.add(obj);
    return obj;
  }

  // ---- Per-frame sync ----

  update(state: GameState, time: number): void {
    // Rebuild cached floor geometry on descent, on in-place tile mutations
    // (e.g. locked doors opening when the key is picked up) AND on a new run:
    // every fresh season starts back at floor 1 / mapVersion 1 — exactly what
    // this cache holds after the previous run's floor 1 — so without the seed
    // in the key the old dungeon kept rendering over the new layout (players
    // walking through walls after a restart). Same seed = same generated map,
    // so a daily rerun keeping its geometry is correct, not a miss.
    const prevFloor = this.builtFloor; // for the portal arrival FX below
    const rebuilt =
      state.floor !== this.builtFloor ||
      state.mapVersion !== this.builtMapVersion ||
      state.seed !== this.builtSeed;
    if (rebuilt) {
      // Corpses belong to the old geometry — never carry them across a rebuild.
      for (const d of this.dying) this.scene.remove(d.mesh);
      this.dying = [];
      this.buildFloor(state);
    }
    if (state.exploredVersion !== this.lastExploredVersion) {
      this.lastExploredVersion = state.exploredVersion;
      this.fogBank.setExplored(state, this.fogSnap);
      this.fogSnap = false;
    }
    const dt = this.prevTime ? Math.min(0.1, time - this.prevTime) : 1 / 60;
    this.prevTime = time;
    this.fogBank.update(dt, time);

    // The camera/light anchor: the local player (fall back to the first).
    const p = state.players.find((pl) => pl.id === this.localPlayerId) ?? state.players[0];
    if (!p) return;
    // Tile tint chases the fog bank's animated reveal + the player's position.
    this.updateFogTint(state, p.pos.x, p.pos.y);

    // Descent gate FX. The energy surface swirls whenever the gate is on
    // screen knowledge (explored); the trip itself gets a gold burst on both
    // ends — departure when the gate accepts the party (safe room opens),
    // arrival when the next floor materializes around the spawn.
    if (this.portalSwirl && this.stairsObj?.visible) {
      this.portalSwirl.rotation.z = time * 1.7;
      (this.portalSwirl.material as THREE.MeshBasicMaterial).opacity = 0.32 + 0.1 * Math.sin(time * 2.6);
      if (this.portalCore) this.portalCore.rotation.z = -time * 2.6;
    }
    const inSafeRoom = !!state.safeRoom;
    if (inSafeRoom && !this.wasInSafeRoom && this.portalPos) {
      this.burst(this.portalPos.x, this.portalPos.y, 0xc9a24b, 16, 0.85, 1.3);
      for (let i = 0; i < 5; i++) {
        this.spawnGlow(this.portalPos.x, 0.4 + i * 0.4, this.portalPos.y, 0xf5e6bf, 0.7, 0.5);
      }
      this.spawnFxLight(this.portalPos.x, this.portalPos.y, 0xc9a24b, 9, 0.7, 1.1);
    }
    this.wasInSafeRoom = inSafeRoom;
    if (rebuilt && state.floor === prevFloor + 1) {
      this.burst(p.pos.x, p.pos.y, 0xc9a24b, 16, 0.85, 1.2);
      for (let i = 0; i < 5; i++) {
        this.spawnGlow(p.pos.x, 0.4 + i * 0.35, p.pos.y, 0xf5e6bf, 0.65, 0.5);
      }
      this.spawnFxLight(p.pos.x, p.pos.y, 0xc9a24b, 9, 0.7, 1.1);
    }

    // Players: reconcile mesh pool + animate each.
    const pSeen = new Set<number>();
    for (const pl of state.players) {
      pSeen.add(pl.id);
      // Hero skin: the campfire pick when the crawler made one, else derived
      // from (seed, player id). A change rebuilds the body + regrafts.
      const skin = Renderer3D.skinIdFor(pl, state.seed);
      let mesh = this.playerMeshes.get(pl.id);
      if (mesh && mesh.userData.skinId !== skin) {
        this.scene.remove(mesh);
        this.playerMeshes.delete(pl.id);
        this.loadoutKeys.delete(pl.id);
        mesh = undefined;
      }
      if (!mesh) { mesh = this.buildPlayerMesh(skin); this.scene.add(mesh); this.playerMeshes.set(pl.id, mesh); }
      // Blindside: a teleport, not a sprint. On the cutto cd edge (BEFORE
      // smoothTo runs), smoke both ends, drop the smokebomb where the crawler
      // WAS, and snap the mesh to the strike.
      {
        const prevCut = this.fxPrevCutto.get(pl.id);
        if (prevCut !== undefined && (pl.cd.cutto ?? 0) > prevCut + 1e-6) {
          const ox = mesh.position.x, oz = mesh.position.z;
          for (let i = 0; i < 3; i++) {
            this.spawnGlow(ox + (i - 1) * 0.2, 0.5 + i * 0.25, oz, 0xcfd6dd, 0.8, 0.45, 1.5);
            this.spawnGlow(pl.pos.x + (i - 1) * 0.2, 0.5 + i * 0.25, pl.pos.y, 0xcfd6dd, 0.8, 0.45, 1.5);
          }
          this.spawnFadeProp("smokebomb", ox, 0.15, oz, 0.7, 0.5);
          mesh.position.set(pl.pos.x, mesh.position.y, pl.pos.y);
        }
        this.fxPrevCutto.set(pl.id, pl.cd.cutto ?? 0);
      }
      this.smoothTo(mesh, pl.pos.x, 0, pl.pos.y, dt);
      this.turnTo(mesh, Math.atan2(pl.facing.x, pl.facing.y), dt);
      mesh.visible = true;
      this.applyLoadout(mesh, pl);
      // Weapon trail on the melee swing edge (attackSwing jumps up).
      {
        const prevSw = this.meleePrevSwing.get(pl.id) ?? 0;
        if (pl.alive && pl.attackSwing > prevSw + 1e-6) this.spawnMeleeTrail(mesh);
        this.meleePrevSwing.set(pl.id, pl.attackSwing);
      }
      // Animation velocity comes from the SMOOTHED mesh (which moves every
      // frame), EMA'd over ~100ms. Raw sim deltas are ZERO on render frames
      // between 60Hz sim steps (and between 15Hz net snapshots), so speed read
      // as 0 / 2x / 0 / 2x — flapping idle<->run every frame was THE walk
      // stutter. Teleports (floor change, respawn) read as absurd speed; skip
      // those samples instead of smearing them into the average.
      const move = this.smoothedVel(mesh, dt);
      const plSpeed = Math.hypot(move.x, move.y);
      if (mesh.userData.mixer) {
        // Real rigged model: drive clips; procedural bob/tip-over would fight them.
        this.animateRiggedPlayer(mesh, pl, plSpeed, move, dt);
      } else {
        this.animatePlayer(mesh, pl.alive, plSpeed, pl.attackSwing, time);
      }
      // Extradition/Slurp stow timer: hide the held weapon while the hands
      // work the chain or the bottle, restore it the moment the act is done.
      const stow = this.weaponStow.get(pl.id);
      if (stow !== undefined) {
        const left = stow - dt;
        const weaponObj = mesh.userData.weaponObj as THREE.Object3D | null | undefined;
        if (left <= 0) {
          this.weaponStow.delete(pl.id);
          if (weaponObj) weaponObj.visible = true;
        } else {
          this.weaponStow.set(pl.id, left);
          if (weaponObj) weaponObj.visible = false;
        }
      }
      // Banked states + statuses live on the BODY, not just HUD chips:
      // Overcharge crackles ember, MOMENTUM's primed crit sparks yellow, and
      // burn/poison/chill wear their own motes (semantic colors throughout).
      const nextPuff = (this.playerFxTick.get(pl.id) ?? 0) - dt;
      if (nextPuff <= 0 && pl.alive) {
        this.playerFxTick.set(pl.id, 0.16);
        const jx = () => (Math.random() - 0.5) * 0.55;
        if (pl.overcharged) {
          this.spawnGlow(mesh.position.x + jx(), 0.9 + Math.random() * 0.6, mesh.position.z + jx(), 0xd98e4a, 0.45, 0.3, 1.2);
        }
        if (pl.stanceCritReady) {
          this.spawnGlow(mesh.position.x + jx(), 0.9 + Math.random() * 0.6, mesh.position.z + jx(), 0xffe066, 0.4, 0.3, 1.2);
        }
        for (const st of pl.statuses ?? []) {
          const c = st.kind === "burn" ? 0xff7a2f : st.kind === "poison" ? 0x7ed957 : 0x7fd4ff;
          this.spawnGlow(mesh.position.x + jx(), 0.25 + Math.random() * 0.9, mesh.position.z + jx(),
            c, 0.38, 0.5, st.kind === "chill" ? 0 : 1.1);
        }
      } else {
        this.playerFxTick.set(pl.id, nextPuff);
      }
      // Briar Witch's mark: while cursedT runs, a violet sigil spins overhead
      // (the pack suddenly cares about you — now you can SEE why).
      let hexm = this.hexMarks.get(pl.id);
      if ((pl.cursedT ?? 0) > 0 && pl.alive) {
        if (!hexm) {
          hexm = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.16, 0),
            new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0.9 }),
          );
          this.scene.add(hexm);
          this.hexMarks.set(pl.id, hexm);
        }
        hexm.position.set(mesh.position.x, 2.2, mesh.position.z);
        hexm.rotation.y += dt * 3;
        hexm.visible = mesh.visible;
      } else if (hexm) {
        this.scene.remove(hexm);
        this.hexMarks.delete(pl.id);
      }
      // The Slurp bottle: grafted once, shown only while the drink act runs.
      const sip = this.potionShow.get(pl.id);
      if (sip !== undefined) {
        if (mesh.userData.potionProp === undefined) {
          mesh.userData.potionProp =
            this.showAttachment(mesh, "potion_medium_red", "*", "l");
          (mesh.userData.potionProp as THREE.Object3D | null)?.scale.setScalar(0.9);
        }
        const potion = mesh.userData.potionProp as THREE.Object3D | null;
        const left = sip - dt;
        if (left <= 0) {
          this.potionShow.delete(pl.id);
          if (potion) potion.visible = false;
        } else {
          this.potionShow.set(pl.id, left);
          if (potion) potion.visible = true;
        }
      }
    }
    for (const [id, mesh] of this.playerMeshes) {
      if (!pSeen.has(id)) {
        this.scene.remove(mesh);
        this.playerMeshes.delete(id);
        this.animPrev.delete(id);
        this.weaponStow.delete(id);
        this.potionShow.delete(id);
        this.playerFxTick.delete(id);
        const hexm = this.hexMarks.get(id);
        if (hexm) { this.scene.remove(hexm); this.hexMarks.delete(id); }
      }
    }

    // STUNT DOUBLES: a ghost-faded copy of the owner's body, idling in place.
    // (The sim moves nothing here — the contract is a statue that soaks.)
    const dSeen = new Set<number>();
    for (const dc of state.decoys ?? []) {
      dSeen.add(dc.id);
      let mesh = this.decoyMeshes.get(dc.id);
      if (!mesh) {
        const owner = state.players.find((p) => p.id === dc.ownerId);
        mesh = this.buildPlayerMesh(owner
          ? Renderer3D.skinIdFor(owner, state.seed)
          : heroSkin(state.seed, dc.ownerId));
        mesh.traverse((o) => {
          const mm = o as THREE.Mesh;
          if (!mm.isMesh || !mm.material || mm.userData.noAO) return;
          const mats = (Array.isArray(mm.material) ? mm.material : [mm.material]).map((mat) => {
            const g = mat.clone();
            g.transparent = true;
            g.opacity = 0.55;
            return g;
          });
          mm.material = Array.isArray(mm.material) ? mats : mats[0];
        });
        (mesh.userData.play as ((n: string) => void) | undefined)?.("idle");
        this.scene.add(mesh);
        this.decoyMeshes.set(dc.id, mesh);
      }
      mesh.position.set(dc.pos.x, 0, dc.pos.y);
      mesh.rotation.set(0, Math.atan2(dc.facing.x, dc.facing.y), 0);
      (mesh.userData.animTick as ((d: number) => void) | undefined)?.(dt);
    }
    for (const [id, mesh] of this.decoyMeshes) {
      if (!dSeen.has(id)) { this.scene.remove(mesh); this.decoyMeshes.delete(id); }
    }

    // SMASHABLES (phase 5): the plan's corner hoards as hittable entities.
    // Meshes are placed once (they don't move); a smashed one vanishes and
    // the sim's hit event supplies the pop. DAMAGED STATE (furniture-feel):
    // blocking furniture at 1 hp LOOKS one hit from gone — the table swaps
    // to the kit's broken model, everything else tilts and sinks. The hp
    // edge just drops the mesh; the next frame rebuilds it damaged.
    const bSeen = new Set<number>();
    for (const b of state.breakables ?? []) {
      bSeen.add(b.id);
      const damaged = !!b.footprint && b.hp === 1;
      const prev = this.breakableMeshes.get(b.id);
      if (prev && damaged && !prev.userData.damaged) {
        this.scene.remove(prev);
        this.breakableMeshes.delete(b.id);
      }
      if (!this.breakableMeshes.has(b.id)) {
        const swap = damaged ? BREAKABLE_DAMAGED[b.key] : undefined;
        const obj = this.modelInstance(swap && this.models[swap] ? swap : b.key);
        if (obj) {
          const box = new THREE.Box3().setFromObject(obj);
          const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
          // Blocking furniture fills its tile; clutter stays hand-sized.
          obj.scale.multiplyScalar((b.footprint ? 0.85 : 0.45) / fp);
          if (damaged && !(swap && this.models[swap])) {
            // No broken model in the kit: one good hit knocks it askew.
            obj.rotation.y = ((b.id * 2654435761) % 628) / 100;
            obj.rotation.z = 0.09;
          }
          const sc = new THREE.Box3().setFromObject(obj);
          obj.position.set(
            b.pos.x - (sc.min.x + sc.max.x) / 2 + obj.position.x,
            -sc.min.y + 0.004 - (damaged ? 0.05 : 0),
            b.pos.y - (sc.min.z + sc.max.z) / 2 + obj.position.z,
          );
          obj.userData.damaged = damaged;
          this.scene.add(obj);
          this.breakableMeshes.set(b.id, obj);
        }
      }
      const mesh = this.breakableMeshes.get(b.id);
      if (mesh) mesh.visible = !!state.explored[Math.floor(b.pos.y) * state.map.w + Math.floor(b.pos.x)];
    }
    for (const [id, mesh] of this.breakableMeshes) {
      if (!bSeen.has(id)) { this.scene.remove(mesh); this.breakableMeshes.delete(id); }
    }

    // Fog of war: entities render inside ANY living player's vision (shared show).
    const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
    const inVision = (pos: Vec2): boolean => {
      for (const pl of state.players) {
        if (!pl.alive) continue;
        const dx = pos.x - pl.pos.x, dy = pos.y - pl.pos.y;
        if (dx * dx + dy * dy <= vis2) return true;
      }
      return false;
    };

    // Roam settlement NPC: at most one at a time, so no id-keyed mesh pool —
    // just toggle/reposition the single mesh.
    if (state.npc) {
      if (!this.npcMesh) {
        this.npcMesh = this.buildNpcMesh();
        this.scene.add(this.npcMesh);
      }
      this.npcMesh.position.set(state.npc.pos.x, 0, state.npc.pos.y);
      this.npcMesh.visible = inVision(state.npc.pos);
    } else if (this.npcMesh) {
      this.scene.remove(this.npcMesh);
      this.npcMesh = null;
    }

    // Monsters: reconcile mesh pool with live monster set + animate.
    // RENDER-SIDE SEPARATION: overlapping enemies push each other's DISPLAY
    // position apart (sim untouched), so a pack rings the player instead of
    // interpenetrating into one mass of heads. O(n^2) over live monsters —
    // fine at pack sizes; offsets ease in/out and are clamped small.
    const sepTargets = new Map<number, { x: number; z: number }>();
    {
      const live = state.monsters;
      for (let i = 0; i < live.length; i++) {
        const a = live[i];
        if (a.dormant) continue;
        const ra = 0.34 * (THEME.archetype[a.kind]?.scale ?? 1);
        for (let j = i + 1; j < live.length; j++) {
          const b = live[j];
          if (b.dormant) continue;
          const rb = 0.34 * (THEME.archetype[b.kind]?.scale ?? 1);
          let dx = a.pos.x - b.pos.x;
          let dz = a.pos.y - b.pos.y;
          const rr = ra + rb;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) { // coincident: split on a stable per-id axis
            dx = Math.sin(a.id * 1.7 + b.id);
            dz = Math.cos(a.id * 1.7 + b.id);
            d = 1;
          }
          const push = Math.min(0.4, (rr - d) * 0.5);
          const nx = (dx / d) * push;
          const nz = (dz / d) * push;
          const ta = sepTargets.get(a.id) ?? { x: 0, z: 0 };
          ta.x += nx; ta.z += nz; sepTargets.set(a.id, ta);
          const tb = sepTargets.get(b.id) ?? { x: 0, z: 0 };
          tb.x -= nx; tb.z -= nz; sepTargets.set(b.id, tb);
        }
      }
    }
    const sepEase = 1 - Math.exp(-10 * dt);
    const seen = new Set<number>();
    for (const mon of state.monsters) {
      seen.add(mon.id);
      let mesh = this.monsters.get(mon.id);
      // Second-stage morphs (the understudy) CHANGE KIND mid-fight — drop the
      // old body and build the new one (the wolf takes the role).
      if (mesh && mesh.userData.simKind !== mon.kind) {
        this.scene.remove(mesh);
        this.monsters.delete(mon.id);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = this.buildMonsterMesh(mon.kind, state.floor, mon.elite,
          mon.defId ? mobDefById(mon.defId) : undefined);
        mesh.userData.simKind = mon.kind;
        if (mon.elite) {
          // Neighborhood boss: visibly bigger than its archetype.
          const bs = ((mesh.userData.baseScale as number) ?? 1) * CONFIG.eliteScale;
          mesh.userData.baseScale = bs;
          mesh.scale.setScalar(bs);
          this.applyAffixVisual(mesh, mon.affix, mon.kind);
        } else if (mon.veteran) {
          // Veteran pack anchor: the silhouette IS the telegraph — bigger
          // than its pack, smaller than an elite, no other fanfare.
          const bs = ((mesh.userData.baseScale as number) ?? 1) * CONFIG.veteranScale;
          mesh.userData.baseScale = bs;
          mesh.scale.setScalar(bs);
        }
        this.scene.add(mesh);
        this.monsters.set(mon.id, mesh);
      }
      mesh.visible = inVision(mon.pos);
      this.applyHitFlash(mesh, mon.hitFlash);
      const bs = (mesh.userData.baseScale as number) ?? 1;
      {
        // Separation is a pure display offset layered over the sim position:
        // strip last frame's offset, chase the sim, ease toward the new one.
        const udS = mesh.userData;
        const oldX = (udS.sepX as number) || 0;
        const oldZ = (udS.sepZ as number) || 0;
        mesh.position.x -= oldX;
        mesh.position.z -= oldZ;
        this.smoothTo(mesh, mon.pos.x, 0, mon.pos.y, dt);
        const st = sepTargets.get(mon.id);
        const nx = oldX + (((st?.x ?? 0) - oldX) * sepEase);
        const nz = oldZ + (((st?.z ?? 0) - oldZ) * sepEase);
        udS.sepX = nx;
        udS.sepZ = nz;
        mesh.position.x += nx;
        mesh.position.z += nz;
      }
      const mVel = this.smoothedVel(mesh, dt);
      const mSpeed = Math.hypot(mVel.x, mVel.y);
      mesh.rotation.y = Math.atan2(p.pos.x - mon.pos.x, p.pos.y - mon.pos.y);
      const ud0 = mesh.userData;
      if (mon.kind === "phantom") {
        // A blink is not a sprint: the sim moves it instantly, but smoothTo
        // would glide the mesh across the gap. On the blink edge (cooldown
        // jumps up), poof both ends and SNAP the body to the far one.
        const prevB = ud0.prevBlinkCd as number | undefined;
        if (prevB !== undefined && mon.blinkCd > prevB + 1e-6) {
          this.spawnGlow(mesh.position.x, 0.7, mesh.position.z, 0xbfe4ff, 0.9, 0.4, 2);
          this.spawnGlow(mon.pos.x, 0.7, mon.pos.y, 0xbfe4ff, 0.9, 0.4, 2);
          mesh.position.set(mon.pos.x, mesh.position.y, mon.pos.y);
        }
        ud0.prevBlinkCd = mon.blinkCd;
      }
      if (mon.kind === "filcher" && ud0.lootProp) {
        // The Repo Rat shows its work: the repossessed pile only rides along
        // while it is actually carrying stolen gold.
        (ud0.lootProp as THREE.Object3D).visible = (mon.carry ?? 0) > 0;
      }
      if (mesh.userData.mixer) {
        // Rigged model: clip by combat state. No squash (it would deform the
        // skinned mesh instead of reading as a hit).
        const ud = mesh.userData;
        const playM = ud.play as (n: string, force?: boolean) => void;
        const playFirstM = ud.playFirst as (...n: string[]) => void;
        // DORMANCY (ambush packs + greeters): hold the Inactive pose — bones
        // on the crypt floor, or a showroom unit standing among the props.
        // The awaken clip fires on the SPRING edge, not on fog reveal, so the
        // trap stays a trap until it isn't.
        if (mon.dormant) {
          ud.revealed = true; // don't double-awaken on the reveal that follows
          ud.wasDormant = true;
          playM(mon.kind === "greeter" ? "dormant_stand" : "dormant_floor");
        } else {
        if (ud.wasDormant) {
          ud.wasDormant = false;
          playFirstM("awaken", "hit"); // SPRUNG: rise/jolt out of the pose
        }
        // Theater: skeletons RISE the first time the fog reveals them, and the
        // introduced menace performs through its ringside freeze.
        if (mesh.visible && !ud.revealed) {
          ud.revealed = true;
          playFirstM("awaken");
        }
        const staggerRose = mon.stagger > 0 && !((ud.prevStagger as number) > 0);
        // FLINCH (combat-feel program #15.1): a fresh hit interrupts the body,
        // not just the tint. Rate-limited so DoT ticks and flurries read as
        // occasional twitches instead of stun-lock theater; never during a
        // committed windup (interrupting attacks is the stagger system's job),
        // never on bosses (their hit-react IS the stagger).
        const flashRose = mon.hitFlash > 0 && !((ud.prevHitFlash as number) > 0);
        ud.prevHitFlash = mon.hitFlash;
        ud.flinchCd = Math.max(0, ((ud.flinchCd as number) ?? 0) - dt);
        if (state.encounter?.monsterId === mon.id) {
          // One performance per introduction — playFirst force-restarts, so gate it.
          if (!ud.taunting) { ud.taunting = true; playFirstM("taunt", "idle"); }
        } else {
          ud.taunting = false;
          // Boss phase-up is a MOMENT: the large rig transforms; medium bosses
          // fall back to a taunt. Edge-detected so it plays exactly once.
          const phaseRose = (mon.phase ?? 0) > ((ud.prevPhase as number) ?? 0);
          ud.prevPhase = mon.phase ?? 0;
          if (phaseRose) {
            playFirstM("transform", "taunt", "hit");
          } else if (staggerRose) {
            // Shielded elites soak it on the shield (explains the damage reduction);
            // everyone else alternates the two hit reactions.
            if (mon.affix === "shielded") playFirstM("block_hit", "hit");
            else playFirstM((ud.hitAlt = !ud.hitAlt) ? "hit" : "hit_b", "hit");
          } else if (
            flashRose && (ud.flinchCd as number) <= 0 && mon.windup <= 0 &&
            mon.stagger <= 0 && mon.kind !== "boss" && mon.affix !== "shielded"
          ) {
            ud.flinchCd = 0.7;
            playFirstM((ud.hitAlt = !ud.hitAlt) ? "hit" : "hit_b", "hit");
          } else if (mon.windup > 0) {
            // Prefer a clip matching the committed attack; fall back to the
            // generic swing when the rig doesn't have that specific one baked.
            const hasClip = ud.hasClip as (n: string) => boolean;
            const wanted = WINDUP_CLIP[mon.windupKind ?? ""] ?? "attack";
            playM(hasClip(wanted) ? wanted : "attack");
          } else if ((ud.animBusy as () => number)() <= 0) {
            const hasClipM = ud.hasClip as (n: string) => boolean;
            const act = residentAct(state, mon);
            // THE RISE (staging v2): the scene just broke for this actor —
            // play the stand-up ONE-SHOT before locomotion takes the body.
            // The whole room rises together (residentAggro is per-purpose).
            if (!act && ud.stagedRise) {
              const rise = ud.stagedRise as string;
              ud.stagedRise = null;
              if (hasClipM(rise)) playFirstM(rise);
            } else {
            // Same hysteresis as players: enter walking decisively, leave lazily.
            ud.locoMoving = (ud.locoMoving as boolean) ? mSpeed > 0.12 : mSpeed > 0.4;
            if (ud.locoMoving) {
              // The unnoticed Repo Rat CREEPS between hoards; once the "a rat!"
              // event fires it drops the act. Fast movers (fleeing filcher,
              // frenzied/deep-tempo chasers) RUN — a sprint on a walk cycle
              // reads as ice-skating.
              if (mon.kind === "filcher" && !mon.noticed && hasClipM("sneak")) playM("sneak");
              else playM(mSpeed > 3.2 && hasClipM("run") ? "run" : "walk");
            } else {
              // RESIDENT STAGING (PHYSICALITY.md §2): an undisturbed resident
              // ACTS — dinner, sleep, hammering, push-ups — until the room's
              // scene breaks (first blood) or anything upstream outranks the
              // idle slot. Kind-signature performances still win (a parked
              // Drum Sergeant drums even in a mess hall).
              if (act && hasClipM(act.clip) &&
                  !(mon.kind === "drummer" || mon.kind === "shieldbearer" || mon.kind === "duelist")) {
                ud.stagedRise = act.rise ?? null; // armed for the scene-break edge
                if (act.burst && hasClipM(act.burst)) {
                  ud.stageT = ((ud.stageT as number) ?? 0) + dt;
                  if ((ud.stageT as number) >= burstPeriod(act, mon.id)) {
                    ud.stageT = 0;
                    playFirstM(act.burst);
                  } else if ((ud.animBusy as () => number)() <= 0) {
                    playM(act.clip);
                  }
                } else {
                  playM(act.clip);
                }
                if (act.faceAnchor) {
                  const anchor = this.stagingAnchors.get(mon.residentOf!);
                  if (anchor) mesh.rotation.y = Math.atan2(anchor.x - mon.pos.x, anchor.y - mon.pos.y);
                }
              } else {
              // A parked Drum Sergeant performs; a parked Shieldbearer holds
              // the wall behind its tower shield; a flourishing Duelist puts
              // the blade UP (the riposte window has to READ).
              playM(
                mon.kind === "drummer" && hasClipM("drum") ? "drum" :
                mon.kind === "shieldbearer" && hasClipM("blocking") ? "blocking" :
                mon.kind === "duelist" && (mon.riposteT ?? 0) > 0 && hasClipM("idle_brawler") ? "idle_brawler" : "idle",
              );
              }
            }
            }
          }
        }
        } // end non-dormant branch
        ud.prevStagger = mon.stagger;
        (ud.animTick as (dt: number) => void)(dt);
        mesh.position.y = mon.hitFlash > 0 ? 0.12 : 0;
        mesh.scale.setScalar(bs);
      } else {
        // Bob while chasing; recoil pop + squash when just hit or staggered;
        // rear up through a windup (scaled by archetype size).
        const bob = mSpeed > 0.2 ? Math.abs(Math.sin(time * 10 + mon.id)) * 0.14 * bs : 0;
        mesh.position.y = (mon.hitFlash > 0 ? 0.18 : 0) + bob;
        const squash = mon.hitFlash > 0 || mon.stagger > 0 ? 1.25 : 1;
        const rear = mon.windup > 0 ? 1 + 0.14 * (1 - mon.windup / Math.max(mon.windupTotal, 1e-3)) : 1;
        mesh.scale.set(bs * squash, bs * (2 - squash) * rear, bs * squash);
      }
      // LANE telegraphs: the charger's rush and the lasher's hook are LINES,
      // not circles — draw the actual lane so the sidestep reads instantly.
      const laneDir = (mon.windupKind === "hook" || mon.windupKind === "charge" || mon.windupKind === "lunge")
        ? mon.chargeDir : undefined;
      let strip = this.laneStrips.get(mon.id);
      if (mon.windup > 0 && laneDir) {
        if (!strip) {
          strip = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          strip.rotation.order = "YXZ";
          strip.rotation.x = -Math.PI / 2;
          this.scene.add(strip);
          this.laneStrips.set(mon.id, strip);
        }
        const len =
          mon.windupKind === "hook" ? CONFIG.lasherHookRange :
          mon.windupKind === "lunge" ? CONFIG.cutpurseLungeRange + 0.8 :
          CONFIG.chargerRange;
        const width =
          mon.windupKind === "hook" ? CONFIG.lasherHookWidth * 2 :
          mon.windupKind === "lunge" ? 0.7 :
          CONFIG.chargerHitRadius * 2;
        strip.position.set(mon.pos.x + laneDir.x * len / 2, 0.065, mon.pos.y + laneDir.y * len / 2);
        strip.scale.set(len, width, 1);
        strip.rotation.y = -Math.atan2(laneDir.y, laneDir.x);
        const prog = 1 - mon.windup / Math.max(mon.windupTotal, 1e-3);
        const mat = strip.material as THREE.MeshBasicMaterial;
        mat.color.setHex(
          mon.windupKind === "hook" ? 0x7cc95a :
          mon.windupKind === "lunge" ? 0xd4c94f : 0xff9a2e,
        );
        mat.opacity = 0.16 + prog * 0.4;
        strip.visible = mesh.visible;
      } else if (strip) {
        this.scene.remove(strip);
        this.laneStrips.delete(mon.id);
      }
      // Attack telegraph: a ground ring that brightens as the strike approaches.
      // Radius = what the attack will actually cover (fuse blast / melee reach).
      // The sentinel's "aim" gets NO ring — its tracking beam IS the telegraph.
      // Lane windups draw the strip above instead of a ring.
      let tel = this.telegraphs.get(mon.id);
      if (mon.windup > 0 && mon.windupKind !== "aim" && !laneDir) {
        if (!tel) {
          // Hades-grammar telegraph: a DIM translucent fill says "this ground",
          // a BRIGHT additive rim that sharpens and pulses says "how soon".
          tel = new THREE.Group();
          const fill = new THREE.Mesh(
            new THREE.CircleGeometry(1, 36),
            new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          fill.rotation.x = -Math.PI / 2;
          const rim = new THREE.Mesh(
            new THREE.RingGeometry(0.88, 1, 48),
            new THREE.MeshBasicMaterial({
              transparent: true, side: THREE.DoubleSide, depthWrite: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          rim.rotation.x = -Math.PI / 2;
          rim.position.y = 0.006;
          tel.add(fill, rim);
          tel.userData.fillMat = fill.material;
          tel.userData.rimMat = rim.material;
          tel.userData.rim = rim;
          this.scene.add(tel);
          this.telegraphs.set(mon.id, tel);
        }
        const prog = 1 - mon.windup / Math.max(mon.windupTotal, 1e-3);
        const radius =
          mon.windupKind === "fuse" ? CONFIG.bomberExplodeRadius :
          mon.windupKind === "shot" || mon.windupKind === "spit" ? 0.5 :
          mon.windupKind === "raise" ? 0.7 :
          mon.windupKind === "heal" || mon.windupKind === "summon" ? 0.65 :
          mon.windupKind === "charge" ? 0.9 :
          mon.windupKind === "slam" ? (mon.kind === "boss" ? CONFIG.bossSlamRadius : CONFIG.bruteSlamRadius) :
          mon.windupKind === "ritual" ? CONFIG.ritualRadius :
          mon.windupKind === "vent" ? CONFIG.slagVentRadius :
          mon.windupKind === "hex" ? 0.6 :
          mon.windupKind === "morph" ? 0.9 :
          mon.attackRange + CONFIG.monsterStrikeGrace;
        tel.position.set(mon.pos.x, 0.06, mon.pos.y);
        tel.scale.setScalar(radius);
        const telColor =
          mon.windupKind === "fuse" ? 0xff7733 :
          mon.windupKind === "shot" ? 0xffcc44 :
          mon.windupKind === "spit" ? 0xa4c93f :
          mon.windupKind === "raise" ? 0x8a5cff :
          mon.windupKind === "heal" ? 0x3fbf6f : // shaman green: interrupt the medic
          mon.windupKind === "summon" ? 0x8a5cff : // violet: more of them incoming
          mon.windupKind === "charge" ? 0xff9a2e :
          mon.windupKind === "slam" ? 0xff2020 :
          mon.windupKind === "ritual" ? 0x8800ee :
          mon.windupKind === "hex" ? 0xa64ca6 :
          mon.windupKind === "morph" ? 0xd8d0a8 : 0xff5030;
        const telFill = tel.userData.fillMat as THREE.MeshBasicMaterial;
        const telRim = tel.userData.rimMat as THREE.MeshBasicMaterial;
        telFill.color.setHex(telColor);
        telRim.color.setHex(telColor);
        telFill.opacity = 0.09 + prog * 0.16;
        telRim.opacity = 0.3 + prog * 0.7;
        // The rim breathes while the tell arms, then locks tight at commit.
        (tel.userData.rim as THREE.Mesh).scale.setScalar(1 + 0.06 * Math.sin(time * 13 + mon.id) * (1 - prog));
        tel.visible = mesh.visible;
      } else if (tel) {
        this.scene.remove(tel);
        this.telegraphs.delete(mon.id);
      }
      // Key carrier: a floating gold octahedron over the head marks the keyholder.
      let marker = this.keyMarkers.get(mon.id);
      if (mon.hasKey && !marker) {
        marker = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          flat(0xffd23e, { emissive: 0xaa7700, emissiveIntensity: 0.9, metalness: 0.6, roughness: 0.3 }),
        );
        this.scene.add(marker);
        this.keyMarkers.set(mon.id, marker);
      } else if (!mon.hasKey && marker) {
        this.scene.remove(marker);
        this.keyMarkers.delete(mon.id);
        marker = undefined;
      }
      if (marker) {
        marker.position.set(mon.pos.x, 1.55 + Math.sin(time * 3 + mon.id) * 0.09, mon.pos.y);
        marker.rotation.y = time * 2.2;
        marker.visible = mesh.visible;
      }
      // Status ring (5.11): a faint pulsing halo colored by the dominant
      // effect (burn > poison > chill) — one cheap mesh, sim decides, we tint.
      const st = mon.statuses;
      let ring = this.statusRings.get(mon.id);
      if (st && st.length > 0 && mon.hp > 0) {
        if (!ring) {
          ring = new THREE.Mesh(
            new THREE.RingGeometry(0.78, 1, 24),
            new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          ring.rotation.x = -Math.PI / 2;
          this.scene.add(ring);
          this.statusRings.set(mon.id, ring);
        }
        const kind = st.find((e) => e.kind === "burn") ? "burn"
          : st.find((e) => e.kind === "poison") ? "poison" : "chill";
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.color.setHex(kind === "burn" ? 0xff7a2f : kind === "poison" ? 0x7ed957 : 0x7fd4ff);
        mat.opacity = 0.22 + 0.1 * Math.sin(time * 6 + mon.id);
        ring.position.set(mon.pos.x, 0.04, mon.pos.y);
        ring.scale.setScalar(0.62 * (mon.elite ? CONFIG.eliteScale : mon.veteran ? CONFIG.veteranScale : 1));
        ring.visible = mesh.visible;
      } else if (ring) {
        this.scene.remove(ring);
        this.statusRings.delete(mon.id);
      }
    }
    for (const [id, mesh] of this.monsters) {
      if (!seen.has(id)) {
        this.monsters.delete(id);
        const marker = this.keyMarkers.get(id);
        if (marker) { this.scene.remove(marker); this.keyMarkers.delete(id); }
        const tel = this.telegraphs.get(id);
        if (tel) { this.scene.remove(tel); this.telegraphs.delete(id); }
        const lane = this.laneStrips.get(id);
        if (lane) { this.scene.remove(lane); this.laneStrips.delete(id); }
        const ring = this.statusRings.get(id);
        if (ring) { this.scene.remove(ring); this.statusRings.delete(id); }
        if (rebuilt) {
          // Floor change: the whole population turned over — no corpses.
          this.scene.remove(mesh);
        } else {
          // Death: let the corpse play out (death clip / tumble) before removal.
          // Two death clips keep a cleared pack from dying in unison.
          const rigged = !!mesh.userData.mixer;
          if (rigged) {
            const variant = Math.random() < 0.5 && (mesh.userData.hasClip as (n: string) => boolean)("death_b") ? "death_b" : "death";
            (mesh.userData.play as (n: string, force?: boolean) => void)(variant, true);
          }
          // An overkill blow near this corpse claims it: launched, tumbling,
          // death clip still playing mid-air. Bigger send-off for bigger hits.
          let fling: (typeof this.dying)[number]["fling"];
          const okIdx = this.overkillMarks.findIndex(
            (mk) => Math.hypot(mk.x - mesh.position.x, mk.y - mesh.position.z) < 1.4,
          );
          if (okIdx >= 0) {
            const mk = this.overkillMarks.splice(okIdx, 1)[0];
            const d = mk.dir ?? { x: 0, y: 0 };
            fling = {
              vx: d.x * 5.5 + (Math.random() - 0.5), vy: 4.6 + Math.random() * 1.2,
              vz: d.y * 5.5 + (Math.random() - 0.5), spin: (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 4),
            };
          }
          this.dying.push({ mesh, t: (rigged ? 1.1 : 0.7) + (fling ? 0.4 : 0), rigged, fling });
        }
      }
    }

    // Floor cleared (or run won): the crawlers play to the camera. A rebuild
    // also empties the count, so gate the edge on NOT having changed floors.
    // Net snapshots are interest-filtered — monstersLeft is the real count
    // (an empty LIST may just mean the survivors are far away).
    const monsterCount = state.monstersLeft ?? state.monsters.length;
    const cleared = !rebuilt && this.prevMonsterCount > 0 && monsterCount === 0 && state.status === "playing";
    const won = state.status === "won" && this.prevStatus !== "won";
    if (cleared || won) {
      for (const m of this.playerMeshes.values()) {
        if (m.userData.playFirst) (m.userData.playFirst as (...n: string[]) => void)("cheer");
      }
    }
    this.prevMonsterCount = monsterCount;
    this.prevStatus = state.status;

    // Ground hazards, reconciled by id: volatile blasts are rings that brighten
    // toward detonation; spitter puddles are filled acid pools that fade out;
    // boss sludge/roots zones are filled pools that GHOST through their arming
    // telegraph, then snap solid when they go live.
    const hazSeen = new Set<number>();
    for (const hz of state.hazards) {
      hazSeen.add(hz.id);
      // BEAM (line) hazards: a thin plane stretched pos->end. Ghostly while
      // arming, blinding for the firing flash. Reuses the hazardRings pool.
      if (hz.kind === "beam" && hz.end) {
        let strip = this.hazardRings.get(hz.id);
        if (!strip) {
          strip = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({
              color: 0xff5a3c, transparent: true, side: THREE.DoubleSide, depthWrite: false,
            }),
          );
          // Yaw about world Y FIRST (rotation order), then pitch flat onto the
          // ground — the default XYZ order warps the strip into a skewed sail.
          strip.rotation.order = "YXZ";
          strip.rotation.x = -Math.PI / 2;
          this.scene.add(strip);
          this.hazardRings.set(hz.id, strip);
        }
        const mx = (hz.pos.x + hz.end.x) / 2, my = (hz.pos.y + hz.end.y) / 2;
        const len = Math.hypot(hz.end.x - hz.pos.x, hz.end.y - hz.pos.y);
        strip.position.set(mx, 0.07, my);
        strip.scale.set(Math.max(len, 1e-3), hz.radius * 2, 1);
        strip.rotation.y = -Math.atan2(hz.end.y - hz.pos.y, hz.end.x - hz.pos.x);
        (strip.material as THREE.MeshBasicMaterial).opacity = hz.fired
          ? 0.9 * (hz.t / Math.max(hz.total, 1e-3) + 0.4) // firing flash, fading out
          : 0.12 + 0.3 * ((hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3)); // telegraph brightens
        strip.visible = inVision({ x: mx, y: my });
        continue;
      }
      const pool = hz.kind === "puddle" || hz.kind === "sludge" || hz.kind === "roots" || hz.kind === "shards"
        || hz.kind === "consecrate";
      let ring = this.hazardRings.get(hz.id);
      if (!ring) {
        ring = new THREE.Mesh(
          pool ? new THREE.CircleGeometry(1, 28) : new THREE.RingGeometry(0.8, 1, 28),
          new THREE.MeshBasicMaterial({
            color:
              hz.kind === "sludge" ? 0x5f7020 : // sewer surge: darker, fouler than acid
              hz.kind === "roots" ? 0x2e8b57 : // grasping green
              hz.kind === "shards" ? 0xb8b0a0 : // ossuary debris: pale bone scatter
              hz.kind === "consecrate" ? 0xe8c96a : // holy ground: theirs, not yours
              pool ? 0x7fb832 : 0xff4628,
            transparent: true, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.hazardRings.set(hz.id, ring);
      }
      ring.position.set(hz.pos.x, 0.06, hz.pos.y);
      ring.scale.setScalar(hz.radius);
      const arming = pool && (hz.arm ?? 0) > 0 && hz.total - hz.t < (hz.arm ?? 0);
      const urgency = 1 - hz.t / Math.max(hz.total, 1e-3);
      (ring.material as THREE.MeshBasicMaterial).opacity = arming
        ? 0.1 + 0.2 * ((hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3)) // telegraph fades in
        : pool
          ? 0.28 + 0.22 * Math.min(1, hz.t / Math.max(hz.total, 1e-3)) // fades as it dries
          : 0.3 + 0.6 * urgency;
      ring.visible = inVision(hz.pos);
      // Blast hazards get a ticking bomb at the epicenter (clown ordnance —
      // the System loves its clowns); the ring alone stays the fallback.
      if (!pool) {
        let bomb = this.hazardBombs.get(hz.id);
        if (!bomb) {
          // The flavor field picks the epicenter dressing: Flame Sweep rows
          // are FIRE, masonry-type blasts (debris rain, the engagement
          // review) are falling ROCK, and only true ordnance keeps the clown
          // bomb — the System loves its clowns, but not on the Architect.
          const model = hz.flavor === "flame"
            ? this.modelInstance("fx_flame_wall") ?? this.modelInstance("clown_bomb")
            : hz.flavor === "debris"
              ? this.modelInstance("rubble_half") ?? this.modelInstance("clown_bomb")
              : this.modelInstance("clown_bomb");
          if (model) {
            bomb = new THREE.Group();
            if (hz.flavor === "flame" && this.models["fx_flame_wall"]) {
              const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
              model.scale.setScalar((2 / Math.max(size.x, size.z, 1e-3)) * hz.radius * 0.9);
              model.traverse((o) => {
                const m = o as THREE.Mesh;
                if (!m.isMesh) return;
                const mat = (m.material as THREE.MeshStandardMaterial).clone();
                mat.emissive = new THREE.Color(0xff5a2e);
                mat.emissiveIntensity = 0.6;
                m.material = mat;
              });
              bomb.userData.flame = true;
            } else if (hz.flavor === "debris" && this.models["rubble_half"]) {
              model.scale.setScalar(0.5);
              bomb.userData.debris = true; // rocks loom; they do not tick
            } else {
              model.scale.setScalar(0.55);
            }
            bomb.add(model);
            this.scene.add(bomb);
            this.hazardBombs.set(hz.id, bomb);
          }
        }
        if (bomb) {
          bomb.position.set(hz.pos.x, 0, hz.pos.y);
          if (bomb.userData.flame) {
            // Fire licks upward as the row nears eruption.
            bomb.scale.setScalar(0.35 + 0.65 * urgency + 0.05 * Math.sin(urgency * 40));
          } else if (bomb.userData.debris) {
            // Masonry DESCENDS: the rock sinks toward its shadow as time runs out.
            bomb.position.y = 2.2 * (1 - urgency);
            bomb.scale.setScalar(0.8 + 0.2 * urgency);
          } else {
            // Ticking wobble that accelerates toward the boom.
            bomb.scale.setScalar(1 + 0.08 * Math.sin(urgency * urgency * 60));
          }
          bomb.visible = ring.visible;
        }
      }
    }
    for (const [id, ring] of this.hazardRings) {
      if (!hazSeen.has(id)) { this.scene.remove(ring); this.hazardRings.delete(id); }
    }
    for (const [id, bomb] of this.hazardBombs) {
      if (!hazSeen.has(id)) { this.scene.remove(bomb); this.hazardBombs.delete(id); }
    }

    // Windup-bound FX: the spitter's lobbed thorn and the bomber's held bomb
    // exist only while the tell runs — pure presentation over sim windup state.
    this.updateWindupFx(state);

    // Party pings: an expanding gold pulse on the marked spot. The pulse cycle
    // derives from the ping's remaining life (sim time), so replays match.
    // Pings pierce the fog on purpose — "over THERE" must work unseen.
    const pingSeen = new Set<number>();
    for (const pg of state.pings) {
      pingSeen.add(pg.id);
      let ring = this.pingRings.get(pg.id);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(0.72, 1, 28),
          new THREE.MeshBasicMaterial({
            color: 0xffd23e, transparent: true, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.pingRings.set(pg.id, ring);
      }
      const cycle = 1 - ((pg.t * 1.6) % 1); // 0 -> 1 expanding pulse
      ring.position.set(pg.pos.x, 0.07, pg.pos.y);
      ring.scale.setScalar(0.35 + cycle * 0.85);
      (ring.material as THREE.MeshBasicMaterial).opacity =
        (0.85 - cycle * 0.55) * Math.min(1, pg.t / 1.2); // and fades as it dies
    }
    for (const [id, ring] of this.pingRings) {
      if (!pingSeen.has(id)) { this.scene.remove(ring); this.pingRings.delete(id); }
    }

    // Click-to-move destination: a quiet steel-blue chip, host-local (not sim
    // state, unlike pings — nobody else sees where you told yourself to walk).
    if (this.moveMarker?.visible) {
      const mm = this.moveMarker.material as THREE.MeshBasicMaterial;
      mm.opacity = 0.4 + 0.15 * Math.sin(performance.now() / 180);
    }

    // Revive channel: a green ring tightening around a downed crawler as a
    // teammate stabilizes them (radius shows the stand-here zone).
    const revSeen = new Set<number>();
    for (const pl of state.players) {
      if (pl.alive || pl.reviveProgress <= 0) continue;
      revSeen.add(pl.id);
      let ring = this.reviveRings.get(pl.id);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(0.78, 0.95, 28),
          new THREE.MeshBasicMaterial({
            color: 0x5fd08a, transparent: true, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.reviveRings.set(pl.id, ring);
      }
      ring.position.set(pl.pos.x, 0.07, pl.pos.y);
      ring.scale.setScalar(CONFIG.reviveRadius * (1.05 - pl.reviveProgress * 0.55));
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.55 * pl.reviveProgress;
      ring.visible = inVision(pl.pos);
    }
    for (const [id, ring] of this.reviveRings) {
      if (!revSeen.has(id)) { this.scene.remove(ring); this.reviveRings.delete(id); }
    }

    // The Briar Witch's mark: a thorny purple pulse under a cursed crawler —
    // the whole party should see who to peel for.
    const curseSeen = new Set<number>();
    for (const pl of state.players) {
      if (!pl.alive || (pl.cursedT ?? 0) <= 0) continue;
      curseSeen.add(pl.id);
      let ring = this.curseRings.get(pl.id);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(0.5, 0.68, 6), // hexagonal: it's a HEX
          new THREE.MeshBasicMaterial({
            color: 0xa64ca6, transparent: true, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.curseRings.set(pl.id, ring);
      }
      ring.position.set(pl.pos.x, 0.065, pl.pos.y);
      ring.rotation.z = performance.now() / 900; // slow ominous spin
      (ring.material as THREE.MeshBasicMaterial).opacity =
        0.35 + 0.2 * Math.sin(performance.now() / 220);
      ring.visible = inVision(pl.pos);
    }
    for (const [id, ring] of this.curseRings) {
      if (!curseSeen.has(id)) { this.scene.remove(ring); this.curseRings.delete(id); }
    }

    // Projectiles: reconcile a mesh pool by id.
    const projSeen = new Set<number>();
    for (const pr of state.projectiles) {
      projSeen.add(pr.id);
      let mesh = this.projectiles.get(pr.id);
      if (!mesh) {
        // Magic missiles read arcane-violet; physical bolts keep the player
        // hue — and FROST BOLTS read lore-blue (STYLEGUIDE: frost's color),
        // so the build-defining chill rider is visible in flight.
        const color = pr.from !== "player" ? THEME.projectileEnemy
          : (pr.chill ?? 0) > 0 ? 0x5a87c6
          : pr.school === "magic" ? 0xa06bff : THEME.projectilePlayer;
        const group = new THREE.Group();
        // Ammo with a real mesh flies as that mesh (arrows nose along their
        // velocity); magic and everything unmodeled stays the classic glow orb.
        const key = this.projectileModelKey(pr, state);
        const model = key ? this.modelInstance(key) : null;
        if (model) {
          // The fletched arrows' rest pose already lies nose-forward (+Z).
          model.scale.setScalar(0.9);
          group.add(model); // no glow billboard — the mesh IS the projectile
          group.userData.aim = true;
        } else {
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(0.11, 8, 8),
            flat(color, { emissive: color, emissiveIntensity: 1.4 }),
          );
          group.add(core, this.makeGlow(color, 0.85));
        }
        group.userData.color = color;
        group.userData.lastTrail = 0;
        mesh = group;
        this.scene.add(mesh); this.projectiles.set(pr.id, mesh);
      }
      this.smoothTo(mesh, pr.pos.x, 0.6, pr.pos.y, dt);
      if (mesh.userData.aim) mesh.rotation.y = Math.atan2(pr.vel.x, pr.vel.y);
      mesh.visible = inVision(pr.pos);
      // Comet trail: a fading glow puff every few ms of flight (orbs only —
      // arrows read as arrows, not comets).
      mesh.userData.lastTrail += dt;
      if (mesh.visible && !mesh.userData.aim && mesh.userData.lastTrail > 0.035) {
        mesh.userData.lastTrail = 0;
        this.spawnGlow(mesh.position.x, mesh.position.y, mesh.position.z, mesh.userData.color, 0.5, 0.22, -0.8);
      }
    }
    for (const [id, mesh] of this.projectiles) {
      if (!projSeen.has(id)) { this.scene.remove(mesh); this.projectiles.delete(id); }
    }

    // Loot: reconcile + bob/spin.
    const lootSeen = new Set<number>();
    for (const l of state.loot) {
      lootSeen.add(l.id);
      let mesh = this.loot.get(l.id);
      if (!mesh) {
        mesh = this.buildLootMesh(l);
        this.scene.add(mesh); this.loot.set(l.id, mesh);
      }
      // Equipment bobs a touch higher and spins faster so drops read as "loot".
      const lift = l.kind === "item" || l.kind === "tome" ? 0.55 : 0.4;
      mesh.position.set(l.pos.x, lift + Math.sin(time * 3 + l.id) * 0.08, l.pos.y);
      mesh.rotation.y = time * 2.4;
      mesh.visible = inVision(l.pos);
    }
    for (const [id, mesh] of this.loot) {
      if (!lootSeen.has(id)) { this.scene.remove(mesh); this.loot.delete(id); }
    }

    // Torch light pool: park the few real lights at the anchors nearest the
    // player (off-screen torches don't need light). Reassignments FADE over
    // ~0.3s — a sconce guttering out behind you, another catching ahead —
    // instead of the old teleport-pop, then layered flicker on top.
    const lp = state.players.find((pl) => pl.alive) ?? state.players[0];
    if (this.torchAnchors.length > 0 && this.torchPool.length > 0) {
      const order = this.torchOrder;
      order.length = this.torchAnchors.length;
      for (let i = 0; i < order.length; i++) order[i] = i;
      const d2 = (i: number): number => {
        const a = this.torchAnchors[i];
        return (a.x - lp.pos.x) ** 2 + (a.y - lp.pos.y) ** 2;
      };
      order.sort((a, b) => d2(a) - d2(b));
      const desired = this.torchDesired;
      desired.clear();
      const nWant = Math.min(this.torchPool.length, order.length);
      for (let i = 0; i < nWant; i++) desired.add(order[i]);
      // First pass: lights already holding a desired anchor claim it.
      for (const st of this.torchState) {
        st.wanted = st.anchor >= 0 && desired.delete(st.anchor);
      }
      const fade = dt / 0.3;
      for (let i = 0; i < this.torchPool.length; i++) {
        const st = this.torchState[i];
        const light = this.torchPool[i];
        if (st.wanted) {
          st.level = Math.min(1, st.level + fade);
        } else {
          st.level = Math.max(0, st.level - fade);
          if (st.level === 0) {
            // Dark: repark at an unclaimed near anchor (fades in from here).
            for (const a of desired) { st.anchor = a; desired.delete(a); break; }
          }
        }
        const t = st.anchor >= 0 ? this.torchAnchors[st.anchor] : null;
        if (!t || st.level <= 0) { light.intensity = 0; continue; }
        light.position.set(t.x, 1.1, t.y);
        light.intensity = this.torchBase * st.level * Renderer3D.torchFlicker(time, t.seed);
      }
    }
    // Flame glow layers: every anchor's core/mid/halo gutters with the same
    // layered flicker the lights use (visible flicker gradient on the light
    // pools), gated by the fog so unexplored sconces don't glow through the
    // dark. Core dances hardest, the wide halo only breathes.
    if (this.flameSprites.length > 0) {
      const fAlphas = this.fogBank.alphas;
      for (const f of this.flameSprites) {
        const hidden = (fAlphas[f.tile] ?? 1) > 0.5;
        f.s.visible = !hidden;
        if (hidden) continue;
        const fl = Renderer3D.torchFlicker(time, f.seed);
        const mat = f.s.material as THREE.SpriteMaterial;
        if (f.role === 0) {
          mat.opacity = f.baseOp * (0.7 + 0.3 * fl);
          f.s.scale.setScalar(f.base * (0.72 + 0.5 * fl));
        } else if (f.role === 1) {
          mat.opacity = f.baseOp * (0.6 + 0.55 * Math.min(1, Math.max(0, (fl - 0.5) * 2)));
          f.s.scale.setScalar(f.base * (0.78 + 0.38 * fl));
        } else {
          mat.opacity = f.baseOp * (0.85 + 0.2 * fl);
          f.s.scale.setScalar(f.base * (0.94 + 0.1 * fl));
        }
      }
    }
    // Baked-pool gutter + fog-frontier drift for the world-lit materials.
    this.wl.uWlFlick.value = 0.88 + 0.12 * Renderer3D.torchFlicker(time, 0.37);
    this.wl.uWlTime.value = time;

    this.updateParticles(dt);
    this.updateFxLights(dt);
    this.updateDying(dt);
    this.updateAbilityFx(state);

    // Camera follows the player from the fixed iso direction, plus trauma shake.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const amp = this.trauma * this.trauma * Renderer3D.SHAKE_MAX;
    const sx = amp > 0 ? (Math.random() * 2 - 1) * amp : 0;
    const sz = amp > 0 ? (Math.random() * 2 - 1) * amp : 0;
    const d = THEME.camDir;
    const dist = THEME.camDist;
    const len = Math.hypot(d.x, d.y, d.z);
    const anchor = this.playerMeshes.get(p.id)?.position;
    const ax = anchor ? anchor.x : p.pos.x;
    const az = anchor ? anchor.z : p.pos.y;
    this.camera.position.set(
      ax + (d.x / len) * dist + sx,
      (d.y / len) * dist,
      az + (d.z / len) * dist + sz,
    );
    this.camera.lookAt(ax, 0, az);
    // Shadow texel snap: quantize the key rig's anchor in shadow-plane
    // coordinates so the map samples the same texels while the camera glides —
    // kills the edge shimmer/crawl on every wall as the player moves.
    {
      const sc = this.key.shadow.camera as THREE.OrthographicCamera;
      const texel = (sc.right - sc.left) / this.key.shadow.mapSize.x;
      const R = this.shadowRight;
      const U = this.shadowUp;
      const u = ax * R.x + az * R.z;
      const v = ax * U.x + az * U.z;
      const du = Math.round(u / texel) * texel - u;
      const dv = Math.round(v / texel) * texel - v;
      const ox = du * R.x + dv * U.x;
      const oy = du * R.y + dv * U.y;
      const oz = du * R.z + dv * U.z;
      this.key.position.set(ax + 8 + ox, 20 + oy, az + 6 + oz);
      this.key.target.position.set(ax + ox, oy, az + oz);
    }
    // Cool rim from behind-left: lifts character silhouettes off the ground.
    this.rim.position.set(ax - 9, 7, az - 5);
    this.rim.target.position.set(ax, 0.8, az);
    // The void gradient rides with the player: out-of-bounds always falls away.
    if (this.voidPlane) this.voidPlane.position.set(ax, -0.22, az);

    // Band atmosphere: feed fresh spawn candidates (explored ground near the
    // player — never the void) on a short cadence, then advance the cloud.
    this.atmoRefresh -= dt;
    if (this.atmoRefresh <= 0) {
      this.atmoRefresh = 0.5;
      this.refreshAtmoSources(state, ax, az);
    }
    this.ambientFx.update(ax, az, dt, time);

    // Camera courtesy: shrink foliage that hides the action (open-air only).
    this.updateCanopy(state, ax, az, dt);
  }

  /**
   * Open-air occlusion courtesy: the camera looks along (+1,+1) on the ground
   * plane, so a tall cluster piece hides an entity when it sits a short way
   * down that diagonal from them. Such pieces shrink toward their root until
   * the shot is clear, then grow back — the System's cameras get their shot.
   */
  private updateCanopy(state: GameState, ax: number, az: number, dt: number): void {
    if (!this.canopy) return;
    const SQ2 = Math.SQRT1_2;
    const wantHidden = (px: number, pz: number, ex: number, ez: number): boolean => {
      const vx = px - ex, vz = pz - ez;
      const u = (vx + vz) * SQ2; // along the camera diagonal
      const w = (vx - vz) * SQ2; // across it
      return u > -0.7 && u < 2.6 && Math.abs(w) < 1.15;
    };
    // Entities that deserve a clear shot: living players + monsters near the
    // local player (the ones actually in frame and in the fight).
    const ents: { x: number; y: number }[] = [];
    for (const p of state.players) if (p.alive) ents.push(p.pos);
    for (const mo of state.monsters) {
      if (Math.abs(mo.pos.x - ax) < 14 && Math.abs(mo.pos.y - az) < 10) ents.push(mo.pos);
    }
    // Mark targets around each entity (candidate cells: the diagonal cone).
    const marked = new Set<CanopyEntry>();
    for (const e of ents) {
      const bx = Math.floor(e.x), bz = Math.floor(e.y);
      for (let dzz = -2; dzz <= 3; dzz++) {
        for (let dxx = -2; dxx <= 3; dxx++) {
          const cell = this.canopy.get((bz + dzz) * this.canopyGridW + (bx + dxx));
          if (!cell) continue;
          for (const c of cell) {
            if (wantHidden(c.x, c.z, e.x, e.y)) marked.add(c);
          }
        }
      }
    }
    // Ease every registered piece toward its target; write matrices on change.
    const k = Math.min(1, dt * 9);
    const dirty = new Set<THREE.InstancedMesh>();
    const scratchM = new THREE.Matrix4();
    const scratchV = new THREE.Vector3();
    for (const cell of this.canopy.values()) {
      for (const c of cell) {
        c.target = marked.has(c) ? 0.12 : 1;
        if (Math.abs(c.f - c.target) < 0.01) {
          if (c.f === c.target) continue;
          c.f = c.target;
        } else {
          c.f += (c.target - c.f) * k;
        }
        dirty.add(c.mesh);
        c.mesh.setMatrixAt(c.index, scratchM.copy(c.base).scale(scratchV.set(c.f, c.f, c.f)));
      }
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Procedural animation for a placeholder player mesh (walk bob, attack lunge, death). */
  private animatePlayer(mesh: THREE.Group, alive: boolean, speed: number, attackSwing: number, time: number): void {
    const body = mesh.userData.body as THREE.Mesh | undefined;
    const weapon = mesh.userData.weapon as THREE.Mesh | undefined;
    const restX = (mesh.userData.weaponRestX as number) ?? 0;

    if (!alive) {
      // Tip over and sink.
      mesh.rotation.x = -Math.PI / 2.2;
      mesh.position.y = 0.1;
      return;
    }
    mesh.rotation.x = 0;

    if (attackSwing > 0) {
      // Lunge forward along facing during the swing, and swing the weapon.
      const prog = 1 - attackSwing / 0.15; // 0 -> 1 across the swing
      const lunge = Math.sin(prog * Math.PI) * 0.18;
      mesh.position.x += Math.sin(mesh.rotation.y) * lunge;
      mesh.position.z += Math.cos(mesh.rotation.y) * lunge;
      if (weapon) weapon.rotation.x = restX - Math.sin(prog * Math.PI) * 1.4;
      mesh.position.y = 0;
    } else if (speed > 0.4) {
      // Walk: bob + subtle roll.
      mesh.position.y = Math.abs(Math.sin(time * 12)) * 0.1;
      if (body) body.rotation.z = Math.sin(time * 12) * 0.08;
      if (weapon) weapon.rotation.x = restX;
    } else {
      // Idle breathing.
      mesh.position.y = Math.sin(time * 2.5) * 0.03;
      if (body) body.rotation.z = 0;
      if (weapon) weapon.rotation.x = restX;
    }
  }

  /** Spawn particle bursts + camera shake for a batch of combat events (host-buffered). */
  emitHits(hits: HitEvent[]): void {
    for (const h of hits) {
      if (h.kind === "chain") {
        // The link line IS the effect (arrival flashes come as separate
        // "weapon"/"crit" hits), so no burst here.
        if (h.to) this.spawnChain(h.pos, h.to);
        continue;
      }
      // Zero-amount crit flashes are the sim's DETONATION markers (Gavel Drop,
      // EXTINCTION corpse pops, the Stunt Double's farewell): a spiked star
      // bursts outward under the usual particle spray.
      if (h.kind === "crit" && h.amount === 0) {
        this.spawnFadeProp("fx_detonation_star", h.pos.x, 0.05, h.pos.y, 1.1, 0.35,
          { tint: 0xff8a3c, spin: 1.5, grow: 4, footprint: true, pop: true });
      }
      const color =
        h.kind === "crit" ? 0xffe066 :
        h.kind === "enemy" ? 0xffb347 :
        h.kind === "player" ? 0xe2574c :
        h.kind === "heal" ? 0x5fd08a :
        h.kind === "gold" ? 0xf2c14e : 0xb98bff;
      // White flash frame on the struck target: for one blink the IMPACT is
      // the brightest thing on screen (and the bloom pass catches it) — the
      // difference between combat and walking.
      if (h.kind === "enemy" || h.kind === "crit") {
        this.spawnGlow(h.pos.x, 0.8, h.pos.y, 0xffffff, h.kind === "crit" ? 1.5 : 1.0, 0.13, 2.2);
        // Radial spark spray at the point of impact (additive, short, hot).
        for (let i = 0; i < (h.kind === "crit" ? 5 : 3); i++) {
          this.spawnGlow(
            h.pos.x + (Math.random() - 0.5) * 0.5, 0.55 + Math.random() * 0.55,
            h.pos.y + (Math.random() - 0.5) * 0.5,
            0xffd9a0, 0.22 + Math.random() * 0.2, 0.18, 2.8,
          );
        }
        // Crits kick a brief real light into the scene — the impact FRAME.
        if (h.kind === "crit") this.spawnFxLight(h.pos.x, h.pos.y, 0xffe6b0, 6, 0.22, 0.9);
      }
      // Killing blows pop: a fatter, impact-directed burst + an extra shake kick.
      const n = (h.kind === "crit" ? 14 : 8) + (h.killed ? 10 : 0) + (h.overkill ? 10 : 0);
      this.spawnBurst(h.pos.x, h.pos.y, color, n, h.dir);
      if (h.kind === "player") this.addTrauma(0.55); // taking damage should register
      if (h.kind === "crit") this.addTrauma(0.3);
      if (h.killed && h.kind !== "player") this.addTrauma(0.25);
      if (h.overkill && h.kind !== "player") {
        this.addTrauma(0.2);
        // The corpse this kill removes (next reconcile) gets launched.
        this.overkillMarks.push({ x: h.pos.x, y: h.pos.y, dir: h.dir, t: 0.5 });
      }
      // Big deaths flash real light into the world (small kills stay cheap).
      if (h.killed && h.kind !== "player" && (h.overkill || h.kind === "crit")) {
        this.spawnFxLight(h.pos.x, h.pos.y, color, h.overkill ? 9 : 5, h.overkill ? 0.5 : 0.32);
      }
    }
  }

  private spawnBurst(x: number, y: number, color: number, count: number, dir?: Vec2): void {
    if (this.particles.length > 260) return; // hard cap
    const mat = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.sharedParticleGeo, mat);
      mesh.position.set(x, 0.6, y);
      this.scene.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2.5;
      this.particles.push({
        mesh,
        // Bias the spray along the impact direction so hits read as directional.
        vx: Math.cos(ang) * sp + (dir?.x ?? 0) * 2.2,
        vy: 2 + Math.random() * 2.5,
        vz: Math.sin(ang) * sp + (dir?.y ?? 0) * 2.2,
        life: 0, max: 0.5 + Math.random() * 0.3,
      });
    }
  }

  /** Extradition's chain: alternating iron links between two world points,
   * hung at torso height with a light sag. One shared material per chain so
   * the whole run fades as one. */
  private spawnChain(from: Vec2, to: Vec2): void {
    if (this.chainFx.length > 8) return; // cap simultaneous chains
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (len < 0.3) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xaab2bd, transparent: true });
    const group = new THREE.Group();
    const links = Math.min(40, Math.max(3, Math.round(len / 0.24)));
    const yaw = -Math.atan2(to.y - from.y, to.x - from.x);
    for (let i = 0; i < links; i++) {
      const t = (i + 0.5) / links;
      const link = new THREE.Mesh(this.sharedLinkGeo, mat);
      link.position.set(
        from.x + (to.x - from.x) * t,
        0.55 - Math.sin(t * Math.PI) * 0.12, // sag toward the middle
        from.y + (to.y - from.y) * t,
      );
      link.rotation.y = yaw;
      link.rotation.x = (i % 2) * (Math.PI / 2); // alternate links twist: reads as interlocked
      group.add(link);
    }
    // The far end carries the gavel head (CLASS ACTION's legal-satire lane),
    // keeping its own wood texture but fading in step with the links.
    const mats: THREE.Material[] = [mat];
    const gavel = this.modelInstance("gavel_anchor");
    if (gavel) {
      gavel.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const gm = (m.material as THREE.MeshStandardMaterial).clone();
        gm.transparent = true;
        gm.depthWrite = false;
        m.material = gm;
        mats.push(gm);
      });
      gavel.scale.setScalar(0.55);
      gavel.position.set(to.x, 0.5, to.y);
      gavel.rotation.y = yaw;
      group.add(gavel);
    }
    this.scene.add(group);
    this.chainFx.push({ group, mats, life: 0, max: 0.35 });
  }

  /** Drop a model that fades out and vanishes (Blindside's smokebomb, the
   * spell-FX one-shots). `footprint` normalizes the model's XZ extent so
   * `scale` means world radius; `tint` applies the semantic emissive color. */
  private spawnFadeProp(
    key: string, x: number, y: number, z: number, scale: number, max: number,
    opts?: { tint?: number; spin?: number; grow?: number; footprint?: boolean; pop?: boolean },
  ): void {
    if (this.fadeProps.length > 16) return; // cap
    const obj = this.modelInstance(key);
    if (!obj) return; // asset absent: the glow puffs carry the moment alone
    let base = 1;
    if (opts?.footprint) {
      const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
      base = 2 / Math.max(size.x, size.z, 1e-3);
    }
    obj.scale.setScalar(base * scale);
    obj.position.set(x, y, z);
    const mats: THREE.Material[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      mat.transparent = true;
      mat.depthWrite = false;
      if (opts?.tint !== undefined) {
        mat.emissive = new THREE.Color(opts.tint);
        mat.emissiveIntensity = 0.55;
      }
      m.material = mat;
      mats.push(mat);
    });
    this.scene.add(obj);
    this.fadeProps.push({
      obj, mats, life: 0, max, spin: opts?.spin ?? 4, grow: opts?.grow ?? 0,
      s0: base * scale, pop: opts?.pop ?? false,
    });
  }

  /** Tick lingering corpses: rigged models play their death clip, stand-ins tumble. */
  private updateDying(dt: number): void {
    // Unclaimed overkill marks expire fast (net mode can cull the corpse
    // before we ever see it disappear).
    this.overkillMarks = this.overkillMarks.filter((mk) => (mk.t -= dt) > 0);
    const alive: typeof this.dying = [];
    for (const d of this.dying) {
      d.t -= dt;
      if (d.t <= 0) { this.scene.remove(d.mesh); continue; }
      if (d.fling) {
        // Launched: ballistic arc + tumble, death clip still playing.
        const f = d.fling;
        d.mesh.position.x += f.vx * dt;
        d.mesh.position.y += f.vy * dt;
        d.mesh.position.z += f.vz * dt;
        f.vy -= 14 * dt;
        d.mesh.rotation.z += f.spin * dt;
        if (d.mesh.position.y <= 0) {
          // Landed: kill the arc, keep a skid, stop tumbling upright-ish.
          d.mesh.position.y = 0;
          f.vx *= 0.25; f.vz *= 0.25; f.vy = 0; f.spin *= 0.2;
        }
      }
      if (d.rigged) {
        (d.mesh.userData.mixer as THREE.AnimationMixer).update(dt);
      } else if (!d.fling) {
        d.mesh.rotation.z = Math.min(Math.PI / 2, d.mesh.rotation.z + dt * 4);
        d.mesh.position.y -= dt * 0.6;
      }
      alive.push(d);
    }
    this.dying = alive;
  }

  /** Claim a pooled point light: explosions and magic actually illuminate the
   * world for a beat (snap on, quadratic decay out). */
  private spawnFxLight(x: number, z: number, color: number, peak = 8, max = 0.45, y = 0.9): void {
    if (this.fxLights.length === 0) {
      for (let i = 0; i < Renderer3D.FX_LIGHT_POOL; i++) {
        const light = new THREE.PointLight(0xffffff, 0, 9, 2);
        this.scene.add(light);
        this.fxLights.push({ light, life: 1, max: 1, peak: 0 });
      }
    }
    let best = this.fxLights[0];
    for (const s of this.fxLights) {
      if (s.life / s.max > best.life / best.max) best = s; // most-finished slot
    }
    best.light.color.set(color);
    best.light.position.set(x, y, z);
    best.life = 0;
    best.max = max;
    best.peak = peak;
  }

  private updateFxLights(dt: number): void {
    for (const s of this.fxLights) {
      if (s.life >= s.max) { s.light.intensity = 0; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      const env = t < 0.12 ? t / 0.12 : (1 - (t - 0.12) / 0.88) ** 2;
      s.light.intensity = s.peak * env;
    }
  }

  /** Feed the mote cloud fresh spawn candidates: explored floor tiles near the
   * player (the void gets NOTHING) plus nearby torch anchors for ember bias. */
  private atmoTorches: { x: number; y: number }[] = [];
  private refreshAtmoSources(state: GameState, px: number, pz: number): void {
    const { map, explored } = state;
    const R = 15;
    const x0 = Math.max(0, Math.floor(px - R));
    const x1 = Math.min(map.w - 1, Math.ceil(px + R));
    const y0 = Math.max(0, Math.floor(pz - R));
    const y1 = Math.min(map.h - 1, Math.ceil(pz + R));
    let n = 0;
    const cap = this.atmoTiles.length / 2;
    for (let y = y0; y <= y1 && n < cap; y++) {
      for (let x = x0; x <= x1 && n < cap; x++) {
        const i = y * map.w + x;
        if (!explored[i] || map.tiles[i] === Tile.Wall) continue;
        if (((x * 7 + y * 13) & 3) !== 0) continue; // stable ~1/4 subsample
        this.atmoTiles[n * 2] = x + 0.5;
        this.atmoTiles[n * 2 + 1] = y + 0.5;
        n++;
      }
    }
    this.atmoTorches.length = 0;
    for (const t of this.torchAnchors) {
      const dx = t.x - px;
      const dz = t.y - pz;
      if (dx * dx + dz * dz < R * R) this.atmoTorches.push({ x: t.x, y: t.y });
    }
    this.ambientFx.setSpawnSources(this.atmoTiles, n, this.atmoTorches);
  }

  private updateParticles(dt: number): void {
    const alive: typeof this.particles = [];
    for (const pt of this.particles) {
      pt.life += dt;
      if (pt.life >= pt.max) { this.scene.remove(pt.mesh); continue; }
      pt.vy -= 9 * dt; // gravity
      pt.mesh.position.x += pt.vx * dt;
      pt.mesh.position.y += pt.vy * dt;
      pt.mesh.position.z += pt.vz * dt;
      const s = 1 - pt.life / pt.max;
      pt.mesh.scale.setScalar(0.4 + s * 0.6);
      if (pt.mesh.position.y < 0.05) { pt.vy = Math.abs(pt.vy) * 0.4; pt.mesh.position.y = 0.05; }
      alive.push(pt);
    }
    this.particles = alive;

    // Glow sprites: fade + optional grow/shrink, no gravity.
    const fxAlive: typeof this.fxSprites = [];
    for (const fx of this.fxSprites) {
      fx.life += dt;
      if (fx.life >= fx.max) { this.scene.remove(fx.sprite); continue; }
      const t = fx.life / fx.max;
      (fx.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
      if (fx.grow !== 0) fx.sprite.scale.multiplyScalar(1 + fx.grow * dt);
      fxAlive.push(fx);
    }
    this.fxSprites = fxAlive;

    // Chains: fade every material in the run, then drop it whole.
    const chainAlive: typeof this.chainFx = [];
    for (const cf of this.chainFx) {
      cf.life += dt;
      if (cf.life >= cf.max) {
        this.scene.remove(cf.group);
        for (const m of cf.mats) m.dispose();
        continue;
      }
      for (const m of cf.mats) (m as THREE.MeshBasicMaterial).opacity = 1 - cf.life / cf.max;
      chainAlive.push(cf);
    }
    this.chainFx = chainAlive;

    // Fade props (smokebomb, stars, cones): spin, grow/collapse, fade, vanish.
    // Growth is a deterministic curve off the spawn scale (no per-frame
    // compounding); `pop` adds an anticipation overshoot on the way in.
    const propsAlive: typeof this.fadeProps = [];
    for (const fp of this.fadeProps) {
      fp.life += dt;
      if (fp.life >= fp.max) { this.scene.remove(fp.obj); continue; }
      fp.obj.rotation.y += dt * fp.spin;
      let s = fp.s0 * Math.max(0.05, 1 + fp.grow * fp.life);
      if (fp.pop) {
        const k = Math.min(1, fp.life / (fp.max * 0.4));
        s *= 0.6 + 0.4 * k + 0.28 * Math.sin(k * Math.PI); // punch past, settle back
      }
      fp.obj.scale.setScalar(s);
      const t = fp.life / fp.max;
      for (const mat of fp.mats) (mat as THREE.MeshBasicMaterial).opacity = 1 - t * t;
      propsAlive.push(fp);
    }
    this.fadeProps = propsAlive;

    // Level-up rings: expand + fade, then drop.
    const ringAlive: typeof this.levelRings = [];
    for (const r of this.levelRings) {
      r.life += dt;
      if (r.life >= r.max) { this.scene.remove(r.mesh); continue; }
      const t = r.life / r.max;
      r.mesh.scale.setScalar(0.5 + t * 2.2);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      ringAlive.push(r);
    }
    this.levelRings = ringAlive;

    // Melee trails: a fast sweep — expand slightly, rotate through the arc,
    // fade hard. Geometry is shared; only the material dies with the trail.
    const trailAlive: typeof this.meleeTrails = [];
    for (const tr of this.meleeTrails) {
      tr.life += dt;
      if (tr.life >= tr.max) {
        this.scene.remove(tr.mesh);
        (tr.mesh.material as THREE.Material).dispose();
        continue;
      }
      const t = tr.life / tr.max;
      tr.mesh.scale.setScalar(0.82 + t * 0.5);
      tr.mesh.rotation.y += dt * 7;
      (tr.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t * t);
      trailAlive.push(tr);
    }
    this.meleeTrails = trailAlive;
  }

  /** D4-style level-up halo: an expanding gold ring at the crawler's feet. */
  emitLevelUp(x: number, z: number): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1, 32),
      new THREE.MeshBasicMaterial({
        color: 0xf2c14e, transparent: true, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.08, z);
    this.scene.add(mesh);
    this.levelRings.push({ mesh, life: 0, max: 1.3 });
    this.spawnFxLight(x, z, 0xf2c14e, 8, 0.8, 1.0);
  }

  /** Project a world point to screen pixels (for DOM overlays like damage numbers). */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    // Ensure the camera's world/inverse matrices reflect this frame's lookAt.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    return {
      x: (v.x * 0.5 + 0.5) * size.x,
      y: (-v.y * 0.5 + 0.5) * size.y,
      visible: v.z < 1,
    };
  }

  render(): void {
    this.composer.render();
  }
}
