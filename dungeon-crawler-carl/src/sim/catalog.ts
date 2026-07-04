import type { Affixes, ItemSlot, MaterialId, PassiveId } from "./types";

// The System Shop catalog — one hybrid shop/crafting system (LoL-style).
// Every safe room sells from this fixed catalog: cheap components BUILD INTO
// higher-tier items (buying an upgrade consumes owned components and discounts
// their value), topped by sponsor-gated LEGENDARY signature gear that carries
// a unique passive. Consumables and tomes share the same shelf.
//
// Tier availability is floor-gated and varies shop to shop (see
// generateSafeRoom in game.ts); the catalog itself is static data so clients
// can render the full build tree ("ALL ITEMS" planning view) at any time.

export type CatalogTier = "consumable" | "starter" | "basic" | "advanced" | "legendary";

/** What a consumable does when bought (applied immediately in buyCatalogItem). */
export type ConsumableEffect = "heal" | "time" | "maxHp" | "mystery" | "tome" | "favor";

export interface CatalogEntry {
  id: string;
  name: string;
  tier: CatalogTier;
  /** One effect/flavor line for the detail panel. */
  desc: string;
  // Gear fields (absent on consumables).
  slot?: ItemSlot;
  /** Base affixes; materialized at purchase scaled by the floor ahead (gearAffixes). */
  affixes?: Affixes;
  /** Legendary signature behavior (hooks in game.ts). */
  passive?: PassiveId;
  /** Component catalog ids consumed (and price-credited) when buying this. */
  buildsFrom?: string[];
  /** Gear: combine cost on top of components. Consumables: base price. */
  cost: number;
  /** Consumables: price grows with the floor ahead (cost + perFloor * floor). */
  perFloor?: number;
  /** Minimum sponsor count to purchase (legendary signature gear). */
  sponsors?: number;
  /** Crafting materials consumed on purchase (the elite/boss hunt). */
  materials?: Partial<Record<MaterialId, number>>;
  effect?: ConsumableEffect;
}

