# TUTORIAL — the first session, with Mordecai

Owner ask: "an initial tutorial of AAA quality to onboard players to the game
— thinking Mordecai as the game guide using the Roam NPC chat experience —
helping to introduce all of the key concepts."

**SHIPPED (r1 + r2 + r3 + r4 + r5 fix rounds, branch `tutorial`; r6 REBUILD —
ONE VOICE — on branch `tutorial-mordecai`).** The design sections that became
code are deleted (BACKLOG.md convention); what remains is the enduring canon
(the one-voice law, the register bible), the implementation map, and the open
edges for later rounds.

## r10 — THE TEACHING CHANNEL BECOMES CONTINUOUS (the r9-owed root cause)

The fifth critic round scored 6.5 and named one cause under every remaining
stall — the thing r9 signed as owed, in its own words: **"the coach prose slot
teaches the wrong thing, once, and never again."** Measured: 2 of 4 cold
profiles learned the kit, 1 of 4 completed the curriculum, and half the cohort
finished a 7.5-minute first session at level 1, floor 1, ~0 gold, still on step
2 of 5. **Zero `src/sim` changes — `RULES_HASH` is untouched.** Measured on the
glass by `tools/_tut_r10_ask.mjs` (one browser, port 5287, cold profile, 8/8
green); frames in `tools/_shots/tut_r10/`.

