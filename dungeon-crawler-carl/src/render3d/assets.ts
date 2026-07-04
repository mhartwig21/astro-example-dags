import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Asset loading seam. The renderer prefers real glTF models when they are present
// under /public/assets (see ASSETS.md + scripts/fetch-assets.sh for the CC0 packs
// this expects), and otherwise falls back to procedural low-poly meshes so the game
// always renders. This lets us confirm art direction now and swap in artwork later
// without touching gameplay or scene-graph wiring.

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

// Optional model manifest. Paths are relative to the site root (Vite `public/`).
// Missing files are handled gracefully — the renderer uses procedural stand-ins.
export const MODEL_MANIFEST: Record<string, string> = {
  player: "/assets/characters/adventurer.glb",
  skeleton: "/assets/characters/skeleton.glb",
  // Per-archetype monster skins (fall back to `skeleton` when absent).
  // The newer KayKit generation (Mystery Monthly + Skeletons 1.1) ships
  // characters WITHOUT baked animations — they play the shared rig clip
  // libraries below (see CHARACTER_RIGS / RIG_CLIP_MANIFEST).
  monster_swarmer: "/assets/characters/skeleton_minion.glb",
  monster_brute: "/assets/characters/orc_brute.glb",
  monster_ranged: "/assets/characters/skeleton_mage.glb",
  monster_bomber: "/assets/characters/clown.glb", // the System loves its clowns
  monster_shaman: "/assets/characters/witch.glb",
  monster_phantom: "/assets/characters/vampire.glb",
  monster_charger: "/assets/characters/werewolf.glb",
  monster_spitter: "/assets/characters/plant_warrior.glb",
  monster_necromancer: "/assets/characters/necromancer.glb",
  monster_boss: "/assets/characters/skeleton_warrior.glb",
  // City-boss arenas + the finale get named menaces (keyed by floor).
  monster_boss_6: "/assets/characters/black_knight.glb",
  monster_boss_12: "/assets/characters/frost_golem.glb",
  monster_boss_18: "/assets/characters/demon_lord.glb",
  // Armory sources: the 1.0 adventurer GLBs. They carry the weapon/shield
  // meshes weaponry.ts grafts onto hands, AND they are the barbarian/mage/
  // rogue hero skins (heroSkin in sim/game.ts) now that monsters wear the
  // newer KayKit cast instead.
  armory_axes: "/assets/characters/barbarian.glb",
  armory_arcana: "/assets/characters/mage.glb",
  armory_knives: "/assets/characters/rogue.glb",
  // Extra hero skin: the one adventurer nothing else wears.
  hero_hooded: "/assets/characters/rogue_hooded.glb",
  wall: "/assets/dungeon/wall.glb",
  floor: "/assets/dungeon/floor.glb",
  stairs: "/assets/dungeon/stairs.glb",
  // Theme-band tiles + props (see render3d/floorThemes.ts). Keys match filenames.
  ...Object.fromEntries(
    [
      // floors (floor_tile_small_decorated is banned: candles baked into the model)
      "floor_dirt_small_A", "floor_dirt_small_weeds",
      "floor_tile_small_broken_A", "floor_tile_small_broken_B", "floor_tile_grate",
      "floor_tile_large", "floor_tile_big_spikes",
      // walls
      "wall_cracked", "wall_broken", "wall_scaffold", "wall_arched",
      // stairs
      "stairs_narrow", "stairs_walled", "stairs_wide", "stairs_wood_decorated",
      // props
      "barrel_small", "box_small", "crates_stacked", "coin", "key",
      "barrel_large", "bottle_A_green", "rubble_half", "trunk_small_A",
      "rubble_large", "column", "sword_shield_broken",
      "keg", "box_large", "shelf_small", "table_medium_broken",
      "banner_red", "banner_shield_red", "pillar_decorated", "chest_gold",
      // rule-based dressing (torch anchors, vault treasure, landmark monument)
      // table_small_decorated_A is banned: candles baked into the model.
      "torch_lit", "torch_mounted", "coin_stack_small", "coin_stack_medium",
      "coin_stack_large",
      // THE GARDEN band (KayKit Halloween Bits, CC0 — see ASSETS.md)
      "floor_dirt", "floor_dirt_grave", "floor_dirt_small",
      "tree_dead_large", "tree_dead_medium", "tree_dead_small",
      "gravestone", "grave_A", "grave_B", "gravemarker_A", "crypt",
      "lantern_standing", "bench", "pumpkin_orange", "pumpkin_orange_small",
      "ribcage", "bone_A",
      // DemonLord's arena set-piece (KayKit Monthly, CC0)
      "summoning_circle",
      // Equippable weapon meshes (KayKit Fantasy Weapons Bits, CC0). Grafted
      // whole-scene onto handslots (weaponry.ts uses node "*" for these).
      "weapon_sword_a", "weapon_sword_e", "weapon_axe_a", "weapon_axe_c",
      "weapon_hammer_b", "weapon_spear_a", "weapon_halberd", "weapon_dagger_a",
      "weapon_wand_a", "weapon_staff_b", "weapon_staff_d",
      // THE GARDEN goes green (KayKit Forest Nature Pack, CC0 — see ASSETS.md)
      "forest_tree_1_a", "forest_tree_1_b", "forest_tree_2_a", "forest_tree_3_a",
      "forest_tree_5_a", "forest_tree_bare_1_a",
      "forest_bush_1_a", "forest_bush_2_a", "forest_bush_4_a",
      "forest_rock_1_a", "forest_rock_3_c", "forest_rock_6_a",
      "forest_grass_1_a", "forest_grass_2_a",
    ].map((name) => [name, `/assets/dungeon/${name}.glb`]),
  ),
};

