# TUTORIAL — the first session, with Mordecai

Owner ask: "an initial tutorial of AAA quality to onboard players to the game
— thinking Mordecai as the game guide using the Roam NPC chat experience —
helping to introduce all of the key concepts."

**SHIPPED (r1 + r2 + r3 + r4 + r5 fix rounds, branch `tutorial`; r6 REBUILD —
ONE VOICE — on branch `tutorial-mordecai`).** The design sections that became
code are deleted (BACKLOG.md convention); what remains is the enduring canon
(the one-voice law, the register bible), the implementation map, and the open
edges for later rounds.

## r6-fix-1 — the harsh critic's round (branch `tutorial-mordecai`)

A critic scored the r6 build 4.5/10 off four cold browser passes. Every finding
below is fixed at the mechanism, not at the symptom; the two false positives
are named as false positives, with the evidence.

**Blockers (severity 5).**

1. **THE FIVE self-consumed without ever painting.** `Objectives.update` armed
   the step, latched every already-true fact and wrote `completed` in the SAME
   call — and obj.five's facts (strike/dash/cast) are RUN-CUMULATIVE, so any
   player who pressed a key during their first fight had all three true the
   instant obj.move finished. The step was born completed, the ledger spent it,
   and the only lesson that teaches the ability kit key by key was gone for
   that profile forever. **Two gates now** (`src/ui/objectives.ts`): the arming
   call returns `{started, checked: [], completed: null}` and reads no facts,
   and a step cannot complete until the host has reported `OBJ_MIN_VISIBLE_MS`
   (4s) of REAL card-on-glass time (`addVisibleMs`, fed by
   `objectivesPaintTick` once per rendered frame, gated on a live dungeon).
   Regression tests: `test/objectives.test.ts` "A STEP MUST PAINT BEFORE IT CAN
   COMPLETE". Verified in the app — a profile seeded at obj.five with all three
   facts true shows `The Five 2/3` on the card and does NOT hold `obj.five` on
   the ledger.
2. **The strip was deleted by the act of playing.** Dismiss-on-input ran off a
   1.2s GRACE, and browsers fire repeated keydown for a HELD key — so a player
   holding W (the state a player is in for most of floor 1) deleted every card
   1.2s after it appeared. The grace period WAS the card's lifetime: 128
   characters in 1.2s is 107 chars/sec. **`e.repeat` is now ignored outright**,
   a plain keydown only counts after a READ BUDGET derived from the line
   (~36 chars/sec, in VISIBLE time), and GOT IT / Enter still dismiss
   instantly. Measured in the app under continuous held-key input: card
   lifetime 6689ms (old build: ~1200ms).

**Majors (severity 4).**

3. **Lessons landed after the thing they teach.** Pacing gates are flood
   control and do nothing about staleness. `CardHooks.stillTrue` is a
   PRECONDITION re-asked at delivery time and at every stale sweep; a card
   whose lesson has been demonstrated is dropped UNSPENT. Wired to `start`
   (dropped once the crawler has walked), `dashkit` (once they have dashed),
   `ability` (once they have cast) and `lowhp` (once the leak closes).
4. **Three of four cold runs died on floor 1 and the tutorial went mute.**
   (a) Survival tools are no longer rewards for surviving: the dash left THE
   FIVE's gate and became a floor-1 PROMPT (`dashkit`) at T+10s, and
   `COACH_LOW_HP` moved 0.6 → 0.78 so the flask arrives before the pack rather
   than as a eulogy at 29/100. (b) `Coach.reteachPrompts()` re-arms the floor-1
   script (prompts only — confirmations were earned by acts) on each new run
   while the curriculum is still owed, capped at 3, which closes the seven
   minutes of mute replay the critic measured after a first death. (c) Pack
   size/aggro mercy is NOT done: it is a sim change and this round holds the
   no-sim-numbers rule. Left in "open edges" below.
5. **Double-tapping `2` at the campfire destroyed the curriculum.** Answering
   "What am I in for?" promoted the SKIP into the index "Let's go." had just
   vacated. Destructive choices now leave the number row entirely (`.dlg-skip`,
   unreachable by the digit handler, which selects `.dlg-choice` only), taking
   one only OPENS a confirmation whose safe answer is slot 1, and backing out
   restores the ORIGINAL list rather than striking itself off. It is also
   REVERSIBLE now: `forgetTips` + the K panel's "Mordecai's guidance — SHOW ME
   AGAIN" (two presses) clears the `tut.*`/`obj.*` keys and reloads.
