// Room purposes — the vignette grammar as SIM-VISIBLE truth.
//
// Phase 1-2 lived render-side; phase 3 (occupancy) needs the sim to know
// which room is the mess hall so the pack can sit at dinner. The fix is this
// pure module: `assignRoomPurposes(seed, floor, map)` computes the same
// answer for everyone — the renderer dresses from it, spawnMonsters seats
// packs by it, and determinism is free because the only randomness is a
// local rng derived from (seed, floor). No GameState, no mutation, no DOM.

import { createRng, nextFloat, type Rng } from "./rng";
import { CONFIG, floorBand } from "./config";
import type { FloorMap, MonsterKind, Vec2 } from "./types";
import PURPOSES_DATA from "./roomPurposes.data.json";

export interface RoomPurpose {
  id: string;
  note?: string; // authorial one-liner (was an inline comment pre-JSON)
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

// The purpose DATA lives in roomPurposes.data.json so the builder's dev
// bridge can ship dressing edits as a clean file write. Convention: in a
// variant, JSON null means "remove the base field" (JSON cannot say
// undefined); resolvePurpose normalizes nulls away after the merge.
export const ROOM_PURPOSES: RoomPurpose[] = PURPOSES_DATA as unknown as RoomPurpose[];


// A dressed room's HISTORY, layered over purpose + variant. The renderer
// translates each into prop damage (thinned runs, broken tables, moss);
// "pristine" is the default and means the variant dresses as authored.
export type RoomCondition = "pristine" | "looted" | "scarred" | "overgrown";

// What the residents SAY when you interrupt them (phase 5) — announced once
// per floor, the first time a seated pack takes damage. System voice.
export const RESIDENT_LINES: Record<string, string> = {
  storage: "Something was NESTING in the stores. It objects to the audit.",
  mess: "You interrupted DINNER. The mess hall takes this personally.",
  archive: "QUIET in the archive. The readers enforce the rule.",
  guardpost: "The WATCH earns its pay after all.",
  barracks: "You woke the GARRISON. They were off duty. They are not anymore.",
  kitchen: "You barged into the KITCHEN mid-service. The staff has knives anyway.",
  forge: "You disturbed the FORGE. The work order now includes you.",
  apothecary: "You jostled the GLASSWARE. The brewers bill for breakage.",
  trainhall: "The SPARRING RING welcomes a volunteer.",
  den: "You interrupted the HAND. All bets are off.",
  warroom: "The PLANNERS pencil you in.",
  ossuary: "The FILING SYSTEM objects to being rearranged.",
};

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
  // Smashable corner hoard (phase 5): the sim spawns Breakable entities here
  // and the renderer draws THESE instead of a cosmetic corner stack, so what
  // you see is exactly what you can hit.
  breakables: { x: number; y: number; key: string }[];
}

/** Merge a variant over its base purpose (variant fields REPLACE base fields).
 *  A null field in the variant REMOVES the base's (JSON's stand-in for
 *  undefined — see roomPurposes.data.json). */
export function resolvePurpose(
  base: RoomPurpose,
  variant: (Partial<Omit<RoomPurpose, "variants">> & { id: string }) | null,
): RoomPurpose {
  if (!variant) return base;
  const merged = { ...base, ...variant, id: base.id, variants: undefined } as Record<string, unknown>;
  for (const k of Object.keys(merged)) if (merged[k] === null) merged[k] = undefined;
  return merged as unknown as RoomPurpose;
}

// OCCUPANCY v2: who actually lives in each kind of room. When a pack spawns
// in a dressed room it usually (70%) draws from these instead of the band
// table — the ossuary keeps the necromancer's crew, the barracks its
// garrison, the stores their vermin. Universal kinds only, so every band
// can staff every room it is allowed to have.
export const PURPOSE_RESIDENTS: Record<string, MonsterKind[]> = {
  storage: ["swarmer", "grunt"], // vermin in the stores
  mess: ["grunt", "brute"], // the off-shift, eating
  archive: ["shaman", "ranged"], // readers with opinions
  guardpost: ["ranged", "grunt"], // the watch, watching
  barracks: ["grunt", "ranged"], // the garrison, off duty
  kitchen: ["grunt", "swarmer"], // staff and the things staff attract
  forge: ["brute", "grunt"], // heavy work wants heavy hands
  apothecary: ["shaman", "ranged"], // the brewers
  trainhall: ["brute", "grunt"], // sparring partners
  den: ["grunt", "brute"], // the card game does not stop for you
  warroom: ["ranged", "shaman"], // planners and their bodyguards
  ossuary: ["necromancer", "swarmer", "swarmer"], // the filing clerk and the files
};

