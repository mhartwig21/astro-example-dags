// Room purposes — the vignette grammar as SIM-VISIBLE truth.
//
// Phase 1-2 lived render-side; phase 3 (occupancy) needs the sim to know
// which room is the mess hall so the pack can sit at dinner. The fix is this
// pure module: `assignRoomPurposes(seed, floor, map)` computes the same
// answer for everyone — the renderer dresses from it, spawnMonsters seats
// packs by it, and determinism is free because the only randomness is a
// local rng derived from (seed, floor). No GameState, no mutation, no DOM.

import { createRng, nextFloat, type Rng } from "./rng";
import { floorBand } from "./config";
import type { FloorMap, Vec2 } from "./types";

export interface RoomPurpose {
  id: string;
  wallRun: string[]; // props lined shoulder-to-shoulder along one wall
  wallMount: string[]; // decor hung ON wall faces (banners, shelves, sconces)
  cornerStack?: string[]; // a tight hoard in one corner
  tableSet?: { table: string; seat: string; tabletop: string[] }; // furnished table + seating
  centerpiece?: { key: string; spill: string[] }; // one anchor prop + debris around it
  rug?: string[]; // one goes under the table — nothing says "lived in" like a rug
  // ZONING (grammar phase 2): where on the floor this job belongs. "living"
  // clusters near the entrance, "work" holds the middle, "deep" sits closest
  // to the stairs — so a floor reads as a settlement, not a shuffle.
  zone?: "living" | "work" | "deep"; // default "work"
  // Band allowlist (FLOOR_BANDS indices, 0 = UNDERCROFT .. 5 = APPROACH).
  // Omitted = at home everywhere. A forge belongs in the IRONWORKS.
  bands?: number[];
  // VARIANTS: seeded re-dressings of the same purpose (an officer's barracks
  // vs a flophouse). Fields REPLACE the base purpose's when a variant rolls
  // (~55% of the time), so every purpose reads two or three different ways.
  variants?: (Partial<Omit<RoomPurpose, "variants">> & { id: string })[];
}

