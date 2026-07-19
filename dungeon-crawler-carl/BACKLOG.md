# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

## The polish ranking (owner-approved 2026-07-17)

The base game is where the owner wants it — the current directive is POLISH
over features. Ranked by elevation-per-effort; pick from the top unless a
session has a reason not to. Numbers reference the entries below.

1. Boss identity + the kiting fix (#6 + #12) — fights are the memories
2. Data-driven balance pass (#13) — usage_events is sitting unmined
3. Itemization depth (#14) — prune dead affixes, named build-benders, drop drama
4. Combat micro-feel audit (#15) — hit-stop, overkill, per-weapon-class feel
5. Announcer tone sweep (#16) — the menus went dry-System; the sim should follow
6. First-visit payload diet (#7) — the invite-link first impression
7. Status-effect sensory completion (#2 + #3) — close the shipped system
8. Per-band music beds (#17)
9. Touch tuning on real glass (#5) — blocked on owner hardware
(2D-host status parity is explicitly deprioritized: debug view, invisible polish.)

Unranked additions (2026-07-17, from the same polish review): #18 stat
transparency (slots naturally beside #14 — same respect-the-builder energy),
#19 readability + accessibility (rises fast if playtests hit late-floor
soup), #20 frame-budget audit (do it BEFORE #12 adds boss FX load).

2. **Status effects in the 2D host + character sheet.** The 5.13 status layer
   ships with 3D-host presentation only (tinted numbers, HUD/boss-bar pips,
   monster ring). The 2D canvas host (`src/render/`, `src/main.ts`) renders
   DoT numbers untinted and shows no pips; the Crawler Profile (`sheet.ts`)
   doesn't yet print burn/poison DPS rows for Afterburn/Frost/Venom builds.
   Sim data is all there (`statuses`, `HitEvent.effect`). NOTE the ranking
   splits this entry: the sheet.ts DPS-rows half is ranked (#7 slot, with
   #3 — it completes the shipped status system and feeds #18); the 2D-host
   half is the explicitly deprioritized part.
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
    line on first blood (RESIDENT_LINES). STILL OPEN (everything else above
    shipped — ignore any older phase framing): (a) settlement/stronghold
    room dressing for Roam (coordinate with the Roam session's arc);
    (b) prop gaps — beds, food, anvil, altar live in the untapped KayKit
    Furniture/Restaurant/RPG Tools packs; extract via the established
    pipeline (tools/asset-pipeline, record in ASSETS.md) and slot into
    `PURPOSE` dressing tables in `src/sim/roomPurposes.ts`.
11. **Roam mode isn't saved/resumable yet.** `createGame`'s new `runKind`
    param (`"race" | "roam"`) never round-trips through `SavedProgress`
    (`src/persist/save.ts`) — closing the tab mid-Roam and hitting CONTINUE
    RUN silently rebuilds as Race. Worse than a lost preference: at the
    floor-18 stairs a restored Roam run hits the RACE finish-line rule and
    ends ("won") instead of descending. **The fix is already written:
    draft PR #123** (`fix-2d-stairs` branch) adds `runKind?` to both save
    shapes + `restoreGame`, with a roam-restore regression test, a
    stairs-reachability sweep (`test/stairs-sweep.test.ts`), and the 2D
    host's `?test`/`?debug=1` `__dcc` probe hook. Needs a rebase (save.ts
    gained `unclaimedAchievements` since) and a merge decision.

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
    BALANCE-NOTES.md so later tuning has a baseline.
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
    the full surface; tips.ts and revisions.ts copy too. Second half (same
    PR or a follow-up): CONTEXTUAL triggers — the System noticing YOU. The
    sim already knows the moments (clutch sub-10%-HP escapes, kill streaks,
    dying twice to the same archetype, a shopper who buys nothing); a
    handful of new `announce()` call sites keyed to them beats fifty more
    generic lines. The Show already tracks hype/frenzy — reuse those
    signals rather than adding state.
17. **Per-band music beds** (polish ranking #8). Six band-themed loops so a
    band transition is a PLACE change, not a palette swap. Seam is ready:
    `audio/manifest.ts` clips + `director.ts` already routes music by
    context (band sting shipped). Sourcing is the work: CC0 loops or the
    Meshy-era generation pipeline's audio equivalent; record provenance in
    ASSETS.md.
18. **Stat transparency — show the math** (the PoE lesson; unranked, pairs
    with #14). Build-crafters stay when the game respects their arithmetic.
    `sheet.ts` already computes every derived number; the polish is making
    each one TRACEABLE at the surface: (a) P-panel tooltips that decompose a
    stat (melee 214 = base × rank × stance × affix lines, one row each —
    sheet.ts already has the factors, the P panel in `main3d.ts` just prints
    totals); (b) shop/bag item tooltips show the DELTA against equipped
    (`itemtip` in main3d.ts has both items in hand already); (c) the #2
    DoT-DPS rows land here too. Pure host/UI work, zero sim changes; do
    after #13's pruning so tooltips explain affixes that survived.
19. **Readability at depth + accessibility accents** (the LoL lesson:
    clarity beats spectacle; unranked, rises if late-floor playtests report
    soup). #15 ADDS juice — this is the matching restraint pass. (a) An FX
    budget: when N effects are live (orbit blades + statuses + hazards +
    strikes), lower-priority glows dim or skip — extend the existing
    particle/fxSprite caps in renderer3d.ts into a priority scheme instead
    of first-come-first-served. (b) Silhouette audit per band: player/mob
    read against each band's floorTint at iso distance (screenshot sweep
    via the verify skill, one shot per band). (c) Accessibility: status and
    rarity are currently color-ONLY signals — add a shape/glyph channel
    (pips already exist; vary their SHAPE per effect), and a K-panel
    reduced-flash toggle that caps shake amplitude + full-screen flashes
    (`dcc:*` localStorage convention, juice call sites in renderer3d.ts).
20. **Frame-budget audit at depth** (unranked; do BEFORE #12 piles boss FX
    on top). Late floors now carry room dressing, breakables, fog banks,
    torch lights, and per-frame portal/status animation — nobody has
    profiled a floor-15 arena fight on weak hardware. Add a ?debug=1 HUD
    line (frame ms, draw calls from `renderer.info`, live particle/light
    counts), capture a baseline per band via the verify skill, then attack
    the top offender only (likely candidates: per-frame Box3 work, light
    count on dressed floors, transparent overdraw from stacked additive
    FX). Budget: 60fps on an integrated-GPU laptop at view=close.
