import { CONFIG } from "./config";
import { Tile, type FloorMap, type RoomRect, type RoomRole, type Vec2 } from "./types";
import { nextInt, type Rng } from "./rng";

type Room = RoomRect;

function center(r: Room): Vec2 {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

function idx(w: number, x: number, y: number): number {
  return y * w + x;
}

function carveRoom(tiles: Uint8Array, w: number, r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      tiles[idx(w, x, y)] = Tile.Floor;
    }
  }
}

// Corridors are TWO tiles wide so parties can fight side by side (and monsters
// can't be trivially bottlenecked in a 1-wide chokepoint).
function carveHCorridor(tiles: Uint8Array, w: number, h: number, x1: number, x2: number, y: number): void {
  const y2 = Math.min(h - 2, y + 1);
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2) + 1 && x < w - 1; x++) {
    tiles[idx(w, x, y)] = Tile.Floor;
    tiles[idx(w, x, y2)] = Tile.Floor;
  }
}

function carveVCorridor(tiles: Uint8Array, w: number, h: number, y1: number, y2: number, x: number): void {
  const x2 = Math.min(w - 2, x + 1);
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2) + 1 && y < h - 1; y++) {
    tiles[idx(w, x, y)] = Tile.Floor;
    tiles[idx(w, x2, y)] = Tile.Floor;
  }
}

