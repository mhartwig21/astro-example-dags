# Art & audio assets — open-source sourcing

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

### Characters & monsters (rigged + animated — the big 3D win)
| Pack | Author | License | Link |
|---|---|---|---|
| KayKit Character Pack: Adventurers | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-adventurers |
| KayKit Character Pack: Skeletons | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-skeletons |
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
  music/  dungeon.ogg, safe_room.mp3, collapse.wav   (loops)
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

Not yet sourced: `sfx/crowd.ogg` (multi-kill roar), and the combat-feel trio
`sfx/swing.ogg` (melee whoosh), `sfx/tell.ogg` (enemy windup cue), and
`sfx/kill.ogg` (killing-blow thump). Kenney Impact/RPG Audio (CC0) have good
candidates for all three; the game stays silent for each until a clip is added.

Note: **freepd.com has shut down** ("Site Closed") — removed from the source
table guidance; OpenGameArt (license-filtered to CC0) is the better music source.

### Attribution (CC-BY assets in use)

_None — everything committed is CC0. Add a row here (author, work, license,
link) for every CC-BY file you commit, and mirror it in the in-game credits
screen._

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
| carpet-bombing | airstrike | Skoll |
| quake-stomp | cataclysm | Lorc |
| stopwatch | bullettime | Lorc |

Convention: `/icons/<abilityId>.svg`, background rect stripped so the white
glyph works as a CSS mask (tinted gold for actives, purple for ultimates).
New abilities: pick an icon at game-icons.net, fetch the raw SVG from the
GitHub mirror, strip `<path d="M0 0h512v512H0z"/>`, and add a row here.

## Licensing hygiene

- Keep this file's table as the source of truth for every asset's origin + license.
- CC0 needs no attribution, but record it anyway so provenance is never lost.
- If you ever add a non-CC0 asset (e.g. CC-BY), add it to the attribution section
  above and to an in-game credits screen.
