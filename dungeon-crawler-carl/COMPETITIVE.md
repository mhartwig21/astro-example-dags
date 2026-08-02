# COMPETITIVE.md — the social/competitive layer

The design for ranked play, verified leaderboards, ghosts, career identity and
the post-run screen. Read `CLAUDE.md` first (architecture), then `PERSISTENCE.md`
(what the DB already does) and `DEPLOY.md` (the one-machine constraint that
bounds everything here).

## 0. The thesis

League of Legends' competitive layer is built on **symmetric 5v5 PvP**. A match
is a closed system with two sides, so LP is a zero-sum transfer, rank is a
rating of head-to-head strength, and decay exists because an unproven rating is
a lie. Almost none of that ports. Our run is a 15-minute solo (or co-op)
performance against a fixed dungeon. There is no opponent to take LP from.

What we have instead is a structural advantage LoL cannot copy: **the sim is
pure and deterministic**, so a whole run is a ~27 KB artifact that reproduces
itself exactly. That single fact buys four things:

| LoL gives you | We can give you |
|---|---|
| Server-authoritative matches you trust because you were in them | **Runs the server re-executes and certifies.** Every entry that *ranks* is a proof, not a claim |
| Match history with per-match detail | Match history where every row carries **verifier-derived detail** — splits, build, cause of death — and every ranked row in the current rules era is **replayable and raceable** |
| Spectate a live game | **Watch or race any ranked run in the current rules era**, offline, from a 27 KB link |
| Ranked ladder rating head-to-head PvP | A ladder rating your **best days on identical dungeons** |
| Post-game scoreboard | A post-run scoreboard that **names what killed you** and hands you the same seed back |

Three qualifiers in that table are load-bearing, and the design reads as
marketing if you skip them:

- **"that ranks"** — verification costs CPU on a one-machine box, so only
  submissions that could reach a board's top 25, plus event entries, are
  replayed (§2.4). Rows below that are stored `claimed` and say so on their
  face.
- **"in the current rules era"** — a proof is executable only by a sim build
  that computes the same numbers. The image and the client each carry four eras
  (§2.6b); past that the row survives as its verifier-derived summary and the
  seal it already earned, while WATCH and RACE go dark with a stated reason
  (§2.6f).
- **the player's own consent** — a proof is a 60 Hz recording of everything the
  player did, and publishing it is a choice. It is disclosed before the first
  submit, and a run can rank privately: verified, sealed, never distributed
  (§8.1).

The qualified version is still something LoL cannot claim. The overclaim would
have been the only thing making it read as marketing.

Everything below is built on the verification spine in §2. The rest of the
document is what that spine makes possible.

---

## 1. AUDIT — what ships today

### 1.1 The surfaces

| Surface | Code | What it is |
|---|---|---|
| Daily Crawl board | `src/server/leaderboard.ts` | One board per UTC day, seed from `dailySeed(day)`. Best entry per crawler NAME, 200/day, 30 days kept. JSON file on the Fly volume (debounced tmp+rename write) |
| All-time boards | same | `deepest` / `fastest` / `kills` / `contracts`, 200 entries each, best per NAME |
| RIVALS contracts | `gameServer.ts` ~989 | The **one** score the server vouches for itself: a rivals race won on the authoritative sim submits to the `contracts` board server-side |
| Career aggregates | `db.ts` `account_stats` | runs / wins / deepest / kills / time_sec, keyed on the anonymous account token, bumped by `recordRunStats` on all-time submits |
| Identity | `db.ts` `account_identities`, `auth.ts` | Anonymous bearer token per browser; Discord OAuth **live**, Google code-complete but env-gated off. A provider identity recovers exactly one account |
| Local career ledger | `src/persist/history.ts` | `dcc:history:v1` in localStorage — last 60 finished runs + `careerBests()`. Powers the menu CAREER panel |
| Post-run recap | `main3d.ts` `renderRecap` / `composeRunCard` | Report card + a 1200x630 share card |
| Quick Join | `GET /open-parties` | Live co-op instances that opted into discovery and have a free seat |
| Telemetry | `POST /telemetry` -> `usage_events` | Build summaries per run/floor/session. The balance record, not a player surface |
| Hygiene | `names.ts`, `allowSubmit` | Name sanitation at every ingress; per-IP token bucket (burst 6, refill 6/min); 4 KB body cap |
| Privacy | `POST /auth/delete` | FORGET ME: erases identities, stats, party seats, account row |

### 1.2 The trust model, stated plainly

**Solo runs never touch the server.** `main3d.ts` runs the sim in the browser and
POSTs a summary on the status edge. The server validates *shape* — integer floor
1..18, time <= 6h, kills <= 100k — and then believes the numbers.

Concretely, today, from a devtools console:

```js
fetch('/leaderboard', { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ board:'alltime', name:'ME', floor:18, won:true, timeSec:1, kills:99999 }) })
```

...is rank 1 on `fastest` and `kills` simultaneously, and `recordRunStats` credits
the sender's career while it's at it. The per-IP bucket allows 6/min, so one IP
fills every slot of every board in about 35 minutes.

Three more holes worth naming because the design has to close them:

- **Boards key on `name`, not on account.** Names are squattable and
  impersonatable, and there is no continuity between a board row and a profile.
- **FORGET ME does not reach the leaderboard.** `deleteAccount` touches
  `account_identities`, `account_stats`, `party_members`, `accounts` — the JSON
  boards are untouched. A deleted account's name stays on public boards forever.
  That is a live privacy gap, not a future one.
- **All-time boards silently mix rules eras.** A balance patch changes what a
  time means and nothing on the board says so.

The `contracts` board is the honourable exception and the proof of concept for
everything in §2: it exists precisely because the authoritative sim ran the race.

### 1.2b The self-reported board is RETIRED

`POST /leaderboard` answered with no proof, no account binding and no seal —
the devtools one-liner documented above. It now answers **410 Gone**, and
`recordRunStats` (the only path by which an unauthenticated request could move a
career aggregate) is deleted rather than disabled. The JSON boards are still
*served*, read-only, flagged `unsealed: true` on the wire and labelled
**UNSEALED · LEGACY** in the client, and they are never mixed into THE
STANDINGS. The only writer left is the server vouching for a RIVALS contract its
own authoritative sim produced.

FORGET ME now cascades into `leaderboard.json` too. Those rows key on the NAME
they were submitted under, so nothing inside SQLite can find them: the delete
request carries the crawler names the browser knows (sanitized, capped at five),
unions them with every display name the account ever put on a board row, and
`Leaderboard.forgetNames()` strips them case-insensitively from every day and
every all-time category.

### 1.3 What is honestly missing

- No verification. No rank. No seasons.
- No per-run detail. A board row is name/floor/won/time/kills — there is nothing
  to click, nothing to watch, no build, no cause of death.
- No profile. Nothing is shareable except a PNG.
- No ghosts, no replay, no spectate, no friends/rivals list.
- No archetype or band dimension anywhere, so there is exactly one top-ten in the
  entire game and 99% of players are not on it.
- The post-run screen grades nothing and compares nothing.

---

## 2. THE VERIFICATION SPINE

### 2.1 Determinism: verified in code, and one hard limit found

**What holds.** I checked the claim rather than trusting it:

- `test/balance.test.ts` "determinism guard" bans `Math.random`, `Date.now`,
  `performance.now` across every file in `src/sim/`. Clean.
- The RNG is mulberry32 threaded through `state.rng` (`src/sim/rng.ts`).
- `stepFloor` sorts players by id before applying intents (`game.ts` ~5541), so
  `PartyIntents` key order cannot bias the RNG stream.
- **The solo host already runs a fixed timestep**: `main3d.ts` ~5551 is
  `while (acc >= SIM_DT) step(state, sampleIntent(SIM_DT), SIM_DT)` at
  `SIM_HZ = 60`. This is the most important fact in the document — the client is
  already tick-quantized, so recording is "write down the intent you just built"
  and nothing about the sim has to change.

I proved it end to end with `tools/replaymeasure.ts`: record the quantized intent
fed to `step()` every tick plus every out-of-band action (drafts, shop, socket,
refit, ready), then replay the stream into a fresh `createGame(seed)` and compare
`serialize(state)`.

**Result: 26 runs across 26 seeds, up to floor 16 — every single one
byte-identical.** Not close; the entire serialized world string matched.

**The hard limit.** `tools/enginedeterminism.ts` runs 4,000 identical steps of
seed 2024 in Node and in each browser engine (via the dev server, real modules):

| Engine | 4,000-step world hash |
|---|---|
| node v24.16 (V8) | `3a00af1c397e3d9b` — reference |
| Chromium 140 (V8) | `3a00af1c397e3d9b` — **identical** |
| Firefox | `594d9cb9244dd69a` — **diverged** |
| WebKit | `594d9cb9244dd69a` — **diverged** |

First divergence at character 34,447: a monster's `wanderDir`, differing in the
last ULP (`-0.8283981349887463` vs `...64`). That is `Math.cos`/`Math.sin`.

`tools/mathdivergence.ts` measures *how often* each primitive the sim uses
disagrees with Node, over 20,000 inputs each:

| fn | Chromium | Firefox | WebKit |
|---|---|---|---|
| sin | 686 | 526 | 526 |
| cos | 648 | 565 | 565 |
| tan | 744 | 837 | 837 |
| atan | 1284 | 0 | 121 |
| exp | 2010 | 0 | 1951 |
| asin | 1056 | 0 | 486 |
| acos | 1485 | 0 | 169 |
| log | 1272 | 0 | 1264 |
| **sqrt** | **0** | **0** | **0** |
| cbrt | 1687 | 0 | 6189 |
| atan2 | 2139 | 0 | 2143 |
| pow | 0 | 4 | 4 |
| hypot | 0 | 7725 | 7951 |

Read the first column twice: **Chromium disagrees with Node on sin/cos/atan2**,
and both are V8. Different V8 *versions* are enough. ECMA-262 requires exact
IEEE-754 rounding for `+ - * /` and `Math.sqrt`, and explicitly permits
implementation-approximated results for every transcendental. The 4,000-step
Chromium match above is luck, not a guarantee.

**RESOLVED — re-measured after MUST-0 shipped (`tools/enginedeterminism.ts`,
4,000 steps of seed 2024, same dev server, real modules):**

| Engine | 4,000-step world hash |
|---|---|
| node v24.16 (V8) | `594d9cb9244dd69a` — reference |
| Chromium | `594d9cb9244dd69a` — **IDENTICAL** |
| Firefox | `594d9cb9244dd69a` — **IDENTICAL** |
| WebKit | `594d9cb9244dd69a` — **IDENTICAL** |

All 45,673 bytes of the serialized world match on every engine. Note the hash
is the one Firefox and WebKit used to produce, not the one Node did: `dmath`
is not "Node's answer, everywhere", it is *one* answer everywhere, which is
the only property that matters. Keep `tools/mathdivergence.ts` — it still
measures the PLATFORM primitives, and it is the canary that tells us the day
someone reintroduces one.

**Consequence: the verification spine is not sound until the sim stops calling
implementation-approximated `Math`.** This is MUST-0 of the migration map. The
census of what has to change in `src/sim/`:

| fn | sites | where | replacement |
|---|---|---|---|
| `hypot` | **28** | game 8, ai 6, combat 4, npc 3, bot 2, pathfield 2, roomPurposes 2, floor 1 | `Math.sqrt(a*a + b*b)` — exactly rounded, mechanical, and almost certainly faster |
| `sin` / `cos` | **47** | game 30, ai 10, abilities 3, combat 2, roomPurposes 2 | one minimax polynomial pair with Cody-Waite reduction |
| `atan2` | 7 | ai, game, combat | atan polynomial + quadrant logic |
| `pow` | 3 | config `xpForLevel`, game | integer-exponent loop / explicit multiplication |
| `asin` / `acos` | 2 | game, combat | identities over the deterministic `atan` |
| `exp` / `log` / `tan` / `cbrt` | **0** | — | not used in the sim at all |

Counted against the tree on 2026-08-02; re-count before scoping the work, because
the sim moves (§2.6a). Two of the `hypot` sites are in `bot.ts`, the test-only
policy driver — convert them anyway for consistency, but note that `bot.ts` is
deliberately *outside* the rules hash (§2.6a), so touching it never costs an era.

Accuracy is irrelevant here; **determinism** is the requirement. A sine that is
2 ULP from true is fine as long as it is the same 2 ULP on every engine. Pin it
with a golden fixture and keep `tools/mathdivergence.ts` as a cross-engine
canary.

