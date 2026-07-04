# Floor biomes — asset research & room-dressing direction

Design notes from a brainstorm on expanding floor visual variety beyond the
current single-pack reskin. Nothing here is implemented yet — this is the
grounding for a future pass on `src/render3d/floorThemes.ts`. See `ASSETS.md`
for the asset-sourcing/licensing pipeline this builds on.

## Where we are today

`src/render3d/floorThemes.ts` reskins **one** asset pack (KayKit Dungeon
Remastered) across 5 depth bands (Undercroft → Sewers → Ruins → Ironworks →
Approach): each band swaps floor/wall/stairs models, a prop scatter set, and a
tint/torch color. Variety comes from *material and palette*, not from a
different kit or a different room layout. Dressing is keyed **only by depth
band** — every room on a given floor gets the same prop pool whether it's the
vault, the landmark room, or a random combat room. `floor.ts` already assigns
per-room **roles** (`entrance` / `landmark` / `vault` / `stairs` / `combat`)
that this dressing layer doesn't use yet.

## Room-build inspiration from KayKit's own demo scenes

The [Dungeon Remastered](https://kaylousberg.itch.io/kaykit-dungeon-remastered)
itch page's demo screenshots show recognizable room archetypes built from the
same modular kit: treasure chambers with gold piles, dining halls, library/
storage rooms with shelves and crates, prison cells with barred doors, and
tavern interiors. These map close to 1:1 onto our existing room roles:

| Room role | Suggested dressing set | Assets we already have |
|---|---|---|
| `vault` | Treasure chamber (gold piles, chest) | `chest_gold`, `coin_stack_small/medium/large` — currently gated to the Approach band only |
| `landmark` | Library/shrine/forge set-piece (varies per band) | `shelf_small`, `table_medium_broken`, `column`, `pillar_decorated` |
| `entrance` | Tavern/camp — a soft first impression | `barrel_small`, `keg`, `box_small`, `trunk_small_A` |
| `stairs` / `combat` | No fixed motif needed | (band theme carries these) |

**Proposal:** add a second, role-keyed dressing layer orthogonal to the
existing band layer — band decides material/palette, role decides furniture
set. Same data shape `floorThemes.ts` already uses (a prop list + density per
key), just indexed by role in addition to band. Not a rewrite.

## New pack: Forest Nature Pack — good fit

[KayKit Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) —
trees, bushes, rocks, grass, modular terrain, CC0, same stylized low-poly
single-gradient-atlas look as Dungeon Remastered (visually compatible,
same author/pipeline). Our sim only cares whether a tile is `Wall` or
`Floor` — it never cares what the tile looks like — so this drops in as
another band with zero sim changes:

- `wall` → rock outcrop / hedge
- `floor` → dirt / moss
- prop scatter → trees / bushes / rocks (same per-tile scatter mechanism
  every existing band already uses)
- `DoorLocked` (floors 3+) → a root-choked thicket instead of a wooden door,
  still functionally the same tile

Proposed as a new band, **THE OVERGROWTH** — nature reclaiming the
architecture — slotted early-mid (e.g. before Ruins), so the arc reads as
civilization → reclaimed collapse → deep stone ruins → industrial → grand
finale. The exact slot is a call to make later, not decided here.

## New packs: Medieval Hexagon / (Legacy) Medieval Builder — wrong shape

Both are hex-grid **overworld/strategy** kits — exterior buildings, road and
water tiles, village layouts — not a modular interior wall/floor/door kit
like Dungeon Remastered. They don't compose with our square room-and-corridor
generator the way Forest does.

- [KayKit Medieval Hexagon Pack](https://kaylousberg.itch.io/kaykit-medieval-hexagon) —
  200+ hex tiles/buildings (blacksmith, tavern, market, windmill, church…),
  4 color variants, CC0.
- [(Legacy) KayKit Medieval Builder Pack](https://kaylousberg.itch.io/kaykit-medieval-builder-pack) —
  also hex/RTS-oriented, sand/rock/forest biome variants, exterior only.

Two honest paths instead of forcing the fit:

1. **Skip them.** Dungeon Remastered's own tavern/dining dressing (barrels,
   kegs, tables, banners — already in our manifest, already partly used in
   the Undercroft band) already covers the "lived-in medieval" mood.
2. **Cherry-pick a few standalone building meshes** (a broken windmill, a
   church facade) purely as **non-walkable backdrop silhouettes** in a
   landmark room — decorative set-dressing, not part of the tile grid. Much
   smaller lift than pack integration.

## Why this isn't a stretch

Floors in Dungeon Crawler Carl are constructed by an alien game-show
intelligence (see `DESIGN.md`) — a floor being an overgrown ruin instead of
stone corridors is diegetically free. It's the System doing what the System
does, not a reskin excuse.

## Open items

- Pick the Overgrowth band's slot in the depth-band sequence.
- Decide whether role-based dressing ships alongside Overgrowth or as its
  own pass.
- Decide whether elites/bosses get biome-flavored set-pieces per band/role.
- If a Medieval pack ever gets pulled in for set-piece meshes, record it in
  `ASSETS.md` (source of truth for licenses) the same way every other pack
  is tracked.
