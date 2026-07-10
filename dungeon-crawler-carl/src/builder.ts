// DCC BUILDER — the owner's crafting bench (/builder.html).
// Rooms: paint a tile footprint + place manifest props → RoomTemplate JSON.
// Enemies: pick a body + behavior + knobs → CustomMobDef JSON.
// Everything exports as data the game imports (src/content/); nothing here
// touches the sim. Reuses the game's own asset loader so the palette is
// exactly what the game can render.

import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadModels, MODEL_MANIFEST, type LoadedModel } from "./render3d/assets";
import { dressRoomPurpose, spillPurposeDoorways, type DressEnv } from "./render3d/dressing";
import { ROOM_PURPOSES, resolvePurpose, type RoomPurpose, type RoomCondition } from "./sim/roomPurposes";
import { createRng, nextFloat } from "./sim/rng";
import { ROOM_TEMPLATES, registerRoomTemplate, validateTemplate } from "./content/rooms";
import { MOB_DEFS } from "./content/mobs";
import { generateFloor } from "./sim/floor";
import { floorSeed } from "./sim/game";
import type { RoomTemplate, RoomProp, CustomMobDef } from "./content/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- Three.js stage ----
const viewport = $("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setClearColor(0x0a0a12);
viewport.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
scene.add(new THREE.AmbientLight(0x8888aa, 1.4));
const key = new THREE.DirectionalLight(0xfff1d0, 1.6);
key.position.set(6, 12, 4);
scene.add(key);

// Orbit + zoom: wheel zooms, middle-drag (or Alt+LMB) orbits yaw — the fixed
// iso angle hides the far walls, and dressings deserve inspection from all
// sides. Yaw π/4 reproduces the original (+10, +10) diagonal exactly.
let camYaw = Math.PI / 4;
let camZoom = 1;
function frame(): void {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  const span = (Math.max(room.w, room.h) * 0.75 + 2.5) / camZoom;
  const aspect = w / Math.max(1, h);
  camera.left = -span * aspect; camera.right = span * aspect;
  camera.top = span; camera.bottom = -span;
  const cx = room.w / 2, cz = room.h / 2, R = Math.SQRT2 * 10;
  camera.position.set(cx + Math.sin(camYaw) * R, 14, cz + Math.cos(camYaw) * R);
  camera.lookAt(cx, 0, cz);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", frame);
viewport.addEventListener("wheel", (e) => {
  camZoom = Math.min(3, Math.max(0.4, camZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
  frame();
  e.preventDefault();
}, { passive: false });
let orbiting = false;
let orbitX = 0;
window.addEventListener("pointermove", (ev) => {
  if (!orbiting) return;
  camYaw += (ev.clientX - orbitX) * 0.008;
  orbitX = ev.clientX;
  frame();
});
window.addEventListener("pointerup", () => { orbiting = false; });

// ---- Model library (the game's own loader: rig clips attach themselves) ----
let models: Record<string, LoadedModel> = {};
const instance = (k: string): THREE.Group | null => {
  const m = models[k];
  return m ? (m.scene.clone(true) as THREE.Group) : null;
};

// ---- Room state ----
const FLOOR = 1, WALL = 0;
const room = { w: 9, h: 7, tiles: [] as number[], props: [] as RoomProp[] };
const resetTiles = () => { room.tiles = new Array(room.w * room.h).fill(FLOOR); };
resetTiles();

const tileGroup = new THREE.Group();
const propGroup = new THREE.Group();
scene.add(tileGroup, propGroup);
const wallGeo = new THREE.BoxGeometry(1, 1.1, 1);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x12121c, roughness: 0.9 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x26263a, roughness: 0.95 });

function rebuildTiles(): void {
  tileGroup.clear();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(room.w, room.h), floorMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(room.w / 2, -0.01, room.h / 2);
  tileGroup.add(ground);
  const grid = new THREE.GridHelper(Math.max(room.w, room.h), Math.max(room.w, room.h), 0x2a2a3a, 0x1c1c2a);
  grid.position.set(room.w / 2, 0.001, room.h / 2);
  (grid.scale as THREE.Vector3).set(room.w / Math.max(room.w, room.h), 1, room.h / Math.max(room.w, room.h));
  tileGroup.add(grid);
  for (let y = 0; y < room.h; y++) {
    for (let x = 0; x < room.w; x++) {
      if (room.tiles[y * room.w + x] === WALL) {
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(x + 0.5, 0.55, y + 0.5);
        tileGroup.add(wall);
      }
    }
  }
  const onBorder = room.tiles.some((t, i) => {
    const x = i % room.w, y = Math.floor(i / room.w);
    return t === WALL && (x === 0 || y === 0 || x === room.w - 1 || y === room.h - 1);
  });
  $("borderWarn").textContent = onBorder
    ? "⚠ border tiles must stay FLOOR or the stamp is rejected in-game" : "";
}

function rebuildProps(): void {
  propGroup.clear();
  for (const p of room.props) {
    const obj = instance(p.key);
    if (!obj) continue;
    obj.position.set(p.x, 0, p.y);
    obj.rotation.y = p.rot ?? 0;
    obj.scale.setScalar(p.scale ?? 1);
    obj.userData.prop = p;
    propGroup.add(obj);
  }
}

// ---- Tools ----
let tool = "floor"; // floor | wall | erase | prop
let activeProp: string | null = null;
let lastPlaced: RoomProp | null = null;

document.querySelectorAll<HTMLButtonElement>("#tileTools button").forEach((b) => {
  b.onclick = () => {
    tool = b.dataset.tool!;
    activeProp = null;
    document.querySelectorAll("#tileTools button, #propList button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  };
});

const ray = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function pointerTile(ev: PointerEvent): { x: number; y: number; fx: number; fy: number } | null {
  const r = renderer.domElement.getBoundingClientRect();
  const nd = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(nd, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(groundPlane, hit)) return null;
  const x = Math.floor(hit.x), y = Math.floor(hit.z);
  if (x < 0 || y < 0 || x >= room.w || y >= room.h) return null;
  return { x, y, fx: Math.round(hit.x * 2) / 2, fy: Math.round(hit.z * 2) / 2 };
}

// Undo: every mutation snapshots first; Ctrl+Z restores (50 deep).
const undoStack: { w: number; h: number; tiles: number[]; props: RoomProp[] }[] = [];
function pushUndo(): void {
  undoStack.push({ w: room.w, h: room.h, tiles: [...room.tiles], props: JSON.parse(JSON.stringify(room.props)) });
  if (undoStack.length > 50) undoStack.shift();
}
function popUndo(): void {
  const s = undoStack.pop();
  if (!s) return;
  room.w = s.w; room.h = s.h; room.tiles = s.tiles; room.props = s.props;
  lastPlaced = null;
  ($("roomW") as HTMLInputElement).value = String(room.w);
  ($("roomH") as HTMLInputElement).value = String(room.h);
  rebuildTiles(); rebuildProps(); frame();
}

let painting = false;
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerdown", (ev) => {
  if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
    orbiting = true; orbitX = ev.clientX; ev.preventDefault();
    return;
  }
  if (mode !== "rooms") return;
  const t = pointerTile(ev);
  if (!t) return;
  if (ev.button === 2 || tool === "erase") {
    // Erase: prop under cursor first, else revert tile to floor.
    pushUndo();
    const near = room.props.findIndex((p) => Math.hypot(p.x - t.fx, p.y - t.fy) < 0.6);
    if (near >= 0) { room.props.splice(near, 1); rebuildProps(); return; }
    room.tiles[t.y * room.w + t.x] = FLOOR;
    rebuildTiles();
    return;
  }
  if (tool === "prop" && activeProp) {
    pushUndo();
    lastPlaced = { key: activeProp, x: t.fx, y: t.fy, rot: 0 };
    room.props.push(lastPlaced);
    rebuildProps();
    return;
  }
  pushUndo();
  painting = true;
  room.tiles[t.y * room.w + t.x] = tool === "wall" ? WALL : FLOOR;
  rebuildTiles();
});
renderer.domElement.addEventListener("pointermove", (ev) => {
  if (mode !== "rooms") return;
  const t = pointerTile(ev);
  // Ghost tracks the cursor while a prop is armed.
  if (ghost) {
    if (tool === "prop" && activeProp && t) {
      ghost.visible = true;
      ghost.position.set(t.fx, 0, t.fy);
    } else {
      ghost.visible = false;
    }
  }
  if (!painting || !t) return;
  room.tiles[t.y * room.w + t.x] = tool === "wall" ? WALL : FLOOR;
  rebuildTiles();
});
window.addEventListener("pointerup", () => { painting = false; });
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.ctrlKey && e.key.toLowerCase() === "z") { popUndo(); e.preventDefault(); return; }
  if (mode !== "rooms" || !lastPlaced) return;
  if (e.key.toLowerCase() === "r") {
    lastPlaced.rot = ((lastPlaced.rot ?? 0) + Math.PI / 4) % (Math.PI * 2);
    rebuildProps();
    return;
  }
  // Nudge the last-placed prop: arrows move a quarter tile, [ ] scale it.
  const nudge = 0.25;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-nudge, 0], ArrowRight: [nudge, 0], ArrowUp: [0, -nudge], ArrowDown: [0, nudge],
  };
  if (e.key in moves) {
    lastPlaced.x = Math.max(0, Math.min(room.w, lastPlaced.x + moves[e.key][0]));
    lastPlaced.y = Math.max(0, Math.min(room.h, lastPlaced.y + moves[e.key][1]));
    rebuildProps();
    e.preventDefault();
  } else if (e.key === "[" || e.key === "]") {
    lastPlaced.scale = Math.max(0.2, Math.min(4, (lastPlaced.scale ?? 1) * (e.key === "]" ? 1.1 : 0.9)));
    rebuildProps();
  }
});

