# TUTORIAL — the first session, with Mordecai

Owner ask: "an initial tutorial of AAA quality to onboard players to the game
— thinking Mordecai as the game guide using the Roam NPC chat experience —
helping to introduce all of the key concepts."

**SHIPPED (r1 + r2 + r3 fix rounds, branch `tutorial`).** The design sections that
became code are deleted (BACKLOG.md convention); what remains is the enduring
canon (the two-voice rule, the register bible), the implementation map, and
the open edges for later rounds.

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
  `tut.saferoom`/`tut.show`/`tut.glyphs` (B5/B6/B7 — at most one per
  safe-room visit, priority-ordered, so "second-or-later safe room" is
  structural), `tut.runback` (B8, verdict aside plate — solo DEATHS only; a
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
  `recordTips`/`seedTips`); shown = consumed; no second ledger.
- **Sim tips (the two that moved the sim)** — `collapse` (first Safe→Warning)
  and `draftBanked` (first level-up mints a draft), both `TIPS` entries +
  `systemTip` sites in game.ts. `rulesHash` regenerated — run proofs rotated.
  (r2: `draftBanked` reworded — the referent is the DRAFT badge the player
  can actually see, and the System says "redeem" where Mordecai says "cash
  it": the two voices share no idiom.)
- **THE ONRAMP, r2 hardening** — the host passes LIVE bind labels for every
  slot of the Five (`Left click or Space`, `Shift, Q, C`, `F`), the flask,
  and the BAG (`I` on desktop, the ☰ menu on touch) — the module header's
  contract, now actually honored (the old hardcoded "1–4" named keys that do
  nothing). Card pacing: COURTESY cards keep a 9s gap on the shared
  `#tutorial` surface (queue holds; the lowhp flask line rides priority
  "high" and skips only the gap, never the active card).
- **Link arrivals** (`?daily=`/`?c=`/`?rush`/`?join=`/`?runback=`) skip
  B0/B9; in-run beats attach to pauses the player already took. Multiplayer
  and test mode construct no guide at all — but THE ONRAMP runs under net
  too (r2): it is a pure observer with zero sim writes, so the fresh browser
  whose first click is THE RUSH still gets its six lines. `?clean=1`
  suppresses beats and cards alike.
- **Acceptance probe** — `tools/_tut_r1.mjs`: cold-profile (fresh context)
  battery, raster-verified (box non-uniformity + warm-key fraction), one
  Chromium; frames in `tools/_tut_shots/`. 61 checks green at r1.
  `tools/_tut_r2.mjs` and `tools/_tut_r3.mjs` are the same shape per round
  (r3: 37 checks, frames in `tools/_tut_r3_shots/`).

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

### THE ONRAMP's one floor-2 exception (r3)

`Onramp.note()` retires on floor 2 — except `"cast"`. A level-1 crawler can
reach the stairs with slot 4 and the ultimate still locked, and the organic
cold run banked its draft and descended without ever casting, which made the
one ability confirmation unreachable FOREVER. The line survives to floor 2
and re-words itself there (the socket is named present tense, not as a
future event). The host mirrors the same window in `onrampObserve`.

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
