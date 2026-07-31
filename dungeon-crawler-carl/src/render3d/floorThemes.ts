import { floorBand } from "../sim/config";
import type { BandMood } from "./theme";

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
  floorAlt2Key?: string; // optional THIRD tile variant, noise-blended
  alt2Ratio?: number; // base fraction of alt2 tiles
  wallKey: string;
  props: string[]; // scatter set (manifest keys)
  propDensity: number; // base chance per eligible walkable tile
  // Debris CLUMPS (D2R-style set dressing): each room gets a few clustered
  // piles of themed junk — bones, rubble, mushrooms — with rotation/scale
  // jitter, instead of an even sprinkle of lone props. keys are correlated
  // per clump (a bone pile is bones, not one of everything).
  scatter?: { keys: string[]; clumpsPerRoom: [number, number]; perClump: [number, number] };
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
  // Cinematic rig + grade for the band (theme.ts BandMood). Applied on floor
  // build: lights, environment gradient, split-tone grade, vignette, void.
  mood: BandMood;
}

export const FLOOR_THEMES: FloorTheme[] = [
  {
    name: "THE UNDERCROFT", // floors 1-3: clean warm stone
    // NOTE: floor_tile_small_decorated has CANDLES baked into the model —
    // that's why removing the candle PROPS didn't stop candles appearing on
    // every early floor. Cracked tiles vary the floor without the tea lights.
    floorKey: "floor", floorAltKey: "floor_tile_small_broken_A", altRatio: 0.14,
    floorAlt2Key: "floor_tile_small_broken_B", alt2Ratio: 0.08,
    wallKey: "wall",
    props: ["barrel_small", "box_small", "crates_stacked", "keg", "trunk_small_A"],
    propDensity: 0.03,
    scatter: {
      keys: ["skull", "bone_A", "rubble_half", "book_single", "mug_a", "plate_stack", "bottle_b_brown"],
      clumpsPerRoom: [3, 4], perClump: [3, 5],
    },
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
    mood: { // warm stone over deep blue-purple darks: the classic dungeon key
      ambient: 0x2e2a52, ambientIntensity: 0.62,
      hemiSky: 0x4a4a7e, hemiGround: 0x2a1c10, hemiIntensity: 0.45,
      key: 0xffe8c4, keyIntensity: 1.75,
      rim: 0x6a8cff, rimIntensity: 0.6,
      envHorizon: 0xffb060, envIntensity: 0.35,
      gradeShadow: 0x16132b, gradeHighlight: 0xfff2dc, gradeSaturation: 1.06,
      vignette: 0.34,
      voidInner: 0x121022, voidOuter: 0x05050b,
      fogDark: 0x0b0a18,
    },
  },
  {
    name: "THE SEWERS", // floors 4-6: dirt, weeds, green rot
    floorKey: "floor_dirt_small_A", floorAltKey: "floor_dirt_small_weeds", altRatio: 0.3,
    floorAlt2Key: "floor_dirt_small", alt2Ratio: 0.14,
    wallKey: "wall_cracked",
    props: ["barrel_large", "bottle_A_green", "rubble_half", "trunk_small_A"],
    propDensity: 0.035,
    // Warm-accented growth CLUMPS (red-capped mushrooms) against a cool
    // grey-green floor — hue contrast carves the space instead of one green
    // wash (art-director note: clumped growth, not confetti specks).
    scatter: {
      keys: ["mushroom", "basket_mushrooms", "bottle_A_green", "rubble_half", "bone_A"],
      clumpsPerRoom: [4, 6], perClump: [3, 5],
    },
    // TWO-TONE (the green-on-green fix): ground and ambient pulled to a cool
    // desaturated slate-green, light pools pushed warm bile-amber — the key
    // keeps the band's hue, the shadows go complementary cool, and the light
    // separates from the ground instead of matching it.
    floorTint: 0x8fa4ad, wallTint: 0x8a9aa0,
    torchColor: 0xd8c05a, torchIntensity: 2.3,
    background: 0x070d0c,
    landmark: { // a collapsed cistern
      pillarKey: "column", pillarScale: 0.9,
      centerpieceKey: "rubble_large", centerpieceScale: 1.0,
      props: ["barrel_large", "bottle_A_green", "rubble_half"],
    },
    entranceProps: ["barrel_large", "trunk_small_A"],
    doorFlankKey: "banner_green",
    mood: { // green rot, two-tone: bile-amber light, cool slate shadows
      ambient: 0x223240, ambientIntensity: 0.62,
      hemiSky: 0x46586a, hemiGround: 0x0e1414, hemiIntensity: 0.5,
      key: 0xd8ecc4, keyIntensity: 1.6,
      rim: 0x4f9ec8, rimIntensity: 0.6,
      envHorizon: 0x86b060, envIntensity: 0.3,
      gradeShadow: 0x0c161e, gradeHighlight: 0xf0f4d8, gradeSaturation: 1.0,
      vignette: 0.38,
      voidInner: 0x0b1116, voidOuter: 0x030507,
      fogDark: 0x0a1014,
    },
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
      hemiIntensity: 0.58,
      keyIntensity: 2.3, // stronger low sun -> readable cast shadows under the canopy
    },
    mood: { // dusk over the treeline: amber sun low, blue hour creeping in
      ambient: 0x3a3c5e, ambientIntensity: 0.65,
      hemiSky: 0x8088b8, hemiGround: 0x2a3018, hemiIntensity: 0.7,
      key: 0xffd9a8, keyIntensity: 2.0,
      rim: 0x8fb0ff, rimIntensity: 0.6,
      envHorizon: 0xffac78, envIntensity: 0.45,
      gradeShadow: 0x1a1c30, gradeHighlight: 0xffe8c8, gradeSaturation: 1.1,
      vignette: 0.26,
      voidInner: 0x141f1c, voidOuter: 0x060a09,
      fogDark: 0x16211a, // woods under dusk, not black broccoli
    },
  },
  {
    name: "THE RUINS", // floors 10-12: broken tile, rubble, ember light
    floorKey: "floor_tile_small_broken_A", floorAltKey: "floor_tile_small_broken_B", altRatio: 0.45,
    floorAlt2Key: "floor", alt2Ratio: 0.12,
    wallKey: "wall_broken",
    props: ["rubble_large", "rubble_half", "column", "sword_shield_broken"],
    propDensity: 0.042,
    scatter: {
      keys: ["bone_A", "skull", "ribcage", "rubble_half", "rubble_large", "sword_shield_broken"],
      clumpsPerRoom: [4, 6], perClump: [3, 5],
    },
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
    mood: { // ember light through smoke: warm ruin, umber darks
      ambient: 0x372220, ambientIntensity: 0.6,
      hemiSky: 0x5c4034, hemiGround: 0x180c06, hemiIntensity: 0.4,
      key: 0xffd0a0, keyIntensity: 1.7,
      rim: 0x4a6a9a, rimIntensity: 0.55,
      envHorizon: 0xff7830, envIntensity: 0.4,
      gradeShadow: 0x1e100c, gradeHighlight: 0xffdfc2, gradeSaturation: 1.08,
      vignette: 0.4,
      voidInner: 0x180d08, voidOuter: 0x060302,
      fogDark: 0x120a06,
    },
  },
  {
    name: "THE IRONWORKS", // floors 13-15: grates, scaffolds, cold steel
    floorKey: "floor_tile_grate", floorAltKey: "floor", altRatio: 0.4,
    floorAlt2Key: "floor_tile_large", alt2Ratio: 0.16, // blank plate variant breaks the grate wallpaper
    wallKey: "wall_scaffold",
    // Metal-forward destructibles: fuel drums, crates, anvils — the wooden
    // tavern kegs stay upstairs (theme-variant props per biome).
    props: ["fuel_a_barrels", "box_large", "anvil", "table_medium_broken"],
    propDensity: 0.034,
    scatter: {
      keys: ["fuel_a_barrels", "box_small", "gems_sack", "anvil", "mug_b"],
      clumpsPerRoom: [3, 5], perClump: [2, 4],
    },
    floorTint: 0xa8bcd8, wallTint: 0x98accc,
    torchColor: 0x7ab4ff, torchIntensity: 2.2,
    background: 0x060a14,
    landmark: { // an abandoned workshop
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "table_round_medium", centerpieceScale: 1.1,
      props: ["shelf_small", "box_large", "keg", "stool_round"],
    },
    entranceProps: ["fuel_a_barrels", "box_large", "stool_round"],
    doorFlankKey: "banner_blue",
    mood: { // cold steel: cyan work-light, blue-black shadows
      ambient: 0x20304a, ambientIntensity: 0.62,
      hemiSky: 0x4a6490, hemiGround: 0x0e1218, hemiIntensity: 0.45,
      key: 0xdce8ff, keyIntensity: 1.75,
      rim: 0x50c8ff, rimIntensity: 0.7,
      envHorizon: 0x5090e0, envIntensity: 0.4,
      gradeShadow: 0x0e1626, gradeHighlight: 0xdcecff, gradeSaturation: 1.04,
      vignette: 0.38,
      voidInner: 0x0b1220, voidOuter: 0x030408,
      fogDark: 0x070d18,
    },
  },
  {
    name: "THE APPROACH", // floors 16-18: arched grandeur, banners, blood light
    floorKey: "floor_tile_large", floorAltKey: "floor_tile_big_spikes", altRatio: 0.1,
    floorAlt2Key: "floor_tile_small_broken_A", alt2Ratio: 0.1,
    wallKey: "wall_arched",
    props: ["banner_red", "banner_shield_red", "sword_shield_broken", "pillar_decorated", "chest_gold"],
    propDensity: 0.036,
    scatter: {
      keys: ["skull", "bone_A", "coin_stack_small", "sword_shield_broken", "rubble_half", "ribcage"],
      clumpsPerRoom: [3, 5], perClump: [3, 5],
    },
    // HAZARD-RED RESERVATION (D2R/LoL rule): the band's light is EMBER-amber
    // over cool violet darks — saturated red belongs to attack telegraphs
    // alone, so danger reads instantly even on the blood floors.
    floorTint: 0xded2d8, wallTint: 0xc8b4bc,
    torchColor: 0xff8a48, torchIntensity: 2.4,
    background: 0x100714,
    landmark: { // a monument to the fallen, right before the end
      pillarKey: "pillar_decorated", pillarScale: 0.9,
      centerpieceKey: "sword_shield_broken", centerpieceScale: 0.9,
      props: ["banner_shield_red", "coin_stack_medium"],
    },
    entranceProps: ["banner_shield_red", "trunk_small_A"],
    doorFlankKey: "banner_red",
    mood: { // ember grandeur: pale marble under amber light, cool violet darks
      ambient: 0x2a2144, ambientIntensity: 0.6,
      hemiSky: 0x564a78, hemiGround: 0x140a12, hemiIntensity: 0.45,
      key: 0xffd8c0, keyIntensity: 1.8,
      rim: 0x8a5aff, rimIntensity: 0.7,
      envHorizon: 0xff8050, envIntensity: 0.4,
      gradeShadow: 0x170f26, gradeHighlight: 0xffe0d0, gradeSaturation: 1.06,
      vignette: 0.42,
      voidInner: 0x150c1e, voidOuter: 0x050206,
      fogDark: 0x100a1a,
    },
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
