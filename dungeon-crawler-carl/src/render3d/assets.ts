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
  // CHAMPION tier (boss layer 1): The Foreman is the CombatMech — the last
  // Mystery Monthly mob-grade character in the collection takes the stage.
  monster_foreman: "/assets/characters/combat_mech.glb",
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
  // CHOSEN crawler looks (Adventurers 2.0, CC0): the campfire check-in lineup.
  // New-generation GLBs — no baked clips, they ride the medium rig libraries
  // via CHARACTER_RIGS like the monster cast does.
  crawler_knight: "/assets/characters/crawler_knight.glb",
  crawler_barbarian: "/assets/characters/crawler_barbarian.glb",
  crawler_druid: "/assets/characters/crawler_druid.glb",
  crawler_engineer: "/assets/characters/crawler_engineer.glb",
  crawler_mage: "/assets/characters/crawler_mage.glb",
  crawler_ranger: "/assets/characters/crawler_ranger.glb",
  crawler_rogue: "/assets/characters/crawler_rogue.glb",
  crawler_hooded: "/assets/characters/crawler_rogue_hooded.glb",
  // Roam mode (SETTLEMENTS.md v1): the settlement's one resident. Reuses a
  // skeleton-family model unwired to any monster or hero skin — a v1 rough
  // edge (it reads skeleton-like) rather than new asset work.
  npc_settlement: "/assets/characters/skeleton_rogue.glb",
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
      // Room purposes wave 2 (vignette grammar): barracks / kitchen / forge /
      // apothecary furniture. Dungeon Remastered + Restaurant Bits + Resource
      // Bits + Block Bits + Adventurers 2.0 (all CC0 — see ASSETS.md).
      "bed_a_single", "bed_b_single", "bed_floor", "bed_decorated", "chair",
      "plate_food_a", "plate_food_b", "crate_large_decorated", "barrel_small_stack",
      "pot_a_stew", "pot_large", "crate_potatoes", "food_barrel_fish",
      "fuel_a_barrels", "gems_sack", "anvil",
      "potion_huge_green", "potion_large_blue", "potion_medium_red",
      // Room purposes wave 3 (variants): training hall, gambling den, war
      // room, ossuary + variant dressing (rugs, mugs, maps, mushrooms).
      // Prototype/Board Game/Furniture/RPG Tools/Halloween/Restaurant/
      // Mystery Monthly bits, all CC0 — see ASSETS.md.
      // LIVED-IN LOOK TEST (iso.html?look=lived): doorway arches at room
      // mouths, gated/window wall variants, open grates, interior pillars.
      // KayKit Dungeon Remastered 1.1, CC0 — see ASSETS.md.
      "wall_doorway", "wall_gated", "wall_archedwindow_gated", "wall_window_open",
      "floor_tile_grate_open", "pillar",
      "dummy_base", "weaponrack", "weaponrack_decorated", "trainingdummy_base",
      "card_base", "card_spades_ace", "card_hearts_king",
      "coin_gold", "coin_10_gold", "coin_silver",
      "rug_rectangle_a", "rug_rectangle_b", "rug_oval_a",
      "mug_a", "mug_b", "vampire_goblet",
      "basket_mushrooms", "mushroom", "crate_mushrooms", "dishrack_plates",
      "skull", "lantern_hanging", "map", "map_rolled",
      "bottle_a_labeled_green", "bottle_b_brown",
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
      "fx_implosion_cone", "fx_flame_wall", "fx_detonation_star", "fx_blast_star",
      // Diegetic System objects (Meshy-generated): the loot-box delivery, the
      // airstrike's real sponsor ordnance, Extradition's gavel chain anchor.
      "system_loot_box", "sponsor_shell", "gavel_anchor", "descent_portal",
    ].map((name) => [name, `/assets/dungeon/${name}.glb`]),
  ),
};