Two smaller hazards, worth writing down before someone trips on them:

- **Never replay from a deserialized checkpoint.** `Object.entries(p.materials)`
  (`game.ts` ~3594) and `Object.keys(p.cd)` (~5562) iterate in insertion order. A
  replay from `createGame(seed)` reproduces that order exactly; a world restored
  from `instance_snapshots` might not. Proofs always start from the seed.
- **`SNAPSHOT_VERSION` and the rules hash are different axes.** Snapshot version
  answers "can this stored world be loaded"; the rules hash answers "does this sim
  compute the same numbers". A change can move either, both, or neither.

### 2.2 The artifact — RunProof v1

```
header   ~120 B JSON   v, rulesHash, seed, mode, runKind, eventId?, startKind,
                       ticks, dtNum/dtDen (1/60), clientBuild
frames   4 B / tick    [flags][castBits][moveDir][aimDir], RLE + gzip
                       flags: move|attack|stairs|flask|dash|bolt|nova|hasAim
                       dirs:  1/256 of a turn (~1.4 degrees)
actions  JSON, gzip    [tick, op, ...args] for reward | upgrade | buy | sell |
                       sellAll | equip | slot | ult | socket | unsocket |
                       dismantle | refit | ready | claimAchievement | ping
claim    ~200 B        what the client says happened: floor, won, ticks, kills,
                       level, ultimate, band split ticks
```

**Quantize before the sim, not at record time.** The host builds an intent, runs
it through `encode`/`decode`, and feeds the *decoded* value to `step()`. The sim
therefore only ever consumes values that survive the wire format, so record and
replay agree by construction rather than by luck. This is free: `move` is
normalized inside the sim anyway (`game.ts` ~5606, `normalize(move)`), and 1.4
degrees of aim resolution is finer than a hand can hold. `ping` and any future
free-position input ride the action list at full precision, not the frame.

The codec lives at `src/sim/replay.ts` — **inside** the sim, so the purity guard
and the rules hash both cover it.

### 2.3 Measured cost

Dev box, Windows, node v24.16, the scripted bot standing in for a player, dt=1/60.
Full table in `tools/replaymeasure.ts` output; the load-bearing rows:

| seed | end | ticks | sim time | raw 4B | +RLE | +gzip | brotli | actions | replay | x realtime | us/tick | exact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 31 | floor 16 | 48,265 | 13.4 min | 188.5 KB | 75.9 KB | **19.9 KB** | 16.1 KB | 6.9 KB (251) | 11.6 s | 70x | 240 | yes |
| 7 | floor 16 | 45,419 | 12.6 min | 177.4 KB | 66.3 KB | 19.2 KB | 15.6 KB | 6.9 KB (248) | 10.5 s | 72x | 230 | yes |
| 47 | floor 11 | 25,947 | 7.2 min | 101.4 KB | 41.3 KB | 10.1 KB | 8.2 KB | 4.1 KB (150) | 3.7 s | 117x | 143 | yes |
| 101 | floor 8 | 19,626 | 5.5 min | 76.7 KB | 39.6 KB | 5.8 KB | 4.7 KB | 2.8 KB (98) | 2.8 s | 118x | 141 | yes |
| 13 | floor 3 | 4,282 | 1.2 min | 16.7 KB | 6.0 KB | 1.5 KB | — | 0.8 KB (28) | 0.3 s | 231x | 72 | yes |

**Headline numbers:**

- **A whole run is ~27 KB** (19.9 KB frames + 6.9 KB actions, before gzipping the
  actions). The naive "JSON-log the Intent every tick" strawman is **7.0 MB** —
  260x worse. A run is smaller than a PNG screenshot of it.
- Extrapolating a full 18-floor clear (~55-60k ticks): **~30-35 KB**.
- **Replay costs 240 us/tick at depth**, 70x realtime. The deepest measured run
  took **11.6 s of CPU**; a full clear extrapolates to **~14-16 s**.
- Per-tick cost is dominated by monster count, not ticks: 20 us in a 4-entity
  boss arena, 675 us on floor 16 with 192 monsters.
- Fly runs `shared-cpu-1x`. Assume 1.5-3x slower than this box: **budget 25-50
  seconds of one core per full-run verification.** That number decides §2.4.

### 2.4 Running verification on exactly one machine

The constraint (DEPLOY.md): one Node process, one shared vCPU, a 33 ms budget per
30 Hz tick *across every live party*. A 30-second replay on the main thread stalls
every party on the box for 30 seconds. Four rules:

1. **Never on the tick thread.** `src/server/verifyWorker.ts` is a
   `worker_threads` Worker that imports `src/sim` and replays. One worker, one job
   at a time.
2. **Verify only what could matter — and only an account's own improvements.**
   A submission is queued only if, taken at face value, it would (a) land in the
   top 25 of a board it targets, or (b) beat that account's current best
   *verified* entry on an open event. Everything else is stored as CLAIMED and
   never replayed.

   Clause (b) is the load-bearing one, and an earlier draft of this document did
   not have it. §3.2A deliberately allows unlimited attempts on a daily, so
   "event entries are always verified" makes event volume equal *attempts by
   every player*, not *players*. With (b), your twelfth attempt costs a verify
   only if it beat your verified eleventh. The bound is improvements, which is a
   function of the population, not of anyone's free time.

   **The ceiling, stated in numbers instead of hand-waved.** At
   `VERIFY_BUDGET_MS_PER_SEC = 250` the box has **21,600 verify-seconds/day**. At
   §2.3's Fly estimate of 25-50 s per *full-depth* run that is **430-860 deep
   verifications a day** — and materially more in practice, because a floor-3
   attempt replays in well under a second and most attempts are shallow. Against
   a realistic 2-4 improvements per active account per day, that budget serves a
   **low-four-figure daily-active ranked population** before verification is the
   binding constraint on anything. If it ever is, the lever in rule 4 is a VM
   size, not a second machine.

   **Deep runs are the throttled class.** Queue priority is `event entry >
   top-3 candidate > top-25 candidate`, and *within* a priority, cheapest-first
   by claimed tick count. A pile of 50-minute artifacts can therefore never
   starve the dailies — it only ever starves itself.
3. **Provisional, then promoted.** Every row carries a state:
   `claimed` (grey) -> `verifying` (pulsing) -> `verified` (seal) or `rejected`
   (removed, submitter cooled down) or `unverifiable` (see §2.6). Only `verified`
   rows are eligible for the top 3, for season CP, or as a rival contract. A
   `claimed` row may still be shown, visibly unproven.
4. **A hard duty cycle, with backpressure that SHEDS rather than closes.** The
   worker replays in chunks and yields, holding itself to
   `VERIFY_BUDGET_MS_PER_SEC` (start at 250 — 25% of a core). `/health` and
   `/metrics` expose `verify_queue_depth`, `verify_ms_total`,
   `verify_backlog_seconds`.

   When the backlog crosses its threshold the queue **drops its own tail**; it
   does not close the board. Shed order is least-trusted first, newest first
   within a class: unlinked accounts before linked ones, first-ever submissions
   before accounts with a verified history, newest before oldest. A shed entry is
   not lost — it is stored `claimed` with a `deferred` note and re-queued when the
   backlog clears. This matters because closing the board is precisely the
   outcome a flooder wants (§2.7): under shedding, a flood degrades the flooder's
   own entries first and the honest tail of the queue last. A single job that
   exceeds a 120 s wall-clock ceiling is killed and rejected.
   Escalation lever, already documented in DEPLOY.md: `fly scale vm
   performance-1x`. Verification is the first workload that would ever justify it,
   and it never requires scaling *out*.

**Storage.** ~27 KB per proof. Retention is bounded (rule 4 of the brief): keep a
proof only while its row is on a board, plus each account's own last 10 runs.
Top-25 daily x 30 days + top-100 x 4 all-time boards + personal ~= 1,200 proofs
~= **35 MB** on a 1 GB volume that Litestream already replicates. Proofs are
evicted with their row.

Note what that means for §0's promise, because the two interact: a proof is
playable while it is *retained* AND while its era is *executable* (§2.6f), and for
most rows retention expires first. The **row** and everything the verifier derived
onto it (§2.5.5) are permanent; the film is not. Private runs (§8.1) retain and
verify identically — the flag governs distribution, never storage or ranking.

### 2.5 What the server actually certifies

Replaying is necessary, not sufficient. The full check, in order (cheap rejects
first, because they run on the request thread):

1. **Shape**: artifact <= 128 KB, ticks <= 6h x 60, actions <= 20,000, every op in
   the allowed set, action ticks non-decreasing and <= ticks.
2. **Seed legitimacy**: for a daily/weekly event the seed MUST equal
   `dailySeed(day)` / the event's stored seed. For any board, `startKind` must be
   `fresh` — a `createTestGame` start is never eligible, which makes today's
   client-side `testMode` exclusion structural instead of polite.
3. **Rules**: `rulesHash` must match a sim build this server can execute (§2.6).
4. **Replay to completion** in the worker, then compare against the claim with
   **zero tolerance**: `status`, `floor`, `elapsed`, `kills`, `level`, `ultimate`.
   Note that elapsed is not an independent claim at all — it is `ticks * dt`. **You
   cannot claim a 4-minute clear without submitting 14,400 ticks that actually
   clear it.** That is the entire anti-cheat, and it is airtight in a way no
   heuristic ever is.
5. Band splits, death cause, and the final build are *derived* by the verifier as
   it replays — the client does not get to assert them, and they cost nothing
   extra once the replay is already running. **They are written onto the `runs`
   row at certification time, not recomputed on read.** That single decision is
   what lets a row stay informative after its proof stops being executable
   (§2.6f): the splits, the build and the named death are *data on the row*, and
   only WATCH and RACE depend on the proof still running.

   One caveat on death cause, because it is not free the way splits are: the sim
   does not currently record who hit you (§6 Beat 3 corrects an earlier claim
   about this). The verifier can only read an attacker identity if the sim keeps
   one, so the one-field change that makes it possible rides along with MUST-0's
   single history reset — see §9 MUST-0.

**Explicitly not attempted: bot detection.** A replay-verified run is a run a
human *could* have played. Whether a script played it is a different and much
softer problem — see §2.7.

### 2.6 Version drift — the hard part

The failure mode that kills replay systems: a run is recorded against sim build N;
two minutes later we deploy N+1 with a damage tweak; the artifact still decodes,
replays without error, and produces a *different* result. Naive verification calls
an honest player a cheater. Five mechanisms, in order:

**(a) A rules hash over what actually computes — not over the directory.**
The era is the scarcest resource in this design: every proof recorded under an
evicted era stops being playable (§2.6f). So the hash must move when the
*numbers* move and stay put otherwise. `scripts/simhash.ts` computes SHA-256
over a **behavioral projection** of `src/sim/`, not its raw bytes:

- Each `*.ts` module is passed through `ts.transpileModule` with
  `removeComments: true` before hashing. Comments are gone and types are erased,
  so a doc rewrite, a type annotation, an `import type`, or a reformat cannot
  burn an era. A changed constant still does, immediately.
- `roomPurposes.data.json` is hashed after
  `JSON.stringify(JSON.parse(...))` normalization.
- **`bot.ts` is excluded.** It is the test-only scripted policy driver, imported
  by `test/balance.test.ts`, `test/bands.test.ts`, `test/zz-bandhunt.test.ts` and
  `tools/replaymeasure.ts` — and by nothing that ships. A guard test asserts no
  shipping module imports it. Tuning the balance bot must never evict an honest
  player's proof.
- **`tips.ts` contributes its exported KEY SET, not its strings.** The keys *are*
  state — `systemTip` (`game.ts` ~1058) pushes a fired key onto `Player.tipsSeen`,
  which `serialize` includes — so adding or removing a tip is a rules change.
  Rewriting the copy is not, and copy is exactly the kind of thing that gets
  rewritten on a whim.

It writes `src/sim/rulesHash.ts` (`export const RULES_HASH = "..."`).
`test/replay.test.ts` recomputes it and fails if the committed constant is stale,
so a sim change that forgets to regenerate cannot merge. Client and server import
the same constant, so they agree by construction. Renderer/UI/server edits do not
move it; a `CONFIG` number does, which is correct — a balance change *is* a rules
change.

**Why the scoping is not fussiness.** On the current tree, **20 of the last 40
commits on main touched `src/sim/`** — roughly every second deploy. Under
raw-directory hashing, an era lasts about two deploys, and a typo fix in a
comment costs exactly as much as a damage rebalance. The projection is what turns
"four eras" (below) from days of coverage into months of it.

