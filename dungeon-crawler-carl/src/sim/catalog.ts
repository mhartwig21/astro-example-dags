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
  /** Consumables: how many can be bought PER SHOP (scarcity — was unlimited).
   * Absent = the CONSUMABLE_STOCK_DEFAULT below. */
  stock?: number;
}

/** Per-shop stock for a consumable with no explicit `stock`. */
export const CONSUMABLE_STOCK_DEFAULT = 2;

/** How many units of a consumable this shop stocks. Non-consumables are Infinity. */
export function consumableStock(entry: CatalogEntry): number {
  if (entry.tier !== "consumable") return Infinity;
  return entry.stock ?? CONSUMABLE_STOCK_DEFAULT;
}

export const CATALOG: CatalogEntry[] = [
  // ---- Consumables (always stocked; repeatable buys; floor-scaled prices) ----
  {
    id: "field_ration", name: "Field Ration", tier: "consumable", effect: "heal",
    desc: "Restore 50% HP. Tastes like sponsorship.", cost: 25, perFloor: 5, stock: 3,
  },
  {
    id: "stabilizer_rod", name: "Stabilizer Rod", tier: "consumable", effect: "time",
    desc: "+15s on the next floor's collapse timer.", cost: 30, perFloor: 6, stock: 2,
  },
  {
    id: "plating_kit", name: "Plating Kit", tier: "consumable", effect: "maxHp",
    desc: "Permanent max-HP graft. Slightly itchy. The System rations these.", cost: 45, perFloor: 9, stock: 2,
  },
  {
    id: "mystery_box", name: "Mystery Box", tier: "consumable", effect: "mystery",
    desc: "A loot-box roll. The System giggles.", cost: 60, perFloor: 8, stock: 2,
  },
  {
    id: "tome", name: "Ability Tome", tier: "consumable", effect: "tome",
    desc: "Learn the ability printed inside. Stock varies.", cost: 120, perFloor: 10, stock: 1,
  },
  {
    id: "system_favor", name: "System Favor", tier: "consumable", effect: "favor",
    desc: "The System owes you one: an extra ability-upgrade draft.", cost: 150, perFloor: 15, stock: 1,
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
  // Support-slot components (backlog #10 slots get build paths too).
  {
    id: "crash_helmet", name: "Crash Helmet", tier: "basic", slot: "helm",
    desc: "OSHA-approved for dungeon work. OSHA no longer exists.", cost: 60, affixes: { maxHp: 10, armor: 3 },
  },
  {
    id: "tour_treads", name: "Tour Treads", tier: "basic", slot: "boots",
    desc: "Broken in by someone who did not survive the tour.", cost: 60, affixes: { speed: 0.2 },
  },
  // The CASTER branch (DESIGN 5.8 phase 3): spell-power components so SP
  // builds can SHOP instead of praying to the drop gods. Names end in their
  // weapon-class noun, so buying one genuinely changes your bolt profile.
  {
    id: "ozone_wand", name: "Ozone Wand", tier: "basic", slot: "weapon",
    desc: "Smells like a thunderstorm filing a complaint.", cost: 65, affixes: { spell: 6 },
  },
  {
    id: "cursed_amplifier", name: "Cursed Amplifier", tier: "basic", slot: "charm",
    desc: "Turns it up to eleven. The eleven is cursed.", cost: 60, affixes: { spell: 3, crit: 0.03 },
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
  {
    id: "stormcall_staff", name: "Stormcall Staff", tier: "advanced", slot: "weapon",
    desc: "The weather report is you now.", cost: 95,
    buildsFrom: ["ozone_wand", "cursed_amplifier"], affixes: { spell: 13, crit: 0.05 },
  },
  // Chase-path middles: each one is a rung on the ladder to a legendary
  // unique below — worth wearing on its own, but you bought it for the plan.
  {
    id: "box_seat_crossbow", name: "Box Seat Crossbow", tier: "advanced", slot: "weapon",
    desc: "Premium sightlines. Bring your own bolts.", cost: 95,
    buildsFrom: ["honed_edge", "glass_charm"], affixes: { damage: 12, crit: 0.06 },
  },
  {
    id: "gyro_stabilizer", name: "Gyro Stabilizer", tier: "advanced", slot: "trinket",
    desc: "Keeps spinning things spinning. Officially a food-cart part.", cost: 85,
    buildsFrom: ["focus_bead", "swift_wraps"], affixes: { speed: 0.3, damage: 7 },
  },
  {
    id: "mosh_pit_helm", name: "Mosh Pit Helm", tier: "advanced", slot: "helm",
    desc: "Rated for elbows, chairs, and modest apocalypses.", cost: 90,
    buildsFrom: ["crash_helmet", "iron_plating"], affixes: { maxHp: 30, armor: 8 },
  },
  {
    id: "encore_treads", name: "Encore Treads", tier: "advanced", slot: "boots",
    desc: "The crowd stomps along. You stomp first.", cost: 85,
    buildsFrom: ["tour_treads", "glass_charm"], affixes: { speed: 0.35, crit: 0.05 },
  },
  {
    id: "vip_pass", name: "VIP Pass", tier: "advanced", slot: "charm",
    desc: "Backstage access. The blood bar is included.", cost: 85,
    buildsFrom: ["killer_instinct", "focus_bead"], affixes: { crit: 0.05, speed: 0.25 },
  },

  // ---- Legendary — sponsor-gated signature gear (unique passives) ----
  {
    id: "headliner_cleaver", name: "The Headliner", tier: "legendary", slot: "weapon",
    desc: "Kills play in primetime: +4 hype per kill.", cost: 150,
    buildsFrom: ["primetime_cleaver"], affixes: { damage: 24, crit: 0.1 },
    passive: "showrunner", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "blastplate_harness", name: "Blastplate Harness", tier: "legendary", slot: "armor",
    desc: "Your dash detonates at the launch point.", cost: 150,
    buildsFrom: ["showstopper_plate"], affixes: { maxHp: 60, armor: 10 },
    passive: "blastplate", sponsors: 2, materials: { elite_trophy: 2 },
  },
  {
    id: "landlords_ledger", name: "Landlord's Ledger", tier: "legendary", slot: "trinket",
    desc: "Kills pay +6 gold, and banked gold earns 10% interest every safe room.", cost: 140,
    buildsFrom: ["crowd_medallion"], affixes: { crit: 0.08, speed: 0.35, maxHp: 20 },
    passive: "ledger", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "overtime_clause", name: "Overtime Clause", tier: "legendary", slot: "trinket",
    desc: "Ultimate cooldowns reduced by 25%.", cost: 160,
    buildsFrom: ["ratings_magnet"], affixes: { crit: 0.12, maxHp: 20 },
    passive: "overtime", sponsors: 2, materials: { elite_trophy: 3, boss_sigil: 1 },
  },
  {
    id: "sweeps_week_staff", name: "Sweeps Week Staff", tier: "legendary", slot: "weapon",
    desc: "Every ability cooldown runs 15% faster. Ratings never sleep.", cost: 155,
    buildsFrom: ["stormcall_staff"], affixes: { spell: 24, crit: 0.08 },
    passive: "tempo", sponsors: 1, materials: { elite_trophy: 2 },
  },
  // CHASE UNIQUES: store-only build-definers. You cannot loot these — you
  // assemble them, shop by shop, and each one warps a build around itself.
  {
    id: "perpetual_encore", name: "Perpetual Encore", tier: "legendary", slot: "trinket",
    desc: "+1 orbit blade, and the blades strike 25% faster. The show must go on.", cost: 150,
    buildsFrom: ["gyro_stabilizer"], affixes: { damage: 12, speed: 0.35, crit: 0.05 },
    passive: "encore", sponsors: 2, materials: { elite_trophy: 2 },
  },
  {
    id: "standing_ovation", name: "Standing Ovation Crossbow", tier: "legendary", slot: "weapon",
    desc: "Bolts pierce +2 bodies. The back row deserves a show too.", cost: 155,
    buildsFrom: ["box_seat_crossbow"], affixes: { damage: 22, crit: 0.1 },
    passive: "skewer", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "signature_choreography", name: "Signature Choreography", tier: "legendary", slot: "boots",
    desc: "Swapping Battle Stance grants +20% crit for the surge window. Swap, spike, repeat.", cost: 150,
    buildsFrom: ["encore_treads"], affixes: { speed: 0.5, crit: 0.08, damage: 8 },
    passive: "choreography", sponsors: 2, materials: { elite_trophy: 3 },
  },
  {
    id: "plot_armor", name: "Plot Armor", tier: "legendary", slot: "helm",
    desc: "Once per floor, a killing blow leaves you at 1 HP. The writers insist.", cost: 180,
    buildsFrom: ["mosh_pit_helm"], affixes: { maxHp: 55, armor: 15 },
    passive: "plot_armor", sponsors: 3, materials: { elite_trophy: 2, boss_sigil: 1 },
  },
  // Novel mechanics that exist NOWHERE else in the game — no constellation
  // node, no drop affix. If you want lifesteal, you plan for this charm.
  {
    id: "blood_subscription", name: "Blood Subscription", tier: "legendary", slot: "charm",
    desc: "Heal 6% of the damage you deal. Auto-renews. Cancellation is difficult.", cost: 160,
    buildsFrom: ["vip_pass"], affixes: { crit: 0.08, maxHp: 30 },
    passive: "leech", sponsors: 2, materials: { elite_trophy: 2 },
  },
  {
    id: "cancellation_axe", name: "Cancellation Axe", tier: "legendary", slot: "weapon",
    desc: "Strikes CANCEL non-elite monsters below 15% HP. No appeals.", cost: 160,
    buildsFrom: ["bloodsport_maul"], affixes: { damage: 24, maxHp: 35 },
    passive: "cancellation", sponsors: 2, materials: { elite_trophy: 3 },
  },
  {
    id: "live_feed", name: "Live Feed", tier: "legendary", slot: "trinket",
    desc: "Crits arc 30% of the hit to a nearby enemy, as magic. Share the moment.", cost: 150,
    buildsFrom: ["ratings_magnet"], affixes: { crit: 0.12, damage: 8 },
    passive: "conduit", sponsors: 1, materials: { elite_trophy: 2 },
  },
  {
    id: "backstage_pass", name: "Backstage Pass", tier: "legendary", slot: "armor",
    desc: "Your dash passes through walls when it can reach the far side. Set dressing.", cost: 170,
    buildsFrom: ["stagedive_harness"], affixes: { maxHp: 45, speed: 0.35, armor: 8 },
    passive: "phase", sponsors: 2, materials: { elite_trophy: 2, boss_sigil: 1 },
  },
  {
    id: "location_scout", name: "Location Scout", tier: "legendary", slot: "charm",
    desc: "The stairs are marked on your minimap from the moment you arrive. Crew knowledge.", cost: 140,
    buildsFrom: ["vip_pass"], affixes: { speed: 0.35, maxHp: 20, crit: 0.04 },
    passive: "pathfinder", sponsors: 1, materials: { elite_trophy: 2 },
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
  if (a.spell) out.spell = Math.round(a.spell * mult); // the schools scale together
  if (a.maxHp) out.maxHp = Math.round(a.maxHp * mult);
  if (a.armor) out.armor = Math.round(a.armor * mult);
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
  // Deeper shelves for the planning game: the store is the build engine now,
  // so the higher tiers stock more per shop than they used to.
  if (tier === "advanced") return Math.min(all, 4 + (shopIndex - unlock));
  if (tier === "legendary") return Math.min(all, 2 + Math.floor((shopIndex - unlock) / 2));
  return all; // consumables/starter/basic: full shelf, always
}