// Elite skins: KayKit's alternate texture PNGs (same UV atlas, recolored) —
// an elite wears its pack's B-variant so it reads as a DIFFERENT individual,
// on top of the per-affix emissive tint. Keyed by monster KIND; kinds absent
// here (clown, vampire — single-texture packs) stay tint-only.
export const ELITE_TEXTURES: Record<string, string> = {
  swarmer: "/assets/characters/skeleton_texture_b.png",
  ranged: "/assets/characters/skeleton_texture_b.png",
  necromancer: "/assets/characters/skeleton_texture_b.png",
  boss: "/assets/characters/skeleton_texture_b.png", // generic Skeleton_Warrior boss
  charger: "/assets/characters/werewolf_texture_b.png",
  shaman: "/assets/characters/witch_texture_b.png",
  brute: "/assets/characters/orcbrute_texture_b.png",
  spitter: "/assets/characters/plantcreatures_texture_b.png",
  drummer: "/assets/characters/orc_texture_b.png",
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
  monster_foreman: "medium", // CombatMech — the champion's chassis
  monster_boss_3: "medium", // Necromancer (as The Crypt Concierge)
  monster_boss_6: "large", // BlackKnight
  monster_boss_9: "medium", // PlantWarrior (as The Topiary Warden)
  monster_boss_12: "large", // FrostGolem
  monster_boss_15: "large", // OrcBrute (as The Furnace Marshal)
  monster_boss_18: "large", // DemonLord
  // The campfire lineup (Adventurers 2.0) — all medium rig.
  crawler_knight: "medium",
  crawler_barbarian: "medium",
  crawler_druid: "medium",
  crawler_engineer: "medium",
  crawler_mage: "medium",
  crawler_ranger: "medium",
  crawler_rogue: "medium",
  crawler_hooded: "medium",
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
const HERO_CLIP_MANIFEST = [
  "/assets/characters/extradition.glb",
  "/assets/characters/flask_drink.glb", // Meshy 342 Stand_and_Drink, retargeted
  "/assets/characters/stuntdouble_cast.glb", // Meshy 42 Gentlemans_Bow — hiring the professional
];

/**
 * The handful of models a first playable frame actually needs: the hero (baked
 * clips included) and the core dungeon shell. Everything else streams behind
 * the running game — the renderer's procedural stand-ins cover the gap and
 * are swapped out via ModelStore.onArrive.
 */
const PRIORITY_KEYS = new Set([
  "player", "wall", "floor", "stairs", "torch_lit", "torch_mounted",
]);

export interface ModelStore {
  /** LIVE record — fills in as GLBs arrive. Hosts read it every frame. */
  models: Record<string, LoadedModel>;
  /** Resolves when the priority wave has settled — enough to start playing. */
  ready: Promise<void>;
  /** Resolves when every manifest entry has settled (tools/tests). */
  complete: Promise<void>;
  /** Set by the host: fires per background arrival (debounce on the far side). */
  onArrive: ((key: string) => void) | null;
}

/**
 * Kick off the streaming load. Nothing here throws: a missing file simply
 * never lands in `models` and the renderer keeps its procedural stand-in.
 * onProgress tracks the PRIORITY wave (what the boot screen gates on); the
 * background bulk reports nothing — it is deliberately invisible.
 */
export function startModelLoad(
  onProgress?: (loaded: number, total: number) => void,
): ModelStore {
  const loader = new GLTFLoader();
  const store: ModelStore = {
    models: {},
    onArrive: null,
    ready: Promise.resolve(),
    complete: Promise.resolve(),
  };

  // Shared clip libraries fill IN PLACE with slot-stable order (the renderer's
  // regex fallbacks are order-sensitive). Characters that arrive before their
  // clips hold a reference to the same array, so late packs reach them
  // automatically; the onArrive-driven mesh rebuild re-binds their animators.
  const rigClips: Record<"medium" | "large", THREE.AnimationClip[]> = { medium: [], large: [] };
  const rigSlots: Record<"medium" | "large", THREE.AnimationClip[][]> = {
    medium: RIG_CLIP_MANIFEST.medium.map(() => []),
    large: RIG_CLIP_MANIFEST.large.map(() => []),
  };
  const heroSlots: THREE.AnimationClip[][] = HERO_CLIP_MANIFEST.map(() => []);
  const heroBaked = new Map<string, number>(); // hero key -> its own clip count

  const appendHeroClips = (key: string): void => {
    const m = store.models[key];
    const baked = heroBaked.get(key);
    if (!m || baked === undefined) return;
    m.animations.length = baked; // idempotent: re-append after each pack lands
    m.animations.push(...heroSlots.flat());
  };
  const finalizeCharacter = (key: string): void => {
    const m = store.models[key];
    if (!m) return;
    const rig = CHARACTER_RIGS[key];
    if (rig && m.animations.length === 0) m.animations = rigClips[rig];
    if (HERO_SKIN_KEYS.includes(key)) {
      heroBaked.set(key, m.animations.length);
      appendHeroClips(key);
    }
  };

  const loadModel = async (key: string, url: string): Promise<void> => {
    try {
      const gltf = await loader.loadAsync(url);
      store.models[key] = { scene: gltf.scene, animations: gltf.animations };
      finalizeCharacter(key);
      store.onArrive?.(key);
    } catch {
      // File absent or failed to parse — renderer keeps its stand-in.
    }
  };

  const entries = Object.entries(MODEL_MANIFEST);
  const wave1 = entries.filter(([k]) => PRIORITY_KEYS.has(k));
  const wave2 = entries.filter(([k]) => !PRIORITY_KEYS.has(k));

  // Progress = priority files SETTLED (loaded or missing-and-skipped) — the
  // boot bar must never stall on an asset we'd gracefully skip anyway.
  let settled = 0;
  const tick = () => onProgress?.(++settled, wave1.length);

  store.ready = Promise.all(
    wave1.map((e) => loadModel(e[0], e[1]).finally(tick)),
  ).then(() => {});

  const background = async (): Promise<void> => {
    await store.ready; // priority wave owns the bandwidth first
    await Promise.all([
      ...wave2.map((e) => loadModel(e[0], e[1])),
      ...(Object.keys(RIG_CLIP_MANIFEST) as ("medium" | "large")[]).flatMap((rig) =>
        RIG_CLIP_MANIFEST[rig].map(async (url, slot) => {
          try {
            rigSlots[rig][slot] = (await loader.loadAsync(url)).animations;
          } catch {
            return; // missing pack: rig characters just animate with less variety
          }
          // Rebuild in place so every character holding this array sees it.
          rigClips[rig].length = 0;
          rigClips[rig].push(...rigSlots[rig].flat());
          store.onArrive?.(`rig:${rig}`);
        }),
      ),
      ...HERO_CLIP_MANIFEST.map(async (url, slot) => {
        try {
          heroSlots[slot] = (await loader.loadAsync(url)).animations;
        } catch {
          return; // missing ability clip: the animator's playFirst fallbacks cover it
        }
        for (const key of HERO_SKIN_KEYS) appendHeroClips(key);
        store.onArrive?.("hero:clips");
      }),
      // GENERATED assets (the builder's Meshy bridge writes these at dev time;
      // committed ones ship like any other file). index.json maps key -> {url,
      // clips?}: props are plain models; creature entries carry armature-only
      // clip GLBs on the creature's own skeleton (bind by bone name, as ever).
      (async () => {
        try {
          const ix = await (await fetch("/assets/generated/index.json")).json() as
            Record<string, { url: string; clips?: string[] }>;
          await Promise.all(Object.entries(ix).map(async ([key, entry]) => {
            try {
              const gltf = await loader.loadAsync(entry.url);
              const clipSets = await Promise.all((entry.clips ?? []).map(async (c) =>
                (await loader.loadAsync(c)).animations));
              store.models[key] = { scene: gltf.scene, animations: [...gltf.animations, ...clipSets.flat()] };
              store.onArrive?.(key);
            } catch { /* one bad generated asset never blocks the rest */ }
          }));
        } catch { /* no generated index: nothing crafted yet */ }
      })(),
    ]);
  };
  store.complete = background();

  return store;
}

/** One-shot full load (tools/tests) — the streaming store, awaited to the end. */
export async function loadModels(
  onProgress?: (loaded: number, total: number) => void,
): Promise<Record<string, LoadedModel>> {
  const store = startModelLoad(onProgress);
  await store.complete;
  return store.models;
}