**(b) The image and the client both carry the last four sim eras.** A Docker
build step checks out the previous three release tags' `src/sim` into
`src/sim-eras/<hash>/`. The verify worker holds a map `rulesHash -> sim module`
with four entries, so a run recorded up to three releases ago still verifies
**under the rules it was played under**. Cost: ~200 KB of JS per era, ~600 KB
total — trivial insurance against normal deploy cadence, and cheaper than any
amount of explaining to a player why their record is unplayable. A test forbids
importing `src/sim-eras/` from anywhere except the verify worker and the client's
replay loader, so nobody accidentally *plays* on old rules.

**The client needs those eras too, for a stricter reason.** Ghosts (§4.1) and
in-browser replay (§8) execute proofs on the *player's* machine, where no server
is watching and a silent desync has no referee. Each non-current era ships as a
separate lazily-loaded chunk, fetched only when the player actually opens a proof
recorded under it; the current era is in the main bundle and the other three cost
nothing until used. §2.6f is the rule that makes this safe.

**(c) Verification is a one-time stamp, not a standing property.** Once a run is
certified under hash H, the row stores `verified_at` and `rules_hash = H` forever.
We never re-verify and never revoke on a patch. Boards render the era as a small
chip (`r7`), hover: "verified under rules era 7, 2026-08-14". This is the honest
reconciliation of "all-time" with "the game changes" — and it is something LoL
*cannot* show you, because their all-time stats silently blend twelve years of
patches.

**(d) Older than four eras is `unverifiable`, never `rejected`.** The row keeps
whatever stamp it earned. If it never earned one (queued when the deploy landed),
the player is told plainly, and offered a re-run: the seed is in the artifact, and
for a daily the seed *is* the day.

**(e) Events pin their era.** An event records its rules hash at creation.
Deploying a sim change mid-event **freezes** it: verified entries stand, new
submissions are refused with the System line *"PATCH DAY. Today's contract is
closed early. The lawyers apologize."* This adds exactly one line to the deploy
runbook — *check for a live event before shipping a sim change* — which is a good
habit regardless, and §3.5 makes the season boundary the natural patch window
anyway.

**(f) The client era gate is a hard error, never a silent desync.** This is the
failure mode the whole subsection exists to prevent, and it is *worse* on the
client than on the server, because on the client nothing is watching.

Every proof load — a ghost (§4.1), an in-browser replay (§8), RUN IT BACK against
a stored PB (§6 Beat 6) — starts with the same three-line decision:

1. `proof.rulesHash === RULES_HASH` -> execute in the main bundle's sim.
2. Otherwise, if the hash names one of the three lazily-loadable eras -> fetch
   that chunk and execute the proof **in the sim it was recorded under**, while
   the player's own run continues on the current sim. This is coherent precisely
   because a ghost is a rival's *trajectory* and never a shared world (§4.1): two
   sims of different eras running side by side is exactly what "you are racing
   what they actually did" means, and the ghost's floor-entry ticks stay as true
   as they were the day they were set.
3. Otherwise **refuse, loudly.** No ghost, no replay, and an explicit state on the
   button rather than a silently disabled one:
   `RECORDED UNDER RULES ERA 5 — NOT PLAYABLE ON ERA 8`.

Never step a foreign proof into the current sim "to see what happens". It will
not throw — the artifact still decodes and the sim still runs — it will quietly
diverge and render a wrong ghost with a wrong split delta, and the player has no
way to detect it. The gate is three lines; the alternative is the ladder lying
silently to exactly the players who care most.

**What happens to a board row whose proof outlives every executable era.** It
does not disappear and it does not lose its seal — verification is a one-time
stamp (§2.6c). The row **pins its era** (`rules_hash` lives on the row) and
degrades in exactly one dimension: WATCH and RACE go inert with the message
above, while everything the verifier derived at certification time — band splits,
final build, cause of death, the scoreboard (§2.5.5) — still renders, because it
was written onto the row rather than recomputed from the proof. An expired row
becomes a photograph instead of a film. That is a fine end state for a record set
five months and eight balance patches ago. A wrong ghost is not.

In practice most rows lose their proof to retention (§2.4 Storage) long before
they lose it to era drift, so the visible population of photographs stays small.

### 2.7 Abuse, identity, and the cost of a submission

**The hole in the obvious answer.** An earlier draft proposed "a per-account
bucket, 6/hour" and correctly noted that IP-only limiting is trivially bypassed.
The proposed fix had the identical weakness, because **an account is free**.
`auth.ts` accepts any client-supplied string matching `/^[A-Za-z0-9_-]{8,64}$/`
as an account token — no server issuance, no secret (`auth.ts:139`, `:197`,
`:211`) — and `db.ts:244` does `INSERT INTO accounts ... ON CONFLICT`, so the
account materializes on first use. A fresh token per submission defeats a
per-account bucket completely.

That is not merely a rate-limit leak; it is a **denial-of-ladder**. §3.2A makes
event entries verification-mandatory, so each free submission *purchases CPU*,
and at a 120 s wall-clock ceiling per job (§2.4 rule 4) one laptop can hold
`verify_backlog_seconds` over threshold indefinitely. If backpressure responded
by closing the board, the attack would cost nothing and would be
indistinguishable from the board being popular. Three changes, in priority order:

**1. Cost the submitter, not the self-asserted account.** Anything that enters
the verify queue or earns CP requires a **linked provider identity**. Discord
OAuth is already live (§1.1) and `account_identities` already stores the link, so
this is a check, not a build. Anonymous tokens keep working for everything that
consumes no CPU — local career, `claimed` board rows, ghosts, replay, party play
— so an anonymous player is never shut out of the *game*, only out of the
*ladder*, and the ask lands at the one moment it is obviously worth paying: the
first time a run is good enough to be worth sealing.

**2. Server-issued anonymous tokens.** Even on the claimed-only path, a token the
client invents is not a rate-limiting subject. `POST /auth/anon` returns
`<random>.<hmac>` signed with a Fly secret; the server rejects anything that does
not verify. No session table, no storage, one HMAC per request — and now a
per-token bucket means something. Existing client-invented tokens are
grandfathered as claimed-only until they link a provider, which is also the
migration path.

**3. Per-IP and per-account verify-CPU accounting.** The existing bucket (burst 6,
refill 6/min) counts *requests*; the scarce resource is *milliseconds*. Track
`verify_ms` per IP per 24h and per account per 24h against an explicit budget.
Over budget, submissions are still accepted and stored `claimed` — they are just
never queued. Combined with shedding backpressure (§2.4 rule 4), a flood degrades
the flooder's own entries and nobody else's.

**Harden `POST /auth/delete` before it has more to delete.** Today it
authenticates by knowing the token alone (`auth.ts:205-217`), the token rides in
a JSON body, and there is no origin check and no confirmation step. That is
survivable while it wipes one aggregate stats row. It is not survivable once §8
makes it wipe a verified career — proofs, CP, board rows, mastery, follows.
Before MUST-4 ships: a fresh provider re-auth for accounts with a linked
identity, a two-step confirm nonce for anonymous ones, an `Origin` check, and a
per-IP bucket on the endpoint. Deletion must stay easy and irreversible for the
person who owns the account, and must stop being a one-line request for anyone
who ever saw their token.

The rest, unchanged:

- **Storage**: bounded by §2.4 retention. No unbounded per-user growth, ever.
- **CPU**: bounded by the duty cycle. A submission flood costs queue depth, not
  frame time; shedding protects live play *and* the honest tail of the queue.
- **Replay bombs**: caps checked before any replay starts; wall-clock ceiling per
  job; the worker is disposable.
- **Name squatting / impersonation**: fixed by keying boards on `account_id` with
  the display name snapshotted at submit time (§5.1) — which also fixes FORGET ME.
- **Event-seed farming** is a different problem from flooding, and rate limits are
  the wrong tool for it. It is handled by event tickets in §3.2A.
- **Scripted play** is the residual and replay cannot solve it. Worth doing:
  input-entropy heuristics as a *flag for review*, never a verdict. Mostly: accept
  it, and let seasons expire a farm's advantage.

---

## 3. LADDERS WORTH CLIMBING

### 3.1 Why LP / tier / decay does not port

LoL's ladder rates head-to-head strength in a zero-sum, symmetric game, and
decays because a rating you stop proving becomes a lie about your strength. Our
run is a performance against a fixed dungeon. There is no opponent to take LP
from. Inventing one ("the dungeon wins when you die") reduces LP to win rate with
extra steps — and win rate is already a deliberate ~40% by design (BALANCE-NOTES),
so it would be a near-constant.

What actually fits a roguelike, and what speedrunning and the Isaac/Slay-the-Spire
daily scene worked out years ago: **rate your BEST, not your average, on a fixed
course, and reset it.** The interesting number is a record; the thing that makes a
record worth chasing again is a season.

### 3.2 Three ladder types

**A. SEEDED EVENTS — the competitive core.**

- **DAILY CONTRACT** — `dailySeed(day)` already exists (`src/sim/daily.ts`) and the
  board already runs. Keep "your best attempt of the day takes the row" — retrying
  a daily is playing the game, and at a 40% win rate one-attempt-only would just
  be a coin flip — and *show the attempt count on the row*, because a first-try
  clear should read differently from a twelfth.
- **WEEKLY CONTRACT** — a harder fixed seed plus a modifier drawn from the existing
  floor-event / elite-affix vocabulary, open 7 days. This is the *Clash* analogue:
  a scheduled, higher-stakes thing to plan around, minus the "five friends free at
  8pm" requirement that makes Clash hard to actually play.
- Every event entry is **verification-mandatory**. No proof, no row. Note what
  that costs: it is *not* bounded by board size, because attempts are unlimited.
  It is bounded instead by §2.4 rule 2's improvement rule — an attempt is only
  replayed if it beat your own verified best — which is what keeps the ceiling a
  function of players rather than of free time.

**EVENT TICKETS — the mechanism that makes an attempt count honest.** The attempt
number is the difference between a ladder that measures skill and one that
measures free time (§3.2C), and it cannot be self-reported. Entering an event
seed calls `POST /events/:id/start`, which returns a signed ticket
`<eventId>.<attemptNo>.<hmac>` — same secret and same one-line mechanism as the
anonymous tokens in §2.7. The proof header carries the ticket; verification
rejects an event entry without one, and the ticket's `attemptNo` *is* the attempt
number on the row. Cost: one endpoint, one HMAC, one integer per account per
event. No storage growth beyond a counter.

This closes the obvious dodge — play offline, retry until it is good, submit the
winner as "attempt 1" — because the start is observed rather than the finish. A
player can still practise the day's seed entirely offline; they simply cannot earn
CP for it, which is the correct trade and should be said in the UI rather than
discovered.

*If tickets are judged too much machinery for the first ship*, the fallback is an
explicit attempt decay on CP (§3.2C) using submitted-attempt counts only, with the
honest caveat that unsubmitted attempts are invisible to it. Tickets are the
better answer; the decay is the cheaper one.

**B. ALL-TIME BOARDS — the museum.**

Keep `deepest` / `fastest` / `kills`, add per-band (§3.3) and per-archetype (§3.4).
Era-chipped (§2.6c). Verified-only for the top 10; `claimed` rows may appear below
with a visible marker, so the board still fills on day one.

**C. SEASON RANK — the progression ladder.**

The replacement for LoL's tier ladder:

- The unit is **CONTRACT POINTS (CP)**, and your season score is the sum of your
  **best 10 event results** — a golf-tour portfolio, not a rating. Missing a week
  costs you a counting slot, not a number you have to defend.
- `CP = round(1000 * (1 - rank/entrants)^1.5)` for a placed run, plus a flat floor
  for finishing at all. Transparent enough to print on the post-run screen.
- **Placement**: your first 3 events of a season score CP normally, but no tier is
  shown until 3 are banked. Same purpose as LoL's ten placement games (don't rank
  someone off one data point) without pretending we estimate a hidden MMR.
- **No decay.** The deliberate departure. CP is not a rating of your strength; it
  is a record of what you did this season, and you do not un-do it. Urgency comes
  from the **season reset**, not a slow bleed. If the top ever needs freshness
  pressure, the honest lever already exists: only your best 10 of ~50 events count,
  so late results displace early ones on their own.

**Anti-farm, both halves of it.** CP comes only from EVENTS (fixed seeds), never
from free-seed runs — you cannot reroll a seed until it is easy. That closes
seed-shopping and leaves the other exploit wide open: §3.2A permits unlimited
attempts on the fixed seed, which harvests the same variance by a different route.
At the deliberate ~40% win rate (§3.1), a twentieth attempt beats a better
player's first, and a formula that pays purely on rank cannot tell them apart.
Showing the attempt count is disclosure, not a countermeasure.