1. **THE PROSE SLOT WAS AN EVENT CHANNEL DOING AN INSTRUCTION'S JOB.** Every
   teaching line in `src/ui/coach.ts` was an EVENT: something became true, a
   line was offered, a card painted, the opportunity was spent forever. That is
   the right shape for a confirmation and exactly the wrong shape for the
   instruction a player is currently failing to follow. Three consequences, one
   cause: a step's instruction was spent on ONE paint (dropped by the queue cap
   — where its 60s moment made it the *preferred* eviction victim — or by a
   modal, and it never came back); a player stuck on an item got silence, because
   prompts are floor-1-only and budgeted, confirmations need an act the player
   cannot perform, and the step intro had already fired; and what did paint was
   the prose for the STEP, or for an event forty seconds gone.

   **THE STANDING ASK** (`src/ui/coach.ts`: `OBJ_ASKS`, `StandingAsk`;
   `Objectives.askKey()`; main3d's `currentAskKey`/`askTick`) is the second half
   of the channel, and it is a PROJECTION, not a message — the same discipline
   r8 gave the checklist. One sentence of prose for the current step's first
   unchecked item, rebuilt from the sequencer every frame, rendered on the
   persistent card (which survives a modal, so the panel a step points at cannot
   hide the step). It is never spent, cannot go stale, and re-reads the world
   every frame. Losing a card now costs a nudge instead of the lesson.
   - **ESCALATION.** An ask that has stood for `ASK_STUCK_MS` (25s) of REAL
     on-glass time — the same honest clock `OBJ_MIN_VISIBLE_MS` is paid in, so
     nobody is escalated at over an instruction they were never shown — is
     replaced by its CONCRETE form: the exact key, the exact place, the thing
     they are probably doing wrong. Permanently, for that item. Any progress
     moves the ask on and resets the clock.
   - **IT IS DELIVERED IN PLACE.** The first build of this fix also queued the
     concrete form as a strip card, and the frame showed what that is: the same
     sentence twice in one column, sixty pixels apart — r8's finding 3 walking
     back in through this round's door. The prose changes where the player is
     already reading and pulses (`.obj-ask.pulse`, two warm sweeps, no motion,
     no new box), re-asserted at most `ASK_MAX_CARDS` times. **Bounded
     attention-drawing is politeness; bounded teaching was the bug.**
   - Coverage is a test: every item the curriculum can stall on — including the
     safe room's `browse` alt wording — must have an ask AND an escalation, and
     no ask may exist that nothing can produce.
2. **THE DRAFT PROMPT FAILED UNIVERSALLY** (severity 8): every cold profile
   ended its first session holding unclaimed drafts, the best one holding two,
   so the game's core progression verb was learned by nobody. The only things
   ever saying so were a badge in the corner and one System notice at 45
   seconds. Three fixes, all at the mechanism: **a banked draft PRE-EMPTS the
   standing ask from anywhere** (it is claimable in any room, costs nothing, and
   is strength already earned) on a faster clock (8s, not 25s); the checklist
   item carries the bind (`Claim a draft with {draft}`) instead of naming an act
   with no control attached; and the System's "NOTICE: you have unclaimed
   evolutions" now fires only for crawlers who are NOT enrolled — ONE VOICE, and
   a second teacher saying the same thing worse in the register the rebuild
   retired from teaching is not a redundancy, it is the defect.
3. **THE SHOW WAS SURFACED, NEVER TAUGHT** (severity 7 — "untaught vocabulary
   was relocated rather than eliminated"). `#show` is on the glass from second
   zero (a hype bar and three counts) and the curriculum's LAST step is titled
   The Show and asks for "hype over 25" and "a favorite" — two words nothing had
   ever said out loud, on a step most first sessions never reach. Taught, at a
   carrier that cannot be missed: **`showbar` fires the instant the hype reading
   first moves** (every crawler's first kill) and defines all three nouns. It
   shares `TOPIC_SHOW` with the sim's `hype` tip — which needed a CRIT — so
   whichever reaches the glass first teaches the premise and the other stands
   down. The obj.show intro and both of its asks define the words they use.

**Verified on the glass** (`_tut_r10_ask.mjs`, cold profile, every text read
paired with a rect + computed-style read): the ask paints at 238x33 with its
control as a key cap ("Hold **WASD** and get off this tile."); a player who does
nothing for 25s is escalated in place to the concrete form (32 → 185 chars) with
**no duplicate card under it**; checking an item hands the prose to the next one
("Find something that moves and hit it with **Space**."); a staged banked draft
pre-empts the step and names its key ("Press **V** to claim the draft you have
banked.").

**Still owed after this round**, and named honestly: monotonic first-session
progress, stairs wayfinding under the collapse clock, mercy escalation/diagnosis
on a stuck floor 1, and the verdict screen's nine choices. The standing ask is
the channel those fixes will speak through; it is not a substitute for them.
Nobody has yet watched a cold profile COMPLETE the curriculum with this in —
that is the next battery's job, and it must measure completion, not arming
(HANDOFF §0).

## r9 — THE SHELF SAID THE FALSE THING: the severity-5 pair (host + instrument)

The fourth critic round scored 6.5 and left nine findings above severity 5 that
are curriculum-architecture work, plus exactly two at severity 5. This round is
those two, at their cause. **Zero `src/sim` changes — `RULES_HASH` is untouched
and no recorded run proof is retired.** Measured on the glass by
`tools/_tut_r9_shelf.mjs` (one browser, port 5287, cold profile, 9/9 green);
frame in `tools/_shots/tut_r9/shelf_first.png`.

1. **"THE FIRST SHELF IS 18/24 TILES THAT DO NOTHING YET, AGAINST AN EMPTY
   EQUIPPED ROW."** The shelf was never the liar; the panel's own copy was.
   Every `basic`-tier catalog entry (`src/sim/catalog.ts`) carries a `slot` AND
   `affixes` — they are wearable stat sticks — and `buyCatalogItem`
   (`src/sim/game.ts`, the `p.equipment[item.slot]` branch) equips a purchase
   the instant its slot is empty or its score beats what is worn. A debut
   crawler's equipped row is six empty slots, so on the FIRST shelf nothing is
   deferred for anybody. The only two sentences on the glass about it said the
   opposite: `COACH_SHOP_BEATS.afford` called COMPONENTS tiles "parts rather
   than gear — they build into the real thing at a later shelf", and the bag's
   empty state said "buy components, they wait here". The shop talked the
   player out of the one shelf where everything works immediately. Four fixes:
   - The beats say the true thing (`gear you wear today that a later shelf
     builds into something bigger`), and `test/coach.test.ts` fails any shelf
     beat that defers a COMPONENTS tile without saying it is useful today.
   - A third form, **`fits`**, exists for the case the critic was looking at:
     it names the EMPTY SLOT and the tile that fills it ("your weapon slot is
     empty, so it goes straight on you"). `shopLessonLine` prefers it, off
     `cheapestFittingEntry` — cheapest, buyable NOW (same `buyBlocker` gate the
     tile's ready ring reads), landing in a slot the crawler has open.
   - The shelf carries the same read: `fillsEmptySlot` adds a `fits` class and
     a green corner flag, and the tile's own hover text names the slot. "Ready
     to buy" answers what you CAN click; on 24 tiles priced within 20 gold of
     each other it never answered what is worth clicking. Measured cold at the
     bare 40-gold stipend: 3 of the 4 ready tiles marked, all three STARTER.
   - **THE CHASE is folded at the first shelf** while the curriculum is live
     (returns at shop 2). Five drop-only boss uniques with no prices cannot be
     bought, are undefined vocabulary, and were one of six navigation
     affordances on a tutorial's first shop. A fold, not a lock — the same rule
     as `body.coldboot` on the menu. Sub-tabs at the first shelf: 3 → 2.

   The 18-tile COMPONENTS row is deliberately NOT thinned. Thinning it would
   have been the symptom fix: those tiles are the build tree and they are
   wearable, so the defect was always the sentence next to them.
2. **THE INSTRUMENT WAS NOT TRUSTWORTHY ENOUGH TO CERTIFY ITS OWN ROUND.**
   Three defects in `tools/_tut_r7_cold.mjs`, all the same mistake in different
   clothes — a SAMPLED observation published as a MEASURED outcome:
   - `engagements` incremented once per decision tick spent inside engage
     range, so it counted dwell and was then compared to a swing COUNT as if
     they shared a unit (B: 433 vs 36; A: 52 vs 93). It counts ENTRY EDGES now,
     with dwell kept separately as `contactTicks` and `swings` renamed
     `swingAttempts`, which is what it always was.
   - `stepStates[title].peak` never observed the completing frame, so "Get
     Moving".peak was 2 in all five passes while `obj.move` ledgered every
     time — and the round read that gap as a defect in the game rather than in
     its own sampling rate. Completion is READ FROM THE LEDGER every tick now
     (`ledgerAt` timestamps each `obj.*` key); `peak` is a labelled footnote.
   - `reachedFive` was set true when the step ARMED, which is what produced the
     headline "4/4 reached THE FIVE" against an actual 2/4 completion. Arming
     and completion are two fields (`armedFive` / `completedFive`), plus
     `stepsCompleted` and `curriculumComplete`, and the headline prints both.
   Also: `TUT_OUT` now selects the shots directory. A round may not overwrite
   the battery that judged it — the r7/r8 evidence in `tools/_shots/tut_r7` is
   the only before-picture there is.

**Verified on the glass** (`_tut_r9_shelf.mjs`, staged safe room on a cold
enrolled profile — labelled a STAGED UI CHECK, never reported as a cold
outcome): lesson "Buy the Boxcutter for 35 gold — your weapon slot is empty, so
it goes straight on you", 3 fits-marked tiles of 4 ready, sub-tabs
`[IN STOCK, ALL ITEMS]`, bag copy corrected. The corrected instrument was also
re-run cold (profile D, 210s): `armedFive: true, completedFive: false` — the
distinction the round had been publishing as one number.

**Owed after this round, and named honestly.** Everything the critic filed at
severity 6+ is untouched and is one piece of architecture: the coach prose slot
multiplexes reactive tips with objective teaching, fires each step's intro once,
caps lectures at seven, and never re-nudges an unfinished item
(`src/ui/coach.ts:344` — "null means DROP"). That is the root cause of the
stalls, the unclaimed drafts, and the two profiles that ended a 7.5-minute
session on step 2. It is a rewrite of the slot's ownership rules, not a patch.
Also owed: monotonic first-session progress, stairs wayfinding under the
collapse clock, mercy escalation/diagnosis on a stuck floor 1, the draft-claim
prompt, THE SHOW's untaught vocabulary, and the verdict screen's nine choices.
**(The root cause, the draft prompt and THE SHOW's vocabulary all shipped in
r10 above; the rest is still owed.)**

One severity-3 item is NARROWED but not fixed, deliberately: "Mordecai's panel
persists as an empty chrome box after graduation" (A_99_final.png). It is not
`#coach-head` — `body.coaching` correctly hides that the moment `finished`
turns true (iso.html:574-575). It is `#tutorial .tut-head`, which
`body.coaching` hides *while* the curriculum runs (iso.html:665) and therefore
un-hides at graduation, leaving a strip card's plaque with no body under it.
Fixing it without a reproduction would be a guess, and this feature's own law
is that a claim about delivery is a claim about pixels.

## r8 — THE COLUMN AND THE ROOM: the third critic round, host-side

Five host findings, each fixed at its cause. Zero sim changes — `RULES_HASH` is
untouched, and r7's DEBUT rules are exactly as they shipped. Measured in the
app by `tools/_tut_r3_probe.mjs` (one cold profile, one browser, port 5287:
boot → floor 1 → the stairs → the shelf → floor 2), frames in
`tools/_shots/r3_saferoom.png` and `r3_floor2.png`.

1. **THE CHECKLIST DESYNCED FROM THE WORLD, in both directions.** It asked for
   three kills while the player stood at the shop counter, and the safe room's
   card was still on the glass a floor later. Three causes, three fixes:
   - **Place is now a property of every step** (`ObjectiveStep.where`:
     `field` | `shop`). The card is the first not-yet-done step whose place is
     the place the crawler is standing in, and **when no step matches, there is
     no card**. r2's `preempt`/`armFact` pair was the same idea as a special
     case on one step, and it left the symmetric hole wide open: once
     `obj.saferoom` was COMPLETE the pre-empt stood down and handed the card
     straight back to "put down three monsters" — in a room with nothing to
     kill. (r2's own test asserted that behavior; it is inverted now.)
   - **The sequencer sampled the world on the SIM clock.** Every intent seam
     sits inside `while (acc >= SIM_DT)`, and solo play zeroes `acc` for every
     open panel — so a curriculum fed only from there is blind for exactly as
     long as the player is at a counter, which is when its own shop step is the
     ask. `objectivesObserve` now latches only the facts that need the consumed
     intent; `objectivesSync` computes the rest and feeds the sequencer **once
     per rendered frame, paused or not**. That is why "Open the shop" can tick
     while the shop is open, which it demonstrably never did.
   - **The card repainted only on a fact EDGE**, and a change of PLACE is an
     edge in no fact. `renderObjectivesCard` builds the HTML from `view()`
     every frame and writes the DOM only when it differs.
2. **THE DESCENT FIRED THREE SUBTITLES AND FOUR DUPLICATED FEED LINES AT ONCE.**
   - The duplication was a RACE, not a rule. `announce()` pushes the same string
     to `state.announcements` and `state.events`, and the solo loop drained
     events *inside* the sub-step loop while announcements were presented at the
     *end* of the frame — so the quiet surface always got there first and r2's
     3.4s window plus its 900ms retro-active pull-back were left trying to
     un-print it. `presentSimOutput` now drains both from ONE seam with the
     announcer given first refusal: an event that IS an announcement never
     enters the visible feed. The archive `log` array still gets every line.
   - The stack was fixed by DELETING news: r2 collapsed the burst to the newest
     line, so the first two sentences flicked past unread (and, being a 350ms
     fade, were all on the glass while it happened — which is what the pass
     photographed). Arrival lines are **metered** now: inside the floor
     transition window they release one at a time, each with a dwell scaled to
     its own length, the previous one fading as the next arrives. Ordinary
     combat chatter is untouched. Measured at the door: 3 lines delivered, peak
     **1** on the glass, 0 duplicated feed lines.
3. **TEACHING WAS FIVE SURFACES IN FOUR CORNERS.** r2 moved the strip onto the
   objectives card's axis and kept them apart with a JS-published CSS variable
   (`--obj-h`); two fixed overlays stacked by arithmetic are still two
   overlays. They are **one plate** now — `#coach`, holding one Mordecai plaque
   (`#coach-head`), the checklist and the strip in normal flow. No measurement,
   no variable, no gap to keep in sync, ONE portrait, one place to look for
   what to do next. The zone map has one `coach column` entry where it had two.
   The System keeps its own two surfaces, and finding 2 stopped one of them
   being a copy of the other.
4. **GEAR / EQUIP / SHOP VOCABULARY WAS TAUGHT BY NOBODY.** The bag half failed
   structurally: `pickup` needs an item to LAND IN THE BAG and floor-1 loot
   mostly auto-equips, so the one gear moment floor 1 reliably provides
   (`autoequip`) was spent on "check the number that moved" — no key, no bag,
   not the word *equipped*. It names all three now, and `pickup`/`autoequip`
   share `TOPIC_BAG` so the bag key is taught exactly once, by whichever moment
   the dungeon reaches first. The shelf gets real beats (`COACH_SHOP_BEATS`,
   same shape and same binding rule as every other line, rendered into the
   panel's own Mordecai row because `body.modal` hides the strip by design):
   the one affordable item by name and price, what a COMPONENTS tile is, that
   the bag sells here, that gold survives a floor.
5. **RE-VERIFIED, and one hole closed.** The strip survives six seconds of held
   W in the real app (`e.repeat` ignored outright); THE FIVE still cannot
   complete before it paints (arm-and-return + `OBJ_MIN_VISIBLE_MS`, and a step
   the player's place is hiding now banks no dwell at all). The Shift/dash rule
   had a live hole: the card's `{cast}` token derived the cast slot correctly
   and then **fell back to a hardcoded slot index**, which is the dash's slot
   for anyone who benched it there. `castKeyIndex` excludes the dash at every
   branch by construction and is the one function both surfaces read.

## r7 — THE DEBUT: the two owed SIM changes (branch `tutorial-mordecai`)

Both r6 rounds ended with the same two items owed, and both were owed because
they are `src/sim` changes and those rounds were scoped to UI. This round is
the sim round. **`RULES_HASH` rotated** (`npx tsx scripts/simhash.ts --write`)
— every previously recorded run proof is retired, which is expected and
documented (COMPETITIVE.md §2.6a) and is the price of both fixes.

**One flag, three rules, one floor.** `GameState.firstRun` is set at
`createGame` by the host that read the profile (`isDebutRun` in main3d), round
-trips through the save (`SavedProgress.firstRun` — a refresh mid-lesson must
not silently promote a first-timer into the real game), and rides the run-proof
header (`RunProofHeader.firstRun`) so a replay rebuilds the same world. Nothing
else in the codebase sets it: not `createTestGame`, not the server, not the
bot, not the balance harness. The gate the player can feel is even narrower —
**floor 1** (`firstRunMercyActive`), which opens at second zero and closes the
instant they take the stairs. No counter, no step to finish, nothing to be
confused by.

1. **THE FIRST RUN CANNOT BE FAILED.** Three of four cold passes died on floor
   1 without finishing the first objective; one cycled `0/3 → 2/3 → reset`
   twelve times over seven minutes. Two mechanisms, because floor 1 has two
   ways to kill you:
   - **The cut to commercial.** Every death in the game funnels through
     `handlePlayerDeath` — monsters, hazards, statuses, bombers, the floor
     itself — so the mercy sits THERE and not at the twenty-odd call sites. A
     killing blow puts the crawler at the floor entrance on
     `firstRunMercyHpFraction` of their bar, briefly untouchable, with hype at
     zero and the System narrating the edit. It costs position, health and the
     crowd; it cannot cost the run. The step loop asks the same question of the
     STATE each frame (`p.hp <= 0 && alive`), so a damage source that forgets
     to route its own death cannot fail the run either.
   - **The held clock.** Floor 1's budget is 120 seconds and a first-timer
     spends most of it learning which key walks. Converting killing blows and
     then letting the FLOOR kill them would be a mercy that lies, and a
     knockdown loop inside a collapsing floor is exactly the "reads as broken"
     failure this round was told to avoid. So the clock counts down normally —
     through the WARNING, whose System line is the collapse lesson the whole
     curriculum is built on — and then HOLDS at `firstRunClockHoldSeconds`,
     announced once as the production decision it is. The HUD says `HELD` in
     the warning's gold and sits still (`.hh-phase.held`): a countdown that
     silently stops is indistinguishable from one that broke.
2. **THE FIRST SHELF IS A SHELF, NOT A WINDOW.** Two cold rounds measured 24
   then 16 gold against a 35-gold cheapest entry. Fixed at the cause, twice
   over: a debut crawler is advanced `firstRunStipendGold` at construction (the
   line is SAID on the first step — a construction-time announcement is cleared
   by `step()` before any host can drain it), and the guarantee is restated at
   `generateSafeRoom` against the shelf that actually generated, so a crawler
   who arrives broke is topped up to `cheapestUsefulShelfPrice`. That helper is
   the shared definition of "affordable AND useful" — gear, or a consumable
   that heals/plates/buys time; never a tome nobody can read or a legendary
   wanting sponsors. Shop 1 only; the second shelf is the real economy.

**A debut is not a contest.** The run records and replays exactly (the flag is
in the header for the same reason the daily rule is), and the server refuses it
a board slot by header — `competitiveApi` and `verifyWorker`, structural, the
same class of refusal as a test-mode start. Ordinary play is untouched: an
ordinary run built from the same seed still starts broke, still collapses,
still dies, and `test/tutorial-firstrun.test.ts` asserts each of those as the
control beside every mercy claim (16 tests; the host half is measured by
`tools/_tut_debut_probe.mjs` against a cold profile on port 5287).

## r6-fix-2 — the second critic round (branch `tutorial-mordecai`)

A harsh critic scored the fixed build 5.5/10 off three cold browser passes
(shots + flow logs in `tools/_shots/tutorial_r2/`). Every finding is fixed at
the mechanism. The two sim-side asks stay open and are named at the bottom.

**Blockers (severity 5).**

1. **Shift was taught as a CAST key and then as the DASH, 21 seconds apart.**
   The `ability` beat printed "Press Shift, Q to cast the abilities you
   actually own" at T+42.1s and `dashkit` printed "Press Shift to dash clear"
   at T+63.4s, while the hotbar and the objectives card both said SHIFT→DASH.
   The host built that label by joining EVERY filled slot's bind, and slot 2 is
   the dash. The rule is now a pure function — `castSlotIndices` in
   `src/ui/coach.ts`, which excludes the dash slot by construction — and a
   crawler whose only non-strike slot IS the dash gets no ability line at all
   (empty label => DECLINED). `objItemLabel`'s `{cast}` token reads the same
   function, so the card and the strip cannot drift. Tests: coach.test.ts
   "SHIFT IS THE DASH, AND THE STRIP MAY NOT SAY OTHERWISE", asserting exactly
   what the critic asked — the ability beat's key list never contains the
   slot2 bind while slot2 holds a dash.
2. **The tutorial could be failed forever.** THE FIVE sat behind "put down
   three monsters IN ONE LIFE" and death reset the counter: pass B cycled
   0/3 -> 1/3 -> 2/3 -> reset twelve consecutive times and was still on step
   one after seven minutes; 2 of 3 cold sessions never reached the step that
   teaches the kit, so the whole downstream spine was unreachable. Two changes,
   both host-side: `Objectives.resetRun` no longer clears item latches (the
   curriculum is a PLAYER-KNOWLEDGE ledger, not a run ledger — only arm
   latches are re-earned), and the `kills3` fact counts SESSION kills
   (`objKillsBanked` + the live run's) so a death banks tuition instead of
   erasing it. This is also the fix for the separate finding that the card
   "reads as erasure" after a losing session — the only persistent progress
   indicator on screen can no longer count backwards.

**Majors (severity 4).**

3. **The card desynced from the world at exactly the moments it mattered.**
   Standing in the first safe room with the shop open, the card read "Get
   Moving 2/3". The spine was strictly sequential, so THE SAFE ROOM lesson did
   not exist at the one moment the player was in a safe room, and a fast
   descender finishes the run before it ever arms. Steps may now declare
   themselves CONTEXTUAL (`ObjectiveStep.preempt`): while the trigger fact is
   live the step takes the card wherever the spine had got to, and the spine
   resumes with its latches and its dwell intact when the trigger goes away.
   `obj.saferoom` is the first one. Its third item ("take the stairs down") is
   gone: it could only be satisfied by LEAVING the room the step is about, it
   duplicated obj.payday's `descend`, and it was one of the two near-identical
   stairs lectures the pass counted. Tests: objectives.test.ts "THE WORLD
   OVERRULES THE QUEUE".
4. **The first shop was a locked door** — 16 gold against 21 tiles priced
   35-180, every price red, no enabled buy control, no teaching card, and a
   panel full of undefined vocabulary. The shelf-affordability half is a SIM
   change and stays open (below). What shipped: the `browse` fallback is now
   REACHABLE (it needed the step to arm, which is finding 3), and while THE
   SAFE ROOM is the live ask the panel's own Mordecai row carries the lesson —
   `shopLessonLine` names the cheapest entry and its price, or, when the shelf
   really is out of reach, says so with the number and tells the player what to
   do instead. It prints INSIDE the panel because that is where the player is
   looking: `body.modal` hides the strip by design, so a card is the wrong
   surface for a shop lesson.
5. **Announcement flood and duplication at the descent.** Floor 2's arrival —
   the biggest teaching beat after first blood — put three System subtitles on
   the glass in one second with the SAME lines simultaneously in the live feed.
   Two rules in `main3d`: `liveAnnouncements` records what is on a louder
   surface right now (banner or toast, normalized text) and `pushLogLine`
   declines to echo it — the archive `log` array is untouched, so nothing is
   lost, only un-doubled; and during a floor transition (`FLOOR_QUIET_MS` after
   the floor changes) the toast stack is collapsed to the newest line, so
   arrival news reads as news instead of a wall.
6. **The V bind for the draft was dead while the badge taught V.** `wasDown`
   meant "in the held set", and one swallowed keyup (alt-tab, devtools, a modal
   taking focus) latched a bind dead for the session. It now means `e.repeat` —
   autorepeat is the only thing that guard ever needed to suppress, and a
   physical press always produces a non-repeat keydown, so no lost event can
   make a taught key do nothing. Plus `clearHeld()` on blur, on
   `visibilitychange`, and on BOTH edges of `body.modal`.
7. **Gear, equipping and the safe room were never taught in any observed
   session.** `pickup` left the PROMPT set: it is an answer to an act, and the
   floor-1 window plus the lecture budget meant the bag key was never named
   (floor-1 loot mostly auto-equips, so the first item that actually lands in
   the bag is usually deeper). It is a confirmation now — any floor,
   unbudgeted. The safe room is covered by findings 3 and 4.

**Minors (severity 2-3).**

8. **Payday armed with an item already ticked.** Every diffed baseline
   (inventory, equipment, gold spent, floor, favorites, and the draft latch) is
   re-based on the step's own arming edge, so each item asks for an act
   performed on THIS card's watch.
9. **Teaching was scattered across four corners, and the strip looked like
   debug UI beside the dialogue panel.** The strip moved to the right rail and
   stacks directly under the objectives card (`--obj-h`, published by
   `publishObjectivesHeight` — only the host can measure a card whose item
   count changes per step), so instruction and checklist are ONE column. It
   wears the dialogue panel's material tokens now: noise+gradient slab,
   three-tone bronze keyline with the lit top edge, offset outline, a SQUARE
   framed portrait chip, a nameplate with the role as a kicker, and key caps —
   the control it names is drawn as a cap (`.tut-key`, shared with the card's
   `.obj-key`), not as a word in the middle of a sentence.
10. **Layering was inconsistent** — the card was crisp over the shop and
    blurred to illegibility behind the dialogue backdrop, including at its
    first paint. One rule for both now (`body.modal, body.dlg`): readable, at
    z 26, on an opaque plate. It does not inset out of the shop panel's way
    because the panel is `min(1100px, 96vw)` — at the widths where an inset
    would be needed there is no gutter to inset into, so the honest fix is to
    look deliberate rather than to look like a bleed-through.
11. **"THE FIVE" was jargon that listed three items.** The card says YOUR KIT;
    the phrase now lives in the arming line, with the clause that explains it
    (four slots and an ultimate, three keys today, two padlocked).
12. **Near-duplicate collapse lesson 21s apart.** Beats may declare a TOPIC;
    the first delivery claims it and every other beat on that topic is declined
    wherever it came from — `linger` and the sim's `collapse` tip share
    `TOPIC_COLLAPSE`. Topics survive `reteachPrompts`: the lesson landed.
13. **Cold boot offered seven modes before the player had crawled once.**
    `body.coldboot` (set from the same fresh-crawler read the curriculum
    enrolls on) folds the featured band, the mode grid, the test chamber and
    the whole boards column behind one `MORE WAYS TO CRAWL` link, leaving
    DESCEND as the door. A fold, not a lock, and never set once any history
    exists.

**Still open after this round** (both were `src/sim` changes and that was a UI
round): the guaranteed-affordable floor-1 shelf, and the floor-1 first-run
mercy. **Both shipped in r7 above.** And the critic is right that System pacing is
UNMEASURED: the round-3 battery must sample `#headline` and `#toasts` with
timestamps (the r2 probe read `#banner`, which is the menu bar) and re-shoot at
1280x720 and a 3:2 laptop ratio.

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
- **The DEBUT's knockdown and its HELD clock have never been watched by a
  critic.** r7 shipped the mercy and the shelf and proved both in the sim; r8's
  probe has now watched the SHELF half in the app (40 gold against a 35-gold
  Field Ration, the `browse` alt form correctly unreachable — that hole is
  closed), but nobody has yet been killed on floor 1 under the mercy. The open
  questions are presentational and all of one kind: does the knockdown read as
  GENEROUS or as weightless, does `HELD` read as a decision, does the topped-up
  float read as help or as charity.
- **Floor-2+ curriculum is still unobserved end to end.** r8's probe reached
  floor 2 and watched `obj.saferoom` complete on the shelf, but `obj.show` and
  the `elite`/`boss` depth confirmations have still never been seen by a
  critic. Drive `?test&floor=2`.
  Related, and a design question rather than a bug: THE SHOW is the game's
  premise and it is the LAST step, behind four gates. r6-fix-1 gave the
  premise an early carrier instead of reordering the spine — the `hype` tip
  fires on the crawler's first CRIT and translates to Mordecai's "the cameras
  pay for loud", inside the first ninety seconds — but whether the closer
  should MOVE is still open, and it is the owner's call.
