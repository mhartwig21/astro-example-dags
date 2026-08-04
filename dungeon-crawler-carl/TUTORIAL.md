# TUTORIAL — the first session, with Mordecai

Owner ask: "an initial tutorial of AAA quality to onboard players to the game
— thinking Mordecai as the game guide using the Roam NPC chat experience —
helping to introduce all of the key concepts."

**SHIPPED (r1 + r2 + r3 + r4 fix rounds, branch `tutorial`).** The design sections that
became code are deleted (BACKLOG.md convention); what remains is the enduring
canon (the two-voice rule, the register bible), the implementation map, and
the open edges for later rounds.

## The one rule this feature keeps relearning (r4 — read this first)

**A concept is taught when a card PAINTS, not when the sim decides to teach
it.** Everything upstream of the glass — the sim's `tipsSeen` latch, the
announcement, the queue — is intent. Only the paint is delivery, and only
delivery may spend a once-EVER opportunity.

r1–r3 wrote the ledger from the sim call and mirrored it out of `saveRun`, and
three cold runs measured the consequence: `favorites` and `achievementClaim`
were consumed, permanently ledgered, and **never once displayed** — the
concepts were not taught badly, they were deleted from that profile forever.
Every guard was green while it happened, because every guard asked the code
whether it had shown a card instead of asking the pixels.

Two things follow, and they are binding on every future round:

1. **`recordTips` is called from exactly two places** — `displayTutorialCard`
   (the paint) and the skip path (an explicit refusal, which is a delivery of
   a different kind). Nowhere else. `saveRun` writes no ledger at all and
   additionally strips unshown ids from the run save, so a refresh-resume can
   re-teach what a crash swallowed.
2. **`Player.tipsSeen` is the sim's within-run latch and nothing more.** It
   exists to stop a rule re-announcing every step. It is not evidence that
   anybody learned anything.

## The one-paragraph design (canon)

**The System teaches the controls in the moment; Mordecai teaches the game at
rest.** THE ONRAMP (shipped in `src/ui/onramp.ts`) keeps minutes 1–5: six
System lines keyed to first-time events on floor 1. Mordecai appears ONLY at
rest moments — campfire, the first draft pause, safe rooms, the verdict, the
second check-in — through the shipped `#dialogue` panel. He never speaks over
live combat, never rides `state.announcements`, and never explains a rule the
System is about to demonstrate. Every beat is one ESC away from gone, fires
once EVER via the shipped tips ledger, and teaches by the player DOING the
thing once with a line of guidance.

## Two voices, one flow (canon — binding on every future line)

| | The System (SHOW) | Mordecai (GUIDE) |
|---|---|---|
| Register | Dry bureaucratic menace; show-aware but bored (VOICE.md) | Gruff, economical, protective; tired manager who's buried clients |
| Channel | `state.announcements` → banners / ticker / tutorial cards | dialogue panel only (plus the B8 verdict aside plate) |
| When | In the moment — the instant a rule touches you | At rest only — campfire, draft pause, safe room, verdict, check-in |
| Teaches | Controls + rules-as-they-bite | Judgment + the meta: what to pick, what to spend, why the cameras pay |
| Skip | Any input / 7s auto-dismiss | ESC or the farewell choice — one input, always last in the list |

**Division-of-labor rule**: if a concept can be demonstrated, the System
demonstrates it and Mordecai shuts up about it. He debriefs (the Show, B6)
only AFTER the System's tip has fired — never the reverse.

