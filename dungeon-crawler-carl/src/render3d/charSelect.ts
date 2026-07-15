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

const ARC_RADIUS = 2.7;
const ARC_SPREAD = (Math.PI * 100) / 180; // the lineup's total angular width
const STEP_FORWARD = 0.55; // how far the chosen crawler steps toward the camp center
// The fire sits off-center so it peeks out from behind the docked panel while
// the lineup owns the left of the frame (composition tuned against 1280x800).
const FIRE_X = 1.1;
const FIRE_Z = 0.7;

interface Slot {
  skin: CrawlerSkin;
  anchor: THREE.Group; // positioned on the arc; the model goes inside
  model: THREE.Group | null;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  home: THREE.Vector3;
  fwd: THREE.Vector3; // unit vector toward the fire (the step direction)
}

/** Two camera moods, lerped between: the fire burns BEHIND the check-in panel
 *  while you pick a mode, then the casting call brings the lineup center
 *  stage for the actual pick. */
const CAMERA_POSES = {
  backdrop: { fov: 38, pos: new THREE.Vector3(-4.2, 1.9, 4.6), look: new THREE.Vector3(0.5, 1.0, -1.5) },
  casting: { fov: 42, pos: new THREE.Vector3(0.15, 2.15, 7.4), look: new THREE.Vector3(0.15, 0.95, -1.3) },
} as const;

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
  private readonly halo: THREE.SpotLight; // drifts to the chosen crawler
  private flames: THREE.Mesh[] = [];
  private sparks: THREE.Points | null = null;
  private sparkPhase: number[] = [];
  private lastT = 0;
  private readonly onClick: (e: MouseEvent) => void;
  private readonly onMove: (e: MouseEvent) => void;

  constructor(gl: THREE.WebGLRenderer, modelsOf: () => Record<string, LoadedModel>, initial: CrawlerSkin) {
    this.gl = gl;
    this.modelsOf = modelsOf;
    this.selected = initial;

    this.scene.background = new THREE.Color(0x05040a);
    this.scene.fog = new THREE.FogExp2(0x05040a, 0.052);

    // Night: readable ambient (KayKit palettes want light), a cold rim from
    // behind, and the fire doing the character work.
    this.scene.add(new THREE.AmbientLight(0x232030, 1.9));
    const rim = new THREE.DirectionalLight(0x38486e, 1.1);
    rim.position.set(-4, 6, -8);
    this.scene.add(rim);
    this.fireLight = new THREE.PointLight(0xff8c3a, 46, 22, 2);
    this.fireLight.position.set(FIRE_X, 1.1, FIRE_Z);
    this.fireLight.castShadow = true;
    this.scene.add(this.fireLight);
    this.halo = new THREE.SpotLight(0xf5e6bf, 18, 14, 0.34, 0.55, 1.6);
    this.halo.position.set(0, 6.5, 2.5);
    this.scene.add(this.halo, this.halo.target);

    // Ground: a worn dark clearing.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 40),
      new THREE.MeshStandardMaterial({ color: 0x181310, roughness: 0.95 }),
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
    const logMat = new THREE.MeshStandardMaterial({
      color: 0x4a3524, roughness: 0.9,
      emissive: 0xff5a1f, emissiveIntensity: 0.32,
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

  /** Advance and render one frame. Call only while the menu owns the screen. */
  frame(tSec: number): void {
    const dt = this.lastT ? Math.min(0.1, tSec - this.lastT) : 0.016;
    this.lastT = tSec;
    this.hydrate();

    // Fire: flicker the light + jitter the flame cones on mixed sines.
    const n = Math.sin(tSec * 11.3) * 0.35 + Math.sin(tSec * 23.7 + 1.7) * 0.2 + Math.sin(tSec * 5.1 + 4.2) * 0.45;
    this.fireLight.intensity = 46 + n * 9;
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
    // casting call) — a slow dolly, not a cut.
    const pose = CAMERA_POSES[this.mode];
    const k = Math.min(1, dt * 3);
    this.camPos.lerp(pose.pos, k);
    this.camLook.lerp(pose.look, k);
    this.camFov += (pose.fov - this.camFov) * k;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    const el = this.gl.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    if (Math.abs(aspect - this.camera.aspect) > 1e-3 || Math.abs(this.camFov - this.camera.fov) > 0.05) {
      this.camera.aspect = aspect;
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.gl.render(this.scene, this.camera);
  }

  dispose(): void {
    this.gl.domElement.removeEventListener("click", this.onClick);
    this.gl.domElement.removeEventListener("mousemove", this.onMove);
    this.gl.domElement.style.cursor = "";
  }
}