// ---- Prop thumbnails (lazy offscreen renders, cached per key) ----
const thumbCache = new Map<string, string>();
let thumbGL: { r: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.OrthographicCamera } | null = null;
function thumbFor(key: string): string | null {
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const src = models[key];
  if (!src) return null;
  if (!thumbGL) {
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    r.setSize(56, 56);
    const s = new THREE.Scene();
    s.add(new THREE.AmbientLight(0xa0a0c0, 1.6));
    const d = new THREE.DirectionalLight(0xfff1d0, 1.8);
    d.position.set(3, 6, 2);
    s.add(d);
    thumbGL = { r, scene: s, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60) };
  }
  const obj = src.scene.clone(true) as THREE.Group;
  thumbGL.scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const m = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-3) * 0.62;
  thumbGL.cam.left = -m; thumbGL.cam.right = m; thumbGL.cam.top = m; thumbGL.cam.bottom = -m;
  thumbGL.cam.position.set(c.x + m * 2, c.y + m * 1.6, c.z + m * 2);
  thumbGL.cam.lookAt(c);
  thumbGL.cam.updateProjectionMatrix();
  thumbGL.r.render(thumbGL.scene, thumbGL.cam);
  const url = thumbGL.r.domElement.toDataURL();
  thumbGL.scene.remove(obj);
  thumbCache.set(key, url);
  return url;
}
// Render only thumbnails that scroll into view — the palette is 100+ keys.
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target as HTMLImageElement;
    const url = thumbFor(img.dataset.key ?? "");
    if (url) {
      img.src = url;
      thumbObserver.unobserve(img);
    } else if (Object.keys(models).length > 0) {
      thumbObserver.unobserve(img); // library loaded but key unknown — leave the placeholder
    } // else: models still loading; the palette re-renders after loadModels
  }
});

// ---- Prop palette (categorized) ----
const PROP_KEYS = Object.entries(MODEL_MANIFEST)
  .filter(([k, url]) => url.includes("/dungeon/") && !k.startsWith("fx_"))
  .map(([k]) => k)
  .sort();