6. **The first death dumped the whole competitive layer on a first-timer.**
   `#recap.novice` (no finished run in history, no season) defers the ladder
   line, the earned/PB block, the math drawer, SHARE/STANDINGS/WATCH THE ARENA
   and the HOLD TAB hint, and `offerProof` defers the consent card to the first
   verdict with a ledger behind it. Mordecai's aside MOVED to directly under
   the death headline. Nothing is deleted — only what the screen leads with.

**Minors (severity 3-2).** The safe room's `MORDECAI:` label became content
(`<b class="tipwho">`, gold, hidden with its row) instead of a `::before` that
outlived the sentence it labelled — and the guided path guaranteed that bug,
because the beat that clears the tip is the one obj.saferoom steers you into.
The objectives card now survives a modal (z 26, above #saferoom/#draft scrims,
still under #recap/#menu): the strip must not talk over a decision, but the
CHECKLIST is the ask the panel is an answer to. obj.saferoom's "Spend some
gold" carries an `alt` form ("Look over the shelf") that arms when
`cheapestShelfPrice() > gold` — the pass that arrived with 24 gold against a
35-gold shelf was being asked for something the economy had made impossible.
Coach lines name ONE device (`Coach.setControls` + `lastInputSource`), so
"Left click or Space" is gone from a keyboard session. Both advertised draft
routes call one `claimBankedDrafts()`, and OPEN now means open (a panel inside
`hideOverlay`'s 130ms closing window is CLOSED — that race is the likeliest
explanation for the un-reproduced V failure); `input.ts` also clears held keys
on `blur`, so a swallowed keyup can no longer dead-lock a panel bind. Board
skeletons render only for the in-flight state; every resolved-empty path shows
its copy alone.

**Two findings were probe artifacts, not bugs** — `#banner`'s eleven bindings
and the shrine's `BANK IT FOR LATER` were both read out of `textContent`.
`.topmenu` is `display: none` until `.tb.open`, and `.tp-x`/`.tp-done`/`.tp-seg`
are `display: none` outside touch (iso.html:6185, and the note above it says
so). `display:none` is out of the accessibility tree too, so neither is a
screen-reader trap. Shot 10 confirms: the top bar paints "SYSTEM" and
"CRAWLER", nothing else. **If a probe reads textContent, it is measuring the
DOM, not the glass** (HANDOFF §0).

Instrument: `tools/_tut_fix_r1.mjs` (one browser, port 5287). It measures card
LIFETIME rather than presence-at-an-instant, because under software GL a
"wait 12 iterations" loop is 12 seconds and kept catching the card's honest
7s auto-dismiss and calling it an input kill.

## r6 — the ONE VOICE rebuild (HANDOFF §3a), plumbing shipped

- `src/ui/onramp.ts` is DELETED; `src/ui/coach.ts` replaces it (same measured
  mechanics — prompt budget, live-label refusal, offer/commit/release — with
  Mordecai's instruction-first beats; `test/coach.test.ts` carries the ported
  behavior tests plus the inverted binding rule).
- `src/ui/objectives.ts` is the guided-step sequencer; main3d's
  `objectivesObserve` computes facts at both intent seams (solo + net) and the
  `#objectives` card renders the current step. Completion is FACT-spent
  (done-by-DOING — the one ledger write that sits under an act, not a paint;
  the paint rule below still governs every once-ever LINE).
- Enrollment: fresh crawlers get an `obj.enrolled` ledger key at first boot;
  profiles without it (veterans) never see the card or the coach — the
  grandfather clause with no seeding writes.
- The `#tutorial` card surface is re-skinned as MORDECAI'S STRIP (his plaque +
  portrait chip); the COURTESY ribbon and lead-in strip logic are gone. The
  queue/pacing/visibility machinery (r2–r5) is untouched.
- `showAnnouncement`'s tip branch now translates the four curriculum tipIds
  through `COACH_TIP_BEATS` and drops every other tip UNSPENT — no tip is
  ever printed in the System's register. Sim untouched; rulesHash unchanged.
