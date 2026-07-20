// The vignette dressing grammar — HOW a RoomDressing becomes furniture.
//
// assignRoomPurposes (sim) decides WHICH room is the mess hall; this module
// owns the placement rules that make it read as one: wall runs shoulder to
// shoulder, mounted decor, the furnished table at the social anchor, the
// corner hoard, condition damage, and the corridor spill outside the door.
// It is shared between renderer3d (the real game floor) and the builder's
// dressing-preview tab, so the preview IS the game's dressing — same code,
// same rolls — not a lookalike.
//
// The host supplies a small env (tile queries, a place() that instantiates
// props, the rng, light-anchor hooks); this module never touches the scene
// graph beyond what place() returns.

import * as THREE from "three";
import type { RoomDressing, RoomPurpose } from "../sim/roomPurposes";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DressEnv {
  frng: () => number;
  isFloor: (x: number, y: number) => boolean;
  isWall: (x: number, y: number) => boolean;
  /** Placement clearance (spawn/stairs/door margins in the game; floor-only in the builder). */
  clear: (x: number, y: number) => boolean;
  /** Instantiate + ground-snap a prop; null when capped/blocked/unknown. Returns the object so the table's top can be measured. */
  place: (
    key: string,
    x: number,
    y: number,
    opts?: { scale?: number; rot?: number; jitter?: number; elevate?: number },
  ) => THREE.Object3D | null;
  /** Is there budget for another light anchor? */
  canTorch: () => boolean;
  /** Register a light anchor riding a just-placed torch mesh. */
  addTorch: (x: number, y: number) => void;
}

/** Every floor face of a room that borders a wall, with its inward normal. */
function wallFaces(env: DressEnv, r: Rect): { x: number; y: number; nx: number; ny: number }[] {
  const faces: { x: number; y: number; nx: number; ny: number }[] = [];
  const check = (x: number, y: number) => {
    if (!env.isFloor(x, y)) return;
    const dir = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      .find(([dx, dy]) => env.isWall(x + dx, y + dy));
    if (dir && env.clear(x, y)) faces.push({ x, y, nx: -dir[0], ny: -dir[1] });
  };
  for (let x = r.x; x < r.x + r.w; x++) { check(x + 0.5, r.y + 0.5); check(x + 0.5, r.y + r.h - 0.5); }
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) { check(r.x + 0.5, y + 0.5); check(r.x + r.w - 0.5, y + 0.5); }
  return faces;
}

/**
 * Dress one room from its RESOLVED dressing (variant already merged,
 * condition and social anchor decided — see assignRoomPurposes). The sim
 * seats the resident pack at the same anchor this pass furnishes.
 */
