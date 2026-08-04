# TUTORIAL — the first session, with Mordecai

Design for the first-run onboarding flow. Owner ask: "an initial tutorial of
AAA quality to onboard players to the game — thinking Mordecai as the game
guide using the Roam NPC chat experience — helping to introduce all of the
key concepts."

Design-only document. Delete sections as they ship (BACKLOG.md convention).

## 0. The one-paragraph design

**The System teaches the controls in the moment; Mordecai teaches the game at
rest.** THE ONRAMP (NICHE.md §4.4, shipped in `src/ui/onramp.ts`) keeps
minutes 1–5: six System lines on the tutorial-card surface, keyed to
first-time events on floor 1, naming the live binds. Mordecai — the gruff
ex-crawler manager whose voice already ships in `safeRoomTip` (game.ts) and
`GUIDE_TIPS` (npc.ts) — appears ONLY at rest moments (campfire, the first
draft pause, safe rooms, the verdict) through the shipped `#dialogue` panel
(portrait, typewriter, numbered choices, `.guide` ember frame). He never
speaks over live combat, never rides `state.announcements`, and never
explains a rule the System is about to demonstrate. Every beat is one ESC
away from gone, every beat fires once EVER via the shipped tips ledger
(`dcc:tips:v1` + `Player.tipsSeen` + account convergence — extended, not
duplicated), and every concept is taught by the player DOING it once with a
line of guidance, not by reading about it.

## 1. Two voices, one flow (the reconciliation)

| | The System (SHOW) | Mordecai (GUIDE) |
|---|---|---|
| Register | Dry bureaucratic menace; show-aware but bored (VOICE.md) | Gruff, economical, protective; tired manager who's buried clients |
| Channel | `state.announcements` → banners / ticker / tutorial cards | dialogue panel only (the Roam `#dialogue` presentation) |
| When | In the moment — the instant a rule touches you, mid-combat is fine (cards are non-modal, auto-dismiss) | At rest only — campfire, draft pause, safe room, verdict, settlement |
| Teaches | Controls + rules-as-they-bite: movement, strike, abilities, flask, stagger, interference, collapse clock | Judgment + the meta: what to pick, what to spend, why the cameras pay, where to go next |
| Skip | Any input / 7s auto-dismiss (shipped) | ESC or the farewell choice — one input, always last in the list |

Division-of-labor rule, binding: **if a concept can be demonstrated, the
System demonstrates it and Mordecai shuts up about it.** Mordecai gets the
concepts that need judgment (drafts, spending, glyph commitment, running it
back) — the things a bored announcer would never help you with, because
helping you is not its job. That contrast IS the two-voice design: the
System explains after the fact, condescendingly; Mordecai prepares you,
grudgingly, because he wants you alive.

### ONRAMP reconciliation (§4.4 is the fast path)

The onramp is untouched and remains the spine of floor 1. Reconciliation
rules:

1. **Link arrivals** (`?daily=`, `?c=`, `?rush`, `?join=`, `?runback=`) skip
   the campfire beat (B0) entirely — a card dragged them in; nothing may
   delay the run. The onramp fires for them exactly as shipped (fresh-crawler
   gate). In-run Mordecai beats (B3–B8) still fire on their sim facts —
   they attach to pauses the player already took, so they cost a link
   arrival nothing.
2. **Organic first runs** get B0 at the campfire, then the identical floor-1
   onramp. One flow, two entry doors.
3. **Multiplayer** (`?join=`): all Mordecai beats suppressed (the shipped
   dialogue seam has no wire message for answers — `answerDialogue` early-
   outs on `net`). System tips still work; the server's account ledger
   already converges `tipsSeen`. Party onboarding is a later phase.
4. **Test mode**: everything suppressed (same `testMode` gate the onramp
   ships with).
5. **The global skip** (B0 choice 3) also silences the remaining onramp
   lines — a player who declined the hand-holding gets no more of it from
   either voice.

## 2. The concept list, prioritized

**IN the first session** (each taught at its moment, never before):

