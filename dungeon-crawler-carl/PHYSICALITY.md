# Physicality — furniture that blocks, residents that act

Design proposal (2026-07-10) for the top two items of the AAA-gap assessment
(BACKLOG "AAA bar" entries): physicalized furniture and the animation pass.
Neither is started. Delete sections as they ship.

Why these two first: they are the gap between "this room *reads* as a mess
hall" (shipped, vignette grammar phases 1-5) and "this room *behaves* like
one." Furniture you fight around is a mechanic; a resident who eats until
interrupted is a scene. Everything else on the AAA list polishes; these two
change what play feels like.

---

## 1. Physicalized furniture — SHIPPED (P1+P2, 2026-07-10)

Blocked mask + plan blockers + connectivity gate + hp-2 smash-to-clear are
live (see the physical-furniture PR). Still open from this section: `tall`
projectile blockers, brute smash-through (v2 — the payoff moment), and a
real-browser visual pass (headless GL was too slow for the streamed models
at review time; sim behavior is fully test-covered).

### Original design (for reference)

**Goal:** big furniture blocks movement, so rooms shape combat. Small clutter
stays walk-through. Smashing big furniture clears the lane.

### The architectural gift we already have

The dressing plan (`assignRoomPurposes`, `src/sim/roomPurposes.ts`) is pure,
sim-visible, and already positions every table, wall run, and hoard. The
landmark colonnade proved the pattern years^H^H days ago: sim-owned blocked
tiles + renderer drawing on exactly those tiles = looks and collision agree
by construction. Furniture is the same pattern with a twist: blockers must be
REMOVABLE (smashed through), so they cannot be baked into `map.tiles`.

### Design: the blocked mask

- `FloorMap.blocked?: Uint8Array` — a parallel mask over the tile grid.
  `isWalkable(map, x, y)` (in `src/sim/floor.ts`) returns false where the
  mask is set. Every consumer — player movement, monster AI, dashes,
  Extradition drags, the balance bot — inherits blocking through that one
  choke point. That is the whole reason this is tractable.
- The PLAN grows `blockers` per dressing: tile-snapped footprints for the
  BIG furniture only — the table set (1 tile), each wall-run piece that is
  furniture-sized (bookcases, bar tops, beds; kegs/crates stay clutter), the
  forge anvil. Small props and all corridor spill stay non-blocking.
- `buildFloor` stamps the mask from the plan; the renderer keeps drawing the
  same props at the same spots (it already does — the plan is shared).

### Blocking furniture IS a breakable

Merge with the phase-5 system rather than adding a second one: a blocking
piece is a `Breakable` with `hp: 2-3` and a `footprint` (tile indices).
Smashing it clears its mask bits — chopping through the bookcase wall to
flank the archive pack is the emergent move this whole feature exists for.
No `mapVersion` bump on smash (that would rebuild the floor): the mask
mutates in place, the breakable mesh vanishes (already handled), movement
opens up next step. `blocked` serializes like `explored`/`tiles` in
`snapshot.ts` (Uint8Array ↔ number[]); add to `WORLD_FIELDS` via the map.

### Projectiles and sight

Furniture blocks FEET, not shots: projectile collision keeps checking
`Tile.Wall` only, so bolts fly over tables (they are knee-high; the iso
camera agrees). v2 option: a `tall` flag (bookcases) that also blocks
projectiles — skip in v1, it doubles the test surface.

### The hard requirement: never trap anyone

Every stamped mask MUST pass a connectivity check: flood-fill from the room
door(s); every non-blocked interior tile and every doorway must remain
reachable, and spawn→stairs must remain connected floor-wide. Placement
rules that make this cheap: wall-run blockers hug walls (they cannot cut a
room), the table is a single interior tile with guaranteed ≥1-tile clearance
ring, nothing stamps within 1 tile of a doorway. Validation runs at plan
time (pure, testable); a failed stamp is simply dropped.

### Tests and known costs

- **Connectivity fuzz**: 300 seeds × floors 1-18 — no unreachable floor
  tile, stairs always reachable. This is the test that gates the feature.
- **Bot soak**: the balance suite IS the stuck-detector; expect fixed-seed
  fixture re-picks (positions shift — the documented convention applies).
