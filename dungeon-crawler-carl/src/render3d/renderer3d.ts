import * as THREE from "three";
import { Tile, type GameState, type HitEvent, type Vec2 } from "../sim/types";
import { THEME } from "./theme";
import { loadModels, type LoadedModel } from "./assets";

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

  private player: THREE.Group;
  private monsters = new Map<number, THREE.Group>();
  private loot = new Map<number, THREE.Mesh>();
  private projectiles = new Map<number, THREE.Mesh>();

  private models: Record<string, LoadedModel> = {};
  private builtFloor = -1;
  private aspect = 1;

  // Animation / juice state (all host-side cosmetics; sim stays pure).
  private prevPlayer: Vec2 = { x: 0, y: 0 };
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
    this.player = this.buildPlayerMesh();
    this.scene.add(this.player);
  }

  async init(): Promise<void> {
    this.models = await loadModels();
    // If a real player model was provided, swap the procedural stand-in for it.
    const rebuilt = this.buildPlayerMesh();
    this.scene.remove(this.player);
    this.player = rebuilt;
    this.scene.add(this.player);
  }

  /** Clone a loaded glTF model if present, else null (caller falls back to primitives). */
  private modelInstance(key: string): THREE.Group | null {
    const m = this.models[key];
    if (!m) return null;
    const g = m.scene.clone(true);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return g;
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
    if (model) return model;
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

  private buildMonsterMesh(kind: keyof typeof THEME.archetype): THREE.Group {
    const spec = THEME.archetype[kind];
    const model = this.modelInstance("skeleton") ?? this.modelInstance("monster");
    const g = model ?? new THREE.Group();
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
    g.scale.setScalar(spec.scale);
    g.userData.baseScale = spec.scale;
    return g;
  }

  private lootColor(kind: string): number {
    return kind === "gold" ? THEME.gold : kind === "heal" ? THEME.heal : THEME.weaponLoot;
  }

  // ---- Floor geometry (rebuilt on descent) ----

  private buildFloor(state: GameState): void {
    this.floorGroup.clear();
    for (const t of this.torchLights) this.scene.remove(t.light);
    this.torchLights = [];

    const map = state.map;
    let floorCount = 0, wallCount = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === Tile.Wall) wallCount++; else floorCount++;
    }

    const tileGeo = new THREE.BoxGeometry(1, 0.2, 1);
    const wallGeo = new THREE.BoxGeometry(1, 1.4, 1);
    const floorMesh = new THREE.InstancedMesh(tileGeo, flat(THEME.floor), floorCount);
    const floorAltMesh = new THREE.InstancedMesh(tileGeo, flat(THEME.floorAlt), floorCount);
    const wallMesh = new THREE.InstancedMesh(wallGeo, flat(THEME.wall), wallCount);
    floorMesh.receiveShadow = true; floorAltMesh.receiveShadow = true;
    wallMesh.castShadow = true; wallMesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    let fi = 0, fai = 0, wi = 0;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (t === Tile.Wall) {
          m.makeTranslation(x + 0.5, 0.7, y + 0.5);
          wallMesh.setMatrixAt(wi++, m);
        } else {
          m.makeTranslation(x + 0.5, -0.1, y + 0.5);
          if ((x + y) % 2 === 0) floorMesh.setMatrixAt(fi++, m);
          else floorAltMesh.setMatrixAt(fai++, m);
        }
      }
    }
    floorMesh.count = fi; floorAltMesh.count = fai; wallMesh.count = wi;
    floorMesh.instanceMatrix.needsUpdate = true;
    floorAltMesh.instanceMatrix.needsUpdate = true;
    wallMesh.instanceMatrix.needsUpdate = true;
    this.floorGroup.add(floorMesh, floorAltMesh, wallMesh);

    // Stairs: a glowing stepped block at the stairs tile.
    const stairs = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), flat(THEME.stairs, { emissive: 0x3a2c00, emissiveIntensity: 0.6 }));
    stairs.position.set(map.stairs.x, 0.05, map.stairs.y); stairs.receiveShadow = true;
    this.floorGroup.add(stairs);

    // Torches: place a handful along walls near the spawn and stairs for mood.
    this.addTorches(state);
    this.builtFloor = state.floor;
  }

  private addTorches(state: GameState): void {
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
    spots.forEach((s, i) => {
      const light = new THREE.PointLight(THEME.torchColor, THEME.torchIntensity, THEME.torchDistance, 2);
      light.position.set(s.x, 1.6, s.y);
      this.scene.add(light);
      this.torchLights.push({ light, base: THEME.torchIntensity, seed: i * 1.7 });
    });
  }

  // ---- Per-frame sync ----

  update(state: GameState, time: number): void {
    if (state.floor !== this.builtFloor) this.buildFloor(state);
    const dt = this.prevTime ? Math.min(0.1, time - this.prevTime) : 1 / 60;
    this.prevTime = time;

    // Player + procedural animation.
    const p = state.player;
    const pSpeed = Math.hypot(p.pos.x - this.prevPlayer.x, p.pos.y - this.prevPlayer.y) / dt;
    this.prevPlayer = { x: p.pos.x, y: p.pos.y };
    this.player.position.set(p.pos.x, 0, p.pos.y);
    this.player.rotation.set(0, Math.atan2(p.facing.x, p.facing.y), 0);
    this.player.visible = true;
    this.animatePlayer(p.alive, pSpeed, p.attackSwing, time);

    // Monsters: reconcile mesh pool with live monster set + animate.
    const seen = new Set<number>();
    for (const mon of state.monsters) {
      seen.add(mon.id);
      let mesh = this.monsters.get(mon.id);
      if (!mesh) { mesh = this.buildMonsterMesh(mon.kind); this.scene.add(mesh); this.monsters.set(mon.id, mesh); }
      const bs = (mesh.userData.baseScale as number) ?? 1;
      const prev = this.prevMon.get(mon.id) ?? mon.pos;
      const mSpeed = Math.hypot(mon.pos.x - prev.x, mon.pos.y - prev.y) / dt;
      this.prevMon.set(mon.id, { x: mon.pos.x, y: mon.pos.y });
      mesh.position.set(mon.pos.x, 0, mon.pos.y);
      mesh.rotation.y = Math.atan2(p.pos.x - mon.pos.x, p.pos.y - mon.pos.y);
      // Bob while chasing; recoil pop + squash when just hit (scaled by archetype size).
      const bob = mSpeed > 0.2 ? Math.abs(Math.sin(time * 10 + mon.id)) * 0.14 * bs : 0;
      mesh.position.y = (mon.hitFlash > 0 ? 0.18 : 0) + bob;
      const squash = mon.hitFlash > 0 ? 1.25 : 1;
      mesh.scale.set(bs * squash, bs * (2 - squash), bs * squash);
    }
    for (const [id, mesh] of this.monsters) {
      if (!seen.has(id)) { this.scene.remove(mesh); this.monsters.delete(id); this.prevMon.delete(id); }
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
        mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.2, 0),
          flat(this.lootColor(l.kind), { emissive: this.lootColor(l.kind), emissiveIntensity: 0.5 }),
        );
        this.scene.add(mesh); this.loot.set(l.id, mesh);
      }
      mesh.position.set(l.pos.x, 0.4 + Math.sin(time * 3 + l.id) * 0.08, l.pos.y);
      mesh.rotation.y = time * 2;
    }
    for (const [id, mesh] of this.loot) {
      if (!lootSeen.has(id)) { this.scene.remove(mesh); this.loot.delete(id); }
    }

    // Torch flicker (cosmetic; uses render time, not sim time).
    for (const t of this.torchLights) {
      t.light.intensity = t.base * (0.75 + 0.25 * Math.sin(time * 9 + t.seed) * Math.sin(time * 3.3 + t.seed));
    }

    this.updateParticles(dt);

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

  /** Procedural animation for the placeholder player (walk bob, attack lunge, death). */
  private animatePlayer(alive: boolean, speed: number, attackSwing: number, time: number): void {
    const body = this.player.userData.body as THREE.Mesh | undefined;
    const weapon = this.player.userData.weapon as THREE.Mesh | undefined;
    const restX = (this.player.userData.weaponRestX as number) ?? 0;

    if (!alive) {
      // Tip over and sink.
      this.player.rotation.x = -Math.PI / 2.2;
      this.player.position.y = 0.1;
      return;
    }
    this.player.rotation.x = 0;

    if (attackSwing > 0) {
      // Lunge forward along facing during the swing, and swing the weapon.
      const prog = 1 - attackSwing / 0.15; // 0 -> 1 across the swing
      const lunge = Math.sin(prog * Math.PI) * 0.18;
      this.player.position.x += Math.sin(this.player.rotation.y) * lunge;
      this.player.position.z += Math.cos(this.player.rotation.y) * lunge;
      if (weapon) weapon.rotation.x = restX - Math.sin(prog * Math.PI) * 1.4;
      this.player.position.y = 0;
    } else if (speed > 0.4) {
      // Walk: bob + subtle roll.
      this.player.position.y = Math.abs(Math.sin(time * 12)) * 0.1;
      if (body) body.rotation.z = Math.sin(time * 12) * 0.08;
      if (weapon) weapon.rotation.x = restX;
    } else {
      // Idle breathing.
      this.player.position.y = Math.sin(time * 2.5) * 0.03;
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