const CATEGORIES: [string, RegExp][] = [
  ["all", /./],
  ["structure", /^(wall|floor|stairs)/],
  ["containers", /barrel|crate|box|keg|chest|trunk/],
  ["treasure", /coin|gold|gem|money|^key$|trophy|loot_box/],
  ["furniture", /table|shelf|bench|bookcase|stool|bartop|plate|book/],
  ["light & banners", /torch|lantern|banner/],
  ["nature", /forest|cliff|tree|bush|rock|grass|fence/],
  ["graveyard", /grave|crypt|pumpkin|bone|ribcage/],
  ["weapons & war", /weapon|sword|drum|cage|shell/],
  ["imported", /::generated::/], // replaced dynamically below
];
const generatedKeys = new Set<string>();
let activeCategory = "all";
const catSel = $("propCategory") as HTMLSelectElement;
for (const [name] of CATEGORIES) {
  const o = document.createElement("option");
  o.value = name; o.textContent = name;
  catSel.appendChild(o);
}
catSel.onchange = () => { activeCategory = catSel.value; renderPropList(propFilter); };

let propFilter = "";
function inCategory(k: string): boolean {
  if (activeCategory === "all") return true;
  if (activeCategory === "imported") return generatedKeys.has(k);
  const re = CATEGORIES.find(([n]) => n === activeCategory)?.[1];
  return re ? re.test(k) : true;
}
function renderPropList(filter = ""): void {
  propFilter = filter;
  const list = $("propList");
  list.innerHTML = "";
  for (const k of PROP_KEYS.filter((k) => k.includes(filter) && inCategory(k))) {
    const b = document.createElement("button");
    const img = document.createElement("img");
    img.dataset.key = k;
    img.width = 28; img.height = 28;
    thumbObserver.observe(img);
    const label = document.createElement("span");
    label.textContent = k;
    b.append(img, label);
    if (k === activeProp) b.classList.add("active");
    b.onclick = () => {
      tool = "prop"; activeProp = k;
      document.querySelectorAll("#tileTools button, #propList button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      refreshGhost();
    };
    list.appendChild(b);
  }
}
($("propSearch") as HTMLInputElement).oninput = (e) => renderPropList((e.target as HTMLInputElement).value);

// Ghost preview: the selected prop rides the cursor, half-transparent, so you
// SEE it (size, orientation, look) before committing a click.
let ghost: THREE.Group | null = null;
function refreshGhost(): void {
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (!activeProp) return;
  const obj = instance(activeProp);
  if (!obj) return;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    const mat = (m.material as THREE.MeshStandardMaterial).clone();
    mat.transparent = true;
    mat.opacity = 0.55;
    mat.depthWrite = false;
    m.material = mat;
  });
  obj.visible = false;
  ghost = obj;
  scene.add(ghost);
}

// ---- Room save / export / import ----
const ROOMS_KEY = "dcc:builder:rooms";
const savedRooms = (): RoomTemplate[] => JSON.parse(localStorage.getItem(ROOMS_KEY) ?? "[]");
const currentRoom = (): RoomTemplate => ({
  id: ($("roomId") as HTMLInputElement).value.trim(),
  name: ($("roomName") as HTMLInputElement).value.trim(),
  role: ($("roomRole") as HTMLSelectElement).value as RoomTemplate["role"],
  w: room.w, h: room.h, tiles: [...room.tiles], props: JSON.parse(JSON.stringify(room.props)),
});
function loadRoom(t: RoomTemplate): void {
  pushUndo();
  room.w = t.w; room.h = t.h; room.tiles = [...t.tiles]; room.props = JSON.parse(JSON.stringify(t.props));
  ($("roomId") as HTMLInputElement).value = t.id;
  ($("roomName") as HTMLInputElement).value = t.name;
  ($("roomRole") as HTMLSelectElement).value = t.role ?? "any";
  ($("roomW") as HTMLInputElement).value = String(t.w);
  ($("roomH") as HTMLInputElement).value = String(t.h);
  rebuildTiles(); rebuildProps(); frame();
}
function renderSaved(): void {
  const list = $("savedList");
  list.innerHTML = "";
  for (const t of savedRooms()) {
    const row = document.createElement("div");
    row.className = "saved";
    const name = document.createElement("span");
    name.textContent = `${t.name} (${t.w}×${t.h})`;
    name.style.cursor = "pointer";
    name.onclick = () => loadRoom(t);
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { localStorage.setItem(ROOMS_KEY, JSON.stringify(savedRooms().filter((x) => x.id !== t.id))); renderSaved(); };
    row.append(name, del);
    list.appendChild(row);
  }
}
$("saveRoom").onclick = () => {
  const t = currentRoom();
  if (!t.id) { $("roomMsg").innerHTML = '<span class="warn">id required</span>'; return; }
  localStorage.setItem(ROOMS_KEY, JSON.stringify([...savedRooms().filter((x) => x.id !== t.id), t]));
  renderSaved();
  $("roomMsg").innerHTML = '<span class="ok">saved locally — Export to add it to the game (src/content/rooms/)</span>';
};
$("exportRoom").onclick = () => {
  ($("roomJson") as HTMLTextAreaElement).value = JSON.stringify(currentRoom(), null, 2);
  $("roomMsg").innerHTML = '<span class="ok">copy into src/content/rooms/&lt;id&gt;.json and register it</span>';
};
$("importRoom").onclick = () => {
  try { loadRoom(JSON.parse(($("roomJson") as HTMLTextAreaElement).value)); $("roomMsg").innerHTML = '<span class="ok">imported</span>'; }
  catch { $("roomMsg").innerHTML = '<span class="warn">invalid JSON</span>'; }
};
$("clearRoom").onclick = () => { pushUndo(); resetTiles(); room.props = []; rebuildTiles(); rebuildProps(); };
// Shipped game content, loadable for editing (re-ship to update it).
function renderGameRooms(): void {
  const list = $("gameRooms");
  list.innerHTML = "";
  for (const t of ROOM_TEMPLATES) {
    const b = document.createElement("button");
    b.style.cssText = "display:block;text-align:left;background:none;border:none;color:var(--ink);cursor:pointer;padding:3px 6px;font-size:12px";
    b.textContent = `${t.name} (${t.w}×${t.h})`;
    b.onclick = () => { loadRoom(t); $("roomMsg").innerHTML = '<span class="ok">loaded from game — edit and re-ship</span>'; };
    list.appendChild(b);
  }
}
// TEST WALK: register the WIP template, then hunt (floor, seed) pairs with
// the game's exact derivation until one actually stamps it, and open that
// exact dungeon in a test-mode tab (main3d re-registers from localStorage).
$("testRoom").onclick = () => {
  const t = currentRoom();
  if (!t.id || !validateTemplate(t)) {
    $("roomMsg").innerHTML = '<span class="warn">needs an id + a valid template (floor border ring, open center)</span>';
    return;
  }
  registerRoomTemplate(t);
  localStorage.setItem("dcc:test:room", JSON.stringify(t));
  $("roomMsg").textContent = "searching for a floor that stamps it…";
  setTimeout(() => {
    for (let floor = 1; floor <= 6; floor++) {
      for (let seed = 1; seed <= 150; seed++) {
        const map = generateFloor(createRng(floorSeed(seed, floor)), floor);
        if (map.stamps?.some((s) => s.id === t.id)) {
          window.open(`/iso.html?test&floor=${floor}&seed=${seed}&testroom=1`, "_blank");
          $("roomMsg").innerHTML = `<span class="ok">stamped on floor ${floor}, seed ${seed} — opened. Check the minimap for your room</span>`;
          return;
        }
      }
    }
    $("roomMsg").innerHTML = '<span class="warn">no stamp in 900 floors — the template may be too big (rooms are 6-12 tiles; strict fit needs w≤room-2)</span>';
  }, 30);
};
$("resize").onclick = () => {
  pushUndo();
  room.w = Math.max(4, Math.min(18, Number(($("roomW") as HTMLInputElement).value)));
  room.h = Math.max(4, Math.min(14, Number(($("roomH") as HTMLInputElement).value)));
  resetTiles(); room.props = []; rebuildTiles(); rebuildProps(); frame();
};
$("rotateRoom").onclick = () => {
  // Rotate the whole design 90° clockwise: tiles transpose, props follow.
  pushUndo();
  const { w, h } = room;
  const next = new Array(w * h).fill(FLOOR);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (x, y) -> (x' = h-1-y, y' = x) in the rotated (w'=h, h'=w) grid.
      next[x * h + (h - 1 - y)] = room.tiles[y * w + x];
    }
  }
  room.tiles = next;
  for (const p of room.props) {
    const nx = h - p.y, ny = p.x;
    p.x = nx; p.y = ny;
    p.rot = ((p.rot ?? 0) - Math.PI / 2) % (Math.PI * 2);
  }
  room.w = h; room.h = w;
  ($("roomW") as HTMLInputElement).value = String(room.w);
  ($("roomH") as HTMLInputElement).value = String(room.h);
  rebuildTiles(); rebuildProps(); frame();
};

