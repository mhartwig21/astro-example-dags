import { Tile, type FloorMap, type GameState, type Vec2 } from "./types";
import { isWalkableForMonster, tileAt } from "./floor";

// FLOW FIELD (AI tier 2): one multi-source BFS from every living crawler's
// tile, shared by every monster on the floor — O(tiles) per rebuild instead
// of a path search per monster. Distances respect walls, locked doors, the
// blocked-furniture mask, and the Roam sanctuary (isWalkableForMonster), so
// a chaser routed by the field walks AROUND the table it used to grind at.
//
// The field lives OUTSIDE GameState: it is a pure function of (map, player
// tiles), recomputed on demand and cached per state object below — nothing
// serializes, replays stay byte-identical, and the golden determinism test
// is indifferent to it. Rivals mount several floor worlds through ONE state
// object, so the cache holds a few keyed fields, not just the latest.

interface FlowField {
  dist: Int32Array;
  w: number;
  h: number;
}

const cache = new WeakMap<GameState, Map<string, FlowField>>();
const CACHE_MAX = 8; // rivals worlds + hysteresis; tiny either way

/** The field identity: world + the source tiles it was grown from. */
function fieldKey(state: GameState): string {
  let k = `${state.floor}:${state.mapVersion}`;
  for (const p of state.players) {
    if (p.alive) k += `:${Math.floor(p.pos.x)},${Math.floor(p.pos.y)}`;
  }
  return k;
}

function build(state: GameState): FlowField {
  const map = state.map;
  const { w, h } = map;
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const p of state.players) {
    if (!p.alive) continue;
    const tx = Math.floor(p.pos.x), ty = Math.floor(p.pos.y);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
    const i = ty * w + tx;
    if (dist[i] === -1) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  // 4-neighborhood on purpose: a diagonal step between two wall corners is
  // exactly the tunneling moveWithCollision forbids.
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && dist[i - 1] === -1 && isWalkableForMonster(map, x - 0.5, y + 0.5)) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < w - 1 && dist[i + 1] === -1 && isWalkableForMonster(map, x + 1.5, y + 0.5)) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - w] === -1 && isWalkableForMonster(map, x + 0.5, y - 0.5)) { dist[i - w] = d; queue[tail++] = i - w; }
    if (y < h - 1 && dist[i + w] === -1 && isWalkableForMonster(map, x + 0.5, y + 1.5)) { dist[i + w] = d; queue[tail++] = i + w; }
  }
  return { dist, w, h };
}

function field(state: GameState): FlowField {
  let byKey = cache.get(state);
  if (!byKey) cache.set(state, (byKey = new Map()));
  const key = fieldKey(state);
  const hit = byKey.get(key);
  if (hit) return hit;
  const built = build(state);
  if (byKey.size >= CACHE_MAX) byKey.delete(byKey.keys().next().value!);
  byKey.set(key, built);
  return built;
}

/**
 * The downhill step along the flow toward the nearest living crawler, or
 * null when there is nothing useful to say (on the crawler's own tile, in a
 * sealed-off region, out of bounds) — callers fall back to greedy steering.
 */
export function flowDir(state: GameState, pos: Vec2): Vec2 | null {
  const f = field(state);
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) return null;
  const here = f.dist[ty * f.w + tx];
  if (here <= 0) return null;
  let best = here;
  let bx = tx, by = ty;
  const consider = (nx: number, ny: number) => {
    const d = f.dist[ny * f.w + nx];
    if (d >= 0 && d < best) { best = d; bx = nx; by = ny; }
  };
  if (tx > 0) consider(tx - 1, ty);
  if (tx < f.w - 1) consider(tx + 1, ty);
  if (ty > 0) consider(tx, ty - 1);
  if (ty < f.h - 1) consider(tx, ty + 1);
  if (bx === tx && by === ty) return null;
  const dx = bx + 0.5 - pos.x, dy = by + 0.5 - pos.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? null : { x: dx / len, y: dy / len };
}

/**
 * The UPHILL step — away from every crawler along walkable topology (the
 * flee direction that can't be cornered by walls). Null when nothing is
 * useful (unreached tile, local maximum with no better neighbor).
 */
export function flowUphill(state: GameState, pos: Vec2): Vec2 | null {
  const f = field(state);
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) return null;
  const here = f.dist[ty * f.w + tx];
  if (here < 0) return null;
  let best = here;
  let bx = tx, by = ty;
  const consider = (nx: number, ny: number) => {
    const d = f.dist[ny * f.w + nx];
    if (d > best) { best = d; bx = nx; by = ny; }
  };
  if (tx > 0) consider(tx - 1, ty);
  if (tx < f.w - 1) consider(tx + 1, ty);
  if (ty > 0) consider(tx, ty - 1);
  if (ty < f.h - 1) consider(tx, ty + 1);
  if (bx === tx && by === ty) return null;
  const dx = bx + 0.5 - pos.x, dy = by + 0.5 - pos.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? null : { x: dx / len, y: dy / len };
}

/** Sight blockers: walls and locked doors. Furniture is knee-high — it
 * stops feet (isWalkable) but not eyes, same rule projectiles use. */
function sightBlocked(map: FloorMap, x: number, y: number): boolean {
  const t = tileAt(map, x, y);
  return t === Tile.Wall || t === Tile.DoorLocked;
}

/** Tile-grid line of sight between two points (integer Bresenham). */
export function tileLos(map: FloorMap, a: Vec2, b: Vec2): boolean {
  let x0 = Math.floor(a.x), y0 = Math.floor(a.y);
  const x1 = Math.floor(b.x), y1 = Math.floor(b.y);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (sightBlocked(map, x0 + 0.5, y0 + 0.5)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
