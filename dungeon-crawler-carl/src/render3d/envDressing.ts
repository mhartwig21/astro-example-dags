import * as THREE from "three";
import type { FloorTheme } from "./floorThemes";
import { tileHash } from "./floorThemes";

// ENVIRONMENT DRESSING (AAA round 2) — three renderer-side passes that buildFloor
// delegates to, all deterministic per (seed, floor) via the cosmetic rng/tileHash:
//
//   placeDecals        — authored-looking floor decals (cracks, stains, scorch,
//                        bones, moss) as instanced alpha-blended quads with
//                        generative canvas textures. Guaranteed per-room minimums
//                        so no lit room ships as a bare plane.
//   signatureDressing  — each band's HERO SETPIECE + signature modular props
//                        (sewers water channels + pipes, ironworks forge crucibles
//                        + hanging chains, ruins collapsed colonnades, undercroft
//                        ossuary niches, garden fairy rings + 3-scale ground
//                        cover, approach show-biz spotlights).
//   voidSilhouettes    — sparse silhouetted geometry in deep-rock and past-the-
//                        map space at 10-20% brightness (columns, broken arches,
//                        distant glints) so the negative space has composition
//                        instead of reading as featureless void.
//
// Purely cosmetic, renderer-side only — the sim never sees any of it. All
// randomness is the per-floor cosmetic rng or tileHash; never Math.random.

export interface EnvRoom { x: number; y: number; w: number; h: number }

export interface EnvCtx {
  band: number;
  floor: number;
  theme: FloorTheme;
  map: { w: number; h: number; rooms: EnvRoom[]; roles: string[] };
  rng: () => number; // per-floor cosmetic rng (renderer-side)
  isFloor: (x: number, y: number) => boolean;
  isWall: (x: number, y: number) => boolean;
  roomMask: Uint8Array;
  /** buildFloor's place(): clearance-checked themed prop placement. */
  place: (key: string, x: number, y: number, opts?: { scale?: number; rot?: number; jitter?: number }) => boolean;
  /** World-lit model instance (unpositioned) for manual composition (fallen columns). */
  getObj: (key: string) => THREE.Object3D | null;
  /** Add a hand-built object to the floor group + fog-reveal registry. */
  addObj: (obj: THREE.Object3D, x: number, y: number) => void;
  /** Inject the world-light stage into a hand-built material. */
  worldLit: (m: THREE.Material) => THREE.Material;
  /** Track a raw (non-worldLit) material for disposal on the next rebuild. */
  trackMat: (m: THREE.Material) => void;
  group: THREE.Group;
  /** Register a texture whose offset scrolls per frame (water flow). */
  addFlow: (tex: THREE.Texture, sx: number, sy: number) => void;
}

// ---- Generative decal textures (cached for the session) ----

const texCache = new Map<string, THREE.Texture>();