// ---- Enemy crafter ----
const BEHAVIORS: [string, string][] = [
  ["swarmer", "fast pack melee — rushes in numbers"],
  ["brute", "slow heavy — telegraphed ground slam"],
  ["ranged", "keeps distance, telegraphed shots"],
  ["bomber", "runs at you and detonates (fuse tell)"],
  ["shaman", "standoff healer — channels heals (interrupt window)"],
  ["phantom", "fast, fragile, blinks toward prey"],
  ["charger", "locks a lane, then rushes it"],
  ["spitter", "lobs acid puddles at your feet"],
  ["necromancer", "raises fresh corpses (channel)"],
  ["drummer", "pack support — frenzy drum aura"],
  ["filcher", "steals gold and flees with it"],
  ["lineworker", "piston punch with knockback"],
  ["sentinel", "lock-on tracking beam"],
  ["toysoldier", "squad-synced volleys"],
];
const CHARACTER_KEYS = Object.entries(MODEL_MANIFEST)
  .filter(([k, url]) => url.includes("/characters/") && !k.startsWith("armory_"))
  .map(([k]) => k)
  .sort();

let mobPreview: THREE.Group | null = null;
let mobMixer: THREE.AnimationMixer | null = null;
const mob: CustomMobDef = {
  id: "my-enemy", name: "THE NEWCOMER", behavior: "swarmer",
  skin: "monster_swarmer", hpMult: 1, damageMult: 1, speedMult: 1,
  scale: 1, bands: [0], weight: 1,
};

function showMobPreview(): void {
  if (mobPreview) scene.remove(mobPreview);
  mobMixer = null;
  const m = models[mob.skin];
  if (!m) return;
  // SkeletonUtils.clone, not .clone(): a plain clone leaves skinned meshes
  // bound to the source scene's bones, so clips play but the mesh never moves.
  mobPreview = cloneSkinned(m.scene) as THREE.Group;
  // Normalize to a readable size, apply scale + tint like the game would.
  const size = new THREE.Box3().setFromObject(mobPreview).getSize(new THREE.Vector3());
  mobPreview.scale.setScalar((2.2 / Math.max(size.y, 1e-3)) * (mob.scale ?? 1));
  if (mob.tint) {
    mobPreview.traverse((o) => {
      const mm = o as THREE.Mesh;
      if (!mm.isMesh) return;
      const mat = (mm.material as THREE.MeshStandardMaterial).clone();
      mat.emissive = new THREE.Color(mob.tint!);
      mat.emissiveIntensity = 0.32;
      mm.material = mat;
    });
  }
  mobPreview.position.set(room.w / 2, 0, room.h / 2);
  scene.add(mobPreview);
  // Clip preview dropdown: every animation this body can play, selectable.
  const clipSel = $("mobClip") as HTMLSelectElement;
  const prevChoice = clipSel.value;
  clipSel.innerHTML = "";
  for (const c of m.animations.slice(0, 60)) {
    const o = document.createElement("option");
    o.value = c.name; o.textContent = c.name;
    clipSel.appendChild(o);
  }
  if (m.animations.length) {
    mobMixer = new THREE.AnimationMixer(mobPreview);
    const chosen =
      m.animations.find((c) => c.name === prevChoice) ??
      m.animations.find((c) => /idle/i.test(c.name)) ??
      m.animations[0];
    clipSel.value = chosen.name;
    mobMixer.clipAction(chosen).play();
  }
}
($("mobClip") as HTMLSelectElement).onchange = () => showMobPreview();

