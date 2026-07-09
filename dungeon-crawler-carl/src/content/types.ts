// Crafted-content definitions: what the builder page (/builder.html) produces
// and the game consumes. Pure data — JSON-serializable, deterministic, no DOM.

// A hand-designed room. Tiles use the sim's Tile enum values; props are
// COSMETIC (renderer-only) and reference MODEL_MANIFEST keys. Convention:
// the outer 1-tile border must be floor (value 1) so stamping never seals a
// doorway — the stamper enforces it, the builder warns about it.
export interface RoomTemplate {
  id: string; // unique, kebab-case
  name: string;
  w: number;
  h: number;
  tiles: number[]; // w*h, row-major, Tile enum values
  props: RoomProp[];
  role?: "landmark" | "vault" | "any"; // which room roles it may stamp into
}

export interface RoomProp {
  key: string; // MODEL_MANIFEST key (or generated-manifest key)
  x: number; // tile-space, relative to template origin (fractions allowed)
  y: number;
  rot?: number; // radians around Y
  scale?: number;
}

// A crafted enemy: an existing behavior archetype wearing a chosen body.
// The sim spawns it as its behavior kind (all combat logic inherits) with
// stat multipliers applied; hosts resolve presentation from the def.
export interface CustomMobDef {
  id: string; // unique, kebab-case; Monster.defId points here
  name: string; // ringside-intro display name
  behavior: string; // existing MonsterKind whose AI/verbs to inherit
  // Multipliers over the behavior archetype's floor-scaled baseline.
  hpMult?: number;
  damageMult?: number;
  speedMult?: number;
  xpMult?: number;
  // Presentation (hosts only).
  skin: string; // model key (e.g. "monster_brute") OR a /assets/... GLB url key in the generated manifest
  rig?: "medium" | "large"; // for animation-less skins; omit when clips are baked
  scale?: number;
  tint?: number; // emissive accent, semantic colors preferred
  texture?: string; // alternate texture url (elite-skin mechanism)
  // Spawning.
  bands?: number[]; // 0..5 band indices this mob may roll in
  weight?: number; // relative spawn weight within its band (default 1)
}
