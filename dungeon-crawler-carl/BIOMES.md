# Floor biomes — asset inventory & visual-variety direction

Art direction for floor variety, grounded in the assets we actually own. See
`ASSETS.md` for the licensing pipeline, `src/render3d/floorThemes.ts` for the
implementation this steers.

## Where we are today (2026-07-05)

Shipped since the first draft of this doc:

- **Six 3-floor bands** (Undercroft → Sewers → Garden → Ruins → Ironworks →
  Approach), each swapping tiles/props/palette via `FLOOR_THEMES`.
- **Role-keyed room dressing**: band decides material/palette, room role
  decides furniture (vault = treasure hoard, landmark = per-band set-piece,
  entrance = camp). Per-floor cosmetic jitter keeps floors within a band
  distinct.
- **THE GARDEN** (floors 7-9) uses the Forest Nature Pack for its scatter —
  live trees/bushes/rocks/grass over dirt, with the Halloween crypt as its
  landmark memory.

**The limit that remains**: every band still renders wall tiles as dungeon
masonry (`wall*` models) and ground as dungeon tiles. The Garden is a dungeon
wearing a forest costume. The next leap is districts that don't read as
"dungeon" at all — see *Open-air districts* below.

## The KayKit Complete Collection — what we own (all CC0)

`The Complete KayKit Collection v6.zip` + `DemonLord.zip` (local, in
Downloads; licenses inside, mirrored to `public/assets/characters/LICENSE-*`).
22 packs, ~29k files. Conversion pipeline is documented in `ASSETS.md`
(characters ship as ready GLBs; props as gltf+bin → `npx gltf-pipeline`).