export const ROOM_PURPOSES: RoomPurpose[] = [
  {
    id: "storage", // the quartermaster's floor: kegs and crates against the walls
    zone: "work",
    wallRun: ["keg", "barrel_large", "crates_stacked", "box_large", "keg_decorated"],
    wallMount: ["shelf_small"],
    cornerStack: ["box_small", "barrel_small", "trunk_small_A"],
    variants: [
      { id: "wine_cellar", wallRun: ["keg_decorated", "barrel_small_stack", "keg", "barrel_large"], cornerStack: ["bottle_a_labeled_green", "bottle_b_brown", "bottle_A_green"], wallMount: ["shelf_small", "lantern_hanging"] },
      { id: "ransacked", wallRun: ["table_medium_broken", "rubble_half", "box_large"], cornerStack: ["rubble_half", "barrel_small"], wallMount: ["banner_brown"] },
    ],
  },
  {
    id: "mess", // somebody eats down here: a set table, a bar top, a keg on tap
    zone: "living",
    wallRun: ["bartop_a_medium", "keg_decorated", "barrel_large"],
    wallMount: ["banner_red", "shelf_small"],
    tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["plate_food_a", "plate_food_b", "bottle_A_green"] },
    variants: [
      { id: "tavern_night", rug: ["rug_oval_a"], tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["mug_a", "mug_b", "vampire_goblet", "plate_food_a"] }, wallMount: ["lantern_hanging", "banner_red"] },
      { id: "washup", wallRun: ["bartop_a_medium", "dishrack_plates", "keg"], tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["plate_stack"] } },
    ],
  },
  {
    id: "archive", // the dungeon keeps records: bookcase runs and a reading table
    zone: "work", bands: [0, 3, 5],
    wallRun: ["bookcase_single", "bookcase_double_decorateda", "bookcase_single"],
    wallMount: ["shelf_small_books"],
    cornerStack: ["book_single", "box_small"],
    tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["book_single"] },
    variants: [
      { id: "map_annex", tableSet: { table: "table_round_medium", seat: "chair", tabletop: ["map", "map_rolled", "book_single"] }, cornerStack: ["map_rolled", "box_small"], rug: ["rug_rectangle_a"] },
    ],
  },
  {
    id: "guardpost", // a watch was stationed here; the shift ended badly
    zone: "work",
    wallRun: ["bench", "box_large", "barrel_small"],
    wallMount: ["banner_shield_red", "torch_mounted"],
    cornerStack: ["barrel_small", "bottle_A_green"],
    centerpiece: { key: "table_medium_broken", spill: ["sword_shield_broken", "bottle_A_green"] },
    variants: [
      { id: "card_watch", tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["card_base", "card_hearts_king", "mug_b", "coin_silver"] }, centerpiece: undefined },
      { id: "armory_rack", wallRun: ["weaponrack", "weaponrack_decorated", "bench"], centerpiece: { key: "dummy_base", spill: ["sword_shield_broken"] } },
    ],
  },
  // Wave 2 (extracted 2026-07-09: Dungeon Remastered beds/chair/food plates,
  // Restaurant pots, Resource barrels, Block Bits anvil, Adventurers potions).
  {
    id: "barracks", // rows of cots against the wall; somebody sleeps down here
    zone: "living",
    wallRun: ["bed_a_single", "bed_b_single", "bed_floor", "bed_decorated"],
    wallMount: ["banner_blue", "shelf_small"],
    cornerStack: ["trunk_small_A", "box_small"],
    tableSet: { table: "table_round_medium", seat: "chair", tabletop: ["bottle_A_green"] },
    variants: [
      { id: "officers", wallRun: ["bed_decorated", "bookcase_single", "trunk_small_A"], rug: ["rug_rectangle_a"], tableSet: { table: "table_round_medium", seat: "chair", tabletop: ["vampire_goblet", "book_single"] } },
      { id: "flophouse", wallRun: ["bed_floor", "bed_floor", "box_small"], wallMount: ["banner_brown"], cornerStack: ["bottle_b_brown", "bottle_A_green", "barrel_small"], tableSet: undefined },
    ],
  },
  {
    id: "kitchen", // the mess gets fed from somewhere: stew pots and stock
    zone: "living",
    wallRun: ["food_barrel_fish", "crate_potatoes", "barrel_small_stack", "crate_large_decorated"],
    wallMount: ["shelf_small", "banner_brown"],
    cornerStack: ["pot_large", "barrel_small"],
    centerpiece: { key: "pot_a_stew", spill: ["plate_food_a", "plate_food_b", "bottle_A_green"] },
    variants: [
      { id: "mushroom_prep", wallRun: ["crate_mushrooms", "basket_mushrooms", "barrel_small_stack"], centerpiece: { key: "pot_large", spill: ["mushroom", "mushroom", "plate_food_b"] } },
      { id: "sculleryard", wallRun: ["dishrack_plates", "bartop_a_medium", "crate_large_decorated"], centerpiece: { key: "pot_a_stew", spill: ["plate_stack", "mug_a"] } },
    ],
  },
  {
    id: "forge", // a work floor: the anvil is the altar and fuel is the faith
    zone: "deep", bands: [3, 4],
    wallRun: ["fuel_a_barrels", "crate_large_decorated", "box_large"],
    wallMount: ["torch_mounted", "shelf_small"],
    cornerStack: ["rubble_half", "barrel_small"],
    centerpiece: { key: "anvil", spill: ["sword_shield_broken", "rubble_half"] },
    variants: [
      { id: "cold_forge", wallMount: ["banner_brown", "shelf_small"], centerpiece: { key: "anvil", spill: ["rubble_half", "rubble_large", "skull"] }, cornerStack: ["rubble_large", "fuel_a_barrels"] },
    ],
  },
  {
    id: "apothecary", // shelves of glassware; the dungeon brews its own
    zone: "work", bands: [0, 1, 3],
    wallRun: ["bookcase_single", "shelf_small", "crate_large_decorated"],
    wallMount: ["shelf_small_books", "banner_green"],
    cornerStack: ["gems_sack", "box_small"],
    tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["potion_huge_green", "potion_large_blue", "potion_medium_red"] },
    variants: [
      { id: "witch_pantry", wallRun: ["shelf_small", "crate_mushrooms", "bookcase_single"], tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["basket_mushrooms", "potion_medium_red", "mushroom"] }, cornerStack: ["basket_mushrooms", "gems_sack"] },
    ],
  },
  // Wave 3: whole new jobs (Prototype/Board Game/RPG Tools/Halloween bits).
  {
    id: "trainhall", // the watch drills here: racks, dummies, and splinters
    zone: "work", bands: [0, 4, 5],
    wallRun: ["weaponrack", "weaponrack_decorated", "bench"],
    wallMount: ["banner_red", "torch_mounted"],
    cornerStack: ["box_large", "barrel_small"],
    centerpiece: { key: "trainingdummy_base", spill: ["sword_shield_broken", "rubble_half"] },
    variants: [
      { id: "proving_ground", centerpiece: { key: "dummy_base", spill: ["sword_shield_broken", "sword_shield_broken"] }, wallMount: ["banner_white", "torch_mounted"] },
    ],
  },
  {
    id: "den", // after the shift: cards, coins, and nobody watching the door
    zone: "living", bands: [1, 4, 5],
    wallRun: ["keg_decorated", "barrel_large", "bench"],
    wallMount: ["lantern_hanging", "banner_brown"],
    cornerStack: ["bottle_b_brown", "box_small", "coin_silver"],
    rug: ["rug_rectangle_b", "rug_oval_a"],
    tableSet: { table: "table_round_medium", seat: "stool_round", tabletop: ["card_base", "card_spades_ace", "card_hearts_king", "coin_gold", "coin_10_gold", "mug_a", "vampire_goblet"] },
  },
  {
    id: "warroom", // somebody is planning something down here
    zone: "deep", bands: [0, 3, 5],
    wallRun: ["bookcase_single", "weaponrack", "box_large"],
    wallMount: ["banner_shield_red", "banner_blue"],
    cornerStack: ["map_rolled", "trunk_small_A"],
    rug: ["rug_rectangle_a"],
    tableSet: { table: "table_round_medium", seat: "chair", tabletop: ["map", "map_rolled"] },
  },
  {
    id: "ossuary", // the dungeon files its dead like everything else
    zone: "deep", bands: [0, 3],
    wallRun: ["rubble_half", "rubble_large", "crate_large_decorated"],
    wallMount: ["banner_white", "torch_mounted"],
    cornerStack: ["skull", "bone_A", "ribcage"],
    centerpiece: { key: "ribcage", spill: ["skull", "bone_A", "rubble_half"] },
  },
];


