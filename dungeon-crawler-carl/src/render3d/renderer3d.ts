import * as THREE from "three";
import { Tile, type GameState, type HitEvent, type Player, type Vec2 } from "../sim/types";
import { THEME } from "./theme";
import { loadModels, type LoadedModel } from "./assets";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { knows, novaParams, orbitBladePos, orbitParams } from "../sim/abilities";
import { weaponClassOf } from "../sim/items";
import { heroSkin } from "../sim/game";
import { CONFIG, floorBand } from "../sim/config";
import { cosmeticRng, themeForFloor, tileHash, type FloorTheme } from "./floorThemes";
import { ATTACHMENT_NODES, CANONICAL_LOADOUT, groundVisualFor, loadoutFor, rarityGlow } from "./weaponry";
import { FogOfWar } from "./fogOfWar";
import { AmbientParticles } from "./ambient";

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

export class Renderer3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private key: THREE.DirectionalLight;

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

  // Torch LIGHT POOL: torch meshes are everywhere, but only a handful of real
  // point lights exist — reassigned each frame to the anchors nearest the
  // player. Constant lighting cost regardless of floor size (forward-renderer
  // fragment cost scales with light count).
  private torchAnchors: { x: number; y: number; seed: number }[] = [];
  private torchPool: THREE.PointLight[] = [];
  private torchBase = 2.2;
  private static TORCH_POOL_SIZE = 6;

  // Party rendering: one mesh per player id. The camera follows localPlayerId.
  private playerMeshes = new Map<number, THREE.Group>();
  localPlayerId = 0;
  private monsters = new Map<number, THREE.Group>();
  private keyMarkers = new Map<number, THREE.Mesh>(); // floating marker over key carriers
  private telegraphs = new Map<number, THREE.Mesh>(); // ground rings under winding-up monsters
  private hazardRings = new Map<number, THREE.Mesh>(); // volatile-corpse blast telegraphs
  // Corpses linger briefly so deaths read (death clip / tumble) instead of popping.
  private dying: { mesh: THREE.Group; t: number; rigged: boolean }[] = [];
  private loot = new Map<number, THREE.Object3D>();
  private projectiles = new Map<number, THREE.Object3D>();

  private models: Record<string, LoadedModel> = {};
  private builtFloor = -1;
  private builtMapVersion = -1;
  private aspect = 1;

  // Fog of war: instanced meshes tinted per tile (white = explored, near-black =
  // hidden). `tiles[i]` is the map tile index behind instance i of `mesh`.
  private fogTargets: { mesh: THREE.InstancedMesh; tiles: number[]; lit: THREE.Color }[] = [];
  // The visible fog bank over unexplored space (drifting planes; see fogOfWar.ts).
  private fogBank = new FogOfWar();
  // Band-themed atmosphere (dust/spores/embers/sparks/ash; see ambient.ts).
  private ambientFx = new AmbientParticles();
  private propEntries: { obj: THREE.Object3D; tile: number }[] = [];
  private stairsObj: THREE.Object3D | null = null;
  private stairsTile = -1;
  private lastExploredVersion = -1;

  // Ability visuals, per player id.
  private orbitBlades = new Map<number, THREE.Mesh[]>();
  private novaRings = new Map<number, THREE.Mesh>();

  // Animation / juice state (all host-side cosmetics; sim stays pure).
  // Last-frame combat state per player: the clip machine fires on EDGES
  // (cooldowns jumping up = a cast; overcharge falling = the spend; etc.).
  private animPrev = new Map<number, {
    swing: number; dash: number; alive: boolean; overcharged: boolean;
    cd: Partial<Record<string, number>>;
  }>();
  // Floor-clear celebration edge (monster count > 0 -> 0 while still playing).
  private prevMonsterCount = -1;
  private prevStatus = "playing";
  private loadoutKeys = new Map<number, string>(); // player id -> applied weapon/shield key
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
  private glowTex: THREE.Texture | null = null;
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

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(THEME.background);
    this.scene.fog = new THREE.Fog(THEME.fog, THEME.fogNear, THEME.fogFar);

    // Fixed orthographic iso camera (frustum set in resize()).
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    // Lighting: ambient + hemisphere fill, one shadow-casting key light, torches added per floor.
    this.scene.add(new THREE.AmbientLight(THEME.ambient, THEME.ambientIntensity));
    this.scene.add(new THREE.HemisphereLight(THEME.hemiSky, THEME.hemiGround, THEME.hemiIntensity));
    this.key = new THREE.DirectionalLight(THEME.keyLight, THEME.keyIntensity);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const c = this.key.shadow.camera as THREE.OrthographicCamera;
    c.left = -18; c.right = 18; c.top = 18; c.bottom = -18; c.near = 1; c.far = 60;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    this.scene.add(this.floorGroup);
    this.scene.add(this.fogBank.group);
    this.scene.add(this.ambientFx.group);
  }

  async init(): Promise<void> {
    this.models = await loadModels();
    // Drop any procedural stand-ins built before the models arrived; the pool
    // rebuilds with real models on the next update.
    for (const mesh of this.playerMeshes.values()) this.scene.remove(mesh);
    this.playerMeshes.clear();
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
      block_hit: pick(/Block_Hit/i), // shielded elites soak hits on the shield (both gens contain this)
      dodge: pick(/Dodge_Forward/i, /Dodge_Right/i), // dash
      throw: pick(/^Throw$/i), // melee-class sidearm bolt
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
    };
    // Everything except locomotion/idles plays once then yields via the busy timer.
    const LOOPING = new Set(["idle", "idle_brawler", "idle_deadeye", "walk", "run", "walk_back", "strafe_left", "strafe_right"]);
    // Retime one-shots to combat tempo (seconds); unlisted one-shots run natural.
    const TARGET: Record<string, number> = {
      attack: 0.3, melee_a: 0.32, melee_b: 0.32, melee_c: 0.32, melee_d: 0.32,
      spin: 0.5, shoot: 0.3, throw: 0.3, spellshoot: 0.35,
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
    const prev = this.animPrev.get(pl.id) ?? { swing: 0, dash: 0, alive: true, overcharged: false, cd: {} };
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
      if (pl.dashTime > prev.dash + 1e-6) {
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
      overcharged: pl.overcharged, cd: { ...cds },
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

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    const hh = THEME.camOrthoHalfHeight;
    const hw = hh * this.aspect;
    this.camera.left = -hw; this.camera.right = hw;
    this.camera.top = hh; this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  // ---- Procedural meshes (placeholders for CC0 glTF art) ----

  // Hero skins (heroSkin in sim/game.ts): model key per skin id. Barbarian/
  // mage/rogue ride the armory_* GLBs (the 1.0 adventurers that also source
  // weapon meshes) — monsters wear the newer KayKit cast now, so hero skins
  // no longer overlap with the menagerie.
  private static readonly SKIN_MODEL: Record<string, string> = {
    knight: "player", barbarian: "armory_axes", mage: "armory_arcana",
    rogue: "armory_knives", hooded: "hero_hooded",
  };

  private buildPlayerMesh(skin: string): THREE.Group {
    const model =
      this.modelInstance(Renderer3D.SKIN_MODEL[skin] ?? "player") ?? this.modelInstance("player");
    if (model) {
      this.normalizeHeight(model, 1.35);
      model.userData.skinId = skin;
      return model;
    }
    const g = new THREE.Group();
    g.userData.skinId = skin;
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

  private buildMonsterMesh(kind: keyof typeof THEME.archetype, floor: number): THREE.Group {
    const spec = THEME.archetype[kind];
    // Prefer a floor-named menace (city bosses + the finale), then the
    // archetype-specific model, then the generic skeleton/monster.
    const model =
      (kind === "boss" ? this.modelInstance(`monster_boss_${floor}`) : null) ??
      this.modelInstance(`monster_${kind}`) ??
      this.modelInstance("skeleton") ??
      this.modelInstance("monster");
    const g = model ?? new THREE.Group();
    if (model) this.normalizeHeight(model, 1.1);
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
    // Fold the archetype size onto whatever scale the model normalization set.
    const base = (model ? g.scale.x : 1) * spec.scale;
    g.scale.setScalar(base);
    g.userData.baseScale = base;
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
    } else if (l.kind === "item" && l.item) {
      const vis = groundVisualFor(l.item);
      const node = vis
        ? (vis.node === "*" ? this.models[vis.srcKey]?.scene : this.models[vis.srcKey]?.scene.getObjectByName(vis.node))
        : null;
      if (node) {
        obj = node.clone(true);
        scale = 0.8;
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
    return group;
  }

  private lootColor(kind: string): number {
    if (kind === "tome") return 0x66f0c8; // ability tome: unmistakable teal
    if (kind === "key") return 0xffd23e; // stairs-district key: bright gold
    return kind === "gold" ? THEME.gold : kind === "heal" ? THEME.heal : THEME.weaponLoot;
  }

  // ---- Floor geometry (rebuilt on descent) ----

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
    const geo = (picked.geometry as THREE.BufferGeometry).clone().applyMatrix4(picked.matrixWorld);
    geo.computeBoundingBox();
    const box = geo.boundingBox!.clone();
    const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    return { geo, mat: picked.material, scale: fp > 1e-4 ? 1 / fp : 1, box };
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

    const map = state.map;

    // Theme band for this depth (art set + palette), plus a cosmetic per-floor
    // rng so floors within a band differ (mix ratio, props, tint jitter).
    const theme: FloorTheme = themeForFloor(state.floor);
    const frng = cosmeticRng((state.seed ^ Math.imul(state.floor, 0x9e3779b1)) >>> 0);
    const altPct = Math.round(theme.altRatio * (0.6 + frng() * 0.9) * 1000); // vs tileHash % 1000
    const tintJitter = 0.93 + frng() * 0.12;
    this.scene.background = new THREE.Color(theme.background);

    // Real glTF tiles when present (instanced for perf), procedural boxes otherwise.
    const floorSrc = this.tileSource(theme.floorKey) ?? this.tileSource("floor");
    const altSrc = this.tileSource(theme.floorAltKey);
    const wallSrc = this.tileSource(theme.wallKey) ?? this.tileSource("wall");
    // Solid rock stays a dark box mass. The glTF wall is a thin PANEL meant to
    // dress a wall face, so it only goes on faces that border walkable floor.
    // The fill box is slightly shorter than the panels so their top/side surfaces
    // are never coplanar (coplanar faces z-fight and flicker as the camera moves).
    const wallHeight = 1.0;
    const fillHeight = wallHeight - 0.04;

    const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < map.w && y < map.h;
    const isFloorAt = (x: number, y: number) => inBounds(x, y) && map.tiles[y * map.w + x] !== Tile.Wall;
    const DIRS = [
      { dx: 0, dz: 1 }, { dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
    ];

    // Tiles are bucketed into CHUNK x CHUNK regions, one InstancedMesh per
    // (chunk, tile kind). A single map-wide instanced mesh defeats frustum
    // culling — the camera sees ~1/6 of a 72x72 floor, and per-chunk meshes let
    // three.js skip the rest (the dominant cost: 1M+ shaded triangles under
    // many lights). Draw calls rise slightly; shaded fragments drop ~5x.
    const CHUNK = 12;
    const chunkCols = Math.ceil(map.w / CHUNK);
    type Kind = "floor" | "alt" | "fill" | "panel" | "door";
    const KINDS: Kind[] = ["floor", "alt", "fill", "panel", "door"];
    type Bucket = Record<Kind, { m: THREE.Matrix4; tile: number }[]>;
    const buckets = new Map<number, Bucket>();
    const push = (kind: Kind, x: number, y: number, tile: number, mat: THREE.Matrix4) => {
      const key = Math.floor(y / CHUNK) * chunkCols + Math.floor(x / CHUNK);
      let b = buckets.get(key);
      if (!b) {
        b = { floor: [], alt: [], fill: [], panel: [], door: [] };
        buckets.set(key, b);
      }
      b[kind].push({ m: mat.clone(), tile });
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
    const placePanel = (x: number, y: number, dx: number, dz: number) => {
      const src = wallSrc!;
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

    // Track which map tile sits behind each instance so fog of war can tint it.
    // Wall instances key off the tile itself; panels key off the floor tile they
    // face (a wall face lights up when the room it borders is explored).
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const idx = y * map.w + x;
        const t = map.tiles[idx];
        if (t === Tile.DoorLocked) {
          // The door block sits over its tile; opening triggers a full rebuild
          // (mapVersion bump), so just draw floor + door now.
          m.makeTranslation(x + 0.5, 1.1 / 2 - 0.02, y + 0.5);
          push("door", x, y, idx, m);
        }
        if (t === Tile.Wall) {
          m.makeTranslation(x + 0.5, fillHeight / 2, y + 0.5);
          push("fill", x, y, idx, m);
          if (wallSrc) {
            for (const d of DIRS) {
              if (!isFloorAt(x + d.dx, y + d.dz)) continue;
              placePanel(x, y, d.dx, d.dz);
              // Fog keys panels off the floor tile they FACE.
              push("panel", x, y, (y + d.dz) * map.w + (x + d.dx), m);
            }
          }
        } else {
          // Mix primary/alt ground per tile (stable hash: same tile, same look).
          const useAlt = altSrc
            ? tileHash(x, y, state.floor) < altPct
            : !floorSrc && (x + y) % 2 !== 0;
          if (useAlt) {
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
    const floorLit = new THREE.Color(theme.floorTint).multiplyScalar(tintJitter);
    const wallLitColor = new THREE.Color(theme.wallTint).multiplyScalar(tintJitter);
    const wallFillLit = wallLitColor.clone().multiplyScalar(0.55); // dark rock tops
    const fillGeo = new THREE.BoxGeometry(1, fillHeight, 1);
    const fillMat = flat(THEME.wall);
    const fallbackFloorGeo = floorSrc && altSrc ? null : new THREE.BoxGeometry(1, 0.2, 1);
    const doorGeo = new THREE.BoxGeometry(0.96, 1.1, 0.96);
    const doorMat = flat(0xc9a24b, { emissive: 0x5a3f08, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.35 });
    const kindSpec: Record<Kind, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; lit: THREE.Color; cast: boolean } | null> = {
      floor: { geo: floorSrc?.geo ?? fallbackFloorGeo!, mat: floorSrc?.mat ?? flat(THEME.floor), lit: floorLit, cast: false },
      alt: { geo: altSrc?.geo ?? fallbackFloorGeo!, mat: altSrc?.mat ?? flat(THEME.floorAlt), lit: floorLit, cast: false },
      fill: { geo: fillGeo, mat: fillMat, lit: wallFillLit, cast: true },
      panel: wallSrc ? { geo: wallSrc.geo, mat: wallSrc.mat, lit: wallLitColor, cast: true } : null,
      door: { geo: doorGeo, mat: doorMat, lit: new THREE.Color(1, 1, 1), cast: true },
    };

    this.fogTargets = [];
    for (const bucket of buckets.values()) {
      for (const kind of KINDS) {
        const list = bucket[kind];
        const spec = kindSpec[kind];
        if (list.length === 0 || !spec) continue;
        const mesh = new THREE.InstancedMesh(spec.geo, spec.mat, list.length);
        for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i].m);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = spec.cast;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere(); // per-chunk sphere -> real frustum culling
        this.floorGroup.add(mesh);
        this.fogTargets.push({ mesh, tiles: list.map((e) => e.tile), lit: spec.lit });
      }
    }
    this.lastExploredVersion = -1; // force a fog re-tint on the new floor
    this.fogBank.rebuild(map, theme);
    this.ambientFx.rebuild(floorBand(state.floor), state.players[0]?.pos.x ?? map.w / 2, state.players[0]?.pos.y ?? map.h / 2);

    // Stairs: the theme's glTF model when present, else a glowing stepped block.
    const stairsModel = this.modelInstance(theme.stairsKey) ?? this.modelInstance("stairs");
    if (stairsModel) {
      const box = new THREE.Box3().setFromObject(stairsModel);
      const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      if (fp > 1e-4) stairsModel.scale.multiplyScalar(1 / fp);
      const scaled = new THREE.Box3().setFromObject(stairsModel);
      stairsModel.position.set(
        map.stairs.x - (scaled.min.x + scaled.max.x) / 2 + stairsModel.position.x,
        -scaled.min.y + 0.005, // proud of the floor plane so the surfaces don't z-fight
        map.stairs.y - (scaled.min.z + scaled.max.z) / 2 + stairsModel.position.z,
      );
      this.floorGroup.add(stairsModel);
      this.stairsObj = stairsModel;
    } else {
      const stairs = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), flat(THEME.stairs, { emissive: 0x3a2c00, emissiveIntensity: 0.6 }));
      stairs.position.set(map.stairs.x, 0.05, map.stairs.y); stairs.receiveShadow = true;
      this.floorGroup.add(stairs);
      this.stairsObj = stairs;
    }
    this.stairsTile = Math.floor(map.stairs.y) * map.w + Math.floor(map.stairs.x);

    // RULE-BASED DRESSING (intent over noise): torches line room walls with the
    // lights anchored to the visible meshes; banners flank locked doors; clutter
    // clusters live in corners; the LANDMARK hall gets a pillar colonnade and an
    // altar; the VAULT gets its treasure hoard. Cosmetic only; sim never sees it.
    this.propEntries = [];
    const clear = (x: number, y: number, spawnR = 2.5, stairsR = 2.5): boolean => {
      const i = Math.floor(y) * map.w + Math.floor(x);
      if (map.tiles[i] !== Tile.Floor) return false;
      if (Math.hypot(x - map.spawn.x, y - map.spawn.y) < spawnR) return false;
      if (Math.hypot(x - map.stairs.x, y - map.stairs.y) < stairsR) return false;
      return ![i - 1, i + 1, i - map.w, i + map.w].some((n) => map.tiles[n] === Tile.DoorLocked);
    };
    const place = (key: string, x: number, y: number, opts: { scale?: number; rot?: number; jitter?: number } = {}): boolean => {
      if (this.propEntries.length > 150 || !clear(x, y)) return false;
      const obj = this.modelInstance(key);
      if (!obj) return false;
      const box = new THREE.Box3().setFromObject(obj);
      const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
      const themed = theme.propScale?.[key];
      obj.scale.multiplyScalar((opts.scale ?? (themed ? themed * (0.85 + frng() * 0.3) : 0.55 + frng() * 0.2)) / fp);
      const scaled = new THREE.Box3().setFromObject(obj);
      const j = opts.jitter ?? 0.25;
      obj.position.set(
        x + (frng() - 0.5) * j - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
        -scaled.min.y + 0.004,
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
        const nearWall = [i - 1, i + 1, i - map.w, i + map.w].some((n) => map.tiles[n] === Tile.Wall);
        if (!nearWall || !clear(x, y)) return;
        if (place("torch_lit", x, y, { scale: 0.55, jitter: 0.05 })) torchAnchors.push({ x, y });
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
        : theme.props;
      if (pool.length === 0) continue;
      const r = map.rooms[ri];
      const corners: Vec2[] = [
        { x: r.x + 1.2, y: r.y + 1.2 }, { x: r.x + r.w - 1.2, y: r.y + 1.2 },
        { x: r.x + 1.2, y: r.y + r.h - 1.2 }, { x: r.x + r.w - 1.2, y: r.y + r.h - 1.2 },
      ];
      const start = Math.floor(frng() * 4);
      for (let c = 0; c < 2; c++) {
        const corner = corners[(start + c * 2) % 4];
        const n = 1 + Math.floor(frng() * 2);
        for (let k = 0; k < n; k++) {
          const key = pool[Math.floor(frng() * pool.length)];
          place(key, corner.x + (frng() - 0.5) * 0.8, corner.y + (frng() - 0.5) * 0.8);
        }
      }
    }

    // 4) LANDMARK hall: a colonnade + centered set-piece, both band-flavored
    //    (library table in the Undercroft, crypt among dead trees in the Garden,
    //    war monument on the Approach — see FLOOR_THEMES.landmark).
    const landmarkIdx = map.roles.indexOf("landmark");
    if (landmarkIdx >= 0) {
      const r = map.rooms[landmarkIdx];
      const lm = theme.landmark;
      for (let px = r.x + 2; px < r.x + r.w - 2; px += 3) {
        for (let py = r.y + 2; py < r.y + r.h - 2; py += 3) {
          // Colonnade along the room edges of the interior grid, not the middle.
          if (px > r.x + 2 && px < r.x + r.w - 3 && py > r.y + 2 && py < r.y + r.h - 3) continue;
          place(lm.pillarKey, px + 0.5, py + 0.5, { scale: lm.pillarScale, rot: 0, jitter: 0 });
        }
      }
      // Centerpiece note: table_small_decorated_A stays out — its model has
      // candles baked in, and candles are banned from the floors.
      place(lm.centerpieceKey, r.x + r.w / 2, r.y + r.h / 2, { scale: lm.centerpieceScale, rot: 0, jitter: 0 });
    }

    // 5) VAULT: the hoard around the guardian's treasure.
    const vaultIdx = map.roles.indexOf("vault");
    if (vaultIdx >= 0) {
      const r = map.rooms[vaultIdx];
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      place("chest_gold", cx, cy + 1, { scale: 0.7, rot: Math.PI, jitter: 0 });
      place("coin_stack_large", cx - 1, cy, { scale: 0.4 });
      place("coin_stack_medium", cx + 1, cy - 0.5, { scale: 0.35 });
      place("coin_stack_small", cx + 0.5, cy + 0.2, { scale: 0.3 });
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

    // 7) A light sprinkle of theme props elsewhere for texture (much sparser
    //    than before — the intentional placements carry the look now).
    const density = theme.propDensity * 0.35 * (0.6 + frng() * 0.9);
    for (let y = 1; y < map.h - 1 && this.propEntries.length < 150; y++) {
      for (let x = 1; x < map.w - 1 && this.propEntries.length < 150; x++) {
        if (map.tiles[y * map.w + x] !== Tile.Floor) continue;
        if (frng() > density) continue;
        const key = theme.props[Math.floor(frng() * theme.props.length)];
        place(key, x + 0.5, y + 0.5, { jitter: 0.4 });
      }
    }

    this.builtFloor = state.floor;
    this.builtMapVersion = state.mapVersion;
  }

  /** Point lights anchored where torch meshes were placed (light = source). */
  private addTorches(theme: FloorTheme, anchors: Vec2[], intensityJitter: number): void {
    this.torchBase = theme.torchIntensity * intensityJitter;
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
  }

  // ---- Fog of war ----

  private static FOG_DARK = new THREE.Color(0.015, 0.015, 0.025);

  /** Re-tint instanced tiles for the current explored set (multiplicative color). */
  private applyFog(state: GameState): void {
    const { explored, map } = state;
    const wallLit = (idx: number): boolean => {
      // A wall tile lights up when any adjacent floor tile has been explored.
      const x = idx % map.w, y = Math.floor(idx / map.w);
      return (
        (x > 0 && !!explored[idx - 1]) || (x < map.w - 1 && !!explored[idx + 1]) ||
        (y > 0 && !!explored[idx - map.w]) || (y < map.h - 1 && !!explored[idx + map.w])
      );
    };
    for (const { mesh, tiles, lit } of this.fogTargets) {
      for (let i = 0; i < tiles.length; i++) {
        const idx = tiles[i];
        const isLit = map.tiles[idx] === Tile.Wall ? wallLit(idx) : !!explored[idx];
        mesh.setColorAt(i, isLit ? lit : Renderer3D.FOG_DARK);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const { obj, tile } of this.propEntries) obj.visible = !!explored[tile];
    if (this.stairsObj) this.stairsObj.visible = !!explored[this.stairsTile];
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
        this.addTrauma(0.45); // sponsor ordnance lands with authority
      }
    }
    this.prevStrikeCount = strikes.length;
    this.prevStrikePos = strikes.map((s) => ({ x: s.pos.x, y: s.pos.y }));
    while (this.strikeMeshes.length < strikes.length) {
      const keg = this.modelInstance("keg") ?? new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.5, 6), flat(0xb0742c, { emissive: 0x662200, emissiveIntensity: 0.4 }));
      keg.scale.multiplyScalar(0.5);
      this.scene.add(keg);
      this.strikeMeshes.push(keg);
    }
    for (let i = 0; i < this.strikeMeshes.length; i++) {
      const mesh = this.strikeMeshes[i];
      const s = strikes[i];
      if (!s) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.set(s.pos.x, 0.3 + s.t * 14, s.pos.y); // falls as t runs out
      mesh.rotation.x += 0.2;
      mesh.rotation.z += 0.13;
    }
  }

  private updateAbilityFx(state: GameState, dt: number): void {
    this.updateStrikeFx(state);
    for (const p of state.players) {
      // Orbit blades: reconcile each player's pool with their learned blade count.
      const op = knows(p, "orbit") && p.alive ? orbitParams(p) : null;
      const want = op ? op.blades : 0;
      let blades = this.orbitBlades.get(p.id);
      if (!blades) { blades = []; this.orbitBlades.set(p.id, blades); }
      while (blades.length < want) {
        const blade = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          flat(0x9fe8ff, { emissive: 0x2f7d99, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.3 }),
        );
        blade.castShadow = true;
        this.scene.add(blade);
        blades.push(blade);
      }
      while (blades.length > want) this.scene.remove(blades.pop()!);
      if (op) {
        for (let i = 0; i < blades.length; i++) {
          // Shared with the sim's hit test (incl. Corkscrew spiral radii).
          const bp = orbitBladePos(p, i);
          blades[i].position.set(bp.x, 0.75, bp.y);
          blades[i].rotation.y += dt * 10;
        }
      }
      // Nova ring: expands over the flash window, fading out.
      let ring = this.novaRings.get(p.id) ?? null;
      if (p.novaFlash > 0) {
        if (!ring) {
          ring = new THREE.Mesh(
            new THREE.TorusGeometry(1, 0.07, 8, 40),
            new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true }),
          );
          ring.rotation.x = -Math.PI / 2;
          this.scene.add(ring);
          this.novaRings.set(p.id, ring);
        }
        const np = novaParams(p);
        const prog = 1 - p.novaFlash / 0.3;
        if (!ring.visible) {
          this.burst(p.pos.x, p.pos.y, 0x8fd8ff, 18, 0.7, np.radius); // fresh cast
          this.addTrauma(0.3);
        }
        ring.visible = true;
        ring.position.set(p.pos.x, 0.15, p.pos.y);
        ring.scale.setScalar(Math.max(0.05, np.radius * prog));
        (ring.material as THREE.MeshBasicMaterial).opacity = 1 - prog;
      } else if (ring) {
        ring.visible = false;
      }
    }
  }

  // ---- Per-frame sync ----

  update(state: GameState, time: number): void {
    // Rebuild cached floor geometry on descent AND on in-place tile mutations
    // (e.g. locked doors opening when the key is picked up).
    const rebuilt = state.floor !== this.builtFloor || state.mapVersion !== this.builtMapVersion;
    if (rebuilt) {
      // Corpses belong to the old geometry — never carry them across a rebuild.
      for (const d of this.dying) this.scene.remove(d.mesh);
      this.dying = [];
      this.buildFloor(state);
    }
    if (state.exploredVersion !== this.lastExploredVersion) {
      this.lastExploredVersion = state.exploredVersion;
      this.applyFog(state);
      this.fogBank.setExplored(state);
    }
    const dt = this.prevTime ? Math.min(0.1, time - this.prevTime) : 1 / 60;
    this.prevTime = time;
    this.fogBank.update(dt, time);

    // The camera/light anchor: the local player (fall back to the first).
    const p = state.players.find((pl) => pl.id === this.localPlayerId) ?? state.players[0];
    if (!p) return;

    // Players: reconcile mesh pool + animate each.
    const pSeen = new Set<number>();
    for (const pl of state.players) {
      pSeen.add(pl.id);
      // Hero skin: derived from (seed, player id) — a fresh adventurer every
      // run. A seed change (new game, restore) rebuilds the body + regrafts.
      const skin = heroSkin(state.seed, pl.id);
      let mesh = this.playerMeshes.get(pl.id);
      if (mesh && mesh.userData.skinId !== skin) {
        this.scene.remove(mesh);
        this.playerMeshes.delete(pl.id);
        this.loadoutKeys.delete(pl.id);
        mesh = undefined;
      }
      if (!mesh) { mesh = this.buildPlayerMesh(skin); this.scene.add(mesh); this.playerMeshes.set(pl.id, mesh); }
      this.smoothTo(mesh, pl.pos.x, 0, pl.pos.y, dt);
      mesh.rotation.set(0, Math.atan2(pl.facing.x, pl.facing.y), 0);
      mesh.visible = true;
      this.applyLoadout(mesh, pl);
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
    }
    for (const [id, mesh] of this.playerMeshes) {
      if (!pSeen.has(id)) {
        this.scene.remove(mesh);
        this.playerMeshes.delete(id);
        this.animPrev.delete(id);
      }
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

    // Monsters: reconcile mesh pool with live monster set + animate.
    const seen = new Set<number>();
    for (const mon of state.monsters) {
      seen.add(mon.id);
      let mesh = this.monsters.get(mon.id);
      if (!mesh) {
        mesh = this.buildMonsterMesh(mon.kind, state.floor);
        if (mon.elite) {
          // Neighborhood boss: visibly bigger than its archetype.
          const bs = ((mesh.userData.baseScale as number) ?? 1) * CONFIG.eliteScale;
          mesh.userData.baseScale = bs;
          mesh.scale.setScalar(bs);
        }
        this.scene.add(mesh);
        this.monsters.set(mon.id, mesh);
      }
      mesh.visible = inVision(mon.pos);
      const bs = (mesh.userData.baseScale as number) ?? 1;
      this.smoothTo(mesh, mon.pos.x, 0, mon.pos.y, dt);
      const mVel = this.smoothedVel(mesh, dt);
      const mSpeed = Math.hypot(mVel.x, mVel.y);
      mesh.rotation.y = Math.atan2(p.pos.x - mon.pos.x, p.pos.y - mon.pos.y);
      if (mesh.userData.mixer) {
        // Rigged model: clip by combat state. No squash (it would deform the
        // skinned mesh instead of reading as a hit).
        const ud = mesh.userData;
        const playM = ud.play as (n: string, force?: boolean) => void;
        const playFirstM = ud.playFirst as (...n: string[]) => void;
        // Theater: skeletons RISE the first time the fog reveals them, and the
        // introduced menace performs through its ringside freeze.
        if (mesh.visible && !ud.revealed) {
          ud.revealed = true;
          playFirstM("awaken");
        }
        const staggerRose = mon.stagger > 0 && !((ud.prevStagger as number) > 0);
        if (state.encounter?.monsterId === mon.id) {
          // One performance per introduction — playFirst force-restarts, so gate it.
          if (!ud.taunting) { ud.taunting = true; playFirstM("taunt", "idle"); }
        } else {
          ud.taunting = false;
          if (staggerRose) {
            // Shielded elites soak it on the shield (explains the damage reduction);
            // everyone else alternates the two hit reactions.
            if (mon.affix === "shielded") playFirstM("block_hit", "hit");
            else playFirstM((ud.hitAlt = !ud.hitAlt) ? "hit" : "hit_b", "hit");
          } else if (mon.windup > 0) {
            playM(mon.windupKind === "shot" && (ud.hasClip as (n: string) => boolean)("shoot") ? "shoot" : "attack");
          } else if ((ud.animBusy as () => number)() <= 0) {
            // Same hysteresis as players: enter walking decisively, leave lazily.
            ud.locoMoving = (ud.locoMoving as boolean) ? mSpeed > 0.12 : mSpeed > 0.4;
            playM(ud.locoMoving ? "walk" : "idle");
          }
        }
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
      // Attack telegraph: a ground ring that brightens as the strike approaches.
      // Radius = what the attack will actually cover (fuse blast / melee reach).
      let tel = this.telegraphs.get(mon.id);
      if (mon.windup > 0) {
        if (!tel) {
          tel = new THREE.Mesh(
            new THREE.RingGeometry(0.8, 1, 28),
            new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          tel.rotation.x = -Math.PI / 2;
          this.scene.add(tel);
          this.telegraphs.set(mon.id, tel);
        }
        const prog = 1 - mon.windup / Math.max(mon.windupTotal, 1e-3);
        const radius =
          mon.windupKind === "fuse" ? CONFIG.bomberExplodeRadius :
          mon.windupKind === "shot" || mon.windupKind === "spit" ? 0.5 :
          mon.windupKind === "raise" ? 0.7 :
          mon.windupKind === "charge" ? 0.9 : mon.attackRange + CONFIG.monsterStrikeGrace;
        tel.position.set(mon.pos.x, 0.06, mon.pos.y);
        tel.scale.setScalar(radius);
        const mat = tel.material as THREE.MeshBasicMaterial;
        mat.color.setHex(
          mon.windupKind === "fuse" ? 0xff7733 :
          mon.windupKind === "shot" ? 0xffcc44 :
          mon.windupKind === "spit" ? 0xa4c93f :
          mon.windupKind === "raise" ? 0x8a5cff :
          mon.windupKind === "charge" ? 0xff9a2e : 0xff5030,
        );
        mat.opacity = 0.2 + prog * 0.65;
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
    }
    for (const [id, mesh] of this.monsters) {
      if (!seen.has(id)) {
        this.monsters.delete(id);
        const marker = this.keyMarkers.get(id);
        if (marker) { this.scene.remove(marker); this.keyMarkers.delete(id); }
        const tel = this.telegraphs.get(id);
        if (tel) { this.scene.remove(tel); this.telegraphs.delete(id); }
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
          this.dying.push({ mesh, t: rigged ? 1.1 : 0.7, rigged });
        }
      }
    }

    // Floor cleared (or run won): the crawlers play to the camera. A rebuild
    // also empties the count, so gate the edge on NOT having changed floors.
    const monsterCount = state.monsters.length;
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
    // toward detonation; spitter puddles are filled acid pools that fade out.
    const hazSeen = new Set<number>();
    for (const hz of state.hazards) {
      hazSeen.add(hz.id);
      const puddle = hz.kind === "puddle";
      let ring = this.hazardRings.get(hz.id);
      if (!ring) {
        ring = new THREE.Mesh(
          puddle ? new THREE.CircleGeometry(1, 28) : new THREE.RingGeometry(0.8, 1, 28),
          new THREE.MeshBasicMaterial({
            color: puddle ? 0x7fb832 : 0xff4628,
            transparent: true, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.hazardRings.set(hz.id, ring);
      }
      ring.position.set(hz.pos.x, 0.06, hz.pos.y);
      ring.scale.setScalar(hz.radius);
      (ring.material as THREE.MeshBasicMaterial).opacity = puddle
        ? 0.28 + 0.22 * Math.min(1, hz.t / Math.max(hz.total, 1e-3)) // fades as it dries
        : 0.3 + 0.6 * (1 - hz.t / Math.max(hz.total, 1e-3));
      ring.visible = inVision(hz.pos);
    }
    for (const [id, ring] of this.hazardRings) {
      if (!hazSeen.has(id)) { this.scene.remove(ring); this.hazardRings.delete(id); }
    }

    // Projectiles: reconcile a mesh pool by id.
    const projSeen = new Set<number>();
    for (const pr of state.projectiles) {
      projSeen.add(pr.id);
      let mesh = this.projectiles.get(pr.id);
      if (!mesh) {
        // Magic missiles read arcane-violet; physical bolts keep the player hue.
        const color = pr.from !== "player" ? THEME.projectileEnemy
          : pr.school === "magic" ? 0xa06bff : THEME.projectilePlayer;
        const group = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.11, 8, 8),
          flat(color, { emissive: color, emissiveIntensity: 1.4 }),
        );
        group.add(core, this.makeGlow(color, 0.85));
        group.userData.color = color;
        group.userData.lastTrail = 0;
        mesh = group;
        this.scene.add(mesh); this.projectiles.set(pr.id, mesh);
      }
      this.smoothTo(mesh, pr.pos.x, 0.6, pr.pos.y, dt);
      mesh.visible = inVision(pr.pos);
      // Comet trail: a fading glow puff every few ms of flight.
      mesh.userData.lastTrail += dt;
      if (mesh.visible && mesh.userData.lastTrail > 0.035) {
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
    // player (off-screen torches don't need light), then flicker.
    const lp = state.players.find((pl) => pl.alive) ?? state.players[0];
    if (this.torchAnchors.length > 0 && this.torchPool.length > 0) {
      const nearest = [...this.torchAnchors]
        .sort((a, b) =>
          (a.x - lp.pos.x) ** 2 + (a.y - lp.pos.y) ** 2 -
          ((b.x - lp.pos.x) ** 2 + (b.y - lp.pos.y) ** 2))
        .slice(0, this.torchPool.length);
      this.torchPool.forEach((light, i) => {
        const t = nearest[i];
        if (!t) { light.intensity = 0; return; }
        light.position.set(t.x, 1.1, t.y);
        light.intensity = this.torchBase * (0.75 + 0.25 * Math.sin(time * 9 + t.seed) * Math.sin(time * 3.3 + t.seed));
      });
    }

    this.updateParticles(dt);
    this.updateDying(dt);
    this.updateAbilityFx(state, dt);

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
    this.key.position.set(ax + 8, 20, az + 6);
    this.key.target.position.set(ax, 0, az);

    // Band atmosphere rides in a wrap-around box centered on the player.
    this.ambientFx.update(ax, az, dt, time);
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
      const color =
        h.kind === "crit" ? 0xffe066 :
        h.kind === "enemy" ? 0xffb347 :
        h.kind === "player" ? 0xe2574c :
        h.kind === "heal" ? 0x5fd08a :
        h.kind === "gold" ? 0xf2c14e : 0xb98bff;
      // Killing blows pop: a fatter, impact-directed burst + an extra shake kick.
      const n = (h.kind === "crit" ? 14 : 8) + (h.killed ? 10 : 0);
      this.spawnBurst(h.pos.x, h.pos.y, color, n, h.dir);
      if (h.kind === "player") this.addTrauma(0.55); // taking damage should register
      if (h.kind === "crit") this.addTrauma(0.3);
      if (h.killed && h.kind !== "player") this.addTrauma(0.25);
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

  /** Tick lingering corpses: rigged models play their death clip, stand-ins tumble. */
  private updateDying(dt: number): void {
    const alive: typeof this.dying = [];
    for (const d of this.dying) {
      d.t -= dt;
      if (d.t <= 0) { this.scene.remove(d.mesh); continue; }
      if (d.rigged) {
        (d.mesh.userData.mixer as THREE.AnimationMixer).update(dt);
      } else {
        d.mesh.rotation.z = Math.min(Math.PI / 2, d.mesh.rotation.z + dt * 4);
        d.mesh.position.y -= dt * 0.6;
      }
      alive.push(d);
    }
    this.dying = alive;
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
    this.renderer.render(this.scene, this.camera);
  }
}
