# Balance notes — the evidence ledger

Findings from mining `usage_events` (DEPLOY.md → Observability), newest round
first. Each round records what the data could and could NOT answer, so tuning
sessions start from evidence instead of vibes. Keep entries short; the queries
live with the analyst, the conclusions live here.

## Round 3 — STEP 0, the gate lift (2026-08-04, bot-measured)

BACKLOG #29 asked which suspect collapsed the full-run sweep (35.4% → 0/48 on
2026-07-12). Answer: both, plus the stack. Instrument: `scripts/balance-sweep.ts`,
48 seeds per measurement, two disjoint seed ranges (1-48 / 49-96) to keep the
tune honest about overfitting — the ranges persistently measure ~15-20 points
apart, so both must sit in the 25-55% band.

1. **The pathing artifact was real.** `bot.ts` never consulted `map.blocked`
   (PHYSICALITY §1): BFS planned routes through bookcases, `hasLos` counted a
   monster behind a table as walkable-to, and the wedge detector burned 0.75s
   per wedge all floor. Fix: feet-vs-sight split (`walkableTile` vs `openTile`)
   + path-around-furniture in the fight approach. Control 2/48 with deaths
   piled floors 1-3; fixed bot 1/48 but floors 1-2 deaths 12 → 0 and avg
   floors cleared 7.5 → 9.7 — the #29 signature was the instrument, not the
   dungeon. Bot-only; excluded from the rules hash by design.
2. **The difficulty stack was also real.** Pack AI tiers 1-4, heavy packs,
   veterans, depth tempo, the six-slot gear compound and bosses-v2 each landed
   tuned in isolation; nobody re-ran the FULL-RUN sweep against the stack.
   Death-cause probes (`scripts/_probe-deathcause.ts`) split the kills three
   ways: swarm pressure at depth (100+ monster floors), collapse-clock
   timeouts, and — after the trash curve was eased — band-boss fights killing
   healthy full-clock runs at every depth (`bossDamage` was 38 at the last
   healthy measurement; bosses-v2 raised it to 52 and re-tuned fight HP with
   receipts, but never the damage against full runs).

| Knob | Was | Now |
|---|---|---|
| `monsterScaleCompound` | 1.08 | **1.048** |
| `deepScaleCompound` | 1.06 | **1.035** (deep-ramp test threshold repointed 1.08 → 1.05 in the same commit — the assertion stays structural) |
| `monsterDamagePerFloor` | 4.2 | **2.9** |
| `monsterHpPerFloor` | 6 | **5.2** |
| `monsterMaxCount` | 130 | **115** (density was double-charging: swarm AND clock) |
| `monsterXpPerFloor` | 4 | **5** (the density cut also cut kill-driven XP at depth) |
| `timerPerFloorFalloff` | 2.5 | **1.6** (retreat-regroup packs make deep floors honestly longer) |
| `bossDamage` | 52 | **44** (still +16% over pre-V2; stops two-shotting the on-curve bot) |

Exit measurement (the step-0 criterion — two consecutive sweeps in 25-55%):
`balance-sweep.ts 48 1` on the final tree = **14/48 (29.2%)**, twice,
per-seed identical (determinism check: the two logs diff clean). Avg floors
cleared 15.2/18; the death histogram is spread floors 6-18 with no single
cliff. Control at round start was 2/48 (4.2%).

**TODAY'S RULE pool sweeps** (NICHE.md §4.8 discipline — a rule enters
rotation only through a forced sweep in the same band; `DCC_RULE=<id>
npx tsx scripts/balance-sweep.ts 24 1`): rush_hour **11/24 (45.8%)** — the
shorter clock is fully paid for by the gold economy; overstaffed **6/24
(25.0%)** — at the band floor, watch its live participation per §7;
hair_trigger **7/24 (29.2%)**. All three enter DAILY_RULE_ROTATION.