- **CONTENT PASS shipped** (same branch, second commit) — the full first-session
  curriculum in Mordecai's voice:
  - **Five objective steps** (was four): GET MOVING → THE FIVE → PAYDAY →
    THE SAFE ROOM → **THE SHOW** (new closer: hype over the System's
    interference floor + one favorite converted, both sim-truth facts;
    favorites measure from the step's own start edge so an old fan cannot
    pre-check the lesson). THE SHOW is last on purpose: it is the game's
    identity, and by then the crawler is deep enough that hype actually flows.
  - **THE FIVE is key by key**: the step's three items are `{token}`-labelled
    (`{strike}`/`{dash}`/`{cast}`, plus `{hypeline}` on THE SHOW) and the host
    substitutes LIVE labels at render time (`objItemLabel` in main3d) — real
    binds on desktop, chips/gestures on touch, the slot that actually holds
    dash wherever the player benched it. `OBJ_LABEL_TOKENS` is the contract;
    a test fails any label whose token the host doesn't know.
  - **Facts are sim-truth now**: a dash is `p.dashTime` running (the old fact
    read `intent.dash`, a legacy bot flag no input host ever sets — the item
    was uncheckable by a human); a cast is a pressed slot that actually HOLDS
    a non-dash ability (a key mashed over a padlocked slot checks nothing).
  - **Depth beats (floor-2+ pacing)**: two new coach confirmations — `elite`
    (first named elite within 8 tiles: the affix lesson) and `boss` (first
    boss within 12: the telegraph lesson). Past floor 1 the prompts are
    silent and the floors teach themselves; Mordecai only footnotes the FIRST
    of each new thing the depth introduces. Unbudgeted, never a promise.
- The r6 acceptance probe (`tools/_tut_r6.mjs`, cold-profile, fails on any
  painted teaching line whose first sentence lacks its instruction/key) is
  still the follow-up round (`tools/_tut_r6_smoke.mjs` + the one-off
  `_tut_content_probe.mjs` cover boot/paint/label-substitution today). The
  old `_tut_r1..r5` batteries assert COURTESY-era behavior and are retired
  as instruments of record.

## The one rule this feature keeps relearning (r5 — read this first)

**A concept is taught when it PAINTS, not when something decides to teach
it.** Everything upstream of the glass — the sim's `tipsSeen` latch, the
Onramp's script, the Guide's sequencer, the announcement, the queue — is
intent. Only the paint is delivery, and only delivery may spend a once-EVER
opportunity.

r1–r3 wrote the ledger from the sim call and mirrored it out of `saveRun`, and
three cold runs measured the consequence: `favorites` and `achievementClaim`
were consumed, permanently ledgered, and **never once displayed** — the
concepts were not taught badly, they were deleted from that profile forever.
Every guard was green while it happened, because every guard asked the code
whether it had shown a card instead of asking the pixels.

r4 fixed that in ONE of the three channels and wrote the fix down as a law
("`recordTips` is called from exactly two places… Nowhere else"). The law was
false when it was written. A fresh critic found the same defect intact in the
other two, and this is the shape of it — the reason it takes a general rule and
not three patches:

| Channel | How r4 spent it early | Measured cost |
|---|---|---|
| Sim tips | (fixed in r4) | — |
| Mordecai (`src/ui/guide.ts`) | `maybeShowRecap` took B8 and wrote the ledger, then scheduled the 620ms reveal whose own first line stands down if a fast R started the next run | cold profile: `ledger=[tut.campfire,tut.runback]`, verdict frames 0, aside frames 0 — B8 deleted from the profile forever by one impatient keypress |
| THE ONRAMP (`src/ui/onramp.ts`) | its 11 lines carry NO `tipId`, so the ledger rule never applied to them at all; `Onramp.note()` marked the event fired at generation | cold profile: flask drunk inside the pacing gap, run ended, R pressed — both halves of the flask lesson gone for the session, neither card ever on the glass |

**So the rule is now structural, in all three modules: OFFER, then COMMIT or
RELEASE.** `Guide.take` and `Onramp.note` hand a beat/line out and mark it
*offered*; presentation calls `commit` when it paints (and `release` when it
does not — a full queue, an expired moment, a run boundary, a panel that
refused the beat). A released opportunity is owed again the next time the game
makes it true.

Three things follow, and they are binding on every future round:

1. **Every `recordTips` call site is a PAINT.** There are five, and each one
   is the line immediately after something reached the glass:
   `displayTutorialCard`, the ticker branch of `showAnnouncement` (a toast is
   a paint too), `guideShow`, the verdict aside's post-reveal rAF, and the
   skip path (an explicit refusal, which is a delivery of a different kind).
   If a sixth appears, it must sit under a paint or it is a bug.
   `saveRun` writes no ledger at all and additionally strips unshown ids from
   the run save, so a refresh-resume can re-teach what a crash swallowed.