// FLOOR STORIES: one seeded event per floor (35%) leaves its mark as a swept
// PATH of conditions instead of independent rolls — looters came in the same
// door you did, a battle tore through the middle, the damp claims the deep
// end. buildFloor announces the line once on arrival; the dressing shows it.
export type FloorStoryId = "looters" | "battle" | "damp";

export const STORY_LINES: Record<FloorStoryId, string> = {
  looters: "Someone swept this floor ahead of you. The System reviewed the footage and is saying nothing.",
  battle: "Something fought through these halls before you arrived. The System does not clean up between takes.",
  damp: "The damp is winning down here. The System disclaims all fungus.",
};

// Purposes that can take customers (phase 4). The verb per purpose lives in
// game.ts (serviceChoices) — this set only gates WHO can hang a shingle.
export const SERVICE_PURPOSES = new Set(["forge", "apothecary", "den", "archive", "warroom"]);

export interface FloorDressingPlan {
  dressings: RoomDressing[];
  story: FloorStoryId | null;
  // At most ONE room per floor is OPEN FOR BUSINESS — rare by design (the
  // owner's constraint: verbs must be a lucky find, not a farming loop),
  // and never in a looted or scarred room: those have nothing left to sell.
  service: { roomIdx: number; purposeId: string } | null;
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
export function assignRoomPurposes(seed: number, floor: number, map: FloorMap): FloorDressingPlan {
  const rng = createRng(((Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) >>> 0) ^ Math.imul(floor + 1, 0xc2b2ae35)) >>> 0);
  const candidates: number[] = [];
  for (let ri = 0; ri < map.rooms.length; ri++) {
    const r = map.rooms[ri];
    if (map.roles[ri] === "combat" && r.w >= 5 && r.h >= 5) candidates.push(ri);
  }
  if (candidates.length === 0) return { dressings: [], story: null, service: null };
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
    const purpose = resolvePurpose(base, variant);
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
    out.push({ roomIdx: slot.ri, purpose, purposeId: base.id, variantId: variant ? variant.id : null, condition, anchor, breakables: [] });
  }
  // The story roll: one event sweeps a coherent path of conditions over the
  // independent per-room rolls above. `out` is ordered entrance-to-depths,
  // so "who it hit" is a slice: looters take the front rooms (they came in
  // the same door you did), the damp takes the deep end, battle the middle.
  let story: FloorStoryId | null = null;
  if (out.length >= 2 && nextFloat(rng) < 0.35) {
    const options: FloorStoryId[] = ["looters", "battle"];
    if (band === 1 || band === 3) options.push("damp");
    story = options[Math.floor(nextFloat(rng) * options.length)];
    const path = story === "damp" ? [...out].reverse() : story === "battle" ? out.slice(1) : out;
    const cond: RoomCondition = story === "looters" ? "looted" : story === "battle" ? "scarred" : "overgrown";
    for (let i = 0; i < Math.min(story === "battle" ? 2 : 3, path.length); i++) path[i].condition = cond;
  }
  let service: FloorDressingPlan["service"] = null;
  const open = out.filter(
    (d) => SERVICE_PURPOSES.has(d.purposeId) && d.anchor && (d.condition === "pristine" || d.condition === "overgrown"),
  );
  if (open.length > 0 && nextFloat(rng) < CONFIG.serviceChance) {
    const d = open[Math.floor(nextFloat(rng) * open.length)];
    service = { roomIdx: d.roomIdx, purposeId: d.purposeId };
  }
  // SMASHABLE corner hoards (phase 5) — drawn LAST so these rolls never
  // reshuffle the story/service outcomes above, and computed against the
  // FINAL condition (a story-looted room has no hoard left to smash).
  for (const d of out) {
    if (!d.purpose.cornerStack || d.condition === "looted") continue;
    const r = map.rooms[d.roomIdx];
    const corners = [
      { x: 1.3, y: 1.3 }, { x: r.w - 1.3, y: 1.3 },
      { x: 1.3, y: r.h - 1.3 }, { x: r.w - 1.3, y: r.h - 1.3 },
    ];
    const c = corners[Math.floor(nextFloat(rng) * 4)];
    const n = CONFIG.breakableCountMin + Math.floor(nextFloat(rng) * (CONFIG.breakableCountMax - CONFIG.breakableCountMin + 1));
    for (let bi = 0; bi < n; bi++) {
      d.breakables.push({
        x: r.x + c.x + (nextFloat(rng) - 0.5) * 0.8,
        y: r.y + c.y + (nextFloat(rng) - 0.5) * 0.8,
        key: d.purpose.cornerStack[Math.floor(nextFloat(rng) * d.purpose.cornerStack.length)],
      });
    }
  }
  return { dressings: out, story, service };
}