**And he does not paraphrase it (r4).** B6 shipped through three rounds
restating the `sponsors` tip nearly clause-for-clause ("sponsors pay YOU, in
gear, between floors" against "sponsors send gifts between floors"), and the
voice test could not see it because quotation-matching cannot detect a
paraphrase. `test/guide.test.ts` now fails any beat line that shares three or
more content words with any System tip — domain nouns deliberately NOT
exempted, because if Mordecai needs three of a tip's words to make his point,
his point IS the tip's point. The fix is always the same: find the thing the
System will never file. It owns mechanism; he owns what it costs you.

**The System never points at your chrome (r4).** It audits ledgers, posts
notices, and files explanations. It has never conceded that you have a HUD, a
badge, or a bottom of a screen, and it does not gloss keys in parentheses like
a manual. It may name a KEY (that is the crawler's own equipment) and a place
in the dungeon (a Safe Room's ACHIEVEMENTS tab). It may not name a pixel.

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
  `equipped`, `drink`) exist only because the player performed the act they
  explain, so they are neither budgeted nor floor-gated; gating a confirmation
  by depth is what made the `cast` line unreachable in r2 and needed a special
  case in r3.
  **No line may name a bind the player cannot use.** The host passes static
  labels for the always-true controls (movement, strike, flask, bag) and a
  LIVE label at call time for anything ability-shaped; a keyed line handed an
  empty label is declined, not printed, and stays unfired for later. This is
  what killed the r3 dump, which named `Shift, Q, C` and `F` while slot 4 and
  the ultimate were padlocked — `CONFIG.ultimateMinFloor` is 7, so the
  ultimate's bind cannot exist in a first session at all and the onramp now
  never speaks it unless the slot itself has filled.
  Card pacing: COURTESY cards keep a 9s gap on the shared `#tutorial` surface
  (queue holds; the lowhp flask line rides priority "high" and skips only the
  gap, never the active card). **The queue is scoped to the run** (r4):
  `startRun` drops everything still waiting — unspent, so the new run may
  teach it when it is true again — because a card that arrives with no context
  is worse than silence.
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
  `tools/_tut_r4_shots/`). Two probe habits r4 added, both learned the
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

The pacing gap (9s) is unchanged; what changed is which lines may JUMP it.
"high" on a tip means exactly "this card's moment expires" — the onramp's
flask line and, since r3, the sim's `collapse` tip (queued behind the gap it
drifted 15-25s from the Warning tick and once landed inside the safe room).
It jumps the gap, never the active card.

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

### The 12 concepts, and where each is actually taught (r4)

The r3 critic's finding was that only 4 of 12 were taught BY DOING. What the
player must DO for each concept to land:

| Concept | Taught by | The act |
|---|---|---|
| Move / aim | onramp `start` | (prompt — the one unavoidable lecture) |
| The swing | onramp `contact` | a monster comes inside 3 tiles |
| The ability slots | onramp `ability` | the player swings first |
| Cooldowns + the glyph socket | onramp `cast` | the player casts |
| A new slot's bind | onramp `slotted` | a draft fills an empty slot |
| The ultimate | onramp `ult` | the ultimate slot fills (floor 7+) |
| Loot exists | onramp `pickup` | the player picks something up |
| Gear is compared | onramp `equipped` | the player equips BY HAND from the bag |
| The flask | onramp `lowhp` → `drink` | the player presses it |
| The stairs / the clock | onramp `linger`, sim `collapse` | time |
| THE SHOW | sim `hype` | the player lands a crit |
| GLYPHS | sim `glyph`, then B7 | the player picks a glyph up |

**GLYPHS, decided honestly.** Mordecai's B7 beat needs a safe room, an open
socket (`glyphSocket1Level` = 4) and a glyph in hand *simultaneously*, and
glyphs drop at ~5% of loot from floor 2 — the r3 critic never assembled that
conjunction in three cold runs, and pretending otherwise is how the concept
scored 0. So the split is explicit: **the System's `glyph` tip is the
first-session coverage** (it fires the instant the stone is in the crawler's
possession, wherever they are), **and B7 is a later-session beat** that adds
judgement on top when the conjunction finally happens. B7 was reordered ahead
of B6 to make "finally" as early as the game allows. It is not claimed as
first-session content.

**THE ULTIMATE is explicitly NOT first-session content either.**
`CONFIG.ultimateMinFloor` is 7. The `ult` line exists so the bind is taught
the moment the slot fills, and it is never printed before then — which is the
whole of blocker 3.

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
