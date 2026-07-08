# Art & audio assets — open-source sourcing

> This file tracks assets **in use** (origin + license). For what's *available*
> in the owner's KayKit Complete Collection zip but not yet used — including the
> full rigged-character census — see `KAYKIT-INVENTORY.md`.

The 3D isometric renderer (`src/render3d/`) currently draws **procedural low-poly
placeholder meshes** so we can confirm art direction without any downloads. It's
built to load real **glTF/GLB** models the moment they're present under
`public/assets/` — see `src/render3d/assets.ts` (`MODEL_MANIFEST`). Uncomment a
manifest entry, drop the matching `.glb` in place, and the renderer swaps the
primitive for the model automatically (falling back to the primitive if the file
is missing). No gameplay code changes — the sim knows nothing about rendering.

## Recommended CC0 packs (public domain, commercial-OK, attribution-free)

All of the following are **CC0 1.0** unless noted. CC0 means you can use, modify,
and ship them commercially with no attribution required (attribution still
appreciated).

### Environment — modular dungeon kits
| Pack | Author | License | Link |
|---|---|---|---|
| Modular Dungeon Kit (40 pcs) | Kenney | CC0 | https://kenney.nl/assets/modular-dungeon-kit |
| Mini Dungeon (with animations) | Kenney | CC0 | https://kenney-assets.itch.io/mini-dungeon |
| LowPoly Modular Dungeon Pack (45+ pcs) | Quaternius | CC0 | https://quaternius.itch.io/lowpoly-modular-dungeon-pack |
| KayKit Dungeon Remastered | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-dungeon-remastered |
| KayKit Halloween Bits (THE GARDEN band: dead trees, graves, crypt, lanterns) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/halloween-bits |
| KayKit Forest Nature Pack (THE GARDEN goes green: live trees, bushes, rocks, grass — `forest_*.glb`, Color1 variant from the Complete Collection) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-forest |
| KayKit Forest Nature Pack — Hill_Cliff kit (open-air Garden walls: `cliff_side_*.glb`, `cliff_inner_*.glb`, `cliff_outer_*.glb` + `forest_tree_3/4_a`, `forest_rock_5_a/c`; Color1, converted via gltf-pipeline) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-forest |
| KayKit Halloween Bits — `fence_gate.glb` (open-air gate dressing) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/halloween-bits |
| KayKit Fantasy Weapons Bits (equippable weapon meshes — `weapon_*.glb`: swords, axes, hammer, spear, halberd, dagger, wand, staves; `weapon_arrow_a.glb` flies as the ballistic bolt) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-fantasy-weapons |
| KayKit Skeletons 1.1 — `skeleton_arrow.glb` (ranged-archetype projectile) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-skeletons |
| KayKit Mystery Monthly: Plant Warrior — `plant_warrior_arrow.glb` (spitter windup lob) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/ |
| KayKit Mystery Monthly: Clown — `clown_bomb.glb` (bomber fuse + volatile-corpse blasts) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/ |
| KayKit Dungeon Remastered 1.1 (interiors: bookcases, tavern bar set, mimic + gold chests, colored banners) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-dungeon-remastered |
| KayKit Resource Bits (vault hoards: gem piles, gold bars, money piles, gem chest; `gem_medium.glb` is the trinket/charm ground drop) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-resource-bits |

Halloween Bits GLBs were converted from the gltf sources in the pack's GitHub
mirror (github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0) via
`gltf-pipeline`; the pack license ships alongside the models as
`public/assets/dungeon/LICENSE-halloween-bits.txt`.

### Characters & monsters (rigged + animated — the big 3D win)
| Pack | Author | License | Link |
|---|---|---|---|
| KayKit Character Pack: Adventurers | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-adventurers |
| KayKit Character Pack: Skeletons | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-skeletons |
| The Complete KayKit Collection v6 (monster cast: Skeleton_Minion, Necromancer, OrcBrute, Clown, Witch, Vampire, Werewolf, PlantWarrior, BlackKnight, FrostGolem, OrcRaider [Drum Sergeant], Hoarder [Repo Rat] + Rig_Medium/Rig_Large animation libraries from Character Animations 1.1) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/ |
| KayKit Monthly Mystery Character: Demon Lord (July 2026; + SummoningCircle prop) | Kay Lousberg | CC0 | https://kaylousberg.itch.io/ |

