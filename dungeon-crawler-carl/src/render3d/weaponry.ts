import type { Item, Player, Rarity } from "../sim/types";

// Visible equipment: map the sim's item names onto the weapon/shield meshes that
// ship INSIDE the KayKit character GLBs. Every rigged character carries its class
// arsenal as toggleable nodes parented to `handslot.l/r` bones, so a weapon from
// one model can be grafted onto another's hand and it rides the animations.

/** Every attachment node we know about, per source model (manifest key).
 * The armory_* keys point at the 1.0 barbarian/mage/rogue GLBs, kept loaded
 * purely as weapon-mesh sources now that monsters wear the newer KayKit cast
 * (which ships clean bodies with no arsenal nodes). */
export const ATTACHMENT_NODES: Record<string, string[]> = {
  player: ["1H_Sword", "2H_Sword", "1H_Sword_Offhand", "Badge_Shield", "Rectangle_Shield", "Round_Shield", "Spike_Shield"],
  armory_axes: ["1H_Axe", "2H_Axe", "1H_Axe_Offhand", "Mug"], // barbarian.glb
  armory_arcana: ["1H_Wand", "2H_Staff", "Spellbook", "Spellbook_open"], // mage.glb
  armory_knives: ["Knife", "Knife_Offhand", "1H_Crossbow", "2H_Crossbow", "Throwable"], // rogue.glb
};

/** What each character shows when nothing special is equipped (one clean loadout). */
export const CANONICAL_LOADOUT: Record<string, string[]> = {
  player: ["1H_Sword", "Round_Shield"],
};

interface WeaponVisual {
  srcKey: string; // model whose GLB holds the node
  node: string;
  twoHanded?: boolean; // hides the shield
}

/** Weapon noun -> mesh. Rare+ one-handers upgrade to their two-handed cousin. */
const WEAPON_VISUALS: Record<string, { base: WeaponVisual; heavy?: WeaponVisual }> = {
  Blade: { base: { srcKey: "player", node: "1H_Sword" }, heavy: { srcKey: "player", node: "2H_Sword", twoHanded: true } },
  Axe: { base: { srcKey: "armory_axes", node: "1H_Axe" }, heavy: { srcKey: "armory_axes", node: "2H_Axe", twoHanded: true } },
  Maul: { base: { srcKey: "armory_axes", node: "2H_Axe", twoHanded: true } },
  Spear: { base: { srcKey: "armory_arcana", node: "2H_Staff", twoHanded: true } },
  Cleaver: { base: { srcKey: "armory_knives", node: "Knife" } },
  Wand: { base: { srcKey: "armory_arcana", node: "1H_Wand" } },
  Staff: { base: { srcKey: "armory_arcana", node: "2H_Staff", twoHanded: true } },
  Crossbow: { base: { srcKey: "armory_knives", node: "1H_Crossbow" }, heavy: { srcKey: "armory_knives", node: "2H_Crossbow", twoHanded: true } },
  Mug: { base: { srcKey: "armory_axes", node: "Mug" } },
};

/** Armor noun -> which of the Knight's shields you carry. */
const SHIELD_BY_ARMOR: Record<string, string> = {
  Plate: "Rectangle_Shield",
  Hauberk: "Round_Shield",
  Carapace: "Spike_Shield",
  Aegis: "Badge_Shield",
  Vest: "Round_Shield",
};

function noun(item: Item): string {
  const parts = item.name.split(" ");
  return parts[parts.length - 1];
}

/** Resolve a player's equipped items to the meshes their model should show.
 * (You hold what you EQUIPPED — since weapon classes became mechanical
 * (DESIGN 5.8), a crossbow in hand means a crossbow in the weapon slot; the
 * old Deadeye-stance visual override would lie about your bolt profile.) */
export function loadoutFor(p: Player): { weapon: WeaponVisual; shield: string | null } {
  const w = p.equipment.weapon;
  const spec = w ? WEAPON_VISUALS[noun(w)] : undefined;
  const heavy = w && (w.rarity === "rare" || w.rarity === "epic");
  const weapon: WeaponVisual =
    spec ? (heavy && spec.heavy ? spec.heavy : spec.base) : { srcKey: "player", node: "1H_Sword" };
  const armorNoun = p.equipment.armor ? noun(p.equipment.armor) : null;
  const shield = weapon.twoHanded
    ? null
    : (armorNoun && SHIELD_BY_ARMOR[armorNoun]) || "Round_Shield";
  return { weapon, shield };
}

/** Emissive flair per rarity (0 = none). */
/**
 * Model node for an item lying ON THE GROUND (loot drops): weapons show the
 * actual mesh you'd equip; armor shows its shield. Null = no model (trinkets).
 */
export function groundVisualFor(item: Item): { srcKey: string; node: string } | null {
  const n = noun(item);
  if (item.slot === "weapon") {
    const spec = WEAPON_VISUALS[n];
    if (!spec) return null;
    const v = (item.rarity === "rare" || item.rarity === "epic") && spec.heavy ? spec.heavy : spec.base;
    return { srcKey: v.srcKey, node: v.node };
  }
  if (item.slot === "armor") {
    const shield = SHIELD_BY_ARMOR[n];
    return shield ? { srcKey: "player", node: shield } : null;
  }
  return null;
}

export function rarityGlow(rarity: Rarity | undefined): { color: number; intensity: number } | null {
  switch (rarity) {
    case "magic": return { color: 0x2255cc, intensity: 0.35 };
    case "rare": return { color: 0xc9a24b, intensity: 0.45 };
    case "epic": return { color: 0x8844ff, intensity: 0.6 };
    default: return null;
  }
}