function canvasTex(key: string, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d");
  if (g) draw(g);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** Seeded rng local to a texture draw (textures are cached, so determinism only
 * matters within one browser session — but stable art beats churn). */
function drawRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decalTexture(kind: string): THREE.Texture {
  return canvasTex(`decal:${kind}`, (g) => {
    const r = drawRng(kind.length * 977 + 13);
    g.clearRect(0, 0, 96, 96);
    if (kind === "crack") {
      // Jagged fracture web out of an off-center impact point.
      g.strokeStyle = "rgba(10,8,10,0.85)";
      g.lineCap = "round";
      const cx = 40 + r() * 16, cy = 40 + r() * 16;
      for (let arm = 0; arm < 5; arm++) {
        let x = cx, y = cy;
        let ang = (arm / 5) * Math.PI * 2 + r() * 0.9;
        g.lineWidth = 2.6;
        g.beginPath();
        g.moveTo(x, y);
        for (let s = 0; s < 5; s++) {
          ang += (r() - 0.5) * 1.1;
          const len = 6 + r() * 10;
          x += Math.cos(ang) * len;
          y += Math.sin(ang) * len;
          g.lineTo(x, y);
          g.lineWidth *= 0.72;
        }
        g.stroke();
      }
    } else if (kind === "stain") {
      // Layered irregular blot, dark center feathering out.
      for (let i = 0; i < 9; i++) {
        const x = 30 + r() * 36, y = 30 + r() * 36, rad = 10 + r() * 22;
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        grad.addColorStop(0, `rgba(12,10,14,${0.16 + r() * 0.12})`);
        grad.addColorStop(1, "rgba(12,10,14,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 96, 96);
      }
    } else if (kind === "scorch") {
      // Charred core with a faint warm rim — old fire, old fight.
      const grad = g.createRadialGradient(48, 48, 0, 48, 48, 40);
      grad.addColorStop(0, "rgba(6,5,6,0.8)");
      grad.addColorStop(0.55, "rgba(10,8,8,0.45)");
      grad.addColorStop(0.8, "rgba(90,40,14,0.18)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 96, 96);
      g.fillStyle = "rgba(4,4,4,0.5)";
      for (let i = 0; i < 14; i++) {
        const a = r() * Math.PI * 2, d = 24 + r() * 18;
        g.beginPath();
        g.arc(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 1.5 + r() * 3, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === "bones") {
      // A scatter of pale shards + one small skull disc.
      g.strokeStyle = "rgba(226,218,196,0.9)";
      g.lineCap = "round";
      for (let i = 0; i < 7; i++) {
        const x = 16 + r() * 60, y = 16 + r() * 60, a = r() * Math.PI * 2, len = 7 + r() * 12;
        g.lineWidth = 2 + r() * 1.6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
      g.fillStyle = "rgba(232,224,204,0.95)";
      g.beginPath();
      g.arc(30 + r() * 36, 30 + r() * 36, 5.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(20,16,14,0.9)";
      g.beginPath();
      g.arc(30 + r() * 36, 30 + r() * 36, 1.6, 0, Math.PI * 2);
      g.fill();
    } else if (kind === "blood") {
      // Old violence: a dried maroon splat with a drag smear off one side —
      // desaturated brown-maroon (saturated red stays reserved for danger
      // telegraphs), reads as story, not gore VFX.
      const cx = 38 + r() * 14, cy = 38 + r() * 14;
      const ang = r() * Math.PI * 2;
      for (let i = 0; i < 8; i++) {
        const d = r() * 14;
        const x = cx + Math.cos(r() * Math.PI * 2) * d;
        const y = cy + Math.sin(r() * Math.PI * 2) * d;
        const rad = 4 + r() * 9;
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        grad.addColorStop(0, `rgba(58,18,14,${0.5 + r() * 0.25})`);
        grad.addColorStop(1, "rgba(58,18,14,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 96, 96);
      }
      // The drag smear: overlapping fading blots walking away from the pool.
      for (let i = 0; i < 9; i++) {
        const t = i / 9;
        const x = cx + Math.cos(ang) * (8 + t * 30);
        const y = cy + Math.sin(ang) * (8 + t * 30);
        g.fillStyle = `rgba(52,16,12,${0.4 * (1 - t)})`;
        g.beginPath();
        g.arc(x, y, 4.5 - t * 2.5, 0, Math.PI * 2);
        g.fill();
      }
      // Spatter flecks.
      g.fillStyle = "rgba(58,18,14,0.55)";
      for (let i = 0; i < 10; i++) {
        const a = r() * Math.PI * 2, d = 14 + r() * 22;
        g.beginPath();
        g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.8 + r() * 1.6, 0, Math.PI * 2);
        g.fill();
      }
    } else { // moss
      // Speckled growth creeping from one edge.
      for (let i = 0; i < 60; i++) {
        const x = r() * 96, y = r() * 96;
        const bias = 1 - Math.hypot(x - 48, y - 48) / 68;
        if (bias < r() * 0.9) continue;
        g.fillStyle = `rgba(${44 + (r() * 30) | 0},${86 + (r() * 40) | 0},${40 + (r() * 24) | 0},${0.25 + r() * 0.4})`;
        g.beginPath();
        g.arc(x, y, 1.4 + r() * 3.4, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
}

/** Soft radial glow (module-local: signature/void passes can't reach the
 * renderer's private sprite texture). */
function glowTexture(): THREE.Texture {
  return canvasTex("glow", (g) => {
    const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.5)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 96, 96);
  });
}

/** Streaked water texture for the sewers channels — scrolled per frame. */
function waterTexture(): THREE.Texture {
  const t = canvasTex("water", (g) => {
    const r = drawRng(0x77aa11);
    g.fillStyle = "#28524c";
    g.fillRect(0, 0, 96, 96);
    for (let i = 0; i < 26; i++) {
      const y = r() * 96, len = 18 + r() * 60, x = r() * 96;
      const v = 60 + (r() * 90) | 0;
      g.strokeStyle = `rgba(${(v * 0.55) | 0},${v + 40},${v + 24},${0.2 + r() * 0.35})`;
      g.lineWidth = 1 + r() * 2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + len, y + (r() - 0.5) * 6);
      g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---- Pass 1: floor decals ----

const DECAL_SETS: { kinds: string[]; tint: number }[] = [
  { kinds: ["crack", "bones", "stain", "blood"], tint: 0xccc4ba }, // undercroft
  { kinds: ["moss", "stain", "crack", "blood"], tint: 0xa8c0b0 }, // sewers
  { kinds: ["moss", "stain"], tint: 0xb0cc94 }, // garden
  { kinds: ["crack", "scorch", "bones", "blood"], tint: 0xd8c2ac }, // ruins
  { kinds: ["scorch", "stain", "crack"], tint: 0xaab6c6 }, // ironworks
  { kinds: ["crack", "bones", "scorch", "blood"], tint: 0xd2c6ca }, // approach
];

export function placeDecals(ctx: EnvCtx): void {
  const set = DECAL_SETS[ctx.band] ?? DECAL_SETS[0];
  const { map, rng } = ctx;
  const perKind: THREE.Matrix4[][] = set.kinds.map(() => []);
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let total = 0;
  const stamp = (x: number, y: number, ki: number) => {
    if (total > 430 || !ctx.isFloor(Math.floor(x), Math.floor(y))) return;
    const s = 0.7 + rng() * 1.7; // wide scale spread: no two stamps read as twins
    quat.setFromAxisAngle(UP, rng() * Math.PI * 2);
    pos.set(x, 0.018 + (total % 7) * 0.0011, y); // micro-stagger kills coplanar decals
    scl.set(s, 1, s);
    perKind[ki].push(new THREE.Matrix4().compose(pos, quat, scl));
    total++;
  };
  // Guaranteed per-room minimum: every lit room reads authored, never bare.
  for (const r of map.rooms) {
    const n = Math.max(4, Math.min(12, Math.floor((r.w * r.h) / 7)));
    for (let i = 0; i < n; i++) {
      stamp(r.x + 1 + rng() * Math.max(1, r.w - 2), r.y + 1 + rng() * Math.max(1, r.h - 2), Math.floor(rng() * set.kinds.length));
    }
    // Grime concentrates along wall bases + thresholds (critic r2 minor):
    // a run of smaller stains hugging the room's perimeter.
    const per = Math.max(2, Math.floor((r.w + r.h) / 4));
    for (let i = 0; i < per; i++) {
      const alongTop = rng() < 0.5;
      const x = alongTop ? r.x + 1 + rng() * Math.max(1, r.w - 2) : (rng() < 0.5 ? r.x + 1.35 : r.x + r.w - 1.35);
      const y = alongTop ? (rng() < 0.5 ? r.y + 1.35 : r.y + r.h - 1.35) : r.y + 1 + rng() * Math.max(1, r.h - 2);
      stamp(x, y, Math.floor(rng() * set.kinds.length));
    }
  }
  // Corridor decals: deterministic slice so connective tissue carries history too.
  for (let y = 1; y < map.h - 1; y++) {
    for (let x = 1; x < map.w - 1; x++) {
      const idx = y * map.w + x;
      if (!ctx.isFloor(x, y) || ctx.roomMask[idx]) continue;
      const h = tileHash(x, y, ctx.floor + 401);
      if (h < 130) stamp(x + 0.5, y + 0.5, h % set.kinds.length);
    }
  }
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  perKind.forEach((mats, ki) => {
    if (mats.length === 0) return;
    const mat = ctx.worldLit(new THREE.MeshStandardMaterial({
      map: decalTexture(set.kinds[ki]),
      color: set.tint,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }));
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.computeBoundingSphere();
    ctx.group.add(mesh);
  });
}

// ---- Pass 2: band signature setpieces ----

function centerOf(r: EnvRoom): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Rooms big enough to host a setpiece, minus the ones with their own script. */
function featureRooms(ctx: EnvCtx): EnvRoom[] {
  const out: EnvRoom[] = [];
  for (let i = 0; i < ctx.map.rooms.length; i++) {
    const role = ctx.map.roles[i];
    if (role === "entrance" || role === "landmark" || role === "vault" || role === "stairs") continue;
    const r = ctx.map.rooms[i];
    if (r.w >= 6 && r.h >= 5) out.push(r);
  }
  // Deterministic shuffle via the floor rng.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, 3);
}

function std(ctx: EnvCtx, params: THREE.MeshStandardMaterialParameters): THREE.Material {
  return ctx.worldLit(new THREE.MeshStandardMaterial({ flatShading: true, ...params }));
}

/** Sewers hero: a sunken water channel with emissive flow, curbed in stone. */
function waterChannel(ctx: EnvCtx, r: EnvRoom): void {
  const horiz = r.w >= r.h;
  const len = (horiz ? r.w : r.h) - 2.6;
  if (len < 3) return;
  const c = centerOf(r);
  const off = (Math.min(r.w, r.h) / 2 - 1.7) * (ctx.rng() < 0.5 ? -1 : 1);
  const cx = horiz ? c.x : c.x + off;
  const cy = horiz ? c.y + off : c.y;
  const g = new THREE.Group();
  const tex = waterTexture();
  const wtex = tex.clone();
  wtex.needsUpdate = true;
  wtex.wrapS = wtex.wrapT = THREE.RepeatWrapping;
  wtex.repeat.set(len / 1.6, 0.7);
  ctx.addFlow(wtex, 0.055, 0.004);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(len, 1.05).rotateX(-Math.PI / 2),
    ctx.worldLit(new THREE.MeshStandardMaterial({
      color: 0x1c443e, map: wtex, emissive: 0x2a7a5a, emissiveMap: wtex,
      emissiveIntensity: 0.55, roughness: 0.22, metalness: 0.1,
      transparent: true, opacity: 0.94, depthWrite: false,
    })),
  );
  water.position.y = 0.035;
  g.add(water);
  // Stone curbs so the channel reads SUNKEN, not painted.
  const curbMat = std(ctx, { color: 0x4a5a58, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(len + 0.2, 0.09, 0.14), curbMat);
    curb.position.set(0, 0.045, side * 0.62);
    curb.castShadow = true;
    g.add(curb);
  }
  if (!horiz) g.rotation.y = Math.PI / 2;
  g.position.set(cx, 0, cy);
  ctx.addObj(g, cx, cy);
}

/** Sewers modular: a rusted pipe run hugging a wall, with a drip glint. */
function pipeRun(ctx: EnvCtx, r: EnvRoom, steel: boolean): void {
  // Pick a wall edge of the room with an actual wall behind it.
  const edges: { x: number; y: number; dx: number; dz: number }[] = [];
  const midX = Math.floor(r.x + r.w / 2), midY = Math.floor(r.y + r.h / 2);
  if (ctx.isWall(midX, r.y - 1)) edges.push({ x: midX, y: r.y, dx: 0, dz: -1 });
  if (ctx.isWall(midX, r.y + r.h)) edges.push({ x: midX, y: r.y + r.h - 1, dx: 0, dz: 1 });
  if (ctx.isWall(r.x - 1, midY)) edges.push({ x: r.x, y: midY, dx: -1, dz: 0 });
  if (ctx.isWall(r.x + r.w, midY)) edges.push({ x: r.x + r.w - 1, y: midY, dx: 1, dz: 0 });
  if (edges.length === 0) return;
  const e = edges[Math.floor(ctx.rng() * edges.length)];
  const len = 2.2 + ctx.rng() * 1.6;
  const g = new THREE.Group();
  const mat = std(ctx, steel
    ? { color: 0x5a646e, roughness: 0.45, metalness: 0.75 }
    : { color: 0x4a5a44, roughness: 0.6, metalness: 0.55 });
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, len, 8).rotateZ(Math.PI / 2), mat);
  pipe.position.y = 0.72;
  pipe.castShadow = true;
  g.add(pipe);
  for (const bx of [-len / 2 + 0.25, len / 2 - 0.25]) {
    const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.16, 8).rotateZ(Math.PI / 2), mat);
    joint.position.set(bx, 0.72, 0);
    g.add(joint);
    const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8), mat);
    drop.position.set(bx, 0.32, 0);
    g.add(drop);
  }
  g.rotation.y = e.dx !== 0 ? Math.PI / 2 : 0;
  const px = e.x + 0.5 + e.dx * 0.32, py = e.y + 0.5 + e.dz * 0.32;
  g.position.set(px, 0, py);
  ctx.addObj(g, px, py);
}

/** Ironworks hero: a glowing forge crucible — dark iron bulk, molten top. */
function forgeCrucible(ctx: EnvCtx, r: EnvRoom): void {
  const c = centerOf(r);
  const px = c.x + (ctx.rng() - 0.5) * 1.5, py = c.y + (ctx.rng() - 0.5) * 1.5;
  const g = new THREE.Group();
  const iron = std(ctx, { color: 0x2c3036, roughness: 0.55, metalness: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.62, 0.95), iron);
  body.position.y = 0.31;
  body.castShadow = true;
  g.add(body);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.1, 1.08), iron);
  lip.position.y = 0.64;
  lip.castShadow = true;
  g.add(lip);
  // Molten surface: emissive clamped WARM-ORANGE (never white) — bloom gets a
  // saturated core, the fixture keeps its silhouette.
  const melt = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.78).rotateX(-Math.PI / 2),
    ctx.worldLit(new THREE.MeshStandardMaterial({
      color: 0x501e08, emissive: 0xff6a1e, emissiveIntensity: 1.35, roughness: 0.8,
    })),
  );
  melt.position.y = 0.7;
  g.add(melt);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xff8a30, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.setScalar(1.7);
  halo.position.y = 0.95;
  halo.userData.noAO = true;
  ctx.trackMat(halo.material);
  g.add(halo);
  g.rotation.y = ctx.rng() * Math.PI * 2;
  g.position.set(px, 0, py);
  ctx.addObj(g, px, py);
  // The workshop around it.
  ctx.place("anvil", px + 1.2, py + 0.2, { scale: 0.55 });
  ctx.place("fuel_a_barrels", px - 1.3, py + 0.6, { scale: 0.6 });
  ctx.place("box_large", px + 0.4, py - 1.4, { scale: 0.5 });
}

/** Ironworks modular: heavy chains hanging against a wall face. */
function hangingChains(ctx: EnvCtx, r: EnvRoom): void {
  const spots: { x: number; y: number; dx: number; dz: number }[] = [];
  for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) {
    if (ctx.isWall(x, r.y - 1)) spots.push({ x, y: r.y, dx: 0, dz: -1 });
    if (ctx.isWall(x, r.y + r.h)) spots.push({ x, y: r.y + r.h - 1, dx: 0, dz: 1 });
  }
  for (let y = r.y + 1; y < r.y + r.h - 1; y += 2) {
    if (ctx.isWall(r.x - 1, y)) spots.push({ x: r.x, y, dx: -1, dz: 0 });
    if (ctx.isWall(r.x + r.w, y)) spots.push({ x: r.x + r.w - 1, y, dx: 1, dz: 0 });
  }
  const n = Math.min(2, spots.length);
  const mat = std(ctx, { color: 0x3a3e46, roughness: 0.4, metalness: 0.85 });
  for (let i = 0; i < n; i++) {
    const s = spots[Math.floor(ctx.rng() * spots.length)];
    const g = new THREE.Group();
    const links = 6 + Math.floor(ctx.rng() * 3);
    for (let l = 0; l < links; l++) {
      const link = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.17, 0.035), mat);
      link.position.y = 1.06 - l * 0.145;
      link.rotation.y = (l % 2) * (Math.PI / 2);
      g.add(link);
    }
    const px = s.x + 0.5 + s.dx * 0.4, py = s.y + 0.5 + s.dz * 0.4;
    g.position.set(px, 0, py);
    ctx.addObj(g, px, py);
  }
}

