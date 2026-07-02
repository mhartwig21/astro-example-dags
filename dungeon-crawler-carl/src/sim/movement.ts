import type { FloorMap, Vec2 } from "./types";

const RADIUS = 0.3; // entity half-size in tiles, for wall clearance

type Walkable = (map: FloorMap, x: number, y: number) => boolean;

function clear(map: FloorMap, x: number, y: number, walkable: Walkable): boolean {
  // Sample the four corners of the entity's bounding box.
  return (
    walkable(map, x - RADIUS, y - RADIUS) &&
    walkable(map, x + RADIUS, y - RADIUS) &&
    walkable(map, x - RADIUS, y + RADIUS) &&
    walkable(map, x + RADIUS, y + RADIUS)
  );
}

/**
 * Move `pos` by `dir * dist`, resolving axis-independently so entities slide
 * along walls instead of sticking. Mutates `pos`. `dir` should be a unit vector.
 */
export function moveWithCollision(
  map: FloorMap,
  pos: Vec2,
  dir: Vec2,
  distance: number,
  walkable: Walkable,
): void {
  const dx = dir.x * distance;
  const dy = dir.y * distance;

  const nx = pos.x + dx;
  if (clear(map, nx, pos.y, walkable)) pos.x = nx;

  const ny = pos.y + dy;
  if (clear(map, pos.x, ny, walkable)) pos.y = ny;
}