2. **`Player.tipsSeen` is the sim's within-run latch and nothing more.** It
   exists to stop a rule re-announcing every step. It is not evidence that
   anybody learned anything. Neither is `Onramp.fired`, and neither is
   `Guide.seen`.
3. **A doc claim about delivery is a claim about pixels.** r4's "exactly two
   places" was checkable by grep and nobody grepped. Every binding sentence in
   this file now names the file and function it is true of.

## The one-paragraph design (canon — REWRITTEN by the r6 rebuild, HANDOFF §3a)

**ONE VOICE: Mordecai teaches everything; the System announces events.**
Owner, verbatim: *"the system courtesy explanations should entirely be
replaced by Mordecai's guidance"* — so COURTESY EXPLANATION is dead as a
teaching format, on every surface. Mordecai now has TWO surfaces: the LIVE
STRIP (the `#tutorial` card surface, non-pausing — `src/ui/coach.ts` lines,
curriculum tip translations, objective step lines) and the MODAL (`#dialogue`,
at rest — `src/ui/guide.ts` beats: campfire, draft, safe rooms, verdict,
check-in). A persistent OBJECTIVES card (`src/ui/objectives.ts` + right-rail
`#objectives`) gives the first session a guided go-do-x-y-z spine: five
sequential steps, 2–3 checkable items each, checked by real state observation
(sim-truth facts), completed steps ledgered forever (`obj.*` on `dcc:tips:v1`).
The sim's TIPS and `tipsSeen` are untouched — the host translates the four
curriculum tipIds into Mordecai's words and drops the rest unspent.

**The riddle fix is structural (owner: "Mordecai is some times talking in
riddles").** Every strip beat is data: `instruction` (EXACTLY one sentence,
imperative, contains the beat's verb and the live `{key}`) + `wry` (sentence
two, never the key). `test/coach.test.ts` enforces it mechanically, the same
way the old two-voice rule was enforced — including the INVERSION: curriculum
translations must NAME their mechanism (collapse→stairs/clock, draftBanked→
draft, hype→hype, glyph→glyph/socket). Coverage asserted where avoidance used
to be.

## One voice, two surfaces (canon — binding on every future line)

