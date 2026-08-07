# THE MIX — verification report

**Branch** `the-mix` (from the integrated `try-it`, so this is measured on
exactly what the owner played). **Commits** `ae5c47f` (audio) + `bc06339` (UI)
+ this pass. **Verified** 2026-08-07 against the SHIPPING build: `npm run build`
→ `STATIC_DIR=dist PORT=5291 npx tsx src/server/gameServer.ts`, `/iso.html` 200.

**The one sentence that matters: every number in this document is a count, an
overlap, an occupancy share or one headroom reading. Nobody in the build loop
can hear. Whether the game now SOUNDS right is not established here and cannot
be — see §6.**

---

## 1. The two verdicts, verbatim

Both were given 2026-08-07, after the owner played the integrated build.

> **"The sound effects for kills is way too much I think... there needs to be a
> masking layer which prioritizes certain sounds over others."**

> **"Same with in late levels notifications... they're a total mess!"**

The census that followed found these are **one defect in two channels**: nothing
was individually loud or individually wrong, there were simply twenty of
everything, and in both channels the thing that got thrown away was chosen by
arrival order rather than by importance.

---

## 2. What shipped

| | audio | notifications |
|---|---|---|
| new file | `src/audio/mix.ts` (349 lines) | `src/ui/notify.ts` (403 lines) |
| shape | priority-aware sink in front of `AudioEngine` | DOM-free policy layer; `main3d.ts` executes the ops it returns |
| callers | all 35 `play()` sites in `src/audio/director.ts` | `main3d.ts`'s announcement router |
| guard | `test/audioMask.test.ts` | `test/notify.test.ts` (19 cases) |

`src/sim/` is **unmodified**. Everything both layers needed was already on the
wire — `state.hits` carries `kind` + `killed`, `state.announcements` carry
`kind` + `priority`. Prioritisation stayed a host/presentation concern, which
is where the hard rule says it belongs.

---

## 3. The priority tiers, and why each one is where it is

### 3.1 Audio (`src/audio/mix.ts`)

Rank, highest first. Ceilings are "admit only while fewer than N voices are
already sounding"; self-overlap is "at most N copies of one id at once".

| tier | members | ceiling | self | why here |
|---|---|---|---|---|
| **5 critical** | `player_hurt`, `death`, `victory`, `warning`, `count_go` | ∞ | 1 | Your own body and the run's ending. Never refused. It measured **38.9% silenced and 81.9% buried** at f15 pack — the game was hiding the one cue that says *you are dying*. |
| **4 telegraph** | `tell`, `boss_intro/phase/punish/down`, `ident_high`, `verdict` | ∞ | 2 | What you must REACT to. The blind guard's single most-eaten cue was `tell` (**290 of 420** attempts at f17). A telegraph you cannot hear is not a telegraph. |
| **3 progression** | `level_up`, `achievement`, `lootbox`, `sponsor`, `band_sting`, `descend`, `crowd`, `ident`, doors, draft/ledger | 15 | 1 | The Show and the ladder. Rewards must land, but they are not survival, so they yield to a wall of telegraphs. `level_up` measured **90% buried on floor 3**. |
| **2 act** | casts, `kill`, `gold`, pickups | 13 | 1 | What you DID. `kill` sits above `hit` because a death is more information than a blow. |
| **1 impact** | `hit`, `crit`, `swing` | 11 | 2 | The blow. Individually cheap, collectively the second-largest contributor. |
| **0 chatter** | barks, DoT ticks, `weapon_flash`, `chain_line` | 6 | 2 | Texture. Measured as the **largest single contributor** (29–35% of the budget; the captured 48-voice peak contained twenty barks). Texture is exactly what should drop out first when the room is full. |

Tiers 4–5 are additionally **forced past the engine's blind FIFO guard**, so the
director becomes their rate limit — the pattern the boss beats already used.
A **220ms focus window** opens behind any critical cue or headline, refusing
chatter and halving the impact/act ceilings. That is the ducking, expressed as
*admission* rather than *gain*, so SOUNDPLAN §2.3's "at most ONE duck source"
is untouched and `level_up` stays off the announcer bus as §1.3a requires.

**Not one gain moved.** A lone kill is byte-identical to what shipped. The
owner named density; "turn the kill down" would break one kill to fix twenty.

### 3.2 Notifications (`src/ui/notify.ts`)