Collection characters were copied from the purchased Complete Collection zip
(self-contained GLBs, textures embedded). The newer-generation characters ship
without baked animations; the shared rig clip libraries
(`rig_medium_*.glb` / `rig_large_*.glb`) animate them — see `CHARACTER_RIGS`
in `src/render3d/assets.ts`. Pack licenses ship alongside as
`LICENSE-kaykit-collection.txt` and `LICENSE-demonlord.txt`.
| RPG Characters / Animated Monsters | Quaternius | CC0 | https://quaternius.com/ |

KayKit Adventurers + Skeletons are the sweet spot for this game: rigged humanoids
sharing a skeleton, with idle/walk/attack/hit/death clips already included — exactly
what maps onto our player and monster entities.

### Aggregators / single-model grabbing
- **poly.pizza** — https://poly.pizza — searchable CC0 model library, per-model GLB
  download (includes the Quaternius/Kenney packs above).
- **OpenGameArt.org** (filter to CC0) — https://opengameart.org
- **Mixamo** — https://www.mixamo.com — free auto-rigging + a large animation
  library. Note: free to use, but **not CC0** (Adobe account + license terms), so
  prefer the CC0 packs above if you want a fully public-domain asset base.

## Where to put files

```
public/assets/
  dungeon/    wall.glb, floor.glb, stairs.glb, props…
  characters/ adventurer.glb, skeleton.glb…
```

Then enable the matching lines in `MODEL_MANIFEST` (`src/render3d/assets.ts`). The
manifest keys the renderer already looks for are `player`, `skeleton`/`monster`,
`wall`, `floor`, `stairs`.

## Fetching

Some hosts (itch.io, kenney.nl direct zips) require a browser click-through and
can't be scripted reliably, and in this repo's sandbox the proxy blocks a few of
them outright. `scripts/fetch-assets.sh` attempts the scriptable sources and prints
manual-download instructions for the rest. Downloaded binaries are git-ignored
(`public/assets/` is not committed) — each contributor fetches their own copy, so
the repo stays lightweight and license-clean.

## Audio — SFX & music

The game has a silent-by-default audio seam mirroring the model loader: the 3D
host plays clips from `public/audio/` when they exist and plays nothing when they
don't (`src/audio/manifest.ts` is the id → file map, `src/audio/engine.ts` the
loader/player, `src/audio/director.ts` the sim-event → sound mapping). Drop a
clip at the manifest path, reload, and it sounds — no code changes. Formats:
anything the browser decodes (`.ogg` recommended; if a source ships `.mp3`,
either convert or point the manifest entry at the `.mp3`).

**Unlike the 3D packs above, the good audio sources are mixed-license.** Keep the
split explicit: CC0 needs nothing; CC-BY is free but **requires attribution** —
if you use any CC-BY clip, list it in the attribution table below AND surface it
in an in-game credits screen (not yet built; build it before shipping CC-BY audio).

### Sources — license-tagged
| Source | What | License | Link |
|---|---|---|---|
| Kenney audio packs (Impact / Interface / RPG / Music Jingles) | SFX + stings | **CC0** | https://kenney.nl/assets?q=audio |
| ~~FreePD~~ (site closed 2026) | music beds | — | use OpenGameArt instead |
| OpenGameArt (filter: license = CC0) | music + SFX | **CC0 when filtered** | https://opengameart.org |
| Freesound (filter: license = CC0) | SFX | **CC0 when filtered** | https://freesound.org/search/?f=license:%22Creative+Commons+0%22 |
| MuseOpen | classical recordings | mostly PD — check per file | https://musopen.org |
| Sound Image (Eric Matyas) | music + SFX | **CC-BY 4.0** (attribution) | https://soundimage.org |
| Freesound (unfiltered) | SFX | mixed CC0/CC-BY/CC-BY-NC — check per file | https://freesound.org |
| White Bat Audio / TeknoAxe | music | royalty-free w/ attribution | https://whitebataudio.com · https://teknoaxe.com |
| Free Music Archive | music | mixed — check per track | https://freemusicarchive.org |

Prefer the CC0 rows (Kenney + FreePD + filtered Freesound cover everything this
game needs) so the repo stays attribution-free like the 3D assets. Avoid any
**NC** (non-commercial) licensed file entirely.

### Where to put files

