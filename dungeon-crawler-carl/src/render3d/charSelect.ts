import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CRAWLER_SKINS, type CrawlerSkin } from "../sim/game";
import type { LoadedModel } from "./assets";

// RINGSIDE CHECK-IN, the campfire: the eight crawlers stand around a fire in
// the dark (Diablo II style) while the check-in panel floats beside them.
// Click a crawler (or arrow keys) to decide who you are — cosmetic only, the
// constellation stays the build. Rendered with the game's own WebGLRenderer
// on the game canvas; main3d drives frame() while the menu is open and the
// game world simply isn't rendered those frames.
//
// Models stream in like everything else: slots start empty and fill as the
// crawler_* GLBs (and the medium rig clip library) arrive — the scene is
// watchable from the first frame either way (ground, fire, firelight).

/** Model key per skin id — mirrors SKIN_MODEL's `c:` rows in renderer3d. */
const LINEUP_MODEL: Record<CrawlerSkin, string> = {
  knight: "crawler_knight", barbarian: "crawler_barbarian",
  druid: "crawler_druid", engineer: "crawler_engineer",
  mage: "crawler_mage", ranger: "crawler_ranger",
  rogue: "crawler_rogue", hooded: "crawler_hooded",
};

const ARC_RADIUS = 3.4;
const ARC_SPREAD = (Math.PI * 165) / 180; // the lineup's total angular width
const STEP_FORWARD = 0.55; // how far the chosen crawler steps toward the camp center
// The fire anchors the center of the frame; the wide arc spreads the band
// around it so the ends flank a centered panel in the backdrop stage.
const FIRE_X = 0;
const FIRE_Z = 0.35;

interface Slot {
  skin: CrawlerSkin;
  anchor: THREE.Group; // positioned on the arc; the model goes inside
  model: THREE.Group | null;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  home: THREE.Vector3;
  fwd: THREE.Vector3; // unit vector toward the fire (the step direction)
}

// Camp dressing: a clearing at the edge of the forest, the night before the
// descent. Hand-composed (not scattered) so the treeline frames the lineup,
// the gap stays open for the camera, and the supplies read as A CAMP —
// someone hauled these here. Models come from the same streamed store the
// game world uses (Forest Nature + Dungeon packs, all already shipped);
// pieces pop in as their GLBs arrive, exactly like the crawlers do.
interface DressSpec {
  key: string; // MODEL_MANIFEST key
  x: number;
  z: number;
  h: number; // normalized world height
  rot?: number; // yaw, radians
  shadow?: boolean; // only near-fire pieces cast (point-light shadows are pricey)
}
const DRESSING: DressSpec[] = [
  // Back treeline — tallest, framing the band, denser behind the arc.
  { key: "forest_tree_1_a", x: -8.6, z: -6.8, h: 4.6 },
  { key: "forest_tree_3_a", x: -5.9, z: -8.4, h: 5.2, rot: 1.1 },
  { key: "forest_tree_2_a", x: -3.0, z: -9.6, h: 4.2, rot: 2.3 },
  { key: "forest_tree_5_a", x: 0.4, z: -10.2, h: 5.6, rot: 0.4 },
  { key: "forest_tree_1_b", x: 3.6, z: -9.2, h: 4.4, rot: 3.6 },
  { key: "forest_tree_4_a", x: 6.4, z: -8.0, h: 5.0, rot: 5.1 },
  { key: "forest_tree_2_a", x: 9.0, z: -6.2, h: 4.0, rot: 4.2 },
  // Flanks — pull the forest around the sides of the frame.
  { key: "forest_tree_3_a", x: -11.4, z: -2.4, h: 5.4, rot: 2.8 },
  { key: "forest_tree_1_a", x: 11.8, z: -1.8, h: 4.8, rot: 1.9 },
  { key: "forest_tree_bare_1_a", x: -10.2, z: 2.6, h: 4.3, rot: 0.7 }, // one dead one — this IS still the dungeon's doorstep
  { key: "forest_tree_5_a", x: 10.6, z: 3.4, h: 5.0, rot: 5.8 },
  // Understory between the trunks.
  { key: "forest_bush_1_a", x: -7.2, z: -5.2, h: 0.9, rot: 1.2 },
  { key: "forest_bush_2_a", x: 2.0, z: -8.6, h: 0.8, rot: 4.4 },
  { key: "forest_bush_4_a", x: 7.8, z: -5.6, h: 1.0, rot: 2.1 },
  { key: "forest_bush_1_a", x: -10.0, z: 0.2, h: 0.85, rot: 3.3 },
  { key: "forest_rock_1_a", x: -4.6, z: -6.9, h: 0.9, rot: 0.9 },
  { key: "forest_rock_3_c", x: 5.2, z: -7.0, h: 0.7, rot: 2.6 },
  { key: "forest_rock_6_a", x: 10.4, z: -4.0, h: 1.2, rot: 4.9 },
  { key: "forest_grass_1_a", x: -2.6, z: -5.4, h: 0.4 },
  { key: "forest_grass_2_a", x: 3.4, z: -5.8, h: 0.4, rot: 2.2 },
  { key: "forest_grass_1_a", x: -6.4, z: -2.2, h: 0.35, rot: 4.1 },
  { key: "forest_grass_2_a", x: 6.8, z: -2.6, h: 0.4, rot: 1.5 },
  // The camp itself — a fallen trunk to sit on, supplies for the descent.
  { key: "trunk_small_A", x: -1.9, z: 2.1, h: 0.55, rot: 1.35, shadow: true },
  { key: "forest_rock_1_a", x: 2.3, z: 2.0, h: 0.55, rot: 3.8, shadow: true },
  { key: "barrel_small", x: 3.3, z: 1.4, h: 0.85, rot: 0.6, shadow: true },
  { key: "crates_stacked", x: 3.9, z: 2.2, h: 1.0, rot: 5.5, shadow: true },
];

