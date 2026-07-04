# Backlog

Play-driven backlog from live runs (2026-07-04). Items are roughly in the
order reported, not priority order. Each entry notes the likely code home so
any session can pick one up cold. Delete items when they ship (git history
remembers).

## 1. Mob density still too low — tuning

More mobs per floor. Density lives in `src/sim/config.ts`:
`monsterBaseCountFloor1` (13), `monsterCountPerFloor` (3), `monsterMaxCount`
(44), plus pack shape (`packSizeMin/Max` 3–6, `packLoneFraction` 0.2).
Raise, then let the balance bot regression tests (`test/balance.test.ts`)
confirm floors stay clearable — they encode "playable", not "current numbers".

## 2. More mob variety, including abilities — feature

Eight archetypes exist (grunt/swarmer/brute/ranged/boss/bomber/shaman/phantom)
plus 4 elite affixes. Directions:
- New archetypes in `src/sim/ai.ts` + `ARCHETYPES`: e.g. a charger (telegraphed
  line rush), an AoE spitter (ground puddles), a necromancer that raises fresh
  corpses (the skeleton GLBs literally ship a `Death_C_Skeletons_Resurrect`
  clip), a shieldbearer that blocks frontal damage.
- More elite affixes (frost/slow aura, thorns, splitter-on-death).
- Quaternius CC0 animated monster packs (see ASSETS.md) for non-humanoid
  skins once behaviors exist — the clip animator fuzzy-matches names, so new
  packs inherit the animation machine.

## 3. Shop/inventory visual bug when the bag gets big — bug

The safe-room System Shop inventory panel breaks visually with a large bag.
UI in `iso.html` + `src/main3d.ts` (shop/inventory render). Constraint from
the house style: panels must FIT the viewport — fix with a tighter grid /
capped rows, not scrollbars.

## 4. Shop shows no icons for equipped gear + bag items — bug

Catalog entries have icons (`/icons/items/<catalogId>.svg`), but player items
are *generated* (`src/sim/items.ts` names like "Cruel Blade") with no icon
mapping — so the "yours" side of the shop renders iconless. Add a noun→icon
map (weaponry.ts already maps nouns→meshes; mirror that for 2D icons, reusing
catalog icons where the noun matches, game-icons.net CC-BY for the rest —
attribution row in ASSETS.md required).

## 5. Dropped items outscale shop items quickly — tuning/design

Ground drops scale with floor (`generateItem` affix budgets grow), while the
System Shop catalog (`src/sim/catalog.ts`) is mostly static — a few floors in,
the shop is strictly worse than the floor loot. Options: floor-indexed catalog
stat scaling, per-band restock tiers, or repositioning the shop as the home of
consumables/materials/signature gear (things drops can't give) rather than
stat sticks.

## 6. Shop doesn't gate item purchases on prerequisites — bug/design

Reported: "inventory shop doesn't require the builds from items to already be
purchased to buy the item." Needs a repro/clarification pass — likely meaning:
tiered/upgrade items in the catalog can be bought without owning the base item
they build on. Audit `buyCatalogItem` (`src/sim/game.ts`) + catalog tier
definitions and add prerequisite gating.

## 7. Higher upgrade caps + scarcity = chase-able OP builds — design

Constellation nodes cap at maxRank 1–3 (`src/sim/abilities.ts UPGRADES`).
Explore raising ceilings so OP builds EXIST, but gate the tail ranks behind
scarcity so hitting one is a run-to-run lottery, not a guarantee:
- "Overrank" ranks past current max that only appear in drafts rarely
  (weighted by floor/luck), or via a rare "System Favor" drop.
- Keep the balance bot honest: OP must mean "feels broken", not "breaks the
  regression tests" — tune monster scaling alongside.

## 8. Boss name overlaps announcements — popup collision audit — bug

The ringside encounter banner and announcement toasts collide (there was a
prior `#banner` id collision fix — the layout conflict remains). Do a full
audit of everything that can occupy the screen at once: encounter banner,
announcement toasts, headline moments, level-up draft, sponsor draft,
achievement pops, minimap, cockpit. Define screen zones + a single stacking
policy (in `iso.html` CSS + `src/main3d.ts` toast/banner code) so no two
systems ever claim the same pixels.

## 9. Way too many System notifications — UX

Announcements already carry `kind` (boss/progress/levelup/loot/achievement/
show/flavor) and `priority` (`announce()` in `src/sim/game.ts`) — the host
just renders too many as center-screen toasts. Route by kind/priority:
- Center toasts: ONLY high-priority headliners (boss, wipe, epic/ultimate
  loot, new band).
- Everything else: a compact side ticker/log that fades, or suppressed
  entirely behind a verbosity setting (e.g. `dcc:notify` local setting with
  critical/normal/all).
The sim already provides the data; this is purely host-side routing.
