# KayKit Complete Collection — inventory & coverage map

What's inside **The Complete KayKit Collection v6.zip** (all CC0), what the game
already uses, and what's still untapped. ASSETS.md stays the license/provenance
ledger for assets **in use**; this file is the survey of what's **available** so
future work (new mobs, new bands, safe-room dressing, floor hazards) starts from
a known menu instead of re-walking the zip.

- **Source zips** (owner's dev box, `C:\Users\hartw\Downloads\`):
  - `The Complete KayKit Collection v6.zip` — 22 packs, ~29k files, License.txt
    inside confirms **CC0** for everything.
  - `DemonLord.zip` (Monthly character + SummoningCircle) — CC0, already in use.
  - `Fantasy Weapon Bits Patreon Early Access.zip` (bows/shields/fistweapons) —
    CC0 despite the name; License.txt inside confirms.
- **Census date**: 2026-07-08 (zip v6, through the June 2026 Mystery Monthly).
  A future v7 zip adds newer Monthly characters; re-run the census when it lands.

## How assets get into the game (the seams)

1. Extract from zip. Characters are self-contained GLBs (textures embedded)
   under `<pack>/characters/` (sometimes `character/`, sometimes with a `gltf/`
   subfolder). Props are `gltf + bin + png` — convert with
   `npx -y gltf-pipeline -i thing.gltf -o thing.glb`.
2. Drop under `public/assets/characters/` or `public/assets/dungeon/`
   (lowercase snake_case filenames by repo convention).
3. Add to `MODEL_MANIFEST` in `src/render3d/assets.ts`. Characters of the new
   generation ship **without baked animations** — also add to `CHARACTER_RIGS`
   with the right rig (`medium`/`large`, table below) and they inherit the whole
   shared clip library (idle/walk/attack/hit/death + specials). The clip
   animator fuzzy-matches names, so this is usually zero renderer work.
4. Record pack + license in ASSETS.md (CC0: provenance row only).

## Rigged character census (the mob-scaling resource)

Every rigged character GLB in the collection. Rig detected from the GLB's node
graph; **all ship without baked animations** and animate via the shared
Character Animations 1.1 libraries already loaded by the renderer.

### In use today (13 from this collection + DemonLord)

| Character | Pack | Rig | Role today |
|---|---|---|---|
| Skeleton_Minion | Skeletons 1.1 | medium | swarmer |
| Skeleton_Mage | Skeletons 1.1 | medium | ranged |
| Skeleton_Warrior | Skeletons 1.1 | medium | generic boss |
| Necromancer | Skeletons 1.1 | medium | necromancer + The Crypt Concierge (boss 3) |
| OrcBrute | Mystery S6 | large | brute + The Furnace Marshal (boss 15) |
| Clown | Mystery S4 | medium | bomber |
| Witch | Mystery S5 | medium | shaman |
| Vampire | Mystery S5 | medium | phantom |
| Werewolf_Wolf | Mystery S4 | medium | charger |
| PlantWarrior | Mystery S6 | medium | spitter + The Topiary Warden (boss 9) |
| BlackKnight | Mystery S5 | large | The Sump King (boss 6) |
| FrostGolem | Mystery S5 | large | The Condemned Architect (boss 12) |
| DemonLord | (separate zip) | large | floor-18 finale |

(Hero skins — adventurer, barbarian, mage, rogue, rogue_hooded — are the older
Adventurers **1.0** GLBs with baked animations, fetched separately; they also
donate weapon/shield meshes to `weaponry.ts`.)

### Untapped characters (48)

Grouped by how naturally they read as **dungeon mobs** in this game's tone (the
dungeon is a galactic reality-TV show — mall cops, animatronics, and toy
soldiers are absolutely on-theme).

**Strong mob candidates (28):**

