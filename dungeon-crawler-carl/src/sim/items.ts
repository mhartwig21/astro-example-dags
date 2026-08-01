import { CONFIG, RARITIES } from "./config";
import { CATALOG, CATALOG_BY_ID, gearAffixes, type CatalogEntry } from "./catalog";
import { nextFloat, nextInt, pick, type Rng } from "./rng";
import { EQUIP_SLOTS, type Affixes, type Item, type ItemSlot, type PassiveId, type Player, type Rarity } from "./types";
import type { School } from "./abilities";

/** True if any equipped item carries the given signature-gear passive.
 * Lives here (not game.ts) so the ability param functions can read it too. */
export function hasPassive(p: Player, id: PassiveId): boolean {
  return EQUIP_SLOTS.some((slot) => p.equipment[slot]?.passive === id);
}

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
  Shears: "swift", // Rootcutter Shears (boss unique)
  Axe: "heavy", Maul: "heavy", Head: "heavy", Permit: "heavy", // Sledge Head / Demolition Permit
  Spear: "reach", Rebuttal: "reach", // Rebar Spear / Pikeman's Rebuttal
  Crossbow: "ballistic", Trigger: "ballistic", Order: "ballistic", // Stock and Trigger / Court Order
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

// COMMODITY-ONLY path (ITEMIZATION-V2 §2.1): RARITIES.mult never touches a
// catalog item — no `catalogId` flows through rarityMult/generateItem. The
// catalog path multiplies CONFIG.catalogQualityMult over gearAffixes instead.
function rarityMult(rarity: Rarity): number {
  return RARITIES.find((r) => r.name === rarity)!.mult;
}

export function rollRarity(rng: Rng): Rarity {
  const total = RARITIES.reduce((s, r) => s + r.weight, 0);
  let r = nextFloat(rng) * total;
  for (const tier of RARITIES) if ((r -= tier.weight) < 0) return tier.name;
  return "common";
}

/** QUALITY roll for catalog drops (§2.1): same seeded 64/26/8/2 weights, but
 * the multiplier applied later is catalogQualityMult, never RARITIES.mult. */