function renderMobModels(filter = ""): void {
  const list = $("mobModelList");
  list.innerHTML = "";
  for (const k of CHARACTER_KEYS.filter((k) => k.includes(filter))) {
    const b = document.createElement("button");
    b.textContent = k;
    if (k === mob.skin) b.classList.add("active");
    b.onclick = () => {
      mob.skin = k;
      renderMobModels((($("mobModelSearch") as HTMLInputElement).value));
      showMobPreview();
    };
    list.appendChild(b);
  }
}
($("mobModelSearch") as HTMLInputElement).oninput = (e) => renderMobModels((e.target as HTMLInputElement).value);

const behaviorSel = $("mobBehavior") as HTMLSelectElement;
for (const [k, blurb] of BEHAVIORS) {
  const o = document.createElement("option");
  o.value = k; o.textContent = k;
  o.dataset.blurb = blurb;
  behaviorSel.appendChild(o);
}
behaviorSel.onchange = () => {
  mob.behavior = behaviorSel.value;
  $("behaviorBlurb").textContent = BEHAVIORS.find(([k]) => k === mob.behavior)?.[1] ?? "";
};
$("behaviorBlurb").textContent = BEHAVIORS[0][1];

const BAND_NAMES = ["Undercroft", "Sewers", "Garden", "Ruins", "Ironworks", "Approach"];
const bandBox = $("bandChecks");
BAND_NAMES.forEach((name, i) => {
  const l = document.createElement("label");
  l.style.display = "inline-flex"; l.style.gap = "3px"; l.style.alignItems = "center";
  const c = document.createElement("input");
  c.type = "checkbox"; c.style.width = "auto"; c.checked = i === 0;
  c.onchange = () => {
    mob.bands = BAND_NAMES.map((_, j) => j).filter((j) => (bandBox.children[j].querySelector("input") as HTMLInputElement).checked);
  };
  l.append(c, document.createTextNode(name.slice(0, 4)));
  bandBox.appendChild(l);
});

const bindSlider = (id: string, out: string, set: (v: number) => void) => {
  const el = $(id) as HTMLInputElement;
  el.oninput = () => { $(out).textContent = Number(el.value).toFixed(1); set(Number(el.value)); };
};
bindSlider("mHp", "oHp", (v) => (mob.hpMult = v));
bindSlider("mDmg", "oDmg", (v) => (mob.damageMult = v));
bindSlider("mSpd", "oSpd", (v) => (mob.speedMult = v));
bindSlider("mScale", "oScale", (v) => { mob.scale = v; showMobPreview(); });
bindSlider("mWeight", "oWeight", (v) => (mob.weight = v));
($("mobTint") as HTMLSelectElement).onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  mob.tint = v ? Number(v) : undefined;
  showMobPreview();
};

const MOBS_KEY = "dcc:builder:mobs";
const savedMobs = (): CustomMobDef[] => JSON.parse(localStorage.getItem(MOBS_KEY) ?? "[]");
const currentMob = (): CustomMobDef => ({
  ...mob,
  id: ($("mobId") as HTMLInputElement).value.trim(),
  name: ($("mobName") as HTMLInputElement).value.trim(),
});
function renderSavedMobs(): void {
  const list = $("savedMobs");
  list.innerHTML = "";
  for (const d of savedMobs()) {
    const row = document.createElement("div");
    row.className = "saved";
    const name = document.createElement("span");
    name.textContent = `${d.name} (${d.behavior})`;
    name.style.cursor = "pointer";
    name.onclick = () => {
      Object.assign(mob, d);
      ($("mobId") as HTMLInputElement).value = d.id;
      ($("mobName") as HTMLInputElement).value = d.name;
      behaviorSel.value = d.behavior;
      renderMobModels(); showMobPreview();
    };
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "✕";
    del.onclick = () => { localStorage.setItem(MOBS_KEY, JSON.stringify(savedMobs().filter((x) => x.id !== d.id))); renderSavedMobs(); };
    row.append(name, del);
    list.appendChild(row);
  }
}
$("saveMob").onclick = () => {
  const d = currentMob();
  if (!d.id) { $("mobMsg").innerHTML = '<span class="warn">id required</span>'; return; }
  localStorage.setItem(MOBS_KEY, JSON.stringify([...savedMobs().filter((x) => x.id !== d.id), d]));
  renderSavedMobs();
  $("mobMsg").innerHTML = '<span class="ok">saved locally — Export to add it to the game (src/content/mobs/)</span>';
};
$("exportMob").onclick = () => {
  ($("mobJson") as HTMLTextAreaElement).value = JSON.stringify(currentMob(), null, 2);
  $("mobMsg").innerHTML = '<span class="ok">copy into src/content/mobs/&lt;id&gt;.json and register it</span>';
};
$("importMob").onclick = () => {
  try {
    const d = JSON.parse(($("mobJson") as HTMLTextAreaElement).value) as CustomMobDef;
    loadMob(d);
    $("mobMsg").innerHTML = '<span class="ok">imported</span>';
  } catch { $("mobMsg").innerHTML = '<span class="warn">invalid JSON</span>'; }
};
function loadMob(d: CustomMobDef): void {
  Object.assign(mob, d);
  ($("mobId") as HTMLInputElement).value = d.id;
  ($("mobName") as HTMLInputElement).value = d.name;
  behaviorSel.value = d.behavior;
  renderMobModels();
  showMobPreview();
}
function renderGameMobs(): void {
  const list = $("gameMobs");
  list.innerHTML = "";
  for (const d of MOB_DEFS) {
    const b = document.createElement("button");
    b.style.cssText = "display:block;text-align:left;background:none;border:none;color:var(--ink);cursor:pointer;padding:3px 6px;font-size:12px";
    b.textContent = `${d.name} (${d.behavior})`;
    b.onclick = () => { loadMob(d); $("mobMsg").innerHTML = '<span class="ok">loaded from game — edit and re-ship</span>'; };
    list.appendChild(b);
  }
}
// TEST FIGHT: stash the def; the test-mode host registers it with every band
// + heavy weight so its behavior's next spawns become YOUR enemy.
$("testMob").onclick = () => {
  const d = currentMob();
  if (!d.id) { $("mobMsg").innerHTML = '<span class="warn">id required</span>'; return; }
  localStorage.setItem("dcc:test:mob", JSON.stringify(d));
  const floor = (d.bands?.[0] ?? 0) * 3 + 1;
  window.open(`/iso.html?test&floor=${floor}&testmob=1`, "_blank");
  $("mobMsg").innerHTML = `<span class="ok">opened floor ${floor} — most ${d.behavior}s there are now ${d.name}</span>`;
};

