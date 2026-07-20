# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

## The polish ranking (owner-approved 2026-07-17)

The base game is where the owner wants it — the current directive is POLISH
over features. Ranked by elevation-per-effort; pick from the top unless a
session has a reason not to. Numbers reference the entries below.

1. Boss identity (#12) — fights are the memories. (The #6 kiting half
   SHIPPED 2026-07-20: chase-speed patience ramp, `bossChaseRamp*` in
   config.ts — contact resets, capped 1.65x, announced once.)
2. Data-driven balance pass (#13) — usage_events is sitting unmined
3. Itemization depth (#14) — prune dead affixes, named build-benders, drop drama
4. Combat micro-feel audit (#15) + telegraph readability pass (#18)
5. Announcer tone sweep (#16) — the menus went dry-System; the sim should follow
6. First-visit payload diet (#7) — the invite-link first impression
7. Status-effect sensory completion (#2 + #3) — close the shipped system
8. Per-band music beds (#17)
9. Touch tuning on real glass (#5) — blocked on owner hardware
(2D-host status parity is explicitly deprioritized: debug view, invisible polish.)

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
7. **Asset payload diet (the 10x-assets path).** Streaming boot + ETag/gzip
   shipped 2026-07-10; levers (a) audio-behind-models and (b)+(c)
   meshopt + WebP compression shipped 2026-07-20: model payload
   **26MB → 10.6MB gz** (assets 73→45.5MB raw; dungeon props −76%), audio
   (23.5MB gz, incompressible) now loads on idle AFTER the game is playable.
   `scripts/compress-assets.mjs` re-compresses everything in place — RUN IT
   AFTER IMPORTING NEW GLBs (simplify stays off; only-replace-if-smaller;
   loader side is MeshoptDecoder in assets.ts, without which compressed GLBs
   don't parse). Still open if 10x really lands: (d) per-band manifest chunks
   that lazy-load on first descent, KTX2 GPU textures, and re-encoding the
   chunky 1.0-generation clip libraries (animation data now dominates the
   remaining 43MB characters dir).

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

12. **Boss signature mechanics** (polish ranking #1, with the #6 kiting fix).
    Band bosses are cast reuses with phase layers; none has a mechanic you
    must LEARN. Give each of the six one signature (the Sump King floods
    lanes, the Condemned Architect rebuilds walls mid-fight, the Furnace
    Marshal vents heat rows…) so every band's wall has a different answer.
    Design per-boss in MOB-CONCEPTS style first; code: boss branch of
    `src/sim/ai.ts`, `arenaDirector` in `game.ts`, `boss*` knobs in
    `config.ts`. Ship one boss per PR — each is independently testable via
    `?test&floor=N`.
13. **Data-driven balance pass** (polish ranking #2). `usage_events` (SQLite,
    litestream-replicated — see DEPLOY.md Observability) has logged per-floor
    build summaries since it shipped and has never been queried. Mine it:
    where do runs die, which constellation nodes are never picked, which
    weapon classes dominate, where does the difficulty curve sag. Then tune
    `config.ts` against evidence and re-run the balance-bot contract. Query
    via `fly ssh console` + `sqlite3 /data/dcc.sqlite` or
    `PersistDb.listEvents`; findings worth keeping go in a short
    BALANCE-NOTES.md so later tuning has a baseline. Complement the mined
    data with a seed-VARIANCE harness (bot over N seeds x floors, flag the
    outlier tails that starve drafts or stack early elite affixes —
    `src/sim/bot.ts`); tuning the tails is what makes the Daily fair.
14. **Itemization depth** (polish ranking #3). Three cuts, no new systems:
    (a) prune dead affixes — anything no build ever wants is noise on every
    drop (`src/sim/items.ts` affix tables; #13's data names the corpses);
    (b) a small set of NAMED build-benders — items with one rule-breaking
    line ("Nova leaves a burning ring", "dash gains a charge, loses
    i-frames") that create decisions, not bigger numbers (items.ts + hooks in
    `game.ts`/`abilities.ts`, catalog.ts if purchasable);
    (c) drop drama — the rare+ drop moment (beam/sound/brief hold) is most of
    what "good itemization" FEELS like (`render3d` ground-item presentation +
    `audio/director.ts`).
15. **Combat micro-feel audit** (polish ranking #4). The last 10% after the
    combat-feel arc: a few frames of hit-stop on crits/kill blows, overkill
    corpse launch, distinct swing/impact feel per weapon class. All
    presentation-layer: `render3d/juice` + `audio/director.ts` keyed off
    existing `HitEvent` data (no sim changes).
16. **Announcer tone sweep** (polish ranking #5). The menus went dry-System
    (2026-07-16, see the campfire PRs); the in-game `announce()` lines still
    carry game-show barker copy, and CLAUDE.md still SAYS "game-show
    announcer voice" — update both. Register: dry bureaucratic menace,
    deadpan legalese, dark humor (the books), never carnival. Also delete the
    weakest ~20% of lines; fewer, better. Grep `announce(` in `src/sim/` for
    the full surface; tips.ts and revisions.ts copy too.
17. **Per-band music beds** (polish ranking #8). Six band-themed loops so a
    band transition is a PLACE change, not a palette swap. Seam is ready:
    `audio/manifest.ts` clips + `director.ts` already routes music by
    context (band sting shipped). Sourcing is the work: CC0 loops or the
    Meshy-era generation pipeline's audio equivalent; record provenance in
    ASSETS.md.
18. **Telegraph + readability consistency pass** (polish ranking #4, paired
    with #15). One visual language for windups — same shape = same dodge
    answer — across monster windup rings, hazard decals, and boss
    signatures; enemy silhouette contrast against the denser room dressing;
    a damage-number diet. Target: every death reads "I was greedy", never
    "what hit me?". Code: renderer3d windup/hazard presentation + THEME
    semantic colors; audit against the fairness rule in DESIGN.md.

## The AAA bar (2026-07-10 assessment)

Priority-ordered gaps between "complete to spec" and "a AAA player calls it
polished," scoped to the room-grammar arc. Overlaps with the polish-ranking
entries above are cross-referenced, not duplicated. Items 19-20 have a full
design doc — see `PHYSICALITY.md`.

19. **Room-grammar telemetry** — extends #13's `usage_events` (SQLite is
    live) with room events: dressed-room entry, service-contract touch/buy/
    walk, wager outcomes, breakable smashes, resident-line triggers. The
    grammar was tuned by bot; these numbers let #13's balance pass cover it.
20. **Physicalized furniture** — big furniture blocks movement via a
    removable `FloorMap.blocked` mask stamped from the dressing plan;
    blocking pieces are hp-2 breakables (smash through the bookcase to
    flank). Full design: `PHYSICALITY.md` §1. Gate: connectivity fuzz over
    300 seeds.
21. **Animation pass (residents act)** — host-side staging off
    `Monster.residentOf`: grafted props (mug/book/map) via the weaponry
    hand-slot seam, lying poses on beds, paired sparring with the existing
    attack clip; later a commissioned `rig_medium_ambient` clip library.
    Full design: `PHYSICALITY.md` §2.
22. **Audio for the room grammar** (joins #3 status cues + #17 music beds):
    smash crunch, per-purpose room tone (forge hum, den murmur), service
    purchase sting, a stinger under System lines. Seam:
    `src/audio/director.ts`; nothing new is mapped.
23. **VFX + lighting quality.** Breakable pop reuses the generic hit poof
    (no splinters/debris); dressed rooms rely on a capped point-light pool.
    The gap vs the KayKit reference renders is mostly soft shadow/AO.
24. **Interaction UX + accessibility** (pairs with #18 readability):
    service contracts have no approach prompt or minimap icon; gold/purple
    loot halos are not colorblind-safe; controller/touch parity for the
    newest flows unaudited.
25. **Roam re-stock exploit (latent bug).** `buildFloor` re-rolls
    breakables and the service room on every build; when Roam floor
    REVISITS land, consumed services/hoards regenerate free. Fix: persist
    consumed ids per floor in the world checkpoint (PERSISTENCE.md) or
    derive consumption from world state. Harmless in Race (one-way floors)
    — fix before Roam revisiting ships.
26. **Prop rendering perf.** Dressing + breakables are CLONED meshes under
    a 185-prop cap, not GPU-instanced batches; torch lighting is a pooled
    hack. Fine on desktop today; instancing + LOD before mobile/minspec
    matters. Code: `place()` in the renderer3d/dressing env.
27. **Systemic narrative depth.** Floor stories are one-liners with one
    chase payoff; the ceiling is multi-floor arcs, room-driven quests, and
    (eventually) a voiced System. Composes with interference + Roam quests.
28. **Hardening.** New-entity netcode under packet loss, save-migration
    tests beyond the one golden fixture, prop-placement edge-case QA
    (tabletop clipping, mounts on odd walls), soak tests.