**Already integrated** (PRs #24-#27 + boss work): the monster cast +
shared-rig animation seam (Skeletons 1.1, Mystery Monthly characters, rig
clip libraries), Forest-pack Garden scatter, Fantasy Weapons for held meshes,
Dungeon Remastered 1.1 interiors, Resource Bits vault hoards, DemonLord as
the floor-18 finale boss with his summoning circle.

**Untapped, ranked by likely value:**

| Pack | What's inside | Natural fit |
|---|---|---|
| Forest Nature 1.0 (the rest) | **Modular hill/cliff WALL system** (Side/Inner/OuterCorner + Tall + Top caps), 67 rocks, 26 trees, 22 bushes, hill blocks — in **7 full colorways** | Open-air districts (below); colorways = seasonal biome variants for free |
| Adventurers 2.0 | 9 player-class characters + modular held weapons | Class select / hero skins beyond the current 4 |
| Halloween Bits (rest) | Fences, gates, coffins, cauldrons | Graveyard open-air variant; Garden landmark variety |
| Board Game Bits | Cards, dice, meeples, boards | DCC game-show set dressing (safe rooms, The Show framing) |
| Restaurant + Furniture Bits | Tables, counters, food, interiors | Safe-room interiors that feel like the System's canteen |
| Platformer Pack | Saws, spikes, moving-part traps | Floor hazards, if/when the sim grows them |
| Mystery Monthly S4-6 (rest) | 30+ more characters (Monstrosity, Tiefling, ToySoldier, FrostGolem variants…) | Future elites/bosses/NPCs |
| Character Animations 1.1 (rest) | MovementAdvanced, Simulation, Tools clip packs | Richer idle/emote states |
| Medieval Hexagon | Hex overworld tiles/buildings | Backdrop silhouettes only (wrong grid); skip otherwise |
| City Builder / Space Base / Holiday / Prototype / Block / RPG Tools | Various | No current fit; park them |

## Open-air districts: floors without dungeon walls

Goal: some bands should feel *transported* — a forest clearing, a mountain
pass — not corridors with nature props. Trees ARE the walls; the path is a
trodden track between hillsides.

### The invariant that makes this cheap

The sim never changes. Mapgen, `Wall`/`Floor` tiles, pathing, fog, the
minimap, and the 2D host are untouched — "open-air" is entirely a render
treatment of the same grid, exactly like every band so far. The one honesty
rule: **every wall tile must host a visually blocking mass** (never an open
gap you can't walk through), and canopy/foliage overhang into walkable tiles
stays small enough (~0.2 tile) that open ground never *looks* blocked.

### The render seam (renderer3d.ts, buildFloor)

Interior bands render a wall tile as a dark fill box + a thin decorated
panel on each face that borders floor (instanced per chunk). An open-air
theme (`kind: "openair"` on `FloorTheme`) replaces that one branch:

1. **Edge tiles** (wall touching floor): classify the tile's neighbor mask
   (4-neighbors + diagonals) as *side / inner corner / outer corner* and
   instance the matching **Forest `Hill_Cliff_*` piece** — the kit is
   literally cut in this grammar (Side, InnerCorner, OuterCorner, Tall
   variants, `Hill_Top_*` caps). This is the same adjacency data the panel
   loop already walks.
2. **Tree-mass interleave**: by `tileHash`, a themable fraction of edge
   tiles render as a **cluster of 2-4 trees** (jittered rotation/scale/
   offset) + undergrowth instead of cliff — so paths are sometimes hemmed by
   rock, sometimes by woods, and the boundary never reads as a repeating
   fence.
3. **Deep wall tiles** (no floor within ~2 tiles): sparse cheap filler
   (hill blocks / canopy blobs) — they're dark under fog of war anyway.
4. **Ground**: grass mats per tile; corridor tiles (the ones with exactly
   two opposing floor neighbors) get the dirt *trodden path* variant so
   routes read at a glance; room interiors get heavier grass/flower scatter
   through the existing prop layer.
5. **Doors**: `DoorLocked` tiles get a gate prop (Halloween `fence_gate` /
   a root-choked thicket) flanked per the existing `doorFlankKey` rule — a
   locked path must still look locked.
6. **Sky & light**: `background` becomes a dusk-sky tone; hemisphere light
   up, key light warmer (dappled late light keeps fog-of-war readable —
   full noon would fight the murk). Torches become `lantern_standing`
   posts; the band's ambient particles (spores/fireflies) already exist.
7. **Beyond the map**: extend a ground skirt + sparse silhouette trees into
   the PAD region the fog planes already cover, so the world ends in misty
   treeline instead of void.

### Rollout

1. **THE GARDEN converts first** (floors 7-9): it already owns the forest
   scatter; this pass swaps its walls/ground/sky. ~18 cliff pieces + a few
   more trees/rocks to convert from the zip (pipeline in ASSETS.md).
2. Later, colorways make cheap siblings: an autumn or pale variant of the
   same kit for a different band, a Halloween **graveyard-at-night**
   (fence walls + dead trees) as a landmark-floor or band variant.
3. Medieval Hexagon stays backdrop-only if ever used.

### Why this is diegetically free

Floors are constructed by an alien game-show intelligence (`DESIGN.md`) — a
floor that is simply *a forest* is the System flexing production budget,
and the announcer already sells it ("The System grew you a garden…").

## Open items

- Convert + commit the Hill_Cliff/Top set (gltf → glb, record in ASSETS.md).
- `FloorTheme.kind` + the open-air wall/ground branch in `buildFloor`.
- Decide THE GARDEN's sky/light values in-engine (screenshots at floor 7
  via `?test&floor=7`).
- Whether elites/bosses get biome-flavored set-pieces per band/role.

## Lived-in look experiment (iso.html?look=lived&view=close)

A flag-gated variant chasing the KayKit Dungeon Remastered promo look:
doorway arches over corridor tiles at room mouths, gated/window wall panel
variants (~11% of faces), corridor floor grates, interior pillar pairs in
big rooms, translucent standing-water pools in THE SEWERS, denser corner
clutter and a 265 prop cap. `view=close` zooms in by a third (a near-overhead top view was tried and rejected).
Both flags are independent and cosmetic-only — the sim never changes, and
the default look is byte-identical without them. Code: renderer3d
(`look`/`viewTop`), assets wall_doorway / wall_gated /
wall_archedwindow_gated / wall_window_open / floor_tile_grate_open /
pillar (Dungeon Remastered 1.1, CC0). If the look wins, fold it into the
band themes and retire the flag.