// ---- Dressing preview (the vignette grammar, SHARED with the game) ----
// dressRoomPurpose here is the same function renderer3d runs on real floors:
// what this tab shows is what the game builds, not a lookalike. The painted
// Rooms-tab footprint is the room; everything outside it reads as wall mass,
// with one synthetic doorway so the corridor spill shows too.
const dressGroup = new THREE.Group();
scene.add(dressGroup);
const dress = {
  purposeId: ROOM_PURPOSES[0].id,
  variantId: "", // "" = base dressing
  condition: "pristine" as RoomCondition,
  seed: 1,
  override: null as RoomPurpose | null, // Apply JSON edits land here
};
const currentBase = (): RoomPurpose =>
  ROOM_PURPOSES.find((p) => p.id === dress.purposeId) ?? ROOM_PURPOSES[0];
function resolvedDress(): RoomPurpose {
  if (dress.override) return dress.override;
  const base = currentBase();
  return resolvePurpose(base, base.variants?.find((v) => v.id === dress.variantId) ?? null);
}

// Unknown keys (typos, un-promoted generated props) still show as a stand-in
// box so the composition reads while you iterate.
const fallbackBox = (key: string): THREE.Group => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.8, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x3a3a4f + (h % 0x40), roughness: 0.9 }),
  );
  m.position.y = 0.4;
  g.add(m);
  return g;
};
const apronMat = new THREE.MeshStandardMaterial({ color: 0x1a1a28, roughness: 0.95 });

// The latest dressing pass as bake-able template props (see place()).
const dressBake: { props: RoomProp[]; skipped: number } = { props: [], skipped: 0 };

function refreshDressing(): void {
  dressGroup.clear();
  dressBake.props = [];
  dressBake.skipped = 0;
  if (mode !== "dress") return;
  const r = { x: 0, y: 0, w: room.w, h: room.h };
  // Apron under the surroundings so the doorway spill has ground to sit over.
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(room.w + 6, room.h + 6), apronMat);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(room.w / 2, -0.02, room.h / 2);
  dressGroup.add(apron);
  // Synthetic map: the painted footprint, wall mass beyond it, one doorway
  // corridor off the south edge (so spillPurposeDoorways has a door to leak
  // out of, exactly like a real floor's corridors).
  const doorX = Math.floor(room.w / 2);
  const inRoom = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < room.w && ty < room.h;
  const isCorridor = (tx: number, ty: number) => tx === doorX && ty >= room.h && ty < room.h + 2;
  const isFloorAt = (x: number, y: number): boolean => {
    const tx = Math.floor(x), ty = Math.floor(y);
    return inRoom(tx, ty) ? room.tiles[ty * room.w + tx] === FLOOR : isCorridor(tx, ty);
  };
  const rng = createRng((dress.seed ^ 0x9e3779b1) >>> 0);
  const frng = () => nextFloat(rng);
  let lights = 0;
  const env: DressEnv = {
    frng,
    isFloor: isFloorAt,
    isWall: (x, y) => {
      const tx = Math.floor(x), ty = Math.floor(y);
      return inRoom(tx, ty) ? room.tiles[ty * room.w + tx] === WALL : !isCorridor(tx, ty);
    },
    clear: isFloorAt,
    place: (key, x, y, opts = {}) => {
      if (!isFloorAt(x, y)) return null;
      // Mirror of renderer3d's place(): footprint-normalize, jitter, ground
      // snap — same rng call order so seeds shuffle layouts the same way.
      const obj = instance(key) ?? fallbackBox(key);
      const box = new THREE.Box3().setFromObject(obj);
      const fp = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1e-4);
      obj.scale.multiplyScalar((opts.scale ?? 0.55 + frng() * 0.2) / fp);
      const scaled = new THREE.Box3().setFromObject(obj);
      const j = opts.jitter ?? 0.25;
      obj.position.set(
        x + (frng() - 0.5) * j - (scaled.min.x + scaled.max.x) / 2 + obj.position.x,
        -scaled.min.y + 0.004 + (opts.elevate ?? 0),
        y + (frng() - 0.5) * j - (scaled.min.z + scaled.max.z) / 2 + obj.position.z,
      );
      obj.rotation.y = opts.rot ?? frng() * Math.PI * 2;
      dressGroup.add(obj);
      // Bake bookkeeping: template props live at y=0 with a scalar scale, so
      // elevated placements (wall mounts, tabletop items), corridor spill,
      // and unknown keys can't survive the conversion — count them instead.
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const bx = r2(obj.position.x), by = r2(obj.position.z);
      if ((opts.elevate ?? 0) > 0 || !models[key] || bx < 0 || by < 0 || bx > room.w || by > room.h) {
        dressBake.skipped++;
      } else {
        dressBake.props.push({ key, x: bx, y: by, rot: r2(obj.rotation.y), scale: r2(obj.scale.x) });
      }
      return obj;
    },
    canTorch: () => lights < 6,
    addTorch: (x, y) => {
      if (lights++ >= 6) return;
      const l = new THREE.PointLight(0xffb45e, 2.2, 6);
      l.position.set(x, 0.9, y);
      dressGroup.add(l);
    },
  };
  const p = resolvedDress();
  // Social anchor, rolled like assignRoomPurposes rolls it: a table sits in
  // an off-center quadrant (the middle stays a fight), a centerpiece centers.
  let anchor: { x: number; y: number } | null = null;
  if (p.tableSet) {
    anchor = {
      x: r.x + r.w * (frng() < 0.5 ? 0.32 : 0.68),
      y: r.y + r.h * (frng() < 0.5 ? 0.32 : 0.68),
    };
  } else if (p.centerpiece) {
    anchor = { x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 };
  }
  dressRoomPurpose(env, r, { purpose: p, condition: dress.condition, anchor });
  spillPurposeDoorways(env, r, p);
  $("dressMsg").textContent = "";
  if (r.w < 5 || r.h < 5) {
    $("dressMsg").innerHTML = '<span class="warn">room under 5×5 — the game only dresses rooms 5×5 and up</span>';
  }
}