| rank | kinds | why here |
|---|---|---|
| **3 boss** | the fight's own news | It is news about the thing filling the screen. |
| **2 progress / achievement** | level, achievements | Earned, and rare. |
| **1 loot** | drops | Useful, repeatable. |
| **0 show / flavor** | crowd, combo counters | **43 of 67 toast lines/min at f13 were one sentence.** The channel was spending its screen-time on a counter. |

`NOTIF_RANK` is an **exhaustive** `Record<AnnouncementKind, number>`, so a new
kind cannot be added without ranking it — tsc enforces it.

Then, in order: **climax lock** (while a boss bar is up / a death beat plays /
a descent happens, lower ranks are HELD; DEATH is a hard cut that clears the
glass) → **coalesce** (one shape, numbers collapsed to `#`, becomes one line
with a running `×N`) → **cap 3 + graceful overflow** (a single `+N more` chip,
never a growing column, never a scrolling log) → **one sentence, one surface**
(a banner claims its shape, so the ticker cannot print what the banner shows).

Knobs: `NOTIF_DEFAULTS` = max 3, gapMs 700, queueMax 6, staleMs 12000,
maxLifeMs 7100; `CLIMAX_YIELD_MS` 1200; in main3d.ts `BOSS_LINGER_MS` 1500,
`DEATH_BEAT_MS` 7000.

---

## 4. Measured, before → after

One instrument for both channels: **`tools/_mixbrowser.mjs`**, the census's own
browser probe, run unchanged against the shipping build (headed, d3d11,
30s per staged scenario). BEFORE = `tools/_shots/mix/` (the census at `b0e1d52`).
AFTER = `tools/_shots/mixverify/` (this pass). Analysis:
`tools/_mixbstat.mjs`, `tools/_notifdiff.mjs`.

**Read the ratios, not the wall rates** — measured sim dilation was 0.35–0.96
and differs run to run. Rates are per SIM second/minute for that reason.

### 4.1 Audio

| scenario | voices/sim-s | peak concurrent | discarded by the blind guard | self-overlap | bark share | cues per kill (±300ms) | **peakPre** | peakPost |
|---|---|---|---|---|---|---|---|---|
| f03_pack | 15.9 → **9.9** | 22 → **10** | 53.0% → **0.0%** | 62.9% → **36.8%** | 7.9% → 0.7% | 12.0 → **5.3** | 0.880 → **0.664** | 0.780 → 0.669 |
| f13_pack | 33.1 → **11.0** | 39 → **10** | 60.3% → **0.0%** | 35.7% → **16.9%** | 40.0% → 1.7% | 12.8 → **5.2** | 0.875 → **0.789** | 0.783 → 0.722 |
| f15_pack | 47.8 → **13.9** | 48 → **10** | 51.0% → **0.0%** | 44.0% → **19.1%** | 41.4% → 0.9% | 16.8 → **3.9** | **1.003 → 0.983** | 0.808 → 0.815 |
| f17_pack | 60.2 → **15.4** | 36 → **11** | 59.3% → **0.0%** | 32.6% → **19.3%** | 38.9% → 5.0% | 15.7 → **4.7** | 0.925 → **0.665** | 0.812 → 0.719 |
| f15_elite | 10.4 → **7.2** | 12 → **7** | 12.2% → **0.0%** | 46.8% → **23.2%** | 4.6% → 2.9% | — | 0.785 → **0.640** | 0.739 → 0.651 |
| f15_boss | 27.7 → **12.7** | 36 → **10** | 32.8% → **0.0%** | 43.1% → **24.6%** | 11.7% → 1.6% | 10.4 → **3.7** | **1.146 → 0.874** | 0.837 → 0.759 |

Three readings.

**(a) The floor-number spread has collapsed.** Peak concurrency is 7–11 in every
scenario, floor 3 through floor 17, against 12–48 before. The mix no longer
runs away with the monster count — which is the whole claim.

**(b) The blind guard now discards NOTHING.** 0.0% throttled everywhere. The
two-thirds of the mix that used to be thrown away at random is now thrown away
on purpose, and the telegraph is on the surviving side of that choice.

**(c) The §2.2 headroom contract holds again.** `peakPre` (compressor INPUT) is
under full scale in every scenario, including the floor-15 boss that measured
**1.146**. *Caveat stated plainly:* f15_pack came in at **0.983** — inside the
contract, but only just, and this is one run. It is the row to re-measure first
if anything is added to the late-floor mix.

