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
## Polish program (ranked 2026-07-20 — the owner's "elevate, don't expand" pass)

The ranking principle: runs are remembered by their peaks (bosses) and their
deaths (fairness), so polish concentrates there before spreading evenly.
Boss anti-kite (the old item 6) shipped with this ranking's first commit:
chase-speed patience ramp in the boss branch of `src/sim/ai.ts`
(`bossChaseRamp*` knobs in config.ts, contact resets, capped, announced once).

P1. **Itemization: decisions, not stat soup.** Every rare+ drop should force
    a five-second think. (a) Prune overlapping small affixes into fewer,
    chunkier ones (`src/sim/items.ts` affix tables); (b) a hand-authored set
    of 8-12 BUILD-AROUND uniques that bend a rule ("Nova leaves burning
    ground", "flask overheal becomes a shield"), gated to boss kills and
    vaults so chase exists — new `uniques.ts` beside items.ts, hooks in the
    boss/vault drop paths of game.ts; (c) drop tooltips show what the shop
    builds toward (`catalog.ts` buildsInto is already queryable).
P2. **Death fairness: telegraph + readability consistency pass.** One visual
    language for windups (same shape = same dodge answer) across
    monster rings, hazard decals, and boss signatures; enemy silhouette
    contrast against the denser dressing; a damage-number diet. Target:
    every death reads "I was greedy", never "what hit me?". Code:
    renderer3d windup/hazard presentation + THEME semantic colors.
P3. **Seed-to-seed variance tuning.** The bot tests hold the difficulty
    FLOOR; outlier seeds still starve drafts or stack early elite affixes.
    Add a bot-driven variance harness (N seeds x floors, flag outliers) to
    balance.test.ts's toolkit and tune the flagged tails — this is what makes
    the Daily fair. Code: `src/sim/bot.ts` harness, drop/draft pacing knobs.
P4. **First-visit payload diet** — see item 7 below (already scoped).
P5. **Audio coverage** — status cues + band sting shipped 2026-07-19; still
    open: per-band boss intro stings, purpose-room ambient layers, and the
    parked real-audio sourcing (needs the owner's manual Kenney download).
P6. **Host parity + sheet completeness** — see item 2 below (already scoped).

Deliberately out of scope for the polish pass: new mobs/rooms/modes (breadth
exists; the roster + vignette systems generate variety already).

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
    dressed room's furniture anchor) are all live. Residents bias (packs
    draw from PURPOSE_RESIDENTS, looted/scarred rooms half-empty) and floor
    STORY seeds (35%: looters/battle/damp sweep a condition path, announced
    once on arrival) shipped 2026-07-10. Phase 4 shipped
    2026-07-10: RARE service rooms (at most one per floor, ~40% of floors,
    pristine/overgrown only — plan.service in roomPurposes.ts) put a priced
    verb behind a touchable contract (forge tempering, apothecary draught,
    den wager at losing odds, archive floor-map, war-room clock time), and
    looter stories CHASE onto the next floor as fleeing Repo Rats (floor 4+).
    Phase 5 shipped
    2026-07-10: corner hoards are SMASHABLE sim entities (Breakable[],
    plan-positioned, popped by melee arcs + all radial AoE for pocket gold)
    and seated residents HOLD their rooms with a once-per-floor interruption
    line on first blood (RESIDENT_LINES). Still open: settlement/stronghold
    room dressing for Roam (coordinate with the Roam session's arc). Phase 3: occupancy coupling — purpose-aware spawn placement (the
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
