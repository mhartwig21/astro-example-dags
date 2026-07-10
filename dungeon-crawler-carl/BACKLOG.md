# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

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

7. **Asset payload diet (the 10x-assets path).** Streaming boot + ETag/gzip
   shipped 2026-07-10 (`startModelLoad` in assets.ts, static caching in
   gameServer.ts) — boot no longer scales with asset count and repeat visits
   are free. What still scales with 10x is FIRST-visit bandwidth (~26MB gz
   today). Levers, in order: (a) deprioritize audio behind the model wave
   (24MB raw competes with wave 1 on slow pipes — `void audio.load()` in
   main3d fires at module init); (b) meshopt/Draco-compress the GLBs at
   import time (tools/asset-pipeline); (c) KTX2 texture transcoding + atlas
   dedup — the 61MB characters dir repeats the same KayKit atlas per file;
   (d) per-band manifest chunks that lazy-load on first descent into a band.

10. **Room vignette grammar, phases 2-3** — phase 1 shipped (2026-07-09):
    `ROOM_PURPOSES` in `src/render3d/floorThemes.ts` + pass 3.5 in
    `renderer3d.buildFloor` dress up to 4 combat rooms per interior floor as
    storage/mess/archive/guardpost (wall runs, wall-mounted decor, table
    sets, a sconce per room). Phases 2-3 LARGELY
    SHIPPED (2026-07-10): the grammar moved to `src/sim/roomPurposes.ts` as
    the shared pure truth (`assignRoomPurposes(seed, floor, map)`); band
    allowlists + zoning, condition modifiers (looted/scarred/overgrown),
    corridor connective tissue, and occupancy v1 (packs gather at the
    dressed room's furniture anchor) are all live. Still open: purpose-aware
    ARCHETYPE bias (skeletons prefer the ossuary), one seeded story-event
    per floor applying conditions along a path, and settlement/stronghold
    room dressing for Roam. Phase 3: occupancy coupling — purpose-aware spawn placement (the
    kennel spawns beasts, the mess pack sits AT the table) + one seeded
    story-event per floor applying conditions along a path. Prop gaps (beds,
    food, anvil, altar) live in the untapped KayKit Furniture/Restaurant/RPG
    Tools packs — extract via the established pipeline.
11. **Roam mode isn't saved/resumable yet.** `createGame`'s new `runKind`
    param (`"race" | "roam"`) never round-trips through `SavedProgress`
    (`src/persist/save.ts`) — closing the tab mid-Roam and hitting CONTINUE
    RUN silently rebuilds as Race. `SaveData` needs an optional `runKind?`
    field (the codebase's existing optional-field + load-time-default
    convention, e.g. `revisions?`/`tipsSeen?`) once Roam is worth resuming.
    Not a blocker for v1 (SETTLEMENTS.md scoped v1 as no-persistence), but
    easy to forget once real persistence work starts.