export const CATALOG: CatalogEntry[] = [
  // ---- Consumables (always stocked; repeatable buys; floor-scaled prices) ----
  {
    id: "field_ration", name: "Field Ration", tier: "consumable", effect: "heal",
    desc: "Restore 50% HP. Tastes like sponsorship.", cost: 25, perFloor: 5,
  },
  {
    id: "stabilizer_rod", name: "Stabilizer Rod", tier: "consumable", effect: "time",
    desc: "+15s on the next floor's collapse timer.", cost: 30, perFloor: 6,
  },
  {
    id: "plating_kit", name: "Plating Kit", tier: "consumable", effect: "maxHp",
    desc: "Permanent max-HP graft. Slightly itchy.", cost: 45, perFloor: 9,
  },
  {
    id: "mystery_box", name: "Mystery Box", tier: "consumable", effect: "mystery",
    desc: "A loot-box roll. The System giggles.", cost: 60, perFloor: 8,
  },
  {
    id: "tome", name: "Ability Tome", tier: "consumable", effect: "tome",
    desc: "Learn the ability printed inside. Stock varies.", cost: 120, perFloor: 10,
  },
  {
    id: "system_favor", name: "System Favor", tier: "consumable", effect: "favor",
    desc: "The System owes you one: an extra ability-upgrade draft.", cost: 150, perFloor: 15,
  },

  // ---- Starter (floor-1 kit; cheap stat sticks; sell them back later) ----
  {
    id: "boxcutter", name: "Boxcutter", tier: "starter", slot: "weapon",
    desc: "Standard-issue. The System expensed it.", cost: 35, affixes: { damage: 3 },
  },
  {
    id: "cardboard_cuirass", name: "Cardboard Cuirass", tier: "starter", slot: "armor",
    desc: "Triple-ply. Mostly waterproof.", cost: 35, affixes: { maxHp: 10 },
  },
  {
    id: "lucky_bottlecap", name: "Lucky Bottlecap", tier: "starter", slot: "trinket",
    desc: "Found heads-up. Probably fate.", cost: 35, affixes: { crit: 0.02 },
  },

  // ---- Basic (the component layer everything builds from) ----
  {
    id: "honed_edge", name: "Honed Edge", tier: "basic", slot: "weapon",
    desc: "A properly sharpened anything.", cost: 65, affixes: { damage: 6 },
  },
  {
    id: "swift_wraps", name: "Swift Wraps", tier: "basic", slot: "weapon",
    desc: "Grip tape for people in a hurry.", cost: 55, affixes: { damage: 3, speed: 0.2 },
  },
  {
    id: "iron_plating", name: "Iron Plating", tier: "basic", slot: "armor",
    desc: "Bolted on. Warranty void.", cost: 65, affixes: { maxHp: 18 },
  },
  {
    id: "padded_lining", name: "Padded Lining", tier: "basic", slot: "armor",
    desc: "For crawlers who plan to be hit anyway.", cost: 55, affixes: { maxHp: 8, speed: 0.15 },
  },
  {
    id: "killer_instinct", name: "Killer Instinct", tier: "basic", slot: "trinket",
    desc: "Bottled. Shake before opening.", cost: 70, affixes: { crit: 0.04 },
  },
  {
    id: "glass_charm", name: "Glass Charm", tier: "basic", slot: "trinket",
    desc: "Fragile-looking. Isn't.", cost: 70, affixes: { crit: 0.05 },
  },
  {
    id: "focus_bead", name: "Focus Bead", tier: "basic", slot: "trinket",
    desc: "Click it and the world slows down. (It doesn't.)", cost: 55, affixes: { speed: 0.25 },
  },

  // ---- Advanced (two components + combine gold; floor-gated, shop-varying) ----
  {
    id: "primetime_cleaver", name: "Prime-Time Cleaver", tier: "advanced", slot: "weapon",
    desc: "Swings scheduled for maximum viewership.", cost: 90,
    buildsFrom: ["honed_edge", "killer_instinct"], affixes: { damage: 14, crit: 0.06 },
  },
  {
    id: "roadie_runner", name: "Roadie Runner", tier: "advanced", slot: "weapon",
    desc: "Set up the stage, tear down the crowd.", cost: 80,
    buildsFrom: ["honed_edge", "swift_wraps"], affixes: { damage: 11, speed: 0.4 },
  },
  {
    id: "bloodsport_maul", name: "Bloodsport Maul", tier: "advanced", slot: "weapon",
    desc: "Heavy enough to count as armor.", cost: 100,
    buildsFrom: ["honed_edge", "iron_plating"], affixes: { damage: 12, maxHp: 25 },
  },
  {
    id: "showstopper_plate", name: "Showstopper Plate", tier: "advanced", slot: "armor",
    desc: "The crowd loves a crawler who won't die on cue.", cost: 90,
    buildsFrom: ["iron_plating", "iron_plating"], affixes: { maxHp: 45 },
  },
  {
    id: "stagedive_harness", name: "Stage-Dive Harness", tier: "advanced", slot: "armor",
    desc: "Rated for falls, brawls, and encores.", cost: 85,
    buildsFrom: ["iron_plating", "padded_lining"], affixes: { maxHp: 24, speed: 0.3 },
  },
  {
    id: "crowd_medallion", name: "Crowd Favorite Medallion", tier: "advanced", slot: "trinket",
    desc: "They chant your name. It helps.", cost: 80,
    buildsFrom: ["glass_charm", "focus_bead"], affixes: { crit: 0.07, speed: 0.3 },
  },
  {
    id: "ratings_magnet", name: "Ratings Magnet", tier: "advanced", slot: "trinket",
    desc: "Violence tests well in every demographic.", cost: 95,
    buildsFrom: ["glass_charm", "killer_instinct"], affixes: { crit: 0.11 },
  },

  // ---- Legendary — sponsor-gated signature gear (unique passives) ----
  {
    id: "headliner_cleaver", name: "The Headliner", tier: "legendary", slot: "weapon",
    desc: "Kills play in primetime: +4 hype per kill.", cost: 150,
    buildsFrom: ["primetime_cleaver"], affixes: { damage: 20, crit: 0.08 },
    passive: "showrunner", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "blastplate_harness", name: "Blastplate Harness", tier: "legendary", slot: "armor",
    desc: "Your dash detonates at the launch point.", cost: 150,
    buildsFrom: ["showstopper_plate"], affixes: { maxHp: 50 },
    passive: "blastplate", sponsors: 2, materials: { elite_trophy: 2 },
  },
  {
    id: "landlords_ledger", name: "Landlord's Ledger", tier: "legendary", slot: "trinket",
    desc: "Every kill credit pays +3 gold.", cost: 130,
    buildsFrom: ["crowd_medallion"], affixes: { crit: 0.06, speed: 0.3 },
    passive: "ledger", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "overtime_clause", name: "Overtime Clause", tier: "legendary", slot: "trinket",
    desc: "Ultimate cooldowns reduced by 25%.", cost: 160,
    buildsFrom: ["ratings_magnet"], affixes: { crit: 0.1 },
    passive: "overtime", sponsors: 2, materials: { elite_trophy: 3, boss_sigil: 1 },
  },
];

