import { floorBand } from "../sim/config";

// Visual identity per 4-floor band (the sim's FLOOR_BANDS announces the names;
// this table decides what each district LOOKS like). Every key must exist in
// MODEL_MANIFEST (assets.ts); missing models fall back to procedural stand-ins.
//
// Within a band, individual floors still get character: the renderer jitters
// the floor-mix ratio, prop density/selection, tint, and torch intensity from
// a per-floor seed — floor 6 and floor 7 are recognizably the same district
// but not the same room.

export interface FloorTheme {
  name: string;
  floorKey: string; // primary ground tile
  floorAltKey: string; // mixed in per-tile for texture
  altRatio: number; // base fraction of alt tiles (jittered per floor)
  wallKey: string;
  stairsKey: string;
  props: string[]; // scatter set (manifest keys)
  propDensity: number; // base chance per eligible walkable tile
  floorTint: number; // multiplies the tile material when explored
  wallTint: number;
  torchColor: number;
  torchIntensity: number;
  background: number; // scene clear color
}

export const FLOOR_THEMES: FloorTheme[] = [
  {
    name: "THE UNDERCROFT", // floors 1-4: clean warm stone
    floorKey: "floor", floorAltKey: "floor_tile_small_decorated", altRatio: 0.14,
    wallKey: "wall", stairsKey: "stairs",
    props: ["barrel_small", "box_small", "crates_stacked", "keg", "trunk_small_A"],
    propDensity: 0.018,
    floorTint: 0xffffff, wallTint: 0xffffff,
    torchColor: 0xff9a3c, torchIntensity: 2.2,
    background: 0x0a0a12,
  },
  {
    name: "THE SEWERS", // floors 5-8: dirt, weeds, green rot
    floorKey: "floor_dirt_small_A", floorAltKey: "floor_dirt_small_weeds", altRatio: 0.3,
    wallKey: "wall_cracked", stairsKey: "stairs_narrow",
    props: ["barrel_large", "bottle_A_green", "rubble_half", "trunk_small_A"],
    propDensity: 0.022,
    floorTint: 0xb9d8a8, wallTint: 0xa8c8a0,
    torchColor: 0x6fd166, torchIntensity: 2.0,
    background: 0x081008,
  },
  {
    name: "THE RUINS", // floors 9-12: broken tile, rubble, ember light
    floorKey: "floor_tile_small_broken_A", floorAltKey: "floor_tile_small_broken_B", altRatio: 0.45,
    wallKey: "wall_broken", stairsKey: "stairs_walled",
    props: ["rubble_large", "rubble_half", "column", "sword_shield_broken"],
    propDensity: 0.028,
    floorTint: 0xe0b898, wallTint: 0xd0a888,
    torchColor: 0xff6a28, torchIntensity: 2.4,
    background: 0x120a06,
  },
  {
    name: "THE IRONWORKS", // floors 13-16: grates, scaffolds, cold steel
    floorKey: "floor_tile_grate", floorAltKey: "floor", altRatio: 0.4,
    wallKey: "wall_scaffold", stairsKey: "stairs_wide",
    props: ["keg", "box_large", "shelf_small", "table_medium_broken"],
    propDensity: 0.02,
    floorTint: 0xa8bcd8, wallTint: 0x98accc,
    torchColor: 0x5aa0ff, torchIntensity: 2.2,
    background: 0x060a14,
  },
  {
    name: "THE APPROACH", // floors 17-18: arched grandeur, banners, blood light
    floorKey: "floor_tile_large", floorAltKey: "floor_tile_big_spikes", altRatio: 0.1,
    wallKey: "wall_arched", stairsKey: "stairs_wood_decorated",
    props: ["banner_red", "banner_shield_red", "sword_shield_broken", "pillar_decorated", "chest_gold"],
    propDensity: 0.024,
    floorTint: 0xe8d0d0, wallTint: 0xd8b8b8,
    torchColor: 0xff4438, torchIntensity: 2.6,
    background: 0x140608,
  },
];

export function themeForFloor(floor: number): FloorTheme {
  return FLOOR_THEMES[floorBand(floor)];
}

/** Tiny local PRNG for cosmetic per-floor variation (never touches the sim RNG). */
export function cosmeticRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable per-tile hash for floor-mix decisions (same tile → same variant). */
export function tileHash(x: number, y: number, floor: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(floor, 83492791)) >>> 0) % 1000;
}