/** Two camera moods, lerped between: the campfire holds the OPEN side of the
 *  frame while you pick a mode, then the casting call brings the lineup
 *  center stage for the actual pick. */
const CAMERA_POSES = {
  backdrop: { fov: 46, pos: new THREE.Vector3(0, 2.7, 9.8), look: new THREE.Vector3(0, 1.1, -0.4) },
  casting: { fov: 45, pos: new THREE.Vector3(0, 2.2, 8.1), look: new THREE.Vector3(0, 0.95, -0.7) },
} as const;

// social r2 — THE COMPOSITION, NOT JUST THE RIG. The r1 light lift was real
// (ambient 1.9->3.2, hemisphere added, rim 1.1->1.9, fire 46->64) and moved
// the hero region's mean luminance 3.0 -> only 3.5% at 1366, because the
// backdrop pose kept the campfire dead-center of the CANVAS — which is
// dead-center BEHIND the check-in panel. The 40% of the frame the panel
// leaves open (left of it) got the arc's dark outer arm and no fire at all;
// a fire cannot light a region it is not in. The backdrop pose now TRUCKS
// RIGHT — pure translation, no rotation, so the lineup still faces the
// camera — until the campfire sits at ~24% of the frame width: the center
// of the open region. The panel is width-tokened (56vw) and right-docked
// (3.5vw pad), so that fraction holds at every 16:9 viewport, and the truck
// is computed from the live aspect so ultrawides keep it too. CASTING is
// untouched: the panel is gone in that stage and center is correct.
const FIRE_SCREEN_FRAC = 0.24; // campfire's target x, as a fraction of frame width
/** World-units truck that puts the fire at FIRE_SCREEN_FRAC for this aspect. */
function backdropTruck(aspect: number): number {
  const pose = CAMERA_POSES.backdrop;
  const halfW = Math.tan((pose.fov * Math.PI) / 360) * (pose.pos.z - FIRE_Z) * aspect;
  return (1 - 2 * FIRE_SCREEN_FRAC) * halfW; // NDC shift * half width
}

export class CharSelectScene {
  selected: CrawlerSkin;
  onSelect: ((skin: CrawlerSkin) => void) | null = null;
  enabled = false; // main3d flips this with the menu; gates input handlers
  /** backdrop = ambiance behind the panel (no input); casting = the pick. */
  mode: keyof typeof CAMERA_POSES = "backdrop";