/** Ruins hero: a collapsed colonnade — standing columns alternating with
 * fallen drums half-sunk in rubble and overgrowth. */
function collapsedColonnade(ctx: EnvCtx, r: EnvRoom): void {
  const horiz = r.w >= r.h;
  const c = centerOf(r);
  const span = (horiz ? r.w : r.h) - 3;
  const count = Math.min(4, Math.max(3, Math.floor(span / 1.8)));
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const along = -span / 2 + t * span;
    const px = horiz ? c.x + along : c.x + (Math.min(r.w, r.h) / 2 - 1.9);
    const py = horiz ? c.y + (Math.min(r.w, r.h) / 2 - 1.9) : c.y + along;
    if (ctx.rng() < 0.45) {
      ctx.place("column", px, py, { scale: 1.35, rot: 0, jitter: 0.08 });
    } else {
      // Fallen: lay the column model on its side across the walk line.
      const obj = ctx.getObj("column");
      if (!obj) continue;
      const box = new THREE.Box3().setFromObject(obj);
      const h = Math.max(box.max.y - box.min.y, 1e-4);
      obj.scale.multiplyScalar(1.5 / h);
      const scaled = new THREE.Box3().setFromObject(obj);
      const rad = Math.max(scaled.max.x - scaled.min.x, scaled.max.z - scaled.min.z) / 2;
      obj.rotation.set(0, ctx.rng() * Math.PI * 2, Math.PI / 2 - 0.06);
      obj.position.set(px, rad * 0.82, py);
      ctx.addObj(obj, px, py);
      ctx.place("rubble_half", px + 0.7, py + 0.3, { scale: 0.45 });
    }
    if (ctx.rng() < 0.5) ctx.place("forest_bush_1_a", px + (ctx.rng() - 0.5) * 1.4, py + (ctx.rng() - 0.5) * 1.4, { scale: 0.45 });
  }
}

