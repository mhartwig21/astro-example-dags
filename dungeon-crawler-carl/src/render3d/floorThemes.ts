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

/**
 * Open-air treatment (BIOMES.md "Open-air districts"): the band renders as
 * terrain instead of masonry. The sim's Wall/Floor grid is untouched — wall
 * tiles simply LOOK like cliff edges or tree masses, so what reads as
 * impassable is exactly what is impassable.
 */
export interface OpenAirSpec {
  cliffSides: string[]; // thin cliff facades for wall faces that border floor
  // TALL blocking pieces for wall tiles rendered as woods. Every woods tile
  // plants one of these near its center so blocked ground always reads
  // blocked — low pieces (rocks, bushes) belong in accentKeys, never here.
  clusterKeys: string[];
  accentKeys?: string[]; // low texture pieces mixed into woods tiles as extras
  clusterRatio: number; // fraction of edge wall tiles that go woods, 0..1
  clusterScale: number; // footprint scale for cluster pieces (trees tower)
  grass: number; // ground color, primary
  grassAlt: number; // ground color, mixed in per-tile
  pathKey: string; // corridor tiles get this trodden-earth tile model
  skirtKeys: string[]; // silhouette trees ringing the world past the map edge
  hemiIntensity: number; // hemisphere light override (open sky above)
  keyIntensity: number; // key light override (late-day sun)
}

export interface FloorTheme {
  name: string;
  floorKey: string; // primary ground tile
  floorAltKey: string; // mixed in per-tile for texture
  altRatio: number; // base fraction of alt tiles (jittered per floor)
  wallKey: string;
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
  // Per-key FOOTPRINT scale (tiles) for props whose default ~0.6-tile
  // normalization lies about their nature — trees should tower, grass should
  // hug the dirt. Unlisted keys keep the default.
  propScale?: Record<string, number>;
  // Present = this band is an open-air district (see OpenAirSpec above).
  openAir?: OpenAirSpec;
}