| # | Concept | Trigger (sim fact) | Voice | Beat |
|---|---|---|---|---|
| 1 | Movement + aim | gameplay live ~1s | System (shipped onramp) | B1 |
| 2 | Melee strike + abilities ("louder arguments") | first move / first cast | System (shipped onramp) | B1 |
| 3 | Flask + dodge pressure | first time under 40% HP | System (shipped onramp `lowhp` + sim tip `lowhp`) | B1 |
| 4 | Loot is a raise (bag, auto-equip) | first pickup | System (shipped onramp) | B1 |
| 5 | Down is the only way out (stairs) | lingering on floor 1 | System (shipped onramp) | B1 |
| 6 | Stagger / poise, statuses | first stagger / affliction | System (shipped sim tips) | B2 |
| 7 | Drafts + the constellation | first draft panel open | **Mordecai** | B3 |
| 8 | Collapse timer | first Safe→Warning transition | System (NEW sim tip) | B4 |
| 9 | Safe room: shop, refit, flask top-up, banked drafts | first safe-room open | **Mordecai** | B5 |
| 10 | Hype → viewers → favorites → sponsors | first interference/sponsor (System, shipped tips); depth at 2nd safe room | System, then **Mordecai** | B6 |
| 11 | Glyph socketing | socket 1 open (level 4) + a safe-room visit | **Mordecai** | B7 |
| 12 | Death → RUN IT BACK | first run end (THE VERDICT) | **Mordecai** | B8 |
| 13 | The daily / the rush / Roam, from the menu | second organic check-in | **Mordecai** | B9 |

