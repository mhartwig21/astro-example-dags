# Backlog

Play-driven backlog from live runs (2026-07-04). Items are roughly in the
order reported, not priority order. Each entry notes the likely code home so
any session can pick one up cold. Delete items when they ship (git history
remembers).

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

## 10b. Itemization phase 3: school counterplay + caster catalog — design/feature

Phases 1–2 of DESIGN 5.8 shipped (attackPower/spellPower, weapon classes,
bolt-from-weapon). Remaining:
- Monster resist tags: `armored` (physical −30%) / `warded` (magic −30%) as new
  elite affixes + a couple of archetype defaults — damageMonster already
  receives the school on every hit, so this is a multiplier at one choke point.
- A caster branch in the System Shop catalog (basic `spell` components building
  into advanced/legendary staff-flavored gear) so SP builds can SHOP, not just
  pray to the drop gods.
- Damage-number tinting by school in the juice layer (HitEvent.school ships).

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
