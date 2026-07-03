import { RARITIES } from "./config";
import { nextFloat, nextInt, pick, type Rng } from "./rng";
import type { Affixes, Item, ItemSlot, PassiveId, Rarity } from "./types";

// Deterministic item generation. Everything rolls off the seeded RNG so drops are
// reproducible. Items carry affixes (stat modifiers) that the player sums across
// equipped slots (see recomputeStats in game.ts).

const SLOT_WEIGHTS: { slot: ItemSlot; weight: number }[] = [
  { slot: "weapon", weight: 42 },
  { slot: "armor", weight: 34 },
  { slot: "trinket", weight: 24 },
];

const RARITY_AFFIX_COUNT: Record<Rarity, number> = { common: 1, magic: 2, rare: 3, epic: 4 };

// Weapon nouns map to real 3D models on the character rig (render3d/weaponry.ts).
const SLOT_NOUNS: Record<ItemSlot, string[]> = {
  weapon: ["Blade", "Axe", "Maul", "Spear", "Cleaver", "Wand", "Staff", "Crossbow"],
  armor: ["Plate", "Hauberk", "Carapace", "Aegis", "Vest"],
  trinket: ["Charm", "Sigil", "Idol", "Band", "Totem"],
};

const RARITY_PREFIX: Record<Rarity, string[]> = {
  common: ["Worn", "Plain", "Scrappy"],
  magic: ["Keen", "Sturdy", "Humming"],
  rare: ["Vicious", "Gilded", "Runed"],
  epic: ["Apocalyptic", "Sovereign", "Cataclysmic"],
};

function rarityMult(rarity: Rarity): number {
  return RARITIES.find((r) => r.name === rarity)!.mult;
}

export function rollRarity(rng: Rng): Rarity {
  const total = RARITIES.reduce((s, r) => s + r.weight, 0);
  let r = nextFloat(rng) * total;
  for (const tier of RARITIES) if ((r -= tier.weight) < 0) return tier.name;
  return "common";
}

function rollSlot(rng: Rng): ItemSlot {
  const total = SLOT_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = nextFloat(rng) * total;
  for (const w of SLOT_WEIGHTS) if ((r -= w.weight) < 0) return w.slot;
  return "weapon";
}

// One affix roll of a given key, scaled by floor depth and rarity.
function rollAffix(rng: Rng, key: keyof Affixes, floor: number, mult: number): number {
  switch (key) {
    case "damage":
      return Math.max(1, Math.round((nextInt(rng, 2, 4) + floor) * mult));
    case "maxHp":
      return Math.max(2, Math.round((nextInt(rng, 6, 12) + floor * 2) * mult));
    case "speed":
      return +((0.15 + nextFloat(rng) * 0.25) * Math.min(2, mult)).toFixed(2);
    case "crit":
      return +((0.02 + nextFloat(rng) * 0.04) * Math.min(2.5, mult)).toFixed(3);
  }
}

// Each slot has a guaranteed primary affix, then extras drawn from a slot-flavored pool.
const PRIMARY: Record<ItemSlot, keyof Affixes> = { weapon: "damage", armor: "maxHp", trinket: "crit" };
const EXTRA_POOL: Record<ItemSlot, (keyof Affixes)[]> = {
  weapon: ["crit", "speed", "maxHp"],
  armor: ["damage", "speed", "crit"],
  trinket: ["speed", "damage", "maxHp"],
};

// ---- Completed works (bench end-game): epic base + materials + SPONSORS ----
// Sponsor gating makes The Show mechanically load-bearing: flashy play earns
// the backers who authorize signature gear.

export interface CompletedRecipe {
  id: PassiveId;
  slot: ItemSlot;
  /** Display name; weapons keep their noun so the 3D model persists. */
  name: (noun: string) => string;
  blurb: string;
  gold: number;
  scrap: number;
  elite_trophy: number;
  sponsors: number; // minimum sponsor count to unlock the recipe
}

export const COMPLETED_RECIPES: CompletedRecipe[] = [
  {
    id: "showrunner", slot: "weapon", name: (noun) => `Headliner ${noun}`,
    blurb: "Kills play in primetime: +4 hype per kill",
    gold: 250, scrap: 12, elite_trophy: 2, sponsors: 1,
  },
  {
    id: "blastplate", slot: "armor", name: () => "Blastplate Harness",
    blurb: "Your dash detonates at the launch point",
    gold: 250, scrap: 12, elite_trophy: 2, sponsors: 2,
  },
  {
    id: "ledger", slot: "trinket", name: () => "Landlord's Ledger",
    blurb: "Every kill credit pays +3 gold",
    gold: 220, scrap: 10, elite_trophy: 2, sponsors: 1,
  },
  {
    id: "overtime", slot: "trinket", name: () => "Overtime Clause",
    blurb: "Ultimate cooldowns reduced by 25%",
    gold: 300, scrap: 14, elite_trophy: 3, sponsors: 2,
  },
];

export function generateItem(rng: Rng, floor: number, nextId: () => number): Item {
  const slot = rollSlot(rng);
  const rarity = rollRarity(rng);
  const mult = rarityMult(rarity);
  const affixes: Affixes = {};

  const primary = PRIMARY[slot];
  affixes[primary] = rollAffix(rng, primary, floor, mult);

  const extras = RARITY_AFFIX_COUNT[rarity] - 1;
  const pool = [...EXTRA_POOL[slot]];
  for (let i = 0; i < extras && pool.length > 0; i++) {
    const key = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    affixes[key] = (affixes[key] ?? 0) + rollAffix(rng, key, floor, mult);
  }

  // The System's favorite joke: a sliver of epic weapons are just... a Mug.
  const noun =
    slot === "weapon" && rarity === "epic" && nextFloat(rng) < 0.07
      ? "Mug"
      : pick(rng, SLOT_NOUNS[slot]);
  const name = `${pick(rng, RARITY_PREFIX[rarity])} ${noun}`;
  return { id: nextId(), slot, rarity, name, affixes };
}

/** A single scalar used to auto-equip "the better item" and to sort the bag. */
export function itemScore(item: Item): number {
  const a = item.affixes;
  return (a.damage ?? 0) * 2 + (a.maxHp ?? 0) * 0.5 + (a.speed ?? 0) * 25 + (a.crit ?? 0) * 300;
}

/** Human-readable affix lines for the inventory UI, e.g. ["+7 DMG", "+4% crit"]. */
export function affixLines(item: Item): string[] {
  const a = item.affixes;
  const out: string[] = [];
  if (a.damage) out.push(`+${a.damage} DMG`);
  if (a.maxHp) out.push(`+${a.maxHp} HP`);
  if (a.speed) out.push(`+${a.speed.toFixed(2)} SPD`);
  if (a.crit) out.push(`+${Math.round(a.crit * 100)}% crit`);
  return out;
}
