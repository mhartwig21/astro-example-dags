# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

1. **More shrine bargains.** The System Shrine ships with two deals + walk-away
   (`shrineChoices` in `src/sim/game.ts`). The plumbing takes any Reward — add
   a couple more floor-scoped trades (e.g. "collapse timer −20s for a free
   upgrade draft") and roll a seeded pair per shrine so repeat visits differ.
2. **Status effects in the 2D host + character sheet.** The 5.13 status layer
   ships with 3D-host presentation only (tinted numbers, HUD/boss-bar pips,
   monster ring). The 2D canvas host (`src/render/`, `src/main.ts`) renders
   DoT numbers untinted and shows no pips; the Crawler Profile (`sheet.ts`)
   doesn't yet print burn/poison DPS rows for Afterburn/Frost/Venom builds.
   Sim data is all there (`statuses`, `HitEvent.effect`).
3. **Status audio cues.** No sounds for ignite/poison/chill apply or DoT
   ticks — deliberately skipped rather than adding asset files. Seam:
   `src/audio/director.ts` maps sim events to clip ids; would key off
   `HitEvent.effect`.
4. **Clown bombs on boss blast telegraphs.** The clown-ordnance prop renders on
   EVERY blast-kind hazard, including the Architect's masonry and the Furnace
   Marshal's flame rows (Hazard carries no source tag). Reads as System
   shelling, but if it grates, add a `src` tag to `Hazard` and gate the bomb
   mesh in `renderer3d.ts`.
5. **Touch feel-tuning on a real iPad.** Touch controls shipped 2026-07-09
   (`src/input/touch.ts` + body.touch layer in iso.html) — verified headless,
   but stick dead zone (0.15), drag slop (22px), cancel radius (34px), chip
   sizes, and the stick-zone extent all want a session on real glass. Knobs
   are the constants at the top of touch.ts and the body.touch CSS block.
6. **Boss kiting trivializes fights** (play feedback 2026-07-08). Bosses can
   be walked in circles forever: melee bosses have no gap-closer and nothing
   punishes a crawler who never lets the windup start. The stagger half of the
   same feedback shipped (poise decay + post-stagger grace in
   `damageMonster`/`stepMonster`); the movement half remains. PARTIAL: the
   arena directors (2026-07-09, `arenaDirector` in game.ts) now shrink safe
   orbit paths on floors 6/9/15 on a rhythm. Still open: a leash lunge on the
   boss kit (tier-gated like slam/ritual) or a move-speed ramp when the
   target stays out of reach N seconds. Code: boss branch of `src/sim/ai.ts`,
   `boss*` knobs in `src/sim/config.ts`.

10. **Room vignette grammar, phases 2-3** — phase 1 shipped (2026-07-09):
    `ROOM_PURPOSES` in `src/render3d/floorThemes.ts` + pass 3.5 in
    `renderer3d.buildFloor` dress up to 4 combat rooms per interior floor as
    storage/mess/archive/guardpost (wall runs, wall-mounted decor, table
    sets, a sconce per room). Phase 2: band-specific purpose skins, condition
    modifiers (looted/battle-scarred/overgrown), zoning by graph distance
    (living quarters near entrance, sacred near boss), corridor connective
    tissue. Phase 3: occupancy coupling — purpose-aware spawn placement (the
    kennel spawns beasts, the mess pack sits AT the table) + one seeded
    story-event per floor applying conditions along a path. Prop gaps (beds,
    food, anvil, altar) live in the untapped KayKit Furniture/Restaurant/RPG
    Tools packs — extract via the established pipeline.