  private readonly gl: THREE.WebGLRenderer;
  private readonly camPos = CAMERA_POSES.backdrop.pos.clone();
  private readonly camLook = CAMERA_POSES.backdrop.look.clone();
  private camFov = CAMERA_POSES.backdrop.fov;
  // A GETTER, not a snapshot: Renderer3D reassigns its live model record when
  // the async asset stream starts, which is usually AFTER the menu opens.
  private readonly modelsOf: () => Record<string, LoadedModel>;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  private readonly slots: Slot[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly fireLight: THREE.PointLight;
  private emberLight: THREE.PointLight | null = null; // fills the fire's own base (r3)
  private readonly halo: THREE.SpotLight; // drifts to the chosen crawler
  private flames: THREE.Mesh[] = [];
  private sparks: THREE.Points | null = null;
  private sparkPhase: number[] = [];
  private readonly dressPlaced: boolean[] = DRESSING.map(() => false);
  private lastT = 0;
  private readonly onClick: (e: MouseEvent) => void;
  private readonly onMove: (e: MouseEvent) => void;

  constructor(gl: THREE.WebGLRenderer, modelsOf: () => Record<string, LoadedModel>, initial: CrawlerSkin) {
    this.gl = gl;
    this.modelsOf = modelsOf;
    this.selected = initial;

    this.scene.background = new THREE.Color(0x05040a);
    // Light enough fog that the treeline still reads as shapes, heavy enough
    // that the forest fades to night instead of ending at a horizon line.
    this.scene.fog = new THREE.FogExp2(0x05040a, 0.042);

    // Night: readable ambient (KayKit palettes want light), a cold rim from
    // behind, and the fire doing the character work.
    // social r1 — LIGHT IT TO EARN THE SPACE: the hero region left of the
    // check-in panel measured 3% mean luminance at 1366 (the screens critic:
    // "you cannot tell three characters are standing there"). The rig now
    // spends real light on the lineup: a brighter warm ambient floor, a
    // moonlight hemisphere so silhouettes separate from the treeline, a
    // stronger cold rim, and a fire that actually carries to the arc. Still
    // night — the target is D2's campfire, not noon.
    this.scene.add(new THREE.AmbientLight(0x2b2836, 3.2));
    this.scene.add(new THREE.HemisphereLight(0x3a4668, 0x2a1c10, 0.9));
    const rim = new THREE.DirectionalLight(0x38486e, 1.9);
    rim.position.set(-4, 6, -8);
    this.scene.add(rim);
    this.fireLight = new THREE.PointLight(0xff8c3a, 64, 26, 2);
    this.fireLight.position.set(FIRE_X, 1.1, FIRE_Z);
    this.fireLight.castShadow = true;
    this.scene.add(this.fireLight);
    this.halo = new THREE.SpotLight(0xf5e6bf, 26, 14, 0.34, 0.55, 1.6);
    this.halo.position.set(0, 6.5, 2.5);
    this.scene.add(this.halo, this.halo.target);

    // Ground: a worn dark clearing (lifted with the rest of the rig so the
    // firelight has something to bounce off in the frame).
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 40),
      new THREE.MeshStandardMaterial({ color: 0x1e1712, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.buildFire();

    // The lineup: eight anchors on the far arc, facing the fire/camera.
    CRAWLER_SKINS.forEach((skin, i) => {
      const a = (i / (CRAWLER_SKINS.length - 1) - 0.5) * ARC_SPREAD;
      const anchor = new THREE.Group();
      const x = Math.sin(a) * ARC_RADIUS;
      const z = -Math.cos(a) * ARC_RADIUS;
      anchor.position.set(x, 0, z);
      anchor.lookAt(0, 0, 4); // face past the fire, toward the camera
      this.scene.add(anchor);
      const fwd = new THREE.Vector3(-x, 0, -z).normalize();
      this.slots.push({ skin, anchor, model: null, mixer: null, idle: null, home: anchor.position.clone(), fwd });
    });

    // Camera starts in the backdrop pose; frame() glides it toward whichever
    // pose `mode` asks for (panel check-in vs the full casting call).
    this.camera.fov = this.camFov;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();

    this.onClick = (e) => {
      if (!this.enabled || this.mode !== "casting") return;
      const hit = this.pick(e);
      if (hit) this.select(hit);
    };
    this.onMove = (e) => {
      if (!this.enabled || this.mode !== "casting") {
        this.gl.domElement.style.cursor = "";
        return;
      }
      this.gl.domElement.style.cursor = this.pick(e) ? "pointer" : "";
    };
    this.gl.domElement.addEventListener("click", this.onClick);
    this.gl.domElement.addEventListener("mousemove", this.onMove);
  }

  /** Campfire: log ring + layered emissive flames + rising sparks. */
  private buildFire(): void {
    // Ember-lit logs: the fire light sits INSIDE the ring, so the faces the
    // camera sees would otherwise render pitch black — the emissive is the
    // glow of wood that has been burning a while.
    // social r3 (lighting rig): 0.32 was tuned before the flames' additive
    // brightness went up — against the lit flame the camera-facing log faces
    // and their hard point-light shadows measured near-black and read as
    // paper-cutout shards. The ember glow carries further now, and a small
    // shadowless ember fill (below) lifts the fire's own base the way real
    // coals throw light back at the ring.
    const logMat = new THREE.MeshStandardMaterial({
      color: 0x4a3524, roughness: 0.9,
      emissive: 0xff5a1f, emissiveIntensity: 0.62,
    });
    const logs = new THREE.Group();
    const logGeo = new THREE.CylinderGeometry(0.06, 0.075, 0.8, 6);
    for (let i = 0; i < 5; i++) {
      const log = new THREE.Mesh(logGeo, logMat);
      const a = (i / 5) * Math.PI * 2;
      log.position.set(Math.cos(a) * 0.18, 0.12, Math.sin(a) * 0.18);
      log.rotation.set(Math.PI / 2.35, a, 0);
      log.castShadow = true;
      logs.add(log);
    }
    logs.position.set(FIRE_X, 0, FIRE_Z);
    this.scene.add(logs);

    // The ember fill: a short-throw, shadowless warm light AT coal height.
    // The main fireLight sits at y=1.1 (so it reaches the lineup); from up
    // there the log ring lights its tops and leaves its camera-facing sides
    // and its own ground shadows pitch black. Coals light a fire from below;
    // this is that, and it reaches nothing but the ring and the dirt.
    const ember = new THREE.PointLight(0xff7a2a, 7, 4.5, 2);
    ember.position.set(FIRE_X, 0.3, FIRE_Z + 0.12);
    this.scene.add(ember);
    this.emberLight = ember;

    // Flames: three nested cones, emissive, additive — flicker via scale.
    const flameSpec = [
      { r: 0.34, h: 0.85, color: 0xff5a1f, opacity: 0.85 },
      { r: 0.22, h: 1.1, color: 0xff9c2e, opacity: 0.9 },
      { r: 0.12, h: 1.32, color: 0xffe08a, opacity: 0.95 },
    ];
    for (const f of flameSpec) {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(f.r, f.h, 8),
        new THREE.MeshBasicMaterial({
          color: f.color, transparent: true, opacity: f.opacity,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      m.position.set(FIRE_X, 0.25 + f.h / 2, FIRE_Z);
      this.scene.add(m);
      this.flames.push(m);
    }

    // Sparks: a few dozen points cycling upward on private phases.
    const N = 36;
    const pos = new Float32Array(N * 3);
    this.sparkPhase = Array.from({ length: N }, (_, i) => (i * 0.618) % 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffc36b, size: 0.05, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(this.sparks);
  }

  /** Raycast the lineup; returns the hit skin or null. */
  private pick(e: MouseEvent): CrawlerSkin | null {
    const rect = this.gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const roots = this.slots.filter((s) => s.model).map((s) => s.anchor);
    const hits = this.raycaster.intersectObjects(roots, true);
    if (!hits.length) return null;
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !roots.includes(o as THREE.Group)) o = o.parent;
    const slot = this.slots.find((s) => s.anchor === o);
    return slot ? slot.skin : null;
  }

  select(skin: CrawlerSkin): void {
    if (skin === this.selected) return;
    this.selected = skin;
    this.flourish(skin);
    this.onSelect?.(skin);
  }

  cycle(dir: 1 | -1): void {
    const i = CRAWLER_SKINS.indexOf(this.selected);
    this.select(CRAWLER_SKINS[(i + dir + CRAWLER_SKINS.length) % CRAWLER_SKINS.length]);
  }

  /** One-shot acknowledgment clip on the chosen crawler, then back to idle. */
  private flourish(skin: CrawlerSkin): void {
    const slot = this.slots.find((s) => s.skin === skin);
    if (!slot?.mixer || !slot.model) return;
    const clips = this.modelsOf()[LINEUP_MODEL[skin]]?.animations ?? [];
    const clip =
      clips.find((c) => /wave/i.test(c.name)) ??
      clips.find((c) => /cheer/i.test(c.name)) ??
      clips.find((c) => /interact/i.test(c.name));
    if (!clip) return;
    const act = slot.mixer.clipAction(clip);
    act.reset().setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = false;
    slot.idle?.crossFadeTo(act, 0.15, false);
    act.play();
    const mixer = slot.mixer;
    const onDone = (ev: { action: THREE.AnimationAction }): void => {
      if (ev.action !== act) return;
      mixer.removeEventListener("finished", onDone as never);
      if (slot.idle) { slot.idle.reset(); act.crossFadeTo(slot.idle, 0.2, false); slot.idle.play(); }
    };
    mixer.addEventListener("finished", onDone as never);
  }

  /** Place camp dressing as its models stream in (static clones, one each). */
  private hydrateDressing(): void {
    const models = this.modelsOf();
    DRESSING.forEach((d, i) => {
      if (this.dressPlaced[i]) return;
      const loaded = models[d.key];
      if (!loaded) return;
      const m = loaded.scene.clone(true);
      const box = new THREE.Box3().setFromObject(m);
      const h = box.max.y - box.min.y;
      if (h > 0) m.scale.multiplyScalar(d.h / h);
      m.position.set(d.x, 0, d.z);
      m.rotation.y = d.rot ?? 0;
      if (d.shadow) m.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
      this.scene.add(m);
      this.dressPlaced[i] = true;
    });
  }

  /** Fill empty slots as their GLBs (and the rig clips) stream in. */
  private hydrate(): void {
    const models = this.modelsOf();
    for (const slot of this.slots) {
      const loaded = models[LINEUP_MODEL[slot.skin]];
      if (!slot.model && loaded) {
        const model = cloneSkinned(loaded.scene) as THREE.Group;
        const box = new THREE.Box3().setFromObject(model);
        const h = box.max.y - box.min.y;
        if (h > 0) model.scale.multiplyScalar(1.35 / h);
        model.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
        slot.anchor.add(model);
        slot.model = model;
        slot.mixer = new THREE.AnimationMixer(model);
      }
      if (slot.mixer && !slot.idle && loaded) {
        const clip =
          loaded.animations.find((c) => /^idle$/i.test(c.name)) ??
          loaded.animations.find((c) => /idle/i.test(c.name));
        if (clip) {
          slot.idle = slot.mixer.clipAction(clip);
          // Desync the breathing so the lineup doesn't metronome.
          slot.idle.time = (this.slots.indexOf(slot) * 0.37) % Math.max(0.01, clip.duration);
          slot.idle.play();
        }
      }
    }
  }

  /** BUILD THE CAMPFIRE BEHIND THE LOADING CARD (perf opt2).
   *
   *  Everything this scene costs is paid on its FIRST rendered frame: eight
   *  SkeletonUtils clones, ~28 camp-dressing clones, the program variants the
   *  scene's materials need, and its first shadow-map build. Measured, that
   *  first frame was a 554 ms freeze landing 13 ms after the overlay lifted —
   *  the menu faded in on a frozen main thread. main3d calls this once during
   *  the prewarm phase instead, while the opaque card still covers the canvas.
   *
   *  Deliberately does NOT touch `lastT`, the mixers, `camPos/camLook/camFov`
   *  or `selected`: the first LIVE frame() must run from exactly the state it
   *  runs from today, so the scene animates and dollies identically. Two
   *  renders because the second one is where the deferred uploads/rebuild the
   *  first one queues get paid (78 ms of the measured stall lived there). */
  warm(): void {
    this.hydrate();
    this.hydrateDressing();
    // Match the live aspect so the warm render's frustum covers what the first
    // real frame will draw (frame() does the same assignment on its own path).
    const el = this.gl.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    if (Math.abs(aspect - this.camera.aspect) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    for (let i = 0; i < 2; i++) {
      this.gl.shadowMap.needsUpdate = true; // see frame(): autoUpdate is off
      this.gl.render(this.scene, this.camera);
    }
  }

  /** Advance and render one frame. Call only while the menu owns the screen. */
  frame(tSec: number): void {
    const dt = this.lastT ? Math.min(0.1, tSec - this.lastT) : 0.016;
    this.lastT = tSec;
    this.hydrate();
    this.hydrateDressing();

    // Fire: flicker the light + jitter the flame cones on mixed sines.
    const n = Math.sin(tSec * 11.3) * 0.35 + Math.sin(tSec * 23.7 + 1.7) * 0.2 + Math.sin(tSec * 5.1 + 4.2) * 0.45;
    this.fireLight.intensity = 64 + n * 12; // flicker rides the r1 base, not the old one
    if (this.emberLight) this.emberLight.intensity = 7 + n * 1.6; // coals breathe with the flame
    this.flames.forEach((f, i) => {
      const w = Math.sin(tSec * (9 + i * 3.1) + i * 2.4);
      f.scale.set(1 + w * 0.08, 1 + Math.sin(tSec * (7.5 + i * 2.3)) * 0.13, 1 + w * 0.08);
      f.rotation.y = tSec * (0.6 + i * 0.35);
    });
    if (this.sparks) {
      const pos = this.sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < this.sparkPhase.length; i++) {
        const p = (this.sparkPhase[i] + tSec * 0.14 * (0.6 + (i % 5) * 0.18)) % 1;
        const swirl = tSec * 1.7 + i * 2.1;
        pos.setXYZ(i, FIRE_X + Math.cos(swirl) * 0.16 * (1 - p), 0.4 + p * 2.1, FIRE_Z + Math.sin(swirl) * 0.16 * (1 - p));
      }
      pos.needsUpdate = true;
      (this.sparks.material as THREE.PointsMaterial).opacity = 0.5 + n * 0.2;
    }

    // The chosen crawler steps toward the fire; everyone else steps home.
    for (const slot of this.slots) {
      const target = slot.skin === this.selected
        ? slot.home.clone().addScaledVector(slot.fwd, STEP_FORWARD)
        : slot.home;
      slot.anchor.position.lerp(target, Math.min(1, dt * 6));
      slot.mixer?.update(dt);
    }
    const sel = this.slots.find((s) => s.skin === this.selected)!;
    this.halo.target.position.lerp(sel.anchor.position.clone().setY(1.0), Math.min(1, dt * 6));
    this.halo.position.lerp(sel.anchor.position.clone().add(new THREE.Vector3(0.4, 5.6, 2.2)), Math.min(1, dt * 6));

    // Glide the camera toward the active pose (check-in backdrop vs the
    // casting call) — a slow dolly, not a cut. The backdrop pose carries the
    // aspect-aware truck (see backdropTruck) that frames the campfire in the
    // open region beside the panel instead of behind it.
    const el = this.gl.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    const pose = CAMERA_POSES[this.mode];
    const truck = this.mode === "backdrop" ? backdropTruck(aspect) : 0;
    const k = Math.min(1, dt * 3);
    this.camPos.lerp(new THREE.Vector3(pose.pos.x + truck, pose.pos.y, pose.pos.z), k);
    this.camLook.lerp(new THREE.Vector3(pose.look.x + truck, pose.look.y, pose.look.z), k);
    this.camFov += (pose.fov - this.camFov) * k;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    if (Math.abs(aspect - this.camera.aspect) > 1e-3 || Math.abs(this.camFov - this.camera.fov) > 0.05) {
      this.camera.aspect = aspect;
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }
    // Renderer3D turns shadowMap.autoUpdate OFF (it drives the dungeon's key
    // light manually so the map is not rebuilt once per post-processing pass),
    // and this scene shares that WebGLRenderer. Arm our own rebuild or the
    // campfire renders against a stale/empty shadow map.
    this.gl.shadowMap.needsUpdate = true;
    this.gl.render(this.scene, this.camera);
  }

  dispose(): void {
    this.gl.domElement.removeEventListener("click", this.onClick);
    this.gl.domElement.removeEventListener("mousemove", this.onMove);
    this.gl.domElement.style.cursor = "";
  }
}