export function dressRoomPurpose(
  env: DressEnv,
  r: Rect,
  d: Pick<RoomDressing, "purpose" | "condition" | "anchor" | "breakables" | "blockers">,
): void {
  const { frng, place } = env;
  const p: RoomPurpose = d.purpose;
  const cond = d.condition;
  const faces = wallFaces(env, r);
  if (faces.length < 3) return;
  // The iso camera sees the INNER face of north walls (normal +y) and
  // west walls (normal +x); furniture against the other two is occluded
  // by the wall mass. Dress the visible walls — KayKit's own sample
  // renders play the same trick (they only ever build N/W walls).
  const visible = (f: { nx: number; ny: number }) => f.nx > 0 || f.ny > 0;
  // WALL RUN: consecutive faces along the longest same-normal VISIBLE
  // wall, furniture shoulder to shoulder, backs to the masonry.
  // A looted room's run is THINNED — they carried half of it away.
  const byNormal = new Map<string, typeof faces>();
  for (const f of faces) {
    const k = `${f.nx},${f.ny}`;
    byNormal.set(k, [...(byNormal.get(k) ?? []), f]);
  }
  const walls = [...byNormal.values()].sort(
    (a, b) => (visible(a[0]) ? 1000 : 0) + a.length < (visible(b[0]) ? 1000 : 0) + b.length ? 1 : -1,
  );
  const runWall = walls[0];
  let runLen = Math.min(runWall.length, 3 + Math.floor(frng() * 3));
  if (cond === "looted") runLen = Math.max(1, runLen - 2);
  const runStart = Math.floor(frng() * Math.max(1, runWall.length - runLen));
  for (let i = 0; i < runLen; i++) {
    const f = runWall[runStart + i];
    const key = p.wallRun[Math.floor(frng() * p.wallRun.length)];
    place(key, f.x - f.nx * 0.26, f.y - f.ny * 0.26, {
      rot: Math.atan2(f.nx, f.ny) + (frng() - 0.5) * (cond === "scarred" ? 0.6 : 0.12),
      jitter: cond === "scarred" ? 0.3 : 0.08, // a battle shoved everything
      scale: 0.6 + frng() * 0.15, // chunky enough to read as furniture
    });
  }
  // WALL MOUNTS: decor hung on 2-3 spaced VISIBLE faces off the run
  // wall. A scarred room's banners were torn down with their owners.
  const mounts = cond === "scarred" ? p.wallMount.filter((k) => !k.startsWith("banner")) : p.wallMount;
  const mountable = faces.filter((f) => !runWall.includes(f) && visible(f));
  for (let m = 0; m < Math.min(3, mountable.length) && mounts.length > 0; m++) {
    const f = mountable[Math.floor(frng() * mountable.length)];
    const key = mounts[Math.floor(frng() * mounts.length)];
    if (place(key, f.x - f.nx * 0.38, f.y - f.ny * 0.38, {
      rot: Math.atan2(f.nx, f.ny), jitter: 0, scale: 0.45, elevate: 0.5,
    }) && key === "torch_mounted" && cond !== "scarred" && env.canTorch()) {
      // A mounted sconce is also a light anchor — the room glows lived-in.
      env.addTorch(f.x, f.y);
    }
  }
  // Every dressed room earns a sconce — EXCEPT scarred ones. Whatever
  // happened here, nobody came back to relight the torches.
  if (cond !== "scarred") {
    const lightFace = mountable[Math.floor(frng() * Math.max(1, mountable.length))] ?? runWall[0];
    if (lightFace && env.canTorch()) {
      const tx = lightFace.x - lightFace.nx * 0.33, ty = lightFace.y - lightFace.ny * 0.33;
      if (place("torch_lit", tx, ty, { scale: 0.55, jitter: 0.05 })) {
        env.addTorch(tx, ty);
      }
    }
  }
  // TABLE SET at the SHARED social anchor (the sim seats packs here).
  // A table that BLOCKS (PHYSICALITY.md §1) is entity-drawn by the host's
  // breakable sync — dress everything around it, skip the cosmetic twin.
  // Tabletop items are skipped too (they would float once it's smashed).
  const tableIsEntity = d.blockers.some((bl) => bl.isTable);
  if (p.tableSet && d.anchor && r.w >= 6 && r.h >= 6 && tableIsEntity) {
    const tcx = d.anchor.x, tcy = d.anchor.y;
    if (p.rug && p.rug.length > 0 && cond !== "scarred") {
      place(p.rug[Math.floor(frng() * p.rug.length)], tcx, tcy, {
        scale: 1.9, jitter: 0.05, rot: Math.floor(frng() * 2) * (Math.PI / 2),
      });
    }
    const seats = 2 + Math.floor(frng() * 3);
    for (let s = 0; s < seats; s++) {
      const a = (s / seats) * Math.PI * 2 + frng() * 0.6;
      place(p.tableSet.seat, tcx + Math.cos(a) * 0.9, tcy + Math.sin(a) * 0.9, {
        scale: 0.32, jitter: cond === "scarred" ? 0.3 : 0.06, rot: a + Math.PI,
      });
    }
  } else if (p.tableSet && d.anchor && r.w >= 6 && r.h >= 6) {
    const tcx = d.anchor.x, tcy = d.anchor.y;
    // A rug under the table sells the whole room (flat: no path lies).
    if (p.rug && p.rug.length > 0 && cond !== "scarred") {
      place(p.rug[Math.floor(frng() * p.rug.length)], tcx, tcy, {
        scale: 1.9, jitter: 0.05, rot: Math.floor(frng() * 2) * (Math.PI / 2),
      });
    }
    const tableKey = cond === "scarred" ? "table_medium_broken" : p.tableSet.table;
    const tableObj = place(tableKey, tcx, tcy, { scale: 0.85, jitter: 0.1 });
    if (tableObj) {
      const top = new THREE.Box3().setFromObject(tableObj).max.y;
      const seats = 2 + Math.floor(frng() * 3);
      for (let s = 0; s < seats; s++) {
        const a = (s / seats) * Math.PI * 2 + frng() * 0.6;
        place(p.tableSet.seat, tcx + Math.cos(a) * 0.8, tcy + Math.sin(a) * 0.8, {
          scale: 0.32, jitter: cond === "scarred" ? 0.3 : 0.06, rot: a + Math.PI, // seats face the table
        });
      }
      // Looted rooms serve a BARE table — they took the silverware too.
      if (cond !== "looted") {
        for (let it = 0, n = 1 + Math.floor(frng() * 2); it < n; it++) {
          const key = p.tableSet.tabletop[Math.floor(frng() * p.tableSet.tabletop.length)];
          place(key, tcx + (frng() - 0.5) * 0.45, tcy + (frng() - 0.5) * 0.45, {
            scale: 0.2, elevate: top + 0.01, jitter: 0,
          });
        }
      }
    }
  }
  // CENTERPIECE + SPILL at the shared anchor.
  if (p.centerpiece && d.anchor) {
    const cx = d.anchor.x, cy = d.anchor.y;
    if (place(p.centerpiece.key, cx, cy, { scale: 0.8, jitter: 0.3 })) {
      for (let s = 0, n = 2 + Math.floor(frng() * 2); s < n; s++) {
        const a = frng() * Math.PI * 2;
        const key = p.centerpiece.spill[Math.floor(frng() * p.centerpiece.spill.length)];
        place(key, cx + Math.cos(a) * (0.9 + frng() * 0.5), cy + Math.sin(a) * (0.9 + frng() * 0.5), { scale: 0.35 });
      }
    }
  }
  // CORNER STACK: a tight hoard in one corner — unless looters found it,
  // or the plan made it SMASHABLE (phase 5): then the sim's Breakable
  // entities ARE the hoard and the host renders those instead.
  if (p.cornerStack && cond !== "looted" && d.breakables.length === 0) {
    const corners = [
      { x: r.x + 1.1, y: r.y + 1.1 }, { x: r.x + r.w - 1.1, y: r.y + 1.1 },
      { x: r.x + 1.1, y: r.y + r.h - 1.1 }, { x: r.x + r.w - 1.1, y: r.y + r.h - 1.1 },
    ];
    const c = corners[Math.floor(frng() * 4)];
    for (let k = 0, n = 2 + Math.floor(frng() * 2); k < n; k++) {
      const key = p.cornerStack[Math.floor(frng() * p.cornerStack.length)];
      place(key, c.x + (frng() - 0.5) * 0.7, c.y + (frng() - 0.5) * 0.7, { scale: 0.4 });
    }
  }
  // CONDITION DEBRIS: the history layer's physical evidence.
  const evidence = cond === "looted" ? ["rubble_half", "bottle_b_brown", "box_small"]
    : cond === "scarred" ? ["rubble_large", "rubble_half", "sword_shield_broken", "skull"]
    : cond === "overgrown" ? ["mushroom", "forest_grass_1_a", "forest_bush_1_a", "mushroom"]
    : null;
  if (evidence) {
    const n = cond === "overgrown" ? 5 : 3;
    for (let e = 0; e < n; e++) {
      const key = evidence[Math.floor(frng() * evidence.length)];
      place(key, r.x + 1 + frng() * (r.w - 2), r.y + 1 + frng() * (r.h - 2), {
        scale: cond === "overgrown" ? 0.3 : 0.4, jitter: 0.3,
      });
    }
  }
}

