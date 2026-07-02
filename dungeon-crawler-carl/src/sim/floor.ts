import { CONFIG } from "./config";
import { Tile, type FloorMap, type Vec2 } from "./types";
import { nextInt, type Rng } from "./rng";

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/**
 * Generate a floor: non-overlapping rooms connected by L-shaped corridors.
 * Player spawns in the first room; stairs-down are placed in the room farthest
 * (by center distance) from spawn so descent requires traversal.
 */
export function generateFloor(rng: Rng, _floor: number): FloorMap {
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

  const spawn = center(rooms[0]);

  // Stairs: room whose center is farthest from spawn.
  let farthest = rooms[1] ?? rooms[0];
  let bestDist = -1;
  for (let i = 1; i < rooms.length; i++) {
    const c = center(rooms[i]);
    const d = (c.x - spawn.x) ** 2 + (c.y - spawn.y) ** 2;
    if (d > bestDist) {
      bestDist = d;
      farthest = rooms[i];
    }
  }
  const stairs = center(farthest);
  tiles[idx(w, stairs.x, stairs.y)] = Tile.StairsDown;

  return {
    w,
    h,
    tiles,
    spawn: { x: spawn.x + 0.5, y: spawn.y + 0.5 },
    stairs: { x: stairs.x + 0.5, y: stairs.y + 0.5 },
  };
}

export function tileAt(map: FloorMap, x: number, y: number): Tile {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return Tile.Wall;
  return map.tiles[idx(map.w, tx, ty)] as Tile;
}

export function isWalkable(map: FloorMap, x: number, y: number): boolean {
  return tileAt(map, x, y) !== Tile.Wall;
}

/** Collect all walkable tile centers, for spawning monsters/loot. */
export function walkableTiles(map: FloorMap): Vec2[] {
  const out: Vec2[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.tiles[idx(map.w, x, y)] !== Tile.Wall) {
        out.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
  }
  return out;
}