| Character | Pack | Rig | Band/role suggestion |
|---|---|---|---|
| Skeleton_Rogue | Skeletons 1.1 | medium | UNDERCROFT — fast stabby variant |
| Skeleton_Golem | Skeletons 1.1 | **large** | UNDERCROFT/SEWERS — second brute silhouette |
| ~~OrcRaider~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Drum Sergeant (SEWERS support mob) |
| Caveman | Mystery S5 | medium | UNDERCROFT — club grunt |
| Monster | Mystery S4 | medium | any — classic beast |
| MonsterCostume | Mystery S4 | medium | THE SHOW twist — "it was a guy in a suit" |
| ~~Werewolf_Man~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Understudy (morphs into the charger wolf) |
| ~~Tiefling~~ | Mystery S5 | medium | **SHIPPED 2026-07-08** as the Briar Witch (vulnerability hex) |
| Cleric | Mystery S6 | medium | RUINS — enemy healer (shaman variant) |
| Paladin (+ helmeted variant) | Mystery S4 | medium | RUINS — armored zealot, shielded elite |
| Lorekeeper | Mystery S6 | medium | RUINS — spellbook caster |
| Ninja | Mystery S4 | medium | APPROACH — blink assassin (phantom variant) |
| AvianSwordsman | Mystery S6 | medium | APPROACH — duelist |
| Marksman | Mystery S6 | medium | APPROACH — sniper (long-range telegraph) |
| MagicalGirl | Mystery S6 | medium | APPROACH — System darling mini-boss |
| ~~Animatronic_Normal~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Greeter (dormant ambusher) |
| ~~Animatronic_Creepy~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Greeter's elite skin |
| ~~Robot_One~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Lineworker (piston punch) |
| ~~Robot_Two~~ | Mystery S4 | medium | **SHIPPED 2026-07-08** as the Sentinel (lock-on beam) |
| ~~Clanker~~ | Mystery S5 | **large** | **SHIPPED 2026-07-08** as the Slagbreaker (vent rhythm) |
| CombatMech | Mystery S5 | medium | IRONWORKS — band boss material (The Foreman champion) |
| ~~ToySoldier~~ | Mystery S6 | medium | **SHIPPED 2026-07-08** as the Wind-Up Battalion (synced volleys) |
| ActionFigure | Mystery S4 | medium | THE SHOW — merchandising tie-in mob |
| Monstrosity | Mystery S6 | **custom rig** | APPROACH — horror boss (no Rig_Medium/Large nodes; verify clips before committing) |
| 4GTN | Mystery S6 | **large** | APPROACH — golem sentinel |
| 4GTN_Forgotten | Mystery S6 | **large** | its ruined/corrupted variant |
| ~~Hoarder~~ | Mystery S6 | medium | **SHIPPED 2026-07-08** as the Repo Rat (fleeing loot-goblin) |
| Superhero | Mystery S5 | medium | THE SHOW — fallen "former favorite" rival |

**NPC / crawler / flavor candidates (20):** Adventurers 2.0 Barbarian,
Barbarian_Large (large rig), Druid, Engineer, Knight, Mage, Ranger, Rogue,
Rogue_Hooded (9 modular player classes — the natural class-select / hero-skin
upgrade, with 67 matching held-weapon + potion props); Helper_A/B (safe-room
staff), Farmer_A/B, Hiker, Survivalist, Driver (+car prop), Protagonist_A/B,
SpaceRanger + SpaceRanger_FlightMode (late-band sponsor cameo?).

Plus: Mannequin_Medium/Large (Character Animations pack) and Dummy (Prototype
Bits) — rig-preview dummies, useful as training-room props.

Most characters ship 2+ alternate texture PNGs in their pack folder (e.g.
`orc_texture_A/B`), so recolored elite/affix variants cost no new models.

## Animation clip libraries (Character Animations 1.1)

Loaded today (see `RIG_CLIP_MANIFEST` in `src/render3d/assets.ts`): **all 14
packs** as of 2026-07-08 — medium General, MovementBasic, CombatMelee,
CombatRanged, Special, MovementAdvanced, Simulation, Tools; large General,
MovementBasic, CombatMelee, MovementAdvanced, Simulation, Special. Notables
from the last batch: Sneaking/Crawling (filcher stealth), Lockpicking, full
dodge sets, sit/lie/wave (safe-room NPCs someday), and
EXPERIMENTAL_Large_Transform (the boss phase-up act). No drink clip exists in
any pack — the flask act needs a generated clip (GENERATION-BACKLOG.md).

## Pack-by-pack inventory

Model counts are raw gltf/glb file counts in the zip (colorway duplicates
counted — noted where that inflates things).