/**
 * CORRIDOR TISSUE: the job leaks out the door — a keg rolled from the
 * storeroom, a bone dragged from the ossuary — so corridors read as
 * paths BETWEEN places rather than filler.
 */
export function spillPurposeDoorways(env: DressEnv, r: Rect, purpose: RoomPurpose): void {
  const { frng, place } = env;
  const spill = purpose.cornerStack ?? purpose.wallRun;
  if (!spill || spill.length === 0) return;
  const doorways: { x: number; y: number }[] = [];
  const tryDoor = (inx: number, iny: number, outx: number, outy: number) => {
    if (env.isFloor(inx, iny) && env.isFloor(outx, outy)) doorways.push({ x: outx, y: outy });
  };
  for (let x = r.x; x < r.x + r.w; x++) {
    tryDoor(x + 0.5, r.y + 0.5, x + 0.5, r.y - 0.5);
    tryDoor(x + 0.5, r.y + r.h - 0.5, x + 0.5, r.y + r.h + 0.5);
  }
  for (let y = r.y; y < r.y + r.h; y++) {
    tryDoor(r.x + 0.5, y + 0.5, r.x - 0.5, y + 0.5);
    tryDoor(r.x + r.w - 0.5, y + 0.5, r.x + r.w + 0.5, y + 0.5);
  }
  for (let k = 0; k < Math.min(2, doorways.length); k++) {
    const door = doorways[Math.floor(frng() * doorways.length)];
    const key = spill[Math.floor(frng() * spill.length)];
    place(key, door.x + (frng() - 0.5) * 0.8, door.y + (frng() - 0.5) * 1.2, { scale: 0.35, jitter: 0.3 });
  }
}
