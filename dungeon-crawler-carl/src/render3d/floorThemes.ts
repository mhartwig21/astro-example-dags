import { floorBand } from "../sim/config";

// Visual identity per 3-floor band (the sim's FLOOR_BANDS announces the names;
// this table decides what each district LOOKS like). Every key must exist in
// MODEL_MANIFEST (assets.ts); missing models fall back to procedural stand-ins.
//
// Two orthogonal layers dress a floor (see BIOMES.md):
//   - the BAND decides material and palette (this table's tile/tint fields),
//   - the room's ROLE decides furniture (the landmark/entrance/vault fields) —
//     a vault reads as a treasure chamber in every district, but the landmark
//     hall is a library in the Undercroft and a crypt garden in the Garden.
//
// Within a band, individual floors still get character: the renderer jitters
// the floor-mix ratio, prop density/selection, tint, and torch intensity from
// a per-floor seed — floor 7 and floor 8 are recognizably the same district
// but not the same room.

export interface LandmarkDressing {
  pillarKey: string; // colonnade along the hall's interior edge grid
  pillarScale: number;
  centerpieceKey: string; // set-piece at the room's center
  centerpieceScale: number;
  props: string[]; // corner clutter pool for this room (overrides band props)
}

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
  landmark: LandmarkDressing;
  entranceProps: string[]; // soft "camp" clutter for the spawn room's corners
  doorFlankKey: string; // prop flanking locked doors (a gate should look like a gate)
}

export const FLOOR_THEMES: FloorTheme[] = [
  {
    name: "THE UNDERCROFT", // floors 1-3: clean warm stone
    // NOTE: floor_tile_small_decorated has CANDLES baked into the model —
    // that's why removing the candle PROPS didn't stop candles appearing on
    // every early floor. Cracked tiles vary the floor without the tea lights.
    floorKey: "floor", floorAltKey: "floor_tile_small_broken_A", altRatio: 0.14,
    wallKey: "wall", stairsKey: "stairs",
    props: ["barrel_small", "box_small", "crates_stacked", "keg", "trunk_small_A"],
    propDensity: 0.018,
    floorTint: 0xffffff, wallTint: 0xffffff,
    torchColor: 0xff9a3c, torchIntensity: 2.2,
    background: 0x0a0a12,
    landmark: { // an abandoned library/storeroom
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "table_medium_broken", centerpieceScale: 0.9,
      props: ["shelf_small", "shelf_small", "box_small"],
    },
    entranceProps: ["barrel_small", "keg", "box_small"],
    doorFlankKey: "banner_red",
  },
  {
    name: "THE SEWERS", // floors 4-6: dirt, weeds, green rot
    floorKey: "floor_dirt_small_A", floorAltKey: "floor_dirt_small_weeds", altRatio: 0.3,
    wallKey: "wall_cracked", stairsKey: "stairs_narrow",
    props: ["barrel_large", "bottle_A_green", "rubble_half", "trunk_small_A"],
    propDensity: 0.022,
    floorTint: 0xb9d8a8, wallTint: 0xa8c8a0,
    torchColor: 0x6fd166, torchIntensity: 2.0,
    background: 0x081008,
    landmark: { // a collapsed cistern
      pillarKey: "column", pillarScale: 0.9,
      centerpieceKey: "rubble_large", centerpieceScale: 1.0,
      props: ["barrel_large", "bottle_A_green", "rubble_half"],
    },
    entranceProps: ["barrel_large", "trunk_small_A"],
    doorFlankKey: "banner_red",
  },
  {
    name: "THE GARDEN", // floors 7-9: the System's dead orchard reclaiming the stone
    floorKey: "floor_dirt", floorAltKey: "floor_dirt_grave", altRatio: 0.16,
    wallKey: "wall_broken", stairsKey: "stairs_walled",
    props: [
      "tree_dead_small", "tree_dead_medium", "gravestone", "gravemarker_A",
      "grave_B", "pumpkin_orange_small", "ribcage", "bone_A",
    ],
    propDensity: 0.026,
    floorTint: 0xc4d8a4, wallTint: 0x9cc09c,
    torchColor: 0xffd27f, torchIntensity: 2.1, // lantern glow against violet dusk
    background: 0x0d0814,
    landmark: { // the crypt at the heart of the orchard
      pillarKey: "tree_dead_medium", pillarScale: 1.1,
      centerpieceKey: "crypt", centerpieceScale: 1.6,
      props: ["gravestone", "gravemarker_A", "grave_A"],
    },
    entranceProps: ["bench", "lantern_standing", "pumpkin_orange_small"],
    doorFlankKey: "lantern_standing",
  },
  {
    name: "THE RUINS", // floors 10-12: broken tile, rubble, ember light
    floorKey: "floor_tile_small_broken_A", floorAltKey: "floor_tile_small_broken_B", altRatio: 0.45,
    wallKey: "wall_broken", stairsKey: "stairs_walled",
    props: ["rubble_large", "rubble_half", "column", "sword_shield_broken"],
    propDensity: 0.028,
    floorTint: 0xe0b898, wallTint: 0xd0a888,
    torchColor: 0xff6a28, torchIntensity: 2.4,
    background: 0x120a06,
    landmark: { // a war shrine to whoever lost here
      pillarKey: "column", pillarScale: 0.9,
      centerpieceKey: "sword_shield_broken", centerpieceScale: 0.9,
      props: ["rubble_half", "sword_shield_broken"],
    },
    entranceProps: ["trunk_small_A", "rubble_half"],
    doorFlankKey: "banner_red",
  },
  {
    name: "THE IRONWORKS", // floors 13-15: grates, scaffolds, cold steel
    floorKey: "floor_tile_grate", floorAltKey: "floor", altRatio: 0.4,
    wallKey: "wall_scaffold", stairsKey: "stairs_wide",
    props: ["keg", "box_large", "shelf_small", "table_medium_broken"],
    propDensity: 0.02,
    floorTint: 0xa8bcd8, wallTint: 0x98accc,
    torchColor: 0x5aa0ff, torchIntensity: 2.2,
    background: 0x060a14,
    landmark: { // an abandoned workshop
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "table_medium_broken", centerpieceScale: 1.0,
      props: ["shelf_small", "box_large", "keg"],
    },
    entranceProps: ["keg", "box_large"],
    doorFlankKey: "banner_red",
  },
  {
    name: "THE APPROACH", // floors 16-18: arched grandeur, banners, blood light
    floorKey: "floor_tile_large", floorAltKey: "floor_tile_big_spikes", altRatio: 0.1,
    wallKey: "wall_arched", stairsKey: "stairs_wood_decorated",
    props: ["banner_red", "banner_shield_red", "sword_shield_broken", "pillar_decorated", "chest_gold"],
    propDensity: 0.024,
    floorTint: 0xe8d0d0, wallTint: 0xd8b8b8,
    torchColor: 0xff4438, torchIntensity: 2.6,
    background: 0x140608,
    landmark: { // a monument to the fallen, right before the end
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "sword_shield_broken", centerpieceScale: 0.9,
      props: ["banner_shield_red", "coin_stack_medium"],
    },
    entranceProps: ["banner_shield_red", "trunk_small_A"],
    doorFlankKey: "banner_red",
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