So the board and the ladder are scored differently, and this is the single
decision that determines whether the season measures skill or free time:

| | scored on |
|---|---|
| **The board row** | your **best** attempt — retrying a daily is playing the game |
| **CP** | your **first ticketed attempt only** (§3.2A) |

Your first run on a seed is the one nobody can practise for, so it is the one the
ladder counts. Everything after it is still worth playing — it takes the board
row, the split records, the mastery and the personal bests — it just does not move
CP. First-attempt variance is exactly what the best-10-of-~50 portfolio already
absorbs: one bad opener costs a counting slot, not a rating, which is the same
argument that justified having no decay.

The post-run screen must say which number it is showing (§6 Beat 5): *"attempt 4
— board row updated, CP unchanged (scored on attempt 1)."*

- **Tiers** are live percentile bands of the season CP distribution — one sorted
  array, recomputed on write — named in the System's voice:
  `BRONZE ENTRANT -> SILVER PROSPECT -> GOLD CONTENDER -> CHAMPION -> HEADLINER
  (top 5%) -> THE SHOW (top 1%)`. THE SHOW updates live and it should sting to
  fall out of it.
- **Percentile, with an absolute floor — never absolute counts.** An earlier draft
  had HEADLINER as "top 50" and THE SHOW as "top 10", which at this game's
  population is nonsense: under ~60 ranked accounts *every* ranked player is a
  HEADLINER and a sixth of the game is in THE SHOW. LoL can afford absolute
  segmentation because it has 100M MAU; we cannot, and cosplaying it is the exact
  failure §3.1 set out to avoid. So: **THE SHOW does not exist below 200 ranked
  accounts in the season, and HEADLINER does not exist below 60.** Below those
  floors the ladder shows CP and "rank 7 of 34" — which is honest, legible, and
  perfectly motivating — and the tier names arrive as the population earns them.
  The full six-tier ladder is tuned for roughly **500-5,000 ranked accounts per
  season**; that is the number to design against and the number to check reality
  against.

### 3.3 Per-band boards

The run is six themed 3-floor bands (`FLOOR_BANDS`). A board per band answers
"who is the best at THE SEWERS" — a question a player who dies on floor 8 can
actually win. Metric: **fastest verified clear of the band's three floors within a
full run**. The splits are free: the verifier already knows the tick of every
floor transition as it replays. This is speedrun segmentation, and it turns "I
died on 11 again" into "I still hold the Ruins split".

**TRAVERSAL, NOT ATTENDANCE — and this is the whole board.** A band split counts
as a record only when the run *walked out of the band*: every floor in it
entered, and its last floor left behind (or the run won on floor 18). Ticks
accumulate for any floor a run merely enters, which is correct for a ledger and
catastrophic for a board — under the naive rule the optimal play for a band
record is to step into the band and die immediately, and the top of every board
fills with eight-second deaths. `ReplaySession.summary()` returns
`bandComplete[]` beside `bandSplitTicks[]`, the verifier is the only thing that
decides it, and `certify()` never even *stores* a partial band. A band you died
inside still appears on your own splits — it is a true thing that happened — and
it is never a record.

**Ties are broken in public.** Splits collide constantly at this population, so
the order is `ticks ASC, verified_at ASC, id ASC`, the board prints splits at
centisecond precision (the data was always exact tick counts), and the tiebreak
is stated in the board subtitle. A board that will not say how it broke a tie is
asking the reader to assume it did not.

**One source of truth.** The career panel's PERSONAL BESTS — BAND SPLITS reads
`GET /crawler/:id → bandBests`, which is the same rows and the same predicate as
`GET /bands/:n`. The localStorage ledger that used to back that panel is now
only an offline cache, overwritten by the server on every load. Two sources of
truth with different rules for the same record is one too many for anything
competitive.

### 3.4 Per-archetype boards

There is no player class today; identity comes from the **ultimate** held at the
end of the run — `airstrike` (SPONSOR) / `cataclysm` / `bullettime` — plus the four
slotted actives. That is a legible three-way split, so: three boards instead of
one, three top-tens instead of one, and a build choice that reads like picking a
lane. Derived from the proof; no new client input. A fourth ultimate adds a lane
for free.

Combined with §3.3 and party size (§7.4), the board matrix is
`kind x band? x archetype? x size` — potentially dozens of small, winnable
top-tens instead of one unreachable one.

**But a split is only a gift above a population threshold.** Dozens of boards
across tens of players is dozens of boards holding one or two rows, and a board
with two rows does not read as winnable, it reads as abandoned. Segmentation makes
a ladder feel populated *and* makes it feel dead, and which one you get is purely
a function of entrants per board. So every split is gated:

- **A split board materializes only at N >= 20 verified entries** in its window,
  and collapses into its parent until then. Below the gate the rows still exist —
  they are simply shown on the parent board, tagged with their archetype or band.
  Nothing is lost and nothing is empty.
- **The gate is the motivation, shown not hidden.** The System says it out loud:
  *"THE SPONSOR BOARD OPENS AT 20 ENTRANTS. CURRENT: 17. THE NETWORK IS PATIENT."*
  A board you can help unlock is better content than a board you can win alone.
- **Open the dimensions in order of population efficiency**: band splits first
  (every run passes through several bands, so a band board fills fastest), then
  party size, then archetype (which divides the population by three and should be
  last).

At the 500-5,000 ranked accounts §3.2C targets, most of the matrix is live. At
friends scale, one or two band boards open and the rest collapse — which is the
correct behaviour, and the reason the gate exists rather than a hope.

### 3.5 Seasons

- 6-8 weeks (one "cour" of the show). Season N ends at a fixed UTC instant: boards
  freeze, standings engrave onto profiles permanently, CP resets, a banner/frame
  cosmetic unlocks by final tier.
- **The season boundary is the correct moment to ship a balance patch**, and the
  DEPLOY.md runbook should say so — it aligns the rules-era problem (§2.6) with a
  moment when nobody has an in-flight ladder position.
- All-time boards never reset; they chip the era.

---

## 4. GHOSTS AND RIVALS

### 4.1 The ghost

A stored proof plus the same seed is a rival playing beside you, live, offline,
for as long as the proof is retained and its era is executable (§2.4, §2.6f).

**Load the proof through the era gate first** (§2.6f). A ghost whose `rulesHash`
is not executable is not a dimmer ghost, it is no ghost, with a reason on the
button.

**Cost, priced against the real budget.** The naive implementation — run a second
`GameState` on the main thread, one ghost tick per local sim tick — costs
20-675 us/tick depending on depth (§2.3). An earlier draft called that "0.1-4% of
a frame" against a 16,667 us frame. That is the *ideal* frame, not this project's.
The measured reality on the target device (Intel iGPU via ANGLE D3D11, default
quality preset, from the perf round): **combat frames land at 16.65 ms against a
16.67 ms vsync deadline** — 60.1 fps with essentially zero headroom, achieved by
dropping to pixel ratio 1.2. There is no spare 4% of a frame. Adding 0.675 ms of
main-thread sim at floor 16 does not cost 4% of slack; it costs the frame, on the
one constraint the whole perf round was fought over.

**So the ghost does not run on the main thread — and it does not need to.** A
ghost has no render state and no interaction with your world; the only thing the
frame needs from it is *the ghost crawler's transform this tick*, plus its
floor-entry ticks. That is fully precomputable, and §2.3 already measured the rate:
replay runs at **70-230x realtime**.