| Pack | Models | What's inside | Status / candidate use |
|---|---|---|---|
| Adventurers 2.0 | 71 + 9 chars | 9 modular player classes, held weapons (incl. shotgun, turret, smokebomb), shields, potions, spellbooks, quiver, ammo crate | **Untapped.** Class select / hero skins; potions for flask visuals |
| Skeletons 1.1 | 29 (6 chars) | Skeleton faction + crypt props (arrows, staffs, shields) | **Partially used** (4 of 6 chars + skeleton_arrow) |
| Character Animations 1.1 | 16 clip packs | The shared rig libraries + mannequins | **Partially used** (8 of 14 packs loaded) |
| Mystery Monthly S4 | 80 (18 chars) | Characters + their signature props (Orc wardrum, car, paladin statue/hammer, ninja gear) | **Partially used** (Clown, Werewolf_Wolf) |
| Mystery Monthly S5 | 64 (14 chars) | Characters + props | **Partially used** (BlackKnight, Vampire, Witch, FrostGolem) |
| Mystery Monthly S6 | 54 (14 chars) | Characters + props | **Partially used** (OrcBrute, PlantWarrior) |
| Dungeon Remastered 1.1 | 283 | The core dungeon set: walls, floors, stairs, doors, torches, chests/mimic, banners, tavern/library furniture | **Heavily used** (~90 models); plenty of unmined props remain (cage, fountain, altar sets) |
| Fantasy Weapons Bits | 48 | Swords/axes/hammers/spears/staves/wands/arrows | **Heavily used** (equippable meshes) |
| Forest Nature Pack | 1588 (≈227 × 7 colorways) | Trees, bushes, rocks, grass, Hill_Cliff modular wall kit | **Used** (Garden band + open-air cliffs, Color1) — 6 more colorways free for future band reskins |
| Halloween Bits | 102 | Graves, crypts, dead trees, pumpkins, fences, bones | **Used** (Garden band) |
| Resource Bits | 132 | Gold bars, gem piles, money piles, chests, ores | **Used** (vault hoards, gem drop); ores/ingots unmined (crafting visuals?) |
| Platformer Pack | 525 (≈105 × 5 colors) | **saw traps, spike traps, swipers, hammers, spikeblocks, conveyors**, cannons, buttons, flags, keys | **Untapped.** The floor-hazard kit if traps ship (BACKLOG-adjacent: band floor events) |
| Board Game Bits | 243 | Full playing-card deck, dice, meeples, pawns, chips, boards | **Untapped.** System game-show set dressing; shrine/gamble-room props |
| RPG Tools Bits | 69 | Anvil, grindstone, lockpicks, locks, keys, maps, journals, fishing kit, lantern | **Untapped.** Crafting-bench/shop dressing; lockpick props for locked doors |
| Furniture Bits | 74 | Beds, desks, couches, lamps, monitors, game console | **Untapped.** Safe-room interiors (modern furniture reads as System-provided) |
| Restaurant Bits | 225 | Full kitchen: appliances, crates of ingredients, dishes, burgers/pizza/ice cream | **Untapped.** Safe-room canteen; Mongo's-diner-style set piece |
| Holiday Bits | 138 | Christmas trees, gifts, candy, gingerbread building blocks, toys | **Untapped.** Seasonal event floor / absurd System theming |
| City Builder Bits | 73 | Modern buildings, cars, roads, park pieces | **Untapped.** "Ruined Earth suburb" flashback floor (buildings are boxy-scale, set-piece only) |
| Space Base Bits | 69 | Base modules, landing pads, dropship, cargo, rover | **Untapped.** THE APPROACH band dressing — production-station backstage |
| Medieval Hexagon | 404 (≈101 × 4 team colors) | Hex-tile buildings: castle, tavern, mills, towers, ships | **Untapped.** Set-piece silhouettes only (hex-tile scale ≠ our grid) |
| Block Bits | 58 | Voxel cubes: dirt/grass/lava/glass, TNT, anvil | **Untapped.** Prototype/greybox only; off-style for shipped floors |
| Prototype Bits 1.1 | 88 (1 char) | Greybox primitives, guns, lockers, pallets, Dummy character | **Untapped.** Test-range dressing; Dummy = training target |

> **Update 2026-07-08:** the mob designs built on this census live in
> `MOB-CONCEPTS.md` (36-mob roster, band casts, new sim verbs, boss layers).

## The 30–45 mob-types question (answered 2026-07-08)

Current cast uses **13 distinct monster models** (12 sim archetypes + band
bosses reusing cast members). The collection holds **28 strong unused mob
skins** (table above) → **~41 distinct monster looks** without buying or
commissioning anything, before texture-variant recolors. Bands that are
model-poor today (IRONWORKS, APPROACH) are exactly where the untapped pool is
richest (robots, mechs, animatronics, golems). The binding constraint is sim
design (archetype behaviors, spawn tables in `config.ts`/`ai.ts`), not art.

## Keeping this file honest

- When an asset ships, move its story: usage + license row into ASSETS.md,
  flip its row here from untapped to used.
- New collection zip (v7+): re-run the census — new Monthly characters land
  every month; update counts and the census date up top.