/** Undercroft hero: ossuary niches — graves lining a wall + a bone shrine. */
function ossuaryNiches(ctx: EnvCtx, r: EnvRoom, hero: boolean): void {
  const edges: { dx: number; dz: number; wallY: number }[] = [];
  const c = centerOf(r);
  if (ctx.isWall(Math.floor(c.x), r.y - 1)) edges.push({ dx: 0, dz: -1, wallY: r.y });
  if (ctx.isWall(Math.floor(c.x), r.y + r.h)) edges.push({ dx: 0, dz: 1, wallY: r.y + r.h - 1 });
  if (edges.length > 0) {
    const e = edges[Math.floor(ctx.rng() * edges.length)];
    const n = Math.min(4, Math.floor((r.w - 2) / 1.6));
    for (let i = 0; i < n; i++) {
      const px = r.x + 1.3 + i * ((r.w - 2.6) / Math.max(1, n - 1));
      const key = i % 2 === 0 ? "gravestone" : "grave_A";
      ctx.place(key, px, e.wallY + 0.5 + e.dz * 0.28, { scale: 0.52, rot: Math.atan2(0, -e.dz) + (e.dz > 0 ? Math.PI : 0), jitter: 0.08 });
    }
  }
  if (hero) {
    ctx.place("crypt", c.x, c.y + 0.6, { scale: 1.15, rot: Math.PI, jitter: 0 });
    for (let i = 0; i < 5; i++) {
      const a = ctx.rng() * Math.PI * 2, d = 1.1 + ctx.rng() * 0.8;
      ctx.place(i % 2 === 0 ? "skull" : "bone_A", c.x + Math.cos(a) * d, c.y + 0.6 + Math.sin(a) * d, { scale: 0.22 + ctx.rng() * 0.12 });
    }
  }
}