**The honest cost, and it is large.** Creature barks fall from 39–41% of the
voice budget at pack density to **0.9–5.0%**. That was the deliberate target
(they were the largest single contributor) but it is a real change of texture
at exactly the moment sixteen monsters are on screen. **If the room sounds
dead, this is the number that says why**, and the knobs are `CEILING[0]` in
`src/audio/mix.ts` (currently 6) and `MAX_BARK_CUES` in `director.ts`
(currently 3). Raising the chatter ceiling to 8 previously measured bark share
back to 3–14% for ~0.4 voices/s.

### 4.2 Notifications

`bossWithChatter` = a boss bar up with an unrelated **toast or teaching card**
live. `bossWithUnrelated` additionally counts the `#headline` banner, which is
its own exclusive one-at-a-time zone and is **deliberately not held** (see §6).

| scenario | lines/sim-min | toast lines/sim-min | max on screen at once | ≥3 elements | boss bar + unrelated **chatter** | boss bar + 3 or more | biggest repeated sentence's share |
|---|---|---|---|---|---|---|---|
| f03_pack | 86.6 → **38.6** | 74.8 → **30.0** | 10 → **3** | 29.8% → 26.0% | 30.3% → **0.0%** | 34.6% → 34.6% | 10.5% → 14.3% |
| f13_pack | 163.3 → **36.1** | 150.7 → **28.9** | 9 → **4** | 76.9% → **27.2%** | 97.1% → **0.0%** | 92.1% → **0.0%** | 72.2% → **12.5%** |
| f15_pack | 177.6 → **30.4** | 169.5 → **26.6** | 10 → **3** | 70.1% → **12.0%** | 97.5% → **0.0%** | 79.3% → **12.9%** | 64.3% → **28.6%** |
| f17_pack | 181.5 → **44.7** | 159.7 → **27.9** | 8 → **5** | 60.7% → **22.5%** | 100.0% → **0.0%** | 39.8% → **0.0%** | 68.2% → **20.0%** |
| f15_elite *(quiet control)* | 13.1 → 12.3 | 10.9 → 10.2 | 3 → 3 | 2.8% → 2.7% | — | — | 40.0% → 40.0% |
| f15_boss | 59.8 → **26.2** | 49.8 → **20.4** | 9 → **3** | 18.9% → **1.2%** | 63.9% → **0.0%** | 22.0% → **1.3%** | 13.3% → 28.6% |
| staged boss capture | 74.7 → **28.2** | 61.1 → **21.1** | 7 → **2** | 69.5% → **0.0%** | 99.7% → **0.0%** | 92.9% → **0.0%** | — |
| staged death capture | 20.1 → **12.2** | 10.0 → **0.0** | 2 → 2 | 0.0% → 0.0% | — | — | — |

Three readings.

**(a) `TOAST_MAX = 3` is now true of the product.** Measured max 3 in five of
six scenarios; the two frames that read 4 and 5 are 3 toasts + the `+N more`
chip + a banner or a teaching card, which is the honest declared ceiling of 6.
Before, the declared cap of 3 measured **up to TEN** — `showToast()`'s eviction
path took `firstElementChild` and deleted it 350ms later *without marking it*,
so every toast arriving inside that fade re-evicted the same dying node. Fixed.

**(b) The climax lock does what gap #7 asked for.** Unrelated toasts/cards over
a live boss bar: **0.0% in every scenario**, from 30–100%. In the staged boss
capture it went 99.7% → 0.0%.

**(c) The repeated sentence is gone as a channel-dominating force.** "N-KILL
COMBO by Carl!" was 64–72% of the toast channel at f13/f15/f17; the largest
single shape is now 12.5–28.6%, and where it survives it survives as **one line
with a `×N` counter** (photographed — §5).

**The instant of death**: 12.2 toasts/sim-min → **0**. The `+N more` chip was
torn down 10ms *before* the first dead frame; the death moment now carries the
PARTY WIPE banner and nothing else.

---

## 5. Frames I read myself

A filmstrip instrument (`tools/_mixfilm.mjs`, new) shoots contiguous frames
through the two moments the round exists to protect, each paired with the exact
DOM composition at the shutter. A stack-triggered snapshot answers "how bad does
it get"; a strip answers "is the screen legible *through* the event", including
the frames either side of the peak — which is where a cap that merely DEFERS the
pile would show it arriving late. It does not.

All in `tools/_shots/mixfilm/`.