function renderPurposeList(): void {
  const list = $("purposeList");
  list.innerHTML = "";
  for (const pu of ROOM_PURPOSES) {
    const b = document.createElement("button");
    b.textContent = `${pu.id} · ${pu.zone ?? "work"}`;
    b.style.cssText = "text-align:left;background:none;border:none;padding:3px 6px;cursor:pointer;font-size:12px";
    b.style.color = pu.id === dress.purposeId ? "var(--gold)" : "var(--ink)";
    b.onclick = () => {
      dress.purposeId = pu.id;
      dress.variantId = "";
      dress.override = null;
      renderPurposeList();
      refreshVariantSelect();
      syncDressJson();
      refreshDressing();
    };
    list.appendChild(b);
  }
}
function refreshVariantSelect(): void {
  const sel = $("dressVariant") as HTMLSelectElement;
  sel.innerHTML = "";
  const add = (v: string, t: string) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  };
  add("", "base");
  for (const v of currentBase().variants ?? []) add(v.id, v.id);
  sel.value = dress.variantId;
}
function syncDressJson(): void {
  ($("dressJson") as HTMLTextAreaElement).value = JSON.stringify(resolvedDress(), null, 2);
}
($("dressVariant") as HTMLSelectElement).onchange = (e) => {
  dress.variantId = (e.target as HTMLSelectElement).value;
  dress.override = null;
  syncDressJson();
  refreshDressing();
};
($("dressCondition") as HTMLSelectElement).onchange = (e) => {
  dress.condition = (e.target as HTMLSelectElement).value as RoomCondition;
  refreshDressing();
};
($("dressSeed") as HTMLInputElement).oninput = (e) => {
  dress.seed = Number((e.target as HTMLInputElement).value) || 0;
  refreshDressing();
};
$("dressReroll").onclick = () => {
  dress.seed += 1;
  ($("dressSeed") as HTMLInputElement).value = String(dress.seed);
  refreshDressing();
};
$("dressApply").onclick = () => {
  try {
    const p = JSON.parse(($("dressJson") as HTMLTextAreaElement).value) as RoomPurpose;
    if (!Array.isArray(p.wallRun) || !Array.isArray(p.wallMount)) {
      throw new Error("wallRun and wallMount must be arrays of prop keys");
    }
    dress.override = p;
    // Warn on keys the model library doesn't know — they render as boxes.
    const keys = [
      ...p.wallRun, ...p.wallMount, ...(p.cornerStack ?? []), ...(p.rug ?? []),
      ...(p.tableSet ? [p.tableSet.table, p.tableSet.seat, ...p.tableSet.tabletop] : []),
      ...(p.centerpiece ? [p.centerpiece.key, ...p.centerpiece.spill] : []),
    ];
    const unknown = [...new Set(keys.filter((k) => !models[k]))];
    refreshDressing();
    $("dressMsg").innerHTML = unknown.length
      ? `<span class="warn">unknown props render as boxes: ${unknown.join(", ")}</span>`
      : '<span class="ok">applied</span>';
  } catch (e) {
    $("dressMsg").innerHTML = `<span class="warn">${String(e).slice(0, 160)}</span>`;
  }
};
$("dressReset").onclick = () => {
  dress.override = null;
  syncDressJson();
  refreshDressing();
};
// BAKE: the current dressing becomes the room's own props — hand-tweak each
// piece in the Rooms tab, then save/ship as a template. Wall mounts, table-
// top items, and corridor spill can't convert (templates are y=0, in-room).
$("dressBake").onclick = () => {
  if (dressBake.props.length === 0) { $("dressMsg").innerHTML = '<span class="warn">nothing to bake — dress a room first</span>'; return; }
  pushUndo();
  room.props = JSON.parse(JSON.stringify(dressBake.props));
  rebuildProps();
  $("dressMsg").innerHTML = `<span class="ok">baked ${dressBake.props.length} props into the Rooms tab${dressBake.skipped ? ` (${dressBake.skipped} elevated/corridor pieces skipped)` : ""}</span>`;
};

// ---- Tabs ----
let mode: "rooms" | "mobs" | "dress" = "rooms";
function setMode(m: typeof mode): void {
  mode = m;
  $("tabRooms").classList.toggle("active", m === "rooms");
  $("tabMobs").classList.toggle("active", m === "mobs");
  $("tabDress").classList.toggle("active", m === "dress");
  $("roomTools").style.display = m === "rooms" ? "" : "none";
  $("roomPane").style.display = m === "rooms" ? "" : "none";
  $("mobPane").style.display = m === "mobs" ? "" : "none";
  $("mobRight").style.display = m === "mobs" ? "" : "none";
  $("dressPane").style.display = m === "dress" ? "" : "none";
  $("dressRight").style.display = m === "dress" ? "" : "none";
  tileGroup.visible = m !== "mobs"; // the dressed room keeps its painted walls
  propGroup.visible = m === "rooms"; // manual props hide while previewing dressing
  if (ghost) ghost.visible = false;
  if (m === "mobs") showMobPreview();
  else if (mobPreview) { scene.remove(mobPreview); mobPreview = null; mobMixer = null; }
  refreshDressing();
}
$("tabRooms").onclick = () => setMode("rooms");
$("tabMobs").onclick = () => setMode("mobs");
$("tabDress").onclick = () => setMode("dress");

