// DCC BUILDER — the owner's crafting bench (/builder.html).
// Rooms: paint a tile footprint + place manifest props → RoomTemplate JSON.
// Enemies: pick a body + behavior + knobs → CustomMobDef JSON.
// Everything exports as data the game imports (src/content/); nothing here
// touches the sim. Reuses the game's own asset loader so the palette is
// exactly what the game can render.

import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadModels, MODEL_MANIFEST, type LoadedModel } from "./render3d/assets";
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

function frame(): void {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  const span = Math.max(room.w, room.h) * 0.75 + 2.5;
  const aspect = w / Math.max(1, h);
  camera.left = -span * aspect; camera.right = span * aspect;
  camera.top = span; camera.bottom = -span;
  camera.position.set(room.w / 2 + 10, 14, room.h / 2 + 10);
  camera.lookAt(room.w / 2, 0, room.h / 2);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", frame);

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

let painting = false;
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerdown", (ev) => {
  if (mode !== "rooms") return;
  const t = pointerTile(ev);
  if (!t) return;
  if (ev.button === 2 || tool === "erase") {
    // Erase: prop under cursor first, else revert tile to floor.
    const near = room.props.findIndex((p) => Math.hypot(p.x - t.fx, p.y - t.fy) < 0.6);
    if (near >= 0) { room.props.splice(near, 1); rebuildProps(); return; }
    room.tiles[t.y * room.w + t.x] = FLOOR;
    rebuildTiles();
    return;
  }
  if (tool === "prop" && activeProp) {
    lastPlaced = { key: activeProp, x: t.fx, y: t.fy, rot: 0 };
    room.props.push(lastPlaced);
    rebuildProps();
    return;
  }
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
  if (e.key.toLowerCase() === "r" && lastPlaced) {
    lastPlaced.rot = ((lastPlaced.rot ?? 0) + Math.PI / 4) % (Math.PI * 2);
    rebuildProps();
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
    b.textContent = k;
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
$("clearRoom").onclick = () => { resetTiles(); room.props = []; rebuildTiles(); rebuildProps(); };
$("resize").onclick = () => {
  room.w = Math.max(4, Math.min(18, Number(($("roomW") as HTMLInputElement).value)));
  room.h = Math.max(4, Math.min(14, Number(($("roomH") as HTMLInputElement).value)));
  resetTiles(); room.props = []; rebuildTiles(); rebuildProps(); frame();
};
$("rotateRoom").onclick = () => {
  // Rotate the whole design 90° clockwise: tiles transpose, props follow.
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
    Object.assign(mob, d);
    ($("mobId") as HTMLInputElement).value = d.id;
    ($("mobName") as HTMLInputElement).value = d.name;
    behaviorSel.value = d.behavior;
    renderMobModels(); showMobPreview();
    $("mobMsg").innerHTML = '<span class="ok">imported</span>';
  } catch { $("mobMsg").innerHTML = '<span class="warn">invalid JSON</span>'; }
};

// ---- Tabs ----
let mode: "rooms" | "mobs" = "rooms";
function setMode(m: typeof mode): void {
  mode = m;
  $("tabRooms").classList.toggle("active", m === "rooms");
  $("tabMobs").classList.toggle("active", m === "mobs");
  $("roomTools").style.display = m === "rooms" ? "" : "none";
  $("roomPane").style.display = m === "rooms" ? "" : "none";
  $("mobPane").style.display = m === "mobs" ? "" : "none";
  $("mobRight").style.display = m === "mobs" ? "" : "none";
  tileGroup.visible = propGroup.visible = m === "rooms";
  if (m === "mobs") showMobPreview();
  else if (mobPreview) { scene.remove(mobPreview); mobPreview = null; mobMixer = null; }
}
$("tabRooms").onclick = () => setMode("rooms");
$("tabMobs").onclick = () => setMode("mobs");

// ---- Meshy bridge (dev server only; the deployed page hides this) ----
async function initBridge(): Promise<void> {
  try {
    const r = await fetch("/__builder/ping");
    if (!r.ok) return;
  } catch { return; }
  $("bridgeBox").style.display = "";
  $("zipBox").style.display = "";
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
});

// Headless-verify hook: lets a driver assert the preview's skinned meshes are
// bound to the clone's own skeleton (the SkeletonUtils.clone contract).
(window as unknown as { __builderDebug: unknown }).__builderDebug = {
  preview: () => mobPreview,
};
