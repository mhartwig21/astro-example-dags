# Balance notes — the evidence ledger

Findings from mining `usage_events` (DEPLOY.md → Observability), newest round
first. Each round records what the data could and could NOT answer, so tuning
sessions start from evidence instead of vibes. Keep entries short; the queries
live with the analyst, the conclusions live here.

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