/** Garden hero: a fairy ring; modular: ground cover at three scales. */
function gardenGrowth(ctx: EnvCtx, r: EnvRoom, hero: boolean): void {
  const c = centerOf(r);
  if (hero) {
    const n = 7 + Math.floor(ctx.rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ctx.rng() * 0.3;
      ctx.place("mushroom", c.x + Math.cos(a) * 1.35, c.y + Math.sin(a) * 1.35, { scale: 0.26 + ctx.rng() * 0.18, jitter: 0.1 });
    }
    ctx.place("basket_mushrooms", c.x, c.y, { scale: 0.4, jitter: 0.2 });
  }
  // Three-scale cover: hugging grass, mid tufts, statement bushes.
  const scales = [0.32, 0.55, 0.85];
  const n = 5 + Math.floor(ctx.rng() * 4);
  for (let i = 0; i < n; i++) {
    const s = scales[i % 3];
    const key = i % 3 === 2 ? "forest_bush_2_a" : i % 2 === 0 ? "forest_grass_1_a" : "forest_grass_2_a";
    ctx.place(key, r.x + 1 + ctx.rng() * (r.w - 2), r.y + 1 + ctx.rng() * (r.h - 2), { scale: s, jitter: 0.3 });
  }
}

/** Approach hero: show-biz spotlight rigs sweeping the killing floor. */
function spotlightRig(ctx: EnvCtx, r: EnvRoom): void {
  const c = centerOf(r);
  const corners = [
    { x: r.x + 1.4, y: r.y + 1.4 }, { x: r.x + r.w - 1.4, y: r.y + 1.4 },
    { x: r.x + 1.4, y: r.y + r.h - 1.4 }, { x: r.x + r.w - 1.4, y: r.y + r.h - 1.4 },
  ];
  const start = Math.floor(ctx.rng() * 4);
  const iron = std(ctx, { color: 0x26242c, roughness: 0.5, metalness: 0.7 });
  const gold = std(ctx, { color: 0x8a7440, roughness: 0.35, metalness: 0.8 });
  for (let i = 0; i < 2; i++) {
    const p = corners[(start + i * 2) % 4];
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.6, 8), iron);
    pole.position.y = 0.8;
    pole.castShadow = true;
    g.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.08, 10), iron);
    base.position.y = 0.04;
    g.add(base);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.34, 10), gold);
    head.position.y = 1.58;
    head.rotation.x = Math.PI / 2 - 0.9;
    g.add(head);
    // The beam: additive cone angled into the room. Warm-gold — never red
    // (saturated red is reserved for danger telegraphs on these floors).
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(0.72, 2.6, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe2a0, transparent: true, opacity: 0.09, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    ctx.trackMat(beam.material);
    beam.position.set(0, 0.85, 0.78);
    beam.rotation.x = 0.62;
    g.add(beam);
    const lens = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffeebc, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    lens.scale.setScalar(0.42);
    lens.position.set(0, 1.62, 0.16);
    lens.userData.noAO = true;
    ctx.trackMat(lens.material);
    g.add(lens);
    g.rotation.y = Math.atan2(c.x - p.x, c.y - p.y);
    g.position.set(p.x, 0, p.y);
    ctx.addObj(g, p.x, p.y);
  }
  // Merch table: the System sells the moment.
  ctx.place("card_spades_ace", c.x + (ctx.rng() - 0.5) * 2, c.y + (ctx.rng() - 0.5) * 2, { scale: 0.3 });
  ctx.place("coin_stack_small", c.x + (ctx.rng() - 0.5) * 2.4, c.y + (ctx.rng() - 0.5) * 2.4, { scale: 0.3 });
}