// Animation-less characters and the rig whose shared clip library animates
// them. KayKit's Medium and Large rigs use identical bone NAMES (clips bind
// by name), differing only in proportions — matching the rig keeps feet
// planted and hands where the clip expects them.
export const CHARACTER_RIGS: Record<string, "medium" | "large"> = {
  monster_swarmer: "medium", // Skeleton_Minion
  monster_brute: "large", // OrcBrute
  monster_bomber: "medium", // Clown
  monster_shaman: "medium", // Witch
  monster_phantom: "medium", // Vampire
  monster_charger: "medium", // Werewolf
  monster_spitter: "medium", // PlantWarrior
  monster_necromancer: "medium", // Necromancer
  monster_boss_6: "large", // BlackKnight
  monster_boss_12: "large", // FrostGolem
  monster_boss_18: "large", // DemonLord
};

// Shared rig clip libraries (KayKit Character Animations 1.1 + DemonLord pack).
// Loaded once; their AnimationClips are appended to every character on that rig.
const RIG_CLIP_MANIFEST: Record<"medium" | "large", string[]> = {
  medium: [
    "/assets/characters/rig_medium_general.glb",
    "/assets/characters/rig_medium_movementbasic.glb",
    "/assets/characters/rig_medium_combatmelee.glb",
    "/assets/characters/rig_medium_combatranged.glb",
    "/assets/characters/rig_medium_special.glb",
  ],
  large: [
    "/assets/characters/rig_large_general.glb",
    "/assets/characters/rig_large_movementbasic.glb",
    "/assets/characters/rig_large_combatmelee.glb",
  ],
};

export async function loadModels(): Promise<Record<string, LoadedModel>> {
  const loader = new GLTFLoader();
  const out: Record<string, LoadedModel> = {};
  // Rig clip libraries load alongside the models; each library GLB carries a
  // mannequin we discard — only its AnimationClips matter.
  const rigClips: Record<"medium" | "large", import("three").AnimationClip[]> = { medium: [], large: [] };
  await Promise.all([
    ...Object.entries(MODEL_MANIFEST).map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        out[key] = { scene: gltf.scene, animations: gltf.animations };
      } catch {
        // File absent or failed to parse — leave it out; renderer falls back.
      }
    }),
    ...(Object.keys(RIG_CLIP_MANIFEST) as ("medium" | "large")[]).map(async (rig) => {
      // Per-pack slots keep the clip order stable regardless of which fetch
      // finishes first — the renderer's regex fallbacks are order-sensitive.
      const slots = await Promise.all(
        RIG_CLIP_MANIFEST[rig].map(async (url) => {
          try {
            return (await loader.loadAsync(url)).animations;
          } catch {
            // Missing clip pack: rig-based characters just animate with less variety.
            return [];
          }
        }),
      );
      rigClips[rig] = slots.flat();
    }),
  ]);
  // Attach the shared library to every animation-less rig-based character.
  // Clips bind to each model's own skeleton by node name at mixer time, so
  // one clip array can serve many characters.
  for (const [key, rig] of Object.entries(CHARACTER_RIGS)) {
    const m = out[key];
    if (m && m.animations.length === 0) m.animations = rigClips[rig];
  }
  return out;
}
