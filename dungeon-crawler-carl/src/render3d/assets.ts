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
  // SEWERS specialists (MOB-CONCEPTS.md wave 2): OrcRaider drums the pack into
  // a frenzy; Hoarder is the fleeing Repo Rat (KayKit Mystery Monthly, CC0).
  monster_drummer: "/assets/characters/orc_raider.glb",
  monster_filcher: "/assets/characters/hoarder.glb",
  // IRONWORKS cast (MOB-CONCEPTS.md): the robot faction clocks in — Robots
  // One/Two, Clanker, ToySoldier, the Animatronics (all Mystery Monthly, CC0).
  monster_lineworker: "/assets/characters/robot_one.glb",
  monster_sentinel: "/assets/characters/robot_two.glb",
  monster_slagbreaker: "/assets/characters/clanker.glb",
  monster_toysoldier: "/assets/characters/toy_soldier.glb",
  monster_greeter: "/assets/characters/animatronic.glb",
  monster_greeter_elite: "/assets/characters/animatronic_creepy.glb", // the broken one
  // GARDEN cast (MOB-CONCEPTS.md): the lasher shares the PlantWarrior body
  // (same species, different job); Werewolf_Man is the pre-morph understudy
  // (the morph swaps its kind to charger = the werewolf model); Tiefling
  // is the Briar Witch.
  monster_lasher: "/assets/characters/plant_warrior.glb",
  monster_understudy: "/assets/characters/werewolf_man.glb",
  monster_hexer: "/assets/characters/tiefling.glb",
  // UNDERCROFT trainers (MOB-CONCEPTS.md): the last two Skeletons 1.1
  // characters + the Caveman join the crypt shift.
  monster_cutpurse: "/assets/characters/skeleton_rogue.glb",
  monster_warden: "/assets/characters/skeleton_golem.glb",
  monster_digger: "/assets/characters/caveman.glb",
  // RUINS cast (MOB-CONCEPTS.md): the dead civilization's staff — Paladin
  // (helmeted variant = elite skin), Cleric, Lorekeeper, and the 4GTN golems.
  monster_shieldbearer: "/assets/characters/paladin.glb",
  monster_shieldbearer_elite: "/assets/characters/paladin_helmet.glb",
  monster_cleric: "/assets/characters/cleric.glb",
  monster_archivist: "/assets/characters/lorekeeper.glb",
  monster_colossus: "/assets/characters/4gtn.glb",
  monster_colossus_elite: "/assets/characters/4gtn_forgotten.glb",
  // THE APPROACH cast (MOB-CONCEPTS.md): the season-finale roster — Ninja,
  // Marksman, AvianSwordsman, MagicalGirl, Superhero, and the Monster/
  // MonsterCostume pair (the beast + the guy who was inside it).
  monster_stagehand: "/assets/characters/ninja.glb",
  monster_sniper: "/assets/characters/marksman.glb",
  monster_duelist: "/assets/characters/avian_swordsman.glb",
  monster_darling: "/assets/characters/magical_girl.glb",
  monster_canceled: "/assets/characters/superhero.glb",
  monster_suitactor: "/assets/characters/beast.glb",
  monster_suitguy: "/assets/characters/beast_costume.glb",
  monster_boss: "/assets/characters/skeleton_warrior.glb",
  // Band-boss arenas + the finale get named menaces (keyed by floor). All are
  // reuses of characters already in the cast — no new asset files.
  monster_boss_3: "/assets/characters/necromancer.glb", // The Crypt Concierge
  monster_boss_6: "/assets/characters/black_knight.glb", // The Sump King
  monster_boss_9: "/assets/characters/plant_warrior.glb", // The Topiary Warden
  monster_boss_12: "/assets/characters/frost_golem.glb", // The Condemned Architect
  monster_boss_15: "/assets/characters/orc_brute.glb", // The Furnace Marshal
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
      // Interior richness (KayKit Dungeon Remastered 1.1 + Resource Bits, CC0):
      // libraries, tavern camps, band-colored gate banners, and vault hoards.
      "bookcase_single", "bookcase_double_decorateda", "shelf_small_books", "book_single",
      "bartop_a_medium", "keg_decorated", "stool_round", "plate_stack",
      "chest_large_gold", "chest_mimic", "table_round_medium",
      "banner_green", "banner_blue", "banner_brown", "banner_white",
      "gold_bars_stack_medium", "gems_pile_large", "money_pile_medium", "gems_chest",
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
      // Open-air Garden walls (Forest Hill_Cliff kit + extra flora, Halloween
      // fence_gate — all CC0; design in BIOMES.md "Open-air districts")
      "cliff_side_b", "cliff_side_d", "cliff_side_f", "cliff_side_h",
      "cliff_inner_a", "cliff_inner_c", "cliff_inner_g", "cliff_inner_i",
      "cliff_outer_a", "cliff_outer_c", "cliff_outer_g", "cliff_outer_i",
      "forest_tree_4_a", "forest_rock_5_a", "forest_rock_5_c", "fence_gate",
      // Typed projectiles + trinket loot (Mystery Monthly Clown / Plant
      // Warrior, Fantasy Weapons arrow, Resource Bits gem — all CC0; see
      // ASSETS.md)
      "plant_warrior_arrow", "clown_bomb",
      "weapon_arrow_a", "gem_medium",
      // Drum Sergeant's kit (Orc Raider pack props, CC0): grafted onto the
      // drummer's handslots in buildMonsterMesh so the band LOOKS like a band.
      "orc_wardrum", "orc_wardrum_stick",
      // Ability-presentation props (Adventurers 2.0, CC0; GENERATION-BACKLOG):
      // the flask's bottle and the blink smokebomb anchor.
      "potion_medium_red", "smokebomb",
      // Spell-FX mesh kit (Meshy-generated, GENERATION-BACKLOG 3b): sculpted
      // effect meshes the juice layer animates; procedural fallbacks remain.
      "fx_nova_ring", "fx_cataclysm_crown",
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
  monster_drummer: "medium", // OrcRaider
  monster_filcher: "medium", // Hoarder
  monster_lineworker: "medium", // Robot_One
  monster_sentinel: "medium", // Robot_Two
  monster_slagbreaker: "large", // Clanker — the big walker
  monster_toysoldier: "medium", // ToySoldier
  monster_greeter: "medium", // Animatronic_Normal
  monster_greeter_elite: "medium", // Animatronic_Creepy
  monster_lasher: "medium", // PlantWarrior (shared body, different job)
  monster_understudy: "medium", // Werewolf_Man (pre-morph)
  monster_hexer: "medium", // Tiefling
  monster_cutpurse: "medium", // Skeleton_Rogue
  monster_warden: "large", // Skeleton_Golem — the big bone furniture
  monster_digger: "medium", // Caveman
  monster_shieldbearer: "medium", // Paladin
  monster_shieldbearer_elite: "medium", // Paladin_with_Helmet
  monster_cleric: "medium", // Cleric
  monster_archivist: "medium", // Lorekeeper
  monster_colossus: "large", // 4GTN — animate masonry
  monster_colossus_elite: "large", // 4GTN_Forgotten
  monster_stagehand: "medium", // Ninja
  monster_sniper: "medium", // Marksman
  monster_duelist: "medium", // AvianSwordsman
  monster_darling: "medium", // MagicalGirl
  monster_canceled: "medium", // Superhero
  monster_suitactor: "medium", // Monster (the suit)
  monster_suitguy: "medium", // MonsterCostume (the guy)
  monster_boss_3: "medium", // Necromancer (as The Crypt Concierge)
  monster_boss_6: "large", // BlackKnight
  monster_boss_9: "medium", // PlantWarrior (as The Topiary Warden)
  monster_boss_12: "large", // FrostGolem
  monster_boss_15: "large", // OrcBrute (as The Furnace Marshal)
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
    // 2026-07-08 (GENERATION-BACKLOG): the previously-untapped packs. New
    // verbs for the animator: Sneaking/Crawling (filcher stealth), the full
    // dodge set, Lockpicking, sit/lie/wave (future safe-room NPCs).
    "/assets/characters/rig_medium_movementadvanced.glb",
    "/assets/characters/rig_medium_simulation.glb",
    "/assets/characters/rig_medium_tools.glb",
  ],
  large: [
    "/assets/characters/rig_large_general.glb",
    "/assets/characters/rig_large_movementbasic.glb",
    "/assets/characters/rig_large_combatmelee.glb",
    // 2026-07-08: dodge set, Flexing, and EXPERIMENTAL_Large_Transform —
    // the natural boss phase-transition act (see the presentation audit).
    "/assets/characters/rig_large_movementadvanced.glb",
    "/assets/characters/rig_large_simulation.glb",
    "/assets/characters/rig_large_special.glb",
  ],
};