export function rollCatalogQuality(rng: Rng): Rarity {
  return rollRarity(rng);
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
      // gearPowerMult: gear owns ~half the power stat since the build-matters
      // pass (damagePerLevel came down in tandem — see config.ts).
      return Math.max(1, Math.round((nextInt(rng, 2, 4) + floor) * mult * CONFIG.gearPowerMult));
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
  // V2 (§2.2): commodity gear is DEMOTED to commons/magics — no epic affix
  // soup. Rarity thrill lives on catalog identities now (quality rolls); a
  // commodity piece exists to be worn for two floors, then dismantled.
  const rolled = rollRarity(rng);
  const rarity: Rarity = rolled === "rare" || rolled === "epic" ? "magic" : rolled;
  const mult = rarityMult(rarity) * SLOT_BUDGET[slot];

  // Noun first: the weapon's CLASS decides which school its stats feed.
  // The System's favorite joke: a sliver of magic weapons are just... a Mug.
  const noun =
    slot === "weapon" && rarity === "magic" && nextFloat(rng) < 0.05
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

/** The damage school a weapon's stats feed: arcane → magic, chaotic → null
 * (wildcard — the Mug plays both sides), everything else physical. */
export function weaponSchoolOf(item: Item): "physical" | "magic" | null {
  const wc = weaponClassOf(item);
  if (wc === "arcane") return "magic";
  if (wc === "chaotic") return null;
  return "physical";
}

/**
 * Should a picked-up/gifted item replace what's worn WITHOUT being asked?
 * Non-weapons: plain score compare. Weapons additionally require SCHOOL
 * agreement with the current weapon — auto-equip never swaps a melee build
 * onto a wand (or a caster onto a maul). Cross-school weapons still drop and
 * still stash; SWITCHING schools is a decision the player makes by hand
 * (gear coherence: off-class melee swings at offclassMeleeDmgMult, so the
 * game must not walk anyone into the penalty). The Mug matches either side.
 * `school` (the crawler's dominant school) biases the compare so a caster's
 * auto-equip stops valuing dead attack power at full price — V2 §1.2.
 */
export function wantsAutoEquip(item: Item, worn: Item | null | undefined, school?: School | null): boolean {
  if (!worn) return true;
  if (item.slot === "weapon" && worn.slot === "weapon") {
    const a = weaponSchoolOf(item);
    const b = weaponSchoolOf(worn);
    if (a !== null && b !== null && a !== b) return false;
  }
  return itemScore(item, school) > itemScore(worn, school);
}

/**
 * itemScore bonus per passive, BY TIER (V2 §5 Phase A). A flat +30 made a T2
 * Grounded Suit and a drop-only boss unique worth exactly the same, so
 * auto-equip would happily bench a chase item for an advanced piece with a
 * marginally fatter stat line — the precise failure §1.2 named as the reason
 * to touch itemScore at all. Chase uniques are the run's want-list; the score
 * has to know that.
 */
const PASSIVE_SCORE_BY_TIER: Record<CatalogEntry["tier"], number> = {
  consumable: 15, starter: 15, basic: 15, advanced: 25, legendary: 60,
};
const PASSIVE_SCORE_DROP_ONLY = 80; // boss uniques: the chase outranks the shelf
const PASSIVE_SCORE_UNTIERED = 25; // a passive with no catalog identity behind it

function passiveScore(item: Item): number {
  if (!item.passive) return 0;
  const entry = item.catalogId ? CATALOG_BY_ID[item.catalogId] : undefined;
  if (!entry) return PASSIVE_SCORE_UNTIERED;
  return entry.dropOnly ? PASSIVE_SCORE_DROP_ONLY : PASSIVE_SCORE_BY_TIER[entry.tier];
}

/** A single scalar used to auto-equip "the better item" and to sort the bag.
 * With no `school` both powers count the same; given the crawler's dominant
 * school, off-school power counts half. Passives add a tier-scaled bonus. */
export function itemScore(item: Item, school?: School | null): number {
  const a = item.affixes;
  const dmgW = school === "magic" ? 1 : 2;
  const spellW = school === "physical" ? 1 : 2;
  return (
    (a.damage ?? 0) * dmgW + (a.spell ?? 0) * spellW + (a.maxHp ?? 0) * 0.5 +
    (a.speed ?? 0) * 25 + (a.crit ?? 0) * 300 + (a.armor ?? 0) * 1.5 +
    passiveScore(item)
  );
}

// ---- ITEMIZATION V2 (§2.1/§2.2): catalog drops with quality on top ----

/** Fallback bonus-affix pools per slot for catalog entries without a curated
 * `bonusPool` — 3 keys each, readable on a card. */
const DEFAULT_BONUS_POOL: Record<ItemSlot, (keyof Affixes)[]> = {
  weapon: ["crit", "speed", "maxHp"],
  armor: ["maxHp", "speed", "crit"],
  helm: ["armor", "crit", "maxHp"],
  boots: ["maxHp", "armor", "crit"],
  trinket: ["speed", "maxHp", "armor"],
  charm: ["maxHp", "speed", "crit"],
};

/**
 * Materialize a catalog entry's affixes at a given QUALITY (§2.1): the printed
 * line (gearAffixes: floor-scaled) x catalogQualityMult, plus quality-count
 * bonus affixes rolled from the item's curated pool at commodity-common
 * magnitude — a hot roll of the item you already wanted, never affix soup.
 * NEVER applies RARITIES.mult (that's the commodity path's whole story).
 */
export function catalogQualityAffixes(rng: Rng, entry: CatalogEntry, floor: number, quality: Rarity): Affixes {
  const mult = CONFIG.catalogQualityMult[quality];
  const base = gearAffixes(entry, floor);
  const out: Affixes = {};
  if (base.damage) out.damage = Math.round(base.damage * mult);
  if (base.spell) out.spell = Math.round(base.spell * mult);
  if (base.maxHp) out.maxHp = Math.round(base.maxHp * mult);
  if (base.armor) out.armor = Math.round(base.armor * mult);
  if (base.speed) out.speed = +(base.speed * Math.min(mult, 1.3)).toFixed(2);
  if (base.crit) out.crit = +(base.crit * Math.min(mult, 1.3)).toFixed(3);
  const bonuses = CONFIG.catalogQualityBonusAffixes[quality];
  const pool = [...(entry.bonusPool ?? DEFAULT_BONUS_POOL[entry.slot ?? "trinket"])];
  for (let i = 0; i < bonuses && pool.length > 0; i++) {
    const key = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    const roll = rollAffix(rng, key, floor, 1);
    out[key] = +(((out[key] ?? 0) + roll)).toFixed(key === "speed" ? 2 : key === "crit" ? 3 : 0);
  }
  return out;
}

/** Materialize one catalog entry as a dropped Item at rolled/given quality. */
export function makeQualityCatalogItem(
  rng: Rng, entry: CatalogEntry, floor: number, nextId: () => number, quality?: Rarity,
): Item {
  const q = quality ?? rollCatalogQuality(rng);
  return {
    id: nextId(),
    slot: entry.slot!,
    rarity: q, // quality REUSES the rarity field (§2.1 data shape)
    name: entry.name,
    affixes: catalogQualityAffixes(rng, entry, floor, q),
    passive: entry.passive,
    catalogId: entry.id,
  };
}

/**
 * Roll a catalog drop (§2.2): a seeded entry of the given tier at rolled
 * quality. Drop-only boss uniques never roll here — the chase is earned in the
 * arena, not on the loot table.
 */
export function rollCatalogDrop(
  rng: Rng, floor: number, tier: "basic" | "advanced", nextId: () => number,
): Item {
  const pool = CATALOG.filter((e) => e.tier === tier && !e.dropOnly && e.slot);
  const entry = pool[nextInt(rng, 0, pool.length - 1)];
  return makeQualityCatalogItem(rng, entry, floor, nextId);
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