export const CATALOG_BY_ID: Record<string, CatalogEntry> = Object.fromEntries(
  CATALOG.map((e) => [e.id, e]),
);

/** Full sticker price: combine cost plus every component's full price, recursively. */
export function totalCost(id: string): number {
  const e = CATALOG_BY_ID[id];
  if (!e) return 0;
  return e.cost + (e.buildsFrom ?? []).reduce((s, c) => s + totalCost(c), 0);
}

/** Price of a consumable for the floor ahead (gear uses totalCost/combine math). */
export function consumablePrice(e: CatalogEntry, floor: number): number {
  return e.cost + (e.perFloor ?? 0) * floor;
}

/** Catalog ids that use `id` as a direct component (the "BUILDS INTO" row). */
export function buildsInto(id: string): CatalogEntry[] {
  return CATALOG.filter((e) => e.buildsFrom?.includes(id));
}

/** Item rarity (drop-tint / HUD language) for each shop tier. */
export const TIER_RARITY = {
  starter: "common",
  basic: "magic",
  advanced: "rare",
  legendary: "epic",
} as const;

// Catalog gear is materialized at purchase, scaled by the floor ahead so the
// build tree stays relevant across an 18-floor run (a Prime-Time Cleaver
// bought on floor 10 outswings one bought on floor 3 — rebuying/upgrading
// through the tree is the intended refresh). The 0.15/floor slope is
// calibrated for TIER PARITY with drops (items.ts rollAffix × RARITIES.mult):
// advanced keeps pace with rare drops, legendary with epics — the shop sells
// certainty and build paths, not strictly-worse stat sticks. Probability/speed
// affixes scale on a tighter leash than raw stats.
export function gearAffixes(e: CatalogEntry, floor: number): Affixes {
  const mult = 1 + 0.15 * Math.max(0, floor - 2);
  const a = e.affixes ?? {};
  const out: Affixes = {};
  if (a.damage) out.damage = Math.round(a.damage * mult);
  if (a.maxHp) out.maxHp = Math.round(a.maxHp * mult);
  if (a.speed) out.speed = +(a.speed * Math.min(mult, 2)).toFixed(2);
  if (a.crit) out.crit = +(a.crit * Math.min(mult, 2.4)).toFixed(3);
  return out;
}

// Floor-gating: the shop after floor N is "shop index N". Starters, basics,
// and consumables are always on the shelf; deeper tiers unlock as the run
// progresses and each shop stocks a seeded, growing SUBSET (varies shop to
// shop — the ALL ITEMS view is how you plan around what today's shelf lacks).
export const TIER_UNLOCK_SHOP: Record<CatalogTier, number> = {
  consumable: 1,
  starter: 1,
  basic: 1,
  advanced: 2,
  legendary: 4,
};

/** How many items of a tier a given shop stocks (before seeded selection). */
export function tierStockCount(tier: CatalogTier, shopIndex: number): number {
  const all = CATALOG.filter((e) => e.tier === tier).length;
  const unlock = TIER_UNLOCK_SHOP[tier];
  if (shopIndex < unlock) return 0;
  if (tier === "advanced") return Math.min(all, 3 + (shopIndex - unlock));
  if (tier === "legendary") return Math.min(all, 1 + Math.floor((shopIndex - unlock) / 2));
  return all; // consumables/starter/basic: full shelf, always
}