**`wipe_07.png` — the mass death.** Twenty monsters died between this frame and
the one before it (kills 2 → 22). On the glass: the boss plate, and nothing
else. Zero toasts, zero cards. Damage numbers and the corpse pile read cleanly.
This is the exact instant that earned the verdict.

**`wipe_09.png` — the busiest frame in either strip.** Boss plate reading
`EXPOSED — UNLOAD`, the centre call-out `UNLOAD / EXPOSED CORE` **alone on its
pixels**, and two toasts, both about this fight. The census photographed this
same moment with the call-out painted straight *through* the `#headline`
banner's text — two System sentences on the same pixels, both unreadable. That
collision is closed (`body.bosscall` stands the banner down) and I can read
every word.

**`boss_02.png` — the plate's arrival.** `body` goes `cine` → `bossplate`; the
plate lands with exactly one toast, the fight's own `COMPLIANCE LATTICE ONLINE`.
The two unrelated toasts live one frame earlier (`boss_00`: an achievement line
and a crowd line) are gone by `boss_01` — that is `CLIMAX_YIELD_MS` shortening
them to a glance rather than yanking them, visible in consecutive frames.

**`boss_00.png` — the RINGSIDE INTRODUCTION.** Letterboxed, alone, clean.

**`boss_08.png` — the deliberate exception.** A high-priority System banner
("The System has GRANTED Carl a stay") sits *below* the boss plate in its
stood-down position. No collision; both readable. This is the one thing the lock
lets through, on purpose (§6).

### Is the boss bar clear?

**Yes.** Across ten boss-strip frames the plate is never overlapped by anything.
The status chips (`PSN×2 4s`, `CHILL 3s`, `BURN 3s`), the three-segment health
bar, the phase pips and the beat name inside the plate all read at a glance.

### Two cosmetic collisions I found, which are NOT the reported defect

At the worst frame the metric run captured (`tools/_shots/mixverify/f17_pack_stack5_2.png`,
5 elements, no boss up — magnified to `tools/_shots/mixfilm/crop_toastcol.png`):

1. **The `+N more` chip is crowded by the newest toast.** The chip renders
   directly above the column and the top toast's box overlaps its lower half —
   `+1 MORE` reads as `+? MORE`. Cosmetic, new furniture, one spacing rule.
2. **The item-pickup tooltip paints through the third toast.** `Glass Charm
   TRINKET` sits on the same pixels as the column's lowest slot; the words
   "CHANTING CARL. Frenzy," are unreadable behind it. This is the same *class*
   of zone collision this round closed for the boss call-out, between two
   surfaces neither round owned.

Neither is what the owner complained about, and neither occurs during a climax
(the lock empties the column). Recorded rather than fixed to keep the merge
surface with the tutorial stream clean.

### Two content bugs, confirmed still live, in territory this round does not own

3. **Mordecai's header renders TWICE** — the persistent nameplate strip and the
   teaching card's own header are identical portraits + `MORDECAI / THE GUIDE`,
   stacked. Magnified proof: `tools/_shots/mixfilm/crop_mordecai.png`. The
   tutorial surface belongs to the sibling stream.
