# Megafloors — research: much larger floors, settlements, roaming mobs, scarce stairs

Research for the "what if each level were much larger" direction: more bosses,
settlements, roaming mobs, multiple stairways that get scarcer with depth (as
in the *Dungeon Crawler Carl* books), without generating unbeatable floors.
Verdict up front: **feasible, in phases, with three real engineering walls and
one hard design guarantee we can enforce at generation time.**

**Design ruling (2026-07-05): no floor budget over 4:00, and never fewer than
two stairways.** The maps size to the clock, not the clock to the maps — that
caps practical floor area at ~5× today's (160²), which is still a dramatic
jump from 72². The original 8-9×/single-stair exploration is kept below as a
rejected variant for the record.

## Where we are (measured, 2026-07-05)

| Thing | Today | Source |
|---|---|---|
| Floor grid | 72×72 = 5,184 tiles (all floors) | `CONFIG.floorGridW/H` |
| Collapse budget | 120s − 2.5s/floor, floor 60s (floor 18 ≈ 77s) | `floorTimeBudget` |
| Walk speed | 4.2 tiles/s → ~17s to cross a floor | `CONFIG.playerSpeed` |
| Monsters | 24 + 6/floor, cap 110 (≈1 per 47 tiles deep) | `CONFIG.monster*` |
| Monster AI | every monster steps every tick; aggro range 8 | `ai.ts` |
| Stairs | exactly 1, in the room farthest from spawn | `floor.ts` |
| MP snapshots | ~28KB JSON, 15/s per client; **bandwidth is the ceiling**, not CPU (48 players degraded the wire, sim used 18% of tick budget) | `DEPLOY.md` capacity table |
| Persistence | saves store seed+floor only; floors regenerate | `persist/save.ts` |

8-9× area = ~216×216 (46,656 tiles). Same monster density ⇒ ~900 monsters.

## The three engineering walls

1. **The collapse timer model.** At 4.2 tiles/s, walking corner-to-corner on a
   216² floor takes ~73s — more than floor 18's entire 77s budget before a
   single fight or wrong turn. A flat per-floor falloff cannot price maps
   whose area varies 9×. The budget must derive from area and stair count.
2. **AI cost + multiplayer bandwidth.** ~900 always-awake monsters is fine
   for the sim CPU-wise only with a sleep LOD (monsters far from every player
   tick sparsely). The harder wall is MP: snapshots serialize every monster,
   and DEPLOY.md already shows the WIRE is the first thing that saturates.
   9× monsters ⇒ ~250KB × 15/s per client. Full-size floors in multiplayer
   require interest-managed snapshots (only entities near the party, plus
   radar blips) — coincidentally the same "snapshot deltas" work DEPLOY.md
   already names as the first scaling fix.
3. **The balance bot.** `test/balance.test.ts` encodes "playable" via a bot
   that clears early floors. On huge floors the bot must *find* stairs, not
   clear the map — the tests (and bot policy) need a stairs-seeking
   formulation, or the difficulty contract silently dies.

None of these bite at once if size scales WITH DEPTH — which is also exactly
the DCC fiction.

## Design proposal

### 1. Deeper means vaster (and stairs get scarcer)

Grid size and stairway count per band — early floors stay close to today (the
balance suite and new-player readability survive untouched), deep floors go
big and lonely:

Sized to the 4-minute ceiling. The honest difficulty metric is **area per
stairway** (how much map hides each exit) — today's floor is 5,184 tiles
hiding 1 stair. That number must start near parity and RISE with depth, or
extra stairways accidentally make the early game easier than today:

| Band | Floors | Grid | Area vs today | Stairways | Area/stair (today: 5,184) | Budget (band start, +5s/floor) | Feel |
|---|---|---|---|---|---|---|---|
| Undercroft | 1-3 | 80² | 1.2× | 2 | 3,200 | 2:00 | today + a choice of exit |
| Sewers | 4-6 | 96² | 1.8× | 3 | 3,072 | 2:30 | options, while they last |
| Garden | 7-9 | 112² | 2.4× | 3 | 4,181 | 2:50 | first "this is big" moment |
| Ruins | 10-12 | 128² | 3.2× | 2 | 8,192 | 3:10 | choose your exit carefully |
| Ironworks | 13-15 | 144² | 4× | 2 | 10,368 | 3:25 | expeditions, not sprints |
| Approach | 16-18 | 160² | 4.9× | 2 | 12,800 | 3:40 → 3:50 | the hunt, capped at 4:00 |

Search difficulty rises ~4× across the run while never starting easier than
today's feel — with one crucial placement rule: **stairways only spawn in the
outer third of the map** (minimum BFS distance from spawn), exactly like
today's farthest-room rule. Multiple stairways then mean *choice of route
and of guardian*, not a shortcut that happens to spawn next door. (Bands 0-1
sit slightly below today's raw number, deliberately: those are the onboarding
floors, and their nearest-exit distance is held up by the placement rule.)

Sanity check on the deepest band: 160² with 2 far-placed stairways puts the
nearest one ~70-100 tiles out (~17-24s pure walk, ~45-60s realistic search
with wrong turns) plus 1:30-2:00 of deep-floor combat ≈ **2:30-3:00 total
against a 3:40-3:50 budget** — pressured but honest, with room for looting
or a settlement stop. Every floor stays under 4:00; no floor ever has one
exit.

*Rejected variant, for the record:* 216²/9× with a single stairway needs
7-10 minute budgets — great expedition fantasy, but it violates the 4-minute
ruling and turns floors into sessions. If an "endless expanse" experience is
ever wanted, it should be a special EVENT floor with its own rules, not the
baseline.

