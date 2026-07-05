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
 *
 * The move is SWEPT: distances beyond the entity radius advance in sub-radius
 * increments, so a single large move (phantom blink, cataclysm knockback) can
 * never tunnel through a thin wall — or through the locked stairs district's
 * one-tile door ring, which once let a blinking KEY CARRIER seal itself in
 * with the very stairs its key opens. Per-frame chase moves are well under one
 * increment, so the normal path is exactly one iteration.
 */
export function moveWithCollision(
  map: FloorMap,
  pos: Vec2,
  dir: Vec2,
  distance: number,
  walkable: Walkable,
): void {
  const steps = Math.max(1, Math.ceil(distance / RADIUS));
  const dx = (dir.x * distance) / steps;
  const dy = (dir.y * distance) / steps;

  for (let s = 0; s < steps; s++) {
    let advanced = false;

    const nx = pos.x + dx;
    if (dx !== 0 && clear(map, nx, pos.y, walkable)) { pos.x = nx; advanced = true; }

    const ny = pos.y + dy;
    if (dy !== 0 && clear(map, pos.x, ny, walkable)) { pos.y = ny; advanced = true; }

    if (!advanced) return; // wedged — no further increment can succeed either
  }
}