- On RACE, a `Worker` loads the proof (in its era's sim module) and replays it,
  streaming back a **ghost track**: 12 B/tick of transform + floor, or 10 Hz
  keyframes at ~2 B/tick with the main thread lerping between them.
- At 70x it is minutes ahead of the player within the first seconds of the run,
  and a 48,265-tick run's full track is ~580 KB raw / ~96 KB at 10 Hz — memory,
  not a stream.
- The main thread's per-frame cost becomes **an array index and a lerp**. Not 4%
  of a frame; not measurable.
- The worker is also exactly what §8's REPLAY scrubber needs (seek = index), so it
  is one piece of machinery serving both.

Render the ghost crawler as a translucent, desaturated pass; the renderer already
draws remote players for co-op. No netcode, no server, works offline. It is still
the cheapest multiplayer we will ever ship — just not for the arithmetic the first
draft used.

Rules that make it good rather than noise:

- Show the ghost only while it is on **your current floor**; otherwise it collapses
  into a HUD chip: `RIVAL — floor 7, 1:12 ahead`.
- The **split delta** is the drama: a live +/- against the ghost's floor-entry
  times, styled like a speedrun split, red when you lose time.
- Ghosts race, they do not interact — no damage, no collision, no shared loot.
  Interaction would require the ghost's world to be your world, and it isn't.
- Ghost sources: your own PB on this seed (default), yesterday's daily champion,
  a crawler you follow, or whoever sent you a challenge link.

**THE GHOST IS A BODY, NOT A WIDGET.** It renders in the world from the
worker's keyframe track: the crawler's own mesh, desaturated to its luminance,
pulled cold, 34% opacity, `depthWrite: false`, no shadows and no lighting
contribution. It is drawn only while it shares your floor and collapses to the
rail chip otherwise. A race you cannot see is a number.

The rail chip is titled with the RIVAL'S NAME, not "YOUR LAST RUN", and it stays
dark until there is a split to show — on floor 1, before either of you has left
it, there is no prior split on either side, so the chip shows the tick your
rival leaves this floor instead. Once there is a delta it is signed and coloured
in both directions: red for time lost, green for time taken.

### 4.2 Rival contracts

RIVALS mode already exists and is the one server-vouched score. Keep it, and add
the **asynchronous** form, which is what a 20-minute session actually wants:

- **CONTRACT ISSUED** — the System pairs you with a crawler near your CP and issues
  a contract on today's seed. You both play whenever you like; the better
  *verified* run takes it. One contract per day, resolves at rollover.
- **BOUNTY** — beating someone above you in CP transfers a bounded slice. This is
  the only zero-sum, LoL-shaped mechanic in the whole design, and it is opt-in and
  capped.
- **The rival picker is the matchmaking that matters here** (§7.3): a nightly job
  over accounts on the box, pairing by CP proximity and "played in the last 3
  days". One machine, a sorted array, no queue.

### 4.3 Making a short session feel contested

The goal: in a 20-minute run you should be racing *something* at all times.

1. The ghost on screen (§4.1).
2. A live board delta in the HUD corner: `40s ahead of #3 pace`.
3. Floor-entry callouts in the System voice, drawn from real board data:
   *"ENTERING THE IRONWORKS. Nine crawlers reached this floor today. Two left it."*
4. Post-run, the contested thing is **named**: *"you lost the daily by 11 seconds,
   on floor 12"* — with that exact ghost offered as an instant RETRY.

---

## 5. CAREER IDENTITY

### 5.1 The prerequisite

Boards key on `name`. Everything in this section — and the FORGET ME cascade —
requires keying on **`account_id`**, with the display name stored as a *snapshot at
submit time*. It is the single most load-bearing schema change in the document and
it is also a privacy fix, so it ships first (§9 MUST-4).

### 5.2 The profile

`/crawler/<publicId>` — a real, shareable page.

- **HEADLINE**: name, season tier + CP, seal count (verified runs), and a banner
  earned by best season finish.
- **THE NUMBERS WORTH STARING AT** — not "runs played":
  - **Where you die**: an 18-bar histogram of run endings by floor. This is a whole
    career in one glance and it is the most interesting chart the game can draw.
  - Deepest floor, fastest verified clear, longest survival *past* the collapse
    timer, best single-floor split per band, career kills, favourite ultimate with
    its win rate, and the share of runs where you claimed every draft.
- **MASTERY per archetype**: a level per ultimate (SPONSOR 7 / CATACLYSM 3 /
  BULLET TIME 1), earned from verified runs weighted by depth. LoL's mastery is a
  per-champion grade ladder; ours is per-ultimate and per-band, and unlike LoL's,
  every point of it is backed by a replayable proof.
- **PERSONAL BESTS**: a table per band / archetype / event type, each row linking
  to its proof — WATCH or RACE where the proof is still executable and still
  retained, and the stored summary plus an era chip where it is not (§2.6f). Your
  own last 10 runs are retained regardless of board position (§2.4 Storage), so
  the recent ones are always playable.
- **MILESTONE HISTORY**: a dated timeline. First floor-10. First clear. First daily
  win. First HEADLINER season. This is what people screenshot.
- The existing `composeRunCard` 1200x630 canvas becomes the profile's OG image.

**Tiers need a population, all of them.** The floor (`TIER_MIN_ACCOUNTS = 60`)
applies to the whole ladder rather than only to HEADLINER and THE SHOW: awarding
BRONZE ENTRANT to the last-placed player in a four-account season dresses four
people in the costume of four hundred, and they can count the entrants. Below
the floor the chip reads UNRANKED and the System states what unlocks the names.

**"Season" means the ladder period and nothing else.** A single run is an
EPISODE — which fits the game-show fiction better anyway — so the career panel
reads "31 episodes · 1 escape", the list is RECENT EPISODES, and a death is
"Episode canceled on floor 7".

### 5.3 What migrates

`dcc:history:v1` (localStorage, 60 runs) becomes a local cache and the offline
fallback; the server ledger is canonical for signed-in accounts and merges the
local ledger on first sign-in, exactly the way `account_tips` already merges the
browser's tip ledger (PERSISTENCE.md).

---

## 6. POST-RUN — the highest-leverage screen in the game

**What exists**: `#recap` renders a title, a subtitle, six stat tiles, three Show
tiles, achievements, the gear list, the ability list, a share card, and RUN AGAIN.

It is a good report card and a poor **retry engine**. It tells you *what* happened,
never *why you lost* or *what to do next*, and it compares you to nothing. In a
short-session game that is the whole job.

### 6.1 The principle

The post-run screen has one job: convert the end of a run into the start of the
next one, in under eight seconds of reading. Every element must (a) grade you,
(b) name the thing that killed you, or (c) be a button.

**Which means the six beats below cannot all be on screen at once.** Written out
in full they are a twenty-second read — a grade with a four-part breakdown, a
three-column scoreboard with superlatives, a named death, a band-by-band split
bar, five kinds of earned delta and five buttons. That is a good *report*, and the
principle above says this is not a report. So the screen has a default state and a
drill-down, and the default state is the design:

| | contents | budget |
|---|---|---|
| **DEFAULT — the whole screen** | Beat 0 (the freeze), Beat 1 (the grade, one line of commentary), Beat 3 (the named death), Beat 5 collapsed to **one line plus the live seal chip**, Beat 6 (the buttons) | under eight seconds |
| **TAB — held, like LoL's scoreboard** | Beat 2 (the scoreboard) and Beat 4 (the splits), full width | as long as you want |
| **Beat 5 expanded** | click the line: every PB, every mastery tick, the CP arithmetic | opt-in |

Binding the detail to a held TAB is not a compromise — it is the same gesture LoL
trained everyone to make, and it means the numbers are *there* for the player who
argues about numbers and *absent* for the player who wants to press R.

### 6.2 The screen, in beats

**Beat 0 — the freeze (0.0-0.6s).** Partly there already (`hitStop` on death).
Hold the killing blow, desaturate, then the banner. The System is a game show; the
death deserves a beat.

**Beat 1 — THE GRADE.** One letter, S/A/B/C/D, huge, with one line of System
commentary. Computed as a percentile against **your own history and today's board**,
not an absolute — so a D on floor 3 and an S on floor 3 both exist and both mean
something. A grade you can only earn at depth is just a depth readout.

Four equal parts, shown on hover:
`DEPTH` (floor vs your median) · `TEMPO` (sim seconds per floor vs the day's median)
· `SURVIVAL` (damage taken per floor) · `EXECUTION` (kills per minute + drafts
claimed).

**Cold start — the case that decides whether there is a second run.** A percentile
against "your own history and today's board" has neither on a first run, and has
neither in an offline session. So the grade falls back explicitly, in this order:

1. **Fewer than 5 finished runs in the local ledger** (`dcc:history:v1`) → grade
   against a **fixed absolute curve** per floor band, authored once from the
   balance bot's own distribution (`tools/replaymeasure.ts` already produces it).
   A first-run player gets a real grade, not a placeholder — and a first-floor
   death that reaches floor 3 with two drafts claimed can honestly be a B.
2. **5 or more local runs, offline or board unavailable** → percentile against
   your local history alone; the hover says `vs YOUR 27 RUNS`.
3. **Online with history** → the full thing; the hover says
   `vs YOUR 27 RUNS · TODAY'S 84`.

The hover label always names its comparison set, so a grade never implies a
population it does not have. The absolute curve is also what makes the very first
grade *meaningful* rather than flattering, which is the only version worth having.

**Beat 2 — THE SCOREBOARD.** LoL's post-game scoreboard is the model: rows you can
argue about.
- **Solo**: three columns — YOU / THE GHOST YOU RACED / TODAY'S #1 — sharing the
  same rows (floor, time, kills, damage taken, gold spent, best split). Comparison
  is what makes a number mean anything, and today's recap has none.
- **Co-op**: a row per party member (damage dealt/taken, kills, revives, gold
  spent, drafts claimed) plus one auto-awarded superlative each — MOST WANTED /
  BEST DRESSED / THE TANK / CROWD FAVOURITE — so nobody reads the screen and
  concludes they were the worst one.

**Beat 3 — THE DEATH, NAMED.** The single highest-value new element on the screen.

> **THE FOREMAN — 340 damage, from 62% HP.**
> Dash was up. You died holding 2 flasks and an unclaimed draft.

That sentence is worth more than every stat tile currently on the screen. It is
also **not free**, and an earlier draft said it was, on the grounds that "the sim
already emits typed hit events". It does not emit what this beat needs:

- `HitEvent` is `{ pos, amount, kind, dir?, killed?, overkill?, school?, resisted?,
  effect?, to? }` (`types.ts:880`). **There is no attacker identity in it.**
- `state.hits` is initialized at `game.ts:1559`, pushed at `game.ts:2047` /
  `:4766` / `:5461`, and **wiped at the top of every step** (`game.ts:5492`,
  `state.hits = []`). It is a per-tick render buffer, not a log. Nothing in it
  survives to the death tick, let alone "the last ten seconds".
- The reverse direction already exists and shows how cheap the right shape is:
  `Monster.lastHitBy` (`types.ts:314`) records which player got the kill, for loot
  boxes.

The fix is one field at one seam, and the seam is already a funnel: **every source
of player damage goes through `damagePlayerHit(state, p, base, opts)`
(`game.ts:2084`)**, called from ~10 sites in `ai.ts` and `game.ts` that all have
the attacking monster in scope. Add `opts.src` and record it on the player as
`lastHitSrc` — a `Player` field, so it survives the per-step `hits` wipe — and the
verifier reads it at the death tick and writes the named death onto the row
(§2.5.5). No client assertion, no heuristic.

**Be honest about what that costs: it moves the rules hash.** `state.hits` and
`Player` are both inside `serialize`, so the field changes byte-exact replay
comparison even though it changes no number. Therefore **it ships with MUST-0**,
which is already the one-time history reset (§9 MUST-0). One era boundary, not two.

**Before verification ships** (MUST-7 lands first, deliberately), the beat renders
from a client-local fallback: the host attributes the killing blow by correlating
the final `kind: "player"` hit's position and `dir` against monsters within
attack range that tick — a render-layer heuristic, no sim change, occasionally
wrong in a crowd, and entirely good enough for a report card. It is replaced by
the verifier's answer the moment the seal lands, which is a nice demonstration of
what the seal is *for*.

**Beat 4 — THE SPLITS.** A band-by-band bar: your time per band vs your PB vs the
board leader, with the band where you lost it highlighted. This is what gives the
next run a plan instead of a vibe.

**Beat 5 — WHAT YOU EARNED.** In the default state this is **one line and a chip**:
the headline earning (`NEW PB — RUINS SPLIT, -14s`, or the CP delta, or nothing but
the seal) plus the verification state resolving live — `PROOF SUBMITTED —
verifying...` becoming a seal while you read the rest of the screen. Watching the
seal land is two genuinely satisfying seconds and it is the moment the trust model
becomes something the player can *feel*.

Click the line to expand: every PB broken (each stamped NEW PB), mastery ticks,
achievements, and the CP arithmetic printed in full. The CP line must state which
attempt it scored (§3.2C):

> `attempt 4 — board row updated. CP unchanged (scored on attempt 1: 612).`

A player who learns that rule from the screen on attempt 2 is informed. A player
who discovers it at the end of a season is furious, and correctly so.

Two states this beat must handle without lying:
- **No provider linked** — CP and the seal both require one (§2.7). Say so, once,
  in the System's voice, with the button: *"unsealed. The System does not put its
  name on an anonymous claim. LINK AN IDENTITY."*
- **Rejected on verification** — the row is removed and the player is told plainly
  and immediately, not silently. A rejection that arrives with no explanation is
  how honest players conclude the ladder is rigged.

**Beat 6 — THE BUTTONS**, in this order and this prominence:
1. **RUN IT BACK** — same seed, this run's ghost enabled. The biggest retry driver
   in the design, because "I know this dungeon now" is the strongest urge a
   roguelike death produces. Bound to the key the player already reflex-presses (R).
2. **NEW CONTRACT** — fresh seed.
3. **RACE THE LEADER** — today's #1 as your ghost.
4. SHARE (run card + proof link).
5. Dismiss.

**THE LADDER LINE IS PERMANENT.** Tier (or UNRANKED), season CP,
rank-of-entrants and the delta this run produced sit in the default state beside
the seal — never inside the [SHOW THE MATH] drawer, and never only for event
runs. It is the LP line; it is the reason the player presses R. A free seed
prints "+0 CP" out loud with the reason, because "the ladder did not move" is
information and a blank space is not.

**THE SEAL IS WEIGHTED BY WHAT IT CERTIFIES.** A run holding a board position
gets the filled gold seal; a run the server replayed and certified that ranks
nowhere gets a hairline chip. Printing an eight-second floor-1 death and a
rank-1 clear identically spends the scarcity that makes the gold one worth
having.

**A STATE THE VERIFIER WOULD REJECT NEVER WEARS LADDER FURNITURE.** A
test-chamber start (or any run standing on floor N that only entered one floor)
gets a **TEST CHAMBER — NOT RANKED** banner instead of a CP line, and the DEPTH
tile says "started here, not walked". The verifier refuses a non-fresh start, so
a screen that dresses one up is claiming an authority the server would decline.

### 6.3 What to cut

The gear and ability dumps are inventory review, not a report card — collapse them
behind a THE BUILD toggle. Every pixel between the grade and the retry button
costs a run.

---

## 7. MATCHMAKING / CO-OP

Matchmaking in symmetric PvP means "find nine strangers of similar skill in 90
seconds". We cannot do that and should not pretend to: one machine, private codes,
and a population that starts at friends scale and, on the numbers in §2.4 rule 2,
tops out around a low-four-figure daily-active ranked cohort before the box is the
constraint. §3.2C and §3.4 are written to degrade gracefully across that whole
range rather than to assume the top of it. What matchmaking means here:

### 7.1 Party finding (exists, needs a face)

`GET /open-parties` already lists discoverable co-op instances with a free seat.
Give it a real QUICK JOIN panel showing floor, band, party size, and one filter
that actually matters: **near my depth**. Sort by `abs(theirFloor - myDeepest)`;
*warn* on a bad match rather than blocking it — a stranger dropping into floor 14
at level 3 is a bad time for six people, but it is their call.

### 7.2 Skill-matched co-op

Match on `account_stats.deepest`, which is already stored, bucketed into three
tiers — enough at this population: **LEARNING** (deepest <= 6), **CRAWLING**
(7-12), **HEADLINING** (13+).

### 7.3 Rival pairing — the matchmaking that matters

§4.2. A nightly job over accounts on the box: CP proximity plus an activity
filter. No queue, no wait, no lobby. You wake up with a contract.

### 7.4 Premades and the LoL duo problem

LoL restricts premades in ranked because a coordinated duo distorts a *symmetric*
ladder. Here co-op is cooperative — it cannot distort a solo ladder, because it is
a different board. The rule: **CP comes from solo verified event runs only.**
Co-op gets its own boards with party size as a board dimension (solo / duo / 3-4 /
5-6). Segmentation instead of restriction; the whole problem disappears.

### 7.5 What we deliberately do not build

A global matchmaking queue, voice chat, or an ELO for co-op. One machine, and none
of them are the fun part.

---

## 8. SOCIAL SURFACE — without a moderation nightmare

**The rule: share ARTIFACTS, never free text.** Every surface below carries only
(a) server-generated text, (b) a sanitized display name, or (c) a proof. No chat,
no comments, no custom titles, no user images. That is not a limitation — it is
what makes this operable by nobody.

### 8.1 Consent — the half of privacy that deletion does not cover

§1.2 names the live FORGET ME gap and the cascade below closes it. Deletion is
not the whole story, because **a RunProof is a 60 Hz recording of everything the
player did**, bound to an account, published to strangers as a raceable ghost
(§4.1) and a permanent link (`/run/<id>`). Nothing in the design so far tells the
player that before it happens. "Share artifacts, never free text" is a moderation
rule; it is not consent. Two additions, both small:

**Disclosure at first submit, once, in the System's voice.** Not a checkbox wall
— one card, the first time a run is offered to a board, with the two facts that
matter and two buttons:

> **THE SYSTEM RECORDS EVERYTHING YOU DO.**
> Every button, sixty times a second. That recording is what makes the seal worth
> anything — anyone can replay your run and watch you earn it. It is also how
> other crawlers race your ghost.
> `SUBMIT — PUBLIC` · `SUBMIT — PRIVATE` · `DON'T SUBMIT`

**A per-run PRIVATE flag** (`runs.private`), settable at submit and toggleable
afterwards from your own profile. A private run:

- **is still verified and still ranks.** The server keeps the proof, replays it,
  seals it, and the row takes its rightful place on the board with a small lock
  chip beside the seal. Competitive integrity does not depend on distribution.
- **is not distributed.** `/run/<id>` returns 404 to everyone but the owner; the
  proof is never served as a ghost, never appears on a build page, and is not
  offered as RACE THE LEADER. The board row shows the verifier-derived summary
  only.
- **is the reason §0 says "every entry that ranks is a proof" and not "every
  ranked run is watchable"** — those are different promises and only the first is
  unconditional.

Defaulting to public is fine; defaulting *silently* to public is not. And the
disclosure is genuinely good copy — the System explaining that it is watching is
the most in-voice thing this game could possibly say.

### 8.2 The surfaces

- **Share a run**: `/run/<id>` — the run card, the scoreboard, the splits, plus
  WATCH (in-browser replay) and RACE THIS (ghost). 27 KB of payload behind a
  40-character link. Private runs 404 here (§8.1); runs whose era is no longer
  executable render the summary with WATCH and RACE inert and labelled (§2.6f).
- **Share a build**: derived from the proof's final state — ultimate, slots, ranks,
  glyphs, gear. A build page is a read-only view of a *verified run*, so a build is
  permanently attached to evidence that it worked. LoL's build sites are aggregate
  guesses; ours are receipts.
- **Spectate**, two kinds:
  1. **REPLAY** — the proof played back at 1x/2x/8x with a scrubber. This is the
     ghost machinery with a camera attached (§4.1's worker: seek = index into the
     precomputed track), costs the server nothing, works offline, and covers ~95%
     of what spectating is for. Same era gate as everything else (§2.6f).
  2. **LIVE** — a read-only WebSocket seat on a running instance, hard-capped (2
     spectators per instance, dynamic snapshots only, sends nothing). Build only if
     people ask; replay comes first.
- **Friends / rivals**: a one-directional follow list of account ids, capped at
  100. No requests, no accept flow, no DMs — following needs no consent surface,
  which deletes an entire class of moderation work. Followed crawlers highlight on
  boards and are one click from being your ghost.
- **The complete moderation surface**: display names (already `sanitizeName`,
  extended to snapshot-at-submit) and one REPORT NAME button on a profile. On
  action, the name is replaced with `Crawler #1234` everywhere by account id — one
  UPDATE, because names are snapshotted per row and keyed by account.
- **FORGET ME must cascade.** Today it misses the boards entirely (§1.2). After
  the account_id migration it must delete proofs, board rows, CP, follows, mastery,
  and the profile — with a test. It must also be **harder to trigger than knowing
  a token** before it has that much to erase (§2.7).

---

## 9. MIGRATION MAP

Scoped so each item is shippable alone and nothing below depends on a rewrite.


### SHIPPED

**Every MUST has landed** — the sim seam, the server, and the player-facing
surface. What remains is the SHOULD list below.

| Item | Where it lives |
|---|---|
| **0. Deterministic math** | `src/sim/dmath.ts` — 28 `hypot`, 47 `sin`/`cos`, 7 `atan2`, 3 `pow`, 2 `asin`/`acos` converted. The `determinism guard` in `test/balance.test.ts` now bans the whole transcendental family in `src/sim/`; `test/determinism-portability.test.ts` pins outputs with a golden fixture. Ride-along: `opts.src` → `Player.lastHitSrc` at the `damagePlayerHit` funnel, so the verifier can name a death |
| **1. The codec + era gate** | `src/sim/replay.ts` — `RunRecorder`, `ReplaySession`, `encodeProof`/`decodeProof`, `validateProofShape`, `diffClaim`, and `assertPlayableEra`, which refuses a foreign proof loudly instead of desyncing |
| **2. Rules hash** | `scripts/simhash.ts` → `src/sim/rulesHash.ts`. Behavioral projection (transpiled, comment-free), `bot.ts` excluded, `tips.ts` contributes keys not strings — all four properties are asserted in `test/replay.test.ts` |
| **4. Schema** | `src/server/competitive.ts` — `runs`, `run_proofs`, `run_bands`, `events`, `event_attempts`, `season_results`, `season_cp`, `mastery`, `follows`, `verify_budget`, all `IF NOT EXISTS` on the live volume. Rows key on `account_id` with the name snapshotted, and `deleteAccount` reaches every one of them |
| **5. Endpoints** | `src/server/competitiveApi.ts` + `src/server/tokens.ts`. `POST /auth/anon`, `POST /runs`, `GET /runs/:id`, `POST /runs/:id/private`, `GET /boards/:kind`, `GET /bands/:n`, `GET /crawler/:id`, `GET /events/current`, `POST /events/:id/start`, `GET /rivals/contract`. `POST /auth/delete` hardened (provider re-auth, confirm nonce, Origin check, per-IP bucket) |
| **6. The worker** | `src/server/verifyWorker.ts` (replay + slice/sleep duty cycle), `src/server/verify.ts` (queue, priorities, shedding, budgets), `src/server/verifyExecutor.ts` (worker with an inline fallback). `verify_queue_depth`, `verify_ms_total`, `verify_backlog_seconds` are on `/health` and `/metrics` |

| Ghost data path | `src/net/ghostWorker.ts` precomputes the track off-thread; `src/net/competitiveClient.ts` is the wire (submit, boards, tickets, proof download with the era verdict attached) |
| **3. Host recording** | `src/main3d.ts` — the sub-step feeds `step()` the intent AFTER the wire round trip *whether or not a recorder is armed* (`rec.record()` when it is, `canonicalIntent()` when it is not), so recording cannot change sim behaviour by construction rather than by care. A ping is re-attached to the decoded intent exactly the way `ReplaySession` re-attaches it. All 15 out-of-band calls emit a `rec.action(...)` beside the real call. A run that did not start at floor 1 in this browser (CONTINUE, test chamber, party) is deliberately NOT recorded, and the post-run screen prints the reason |
| **7. The screens** | `src/main3d.ts` + `iso.html` + `src/ui/social.ts`. THE VERDICT (`#recap`, grade + named death + earned line + live seal + buttons, with the scoreboard and splits behind a held TAB), THE STANDINGS (`#ladder`: contracts / all-time / bands / rivals), THE CRAWLER (`#career`: the 18-bar death histogram, mastery, PB splits, milestones), the ghost rail chip + chart marker, the consent card (`#consent`), and the challenge codec |

**Re-measured after MUST-0** (`npx tsx tools/replaycheck.ts`, same dev box, same
bot, dt=1/60). The numbers improved, because `dhypot` is `sqrt(a*a+b*b)` and
beats `Math.hypot` by enough to show up at the run level:

| seed | end | ticks | sim time | container | +gzip | brotli | replay | x realtime | us/tick | exact |
|---|---|---|---|---|---|---|---|---|---|---|
| 7 | **floor 18, WON** | 54,398 | 15.1 min | 99.0 KB | **29.4 KB** | 23.1 KB | 5.9 s | 153x | 108.6 | yes |
| 31 | floor 13 | 30,853 | 8.6 min | 47.9 KB | 13.0 KB | 10.3 KB | 2.5 s | 203x | 82.2 | yes |
| 47 | floor 11 | 25,947 | 7.2 min | 45.7 KB | 11.4 KB | 9.0 KB | 1.7 s | 252x | 66.2 | yes |
| 101 | floor 8 | 19,626 | 5.5 min | 42.7 KB | 6.8 KB | 5.4 KB | 1.1 s | 294x | 56.6 | yes |

So a **full 18-floor clear is 29 KB and 5.9 seconds of CPU** here, against the
§2.3 estimate of ~30-35 KB and 14-16 s. At Fly's 1.5-3x penalty that is
**9-18 s per deep verification**, not 25-50 — roughly **1,200-2,400 deep
verifications a day** inside the same 250 ms/s duty cycle. The ceiling in §2.4
rule 2 moves the right way; the rule itself does not change.

End to end against the real server (worker thread, 250 ms/s duty cycle): a
5.6 KB / 13,267-tick artifact returns from `POST /runs` in **16 ms** (the
request thread only does shape + queue rules) and is **verified 3.6 s later**
— about 0.9 s of actual CPU. The verdict carried what the verifier derived and
the client never asserted: band splits `[6422, 6845, 0, 0, 0, 0]` and the named
death `boss / "The Sump King" / 30 damage from 10 of 352 HP`.

**What MUST-3 has to do, exactly** (the host contract):

```ts
const rec = new RunRecorder({ seed, mode, runKind, playerName, eventId, ticket });
// ...each sub-step, feed step() THE RETURN VALUE, not the raw intent:
step(state, rec.record(sampleIntent(dt)), REPLAY_DT);
// ...and one line beside each out-of-band call, in the same order:
rec.action("reward", idx); chooseReward(state, pid, idx);
// ...then at the status edge:
await client.submitRun(rec.finish(state, pid), token, name, "public" | "private");
```

`rec.record()` returns the DECODED intent, which is what makes recording
unable to change sim behaviour: the host feeds `step()` the same quantized
value whether or not anyone is recording, so there is no second code path to
drift. Ops the recorder knows: `reward upgrade buy sell sellAll equip slot ult
socket unsocket dismantle refit ready claim ping`.

### MUST

**0. `src/sim/dmath.ts` — deterministic math. THE ONE-TIME HISTORY RESET.**
*Nothing else in this document is sound until this ships.* Replace every
implementation-approximated `Math` call in `src/sim/` (§2.1 census: **28**
`hypot`, **47** `sin`/`cos`, 7 `atan2`, 3 `pow`, 2 `asin`/`acos`). Extend the
`determinism guard` test in `test/balance.test.ts` to ban the whole family in
`src/sim/`. Pin `dmath` outputs with a golden fixture. Keep
`tools/mathdivergence.ts` as the cross-engine canary.

**Say the quiet part: this is not a purity cleanup, it is a balance change.**
Even the "mechanical" first step — `hypot -> Math.sqrt(a*a+b*b)` — is not
result-preserving. Different rounding, different overflow behaviour, therefore
different distances, therefore different aggro checks, therefore different runs.
It perturbs balance, breaks golden fixtures, moves the rules hash, and **retires
the meaning of every leaderboard row recorded before it**. That is fine, and it is
survivable exactly once. It is not survivable after players have earned seals.

Two hard ordering constraints follow, and they are the reason this is MUST-0
rather than a tidy-up someone does later:

1. **MUST-0 ships before any board goes verified.** No row may carry a seal from
   an era that MUST-0 is about to invalidate.
2. **MUST-4's import of `leaderboard.json` is downstream of MUST-0, and imports
   every existing row as `state='claimed'`** — never `verified`, never
   era-stamped. The current boards were recorded under pre-`dmath` rules by
   clients whose `Math.sin` we now know disagreed across engines; they are history,
   not evidence. Shipping these two in the other order silently blesses
   unverifiable rows as verified, and there is no way back from that.

**Ride-along, deliberately bundled here:** the `damagePlayerHit` attacker field
that Beat 3 needs (§6.2 Beat 3, `opts.src` -> `Player.lastHitSrc`). It moves the
rules hash without moving a number, so it belongs in the era boundary we are
already paying for, not in a second one a month later.

*Sim seam only — no schema, no endpoint, no UI.*

**1. `src/sim/replay.ts` — the codec, and the era gate that guards it.** §2.2,
already prototyped in `tools/replaymeasure.ts`. Pure, inside the sim, covered by
the purity guard and the rules hash. **The client-side `rulesHash` check (§2.6f)
ships in the loader here, not later with the era chunks** — a gate that refuses
everything foreign is correct from day one; multi-era playback is the upgrade
that makes it refuse less.

**2. `src/sim/rulesHash.ts` + `scripts/simhash.ts` + the staleness test.** §2.6a.


**3. Host recording. SHIPPED.** `main3d.ts` records the intent it already builds each
sub-step *after* encoding/decoding it, plus every out-of-band action call
(`chooseReward`, `chooseUpgrade`, `buyCatalogItem`, `sellItem`, `sellAllItems`,
`equipFromInventory`, `slotAbility`, `setUltimate`, `socketGlyph`, `unsocketGlyph`,
`dismantleItem`, `refitItem`, `setReady`, `claimAchievementLootBox`). The only
sim-visible change is feeding the decoded intent to `step()` — which the sim cannot
distinguish, by construction. Memory: 4 B/tick = 864 KB for a 60-minute run; cap
and stop recording past a ceiling. **Constraint: recording must not change sim
behaviour** (brief rule 1) — the round-trip guarantees it, and the replay
round-trip test proves it.

**4. Schema.** The leaderboard moves off JSON into SQLite. PERSISTENCE.md's
condition for that migration ("only if the model actually bites") is now met: rows
need account ids, proof references, verification state, era stamps, and a deletion
cascade. Import `leaderboard.json` once as `state='claimed'`, then retire it.

```sql
run_proofs(id PK, account_id, rules_hash, seed, event_id, ticks,
           frames BLOB, actions BLOB, claim TEXT, created_at)
runs(id PK, account_id, display_name, event_id, seed, rules_hash,
     won, floor, time_ticks, kills, level, ultimate, band_splits TEXT,
     death_cause TEXT, final_build TEXT,   -- verifier-derived, stored (§2.5.5)
     attempt_no INTEGER,                   -- from the event ticket (§3.2A)
     private INTEGER DEFAULT 0,            -- ranks, but never distributed (§8.1)
     state TEXT CHECK(state IN ('claimed','verifying','verified','rejected','unverifiable')),
     verified_at, proof_id, created_at)
events(id PK, kind, day, seed, rules_hash, opens_at, closes_at, frozen)
event_attempts(account_id, event_id, attempts INTEGER, first_scored_run_id,
               PRIMARY KEY(account_id, event_id))   -- ticket counter + CP anchor
season_cp(account_id, season, cp, events_counted, updated_at, PRIMARY KEY(account_id, season))
mastery(account_id, ultimate, xp, updated_at, PRIMARY KEY(account_id, ultimate))
follows(account_id, target_id, created_at, PRIMARY KEY(account_id, target_id))
verify_budget(subject TEXT, day TEXT, ms INTEGER, PRIMARY KEY(subject, day))  -- §2.7.3
```
Indexes: `runs(event_id, state, won DESC, floor DESC, time_ticks ASC)`,
`runs(account_id, created_at DESC)`. `account_stats` stays as the cheap career
aggregate. **`deleteAccount` gains every one of these tables** — with a test.
`verify_budget` is the only unbounded-looking table and it is not: rows are keyed
by day and swept on a 48h window.

**Import order is a constraint, not a preference** (§9 MUST-0): the one-time
`leaderboard.json` import runs *after* MUST-0 and writes `state='claimed'` with a
NULL `rules_hash` for every row.

**5. Endpoints.**
`POST /auth/anon` (server-issued signed anonymous token, §2.7.2) ·
`POST /runs` (proof submit, <= 128 KB, per-IP + per-account buckets, verify-CPU
budget, linked identity required to enter the queue) ·
`GET /runs/:id` (metadata + proof, for ghosts and replay; 404 when private) ·
`GET /boards/:kind?event=&band=&archetype=&size=` (replaces `/leaderboard`, which
stays as an alias through the migration; split boards collapse to the parent below
the entrant gate, §3.4) · `GET /crawler/:id` · `GET /events/current` ·
`POST /events/:id/start` (issues the signed attempt ticket, §3.2A) ·
`GET /rivals/contract` · `POST /runs/:id/private` (owner-only toggle, §8.1).
Hardened: `POST /auth/delete` (§2.7).

**6. `src/server/verifyWorker.ts`** — the worker, queue, duty cycle, and
shedding backpressure of §2.4, the improvement-only queue rule (§2.4 rule 2), the
per-IP/per-account verify-CPU budget (§2.7.3), plus `verify_queue_depth` /
`verify_ms_total` / `verify_backlog_seconds` on `/health` and `/metrics`.


**7. The post-run screen (§6). SHIPPED**, and so did the rest of the player
surface it hangs off (§3, §4.1, §5.2, §8.1-8.2). Three decisions worth keeping
when this screen is next touched, because each of them was a bug first:

- **The grade is capped by depth.** Without the ceiling the four-part average
  is gameable by dying instantly: a run that ends eight seconds into floor 1
  clears no floors slowly and takes almost no damage, so three of the four
  parts reward it. It scored a B. You may now finish at most one letter above
  the depth you reached, and the basis line says `CAPPED BY DEPTH` when the
  ceiling is what decided the letter.
- **TEMPO divides by floors CLEARED, never by the floor you died on**, and
  SURVIVAL is **seconds per health bar lost**, not damage per floor. The old
  metric is undefined for a run that clears nothing and flatters a crawler who
  died before anything could hit them.
- **Band split deltas compare against the bests as they stood BEFORE the run
  banked its own**, or every split proudly reports zero against itself.


### ELEVATION ROUND 2 — what the spine gained, and what it cost

Not new systems. The round closed the gap between what this document says the
verification spine does and what the code actually did.

| Hole | Where it was | What it is now |
|---|---|---|
| **The public board handed out bearer tokens.** `publicRun` returned `accountId`, and `account_id` IS the auth token (`POST /runs?token=` passes it straight in, `TokenService.isUsable` authenticates that exact string). One unauthenticated `GET /boards/deepest` was a credential dump for every ranked crawler: burn their attempt counter, flip their sealed run private, submit a tampered proof in their name, read their linked identity, complete their FORGET ME | `competitiveApi.publicRun` | `publicIdFor(accountId)` = `sha256("dcc:public:"+id)[:16]`, on **every** wire projection — board rows, the profile, the follow list, the rival card. `account_public` holds the one reverse lookup a `/crawler/<publicId>` link needs. Asserted by a test that greps the whole payload for the token |
| **Event tickets did not close the dodge they document.** `issueTicket` signed `eventId:accountId:attemptNo` only — no timestamp, no single-use — so "call /start once, keep ticket #1, play twenty runs offline, submit the best" arrived as attempt 1, `scoresCp: true` | `tokens.ts`, `competitiveApi.submit` | The ticket is **stamped** and **spent**. A submission must be at least `ticks * dt` old (a run cannot arrive before it has been played) and at most `ticks * dt + TICKET_GRACE_MS` (15 min) — so the window holds roughly one run rather than an afternoon of them — and the signature is consumed in `spent_tickets` on first use. A ticket outside its window is not a rejection: the row stands, unproven, with the reason printed |
| **The era stamp was the server's, not the proof's.** `certify(..., rulesHash: RULES_HASH)` discarded `proof.header.rulesHash`. Invisible at one era; a lie on the first widened deploy, on the one chip §2.6c says LoL cannot show you | `VerifyJob.rulesHash` | The job carries the proof's hash and `certify` stamps `rules_hash = H` |
| **The verify worker accepted eras it could not execute.** It imports one sim and passed the caller's `eras[]` through as `availableEras`; `assertPlayableEra` only checks list membership. Widening `eras` to four would have replayed old proofs under new rules — §2.6f's forbidden failure mode, on the server | `verifyWorker.ERA_SIMS` | The gate is keyed to **loadable sim modules**. `executableEras()` intersects any requested list with `ERA_SIMS`, in the worker AND in `CompetitiveApi`, so `playable` on the wire cannot promise a ghost the box cannot run. When `src/sim-eras/` lands, each era registers its module in that map |
| **The verified/unproven split lived in one renderer.** `GET /boards/:kind` mixed both in `entries` while the response's own subtitle claimed every ranked row is a proof | `competitiveApi` boards route | Two arrays. `entries` is **proofs only**, `unproven` carries the claims, and a second consumer cannot render a fabricated floor-18 row as a rank |
| **Proof retention evicted board leaders.** `sweepProofs` kept `won DESC, floor DESC, time_ticks ASC` — the DEEPEST ordering and only that — so FASTEST, KILLS and every band record holder lost their film while holding rank 1 | `CompetitiveStore.sweepProofs` | A UNION across all four `BOARD_KINDS` plus the six band boards, plus each account's last N |
| **A claim outranked its own proof.** `board()` partitioned per account without `state = 'verified' DESC`, so a crawler who submitted the same run twice (once before linking an identity) had the *unproven* row chosen as their representative and vanished from verified-only boards. Reproduced live | `CompetitiveStore.board` | Verified wins the partition as well as the ordering |
| **The one server-vouched score wore the forgery label.** A won RIVALS contract wrote to the retired JSON board, whose every response is stamped `UNSEALED · LEGACY — self-reported rows from before verification` | `gameServer` run-end edge | `CompetitiveStore.insertServerVouched` — a verified, era-stamped row with **no proof id**, so WATCH and RACE stay inert with a stated reason while the row is sealed, because the authoritative sim ran it |
| **A near miss was condemned forever.** `wouldRank` is a snapshot of a board that moves, and only SHED jobs were ever re-queued | `reconsiderRankRefused` | A rank refusal keeps its film (inside the account's own last-N retention) and is re-offered when the rows above it move |

And on the screen the player actually reads, §6's own rules applied to §6:

- **The daily had two doors and the front one was silently unranked.** The
  menu's gold headline tile resolved `dailySeed(day)` — the *same seed as the
  server's daily contract* — with no ticket, so the most prominent button in
  the product played today's contract dungeon while the ladder line printed
  "free seed: contract points come from contracts". Both doors sign now
  (`enterDailyContract`), R on a daily signs again, and the two cases that
  genuinely cannot sign (a challenge link to a closed day, an unreachable
  server) name themselves instead of being flattened into "free seed".
- **§6.2's "A STATE THE VERIFIER WOULD REJECT NEVER WEARS LADDER FURNITURE"
  was implemented for test-chamber starts only.** A REFUSED run showed the
  ladder plate, "this run still holds its board row and its splits", and
  `NEW PB — DEEPEST FLOOR 1` in gold around the refusal block. A rejection now
  replaces the plate, suppresses every PB, and rolls the local band ledger back
  to where the run found it.
- **The seal's weight only knew about the daily.** `GET /runs/:id` returns
  `boards[]` — the board keys the row occupies — so a free-seed run at rank 1
  all-time stops being told "It ranks nowhere, and it is still true".
- **SEALED meant two things ninety pixels apart.** The pre-submit kicker is
  `NOTHING HAS LEFT THIS MACHINE`; SEALED is spent only on certification.
- The default state gained **THE MARK** (one permanent row of the sealed
  leader, §6 Beat 2 without the held TAB) and **the banked ledger** (every run
  ticks an episode; none of it is a ladder claim, so it costs the spine
  nothing). The explanation and navigation layer moved from 3.51:1 to
  ≥5.26:1 at ≥10.5px. The panel went from 930×650 at (335,125) — 37% of a
  1600×900 screen — to 74%. The docked consent card is measured rather than
  guessed (`--consent-h`), so the grade medal stops being clipped by the
  viewport edge on the one run per browser where it appears.

### ELEVATION ROUND 3 — the spine stops contradicting itself

Round 2 closed the gap between the document and the code. Round 3 closed the gap
between **what one surface says and what the next one shows**, and shut two
exploits that were measured, not reasoned about.

**Two rulesets were reaching a board that presents as verified.**

| Hole | Where it was | What it is now |
|---|---|---|
| **An unverified RULESET certified.** `validateProofShape` checks version, hash, seed, ticks, dt, startKind, actions and claim, and never looked at `header.mode` or `header.runKind` — while `ReplaySession` builds the world straight from them (`createGame(seed, mode, runKind)`). Measured: the shipped bot on seed 2024, recorded twice with a 40k-step cap and run through the real `verifyArtifact({requireFreshStart:true})` — **race** → dead on floor 5, 115 kills, 21,038 ticks; **roam** → floor 16, 171 kills, 35,224 ticks, ultimate `injunction`, and the verdict came back **`ok: true`**. Roam floors have no boss gate and a flat 30-minute budget instead of `floorTimeBudget`, so the same policy walks ~4x as far: DEEPEST takes a gold-sealed floor-16 roam row, KILLS is owned outright, and every band board — the boards §3.3 calls the most winnable — falls at ~2x pace. The client refusal existed and was POLITE only (`recBlocked = "ROAM has no clock and no board"`), exactly the pattern §2.5 step 2 says it made structural for test starts | `verifyWorker.rulesetRefusal` | One gate, applied at the door (`competitiveApi.submit`, beside the `startKind` check) **and** inside the worker before `ReplaySession` is constructed, so a hand-rolled artifact never builds a roam world. `runs.run_kind` stores which game was played, and `publicRun` carries `mode` + `runKind`, so an existing certified row can be audited and labelled |
| **A competitive dimension the verifier never checks was printed inside the seal's frame.** `partySize` was read straight off the query string (`Number(q.get("size") ?? 1)`), stored, returned on the wire, and printed on a SEALED board row as `party of N`. Nothing in `ReplaySession.summary()` or `VerifiedFacts` derives or contradicts it, `certify()` never touches the column — and it is a **board axis**: `board({partySize})` filters `party_size = ?` and `splitEntrants("party_size", …)` counts toward opening the co-op split boards §7.4 defines. Worse than merely unverified: MUST-3 does not record party runs at all, so every `party of N>1` on a proof-verified row was necessarily fabricated. `POST /runs?token=…&size=6` put a solo run on the 5-6 board with the gold seal | `competitiveApi.submit` | A proof attests to ONE crawler's inputs, so a proof-verified row is `partySize: 1`, full stop. The `size` param is gone from the client and ignored by the server. Party rows come only from `insertServerVouched`, where the authoritative sim counted the seats itself, and the row says `counted by the server` |

**Three places the product was telling the player something untrue.**

- **The seal named boards that were empty when you clicked through.** `holdsBoards`
  answers with SCOPED keys (`deepest@daily-2026-08-02`), `boardsPhrase` stripped
  the scope with `b.split("@")[0]`, and — the actual bug underneath —
  `BoardQuery.eventId === null` meant `event_id IS NULL`, which
  `GET /boards/:kind` passed for every request with no `event` param. **Every
  event run was excluded from every all-time board by construction**, so the
  verdict said "it holds a position on DEEPEST, KILLS" while both boards
  answered `entries: 0` and THE STANDINGS printed "this museum is empty". The
  scope is now three-state (`undefined` = the museum, `null` = free seeds only,
  a string = that event), `holdsBoards` reports both scopes, and `boardLabel`
  prints `DEEPEST — TODAY'S CONTRACT` / `DEEPEST — ALL-TIME`.
- **A rivals row claimed a film that never existed.** `insertServerVouched`
  writes `proofId = null` (nobody records a party run) and `playability()` fell
  through to *"the proof has aged out of retention"* — a deliberate false
  statement, in the product whose pitch is that it does not make them.
  `publicRun` now carries `film: "retained" | "expired" | "never"` (retention
  never clears `proof_id`, so a null id means the film never existed), and the
  refusal reads *THE SERVER RAN THIS ONE ITSELF*. The winner also finally sees
  it: `renderSeal` opened with `if (net) { display = "none" }`, so the one
  genuinely server-authoritative score in the product was the one the player was
  never shown earning. There is a `vouched` verdict state for it now.
- **`rejected` was returned for resource and infrastructure failures, and then
  punished.** The wall-clock ceiling, a replay throw, a worker crash, a closed
  executor and a failed spawn all answered `rejected` — the state reserved for
  *the claim was false* — which prints THE SYSTEM DISAGREES WITH YOU and sets a
  10-minute account cooldown. §2.6d says a capability failure is `unverifiable`,
  never `rejected`. All six are `unverifiable` now. **And the boundary is stated
  instead of discovered**: `maxCertifiableTicks(budget, ceiling, usPerTick)`
  turns the duty cycle into a number of sim-minutes, the submit path refuses past
  it *before* the clock is spent, and the reason names the limit. `spent()` is
  wall clock including the duty sleeps, so a 120 s ceiling at 250 ms/s buys
  ~30 s of CPU — there was a run length past which this ladder called honest
  players cheats, and nothing stated it.

**FORGET ME regressed, and re-opened the exact gap §1.2 calls live.**
`importLegacyBoard` copies every legacy row into the competitive store keyed
`accountId = "legacy:" + name` and runs unconditionally at boot;
`deleteAccount` only ever matched `account_id`, and the name cascade reached
only the JSON file. So after a FORGET ME the JSON row went and **the SQLite copy
of the same crawler survived forever, publicly, in the UNPROVEN shelf on THE
STANDINGS**. `CompetitiveStore.deleteByDisplayNames` closes it, wired into
`onAccountDeleted` beside `leaderboard.forgetNames`, matching
case-insensitively on both the legacy key and the snapshotted display name.

**And on the screen the player reads more than any other:**

- **The rejection prints numbers, not a debug token.** `verifyWorker` concatenated
  `diffClaim`'s bare identifiers, so the highest-stakes negative moment in the
  product read *"claim disagrees with the replay: status"*. The verifier holds
  both sides at that moment; `describeClaimDiff` says *"you claimed 42 kills; the
  replay counted 39"*. It lives on the server, so no era was spent to fix it.
- **The default player can act on the demand.** A fresh anonymous token signing
  the daily got `scoresCp: true` at the door and, at the exit, *"LINK AN
  IDENTITY"* — a string that existed **only** as a server refusal, with no
  button, link or OAuth affordance anywhere on the screen. `POST /events/:id/start`
  answers `linked` now (so the door stops overselling), the submit outcome
  carries a typed `needsIdentity`, and the seal renders a 195x36 button beside
  the sentence. Measured: `scoresCp: false` at entry, `linkButtonExists: true`
  at the verdict.
- **The career panel stopped calling refused runs sealed.** The WHERE YOU DIE
  histogram was labelled `${serverN} sealed runs` off `profile.deathsByFloor`,
  built from ALL runs, while `seals` on the same response counts verified ones —
  live, the chart read "4 sealed runs" and THE SEALED RECORD 300px below read
  SEALS 0, because all four were REFUSED. The profile returns
  `sealedDeathsByFloor` and `refused`; the chart draws certified rows only and
  names what it left out.
- **The verifier-derived detail is rendered.** Splits, the full build (gear with
  rarities, ability ranks, glyph sockets), the named death and the four derived
  numbers were all on the wire and discarded at render. Every sealed board row
  has a DETAIL panel, and it says the crawler asserted none of it.
- Plus: a `#TAG` discriminator on every row (two crawlers named "Carl" sat one
  row apart with nothing between them), the grade's basis in a plate at 13px in
  `--ink` instead of 168px of 11px `--ink-faint` wrapping three ways, FINAL STATS
  deleted from behind TAB (it duplicated the scoreboard's own YOU column) and
  SEASON RATINGS relabelled to the run it was actually showing, one clock built
  from one tick count (the headline said 2:05 and the board row said 2:06), the
  win state given its own plate/medal/exit-block/CTA treatment, WATCH freed from
  the dismiss button, split boards collapsing into UNCLAIMED SPLITS instead of
  six empty headers, THE OTHER MUSEUMS filling the 42% of viewport the ALL-TIME
  tab left as black, and the explanation layer cut from ~90-word essays to one
  line per surface (measured: 4-20% of the body by area).

**Tests this round added, at the boundary that broke:** `grep -n
'roam|runKind|partySize' test/competitive.test.ts` returned nothing before it.
There are now cases for the roam header refused at the door AND in the worker,
`run_kind`/`mode` stored on a certified row, `POST /runs?size=6` landing as
`partySize: 1`, a capability failure returning `unverifiable` with the ceiling
in sim-minutes, an over-long run refused at the door, a sealed contract run
appearing on the all-time board its seal names, and a legacy row deleted by name.

### SHOULD

- **WATCH.** The word is no longer spent on dismiss, but there is still no
  in-browser replay on the verdict: `RUN IT BACK` races your own ghost, and that
  is the closest the screen gets to "the server re-executed this, here it is".
  §8.2's REPLAY (the ghost worker with a camera attached — seek = index into the
  precomputed track) is the missing piece, and it needs a camera target the
  renderer does not currently expose.
- **Ghosts** (§4.1). The sim seam is already done by MUST-1; this is a worker that
  precomputes the ghost track, one translucent render pass, and the era gate.
- **Season CP, tiers, placement** (§3.2C) and the **profile** (§5.2).
- **Per-band and per-archetype boards** (§3.3-3.4) — the splits fall out of the
  verifier for free, so this is board rows and UI only.
- **Weekly contract**; **rival contracts** (§4.2).
- **`src/sim-eras/` build step** (§2.6b), server and client chunks together. Until
  it ships, the executable window is one era: a deploy during a live event freezes
  that event (§2.6e), and every older proof is refused by the client gate rather
  than silently desynced (§2.6f). That is an acceptable interim precisely because
  the gate ships with MUST-1, not with the eras.
- **Name snapshotting + FORGET ME cascade** — do these *with* MUST-4, not after:
  the gap is live today.

### LATER

- Live spectate (replay covers the need first, at zero server cost).
- Follows / rivals lists, build pages.
- Scripted-play heuristics, as review flags only.
- `fly scale vm performance-1x` — only if verification backlog actually demands it
  (DEPLOY.md runbook). Never `fly scale count 2`.

### Tests this work needs

- **`test/replay.test.ts`** — codec round-trip; record -> replay byte-equality of
  `serialize(state)` across the balance seeds and depths (port
  `tools/replaymeasure.ts`); rules-hash staleness; an **artifact-size ceiling** as
  a regression guard, so a future sim change that makes intents unrepresentable
  fails loudly instead of silently breaking verification; **the hash projection
  itself** — editing a comment or a type annotation in `src/sim/` does NOT move
  `RULES_HASH`, editing a `CONFIG` number DOES, and touching `bot.ts` or a `tips.ts`
  string does not while adding a tip KEY does (§2.6a); and **the client era gate** —
  loading a proof with an unknown `rulesHash` throws a typed error rather than
  running (§2.6f).
- **`test/determinism-portability.test.ts`** — the `dmath` golden fixture.
- **`test/server.test.ts`** additions — submit -> `claimed` -> `verified`; a
  tampered claim is `rejected`; a wrong seed on an event is `rejected`; a stale
  rules hash is `unverifiable`, **not** `rejected`; the per-account rate limit;
  an unsigned or forged anonymous token is refused (§2.7.2); an event entry with
  no ticket earns no CP; a second attempt updates the board row and does **not**
  move CP (§3.2C); a submission from an account with no linked identity is stored
  `claimed` and never queued; over-budget verify-CPU sheds to `claimed` rather
  than closing the board (§2.4 rule 4); a private run ranks but 404s on
  `/runs/:id` for a non-owner (§8.1).
- **`test/persistence.test.ts`** addition — FORGET ME erases proofs, board rows,
  CP, mastery and follows.
- The existing 718 tests stay green, and the `src/sim/` purity guard gets
  *stricter*, not looser.

### The single-machine reality, restated

Nothing above needs a second machine. Verification is a worker thread with an
explicit CPU budget and explicit backpressure; ghosts and replays run entirely on
the client; boards, proofs and CP are SQLite rows on the volume Litestream already
replicates; matchmaking is a sorted array and a nightly job. The one place this
design will ever feel the box is verification CPU — and that has a budget, a
degradation behaviour that protects live play, and an escalation lever that scales
*up*, never *out*.

---

## Appendix — the measurement tools

Three throwaway-but-keep-them tools back every number in this document. All are
outside `tsconfig.json`'s `include`, so they never affect `npm run typecheck`.

| Tool | What it answers |
|---|---|
| `tools/replaymeasure.ts` | Record + replay a bot run; artifact size in five encodings, replay CPU, and byte-exact verification of the round trip. `npx tsx tools/replaymeasure.ts [seeds] [floors]`; `GEARED=22 GEARFLOOR=13` starts from a stage-representative crawler so the bot reaches the deep floors |
| `tools/enginedeterminism.ts` | Runs the same 4,000 sim steps in Node and in Chromium / Firefox / WebKit (against the dev server) and diffs the serialized world. Needs `npx playwright install firefox webkit` |
| `tools/mathdivergence.ts` | Per-primitive divergence rate between Node and each browser engine over 20,000 inputs — the table in §2.1 |

Re-run all three after any change to `src/sim/`, and especially after MUST-0:
`enginedeterminism` must report IDENTICAL on every engine before the verification
spine can be trusted.