- **Drag/knockback**: Extradition pulls and slam knockbacks stop at
  furniture via `moveWithCollision` automatically — add one test each.
- Monster AI has no pathfinding around obstacles beyond wall-slide; packs
  behind a table may shuffle. Acceptable v1 (they shuffle at walls today);
  the brute variant below is the real fix.

### v2 hooks (not in scope, worth naming)

- **Brutes smash THROUGH**: a brute whose path is furniture-blocked attacks
  the breakable instead of shuffling — the table explodes, the fight
  arrives. This single behavior sells the whole system.
- `tall` projectile blockers; furniture the Extradition chain can hook.

Effort: the mask + plan blockers + validation is a focused PR; the merge
with breakables a second; fixtures and fuzz a third of the total time.

---

## 2. The animation pass — residents that act

**Goal:** the seated pack *does something* until you interrupt it.

### What we have to work with

- Characters play shared rig clip libraries
  (`RIG_CLIP_MANIFEST`: `rig_medium_general / movementbasic / combatmelee /
  combatranged` + large) with fuzzy clip-name matching — new clips in those
  files are inherited by every character automatically.
- The hand-slot graft (`weaponry.ts`) attaches arbitrary meshes to hands.
  This is the cheapest aliveness money can buy: a resident holding a mug IS
  eating, holding a book IS reading — no new clips required.
- `Monster.residentOf` (purpose id) already marks who is staging; residents
  already hold position (sentries) until aggro; aggro naturally switches
  them to movement/combat clips, so the interruption transition is free.

### Phase A1 — audit (hours)

Enumerate actual clip names in the four rig libraries (a 20-line script over
the GLBs). The plan below assumes only `idle`/`attack` exist; anything found
beyond that (sit, cheer, sleep) upgrades a staging from "prop trick" to
"real clip" for free.

### Phase A2 — staging, host-side only (the meat)

A `staging.ts` module in `render3d/`: given a monster with `residentOf`,
apply a STAGING while the sim says it hasn't moved and isn't aggroed:

| Purpose | Staging (no new clips needed) |
|---|---|
| mess / den | mug or plate grafted to hand; face the table; slow idle; every 4-7s a brief head-bob "drink" (hand bone rotation, 0.5s) |
| barracks | LYING POSE: mesh rotated 90° onto the bed prop, idle clip paused at frame 0 — reads as sleep instantly |
| archive / apothecary / warroom | book / potion / map_rolled grafted to hand, head pitched down — reading |
| trainhall | PAIRED SPAR: two residents face each other, alternate the `attack` clip on a shared timer, no damage — the existing combat clip becomes theater |
| forge | periodic `attack` clip aimed at the anvil — hammering |
| guardpost | slow 180° facing sweep — watching |
| ossuary / storage / kitchen | pose + prop variants of the above (bone, sack, pot) |

Rules: staging is PURE presentation — it never touches the sim, and drops
the instant the monster moves, takes damage, or gains a windup (one check
per frame per resident; residents are ≤ ~15 per floor). The stand-up beat is
the movement clip's first frames; no bespoke transition needed. The sim's
only contribution is already shipped (`residentOf` + sentry behavior).

### Phase A3 — real clips (only where the trick shows)

If A1 finds no sit/sleep clips: the GENERATION-BACKLOG Meshy/animation
pipeline owns commissioning a `rig_medium_ambient.glb` library (sit, sleep,
cheer, hammer, eat — five clips, one file, every character inherits via the
fuzzy matcher). A2 ships without it; A3 replaces the two weakest tricks
(lying pose, drink bob) when the library lands.

### Tests

Staging is host-side (no sim tests); verification is the headless screenshot
harness: a barracks with lying skeletons, a trainhall mid-spar, a mess pack
holding mugs — plus one sim test that residents still aggro correctly (the
existing interruption-line test already covers the seam).

### Order of operations

Furniture P1 (mask+plan+validation) → Animation A1+A2 (independent, can run
parallel to P2/P3) → Furniture P2 (breakable merge) → A3 with the clip
library → Furniture v2 (brute smash-through) last, because it depends on
both systems and is the payoff moment.
