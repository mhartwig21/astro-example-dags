# Balance notes — the evidence ledger

Findings from mining `usage_events` (DEPLOY.md → Observability), newest round
first. Each round records what the data could and could NOT answer, so tuning
sessions start from evidence instead of vibes. Keep entries short; the queries
live with the analyst, the conclusions live here.

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