export const FLOOR_THEMES: FloorTheme[] = [
  {
    name: "THE UNDERCROFT", // floors 1-3: clean warm stone
    // NOTE: floor_tile_small_decorated has CANDLES baked into the model —
    // that's why removing the candle PROPS didn't stop candles appearing on
    // every early floor. Cracked tiles vary the floor without the tea lights.
    floorKey: "floor", floorAltKey: "floor_tile_small_broken_A", altRatio: 0.14,
    wallKey: "wall",
    props: ["barrel_small", "box_small", "crates_stacked", "keg", "trunk_small_A"],
    propDensity: 0.018,
    floorTint: 0xffffff, wallTint: 0xffffff,
    torchColor: 0xff9a3c, torchIntensity: 2.2,
    background: 0x0a0a12,
    landmark: { // an abandoned library
      pillarKey: "bookcase_single", pillarScale: 1.0,
      centerpieceKey: "bookcase_double_decorateda", centerpieceScale: 1.4,
      props: ["shelf_small_books", "shelf_small", "book_single"],
    },
    entranceProps: ["bartop_a_medium", "keg_decorated", "stool_round", "plate_stack"],
    doorFlankKey: "banner_red",
  },
  {
    name: "THE SEWERS", // floors 4-6: dirt, weeds, green rot
    floorKey: "floor_dirt_small_A", floorAltKey: "floor_dirt_small_weeds", altRatio: 0.3,
    wallKey: "wall_cracked",
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
    doorFlankKey: "banner_green",
  },
  {
    name: "THE GARDEN", // floors 7-9: the forest the System grew over the stone
    // (KayKit Forest Nature Pack: live trees/bushes/rocks/grass; the crypt and
    // a few graves persist as the landmark's memory of what got buried here.)
    floorKey: "floor_dirt", floorAltKey: "floor_dirt_grave", altRatio: 0.07,
    wallKey: "wall_broken",
    props: [
      "forest_tree_1_a", "forest_tree_1_b", "forest_tree_2_a",
      "forest_tree_5_a", "forest_bush_1_a", "forest_bush_2_a", "forest_bush_4_a",
      "forest_rock_1_a", "forest_rock_3_c", "forest_rock_6_a",
      "forest_grass_1_a", "forest_grass_2_a", "forest_grass_1_a", "forest_grass_2_a",
    ],
    propDensity: 0.07, // the one band that should feel THICK with scatter
    floorTint: 0xb8d8a0, wallTint: 0x9cc09c,
    torchColor: 0xffd27f, torchIntensity: 1.6, // soft lantern glow (flat grass turns hot pools neon)
    background: 0x14211f, // dusk sky over the treeline, not dungeon murk
    landmark: { // the crypt in the overgrowth, dead trees keeping watch
      pillarKey: "tree_dead_medium", pillarScale: 1.1,
      centerpieceKey: "crypt", centerpieceScale: 1.6,
      props: ["gravestone", "gravemarker_A", "grave_A", "forest_tree_bare_1_a"],
    },
    entranceProps: ["bench", "lantern_standing", "forest_bush_1_a"],
    doorFlankKey: "lantern_standing",
    propScale: {
      forest_tree_1_a: 1.6, forest_tree_1_b: 1.7, forest_tree_2_a: 1.5,
      forest_tree_3_a: 1.1, forest_tree_5_a: 1.6, forest_tree_bare_1_a: 1.4,
      forest_bush_1_a: 0.9, forest_bush_2_a: 0.85, forest_bush_4_a: 1.0,
      forest_rock_1_a: 0.8, forest_rock_3_c: 1.2, forest_rock_6_a: 0.9,
      forest_grass_1_a: 0.55, forest_grass_2_a: 0.55,
    },
    // The Garden is TRANSPORTED, not dungeon-dressed: cliffsides and tree
    // masses are the walls, corridors are trodden earth between grass.
    openAir: {
      cliffSides: ["cliff_side_b", "cliff_side_d", "cliff_side_f", "cliff_side_h"],
      clusterKeys: [
        "forest_tree_1_a", "forest_tree_1_b", "forest_tree_2_a",
        "forest_tree_3_a", "forest_tree_4_a", "forest_tree_5_a",
      ],
      accentKeys: ["forest_rock_5_a", "forest_rock_5_c", "forest_bush_1_a"],
      clusterRatio: 0.45,
      clusterScale: 1.5,
      grass: 0x5d7a44, grassAlt: 0x516c3b,
      pathKey: "floor_dirt",
      skirtKeys: ["forest_tree_1_a", "forest_tree_2_a", "forest_tree_5_a"],
      hemiIntensity: 0.85,
      keyIntensity: 1.2,
    },
  },
  {
    name: "THE RUINS", // floors 10-12: broken tile, rubble, ember light
    floorKey: "floor_tile_small_broken_A", floorAltKey: "floor_tile_small_broken_B", altRatio: 0.45,
    wallKey: "wall_broken",
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
    doorFlankKey: "banner_brown",
  },
  {
    name: "THE IRONWORKS", // floors 13-15: grates, scaffolds, cold steel
    floorKey: "floor_tile_grate", floorAltKey: "floor", altRatio: 0.4,
    wallKey: "wall_scaffold",
    props: ["keg", "box_large", "shelf_small", "table_medium_broken"],
    propDensity: 0.02,
    floorTint: 0xa8bcd8, wallTint: 0x98accc,
    torchColor: 0x5aa0ff, torchIntensity: 2.2,
    background: 0x060a14,
    landmark: { // an abandoned workshop
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "table_round_medium", centerpieceScale: 1.1,
      props: ["shelf_small", "box_large", "keg", "stool_round"],
    },
    entranceProps: ["keg", "box_large", "stool_round"],
    doorFlankKey: "banner_blue",
  },
  {
    name: "THE APPROACH", // floors 16-18: arched grandeur, banners, blood light
    floorKey: "floor_tile_large", floorAltKey: "floor_tile_big_spikes", altRatio: 0.1,
    wallKey: "wall_arched",
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
