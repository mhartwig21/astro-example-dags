# DCC Builder — the crafting bench (`/builder.html`)

The owner's creative-control surface: design dungeon rooms from the KayKit
prop palette, compose enemies from any character body + an existing behavior
brain, and (on the dev box) generate brand-new props and creatures through
the Meshy pipeline — all exported as data the game imports.

## Rooms tab

Paint tiles (Floor/Wall; RMB or Erase reverts), place props from the palette
(every `/assets/dungeon/` manifest key; R rotates the last-placed), then
Save (localStorage) / Export JSON.

**Contract**: the border ring and center tile must stay FLOOR, and interior
walls need 2-wide gaps — the stamper validates and silently reverts designs
that would create 1-wide chokepoints (the floor-wide 2x2-walkable invariant).

**Into the game**: on the dev box, **Ship to game** writes
`src/content/rooms/<id>.json` and registers it in `index.ts` for you — review
the git diff and commit. (Manual path still works: drop the exported JSON in
and register it yourself.) Mapgen stamps registered templates into eligible
rooms (seeded, ≤2 per floor, never the entrance or stairs room, needs a room
2 tiles larger than the template each way — keep templates small, 7×5 fits
far more rooms than 9×7). Props render from `map.stamps`; walls are real sim
tiles.

**Test Walk ▶** registers the work-in-progress template, hunts (floor, seed)
pairs with the game's real derivation (`floorSeed` + `generateFloor`) until
one stamps it, and opens that exact dungeon in a test tab — walk your room
before shipping it. The "Game rooms (shipped)" list loads existing templates
for editing; re-ship to update.

## Enemies tab

Pick a body (any character key, including compiled creatures), a behavior
(an existing archetype brain — the sim keeps `kind = behavior`, so every AI
branch and `ARCHETYPES` read works untouched), stat multipliers, scale, tint,
spawn bands + weight. **Ship to game** (dev box) writes
`src/content/mobs/<id>.json` + the registry entry; Export JSON is the manual
path. At spawn, a matching roll substitutes the def for its behavior kind in
its bands (data-gated: floors with no matching defs replay identically).
Example shipped: THE AUDITOR (`the-auditor`).

**Test Fight ▶** stashes the def in localStorage and opens a test run on its
first band's floor; the test-mode host registers it with every band + weight
99, so most spawns of its behavior become YOUR enemy — fight it before you
ship it. "Game enemies (shipped)" loads existing defs for editing.

## Dressing tab

Previews the **vignette grammar** (`src/sim/roomPurposes.ts` +
`src/render3d/dressing.ts`) on the Rooms-tab footprint — the SAME
`dressRoomPurpose`/`spillPurposeDoorways` code the game's floor build runs,
so what you see is what a real floor gets. Pick a purpose × variant ×
condition, reroll the placement seed to shuffle layouts, and a synthetic
south doorway shows the corridor spill. The right panel holds the RESOLVED
purpose as editable JSON: tweak prop keys / sets, **Apply** to re-dress
(unknown keys render as stand-in boxes and are listed), and **Ship to game**
(dev box) upserts the entry in `src/sim/roomPurposes.data.json` — shipping a
base purpose keeps its authored variants unless your JSON brings its own.
Rooms under 5×5 don't dress (matches the in-game candidate filter). Purpose
DATA lives in `roomPurposes.data.json` (in variants, `null` = "remove the
base field"); the grammar/types stay in `roomPurposes.ts`.

## Meshy bridge (dev box only)

`npm run dev` hosts `/__builder/*` endpoints that run the asset pipeline
(needs `MESHY_API_KEY` + `BLENDER_BIN` in the environment). The deployed
builder page detects the bridge is absent and hides the panel.

- **Generate Prop** (~20 credits): text-to-3D + palette snap →
  `public/assets/generated/<id>.glb` + an `index.json` entry the game's
  loader picks up. Usable in room designs immediately after a reload.
- **Generate Creature** (~40 credits): the creature compiler
  (`orchestrator/creature.py`) — text-to-3D (T-pose) → Meshy auto-rig → the
  standard clip set (Idle/Walking_A/Attack/Hit_A/Death_A as presets 89/1/96/
  178/8) on the creature's OWN skeleton, renamed to the clip-matcher
  vocabulary (`blender/rename_clip.py`). No cross-skeleton retargeting.
  Creature bodies are NOT palette-snapped (re-UV vs skinning untested) —
  prompt "flat colors" and let the emissive tint do the rest.

`public/assets/generated/` is git-ignored scratch space. **Promoting a
creation to shipped content**: copy the GLB(s) into `public/assets/dungeon/`
or `public/assets/characters/`, add the `MODEL_MANIFEST` row, and record
provenance in ASSETS.md — same as every other asset.