// ---- Meshy bridge (dev server only; the deployed page hides this) ----
async function initBridge(): Promise<void> {
  try {
    const r = await fetch("/__builder/ping");
    if (!r.ok) return;
  } catch { return; }
  $("bridgeBox").style.display = "";
  $("zipBox").style.display = "";
  // SHIP TO GAME: the bridge writes the content file + registry entry on this
  // machine — the result is a git diff to review, not a hidden side channel.
  $("shipRoom").style.display = $("shipMob").style.display = $("shipPurpose").style.display = "";
  const ship = async (kind: string, data: unknown, msgEl: string): Promise<void> => {
    const r = await fetch("/__builder/ship", { method: "POST", body: JSON.stringify({ kind, data }) });
    const body = await r.json() as { files?: string[]; error?: string };
    $(msgEl).innerHTML = r.ok
      ? `<span class="ok">shipped → ${(body.files ?? []).join(", ")} — review the git diff and commit</span>`
      : `<span class="warn">${body.error}</span>`;
  };
  $("shipRoom").onclick = () => {
    const t = currentRoom();
    if (!t.id || !validateTemplate(t)) {
      $("roomMsg").innerHTML = '<span class="warn">needs an id + a valid template (floor border ring, open center)</span>';
      return;
    }
    void ship("room", t, "roomMsg");
  };
  $("shipMob").onclick = () => {
    const d = currentMob();
    if (!d.id || !d.name) { $("mobMsg").innerHTML = '<span class="warn">id and name required</span>'; return; }
    void ship("mob", d, "mobMsg");
  };
  $("shipPurpose").onclick = () => {
    try {
      const p = JSON.parse(($("dressJson") as HTMLTextAreaElement).value) as RoomPurpose;
      void ship("purpose", p, "dressMsg"); // bridge upsert keeps authored variants unless you send your own
    } catch { $("dressMsg").innerHTML = '<span class="warn">invalid JSON</span>'; }
  };
  // Zip import: search the owner's KayKit collection zip, extract + convert
  // props on demand (they land in the generated palette).
  $("zipGo").onclick = async () => {
    const q = ($("zipSearch") as HTMLInputElement).value.trim();
    if (!q) return;
    $("zipResults").textContent = "searching…";
    const hits = await (await fetch(`/__builder/zip-search?q=${encodeURIComponent(q)}`)).json() as string[];
    const box = $("zipResults");
    box.innerHTML = "";
    for (const path of hits) {
      const b = document.createElement("button");
      b.style.cssText = "display:block;text-align:left;background:none;border:none;color:var(--ink);cursor:pointer;padding:2px 4px;font-size:11px";
      b.textContent = path.split("/").slice(-1)[0] + "  (" + path.split("/").slice(1, 2)[0] + ")";
      b.title = path;
      b.onclick = async () => {
        $("zipMsg").textContent = "extracting + converting…";
        const r = await fetch("/__builder/zip-extract", { method: "POST", body: JSON.stringify({ path }) });
        const body = await r.json();
        $("zipMsg").textContent = r.ok
          ? `imported as "${body.key}" — reload the page to place it`
          : `failed: ${body.error}`;
      };
      box.appendChild(b);
    }
    if (hits.length === 0) box.textContent = "no matches";
  };
  const renderJobs = async () => {
    try {
      const jobs = await (await fetch("/__builder/jobs")).json() as
        { id: string; kind: string; status: string; detail: string }[];
      $("jobList").innerHTML = jobs.map((j) =>
        `<div>[${j.status}] ${j.kind} <b>${j.id}</b> — ${j.detail}</div>`).join("") || "no jobs yet";
    } catch { /* server restarting */ }
  };
  setInterval(renderJobs, 4000);
  void renderJobs();
  const kick = async (kind: "prop" | "creature") => {
    const id = ($("genId") as HTMLInputElement).value.trim();
    const prompt = ($("genPrompt") as HTMLInputElement).value.trim();
    const r = await fetch("/__builder/generate", {
      method: "POST",
      body: JSON.stringify({ kind, id, prompt }),
    });
    if (!r.ok) $("jobList").innerHTML = `<span class="warn">${(await r.json()).error}</span>`;
    else void renderJobs();
  };
  $("genProp").onclick = () => void kick("prop");
  $("genCreature").onclick = () => void kick("creature");
}
void initBridge();

// ---- Boot ----
const clock = new THREE.Clock();
function tick(): void {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (mobMixer) mobMixer.update(dt);
  if (mobPreview) mobPreview.rotation.y += dt * 0.5;
  renderer.render(scene, camera);
}
rebuildTiles();
renderPropList();
renderSaved();
renderSavedMobs();
renderMobModels();
renderGameRooms();
renderGameMobs();
renderPurposeList();
refreshVariantSelect();
syncDressJson();
frame();
tick();
void loadModels().then(async (m) => {
  models = m;
  // Generated assets join the palettes: props into the room palette,
  // creature entries (they carry clips) into the body list.
  try {
    const ix = await (await fetch("/assets/generated/index.json")).json() as
      Record<string, { url: string; clips?: string[] }>;
    for (const [k, e] of Object.entries(ix)) {
      if (e.clips?.length) CHARACTER_KEYS.push(k);
      else { PROP_KEYS.push(k); generatedKeys.add(k); }
    }
    PROP_KEYS.sort(); CHARACTER_KEYS.sort();
    renderPropList(); renderMobModels();
  } catch { /* nothing generated yet */ }
  rebuildProps();
  if (mode === "mobs") showMobPreview();
  if (mode === "dress") refreshDressing();
});

// Headless-verify hook: lets a driver assert the preview's skinned meshes are
// bound to the clone's own skeleton (the SkeletonUtils.clone contract).
(window as unknown as { __builderDebug: unknown }).__builderDebug = {
  preview: () => mobPreview,
  dressCount: () => dressGroup.children.length,
  dressSnapshot: () =>
    JSON.stringify(dressGroup.children.map((o) => [Math.round(o.position.x * 100), Math.round(o.position.z * 100)])),
};