// Hero-skin model keys (Adventurers 1.0, baked clips) and extra ability clips
// appended to them. The extra clips are AI-generated via the asset pipeline
// (Meshy preset clip retargeted onto the Adventurers rig by
// tools/asset-pipeline/blender/retarget_clip.py — provenance in ASSETS.md);
// they bind to each skin's skeleton by bone name, same as the rig libraries.
const HERO_SKIN_KEYS = ["player", "armory_axes", "armory_arcana", "armory_knives", "hero_hooded"];
const HERO_CLIP_MANIFEST = ["/assets/characters/extradition.glb"];

export async function loadModels(): Promise<Record<string, LoadedModel>> {
  const loader = new GLTFLoader();
  const out: Record<string, LoadedModel> = {};
  // Rig clip libraries load alongside the models; each library GLB carries a
  // mannequin we discard — only its AnimationClips matter.
  const rigClips: Record<"medium" | "large", import("three").AnimationClip[]> = { medium: [], large: [] };
  const heroClips: import("three").AnimationClip[] = [];
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
    ...HERO_CLIP_MANIFEST.map(async (url) => {
      try {
        heroClips.push(...(await loader.loadAsync(url)).animations);
      } catch {
        // Missing ability clip: the animator's playFirst fallbacks cover it.
      }
    }),
  ]);
  // Attach the shared library to every animation-less rig-based character.
  // Clips bind to each model's own skeleton by node name at mixer time, so
  // one clip array can serve many characters.
  for (const [key, rig] of Object.entries(CHARACTER_RIGS)) {
    const m = out[key];
    if (m && m.animations.length === 0) m.animations = rigClips[rig];
  }
  // Hero skins already have baked clips (the merge above skips them), so the
  // extra ability clips are APPENDED rather than gated on animations.length.
  if (heroClips.length > 0) {
    for (const key of HERO_SKIN_KEYS) {
      const m = out[key];
      if (m) m.animations = [...m.animations, ...heroClips];
    }
  }
  return out;
}