**DEFERRED beyond the first session** (contextual later-beats, mostly
shipped): the ultimate slot (System tip when the first ultimate tome/draft
appears), bolt physics / extradition / afflicted / overrank / achievement
claiming (shipped sim tips), Roam campaign mechanics (Roam teaches itself —
Mordecai's shipped `GUIDE_TIPS` + orientation live there), party/rivals wire,
crafting-component depth (the shop's component highlighting carries it),
DEATH IS A DOOR's two doors (rush-only; the rush is a link/veteran surface).

Teaching all thirteen at once is the failure mode this table exists to
prevent: beats 1–6 are minutes 1–4; 7–9 land at the player's first pauses;
10–13 land where the game itself raises the subject.

## 3. The flow, beat by beat (cold profile)

Beat grammar, binding for every Mordecai beat below:

- **Opens** only when its rest surface opens (never a popup over play).
- **Plays** 1–2 typewriter lines (Space/Enter completes — shipped), then
  numbered choices: optional depth choice(s) first, farewell always last.
- **Closes** into the surface it introduced (draft panel, safe room) or back
  to the rest state. ESC anywhere = farewell (shipped).
- **Ledgers** its `tut.*` key the moment it is SHOWN (shown = consumed, the
  shipped tips convention) — a beat never replays, even after a skip.
- **One beat per surface visit.** A queued beat waits for the next rest
  surface; two beats never chain.

### B0 — THE CAMPFIRE INTRO (organic cold profiles only)

- **Trigger**: fresh crawler (the shipped onramp gate: no token, no history,
  no save) reaches the casting stage of RINGSIDE CHECK-IN (mode picked,
  campfire scene up, CHECK IN button live). Not shown to link arrivals.
- **The player does**: picks a crawler and a name — the beat rides the scene
  where those decisions already happen; it adds zero extra screens.
- **Mordecai** (dialogue panel over the campfire, `.guide` frame):

  > "Name's Mordecai. I managed crawlers before the dungeon ate my license.
  > Now I mind the fires and try to keep a few of you alive past the first
  > week."
  >
  > "The System talks a lot down there. Listen to WHAT it says, never HOW it
  > says it. I'll be at the safe rooms when you want an answer from someone
  > with a pulse."

  Choices:
  1. **"What am I in for?"** → "Eighteen floors, every one on a clock. Kill
     fast, loot faster, take the stairs before the ceiling does. Everything
     past that is detail, and detail keeps." *(returns to choices)*
  2. **"Let's go."** → farewell, panel closes, CHECK IN proceeds.
  3. **"Skip the hand-holding."** → sets ALL `tut.*` keys + silences the
     remaining onramp lines. Mordecai: "Fine by me. Advice keeps. The stairs
     are down — everything else you'll learn from the floor." *(closes)*
- **Skip path**: ESC, choice 2, or choice 3 — each exactly one input; CHECK
  IN is reachable the moment the panel closes.
- **Ledger**: `tut.campfire` (browser ledger — pre-sim, no Player yet;
  `seedTips` carries it into every character created after).

### B1 — FLOOR 1: THE ONRAMP (shipped, unchanged)

- The six System lines (`start`/`moved`/`cast`/`pickup`/`lowhp`/`linger`) on
  the `#tutorial` card surface, floor 1 only, live bind labels, auto-dismiss.
  This beat is regression-guarded, not redesigned. Mordecai is silent for
  the entire floor.

### B2 — FIRST COMBAT: THE SYSTEM DEMONSTRATES (shipped, unchanged)

- Stagger, composure, afflictions, low-HP television — the shipped sim tips
  fire as the rules bite (`systemTip` sites in game.ts). Binding rule
  restated because the critic will check it: **no Mordecai surface may
  appear while combat is live.** His first in-run appearance is B3, inside
  a pause.

### B3 — THE FIRST DRAFT (first level-up cash-in)

- **Trigger**: the draft panel opens for the first time ever (`tut.draft`
  unset). The badge/announcement that a draft is BANKED is the System's
  (new tip, §5). The beat rides the pause the panel already owns.
- **Mordecai** (panel, before the draft UI):

  > "First draft. Everything on the table is real — the lottery isn't
  > rigged, it's just indifferent. Take what changes HOW you fight, not what
  > pads a number. Numbers come free with levels. A new move is a new way
  > out of a bad room."

  Choices: 1. **"Show me the picks."** → panel closes into the draft UI.
  2. *(ESC does the same — there is no way to lose the draft.)*
- **The player does**: makes the pick. The draft itself is the lesson.
- **Skip**: ESC → straight to the draft UI. One input.
- **Ledger**: `tut.draft`.

### B4 — THE CLOCK CLEARS ITS THROAT (collapse warning)

- **Trigger**: first ever Safe→Warning transition (sim fact; new `systemTip`
  site — see §5). Live gameplay, so this is the SYSTEM's, on the card
  surface, non-modal:

  > "COURTESY EXPLANATION: this floor is on a clock, and the clock has
  > opinions now. When it runs out, the floor becomes the hazard. The stairs
  > are down. Punctuality is survivable. Sentiment is not."

- **The player does**: reads the HUD timer that just changed color, keeps
  playing. Mordecai adds judgment later (B5's "loot fast" line carries it).
- **Ledger**: `collapse` (sim-side `TIPS` entry, `Player.tipsSeen`).

### B5 — THE FIRST SAFE ROOM

- **Trigger**: first ever safe-room open (`tut.saferoom` unset). The sim is
  already paused (shipped safe-room behavior).
- **Mordecai** (panel first, then the safe-room panel):

  > "Safe room. The one door down here the dungeon can't follow you
  > through. Shop's stocked, the bench will re-slot your kit, and the flask
  > gets topped on the house."
  >
  > "Spend the gold. The exchange rate only gets worse with depth, and
  > nobody's buried with their savings. If you're sitting on a draft, cash
  > it here — nothing's chewing on you for once."

  Choices: 1. **"Open the shop."** → closes into the safe-room panel, shop
  tab. 2. **"Later."** → farewell.
- **The player does**: buys something, or refits, or walks — the safe-room
  panel itself is one choice away either way.
- **Skip**: ESC / "Later." One input; the safe-room panel is unaffected.
- **Ledger**: `tut.saferoom`.

### B6 — THE HONEST VERSION OF THE SHOW

- **Trigger**: second-or-later safe room, AND the player has met the Show
  (any of the shipped `interference` / `sponsors` / `favorites` tips has
  fired — the System demonstrates first, Mordecai debriefs after, never the
  reverse). One beat per safe-room visit means this never stacks on B5.
- **Mordecai**:

  > "You've noticed the cameras. Here's the honest version: hype is money.
  > Crits, crowds, close calls — the audience pays for all of it, and
  > sponsors pay YOU, in gear, between floors. Play a little louder than
  > survival strictly needs. I hate it too. It works."

  Choices: 1. **"Noted."** → farewell.
- **Skip**: ESC. **Ledger**: `tut.show`.

### B7 — THE FIRST GLYPH

- **Trigger**: a safe-room (or settlement bench) visit while socket 1 is
  open (level ≥ `glyphSocket1Level`, 4) AND the player owns a glyph or the
  shelf stocks the Glyph Cache (shop ≥ `glyphCacheFromShop`, 2). Fires on
  the visit where socketing is actually possible — never as theory.
- **Mordecai**:

  > "Your kit grew a socket. Glyphs go in. They don't make an ability
  > bigger — they make it DIFFERENT, and different is what gets you off
  > floor six. Try one. Hate it. Swap it at any bench, free. The first
  > commitment is the hardest; make it anyway."

  Choices: 1. **"Open the bench."** → closes into the loadout/socket UI.
  2. **"Later."** → farewell.
- **The player does**: sockets a glyph — the bench is one choice away and
  pre-focused on the open socket.
- **Skip**: ESC / "Later." **Ledger**: `tut.glyphs`.

### B8 — THE FIRST VERDICT (death is tuition)

- **Trigger**: first ever run end on THE VERDICT screen (win or wipe;
  `tut.runback` unset). Solo only. In a rush, DEATH IS A DOOR's two doors
  own the moment — no Mordecai there (rush arrivals are link/veteran paths
  and the beat stays ledgered for later solo runs).
- **Presentation**: NOT the full dialogue modal over the recap — THE VERDICT
  outranks everything (z 27) and its layout is shipped. Mordecai gets a
  guide-framed aside plate inside the verdict layout (portrait chip + one
  line + the ember keyline), above the RUN IT BACK CTA:

  > "That floor's still standing, and now you know its streets. Same seed,
  > same doors — run it back and collect what the tuition bought."

  (The CTA below it already reads `RUN IT BACK [R]` — his line points at it,
  the button teaches the input.)
- **The player does**: presses R (or not — the menu path is equally taught
  by B9).
- **Skip**: nothing to skip — one line, no modal, no input cost.
- **Ledger**: `tut.runback`.

### B9 — THE SECOND CHECK-IN (the menu has doors too)

- **Trigger**: second-or-later ORGANIC arrival at RINGSIDE CHECK-IN (not
  link-entered), at the panel stage (not casting — don't gate the rematch),
  ≥1 finished run in history, `tut.menu2` unset.
- **Mordecai** (panel over the campfire scene, same as B0):

  > "Back for more. Good. Two things worth knowing up top: the DAILY deals
  > every crawler alive the same dungeon — one seed, one board, bragging
  > rights until midnight. And the RUSH always has seats — racing strangers
  > beats dying alone."

  Choices: 1. **"And Roam?"** → "The long clock. Settlements, contracts,
  nobody counting your ratings. When you'd rather walk than sprint, it's
  there." 2. **"Thanks."** → farewell.
- **Skip**: ESC / choice 2. **Ledger**: `tut.menu2` (browser ledger).

## 4. Mordecai's presence (where the man lives)

- **The campfire** (B0, B9): he minds the fires — the check-in scene is his
  porch. Panel renders over the campfire canvas; the menu's own controls
  stay one input away.
- **Safe rooms** (B5, B6, B7): he is the safe-room manager the shipped
  `safeRoomTip` lines always implied. His ambient one-liners (`safeRoomTip`)
  continue unchanged as the safe-room panel's tip line; the tutorial beats
  are the once-ever, panel-grade version of the same man.
- **The verdict** (B8): an aside plate, not a modal — the numbers are the
  star, he's the corner-man.
- **Roam settlements** (shipped): unchanged — entrance-settlement guide,
  `GUIDE_TIPS`, orientation, the works. The tutorial adds nothing to Roam;
  Roam was already his home.
- **Never**: floor-side in a race, over live combat, on the announcement
  channel, in the System's typography. The dialogue panel appears only at
  the five rest surfaces enumerated above — the input-authority rule and
  the screen-zone map are binding (`#dialogue` z 22, modal, captures keys).

Register bible (for every future Mordecai line): short declaratives; wry,
never breathless; protective under the gruffness ("I hate it too. It
works."); concrete verbs over adjectives; no exclamation marks; no corporate
cheer; he says "you" and means the person, where the System says "Crawler"
and means the inventory item. He NEVER pre-explains a mechanic the System
demonstrates (stagger, interference, collapse) — he editorializes after.

## 5. Architecture (seams, not inventions)

- **`src/ui/guide.ts`** (new, pure): the beat table as DATA — `{ key,
  trigger, lines, choices }` — plus a `Guide` class in the exact `Onramp`
  mold: sim facts in, at most one beat out, unit-testable without a DOM.
  Host adapter in main3d.ts renders beats through the SHIPPED `#dialogue`
  presentation (`.guide` frame, `mordecai` portrait, typewriter, numbered
  choices, ESC farewell) — `updateDialogueUi`'s `runKind === "roam"` gate
  grows a tutorial branch fed by the guide module instead of
  `state.dialogue`; `state.dialogue` remains exclusively Roam's, so replay,
  MUST-3, and the sim stay untouched by presentation beats.
- **Ledger — extend, never duplicate**: `tut.*` keys ride the shipped
  browser ledger (`dcc:tips:v1`, `knownTips`/`recordTips`) and flow into
  every new character via the shipped `seedTips`, whence the account save /
  server convergence that already exists. No second ledger, no new storage
  key.
- **Sim changes, exactly two** (both `TIPS` entries + `systemTip` trigger
  sites in game.ts): `collapse` (first Safe→Warning, B4) and `draftBanked`
  ("COURTESY EXPLANATION: your level-up minted a DRAFT — it's banked in the
  badge by your cockpit, it does not spoil. Cash it somewhere quiet.") —
  fires on the first ever banked draft, card surface, and is what makes B3
  reachable by a player who ignores badges. **These move the sim: run
  `npx tsx scripts/simhash.ts --write` and note that run proofs rotate.**
- **Gates**: guide module constructed only when `!net && !testMode` (the
  onramp's gates). B0/B9 additionally require the organic-menu path; B0
  requires the fresh-crawler check. B3–B8 are ledger-gated only —
  pre-tutorial veterans see each once, at a pause, one ESC from gone
  (the precedent every shipped tip set).
- **No scrollbars; fits 1366×768, 1600×900, 2560×1440, and the shipped
  touch layer at 9e0969b** — the dialogue panel already clamps
  (`min(880px, 92vw)`); the B8 aside must fit inside the verdict's shipped
  layout without displacing the CTA row. The mobile-wr branch is NOT here;
  build against keyboard/mouse + existing touch only.

## 6. Acceptance criteria (falsifiable, per beat)

**Protocol, non-negotiable**: every first-run claim is verified from a COLD
profile (fresh browser context, cleared localStorage) — a warm-profile pass
proves nothing. Every visual claim is RASTER-verified (the `#tutorial` card
has a documented history of not painting — frames must visibly contain the
claimed beat; DOM presence is not evidence). One Chromium at a time.

- **B0**: Cold profile → DESCEND → casting stage: a frame shows the Mordecai
  panel (portrait pixels non-uniform, nameplate "MORDECAI" legible, ≥3
  numbered choices) at 1366×768, 1600×900, 2560×1440. ESC → CHECK IN
  clickable in the very next input. Reload → beat absent. `?daily=<today>`
  cold profile → beat absent. Choice 3 → no onramp card ever appears on the
  following floor 1 (raster: 30s of floor-1 play, zero cards).
- **B1** (regression): cold profile, floor 1 — "fresh meat" card paints
  within 3s of gameplay; each onramp line at most once; floor 2 → zero
  onramp lines.
- **B2 / global voice rule**: no frame anywhere in the session shows the
  dialogue panel while any monster is in aggro/windup (spot-checked at
  first-combat and collapse moments); grep-level check: no Mordecai string
  reaches `announce()`/`state.announcements`, no `TIPS` string reaches the
  dialogue panel.
- **B3**: cold profile, first draft opened → frame shows guide panel BEFORE
  any draft UI; next frame after choice 1 shows the draft panel; completing
  the pick works; second draft same run → panel absent. ESC path: draft UI
  reachable in one input from the beat.
- **B4**: cold profile, linger to Warning (or pinned seed) → the collapse
  card PAINTS (raster) once; a second run on the same profile reaching
  Warning → card absent. `test/` unit: the tip fires on the transition, once
  per ledger.
- **B5**: first stairs → frame sequence shows guide panel, then (choice 1)
  the safe-room shop tab. Second safe room → B5 absent (B6 may appear —
  exactly one beat per visit). ESC leaves the safe-room panel fully usable.
- **B6**: fires only after an interference/sponsors/favorites tip has fired
  (unit-testable in the guide module: Show-naive state → no beat).
- **B7**: at a bench visit with socket open + glyph obtainable → beat; the
  socket UI is reachable within 2 inputs of the beat (choice 1 = 1 input);
  socketing completes. Level <4 or no glyph path → no beat (unit test).
- **B8**: cold profile, die on floor 1 → THE VERDICT frame contains the
  Mordecai aside plate AND an unobstructed RUN IT BACK CTA; pressing R
  starts a run with the identical seed. Second death → plate absent. A rush
  death (DEATH IS A DOOR) → plate absent, both doors untouched.
- **B9**: after one finished run, organic menu visit #2 → beat paints;
  visit #3 → absent; link-entered visit → absent.
- **Whole-flow budget**: an unskipped organic first session shows at most 6
  System onramp lines + ≤4 sim tip cards + ≤5 Mordecai beats of ≤2 lines
  each before the first run ends — counted from a scripted cold-profile
  playthrough. Anything that reads as a lecture (two beats chained, a beat
  over combat, a beat repeating) fails the round.
- **Suite**: full vitest + typecheck green at phase-final commits; the two
  sim tips land with `rulesHash` regenerated; no existing test weakened.
