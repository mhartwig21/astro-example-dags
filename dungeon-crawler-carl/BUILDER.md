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

**Into the game**: drop the exported JSON into `src/content/rooms/<id>.json`,
register it in `src/content/rooms/index.ts`. Mapgen stamps registered
templates into eligible rooms (seeded, ≤2 per floor, never the entrance or
stairs room, needs a room 2 tiles larger than the template each way — keep
templates small, 7×5 fits far more rooms than 9×7). Props render from
`map.stamps`; walls are real sim tiles.

## Enemies tab

Pick a body (any character key, including compiled creatures), a behavior
(an existing archetype brain — the sim keeps `kind = behavior`, so every AI
branch and `ARCHETYPES` read works untouched), stat multipliers, scale, tint,
spawn bands + weight. Export JSON → `src/content/mobs/<id>.json`, register in
`src/content/mobs/index.ts`. At spawn, a matching roll substitutes the def
for its behavior kind in its bands (data-gated: floors with no matching defs
replay identically). Example shipped: THE AUDITOR (`the-auditor`).

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