```
public/audio/
  sfx/    hit.ogg, crit.ogg, player_hurt.ogg, heal.ogg, gold.ogg, item.ogg,
          swing.ogg, tell.ogg, kill.ogg,
          dash.ogg, bolt.ogg, nova.ogg, level_up.ogg, lootbox.ogg,
          achievement.ogg, door_unlock.ogg, descend.ogg, death.ogg, victory.ogg,
          announce.ogg, sponsor.ogg, crowd.ogg, warning.ogg, buy.ogg, equip.ogg
  music/  dungeon.ogg, safe_room.mp3, collapse.wav,
          battle_theme_a.ogg, battle_music.ogg, battle_winter.ogg,   (battle rotation)
          boss_epic.ogg, boss_blackmoor.ogg, boss_colossal.ogg   (boss themes; all loop)
```

The full list with per-sound volume/bus/throttle lives in `src/audio/manifest.ts`
— that file is the source of truth. `scripts/fetch-assets.sh` prints download
pointers for the audio sources too.

### Audio files in use (all CC0 — provenance record, attribution not required)

| Our file(s) | Source | Author | License |
|---|---|---|---|
| `sfx/hit,crit,player_hurt,nova.ogg` | Kenney — Impact Sounds | Kenney | CC0 |
| `sfx/announce,warning.ogg` | Kenney — Interface Sounds | Kenney | CC0 |
| `sfx/gold,buy,item,equip,door_unlock,descend.ogg` | Kenney — RPG Audio | Kenney | CC0 |
| `sfx/level_up,victory,lootbox,achievement,sponsor.ogg` | Kenney — Music Jingles | Kenney | CC0 |
| `sfx/heal,dash,bolt,death.ogg` | Kenney — Digital Audio | Kenney | CC0 |
| `music/dungeon.ogg` | [Loopable Dungeon Ambience](https://opengameart.org/content/loopable-dungeon-ambience) | JaggedStone | CC0 |
| `music/safe_room.mp3` | [Calm Ambient 1 (Synthwave 4k)](https://opengameart.org/content/calm-ambient-1-synthwave-4k) | The Cynic Project (cynicmusic.com) | CC0 |
| `music/collapse.wav` | [Fast fight / battle music (looped)](https://opengameart.org/content/fast-fight-battle-music-looped) | Ville Nousiainen, loop by XCVG | CC0 |
| `music/battle_theme_a.ogg` | [Battle Theme A](https://opengameart.org/content/battle-theme-a) | cynicmusic (The Cynic Project) | CC0 |
| `music/boss_epic.ogg` | [Boss Battle Music](https://opengameart.org/content/boss-battle-music) | Juhani Junkala (SubspaceAudio) | CC0 |

Not yet sourced: `sfx/crowd.ogg` (multi-kill roar), the combat-feel trio
`sfx/swing.ogg` (melee whoosh), `sfx/tell.ogg` (enemy windup cue), and
`sfx/kill.ogg` (killing-blow thump), plus `sfx/boss_intro.ogg` (ringside
introduction sting). Kenney Impact/RPG Audio (CC0) have good candidates for
all of them; the game stays silent for each until a clip is added.

Note: **freepd.com has shut down** ("Site Closed") — removed from the source
table guidance; OpenGameArt (license-filtered to CC0) is the better music source.

### Attribution (CC-BY assets in use)

Attribution is REQUIRED for these. It is provided here and in-game (KEY
BINDINGS panel footer in `iso.html`) — keep both in sync when adding rows.

| Work | Author | License | Source | Our file |
|---|---|---|---|---|
| Battle Music | Alexandr Zhelanov | CC BY 3.0 | [OGA page](https://opengameart.org/content/battle-music) | `music/battle_music.ogg` |
| Battle in the Winter | Johan Brodd (jobromedia) | CC BY 3.0 | [OGA page](https://opengameart.org/content/battle-in-the-winter) | `music/battle_winter.ogg` |
| Colossal Boss Battle Theme | Matthew Pablo ([matthewpablo.com](https://matthewpablo.com)) | CC BY 3.0 | [OGA page](https://opengameart.org/content/colossal-boss-battle-theme) | `music/boss_colossal.ogg` |
| Blackmoor Tides (Epic Pirate Battle Theme) | Matthew Pablo ([matthewpablo.com](https://matthewpablo.com)) | CC BY 3.0 | [OGA page](https://opengameart.org/content/blackmoor-tides-epic-pirate-battle-theme) | `music/boss_blackmoor.ogg` |

The `.ogg` files are re-encodes of the authors' seamless-loop WAV/MP3 releases
(format conversion only, no creative changes). Rejected during sourcing:
"Orchestral Battle Music" (Zefz) — CC-BY-SA/GPL only, and the author states the
samples come from a commercial MAGIX sample DVD, so the relicensing chain is
unclear. Don't ship it.

## Ability icons — game-icons.net (CC BY 3.0, attribution REQUIRED)

`public/icons/*.svg` come from https://game-icons.net (GitHub: game-icons/icons),
license **CC BY 3.0** — unlike everything else in this repo, these REQUIRE
attribution. It is provided in-game (KEY BINDINGS panel footer) and here:

| Icon | Ability | Author |
|---|---|---|
| sword-slice | melee | Lorc |
| sprint | dash | Lorc |
| energy-arrow | bolt | Lorc |
| explosion-rays | nova | Lorc |
| orbital | orbit | Lorc |
| switch-weapon | stance | Delapouite |
| lightning-arc | overcharge | Lorc |
| carpet-bombing | airstrike | Skoll |
| quake-stomp | cataclysm | Lorc |
| stopwatch | bullettime | Lorc |
| flask *(original)* | Sponsor Slurp™ flask chip | drawn for this repo, CC0 — NOT game-icons |

Convention: `/icons/<abilityId>.svg`, background rect stripped so the white
glyph works as a CSS mask (tinted gold for actives, purple for ultimates).
New abilities: pick an icon at game-icons.net, fetch the raw SVG from the
GitHub mirror, strip `<path d="M0 0h512v512H0z"/>`, and add a row here.

### Noun icons — `public/icons/nouns/` (same source, license, and convention)

Generated field drops (`src/sim/items.ts` SLOT_NOUNS) show their weapon/armor/
trinket NOUN's icon in the bag and equipped rows, rarity-tinted via CSS mask.
One file per noun, lowercase: `/icons/nouns/<noun>.svg`.

| Our file | game-icons.net icon | Author |
|---|---|---|
| blade | broadsword | Lorc |
| axe | battle-axe | Lorc |
| maul | warhammer | Delapouite |
| spear | barbed-spear | Lorc |
| cleaver | bowie-knife | Lorc |
| wand | fairy-wand | Lorc |
| staff | wizard-staff | Lorc |
| crossbow | crossbow | Carl Olsen |
| mug | beer-stein | Lorc |
| plate | breastplate | Lorc |
| hauberk | scale-mail | Lorc |
| carapace | turtle-shell | Lorc |
| aegis | checked-shield | Lorc |
| vest | sleeveless-jacket | Delapouite |
| charm | gem-pendant | Lorc |
| sigil | rune-stone | Lorc |
| idol | totem-head | Lorc |
| band | diamond-ring | Delapouite |
| totem | totem-mask | Lorc |
| helm | visored-helm | Lorc |
| visor | heavy-helm | Lorc |
| hood | hood | Lorc |
| crown | crown | Lorc |
| boots | leather-boot | Lorc |
| greaves | greaves | Delapouite |
| treads | footprint | Lorc |
| striders | running-shoe | Delapouite |
| pendant | pearl-necklace | Delapouite |
| talisman | ankh | Lorc |
| locket | heart-necklace | Delapouite |
| fetish | voodoo-doll | Lorc |

### Stat icons — `public/icons/stats/` (same source, license, and convention)

The Crawler Profile panel's attribute tiles (`renderSheet` in `src/main3d.ts`),
tinted per stat via CSS mask.

| Our file | game-icons.net icon | Author |
|---|---|---|
| attack | crossed-swords | Lorc |
| spell | magic-swirl | Lorc |
| crit | on-target | Lorc |
| speed | wingfoot | Lorc |
| armor | shield | sbed |
| hp | health-normal | sbed |

### Item icons — `public/icons/items/` (same source, license, and convention)

The System Shop catalog (`src/sim/catalog.ts`) uses `/icons/items/<catalogId>.svg`,
tier-tinted via CSS mask. Same pipeline as ability icons; same CC BY 3.0
attribution requirement (covered by the same in-game credits line).

| Our file | game-icons.net icon | Author |
|---|---|---|
| field_ration | meat | Lorc |
| stabilizer_rod | sands-of-time | Lorc |
| plating_kit | toolbox | Delapouite |
| mystery_box | perspective-dice-six-faces-random | Delapouite |
| tome | burning-book | Lorc |
| system_favor | aura | Lorc |
| boxcutter | box-cutter | Delapouite |
| cardboard_cuirass | cardboard-box | Delapouite |
| lucky_bottlecap | bottle-cap | Delapouite |
| honed_edge | broadsword | Lorc |
| swift_wraps | fist | Lorc |
| iron_plating | scale-mail | Lorc |
| padded_lining | lamellar | Lorc |
| killer_instinct | on-target | Lorc |
| glass_charm | gem-pendant | Lorc |
| focus_bead | prayer-beads | Delapouite |
| primetime_cleaver | meat-cleaver | Lorc |
| roadie_runner | running-shoe | Delapouite |
| bloodsport_maul | warhammer | Delapouite |
| showstopper_plate | breastplate | Lorc |
| stagedive_harness | cape | Delapouite |
| crowd_medallion | laurels | Lorc |
| ratings_magnet | magnet | Lorc |
| headliner_cleaver | microphone | Delapouite |
| blastplate_harness | explosive-materials | Lorc |
| landlords_ledger | notebook | Delapouite |
| overtime_clause | time-trap | Lorc |
| ozone_wand | crystal-wand | Lorc |
| cursed_amplifier | sonic-shout | Lorc |
| stormcall_staff | lightning-storm | Lorc |
| sweeps_week_staff | lightning-branches | Lorc |
| crash_helmet | full-motorcycle-helmet | Delapouite |
| tour_treads | converse-shoe | Delapouite |
| box_seat_crossbow | crossbow | Carl Olsen |
| gyro_stabilizer | vortex | Lorc |
| mosh_pit_helm | horned-helm | Lorc |
| encore_treads | wingfoot | Lorc |
| perpetual_encore | orbital | Lorc |
| standing_ovation | theater-curtains | Delapouite |
| signature_choreography | ballerina-shoes | Delapouite |
| plot_armor | drama-masks | Lorc |
| vip_pass | ticket | Delapouite |
| blood_subscription | heart-drop | Lorc |
| cancellation_axe | battered-axe | Lorc |
| live_feed | tv | Delapouite |
| backstage_pass | magic-portal | Lorc |
| location_scout | treasure-map | Lorc |
| elite_trophy | trophy-cup | Delapouite |
| boss_sigil | crowned-skull | Lorc |
| gold | two-coins | Delapouite |

### UI icons — `public/icons/ui/` (same source, license, and convention)

Chrome icons that replaced the emoji glyphs (STYLEGUIDE.md rule three:
icons are drawn, never typed). CSS-mask tinted via `.uic`.

| Our file | game-icons.net icon | Author |
|---|---|---|
| party | crossed-swords | Lorc |
| skull | skull-crossed-bones | Lorc |
| race | laurels | Lorc |
| shopping | shopping-cart | Delapouite |
| marker | position-marker | Delapouite |

### Fonts — `public/fonts/` (SIL Open Font License 1.1)

The Torchlit Broadcast type system (STYLEGUIDE.md). OFL license texts ship
alongside the files (`OFL-Cinzel.txt`, `OFL-AlegreyaSans.txt`).

| File | Family | Role | Source |
|---|---|---|---|
| Cinzel.ttf (variable) | Cinzel | Display: titles, labels, buttons | github.com/google/fonts (ofl/cinzel) |
| AlegreyaSans-{Regular,Bold,Italic}.ttf | Alegreya Sans | Body: text, tooltips, data | github.com/google/fonts (ofl/alegreyasans) |

## AI-generated assets — `tools/asset-pipeline/`

The asset pipeline (`tools/asset-pipeline/`) generates new models with Meshy AI
and re-textures them onto the KayKit gradient atlas so they match the packs
above. Provenance rules for anything it produces:

- `tools/asset-pipeline/palette/*.png` are atlas textures **extracted from the
  KayKit GLBs already recorded above** (CC0, Kay Lousberg) — same license,
  same origin.
- Meshy-generated models are governed by the **Meshy plan's license at
  generation time**, not CC0 — free-tier output is CC-BY/non-commercial;
  paid tiers grant commercial rights. When committing a generated model to
  `public/assets/`, add it to a table here with `Meshy (<plan>)` as the origin.

## Licensing hygiene

- Keep this file's table as the source of truth for every asset's origin + license.
- CC0 needs no attribution, but record it anyway so provenance is never lost.
- If you ever add a non-CC0 asset (e.g. CC-BY), add it to the attribution section
  above and to an in-game credits screen.
