# Backlog

Play-driven backlog from live runs (2026-07-04). Items are roughly in the
order reported, not priority order. Each entry notes the likely code home so
any session can pick one up cold. Delete items when they ship (git history
remembers).

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

## 10. More equipment slots (LoL has six; we have three) — design/feature

`Player.equipment` is hard-coded to `{ weapon, armor, trinket }`
(`src/sim/types.ts`, `ItemSlot`). Expand toward an ARPG spread — e.g. weapon,
armor, helm, boots, and two trinket/accessory slots. Touches:
- `src/sim/items.ts` (generation must roll the new slots; name pools per slot),
  `recomputeStats`/`equipItem`/`itemScore`/auto-equip in `src/sim/game.ts`.
- Catalog gear (`src/sim/catalog.ts`) + signature-gear passives (`Item.passive`
  checks read all equipment pieces — keep `hasPassive` slot-agnostic).
- Shop/inventory UI + cockpit paper-doll in `src/main3d.ts` / `iso.html`
  (which also intersects backlog #3/#4).
- Save migration: old `{weapon, armor, trinket}` saves must load (fold into
  the new shape with empty new slots), like the loadout migration did.
- Balance: six affix-bearing pieces stack far more raw stat than three — either
  shrink per-piece budgets or let monster scaling absorb it (balance bot gates).

## 11. Boss battles: much harder, in larger arenas — design/tuning

Two halves:
- **Harder**: boss stats/phases live in `ARCHETYPES` + phase enrage tiers
  (`Monster.phase`, boss knobs in `src/sim/config.ts`, one-shot insurance via
  `bossHitCapFraction`). Beyond raw numbers, bosses want MECHANICS: more
  telegraphed patterns (radial volleys exist), adds waves, arena hazards,
  phase-specific behaviors — a boss should be a fight you learn, not a big
  grunt. The ringside-introduction freeze is the natural place to set stakes.
- **Larger arenas**: boss rooms come from the floor generator (room roles /
  landmark rooms in the mapgen + `buildFloor`). Give boss floors a dedicated
  oversized arena room (with door seal already in place), sized so dodge/dash
  patterns have room to breathe — current rooms cramp the fight.

## 12. Victory end screen: final stats + final build — feature

`state.status === "won"` currently just announces. Add a proper run-recap
screen (host-side, `src/main3d.ts` + `iso.html`): final level, damage dealt/
taken, kills, gold, floors cleared, run time (`state.elapsed`), The Show
numbers (viewers/favorites/sponsors — "season finale ratings" framing fits
DCC), equipped gear with rarities, ability loadout + constellation ranks
(reuse the T-panel card renderer), achievements earned. All the data already
lives on `Player`/`GameState`; this is a presentation feature. Also worth a
smaller version on party wipe ("your season, in memoriam").