export function signatureDressing(ctx: EnvCtx): void {
  const rooms = featureRooms(ctx);
  rooms.forEach((r, i) => {
    const hero = i === 0;
    switch (ctx.band) {
      case 0:
        ossuaryNiches(ctx, r, hero);
        break;
      case 1:
        if (hero || ctx.rng() < 0.6) waterChannel(ctx, r);
        pipeRun(ctx, r, false);
        break;
      case 2:
        gardenGrowth(ctx, r, hero);
        break;
      case 3:
        if (hero) collapsedColonnade(ctx, r);
        else {
          ctx.place("column", r.x + 1.6, r.y + 1.6, { scale: 1.3, rot: 0, jitter: 0.1 });
          ctx.place("rubble_large", r.x + r.w - 1.8, r.y + r.h - 1.8, { scale: 0.7 });
          if (ctx.rng() < 0.6) ctx.place("forest_bush_1_a", centerOf(r).x, centerOf(r).y + 1, { scale: 0.5, jitter: 0.6 });
        }
        break;
      case 4:
        if (hero) forgeCrucible(ctx, r);
        hangingChains(ctx, r);
        if (!hero) pipeRun(ctx, r, true);
        break;
      case 5:
        if (hero || ctx.rng() < 0.5) spotlightRig(ctx, r);
        break;
    }
  });
}

