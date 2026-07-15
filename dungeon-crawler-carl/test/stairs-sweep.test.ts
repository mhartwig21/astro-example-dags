import { describe, expect, it } from "vitest";
import { generateFloor } from "../src/sim/floor";
import { createRng } from "../src/sim/rng";
import { Tile } from "../src/sim/types";
import { CONFIG } from "../src/sim/config";

// "Going down staircases isn't working" (2D play report) — the invariant that
// must hold on EVERY generated floor: the stairs tile exists where map.stairs
// points, and it is reachable on foot from the spawn. Locked doors count as
// walkable here (the key always spawns; they open eventually).
function reachable(map: ReturnType<typeof generateFloor>): boolean {
  const { w, h, tiles, spawn, stairs } = map;
  const pass = (t: number): boolean =>
    t === Tile.Floor || t === Tile.StairsDown || t === Tile.DoorLocked;
  const start = Math.floor(spawn.y) * w + Math.floor(spawn.x);
  const goal = Math.floor(stairs.y) * w + Math.floor(stairs.x);
  const seen = new Uint8Array(w * h);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    if (i === goal) return true;
    const x = i % w;
    for (const n of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
      if (n < 0 || n >= w * h || seen[n] || !pass(tiles[n])) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return false;
}

describe("stairs invariant sweep", () => {
  it("every floor's stairs tile exists and is reachable from spawn (race)", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (let floor = 1; floor <= CONFIG.finalFloor; floor++) {
        const map = generateFloor(createRng((seed * 2654435761) >>> 0), floor);
        const sx = Math.floor(map.stairs.x);
        const sy = Math.floor(map.stairs.y);
        if (map.tiles[sy * map.w + sx] !== Tile.StairsDown) {
          bad.push(`seed ${seed} floor ${floor}: no StairsDown tile at map.stairs`);
        } else if (!reachable(map)) {
          bad.push(`seed ${seed} floor ${floor}: stairs unreachable from spawn`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("roam floors keep the invariant too (incl. past floor 18)", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 15; seed++) {
      for (const floor of [1, 5, 12, 18, 19, 25, 40]) {
        const map = generateFloor(createRng((seed * 40503) >>> 0), floor, "roam");
        const sx = Math.floor(map.stairs.x);
        const sy = Math.floor(map.stairs.y);
        if (map.tiles[sy * map.w + sx] !== Tile.StairsDown) {
          bad.push(`roam seed ${seed} floor ${floor}: no StairsDown tile at map.stairs`);
        } else if (!reachable(map)) {
          bad.push(`roam seed ${seed} floor ${floor}: stairs unreachable from spawn`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