function overlaps(a: Room, b: Room, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/** Floors at or below this depth seal the stairs room behind locked doors. */
export const LOCKED_FLOOR_MIN = 3;

/**
 * BFS over walkable tiles from a start tile; returns the reachable-tile mask.
 * Used by the door-locking softlock guard (and mirrored by the tests).
 */
function reachableFrom(tiles: Uint8Array, w: number, h: number, start: Vec2): Uint8Array {
  const seen = new Uint8Array(w * h);
  const sx = Math.floor(start.x), sy = Math.floor(start.y);
  const queue: number[] = [idx(w, sx, sy)];
  seen[queue[0]] = 1;
  while (queue.length > 0) {
    const i = queue.shift()!;
    const x = i % w, y = Math.floor(i / w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(w, nx, ny);
      if (seen[ni]) continue;
      const t = tiles[ni];
      if (t === Tile.Wall || t === Tile.DoorLocked) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

/**
 * Seal the stairs room: every walkable tile just outside the room's perimeter
 * (i.e. every corridor mouth) becomes a locked door. Softlock guard: if sealing
 * would cut off ANY other room (a corridor between two other rooms can graze the
 * stairs room), the seal is reverted and the floor stays unlocked.
 */
function lockStairsRoom(
  tiles: Uint8Array,
  w: number,
  h: number,
  rooms: Room[],
  stairsRoomIdx: number,
  spawn: Vec2,
): boolean {
  const room = rooms[stairsRoomIdx];
  const doors: number[] = [];
  const trySeal = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = idx(w, x, y);
    if (tiles[i] === Tile.Floor) {
      tiles[i] = Tile.DoorLocked;
      doors.push(i);
    }
  };
  // Orthogonal neighbors of the room rect: top/bottom edges, then left/right.
  for (let x = room.x; x < room.x + room.w; x++) {
    trySeal(x, room.y - 1);
    trySeal(x, room.y + room.h);
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    trySeal(room.x - 1, y);
    trySeal(room.x + room.w, y);
  }
  if (doors.length === 0) return false;

  // Everything except the stairs room must remain reachable from spawn.
  const seen = reachableFrom(tiles, w, h, spawn);
  const ok = rooms.every((r, i) => {
    if (i === stairsRoomIdx) return true;
    const c = center(r);
    return !!seen[idx(w, c.x, c.y)];
  });
  if (!ok) {
    for (const i of doors) tiles[i] = Tile.Floor;
    return false;
  }
  return true;
}

/**
 * Generate a floor: non-overlapping rooms connected by L-shaped corridors.
 * Player spawns in the first room; stairs-down are placed in the room farthest
 * (by center distance) from spawn so descent requires traversal. On floors
 * >= LOCKED_FLOOR_MIN the stairs room is sealed behind locked doors (a key
 * carrier is assigned when monsters spawn; see game.ts).
 */
export function generateFloor(rng: Rng, floor: number): FloorMap {
  const w = CONFIG.floorGridW;
  const h = CONFIG.floorGridH;
  const tiles = new Uint8Array(w * h); // all Wall (0) initially

  const targetRooms = nextInt(rng, CONFIG.floorMinRooms, CONFIG.floorMaxRooms);
  const rooms: Room[] = [];
  let attempts = 0;

  while (rooms.length < targetRooms && attempts < 300) {
    attempts++;
    const rw = nextInt(rng, 6, 12);
    const rh = nextInt(rng, 6, 12);
    const rx = nextInt(rng, 1, w - rw - 2);
    const ry = nextInt(rng, 1, h - rh - 2);
    const room: Room = { x: rx, y: ry, w: rw, h: rh };
    if (rooms.some((other) => overlaps(room, other, 1))) continue;
    rooms.push(room);
  }

  // Guarantee at least two rooms so there's always a spawn and a distinct stairs room.
  if (rooms.length < 2) {
    rooms.length = 0;
    rooms.push({ x: 2, y: 2, w: 7, h: 7 });
    rooms.push({ x: w - 9, y: h - 9, w: 7, h: 7 });
  }

  for (const r of rooms) carveRoom(tiles, w, r);

  // Connect rooms in creation order with L-shaped corridors.
  for (let i = 1; i < rooms.length; i++) {
    const a = center(rooms[i - 1]);
    const b = center(rooms[i]);
    if (nextInt(rng, 0, 1) === 0) {
      carveHCorridor(tiles, w, h, a.x, b.x, a.y);
      carveVCorridor(tiles, w, h, a.y, b.y, b.x);
    } else {
      carveVCorridor(tiles, w, h, a.y, b.y, a.x);
      carveHCorridor(tiles, w, h, a.x, b.x, b.y);
    }
  }

  // CYCLES: the creation-order chain is a tree (mazes feel like mazes). Fold the
  // space back on itself with loop corridors so floors read as architecture:
  // connect the last room to a mid-chain room, plus one more distant pair.
  let cycles = 0;
  const connect = (a: Vec2, b: Vec2) => {
    if (nextInt(rng, 0, 1) === 0) {
      carveHCorridor(tiles, w, h, a.x, b.x, a.y);
      carveVCorridor(tiles, w, h, a.y, b.y, b.x);
    } else {
      carveVCorridor(tiles, w, h, a.y, b.y, a.x);
      carveHCorridor(tiles, w, h, a.x, b.x, b.y);
    }
  };
  if (rooms.length >= 5) {
    connect(center(rooms[rooms.length - 1]), center(rooms[Math.floor(rooms.length / 2) - 1]));
    cycles++;
    const from = nextInt(rng, 0, rooms.length - 5);
    connect(center(rooms[from]), center(rooms[from + 3]));
    cycles++;
  }

  const spawn = center(rooms[0]);

  // Stairs: room whose center is farthest from spawn (never rooms[0], the spawn room).
  let farthestIdx = 1;
  let bestDist = -1;
  for (let i = 1; i < rooms.length; i++) {
    const c = center(rooms[i]);
    const d = (c.x - spawn.x) ** 2 + (c.y - spawn.y) ** 2;
    if (d > bestDist) {
      bestDist = d;
      farthestIdx = i;
    }
  }
  const stairs = center(rooms[farthestIdx]);
  tiles[idx(w, stairs.x, stairs.y)] = Tile.StairsDown;

  // ROLES (mission-lite): entrance and stairs are fixed; the biggest remaining
  // room becomes the LANDMARK set piece; the smallest room past the exit in
  // chain order (an off-path branch) becomes the treasure VAULT.
  const roles: RoomRole[] = rooms.map(() => "combat");
  roles[0] = "entrance";
  roles[farthestIdx] = "stairs";
  let landmarkIdx = -1;
  let bestArea = -1;
  for (let i = 1; i < rooms.length; i++) {
    if (i === farthestIdx) continue;
    const area = rooms[i].w * rooms[i].h;
    if (area > bestArea) { bestArea = area; landmarkIdx = i; }
  }
  if (landmarkIdx >= 0) roles[landmarkIdx] = "landmark";
  let vaultIdx = -1;
  let vaultArea = Infinity;
  for (let i = 1; i < rooms.length; i++) {
    if (i === farthestIdx || i === landmarkIdx) continue;
    // Prefer branch rooms past the exit in chain order (off the critical path).
    const offPath = i > farthestIdx ? 0 : 10000;
    const area = rooms[i].w * rooms[i].h + offPath;
    if (area < vaultArea) { vaultArea = area; vaultIdx = i; }
  }
  if (vaultIdx >= 0) roles[vaultIdx] = "vault";

  // PACING: 0..1 progress along the critical chain toward the stairs. Branch
  // rooms past the exit inherit near-full depth (they're deep detours).
  const depths = rooms.map((_r, i) =>
    farthestIdx === 0 ? 1 : Math.min(1, i / farthestIdx),
  );

  // Deep floors: seal the stairs room behind locked doors (softlock-guarded).
  const locked =
    floor >= LOCKED_FLOOR_MIN && lockStairsRoom(tiles, w, h, rooms, farthestIdx, spawn);

  return {
    w,
    h,
    tiles,
    spawn: { x: spawn.x + 0.5, y: spawn.y + 0.5 },
    stairs: { x: stairs.x + 0.5, y: stairs.y + 0.5 },
    rooms,
    roles,
    depths,
    cycles,
    locked,
    lockedRoomIdx: locked ? farthestIdx : -1,
  };
}

export function tileAt(map: FloorMap, x: number, y: number): Tile {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return Tile.Wall;
  return map.tiles[idx(map.w, tx, ty)] as Tile;
}

export function isWalkable(map: FloorMap, x: number, y: number): boolean {
  const t = tileAt(map, x, y);
  return t !== Tile.Wall && t !== Tile.DoorLocked;
}

/** Collect all walkable tile centers, for spawning monsters/loot. */
export function walkableTiles(map: FloorMap): Vec2[] {
  const out: Vec2[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const t = map.tiles[idx(map.w, x, y)];
      if (t !== Tile.Wall && t !== Tile.DoorLocked) {
        out.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
  }
  return out;
}
