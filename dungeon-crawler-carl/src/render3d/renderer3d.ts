import * as THREE from "three";
import { Tile, type GameState, type HitEvent, type Player, type Vec2 } from "../sim/types";
import { THEME } from "./theme";
import { loadModels, type LoadedModel } from "./assets";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { knows, novaParams, orbitParams } from "../sim/abilities";
import { CONFIG } from "../sim/config";
import { cosmeticRng, themeForFloor, tileHash, type FloorTheme } from "./floorThemes";
import { ATTACHMENT_NODES, CANONICAL_LOADOUT, loadoutFor, rarityGlow } from "./weaponry";

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
  private torchLights: { light: THREE.PointLight; base: number; seed: number }[] = [];

  // Party rendering: one mesh per player id. The camera follows localPlayerId.
  private playerMeshes = new Map<number, THREE.Group>();
  localPlayerId = 0;
  private monsters = new Map<number, THREE.Group>();
  private keyMarkers = new Map<number, THREE.Mesh>(); // floating marker over key carriers
  private loot = new Map<number, THREE.Mesh>();
  private projectiles = new Map<number, THREE.Mesh>();

  private models: Record<string, LoadedModel> = {};
  private builtFloor = -1;
  private builtMapVersion = -1;
  private aspect = 1;

  // Fog of war: instanced meshes tinted per tile (white = explored, near-black =
  // hidden). `tiles[i]` is the map tile index behind instance i of `mesh`.
  private fogTargets: { mesh: THREE.InstancedMesh; tiles: number[]; lit: THREE.Color }[] = [];
  private propEntries: { obj: THREE.Object3D; tile: number }[] = [];
  private stairsObj: THREE.Object3D | null = null;
  private stairsTile = -1;
  private lastExploredVersion = -1;

  // Ability visuals, per player id.
  private orbitBlades = new Map<number, THREE.Mesh[]>();
  private novaRings = new Map<number, THREE.Mesh>();

  // Animation / juice state (all host-side cosmetics; sim stays pure).
  private prevPlayers = new Map<number, Vec2>();
  private prevSwings = new Map<number, number>();
  private loadoutKeys = new Map<number, string>(); // player id -> applied weapon/shield key
  private prevMon = new Map<number, Vec2>();
  private prevTime = 0;
  private shake = 0;
  private particles: {
    mesh: THREE.Mesh;
    vx: number; vy: number; vz: number; life: number; max: number;
  }[] = [];
  private sharedParticleGeo = new THREE.TetrahedronGeometry(0.09, 0);

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
   * Wire an AnimationMixer with idle/walk/attack/death actions (clip names matched
   * fuzzily so any humanoid pack works). Exposes userData.mixer and
   * userData.play(name, force?) with crossfading; one-shot actions clamp.
   */
  private attachClipAnimator(g: THREE.Group, clips: THREE.AnimationClip[]): void {
    const pick = (...res: RegExp[]) => {
      for (const re of res) {
        const c = clips.find((c) => re.test(c.name));
        if (c) return c;
      }
      return null;
    };
    const found: Record<string, THREE.AnimationClip | null> = {
      idle: pick(/^idle$/i, /idle/i),
      walk: pick(/^walk/i, /walk/i, /^run/i, /run/i),
      attack: pick(/melee.*attack/i, /attack/i, /slice|chop|stab/i),
      death: pick(/^death/i, /death|die/i),
    };
    const mixer = new THREE.AnimationMixer(g);
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const [name, clip] of Object.entries(found)) {
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      if (name === "attack" || name === "death") {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        if (name === "attack") a.timeScale = Math.max(1, clip.duration / 0.3);
      }
      actions[name] = a;
    }
    let current = "";
    g.userData.mixer = mixer;
    g.userData.play = (name: string, force = false) => {
      const next = actions[name];
      if (!next || (current === name && !force)) return;
      const prev = actions[current];
      next.reset().play();
      if (prev && prev !== next) prev.crossFadeTo(next, 0.12, false);
      current = name;
    };
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

  private buildPlayerMesh(): THREE.Group {
    const model = this.modelInstance("player");
    if (model) {
      this.normalizeHeight(model, 1.35);
      return model;
    }
    const g = new THREE.Group();
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
  private applyLoadout(mesh: THREE.Group, pl: Player): void {
    const { weapon, shield } = loadoutFor(pl);
    const key = `${weapon.srcKey}/${weapon.node}/${shield ?? "-"}/${pl.equipment.weapon?.rarity ?? "-"}`;
    if (this.loadoutKeys.get(pl.id) === key) return;
    this.loadoutKeys.set(pl.id, key);

    // Hide every known attachment (including previous grafts).
    for (const name of ATTACHMENT_NODES.player) {
      const node = mesh.getObjectByName(name);
      if (node) node.visible = false;
    }
    const grafts: THREE.Object3D[] = (mesh.userData.grafts as THREE.Object3D[]) ?? [];
    for (const g of grafts) g.visible = false;

    // Shield (armor slot), unless the weapon needs both hands.
    if (shield) {
      const node = mesh.getObjectByName(shield);
      if (node) node.visible = true;
    }

    // Weapon: native node or a cached cross-model graft.
    let weaponObj: THREE.Object3D | null = null;
    if (weapon.srcKey === "player") {
      weaponObj = mesh.getObjectByName(weapon.node) ?? null;
      if (weaponObj) weaponObj.visible = true;
    } else {
      const graftName = `graft_${weapon.srcKey}_${weapon.node}`;
      weaponObj = mesh.getObjectByName(graftName) ?? null;
      if (!weaponObj) {
        const srcModel = this.models[weapon.srcKey];
        const srcNode = srcModel?.scene.getObjectByName(weapon.node);
        // GLTFLoader sanitizes node names ("handslot.r" -> "handslotr").
        const hand = mesh.getObjectByName("handslotr") ?? mesh.getObjectByName("handslot.r");
        if (srcNode && hand) {
          weaponObj = srcNode.clone(true);
          weaponObj.name = graftName;
          // Same rig family: the node's local transform relative to its own
          // handslot carries over 1:1.
          hand.add(weaponObj);
          grafts.push(weaponObj);
          mesh.userData.grafts = grafts;
        }
      }
      if (weaponObj) weaponObj.visible = true;
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

  private buildMonsterMesh(kind: keyof typeof THEME.archetype): THREE.Group {
    const spec = THEME.archetype[kind];
    // Prefer an archetype-specific model, then the generic skeleton/monster.
    const model =
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
    this.floorGroup.clear();
    for (const t of this.torchLights) this.scene.remove(t.light);
    this.torchLights = [];

    const map = state.map;
    let floorCount = 0, wallCount = 0, doorCount = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === Tile.Wall) wallCount++; else floorCount++;
      if (map.tiles[i] === Tile.DoorLocked) doorCount++; // floor carved under, door box on top
    }

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
    const floorMesh = floorSrc
      ? new THREE.InstancedMesh(floorSrc.geo, floorSrc.mat, floorCount)
      : new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.2, 1), flat(THEME.floor), floorCount);
    const floorAltMesh = altSrc
      ? new THREE.InstancedMesh(altSrc.geo, altSrc.mat, floorCount)
      : new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.2, 1), flat(THEME.floorAlt), floorSrc ? 0 : floorCount);
    // Solid rock stays a dark box mass. The glTF wall is a thin PANEL meant to
    // dress a wall face, so it only goes on faces that border walkable floor.
    // The fill box is slightly shorter than the panels so their top/side surfaces
    // are never coplanar (coplanar faces z-fight and flicker as the camera moves).
    const wallHeight = 1.0;
    const fillHeight = wallHeight - 0.04;
    const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, fillHeight, 1), flat(THEME.wall), wallCount);
    floorMesh.receiveShadow = true; floorAltMesh.receiveShadow = true;
    wallMesh.castShadow = true; wallMesh.receiveShadow = true;
    // Locked doors: gold/bronze blocks slightly taller than the walls, sitting on
    // top of floor-carved tiles (the sim keeps them non-walkable until the key).
    const doorMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.96, 1.1, 0.96),
      flat(0xc9a24b, { emissive: 0x5a3f08, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.35 }),
      doorCount,
    );
    doorMesh.castShadow = true; doorMesh.receiveShadow = true;

    const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < map.w && y < map.h;
    const isFloorAt = (x: number, y: number) => inBounds(x, y) && map.tiles[y * map.w + x] !== Tile.Wall;
    const DIRS = [
      { dx: 0, dz: 1 }, { dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
    ];

    let panelMesh: THREE.InstancedMesh | null = null;
    if (wallSrc) {
      let panelCount = 0;
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          if (map.tiles[y * map.w + x] !== Tile.Wall) continue;
          for (const d of DIRS) if (isFloorAt(x + d.dx, y + d.dz)) panelCount++;
        }
      }
      panelMesh = new THREE.InstancedMesh(wallSrc.geo, wallSrc.mat, panelCount);
      panelMesh.castShadow = true; panelMesh.receiveShadow = true;
    }

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
    const floorTiles: number[] = [], floorAltTiles: number[] = [];
    const wallTiles: number[] = [], panelTiles: number[] = [], doorTiles: number[] = [];
    let fi = 0, fai = 0, wi = 0, pi = 0, di = 0;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const idx = y * map.w + x;
        const t = map.tiles[idx];
        if (t === Tile.DoorLocked) {
          // The door block sits over its tile; the floor branches below still run
          // so the tile has ground under the door when it opens... which happens
          // via a full rebuild (mapVersion bump), so just draw floor + door now.
          m.makeTranslation(x + 0.5, 1.1 / 2 - 0.02, y + 0.5);
          doorTiles.push(idx);
          doorMesh.setMatrixAt(di++, m);
        }
        if (t === Tile.Wall) {
          m.makeTranslation(x + 0.5, fillHeight / 2, y + 0.5);
          wallTiles.push(idx);
          wallMesh.setMatrixAt(wi++, m);
          if (panelMesh) {
            for (const d of DIRS) {
              if (!isFloorAt(x + d.dx, y + d.dz)) continue;
              placePanel(x, y, d.dx, d.dz);
              panelTiles.push((y + d.dz) * map.w + (x + d.dx));
              panelMesh.setMatrixAt(pi++, m);
            }
          }
        } else {
          // Mix primary/alt ground per tile (stable hash: same tile, same look).
          const useAlt = altSrc
            ? tileHash(x, y, state.floor) < altPct
            : !floorSrc && (x + y) % 2 !== 0;
          if (useAlt) {
            placeFloor(altSrc, x, y);
            floorAltTiles.push(idx);
            floorAltMesh.setMatrixAt(fai++, m);
          } else {
            placeFloor(floorSrc, x, y);
            floorTiles.push(idx);
            floorMesh.setMatrixAt(fi++, m);
          }
        }
      }
    }
    floorMesh.count = fi; floorAltMesh.count = fai; wallMesh.count = wi; doorMesh.count = di;
    floorMesh.instanceMatrix.needsUpdate = true;
    floorAltMesh.instanceMatrix.needsUpdate = true;
    wallMesh.instanceMatrix.needsUpdate = true;
    doorMesh.instanceMatrix.needsUpdate = true;
    this.floorGroup.add(floorMesh, floorAltMesh, wallMesh);
    if (di > 0) this.floorGroup.add(doorMesh);
    if (panelMesh) {
      panelMesh.count = pi;
      panelMesh.instanceMatrix.needsUpdate = true;
      this.floorGroup.add(panelMesh);
    }
    const floorLit = new THREE.Color(theme.floorTint).multiplyScalar(tintJitter);
    const wallLitColor = new THREE.Color(theme.wallTint).multiplyScalar(tintJitter);
    const wallFillLit = wallLitColor.clone().multiplyScalar(0.55); // dark rock tops
    this.fogTargets = [
      { mesh: floorMesh, tiles: floorTiles, lit: floorLit },
      { mesh: floorAltMesh, tiles: floorAltTiles, lit: floorLit },
      { mesh: wallMesh, tiles: wallTiles, lit: wallFillLit },
    ];
    if (di > 0) this.fogTargets.push({ mesh: doorMesh, tiles: doorTiles, lit: new THREE.Color(1, 1, 1) });
    if (panelMesh) this.fogTargets.push({ mesh: panelMesh, tiles: panelTiles, lit: wallLitColor });
    this.lastExploredVersion = -1; // force a fog re-tint on the new floor

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

    // Prop scatter: the band furniture, seeded per floor so each floor of a
    // district has its own character. Cosmetic only: the sim never sees props.
    this.propEntries = [];
    const density = theme.propDensity * (0.6 + frng() * 0.9);
    const maxProps = 110;
    for (let y = 1; y < map.h - 1 && this.propEntries.length < maxProps; y++) {
      for (let x = 1; x < map.w - 1 && this.propEntries.length < maxProps; x++) {
        const idx = y * map.w + x;
        if (map.tiles[idx] !== Tile.Floor) continue;
        if (frng() > density) continue;
        // Keep spawn, stairs, and door mouths clear.
        if (Math.hypot(x + 0.5 - map.spawn.x, y + 0.5 - map.spawn.y) < 3) continue;
        if (Math.hypot(x + 0.5 - map.stairs.x, y + 0.5 - map.stairs.y) < 2.5) continue;
        if ([idx - 1, idx + 1, idx - map.w, idx + map.w].some((n) => map.tiles[n] === Tile.DoorLocked)) continue;
        const key = theme.props[Math.floor(frng() * theme.props.length)];
        const obj = this.modelInstance(key);
        if (!obj) continue;
        const box = new THREE.Box3().setFromObject(obj);
        const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
        obj.scale.multiplyScalar((0.5 + frng() * 0.3) / fp);
        const scaled = new THREE.Box3().setFromObject(obj);
        obj.position.set(
          x + 0.5 + (frng() - 0.5) * 0.4 - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
          -scaled.min.y + 0.004,
          y + 0.5 + (frng() - 0.5) * 0.4 - (scaled.min.z + scaled.max.z) / 2 + obj.position.z,
        );
        obj.rotation.y = frng() * Math.PI * 2;
        this.floorGroup.add(obj);
        this.propEntries.push({ obj, tile: idx });
      }
    }

    // Torches: place a handful along walls near the spawn and stairs for mood.
    this.addTorches(state, theme, 0.85 + frng() * 0.3);
    this.builtFloor = state.floor;
    this.builtMapVersion = state.mapVersion;
  }

  private addTorches(state: GameState, theme: FloorTheme, intensityJitter: number): void {
    const map = state.map;
    const spots: Vec2[] = [];
    // Sample some walkable tiles adjacent to walls; deterministic scan (no RNG needed for cosmetics).
    for (let y = 1; y < map.h - 1 && spots.length < 10; y += 3) {
      for (let x = 1; x < map.w - 1 && spots.length < 10; x += 3) {
        const here = map.tiles[y * map.w + x];
        if (here === Tile.Wall) continue;
        const nearWall =
          map.tiles[y * map.w + (x - 1)] === Tile.Wall || map.tiles[y * map.w + (x + 1)] === Tile.Wall ||
          map.tiles[(y - 1) * map.w + x] === Tile.Wall || map.tiles[(y + 1) * map.w + x] === Tile.Wall;
        if (nearWall) spots.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
    const intensity = theme.torchIntensity * intensityJitter;
    spots.forEach((s, i) => {
      const light = new THREE.PointLight(theme.torchColor, intensity, THEME.torchDistance, 2);
      light.position.set(s.x, 1.6, s.y);
      this.scene.add(light);
      this.torchLights.push({ light, base: intensity, seed: i * 1.7 });
    });
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

  private updateAbilityFx(state: GameState, dt: number): void {
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
          const a = p.orbitAngle + (i * Math.PI * 2) / op.blades;
          blades[i].position.set(p.pos.x + Math.cos(a) * op.radius, 0.75, p.pos.y + Math.sin(a) * op.radius);
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
    if (state.floor !== this.builtFloor || state.mapVersion !== this.builtMapVersion) {
      this.buildFloor(state);
    }
    if (state.exploredVersion !== this.lastExploredVersion) {
      this.lastExploredVersion = state.exploredVersion;
      this.applyFog(state);
    }
    const dt = this.prevTime ? Math.min(0.1, time - this.prevTime) : 1 / 60;
    this.prevTime = time;

    // The camera/light anchor: the local player (fall back to the first).
    const p = state.players.find((pl) => pl.id === this.localPlayerId) ?? state.players[0];
    if (!p) return;

    // Players: reconcile mesh pool + animate each.
    const pSeen = new Set<number>();
    for (const pl of state.players) {
      pSeen.add(pl.id);
      let mesh = this.playerMeshes.get(pl.id);
      if (!mesh) { mesh = this.buildPlayerMesh(); this.scene.add(mesh); this.playerMeshes.set(pl.id, mesh); }
      const prev = this.prevPlayers.get(pl.id) ?? pl.pos;
      const plSpeed = Math.hypot(pl.pos.x - prev.x, pl.pos.y - prev.y) / dt;
      this.prevPlayers.set(pl.id, { x: pl.pos.x, y: pl.pos.y });
      mesh.position.set(pl.pos.x, 0, pl.pos.y);
      mesh.rotation.set(0, Math.atan2(pl.facing.x, pl.facing.y), 0);
      mesh.visible = true;
      this.applyLoadout(mesh, pl);
      const prevSwing = this.prevSwings.get(pl.id) ?? 0;
      if (mesh.userData.mixer) {
        // Real rigged model: drive clips; procedural bob/tip-over would fight them.
        const play = mesh.userData.play as (n: string, force?: boolean) => void;
        if (!pl.alive) play("death");
        else if (pl.attackSwing > prevSwing + 1e-6) play("attack", true);
        else if (pl.attackSwing <= 0) play(plSpeed > 0.4 ? "walk" : "idle");
        (mesh.userData.mixer as THREE.AnimationMixer).update(dt);
      } else {
        this.animatePlayer(mesh, pl.alive, plSpeed, pl.attackSwing, time);
      }
      this.prevSwings.set(pl.id, pl.attackSwing);
    }
    for (const [id, mesh] of this.playerMeshes) {
      if (!pSeen.has(id)) {
        this.scene.remove(mesh);
        this.playerMeshes.delete(id);
        this.prevPlayers.delete(id);
        this.prevSwings.delete(id);
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
        mesh = this.buildMonsterMesh(mon.kind);
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
      const prev = this.prevMon.get(mon.id) ?? mon.pos;
      const mSpeed = Math.hypot(mon.pos.x - prev.x, mon.pos.y - prev.y) / dt;
      this.prevMon.set(mon.id, { x: mon.pos.x, y: mon.pos.y });
      mesh.position.set(mon.pos.x, 0, mon.pos.y);
      mesh.rotation.y = Math.atan2(p.pos.x - mon.pos.x, p.pos.y - mon.pos.y);
      if (mesh.userData.mixer) {
        // Rigged model: walk/idle clips + a small recoil pop; no squash (it would
        // deform the skinned mesh instead of reading as a hit).
        (mesh.userData.play as (n: string) => void)(mSpeed > 0.2 ? "walk" : "idle");
        (mesh.userData.mixer as THREE.AnimationMixer).update(dt);
        mesh.position.y = mon.hitFlash > 0 ? 0.12 : 0;
        mesh.scale.setScalar(bs);
      } else {
        // Bob while chasing; recoil pop + squash when just hit (scaled by archetype size).
        const bob = mSpeed > 0.2 ? Math.abs(Math.sin(time * 10 + mon.id)) * 0.14 * bs : 0;
        mesh.position.y = (mon.hitFlash > 0 ? 0.18 : 0) + bob;
        const squash = mon.hitFlash > 0 ? 1.25 : 1;
        mesh.scale.set(bs * squash, bs * (2 - squash), bs * squash);
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
        this.scene.remove(mesh); this.monsters.delete(id); this.prevMon.delete(id);
        const marker = this.keyMarkers.get(id);
        if (marker) { this.scene.remove(marker); this.keyMarkers.delete(id); }
      }
    }

    // Projectiles: reconcile a mesh pool by id.
    const projSeen = new Set<number>();
    for (const pr of state.projectiles) {
      projSeen.add(pr.id);
      let mesh = this.projectiles.get(pr.id);
      if (!mesh) {
        const color = pr.from === "player" ? THEME.projectilePlayer : THEME.projectileEnemy;
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.18, 8, 8),
          flat(color, { emissive: color, emissiveIntensity: 0.9 }),
        );
        this.scene.add(mesh); this.projectiles.set(pr.id, mesh);
      }
      mesh.position.set(pr.pos.x, 0.6, pr.pos.y);
      mesh.visible = inVision(pr.pos);
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
        const col = l.kind === "item" && l.rarity ? THEME.rarity[l.rarity] : this.lootColor(l.kind);
        mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.2, 0),
          flat(col, { emissive: col, emissiveIntensity: 0.6 }),
        );
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

    // Torch flicker (cosmetic; uses render time, not sim time).
    for (const t of this.torchLights) {
      t.light.intensity = t.base * (0.75 + 0.25 * Math.sin(time * 9 + t.seed) * Math.sin(time * 3.3 + t.seed));
    }

    this.updateParticles(dt);
    this.updateAbilityFx(state, dt);

    // Camera follows the player from the fixed iso direction, plus decaying shake.
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const sz = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const d = THEME.camDir;
    const dist = THEME.camDist;
    const len = Math.hypot(d.x, d.y, d.z);
    this.camera.position.set(
      p.pos.x + (d.x / len) * dist + sx,
      (d.y / len) * dist,
      p.pos.y + (d.z / len) * dist + sz,
    );
    this.camera.lookAt(p.pos.x, 0, p.pos.y);
    this.key.position.set(p.pos.x + 8, 20, p.pos.y + 6);
    this.key.target.position.set(p.pos.x, 0, p.pos.y);
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
      const n = h.kind === "crit" ? 14 : 8;
      this.spawnBurst(h.pos.x, h.pos.y, color, n);
      if (h.kind === "player") this.shake = Math.min(0.6, this.shake + 0.35);
      if (h.kind === "crit") this.shake = Math.min(0.4, this.shake + 0.15);
    }
  }

  private spawnBurst(x: number, y: number, color: number, count: number): void {
    if (this.particles.length > 260) return; // hard cap
    const mat = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.sharedParticleGeo, mat);
      mesh.position.set(x, 0.6, y);
      this.scene.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2.5;
      this.particles.push({
        mesh, vx: Math.cos(ang) * sp, vy: 2 + Math.random() * 2.5, vz: Math.sin(ang) * sp,
        life: 0, max: 0.5 + Math.random() * 0.3,
      });
    }
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