| | The System (SHOW) | Mordecai — STRIP | Mordecai — MODAL |
|---|---|---|---|
| Register | Dry bureaucratic menace; show-aware but bored (VOICE.md) | Instruction first, quip second; no exclamation marks | Gruff, economical, protective; judgement, not mechanics |
| Channel | `state.announcements` → banners / ticker / log (EVENTS only, never teaching) | `#tutorial` card surface (non-pausing) + `#objectives` card | `#dialogue` panel (pauses solo world) + B8 verdict aside |
| When | The instant an event happens | The instant a rule touches you | At rest — campfire, draft pause, safe room, verdict, check-in |
| Teaches | NOTHING (this is the rebuild's law) | Controls, mechanisms, the objective steps | Judgment + the meta: what to pick, what to spend, why the cameras pay |
| Skip | — | Any input / auto-dismiss; B0 skip silences all of it | ESC or the farewell choice — one input, always last in the list |

**Division-of-labor rule (rescoped)**: the STRIP owns mechanism; the MODAL
owns judgement. A modal beat may not restate a mechanism the strip (or the
sim tips' subject matter) already owns — `test/guide.test.ts`'s paraphrase
test still fails any MODAL line sharing three or more content words with any
sim tip, domain nouns deliberately NOT exempted. The fix is always the same:
the modal says the thing a mechanism line will never say. And B6 still
debriefs the Show only AFTER the System has demonstrated it — the
demonstrate-then-debrief order survived the rebuild.

**The System never points at your FURNITURE (r4, corrected r5).** It audits
ledgers, posts notices, and files explanations. It has never conceded that you
have a HUD, a badge, or a bottom of a screen, and it does not gloss keys in
parentheses like a manual. It may name a CONTROL — a key on desktop, a chip or
a half of the glass on touch, because on a phone the control IS a pixel and a
lesson that named a keyboard there would be a lie — and it may name a place in
the dungeon (a Safe Room's ACHIEVEMENTS tab). What it may not name is the
READOUT: the bar, the badge, the counter, the panel you watch. Controls are
the crawler's own equipment; readouts are the audience's.

(r4 wrote this rule as "it may not name a pixel", which the shipped touch
script and `test/onramp.test.ts` had contradicted since r1 — the touch lines
name the STRIKE chip and the ☰ menu by design. The rule was right; the sentence
was wrong.)

**Register bible** (for every future Mordecai line): short declaratives; wry,
never breathless; protective under the gruffness ("I hate it too. It
works."); concrete verbs over adjectives; no exclamation marks; no corporate
cheer; he says "you" and means the person, where the System says "Crawler"
and means the inventory item. `test/guide.test.ts` holds the voice line
mechanically (no COURTESY EXPLANATION, no exclamation marks, no TIPS text on
the dialogue surface).

## Implementation map (r1)

- **`src/ui/guide.ts`** — the beat table as DATA + the `Guide` sequencer
  (Onramp mold: facts in, at most one never-before-seen beat out). Beats:
  `tut.campfire` (B0, casting stage, organic fresh crawlers only),
  `tut.draft` (B3, first level-up claim — Mordecai before the draft UI),
  `tut.saferoom`/`tut.glyphs`/`tut.show` (B5/B7/B6 — at most one per
  safe-room visit, priority-ordered, so "second-or-later safe room" is
  structural. r4 put B7 ahead of B6: B7 needs a socket, a safe room and a
  glyph in hand simultaneously — a conjunction three cold runs never once
  assembled — while B6 is eligible at every later visit for the rest of the
  run. The scarce beat gets the scarce opportunity), `tut.runback` (B8, verdict aside plate — solo DEATHS only; a
  win gates it out without consuming it, r2), `tut.menu2` (B9, second organic
  check-in with ≥1 finished run, shown a 1.6s beat after the menu paints and
  standing down if the player has already moved on, r2). `tut.skipAll` is the
  global skip and it silences BOTH voices for real (r2): every beat ledgered,
  the remaining onramp lines dropped, AND every future first-contact COURTESY
  card suppressed at presentation — the sim still marks `tipsSeen`
  (shown-or-declined = consumed); the host just declines to lecture.
- **Host adapter** — main3d.ts `THE GUIDE` block: renders beats through the
  SHIPPED `#dialogue` presentation (`.guide` ember frame + `.tut` z-lift to
  29 over the check-in menu); `dlgOpen` doubles as the pause gate, so no beat
  can share a frame with live combat. `state.dialogue` remains exclusively
  Roam's; the sim, the replay wire, and MUST-3 are untouched by beats.
- **Ledger** — the shipped browser tips ledger (`dcc:tips:v1`,
  `recordTips`/`seedTips`); SHOWN = consumed; no second ledger. See §"the one
  rule this feature keeps relearning" above for who is allowed to write it.
  Announcements carry `tipId` so presentation can name what it painted.
- **Sim tips (the four that moved the sim)** — `collapse` (first
  Safe→Warning), `draftBanked` (first level-up mints a draft), and, from r4,
  `hype` (first crit — the bar moves in the frame the crawler moved it) and
  `glyph` (first glyph in hand). All four are `TIPS` entries + `systemTip`
  sites in game.ts. `rulesHash` regenerated — run proofs rotated.
  (r4: `draftBanked` reworded again. The System posts a NOTICE; it does not
  concede that you have a HUD with a badge at the bottom of it. It says
  "redeem" where Mordecai says "cash it": the two voices share no idiom.)
- **THE ONRAMP, r4 rebuild — PROMPTS and CONFIRMATIONS.** The ≤6 budget was
  never wrong; it was measuring the wrong thing. It now governs PROMPTS only
  (`start`, `contact`, `pickup`, `lowhp`, `linger`) — unsolicited lectures,
  floor 1, capped. CONFIRMATIONS (`ability`, `cast`, `slotted`, `ult`,
  `equipped`, `autoequip`, `drink`) exist only because the player performed the
  act they explain, so they are neither budgeted nor floor-gated; gating a
  confirmation by depth is what made the `cast` line unreachable in r2 and
  needed a special case in r3.
  **No line may name a bind the player cannot use.** The host passes static
  labels for the always-true controls (movement, strike, flask, bag) and a
  LIVE label at call time for anything ability-shaped; a keyed line handed an
  empty label is declined, not printed, and stays unfired for later. This is
  what killed the r3 dump, which named `Shift, Q, C` and `F` while slot 4 and
  the ultimate were padlocked — `CONFIG.ultimateMinFloor` is 7, so the
  ultimate's bind cannot exist in a first session at all and the onramp now
  never speaks it unless the slot itself has filled.
  **The script's ORDER is part of the script (r5).** `onrampObserve` reports
  PROMPTS before CONFIRMATIONS, and `intent.attack` is only a swing when
  something is inside `ONRAMP_CONTACT_TILES` *and* the exchange has drawn first
  blood either way. r4 observed confirmations first and treated a held mouse
  button as combat, so the most common fresh-player instinct — press and hold
  from the first frame — got "swinging is the floor, not the ceiling" at +0.9s
  with the nearest monster twenty tiles away, eleven seconds ahead of "WASD
  walks".
  **The flask prompt is at 60%, not 40% (r5, `ONRAMP_LOW_HP`).** At 40% the
  measured card painted at hp=34% with the crawler dead two seconds later, and
  four cold runs produced the verdict line "You died holding 3 flasks."
  **The bag is named only when the bag has something in it (r5).** `pickup`
  used to fire on gold, so the compliant reader pressed the key on cue and
  found nothing to wear.
  **`autoequip` is the loot lesson's reachable half (r5).** `equipped` fires on
  a BY-HAND equip and never once fired in four cold runs, because floor-1 loot
  is auto-equipped and the bag stays empty; the sim dressing the crawler is the
  moment gear demonstrably went on, and it is the natural place to explain why
  some gear never needed the trip.
- **Link arrivals** (`?daily=`/`?c=`/`?rush`/`?join=`/`?runback=`) skip
  B0/B9; in-run beats attach to pauses the player already took. Multiplayer
  and test mode construct no guide at all — but THE ONRAMP runs under net
  too (r2): it is a pure observer with zero sim writes, so the fresh browser
  whose first click is THE RUSH still gets its six lines. `?clean=1`
  suppresses beats and cards alike.
- **Acceptance probe** — `tools/_tut_r1.mjs`: cold-profile (fresh context)
  battery, raster-verified (box non-uniformity + warm-key fraction), one
  Chromium; frames in `tools/_tut_shots/`. 61 checks green at r1.
  `tools/_tut_r2.mjs`, `_tut_r3.mjs` and `_tut_r4.mjs` are the same shape per
  round (r4: 70 checks across four cold contexts, frames in
  `tools/_tut_r4_shots/`). r5 is `tools/_tut_r5_p1..p4.mjs` over
  `_tut_r5_lib.mjs` — which is the r4 CRITIC's instrument copied verbatim but
  for the shots directory, so the round is measured by the tool that failed it;
  frames and transcripts in `tools/_tut_r5_shots/`. ?debug=1 exposes
  `__dcc.tut()`: what the card surface is HOLDING (queued, with each card's age
  and moment length) versus what the ONRAMP has DELIVERED — the two questions
  every previous round conflated. Two probe habits r4 added, both learned the
  expensive way: a context asserts its profile is cold by reading
  `dcc:tips:v1`/`dcc:save:v1`/`dcc:history:v1` rather than assuming, and every
  in-run battery holds the crawler alive and CHECKS it survived — a death
  opens THE VERDICT, and post-r3 a card correctly refuses to burn behind a
  modal, so every measurement after an unnoticed death is a measurement of a
  corpse.

### The card surface's visibility contract (r3)

A once-EVER card is spent the moment it is SHOWN, so it may only be shown
where a player can see it. Three rules, all in main3d's `THE GUIDE`/card
block:

1. **Nothing displays behind a modal.** `tutorialBlocked()` = `dlgOpen ||
   body.modal`; the pump waits on it (400ms poll), because `body.modal` sets
   `#tutorial` to `opacity: 0 !important` (iso.html's modal-focus rule).
   Observed pre-fix: the collapse card displayed behind the safe-room shop
   and was consumed unseen, permanently.
2. **The auto-dismiss clock counts VISIBLE time only.** The 7s courtesy timer
   is an interval that accrues only while unblocked, so a modal opening
   mid-card pauses it instead of clipping the tail.
3. **Any-input dismiss stands down while blocked** — that input belongs to
   the modal, not to a card nobody can read.
4. **...and an URGENT card gets a longer input grace (r5: 2.6s vs 1.2s).** The
   flask line arrives while the crawler is losing a fight, which is exactly
   when the player's hands are busiest; its measured dwell in a real fight was
   0.3 SECONDS, blinked away by a movement key that was already down. A card
   nobody can physically read has been spent, not delivered.

"high" on a tip means exactly "this card's moment expires" — the onramp's
flask line and, since r3, the sim's `collapse` tip (queued behind the gap it
drifted 15-25s from the Warning tick and once landed inside the safe room).
It jumps the gap, never the active card.

### The card surface stops being a metronome (r5)

A guarded cold run painted **fourteen cards on floor 1 at almost exactly 10.4s
intervals**, with a median act→card lag of 30.4s and the hype card arriving
**47.6 seconds** after the crit whose sentence it opens with. The onramp's ≤6
prompt budget was intact and irrelevant: the player was reading a conveyor
belt, and the queue — not the game — was deciding what was being taught. Four
changes, all in main3d's card block:

1. **Every card declares how long its MOMENT is worth** (`cardMomentMs`:
   `ONRAMP_MOMENT_MS` / `SIM_TIP_MOMENT_MS`, default 25s). Past it the card is
   DROPPED — unspent, released to its author, teachable again the next time
   the game makes it true. A reaper runs on a 1s interval so a moment expires
   in wall time, not in pump time: a card waiting behind an ACTIVE card (whose
   own visible clock is paused behind a panel) must not be delivered a minute
   late the instant the glass clears.
2. **A card about NOW goes ahead of a card about ALWAYS**, and waits behind a
   3s gap instead of the 14s courtesy one. Evergreen rules ("WASD walks", "the
   stairs are down") lose nothing by waiting; they were what held the hype card.
3. **The courtesy gap widened 9s → 14s.** Nine seconds is short enough that a
   busy fight can always fill the next slot, which is what a 10.4s metronome
   is made of. Fourteen cannot.
4. **The card surface is the CURRICULUM; the ticker is the chatter.** On floor
   1 of a fresh crawler's session, the card belongs to the twelve concepts —
   the onramp's lines plus `CURRICULUM_TIPS` (`collapse`, `draftBanked`,
   `hype`, `glyph`). Every other first-contact tip (staggers, bolts,
   afflictions, loot boxes) routes to the ticker, where the System's ordinary
   chatter has always lived. A toast is still a paint, so it still spends —
   `showAnnouncement`'s toast branch writes the ledger for exactly that reason.

Measured after (cold profile, mouse held from the first frame, floor 1 for
93s): **9 cards, gaps 4.3 / 8.5 / 4.7 / 15.7 / 15.6 / 15.6 / 11.3 / 16.9s** —
contextual teaching bunched into the first fight (contact +5.3s, the ability
line +13.7s with the nearest monster 2.9 tiles away, hype +18.4s), evergreen
rules spaced wide after it. Hype card **4.1s** behind its crit (r4: 47.6s).
Median sim-tip delivery lag ~0s (r4: 30.4s). Three rule footnotes rode the
ticker instead, with real boxes on the glass.

### Two lectures, one wound (r3)

The sim's `lowhp` tip ("EXCELLENT television") now waits for the SECOND
distinct brush with death: the FIRST one already carries THE ONRAMP's flask
line, and two lectures 12s apart on the same wound read as nagging. A brush
is an EDGE — `Player.lowHpNow` latches on the dip, clears in the step loop
when the crawler climbs back over `show.lowHpFraction`, and `lowHpBrushes`
counts them. Once-EVER is untouched: `tipsSeen` still owns the ledger, so a
run that ends on its first brush simply leaves the tip for a later one.

### THE ONRAMP's floor-2 exception (r3), generalized (r4)

r3 carved `"cast"` alone out of the floor-1 retirement: a level-1 crawler can
reach the stairs with slot 4 and the ultimate still locked, and the organic
cold run banked its draft and descended without ever casting, which made the
one ability confirmation unreachable FOREVER. (The line re-words itself on
floor 2 — the socket is named present tense, not as a future event.)

r4 stopped treating that as an exception. Every CONFIRMATION is exempt from
the floor window on the same argument, because the exemption was never about
`cast`: it was about the fact that a confirmation belongs to whoever performed
the act, whenever they performed it. PROMPTS still retire on floor 2, where
the game starts teaching itself.

### The 12 concepts, and where each is actually taught (r5)

The r3 critic's finding was that only 4 of 12 were taught BY DOING; the r4
critic's was that the three the owner named as the point — THE FIVE, THE SHOW,
GLYPHS — were the three weakest. What the player must DO for each concept to
land, and where it was last MEASURED landing:

| Concept | Taught by | The act | Measured (cold, r5) |
|---|---|---|---|
| Move / aim | onramp `start` | (prompt — the one unavoidable lecture) | +1.0s, first card even with the mouse held from frame one |
| The swing | onramp `contact` | a monster comes inside 3 tiles | +7.0s, nearest monster 2.9 tiles |
| The ability slots | onramp `ability` | the player swings AT something, and the exchange costs or produces something | +17.8s, nearest monster 2.6 tiles, after `start` and `contact` |
| Cooldowns + the glyph socket | onramp `cast` | the player casts | (unchanged since r3) |
| A new slot's bind | onramp `slotted` | a draft fills an empty slot | +63.6s, naming C, the slot that had just filled |
| The ultimate | onramp `ult` | the ultimate slot fills (floor 7+) | NOT first-session — see below |
| Loot exists | onramp `pickup` | an ITEM lands in the bag (r5: no longer gold) | +49.1s, bag holding 4 |
| Gear is compared | onramp `autoequip`, then `equipped` | the sim dresses the crawler / the player equips by hand | +33.5s (`autoequip`); `equipped` still needs a by-hand equip |
| The flask | onramp `lowhp` → `drink` | the player presses it | prompt at hp 45–58%, confirmation 3–5s after the press |
| The stairs / the clock | onramp `linger`, sim `collapse` | time | +76.9s / +92.5s |
| THE SHOW | sim `hype` | the player lands a crit | card 4.2s behind the crit (r4: 47.6s) |
| GLYPHS | sim `glyph`, then B7 | the player picks a glyph up | NOT first-session — see below |

**GLYPHS, decided honestly — and r5 stops claiming the half r4 claimed.** r4
split the concept: B7 a later-session beat, but "the System's `glyph` tip is
the first-session coverage". The r4 critic then reported the tip unreached in
four cold sessions, and r5 reproduced that: glyphs drop at ~5% of loot from
floor 2, and a first session mostly ends on floors 1–3. So the honest statement
is the simple one: **GLYPHS IS NOT FIRST-SESSION CONTENT.** The `glyph` tip is
its coverage *whenever it happens* — it fires the instant the stone is in the
crawler's possession, wherever they are, and it is `CURRICULUM_TIPS` so it gets
the card and not the ticker. B7 adds judgement on top when a safe room, an open
socket (`glyphSocket1Level` = 4) and a glyph in hand finally coincide; it is
ordered ahead of B6 to make "finally" as early as the game allows. Neither is
counted as a first-session concept, and no probe in this repo should be written
to assert one.

**THE ULTIMATE is explicitly NOT first-session content either.**
`CONFIG.ultimateMinFloor` is 7. The `ult` line exists so the bind is taught
the moment the slot fills, and it is never printed before then.

**So the honest scoreboard is 10 first-session concepts, all taught by an act
the player performed, plus 2 (the ultimate, glyphs) that the game does not put
in front of a first session and that this feature does not pretend to.**

## Open edges (later rounds)

- **B7 at Roam settlement benches**: r1 fires the glyph beat at race-run safe
  rooms only; the settlement outfitter is opened by a live Roam dialogue and
  needs its own seam (Roam already has Mordecai's `GUIDE_TIPS` there).
- **Party onboarding** (`?join=`): Mordecai's beats stay suppressed — the
  dialogue seam has no wire message for answers. Later phase. (The System
  side is covered since r2: the onramp teaches controls under net.)
- **Touch farewell affordance**: beats close by tapping the farewell choice;
  a dedicated on-glass ESC affordance could come with the mobile merge (the
  mobile-wr branch is not on `tutorial`).
- **FIRST-RUN MERCY on floor 1** (r6-fix-1 item 4c, NOT done). Three of four
  cold passes died on floor 1 with GET MOVING at 1/3 or worse. The critic's
  ask is Hades' Tartarus shape: reduce pack size/aggro until `obj.move`
  completes. That is a `src/sim` change — it moves numbers, rotates
  `RULES_HASH` and retires every recorded run proof, and it has to be a flag
  the recorded run setup carries or replays diverge. It needs its own round
  with `npx tsx scripts/simhash.ts --write` and a balance-test pass; doing it
  quietly inside a UI round would have been exactly the wrong trade.
- **Floor-2+ curriculum is still unobserved end to end.** No cold pass has
  reached floor 2, so `obj.saferoom`, `obj.show` and the `elite`/`boss` depth
  confirmations have never been seen by a critic. Drive `?test&floor=2`.
  Related, and a design question rather than a bug: THE SHOW is the game's
  premise and it is the LAST step, behind four gates. r6-fix-1 gave the
  premise an early carrier instead of reordering the spine — the `hype` tip
  fires on the crawler's first CRIT and translates to Mordecai's "the cameras
  pay for loud", inside the first ninety seconds — but whether the closer
  should MOVE is still open, and it is the owner's call.
