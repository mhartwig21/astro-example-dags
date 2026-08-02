import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { Tile, type BossEvent, type GameState, type HitEvent, type Monster, type Player, type Vec2 } from "../sim/types";
import { DEFAULT_MOOD, THEME, type BandMood } from "./theme";
import { ELITE_TEXTURES, startModelLoad, type LoadedModel } from "./assets";
import { roomTemplateById } from "../content/rooms";
import { mobDefById } from "../content/mobs";
import type { CustomMobDef } from "../content/types";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import {

  bulwarkParams, cataclysmParams, novaParams, orbitBladePos, orbitHurlPoint, orbitParams, rank, slotted,
} from "../sim/abilities";
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
import { accentGlows, placeDecals, signatureDressing, voidSilhouettes, type EnvCtx } from "./envDressing";
import { bakeLightGrid, neutralLightGrid, LM_SCALE, LM_AO_SCALE, type BakeLight, type BakeStain } from "./lightGrid";
import { FxParticles, TEX_FLICKER } from "./fxParticles";
import { SwingArcs, TrailRibbons } from "./fxTrails";
import {
  QUALITY_PRESETS, QUALITY_ORDER, QualityAutoTuner, guessQuality, loadQualityChoice,
  saveQualityChoice, urlQualityOverride, type QualityChoice, type QualityProfile,
} from "./quality";
import { FX_PAL, GroundDecals, Shockwaves, TELEGRAPH_GEO, makeTelegraphMat, makeLaneMat, makePoolMat, makeDissolving } from "./fx";
import { BossFx } from "./bossFx";
import { ASK_PAL, bossFamily } from "./bossSignatures";
import {
  AIM_MIN_FOOTPRINT_PX, AIM_STROKE_PX, buildAimShape, disposeAimShape,
  type AimIndicatorShape,
} from "./aimIndicator";

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
      // Capped to the OUTER ~10% of frame (final pass, issue #1): a vignette
      // that starts mid-frame was stacking with the murk and crushing 60%+
      // of every shot below 5% luminance.
      float d = length(vUv - 0.5) * 1.4142;
      float vig = 1.0 - uVignette * smoothstep(0.84, 1.16, d);
      c.rgb = mix(uVigColor, c.rgb, vig);
      gl_FragColor = c;
    }`,
};

// Bloom at a fraction of frame resolution (quality ladder).
//
// UnrealBloomPass already halves before it builds its 5-mip chain, so a scale
// of 0.5 puts the brightest mip at a quarter of frame resolution. The pass's
// final step is an additive fullscreen quad into the FULL-res read buffer, so
// the scale never changes where bloom lands or how bright it is — only how
// finely the glow is sampled. A wide soft kernel (radius 0.7 here) is a blur
// of a blur: dropping its input resolution is invisible, and it takes the mip
// chain's fill cost down with it quadratically.
class ScaledBloomPass extends UnrealBloomPass {
  private scale = 1;
  private fullW = 2;
  private fullH = 2;
  setScale(s: number): void {
    if (s === this.scale) return;
    this.scale = s;
    this.setSize(this.fullW, this.fullH);
  }
  setSize(width: number, height: number): void {
    this.fullW = width; this.fullH = height;
    super.setSize(
      Math.max(2, Math.round(width * this.scale)),
      Math.max(2, Math.round(height * this.scale)),
    );
  }
}

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

  // PERF (CPU floor): with an externally-supplied depth buffer the stock pass
  // skips its G-buffer prepass entirely — no second full-scene render, no
  // second shadow-map build, and no pair of scene.traverse() visibility walks
  // over ~5,700 objects. What is left is four fullscreen quads. The normal
  // target is then never rendered into, so keep it at 1x1 instead of paying
  // for a full-res HalfFloat surface + depth texture that nothing reads.
  private gbufOff = false;
  useSharedDepth(depth: THREE.DepthTexture): void {
    this.setGBuffer(depth, undefined);
    this.gbufOff = true;
    (this as unknown as { normalRenderTarget: THREE.WebGLRenderTarget }).normalRenderTarget.setSize(1, 1);
  }

  // HALF-RES AO WITH A BILATERAL UPSAMPLE (quality ladder).
  //
  // The AO buffer and the denoise buffer are sized independently. Running the
  // AO march at aoScale 0.5 costs a QUARTER of its samples; the denoise pass
  // then runs at full resolution and reads the small AO buffer through
  // textureLod (bilinear) while weighting every tap by depth, normal and luma
  // from the FULL-res shared depth buffer. That is precisely a joint-bilateral
  // upsample, and it is stock three shader code — no custom pass needed. The
  // occlusion contact line stays pinned to the geometry edge instead of
  // bleeding across it the way a plain bilinear stretch would.
  //
  // Setting denoiseScale below 1 gives up the bilateral upsample and lets the
  // AO blend do a plain bilinear stretch instead — cheaper, softer, which is
  // the right trade on the lower rungs.
  private aoScale = 1;
  private denoiseScale = 1;
  private fullW = 2;
  private fullH = 2;
  setResolutionScales(aoScale: number, denoiseScale: number): void {
    if (aoScale === this.aoScale && denoiseScale === this.denoiseScale) return;
    this.aoScale = aoScale;
    this.denoiseScale = denoiseScale;
    this.setSize(this.fullW, this.fullH);
  }

  // Stock setSize also resizes normalRenderTarget; skip that once it is dead.
  setSize(width: number, height: number): void {
    this.fullW = width; this.fullH = height;
    if (!this.gbufOff) { super.setSize(width, height); return; }
    const self = this as unknown as {
      width: number; height: number;
      gtaoRenderTarget: THREE.WebGLRenderTarget; pdRenderTarget: THREE.WebGLRenderTarget;
      gtaoMaterial: THREE.ShaderMaterial; pdMaterial: THREE.ShaderMaterial;
    };
    const aw = Math.max(1, Math.round(width * this.aoScale));
    const ah = Math.max(1, Math.round(height * this.aoScale));
    const dw = Math.max(1, Math.round(width * this.denoiseScale));
    const dh = Math.max(1, Math.round(height * this.denoiseScale));
    self.width = width; self.height = height;
    self.gtaoRenderTarget.setSize(aw, ah);
    self.pdRenderTarget.setSize(dw, dh);
    // Each material's `resolution` is the size of the buffer IT writes: the AO
    // march steps in AO texels, the denoise steps its poisson radius in denoise
    // texels. Feeding either the other one's size scales the kernels wrongly.
    self.gtaoMaterial.uniforms.resolution.value.set(aw, ah);
    self.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
    self.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
    self.pdMaterial.uniforms.resolution.value.set(dw, dh);
    self.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
  }

  // EffectComposer ping-pongs two render targets and rt2 is a clone of rt1 —
  // so each carries its OWN cloned DepthTexture. Re-point the AO + denoise
  // samplers at whichever buffer the RenderPass just filled; otherwise a pass
  // count with odd swap parity would silently feed us last frame's depth.
  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime = 0,
    maskActive = false,
  ): void {
    if (this.gbufOff) {
      const depth = readBuffer.depthTexture;
      const self = this as unknown as {
        depthTexture: THREE.Texture | null;
        gtaoMaterial: THREE.ShaderMaterial; pdMaterial: THREE.ShaderMaterial;
      };
      if (depth && self.depthTexture !== depth) {
        self.depthTexture = depth;
        self.gtaoMaterial.uniforms.tDepth.value = depth;
        self.pdMaterial.uniforms.tDepth.value = depth;
      }
    }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
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

// BOSSES V2 (capture round 2) — arena furniture keys are GAMEPLAY keys, not
// asset keys: the sim writes "drain" / "vent" / "shutdown" / "barricade" /
// "rubble" because that is what the mechanic is called. None of those exist in
// the KayKit pool, so modelInstance returned null and the props rendered as
// nothing at all — which is why a Sump King capture had "no floodgate, no
// drain prop in frame" for a boss whose entire ask is the floodgates.
const BREAKABLE_MODEL: Record<string, string> = {
  drain: "floor_tile_grate_open", // FLOODGATE: a grate the level runs out of
  vent: "fuel_a_barrels", // WALL VENT: pressure plant
  shutdown: "anvil", // CONVEYOR control: heavy machinery
  collapse: "pillar",
  barricade: "crates_stacked",
  rubble: "rubble_half",
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

  // Post chain: Render -> GTAO -> Bloom -> Output (ACES + sRGB) -> Grade -> SMAA.
  private composer: EffectComposer;
  private gtao: WorldGTAOPass;
  private bloom: ScaledBloomPass;
  private gradePass: ShaderPass;
  // SMAA runs LAST, on the tone-mapped, graded, gamma-encoded image. Edge
  // detection wants perceptual (display-referred) values — running AA inside
  // the linear HDR chain makes it under-detect edges in the shadows and
  // over-detect them in the highlights. Grade is a smooth per-pixel operator
  // (no grain), so there is nothing for SMAA to smear here.
  private smaa: SMAAPass | null = null;

  // ---- Quality ladder (see quality.ts) ----
  private quality: QualityProfile;
  private qualityChoice: QualityChoice;
  private tuner: QualityAutoTuner;
  private onQualityChange: ((p: QualityProfile) => void) | null = null;
  /** Composed-frame counter, for the shadow-rebuild cadence. */
  private frameNo = 0;
  /** Force the next composed frame to rebuild the shadow map regardless of the
   *  preset's cadence — set whenever the map is destroyed. */
  private shadowDirty = true;
  private lastFrameAt = 0;
  /** Wall-clock deadline before which the tuner ignores every frame. */
  private warmupUntil = 0;
  /** Set by beginTuning() (or, as a fallback, by the end of prewarm) — the
   *  moment the player is actually looking at the game. */
  private tuningArmed = false;

  /** The effective device pixel ratio: the display's, capped by the preset. */
  private pixelRatio(): number {
    return Math.min(devicePixelRatio || 1, this.quality.pixelRatioCap) * this.renderScale;
  }

  /** Current preset (settings UI reads this). */
  get qualityProfile(): QualityProfile {
    return this.quality;
  }

  /** "auto" or the pinned preset name (settings UI reads this). */
  get qualitySetting(): QualityChoice {
    return this.qualityChoice;
  }

  /** Fired whenever the preset actually changes, including auto-detect moves,
   *  so the settings row can repaint itself without polling. */
  setQualityListener(fn: ((p: QualityProfile) => void) | null): void {
    this.onQualityChange = fn;
  }

  /**
   * MANUAL OVERRIDE (settings row). "auto" hands control back to the tuner,
   * starting from whatever is on screen now.
   */
  setQuality(choice: QualityChoice): void {
    this.qualityChoice = choice;
    saveQualityChoice(choice);
    if (choice === "auto") {
      this.tuner.reset(this.quality.name);
      return;
    }
    this.tuner.reset(choice);
    this.applyQuality(QUALITY_PRESETS[choice]);
  }

  /**
   * HAND THE AUTO-TUNER OVER TO REAL GAMEPLAY.
   *
   * Until this is called the tuner is inert: it neither samples nor changes
   * anything. Call it at the exact moment the player starts seeing frames —
   * in main3d.ts that is immediately after `await renderer.prewarm(...)`
   * returns, on the same line as hiding #loading:
   *
   *     await renderer.prewarm(state, ...);
   *     renderer.beginTuning();          // <-- here
   *     loadingEl.classList.add("done");
   *
   * prewarm() calls this itself as a fallback, so a host that never wires it up
   * still gets a tuner armed at the end of prewarm rather than at the first
   * compile frame. Calling it again is safe and simply restarts the warm-up
   * window, which is what a host wants if it shows a menu in between.
   */
  beginTuning(): void {
    this.tuningArmed = true;
    this.warmupUntil = 0; // re-armed on the next composed frame
    this.lastFrameAt = 0;
  }

  /**
   * Push a profile into the live pipeline.
   *
   * Everything touched here is reallocation of buffers or a pass toggle —
   * deliberately NOT anything that changes a material's program. Light-pool
   * sizes in particular are read once when the pools are first built (during
   * prewarm, behind the loading screen) and are left alone afterwards: a
   * forward renderer compiles a program per light count, so resizing a pool
   * mid-run is exactly the multi-second shader stall this work exists to kill.
   */
  private applyQuality(p: QualityProfile): void {
    const prev = this.quality;
    this.quality = p;

    if (p.pixelRatioCap !== prev.pixelRatioCap) this.resize(this.lastW, this.lastH);

    if (p.msaaSamples !== prev.msaaSamples) {
      for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        rt.samples = p.msaaSamples;
        rt.dispose(); // forces reallocation with the new sample count
      }
    }

    if (this.smaa) this.smaa.enabled = p.smaa;

    // Push the AO configuration UNCONDITIONALLY, not only when the pass is on.
    // Gating it on `p.gtao` left the buffers sized for whatever rung was
    // visited last, so a profile's gtaoScale/gtaoDenoiseScale silently did not
    // describe the pass whenever it was entered with AO off — a field that
    // lies. The calls are cheap and idempotent while the pass is disabled.
    this.gtao.enabled = p.gtao;
    this.gtao.setResolutionScales(p.gtaoScale, p.gtaoDenoiseScale);
    this.gtao.updateGtaoMaterial({ samples: p.gtaoSamples });
    this.gtao.updatePdMaterial({ samples: p.gtaoDenoiseSamples });

    this.bloom.enabled = p.bloom;
    this.bloom.setScale(p.bloomScale);

    if (p.shadowMapSize !== prev.shadowMapSize) {
      this.renderer.shadowMap.enabled = p.shadowMapSize > 0;
      if (p.shadowMapSize > 0) {
        this.key.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
        // The map is only reallocated at the new size if the old one is gone.
        this.key.shadow.map?.dispose();
        this.key.shadow.map = null;
        // ...AND THE NEXT COMPOSED FRAME MUST REBUILD IT, WHATEVER THE CADENCE.
        //
        // Without this the frame after a preset change composed with
        // key.shadow.map === null: three.js binds its 1x1 emptyTexture for
        // directionalShadowMap, the PCF compare returns 0, and the key light
        // reads as fully occluded. Measured by gl.readPixels of the real
        // backbuffer: 71.9 mean luminance with a map vs 47.0 without — one
        // frame 35% darker, on 12 of 12 disposals into a preset whose
        // shadowInterval is > 1. It fired on every auto-tuner downgrade, i.e.
        // exactly when the machine is already slow enough that the black flash
        // lasts 100 ms rather than 17.
        this.shadowDirty = true;
      }
    }

    this.fxp.setDensity(p.fxDensity);
    this.ambientFx.setDensity(p.moteDensity);

    this.onQualityChange?.(p);
  }

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
    // WALL-AWARE visibility (final pass, issue #2): per-tile walk-distance
    // field BFS'd from the player through the walkable grid — the light
    // falloff follows corridors and stops at architecture instead of
    // airbrushing a radial blob across walls. R8, dist/32 tiles.
    uWlDist: { value: neutralLightGrid() as THREE.Texture },
    // READABLE DARKNESS floor (final pass, issue #1): out-of-play geometry
    // keeps ~8-12% display luminance — band-hued cool murk that still shows
    // tile/wall texture — plus sparse warm accent glints (embers/fungus/
    // crowd-cam drones per the DCC fiction) every 8-10 tiles.
    uWlMurk: { value: new THREE.Color(0.9, 1.0, 1.25).multiplyScalar(0.034) },
    uWlGlint: { value: new THREE.Color(1.0, 0.6, 0.3).multiplyScalar(0.22) },
  };
  // The live baked grid for the current floor (disposed on rebuild).
  private lightGridTex: THREE.DataTexture | null = null;
  // Walk-distance field for the wall-aware light falloff (issue #2): all
  // buffers preallocated per floor — the per-tile BFS re-runs only when the
  // player crosses a tile boundary, with zero hot-loop allocation.
  private wlDist: {
    tex: THREE.DataTexture;
    data: Uint8Array;
    field: Float32Array;
    queue: Int32Array;
    lastTile: number;
  } | null = null;
  // Prop materials already swapped for their world-lit clone this build
  // (original -> clone), so shared loader-cache materials clone exactly once.
  private wlPropCache = new Map<string, THREE.Material>();
  // Per-instance foliage tint variants (r5 issue #4: three identical
  // styrofoam trees): quantized so a whole garden costs ~5 material clones
  // per source atlas — warm, cool, deep, autumn-leaning individuals.
  private static FOLIAGE_KEY = /^(forest_tree|forest_bush|tree_dead)/;
  private static FOLIAGE_VARIANTS: [number, number, number][] = [
    [1, 1, 1],
    [1.14, 1.05, 0.82], // sun-warm
    [0.84, 0.97, 1.08], // cool shade
    [0.76, 0.86, 0.78], // deep evergreen
    [1.22, 0.98, 0.66], // autumn lean
  ];
  // Per-instance VALUE variants for every other prop (r7 material blocker:
  // "undercroft tables/chairs/jugs all the same uniform orange-red") — four
  // quantized value/warmth steps so a furnished room reads as individuals
  // with tonal structure, at a bounded clone cost per source atlas.
  private static PROP_VARIANTS: [number, number, number][] = [
    [1, 1, 1],
    [0.82, 0.80, 0.82], // shadow-worn
    [1.13, 1.09, 1.0], // key-side lift
    [0.92, 0.87, 0.80], // sooted warm-dark
  ];

  /** Clone a material and inject the world-light fragment stage (fog mask +
   * distance falloff), optionally the wall base-gradient + lit top bevel
   * ("base") or the canopy sky-gradient ("canopy"). Clones are tracked in
   * floorMats and disposed on the next floor rebuild. */
  private worldLit<T extends THREE.Material | THREE.Material[]>(
    mat: T,
    opts: { dim?: number; base?: boolean; canopy?: boolean; prop?: boolean } = {},
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
          "#include <common>\nvarying vec3 vWlPos;\nfloat wlK;\nfloat wlFogG;\nfloat wlPropR = 1.0;\nvec3 wlBake;\nvec3 wlFogSil;\nuniform sampler2D uWlMask;\nuniform sampler2D uWlLm;\nuniform sampler2D uWlNoise;\nuniform sampler2D uWlDist;\nuniform vec2 uWlMapInv;\nuniform vec2 uWlPlayer;\nuniform vec3 uWlDark;\nuniform vec3 uWlFall;\nuniform vec3 uWlMurk;\nuniform vec3 uWlGlint;\nuniform float uWlDim;\nuniform float uWlFlick;\nuniform float uWlTime;";
        let stage = "#include <color_fragment>\n{\n";
        if (opts.base) {
          // Masonry: darken toward the ground line, then a LIT top-edge bevel
          // band — the 2-tone wall (dark face, bright rim) that separates a
          // carved wall from an unlit extrusion.
          stage +=
            // Top bevel stays subtle: a step, not frosting — the pale slab
            // caps read as snow at 0.55 (the critic's "cake frosting" note).
            "  float wallShade = 0.7 + 0.3 * smoothstep(-0.06, 0.85, vWlPos.y);\n" +
            "  wallShade += 0.16 * smoothstep(0.80, 0.95, vWlPos.y);\n" +
            "  diffuseColor.rgb *= wallShade;\n" +
            // Noise-broken SOOT/MOSS gradient rising from the floor line so
            // long runs never read as one repeated clean stamp (critic r2:
            // monotonous single-height brick with visible tiling).
            "  float sNz = texture2D(uWlNoise, vWlPos.xz * 0.11 + vec2(0.31, 0.77)).r;\n" +
            "  float soot = (1.0 - smoothstep(0.03, 0.55, vWlPos.y)) * (0.35 + 0.65 * sNz);\n" +
            "  diffuseColor.rgb *= 1.0 - 0.30 * soot;\n" +
            "  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.86, 0.94, 0.84), soot * 0.55);\n";
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
          (opts.prop
            ? // PROP MATERIAL ZONING (r6 item #2 + r5 "flat single-albedo props
              // read as unlit plastic"): a trim-sheet-style pass every placed
              // prop shares —
              //  · soft albedo ceiling: pale texels (raw KayKit stone/plaster/
              //    paper) compress toward ~0.86 so they keep a shading gradient
              //    under torchlight instead of blowing out to graybox white;
              //  · stone zoning: bright UNSATURATED texels lean warm sandstone
              //    (dyed cloth/gold/foliage keep their hue identity);
              //  · two-octave world-space grain: baked-AO-style tonal breakup
              //    so no face renders as one flat value;
              //  · cavity shading from the face normal: tops catch the key,
              //    undersides sink — chunky boxes read carved, not extruded;
              //  · ground grime rising from the floor line grounds the base;
              //  · the grain drives roughness too (wlPropR below), so the
              //    torch specular response varies across a face.
              "  float pMx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));\n" +
              "  float pSat = pMx - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));\n" +
              "  diffuseColor.rgb *= mix(1.0, 0.86 / max(pMx, 1e-4), smoothstep(0.72, 1.05, pMx));\n" +
              "  float pStone = (1.0 - smoothstep(0.10, 0.34, pSat)) * smoothstep(0.36, 0.62, pMx);\n" +
              "  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.07, 0.97, 0.84), pStone * 0.75);\n" +
              "  float pNz = texture2D(uWlNoise, vWlPos.xz * 0.83 + vec2(vWlPos.y * 0.41, vWlPos.y * -0.23)).r;\n" +
              "  float pNz2 = texture2D(uWlNoise, vWlPos.xz * 3.1 + vec2(vWlPos.y * 1.7, 0.37)).r;\n" +
              // r7 material blocker (flat single-hue props): the tonal breakup
              // doubles in amplitude — a face now spans a real 2-3 value range.
              "  diffuseColor.rgb *= 0.82 + 0.20 * pNz + 0.10 * pNz2;\n" +
              // Cavity/top-light: tops catch the key hard, undersides sink deep.
              "  diffuseColor.rgb *= (0.78 + 0.32 * clamp(wlN.y, 0.0, 1.0)) * (1.0 - 0.36 * clamp(-wlN.y, 0.0, 1.0));\n" +
              // Edge-wear highlight: upward faces near a prop's crown pick up a
              // worn pale lift, broken by the fine grain — chipped paint/stone.
              "  float pEdge = clamp(wlN.y, 0.0, 1.0) * smoothstep(0.30, 0.85, vWlPos.y) * smoothstep(0.45, 0.85, pNz2);\n" +
              "  diffuseColor.rgb += (diffuseColor.rgb * 0.5 + 0.06) * pEdge * 0.55;\n" +
              "  float pBase = (1.0 - smoothstep(0.04, 0.55, vWlPos.y)) * (0.35 + 0.65 * pNz);\n" +
              "  diffuseColor.rgb *= 1.0 - 0.26 * pBase;\n" +
              "  wlPropR = 0.90 + 0.26 * pNz2 - 0.22 * pStone - 0.20 * pEdge;\n"
            : "") +
          "  vec2 wUv = (vWlPos.xz - wlN.xz * 0.38) * uWlMapInv;\n" +
          "  float wFog = texture2D(uWlMask, wUv).r;\n" +
          "  if (wUv.x < -0.001 || wUv.x > 1.001 || wUv.y < -0.001 || wUv.y > 1.001) wFog = 1.0;\n" +
          // TIGHT architectural frontier (r5 issue #1 — recurred every round):
          // the reveal band hugs the wall-shaped bilinear mask in a 1-2 tile
          // step with only a light curl of drifting noise. The old wide
          // smoothstep + deep erosion is what read as a Gaussian blob edge
          // ignoring the geometry.
          "  float wNz = texture2D(uWlNoise, vWlPos.xz * 0.045 + vec2(uWlTime * 0.010, uWlTime * -0.007)).r;\n" +
          "  wFog = clamp(smoothstep(0.24, 0.80, wFog + (wNz - 0.5) * 0.24 * wFog * (1.9 - wFog)), 0.0, 1.0);\n" +
          "  wlFogG = wFog;\n" +
          // WALL-AWARE falloff (issue #2): walk-distance BFS'd through the
          // level, not euclidean — light carving follows corridors and stops
          // at wall faces. Only a whisper of euclidean is blended in to soften
          // the core near the player; any more re-inflates the radial ellipse.
          "  float wDWalk = texture2D(uWlDist, wUv).r * 32.0;\n" +
          "  if (wUv.x < -0.001 || wUv.x > 1.001 || wUv.y < -0.001 || wUv.y > 1.001) wDWalk = 32.0;\n" +
          "  float wD = mix(wDWalk, distance(vWlPos.xz, uWlPlayer), 0.10);\n" +
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
          // Pre-desaturation albedo, kept for the murk emissive below (r7
          // minor: unlit foliage rendered 0%-sat concrete — the murk must
          // carry the surface's own hue, cooled, not a grey stamp of it).
          "  vec3 wAlb0 = diffuseColor.rgb;\n" +
          // Desaturate-THEN-darken across the fog frontier: color drains out
          // of geometry before the dark swallows it (atmospheric recession,
          // not a black multiply) — reads as a 2-3 tile smoothstep of haze.
          "  float wLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n" +
          "  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(wLum), wFog * 0.85);\n" +
          // WARM-TO-COOL transition band (r5 issue #1): across the 1-2 tile
          // frontier the lit side leans candle-warm and the dark side leans
          // cool before the murk takes over — the edge reads as light dying
          // into cold air, not a blur stamp. Peaks mid-band, zero elsewhere.
          "  float wBandM = wFog * (1.0 - wFog) * 4.0;\n" +
          "  vec3 wEdgeT = mix(vec3(1.10, 1.00, 0.86), vec3(0.82, 0.90, 1.14), smoothstep(0.2, 0.8, wFog));\n" +
          "  diffuseColor.rgb *= mix(vec3(1.0), wEdgeT, wBandM * 0.55);\n" +
          // DISTANCE recession on EXPLORED ground too: far tiles drain color
          // and cool toward the haze instead of rendering the tile texture at
          // 10% brightness (which read as an unlit level-editor blockout —
          // the critique's "visible hex grid"). Near the player: untouched.
          // ... keeping ~40% of the surface's own chroma (r7 minor: full
          // desat at range turned shadowed foliage into concrete sculptures).
          "  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(wLum), diffuseColor.rgb, 0.40) * vec3(0.72, 0.84, 1.04), 0.55 * wT);\n" +
          "  vec3 wAlb = diffuseColor.rgb;\n" +
          "  wlK = wFall * uWlDim * wLit;\n" +
          // READABLE DARKNESS (final pass, issue #1 — D2R rule): unexplored /
          // out-of-play space keeps ~8-12% display luminance. The scene lights
          // retain a whisper of albedo response (so the key still models the
          // forms) and a band-hued COOL murk emissive returns below it,
          // modulated by the geometry's own albedo + baked AO grid — tile
          // seams and wall texture stay readable in the dark instead of
          // collapsing to a crushed void. Distance cools and dims it gently
          // (never to black); the drifting noise keeps it breathing.
          // The scene-light albedo response in the dark rides the same depth
          // crush computed below — near the frontier it holds the readable
          // floor, deep void goes to black instead of faint repeating tiles.
          "  float wDepthPre = 1.0 - 0.78 * smoothstep(3.2, 10.0, wD + (wNz - 0.5) * 3.2);\n" +
          "  wDepthPre *= wDepthPre;\n" +
          "  diffuseColor.rgb = wAlb * max(wlK, wFog * 0.085 * wDepthPre);\n" +
          "  float wUp = max(wlN.y, 0.0) * smoothstep(0.30, 0.95, vWlPos.y);\n" +
          "  float wTex = dot(wAlb, vec3(0.299, 0.587, 0.114));\n" +
          "  wTex = wTex / (wTex + 0.22);\n" +
          // DEPTH CRUSH (r7 blocker: the murk read as a giant soft blob with
          // faint repeating tile texture filling 60% of frame): unlit space
          // near the frontier keeps the readable 8-12% architectural floor,
          // but past ~6 walk tiles it dives to near-black — squared falloff,
          // boundary dithered by the drifting noise so the drop-off is a
          // ragged particulate edge, never a smooth radial gradient.\n
          "  float wDepth = wDepthPre;\n" +
          "  float wMurk = (0.45 + 0.85 * wTex) * (0.80 + 0.28 * wNz) * (0.85 + 0.30 * wUp) * min(0.35 + 0.85 * wAo, 1.1);\n" +
          // Murk keeps ~55% of the surface's own hue (cooled by uWlMurk): dark
          // trees stay living green-blue, dark brick stays warm — not concrete.
          "  vec3 wChroma = mix(vec3(1.0), clamp(wAlb0 / max(dot(wAlb0, vec3(0.299, 0.587, 0.114)), 0.03), 0.0, 2.4), 0.55);\n" +
          "  wlFogSil = uWlMurk * wChroma * (wMurk * wFog * wDepth);\n" +
          // Sparse distant accents (DCC fiction: stray embers, glinting eyes,
          // crowd-cam drone lights): two decorrelated noise octaves thresholded
          // to isolated specks every ~8-10 tiles, guttering with the torch
          // flicker, only in the murk and away from the play bubble.
          "  float wG1 = texture2D(uWlNoise, vWlPos.xz * 0.37 + vec2(3.1, 7.7)).r;\n" +
          "  float wG2 = texture2D(uWlNoise, vWlPos.xz * 0.093 + vec2(9.2, 1.4)).r;\n" +
          "  float wGl = smoothstep(0.90, 0.95, wG1 * (0.30 + 0.70 * wG2));\n" +
          "  wlFogSil += uWlGlint * (wGl * wFog * (0.55 + 0.45 * uWlFlick) * smoothstep(2.5, 6.0, wD));\n" +
          "  wlBake = wAlb * wLm.rgb * (" + LM_SCALE.toFixed(3) + " * uWlFlick" + (opts.base ? " * (0.55 + 0.9 * exp(-2.6 * abs(vWlPos.y - 0.78)))" : "") + ") * wLit * (0.4 + 0.6 * wFall);\n}";
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", head)
          .replace("#include <color_fragment>", stage)
          // MATTE MURK (critic r3: fogged trees read as glossy black plastic —
          // "missing shaders"): specular response dies with the albedo, so
          // silhouettes in the dark are charcoal-matte, never wet highlights.
          .replace(
            "#include <roughnessmap_fragment>",
            "#include <roughnessmap_fragment>\n" +
              (opts.prop ? "  roughnessFactor = clamp(roughnessFactor * wlPropR, 0.08, 1.0);\n" : "") +
              "  roughnessFactor = mix(roughnessFactor, 1.0, wlFogG);",
          )
          .replace(
            "#include <metalnessmap_fragment>",
            "#include <metalnessmap_fragment>\n  metalnessFactor *= (1.0 - wlFogG);",
          )
          // Emissives (doors, water sheen) are gated by the same stage, so
          // nothing glows through unexplored fog; the baked torch pools add
          // back here as albedo-scaled radiance.
          .replace(
            "#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n  totalEmissiveRadiance *= min(1.0, wlK * 1.6);\n  totalEmissiveRadiance += wlBake + wlFogSil;",
          );
      };
      c.customProgramCacheKey = () => `wl${opts.base ? "b" : ""}${opts.canopy ? "c" : ""}${opts.prop ? "p" : ""}`;
      this.floorMats.push(c);
      return c;
    };
    return (Array.isArray(mat) ? mat.map(one) : one(mat)) as T;
  }

  /** Swap every standard material under a placed prop for its world-lit clone
   * (cached per source material, so a hundred barrels cost two clones). Props
   * then sink into the fog and the distance falloff exactly like the ground
   * they stand on, instead of floating full-bright over the murk. */
  private worldLitProp(obj: THREE.Object3D, tint?: THREE.Color, variant = ""): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const swap = (m: THREE.Material): THREE.Material => {
        if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
        const key = variant ? `${m.uuid}:${variant}` : m.uuid;
        let c = this.wlPropCache.get(key);
        if (!c) {
          c = this.worldLit(m, { prop: true });
          // MATERIAL ZONING for props (r5 issue #2: graybox setpieces): a
          // band tint multiplies the shared atlas so pale stone reads as the
          // band's stone — warm sandstone in the ruins, cold iron downstairs.
          if (tint) (c as THREE.MeshStandardMaterial).color.multiply(tint);
          this.wlPropCache.set(key, c);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  // CHARACTER SHADING (final pass, issues #3-4) — one injected stage turns
  // the flat "3D-print blank" KayKit clay into lit material:
  //  · albedo ZONING by texel luminance: dark texels (cloth/leather/metal)
  //    lean cool, bright texels (bone/ivory/skin) lean warm — the single
  //    white cast splits into readable material families;
  //  · warm-top/cool-bottom vertical 2-tone (key from above, bounce below);
  //  · cavity AO from the surface normal (undersides/crevices sink);
  //  · two-tone fresnel rim: the warm side keyed to the BAND'S practical
  //    light color (uChWarm tracks the floor theme's torch), the cool side a
  //    persistent figure-ground accent;
  //  · optional emissive ACCENT (class trim on the hero, threat glow on
  //    elites/bosses) breathing on uChTime.
  // Clones are cached per source material + variant for the session.
  private rimCache = new Map<string, THREE.Material>();
  // Shared per-frame uniforms for every character material.
  private chU = {
    uChTime: { value: 0 },
    uChWarm: { value: new THREE.Color(0xffc890).multiplyScalar(0.85) },
  };
  private applyCharacterShading(
    g: THREE.Object3D,
    opts: {
      rim: number; // cool rim color
      strength: number; // rim intensity
      desat?: number; // palette pullback 0..1 (mobs cede saturation to the hero)
      hero?: boolean; // value/saturation authority boost (+~18%/12%)
      accent?: number; // emissive accent color (class trim / elite threat)
      accentGain?: number; // accent intensity (default 0.35)
      tint?: number; // archetype albedo tint folded into UNSATURATED texels
      tintGain?: number; // how far white-clay texels lean into the tint (default 0.5)
      value?: number; // flat value multiplier (<1: mobs cede brightness to the hero)
      grime?: number; // 0..1 foot-up wear: darkened, desaturated base (boss material pass)
      trim?: number; // metallic edge-glint hex (gold trim on the upper body)
      trimGain?: number; // trim intensity (default 0.3)
      gloss?: number; // roughness override (porcelain sheen < the 0.82 clay cap)
    },
  ): void {
    const col = new THREE.Color(opts.rim);
    const desat = opts.desat ?? 0;
    const accent = opts.accent !== undefined ? new THREE.Color(opts.accent) : null;
    const accentGain = opts.accentGain ?? 0.35;
    const trim = opts.trim !== undefined ? new THREE.Color(opts.trim) : null;
    const trimGain = opts.trimGain ?? 0.3;
    // Archetype tint, VALUE-PRESERVING (issue #3: "bone-white 3D-print
    // blanks"): normalize so the max component is 1 — the tint shifts hue on
    // white clay without crushing it toward black.
    let tint: THREE.Color | null = null;
    if (opts.tint !== undefined) {
      tint = new THREE.Color(opts.tint);
      const mx = Math.max(tint.r, tint.g, tint.b, 1e-3);
      tint.multiplyScalar(1 / mx);
    }
    const tintGain = opts.tintGain ?? 0.5;
    // ---- ONE PROGRAM FOR EVERY CHARACTER IN THE GAME ----------------------
    //
    // THIS USED TO BAKE THE NUMBERS INTO THE GLSL, and that was the single
    // biggest source of the multi-second freezes. Every archetype's rim hex,
    // tint hex, accent hex, trim hex and five gains were emitted as float
    // literals, so `variant` (and with it the program cache key) changed for
    // EVERY monster type. A skeleton, an orc and a tiefling are the same shader
    // with different constants, but three.js saw three programs — and built
    // each one the first time that monster walked on screen. Measured on the
    // reference machine (tools/progkeys.mjs, ULTRA, native res): 55 programs
    // compiled DURING gameplay, ~32 of them these character variants, and on
    // ANGLE/D3D11 each build blocks the frame it lands on for a few hundred ms.
    //
    // The numbers are now UNIFORMS and every term is emitted UNCONDITIONALLY,
    // so the shader text is a compile-time constant and `customProgramCacheKey`
    // is a constant too: all characters share one program per (map, skinning)
    // shape, which prewarm can enumerate exhaustively.
    //
    // "Unconditionally" is safe because every optional term has an EXACT
    // identity at gain 0 — mix(x, y, 0.0) is x and `+= c * 0.0` is nothing —
    // so a monster with no trim renders bit-identically to the old build's
    // no-trim program. Nothing is approximated to win the merge.
    //
    // The optional terms are then skipped with `if (uChSomeGain > 0.0)`. That
    // condition is a UNIFORM, so it is constant across an entire draw call:
    // every fragment in the batch takes the same branch, there is no warp
    // divergence, and a mob with no tint/grime/accent/trim pays about what it
    // paid back when those terms were compiled out of its private program.
    // The branch is what makes a single shared program affordable.
    const colorGlsl =
      // Palette pullback (mobs cede saturation to the hero). uChDesat = 1 - desat.
      `\n  diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), diffuseColor.rgb, uChDesat);` +
      // HERO AUTHORITY (issue #4): the player owns the value/saturation budget
      // — ~18% more chroma and ~12% more value than any NPC. uChHeroSat is 1.0
      // and uChValue folds in the flat value multiplier for everyone else.
      `\n  diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), diffuseColor.rgb, uChHeroSat) * uChValue;` +
      // ALBEDO ZONING, archetype pass (issue #3): bright UNSATURATED texels —
      // the white clay that reads as a 3D-print blank — take on the archetype's
      // hue (an ogre gets ogre skin, a cultist gets robe dye), while
      // already-dyed texels (cloth, trim) and dark texels (leather, metal — the
      // cool lean below owns those) keep their material identity.
      `\n  if (uChTintGain > 0.0) { float tMx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));` +
      `\n    float tSat = tMx - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));` +
      `\n    float tK = (1.0 - smoothstep(0.08, 0.30, tSat)) * smoothstep(0.30, 0.60, tMx);` +
      `\n    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uChTint, tK * uChTintGain); }` +
      // MATERIAL WEAR (r7 boss pass): the base of the figure carries floor
      // grime — darker, desaturated, leaning warm-dirt — fading out by chest
      // height. Kills the "untextured white cylinder" read at the silhouette's
      // widest point without touching the face/crown.
      `\n  if (uChGrime > 0.0) { float gK = (1.0 - smoothstep(0.15, 1.05, vChW.y)) * uChGrime;` +
      `\n    vec3 gDirt = mix(vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), diffuseColor.rgb, 0.6) * vec3(0.62, 0.55, 0.47);` +
      `\n    diffuseColor.rgb = mix(diffuseColor.rgb, gDirt, gK); }` +
      `\n  { float chL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));` +
      `\n    diffuseColor.rgb *= mix(vec3(0.78, 0.85, 1.10), vec3(1.10, 1.01, 0.88), smoothstep(0.22, 0.68, chL));` +
      `\n    diffuseColor.rgb *= mix(vec3(0.84, 0.88, 1.02), vec3(1.05, 1.02, 0.97), smoothstep(0.05, 1.35, vChW.y)); }` +
      // ALBEDO CEILING (audit r5 blocker: "fullbright white brutes"): bone/
      // ivory texels at ~1.0 albedo saturate the tone-map shoulder under any
      // real light and read as an UNLIT material error. Softly compress the
      // brightest texels toward ~0.84 so even white bone keeps a shading
      // gradient; the hero keeps its authority boost untouched (uChCeil = 0).
      `\n  if (uChCeil > 0.0) { float chMx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));` +
      `\n    diffuseColor.rgb *= mix(1.0, 0.84 / max(chMx, 1e-4), smoothstep(0.70, 1.04, chMx)); }`;
    // Normal-dependent terms run at emissivemap_fragment (normal is live):
    // cavity AO sink, the two-tone rim, the accent glow and the trim glint.
    const emisGlsl =
      `{ diffuseColor.rgb *= 0.78 + 0.22 * smoothstep(-0.7, 0.6, normal.y);\n` +
      `  vec3 rimV = normalize(vViewPosition);\n` +
      `  float rimF = pow(1.0 - clamp(dot(normal, rimV), 0.0, 1.0), 3.0);\n` +
      `  float rimSide = smoothstep(-0.45, 0.55, -normal.x * 0.6 + normal.y * 0.55);\n` +
      `  vec3 rimC = mix(uChRim, uChWarm, rimSide);\n` +
      `  totalEmissiveRadiance += rimC * (rimF * uChRimStr);\n` +
      // Accent rides the mid-fresnel band (trim/edges, not the whole body),
      // breathing at ~1.3Hz so it reads alive at a glance.
      `  if (uChAccentGain > 0.0) {\n` +
      `    float accF = pow(1.0 - clamp(dot(normal, rimV), 0.0, 1.0), 2.0);\n` +
      `    float accPulse = 0.75 + 0.25 * sin(uChTime * 8.2);\n` +
      `    totalEmissiveRadiance += uChAccent * (accF * uChAccentGain * accPulse); }\n` +
      // GOLD TRIM GLINT (r7 boss pass, matches the HUD's gold-on-black
      // language): a steady metallic edge catch on the UPPER body — fresnel
      // edges plus up-facing bevels — so the crown/shoulders read from the
      // gameplay camera, not just a probe angle.
      `  if (uChTrimGain > 0.0) {\n` +
      `    float trF = pow(1.0 - clamp(dot(normal, rimV), 0.0, 1.0), 2.2);\n` +
      `    float trUp = smoothstep(0.25, 0.85, normal.y);\n` +
      `    float trH = smoothstep(0.55, 1.35, vChW.y);\n` +
      `    totalEmissiveRadiance += uChTrim * (max(trF, trUp * 0.55) * trH * uChTrimGain); }\n` +
      `}`;
    // The per-material uniform block. These values used to be GLSL literals;
    // they are the ONLY thing that differs between one character and another.
    const chVals = {
      uChDesat: { value: 1 - desat },
      uChHeroSat: { value: opts.hero ? 1.18 : 1 },
      uChValue: { value: (opts.hero ? 1.12 : 1) * (opts.value ?? 1) },
      uChTint: { value: tint ?? new THREE.Color(1, 1, 1) },
      uChTintGain: { value: tint ? tintGain : 0 },
      uChGrime: { value: opts.grime ?? 0 },
      uChCeil: { value: opts.hero ? 0 : 1 },
      uChRim: { value: col },
      uChRimStr: { value: opts.strength },
      uChAccent: { value: accent ?? new THREE.Color(0, 0, 0) },
      uChAccentGain: { value: accent ? accentGain : 0 },
      uChTrim: { value: trim ?? new THREE.Color(0, 0, 0) },
      uChTrimGain: { value: trim ? trimGain : 0 },
    };
    const chDecl =
      "uniform float uChDesat;\nuniform float uChHeroSat;\nuniform float uChValue;\n" +
      "uniform vec3 uChTint;\nuniform float uChTintGain;\nuniform float uChGrime;\n" +
      "uniform float uChCeil;\nuniform vec3 uChRim;\nuniform float uChRimStr;\n" +
      "uniform vec3 uChAccent;\nuniform float uChAccentGain;\n" +
      "uniform vec3 uChTrim;\nuniform float uChTrimGain;\n";
    // Still one MATERIAL per distinct look (it carries the uniform values), but
    // every one of them now resolves to the same PROGRAM.
    const variant = `${opts.rim}:${opts.strength}:${desat}:${opts.hero ? "h" : ""}:${opts.accent ?? ""}:${accentGain}:${opts.tint ?? ""}:${tintGain}:${opts.value ?? 1}:${opts.grime ?? 0}:${opts.trim ?? ""}:${trimGain}:${opts.gloss ?? ""}:w7u`;
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
          // Subtle specular response (audit r5): KayKit ships roughness-1
          // clay — capping it lets torch pools catch a soft highlight on
          // shoulders/helmets so characters read as material, not matte.
          (c as THREE.MeshStandardMaterial).roughness =
            Math.min((c as THREE.MeshStandardMaterial).roughness ?? 1, opts.gloss ?? 0.82);
          // Porcelain/gloss tier picks up a whisper of metalness so the sheen
          // has color, not just a white ping.
          if (opts.gloss !== undefined) {
            (c as THREE.MeshStandardMaterial).metalness =
              Math.max((c as THREE.MeshStandardMaterial).metalness ?? 0, 0.12);
          }
          c.onBeforeCompile = (shader) => {
            // chU is SHARED (one object per uniform, driven per frame for every
            // character at once); chVals is PER MATERIAL — that split is what
            // lets one program serve every archetype.
            Object.assign(shader.uniforms, this.chU, chVals);
            shader.vertexShader = shader.vertexShader
              .replace("#include <common>", "#include <common>\nvarying vec3 vChW;")
              .replace(
                "#include <project_vertex>",
                "#include <project_vertex>\nvChW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
              );
            shader.fragmentShader = shader.fragmentShader
              .replace(
                "#include <common>",
                `#include <common>\nvarying vec3 vChW;\nuniform float uChTime;\nuniform vec3 uChWarm;\n${chDecl}`,
              )
              .replace(
                "#include <emissivemap_fragment>",
                `#include <emissivemap_fragment>\n${emisGlsl}`,
              )
              .replace(
                "#include <color_fragment>",
                `#include <color_fragment>${colorGlsl}`,
              );
          };
          // CONSTANT, deliberately: the shader text no longer depends on any of
          // `variant`'s numbers, so every character material shares a program.
          c.customProgramCacheKey = () => "chr1";
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
  // HERO LAMP (critic r2: "add a warm counter-light near the player"): a small
  // warm point light riding the crawler, so the hero zone always holds a
  // readable value peak even between sconces — the biome's identity comes
  // from its lamps' hue, the player's legibility from this one.
  private heroLamp: THREE.PointLight | null = null;
  private heroLampBase = 1.15;

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
  /**
   * THE RIVAL GHOST (COMPETITIVE.md 4.1). A rival's proof replayed beside you
   * is the cheapest multiplayer this game will ever ship, and it is only
   * multiplayer if you can SEE it. A split delta in the corner is a number; a
   * translucent crawler rounding the corner ahead of you is a race.
   *
   * It is a TRAJECTORY, never a shared world: no collision, no loot, no
   * damage, no lighting contribution. The pose is pushed in from the host each
   * frame (it comes off a precomputed keyframe track, not a second sim).
   */
  private ghostMesh: THREE.Group | null = null;
  private ghostPose: { x: number; y: number; onFloor: boolean } | null = null;
  private ghostSkin = "";

  /** Host hook: where the rival is this frame, or null for no ghost. */
  setGhost(pose: { x: number; y: number; onFloor: boolean } | null): void {
    this.ghostPose = pose;
  }
  // Containers that may spawn knocked on their side (place() tipped variants).
  private static TIPPABLE = new Set([
    "barrel_small", "barrel_large", "keg", "keg_decorated", "pot_large", "box_small", "trunk_small_A",
  ]);

  private breakableMeshes = new Map<number, THREE.Object3D>(); // smashable dressing (phase 5)
  private stagingAnchors = new Map<string, Vec2>(); // purpose -> social anchor (resident facing)
  private npcMeshes = new Map<number, THREE.Group>(); // Roam: settlement residents
  localPlayerId = 0;
  private monsters = new Map<number, THREE.Group>();
  private keyMarkers = new Map<number, THREE.Mesh>(); // floating marker over key carriers
  private telegraphs = new Map<number, THREE.Group>(); // ground telegraphs (dim fill + bright rim) under winding-up monsters
  private laneStrips = new Map<number, THREE.Mesh>(); // LANE telegraphs: charger rush + lasher hook

  private statusRings = new Map<number, THREE.Mesh>(); // faint ring under statused monsters (5.11)
  // STAGE CABLES' pin (V2 N2): a per-monster SHACKLE. Control you cannot see
  // is control you cannot plan around, and this pin deliberately still lets
  // windups resolve -- so the player has to tell "pinned but winding up" from
  // "free and closing" inside 0.2s. Deliberately a hard, bracketed cage:
  // stagger is a grey helpless body with no ground decal, and the two must
  // never read the same ("the pin is control, not a stun").
  private pinCages = new Map<number, THREE.Group>();
  private hazardRings = new Map<number, THREE.Mesh>(); // volatile-corpse blast telegraphs
  // Beam-line hazards get real ordnance anatomy (r5 major): a shader strip
  // (taper + streaming noise), a muzzle-flare sprite at the source, an impact
  // sprite at the far end, and one-shot blossom particles on the firing edge.
  private hazardBeams = new Map<number, THREE.Group>();
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
    // Round 2: edge-glow erode after `delay` seconds (uniform driven 0->1
    // over `dur`), and an optional elite/boss death beat (scale swell timer).
    dissolve?: { u: { value: number }; delay: number; dur: number };
    beat?: number;
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
  private dirBlobMat: THREE.MeshBasicMaterial | null = null; // hero's crisp offset shadow
  // Torch flame glow cores (one per anchor), flickered per frame + fog-gated.
  private flameSprites: { s: THREE.Sprite; seed: number; base: number; tile: number; role: 0 | 1 | 2; baseOp: number }[] = [];
  // Vertical light streaks on the wall face behind each interior sconce —
  // the wall visibly catches its own torch (fog-gated, guttering with it).
  private torchStreaks: { m: THREE.Mesh; tile: number; seed: number; baseOp: number }[] = [];
  private streakGeo: THREE.PlaneGeometry | null = null; // shared, never per-floor
  private streakTex: THREE.CanvasTexture | null = null;
  // Scrolled textures (sewer channel flow) — offsets driven in the torch/flame
  // frame pass; textures are per-build clones, disposed on the next rebuild.
  private envFlow: { tex: THREE.Texture; sx: number; sy: number; wobble?: number; freq?: number }[] = [];
  private strikeMeshes: THREE.Object3D[] = []; // falling airstrike shells (pooled)
  private strikeMarks: THREE.Mesh[] = []; // impact-point anticipation discs (pooled)
  private prevStrikeCount = 0;
  private prevStrikePos: { x: number; y: number }[] = [];

  // ---- Round-2 combat FX system (fxParticles/fxTrails/fx modules) ----
  // GPU particle pool (impacts, sparks, gathers, gibs), shader swing arcs,
  // projectile ribbons, scorch/blood decals, shockwave rings — plus a crit
  // "bloom kick" that momentarily raises the bloom pass for a camera-space
  // impact frame.
  private fxp = new FxParticles();
  // Flash de-stacking (critic r2 blocker): simultaneous hits at one spot must
  // NOT stack N additive flash3s into a clipped white ball — recent flash
  // positions downgrade nearby follow-ups to sparks-only accents.
  private recentFlash: { x: number; z: number; t: number }[] = [];
  private swingArcs = new SwingArcs();
  private ribbons = new TrailRibbons();
  private decals = new GroundDecals();
  private shocks = new Shockwaves();
  // BOSSES V2 §5: the encounter's own stage manager — plates, shield shells,
  // tether cords, punish beacons, per-boss signature beats, and the camera
  // intent the fight is allowed to borrow. Everything it needs from the
  // renderer arrives through this dependency bundle, so the boss layer never
  // reaches into scene-graph internals.
  readonly bossFx = new BossFx({
    fxp: this.fxp,
    shocks: this.shocks,
    decals: this.decals,
    light: (x, z, hex, peak, max, y) => this.spawnFxLight(x, z, hex, peak, max, y),
    trauma: (a) => this.addTrauma(a),
    bloom: (a) => { this.bloomKick = Math.min(1.4, this.bloomKick + a); },
  });
  private dustTint = 0x3a332c; // floor-ambient dust color, set per floor build
  private bloomBase = -1;
  private bloomKick = 0;

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

  // BEAM ANATOMY (audit r5 major: "ten uniform debug-ray capsules"): the boss
  // volley's line hazards render as authored ordnance, not stretched planes —
  // a width taper along flight, a white-hot core handing off to a saturated
  // additive skirt, streaming per-beam noise (seeded, so a radial volley
  // shimmers as ten individuals), a muzzle boost at the origin, and endpoint
  // caps. Arming mode draws rail edges + faint interior (a floor CLAIM);
  // uHot crossfades to the firing read.
  private static readonly BEAM_FRAG = /* glsl */ `
    uniform vec3 uColor;
    uniform float uHot;   // 0 arming telegraph -> 1 firing
    uniform float uFade;  // master alpha envelope
    uniform float uTime;
    uniform float uSeed;
    uniform float uLen;   // world-units length (noise frequency reference)
    varying vec2 vUv;
    float bh(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
    float bn(vec2 q) {
      vec2 f = fract(q);
      f = f * f * (3.0 - 2.0 * f);
      float a = bh(q), b = bh(q + vec2(1.0, 0.0));
      float c = bh(q + vec2(0.0, 1.0)), d = bh(q + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    void main() {
      float w = abs(vUv.y - 0.5) * 2.0;
      // HARD width taper along flight (r6 major: "identical width along their
      // entire length"): fat at the muzzle, thinning to ~28% at the tip.
      float taper = mix(1.0, 0.28, smoothstep(0.02, 1.0, vUv.x));
      float cw = w / max(taper, 1e-3);
      if (cw > 1.0) discard;
      // The white-hot core also narrows along flight — near the tip only the
      // colored skirt survives, so the shot visibly loses energy downrange.
      float coreW = mix(0.38, 0.16, vUv.x);
      float core = smoothstep(coreW, 0.0, cw);
      float skirt = 1.0 - smoothstep(0.05, 1.0, cw);
      float nz = bn(vec2(vUv.x * uLen * 1.3 - uTime * (7.0 + uSeed * 3.0), uSeed * 19.0 + vUv.y * 2.0));
      float stream = 0.55 + 0.6 * nz;
      float muzzle = smoothstep(0.3, 0.0, vUv.x);
      float caps = smoothstep(0.0, 0.035, vUv.x) * (1.0 - smoothstep(0.955, 1.0, vUv.x));
      float rail = smoothstep(0.58, 0.92, cw) * (1.0 - smoothstep(0.92, 1.0, cw));
      float armA = rail * 0.8 + core * 0.15 + skirt * 0.05;
      float fireA = (core * (0.9 + 0.7 * muzzle) + skirt * 0.34) * stream;
      float a = mix(armA, fireA, uHot) * caps * uFade;
      if (a < 0.004) discard;
      // Screen-space dither breaks the stepped alpha banding (r6 major) that
      // smooth gradients pick up under the 8-bit compositing chain.
      a = clamp(a + (bh(gl_FragCoord.xy * 0.71) - 0.5) * 0.045, 0.0, 1.0);
      // Exposure discipline (r6 major: "blown to a uniform pure-white core"):
      // the core stays warm-white only near the muzzle and hands off to the
      // saturated damage palette downrange instead of clipping end-to-end.
      vec3 hot = mix(uColor, vec3(1.0), 0.62);
      vec3 deep = uColor * uColor * 1.5;
      vec3 armC = mix(deep, uColor, 0.5) * 1.25;
      vec3 fireC = hot * (core * (0.85 + 0.75 * muzzle)) + uColor * (skirt * 1.2);
      gl_FragColor = vec4(mix(armC, fireC, uHot), a);
    }`;
  private beamStripGeo: THREE.PlaneGeometry | null = null;
  /** Build one pooled beam-hazard group: shader strip + muzzle/impact sprites. */
  private buildBeamGroup(color: number, seed: number): THREE.Group {
    if (!this.beamStripGeo) this.beamStripGeo = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.Group();
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uHot: { value: 0 }, uFade: { value: 0 },
        uTime: { value: 0 }, uSeed: { value: seed }, uLen: { value: 1 },
      },
      vertexShader: `varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: Renderer3D.BEAM_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const strip = new THREE.Mesh(this.beamStripGeo, mat);
    // Yaw about world Y FIRST (rotation order), then pitch flat onto the
    // ground — the default XYZ order warps the strip into a skewed sail.
    strip.rotation.order = "YXZ";
    strip.rotation.x = -Math.PI / 2;
    strip.renderOrder = 10;
    strip.userData.noAO = true;
    const hotHex = new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.6).getHex();
    const muzzle = this.makeGlow(hotHex, 1.1);
    muzzle.userData.noAO = true;
    const impact = this.makeGlow(color, 0.85);
    impact.userData.noAO = true;
    g.add(strip, muzzle, impact);
    g.userData.strip = strip;
    g.userData.mat = mat;
    g.userData.muzzle = muzzle;
    g.userData.impact = impact;
    g.userData.seed = seed;
    g.userData.wasFired = false;
    return g;
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

  /** RIM-BIASED HIT-FLASH (audit r3): the old full-body emissive add turned
   * whole crowds into flat white marshmallows. Now the struck body's materials
   * are cloned lazily on the first hit (after every other cloning — elite
   * skins, affix tints — has already run) and a shader stage adds a
   * fresnel-weighted additive flash: the SILHOUETTE catches fire while ~60%
   * of the albedo survives in the interior, so the creature stays modeled.
   * Per-damage-type tint rides userData.flashTintHex (set in emitHits),
   * the fade is exponential, and a per-body 1-2 frame stagger keeps a crowd
   * from strobing as one mass. */

  /** Amortizes the lazy material clone: INJUNCTION enrages the WHOLE floor at
   * once, and cloning eighty rigs' materials in one frame is exactly the kind
   * of hitch the perf round spent a week killing. A few per frame lights the
   * room over ~0.3s against a 12s window -- nobody sees the ramp. */
  private flashCloneBudget = 0;

  private applyHitFlash(mesh: THREE.Group, hitFlash: number, dt = 0, rage = 0): void {
    const ud = mesh.userData;
    // RENDERER-SIDE ENVELOPE (audit r4): the sim's 120ms hitFlash window is
    // narrower than a human glance (and narrower than a SwiftShader frame) —
    // an exponential renderer-clocked tail stretches the visible flash to
    // ~250ms without touching sim timing. Also drives the scale-punch.
    const prevHF = (ud.prevHFVal as number) ?? 0;
    ud.prevHFVal = hitFlash;
    let env = (ud.flashEnv as number) ?? 0;
    if (hitFlash > prevHF + 1e-6) env = 1;
    else if (env > 0) { env *= Math.exp(-dt * 8); if (env < 0.02) env = 0; }
    ud.flashEnv = env;


    // Rage alone waits its turn for the clone budget; a real HIT never does.
    if (rage > 0 && hitFlash <= 0 && !ud.flashMats && this.flashCloneBudget <= 0) return;
    if ((hitFlash > 0 || rage > 0) && !ud.flashMats) {
      if (hitFlash <= 0) this.flashCloneBudget--;
      const uFlash = { value: 0 };
      const uTint = { value: new THREE.Color(0xffc9a0) };
      const mats: THREE.MeshStandardMaterial[] = [];
      mesh.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh || !mm.material || mm.userData.noAO) return;
        const swap = (m: THREE.Material): THREE.Material => {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.isMeshStandardMaterial) return m;
          const c = std.clone();
          // Material.clone() drops injected shader stages — chain the rim
          // light (applyRimLight) through, or the first hit would strip a
          // monster's silhouette pop for the rest of its life.
          const prevOBC = Object.prototype.hasOwnProperty.call(std, "onBeforeCompile")
            ? std.onBeforeCompile
            : null;
          const prevKey = Object.prototype.hasOwnProperty.call(std, "customProgramCacheKey")
            ? std.customProgramCacheKey.bind(std)
            : null;
          c.onBeforeCompile = (shader, renderer) => {
            if (prevOBC) prevOBC.call(c, shader, renderer);
            shader.uniforms.uHitFlash = uFlash;
            shader.uniforms.uHitTint = uTint;
            shader.fragmentShader = shader.fragmentShader
              .replace(
                "#include <common>",
                "#include <common>\nuniform float uHitFlash;\nuniform vec3 uHitTint;",
              )
              .replace(
                // Interior: nudge the albedo toward the tint but PRESERVE the
                // texture read — never a solid untextured fill.
                "#include <color_fragment>",
                "#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uHitTint * 0.6, uHitFlash * 0.3);",
              )
              .replace(
                // Silhouette: the flash energy lives in a fresnel rim, so the
                // body reads as a lit CREATURE taking a hit, not a decal.
                // Gains tuned down (r5 blocker): on bright albedos (bone,
                // ivory) the old 0.18 interior add pushed the whole body over
                // the tone-map shoulder — flat white marshmallows again.
                "#include <emissivemap_fragment>",
                "#include <emissivemap_fragment>\n{ vec3 hfV = normalize(vViewPosition);\n" +
                  "  float hfRim = pow(1.0 - clamp(dot(normal, hfV), 0.0, 1.0), 2.0);\n" +
                  "  totalEmissiveRadiance += uHitTint * uHitFlash * (0.09 + 1.05 * hfRim); }",
              );
          };
          c.customProgramCacheKey = () => `${prevKey ? prevKey() : ""}|hitflash`;
          mats.push(c);
          return c;
        };
        mm.material = Array.isArray(mm.material) ? mm.material.map(swap) : swap(mm.material);
      });
      ud.flashMats = mats;
      ud.flashU = uFlash;
      ud.flashTintU = uTint;
    }
    const uF = ud.flashU as { value: number } | undefined;
    if (!uF) return;
    // Per-body stagger (~1-2 frames at 60fps) + exponential fade: hot on the
    // impact frame, easing down the renderer envelope's ~250ms tail.

    const stagger = (mesh.id % 3) * 0.009;
    const simF = Math.max(0, Math.min(1, (hitFlash - stagger) / 0.12));
    const struck = Math.max(simF * simF * (0.3 + 0.7 * simF), env * 0.8);
    // INJUNCTION's enrage (V2 N3): a SUSTAINED crimson on every enraged body
    // for the whole window. §3.2 N3 promised "the enrage has its own tint";
    // what shipped was a reservoir-sampled ember on one monster per ~9 events
    // across the whole floor, which is a particle, not a tell. The crawler who
    // bought twelve violent seconds has to be able to see which twelve.
    const f = Math.max(struck, rage);
    uF.value = f;
    if (ud.flashTintHex !== undefined && f > 0) {
      (ud.flashTintU as { value: THREE.Color }).value.setHex(ud.flashTintHex as number);
      ud.flashTintHex = undefined;
    } else if (rage > struck) {
      // Rage owns the tint whenever it is the louder of the two, so a body
      // that took a hit ten seconds ago does not stay warm-white through it.
      (ud.flashTintU as { value: THREE.Color }).value.setHex(FX_PAL.stay.mid);
    }
  }

  // Melee weapon trail (round 2): a shader-driven swing arc with an animated
  // sweep — hot leading edge, decaying wake — alternating direction per combo
  // swing so back-and-forth slashes read as different strokes.
  private meleePrevSwing = new Map<number, number>();
  private meleeMirror = new Map<number, boolean>();
  private spawnMeleeTrail(anchor: THREE.Object3D, ownerId = 0, hex = 0xffb057, scale = 0.86): void {
    const mirror = !(this.meleeMirror.get(ownerId) ?? false);
    this.meleeMirror.set(ownerId, mirror);
    this.swingArcs.spawn(anchor.position.x, anchor.position.z, anchor.rotation.y, hex, scale, mirror);
    // A few sympathetic sparks along the blade path sell the metal.
    const fx = anchor.position.x + Math.sin(anchor.rotation.y) * 0.7;
    const fz = anchor.position.z + Math.cos(anchor.rotation.y) * 0.7;
    this.fxp.sparks(fx, 0.75, fz, hex, 3);
    // Smear support (audit r5): a couple of embers drift off the arc's wake
    // so the swing leaves decay frames behind the crescent, not a clean cut.
    this.fxp.embers(fx, fz, hex, 2, 0.45);
  }

  /** CAST ANTICIPATION (round 2): a ~140ms converge-then-flash on the caster —
   * motes gather into the hands, then a delayed hand-flash pops right as the
   * ability's own FX fire. Pure staging over the cast edge; no timing change. */
  private castGather(anchor: THREE.Object3D, hex: number): void {
    this.fxp.gatherBurst(anchor.position.x, 1.0, anchor.position.z, hex);
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
    // powerPreference: on a laptop with switchable graphics this is what asks
    // for the discrete part instead of whatever the browser defaults to; on a
    // single-GPU box it is free. (It must be passed at context creation — it
    // cannot be set afterwards.)
    // `antialias` here applies to the DEFAULT framebuffer only. The dungeon
    // never draws into it directly (every frame goes through the composer, and
    // SMAA is what antialiases the world now), so it looks like free savings —
    // but the campfire character-select scene DOES render straight to screen
    // (charSelect.ts), and this flag is the only AA it has. Measured as its own
    // two-build A/B at native resolution, 3 alternating reps each: 8.8 ms with
    // it off vs 10.0 ms with it on — a -12% median whose sample ranges overlap
    // almost completely (the "on" build's best rep tied the "off" build's).
    // That is not a win worth a permanently aliased menu, so it stays on.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });

    // QUALITY. Resolved before anything sized or allocated below reads it: the
    // composer target's sample count, the AO/bloom buffer scales, the shadow
    // map edge and the light-pool sizes are all decided here, once.
    this.qualityChoice = urlQualityOverride() ?? loadQualityChoice();
    this.quality = QUALITY_PRESETS[
      this.qualityChoice === "auto"
        ? guessQuality(this.renderer.getContext(), {
          // Safari does not expose WEBGL_debug_renderer_info, so on an iPhone
          // the renderer string is empty and the mobile branch never fires.
          // These two facts are not gated by anything.
          coarse: window.matchMedia?.("(pointer: coarse)").matches ?? false,
          shortEdge: Math.min(screen?.width ?? innerWidth, screen?.height ?? innerHeight),
        })
        : this.qualityChoice
    ];
    this.tuner = new QualityAutoTuner(this.quality.name);

    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The key light's shadow map is rebuilt inside EVERY WebGLRenderer.render()
    // that sees the scene, so anything that renders the world twice pays for it
    // twice. Drive it manually — exactly one rebuild per composed frame, from
    // render() below.
    this.renderer.shadowMap.autoUpdate = false;
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
    this.key.shadow.mapSize.set(this.quality.shadowMapSize || 2048, this.quality.shadowMapSize || 2048);
    if (this.quality.shadowMapSize === 0) this.renderer.shadowMap.enabled = false;
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
    // Round-2 combat FX layers ride the scene root (world-space effects).
    this.scene.add(this.fxp.group, this.swingArcs.group, this.ribbons.group, this.decals.group, this.shocks.group);
    this.scene.add(this.bossFx.group);
    this.ribbons.setCamDir(THEME.camDir.x, THEME.camDir.y, THEME.camDir.z);

    // Post chain. HalfFloat keeps the pipeline HDR until OutputPass tone-maps.
    // A DepthTexture rides along so the RenderPass's depth SURVIVES the frame
    // and GTAO can consume it instead of re-rendering the world (see
    // WorldGTAOPass.useSharedDepth).
    //
    // THE MSAA CLIFF (quality.ts finding 1). This target used to be `samples: 4`.
    // A 4x multisampled RGBA16F surface at 2880x1704 is ~157 MB of traffic per
    // frame on a GPU with no dedicated VRAM, and EVERY pass that reads the
    // target forces a resolve blit on top. Measured on the shipped build at
    // native resolution: 60 ms/frame with samples=4 vs 9 ms with samples=0 —
    // 85% of the entire frame, dwarfing every other cost combined. Geometry AA
    // is now SMAA at the end of the chain, which measured under the noise floor
    // on the same device. samples comes from the preset purely so a future
    // discrete-GPU path could opt back in; every shipped preset sets it to 0.
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      samples: this.renderer.capabilities.isWebGL2 ? this.quality.msaaSamples : 0,
      depthTexture: new THREE.DepthTexture(2, 2, THREE.UnsignedIntType),
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new WorldGTAOPass(this.scene, this.camera, 2, 2);
    if (this.renderer.capabilities.isWebGL2 && rt.depthTexture) this.gtao.useSharedDepth(rt.depthTexture);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.85;
    this.gtao.setResolutionScales(this.quality.gtaoScale, this.quality.gtaoDenoiseScale);
    this.gtao.updateGtaoMaterial({
      radius: 0.55, distanceExponent: 1, thickness: 1, scale: 1.3,
      samples: this.quality.gtaoSamples, distanceFallOff: 1, screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({
      lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4,
      radiusExponent: 1, rings: 2, samples: this.quality.gtaoDenoiseSamples,
    });
    this.gtao.enabled = this.quality.gtao;
    this.composer.addPass(this.gtao);
    // Thresholded above the tone-map knee: only emissives, torch cores, and
    // additive FX bloom — the frame itself stays crisp. Wide soft kernel so
    // flames BLEED into the dark instead of halting at a tight halo.
    // Threshold above the tone-map knee so only true emitters bloom, and a
    // modest strength — flame cores are TINTED sprites now, so the pass
    // spreads colored light instead of flattening cores to white discs.
    // Threshold LIFTED to 0.92 (critic r2 blocker): the combat-FX layers are
    // budgeted to peak ~0.9, so their hue passes through untouched — only the
    // rare true-hot pixel (flame cores, the tiny impact core) blooms.
    this.bloom = new ScaledBloomPass(new THREE.Vector2(2, 2), 0.5, 0.7, 0.92);
    this.bloom.setScale(this.quality.bloomScale);
    this.bloom.enabled = this.quality.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
    // SMAA replaces the render target's MSAA — LAST, so it works on the final
    // display-referred image (see the field declaration). EffectComposer.setSize
    // forwards to every pass, so resize() needs no special case for it.
    this.smaa = new SMAAPass(2, 2);
    this.smaa.enabled = this.quality.smaa;
    this.composer.addPass(this.smaa);
  }

  async init(
    onProgress?: (loaded: number, total: number) => void,
    opts: { full?: boolean } = {},
  ): Promise<void> {
    // Streaming load: by default init resolves after the PRIORITY wave (hero +
    // core dungeon shell — a few files), so boot is near-instant, and the
    // remaining ~200 GLBs stream behind the running game (each arrival
    // schedules a debounced refresh that swaps stand-ins for the real thing).
    // `full` gates on the ENTIRE manifest instead — the perf round's loading
    // screen front-loads everything so the running game never mid-streams.
    const store = startModelLoad(onProgress);
    this.models = store.models; // LIVE record — fills in as assets land
    store.onArrive = (key) => {
      this.preuploadTextures(key);
      this.scheduleAssetRefresh();
    };
    await (opts.full ? store.complete : store.ready);
    this.scheduleAssetRefresh();
  }

  /**
   * PUSH A STREAMED MODEL'S TEXTURES TO THE GPU AT ARRIVAL, NOT AT FIRST DRAW.
   *
   * three.js uploads a texture lazily, on the first draw that binds it — so a
   * 1024^2 atlas becomes a synchronous texSubImage2D + mipmap generation on the
   * exact frame a monster first walks into view, which is to say mid-fight.
   * With the shader compiles fixed this is what is left: tools/hitchprobe.mjs
   * on the post-fix build measured 24 texSubImage2D stalls totalling 761 ms
   * after the loading screen, none of them attributable to program building.
   *
   * initTexture() does the same upload on demand. Arrival time is a strictly
   * better moment for it: with the front-loaded boot (`full`) every arrival is
   * behind the opaque loading screen, and even when assets stream behind a
   * running game the cost is spread across arrivals instead of clustering on
   * the frame a whole pack becomes visible at once.
   *
   * BUT IT IS BUDGETED, BECAUSE THE UNBOUNDED VERSION WAS WORSE THAN THE BUG.
   *
   * The first cut of this ran on EVERY texture of EVERY arriving model,
   * including the ~200 GLBs in the manifest that a given floor never draws.
   * Measured on the reference machine (direct read of
   * renderer.info.memory.textures, same URL on both builds): 64 resident GL
   * textures before, 320 after — an estimated 85 MB of uploads becoming
   * ~1.3 GB, i.e. the entire manifest, on an integrated GPU with no dedicated
   * VRAM that shares system memory. That buys back 761 ms of lazy-upload stalls
   * and pays for it with driver eviction and paging of a 1.3 GB working set,
   * which is the SAME multi-second-stall mechanism this work exists to remove,
   * plus a context-loss risk on a lower-memory machine.
   *
   * So: spend a fixed budget, cheapest-first is not worth the sort — arrival
   * order is priority order, because the loader's priority wave (hero + core
   * dungeon shell) arrives first and is exactly what the first floor draws.
   * Past the cap, everything falls back to three.js's lazy upload, i.e. the
   * behaviour before any of this existed.
   */
  private static readonly PREUPLOAD_BUDGET_BYTES = 160 * 1024 * 1024;
  private preuploadSpent = 0;

  /** Bytes a texture will occupy once uploaded: RGBA8 plus the ~1/3 the full
   *  mip chain adds. Returns 0 for a texture with no decoded image yet. */
  private static textureBytes(t: THREE.Texture): number {
    const img = t.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    if (!(w > 0 && h > 0)) return 0;
    return Math.ceil(w * h * 4 * (t.generateMipmaps === false ? 1 : 4 / 3));
  }

  private preuploadTextures(key: string): void {
    if (this.preuploadSpent >= Renderer3D.PREUPLOAD_BUDGET_BYTES) return;
    const m = this.models[key];
    if (!m) return;
    const SLOTS = ["map", "normalMap", "emissiveMap", "roughnessMap",
      "metalnessMap", "aoMap", "alphaMap"] as const;
    const seen = new Set<THREE.Texture>();
    m.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (this.preuploadSpent >= Renderer3D.PREUPLOAD_BUDGET_BYTES) return;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const rec = mat as unknown as Record<string, THREE.Texture | null | undefined>;
        for (const slot of SLOTS) {
          const t = rec[slot];
          if (!t || seen.has(t)) continue;
          seen.add(t);
          const bytes = Renderer3D.textureBytes(t);
          if (this.preuploadSpent + bytes > Renderer3D.PREUPLOAD_BUDGET_BYTES) {
            this.preuploadSpent = Renderer3D.PREUPLOAD_BUDGET_BYTES; // latch off
            return;
          }
          // Never let a bad texture take the whole asset pipeline down: a
          // failed upload just means three retries it on first draw, i.e. the
          // behaviour we had before.
          try {
            this.renderer.initTexture(t);
            this.preuploadSpent += bytes;
          } catch { /* falls back to lazy upload */ }
        }
      }
    });
  }

  // TRIED AND REJECTED: uploading every texture `this.scene` references at the
  // end of prewarm, on the theory that the built floor IS the working set. It
  // is not — the scene holds cached and fog-hidden meshes that are never drawn,
  // so the traverse found 98 manifest textures where drawing only ever touches
  // ~34. Measured cost: resident manifest uploads 64 -> 98, 341 MB -> 515 MB on
  // a GPU with no dedicated memory. Measured benefit: the first-frame lazy
  // uploads fell 18 -> 9 in one run of two and the frame itself stayed at
  // ~120 ms either way (tools/_hitch.mjs). Paying 174 MB for no measurable
  // change in the thing it was supposed to fix is not a trade; the ~120 ms
  // handover frame is not texture uploads. See the residual-hitch note in
  // prewarm().

  /**
   * A background asset landed: drop cached meshes built from stand-ins and
   * force a floor rebuild, all debounced so a burst of arrivals costs one
   * refresh. Mirrors the mid-fight morph path — markers/telegraphs keyed by
   * entity id survive; only the body meshes rebuild on the next update.
   */
  private assetRefresh: ReturnType<typeof setTimeout> | null = null;
  private scheduleAssetRefresh(): void {
    if (this.assetRefresh !== null) clearTimeout(this.assetRefresh);
    this.assetRefresh = setTimeout(() => this.runAssetRefresh(), 350);
  }

  private runAssetRefresh(): void {
    this.assetRefresh = null;
    this.builtFloor = -1; // next update() rebuilds the floor with real tiles
    for (const mesh of this.playerMeshes.values()) this.scene.remove(mesh);
    this.playerMeshes.clear();
    for (const mesh of this.decoyMeshes.values()) this.scene.remove(mesh);
    this.decoyMeshes.clear();
    if (this.ghostMesh) { this.scene.remove(this.ghostMesh); this.ghostMesh = null; }
    for (const mesh of this.breakableMeshes.values()) this.scene.remove(mesh);
    this.breakableMeshes.clear();
    for (const mesh of this.monsters.values()) this.scene.remove(mesh);
    this.monsters.clear();
  }

  /**
   * RUN A PENDING REFRESH *NOW*, INSTEAD OF 350 ms FROM NOW.
   *
   * The debounce is right for assets streaming behind a live game and wrong for
   * boot. main3d awaits init({ full: true }), so by the time prewarm starts the
   * whole manifest has landed — but the last arrival left a 350 ms timer armed,
   * which then fired somewhere in the middle of prewarm, AFTER prewarm's own
   * update() had already built the floor out of those very models. It set
   * builtFloor = -1 for nothing, and the redundant rebuild was cashed in on the
   * first gameplay frame: measured as a single 88-105 ms frame in the first
   * idle window of every vsync-paced run, landing within a second of the
   * loading screen lifting. Flushing it before prewarm builds anything moves
   * that work behind the overlay where it belongs.
   */
  private flushAssetRefresh(): void {
    if (this.assetRefresh === null) return;
    clearTimeout(this.assetRefresh);
    this.runAssetRefresh();
  }

  /**
   * SHADER + POOL PREWARM (perf round): runs while the boot loading screen is
   * still opaque. Bakes every band's PMREM environment, builds the boot floor
   * and its entity meshes, pre-allocates the pooled FX lights, spawns one of
   * every particle/telegraph/trail/beam/ring material variant far off-world,
   * then compiles every program (renderer.compile + one full composer pass)
   * so the first real combat frame never stalls on a shader build. All
   * warmup FX are expired and removed before the screen lifts — zero visual
   * change once play begins.
   */
  /**
   * WALK EVERY QUALITY RUNG ONCE, HERE, BEHIND THE LOADING SCREEN.
   *
   * GTAO's sample counts are shader DEFINES, and each preset asks for a
   * different pair (ultra 12/8, high 9/6, balanced 6/4, performance: off), so
   * the first visit to a rung compiles two fullscreen programs. That is a hitch
   * delivered by the AUTO-TUNER — which steps down precisely when the machine
   * is already missing frames, making the stutter land at the worst possible
   * moment and look like the downgrade itself made things worse. Measured with
   * tools/_presetcheck.mjs: 128 programs after boot, 132 after cycling the
   * ladder, and stable forever after. So pay the four here.
   *
   * applyQuality is a pure reconfigure (resize + pass settings; the light pools
   * are deliberately sized once elsewhere), so cycling and restoring is safe.
   * The host listener is muted for the walk: the settings row must not see four
   * spurious preset changes during boot.
   */
  private prewarmQualityLadder(): void {
    if (this.lastW <= 2) return; // no real canvas size yet — nothing to size to
    const active = this.quality;
    const listener = this.onQualityChange;
    this.onQualityChange = null;
    try {
      for (const name of QUALITY_ORDER) {
        if (name === active.name) continue;
        this.applyQuality(QUALITY_PRESETS[name]);
        this.render();
      }
    } finally {
      this.applyQuality(active);
      this.onQualityChange = listener;
    }
    this.render();
  }

  /**
   * THE CHARACTER-MATERIAL ZOO — one mesh per surviving program permutation.
   *
   * Once the archetype colors moved into uniforms (applyCharacterShading), the
   * character programs stopped forking on CONTENT and fork only on SHAPE. The
   * shape axes are enumerable, so enumerate them instead of hoping the boot
   * scene happens to contain one of each:
   *
   *   map / no map        — USE_MAP. Textured KayKit mobs vs untextured ones.
   *   skinned / static    — USE_SKINNING. Rigged mobs vs procedural stand-ins.
   *   plain / hitflash / dissolve / hitflash+dissolve
   *                       — the injected-shader chain. A mob that is hit gets
   *                         flash materials; one that dies gets dissolve ones;
   *                         one that is hit AND dies gets both. None of the
   *                         three exists at boot, so all three used to compile
   *                         mid-fight — measured as 12 of the 28 remaining
   *                         runtime builds.
   *   front / double side — SIDE forks the DEPTH material (flipSided vs
   *                         doubleSided). Nothing in src/ builds a double-sided
   *                         shadow caster, but the KayKit GLBs do (foliage,
   *                         cloth, banners) and buildEntityMesh sets castShadow
   *                         on every mesh it finds, so they arrive with the
   *                         models.
   *   opaque / alphaTest  — ALPHA_TEST forks the depth material too; same
   *                         source, alpha-masked GLB materials.
   *
   * THE LAST TWO AXES ARE NOT SPECULATIVE. Without them the build's own
   * [shader-guard] fired during ordinary roaming and fighting on floor 5:
   * programs 131 -> 136, five synchronous mid-play depth builds, cache-key
   * boolean masks 144384 / 144384 / 142368 / 142336 / 144416. Decoded against
   * three's WebGLPrograms.getProgramCacheKeyBooleans: 144384 is
   * shadowMapEnabled + flipSided + useDepthPacking + opaque; 142368 and 142336
   * swap flipSided for doubleSided; +32 adds skinning. A separate floor-17 run
   * caught mask 1025 — an alpha-tested shadow caster.
   *
   * COST OF ADDING THEM: the extra rungs are only combined with the `plain`
   * chain, because the flash/dissolve injections fork the LIT program (via
   * customProgramCacheKey) and not the depth one, so pairing them with side and
   * alphaTest would multiply meshes without producing new cache keys.
   *
   * The meshes are real (three compiles what it can see), scaled to a few
   * thousandths of a unit and parked on the camera's focus point: small enough
   * to be invisible, but inside both the view frustum and the shadow camera, so
   * the DEPTH-material permutations get built by the same prewarm render pass.
   * The caller removes them before the loading screen lifts.
   */
  private buildCharacterZoo(): THREE.Object3D[] {
    // Focus point of the iso camera, inverted from the placement in update().
    const d = THEME.camDir;
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const fx = this.camera.position.x - (d.x / len) * THEME.camDist;
    const fz = this.camera.position.z - (d.z / len) * THEME.camDist;

    // 1x1 white pixel: only the PRESENCE of a map forks the program, never its
    // contents, so this stands in for every character texture in the game.
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    // A one-bone rig is enough to set USE_SKINNING; every rigged mob in the
    // game lands on the same program regardless of its real bone count.
    const skinGeo = geo.clone();
    const vn = skinGeo.attributes.position.count;
    const wt = new Float32Array(vn * 4);
    for (let i = 0; i < vn; i++) wt[i * 4] = 1;
    skinGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(vn * 4), 4));
    skinGeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wt, 4));

    const out: THREE.Object3D[] = [];
    // (side, alphaTest) rungs. FrontSide/0 is the common case and carries the
    // full injected-shader chain; the others exist only to reach their DEPTH
    // permutations, so they ride `plain`.
    const SHAPES: Array<{ side: THREE.Side; alphaTest: number; chains: string[] }> = [
      { side: THREE.FrontSide, alphaTest: 0, chains: ["plain", "flash", "dissolve", "flash+dissolve"] },
      { side: THREE.DoubleSide, alphaTest: 0, chains: ["plain"] },
      { side: THREE.FrontSide, alphaTest: 0.5, chains: ["plain"] },
      { side: THREE.DoubleSide, alphaTest: 0.5, chains: ["plain"] },
    ];
    for (const mapped of [false, true]) {
      for (const skinned of [false, true]) {
        for (const shape of SHAPES) {
          for (const chain of shape.chains) {
            const mat = new THREE.MeshStandardMaterial({
              map: mapped ? tex : null,
              side: shape.side,
              // alphaTest > 0 is what sets USE_ALPHATEST; the value is not in
              // the cache key, only whether it is non-zero.
              alphaTest: shape.alphaTest,
            });
            mat.name = `zoo_${mapped ? "map" : "flat"}`;
            let mesh: THREE.Mesh;
            if (skinned) {
              const bone = new THREE.Bone();
              const sm = new THREE.SkinnedMesh(skinGeo, mat);
              sm.add(bone);
              sm.bind(new THREE.Skeleton([bone]));
              mesh = sm;
            } else {
              mesh = new THREE.Mesh(geo, mat);
            }
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            const g = new THREE.Group();
            g.add(mesh);
            // Same call the real mobs take, so the same rimCache/uniform path
            // and therefore the same program.
            this.applyCharacterShading(g, { rim: 0x9fd0ff, strength: 0.8, desat: 0.15, tint: 0xc9a24b });
            if (chain.includes("flash")) this.applyHitFlash(g, 1, 0);
            if (chain.includes("dissolve")) makeDissolving(g, 0xffb457);
            // Sub-pixel, at the focus point: seen by the frustum and the shadow
            // camera (which is what builds the depth programs), seen by nobody.
            g.scale.setScalar(0.003);
            g.position.set(fx, 0.5, fz);
            this.scene.add(g);
            out.push(g);
          }
        }
      }
    }
    // The geometries and the 1x1 stand-in texture are only needed while the zoo
    // is resident; the caller releases them (see prewarm). The MATERIALS are
    // deliberately never disposed — three.js refcounts programs and destroys
    // them on the last material release, so disposing them would throw away
    // exactly what this routine just spent the loading screen building.
    this.zooScrap = [tex, geo, skinGeo];
    return out;
  }

  /** Disposable, non-program-bearing leftovers of buildCharacterZoo(). */
  private zooScrap: Array<THREE.Texture | THREE.BufferGeometry> = [];

  // ---- POST-BOOT SHADER-BUILD GUARD (dev only) --------------------------
  //
  // Every program built after the loading screen lifts is a multi-hundred-
  // millisecond freeze in a live frame, and the regression is SILENT: add one
  // monster whose material forks the cache key and the hitches quietly come
  // back. So arm a tripwire. `renderer.info.programs` IS three.js's live
  // program cache array, so the check is a length compare per frame — free —
  // and only on growth does it pay for a diff. Off in production: it exists to
  // fail a dev/probe run loudly, not to spend a player's frame budget.
  private progGuard: { known: Set<string>; count: number } | null = null;

  private checkProgramGuard(): void {
    const g = this.progGuard;
    if (!g) return;
    const list = this.renderer.info.programs;
    if (!list || list.length === g.count) return;
    g.count = list.length;
    for (const p of list) {
      const k = `${p.name}::${p.cacheKey}`;
      if (g.known.has(k)) continue;
      g.known.add(k);
      console.warn(
        `[shader-guard] program built AFTER boot (this is a frame hitch): ${p.name}\n` +
        `  cacheKey: ${p.cacheKey}\n` +
        `  Prewarm must cover this permutation — see Renderer3D.prewarm().`,
      );
    }
  }

  /** Arm the guard with everything prewarm produced. Called at the end of
   *  prewarm; enabled by `?debug` (the capture harnesses all pass it) or a dev
   *  build, so a normal player never pays for it. */
  private armProgramGuard(): void {
    let on = false;
    try {
      on = import.meta.env?.DEV === true || new URLSearchParams(location.search).has("debug");
    } catch { /* no location (worker/test) — leave it off */ }
    if (!on) return;
    const list = this.renderer.info.programs ?? [];
    this.progGuard = {
      known: new Set(list.map((p) => `${p.name}::${p.cacheKey}`)),
      count: list.length,
    };
    console.info(`[shader-guard] armed: ${list.length} programs prewarmed; any further build will be logged.`);
  }

  /**
   * Compile every material in the scene FOR THE BUFFER THE GAME ACTUALLY DRAWS
   * INTO, in parallel. Two separate bugs lived in the plain
   * `renderer.compile(scene, camera)` this replaces.
   *
   * WRONG PERMUTATION. getParameters() reads the CURRENTLY BOUND render target
   * to decide tone mapping and output color space (three.module.js:20634 /
   * :20692 / :20725) and both are in the program cache key. With nothing bound,
   * compile() built the direct-to-canvas variant (`TONE_MAPPING`, sRGB) — but
   * every gameplay frame goes through the composer into a render target, which
   * needs the NoToneMapping/linear variant. So prewarm was warming a set of
   * programs the game never binds, and the game then built its own set later,
   * one blocking compile per frame. Binding a composer target first is the fix.
   *
   * SERIAL COMPILE. On ANGLE/D3D11 linkProgram is asynchronous, but three.js
   * defers the expensive half of program creation to onFirstUse() and reaches
   * it from getUniforms() on the first DRAW — so link-then-immediately-draw
   * makes the main thread eat every GLSL->HLSL->D3D compile serially.
   * compileAsync() instead polls KHR_parallel_shader_compile's
   * COMPLETION_STATUS_KHR and resolves only when every program is genuinely
   * ready, which is what lets the driver's worker threads do the work.
   * tools/parallelbench.mjs measured both on this box with the app's own
   * shaders: 7005 ms of main-thread blocking serial vs 0.1 ms parallel.
   */
  private async compileForComposer(): Promise<void> {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.renderTarget1);
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(prev);
    }
  }

  async prewarm(state: GameState, onStep?: (done: number, total: number) => void): Promise<void> {
    const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
    const TOTAL = 3;
    // Cash in the arrival debounce here, not on the player's first frame.
    this.flushAssetRefresh();
    // 1) Every band's environment sky (PMREM's own blur programs compile here).
    for (let band = 0; band < 6; band++) {
      const theme = themeForFloor(band * 3 + 1);
      this.bakeEnv(band, theme.mood ?? DEFAULT_MOOD);
    }
    onStep?.(1, TOTAL);
    await breathe();

    // 2) The boot floor + entities, then one of each FX variant off-world
    //    (position is irrelevant: compile() ignores the frustum, and the
    //    opaque loading overlay hides the single warm render below).
    this.update(state, 0.001);
    this.update(state, 0.017); // second tick: hero lamp, animators, smoothing state
    const WX = -40;
    const WZ = -40;
    this.fxp.burst(WX, WZ, 0xffb057, 4);
    this.fxp.sparks(WX, 0.5, WZ, 0xffe066, 4);
    this.fxp.flash3(WX, 0.5, WZ, FX_PAL.airstrike, 0.5);
    this.fxp.smoke(WX, 0.5, WZ, 2);
    this.fxp.dust(WX, 0.4, WZ, 2);
    this.fxp.embers(WX, WZ, 0xff8a3c, 2, 0.5);
    this.fxp.radialStreaks(WX, 0.5, WZ, 0xffe066, 3, 1);
    this.fxp.vortex(WX, WZ, 0x8bd450, 1);
    this.fxp.gatherBurst(WX, 0.5, WZ, 0xb98bff);
    this.fxp.gather(WX, 0.5, WZ, 0xb98bff, 0.5);
    this.fxp.gibs(WX, WZ, 0x8b1a1a, 2);
    this.fxp.column(WX, WZ, 0xffb057, 2, 1);
    this.swingArcs.spawn(WX, WZ, 0, 0xffb057, 0.6, false);
    this.ribbons.claim(-999999, 0xffb057, 0.1);
    this.ribbons.push(-999999, WX, 0.5, WZ);
    this.ribbons.push(-999999, WX + 0.4, 0.6, WZ);
    this.ribbons.release(-999999);
    this.decals.spawn(WX, WZ, 0.6, 0x120a18, 0xffb057, 1);
    this.shocks.spawn(WX, WZ, 0xffb057, 1, 0.3);
    this.burst(WX, WZ, 0xc9a24b, 3, 0.5, 0.5);
    this.spawnGlow(WX, 0.5, WZ, 0xf5e6bf, 0.5, 0.3);
    this.spawnFxLight(WX, WZ, 0xc9a24b, 1, 0.2, 0.9); // allocates the pooled FX lights
    this.emitLevelUp(WX, WZ);
    this.spawnFadeProp("smokebomb", WX, 0.2, WZ, 0.5, 0.3);
    // One-off shader materials that otherwise compile mid-combat: ground
    // telegraphs, hazard pools, lane strips, channel beams, ability rings.
    const warm: THREE.Object3D[] = [];
    const addWarm = (o: THREE.Object3D, x: number, z: number): void => {
      o.position.set(x, 0.06, z);
      this.scene.add(o);
      warm.push(o);
    };
    addWarm(new THREE.Mesh(TELEGRAPH_GEO, makeTelegraphMat()), WX, WZ);
    addWarm(new THREE.Mesh(TELEGRAPH_GEO, makePoolMat(0x8bd450)), WX + 2, WZ);
    {
      const lane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeLaneMat());
      lane.rotation.x = -Math.PI / 2;
      addWarm(lane, WX + 4, WZ);
    }
    addWarm(this.buildBeamGroup(0xff5a2e, 1), WX, WZ + 2);
    addWarm(this.buildOrbitBlade(), WX + 2, WZ + 2);
    {
      // The dissolve (death burn-away) shader variant.
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), flat(0x888888));
      makeDissolving(d, 0xffb457);
      addWarm(d, WX + 4, WZ + 2);
    }
    // The V2 ability rigs. These are built lazily on first cast, so without
    // a warm entry here the FIRST Brace / Injunction / pin / cable in a run
    // pays a synchronous program build - exactly the mid-fight hitch this
    // routine exists to prevent, and the shader-guard caught it doing so on
    // floor 6. Two of them fork genuinely new programs rather than reusing a
    // warmed one:
    //   buildBraceShell's `seams` is the ONLY LineSegments in the renderer,
    //     so nothing else can build the LINE variant of the basic program.
    //   buildCableRig's `steel` is a lit MeshStandardMaterial WITHOUT
    //     flatShading (and with emissive), unlike flat() at the top of this
    //     file which sets flatShading: true - FLAT_SHADED is in the program
    //     cache key, so neither the zoo nor the world props cover it. Its
    //     stakes also castShadow, but that depth permutation is
    //     plain/opaque/front-sided and the zoo already builds it.
    // The other two are additive double-sided basic meshes the telegraphs
    // already cover; they are warmed anyway so a later edit to them cannot
    // silently reintroduce the hitch.
    addWarm(this.buildBraceShell(), WX + 6, WZ + 2);
    addWarm(this.buildStayRig(), WX + 8, WZ + 2);
    addWarm(this.buildPinCage(), WX + 10, WZ + 2);
    addWarm(this.buildCableRig(), WX + 12, WZ + 2);
    // buildFxRing adds itself to the scene — track both variants for removal.
    const novaWarm = this.buildFxRing("nova");
    novaWarm.position.set(WX + 6, 0.06, WZ);
    warm.push(novaWarm);
    const cataWarm = this.buildFxRing("cataclysm");
    cataWarm.position.set(WX + 8, 0.06, WZ);
    warm.push(cataWarm);
    onStep?.(2, TOTAL);
    await breathe();

    // 3) Compile everything, run one full post pass (GTAO/bloom/output/grade
    //    programs + shadow-pass depth materials), then expire the warmup FX.
    //
    // THE ZOO STAYS RESIDENT ACROSS BOTH COMPILES BELOW. That is the point of
    // it: a forward renderer bakes the scene's light count into every lit
    // program, this scene has exactly two counts (see updateFxLights), and the
    // warmup props are torn down between them. Anything removed before the
    // second compile is only ever warmed for the combat count and will rebuild
    // — mid-fight — the first time it is drawn on an idle frame.
    // COMPILE THE SAME SCENE TWICE, ONCE PER LIGHT COUNT, AND TEAR NOTHING
    // DOWN IN BETWEEN. A forward renderer bakes the scene's light count into
    // every lit program, and this scene has exactly two counts: the FX impact
    // pool wakes and sleeps AS A GROUP (see updateFxLights), so the world is
    // either at 14 point lights (combat) or 10 (idle). Anything that is in the
    // scene for only ONE of the two compiles gets warmed for only one count and
    // rebuilds itself — mid-fight — the first time it is drawn at the other.
    // That is why the warmup FX, the streamed prop and the zoo all stay
    // resident until after the second pass: the earlier ordering expired them
    // between the compiles and left 21 programs (measured, tools/progkeys.mjs)
    // whose keys differed from a prewarmed one in exactly one field —
    // numPointLights 10 vs 14.
    const zoo = this.buildCharacterZoo();
    await this.compileForComposer();
    this.render(); // NOT composer.render — render() arms the manual shadow pass

    // Put the FX light pool to sleep, then do it all again at the idle count.
    // TWICE, AND THAT IS LOAD-BEARING: updateFxLights only hides the pool once
    // it OBSERVES that no slot is still live, and a slot expires during the
    // very call that advances it past its lifetime — so the first call leaves
    // the group visible and only the second flips it off.
    this.updateFxLights(31);
    this.updateFxLights(0.016);
    await this.compileForComposer();
    this.render(); // depth/shadow permutations at the idle light count too

    // Only now: expire the warmup FX and drop the props. Materials are
    // deliberately NOT disposed — disposing would release the very programs
    // this just warmed (three.js refcounts them and destroys on the last
    // release). The pooled systems (particles, lights) live for the run.
    for (const o of warm) this.scene.remove(o);
    for (const o of zoo) this.scene.remove(o);
    // Geometry + the 1x1 stand-in texture hold no programs, so releasing them
    // is free and keeps a routine whose whole subject is memory discipline from
    // leaking its own scratch.
    for (const s of this.zooScrap) s.dispose();
    this.zooScrap = [];
    this.updateParticles(30);
    this.swingArcs.update(30);
    this.decals.update(30);
    this.shocks.update(30);
    this.ribbons.update(30);
    this.prewarmQualityLadder();
    this.armProgramGuard();
    onStep?.(3, TOTAL);
    await breathe();
    // Everything above composed frames behind the loading screen. Only NOW may
    // the auto-tuner start forming an opinion — see beginTuning() and the
    // warm-up gate in render(). A host that calls beginTuning() itself (the
    // right thing: it knows when the overlay actually lifts) just restarts the
    // window from a slightly later, slightly more honest moment.
    this.beginTuning();
    // RESIDUAL HITCHES, MEASURED AND NOT FIXED HERE (tools/_hitch.mjs,
    // vsync-paced so these are real frames a player would feel, not rAF
    // run-ahead). In the first 25 s of play, threshold 40 ms, every run:
    //   ~130 ms in : ONE 120-125 ms frame — the handover itself. dPrograms 0,
    //                and force-uploading every texture the scene references did
    //                not move it (see the rejected experiment above), so it is
    //                the browser's first composite of the full HUD plus the
    //                overlay teardown, not our GPU work.
    //   ~220 ms in : one 65-80 ms frame, no counter deltas, heap +4 MB — GC.
    //   ~3.1 s in  : one ~105 ms frame; heap DROPPED 24 MB in one run — a major
    //                GC of the boot garbage.
    //   nothing over 40 ms after ~3.9 s.
    // Programs never move (delta 0 across all of it), so none of this is shader
    // compilation. Killing the GC pauses means an allocation audit of boot, not
    // a renderer setting, and it is bounded at ~105 ms in the first four
    // seconds — versus the 4981 ms worst frame this work started from.
    // NOT DONE HERE: renderer.debug.checkShaderErrors = false. It looks like
    // the obvious fix for the multi-second stalls (it drops the synchronous
    // getProgramParameter(LINK_STATUS) read that forces the driver to finish
    // linking on the main thread), but tools/progtrace.mjs already established
    // the stalls are not gl.linkProgram, and an A/B of it here did not beat
    // the machine's noise. It only moves the stall to first USE of the
    // program. Leave validation on until something measures a real win.
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
    g.userData.modelKey = key; // capture-harness prop identification (propprobe)
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
        if (wc === "arcane") { playFirst("spellshoot", "shoot", "attack"); this.castGather(mesh, 0xa06bff); }
        else if (wc === "ballistic" || wc === null) playFirst("shoot", "attack");
        else playFirst("throw", "shoot", "attack");
      }
      else if (cdRose("nova")) { playFirst("cast_raise", "attack"); this.castGather(mesh, 0x8fd8ff); }
      else if (cdRose("overcharge")) { playFirst("cast_long", "cast_raise"); this.castGather(mesh, 0xd98e4a); }
      else if (cdRose("stance")) playFirst("block");
      else if (cdRose("airstrike") || cdRose("cataclysm") || cdRose("bullettime")) {
        playFirst("cast_summon", "cast_raise");
        this.castGather(mesh, cdRose("cataclysm") ? 0xff8a3c : 0xffc860);
      }
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
    // Reused scratch (GC sweep): one call per animated body per frame.
    this.velOut.x = ud.velX as number;
    this.velOut.y = ud.velZ as number;
    return this.velOut;
  }
  private velOut: Vec2 = { x: 0, y: 0 };

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

  /**
   * THE PICKUP RING (MOBILE.md §2.7).
   *
   * Measured across four devices with a live drop on the floor: no renderer
   * key matching `pickup|lootring|magnet` and no DOM node matching
   * `pickup|lootstrip` existed at all, so a player on glass had no way to know
   * an item had been collected — or how close they had to get. The ring is the
   * world half of the answer: it draws the SIM's own `pickupRadius` around the
   * crawler while there is anything nearby to collect, and flares on the
   * frame something is actually taken.
   *
   * It reads a sim constant and paints it. It decides nothing.
   */
  setPickupRing(at: Vec2 | null, radius: number): void {
    if (!at) {
      if (this.pickupRing) this.pickupRing.visible = false;
      return;
    }
    if (!this.pickupRing) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.86, 1, 40),
        new THREE.MeshBasicMaterial({
          color: 0x9a6bd0, transparent: true, opacity: 0.34,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 3980;
      this.pickupRing = m;
      this.scene.add(m);
    }
    const r = this.pickupRing;
    r.visible = true;
    // The flare decays on wall clock: it is presentation, and the sim is not
    // stepping while a panel holds it.
    const age = (performance.now() - this.pickupFlareAt) / 380;
    const flare = age >= 0 && age < 1 ? 1 - age : 0;
    const s = radius * (1 + flare * 0.55);
    r.position.set(at.x, 0.05, at.y);
    r.scale.set(s, s, 1);
    (r.material as THREE.MeshBasicMaterial).opacity = 0.28 + flare * 0.55;
  }

  /** Something was collected this frame: flare the ring. */
  pulsePickup(): void {
    this.pickupFlareAt = performance.now();
  }
  private pickupRing: THREE.Mesh | null = null;
  private pickupFlareAt = -1e9;

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
   * TARGET SELECTION, DRAWN (MOBILE.md §3.3).
   *
   * Measured: a world tap set `lockedTargetId` correctly on 4 of 4 devices, the
   * LOCK chip lit, and `pickTarget` steered the smart cast — and NOTHING was
   * drawn on the monster. `grep lockedTargetId src/` returned the tap handler,
   * `smartAim` and the clear-on-death, and no renderer call at all. Wild Rift
   * draws a ring on the locked champion; on a phone where the thumb covers a
   * third of the glass, a lock you cannot see is a lock you do not trust.
   *
   * TWO MARKERS, DELIBERATELY DIFFERENT, because they answer different
   * questions:
   *
   *   LOCK   persistent, a closed bracket ring — "this is mine until I say
   *          otherwise". Survives between casts and follows the monster.
   *   SMART  transient, four corner ticks that fade over 420 ms — "THIS is
   *          what the chip you just tapped chose". It is the answer to the
   *          only question a smart cast leaves open, and it must not look like
   *          the lock or it teaches the wrong permanence.
   *
   * Positions arrive per frame in world units; either may be null.
   */
  setTargetMarkers(locked: Vec2 | null, smart: Vec2 | null): void {
    if (locked) {
      if (!this.lockRing) {
        const g = new THREE.Group();
        // A BRACKET, NOT A CIRCLE. The enemy ground telegraph is already a
        // ring, and a second ring a few pixels away is how §1.6's palette
        // problem happened in shape instead of colour. Four arcs with gaps
        // read as a reticle at 20 px and cannot be mistaken for an AoE.
        for (let i = 0; i < 4; i++) {
          const a0 = i * (Math.PI / 2) + 0.34;
          const m = new THREE.Mesh(
            new THREE.RingGeometry(0.62, 0.78, 18, 1, a0, Math.PI / 2 - 0.68),
            new THREE.MeshBasicMaterial({
              color: 0xeaf9ff, transparent: true, opacity: 0.9,
              side: THREE.DoubleSide, depthWrite: false, depthTest: false,
            }),
          );
          m.rotation.x = -Math.PI / 2;
          g.add(m);
        }
        g.renderOrder = 4010;
        this.lockRing = g;
        this.scene.add(g);
      }
      this.lockRing.visible = true;
      this.lockRing.position.set(locked.x, 0.09, locked.y);
      // A slow spin is what separates "the game is tracking this" from "a
      // decal was left here"; it costs one rotation write.
      this.lockRing.rotation.y = (performance.now() / 1000) * 0.9;
    } else if (this.lockRing) {
      this.lockRing.visible = false;
    }

    if (smart) {
      this.smartMarkAt = performance.now();
      this.smartMarkPos = { x: smart.x, y: smart.y };
    }
    // 420 ms, not 260: the question this answers is "what did that tap pick",
    // and the eye has to leave the thumb and find the monster before it can be
    // answered. Measured under the harness's 3 fps renderer a 260 ms flash was
    // already gone two frames after the cast — which is also what it would be
    // on a phone dropping frames in a pack fight, i.e. exactly when it matters.
    const age = (performance.now() - this.smartMarkAt) / 420;
    if (this.smartMarkPos && age >= 0 && age < 1) {
      if (!this.smartMark) {
        const g = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const a = i * (Math.PI / 2) + Math.PI / 4;
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(0.42, 0.09),
            new THREE.MeshBasicMaterial({
              color: 0x39c8e8, transparent: true, opacity: 0.95,
              side: THREE.DoubleSide, depthWrite: false, depthTest: false,
            }),
          );
          m.rotation.x = -Math.PI / 2;
          m.rotation.z = a;
          m.position.set(Math.cos(a) * 0.72, 0, Math.sin(a) * 0.72);
          g.add(m);
        }
        g.renderOrder = 4012;
        this.smartMark = g;
        this.scene.add(g);
      }
      this.smartMark.visible = true;
      this.smartMark.position.set(this.smartMarkPos.x, 0.1, this.smartMarkPos.y);
      // Snap in, ease out: the tick starts wide and closes on the target, so
      // the eye is led to the monster rather than asked to find the marker.
      const s = 1 + (1 - age) * 0.5;
      this.smartMark.scale.set(s, 1, s);
      for (const c of this.smartMark.children) {
        ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - age);
      }
    } else if (this.smartMark) {
      this.smartMark.visible = false;
    }
  }
  private lockRing: THREE.Group | null = null;
  private smartMark: THREE.Group | null = null;
  /** Public for the device harness: when the last smart pick was flashed. */
  smartMarkAt = -1e9;
  private smartMarkPos: Vec2 | null = null;

  /**
   * THE AIM TELEGRAPH (MOBILE.md §3.1) — the single read a touch ARPG lives on.
   *
   * What this replaces, measured in §1.6: three hardcoded meshes — a
   * `PlaneGeometry(4.2, 0.2)`, a `RingGeometry(2.0, 2.2)` and a 0.34 arrow —
   * painted gold `#c9a24b` at 0.42 with no outline. Nova (radius 2.6) and
   * cataclysm (radius 6) therefore drew the PIXEL-IDENTICAL ring, bolt's
   * telegraph was a 4.2-unit stub whatever its derived reach, and the frame
   * diff inside the indicator's own projected box came back AT OR BELOW the
   * scene's churn between two consecutive frames: the thing carried no signal
   * the torchlight did not already carry.
   *
   * Four changes, each answering a measured failure:
   *
   * 1. GEOMETRY IS REBUILT FROM THE ABILITY. `range`, `radius` and `arc` come
   *    from the `AimSpec` the host already computes off the crawler's own
   *    params, so glyphs and ranks change the drawn circle — a thing Wild Rift
   *    structurally cannot do, because its indicators are per-ability art.
   * 2. SIX SHAPES, not three: `cone` and `scatter` exist now instead of being
   *    folded into line and ring by the host.
   * 3. COLOUR THE WORLD DOES NOT OWN. Gold is the HUD, the chips, the
   *    torchlight and the loot glow; red/orange is the ENEMY ground telegraph.
   *    The player indicator is cyan `#39c8e8` fill at 0.30 under a white
   *    `#eaf9ff` core stroke at 0.85, over a `#08131a` outline at 0.7.
   * 4. FLOORS, so a correct shape cannot be an invisible one: a 3 CSS px
   *    minimum stroke width converted to world units through the live camera
   *    scale, and a 96x96 CSS px minimum projected footprint — the dash arrow
   *    measured 71x28.
   *
   * The core stroke draws with `depthTest: false` and a high `renderOrder`, so
   * a pack of sprites standing on the telegraph cannot swallow it (the failure
   * photographed in `r5/crop-aim-line.png`); the fill keeps `depthTest` so it
   * still reads as something lying on the floor.
   */
  setAimIndicator(
    kind: AimIndicatorShape | null, from?: Vec2, dir?: Vec2,
    range = 4.2, radius = 2.1, arc = 0,
  ): void {
    if (!kind || kind === "none" || !from) {
      if (this.aimIndicator) this.aimIndicator.visible = false;
      return;
    }
    if (!this.aimIndicator) {
      const g = new THREE.Group();
      g.name = "aimIndicator";
      // Render after the world; the fill still depth-tests, the stroke does not.
      g.renderOrder = 4000;
      this.aimIndicator = g;
      this.scene.add(g);
    }
    const ind = this.aimIndicator;
    ind.visible = true;
    ind.position.set(from.x, 0.07, from.y);
    if (dir && (dir.x !== 0 || dir.y !== 0)) ind.rotation.y = -Math.atan2(dir.y, dir.x);

    // STROKE WIDTH IS A SCREEN QUANTITY. The old 0.2-world-unit plane is what
    // made the line vanish: at the iso zoom a phone actually runs, 0.2 units
    // is barely over a pixel. Convert 3 CSS px through the camera's own
    // world-per-pixel scale, and never go below it.
    const worldPerPx = this.aimWorldPerPx();
    const stroke = Math.max(0.13, AIM_STROKE_PX * worldPerPx);
    // MINIMUM FOOTPRINT. `AIM_MIN_FOOTPRINT_PX` of screen, in world units,
    // measured on the SHORT screen axis so an iso-foreshortened up-screen aim
    // is the case that binds.
    const minSpan = AIM_MIN_FOOTPRINT_PX * worldPerPx;
    const key = `${kind}|${range.toFixed(2)}|${radius.toFixed(2)}|${arc.toFixed(3)}|${stroke.toFixed(3)}|${minSpan.toFixed(2)}`;
    if (this.aimKey === key) return;
    this.aimKey = key;
    for (const c of ind.children.slice()) disposeAimShape(c);
    ind.clear();
    for (const m of buildAimShape(kind, range, radius, arc, stroke, minSpan)) ind.add(m);
  }

  /**
   * World units per CSS pixel at the ground plane, from the live orthographic
   * frustum. One division, no raycast: the iso camera is orthographic, so the
   * scale is constant across the frame.
   */
  /**
   * The host publishes the live aim every frame while a chip is held: a UNIT
   * world direction and the reach in tiles, or null the moment it is released.
   *
   * The lead is capped rather than proportional — a 6-tile nova and a 14.4-tile
   * bolt want the same "show me a bit more that way", and a camera that slides
   * 7 tiles for an ultimate would lose the crawler, which is the thing the
   * player is dodging with.
   */
  setAimLead(dir: Vec2 | null, reach: number): void {
    if (!dir || reach <= 0) { this.aimLeadWant = 0; return; }
    this.aimDirWorld = dir;
    // Half the reach, capped at 4.2 tiles (half the ortho half-height), and
    // nothing at all for a shape that already fits comfortably in frame.
    this.aimLeadWant = reach < 5 ? 0 : Math.min(reach * 0.5, 4.2);
  }
  private aimLead = 0;
  private aimLeadWant = 0;
  private aimDirWorld: Vec2 | null = null;

  private aimWorldPerPx(): number {
    const cam = this.camera;
    const h = Math.abs(cam.top - cam.bottom) / Math.max(1, cam.zoom);
    const px = Math.max(1, this.lastH);
    return h / px;
  }
  private aimKey = "";

  // RENDER SCALE (SYSTEM menu setting): scales the backing buffer + composer
  // targets only — the canvas CSS size and every DOM overlay stay crisp.
  private renderScale = 1;
  private lastW = 2;
  private lastH = 2;
  setRenderScale(s: number): void {
    this.renderScale = Math.min(1, Math.max(0.5, s));
    this.resize(this.lastW, this.lastH);
  }

  resize(w: number, h: number): void {
    this.lastW = w;
    this.lastH = h;
    // PIXEL RATIO is the preset's biggest lever: every pixel-bound pass costs
    // its square. The display's own ratio is the ceiling, the preset's cap is
    // the policy, and the SYSTEM-menu render scale multiplies on top.
    const ratio = this.pixelRatio();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    // The composer multiplies by its own pixel ratio (captured from the
    // renderer at construction — keep it in sync when the scale setting
    // changes it), so pass CSS pixels — same as setSize above.
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.aspect = w / h;
    // "close" view: a third more zoomed in — furnishing and character read
    // bigger; you see less of the floor at once.
    this.lastProjHH = -1; // the aspect moved: force the rebuild
    this.applyProjection();
  }

  /** Last half-height actually pushed to the camera (see applyProjection). */
  private lastProjHH = -1;

  /**
   * The ortho frame. BOSSES V2 §5.5 lets the boss layer BORROW it — wider one
   * step per phase transition (the arena is more dangerous, so show more of
   * it), tighter on the intermission — and `bossFx.zoom` eases back to 1 the
   * moment the beat is over. Re-applied every frame because the boss zoom is
   * continuous, unlike the one-shot `viewClose` setting.
   */
  private applyProjection(): void {
    // The aim lead widens the frame as well as sliding it: sliding alone trades
    // the far end of the skillshot for the crawler's own feet, and on a 342 px
    // phone you need both in one picture to aim at all.
    const aimWide = 1 + Math.min(0.22, this.aimLead * 0.052);
    const hh = THEME.camOrthoHalfHeight * (this.viewClose ? 0.67 : 1) *
      this.bossFx.zoom * aimWide;
    // The boss zoom eases continuously, so this is called every frame — but
    // rebuilding the projection matrix (and dirtying the frustum) when nothing
    // moved is pure waste, and the last perf round was won on exactly this
    // kind of thing.
    if (Math.abs(hh - this.lastProjHH) < 1e-4) return;
    this.lastProjHH = hh;
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

  // Class-colored trim glow for the hero accent (issue #4): each skin owns a
  // signature hue so YOUR crawler is findable in a brawl by color alone.
  private static readonly SKIN_ACCENT: Record<string, number> = {
    knight: 0x4fd1ff, barbarian: 0xff8a3c, mage: 0xb98bff,
    rogue: 0x8bd450, hooded: 0x6fe3ff,
    "c:knight": 0x4fd1ff, "c:barbarian": 0xff8a3c, "c:druid": 0x7ed957,
    "c:engineer": 0xf2c14e, "c:mage": 0xb98bff, "c:rogue": 0x8bd450,
  };

  /** The render skin id for a player: their campfire pick, else the seeded look. */
  static skinIdFor(pl: { id: number; skin?: string }, seed: number): string {
    return pl.skin && `c:${pl.skin}` in Renderer3D.SKIN_MODEL ? `c:${pl.skin}` : heroSkin(seed, pl.id);
  }

  private buildPlayerMesh(skin: string): THREE.Group {
    const model =
      this.modelInstance(Renderer3D.SKIN_MODEL[skin] ?? "player") ?? this.modelInstance("player");
    if (model) {
      // 15% scale authority (r7 major: "the hero should be the first pixel
      // read in every frame" — a 40px capsule loses to every torch).
      this.normalizeHeight(model, 1.55);
      this.addBlobShadow(model, 0.42);
      // HERO SILHOUETTE AUTHORITY (final pass, issue #4): persistent cool
      // rim (stronger than any NPC's), +18%/12% sat/value authority, and a
      // class-colored trim glow — the player reads FIRST in any crowd.
      // Stored on userData so late attachments (headgear, grafted weapons)
      // inherit the exact same treatment instead of swallowing the rim.
      const shade = {
        rim: 0xcfe0ff,
        strength: 1.45,
        hero: true,
        accent: Renderer3D.SKIN_ACCENT[skin] ?? 0x4fd1ff,
        accentGain: 0.62,
      };
      model.userData.charShade = shade;
      this.applyCharacterShading(model, shade);
      // PERMANENT CHARACTER LIGHT RIG (r7 major): a cool kick light that
      // travels WITH the hero — behind-left-above, short throw — so the
      // player always has rim separation from the floor, and enemies stepping
      // into melee range catch a cool fill that keeps their silhouettes alive
      // inside the warm impact pools. One PointLight per player; cheap.
      {
        const gs = model.scale.x || 1;
        const kick = new THREE.PointLight(0x9fd0ff, 1.05, 4.5, 2);
        kick.position.set(-0.55 / gs, 2.0 / gs, -0.5 / gs);
        kick.userData.noAO = true;
        model.add(kick);
      }
      // Crisp directional contact shadow: a second, tighter dark ellipse
      // offset opposite the key light so the hero visibly SITS on the floor.
      {
        const gs = model.scale.x || 1;
        const { geo, mat } = this.blobResources();
        if (!this.dirBlobMat) {
          this.dirBlobMat = mat.clone();
          this.dirBlobMat.opacity = 0.5;
        }
        const dsh = new THREE.Mesh(geo, this.dirBlobMat);
        dsh.position.set(-0.1 / gs, 0.042 / gs, -0.08 / gs);
        dsh.scale.set(0.3 / gs, 1 / gs, 0.24 / gs);
        dsh.renderOrder = 1;
        dsh.userData.noAO = true;
        model.add(dsh);
      }
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
        // Grafted gear inherits the owner's character shading (issue #4:
        // headgear/weapons must LAYER onto the silhouette — an unshaded
        // graft reads as a matte hole in the rim-lit figure).
        const shade = mesh.userData.charShade as Parameters<Renderer3D["applyCharacterShading"]>[1] | undefined;
        if (shade) this.applyCharacterShading(obj, shade);
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

    // Rarity flair: emissive tint on the weapon's materials — plus material
    // separation (readability round 2): held steel goes specular against the
    // matte cloth body, so the weapon catches the key light and glints.
    if (weaponObj) {
      const glow = rarityGlow(pl.equipment.weapon?.rarity);
      weaponObj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.metalness = 0.55;
        mat.roughness = 0.35;
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
    // individuals against any floor wash instead of one silhouette soup —
    // plus a 15% palette pullback so enemies never outrank the hero. Elites
    // and bosses add an archetype-colored emissive accent (issue #3: threat
    // ID at a glance); bosses burn hotter and get arena treatment on spawn.
    const isBossKind = kind === "boss";
    const shade = {
      rim: 0x9fc4ff,
      // Cool rim raised a step (r6 blocker: crowd silhouettes sank into the
      // floor value; r7 blocker: golems went full silhouette inside the
      // combat hot zone) — every enemy edge separates even against a blown
      // impact pool, because the rim is EMISSIVE and survives any exposure.
      strength: isBossKind ? 0.95 : 0.8,
      desat: isBossKind ? 0.05 : 0.15,
      accent: elite || isBossKind ? (def?.tint ?? spec.color) : undefined,
      accentGain: isBossKind ? 0.85 : 0.4,
      // BOSS MATERIAL PASS (r7 major: "untextured white cylinder"): porcelain
      // sheen, floor grime up the base, and a gold trim glint matching the
      // HUD language — the menace reads as a crafted prop, not a blockout.
      gloss: isBossKind ? 0.42 : undefined,
      grime: isBossKind ? 0.55 : undefined,
      trim: isBossKind ? 0xd8a742 : undefined,
      trimGain: isBossKind ? 0.34 : undefined,
      // Archetype albedo tint (issue #3): white-clay texels take the
      // archetype's hue, so a pack splits into material families instead of
      // shipping as identical bone-white blanks. Bosses lean harder — the
      // menace must read as ITS OWN THING from across the arena.
      tint: def?.tint ?? spec.color,
      tintGain: isBossKind ? 0.6 : 0.5,
      // Mobs cede brightness to the hero (issue #4): a white ogre must never
      // out-value the player's silhouette.
      value: isBossKind ? 1 : 0.9,
    };
    g.userData.charShade = shade;
    this.applyCharacterShading(g, shade);
    // SIGNATURE MENACE GLOW (r6 major: the boss lost a size contest to its
    // own damage number): bosses carry their own light — an archetype-hued
    // aura halo spilling around the silhouette plus a warm ember crown at the
    // head. Depth-tested sprites, so the body occludes the centers and only
    // the rim light escapes — the boss reads as the arena's light source.
    if (isBossKind) {
      const bs = g.scale.x || 1;
      const aura = this.makeGlow(def?.tint ?? spec.color, 3.6 / bs);
      aura.position.y = 1.6 / bs;
      (aura.material as THREE.SpriteMaterial).opacity = 0.32;
      aura.userData.noAO = true;
      // Crown glow leans GOLD and burns brighter (r7 major: the skull-crown
      // detail vanished from the gameplay camera — the head must carry a
      // readable hot accent from the iso angle, not just a probe orbit).
      const crown = this.makeGlow(0xf2c14e, 1.7 / bs);
      crown.position.y = 2.9 / bs;
      (crown.material as THREE.SpriteMaterial).opacity = 0.62;
      crown.userData.noAO = true;
      g.add(aura, crown);
    }
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
    // Character warm rim keyed to the band's PRACTICAL light (issue #3): the
    // torch-side kicker on every figure matches the color of the sconces
    // actually lighting the floor, luma-normalized so it shifts hue only.
    {
      const w = this.chU.uChWarm.value as THREE.Color;
      w.set(theme.torchColor);
      const luma = Math.max(1e-4, 0.2126 * w.r + 0.7152 * w.g + 0.0722 * w.b);
      w.multiplyScalar(0.85 / luma);
    }

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
    this.scene.environment = this.bakeEnv(band, mood);
    this.scene.environmentIntensity = mood.envIntensity;
  }

  /** PMREM the band's gradient sky (cached per band — bake once, reuse). */
  private bakeEnv(band: number, mood: BandMood): THREE.Texture {
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
    return env;
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
    this.torchStreaks = [];
    for (const m of this.floorMats) m.dispose();
    this.floorMats = [];
    for (const f of this.envFlow) f.tex.dispose();
    this.envFlow = [];
    this.wlPropCache.clear(); // clones died with floorMats; next build re-clones

    const map = state.map;

    // Theme band for this depth (art set + palette), plus a cosmetic per-floor
    // rng so floors within a band differ (mix ratio, props, tint jitter).
    // Roam floor numbers grow open-endedly, but themeForFloor already clamps
    // via floorBand (same as Race) — and now that Roam's tribe identity also
    // tracks floorBand (roamTribeId), visuals and tribe always agree.
    const theme: FloorTheme = themeForFloor(state.floor);
    // Impact dust inherits the floor's ambient color (audit r3): kicked-up
    // grit on an ice floor reads cold, on an ember floor reads ashen.
    this.dustTint = new THREE.Color(theme.floorTint)
      .lerp(new THREE.Color(0x6b5f52), 0.45).multiplyScalar(0.42).getHex();
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
    // Wall-run variation piece: the band's banner instanced on wall faces.
    const bannerSrc = openAir ? null : this.tileSource(theme.doorFlankKey);
    const nudge = new THREE.Matrix4(); // scratch for panel-face offsets
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
    // DRAW-CALL DIET (perf round): sparse decorative kinds (coping trim,
    // pilasters, wall banners, doors, grates, cliff facades, tree clusters)
    // used to mint one InstancedMesh per 12x12 chunk EACH — dozens of tiny
    // meshes per kind per floor, and every scene object costs again in the
    // shadow + AO passes. They bucket into 36x36 SUPER-chunks instead:
    // identical pixels (same instances, same materials, same tints), ~1/9
    // the meshes. The high-population ground/fill/panel kinds keep the fine
    // 12-tile chunking that makes frustum culling pay for itself.
    const SUPER = 36;
    const superCols = Math.ceil(map.w / SUPER);
    const SPARSE_BASE = 0x40000; // key namespace: super-chunk ids never collide
    // Deliberately NOT merged: cluster/accent foliage — those are the
    // tri-heavy canopies (merging defeats frustum culling where it matters
    // most) AND the camera-courtesy step-aside rewrites their instance
    // matrices per frame, so their buffers must stay chunk-small.
    const sparseKind = (kind: string): boolean =>
      kind === "trim" || kind === "pilaster" || kind === "wbanner" || kind === "door" ||
      kind === "grate" || kind === "grateO" || kind === "path" || kind === "panelGate" ||
      kind.startsWith("cliff") || kind.startsWith("panelW");
    // Kinds are dynamic: interior bands use floor/alt/fill/panel/door; open-air
    // bands add a trodden path plus per-variant cliff facades and tree clusters.
    type Bucket = Map<string, { m: THREE.Matrix4; tile: number }[]>;
    const buckets = new Map<number, Bucket>();
    const push = (kind: string, x: number, y: number, tile: number, mat: THREE.Matrix4) => {
      const key = sparseKind(kind)
        ? SPARSE_BASE + Math.floor(y / SUPER) * superCols + Math.floor(x / SUPER)
        : Math.floor(y / CHUNK) * chunkCols + Math.floor(x / CHUNK);
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
    const pfQuat = new THREE.Quaternion();
    const pfOff = new THREE.Vector3();
    const pfPos = new THREE.Vector3();
    const pfScl = new THREE.Vector3();
    const PF_UP = new THREE.Vector3(0, 1, 0);
    const placeFloor = (src: typeof floorSrc, x: number, y: number) => {
      if (!src) { m.makeTranslation(x + 0.5, -0.1, y + 0.5); return; }
      const s = src.scale;
      const cx = (src.box.min.x + src.box.max.x) / 2;
      const cz = (src.box.min.z + src.box.max.z) / 2;
      // Quarter-turn per tile (r7 minor: identical crack/stain tile variants
      // repeating in one orientation read as wallpaper) — free variety on
      // square tiles, keyed by position so it's stable across rebuilds.
      pfQuat.setFromAxisAngle(PF_UP, (tileHash(x, y, 7) % 4) * (Math.PI / 2));
      pfOff.set(cx * s, 0, cz * s).applyQuaternion(pfQuat);
      pfPos.set(x + 0.5 - pfOff.x, -src.box.max.y * s, y + 0.5 - pfOff.z);
      pfScl.set(s, s, s);
      m.compose(pfPos, pfQuat, pfScl);
    };
    // Panel placement: length spans the tile edge, height stretched to the fill
    // boxes, face flush with the wall/floor boundary, rotated toward the floor.
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const placePanel = (src: Src, x: number, y: number, dx: number, dz: number, height = wallHeight) => {
      const s = src.scale;
      const sy = height / Math.max(1e-4, src.box.max.y - src.box.min.y);
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
          // WALL SILHOUETTES: flat-topped extrusion no more. A seeded ~9% of
          // room-facing wall tiles are BROKEN — collapsed to a ragged stump —
          // intact faced walls carry a coping-stone trim cap plus a pilaster
          // every ~5 tiles for vertical rhythm, and the ROOFLINE VARIES:
          // convex corners and door shoulders step UP into small bastions,
          // and a seeded ~8% of run tiles rise a course, so a 15-tile wall
          // run reads as built masonry instead of one extrusion.
          const facing = DIRS.filter((d) => isFloorAt(x + d.dx, y + d.dz));
          const hSil = tileHash(x, y, state.floor + 201);
          const brokenWall = facing.length > 0 && hSil < 135;
          let hgt = brokenWall ? fillHeight * (0.5 + (hSil % 27) / 100) : fillHeight;
          if (!brokenWall && facing.length > 0) {
            const nearDoor = [idx - 1, idx + 1, idx - map.w, idx + map.w]
              .some((n) => n >= 0 && n < map.tiles.length && map.tiles[n] === Tile.DoorLocked);
            if (nearDoor) hgt = fillHeight + 0.22; // door shoulders frame the gate
            else if (facing.length >= 2) hgt = fillHeight + 0.13; // corner bastion
            else if (hSil >= 875) hgt = fillHeight + 0.14 + ((hSil % 11) / 100); // raised courses, varied
          }
          m.makeScale(1, hgt / fillHeight, 1).setPosition(x + 0.5, hgt / 2, y + 0.5);
          push("fill", x, y, idx, m);
          if (facing.length > 0 && !brokenWall) {
            m.makeTranslation(x + 0.5, hgt + 0.033, y + 0.5);
            push("trim", x, y, idx, m);
          } else if (brokenWall) {
            // Rubble crown on the stump so the break reads collapsed, not cut.
            m.makeScale(0.7, 0.22, 0.7).setPosition(x + 0.5, hgt + 0.05, y + 0.5);
            push("fill", x, y, idx, m);
          }
          if (wallSrc) {
            for (const d of facing) {
              // Lived look: a seeded slice of wall faces carry windows or a
              // portcullis gate — masonry with a history, not wallpaper.
              const hv = lived ? tileHash(x * 3 + d.dx, y * 3 + d.dz, state.floor + 55) : 999;
              const variant = hv < 45 && winSrc ? { src: winSrc, kind: "panelWin" }
                : hv < 85 && winGatedSrc ? { src: winGatedSrc, kind: "panelWinG" }
                : hv < 115 && gatedSrc ? { src: gatedSrc, kind: "panelGate" }
                : null;
              placePanel(variant ? variant.src : wallSrc, x, y, d.dx, d.dz, brokenWall ? hgt : hgt + 0.04);
              // Fog keys panels off the floor tile they FACE.
              push(variant ? variant.kind : "panel", x, y, (y + d.dz) * map.w + (x + d.dx), m);
              const along = d.dx !== 0 ? y : x;
              if (!brokenWall && (along + state.floor) % 5 === 0) {
                quat.setFromAxisAngle(UP, Math.atan2(d.dx, d.dz));
                pos.set(x + 0.5 + d.dx * 0.56, 0.59, y + 0.5 + d.dz * 0.56);
                scl.set(1, 1, 1);
                m.compose(pos, quat, scl);
                push("pilaster", x, y, (y + d.dz) * map.w + (x + d.dx), m);
              } else if (!brokenWall && bannerSrc && (along * 2 + (d.dx !== 0 ? x : y) + state.floor * 3) % 9 === 4) {
                // VARIATION PIECE every few tiles of run: the band's banner
                // hung on the face — long walls stop reading as wallpaper.
                placePanel(bannerSrc, x, y, d.dx, d.dz, 0.8);
                m.premultiply(nudge.makeTranslation(d.dx * 0.08, 0.12, d.dz * 0.08));
                push("wbanner", x, y, (y + d.dz) * map.w + (x + d.dx), m);
              }
            }
          }
        } else if (openAir) {
          // Grass everywhere; the corridors between clearings show trodden earth.
          if (pathSrc && !roomMask[idx]) {
            placeFloor(pathSrc, x, y);
            push("path", x, y, idx, m);
          } else {
            // ORGANIC meadow variation (critic r2: per-tile random read as a
            // dev checkerboard): coarse multi-tile patches with dithered
            // edges, plus the odd worn dirt scuff where traffic killed the grass.
            const hFine = tileHash(x, y, state.floor);
            const hCoarse = tileHash(x >> 2, y >> 2, state.floor + 5);
            if (pathSrc && hFine >= 955) {
              placeFloor(pathSrc, x, y);
              push("path", x, y, idx, m);
            } else {
              m.makeTranslation(x + 0.5, 0.001, y + 0.5);
              push(hCoarse * 0.68 + hFine * 0.32 < 440 ? "alt" : "floor", x, y, idx, m);
            }
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
    // Wall-top coping trim + face pilasters (silhouette pass): the trim cap
    // overhangs a hair and reads a step lighter; pilasters stand proud of the
    // face in the same masonry so wall runs get vertical rhythm.
    const trimGeo = new THREE.BoxGeometry(1.08, 0.07, 1.08);
    // Coping trim is CARVED STONE in the wall's own family — one value step
    // apart, never the pale dust-cap that read as snow inside a dungeon.
    const trimMat = this.worldLit(flat(THEME.wall, { map: this.stoneTexture() }), { base: true }) as THREE.Material;
    const pilasterGeo = new THREE.BoxGeometry(0.3, 1.18, 0.16);
    const pilasterMat = this.worldLit(flat(THEME.wall, { map: this.stoneTexture() }), { base: true }) as THREE.Material;
    const doorGeo = new THREE.BoxGeometry(0.96, 1.1, 0.96);
    const doorMat = this.worldLit(flat(0xc9a24b, { emissive: 0x5a3f08, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.35 }));
    // Alt-tile glow (IRONWORKS grates): a faint emissive inside the vents so
    // they read as designed fixtures lit from below, not missing textures.
    let altBase: THREE.Material | THREE.Material[] = altSrc?.mat ?? flat(THEME.floorAlt);
    if (theme.altGlow && altSrc && !Array.isArray(altBase) && (altBase as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const g = (altBase as THREE.MeshStandardMaterial).clone();
      g.emissive = new THREE.Color(theme.altGlow.color);
      g.emissiveIntensity = theme.altGlow.intensity;
      this.floorMats.push(g);
      altBase = g;
    }
    const kindSpec: Record<string, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; lit: THREE.Color; cast: boolean } | null> = {
      floor: { geo: floorSrc?.geo ?? fallbackFloorGeo!, mat: this.worldLit(floorSrc?.mat ?? flat(THEME.floor)), lit: floorLit, cast: false },
      alt: { geo: altSrc?.geo ?? fallbackFloorGeo!, mat: this.worldLit(altBase), lit: floorLit, cast: false },
      alt2: alt2Src ? { geo: alt2Src.geo, mat: this.worldLit(alt2Src.mat), lit: floorLit, cast: false } : null,
      fill: { geo: fillGeo, mat: fillMat, lit: wallFillLit, cast: true },
      panel: wallSrc ? { geo: wallSrc.geo, mat: this.worldLit(wallSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      door: { geo: doorGeo, mat: doorMat, lit: new THREE.Color(1, 1, 1), cast: true },
      panelWin: winSrc ? { geo: winSrc.geo, mat: this.worldLit(winSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      panelWinG: winGatedSrc ? { geo: winGatedSrc.geo, mat: this.worldLit(winGatedSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      panelGate: gatedSrc ? { geo: gatedSrc.geo, mat: this.worldLit(gatedSrc.mat, { base: true }), lit: wallLitColor, cast: true } : null,
      grate: grateSrc ? { geo: grateSrc.geo, mat: this.worldLit(grateSrc.mat), lit: floorLit, cast: false } : null,
      grateO: grateOpenSrc ? { geo: grateOpenSrc.geo, mat: this.worldLit(grateOpenSrc.mat), lit: floorLit, cast: false } : null,
      trim: { geo: trimGeo, mat: trimMat, lit: wallLitColor.clone().multiplyScalar(0.98), cast: true },
      pilaster: { geo: pilasterGeo, mat: pilasterMat, lit: wallLitColor.clone().multiplyScalar(1.05), cast: true },
      wbanner: bannerSrc ? { geo: bannerSrc.geo, mat: this.worldLit(bannerSrc.mat), lit: new THREE.Color(tintJitter, tintJitter, tintJitter), cast: false } : null,
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
        // Masonry gets the same treatment (critic r2: 20-tile wall runs read
        // as one repeated stamp) — per-instance value jitter breaks the tiling.
        const masonry = kind === "fill" || kind === "trim" || kind === "pilaster" || kind.startsWith("panel") || kind.startsWith("cliff");
        const litColors = new Float32Array(list.length * 3);
        for (let i = 0; i < list.length; i++) {
          // Per-tile value jitter (+ baked AO) so a field of identical tiles
          // never reads as one flat albedo sheet.
          const jit = ground ? 0.92 + 0.16 * (tileHash(list[i].tile % map.w, (list[i].tile / map.w) | 0, state.floor + 7) / 1000)
            : masonry ? 0.90 + 0.17 * (tileHash(list[i].tile % map.w, (list[i].tile / map.w) | 0, state.floor + 11) / 1000)
            : 1;
          const ao = (ground ? aoGrid[list[i].tile] : 1) * jit;
          litColors[i * 3] = spec.lit.r * ao;
          litColors[i * 3 + 1] = spec.lit.g * ao;
          litColors[i * 3 + 2] = spec.lit.b * ao;
          if (foliage) {
            // Per-tree jitter (±8% hue lean, ±15% value): a forest of one
            // saturated green reads painted-on; individuals read grown.
            const hj = tileHash(list[i].tile % map.w, (list[i].tile / map.w) | 0, state.floor + 19 + i);
            const v = 0.82 + 0.28 * (hj / 1000);
            const w = ((((hj * 7) % 1000) / 1000) - 0.5) * 0.22; // warm<->cool lean (tempered: candy greens clash)
            litColors[i * 3] *= v * (1 + w);
            litColors[i * 3 + 1] *= v;
            litColors[i * 3 + 2] *= v * (1 - w * 0.8);
            // Accent individuals (critic r3: same-value broccoli): ~7% turn
            // autumn-rust, ~4% go dull sick-olive — the canopy gets punctuation
            // marks without repainting the band's green identity.
            const acc = (hj * 13) % 1000;
            if (acc < 70) {
              litColors[i * 3] *= 1.5;
              litColors[i * 3 + 1] *= 0.66;
              litColors[i * 3 + 2] *= 0.38;
            } else if (acc < 110) {
              litColors[i * 3] *= 1.12;
              litColors[i * 3 + 1] *= 0.82;
              litColors[i * 3 + 2] *= 0.5;
            }
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
    // Interior falloff starts sooner with a deeper floor: mid-distance sinks
    // toward shadow so the torch pools read carved out of the dark (D2R) —
    // but the far floor stays READABLE (final pass, issue #1): distant
    // explored ground keeps ~a third of its lighting, never a crushed void.
    if (openAir) this.wl.uWlFall.value.set(5.5, 16, 0.34);
    else this.wl.uWlFall.value.set(3.7, 11, 0.30);
    // Murk hue: the band's colored dark, luma-normalized then leaned cool
    // (faint sky bounce) at a fixed ~8-12% display-luminance magnitude — the
    // band keeps its identity in the dark without the value crush.
    {
      const m = this.fogDark.clone();
      const luma = Math.max(1e-4, 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b);
      m.multiplyScalar(1 / luma).multiply(new THREE.Color(0.86, 0.94, 1.18));
      (this.wl.uWlMurk.value as THREE.Color).copy(m).multiplyScalar(0.028);
      (this.wl.uWlGlint.value as THREE.Color).set(theme.torchColor).multiplyScalar(0.3);
    }
    // Walk-distance field for the wall-aware falloff (issue #2): allocated
    // per floor, BFS'd from the player's tile whenever it changes.
    this.wlDist?.tex.dispose();
    {
      const n = map.w * map.h;
      const data = new Uint8Array(n).fill(255);
      const tex = new THREE.DataTexture(data, map.w, map.h, THREE.RedFormat, THREE.UnsignedByteType);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.wlDist = { tex, data, field: new Float32Array(n), queue: new Int32Array(n * 8), lastTile: -1 };
      this.wl.uWlDist.value = tex;
    }
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
        // Crafted-room props take the SAME band tint + value variant as the
        // scattered set (r7 material blocker: stamp props bypassed the zoning
        // and shipped as untextured light-gray boxes in hero rooms).
        {
          let tint = theme.propTint?.[p.key] !== undefined ? new THREE.Color(theme.propTint[p.key]) : undefined;
          let variant = tint ? `t${theme.propTint![p.key].toString(16)}` : "";
          const vi = tileHash(Math.floor(stamp.x + p.x), Math.floor(stamp.y + p.y), state.floor) % Renderer3D.PROP_VARIANTS.length;
          if (vi > 0) {
            const [pr, pg, pb] = Renderer3D.PROP_VARIANTS[vi];
            tint = (tint ?? new THREE.Color(1, 1, 1)).multiply(new THREE.Color(pr, pg, pb));
          }
          this.worldLitProp(obj, tint, `v${vi}${variant}`);
        }
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
    const PROP_CAP = lived ? 920 : 880; // density pass (critic r2: ~3x): no lit room ships as an empty plane
    const place = (key: string, x: number, y: number, opts: { scale?: number; rot?: number; jitter?: number; onWall?: boolean; elevate?: number } = {}): boolean => {
      // onWall: landmark set pieces stand ON sim-blocked pillar tiles — the
      // one case where a prop belongs on a non-Floor tile (looks = collision).
      // elevate: lift after the ground snap (wall-mounted decor, tabletop items).
      if (this.propEntries.length > PROP_CAP || (!opts.onWall && !clear(x, y))) return false;
      const obj = this.modelInstance(key);
      if (!obj) return false;
      // Props share the world-lit stage with the ground they stand on: they
      // sink into fog and the distance falloff instead of floating full-bright.
      // Band prop tints (r5 issue #2) + per-instance foliage variance (r5
      // issue #4) ride the same clone cache, quantized so clones stay bounded.
      let tint = theme.propTint?.[key] !== undefined ? new THREE.Color(theme.propTint[key]) : undefined;
      let variant = tint ? `t${theme.propTint![key].toString(16)}` : "";
      if (Renderer3D.FOLIAGE_KEY.test(key)) {
        const vi = Math.floor(frng() * Renderer3D.FOLIAGE_VARIANTS.length);
        const [fr, fg, fb] = Renderer3D.FOLIAGE_VARIANTS[vi];
        tint = (tint ?? new THREE.Color(1, 1, 1)).multiply(new THREE.Color(fr, fg, fb));
        variant = `f${vi}${variant}`;
      } else {
        // Everything else gets a quantized value step (r7: uniform-hue props).
        const vi = Math.floor(frng() * Renderer3D.PROP_VARIANTS.length);
        const [pr, pg, pb] = Renderer3D.PROP_VARIANTS[vi];
        if (vi > 0) tint = (tint ?? new THREE.Color(1, 1, 1)).multiply(new THREE.Color(pr, pg, pb));
        variant = `v${vi}${variant}`;
      }
      this.worldLitProp(obj, tint, variant);
      const box = new THREE.Box3().setFromObject(obj);
      const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
      const themed = theme.propScale?.[key];
      // The theme's scale chart CAPS even explicit scales: a playing card in
      // a scatter clump must never render at half a character's height.
      let fpScale = opts.scale ?? (themed ? themed * (0.85 + frng() * 0.3) : 0.55 + frng() * 0.2);
      if (themed !== undefined && opts.scale !== undefined) fpScale = Math.min(fpScale, themed * 1.1);
      obj.scale.multiplyScalar(fpScale / fp);
      // TIPPED VARIANTS (critic r3: eight identical upright barrels at grid
      // rotations): ~1 in 7 tippable containers lies knocked on its side at a
      // free angle — the cluster reads as history, not a level-editor stamp.
      const tipped = opts.rot === undefined && Renderer3D.TIPPABLE.has(key) && frng() < 0.14;
      if (tipped) obj.rotation.set(Math.PI / 2 * 0.97, frng() * Math.PI * 2, (frng() - 0.5) * 0.25);
      const scaled = new THREE.Box3().setFromObject(obj);
      const j = opts.jitter ?? 0.25;
      obj.position.set(
        x + (frng() - 0.5) * j - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
        -scaled.min.y + 0.004 + (opts.elevate ?? 0),
        y + (frng() - 0.5) * j - (scaled.min.z + scaled.max.z) / 2 + obj.position.z,
      );
      if (!tipped) obj.rotation.y = opts.rot ?? frng() * Math.PI * 2;
      this.floorGroup.add(obj);
      this.propEntries.push({ obj, tile: Math.floor(y) * map.w + Math.floor(x) });
      return true;
    };

    // 1) Torch anchors along room walls (every ~4 perimeter tiles), lights riding
    //    the meshes. Replaces the old free-floating torch light sampling.
    const torchAnchors: Vec2[] = [];
    // Wall-face spots for the sconce light streaks (interiors only — the
    // Garden's standing lanterns have no masonry behind them).
    const streakSpots: { x: number; y: number; dx: number; dy: number }[] = [];
    for (let ri = 0; ri < map.rooms.length && torchAnchors.length < 18; ri++) {
      const r = map.rooms[ri];
      let steps = 0;
      const tryTorch = (x: number, y: number) => {
        if (torchAnchors.length >= 18) return;
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
        if (place(torchKey, tx, ty, { scale: openAir ? 0.7 : 0.55, jitter: 0.05 })) {
          torchAnchors.push({ x: tx, y: ty });
          if (!openAir) streakSpots.push({ x, y, dx: wallDir[0], dy: wallDir[1] });
        }
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
      // PER-ROOM VARIETY CURSOR (critic r3: eight identical banded barrels in
      // one frame): clutter cycles a shuffled copy of the pool instead of
      // independent random picks, so a room never fills with one prop.
      const order = pool.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const jx = Math.floor(frng() * (i + 1));
        [order[i], order[jx]] = [order[jx], order[i]];
      }
      let pc = 0;
      const nextKey = () => pool[order[pc++ % order.length]];
      // Density floor: three corners cluttered per room (two in open-air, the
      // scatter there is carried by the flora passes).
      const nCorners = openAir ? 2 : 4;
      for (let c = 0; c < nCorners; c++) {
        const corner = corners[(start + c * (nCorners === 2 ? 2 : 1)) % 4];
        const n = 2 + Math.floor(frng() * 3);
        for (let k = 0; k < n; k++) {
          place(nextKey(), corner.x + (frng() - 0.5) * 0.8, corner.y + (frng() - 0.5) * 0.8);
        }
      }
      // 3b) WALL-HUG CLUTTER (interiors): stretches of room wall between the
      //     torches get small props tucked against the face — crates against
      //     masonry, junk along the skirting — so a lit room's edges read
      //     furnished instead of shipping as a bare plane with two slabs.
      if (!openAir) {
        const hug = (x: number, y: number, dx: number, dy: number): void => {
          if (frng() > 0.72) return;
          const key = nextKey();
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
        // PRACTICAL on the monument (r5 issue #2): flanking flames + their
        // baked pools, so the hall's hero setpiece sits in its own warm key
        // instead of shipping as gray-on-dark graybox. Pushed AFTER
        // addTorches() reassigned this.torchAnchors, same as the boss ring.
        if (!openAir) {
          for (const [fdx, fdy] of [[-1.15, 0.65], [1.15, 0.65]] as const) {
            if (place("torch_lit", px + fdx, py + fdy, { scale: 0.55, jitter: 0.05 })) {
              this.torchAnchors.push({ x: px + fdx, y: py + fdy, seed: 47 + fdx * 3.1 });
            }
          }
        }
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
    // ARENA KICK LIGHTING (final pass, issue #6): the reveal frame must never
    // be a black void — the arena gets its own practicals: a ring of ritual
    // flames around the circle (real torch anchors, so they inherit the flame
    // sprites, baked wall-shadowed pools and gutter flicker), plus a baked
    // boss-colored glow under the circle itself that silhouettes the menace
    // from below and rims every combatant that steps in.
    const arenaLights: BakeLight[] = [];
    const boss = state.monsters.find((mo) => mo.kind === "boss");
    if (boss) {
      const finale = state.floor >= CONFIG.finalFloor;
      place("summoning_circle", boss.pos.x, boss.pos.y, {
        scale: finale ? 3.2 : 2.0,
        rot: 0,
        jitter: 0,
      });
      const ringR = finale ? 4.2 : 3.1;
      const flameKey = openAir ? "lantern_standing" : "torch_lit";
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + 0.35;
        const bx = boss.pos.x + Math.cos(ang) * ringR;
        const by = boss.pos.y + Math.sin(ang) * ringR;
        if (!isFloorAt(Math.floor(bx), Math.floor(by))) continue;
        if (place(flameKey, bx, by, { scale: 0.62, jitter: 0.04 })) {
          this.torchAnchors.push({ x: bx, y: by, seed: 31 + k * 2.3 });
        }
      }
      // The ritual circle glows the boss's threat color — a cool-void frame
      // with a crimson-lit menace at its center, not a white blob in the dark.
      const bc = new THREE.Color(THEME.archetype.boss.color).lerp(new THREE.Color(0xff9a4d), 0.35);
      arenaLights.push({
        x: boss.pos.x, y: boss.pos.y, r: finale ? 6.5 : 5.0,
        color: { r: bc.r, g: bc.g, b: bc.b },
        intensity: 1.05, jitter: false,
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

    // 7b) CORRIDOR GUARANTEE (interiors): a deterministic ~7% of corridor
    //     tiles get a small wall-hugged prop, independent of the density
    //     roll — no more prop-free connective tissue between lit rooms.
    if (!openAir) {
      for (let y = 1; y < map.h - 1; y++) {
        for (let x = 1; x < map.w - 1; x++) {
          const ci = y * map.w + x;
          if (map.tiles[ci] !== Tile.Floor || roomMask[ci]) continue;
          const hc = tileHash(x, y, state.floor + 61);
          if (hc >= 115) continue;
          const wd = DIRS.find((d) => map.tiles[ci + d.dz * map.w + d.dx] === Tile.Wall);
          if (!wd) continue;
          const key = theme.props[hc % theme.props.length];
          place(key, x + 0.5 + wd.dx * 0.3, y + 0.5 + wd.dz * 0.3, {
            scale: 0.3 + (hc % 20) / 100, jitter: 0.12,
            rot: Math.atan2(-wd.dx, -wd.dz) + (frng() - 0.5) * 0.7,
          });
        }
      }
    }

    // 8) BAND SIGNATURE PASS (envDressing.ts): floor decals with guaranteed
    //    per-room minimums, each band's hero setpiece + signature modular
    //    props, and silhouetted composition for the void. All deterministic
    //    per (seed, floor); all cosmetic.
    const envAccentLights: BakeLight[] = [];
    {
      const envCtx: EnvCtx = {
        band: floorBand(state.floor),
        floor: state.floor,
        theme,
        map: { w: map.w, h: map.h, rooms: map.rooms, roles: map.roles },
        rng: frng,
        isFloor: (x, y) => isFloorAt(x, y),
        isWall: (x, y) => inBounds(x, y) && map.tiles[y * map.w + x] === Tile.Wall,
        roomMask,
        place: (key, x, y, opts) => place(key, x, y, opts),
        getObj: (key) => {
          const obj = this.modelInstance(key);
          if (obj) this.worldLitProp(obj);
          return obj;
        },
        addObj: (obj, x, y) => {
          this.floorGroup.add(obj);
          this.propEntries.push({
            obj,
            tile: Math.min(map.tiles.length - 1, Math.max(0, Math.floor(y) * map.w + Math.floor(x))),
          });
        },
        // Setpiece materials share the prop zoning stage (r6 item #2): stone
        // curbs/colonnades get the same albedo ceiling + cavity + grain as
        // placed props, so hero dressing never ships graybox-flat.
        worldLit: (mm) => this.worldLit(mm, { prop: true }),
        trackMat: (mm) => { this.floorMats.push(mm); },
        group: this.floorGroup,
        addFlow: (tex, sx, sy, opts) => { this.envFlow.push({ tex, sx, sy, wobble: opts?.wobble, freq: opts?.freq }); },
        addLight: (lx, ly, color, intensity, radius) => {
          const c = new THREE.Color(color);
          envAccentLights.push({ x: lx, y: ly, r: radius, color: { r: c.r, g: c.g, b: c.b }, intensity });
        },
      };
      placeDecals(envCtx);
      signatureDressing(envCtx);
      accentGlows(envCtx);
      if (!openAir) voidSilhouettes(envCtx, theme.mood);
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
      const flameY = openAir ? 1.12 : 0.98;
      const warmLean = new THREE.Color(0xffe9a8);
      const redLean = new THREE.Color(0xff5a20);
      for (const a of this.torchAnchors) {
        const v = 0.85 + 0.3 * (((Math.imul((a.seed * 97) | 0, 2654435761) >>> 8) % 1000) / 1000);
        // PER-SCONCE FLAME IDENTITY (critic r3: every torch the identical
        // round gradient): hue leans ±10% warm/red per anchor, so a wall of
        // sconces reads as many fires, not one stamped sprite.
        const hueJ = ((((Math.imul((a.seed * 131 + 7) | 0, 2654435761) >>> 9) % 1000) / 1000) - 0.5) * 0.2;
        const aC = torchC.clone().lerp(hueJ > 0 ? warmLean : redLean, Math.abs(hueJ));
        // BLOWOUT CLAMP: the hot point is TINY (a 1-2px prick after bloom) and
        // only lightly whitened, the mid layer keeps the band's saturated hue —
        // an ice-blue lamp stays ice-blue with a pin of white, never a white
        // disc that swallows its own fixture.
        const coreC = aC.clone().lerp(new THREE.Color(0xfff6e8), 0.72).getHex();
        const midC = aC.getHex();
        const haloC = aC.clone().lerp(new THREE.Color(theme.mood.gradeShadow), 0.15).getHex();
        const tile = Math.min(map.tiles.length - 1, Math.max(0, Math.floor(a.y) * map.w + Math.floor(a.x)));
        const layers: { c: number; size: number; op: number; role: 0 | 1 | 2 }[] = [
          { c: coreC, size: 0.13 * v, op: 0.82, role: 0 },
          { c: midC, size: 0.56 * v, op: 0.55, role: 1 },
          { c: haloC, size: 1.35 * v, op: 0.1, role: 2 },
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
      // SCONCE WALL STREAKS: a vertical firelight lick painted up the wall
      // face behind each interior torch (critic r3: torches read as glowing
      // lollipops with no interaction with the masonry they hang from).
      // Additive gradient quads flush to the wall, guttering with the flame
      // and fog-gated with it in update().
      if (streakSpots.length > 0) {
        if (!this.streakTex) {
          const c = document.createElement("canvas");
          c.width = 64;
          c.height = 64;
          const g = c.getContext("2d");
          if (g) {
            // Bright at the sconce line (top), feathering down + out.
            const grad = g.createRadialGradient(32, 8, 0, 32, 8, 58);
            grad.addColorStop(0, "rgba(255,255,255,0.85)");
            grad.addColorStop(0.35, "rgba(255,255,255,0.32)");
            grad.addColorStop(0.75, "rgba(255,255,255,0.07)");
            grad.addColorStop(1, "rgba(255,255,255,0)");
            g.fillStyle = grad;
            g.fillRect(0, 0, 64, 64);
          }
          this.streakTex = new THREE.CanvasTexture(c);
        }
        this.streakGeo ??= new THREE.PlaneGeometry(0.62, 0.8);
        const streakC = new THREE.Color(theme.torchColor).lerp(new THREE.Color(0xfff2d8), 0.22);
        let si = 0;
        for (const sp of streakSpots) {
          const mat = new THREE.MeshBasicMaterial({
            map: this.streakTex, color: streakC, transparent: true, opacity: 0.2,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          });
          this.floorMats.push(mat);
          const m = new THREE.Mesh(this.streakGeo, mat);
          // Flush to the wall face (tiny inset so it never z-fights), light
          // pooling DOWN from the sconce line toward the floor.
          m.position.set(sp.x + sp.dx * 0.485, 0.58, sp.y + sp.dy * 0.485);
          m.rotation.y = Math.atan2(-sp.dx, -sp.dy);
          m.renderOrder = 2;
          this.floorGroup.add(m);
          const tile = Math.min(map.tiles.length - 1, Math.max(0, Math.floor(sp.y) * map.w + Math.floor(sp.x)));
          this.torchStreaks.push({ m, tile, seed: si * 2.3 + 0.7, baseOp: 0.16 + 0.08 * (((si * 37) % 10) / 10) });
          si++;
        }
      }
    }

    // BAKE the light/AO grid: wall-shadowed torch pools + junction AO +
    // contact shadows + macro grime + per-room stains (see lightGrid.ts).
    {
      const torchTint = new THREE.Color(theme.torchColor);
      // Tight pools (D2R): smaller radius, hotter core — every sconce owns a
      // carved pool with real overlap zones instead of five merging into one
      // room-wide wash.
      const lights: BakeLight[] = this.torchAnchors.map((a) => {
        // Pool intensity varies ±12% per sconce (matches the flame hue
        // variance above): overlapping pools get real bright/dim rhythm.
        const iv = 0.88 + 0.24 * (((Math.imul((a.seed * 53 + 3) | 0, 2654435761) >>> 10) % 1000) / 1000);
        return {
          x: a.x, y: a.y, r: openAir ? 4.0 : 3.4,
          color: { r: torchTint.r, g: torchTint.g, b: torchTint.b },
          intensity: theme.torchIntensity * 0.6 * iv,
        };
      });
      // The descent gate glows System gold.
      lights.push({
        x: map.stairs.x, y: map.stairs.y, r: 3.4,
        color: { r: 0.79, g: 0.64, b: 0.29 }, intensity: 0.85, jitter: false,
      });
      // Counter-color accent pools (envDressing accentGlows): the warm
      // cook-fire in the green sewers, the cool grave-light in the embers.
      lights.push(...envAccentLights);
      // Boss-arena ritual glow (issue #6) — baked, so it rims the arena even
      // before any dynamic light wakes up.
      lights.push(...arenaLights);
      const stains: BakeStain[] = [];
      for (const r of map.rooms) {
        const count = 2 + Math.floor(frng() * 3);
        for (let i = 0; i < count; i++) {
          stains.push({
            x: r.x + 1 + frng() * Math.max(1, r.w - 2),
            z: r.y + 1 + frng() * Math.max(1, r.h - 2),
            r: 0.7 + frng() * 1.3,
            s: 0.10 + frng() * 0.16,
          });
        }
      }
      // STORY GRIME (the D2R decal read, baked): a soot fan under every
      // sconce, traffic wear ground into every corridor tile, and a worn
      // threshold at each sealed door — the floor now records how this place
      // is used, instead of shipping showroom-pristine.
      for (const a of this.torchAnchors) {
        stains.push({ x: a.x, z: a.y, r: 0.8, s: 0.3 });
      }
      if (!openAir) {
        for (let sy = 1; sy < map.h - 1; sy++) {
          for (let sx = 1; sx < map.w - 1; sx++) {
            const si = sy * map.w + sx;
            if (map.tiles[si] === Tile.DoorLocked) {
              stains.push({ x: sx + 0.5, z: sy + 0.5, r: 1.5, s: 0.13 });
            } else if (map.tiles[si] === Tile.Floor && !roomMask[si]) {
              stains.push({ x: sx + 0.5, z: sy + 0.5, r: 0.85, s: 0.06 });
            }
          }
        }
      }
      this.lightGridTex?.dispose();
      this.lightGridTex = bakeLightGrid({
        w: map.w, h: map.h,
        isWall: (x, y) => map.tiles[y * map.w + x] === Tile.Wall,
        lights,
        stamps: blobSpots.map((b) => ({ x: b.x, z: b.z, r: b.r, s: 0.62 })),
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
    if (!this.heroLamp) {
      this.heroLamp = new THREE.PointLight(0xffd9a8, 0, 7.5, 2);
      this.scene.add(this.heroLamp);
    }
    // Warm counter-light vs the band's lamp hue: cool bands warm the hero,
    // warm bands stay neutral-warm — slightly stronger where lamps run cool.
    const tc = new THREE.Color(theme.torchColor);
    const lampWarm = tc.r > tc.g && tc.r > tc.b; // orange/amber lamp bands
    this.heroLamp.color.set(lampWarm ? 0xffe0b8 : 0xffd2a0);
    // r7 major (hero vanished against the f5 sewer floor): the hero's key is
    // a CONSTANT — strong enough that the crawler owns the warmest pixels of
    // any frame even between torch pools, in every band.
    this.heroLampBase = lampWarm ? 1.3 : 1.7;
    if (this.torchPool.length === 0) {
      // Preset-sized, built once (see applyQuality). Enough live lights that a
      // lit room's walls actually catch fire-light; the baked grid does the
      // rest, so the lower rungs can afford fewer without the room going flat.
      for (let i = 0; i < this.quality.torchLights; i++) {
        // Shorter throw than the theme default: each flame owns a tight hot
        // pool; the baked grid carries the wider (wall-shadowed) spill.
        const light = new THREE.PointLight(0xffffff, 0, THEME.torchDistance * 0.8, 2);
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
  /** Rebuild the walk-distance field (wall-aware visibility, issue #2):
   * label-correcting BFS from the player's tile over the walkable grid,
   * 8-connected (diagonals cost √2, no corner cutting); wall tiles take
   * min(adjacent floor)+0.7 so their lit faces match the corridor they face.
   * Encoded dist/32 tiles into the R8 texture the world-lit shader samples. */
  private bakeWalkDist(map: GameState["map"], px: number, pz: number): void {
    const d = this.wlDist;
    if (!d) return;
    const { w, h } = map;
    const tiles = map.tiles;
    const { field, queue, data } = d;
    field.fill(Infinity);
    const sx = Math.max(0, Math.min(w - 1, Math.floor(px)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(pz)));
    const start = sy * w + sx;
    field[start] = 0;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    const cap = queue.length;
    while (head !== tail) {
      const i = queue[head++ % cap];
      if (head > cap * 4) break; // safety: pathological re-expansion
      const base = field[i];
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (tiles[ni] === Tile.Wall) continue;
          // No diagonal corner cutting past a wall.
          if (dx !== 0 && dy !== 0 && (tiles[y * w + nx] === Tile.Wall || tiles[ny * w + x] === Tile.Wall)) continue;
          const nd = base + (dx !== 0 && dy !== 0 ? 1.41421356 : 1);
          if (nd < field[ni] - 1e-4) {
            field[ni] = nd;
            queue[tail++ % cap] = ni;
            if (tail - head >= cap) { head = tail; break; } // overflow guard
          }
        }
      }
    }
    // Wall tiles read the corridor beside them (+0.7), so lit wall faces
    // darken with the room they bound, not the room behind them.
    for (let i = 0; i < field.length; i++) {
      let v = field[i];
      if (tiles[i] === Tile.Wall) {
        const x = i % w;
        const y = (i / w) | 0;
        v = Infinity;
        if (x > 0) v = Math.min(v, field[i - 1]);
        if (x < w - 1) v = Math.min(v, field[i + 1]);
        if (y > 0) v = Math.min(v, field[i - w]);
        if (y < h - 1) v = Math.min(v, field[i + w]);
        v += 0.7;
      }
      data[i] = v === Infinity ? 255 : Math.min(255, Math.round((v / 32) * 255));
    }
    d.tex.needsUpdate = true;
  }

  private updateFogTint(state: GameState, px: number, pz: number): void {
    const { map } = state;
    this.wl.uWlPlayer.value.set(px, pz);
    if (this.wlDist) {
      const tile =
        Math.max(0, Math.min(map.h - 1, Math.floor(pz))) * map.w +
        Math.max(0, Math.min(map.w - 1, Math.floor(px)));
      if (tile !== this.wlDist.lastTile && this.wlDist.data.length === map.w * map.h) {
        this.wlDist.lastTile = tile;
        this.bakeWalkDist(map, px, pz);
      }
    }
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
    const pal = FX_PAL.airstrike;
    // Impacts: the count dropped — detonate at the previous positions that
    // landed. Full impact recipe (audit r3): violet 3-layer flash, sparks,
    // embers, smoke, shock ring, long scorch decal, debris star, light.
    if (strikes.length < this.prevStrikeCount) {
      for (const pos of this.prevStrikePos.slice(strikes.length)) {
        // Claim the spot FIRST: per-victim hit events landing this same frame
        // must not re-stack their own flashes on top of the detonation.
        this.claimFlash(pos.x, pos.y);
        this.fxp.flash3(pos.x, 0.7, pos.y, pal, 1.5);
        // AIRSTRIKE IDENTITY: a violet vertical column out of the impact —
        // ordnance reads as "something came DOWN here", not a generic puff.
        this.fxp.column(pos.x, pos.y, pal.mid, 10, 2.4);
        this.fxp.sparks(pos.x, 0.6, pos.y, pal.mid, 18);
        this.fxp.embers(pos.x, pos.y, pal.mid, 12, CONFIG.ultAirstrikeRadius * 0.7);
        this.fxp.smoke(pos.x, 0.5, pos.y, 5, 0x28222f);
        this.shocks.spawn(pos.x, pos.y, pal.mid, CONFIG.ultAirstrikeRadius, 0.5);
        this.decals.spawn(pos.x, pos.y, CONFIG.ultAirstrikeRadius * 0.55, 0x120a18, pal.rim, 9);
        // Debris ring under the impact: the crater the shell leaves behind.
        this.spawnFadeProp("fx_blast_star", pos.x, 0.04, pos.y, CONFIG.ultAirstrikeRadius * 0.8, 0.4,
          { tint: pal.mid, spin: 0.6, grow: 1.6, footprint: true, pop: true });
        this.addTrauma(0.45); // sponsor ordnance lands with authority
        this.spawnFxLight(pos.x, pos.y, pal.mid, 4.5, 0.5, 1.0);
      }
    }
    this.prevStrikeCount = strikes.length;
    // In-place refresh (GC sweep): the old strikes.map() minted a new array +
    // objects every frame, combat or not.
    this.prevStrikePos.length = strikes.length;
    for (let i = 0; i < strikes.length; i++) {
      const e = this.prevStrikePos[i] ?? (this.prevStrikePos[i] = { x: 0, y: 0 });
      e.x = strikes[i].pos.x;
      e.y = strikes[i].pos.y;
    }
    for (let i = 0; i < Math.max(this.strikeMeshes.length, strikes.length); i++) {
      const s = strikes[i];
      let mesh = this.strikeMeshes[i];
      const mark = this.strikeMarks[i];
      if (!s) {
        if (mesh) mesh.visible = false;
        if (mark) mark.visible = false;
        this.ribbons.release(-4000 - i); // trail fades out where the shell died
        continue;
      }
      const kind = s.kind ?? "shell";
      if (!mesh || mesh.userData.strikeKind !== kind) {
        // Kind-aware pool: an Aftermath echo is a ground pulse, not falling
        // sponsor ordnance — it must never render as the airstrike keg.
        if (mesh) this.scene.remove(mesh);
        if (kind === "echo") {
          mesh = this.buildFxRing("cataclysm");
          this.scene.remove(mesh); // buildFxRing adds; re-add via the pool below
        } else {
          // Real sponsor ordnance: SMALL, hot, and clearly a warhead — the
          // shell reads by its emissive glow + motion streak, not by bulk.
          mesh = this.modelInstance("sponsor_shell") ?? this.modelInstance("keg") ?? new THREE.Mesh(
            new THREE.ConeGeometry(0.18, 0.5, 6), flat(0xb0742c, { emissive: 0x662200, emissiveIntensity: 0.4 }));
          mesh.scale.multiplyScalar(0.34);
          mesh.traverse((o) => {
            const mm2 = o as THREE.Mesh;
            if (!mm2.isMesh) return;
            const m2 = (mm2.material as THREE.MeshStandardMaterial);
            if (!m2.isMeshStandardMaterial) return;
            const c2 = m2.clone();
            c2.emissive = new THREE.Color(pal.rim);
            c2.emissiveIntensity = 0.9;
            mm2.material = c2;
          });
          mesh.add(this.makeGlow(pal.mid, 1.5)); // hot warhead halo (parent-scaled)
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
        // Motion-stretched streak + smoke/ember wake behind the shell.
        const rid = -4000 - i;
        this.ribbons.claim(rid, pal.mid, 0.16);
        this.ribbons.push(rid, mesh.position.x, mesh.position.y, mesh.position.z);
        const lastT = (mesh.userData.trailT as number) ?? -1;
        if (this.prevTime - lastT > 0.06 && mesh.position.y < 30) {
          mesh.userData.trailT = this.prevTime;
          this.fxp.spawn({
            x: mesh.position.x, y: mesh.position.y + 0.25, z: mesh.position.z,
            vy: 0.7, life: 0.4, size0: 0.18, size1: 0.06,
            col0: pal.mid, col1: pal.rim, dim: 0.7,
          });
          this.fxp.smoke(mesh.position.x, mesh.position.y + 0.5, mesh.position.z, 1, 0x241f2e);
        }
        // ANTICIPATION SHADOW (audit r3): the drop zone is telegraphed on the
        // ground — an arming disc that fills as the shell closes in.
        let mk = this.strikeMarks[i];
        if (!mk) {
          mk = new THREE.Mesh(TELEGRAPH_GEO, makeTelegraphMat());
          mk.renderOrder = 6;
          mk.userData.noAO = true;
          this.scene.add(mk);
          this.strikeMarks[i] = mk;
        }
        mk.visible = true;
        mk.position.set(s.pos.x, 0.055, s.pos.y);
        mk.scale.setScalar(CONFIG.ultAirstrikeRadius);
        const mm = mk.material as THREE.ShaderMaterial;
        (mm.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
        mm.uniforms.uProg.value = Math.min(1, Math.max(0, 1 - s.t / 0.9));
        mm.uniforms.uTime.value = this.prevTime + i * 0.61;
      }
      if (kind === "echo" && this.strikeMarks[i]) this.strikeMarks[i].visible = false;
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
    const seen = this.scratchSet();
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

  // ---- ABILITIES-V2 verbs: every new press gets a read of its own ----
  // The rule here is the one the FX round set and the design doc restates:
  // the player names what happened in 0.2s. So no new verb borrows an
  // existing silhouette. Bulwark is a CLOSED VOLUME (nothing else in the FX
  // vocabulary is a shell you stand inside). Stage Cables is a pair of TAUT
  // LINES at knee height between two driven stakes -- the only FX in the game
  // with visible tension. Injunction stamps a COURT SEAL on the floor and
  // leaves the room lit red for as long as you owe for it. And Collapse's
  // gather runs the vortex INWARD a beat before its own blast runs outward,
  // so the rework (R1: it is a gather now, not an AoE) is legible from the
  // cockpit instead of only in the patch notes.
  private braceShells = new Map<number, THREE.Group>();
  private stayRigs = new Map<number, THREE.Group>();
  private cableRigs = new Map<number, THREE.Group>();
  private prevBulwarkT = new Map<number, number>();
  private prevBulwarkAbs = new Map<number, number>();
  private prevInjT = new Map<number, number>();
  private prevNovaCd = new Map<number, number>();
  private prevHurlT = new Map<number, number>();

  /** BULWARK's brace: a faceted plate shell + a bright ground seam. Built
   * from EDGES rather than a wireframe on purpose -- seams read as armor, a
   * wireframe reads as the debug gizmo the r6 zone pass was called out for. */
  private buildBraceShell(): THREE.Group {
    const g = new THREE.Group();
    const pal = FX_PAL.brace;
    // Detail 0, not 1: twenty big faces read as PLATES, eighty small ones read
    // as a wireframe sphere, and a wireframe sphere is a debug gizmo.
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: pal.rim, transparent: true, opacity: 0.3, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    const seams = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 12),
      new THREE.LineBasicMaterial({
        color: pal.mid, transparent: true, opacity: 0.75, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const foot = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 44).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: pal.core, transparent: true, opacity: 0.8, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    foot.position.y = -0.52;
    g.add(dome, seams, foot);
    g.userData = { dome, seams, foot };
    g.renderOrder = 6;
    g.traverse((o) => { o.userData.noAO = true; });
    return g;
  }

  /** INJUNCTION's stay: the seal the System stamps on the floor, and the
   * writ ring counter-rotating over it. Both live only while the clock is
   * held, because the whole ultimate is "you are paying for this right now". */
  private buildStayRig(): THREE.Group {
    const g = new THREE.Group();
    const pal = FX_PAL.stay;
    const mat = (hex: number, op: number) => new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: op, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const seal = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.55, 56).rotateX(-Math.PI / 2), mat(pal.mid, 0.7));
    seal.position.y = 0.05;
    const inner = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.4, 40).rotateX(-Math.PI / 2), mat(pal.core, 0.55));
    inner.position.y = 0.05;
    // Eight ticks, not twenty-four: a dense ring reads as texture, a sparse
    // one reads as a MECHANISM -- and this ultimate is a mechanism with a
    // bill attached.
    const ticks = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const t = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.16).rotateX(-Math.PI / 2), mat(pal.core, 0.8));
      const a = (i / 8) * Math.PI * 2;
      t.position.set(Math.cos(a) * 1.85, 0.06, Math.sin(a) * 1.85);
      t.rotation.y = -a;
      ticks.add(t);
    }
    g.add(seal, inner, ticks);
    g.userData = { seal, inner, ticks };
    g.traverse((o) => { o.userData.noAO = true; o.renderOrder = 6; });
    return g;
  }


  /**
   * The per-monster PIN tell (V2 N2). Every comparable game gives a root a
   * per-unit mark -- LoL's shackles, PoE2's immobilise ring -- because a body
   * standing still is not a read: half the room is standing still anyway.
   *
   * Deliberately a HARD SHACKLE and not a soft halo: a taut ground ring with
   * four bracket posts standing on it, in rigging teal. Stagger is a grey,
   * squashed, animating body with nothing on the floor; a chilled body wears
   * statusRings' soft pulse. This is neither, because "the pin is control, not
   * a stun" is only a design statement if the two read differently.
   */
  private buildPinCage(): THREE.Group {
    const g = new THREE.Group();
    const pal = FX_PAL.pin;
    const mat = (hex: number, op: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: op, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // The taut line on the floor: thin and hard-edged, not a bloom.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.95, 32).rotateX(-Math.PI / 2), mat(pal.mid, 0.8));
    ring.position.y = 0.03;
    g.add(ring);
    // Four posts: the shackle itself, standing up out of the ring so the mark
    // survives a crowded floor from the game's camera angle.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const post = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.5), mat(pal.core, 0.85));
      post.position.set(Math.cos(a) * 0.88, 0.25, Math.sin(a) * 0.88);
      post.rotation.y = -a + Math.PI / 2;
      g.add(post);
    }
    g.traverse((o) => { o.userData.noAO = true; o.renderOrder = 7; });
    return g;
  }

  /** STAGE CABLES: two driven stakes and the lines between them. The cables
   * are real geometry at knee height (not a ground decal) because the whole
   * ability is "nothing crosses this" -- a floor tint cannot say that. */
  private buildCableRig(): THREE.Group {
    const g = new THREE.Group();
    const pal = FX_PAL.pin;
    const steel = new THREE.MeshStandardMaterial({
      color: 0x39424a, emissive: new THREE.Color(pal.mid), emissiveIntensity: 1.1,
      roughness: 0.5, metalness: 0.7,
    });
    const stakeGeo = new THREE.CylinderGeometry(0.11, 0.14, 1.1, 6);
    const a = new THREE.Mesh(stakeGeo, steel);
    const b = new THREE.Mesh(stakeGeo, steel);
    a.castShadow = b.castShadow = true;
    const lineMat = new THREE.MeshBasicMaterial({
      color: pal.mid, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Unit-length boxes along +X, scaled to the span each frame.
    const hi = new THREE.Mesh(new THREE.BoxGeometry(1, 0.075, 0.075), lineMat);
    const lo = new THREE.Mesh(new THREE.BoxGeometry(1, 0.075, 0.075), lineMat);
    const field = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), makeLaneMat());
    (field.material as THREE.ShaderMaterial).uniforms.uColor.value = new THREE.Color(pal.rim);
    field.position.y = 0.05;
    field.userData.noAO = true;
    field.renderOrder = 4;
    g.add(a, b, hi, lo, field);
    g.userData = { a, b, hi, lo, field, mat: lineMat };
    return g;
  }

  /**
   * Everything ABILITIES-V2 added that the world has to show: the brace, the
   * stay, the gather, and the hurled ring leaving home. Reconciled by player
   * id, torn down the frame the state field goes quiet.
   */
  private updateV2Fx(state: GameState, dt: number, time: number): void {
    const alive = this.scratchSet();
    for (const p of state.players) {
      alive.add(p.id);
      // ---- BULWARK: the brace ----
      const bt = p.bulwarkT ?? 0;
      const prevBt = this.prevBulwarkT.get(p.id) ?? 0;
      const bpal = FX_PAL.brace;
      if (bt > 0) {
        let shell = this.braceShells.get(p.id);
        if (!shell) {
          shell = this.buildBraceShell();
          this.scene.add(shell);
          this.braceShells.set(p.id, shell);
        }
        // Dig In widens the cover to the whole party; the shell has to BE the
        // covered area or the node is a lie the tooltip tells.
        const cover = Math.max(1.15, bulwarkParams(p).allyRadius || 1.15);
        const pulse = 0.9 + 0.1 * Math.sin(time * 9);
        shell.position.set(p.pos.x, 1.0, p.pos.y);
        shell.scale.set(cover * pulse, cover * 0.72 * pulse, cover * pulse);
        shell.rotation.y = time * 0.35;
        const ud = shell.userData as { dome: THREE.Mesh; seams: THREE.LineSegments; foot: THREE.Mesh };
        // The shell BRIGHTENS as the brace runs out: the last half-second is
        // the counterplay window, and the AI is not the only one reading it.
        const spent = 1 - Math.min(1, bt / Math.max(CONFIG.bulwarkSeconds, 1e-3));
        (ud.dome.material as THREE.MeshBasicMaterial).opacity = 0.26 + 0.18 * spent;
        (ud.seams.material as THREE.LineBasicMaterial).opacity = 0.6 + 0.35 * spent;
        (ud.foot.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * Math.abs(Math.sin(time * 6));
        shell.visible = true;
        if (prevBt <= 0) {
          this.fxp.impactFlash(p.pos.x, 1.0, p.pos.y, bpal.core, 1.2);
          this.fxp.gatherBurst(p.pos.x, 1.0, p.pos.y, bpal.mid);
          this.fxp.dust(p.pos.x, 0.1, p.pos.y, 8, 0x4a4438);
          this.spawnFxLight(p.pos.x, p.pos.y, bpal.mid, 3.2, 0.3, 1.0);
          this.addTrauma(0.1);
        }
        const abs = p.bulwarkAbsorbed ?? 0;
        if (abs > (this.prevBulwarkAbs.get(p.id) ?? 0) + 0.5) {
          this.fxp.sparks(p.pos.x, 1.1, p.pos.y, bpal.core, 7);
          (ud.seams.material as THREE.LineBasicMaterial).opacity = 1;
        }
        this.prevBulwarkAbs.set(p.id, abs);
      } else {
        const shell = this.braceShells.get(p.id);
        if (shell) { this.scene.remove(shell); this.braceShells.delete(p.id); }
        if (prevBt > 0) {
          // Expiry pays out three different ways, so it reads three different
          // ways: SPITE banks a red-hot charge, Shove throws the room off you,
          // the plain brace heals.
          const params = bulwarkParams(p);
          if (params.shove) {
            this.shocks.spawn(p.pos.x, p.pos.y, bpal.core, CONFIG.bulwarkShoveRadius * 1.15, 0.4);
            this.fxp.radialStreaks(p.pos.x, 0.7, p.pos.y, bpal.mid, 18, CONFIG.bulwarkShoveRadius);
            this.fxp.dust(p.pos.x, 0.15, p.pos.y, 14, 0x4a4438);
            this.addTrauma(0.3);
          }
          if (params.spite && (p.spiteBank ?? 0) > 0) {
            this.fxp.flash3(p.pos.x, 1.0, p.pos.y, FX_PAL.strike, 1.0);
            this.fxp.embers(p.pos.x, p.pos.y, FX_PAL.strike.mid, 9, 0.7);
          } else {
            this.fxp.column(p.pos.x, p.pos.y, FX_PAL.heal.mid, 7, 1.8);
          }
          this.spawnFxLight(p.pos.x, p.pos.y,
            params.spite ? FX_PAL.strike.mid : FX_PAL.heal.mid, 3.5, 0.35, 1.0);
        }
        this.prevBulwarkAbs.delete(p.id);
      }
      this.prevBulwarkT.set(p.id, bt);

      // ---- INJUNCTION: the stay ----
      const it = p.injunctionT ?? 0;
      const prevIt = this.prevInjT.get(p.id) ?? 0;
      const spal = FX_PAL.stay;
      if (it > 0) {
        let rig = this.stayRigs.get(p.id);
        if (!rig) { rig = this.buildStayRig(); this.scene.add(rig); this.stayRigs.set(p.id, rig); }
        rig.position.set(p.pos.x, 0, p.pos.y);
        const rud = rig.userData as { seal: THREE.Mesh; inner: THREE.Mesh; ticks: THREE.Group };
        rud.seal.rotation.y = time * 0.5;
        rud.ticks.rotation.y = -time * 0.8;
        const beat = 0.55 + 0.45 * Math.abs(Math.sin(time * 2.2));
        (rud.seal.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.35 * beat;
        (rud.inner.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.3 * beat;
        rig.visible = true;
        if (prevIt <= 0) {
          // The loudest cast in the game, on purpose: the design asks the
          // biggest ultimate to carry the biggest counterplay window, and the
          // whole floor was just told it has one.
          this.fxp.flash3(p.pos.x, 0.8, p.pos.y, spal, 2.0);
          this.fxp.column(p.pos.x, p.pos.y, spal.mid, 14, 3.2);
          this.shocks.spawn(p.pos.x, p.pos.y, spal.mid, 7, 0.6);
          this.fxp.radialStreaks(p.pos.x, 0.6, p.pos.y, spal.core, 22, 5.5);
          this.spawnFxLight(p.pos.x, p.pos.y, spal.mid, 7, 0.7, 1.2);
          this.addTrauma(0.55);
        }
        // The bodies that were told smoulder for the duration, so the price of
        // the ultimate is visible on the things that will be collecting it.
        if (Math.random() < dt * 9) {
          let lit: Monster | null = null;
          let n = 0;
          for (const m of state.monsters) {
            if (m.hp <= 0 || (m.injRageT ?? 0) <= 0) continue;
            n++;
            if (Math.random() < 1 / n) lit = m; // reservoir pick: no array churn
          }
          if (lit) this.fxp.embers(lit.pos.x, lit.pos.y, spal.mid, 2, 0.35);
        }
      } else {
        const rig = this.stayRigs.get(p.id);
        if (rig) { this.scene.remove(rig); this.stayRigs.delete(p.id); }
        if (prevIt > 0) {
          // Release: the debt comes due, and it comes due INWARD -- the seal
          // collapses onto the crawler rather than blooming off them.
          this.fxp.vortex(p.pos.x, p.pos.y, spal.mid, 4.5);
          this.fxp.impactFlash(p.pos.x, 0.7, p.pos.y, spal.rim, 1.6);
          this.spawnFxLight(p.pos.x, p.pos.y, spal.rim, 4, 0.4, 1.0);
          this.addTrauma(0.3);
        }
      }
      this.prevInjT.set(p.id, it);

      // ---- COLLAPSE: the GATHER, a beat before its own blast ----
      // R1 moved this ability's whole case from "it multiplies by N" to "it
      // MAKES N". An invisible pull means the rework never reaches the player,
      // so it takes its own hue and its own direction of travel.
      const ncd = p.cd.nova ?? 0;
      if (ncd > (this.prevNovaCd.get(p.id) ?? 0) + 1e-6) {
        const np = novaParams(p);
        const pull = FX_PAL.pull;
        this.fxp.vortex(p.pos.x, p.pos.y, pull.mid, np.gatherRadius);
        this.fxp.vortex(p.pos.x, p.pos.y, pull.core, np.gatherRadius * 0.75);
        this.fxp.vortex(p.pos.x, p.pos.y, pull.mid, np.gatherRadius * 0.5);
        this.fxp.gather(p.pos.x, 0.8, p.pos.y, pull.mid, 1);
        // The LANDING RING: bodies that get dragged end up on novaGatherRing,
        // and marking exactly that circle is what turns "some particles moved"
        // into "the room is now standing here". Small and tight on purpose --
        // an inward cast must not out-bloom its own detonation.
        this.fxp.impactFlash(p.pos.x, 0.6, p.pos.y, pull.core, 1.1);
        this.shocks.spawn(p.pos.x, p.pos.y, pull.mid, CONFIG.novaGatherRing, 0.22);
        this.spawnFxLight(p.pos.x, p.pos.y, pull.mid, 3.5, 0.3, 0.9);
        // Kick dust off the bodies the drag actually moved. The sim counted
        // them, so the FX can never claim a gather that did not happen.
        if ((state.gatheredLast ?? 0) > 0) {
          for (const m of state.monsters) {
            if (m.hp <= 0) continue;
            const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y;
            if (dx * dx + dy * dy > np.gatherRadius * np.gatherRadius) continue;
            this.fxp.dust(m.pos.x, 0.12, m.pos.y, 3, 0x4a4438);
          }
        }
      }
      this.prevNovaCd.set(p.id, ncd);

      // ---- ORBIT: the ring leaves home ----
      // Four small daggers sliding across a dark floor is not a read. The
      // travelling SAW is: one ribbon down the flight line, a hot core riding
      // it, and grinding sparks -- so the thing that just left your body is
      // the brightest object on screen, which is the point of R3.
      const ht = p.orbitHurlT ?? 0;
      const hurl = orbitHurlPoint(p);
      const RIB = -7000 - p.id;
      if (ht > 0 && (this.prevHurlT.get(p.id) ?? 0) <= 0) {
        this.fxp.sparks(p.pos.x, 0.8, p.pos.y, 0x9fe8ff, 9, p.orbitHurlDir);
        this.fxp.impactFlash(p.pos.x, 0.8, p.pos.y, 0xd8f6ff, 0.8);
        this.ribbons.claim(RIB, 0x9fe8ff, 0.34);
      }
      if (hurl) {
        this.ribbons.push(RIB, hurl.x, 0.62, hurl.y);
        this.spawnGlow(hurl.x, 0.62, hurl.y, hurl.back ? 0xd8f6ff : 0x9fe8ff, 1.1, 0.16);
        if (Math.random() < dt * 34) this.fxp.sparks(hurl.x, 0.6, hurl.y, 0xd8f6ff, 2);
      } else if (ht <= 0 && (this.prevHurlT.get(p.id) ?? 0) > 0) {
        this.ribbons.release(RIB);
        this.fxp.impactFlash(p.pos.x, 0.75, p.pos.y, 0xd8f6ff, 0.7); // it comes home
      }
      this.prevHurlT.set(p.id, ht);
    }
    for (const [id, shell] of this.braceShells) {
      if (!alive.has(id)) { this.scene.remove(shell); this.braceShells.delete(id); }
    }
    for (const [id, rig] of this.stayRigs) {
      if (!alive.has(id)) { this.scene.remove(rig); this.stayRigs.delete(id); }
    }
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
        // THE HURL (V2 R3): while the ring is away there is no aura, and the
        // player has to be able to SEE that they spent their bodyguard. So the
        // blades physically leave -- tightened into a saw around the travelling
        // point, spinning hot -- and the space around the crawler reads empty.

        const hurl = orbitHurlPoint(p);
        for (let i = 0; i < blades.length; i++) {
          // Shared with the sim's hit test (incl. Corkscrew spiral radii) AND
          // with the 2D host: orbitBladePos returns the travelling saw while
          // the ring is away, so no renderer can draw a calm orbit during the
          // throw again.
          const bp = orbitBladePos(p, i);
          const cx = hurl ? hurl.x : p.pos.x;
          const cy = hurl ? hurl.y : p.pos.y;
          blades[i].position.set(bp.x, hurl ? 0.62 : 0.75, bp.y);
          // Nose along the direction of travel (tangent to whatever it circles).
          blades[i].rotation.y = -Math.atan2(bp.y - cy, bp.x - cx);
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
          const radius0 = ring.userData.radius as number;
          const pal = kind === "cataclysm" ? FX_PAL.cataclysm : FX_PAL.nova;
          // IMPLOSION capstone: a collapsing spiral of stretched motes drags
          // inward a beat before the shockwave reads outward (the old milky
          // cone mesh read as an untextured placeholder — audit r3 blocker).
          if (kind === "nova" && rank(p, "nova.implode") > 0) {
            this.fxp.vortex(p.pos.x, p.pos.y, FX_PAL.frost.mid, radius0 * 0.8);
          }
          // AUTHORED BLAST STACK (audit r3): 3-layer hue flash at the caster,
          // gravity sparks + rising embers over the blast radius, a drifting
          // smoke ring, a ground shock ring, and a fading scorch — replaces
          // the shapeless white glow-puff cloud.
          this.claimFlash(p.pos.x, p.pos.y); // per-victim hits ride this blast
          this.fxp.flash3(p.pos.x, 0.7, p.pos.y, pal, kind === "cataclysm" ? 1.7 : 1.3);
          // NOVA IDENTITY: radial slash-streaks at blade height — the ult
          // reads as a ring of arcs sweeping outward, not a bloom puff.
          this.fxp.radialStreaks(p.pos.x, 0.8, p.pos.y, pal.mid,
            kind === "cataclysm" ? 12 : 9, radius0 * 0.9);
          this.fxp.sparks(p.pos.x, 0.6, p.pos.y, pal.mid, kind === "cataclysm" ? 24 : 16);
          this.fxp.embers(p.pos.x, p.pos.y, pal.mid, kind === "cataclysm" ? 20 : 13, radius0 * 0.75);
          // Sooty wisps + a floor-ambient dust slap (the old 3-5 lifted-gray
          // puffs pooled into an ambiguous pale lobe under the blast).
          this.fxp.smoke(p.pos.x, 0.5, p.pos.y, kind === "cataclysm" ? 3 : 2, 0x2e2820);
          this.fxp.dust(p.pos.x, 0.2, p.pos.y, 4, this.dustTint);
          this.shocks.spawn(p.pos.x, p.pos.y, pal.mid, radius0, kind === "cataclysm" ? 0.55 : 0.45);
          this.decals.spawn(p.pos.x, p.pos.y, radius0 * 0.5, 0x141008, pal.rim, 9);
          // Layered secondary: the crown's blast kicks up a debris ring too.
          if (kind === "cataclysm") {
            this.spawnFadeProp("fx_blast_star", p.pos.x, 0.03, p.pos.y,
              radius0 * 0.55, 0.45,
              { tint: pal.mid, spin: 0.8, grow: 1.4, footprint: true });
          }
          this.addTrauma(kind === "cataclysm" ? 0.45 : 0.3);
          // The blast lights the arena: pooled FX light with a decay envelope.
          // Peaks kept under the washout line — the ring + embers carry scale.
          this.spawnFxLight(p.pos.x, p.pos.y, pal.mid,
            kind === "cataclysm" ? 5 : 3.5, kind === "cataclysm" ? 0.55 : 0.4, 1.0);
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
        const ringS = ((ring!.userData.baseScale as number) ?? 1) * Math.max(0.05, radius * eased);
        // Generated ring meshes can be TALL — clamp world height so the
        // shockwave hugs the ground instead of ballooning over the fight.
        if (ring!.userData.model) ring!.scale.set(ringS, Math.min(ringS * 0.3, 1.3), ringS);
        else ring!.scale.setScalar(ringS);
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

  // GC SWEEP (perf round): the reconcile loops below each need a "seen ids"
  // set per frame. They draw from this pool (index reset at the top of
  // update(); call order is stable frame to frame) instead of allocating a
  // dozen fresh Sets every frame.
  private setPool: Set<number>[] = [];
  private setPoolI = 0;
  private scratchSet(): Set<number> {
    let s = this.setPool[this.setPoolI];
    if (!s) {
      s = new Set();
      this.setPool[this.setPoolI] = s;
    }
    this.setPoolI++;
    s.clear();
    return s;
  }

  /**
   * BOSSES V2 §7.4 — consume the sim's typed boss beats. The host buffers
   * them across sub-steps (exactly like hits) and hands them over BEFORE
   * update(), so a phase edge stages in the same frame it happened in.
   */
  bossEvents(events: BossEvent[]): void {
    for (const e of events) this.bossFx.beat(e);
  }

  /** Seconds of hit-stop the boss layer wants this frame (§5.5/§5.7). */
  get bossSlowmo(): number { return this.bossFx.slowmo; }

  /** §5.7 — draw the ringside loot arc from the corpse to where a drop landed. */
  /** Capture hold (tools/bossshot.mjs): keep live boss rigs up for `seconds`. */
  holdBossBeats(seconds: number): void { this.bossFx.hold(seconds); }

  bossLootArc(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
    this.bossFx.lootArc(fromX, fromZ, toX, toZ, hex);
  }

  update(state: GameState, time: number): void {
    this.setPoolI = 0;
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
    const pSeen = this.scratchSet();
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
        if (pl.alive && pl.attackSwing > prevSw + 1e-6) this.spawnMeleeTrail(mesh, pl.id);
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
    const dSeen = this.scratchSet();
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

    // THE GHOST, IN THE ROOM. Same body as the crawler it came from, drained of
    // colour and half there: it has to read as a rival at a glance and never as
    // something you can hit. It renders only while it shares your floor - a
    // rival two floors down is information for the rail chip, not a marker
    // floating through a wall.
    {
      const gp = this.ghostPose;
      if (gp && gp.onFloor) {
        const skin = Renderer3D.skinIdFor(p, state.seed);
        if (this.ghostMesh && this.ghostSkin !== skin) {
          this.scene.remove(this.ghostMesh);
          this.ghostMesh = null;
        }
        if (!this.ghostMesh) {
          const mesh = this.buildPlayerMesh(skin);
          mesh.traverse((o) => {
            const mm = o as THREE.Mesh;
            if (!mm.isMesh || !mm.material) return;
            const mats = (Array.isArray(mm.material) ? mm.material : [mm.material]).map((mat) => {
              const g = mat.clone() as THREE.MeshStandardMaterial;
              g.transparent = true;
              g.opacity = 0.45;
              g.depthWrite = false; // a see-through body must not punch the depth buffer
              if (g.color) {
                // Desaturate to its own luminance, then pull it cold. A grey
                // crawler in a warm torchlit dungeon reads as "not really here"
                // without needing an outline shader.
                const l = g.color.r * 0.299 + g.color.g * 0.587 + g.color.b * 0.114;
                g.color.setRGB(l * 0.72, l * 0.78, l * 0.92);
              }
              if (g.emissive) g.emissive.setRGB(0.05, 0.07, 0.11);
              if (g.map !== undefined) g.metalness = 0;
              g.roughness = 1;
              return g;
            });
            mm.material = Array.isArray(mm.material) ? mats : mats[0];
            mm.castShadow = false;
            mm.receiveShadow = false;
          });
          (mesh.userData.play as ((n: string) => void) | undefined)?.("run");
          // A GROUND MARKER, because a 34%-opacity cold body in a torchlit
          // room reads as a lighting artifact. The ring is the cue that says
          // "something is standing there" from across an arena; the projected
          // nameplate (main3d: updateGhostPlate) says WHO.
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.42, 0.56, 40).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({
              color: 0x8fc0e8, transparent: true, opacity: 0.5,
              depthWrite: false, side: THREE.DoubleSide,
            }),
          );
          ring.position.y = 0.03;
          ring.renderOrder = 2;
          mesh.add(ring);
          mesh.position.set(gp.x, 0, gp.y);
          this.scene.add(mesh);
          this.ghostMesh = mesh;
          this.ghostSkin = skin;
        }
        const gm = this.ghostMesh;
        const dx = gp.x - gm.position.x, dz = gp.y - gm.position.z;
        if (dx * dx + dz * dz > 4e-4) this.turnTo(gm, Math.atan2(dx, dz), dt);
        this.smoothTo(gm, gp.x, 0, gp.y, dt);
        gm.visible = true;
        (gm.userData.animTick as ((d: number) => void) | undefined)?.(dt);
      } else if (this.ghostMesh) {
        this.ghostMesh.visible = false;
      }
    }

    // SMASHABLES (phase 5): the plan's corner hoards as hittable entities.
    // Meshes are placed once (they don't move); a smashed one vanishes and
    // the sim's hit event supplies the pop. DAMAGED STATE (furniture-feel):
    // blocking furniture at 1 hp LOOKS one hit from gone — the table swaps
    // to the kit's broken model, everything else tilts and sinks. The hp
    // edge just drops the mesh; the next frame rebuilds it damaged.
    const bSeen = this.scratchSet();
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
        const asset = BREAKABLE_MODEL[b.key] ?? b.key;
        const obj = this.modelInstance(swap && this.models[swap] ? swap : asset);
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

    // BOSSES V2 §5 — the encounter's persistent rigs (plates, shield shells,
    // tether cords, punish beacons) reconcile here, one pass, sharing the
    // same fog gate every other entity uses. Everything else about the boss
    // layer is edge-triggered off state.bossEvents.
    this.bossFx.update(state, dt, time, (m: Monster) => inVision(m.pos));

    // Roam settlement residents: id-keyed mesh pool over the full roster
    // (state.npcs; v1 snapshots only carried the singular state.npc).
    {
      const npcs = state.npcs ?? (state.npc ? [state.npc] : []);
      const seen = this.scratchSet();
      for (const n of npcs) {
        seen.add(n.id);
        let mesh = this.npcMeshes.get(n.id);
        if (!mesh) {
          mesh = this.buildNpcMesh();
          this.scene.add(mesh);
          this.npcMeshes.set(n.id, mesh);
        }
        mesh.position.set(n.pos.x, 0, n.pos.y);
        mesh.visible = inVision(n.pos);
      }
      for (const [id, mesh] of this.npcMeshes) {
        if (!seen.has(id)) {
          this.scene.remove(mesh);
          this.npcMeshes.delete(id);
        }
      }
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
      // Soft collision vs the HERO: overlapping mobs yield display-space
      // ground around each player, so the crowd rings the crawler instead of
      // clipping through the body (offset applied to the monster mesh only —
      // the player mesh is the camera anchor and never shifts).
      for (const plS of state.players) {
        if (!plS.alive) continue;
        for (const b of live) {
          if (b.dormant) continue;
          const rr = 0.34 * (THEME.archetype[b.kind]?.scale ?? 1) + 0.4;
          let dx = b.pos.x - plS.pos.x;
          let dz = b.pos.y - plS.pos.y;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) { dx = Math.sin(b.id * 2.3); dz = Math.cos(b.id * 2.3); d = 1; }
          const push = Math.min(0.45, (rr - d) * 0.8);
          const tb = sepTargets.get(b.id) ?? { x: 0, z: 0 };
          tb.x += (dx / d) * push;
          tb.z += (dz / d) * push;
          sepTargets.set(b.id, tb);
        }
      }
    }

    const sepEase = 1 - Math.exp(-10 * dt);
    this.flashCloneBudget = 4; // see applyHitFlash: Injunction enrages a FLOOR
    const seen = this.scratchSet();
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
          mesh.userData.isElite = true; // death gets the big-beat staging
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
      // Enraged bodies burn for the duration (see applyHitFlash). Pulsed and
      // phase-offset per monster so a full room reads as a crowd catching
      // fire rather than one strobing mass.
      const rage = (mon.injRageT ?? 0) > 0 ? 0.3 + 0.1 * Math.sin(time * 5 + mon.id) : 0;
      this.applyHitFlash(mesh, mon.hitFlash, dt, rage);
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
        // KNOCKBACK (audit r4 juice stack): hits shove the DISPLAY body a few
        // inches along the impact direction, easing back over ~150ms — pure
        // renderer offset (emitHits sets the impulse), sim position untouched.
        const kbx = (udS.kbX as number) || 0;
        const kbz = (udS.kbZ as number) || 0;
        if (kbx !== 0 || kbz !== 0) {
          mesh.position.x += kbx;
          mesh.position.z += kbz;
          const dk = Math.exp(-dt * 9);
          udS.kbX = Math.abs(kbx) < 0.008 ? 0 : kbx * dk;
          udS.kbZ = Math.abs(kbz) < 0.008 ? 0 : kbz * dk;
        }
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
        // Lift + scale-punch ride the renderer flash envelope (audit r4): the
        // struck body pops ~9% and settles over ~250ms instead of 2 frames.
        const hitEnv = (ud.flashEnv as number) ?? 0;
        mesh.position.y = 0.1 * hitEnv;
        mesh.scale.setScalar(bs * (1 + 0.09 * hitEnv));
      } else {
        // Bob while chasing; recoil pop + squash when just hit or staggered;
        // rear up through a windup (scaled by archetype size).
        const bob = mSpeed > 0.2 ? Math.abs(Math.sin(time * 10 + mon.id)) * 0.14 * bs : 0;
        const hitEnvP = (mesh.userData.flashEnv as number) ?? 0;
        mesh.position.y = 0.18 * hitEnvP + bob;
        const squash = hitEnvP > 0.25 || mon.stagger > 0 ? 1 + 0.25 * Math.max(hitEnvP, mon.stagger > 0 ? 1 : 0) : 1;
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
          // Two-tone LANE telegraph (audit r3): gradient fill, breathing side
          // rails, chevrons marching down-lane — same dialect as the disc.
          strip = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeLaneMat());
          strip.rotation.order = "YXZ";
          strip.rotation.x = -Math.PI / 2;
          strip.renderOrder = 6;
          strip.userData.noAO = true;
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
        const laneHex =
          mon.windupKind === "hook" ? 0x7cc95a :
          mon.windupKind === "lunge" ? 0xd4c94f : 0xff9a2e;
        const mat = strip.material as THREE.ShaderMaterial;
        (mat.uniforms.uColor.value as THREE.Color).setHex(laneHex);
        mat.uniforms.uProg.value = prog;
        mat.uniforms.uTime.value = time + mon.id * 0.7;
        // Far end must be in vision too (audit r5): a lane pointing into the
        // murk must not streak across unexplored darkness toward the HUD.
        strip.visible = mesh.visible &&
          inVision({ x: mon.pos.x + laneDir.x * len, y: mon.pos.y + laneDir.y * len });
        // Lane windups gather too (charger crouch, lasher coil).
        if (mesh.visible) {
          ud0.gatherT = ((ud0.gatherT as number) ?? 0) - dt;
          if ((ud0.gatherT as number) <= 0) {
            ud0.gatherT = 0.06;
            this.fxp.gather(mesh.position.x, 0.8, mesh.position.z, laneHex, prog);
          }
        }
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
          // Round-2 telegraph: one shader disc — rotating rune ticks, a conic
          // sweep that fills with the windup, a pulsing edge-glow rim; bosses
          // and elites speak a heavier dialect (chevrons + collapsing rings).
          tel = new THREE.Group();
          const disc = new THREE.Mesh(TELEGRAPH_GEO, makeTelegraphMat());
          // Readability rule (audit r3): the telegraph draws ABOVE decals and
          // ground glow — the one thing the player must read stays on top.
          disc.renderOrder = 6;
          disc.userData.noAO = true;
          tel.add(disc);
          tel.userData.telMat = disc.material;
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
          // ---- BOSSES V2 windups. Each one covers what it will actually do,
          // because a telegraph whose disc lies about its reach is worse than
          // no telegraph at all.
          mon.windupKind === "punish" ? CONFIG.bossSlamRadius * 0.8 :
          mon.windupKind === "latefee" ? 3.2 :
          mon.windupKind === "bloom" ? CONFIG.bloomRadius * 2.2 :
          mon.windupKind === "pull" ? CONFIG.greasePullRange * 0.55 :
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
          mon.windupKind === "morph" ? 0xd8d0a8 :
          // ---- BOSSES V2: the tell wears the fight's ASK color (bossFx.ts),
          // so a player who has learned "gold means unload" or "green means
          // storm" reads the disc before they read the boss.
          mon.windupKind === "punish" ? ASK_PAL.window.mid :
          mon.windupKind === "latefee" ? ASK_PAL.window.mid :
          mon.windupKind === "bloom" ? ASK_PAL.storm.mid :
          mon.windupKind === "pull" ? ASK_PAL.arena.mid :
          mon.kind === "boss" ? ASK_PAL[bossFamily(mon.bossId)].mid : 0xff5030;
        const tm = tel.userData.telMat as THREE.ShaderMaterial;
        (tm.uniforms.uColor.value as THREE.Color).setHex(telColor);
        tm.uniforms.uProg.value = prog;
        tm.uniforms.uTime.value = time + mon.id * 0.7; // desync neighboring tells
        tm.uniforms.uBoss.value = mon.kind === "boss" || mon.elite ? 1 : 0;
        // The ASK silhouette outranks the shared disc while it is up (r3 minor).
        tm.uniforms.uDemote.value =
          mon.kind === "boss" && this.bossFx.silhouetteLive ? 1 : 0;
        tel.visible = mesh.visible;
        // CAST ANTICIPATION: motes gather INTO the body while the tell runs —
        // the caster visibly draws power before the strike fires.
        if (mesh.visible) {
          ud0.gatherT = ((ud0.gatherT as number) ?? 0) - dt;
          if ((ud0.gatherT as number) <= 0) {
            ud0.gatherT = 0.06;
            this.fxp.gather(mesh.position.x, 0.9 * ((mesh.userData.baseScale as number) ?? 1), mesh.position.z, telColor, prog);
          }
        }
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

      // PINNED (V2 N2): the shackle. Four bracket posts standing on a taut
      // ring, snapping tight on contact and easing loose as the pin expires.
      const pinT = mon.pinnedT ?? 0;
      let cage = this.pinCages.get(mon.id);
      if (pinT > 0 && mon.hp > 0) {
        if (!cage) { cage = this.buildPinCage(); this.scene.add(cage); this.pinCages.set(mon.id, cage); }
        const s = 0.7 * (mon.elite ? CONFIG.eliteScale : mon.veteran ? CONFIG.veteranScale : 1);
        cage.position.set(mon.pos.x, 0.02, mon.pos.y);
        cage.scale.setScalar(s);
        cage.rotation.y = time * 0.35;
        // Bright and tight while the pin has time on it, fading over the last
        // half second so "about to be free" is legible BEFORE it is free.
        const grip = Math.min(1, pinT / 0.5);
        for (const o of cage.children) {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = (0.25 + 0.6 * grip) * (0.85 + 0.15 * Math.sin(time * 9 + mon.id));
        }
        cage.visible = mesh.visible;
      } else if (cage) {
        this.scene.remove(cage);
        this.pinCages.delete(mon.id);
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
        const cage = this.pinCages.get(id);
        if (cage) { this.scene.remove(cage); this.pinCages.delete(id); }
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
          // Round-2 death staging: elites/bosses get a BEAT (shockwave ring,
          // light flash, ember column, scale swell), every corpse then erodes
          // away in an edge-glow dissolve instead of popping.
          const bigDeath = !!mesh.userData.isElite || mesh.userData.simKind === "boss";
          if (bigDeath) {
            const mx = mesh.position.x, mz = mesh.position.z;
            const boss = mesh.userData.simKind === "boss";
            this.shocks.spawn(mx, mz, 0xffd9a0, boss ? 4.4 : 2.8, boss ? 0.6 : 0.45);
            this.spawnFxLight(mx, mz, 0xffdca0, boss ? 7 : 4.5, 0.6, 1.2);
            this.fxp.column(mx, mz, boss ? 0xffb457 : 0xffe0b0, boss ? 18 : 10, boss ? 2.6 : 1.8);
            this.decals.spawn(mx, mz, boss ? 1.9 : 1.25, 0x120807, 0xc03024, 12);
            this.addTrauma(boss ? 0.5 : 0.32);
          }
          const delay = (rigged ? 0.8 : 0.4) + (fling ? 0.4 : 0);
          const dur = 0.55;
          this.dying.push({
            mesh, t: Math.max((rigged ? 1.1 : 0.7) + (fling ? 0.4 : 0), delay + dur + 0.05),
            rigged, fling,
            dissolve: { u: makeDissolving(mesh, bigDeath ? 0xffb457 : 0x9fc4ff), delay, dur },
            beat: bigDeath ? 0 : undefined,
          });
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
    const hazSeen = this.scratchSet();
    for (const hz of state.hazards) {
      hazSeen.add(hz.id);
      // BEAM (line) hazards: authored ordnance anatomy (r5 major) — shader
      // strip with taper/noise, muzzle flare at the source, impact bloom at
      // the far end, blossom particles on the firing edge. Per-beam seed so
      // a ten-line radial volley staggers instead of firing as one stencil.
      if (hz.kind === "beam" && hz.end) {
        let beam = this.hazardBeams.get(hz.id);
        if (!beam) {
          const seed = ((hz.id % 7) * 0.37 + (hz.id % 13) * 0.11) % 1;
          beam = this.buildBeamGroup(0xff5a3c, seed);
          this.scene.add(beam);
          this.hazardBeams.set(hz.id, beam);
        }
        const strip = beam.userData.strip as THREE.Mesh;
        const bmat = beam.userData.mat as THREE.ShaderMaterial;
        const muzzle = beam.userData.muzzle as THREE.Sprite;
        const impact = beam.userData.impact as THREE.Sprite;
        const seed = beam.userData.seed as number;
        const mx = (hz.pos.x + hz.end.x) / 2, my = (hz.pos.y + hz.end.y) / 2;
        const len = Math.hypot(hz.end.x - hz.pos.x, hz.end.y - hz.pos.y);
        strip.position.set(mx, 0.07, my);
        // Slight per-beam width variance (0.9..1.15): a volley of individuals.
        strip.scale.set(Math.max(len, 1e-3), hz.radius * 2 * (0.9 + seed * 0.25), 1);
        strip.rotation.y = -Math.atan2(hz.end.y - hz.pos.y, hz.end.x - hz.pos.x);
        const decay = Math.min(1, hz.t / Math.max(hz.total, 1e-3) + 0.35);
        const armK = Math.min(1, (hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3));
        bmat.uniforms.uTime.value = time;
        bmat.uniforms.uLen.value = len;
        bmat.uniforms.uHot.value = hz.fired ? 1 : 0;
        bmat.uniforms.uFade.value = hz.fired
          ? decay // firing: hot, fading with the flash
          : 0.4 + 0.5 * armK; // telegraph brightens toward the volley
        // MUZZLE FLARE: breathing ember while arming, a hot pop when firing.
        muzzle.position.set(hz.pos.x, 0.5, hz.pos.y);
        const mm = muzzle.material as THREE.SpriteMaterial;
        if (hz.fired) {
          mm.opacity = 0.85 * decay;
          muzzle.scale.setScalar(1.5 + 0.5 * decay);
        } else {
          mm.opacity = 0.3 + 0.18 * Math.sin(time * 9 + seed * 17);
          muzzle.scale.setScalar(0.7 + 0.25 * armK);
        }
        // IMPACT SPLASH: nothing while arming; a hot terminus when firing.
        impact.position.set(hz.end.x, 0.16, hz.end.y);
        (impact.material as THREE.SpriteMaterial).opacity = hz.fired ? 0.9 * decay : 0;
        impact.scale.setScalar(0.85 + 0.8 * (1 - decay));
        // FIRING EDGE (one-shot): muzzle flash burst, far-end blossom, and a
        // scorch decal stamped where the shot terminates (r6 major: beams
        // ended on nothing — every hit needs a mark the world keeps).
        if (hz.fired && !beam.userData.wasFired) {
          beam.userData.wasFired = true;
          const dirx = (hz.end.x - hz.pos.x) / Math.max(len, 1e-3);
          const diry = (hz.end.y - hz.pos.y) / Math.max(len, 1e-3);
          if (inVision(hz.pos)) {
            this.fxp.impactFlash(hz.pos.x, 0.65, hz.pos.y, 0xffb057, 1.15);
            this.fxp.sparks(hz.pos.x, 0.6, hz.pos.y, 0xffb057, 4, { x: dirx, y: diry });
          }
          if (inVision(hz.end)) {
            this.fxp.impactFlash(hz.end.x, 0.35, hz.end.y, 0xff5a3c, 0.95);
            this.fxp.sparks(hz.end.x, 0.35, hz.end.y, 0xff7a4d, 5);
            this.fxp.embers(hz.end.x, hz.end.y, 0xff5a3c, 3, 0.5);
            this.decals.spawn(hz.end.x, hz.end.y, 0.6, 0x120807, 0xff6a3c, 7);
          }
        }
        // BEAM-BODY INTERACTION (r6 major: shots "pass straight through the
        // player with no rim response"): while the beam is live, any crawler
        // it crosses catches a brief warm graze glow at the crossing point —
        // the light visibly touches the body instead of ignoring it.
        if (hz.fired && decay > 0.15) {
          for (const pl of state.players) {
            if (!pl.alive) continue;
            const ex = hz.end.x - hz.pos.x, ey = hz.end.y - hz.pos.y;
            const tSeg = Math.max(0, Math.min(1,
              ((pl.pos.x - hz.pos.x) * ex + (pl.pos.y - hz.pos.y) * ey) / Math.max(len * len, 1e-6)));
            const nx = hz.pos.x + ex * tSeg, ny = hz.pos.y + ey * tSeg;
            const dgx = pl.pos.x - nx, dgy = pl.pos.y - ny;
            if (dgx * dgx + dgy * dgy < (hz.radius + 0.42) ** 2 && Math.random() < dt * 22) {
              this.spawnGlow(nx, 0.85, ny, 0xffb47a, 1.25, 0.14);
              this.fxp.sparks(nx, 0.8, ny, 0xffc9a0, 2);
            }
          }
        }
        // BOTH endpoints must be in vision (audit r5 blocker): a midpoint-only
        // check let half-revealed beams stretch across unexplored darkness and
        // slice through screen regions the HUD owns — a beam whose far end is
        // still in the murk stays hidden until the player can actually see it.
        const vis = inVision(hz.pos) && inVision(hz.end) && inVision({ x: mx, y: my });
        strip.visible = vis;
        muzzle.visible = vis || inVision(hz.pos); // the source alone may show
        impact.visible = vis;
        continue;
      }
      // STAGE CABLES (V2 N2): a LINE hazard, not a disc. Falling through to
      // the blast branch would have rendered the player's own pin line as a
      // ticking clown bomb sitting on its midpoint -- the exact "recolored
      // nova" failure the FX rule exists to stop.
      if (hz.kind === "cables" && hz.end) {
        let rig = this.cableRigs.get(hz.id);
        if (!rig) { rig = this.buildCableRig(); this.scene.add(rig); this.cableRigs.set(hz.id, rig); }
        const rud = rig.userData as {
          a: THREE.Mesh; b: THREE.Mesh; hi: THREE.Mesh; lo: THREE.Mesh;
          field: THREE.Mesh; mat: THREE.MeshBasicMaterial;
        };
        // hz.pos is the MIDPOINT (doCables), so the near stake mirrors the far.
        const sx = 2 * hz.pos.x - hz.end.x, sy = 2 * hz.pos.y - hz.end.y;
        const span = Math.hypot(hz.end.x - sx, hz.end.y - sy);
        const yaw = -Math.atan2(hz.end.y - sy, hz.end.x - sx);
        rud.a.position.set(sx, 0.55, sy);
        rud.b.position.set(hz.end.x, 0.55, hz.end.y);
        for (const [line, h] of [[rud.hi, 0.78], [rud.lo, 0.46]] as [THREE.Mesh, number][]) {
          line.position.set(hz.pos.x, h, hz.pos.y);
          line.rotation.y = yaw;
          line.scale.set(span, 1, 1);
        }
        rud.field.position.set(hz.pos.x, 0.05, hz.pos.y);
        rud.field.rotation.y = yaw;
        rud.field.scale.set(span, 1, hz.radius * 2);
        // The line is ARMED while the pin phase is running (hz.t counts down
        // through pin, then the slow field). Armed: taut and humming. Spent:
        // slack and dim, with only the ground field still working.
        const armed = hz.t > (hz.total - (hz.pin ?? 0));
        rud.mat.opacity = armed ? 0.75 + 0.25 * Math.abs(Math.sin(time * 7)) : 0.3;
        (rud.field.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
        (rud.field.material as THREE.ShaderMaterial).uniforms.uProg.value = armed ? 0.85 : 0.35;
        const vis = inVision(hz.pos);
        rig.visible = vis;
        // Tension sparks off the line while it is holding something.
        if (armed && vis && Math.random() < dt * 6) {
          const k = Math.random();
          this.fxp.sparks(sx + (hz.end.x - sx) * k, 0.62, sy + (hz.end.y - sy) * k, FX_PAL.pin.core, 2);
        }
        continue;
      }
      // SPORE PODS (BOSSES V2 §7.4 — the Pollinator's new Hazard.kind). Its
      // own primitive, not a sludge recolor: petal seams that SPREAD and a
      // core that swells as the pod arms, so "this is about to open and seed
      // two more" reads from the silhouette without a timer. Pods that go off
      // seed pods, so the arena saturates if the player ignores them — the
      // read has to survive twenty of these on screen at once.
      if (hz.kind === "spore") {
        let pod = this.hazardRings.get(hz.id);
        if (!pod) {
          pod = new THREE.Mesh(TELEGRAPH_GEO, this.bossFx.sporeMat(hz.id));
          pod.renderOrder = 5;
          pod.userData.noAO = true;
          pod.userData.spore = true;
          this.scene.add(pod);
          this.hazardRings.set(hz.id, pod);
        }
        const armT = hz.arm ?? 0;
        const elapsed = hz.total - hz.t;
        const sm = pod.material as THREE.ShaderMaterial;
        sm.uniforms.uTime.value = time + (hz.id % 11) * 0.53;
        sm.uniforms.uArm.value = armT > 0 ? Math.min(1, elapsed / armT) : 1;
        sm.uniforms.uDry.value = 1 - Math.min(1, hz.t / Math.max(hz.total, 1e-3));
        pod.position.set(hz.pos.x, 0.07, hz.pos.y);
        pod.scale.setScalar(hz.radius);
        pod.visible = inVision(hz.pos);
        // Pollen drifts off a live pod: the garden is BREATHING, and the motes
        // mark the ground the pod will claim when it opens.
        if (pod.visible && Math.random() < dt * 5) {
          this.fxp.embers(hz.pos.x, hz.pos.y, ASK_PAL.storm.core, 1, hz.radius * 0.9);
        }
        continue;
      }
      // FAULT LINE / RIFT (V2 U1, R1): player-owned BROKEN GROUND. It reads
      // through the living-pool shader like every other lingering zone, but in
      // the owning ability's hue -- Fault Line magma, a Collapse rift void.
      const pool = hz.kind === "puddle" || hz.kind === "sludge" || hz.kind === "roots" || hz.kind === "shards"
        || hz.kind === "consecrate" || hz.kind === "fissure";
      let ring = this.hazardRings.get(hz.id);
      if (!ring) {
        // ZONE MATERIAL REBUILD (r6 major: "flat red/orange floor tints with
        // no emissive gradient, flicker, or edge treatment"): lingering pools
        // render through the living-pool shader (wobbled edge, churn, hot
        // core, flicker); blast telegraphs speak the full three-part shader
        // telegraph language (rune ring, conic clock, breathing rim) instead
        // of a bare wireframe ring.
        if (pool) {
          const bodyHex =
            hz.kind === "sludge" ? 0x5f7020 : // sewer surge: darker, fouler than acid
            hz.kind === "roots" ? 0x2e8b57 : // grasping green
            hz.kind === "shards" ? 0xb8b0a0 : // ossuary debris: pale bone scatter
            hz.kind === "consecrate" ? 0xe8c96a : // holy ground: theirs, not yours
            // RIM, not mid: every shipped pool body is a DEEP color (sludge
            // 0x5f7020, acid 0x7fb832) because the pool shader adds its own
            // hot core and the bloom pass adds the halo. A mid-tone body here
            // lit the whole quadrant and ate the fight inside it.
            hz.kind === "fissure"
              ? (hz.ability === "nova" ? FX_PAL.pull.rim : FX_PAL.cataclysm.rim) // yours: void rift vs magma
              :
            0x7fb832; // acid
          ring = new THREE.Mesh(TELEGRAPH_GEO, makePoolMat(bodyHex));
          ring.userData.pool = true;
        } else {
          const mat = makeTelegraphMat();
          (mat.uniforms.uColor.value as THREE.Color).setHex(hz.flavor === "flame" ? 0xff7733 : 0xff4628);
          ring = new THREE.Mesh(TELEGRAPH_GEO, mat);
        }
        ring.renderOrder = 4;
        ring.userData.noAO = true;
        this.scene.add(ring);
        this.hazardRings.set(hz.id, ring);
      }
      ring.position.set(hz.pos.x, 0.06, hz.pos.y);
      ring.scale.setScalar(hz.radius);
      const arming = pool && (hz.arm ?? 0) > 0 && hz.total - hz.t < (hz.arm ?? 0);
      const urgency = 1 - hz.t / Math.max(hz.total, 1e-3);
      {
        const zm = ring.material as THREE.ShaderMaterial;
        zm.uniforms.uTime.value = time + (hz.id % 9) * 0.77; // desync neighbors
        if (ring.userData.pool) {
          zm.uniforms.uDry.value = 1 - Math.min(1, hz.t / Math.max(hz.total, 1e-3));
          zm.uniforms.uArm.value = arming ? 1 : 0;
        } else {
          zm.uniforms.uProg.value = urgency;
          zm.uniforms.uBoss.value = (hz.radius > 1.6 ? 1 : 0);
        }
      }
      ring.visible = inVision(hz.pos);
      // Fire-flavored blasts shed a few live embers while they arm — the
      // patch reads as burning ground, not painted ground.
      if (!pool && hz.flavor === "flame" && ring.visible && Math.random() < dt * 7) {
        this.fxp.embers(
          hz.pos.x + (Math.random() - 0.5) * hz.radius * 1.2,
          hz.pos.y + (Math.random() - 0.5) * hz.radius * 1.2,
          0xff7a2f, 1, 0.55);
      }
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
      if (!hazSeen.has(id)) {
        this.scene.remove(ring);
        this.hazardRings.delete(id);
        if (ring.userData.spore) this.bossFx.releaseSpore(id);
      }
    }
    for (const [id, bomb] of this.hazardBombs) {
      if (!hazSeen.has(id)) { this.scene.remove(bomb); this.hazardBombs.delete(id); }
    }
    for (const [id, beam] of this.hazardBeams) {
      if (!hazSeen.has(id)) { this.scene.remove(beam); this.hazardBeams.delete(id); }
    }
    for (const [id, rig] of this.cableRigs) {
      if (!hazSeen.has(id)) {
        // The line goes slack: one last snap where the stakes were.
        this.fxp.sparks(rig.position.x, 0.6, rig.position.z, FX_PAL.pin.mid, 3);
        this.scene.remove(rig);
        this.cableRigs.delete(id);
      }
    }

    // Windup-bound FX: the spitter's lobbed thorn and the bomber's held bomb
    // exist only while the tell runs — pure presentation over sim windup state.
    this.updateWindupFx(state);

    // Party pings: an expanding gold pulse on the marked spot. The pulse cycle
    // derives from the ping's remaining life (sim time), so replays match.
    // Pings pierce the fog on purpose — "over THERE" must work unseen.
    const pingSeen = this.scratchSet();
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
    const revSeen = this.scratchSet();
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
    const curseSeen = this.scratchSet();
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
    const projSeen = this.scratchSet();
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
          // LoL PROJECTILE ANATOMY (audit r3): white-hot core, tight hot
          // sprite, SATURATED colored glow shell — each layer clamped under
          // the bloom knee so the ordnance keeps a readable shape instead of
          // clipping to a featureless bloom disc.
          const hotHex = new THREE.Color(color)
            .lerp(new THREE.Color(1, 1, 1), 0.7).getHex();
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(0.085, 8, 8),
            flat(hotHex, { emissive: hotHex, emissiveIntensity: 0.85 }),
          );
          const hotSprite = this.makeGlow(hotHex, 0.34);
          const shell = this.makeGlow(color, 0.8);
          (shell.material as THREE.SpriteMaterial).opacity = 0.5;
          group.add(core, hotSprite, shell);
          // GROUND-LIGHT BLOB (audit r5): a soft school-colored pool glides
          // along the floor under the bolt — ordnance visibly lights the
          // ground it crosses instead of floating detached in the dark.
          const pool = new THREE.Mesh(
            this.blobResources().geo,
            new THREE.MeshBasicMaterial({
              map: this.glowTexture(), color, transparent: true, opacity: 0.3,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }),
          );
          pool.position.y = -0.52; // group flies at y=0.6 -> pool ~0.08 over floor
          pool.scale.setScalar(0.55);
          pool.renderOrder = 2;
          pool.userData.noAO = true;
          group.add(pool);
          // VOLLEY VARIANCE (r5 major: "ten uniform debug-ray capsules"): a
          // per-id size/heat jitter so a radial volley reads as ten shots,
          // not one stencil rotated ten times.
          const jit = 0.88 + ((pr.id * 37) % 23) / 23 * 0.28;
          core.scale.setScalar(jit);
          hotSprite.scale.multiplyScalar(jit);
          shell.scale.multiplyScalar(0.9 + ((pr.id * 53) % 17) / 17 * 0.24);
        }
        group.userData.color = color;
        group.userData.lastTrail = 0;
        mesh = group;
        this.scene.add(mesh); this.projectiles.set(pr.id, mesh);
        // MUZZLE FLARE (r5 major): ordnance visibly LEAVES a source — a hot
        // pop + directional sparks at the spawn point. Enemy fire only (the
        // player's own cast FX already covers the hero's hands).
        if (pr.from !== "player" && inVision(pr.pos)) {
          const sp = Math.hypot(pr.vel.x, pr.vel.y) || 1;
          this.fxp.impactFlash(pr.pos.x, 0.62, pr.pos.y, color, 0.55);
          this.fxp.sparks(pr.pos.x, 0.6, pr.pos.y, color, 2,
            { x: pr.vel.x / sp, y: pr.vel.y / sp });
        }
      }
      this.smoothTo(mesh, pr.pos.x, 0.6, pr.pos.y, dt);
      if (mesh.userData.aim) mesh.rotation.y = Math.atan2(pr.vel.x, pr.vel.y);
      mesh.visible = inVision(pr.pos);
      // RIBBON TRAIL (round 2): a continuous tapered streak in the school's
      // color replaces the gappy puff chain; arrows keep a thin speed line.
      if (mesh.visible) {
        this.ribbons.claim(pr.id, mesh.userData.color as number, mesh.userData.aim ? 0.07 : 0.24);
        this.ribbons.push(pr.id, mesh.position.x, mesh.position.y, mesh.position.z);
        // EMBER EMITTER (audit r3, LoL anatomy layer 4): tiny flickering
        // motes shed along the flight path, sinking as they die.
        if (!mesh.userData.aim && time - ((mesh.userData.lastTrail as number) ?? 0) > 0.05) {
          mesh.userData.lastTrail = time;
          const c = mesh.userData.color as number;
          this.fxp.spawn({
            x: mesh.position.x - pr.vel.x * 0.035, y: mesh.position.y,
            z: mesh.position.z - pr.vel.y * 0.035,
            vx: (Math.random() - 0.5) * 0.8, vy: -0.2 - Math.random() * 0.5,
            vz: (Math.random() - 0.5) * 0.8, ay: -3,
            life: 0.3 + Math.random() * 0.2, size0: 0.07, size1: 0.02,
            col0: c, col1: c, dim: 0.85, fadeIn: 0.05,
            rot: Math.random() * 6.28, tex: TEX_FLICKER,
          });
        }
      }
    }
    for (const [id, mesh] of this.projectiles) {
      if (!projSeen.has(id)) {
        // IMPACT BLOSSOM (r5 major): every bolt END gets punctuation — hits on
        // actors already blossom via state.hits, but volley shots dying on
        // walls/range used to just vanish, leaving the ray with no far end.
        // Small + enemy-hue only; the hit pipeline stays the loud channel.
        if (mesh.visible && !mesh.userData.aim) {
          const c = (mesh.userData.color as number) ?? 0xffb057;
          this.fxp.impactFlash(mesh.position.x, mesh.position.y, mesh.position.z, c, 0.6);
          this.fxp.sparks(mesh.position.x, mesh.position.y, mesh.position.z, c, 3);
        }
        this.scene.remove(mesh);
        this.projectiles.delete(id);
        this.ribbons.release(id); // trail fades out where the bolt died
      }
    }

    // Loot: reconcile + bob/spin.
    const lootSeen = this.scratchSet();
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
    if (this.heroLamp && lp) {
      // The hero's warm counter-light rides just above and behind the crawler,
      // guttering gently so it reads as carried firelight, not a headlamp.
      // FIGHT KEY (r6 blocker: the crowd beat had no focal light): when a
      // pack closes in the practical swells toward ~1.9x and lifts/widens —
      // the fight becomes the brightest, warmest pixel cluster in the frame
      // (LoL teamfight rule) and every ringed silhouette catches the kiss.
      let packNear = 0;
      for (const m of state.monsters) {
        if (m.dormant || m.hp <= 0) continue;
        const ddx = m.pos.x - lp.pos.x, ddy = m.pos.y - lp.pos.y;
        if (ddx * ddx + ddy * ddy < 17.6 && ++packNear >= 6) break;
      }
      const fightK = Math.min(1, packNear / 4);
      this.heroLamp.position.set(lp.pos.x + 0.3, 1.55 + 0.45 * fightK, lp.pos.y + 0.35);
      this.heroLamp.distance = 7.5 + 4 * fightK;
      this.heroLamp.intensity = this.heroLampBase * (1 + 1.25 * fightK)
        * (0.93 + 0.07 * Renderer3D.torchFlicker(time, 4.2));
    }
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
        // ~8Hz flame dance: the SOURCE wanders a few cm and gutters, so the
        // pool's edge crawls like firelight instead of breathing in place.
        const fl = Renderer3D.torchFlicker(time, t.seed);
        const w1 = Renderer3D.torchFlicker(time + 17.3, t.seed + 9.1) - 0.74;
        const w2 = Renderer3D.torchFlicker(time + 31.7, t.seed + 23.7) - 0.74;
        light.position.set(t.x + w1 * 0.55, 1.06 + (fl - 0.74) * 0.3, t.y + w2 * 0.55);
        light.intensity = this.torchBase * st.level * fl;
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
        if (hidden) {
          // DISTANT EMBERS (critic r3 blocker: the unexplored field read as
          // unrendered canvas): fogged sconces stay as faint guttering
          // pinpricks in the murk — the dark reads as a place with lights
          // burning in it, D2R-style, without lifting the murk's value floor.
          if (f.role === 0) { f.s.visible = false; continue; }
          f.s.visible = true;
          const dfl = Renderer3D.torchFlicker(time * 0.55, f.seed);
          const dmat = f.s.material as THREE.SpriteMaterial;
          if (f.role === 1) {
            dmat.opacity = 0.13 * (0.75 + 0.25 * dfl);
            f.s.scale.setScalar(f.base * 0.5);
          } else {
            dmat.opacity = 0.06 * (0.85 + 0.15 * dfl);
            f.s.scale.setScalar(f.base * 0.75);
          }
          continue;
        }
        f.s.visible = true;
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
    // Sconce wall streaks: gutter with their torch, hidden under fog.
    if (this.torchStreaks.length > 0) {
      const fAlphas = this.fogBank.alphas;
      for (const t of this.torchStreaks) {
        const hidden = (fAlphas[t.tile] ?? 1) > 0.5;
        t.m.visible = !hidden;
        if (hidden) continue;
        const fl = Renderer3D.torchFlicker(time, t.seed);
        (t.m.material as THREE.MeshBasicMaterial).opacity = t.baseOp * (0.72 + 0.28 * fl);
      }
    }
    // Baked-pool gutter + fog-frontier drift for the world-lit materials.
    this.wl.uWlFlick.value = 0.88 + 0.12 * Renderer3D.torchFlicker(time, 0.37);
    this.wl.uWlTime.value = time;
    this.chU.uChTime.value = time; // character accent-glow breathing
    // Sewer channels etc: emissive water crawls along its run. Molten
    // channels add a sinusoidal UV wobble — heat-shimmer on the emissive
    // (r5 issue #3) without touching the shader.
    for (const f of this.envFlow) {
      if (f.wobble) {
        const fq = f.freq ?? 1.6;
        f.tex.offset.set(
          time * f.sx + Math.sin(time * fq) * f.wobble,
          time * f.sy + Math.sin(time * fq * 0.83 + 1.7) * f.wobble,
        );
      } else {
        f.tex.offset.set(time * f.sx, time * f.sy);
      }
    }

    this.updateParticles(dt);
    this.updateFxLights(dt);
    this.updateDying(dt);
    this.updateAbilityFx(state);
    this.updateV2Fx(state, dt, time);

    // Round-2 FX layers: GPU particle clock, swing arcs, ribbons, decals,
    // shockwaves — then relax the crit bloom kick (camera-space impact frame).
    this.fxp.update(time);
    this.swingArcs.update(dt);
    this.ribbons.update(dt);
    this.decals.update(dt);
    this.shocks.update(dt);
    if (this.bloomBase < 0) this.bloomBase = this.bloom.strength;
    this.bloomKick = Math.max(0, this.bloomKick - dt * 4.2);
    // Kick stays a tight accent: a big kick used to fog the whole quadrant.
    this.bloom.strength = this.bloomBase + this.bloomKick * 0.18;

    // Camera follows the player from the fixed iso direction, plus trauma shake.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const amp = this.trauma * this.trauma * Renderer3D.SHAKE_MAX;
    const sx = amp > 0 ? (Math.random() * 2 - 1) * amp : 0;
    const sz = amp > 0 ? (Math.random() * 2 - 1) * amp : 0;
    const d = THEME.camDir;
    const dist = THEME.camDist;
    const len = Math.hypot(d.x, d.y, d.z);
    const anchor = this.playerMeshes.get(p.id)?.position;
    let ax = anchor ? anchor.x : p.pos.x;
    let az = anchor ? anchor.z : p.pos.y;
    // BOSSES V2 §5.2/§5.3 — THE REVEAL. During the ringside beat the camera
    // ORBITS: the anchor slides toward the boss and the fixed iso direction
    // gains a yaw offset, so the introduction ends on a silhouette instead of
    // a static three-quarter. It eases back to zero the moment the beat ends —
    // §5.5's rule is that normal combat gets no camera work at all.
    const orbit = this.bossFx.orbit;
    // BOSSES V2 (capture round 2) — ENCOUNTER FRAMING. The health plate owns
    // the top of the screen and the boss stands UP-SCREEN of the crawler, so
    // every fight shot had the star of the fight behind its own UI panel. The
    // fix is two camera moves the boss layer asks for and this applies, since
    // this is where camDir lives:
    //   1) slide the anchor part-way to the boss, so the PAIR is the subject
    //   2) push the anchor along SCREEN-UP, which slides the whole framing
    //      DOWN the screen and out from under the panel
    // Both ease to zero the moment the fight ends.
    const bias = this.bossFx.frameBias;
    const drop = this.bossFx.frameDrop;
    if (bias > 1e-3 || Math.abs(orbit) > 1e-3) {
      const star = state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
      if (star) {
        // The reveal's orbit bias and the fight's framing bias are the same
        // move; take whichever is asking for more rather than stacking them.
        const k = Math.max(bias, Math.min(1, Math.abs(orbit) / 0.55) * 0.45);
        ax += (star.pos.x - ax) * k;
        az += (star.pos.y - az) * k;
      }
    }
    // AIMING A SKILLSHOT LONGER THAN THE FRAME (MOBILE.md §3.4).
    //
    // Measured on an iPhone 13 landscape: bolt's telegraph projected a box
    // (348,-202)-(402,169) on a 750x342 viewport dragging up, and
    // (-214,152)-(375,186) dragging inboard — 8.1% of its vertices on the
    // glass, both devices. The camera shows 8.5 tiles of world above the
    // crawler and bolt reaches 14.4, so a phone player was committing a
    // full-reach skillshot without ever seeing where it ends. The shape was
    // correct; the FRAME was wrong, and no amount of stroke width fixes a
    // frame.
    //
    // So the camera leads the aim while the drag is LIVE — the anchor slides
    // along the aim direction, and the frame widens a little, both eased so a
    // flick-aim does not whip the scene. It returns the instant the finger
    // lifts. This is the same borrowing the boss layer already does (§5.5),
    // and it is presentation only: the sim never learns the camera moved.
    this.aimLead += (this.aimLeadWant - this.aimLead) * Math.min(1, dt * 9);
    if (this.aimLead > 1e-3 && this.aimDirWorld) {
      ax += this.aimDirWorld.x * this.aimLead;
      az += this.aimDirWorld.y * this.aimLead;
    }
    if (drop > 1e-3) {
      // Screen-up, on the ground plane, is the reverse of the camera's own
      // horizontal heading: move the anchor that way and everything else in
      // the frame slides down.
      const hx = d.x / Math.hypot(d.x, d.z);
      const hz = d.z / Math.hypot(d.x, d.z);
      ax -= hx * drop;
      az -= hz * drop;
    }
    const cosO = Math.cos(orbit), sinO = Math.sin(orbit);
    const dirX = (d.x * cosO - d.z * sinO) / len;
    const dirZ = (d.x * sinO + d.z * cosO) / len;
    this.camera.position.set(
      ax + dirX * dist + sx,
      (d.y / len) * dist,
      az + dirZ * dist + sz,
    );
    this.camera.lookAt(ax, 0, az);
    // The boss layer's zoom is continuous, so the frame is re-derived every
    // composed frame rather than only on resize.
    this.applyProjection();
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
  // Scratch for updateCanopy (GC sweep: no per-frame Set/Matrix/Vector mints).
  private canopyEnts: { x: number; y: number }[] = [];
  private canopyMarked = new Set<CanopyEntry>();
  private canopyDirty = new Set<THREE.InstancedMesh>();
  private canopyM = new THREE.Matrix4();
  private canopyV = new THREE.Vector3();

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
    const ents = this.canopyEnts;
    ents.length = 0;
    for (const p of state.players) if (p.alive) ents.push(p.pos);
    for (const mo of state.monsters) {
      if (Math.abs(mo.pos.x - ax) < 14 && Math.abs(mo.pos.y - az) < 10) ents.push(mo.pos);
    }
    // Mark targets around each entity (candidate cells: the diagonal cone).
    const marked = this.canopyMarked;
    marked.clear();
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
    const dirty = this.canopyDirty;
    dirty.clear();
    const scratchM = this.canopyM;
    const scratchV = this.canopyV;
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

  /** Claim the right to spawn a FULL impact flash at (x,z): returns false if
   * another flash landed within ~1.1u in the last 140ms — the caller drops to
   * a sparks-only accent so simultaneous hits never stack to clipped white. */
  private claimFlash(x: number, z: number): boolean {
    const t = this.prevTime;
    for (let i = this.recentFlash.length - 1; i >= 0; i--) {
      if (t - this.recentFlash[i].t > 0.14) this.recentFlash.splice(i, 1);
    }
    for (const f of this.recentFlash) {
      const dx = f.x - x, dz = f.z - z;
      if (dx * dx + dz * dz < 2.25) return false; // within 1.5u = same blast
    }
    this.recentFlash.push({ x, z, t });
    return true;
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
      // STANDARD IMPACT RECIPE (audit r3, per hit): 3-layer hue flash (tiny
      // white-hot core + saturated spiked star + deep rim), gravity sparks,
      // a drifting smoke wisp, and — for the punctuation tier (crit/kill) —
      // shock ring, scorch decal, real light. Per-school tinting throughout,
      // dimmed under the bloom knee so hue survives instead of clipping white.
      if (h.kind === "enemy" || h.kind === "crit") {
        const crit = h.kind === "crit";
        const pal = crit ? FX_PAL.crit : h.school === "magic" ? FX_PAL.magic : FX_PAL.strike;
        // Tag the struck body with the damage-type tint: the rim hit-flash
        // (applyHitFlash) reads it — warm white physical, violet magic, gold
        // crit — so the body flash and the impact kit speak one color.
        {
          const tintHex = crit ? 0xffd23e : h.school === "magic" ? 0xb98bff : 0xffc9a0;
          let best: THREE.Group | null = null;
          let bestD = 1.44; // within 1.2u of the impact
          for (const mm of this.monsters.values()) {
            const dx = mm.position.x - h.pos.x, dz = mm.position.z - h.pos.y;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD) { bestD = d2; best = mm; }
          }
          if (best) {
            best.userData.flashTintHex = tintHex;
            // Knockback impulse (audit r4): the struck body shoves along the
            // impact direction; the monster update decays the display offset.
            if (h.dir) {
              const dl = Math.hypot(h.dir.x, h.dir.y) || 1;
              const kb = (crit ? 0.3 : 0.18) * (h.killed ? 1.4 : 1);
              const bud = best.userData;
              bud.kbX = Math.max(-0.45, Math.min(0.45, ((bud.kbX as number) || 0) + (h.dir.x / dl) * kb));
              bud.kbZ = Math.max(-0.45, Math.min(0.45, ((bud.kbZ as number) || 0) + (h.dir.y / dl) * kb));
            }
          }
        }
        // THREE-LAYER IMPACT KIT on every damage event (audit r3): hot flash
        // card + directional spark burst + floor-ambient dust puff. De-stack:
        // only ONE full kit per spot per beat — simultaneous multi-hits add
        // sparks, not another additive layer (white-clip fix).
        if (crit || this.claimFlash(h.pos.x, h.pos.y)) {
          this.fxp.flash3(h.pos.x, 0.8, h.pos.y, pal, crit ? 1.35 : 1.0);
          this.fxp.dust(h.pos.x, 0.25, h.pos.y, crit ? 3 : 2, this.dustTint);
          this.fxp.sparks(h.pos.x, 0.7, h.pos.y, pal.mid, crit ? 16 : 10, h.dir);
          // Secondary embers (audit r5): 2-3 slow gravity motes linger after
          // the spark spray so the impact has decay frames, not one pop.
          this.fxp.embers(h.pos.x, h.pos.y, pal.mid, crit ? 4 : 2, 0.35);
          // Every full kit throws a BRIEF real light that kisses nearby wall
          // bricks (crits below layer their bigger flash on top of this).
          // Peaks trimmed + lifted (r7 blocker: four pooled lights parked at
          // torso height over one melee scrum fused into a floor-nuking
          // yellow-white pool — the hit moment must ADD readability).
          if (!crit) this.spawnFxLight(h.pos.x, h.pos.y, pal.mid, 1.15, 0.13, 1.05);
        } else {
          this.fxp.sparks(h.pos.x, 0.7, h.pos.y, pal.mid, 6, h.dir);
        }
        if (crit) {
          // Crits: real light + a ground shock ring + a camera-space bloom
          // kick — the LoL "big hit" punctuation stack. Peak capped ~1.5
          // stops over the torch key (r7 blocker) so floor albedo survives
          // directly under the flash.
          this.spawnFxLight(h.pos.x, h.pos.y, pal.mid, 2.1, 0.22, 1.05);
          this.shocks.spawn(h.pos.x, h.pos.y, pal.mid, 1.5, 0.3);
          this.bloomKick = Math.min(1, this.bloomKick + 0.22);
        }
        // Ability/magic hits scorch the ground they land on (short-lived for
        // ordinary hits — kills below stamp the long one).
        if (h.school === "magic" && !h.killed) {
          this.decals.spawn(h.pos.x, h.pos.y, 0.45, 0x120a18, FX_PAL.magic.rim, 5);
        }
      }
      // The crawler TAKING a hit is a damage event too (audit r3: the kit
      // fires on every one): a compact crimson flash + sparks at the body.
      if (h.kind === "player" && this.claimFlash(h.pos.x, h.pos.y)) {
        this.fxp.flash3(h.pos.x, 0.8, h.pos.y,
          { core: 0xffe2d0, mid: 0xff6a4a, rim: 0xa02020 }, 0.9);
        this.fxp.sparks(h.pos.x, 0.7, h.pos.y, 0xe2574c, 7, h.dir);
        this.fxp.dust(h.pos.x, 0.2, h.pos.y, 2, this.dustTint);
      }
      // Killing blows pop: a fatter, impact-directed burst + an extra shake kick.
      const n = (h.kind === "crit" ? 14 : 8) + (h.killed ? 10 : 0) + (h.overkill ? 10 : 0);
      this.spawnBurst(h.pos.x, h.pos.y, color, n, h.dir);
      // Death leaves a mark: gibs + a cooling blood/scorch splat under the
      // corpse (school-tinted flash, fading over ~10s).
      if (h.killed && h.kind !== "player") {
        const hot = h.school === "magic" ? 0x8a5cff : 0xc03024;
        this.decals.spawn(h.pos.x, h.pos.y, 0.72 + (h.overkill ? 0.35 : 0), 0x120807, hot, 10);
        this.fxp.gibs(h.pos.x, h.pos.y, 0x6e2018, h.overkill ? 16 : 9, h.dir);
        // Dust slap where the body lands + one sooty wisp over it.
        this.fxp.dust(h.pos.x, 0.15, h.pos.y, 3, this.dustTint);
        this.fxp.smoke(h.pos.x, 0.5, h.pos.y, 1, 0x26211f);
        // Death beat afterimage (audit r3): a few slow soul-wisp motes rise
        // off the corpse — deaths are hype moments in this fiction.
        const wispHex = h.school === "magic" ? 0xb98bff : 0xffd9a8;
        for (let i = 0; i < 3; i++) {
          this.fxp.spawn({
            x: h.pos.x + (Math.random() - 0.5) * 0.35, y: 0.35 + Math.random() * 0.25,
            z: h.pos.y + (Math.random() - 0.5) * 0.35,
            vx: (Math.random() - 0.5) * 0.25, vy: 0.85 + Math.random() * 0.5,
            vz: (Math.random() - 0.5) * 0.25,
            life: 0.85 + Math.random() * 0.45, size0: 0.12, size1: 0.05,
            col0: wispHex, col1: wispHex, dim: 0.55, fadeIn: 0.25,
            rot: Math.random() * 6.28, tex: TEX_FLICKER,
          });
        }
        if (h.overkill) this.shocks.spawn(h.pos.x, h.pos.y, hot, 1.8, 0.4);
      }
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
        this.spawnFxLight(h.pos.x, h.pos.y, color, h.overkill ? 4.5 : 2.8, h.overkill ? 0.5 : 0.32);
      }
    }
  }

  private spawnBurst(x: number, y: number, color: number, count: number, dir?: Vec2): void {
    // Round 2: the CPU mesh-per-particle burst is gone — the pooled GPU quads
    // carry it (ring buffer recycles the oldest, so fights never drop fresh FX).
    this.fxp.burst(x, y, color, count, dir);
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
    // before we ever see it disappear). In-place compaction — no per-frame
    // filter() allocation.
    let mw = 0;
    for (let i = 0; i < this.overkillMarks.length; i++) {
      const mk = this.overkillMarks[i];
      if ((mk.t -= dt) > 0) this.overkillMarks[mw++] = mk;
    }
    this.overkillMarks.length = mw;
    let dw = 0;
    for (let di = 0; di < this.dying.length; di++) {
      const d = this.dying[di];
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
      // Edge-glow erode: after the death clip has read, the body burns away.
      if (d.dissolve) {
        d.dissolve.delay -= dt;
        if (d.dissolve.delay <= 0) {
          d.dissolve.u.value = Math.min(1, d.dissolve.u.value + dt / d.dissolve.dur);
        }
      }
      // Elite/boss death beat: a slow-motion swell before the body settles.
      if (d.beat !== undefined) {
        d.beat += dt;
        const p = Math.min(1, d.beat / 0.42);
        const bs = (d.mesh.userData.baseScale as number) ?? d.mesh.scale.x;
        d.mesh.scale.setScalar(bs * (1 + 0.15 * Math.sin(p * Math.PI)));
      }
      this.dying[dw++] = d;
    }
    this.dying.length = dw;
  }

  /** Claim a pooled point light: explosions and magic actually illuminate the
   * world for a beat (snap on, quadratic decay out). */
  private spawnFxLight(x: number, z: number, color: number, peak = 8, max = 0.45, y = 0.9): void {
    if (this.fxLights.length === 0) {
      // Pool size comes from the preset, ONCE — see applyQuality's note on why
      // light counts must not move after prewarm has compiled for them.
      for (let i = 0; i < this.quality.fxLights; i++) {
        // Throw tightened 9 -> 5.5 (r7 blocker): an impact light is a local
        // punctuation pop, not room lighting — the wide radius let four
        // stacked flashes fuse into one arena-wide clipped pool.
        const light = new THREE.PointLight(0xffffff, 0, 5.5, 2);
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
    // The whole pool wakes AS A GROUP (see updateFxLights): the scene's point-
    // light count only ever flips between two values — both prewarmed — so a
    // combat flash never triggers a mid-fight program build.
    for (const s of this.fxLights) s.light.visible = true;
  }

  private updateFxLights(dt: number): void {
    let total = 0;
    let anyLive = false;
    for (const s of this.fxLights) {
      if (s.life >= s.max) { s.light.intensity = 0; continue; }
      anyLive = true;
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      const env = t < 0.12 ? t / 0.12 : (1 - (t - 0.12) / 0.88) ** 2;
      // Fire flicker on the decay: the floor pool breathes like burning
      // aftermath instead of holding a flat neutral ellipse (critic r2).
      const flick = 0.84 + 0.16 * Math.sin(s.life * 43 + s.peak * 13);
      s.light.intensity = s.peak * env * flick;
      total += s.light.intensity;
    }
    // ENERGY BUDGET (r7 blocker: stacked impact lights fused into a clipped
    // yellow-white pool that erased the hero, the tiles and the numbers): the
    // POOL shares a fixed brightness budget — simultaneous hits split it
    // instead of summing past the tone-map shoulder. A lone crit is untouched.
    const BUDGET = 2.4;
    if (total > BUDGET) {
      // Soft shoulder, not a hard ceiling: excess energy lands at 25% so a
      // deliberate hero moment (portal beacon, ultimate blast) still spikes
      // visibly — it just can't stack four of itself into pure white.
      const k = (BUDGET + (total - BUDGET) * 0.25) / total;
      for (const s of this.fxLights) s.light.intensity *= k;
    }
    // IDLE LIGHT DIET (perf round): with nothing burning, the pool goes
    // invisible AS A GROUP — walk-around frames pay the baseline point-light
    // count instead of shading four dead lights per fragment. Group toggling
    // keeps the scene at exactly two light-count program variants, both
    // compiled during prewarm.
    if (!anyLive) {
      for (const s of this.fxLights) s.light.visible = false;
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
    // GC SWEEP (perf round): every list below compacts IN PLACE (write-index
    // pattern) — the old per-frame `const alive = []` rebuilds allocated five
    // arrays every frame for the collector to chew on.
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      pt.life += dt;
      if (pt.life >= pt.max) { this.scene.remove(pt.mesh); continue; }
      pt.vy -= 9 * dt; // gravity
      pt.mesh.position.x += pt.vx * dt;
      pt.mesh.position.y += pt.vy * dt;
      pt.mesh.position.z += pt.vz * dt;
      const s = 1 - pt.life / pt.max;
      pt.mesh.scale.setScalar(0.4 + s * 0.6);
      if (pt.mesh.position.y < 0.05) { pt.vy = Math.abs(pt.vy) * 0.4; pt.mesh.position.y = 0.05; }
      this.particles[w++] = pt;
    }
    this.particles.length = w;

    // Glow sprites: fade + optional grow/shrink, no gravity.
    w = 0;
    for (let i = 0; i < this.fxSprites.length; i++) {
      const fx = this.fxSprites[i];
      fx.life += dt;
      if (fx.life >= fx.max) { this.scene.remove(fx.sprite); continue; }
      const t = fx.life / fx.max;
      (fx.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
      if (fx.grow !== 0) fx.sprite.scale.multiplyScalar(1 + fx.grow * dt);
      this.fxSprites[w++] = fx;
    }
    this.fxSprites.length = w;

    // Chains: fade every material in the run, then drop it whole.
    w = 0;
    for (let i = 0; i < this.chainFx.length; i++) {
      const cf = this.chainFx[i];
      cf.life += dt;
      if (cf.life >= cf.max) {
        this.scene.remove(cf.group);
        for (const m of cf.mats) m.dispose();
        continue;
      }
      for (const m of cf.mats) (m as THREE.MeshBasicMaterial).opacity = 1 - cf.life / cf.max;
      this.chainFx[w++] = cf;
    }
    this.chainFx.length = w;

    // Fade props (smokebomb, stars, cones): spin, grow/collapse, fade, vanish.
    // Growth is a deterministic curve off the spawn scale (no per-frame
    // compounding); `pop` adds an anticipation overshoot on the way in.
    w = 0;
    for (let i = 0; i < this.fadeProps.length; i++) {
      const fp = this.fadeProps[i];
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
      this.fadeProps[w++] = fp;
    }
    this.fadeProps.length = w;

    // Level-up rings: expand + fade, then drop.
    w = 0;
    for (let i = 0; i < this.levelRings.length; i++) {
      const r = this.levelRings[i];
      r.life += dt;
      if (r.life >= r.max) { this.scene.remove(r.mesh); continue; }
      const t = r.life / r.max;
      r.mesh.scale.setScalar(0.5 + t * 2.2);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      this.levelRings[w++] = r;
    }
    this.levelRings.length = w;
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

  // Scratch for worldToScreen (called per damage number per frame — no
  // per-call vector allocations).
  private w2sV = new THREE.Vector3();
  private w2sSize = new THREE.Vector2();
  private w2sOut = { x: 0, y: 0, visible: true };

  /** Project a world point to screen pixels (for DOM overlays like damage
   * numbers). Returns a REUSED scratch object — consume it before the next call. */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    // Ensure the camera's world/inverse matrices reflect this frame's lookAt.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const v = this.w2sV.set(x, y, z).project(this.camera);
    const size = this.renderer.getSize(this.w2sSize);
    this.w2sOut.x = (v.x * 0.5 + 0.5) * size.x;
    this.w2sOut.y = (-v.y * 0.5 + 0.5) * size.y;
    this.w2sOut.visible = v.z < 1;
    return this.w2sOut;
  }

  // -------------------------------------------------------------------------
  // THE MEASURED EXPOSURE GOVERNOR (BOSSES-V2 r3 blocker).
  //
  // §5.9 shipped a governor that added up a DECLARED cost per beat. It could
  // not see the case that actually broke: the arena floor itself. The Topiary
  // Warden on floor 9's bright forest was a solid white ellipse in its own
  // reveal and an unreadable white sphere in combat, while the identical
  // budget held fine on the dark brick arenas — because a budget of beats has
  // no idea how bright the room already is.
  //
  // So it measures. After the composed frame, an 8x8 block of the FINAL,
  // display-referred image around the boss's screen position is read back and
  // reduced to a mean luma plus a saturated-pixel fraction. That is the actual
  // thing the review asked about ("does the boss silhouette blow out"), it
  // counts a bright floor automatically, and it costs one 64-pixel readback —
  // only while a boss is on screen, and only every 4th frame.
  // -------------------------------------------------------------------------
  private lumBuf = new Uint8Array(8 * 8 * 4);
  private lumTick = 0;

  /**
   * 0..1 — how hard the boss layer should pull its bloom kicks, light peaks
   * and additive rig alphas back this frame. 1 = a dark arena with headroom to
   * spare; ~0.25 = the neighbourhood is already at the top of the range.
   * Consumed by BossFx (shaders + light peaks) and by the intro key light.
   */
  get bossExposureScale(): number { return this.bossFx.exposureScale; }

  private measureBossExposure(): void {
    const star = this.bossFx.starPos;
    if (!star) { this.bossFx.setMeasuredLuma(0, 0); return; }
    if ((this.lumTick = (this.lumTick + 1) & 3) !== 0) return;
    const sp = this.worldToScreen(star.x, 1.6, star.y);
    if (!sp.visible) return;
    const gl = this.renderer.getContext();
    const size = this.renderer.getSize(this.w2sSize);
    const ratio = this.renderer.getPixelRatio();
    // GL's origin is bottom-left; worldToScreen hands back CSS pixels top-left.
    const px = Math.round(sp.x * ratio) - 4;
    const py = Math.round((size.y - sp.y) * ratio) - 4;
    const w = Math.round(size.x * ratio), h = Math.round(size.y * ratio);
    if (px < 0 || py < 0 || px + 8 > w || py + 8 > h) return;
    // Reading the DEFAULT framebuffer, in the same task as the draw that filled
    // it — valid without preserveDrawingBuffer, and it is the presented image,
    // so tone mapping, bloom and the grade are all already in the numbers.
    try {
      this.renderer.setRenderTarget(null);
      gl.readPixels(px, py, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, this.lumBuf);
    } catch {
      return; // a context loss mid-frame is not worth a crash over a governor
    }
    let sum = 0, hot = 0;
    for (let i = 0; i < 64; i++) {
      const r = this.lumBuf[i * 4], g2 = this.lumBuf[i * 4 + 1], b = this.lumBuf[i * 4 + 2];
      const l = (r * 0.2126 + g2 * 0.7152 + b * 0.0722) / 255;
      sum += l;
      if (l > 0.93) hot++;
    }
    this.bossFx.setMeasuredLuma(sum / 64, hot / 64);
  }

  render(): void {
    // shadowMap.autoUpdate is off (constructor): arm exactly one rebuild for
    // this composed frame. three.js clears needsUpdate itself after the first
    // WebGLRenderer.render() consumes it, so the ~20 fullscreen-quad renders
    // that follow in the post chain no longer each re-walk the shadow casters.
    //
    // SHADOW CADENCE: on the cheaper presets the map is rebuilt every Nth
    // composed frame instead. The map persists in between, and this camera is a
    // fixed-angle ortho that only pans, so a one-frame-stale shadow is not
    // something you can see — but it is a whole extra scene traversal + depth
    // pass that you do not pay for.
    this.frameNo++;
    if (this.quality.shadowMapSize > 0
      && (this.shadowDirty || this.frameNo % this.quality.shadowInterval === 0)) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    this.composer.render();
    if (this.progGuard) this.checkProgramGuard();
    this.measureBossExposure();

    // AUTO-DETECT feed. Frame time is measured between composed frames, which
    // is what the player actually experiences (sim + render + present), not
    // just the renderer's slice of it. See QualityAutoTuner — it judges the
    // MEAN over a wall-clock window, because the median of a GPU-bound frame
    // distribution is not a description of anything a player feels.
    //
    // WARMUP GATE: the first few seconds of play are still streaming ~200 GLBs
    // behind the game and rebuilding floors as they land. Those frames are slow
    // for reasons no preset can fix, and judging them would downgrade a machine
    // that is fine. Gate on WALL CLOCK, not a frame count — a frame count takes
    // longest to reach on exactly the slow machines we most need to judge.
    //
    // AND THE GATE STARTS AT beginTuning(), NOT AT THE FIRST COMPOSED FRAME.
    // This is the bug that made every session on the reference machine end up
    // pinned to PERFORMANCE. prewarm() composes ~10 frames of its own from
    // BEHIND the opaque loading screen (the two compile passes, the four rungs
    // of prewarmQualityLadder). Anchoring the 4 s window to the first of those
    // expired it roughly 2 s BEFORE the overlay lifted — measured
    // loadingHidden = 10.0 s against a gate that opened at ~8.3 s — so the
    // tuner spent its first windows judging shader-compilation frames, scored
    // two bad windows, stepped down, and `ceiling` made that permanent.
    // Nothing about those frames was a statement about the hardware.
    if (this.qualityChoice === "auto" && this.tuningArmed) {
      const now = performance.now();
      if (this.warmupUntil === 0) this.warmupUntil = now + 4000;
      if (now < this.warmupUntil) { this.lastFrameAt = 0; return; }
      if (this.lastFrameAt !== 0) {
        const next = this.tuner.sample(now - this.lastFrameAt);
        if (next && next !== this.quality.name) this.applyQuality(QUALITY_PRESETS[next]);
      }
      this.lastFrameAt = now;
    } else {
      this.lastFrameAt = 0;
    }
  }
}
