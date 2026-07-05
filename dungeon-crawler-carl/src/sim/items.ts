import { RARITIES } from "./config";
import { nextFloat, nextInt, pick, type Rng } from "./rng";
import type { Affixes, Item, ItemSlot, Rarity } from "./types";

// Deterministic item generation. Everything rolls off the seeded RNG so drops are
// reproducible. Items carry affixes (stat modifiers) that the player sums across
// equipped slots (see recomputeStats in game.ts).

const SLOT_WEIGHTS: { slot: ItemSlot; weight: number }[] = [
  { slot: "weapon", weight: 30 },
  { slot: "armor", weight: 20 },
  { slot: "helm", weight: 13 },
  { slot: "boots", weight: 13 },
  { slot: "trinket", weight: 12 },
  { slot: "charm", weight: 12 },
];

// Six sockets stack twice the affix real estate of the old three, so the
// SUPPORT slots (helm/boots/charm) roll at a reduced budget — the weapon/
// armor/trinket curves (and their catalog tier parity) stay untouched.
const SLOT_BUDGET: Record<ItemSlot, number> = {
  weapon: 1, armor: 1, trinket: 1, helm: 0.6, boots: 0.6, charm: 0.6,
};

const RARITY_AFFIX_COUNT: Record<Rarity, number> = { common: 1, magic: 2, rare: 3, epic: 4 };

// Weapon nouns map to real 3D models on the character rig (render3d/weaponry.ts).
const SLOT_NOUNS: Record<ItemSlot, string[]> = {
  weapon: ["Blade", "Axe", "Maul", "Spear", "Cleaver", "Wand", "Staff", "Crossbow"],
  armor: ["Plate", "Hauberk", "Carapace", "Aegis", "Vest"],
  helm: ["Helm", "Visor", "Hood", "Crown"],
  boots: ["Boots", "Greaves", "Treads", "Striders"],
  trinket: ["Charm", "Sigil", "Idol", "Band", "Totem"],
  charm: ["Pendant", "Talisman", "Locket", "Fetish"],
};

// Genuine itemization (DESIGN 5.8): every weapon noun belongs to a CLASS with
// one mechanical hook (abilities.ts reads these for melee/bolt/nova params).
// Catalog weapon names resolve through the same map (noun = last word), so
// "Bloodsport Maul" is heavy and "Prime-Time Cleaver" is swift for free.
export type WeaponClass = "swift" | "heavy" | "reach" | "ballistic" | "arcane" | "chaotic";
const WEAPON_CLASS_BY_NOUN: Record<string, WeaponClass> = {
  Blade: "swift", Cleaver: "swift", Boxcutter: "swift", Edge: "swift", Wraps: "swift", Runner: "swift", Headliner: "swift",
  Axe: "heavy", Maul: "heavy",
  Spear: "reach",
  Crossbow: "ballistic",
  Wand: "arcane", Staff: "arcane",
  Mug: "chaotic",
};

/** Weapon class of an item (by name noun), or null for non-weapons/unknowns. */
export function weaponClassOf(item: Item | null | undefined): WeaponClass | null {
  if (!item || item.slot !== "weapon") return null;
  const parts = item.name.split(" ");
  return WEAPON_CLASS_BY_NOUN[parts[parts.length - 1]] ?? null;
}

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
    case "spell": // the schools grow on the same curve; gear picks WHICH
      return Math.max(1, Math.round((nextInt(rng, 2, 4) + floor) * mult));
    case "maxHp":
      return Math.max(2, Math.round((nextInt(rng, 6, 12) + floor * 2) * mult));
    case "speed":
      return +((0.15 + nextFloat(rng) * 0.25) * Math.min(2, mult)).toFixed(2);
    case "crit":
      return +((0.02 + nextFloat(rng) * 0.04) * Math.min(2.5, mult)).toFixed(3);
    case "armor":
      return Math.max(1, Math.round((nextInt(rng, 3, 6) + floor * 1.5) * mult));
  }
}

// Each slot has a guaranteed primary affix, then extras drawn from a slot-flavored
// pool. Arcane weapons flip their rolls to the magic school — finding a great
// staff IS the nudge toward a caster build. Armor pieces lead with ARMOR (the
// mitigation stat is a gear story); HP moved to their extra pool.
const PRIMARY: Record<ItemSlot, keyof Affixes> = {
  weapon: "damage", armor: "armor", helm: "maxHp", boots: "speed", trinket: "crit", charm: "crit",
};
const EXTRA_POOL: Record<ItemSlot, (keyof Affixes)[]> = {
  weapon: ["crit", "speed", "maxHp"],
  armor: ["maxHp", "damage", "spell", "speed", "crit"],
  helm: ["armor", "crit", "damage", "spell"],
  boots: ["maxHp", "armor", "crit"],
  trinket: ["speed", "damage", "spell", "maxHp", "armor"],
  charm: ["damage", "spell", "maxHp", "speed"],
};

// Signature gear (unique passives, sponsor-gated) lives in the System Shop
// catalog now — see catalog.ts LEGENDARY tier.

export function generateItem(rng: Rng, floor: number, nextId: () => number): Item {
  const slot = rollSlot(rng);
  const rarity = rollRarity(rng);
  const mult = rarityMult(rarity) * SLOT_BUDGET[slot];

  // Noun first: the weapon's CLASS decides which school its stats feed.
  // The System's favorite joke: a sliver of epic weapons are just... a Mug.
  const noun =
    slot === "weapon" && rarity === "epic" && nextFloat(rng) < 0.07
      ? "Mug"
      : pick(rng, SLOT_NOUNS[slot]);
  const wclass = slot === "weapon" ? WEAPON_CLASS_BY_NOUN[noun] : undefined;

  const affixes: Affixes = {};
  const primary =
    slot === "weapon" && wclass === "arcane" ? "spell"
    : slot === "weapon" && wclass === "chaotic" ? (nextFloat(rng) < 0.5 ? "spell" : "damage")
    : PRIMARY[slot];
  affixes[primary] = rollAffix(rng, primary, floor, mult);

  const extras = RARITY_AFFIX_COUNT[rarity] - 1;
  const pool = [...EXTRA_POOL[slot]];
  for (let i = 0; i < extras && pool.length > 0; i++) {
    const key = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    affixes[key] = (affixes[key] ?? 0) + rollAffix(rng, key, floor, mult);
  }

  const name = `${pick(rng, RARITY_PREFIX[rarity])} ${noun}`;
  return { id: nextId(), slot, rarity, name, affixes };
}

/** A single scalar used to auto-equip "the better item" and to sort the bag.
 * School-agnostic: both powers count the same (the player curates the build). */
export function itemScore(item: Item): number {
  const a = item.affixes;
  return (
    (a.damage ?? 0) * 2 + (a.spell ?? 0) * 2 + (a.maxHp ?? 0) * 0.5 +
    (a.speed ?? 0) * 25 + (a.crit ?? 0) * 300 + (a.armor ?? 0) * 1.5
  );
}

/** Human-readable affix lines for the inventory UI, e.g. ["+7 ATK", "+4% crit"]. */
export function affixLines(item: Item): string[] {
  const a = item.affixes;
  const out: string[] = [];
  if (a.damage) out.push(`+${a.damage} ATK`);
  if (a.spell) out.push(`+${a.spell} MAG`);
  if (a.maxHp) out.push(`+${a.maxHp} HP`);
  if (a.armor) out.push(`+${a.armor} ARM`);
  if (a.speed) out.push(`+${a.speed.toFixed(2)} SPD`);
  if (a.crit) out.push(`+${Math.round(a.crit * 100)}% crit`);
  return out;
}