The System announces the count on entry ("This floor has TWO staircases,
Crawler. The nearest one is lying about it.") — DCC voice doing UX work.

### 2. Beatability is a generation-time GUARANTEE, not a tuning hope

After mapgen, BFS from spawn to the nearest stairway; require
`walkTime(shortestPath) ≤ 35% of the floor's budget`, else re-roll stair
placement (the check is microseconds; re-roll is bounded). A floor cannot be
born impossible. Lock it with a sim test across many seeds — same pattern as
the corridor-width test.

**The timer is a simple, announceable ramp under a hard 4:00 ceiling**: band
start budgets from the table (2:00 → 3:40) **+5s per floor within the band**,
never exceeding 4:00. Players can plan around a rule the System narrates
("a little more time, the deeper you crawl; a fresh stipend each district").
The pressure DCC-style comes from stair *scarcity and distance*, not a
stopwatch tuned for a 72² map. Collapse phases (SAFE/WARNING/FRENZY) stay
proportional. The beatability guarantee above is what makes a fixed ceiling
safe: floors that would need more than the ceiling *cannot generate*.

### 3. Regions: big floors must be places, not soup

Partition the grid into macro-cells (2×2 up to 4×4 by band), run the existing
room+corridor generator inside each cell, join cells with wide arteries
(3-wide trodden roads — the corridor system already renders these as paths).
Each region draws one **anchor**: stairway / vault / settlement / mini-boss
lair / landmark. Regions give fights locality, give the minimap legible
geography, and keep generator complexity linear. (`roles` already exists
per-room; this adds one level above it.)

### 4. More bosses

- The floor boss + oversized arena (already shipped) stays; on multi-stair
  floors it guards the *best* stairway (shortest next-floor path or a loot
  vault attached).
- **Stair guardians**: each additional stairway is held by a mini-boss — an
  elite-plus with one real mechanic (charger with a wall-stun, shaman with a
  sanctuary totem...). Choosing which exit to fight for becomes the floor's
  strategic question. 2-4 bosses/floor deep.

### 5. Settlements (the Desperado Club vibe)

From band 1 down, ~60% of floors roll one settlement region: a no-aggro zone
(monsters won't path inside; sim gets a `sanctuary` room mask) containing:
- a **System kiosk** — reuses the safe-room catalog/shop UI in-floor,
- a **paid heal fountain** (gold sink; flask refill),
- a **rumor-monger** who sells the *nearest stairway's location ping* on the
  minimap — the anti-frustration valve for scarce stairs, priced in gold.
  Extremely DCC: the System will always sell you the answer.
Bots and monsters ignore it; the collapse does NOT (no camping the ending).

### 6. Roaming mobs

2-4 patrol packs per floor walking artery waypoint loops, so the map feels
inhabited and backtracking stays dangerous. Requires the **AI sleep LOD**
anyway needed for scale: monsters farther than ~24 tiles from every player
run a cheap wake-check tick (roamers advance along their route abstractly);
full AI only near players. Deterministic (pure function of state), so
replays/tests are unaffected. Ambush packs (already shipped) sprinkle in.

### 7. Renderer & host readiness (mostly already paid for)

- Chunked InstancedMesh + per-chunk frustum culling means *visible* cost is
  unchanged at any map size; build time grows linearly (~9× instances — put a
  one-beat "DESCENDING…" transition over the rebuild; async-friendly).
- Fog mask/explored arrays at 216²: ~46KB each — trivial.
- Minimap: cache the explored layer to an offscreen canvas, redraw only on
  `exploredVersion` bump (it currently redraws whole-map per frame — fine at
  72², wasteful at 216²).
- Saves: unaffected (seed+floor regenerate the map).

## Phasing (each phase ships playable)

**P1 — Deeper means vaster.** Depth-scaled grids (cap ~2.4×/Garden-size
while we learn), multi-stairs + stair guardians, the banded +5s/floor timer
under the 4:00 ceiling + the beatability guarantee + seeds test,
stairway-count announcements, AI sleep LOD, minimap caching, stairs-seeking
bot + rewritten balance tests. Monster cap ~180.
**P2 — Living floors.** Settlements (kiosk/fountain/rumor ping), roaming
patrol packs, region landmarks, discovered-stairs pinned on the minimap,
full band table (deep floors to 160²).
**P3 — Multiplayer scale + spectacle.** Monster caps by area,
interest-managed + delta-compressed snapshots (the DEPLOY.md roadmap item),
and phased regional collapse — outer regions die first, herding everything
living toward the center. The season finale films itself.

## Risks & honest costs

| Risk | Mitigation |
|---|---|
| Big-but-empty floors | regions + anchors + roamers; density budgeted per region, not per floor |
| Can't-find-stairs frustration | announcements, rumor ping, discovered-stairs persistence, beatability guarantee |
| Balance suite rewrite | stairs-seeking bot policy is P1 work, not an afterthought — the contract must move WITH the design |
| MP bandwidth | interest management gated to P3; P1/P2 keep monster counts within today's wire budget |
| Floor build hitch | transition beat now, async build if it ever exceeds ~1s on real GPUs |

## Open questions for the next session

- Do different stairways lead to *different floor variants* (risk/reward
  exits) or just different placements? (DCC leans variant.)
- Should settlements persist across a run (same vendor recognizes you)?
- Phased collapse in P3: regions die outer-to-inner, or dice-rolled?