// ---- Pass 3: void composition (interior bands) ----

/** Sparse silhouetted geometry where there is otherwise only darkness: dim
 * columns/arches on the deep rock and past the map edge, plus a few distant
 * glints — negative space with composition, still clearly "not the world". */
export function voidSilhouettes(ctx: EnvCtx, mood: { voidInner: number; hemiSky: number; envHorizon: number }): void {
  const { map } = ctx;
  // WHISPER-quiet: these read as barely-there depth cues (<10% value step
  // over the murk). At the old 1.35x lift they read as glowing slabs
  // floating in the fog — the critic's #1 blocker.
  const silCol = new THREE.Color(mood.voidInner).lerp(new THREE.Color(mood.hemiSky), 0.1).multiplyScalar(0.8);
  const mat = new THREE.MeshBasicMaterial({ color: silCol });
  ctx.trackMat(mat);
  const mats: THREE.Matrix4[] = [];
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = (x: number, z: number, hgt: number, w: number) => {
    quat.identity();
    pos.set(x, hgt / 2, z);
    scl.set(w, hgt, w);
    mats.push(new THREE.Matrix4().compose(pos, quat, scl));
  };
  const lintel = (x: number, z: number, y: number, len: number, alongX: boolean) => {
    quat.identity();
    pos.set(x, y, z);
    scl.set(alongX ? len : 0.42, 0.34, alongX ? 0.42 : len);
    mats.push(new THREE.Matrix4().compose(pos, quat, scl));
  };
  // Deep-rock silhouettes: wall tiles with no floor within 2 tiles carry the
  // occasional broken column standing out of the rock mass.
  const deepOK = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (ctx.isFloor(x + dx, y + dy)) return false;
      }
    }
    return true;
  };
  const glints: { x: number; z: number; y: number }[] = [];
  for (let y = 1; y < map.h - 1; y++) {
    for (let x = 1; x < map.w - 1; x++) {
      if (!ctx.isWall(x, y) || !deepOK(x, y)) continue;
      const h = tileHash(x, y, ctx.floor + 307);
      if (h < 16) {
        col(x + 0.5, y + 0.5, 1.35 + (h % 13) * 0.1, 0.34 + (h % 7) * 0.03);
      } else if (h < 21 && glints.length < 5) {
        glints.push({ x: x + 0.5, z: y + 0.5, y: 1.2 + (h % 9) * 0.12 });
      }
    }
  }
  // Past the map edge: a ruin skyline ring — columns, the odd arch pair.
  const ring = 44;
  for (let i = 0; i < ring; i++) {
    const side = i % 4;
    const along = ctx.rng() * (side < 2 ? map.w + 20 : map.h + 20) - 10;
    const out = 2 + ctx.rng() * 12;
    const px = side === 0 || side === 1 ? along : side === 2 ? -out : map.w + out;
    const pz = side === 2 || side === 3 ? along : side === 0 ? -out : map.h + out;
    const hgt = 1.2 + ctx.rng() * 2.2;
    col(px, pz, hgt, 0.3 + ctx.rng() * 0.3);
    if (ctx.rng() < 0.22) {
      // Broken arch: partner column + lintel bridging them.
      const alongX = side < 2;
      const gap = 1.1 + ctx.rng() * 0.5;
      col(px + (alongX ? gap : 0), pz + (alongX ? 0 : gap), hgt * (0.85 + ctx.rng() * 0.2), 0.3);
      lintel(px + (alongX ? gap / 2 : 0), pz + (alongX ? 0 : gap / 2), hgt - 0.1, gap + 0.5, alongX);
    }
  }
  if (mats.length > 0) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, mats.length);
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    ctx.group.add(mesh);
  }
  // Distant glints: pinpricks of the band's horizon color in the dark.
  const gm = new THREE.SpriteMaterial({
    map: glowTexture(), color: mood.envHorizon, transparent: true, opacity: 0.05,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  ctx.trackMat(gm);
  for (const gl of glints) {
    const s = new THREE.Sprite(gm);
    s.scale.setScalar(0.2 + ctx.rng() * 0.16);
    s.position.set(gl.x, gl.y, gl.z);
    s.userData.noAO = true;
    ctx.group.add(s);
  }
}