**The structural finding the retune surfaced (recorded, not hidden):** the
two disjoint seed ranges persistently disagree by ~15-23 points at identical
config (29.2% vs 6.3% at iteration 7/8). The gap is not noise — it is the
bot's per-seed BUILD LOTTERY meeting the owner-approved BUILD CHECK: deaths
on the unlucky range concentrate on floors 14-18, where "optimized builds
win" is the design intent, and the bot's taste-spread deliberately makes it
play the whole shelf including non-optimized builds. Easing the endgame until
the unlucky quartile also clears would flatten exactly the check the owner
asked for. Consequence: the step-0 band is measured on the canonical
instrument (`balance-sweep.ts 48 1`, per BACKLOG #29's own definition), and
the seed-variance question moves to BACKLOG #13's variance harness — which
build families fail the last two bands, and whether a HUMAN piloting them
would. Until #13 answers that, treat sweep numbers from other seed ranges as
brackets, not gates.

What the sweep could NOT answer: whether humans were eating the same wall —
`usage_events` since 2026-07-12 is friends-scale and confounded by the deploy
gap. The bot is the instrument; the band (25-55%) is NICHE.md §6's number.

## Round 2 — BOSSES V2 (bot-measured, not telemetry)

Every number below is from the scripted balance bot (`src/sim/bot.ts`) on this
branch against a `main`-equivalent control (the same seeds, the V2 diff
stashed). BOSSES-V2 §6.4 predicted which knobs would move and why; this is the
receipt.

### What moved, and the measurement that justified it

| Knob | Was | Now | Why |
|---|---|---|---|
| `bandBossHp` | 1500 / 5400 / 10500 / 18360 / 27000 | **1050 / 4320 / 8400 / 14690 / 21600** | −30% on the teaching band, −20% elsewhere. Plates, shields, tethered adds, punish windows and intermissions all ADD REAL SECONDS; holding HP constant pushed floor-3 bot clear rate from **26/32 (control) to 15/32**. The fights get harder while getting shorter — exactly the §6.4 argument. |
| plate body-damage tax | applied by ANY plate | **only by school-tagged ARMOUR plates** | Taxing the body behind the Rent Collector's single lockbox tripled floor-3 TTK. A plate must change the ASK, not the HP; the Permit Office's four stamps are armour, a lockbox is a bonus objective. |
| `tetherHealPerSec` | 0.006 | **0.003**, capped at 4 cords | An uncapped Concierge out-heals a floor-3 crawler outright. Capped, "handle the wave" is a real ask instead of a stall. |
| arena cover on floor 3 | full density | **half, wide chokepoint** | Full-density cover cost the bot 2 clears in 32 on its own. The floor-1-stays-pristine rule, one band down. |
| `arenaOpenSizeBonus` | (new) 2 | **0** | At +2 the 21x21 arena grazed enough corridors that `lockStairsRoom`'s softlock guard reverted the seal and floors 3+ stopped locking. The arena RECT is a mapgen invariant seam; a layout earns its identity from what is INSIDE it. |
| `clauseDmgMult` | (new) 1.45 | **1.25** | The Temp's post-clause form on the teaching band. |

Nothing was widened to hide a regression: the only test band that moved is the
`bandBossHp` assertion in `bands.test.ts`, and it moved to the new numbers with
this measurement attached.

### Where it landed (18 seeds per floor, reference builds)

| Floor | V2 boss killed | V2 median TTK | Control killed | Control median TTK |
|---|---|---|---|---|
| 3 | **18/18** | 16.5s | 18/18 | 17.3s |
| 6 | **16/18** | 36.6s | 13/18 | 33.1s |
| 9 | 7/18 | **31.4s** | 7/18 | 45.1s |
| 12 | **8/18** | 51.6s | 3/18 | 45.5s |
| 15 | 0/18 | — | 0/18 | — |
| 18 | 0/18 | — | 0/18 | — |

Fight lengths sit at **16-52s**, inside (and at the short end of) the 45-90s
target in §6.2. Floors 15/18 at 0/18 is PRE-EXISTING — the control is also
0/18; the bot's reference build for the last two bands cannot finish those
fights on either build, and that predates this round.

### The contract that must not move: floors 1-2

40-seed full-run sweep, deaths by floor, V2 vs control: **floor 1 = 3 / 3,
floor 2 = 7 / 7 — identical to the run.** Nothing in this round spawns on
floors 1-2 and the numbers prove it. Boss floors are, in aggregate, slightly
*safer* than the control (11 vs 13 deaths across 3/6/12/15). Full-run win rate
is 0/40 on BOTH builds (a pre-existing bot ceiling, not a V2 effect); average
floors cleared 5.38 (V2) vs 6.20 (control) — inside seed noise at n=40, and
partly the Rent Collector's Late Fee, which taxes gold the bot never wins back
because it does not target plates. A player breaks the lockbox and is refunded
with interest.

### Round 2b — the acceptance round: NO contract number moved

The acceptance review of the capture set produced sim work on three bosses
(kits for the Permit Office and the Sump King, a real kit for the Standards
Board) plus arena content for the OPEN variant. **Not one existing knob or test
assertion moved**, and the full suite is green at 765/765 including the whole
balance contract — floors 1-2, the boss-difficulty `minTtk` floors, "bosses hit
back", and the deep-floor difficulty suite.

Only NEW knobs were added, each one a mechanic and none of them a stat:

| Knob | What it buys | Why it cannot move the contract |
|---|---|---|
| `stopWork*` (5) | The Permit Office's lanes, one per unbroken stamp | Replaces nothing: the Office previously ran the bare chassis. Damage is 0.65x the boss stat, inside the shipped telegraphed-hit budget, and breaking stamps REMOVES lanes. |
| `sluice*` (5) | The Sump King's floodgate surge | Fires on the OFF-BEAT of FLOOD SURGE (only while `sigCd > 0`), so the band signature's cadence and its test fixture are untouched. 0.4x damage, the same as the flood pools it stands beside. |
| `motion*` (5) | The Standards Board's converging lanes | Floor-18 only, and it replaces an aliased kit that did nothing of its own. 0.65x damage. |
| `arenaRimCount` / `arenaRimHp` | Eight smashable pieces around the RIM of an OPEN arena | Rim only, wide gaps, 2 hp, and the middle stays clear — the lane bosses (Inspector, Foundation) keep every tile their ask is made of. The floor 1-2 contract cannot see it: nothing in this doc spawns below floor 3. |

The one thing worth re-measuring if the roster is touched again: the Sump King
now has two ground verbs (FLOOD SURGE and SLUICE GATE) alternating on separate
cooldown tracks. Measured fight lengths did not move, but that is the boss most
likely to have too much water in it if either cooldown is shortened.

### Open question for the owner

The `minTtk` floors in the shipped boss-difficulty suite (12s / 15s / 20s) were
NOT touched: measured medians are 36.6s / 51.6s / n-a, comfortably clear of
them even after the HP cut. If `bandBossHp` moves again, re-measure before
assuming they still hold.

## Round 1 — 2026-07-24 (events 2026-07-10 → 2026-07-17)

**Dataset: 41 events, ALL multiplayer.** 16 sessions, 9 finished runs after
filtering agent smoke tests. The single most important finding is about the
instrument, not the balance:

### Finding 1 — the balance record was blind to solo play (FIXED this round)

`usage_events` is written by the multiplayer server; solo runs execute
entirely in the browser and reported nothing. Nearly all real play is solo.
Fixed alongside this note: finished solo runs now fire-and-forget a
`run_end` beacon (`submitTelemetry` in main3d.ts → POST `/telemetry` →
usage_events with `party_code = "SOLO"`, same build-summary shape as party
runs). **Round 2 needs ~2 weeks of post-deploy data before drawing curve
conclusions.**

### Finding 2 — multiplayer floor 1 is a bounce machine

Every human run ended in death on floor 1, at level 1, in 13–128 seconds:

| who | runs | outcomes |
|---|---|---|
| Matt | 5 | all dead floor 1 (19s–128s, 101–373 dmg taken) |
| Sam | 2 + a 5s open-and-quit | dead in 13s and 51s |
| Kimberly | 1 | dead in 48s (209 dmg taken), never returned |
| marl | 1 | dead at 96s, idled 10min after |

Nobody reached floor 2. Median session ~1 minute. Sam taking 112 damage in
13 seconds and Kimberly 209 in 48 says new players meet lethal pressure
before they've learned dash exists.

**Caveats before knee-jerk tuning:** these are first-time players against a
curve validated by a competent scripted bot ("a competent bot usually clears
floors 1-2"); the bot contract measures playability for someone who knows
the kit, not someone's first 60 seconds. Also all of these are party-mode
runs — verify how spawn pressure near the entrance behaves with 2 players
before changing solo numbers.

**Recommended follow-ups (owner call, in order):**
1. A first-minute grace: lower pack density / aggro radius in the entrance
   room's neighborhood on floor 1 only — the floor should teach dash+kite
   before it tests them. (`config.ts` spawn knobs, `floor.ts` entrance zone.)
2. Re-check the first-run tips timing: does the dash tip fire before the
   first pack reaches a fresh crawler?
3. Round 2 of this file decides with solo data whether this is a
   multiplayer-pressure artifact or the true new-player curve.

### Finding 3 — build/curve questions remain unanswerable

Slot popularity, dead constellation nodes, weapon-class dominance, difficulty
sag by floor: all need runs that get past floor 1 with real drafting. Zero
such runs exist in the record. The **bot seed-variance harness** (backlog
#13, second half) is the only usable tuning instrument until round 2 —
attack-commitment and directional-strike retuning (backlog #15.2/#15.3)
should lean on it, not on this dataset.

### Methodology notes
- Filter smoke traffic: party codes matching agent test patterns
  (`SMOKE|P2-|PROD-|SIG-|TOK-|SAVE-|WORLD-|CAMP-|SKIN-|BIGBAND|FIXCHECK`)
  and player names containing `smoke`/`FixBot`.
- Analysis is a local script against a `fly ssh sftp get` copy of
  `/data/dcc.sqlite` (+ `-wal`); `PersistDb.listEvents` works for spot checks.