4. **Double-encoded em dashes still render as `â€"`** — 338 lines across
   `src/sim/ai.ts` and `src/sim/config.ts`. Legible in the Live Feed of
   `wipe_09.png` ("A cleric CONSECRATES the ground â€" it heals them…").
   `src/sim` is read-only to this round.

---

## 6. What I could NOT verify

**Everything about whether it SOUNDS good.** I cannot hear. There is no
instrument in this repo, or available to me, that can tell you a mix is
pleasant. Specifically unestablished:

- **Whether the density now feels right, or merely measures right.** Every audio
  figure in §4.1 is a count of clip starts, an overlap of durations, or one
  amplitude reading off the compressor's analyser. Nine voices per second can
  be a good mix or a bad one; the instrument cannot tell the difference.
- **Whether the room went dead.** This is the single most likely failure and the
  measurement points straight at it: barks are down from ~40% of the voice
  budget to ~1% at pack density. Sixteen monsters may now sound like four.
- **Whether the multi-kill emphasis reads as a REWARD or as a SWALLOWED KILL.**
  Three or more kills inside 260ms now fire as one emphatic cue (the same clip
  at rate 0.86 plus the crowd) instead of N layered kills. That is either
  "the game punctuated my wipe" or "the game ate my kills". Only an ear decides.
- **Whether any individual clip is good.** Untouched by this round, and SOUNDPLAN
  §1.3a still carries open verdicts on `dash`, `level_up`, the r3 SFX set and
  the `battle_winter` trim. None of them are cleared and this round clears none.
- **Whether the game now UNDER-informs.** The UI half I can see and did; but
  "is floor 17 too quiet now" is a feel judgement. Note `wipe_07`: a 20-kill
  wipe during a boss fight produces **zero text** on the glass. That is the
  policy working exactly as designed, and it may still be wrong.
- **Frame-rate honesty.** The probe ran at 0.35–0.96 sim dilation. Per-sim-second
  rates are the honest axis; per-frame occupancy shares are **floors**. At a true
  60fps the same events compress into less wall time and stack harder.
  The mixer's clock is SIM time, so it is slightly *more* permissive in a
  dilated browser than in the harness — the harness numbers are the strict ones.

---

## 7. What the owner should listen and look for

### Listen (floor 13+, pull a big pack, then fight a boss)

1. **Is the room too thin?** Sixteen monsters, all aggroed. Do you hear a crowd
   of creatures, or four creatures and your own weapon? → knob: `CEILING[0]` in
   `src/audio/mix.ts` (6) and `MAX_BARK_CUES` in `director.ts` (3).
2. **Does a big wipe still feel like a payoff?** Cleave five things at once.
   Does the multi-kill land as one satisfying punctuation, or does it feel like
   four kills went missing? → knobs: `KILL_GATE_MS` (260), `MULTI_KILL_GATE_MS` (620).
3. **Can you now hear the wind-up?** `tell` was silenced 62–69% of the time and
   is now never silenced. Is the telegraph audible *while* you are mid-fight —
   the only moment it matters?
4. **Is a single kill unchanged?** Kill one thing alone in a corridor. It should
   be *identical* to what you played. If it is not, the "no gain moved" rule
   has been broken somewhere and that is a bug, not a taste call.
5. **Does the level-up finally land?** It measured 90% buried on floor 3.

### Look

6. **During a boss fight** — is the plate ever competing? The only thing the lock
   deliberately lets through is a **high-priority `#headline` banner** (PARTY
   WIPE, AMBUSH, RULES VIOLATION). If that still buries the fight, the knob is
   one line in `NotifMix.offer`: route high-priority through the same rank floor
   instead of straight to `offerBanner`. **It was left alone on purpose** — that
   change would also silence PARTY WIPE at the death moment, which is the one
   line that moment should have.
7. **The `×N` counter.** "3-KILL COMBO by Carl! … **×4**" is four sentences
   collapsed into one. Does that read as informative, or as the game refusing to
   celebrate? → knob: `maxLifeMs` (7100).
8. **The `+N more` chip.** New furniture. If you would rather have nothing there,
   delete `renderToastOverflow` and the `.toast-more` CSS; the queue keeps
   working silently. (And see §5.1 — it needs a spacing fix regardless.)
9. **Is late-floor play now UNDER-informed?** → knobs: `gapMs` (700),
   `staleMs` (12000). These two decide how much of a burst ever reaches the glass.
10. **What coalescing costs.** Two genuinely different sentences that differ only
    by a number are now one line. "Descending to floor 2" and "…floor 3" would
    collapse if they arrived within one hold. The archive feed keeps both. This
    is the behaviour change most likely to surprise.

---

## 8. Reproducing this

```
npm run build
STATIC_DIR=dist PORT=5291 npx tsx src/server/gameServer.ts    # NOT vite preview
node tools/_mixbrowser.mjs --out tools/_shots/mixverify --seconds 30
node tools/_mixbstat.mjs  tools/_shots/mixverify
node tools/_notifdiff.mjs tools/_shots/mix tools/_shots/mixverify
node tools/_mixfilm.mjs   --out tools/_shots/mixfilm
node tools/_mixcrop.mjs IN.png OUT.png X Y W H SCALE   # magnify a frame to READ it
```

(`tools/_mixcrop.mjs`, not `tools/_crop.mjs` — the latter is the visual-AB
round's two-up comparator and is a different tool.)

`tools/_mixsim.ts` + `tools/_mixdiff.mjs` are the 1:1-clock sim harness behind
SOUNDPLAN §2.5's strict tables. Evidence dumps under `tools/_shots/` are
gitignored; the instruments are committed so the tables stay reproducible.

**Verdict of this pass: both channels are measurably fixed, the boss bar and the
death beat are legible in frames I read myself, and the quality of the result is
unverified and stays unverified until the owner listens.**
