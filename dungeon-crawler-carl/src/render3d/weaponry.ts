import type { Item, Player, Rarity } from "../sim/types";

// Visible equipment: map the sim's item names onto the weapon/shield meshes that
// ship INSIDE the KayKit character GLBs. Every rigged character carries its class
// arsenal as toggleable nodes parented to `handslot.l/r` bones, so a weapon from
// one model can be grafted onto another's hand and it rides the animations.

/** Every attachment node we know about, per source model (manifest key). */
export const ATTACHMENT_NODES: Record<string, string[]> = {
  player: ["1H_Sword", "2H_Sword", "1H_Sword_Offhand", "Badge_Shield", "Rectangle_Shield", "Round_Shield", "Spike_Shield"],
  monster_bomber: ["1H_Axe", "2H_Axe", "1H_Axe_Offhand", "Mug"], // barbarian.glb
  monster_shaman: ["1H_Wand", "2H_Staff", "Spellbook", "Spellbook_open"], // mage.glb
  monster_phantom: ["Knife", "Knife_Offhand", "1H_Crossbow", "2H_Crossbow", "Throwable"], // rogue.glb
};

/** What each character shows when nothing special is equipped (one clean loadout). */
export const CANONICAL_LOADOUT: Record<string, string[]> = {
  player: ["1H_Sword", "Round_Shield"],
  monster_bomber: ["1H_Axe"],
  monster_shaman: ["2H_Staff"],
  monster_phantom: ["Knife"],
};

interface WeaponVisual {
  srcKey: string; // model whose GLB holds the node
  node: string;
  twoHanded?: boolean; // hides the shield
}

/** Weapon noun -> mesh. Rare+ one-handers upgrade to their two-handed cousin. */
const WEAPON_VISUALS: Record<string, { base: WeaponVisual; heavy?: WeaponVisual }> = {
  Blade: { base: { srcKey: "player", node: "1H_Sword" }, heavy: { srcKey: "player", node: "2H_Sword", twoHanded: true } },
  Axe: { base: { srcKey: "monster_bomber", node: "1H_Axe" }, heavy: { srcKey: "monster_bomber", node: "2H_Axe", twoHanded: true } },
  Maul: { base: { srcKey: "monster_bomber", node: "2H_Axe", twoHanded: true } },
  Spear: { base: { srcKey: "monster_shaman", node: "2H_Staff", twoHanded: true } },
  Cleaver: { base: { srcKey: "monster_phantom", node: "Knife" } },
  Wand: { base: { srcKey: "monster_shaman", node: "1H_Wand" } },
  Staff: { base: { srcKey: "monster_shaman", node: "2H_Staff", twoHanded: true } },
  Crossbow: { base: { srcKey: "monster_phantom", node: "1H_Crossbow" }, heavy: { srcKey: "monster_phantom", node: "2H_Crossbow", twoHanded: true } },
  Mug: { base: { srcKey: "monster_bomber", node: "Mug" } },
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

/** Resolve a player's equipped items to the meshes their model should show. */
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
export function rarityGlow(rarity: Rarity | undefined): { color: number; intensity: number } | null {
  switch (rarity) {
    case "magic": return { color: 0x2255cc, intensity: 0.35 };
    case "rare": return { color: 0xc9a24b, intensity: 0.45 };
    case "epic": return { color: 0x8844ff, intensity: 0.6 };
    default: return null;
  }
}