// A dressed room's HISTORY, layered over purpose + variant. The renderer
// translates each into prop damage (thinned runs, broken tables, moss);
// "pristine" is the default and means the variant dresses as authored.
export type RoomCondition = "pristine" | "looted" | "scarred" | "overgrown";

export interface RoomDressing {
  roomIdx: number; // index into map.rooms
  purpose: RoomPurpose; // variant-RESOLVED (fields already merged, variants stripped)
  purposeId: string; // the base purpose id (stable across variants)
  variantId: string | null;
  condition: RoomCondition;
  // The room's social anchor — where the table/centerpiece stands. The
  // renderer builds the furniture here; the sim gathers the resident pack
  // around it. Null when the purpose has no focal furniture.
  anchor: Vec2 | null;
}

function shuffleInPlace<T>(rng: Rng, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(nextFloat(rng) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The one source of truth for "which room is what" on a floor. Deterministic
 * per (seed, floor): band-filtered purposes walk a zone ladder across the
 * entrance-to-depths span (living by the door, work in the middle, the
 * strange rooms deepest), each with a seeded variant and condition roll.
 */
export function assignRoomPurposes(seed: number, floor: number, map: FloorMap): RoomDressing[] {
  const rng = createRng(((Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) >>> 0) ^ Math.imul(floor + 1, 0xc2b2ae35)) >>> 0);
  const candidates: number[] = [];
  for (let ri = 0; ri < map.rooms.length; ri++) {
    const r = map.rooms[ri];
    if (map.roles[ri] === "combat" && r.w >= 5 && r.h >= 5) candidates.push(ri);
  }
  if (candidates.length === 0) return [];
  const band = floorBand(floor);
  const pool = shuffleInPlace(rng, ROOM_PURPOSES.filter((pu) => !pu.bands || pu.bands.includes(band)));
  const byDist = candidates
    .map((ri) => {
      const r = map.rooms[ri];
      return { ri, d: Math.hypot(r.x + r.w / 2 - map.spawn.x, r.y + r.h / 2 - map.spawn.y) };
    })
    .sort((a, b) => a.d - b.d);
  const count = Math.min(5, byDist.length, pool.length);
  const ZONE_LADDER: ("living" | "work" | "deep")[] = ["living", "living", "work", "work", "deep"];
  const used = new Set<RoomPurpose>();
  const out: RoomDressing[] = [];
  for (let k = 0; k < count; k++) {
    const slot = byDist[count === 1 ? 0 : Math.round((k * (byDist.length - 1)) / (count - 1))];
    const wantZone = ZONE_LADDER[Math.min(k, ZONE_LADDER.length - 1)];
    const base = pool.find((pu) => !used.has(pu) && (pu.zone ?? "work") === wantZone)
      ?? pool.find((pu) => !used.has(pu));
    if (!base) break;
    used.add(base);
    // Variant roll (~55%): the same job dressed a different way.
    const variant = base.variants && base.variants.length > 0 && nextFloat(rng) < 0.55
      ? base.variants[Math.floor(nextFloat(rng) * base.variants.length)]
      : null;
    const purpose: RoomPurpose = variant
      ? { ...base, ...variant, id: base.id, variants: undefined }
      : base;
    // Condition roll: most rooms are lived-in as authored; the rest carry a
    // history. Overgrowth only takes root in the damp bands.
    const conditions: RoomCondition[] = ["looted", "scarred"];
    if (band === 1 || band === 3) conditions.push("overgrown");
    const condition: RoomCondition = nextFloat(rng) < 0.45
      ? conditions[Math.floor(nextFloat(rng) * conditions.length)]
      : "pristine";
    // The social anchor: the table's quadrant (off-center — the middle of a
    // combat room stays a fight), or the room center for centerpiece rooms.
    const r = map.rooms[slot.ri];
    let anchor: Vec2 | null = null;
    if (purpose.tableSet) {
      const qx = nextFloat(rng) < 0.5 ? 0.32 : 0.68;
      const qy = nextFloat(rng) < 0.5 ? 0.32 : 0.68;
      anchor = { x: r.x + r.w * qx, y: r.y + r.h * qy };
    } else if (purpose.centerpiece) {
      anchor = { x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 };
    }
    out.push({ roomIdx: slot.ri, purpose, purposeId: base.id, variantId: variant ? variant.id : null, condition, anchor });
  }
  return out;
}
