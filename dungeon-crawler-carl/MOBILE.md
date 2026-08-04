# MOBILE.md — beating Wild Rift on glass

Scope: the 3D host (`iso.html` + `src/main3d.ts` + `src/input/`) on phones and
tablets. The sim is not touched. Everything below maps a finger to the **same
`Intent` the keyboard produces** — no new game rules in the host.

Status: the touch core and the responsive HUD are **shipped**. §5 is now split
into **§5.1 shipped and measured** (every row carries the number that proves it)
and **§5.2 still a target** (nothing measured). Read the split before quoting a
verdict — the old single table read as a scoreboard for work that was not on the
glass, which is exactly the failure a critic caught.

---

## ROUND 2 — WHAT A CRITIC FOUND, AND WHAT IT COST

Round 1 shipped the six §2.0 decisions. A device-driven acceptance round then
found the layer was correct and the SURFACES were not. The five that mattered,
with what actually turned out to be wrong:

1. **A phone player could not buy anything — and the cause was one line.**
   `renderSafeRoom()` did `srPageShop.style.display = "grid"`. An inline style
   beats every stylesheet rule, so the whole one-pane-at-a-time shop treatment
   was silently defeated: `.shop-body` stayed a `244px 348px` grid inside a
   606 px container with the second track holding a `display: none`d pane. The
   shelf therefore lived in 40% of the panel, its first tile row was centred
   below the pane's clip, and **not one `.itile` was hit-testable** —
   `elementFromPoint` at every tile centre returned the DESCEND row or the
   clipped pane edge. The select→detail→BUY chain was never broken; there was
   nothing a finger could press to start it. `tools/mobileshot.mjs --scenes shop
   --drive` now ends that check in a GOLD DELTA, and a "reachable" helper that
   hit-tests instead of trusting a rect — geometry alone is what let the
   previous round measure three tappable tiles where there were none.
2. **The aim indicator was still the placeholder.** `setAimIndicator` took
   three shapes and no numbers, so the host folded six shapes down to three and
   every AoE drew the same 2.0–2.2 ring whatever its real radius. It now takes
   `(kind, from, dir, range, radius, arc)` straight from the `AimSpec`, in
   `src/render3d/aimIndicator.ts`, with §3.1's palette and floors. §5.1 carries
   the measurement; §5.2 keeps the LEGIBILITY row until the §1.6 diff is re-shot.
3. **The harness was lying about multi-touch.** `touchDriver.up()` sent
   `touchEnd` with the STILL-LIVE points instead of the released one, which
   corrupts Chromium's touch stream: after any lift, a second finger makes the
   browser end and re-create the first one. Fixed. **Every multi-finger row in
   §1.1 and the §8.3 exit gate was driven through that bug and is therefore
   unestablished rather than false** — including the `move while casting` FAILs
   on 3 of 4 devices, which an independent re-test could not reproduce.
4. **The CANCEL band was on the wrong hand.** Measured on an iPhone 13: a
   258x58 strip at (146,272) while the cluster occupied x 449–712 — a ~176 px
   cross-screen drag, past the 109 px `aimThrow` — with 92% of its area inside
   the MOVEMENT thumb's zone. See §4.2a for why the obvious repair fails its own
   arithmetic and what shipped instead.
5. **Touch chrome was being injected into every DESKTOP panel.** `attachPanel()`
   and `Segmented` inject unconditionally at module load; every rule that styles
   `.tp-x` / `.tp-done` / `.tp-seg` lived inside `@media (pointer: coarse)`. A
   1600x900 fine-pointer window therefore rendered a 28x25 ✕, a 620x24 pane
   switcher and a 62x24 DONE bar in the browser's default ButtonFace grey.
   Touch is supposed to be additive; this was a straight cost to the desktop
   game, and it is now hidden outside the media query so the class of bug cannot
   recur when the AUTO/ON/OFF toggle flips at runtime.


---

## ROUND 3 — THE TELEGRAPH WAS BEING DRAWN 175x TOO FAR AWAY

Round 2 shipped six correct shapes fed the live `AimSpec`, and §5.1 called the
indicator **better** than Wild Rift's. A device round then projected the live
indicator's own vertices through the renderer's own camera and found that for
six of ten abilities — including **both ultimates** — **0% of them were on the
screen**. Nova landed 455 world units from a crawler at (50.79, 62.32);
cataclysm landed 1050. The ratio 2.308 is exactly `cataclysm r6 / nova r2.6`,
and the implied |dir| of 174.9 px is exactly `hypot(150, 90)` — the harness's
own drag, to one decimal place.

**One line, and it had been there since the first touch commit.**

```ts
const dir = touchHeld.aimDir ? isoRotate(touchHeld.aimDir) : p.facing;
const at  = { x: p.pos.x + dir.x * place, ... };   // `place` is in TILES
```

`touch.ts` returns `aimDir` as the RAW PIXEL VECTOR (`current - origin`, never
normalised) and `isoRotate` is a pure rotation, so `dir` carried a 110-175
magnitude while the `p.facing` fallback was unit. Every PLACED shape
(`isPlacedShape` = ring | scatter | arrow: nova, orbit, cataclysm, airstrike,
cutto and **dash**) was therefore placed at 110-175 times its real distance.
Line, cone and chain survived on an accident: `aimPlacement()` returns 0 for
them, and the renderer reads their direction through `atan2`, which discards
magnitude.

Three things this cost, all of which had been recorded as wins:

* **§5.1's `Indicator | better` row.** Withdrawn. A shape nobody can see is not
  a verdict against anybody.
* **§1.6's legibility diff.** It was measuring a degenerate box in the far
  distance, which is why "the indicator's contribution is at or below the scene
  churn" reproduced no matter what the palette did.
* **HANDOFF's "the telegraph reads".** It did not.

**What fixed it, and why not "remember to normalize".** Direction and anchor
are now derived together by `aimAnchor()` in `src/input/aimSpec.ts` — one pure
function, given the spec, the crawler, the rotated drag and the frac — and
`test/aimTelegraph.test.ts` projects the result through an iso camera rebuilt
from `THEME` and asserts the shape's box lands on a real device viewport, for
every shape, four drag directions, frac 0 / 0.5 / 1, on four devices. It also
carries a REGRESSION row that reproduces the shipped arithmetic and asserts it
is off the glass, so the test's own sensitivity is demonstrated rather than
assumed.

Measured after, on a 750x342 iPhone 13 with real touch held through the frame
(`tools/_mobile/r3.mjs`, `r3-iphone13-land.png`), as the fraction of the
telegraph's projected vertices inside the viewport:

| shape | drag up | down | inboard | outboard |
|---|---|---|---|---|
| `arrow` (dash) | 79% | 94% | 100% | 100% |
| `line` (bolt) | 78% | 92% | 100% | 100% |
| `ring` (cataclysm, the ultimate) | 100% | 100% | 100% | 100% |

Was 0% for the ring and 8.1% for the line, in every direction, on every device.

### The camera now leads the aim (§3.4)

The line's residual — 78% on an up-screen drag — is not a bug in the shape, it
is a frame problem: the camera shows 8.5 tiles of world above the crawler and
bolt reaches 14.4. A phone player was committing a full-reach skillshot without
seeing where it ended (`lr2/iphone13-land-aim-line.png`: the box started at
x = -134). So while a drag is live the camera slides up to 4.2 tiles along the
aim and widens the ortho frame up to 22%, easing both ways and returning the
instant the finger lifts — the same borrowing the boss layer already does, and
presentation only. That is what moved the line's up-screen box from
(348,-202)-(402,169) to (348,-6)-(402,235).

### Four other round-3 findings, and what each turned out to be

1. **Flick-to-dash fired on 1 of 4 profiles — and it was the HARNESS.**
   Instrumented, the page received every dispatched `pointermove` (4 dispatched
   → 4 delivered, 4 raw samples, gaps [16,16,16] ms): there was no coalescing
   and no lost sample. `FLICK_DEBOUNCE_MS` is judged on EVENT time, and the
   driver's virtual clock only advances when the script calls `tick()` — so
   five profiles driven back to back all landed inside 350 ms of each other in
   the page's view and every one after the first was correctly debounced. The
   battery now advances the clock between profiles, and **5 of 5 fire on both
   an iPhone 13 and an iPad Pro 11** (`tools/_mobile/r3flick.mjs`).
   The recogniser did have a real defect, and a different one: a 55 px-radius
   thumb STIR at 900 px/s stepped 14.4 px per sample against the iPad's 14.3 px
   floor and dashed — a false positive by a tenth of a pixel, clean on an
   iPhone only because its floor is 16.8. A threshold that a device's stick
   radius decides is a coincidence, not a threshold. The latch now also
   requires the run to have GONE somewhere: `FLICK_MIN_NET_R = 1.2` radii of
   net travel at `FLICK_STRAIGHTNESS = 0.93` straightness, and it fires on a
   fast RUN as well as on two consecutive samples so the browser's delivery
   rate cannot decide whether a dodge happens. Every measured profile still
   fires; the stir never does, on either device.
2. **Move-while-aiming "failing on iPad in 2 of 2 runs" did not reproduce.**
   Two real fingers, four directions, two independent runs per device: the
   phone kept 4.25-9.56 tiles in every direction of both runs. This is the row
   that would have invalidated the per-pointer-role architecture, so it is
   worth saying plainly what it is: unreproduced, on a driver that has itself
   been corrected once (§0's `touchDriver.up()` note).
3. **"One aimed cast in four produced no cast" did not reproduce either — but
   it is now instrumented rather than argued.** From outside, a refusal, a
   queue expiry, a deaf modal gate, a re-entrant pointerId and a cancel are all
   the same silence, which is why an intermittent dropped cast is the worst
   class of touch bug: the player blames themselves. Every chip press now
   records a `CastVerdict` (`src/input/touch.ts`) naming which of the five it
   was, with the FSM state, the leak-corrected travel and the armed flag at
   release, read by the harness through `debug.touch.verdicts`. Driven 40 times
   per slot on two slots: **80 of 80 produced a cooldown, and all 80 verdicts
   read `aimed`.**
4. **Target selection was genuinely invisible, and now is not.** `grep
   lockedTargetId src/` returned the tap handler, `smartAim` and the
   clear-on-death, and no renderer call: the lock steered `pickTarget` and lit
   the LOCK chip for four rounds while nothing appeared on the monster. There
   are now two markers, deliberately different because they answer different
   questions — a persistent white BRACKET on the locked target (not a ring: the
   enemy ground telegraph is already a ring), and a transient cyan reticle that
   flashes for 420 ms on whatever the smart cast just chose. Measured, the
   bracket sits 0.00 tiles from the monster it belongs to.

### And one control was painted on the character

`#t-map` measured 51x51 at (370,152) on an iPhone 13 whose crawler projects to
(375,150) — the MAP chip on the crawler's chest, inside a cluster bounding box
of 323x174 (43% x 51% of the screen) that contained the character outright. The
iPad was clean for a reason that had nothing to do with intent: a tablet's
comfortable arc simply cannot reach the middle of an 1194 px slab.

The layout now carries a **crawler keepout** (`crawlerKeepout()`), sized to the
character rather than to a taste — ±7.5% of width and ±13% of height around the
viewport centre, which is the one region whose contents are known in advance
because the camera puts them there. Chips escape it outboard or downward, never
upward (that is the read band), and a chip that cannot escape makes the pack
FAIL so the size slider steps down — the same "the slider is a request"
treatment §4.2a already applies. `test/touchLayout.test.ts` asserts no combat
or nav control's 44 px hit rect intersects the keepout, on six viewports x two
hands x eight slider positions.

### The desktop gate was manufacturing its own FAILs

`tools/_mobile/deskdeep.mjs` reported 2 FAILs ("ability keys 1-4 each cast",
"F fires the ultimate") and HANDOFF recorded them as "a bindings mismatch that
predates this track (verified by stashing)". It is neither. The probe used
`page.keyboard.press(k)` — a ~10 ms key edge — against a host that samples the
keyboard once per sim step on a page running at ~3 fps under SwiftShader, which
is precisely the gotcha CLAUDE.md documents ("hold keys >= 450 ms"). Stashing
could never have shown a bindings mismatch, because the branch was never the
variable. The probe now holds for 520 ms, and all five ability keys fire.
A gate that manufactures FAILs is worse than no gate: it is how a real
regression eventually gets waved through.

---

## ROUND 4 (mobile-wr) — THE FIX ROUND: four blockers, six majors, and the STYLE half

The wr-a/wr-surf audit round found the layer correct and the NEW SURFACES and
the SKIN not. This round fixed all four blockers, all six majors, and shipped
the control skin. Verified with real CDP touch on iPhone 13 / iPad Pro 11 /
Pixel 5: `tools/_mobile/wrfix1.mjs`, **54 checks / 0 FAIL** (one WARN below),
frames + report under `tools/_mobile/wr-fix1/`.

**Blockers.** (1) The RESULT CARD's sharesheet was a trap on a phone — buttons
at y=558 on a 342px glass, no scroll, no backdrop close. The card is a flex
column now: `.sbody` scrolls, the action rail is pinned (all four actions
measured 165x58, hit-tested), `attachPanel` gives it the ✕ / backdrop / swipe.
(2) Top-menu dropdown taps ALSO registered as world taps at the row's centre —
`isGameplayTarget` now files `.topmenu`/`.topbtn` as UI wherever they hang.
(3) Tap-to-lock: `measureChips` caches measured while a chip's layer was
hidden poisoned the router with 0x0 rects at the origin (controlAt said null
where the LOCK chip visibly was — the DOM path then ate the tap); zero
measurements now fall back to the zone table, and `screenTapTarget` grants a
moving target a lag allowance (`TAP_LAG_S` x its own speed in screen px) so
poll latency cannot make a runner un-lockable. (4) THE RUSH tile on compact:
the menu footer is gone on compact AND the compact masthead slimmed
(`--hero-h` 44, welcome line dropped) so the funnel's two public tiles sit
fully on a 293px glass; the top-menus themselves now scroll
(`max-height: calc(100vh - 64px)`) so the CRAWLER menu's last rows exist on
compact at all.

**Majors.** READY is 220x48 everywhere; the CRAWL LEDGER got `attachPanel`
closers (✕ verified closing it by touch on all three devices); the K panel's
perf row is drag-scroll reachable and cycles under a thumb; the touch settings
rows render as `.kb-row ctl-row` (measurable by the same probes as every other
row) and HOLDING a layout stepper drops the panel to a 0.14-opacity veil so
the cluster previews live underneath (wr_01/wr_06's editor idea in our
grammar); `#bosscall`'s 236px floor yields to `min(236px, 34vh)` so the
marquee stays off the controls on short screens; the recap's action rail
split — only RUN IT BACK / NEW CONTRACT pin (one opaque 67px row), the other
three flow with the copy they belong to, and the desktop rail is reassembled
byte-identical via `display: contents` + `order`.

**The skin (wr_01-04, decided against the frames, drawn in house language).**
Chip faces are dark glass (radial rgba stack) with the identity in a 2px gold
rim; the rim is the state channel — bright gold ready, dimmed bronze cooling
(icon recedes with it), warm bloom on the ultimate. Cooldowns carry NUMERIC
seconds on the face (`.cdnum`, tabular, touch-only — wr_04's '42') over the
existing sweep. Three size tiers measured on every device (iPhone:
ult 95 / attack 82 / abilities 68 / flask 63 / LOCK 45 / MAP 41): satellites
paint a tier down through a new `vis` field on `ControlRect` — the HIT rect
never drops below 44 (the router pads), only the paint shrinks. The LOCK chip
is an icon now (drawn reticle, no words on chips). The stick nub is a
hard-edged disc — dark outline ring + lit rim — that survives bright floors.
And every live aim draws wr_04's missing piece: a cyan MAX-RANGE boundary
around the CRAWLER (`buildRangeRing`, faint fill only under 8 tiles), keyed
and disposed like the indicator, cleared on lift.

**Two non-touch fixes that fell out.** three.js's `compileAsync` poll crashes
with `reading 'isReady'` when a polled material is disposed mid-flight (the
late shader-catcher compiles exactly when telegraph teardowns mint and destroy
materials) — the poll is now ours, with the one guard three forgot, and the
aim layer's materials are shared singletons that are never disposed (each drag
frame was minting ~8 and disposing the previous 8). The phone-boot pageerror
is gone from the battery.

**The WARN, on the record.** iPad tap-lock needed one re-aimed tap under the
harness: with monster AND crawler world-static and clickMove null, the
projection still sweeps ±40px over seconds (slow camera motion), and
SwiftShader's ~1fps polling spans a whole second of it where a 60fps device
spans ~1px. Forensics in the probe comments; a human thumb re-aims
continuously, which is what the retry models.

**Desktop guard.** `deskdeep.mjs`: identical scores on this branch and on the
stashed baseline (the two long-standing FAILs — `ability keys 1-4` counting
melee/stuntdouble "NOTHING", and F-on-injunction attribution — reproduce at
0/4 on the BASELINE and 2/4 here; pre-existing probe semantics, not a
regression; the probe needs a cd-attribution fix on the desktop track).
`touch close chrome is NOT injected on a fine pointer` still PASSES, and the
recap/sharesheet rails render desktop-identical by construction.

---

## ROUND 5 (mobile-wr r2) — THE SYSTEM'S VOICE WAS BEING CUT OFF MID-WORD

The wr acceptance round (ac-wr-r1) found three majors on the NEW surfaces, all
presentation, all phone-class. Fixed and verified with real CDP touch on
iPhone 13 / iPad Pro 11 / Pixel 5: `tools/_mobile/ac_wr_r2.mjs` (24 checks /
0 FAIL, frames + report under `tools/_mobile/ac-wr-r2/`) plus a full re-run of
the surfaces battery (`ac_wr_surf2.mjs`, 26 checks / 0 FAIL, `ac-wr-r2-surf/`).

1. **The COURTESY card's two-line clamp was the wound, and it swallowed its
   own dismiss.** On compact/phone the r4 treatment clamped `.tut-body` to two
   lines with `overflow: hidden` — measured on a live fresh-crawler run,
   47px shown of 179px of the ONRAMP's teaching line (73% clipped), the
   centre plate reading 'BOX. It will not' mid-word — and because GOT IT
   lived INSIDE the clamped body, the button was painted out of existence
   while still claiming a 78x44 rect (hit-test: FAIL). The clamp is gone: the
   card spans the full measured plaque band (--card-w, the 36ch compact cap
   deleted), a 44px head strip carries the ribbon (abbreviated to SYSTEM via
   `.tut-hx` on phones) with GOT IT as a permanent 100x44 cell, and the body
   wraps in full below. **GOT IT docks at the band's LEFT end** — the first
   fix docked it right and its rect landed exactly on the ☰ glyph chip at
   (491,35) on a Pixel 5, so the CRAWL LEDGER tap dismissed a courtesy
   instead; the card's *glass* may cover the centre chips (it is
   pointer-transparent and taps pass through), its one real *button* may not.
   Auto-dismiss now scales with the line (55 ms/char, 7-14s). Worst line
   measured 93px of card on a Pixel 5, nothing scroll-clipped on any class.
2. **The death moment now owns its pixels.** The high-priority banner
   (`#headline`, top max(19%,152px)) bled through the 0.9-alpha YOU ARE DOWN
   card into the countdown, and CONCEDE's bottom sat below the home-indicator
   inset. On coarse pointers the card is opaque (a modal moment is not
   chrome), centres in the inset-aware viewport
   (`calc((100dvh - --sa-b)/2)`), and the two doors sit side by side again —
   two 187x44 thumb targets beat a stacked pair running off the glass. While
   it is up, `body.downed` stands the headline AND the courtesy card down
   (visibility, coarse-only) — same standdown grammar as `body.bossplate`.
   Measured: card 420x171 fully inside the glass on both phone and tablet,
   banner live in the DOM with `visibility: hidden`, CONCEDE lands by touch,
   SEAT FREED, RUN IT BACK unaffected.
3. **The standings chip hangs from the measured plaque fact.** `#party` sat
   at a constant top (96/78px) while the plaque and XP under-rail breathe with
   content — measured 3659px² of collision with the plate on an iPad Pro 11
   and a visible collision mid-race on an iPhone 13. Phone classes dock it at
   `--xp-top + 14`; tablets at `--xp-top + 158`, under the minimap puck that
   owns their right rail. Zero intersection with plate, rail and minimap on
   all three devices, mid-race.

**The desktop track owes one fix** (BACKLOG.md 1b, NOT this branch): slot-1
melee by SPACE and slot-4 stuntdouble by C cast nothing — no damage, no
cooldown, no decoy with a monster staged 0.9 tiles out and keys held 1.4s —
identically on baseline `focus`. `deskdeep.mjs` on this branch: every other
check PASSES, touch chrome still not injected on a fine pointer.

**Probe lesson kept.** The surfaces battery's perf-row check FAILed while the
dedicated probe PASSed: its scroll drag ended as a fling and it tapped
coordinates read 400ms earlier, mid-deceleration. Scroll drags in a probe end
SETTLED (finger still 240ms before lift, `ac_wr_perfrow.mjs` semantics) and a
moved row gets one re-aimed tap — a human thumb does both without thinking.

---

## ROUND 6 — REAL GLASS DISAGREED WITH EVERY GREEN BATTERY

The owner played production on a real iPhone (Safari, landscape) and reported,
verbatim: *"The mobile experience for controls looks much worse than wild
rift. They all spread out and take up so much space. You also can't move and
press an action at the same time. The mobile controls we had before all the
AAA looping were much much better than this."* Every emulated multi-touch
battery was green at the time. Both halves of that report were real, and one
of them was structurally invisible to the harness.

### 6.1 The multi-touch killer: we were suspending ourselves on `gesturestart`

`touchShell.bindAuthority()` treated iOS `gesturestart` as "the OS has taken
the finger" and raised the `system-gesture` suspend reason — which
`cancelAll()`s every live pointer and then holds input deaf until 120 ms after
`gestureend` plus the 120 ms modal gate. But **Safari fires `gesturestart` the
moment a SECOND finger touches the glass** — on every two-finger moment,
regardless of `touch-action`, regardless of whether a pinch ever engages.
Move-thumb + ability-thumb IS a two-finger moment, so on a real iPhone the
layer cancelled both fingers the instant you tried to move and act at once.
Chromium **never fires GestureEvents**, so no CDP battery could ever see it:
the emulator was not lying about our FSM, it was silent about Safari's.

The fix follows the principle the adjacent `contextmenu` comment already
states: *a gesture we preventDefault()ed is a gesture the OS did NOT take.*
The handlers now `preventDefault()` (which is exactly how Safari is told to
keep native pinch-zoom out) and raise nothing. If Safari ever truly takes the
fingers it says so per pointer with `pointercancel`, and `onUp()` refunds each
role individually. Verified as far as emulation can:
`tools/_mobile/ios_gesture_probe.mjs` drives real CDP two-finger play and
dispatches synthetic `gesturestart`/`gesturechange` storms through the same
listeners Safari would — 11 checks / 0 FAIL: no suspend reason raised, the
stick keeps its pointer through the storm (30.96 tiles), and a second-finger
chip press mid-storm casts while movement continues (8.37 tiles).

Three defensive fixes rode along, all aimed at the same class of
real-iOS-only failure:

* **The preventDefault discipline.** iOS makes document-level touch listeners
  passive BY DEFAULT, and pointer events cannot veto Safari's recognisers at
  all — when they stay live, the second finger's touchstart engages pinch
  arbitration and Safari answers with `touchcancel` on the FIRST finger.
  `TouchController.bind()` now also binds non-passive capture-phase
  `touchstart`/`touchmove` and preventDefaults ONLY gameplay-surface touches
  (same predicate as the pointer router), so panels keep native scrolling.
* **Stale pointer ids route instead of dying.** A pointerdown for an id the
  role map still holds means the old lift NEVER arrived (backgrounding, a
  system sheet). The old guard swallowed the new press — one lost pointerup
  made a spot on the glass permanently deaf on any browser that reuses ids.
  The stale role is now refunded (`dropRole`) and the new press routes;
  `test/touchIntent.test.ts` "2.9x" holds all three cases.
* **Dead roles expire.** `cancelAll()` marks roles dead so the trailing lift
  is eaten, but the TTL reaper skipped dead roles entirely — they could block
  their id forever. They now expire at `POINTER_TTL` like everything else.

### 6.2 COMPACT is the default layout, LARGE is the choice

The sprawl was real: on the owner's Safari-chromed viewport the cluster read
as eight full-size coins across half the screen, two of them LOCKED slots —
one of those the largest disc on the glass (the empty ultimate) — with the
home indicator over the bottom row. The classifier was right (`compact` is a
ROOM tier and Safari-chromed landscape is short); what was wrong is that
nothing downstream got more economical for it.

`LayoutPrefs.preset` (persisted in TouchPrefs, stepper in CUSTOMISE CONTROLS,
live-preview PEEK): **`compact` is the default** — an absent preset in an old
pref blob computes as compact, not as what it looked like before. Compact is
the same arc grammar with the economy turned up: chips at the low end of the
9-11 mm band (`CHIP_MM_COMPACT = 9.2`, 56 px on a phone — hit rects still
floor at 44), a compressed radial ladder (`ARC_CORNER_COMPACT`: outermost
combat chip 1.32 rf vs 1.42, map 1.48 vs 1.56), quieter hero tiers (ult 1.28
vs 1.42), satellites a further tier down (0.52 vs 0.64), and a 0.52 band
share vs 0.58. Locked ability slots stop advertising absence: `hudLayout`
paints an `.empty` slot at 40% of its tier (floor 22 px) and the CSS quiets
it to a faint socket. Measured on an iPhone 13 landscape: cluster bounding
box **270x154 compact vs 311x172 large** (–22% area), no control crossing the
21 px bottom inset. `test/touchLayout.test.ts` "layout preset" pins all of
it: compact strictly smaller on every device, never below MIN_TARGET, ability
chips >= 9 mm where the pack has room, reach invariant intact, bottom inset
clear. Frames: `tools/_mobile/compact-r1/` (`compact-l3.png` is the
locked-slot demotion; `compact-l12` vs `large-l12` is the footprint).

### 6.3 `?touchdebug=1` — the owner's phone is the instrument now

Emulation cannot fire a native GestureEvent and cannot prove what Safari
delivers, so production carries a 30-second diagnostic
(`src/input/touchDebug.ts`, flag-gated, presentation-only, passive
listeners): live touch count with a ring drawn at every DELIVERED touch
point, the FSM per zone (`stick DOWN · btn aiming(2) · roles 2:stick 3:chip ·
suspend [...]`), and a rolling last-5 event tail (start/end/CANCEL with
pointer ids, plus `gest:*` lines when Safari's recogniser wakes). One
screenshot while holding move + tapping an ability answers the question no
battery can: **did iOS deliver the second touch at all, or did our machine
drop it?** Two dots + `suspend []` + a working game = fixed. One dot while
two fingers are down = Safari ate the touch before the page saw it (a
`TOUCHCANCEL` line right after `gest:start` names the killer). The harness
reads the same snapshot via `__dcc.touch.fsm()`.

### 6.4 What round 6 cannot claim

The gesture fix and the preventDefault discipline are **verified against our
own listeners, not against Safari** — Chromium cannot fire a native
GestureEvent, does not run WebKit's touch arbitration, and reports
`maxTouchPoints` wrong under emulation (§0). The claim "move-while-acting now
works on the owner's iPhone" is therefore UNVERIFIED until the owner holds
move + taps an ability on production, ideally once with `?touchdebug=1`. That
screenshot is the round's real exit gate.

---

## ROUND 8 (mobile-wr r4) — THE ARRANGEMENT WAS RIGHT; THE SIZES WERE NEVER MEASURED

The owner, on the r3 rebuild: *"oh the screen shot looks closer! But the boxes
are too big and overlaping."* Arrangement accepted, two faults — and both were
things r3 CHOSE, from a reference it looked at instead of measuring. So this
round measured it. Off `wr_01_hud_default_layout.jpg` (1024x461, default
layout) and confirmed on `wr_03_aim_tidalwave.jpg` (1024x458, live):

| measured | Wild Rift | ours before | ours now |
|---|---|---|---|
| ability disc / viewport height | **0.125** | 0.164 (+31%) | **0.126** |
| basic attack / viewport height | **0.185** | 0.246 (+33%) | **0.187** |
| ultimate / viewport height | **0.130** | 0.200 | **0.140** |
| neighbour pitch / disc diameter | **1.24** | 0.86 | **1.26 - 1.36** |
| gap between neighbouring discs | +0.24 disc | **MINUS 8 px** | +11 to 15 px |
| fan ring radius / disc diameter | 2.09 | 1.39 (dead formula) | 2.16 |
| fan angles about the primary | -13.6 / 19.9 / 57.3 / 91.9 | -10 / 22 / 54 / 92 | -14 / 20 / 57 / 92 |

**1. THE DISC IS A SCREEN QUANTITY; THE TARGET UNDER IT IS A HAND ONE.** §2.0's
register had one column too few. `CHIP_MM` is a correct TARGET size and a wrong
DISC size, because Wild Rift runs full-screen and we run under ~50 pt of Safari
chrome — the same millimetre is a bigger share of our frame, which is exactly
the 31% the owner could see. The chip is now `min(hand ceiling, reference share
of the short edge)`: on a phone the FRAME binds (42.8 px on an iPhone 13, under
its own 44 px target — the split `ControlRect.vis` has always existed for), on
an iPad the HAND binds and the tablet keeps the 47.9 px it already had. One
formula, right at both ends, and no hit rect moved.

**2. "EDGES VISUALLY KISS" WAS A MISREADING, AND IT COST THE STRICT INVARIANT.**
The reference gap is a quarter of a disc; r3 shipped 48 px on 56 px chips, i.e.
8 px of overlap. Worse, it had relaxed the axis-aligned no-overlap rule to a
centre-distance floor *specifically to permit* that overlap. Both are reverted:
`FAN_PITCH = 1.24` is the measured number, and **no two padded 44 px hit rects
may overlap** is back — verified across the declared matrix (7 viewports x 2
hands x 8 slider positions x 2 presets: zero overlaps). That restores by
construction the property whose loss caused the Pixel 5 "tapping DASH drank a
potion" bug: a rect can never contain a neighbour's centre.

**3. THE RING IS SOLVED, NOT CHOSEN (`cornerRing`).** r3's authored ring
formula was dead code — a floor derived from the 44 px rects (83.4 px) was what
actually bound on every phone, so the fan's spacing was whatever relaxation
converged to. The ring is now the smallest radius satisfying all three debts at
once: clear the primary, hold `FAN_PITCH`, keep the padded rects axis-separated.
Solving the last two together is why the fan angles are now `wr_01`'s own — on
r3's eyeballed 22->54 step the chord runs diagonally, worst case for an
axis-aligned rect, and would have forced a 106 px ring where the pitch wanted
96; at the measured 20->57 the two rules land within 1% (91.6 vs 92.0) and the
ring comes out at 2.16 diameters against the reference's 2.09.

**4. THE CLUSTER IS CORNER-ANCHORED, NOT THE PRIMARY.** `wr_01`'s first ability
sits 30 px *below* its basic attack's centre and its rim hangs 17 px past it,
which is why WR's whole corner floats ~50 px off the frame edge. r3 pinned the
primary flush, so that chip landed 13 px outside the safe box, the box clamp
shoved it back, and the CLAMP set the pitch (46 px where the ring asked 56).
The bounding box is flush now; the primary is still the corner chip.

**5. RULE 2's BUDGET HAS AN ARITHMETIC FLOOR, WRITTEN DOWN.** The 0.57/0.58
share still governs 95 of 96 matrix cells. In one (Pixel 5, x1.4 buttons, the
inset slider at its 32 px maximum) it asks for 130.5 px of a cluster that
cannot go below 136: three ranks of padded 44 px targets is the shortest nine
controls can be once every disc is already at the floor. r3 met that number
only by letting two hit rects intersect — which is the trade the restored
invariant refuses. The budget is now `max(share, 3 x (MIN_TARGET + 2))`.

Also fixed, found by the restored invariant: on a LEFT-handed corner grip the
zero-area cancel band was parked at `clusterLeft`, i.e. the far side of the
cluster, where the clamp could drop it inside the primary's own hit box. A
degenerate rect still has a position; it now takes the inboard edge on both
hands. And the ultimate came down from 1.22 to 1.12 chips (0.140 of viewport
height against the reference's 0.130) — still the biggest fan chip, no longer
the second-biggest thing on the glass.

Untouched, as briefed: the touchShell gesture handlers and FSM (the iOS
multi-touch fix), the arrangement itself, safe-area insets, compact-as-default,
the WR skin, and the size/mirror/preset customisation.

Verified: `test/touchLayout.test.ts` 64/64 with the pinned numbers rewritten to
the new contract (the measured ratios, the strict overlap ban, the cluster-flush
anchor, the extent floor); full vitest **1278/1278**; tsc clean;
`battery_focus.mjs` 5/5 (identical to the pre-change baseline) and
`ios_gesture_probe.mjs` **11/11** against the live layout, which measures the
compact cluster at **241x200** against r3's 268x194 — smaller discs AND a
smaller footprint. Real-GPU frames in `tools/_mobile/wr-r4/`; the owner's
side-by-side with the ratio table is
`~/.claude/jobs/d43e193f/tmp/wr-sidebyside-2.png` (`wr_shot.mjs` /
`wr_composite2.mjs`).

---

## ROUND 7 (mobile-wr r3) — THE ARRANGEMENT WAS THE THING, AND THREE ROUNDS NEVER TOUCHED IT

The owner, after the compact round deployed: *"It still doesn't look wild
rift... that's what the old controls looked like."* The diagnosis, binding:
rounds 4-6 skinned the chips (correctly) and never changed the ARRANGEMENT.
Wild Rift's control corner is a specific geometry — one large basic-attack
disc anchored IN the corner, 3-4 abilities fanned in a tight arc around it
(edges visually kissing), the ultimate distinct within the fan, small
utilities tucked inside the organism — and ours was two shallow ranks of
similar coins. This round rebuilt the corner-grip cluster to THAT geometry
(`ARC_CORNER`/`ARC_CORNER_COMPACT` in `src/input/touchLayout.ts`):

* **The PRIMARY is melee (slot0), and it is the corner.** `rf: 0` — the
  cluster pivot IS its centre, parked 2 px off the safe corner, 1.5x chip
  size (84 px on an iPhone 13, the same ~25%-of-height WR's attack takes).
  The thumb rests on it; `fromPivot` semantics unchanged.
* **The fan is ONE ring, chip-scaled.** slot1-3 + the ultimate at ring radius
  = primary radius + chip radius + `RING_GAP`, sweeping -10 deg (WR starts at
  about -13) to 92 deg. The ultimate: top of the fan, 1.22-1.26x — distinct
  in position AND size, exactly `wr_01`'s button 4. The ring is deliberately
  NOT reach-scaled: the fan must hug the primary whatever the thumb length;
  reach is still asserted per control against `comfortable`.
* **Utilities tucked, not orbiting.** Flask + context pill run inboard along
  the bottom edge (WR's summoner-spell row); LOCK and MAP are small sockets
  in the fan's outer notches (where WR parks its level-up pips). Locked
  ability slots keep the r6 socket demotion — now they are sockets *within
  the fan arc*, not free-floating coins.
* **The spacing metric went circular, and this is the round's one trade
  against the old spec.** The axis-aligned no-box-overlap invariant forbade
  the WR look outright (a tight arc's diagonal neighbours always overlap
  boxes). The floor is now a CENTRE DISTANCE: `max(46 px, 0.82 x mean hit
  size)` — the router resolves by nearest centre, so every chip keeps an
  exclusive Voronoi corridor >= 46 px wide, and no chip's padded rect may
  ever cover a neighbour's centre (the Pixel 5 "tapping DASH drank a potion"
  property, kept structural). Adjacent fan discs may visually kiss (measured
  iPhone 13: 48 px spacing on 56 px chips, ~8 px of edge overlap — `wr_01`'s
  own spacing to the pixel). The 44 px hit floor itself is untouched.
  **[REVERSED in ROUND 8 — the parenthetical is wrong. `wr_01`'s spacing is
  1.24 disc diameters, a real gap; nobody had measured it. The trade this
  bullet describes bought nothing and the strict invariant is back.]**
* **Short glass squeezes the fan before it shrinks a chip.** On a Pixel 5 (or
  a player-padded inset) the circular fan cannot meet rule 2's extent budget;
  the fan goes ELLIPTICAL (`sy`, refined against the measured extent) — which
  is what WR itself does: `wr_01`'s ring radii measure 180 -> 113 px climbing
  the fan. Chips step down 5% only when a 0.55 squeeze still cannot fit.
* **The fan track.** `#t-fanarc` (`ui/hudLayout.ts`): a faint annulus under
  the ring, conic-masked to the fan's span, squeezed by the measured ellipse
  — the one paint that makes nine controls read as a single quarter-circle
  unit. DOM-ordered under the chips; stylesheet keeps display authority
  (modal/cine/checkin stand it down); corner grips only.

Kept whole: the FSM and touchShell gesture handlers (untouched), aim
throw/cancel ordering, safe-area insets, compact-as-default, the skin
(rims/sweeps/cdnum/pips), the customisation surface (size/mirror/preset all
operate on the new geometry — mirroring is still one reflection). Side grip
(tablets) keeps its measured side-fan posture.

Verified: `test/touchLayout.test.ts` rewritten to pin the NEW contract
(primary anchored + biggest on corner; ult top-of-fan + biggest fan chip;
circular spacing floor + centre-coverage ban; elliptical adaptation), 63/63;
full vitest 1277/1277; `battery_focus.mjs` 6/6 and `ios_gesture_probe.mjs`
11/11 against the live layout (compact 268x194 vs large 301x189 on iPhone
13); real-GPU frames + the owner's side-by-side composite:
`tools/_mobile/wr-arr/` and `~/.claude/jobs/d43e193f/tmp/wr-sidebyside.png`
(`wr_shot.mjs` / `wr_composite.mjs`).

---

**Read §2.0 first.** Two design-critic rounds (6.5, then 7.0 against an 8.0 bar)
found six places where this document described an intention instead of deciding
one. §2.0 is the decision register that settles all six with numbers, and it
outranks every other section — including sections written before it. Four of the
six turned out to be the same mistake, which §2.0 names.

**All six decisions are now IMPLEMENTED** (branch `trk-mobile`), with the tests
that hold them:

| # | code | test |
|---|---|---|
| 1 tap/aim, leaky origin | `AbilityButton.move()`, `AIM_SLOP`/`ORIGIN_LEAK` in `src/input/touch.ts` | `test/touchIntent.test.ts` "2.4a" — the five speed rows, byte-identical Intent for 40 ms vs 3 s, frozen origin |
| 2 aim throw | `aimThrow`/`cancelRadius` in `computeZones()` | `test/touchLayout.test.ts` — the mm table to the pixel, and the ordering invariant at every slider position |
| 3 world tap ceiling | `TAP_MS` deleted; one verdict in `TouchController.onUp()` | `test/touchIntent.test.ts` "2.5a" — 11 durations, exactly one Intent each, never silence |
| 4 reach model | `reachArcs()`, `MM_PER_PX` | `test/touchLayout.test.ts` — the §3.2 instance table |
| 5 pivot/fan/chip | `ARC_CORNER`/`ARC_SIDE`, the cluster box, the packing loop | `test/touchLayout.test.ts` "the §4.2a cluster invariants" — 6 viewports x 2 hands x 8 slider positions |
| 6 input authority | `suspend()`/`resume()`, `POINTER_TTL`, `TouchShell.bindAuthority()` | `test/touchIntent.test.ts` "2.9a" + `test/panels.test.ts`, which parses the screen-zone map |

Driven on the device matrix with REAL touch (`--drive`, CDP
`Input.dispatchTouchEvent`, never `page.mouse.*`): `tools/_mobile/i5` is
**19 PASS / 0 FAIL** on iPhone 13 landscape, and `tools/_mobile/i4` carries the
four-device sweep. Newly green versus §1: *safe areas — every HUD element
clears the hardware insets* (was 7 intrusions, §1.4); *modal opens mid-aim, then
the finger lifts — casts once it closed: none* (was §1.7's queued detonation);
*thumb lands on minimap → moved 3.33 tiles* on the iPad (was 0.05 tiles and a
stray ping, §1.2); and *world: long press pings* / *tap to move*, which had no
touch path at all (§1.8).

Three places where implementation contradicted the text, decided in code and
recorded here rather than quietly:

* **A corner grip ships NO cancel band at all (round 2).** Round 1 pinned it to
  the bottom-inboard corner; measured on an iPhone 13 that put a 258x58 strip at
  (146,272) while the cluster occupied x 449-712 — a ~176 px cross-screen drag,
  well past the 109 px `aimThrow`, so the band was decorative — and 92% of its
  area lay inside the MOVEMENT thumb's zone, painting a giant CANCEL bar under
  the walking thumb every time you aimed. The obvious repair (inboard of the
  cluster, on the casting side) fails its own arithmetic twice: the gap between
  the stick zone and the cluster is 87 px on an iPhone 13, under the 96 px this
  layout will accept, and a band there sits exactly one `aimThrow` inboard of
  the nearest chip, so every full-range LEFTWARD aim would land in it and
  cancel. `ZoneTable.cancelMode` is therefore `"band"` on a side grip (measured
  0% stick overlap, unchanged) and `"origin"` on a corner grip: return inside
  `cancelRadius` of the frozen press origin, which was already the only cancel a
  phone player could perform — what was missing is that nothing DREW it.
  `touchShell` now paints a ringed ✕ there the moment AIMING starts (measured
  79x79 at (377,221) on an iPhone 13).
* **The corner CANCEL band cannot sit above the cluster.** §4.2a rule 1
  reserves the top 32% of the safe box, rule 2 gives the corner cluster the 58%
  below it, and rule 4 forbids the band from the top 40% — a 44 px strip does
  not fit in the 24 px that leaves on an iPhone 13. Both postures now pin the
  band to a bottom corner of the safe box, clear of the lowest chip by 24 px:
  bottom-**outer** on a side grip (as written) and bottom-**inboard** on a
  corner grip, where the cluster already owns the outer corner.
* **`rf` runs past 1.0 on the corner fan.** Nine controls with a 44 px hit floor
  do not fit in a 172 px quarter-disc that must also clear the stick zone and
  the read band; what fits is two shallow ranks. The reach invariant is
  asserted on `fromPivot` against `comfortable` — the thing the hand cares
  about — and `rf` is only the authoring unit. Landscape phones clear it *only*
  because decision 4 gave them back 31% of arc.
* **The size slider is a request.** At `buttonScale 1.4` the cluster is
  over-subscribed on every phone in the matrix. Rather than let relaxation push
  chips past `comfortable` or into the movement thumb's zone — the old
  behaviour, and both worse than a smaller chip — `computeZones()` steps the
  requested chip size down 5% at a time until the cluster packs. A Pixel 5 at
  1.0x gets 58 px chips instead of 64; that is what a Pixel 5 can hold.

---

## 0. HOW THIS WAS MEASURED — AND WHAT IT CANNOT TELL US

`tools/mobileshot.mjs` is the harness, and every number in §1 comes out of it.
It is not a resized desktop window:

* real Playwright **device descriptors** (`devices["iPhone 13 landscape"]` …)
  with `hasTouch` + `isMobile`, so `(pointer: coarse)`, `devicePixelRatio` and
  the mobile UA all behave as they do on glass;
* all input driven through **CDP `Input.dispatchTouchEvent`** — genuine
  multi-touch, never `page.mouse.*`, which would exercise the desktop path and
  prove nothing;
  **Round-2 correction:** `touchDriver.up()` used to send `touchEnd` carrying
  the points that SURVIVED the lift rather than the point that was released.
  CDP takes that literally and Chromium's touch stream desynchronises — after
  any lift, the next finger down makes the browser end and re-create the first
  one (observed: `pointerdown#6` immediately followed by `pointerup#5` and a
  phantom `#7`). Every multi-finger claim recorded before this fix is
  **unestablished**, not disproved, and must be re-shot before it is used as a
  gate;
* `--guides` paints the **hardware safe-area insets** over the frame (Chromium
  reports `env(safe-area-inset-*)` as 0, so the harness supplies the real
  numbers per device); `--reach` paints thumb-reach arcs from two pivots
  (today's bottom corner, and the side-grip pivot — §4.2a). **The `r8`/`r8b`
  arcs were drawn with the short-edge model that §3.2 has since rejected**;
  they are still valid as *captures of the cluster*, but the arcs painted on
  them are 31% too small on phones and 17% too large on tablets. `--reach` must
  be re-pointed at `reachArcs()` (millimetre model) before the §8.3 gate, and
  the r8 crops re-shot;
* `--drive` runs a **19-check** interaction battery that reads sim state before
  and after each gesture, so "the button lit up" is never mistaken for "the
  ability fired";
* `--probe` dumps the measured rect of every control;
* `--measure` (new) dumps **panel geometry**: grid tracks, overflow and hidden
  scroll, every interactive descendant's size, and the list of close controls.
  §4.5 used to be source reading; it is now measurement;
* the **aim scenes** (`aim-line`, `aim-ring`, `aim-arrow`, `aim-ult`, new)
  press an ability chip, drag past the slop, and hold the finger down through
  the screenshot, then project the live telegraph through the renderer's own
  camera and diff the frame with the telegraph on against the frame with it
  off. The indicator is now photographed and measured, not inferred from a
  matching key name in the scene graph.

Four harness lessons worth keeping.

1. The staged pack kills a level-14 crawler mid-battery and a dead crawler
   no-ops every later check, so the battery installs an immortality watchdog —
   without it, twelve phantom FAILs.
2. SwiftShader runs the iPad's ULTRA backbuffer at ~1 fps and input edges are
   only consumed on a sim step, so the battery settles by **rAF frames**, not
   wall clock, and pins `?quality=performance`.
3. **A scene driver that does not verify is a scene driver that lies.** Rounds
   1–4 shipped "shop" and "constellation" captures that were combat frames, a
   death recap and a level-up draft: `--drive`'s watchdog pins
   `state.status = "playing"` and evicts the safe room; a keypress aimed at a
   panel is swallowed while the crawler is dead; and descending opens the
   SPONSOR DRAFT *on top of* the safe room a frame or two later. `openPanel()`
   now resurrects, presses, verifies and retries, and **throws** if the panel
   never appears. r6/r7/r9 are the first captures of these surfaces.
4. The panel-visibility test must not include `opacity`: the modals fade in over
   ~180 ms and a measurement taken during the fade reports the panel as absent.

**What this harness cannot tell you** — the reason §8.3 now has a real-hardware
gate:

| question | why the harness cannot answer it |
|---|---|
| frame time, input latency, thermal behaviour | SwiftShader. Use `tools/gpuprobe.mjs --use-angle=d3d11`, which is a desktop D3D11 path and therefore not a phone either |
| what preset a real iPhone picks | §7.1's whole argument is about what **Safari** does with `WEBGL_debug_renderer_info`. Chromium-under-emulation is not Safari and has never run this branch |
| whether a telegraph is legible | measurable only as pixels-changed against a noise floor (§1.6). Whether a human sees it is not in scope for a headless run |
| whether a thumb reaches | arcs are geometry. Thumb length, grip and case thickness are not |
| whether a thumb *drifts* | §2.4a's `ORIGIN_LEAK = 40 px/s` is sized against contact-centroid creep, which is a property of skin under pressure. CDP synthesises exactly the coordinates it is told to; it has no skin. Device gate, §8.3 (5) |
| `MM_PER_PX` | the emulator reports the descriptor's CSS viewport and dpr, never a physical size. The table in §2.0 is derived from published panel dimensions, not measured through the browser. Device gate, §8.3 (5) |
| `navigator.maxTouchPoints` | reports **1** under emulation even with `hasTouch: true`; do not gate anything on it |

Reproduce:

```
node tools/mobileshot.mjs --out tools/_mobile/rN \
  --devices iphone13-land,iphone13promax-land,ipadpro11-land,ipad7-land,pixel5-land \
  --scenes combat --guides --reach --probe --drive
node tools/mobileshot.mjs --out tools/_mobile/rN+1 \
  --devices iphone13-land,ipadpro11-land \
  --scenes shop,constellation,sheet,inventory --measure --probe
node tools/mobileshot.mjs --out tools/_mobile/rN+2 \
  --devices iphone13-land --scenes aim-line,aim-ring,aim-arrow,aim-ult
```

---

## 1. AUDIT

### 1.1 The headline

**The touch control layer that exists actually works.** On a clean patch of the
stick zone, with the crawler alive, every core verb lands:

| check (iPhone 13 landscape / iPad Pro 11 landscape) | result |
|---|---|
| floating stick moves the crawler | PASS — 4.68 / 16.15 tiles, stick visual appears |
| hold the melee chip → damage | PASS — pack hp 8873→8400 / 8784→8449 |
| tap an ability chip → smart cast | PASS — `cd.dash` starts |
| press-drag off a chip → aimed cast | PASS — fired `bolt`, facing turned, telegraph shown |
| drag out and back → cancel | PASS — no cooldown started, no cast leaked |
| **move while casting (two fingers)** | PASS — 2.35 tiles kept, second finger on the chips |
| tap the flask chip → drink | PASS — hp 165→412 |
| dash | PASS (as an ability chip) |
| double-tap zoom / text selection / pull-to-refresh | PASS — `visualViewport.scale` pinned at 1, 0 chars selected |

So this is not a rescue job. The skeleton — floating origin, chips-as-buttons
with tap/drag/cancel, per-pointer roles, iso rotation at the seam, device
arbitration against the mouse — is sound and worth building on. What follows is
what is **broken, unreachable, or absent**.

*(Correction from earlier rounds: the multi-touch check used to be driven from
`(0.18 W, 0.72 H)`, which on a phone is under a transient System card — so it
intermittently reported FAIL and was measuring §1.2, not multi-touch. It now
runs from the clear-ground origin and reports what the finger landed on either
way. `tools/_mobile/drive6.log`.)*

### 1.2 Broken: the left thumb does not own the left side

Two elements sit inside `#t-stickzone` (`left:0; top:15%; bottom:0; width:44%`,
z-index 4) with a **higher** z-index, and they eat the movement thumb.

**(a) The minimap.** `body.touch #minimap-frame { left: 12px; top: 96px; }`
z-index 5, 115×115 on a phone, 160×160 on an iPad. Measured hit test at its
centre: `CANVAS#minimap`. Driving a stick gesture there produced **0.05 tiles of
movement and dropped a party ping instead** (`pings 0→1`), on every device
tested, in every battery run including the latest (`drive6.log`).

**(b) Transient System cards.** `#tutorial` is z-index 7 with
`pointer-events: none`, but its children are `pointer-events: auto` — and on
`body.phone` the card is parked at `top: 96px; left: 12px`. Measured element
under the natural stick point (135, 246) on iPhone 13 landscape:
`BUTTON.tut-dismiss`. On the iPad (`body.touch #tutorial { top: 284px }`) the
element under (215, 600) was also `BUTTON.tut-dismiss`, and
`tools/_mobile/r8/ipadpro11-land-combat.png` shows the courtesy card and its
GOT IT button sitting inside the left thumb's arc on an 11-inch tablet.

The CSS comment concedes the trade ("the phone hasn't the height, so the
transient card sits OVER the minimap instead"). What it costs is movement, and
these cards fire constantly — first-contact tips, courtesy explanations,
achievement callouts.

Evidence: `r1/iphone13-land-combat.png`, `r1/pixel5-land-combat.png`,
`r1/iphone13-land-constellation.png` (card covering x 12–234, y 96–266 of a
750×342 viewport), `r8/ipadpro11-land-combat.png`.

### 1.3 Broken: panels are one-way doors — measured

Every number below is `--measure` output, not source reading
(`r6/report.json`, `r7/report.json`, `r9/report.json`).

**Close controls: there are none, anywhere.** `#inv`, `#sheet`, `#abil` contain
**zero** `<button>` elements. `#saferoom`'s only buttons are its own tabs, SELL
ALL and DESCEND. Measured `tap-outside closes = false`. On a phone with no
keyboard, opening any of them ends the session.

**`#sheet` — iPhone 13 landscape (750×342).** Panel 750×339. `.sheet-cols`
resolves to `305px 494.25px` = **799px of tracks inside a 708px container** →
`scrollX 89` (the DAMAGE table's CD and DPS columns are severed at the viewport
edge) and `scrollY 383`. Zero interactive elements. On iPad Pro 11 the same
grid resolves to `305px 627px` inside 912 and there is no overflow at all — the
sheet is a phone problem specifically. `r3/iphone13-land-sheet.png`,
`r7/iphone13-land-sheet.png`.

**`#inv` — iPhone 13 landscape.** Panel 636×306, `scrollY 160`. `.cols` is
`301px 301px`: EQUIPPED and BAG stay **side by side even at 750px wide**. Item
rows measure 289×32 — under the 44px minimum in one axis. Zero close controls.
`r9/iphone13-land-inventory.png`.

**`#saferoom` (the shop) — iPhone 13 landscape.** The first real capture of
this surface (`r6/iphone13-land-shop.png`).

| measurement | value |
|---|---|
| `.shop-body` grid tracks | `350px 348px` in a 712px container — **two** tracks, not three |
| panel box | 750×349 on a 342-tall viewport: 4px above the top edge, 4px below the bottom, `scrollY 60` |
| `#sr-bag` | at y = **363** — 21px *below* the viewport. The bag is entirely off-screen |
| `#sr-detail` | 348×176 with `scrollY 178` — **more than half its content is hidden** |
| shelf sections | 199px tall each; the second section starts at y = 366, off-screen |
| every interactive control | **8 of 8 under 44px.** Page tabs 102×27 / 73×27 / 119×27; shelf tabs 72×24 / 76×24 / 83×24; SELL ALL 68×**18**; DESCEND 187×41 |
| buy controls | **none exist** (`buyButtons: []`) — purchasing is a click on the shelf tile, with no visible affordance |
| close controls | none |

On iPad Pro 11 the panel is 1138×788 and fits with no overflow; the shelf gets
738px. The tap targets are the same 24–27px on both. So the tablet shop is a
*touch-target* problem; the phone shop is a *layout* problem as well.

**`#menu`** on iPhone 13 landscape: the title block eats the top half and NEW
RUN, PARTY, RIVALS, ROAM, TEST CHAMBER and DESCEND are all below the fold
(`r2/iphone13-land-menu.png`). It scrolls, so it is recoverable — but the first
thing a phone player sees is a menu with no visible way to start.

**The recap (`IN MEMORIAM`)** has the same shape: NEW SEASON / WATCH THE ARENA
below the fold on a 342px-tall viewport (`r3/iphone13-land-shop.png`, captured
after a staged death — the filename is a leftover from the round that could not
open the shop).

**`#sheet` says "hover anything for the math".** Touch has no hover. The
derivation layer is invisible on a phone.

### 1.4 Broken: safe areas

The battery compares every HUD rect against the real hardware inset. Nothing
clears it.

| device | intrusions |
|---|---|
| iPhone 13 landscape (L/R 47, bottom 21) | `minimap-frame` left 12<47 · `cockpit` right 10<47 · `cockpit` bottom 10<21 · `hud-tl` left 12<47 · `hud-tr` right 12<47 · `xpbar` right 10<47 · **`xpbar` bottom −4<21 (already clipped off-screen)** |
| iPad Pro 11 landscape (top 24, bottom 20) | `cockpit` bottom 10<20 · `banner` top 12<24 · `hud-tl` top 12<24 · `hud-tr` top 12<24 · `xpbar` bottom −4<20 |
| Pixel 5 landscape (gesture bar 24) | `cockpit` right 10<24 · `hud-tr` right 12<24 · `xpbar` right 10<24 |

`iso.html` does have a `@media (pointer: coarse)` block using
`max(12px, env(safe-area-inset-*))` — but it covers only `#banner`, `#hud-tl`,
`#hud-tr` and `#cockpit`, and even those use 12px floors smaller than the real
inset, so the `max()` resolves to the wrong side of the notch on any device
where `env()` is 0-reported. `#minimap-frame`, `#t-stairs`, `#xpbar`, `#toasts`
and `#tutorial` are plain pixel offsets.

### 1.5 Broken by geometry: Pixel 5 landscape

802×293 CSS. `#cockpit` is 234×188 at (558, 95) — the ability cluster is **64%
of the screen height**, and the ultimate chip lands at y = 126, level with the
HP bar. `#xpbar` is off the bottom. The dungeon is a letterbox with the crawler
pinned near the top.

Measured, the cluster does not adapt *at all*: chip centre distances from the
bottom-right corner are **identical** on a 293-tall Pixel 5 and a 380-tall
iPhone 13 Pro Max — 20 / 114 / 120 / 127 / 137 px for slots 0–4 and 180px for
the flask (`r8b/report.json`). One fixed arc, five device shapes.

Anything with a short edge under ~320 CSS px has no working layout today.

### 1.6 The aim indicator, photographed

Four rounds asserted the telegraph existed because `renderer` had a key matching
`/aim|telegraph/`. That is a scene-graph lookup. The aim scenes hold the finger
down through the screenshot; here is what is actually on the glass
(`r5/report.json`, iPhone 13 landscape, 750×342 at dpr 3):

| ability | shape drawn | projected size on screen | what it should be |
|---|---|---|---|
| `bolt` | `line` | **111 × 44 CSS px** | a 4.2-unit plane; bolt has no range field at all (§8.1) |
| `nova` | `ring` | **132 × 83** | `novaParams().radius` = 2.6 base, +25%/rank, ×staff mult |
| `dash` | `arrow` | **71 × 28** | `dashParams().distance` = 3.2 × (1 + 0.3/rank) |
| `cataclysm` (ult) | `ring` | **132 × 83 — pixel-identical to nova's** | `cataclysmParams().radius` = **6** |

Material, from the live mesh: `#c9a24b`, `opacity 0.42`, `transparent`,
`depthWrite: false`, **no outline, no halo, no second pass**.

**Legibility, measured against a noise floor.** The harness shoots the frame
three times — once with the indicator visible, twice with it hidden — and
compares the mean per-channel delta *inside the indicator's own projected box*:

| ability | indicator on → off | scene churn (off → off) |
|---|---|---|
| `bolt` (line) | mean Δ 65.9, 83.3% of pixels over Δ24 | mean Δ **56.4**, 67.0% over Δ24 |
| `nova` (ring) | mean Δ 72.0, 87.3% over Δ24 | mean Δ **88.0**, 92.0% over Δ24 |
| `dash` (arrow) | mean Δ 48.8, 59.5% over Δ24 | mean Δ **48.1**, 59.1% over Δ24 |

The telegraph's contribution to the frame is **at or below** what torchlight
flicker, fog and the animated pack change on their own between two consecutive
frames — for the ring, strictly below. This is not proof a human cannot see it,
but it is proof the indicator carries no signal the scene does not already
carry. `r5/crop-aim-line.png` is the visual version: the line's projected box
is dead centre of the crop and nothing gold is visible in it.

Two further problems fall out of the same capture:

* **The palette is already spoken for.** Gold `#c9a24b` is the HUD, the chips,
  the torchlight and the loot glow (`r1/iphone13-land-combat.png`); red/orange
  is the *enemy* ground telegraph, plainly visible as the ring under the pack in
  `r5/iphone13-land-aim-ring.png`, where it is far louder than our own gold
  arc a few pixels away. "Gold = valid, red = cancel" paints our valid state in
  the HUD's colour and our cancel state in the enemy's.
* **The drag is screen-space; the world is isometric.** The projected box for
  the same 4.2-unit line is 111×44 — 2.5:1 — because the iso basis foreshortens
  the up-screen axis. A screen-radius → world-range mapping that ignores this
  gives a skillshot half the reach when aimed up-screen.

### 1.7 A modal opening mid-aim queues the cast — measured

New battery check (`drive6.log`). Press an ability chip, drag into the aiming
state, open a full-screen panel mid-drag, then lift the finger over whatever the
panel put underneath:

```
[FAIL] modal: opens mid-aim, then the finger lifts —
  modal opened mid-drag=true; the release point sits over DIV#.item;
  casts while the modal was up: none; casts once it closed: bolt;
  modal still open after release=true
```

Nothing in the host cancels gameplay pointers on modal open. The chip pointer is
`setPointerCapture`d, so the release is delivered to `#skills` and resolves as an
**aimed cast** — which does not fire while the panel holds the sim, and then
**detonates the instant the panel closes**, along a drag vector aimed at a world
state that is seconds stale. The level-up draft is exactly this modal, it opens
unprompted mid-fight, and descending stacks it on top of the safe room
(`r4/ipadpro11-land-shop.png`, and the reason the shop scene now drains drafts
before it claims the shop is on screen).

The good news: `pointercancel` on a chip already resolves as `{kind:"cancel"}` —
refund-identical to a cancel-band exit. The mechanism for the fix exists; nothing
invokes it.

### 1.8 Absent

* **No resting affordance for the stick.** `#t-stick` is `display: none` until a
  finger lands. A first-time player sees no left-hand control at all. Wild Rift
  always shows the base ring.
* **No haptics.** `navigator.vibrate` appears **zero times** in `src/`
  (available in the battery's environment; never called).
* **No target lock, no target priority.** `autoAimDir(range = 8)` picks the
  **nearest living monster**, full stop — no lowest-HP, no last-damaged, no
  threat, no respect for the ability's actual range, no `dormant` exclusion.
* **Indicators do not describe the ability** — §1.6.
* **No cancel zone.** Cancel is "drag back within 34px of where you pressed",
  which is invisible and, on a 48px chip, indistinguishable from a small aim
  correction. Wild Rift draws a labelled band.
* **No tap-to-move, no world tap at all** except the minimap ping.
  `stepClickMove` (`src/input/clickMove.ts`) is a fully-built, tested,
  Diablo-style click-move that touch never reaches.
* **No dodge gesture.** Dash is only an ability chip.
* **No control customisation.** The K panel has one three-state TOUCH toggle
  (AUTO / ON / OFF) and nothing else.
* **No portrait anything.** `body.phone` + portrait shows the ROTATE gate over
  *everything*, including the campfire menu and the leaderboard
  (`r2/iphone13-menu.png`).

### 1.9 Per-frame allocations in the touch layer — and their real size

`TouchController.sample()` allocates on every polled frame: the returned
`TouchSample` literal, the `castHeld` array literal, and `this.pending.splice(0)`.
`VirtualStick.value` and `.nub` each return a fresh object per read. Five
allocations per frame, ~300/s.

**That is the count, not a measurement of harm.** `performance.memory` over 240
consecutive frames of live rendering reports a heap delta of **0 bytes**
(`drive6.log`) — Chromium quantises that counter to ~100 KB, so the honest
reading is "below the quantum", i.e. these allocations are nursery traffic. No
profile anywhere shows the touch layer exceeding §7.2's own 0.15 ms budget.

This is why the fix is **SHOULD, not MUST** (§8.3). It is cheap and tidy and it
should happen; it is not what is standing between this game and a phone.

### 1.10 Unusable vs merely ugly

**Unusable** (a real player is stuck or loses the run):

1. inventory / character / abilities / shop panels cannot be closed by touch;
2. the minimap and System cards steal the movement thumb mid-fight;
3. a modal opening mid-aim queues a cast that fires when it closes (§1.7);
4. Pixel-5-class landscape (short edge ≤ 300) has no viable layout;
5. the shop's bag is off-screen and half its detail pane is unscrollable-to on
   a phone (§1.3);
6. the character sheet's numbers are clipped off-screen on a phone;
7. portrait is a wall, even on the menu.

**Ugly but survivable**: menu and recap needing a scroll; ability cluster
crowding the bottom-right; HUD under the notch; no resting stick ring;
indicators that are technically present and practically invisible.

---

## 2. THE CONTROL MODEL

### 2.0 The decision register — six contradictions, six numbers

Two design-critic rounds scored this document 6.5 then 7.0 and named six places
where it *described* an intention instead of *deciding* one. They are settled
here, in one table, and each row is expanded in the section named. Nothing in
§2–§4 may contradict this table; if it does, the table wins and the section is
the bug.

| # | the contradiction | the decision | where |
|---|---|---|---|
| 1 | AIMING promoted on `travel > 18px` **OR** `dwell > 90ms`, but a deliberate human tap runs 100–300 ms | **Travel only, from a leaky origin.** `AIM_SLOP = 18 CSS px` measured from an origin that follows the finger at `ORIGIN_LEAK = 40 px/s` while PRESSED, frozen on promotion. **No time term exists anywhere in the ability FSM.** | §2.4a |
| 2 | max range = "1.0 stick-radius from the chip", but R is a clamped viewport function (36–123 px across the matrix) | **The aim throw is its own quantity and it is physical, not viewport-derived.** `aimThrow = 18 mm` (88–124 CSS px), scaled by `buttonScale`. R stays the *movement* stick's radius and stops being borrowed. | §2.3, §2.4b |
| 3 | tap = up ≤ 200 ms, long-press = 450 ms held — the 200–450 ms band does nothing at all | **Delete the tap ceiling.** One threshold: release before the 450 ms ping arms = move order, at any duration; release after = ping. `TAP_MS` is deleted from the codebase. | §2.5a |
| 4 | `comfortable = clamp(0.55 × shortEdge, 150, 300)` — one formula for a 6.1" phone and an 11" tablet | **Reach is a hand constant in millimetres, not a screen fraction.** `comfortable = 48 mm`, `stretch = 66 mm`, converted per class through a measured `MM_PER_PX` table, then capped by geometry. Phones gain ~45% of arc; tablets lose ~17%. | §3.2 |
| 5 | the tablet side pivot at `0.62 H` puts the cluster where §1.5 condemns it — climbing the screen edge, under the boss plate, beneath the cancel band | **Keep the side pivot, change the fan.** Corner grip fans **+6°…+96°** (up and inboard); side grip fans **−46°…+46°** (symmetric about inboard horizontal) at `0.58 H`, with a hard invariant: no combat chip enters the top 32% of the safe box and the cluster is never taller than 46% of it. | §4.2a |
| 6 | `pointercancel` covers "a modal opened" and nothing else | **One refcounted input authority with eight enumerated suspend reasons**, driven by `body.modal` rather than a hand-maintained list of nine element IDs that misses six live overlays — plus an 8 s stuck-pointer reaper for the iOS backgrounding case that fires no event at all. | §2.9 |

**The single mistake underneath four of the six.** Rows 1, 2, 4 and the stick
radius are all the same error: *a quantity set by the hand was written as a
function of the screen.* A thumb is the same 48 mm on a 6.1" phone and a 12.9"
tablet; a tap is the same 120 ms on both; a comfortable aim throw is the same
18 mm on both. The viewport decides how much **room** those quantities have, not
how **big** they are. So this document now separates them explicitly:

* **hand-scale** — stick radius, aim throw, cancel radius, chip size, reach
  arcs. Authored in **millimetres**, converted once per class through
  `MM_PER_PX`, then *capped* (never scaled) by the viewport.
* **screen-scale** — zone rectangles, the status band, the world zone, panel
  layout. Authored as viewport fractions, as they already are.

`MM_PER_PX`, derived from the device matrix (CSS px are not physically constant
— iOS ships tablets at a deliberately lower point density than phones):

| class | devices measured | pt/in | mm per CSS px |
|---|---|---|---|
| `compact` | Pixel 5 (393×851 dp, 6.0") | 156.2 | **0.163** |
| `phone` | iPhone 13 (390×844 pt, 6.06"), 13 Pro Max (428×926, 6.68") | 153.4 / 152.7 | **0.165** |
| `tablet-s` | iPad Pro 11 (834×1194, 11.0"), iPad 7 (810×1080, 10.2") | 132.4 / 132.4 | **0.192** |
| `tablet-l` | iPad Pro 12.9 (1024×1366, 12.9") | 132.3 | **0.192** |

Spread inside a class is ≤ 2%. The residual — and the ±20% of hand size no
formula can see — is what `stickScale` / `buttonScale` / `hudInset` are for
(§6). A `?mmpx=` override exists for the harness.

### 2.1 Principles

1. **The sim never learns a finger exists.** Every gesture ends as a field on
   the same `Intent` the keyboard fills: `move`, `aim`, `cast[]`, `flask`,
   `useStairs`, `ping`.
2. **Screen space in, iso-rotated once at the seam** (`isoRotate`), exactly as
   the pad and the current touch layer do.
3. **Zones are computed once per layout change**, never per frame, and pointer
   roles are assigned at `pointerdown` and never reassigned.
4. **Moving while aiming is non-negotiable** and falls out of (3): the stick
   pointer and the ability pointer are different `pointerId`s with different
   roles, and the stick refuses to re-base under a second finger.
5. **Every gesture has exactly one owner, decided by a written precedence
   order** (§2.10). A gesture that two recognisers could claim is a bug.

### 2.2 Zones (left-handed mirrors the whole thing)

Computed from `innerWidth/innerHeight`, the safe-area insets, and the player's
size/position prefs. Recomputed on `resize`, `orientationchange`, and any pref
change — nothing else.

```
+--------------------------------------------------------------+
|  status band (top HUD, safe-inset aware)                      |
+---------------------+------------------+---------------------+
|                     |                  |   CANCEL BAND       |
|   STICK ZONE        |   WORLD ZONE     |   (appears only     |
|   left 46%,         |   tap = select / |    while aiming)    |
|   below the band    |   lock / move    +---------------------+
|                     |                  |   ABILITY CLUSTER   |
|                     |                  |   + potion + ult    |
+---------------------+------------------+---------------------+
|                        home-indicator gutter                  |
+--------------------------------------------------------------+
```

The stick zone **excludes** every modal, and the minimap and transient cards
move out of it entirely (§4). No control ever lives in the gutter.

The diagram is the **corner-grip** posture (`compact` / `phone`). On
`tablet-s` / `tablet-l` the cluster fans symmetrically around a side-grip pivot
and the CANCEL band moves to the bottom-outer corner — §4.2a, which also
carries the invariant that stops the cluster climbing into the read band on
either posture.

### 2.3 Movement stick

```
IDLE --down(in stick zone, no stick pointer live)--> ACTIVE
ACTIVE --move--> ACTIVE            (recentring, see below)
ACTIVE --up|cancel--> IDLE         (move zeroes the same frame)
```

* **Floating origin.** Base spawns under the thumb on `pointerdown`; the crawler
  never lurches because the vector starts at zero.
* **Resting ghost.** At IDLE, a 25%-opacity ring sits at the last lift position
  (falling back to a default anchor at 22% width / 72% height). It is a hint,
  not a hitbox — the whole zone stays live.
* **Radius `R` is a thumb quantity, so it is authored in millimetres**
  (contradiction 2, half of it). The old rule
  `R = clamp(0.16 × min(vw, vh), 52, 88)` said an iPad deserves a 88 px stick
  and a phone a 55 px one — i.e. that a tablet grants you a longer thumb. It
  does not. A comfortable stick throw is a **flexion of the thumb IP joint of
  about 11 mm**, and it is 11 mm on every device:

  ```
  R = clamp(11mm / MM_PER_PX[cls], 56, 76) × stickScale     // stickScale 0.7-1.4
  ```

  | class | R (CSS px) | R today | physical throw today |
  |---|---|---|---|
  | `compact` | **67** | 52 (clamped) | 8.5 mm — cramped |
  | `phone` | **67** | 55 | 9.1 mm — cramped |
  | `tablet-s` | **57** | 88 | 16.9 mm — a thumb cannot do this without regripping |
  | `tablet-l` | **57** | 88 | 16.9 mm |

  The tablet stick therefore gets **smaller** in CSS px and **identical** in
  millimetres, which is the whole point. Cosmetically the ring paints at
  `1.25 R` on `tablet-*` so a functionally-correct stick does not read as a
  toy on a 11" slab; the **hitbox is R**, and the whole zone stays live anyway.
* **Dead zone** 0.14 R (current code: 0.15 — keep, it tested clean at 5px of
  thumb jitter). At R = 67 that is 9.4 px ≈ 1.6 mm, comfortably above the
  1.0–1.5 mm of contact-centroid wander a resting thumb produces.
* **Recentring.** If the finger passes 1.35 R from the origin, slide the origin
  along the finger vector so the finger sits at exactly 1.0 R. The stick can
  never "run out" under a thumb that drifts up the screen over a long chase, and
  direction never inverts. Recentring runs **after** the flick test (§2.6) reads
  the frame's raw pointer velocity, so it can never eat a flick.
* **Walk / run is NOT free, and the earlier claim was wrong.** `Intent.move`'s
  comment says "need not be normalized", but `game.ts` does
  `const dir = normalize(move); … moveWithCollision(map, p.pos, dir, speed*dt, …)`
  — the magnitude is discarded before it reaches `moveWithCollision`, and a
  host-side scale on the vector is discarded with it. Analogue walk/run
  therefore requires a **sim change** (a speed scalar on `Intent`, or reading
  `|move|` in `game.ts`), which is out of scope for a round whose first rule is
  "no new game rules in the host". Two honest options: (a) drop walk/run from
  this round and from §5's verdict — the current plan of record; (b) schedule a
  separate one-line sim PR with its own determinism test. It is not shipping as
  part of the touch layer.
* **Lift** zeroes movement on the same frame as the `pointerup`, before the next
  sim step — no coasting.

### 2.4 Ability activation

Five slots (4 + ultimate) plus the potion. Per-slot state machine:

```
IDLE
 |  down
 v
PRESSED --------(travel > 18 px from the LEAKY origin)---------> AIMING
 |  up (ANY duration: 40 ms, 300 ms, 3 s — all the same Intent)   |
 v                                                               |
SMART CAST                                                       |
                                       finger in CANCEL BAND     |
                                    or back inside cancelRadius  |
                                                 v               |
                                              CANCEL <-----------+
                                                 |               | leave
                                                 +---------------+
                                                                 |
                                                            up   v
                                                          AIMED CAST
```

#### 2.4a The tap/aim decision — contradiction 1, decided

**The rule: `travel > 18 CSS px` measured from a leaky origin. There is no time
term in this machine at any threshold, in any mode.**

*Why a dwell term was always wrong.* The rejected rule promoted to AIMING on
`dwell > 90 ms`. There is no human population whose taps fit under that ceiling:

| source | number | what it says |
|---|---|---|
| Android `ViewConfiguration` | `LONG_PRESS_TIMEOUT = 500 ms`, `DOUBLE_TAP_TIMEOUT = 300 ms`, `TAP_TIMEOUT = 100 ms` | the 100 ms constant is the delay before *painting* a pressed state — Android has **no maximum tap duration** at all |
| UIKit | `UITapGestureRecognizer` has **no duration limit**; `UILongPressGestureRecognizer.minimumPressDuration = 0.5 s`, `allowableMovement = 10 pt` | a tap is a tap at any length; it fails only when a competing long-press wins at 500 ms |
| accessibility literature ([arXiv 1402.1036](https://arxiv.org/pdf/1402.1036)) | tap/press separation "often set around 500 ms"; the workable range is **500–1000 ms, peaking at 800 ms**; some users tap in 100–300 ms, others need **over a second** | the population spread alone is an order of magnitude wider than 90 ms |
| smartphone tapping dataset, 176 adults 18–74 ([Sci. Data, 2024](https://www.nature.com/articles/s41597-024-04052-y)) | tap contact times recorded per participant with age and hand | fast repeated tapping sits near 80–120 ms; a *deliberate, aimed* tap under combat load is slower, not faster |

A 90 ms ceiling puts the **median** deliberate tap into AIMING with a drag
vector of a few pixels — the game's most-used verb landing in the state meant
for its rarest. Every platform that has shipped a tap recogniser to a billion
hands reaches the same conclusion: **duration does not classify a tap.**

*Why deleting dwell was not sufficient either.* Travel alone still misreads a
long hold, because a stationary thumb is not stationary: as the pad flattens
under pressure the reported contact centroid **creeps 1–4 mm over 300–800 ms**
(6–24 CSS px at `MM_PER_PX ≈ 0.165`). A 500 ms tap therefore crosses an 18 px
travel threshold *without the player moving their thumb*, and the old spec had
no answer. Hence:

**The leaky origin.** While PRESSED, the press origin follows the finger at
`ORIGIN_LEAK = 40 CSS px/s` (≈ 6.6 mm/s). Travel is measured from that leaky
origin, not from the raw touchdown point. On promotion to AIMING the origin
**freezes** — the aim vector, the range fraction and the cancel radius are all
measured from the frozen point, so the leak can never distort an aim in
progress.

Provable consequences, and these are the test rows:

| finger behaviour | speed | outcome |
|---|---|---|
| held still, centroid creep 12 px/s | 12 < 40 | never promotes, at any duration — **tap** |
| held 3 s with 30 px/s of drift (a shaking hand, a bus) | 30 < 40 | never promotes — **tap** |
| deliberate slow aim | 100 px/s | promotes after `18/(100−40)` = **300 ms** |
| ordinary aim drag | 300 px/s | promotes after **69 ms** |
| fast flick-aim | 900 px/s | promotes after **21 ms** |

The leak rate is chosen at 40 px/s because it sits above every drift regime and
an order of magnitude below every deliberate one; there is no observed thumb
behaviour in the 40–100 px/s band that means anything other than "aiming
carefully", and that band promotes, slowly, which is correct.

**The ambiguous band, named explicitly.** There are two, and neither is a time
band:

* **0 → 18 px of leak-corrected travel: TAP.** Release resolves as a smart cast
  at the §2.5 prioritised target. Duration is not consulted. A 40 ms tap and a
  3 s hold-and-release produce a **byte-identical `Intent`**, and
  `test/touchIntent.test.ts` asserts equality, not similarity.
* **18 px → `cancelRadius`: this band cannot exist**, by the threshold-ordering
  invariant below. It is the band the old spec papered over with a "release
  below the stick dead zone resolves as a smart cast" special case — which was
  unreachable at default settings (dead zone 0.14 × 55 = 7.7 px, well inside the
  34 px cancel radius) and undefined at non-default ones, because `cancelRadius`
  scaled with `buttonScale` and the slop did not.

**Threshold ordering is now an asserted invariant, not a coincidence.**
`computeZones()` returns `aimThrow` and `cancelRadius` and asserts, on every
device and at every slider position:

```
AIM_SLOP (18) < cancelRadius < 0.5 × aimThrow
```

`cancelRadius = clamp(0.34 × aimThrow, 30, 42)` and `aimThrow ≥ 88` (§2.4b)
satisfy it by construction: 18 < 30…42 < 44…62. The "no path through this
machine produces a cast with an undefined direction" invariant is therefore
**structural**, not a special case — the dead-zone branch stays in the code as a
defensive floor and is documented as unreachable-by-construction.

**Dwell is still allowed to do exactly one thing: nothing.** The indicator
already appears on `pointerdown` in the same frame, so there is no reveal left
for a dwell timer to trigger. The word does not appear in the FSM.

**Versus Wild Rift.** Wild Rift's ability buttons classify on movement, and its
per-ability "tap cast / aim" toggle is a *mode*, not a timer — holding a Wild
Rift ability button without moving does not silently arm an aim. We **match**
them on the classification rule, and **beat** them on the drift case: a leaky
origin is not something a fixed slop can do, and it is the difference between a
control scheme that works for a 20-year-old's steady thumb and one that works
for a tired one at floor 15. *(Confidence: the movement-classification claim is
observed from play and from the settings UI's framing, not from a citable Riot
source. The platform constants above are citable; the Wild Rift ones are not.
Treat this row as "match asserted, beat argued" until the §8.3 device gate puts
both games in one pair of hands.)*

#### 2.4b The aim throw — contradiction 2, decided

The old spec said maximum range is reached with the "finger at 1.0
stick-radius from the chip". `R` is the **movement** stick's radius, on the
**other hand**, and it is a clamped function of the viewport that the player can
scale with a slider that has nothing to do with aiming. Across the matrix that
made the full-range aim throw anything from `52 × 0.7 = 36 px` to
`88 × 1.4 = 123 px` — a 3.4× spread — and at the small end the *entire* aim
range (36 px) lived inside the fixed 34 px cancel radius. Maximum range and
"never mind" were the same gesture.

**Decision: the aim throw is its own hand-scale quantity.**

```
aimThrow     = clamp(18mm / MM_PER_PX[cls], 88, 124) × buttonScale   // NOT stickScale
cancelRadius = clamp(0.34 × aimThrow, 30, 42)
```

| class | `aimThrow` | `cancelRadius` | angular jitter at 1.5 mm of thumb noise |
|---|---|---|---|
| `compact` | 110 | 37 | 4.8° |
| `phone` | 109 | 37 | 4.8° |
| `tablet-s` | 94 | 32 | 4.8° |
| `tablet-l` | 94 | 32 | 4.8° |

18 mm is chosen from the angular budget, not from taste: 1.5 mm of contact
jitter over an 18 mm throw is 4.8° of aim error, which at bolt's derived 14.4
tile reach is 1.2 tiles of miss at maximum range — inside a monster's own
footprint. At the old tablet value (88 px = 16.9 mm) that was 5.1°, at the old
small-phone value (36 px = 5.9 mm) it was **14.3°**, or 3.6 tiles of miss.

Three further rules the old text left open:

* **Over-throw is free.** Any drag past `aimThrow` clamps to `frac = 1.0`. The
  thumb runs out of screen long before it runs out of intent, especially on a
  342 px-tall phone; punishing that would be punishing the device.
* **`frac` only means something for placed shapes.** For `ring`, `scatter` and
  the landing footprint of `arrow`, the drag is *direction + distance* and
  `frac` maps to placement:
  `dist = (0.15 + 0.85 × frac) × range`, so the shortest committed drag still
  places the shape clear of the crawler's own feet rather than on them.
  For `line`, `cone` and `chain` the drag is **direction only** and `frac` is
  ignored — a bolt flies its full derived reach whatever the throw, and
  pretending otherwise would have invented a game rule in the input layer,
  which §2.1 forbids.
* **Rotate before you scale.** The screen vector goes through `isoRotate`
  **first**, then its magnitude maps to world distance (§3), so an up-screen and
  a sideways drag of equal thumb travel mean equal world distance despite the
  iso basis foreshortening the up-screen axis 2.5:1 (measured, §1.6).

**Versus Wild Rift.** Wild Rift gives each ability button its own control wheel
whose radius is a fixed per-button constant, tunable with a sensitivity slider.
We **beat** that by deriving the throw from a physical constant per device class
so the *default* is right on a 6.0" Pixel and an 12.9" iPad without the player
discovering a slider — and we keep the slider anyway. *(Confidence: the "fixed
per-button wheel plus a sensitivity slider" description is from the settings UI
as reported by [community control guides](https://www.techy.how/tutorials/wild-rift-best-settings-controls);
no Riot engineering source states the underlying constant.)*
#### 2.4c The rest of the machine

* **The indicator appears on `pointerdown`, in the same frame**, not after the
  slop threshold. On press you immediately see the ability's real reach; the
  drag only *changes* it. This is the single biggest feel gap versus Wild Rift,
  and it is also what makes §2.4a safe: a slow tap and a slow aim look identical
  to the player for as long as they *are* identical.
* **`PRESSED` release = smart cast** at the prioritised target (§2.5). If no
  target is in range, cast along facing (current behaviour — keep).
* **`AIMING` release = aimed cast** along the frozen-origin drag vector, per
  §2.4b.
* **Cancel is two affordances, both live**: (a) a labelled CANCEL band whose
  placement is posture-dependent (§4.2a) and which appears the moment `AIMING`
  starts (Wild Rift's answer, and the one people transfer in), and (b) returning
  inside `cancelRadius` of the **frozen** origin — 37 px on a phone, 32 px on a
  tablet, never the old fixed 34. Entering either turns the indicator to its
  cancel state (§3) and kills the haptic; releasing there costs nothing — no
  cooldown, no charge. The return-cancel only **arms** once the thumb has been
  outside `cancelRadius`, so a short aim is never born already cancelled.
* **Interruption-cancel is refund-identical to a cancel-band exit.** A pointer
  killed by **any of the eight suspend reasons in §2.9** — not just a modal —
  resolves as `{kind:"cancel"}`: no cooldown, no charge, no queued cast. This is
  already true of `pointercancel` in `SlotButton.up()`; every other path routes
  to the same `cancelAll()`.
* **Cooldown / no-charge presses** are refused at `pointerdown` with a distinct
  buzz + a shake on the chip, and never enter `AIMING`. Today a dead chip runs
  the whole gesture and silently does nothing.
* **Per-slot cast mode**, persisted: `tap` (fire immediately on press — fastest,
  for point-blank kit), `tap-release` (default; press shows the indicator,
  release fires — LoL's "quick cast with indicator"), `aim-only` (requires
  travel > 18 px before a release will cast; a release below that threshold is
  a cancel, not a smart cast — that is the point of the mode).
  With dwell gone, `tap` and `tap-release` behave identically for a slow presser,
  which is the correct behaviour and was not true of the earlier design.
* **The melee/basic chip stays hold-to-repeat** (current behaviour, works).

### 2.5 Target selection and lock

Replace `autoAimDir` with a pure `pickTarget()` in a new `src/input/targeting.ts`
so it can be unit-tested without a DOM. Priority, first match wins:

1. the **locked** target, if alive and within the ability's real range;
2. the target **you damaged in the last 3 s**, if alive and in range (this is
   what makes finishing feel intentional rather than random);
3. inside range, the enemy with the **lowest current HP fraction**, biased by a
   small cone weight toward the crawler's facing;
4. otherwise the nearest.

Elites and bosses get a modest score bonus; `dormant` monsters are excluded
(today's `autoAimDir` skips `hp <= 0` but not `dormant`).

**Lock** is a world-zone tap on a monster (host-side raycast; the sim knows
nothing). A locked target draws a ring plus a small plate. Tap it again, tap
empty ground, or its death clears the lock. A LOCK toggle chip near the cluster
switches "sticky lock" on, for boss fights.

#### 2.5a World-zone tap vs long-press — contradiction 3, decided

The old pair — tap = "up within **200 ms**, travel < 16 px", long-press =
"**450 ms** held, travel < 16 px" — left the 200–450 ms band assigned to
**nothing**. That is not an edge case: it is the band a deliberate tap under
combat load actually lands in (§2.4a), and the failure mode is the worst one
available — the finger lifts and the game does not respond at all, which reads
as a dropped input, not as a rejected one. Traced in the shipped router, the
band is literally `else { /* nothing */ }`.

**Decision: delete the tap ceiling. There is one threshold, not two.**

```
TAP_TRAVEL     = 16 CSS px   (≈ 2.6 mm — an intentional-tap slop, not a scroll slop)
LONG_PRESS_MS  = 450         (the ONLY time threshold in the world recogniser)
TAP_MS                       DELETED from src/input/touch.ts
```

`TWO_FINGER_UP = 200` is a *different* constant and it survives: it is the
two-finger dash budget in §2.6, an arbitration point between two recognisers,
not a ceiling on a single-finger tap. The two sharing a value was part of why
the contradiction was easy to miss.

| gesture | rule | result |
|---|---|---|
| tap empty ground | travel ≤ 16 px, released **before the ping arms** — at any duration, 40 ms or 400 ms | move there via `stepClickMove` |
| tap a monster | same | lock **and** auto-attack toward it |
| long-press | travel ≤ 16 px, held to 450 ms → the ping **arms** (ring grows + 25 ms haptic); released after | party ping (replacing the minimap-tap ping) |
| slide off | travel > 16 px at any point | aborts **both**; the gesture belongs to the camera recogniser (§2.8) |

Three properties this buys, each one testable:

1. **No dead band.** Every `pointerup` inside 16 px of travel produces exactly
   one of two Intents. There is no third outcome and no silence.
2. **The boundary is announced before it is crossed.** At 450 ms the ring
   appears and the device buzzes, so a player who was tapping and is now
   long-pressing *sees it happen* and can still slide off to abort. The old
   design's boundary was invisible in both directions.
3. **The verdict is taken on event time, the arm on local time**, which is
   already how the shipped router works — and it exists because a 110 ms tap on
   a frame-dropping phone was measured being classified as a 450 ms long press
   when both were read from the local clock.

**Versus Wild Rift, and the platforms.** UIKit's
`UILongPressGestureRecognizer.minimumPressDuration` is 500 ms and Android's
`LONG_PRESS_TIMEOUT` is 500 ms; **neither platform bounds a tap from above**.
We match their *shape* exactly and pick **450 ms** rather than 500: a party ping
in a 3-player crawl with a collapse timer is used far more often than a system
context menu, and 450 ms sits above the 99th percentile of deliberate taps while
returning 50 ms to the most-repeated non-combat verb in co-op. Wild Rift routes
its equivalent through a **drag-out-of-a-ping-button** wheel rather than a
world long-press; that is a better fit for a MOBA with four ping types and a
worse one for a crawler with one, so we are deliberately **not** matching it,
and we keep the ping on the world so the minimap can become display-only
(§4.2).

**A live click-move path is cancelled the instant the stick produces a non-zero
`move`.** Direct control always wins over autopilot; there is no blending and no
"resume after". `stepClickMove` already exposes this as clearing its target.

### 2.6 Dodge / dash

Keep the chip. Add, opt-in and default **on**:

* **flick-dash** — evaluated on the stick pointer from **raw pointer velocity**,
  not from displacement-from-origin: > **2.6 R per second** sustained across two
  consecutive `pointermove` samples, with the finger still down, fires
  `cast[dashSlot]` with `aim` = the flick direction. Velocity is used precisely
  because recentring (§2.3) clamps displacement to 1.0 R and would otherwise make
  a fast flick unmeasurable. Debounced 350 ms so a fast turn is not a dash.
* **two-finger tap in the world zone** — dash along current movement, for
  players who dislike the flick. Recognised only if **both** pointers go down
  within 120 ms of each other, **both lift within 200 ms**, and **neither travels
  more than 16 px**. Anything slower or longer is handed to the camera
  recogniser (§2.8) instead; there is exactly one arbitration point and it is
  this budget.

Both map to the same slot cast. If dash is not slotted, both are inert (no new
rule, no reserved slot).

### 2.7 Potion, loot, interact

* **Potion**: tap the flask chip (works today). Add a low-HP pulse on the chip
  and a distinct haptic when a charge refills.
* **Loot**: needs no input — the sim auto-collects inside `CONFIG.pickupRadius`.
  The failure is *feedback*: add a ground ring at pickup radius when an item is
  inside it, and a compact "picked up" strip clear of the thumbs.
* **Interact**: generalise `#t-stairs` into one **context chip** showing the
  highest-priority interactable in reach with its verb — DESCEND / TOUCH /
  SPEAK / OPEN / SHOP. It maps to `useStairs`, which the sim already overloads
  for dialogue in Roam. It moves from its mid-screen float
  (`right: 252px; bottom: 130px`) to a fixed dock just inboard of the cluster.

### 2.8 Camera

Two-finger drag in the world zone = peek (host-side camera offset, springs back
on release). Two-finger pinch = toggle CLOSE / STANDARD framing, writing the
existing `camView` setting. Claimed only once the two-finger-tap budget in §2.6
has **expired** — i.e. after 200 ms of contact or 16 px of travel on either
pointer, whichever comes first.

### 2.9 Multi-touch contract

| pointer | eligibility | notes |
|---|---|---|
| stick | first `down` in the stick zone | a second finger in the zone is ignored, never re-bases |
| ability | first `down` on a chip | one aimed cast at a time; a second chip press queues (see below) |
| potion / context / lock | any `down` on those chips | independent, instantaneous |
| world | `down` in the world zone | tap / long-press / two-finger (§2.6, §2.8) |
| UI | anything over a modal | see the modal gate below |

Three simultaneous gameplay pointers (move + aim + potion) are supported. A
fourth is dropped.

#### 2.9a Input authority — contradiction 6, decided

The shipped fix for §1.7 is a boolean, `setModalOpen(open)`, driven by a
**hand-maintained list of nine element IDs** in `main3d.ts`:
`inv, abil, sheet, keys, recap, saferoom, draft, menu, dialogue`. Checked
against the screen-zone map in `iso.html`, that list misses every one of these,
all of which are live surfaces today:

| missed surface | z | what happens now |
|---|---|---|
| `#ladder` / `#career` / `#consent` | 28 | THE STANDINGS, THE CRAWLER and the submit-consent card open over a live gameplay pointer |
| `#loading` | 29 | SIGNAL ACQUISITION covers the glass while a finger is down |
| `#recap-tab` | 27 | the held-TAB drill-down |
| `#rotate` | 40 | **the orientation gate — the one overlay that outranks everything** |
| a `[data-sheet]` bottom sheet (§4.5 5) | — | tap-to-open math / item / map sheets are not full-screen, so they would never set the flag, yet they sit *on top of the cluster* |
| tab backgrounded, call arrives, shade pulled | — | **no DOM event at all.** iOS Safari does not reliably fire `pointercancel` when the page is hidden; the captured pointer simply stops existing and the stick stays pushed |

A boolean maintained by an ID list is the wrong shape. Two overlapping reasons
(descend opens the SPONSOR DRAFT *on top of* the safe room — measured, §0
lesson 3) also un-suspend on the first close.

**Decision: one refcounted input authority with an enumerated reason set.**

```ts
touch.suspend(reason: SuspendReason): void   // idempotent per reason
touch.resume(reason: SuspendReason): void
// gameplay input is live iff the reason set is EMPTY
```

| reason | raised by | why it is not `modal` |
|---|---|---|
| `modal` | `body.modal`, and **only** `body.modal` — a `MutationObserver` on `document.body`'s class list, not an element list | the ID list is deleted. Any surface at z ≥ 20 sets `body.modal` when it opens; `test/panels.test.ts` asserts every overlay in the screen-zone map at z ≥ 20 does so, which is a check a new panel cannot forget |
| `sheet` | any visible `[data-sheet]` | not full-screen, still over the cluster |
| `rotate-gate` | `#rotate` visible (`body.phone.ingame` + portrait) | z 40, deliberately outranks `body.modal` |
| `orientation` | `orientationchange`, **held until 250 ms after the last `visualViewport` resize** | iOS fires the two apart; releasing on the first one re-arms the layer against stale zones |
| `hidden` | `visibilitychange` → hidden, `pagehide`, `window.blur` | fires no pointer event whatsoever — this is the class of bug that leaves a phone player running into a wall after a phone call |
| `not-playing` | `state.status !== "playing"` | death, win and floor transition swallow intents sim-side while the FSM keeps its state |
| `editor` | CUSTOMISE CONTROLS mode (LATER #20) | the controls are the content |
| `system-gesture` | `contextmenu`, iOS `gesturestart` | the OS has taken the finger |

**Explicitly NOT suspend reasons**: hit-stop and any sim freeze. §3's
acknowledge-inside-one-frame rule exists precisely so a press during a frozen
sim looks alive; suspending there would be the opposite of the fix.

The transition rules, unchanged in spirit and now applied to all eight:

1. **Raising any reason** resolves every live gameplay pointer as **cancel** —
   refund-identical to a cancel-band exit: no cooldown, no charge, no queued
   cast, stick zeroed the same frame.
2. Those `pointerId`s are marked **dead**: the trailing `pointerup` /
   `pointercancel` is consumed and routed to nothing, and
   `releasePointerCapture` is called so the browser stops delivering them to
   `#skills`.
3. **Clearing the last reason** starts a `MODAL_GATE_MS = 120` deaf frame on the
   **local** clock, and any pointer still on the glass stays dead until it
   lifts. Closing a panel with a finger already down must not start a cast, and
   a panel must not accept the same press that dismissed the thing before it.
4. **Refcounted**, so draft-over-safe-room resumes only when both are gone.

**The stuck-pointer reaper** (the belt to `hidden`'s braces). Any pointer role
with no `pointermove` and no `pointerup` for `POINTER_TTL = 8000 ms` is reaped
through the same `cancelAll()` path. There is no legitimate 8-second motionless
hold in this game — the basic-attack chip repeats on `castHeld`, which the
reaper releases, and a player who is genuinely still holding it re-presses in
one frame. A stick that is still pushed after the app came back from a call is
the single most-reported control bug in mobile action games, and it is
unreachable if the layer never trusts a pointer to tell it when it died.

**Versus Wild Rift.** Wild Rift cancels casts and drops the stick on
interruption — incoming call, app switch, disconnect banner — and its ability
indicators do not survive one. We **match** them on the behaviour and **beat**
them on the guarantee: an enumerated reason set with a refcount means a new
surface is either registered or caught by `test/panels.test.ts`, and the TTL
reaper means the guarantee holds even on the platform paths that emit no event
at all. *(Confidence: the Wild Rift interruption behaviour is observed, not
cited. The iOS `pointercancel`-on-background unreliability is the reason the
reaper exists regardless of what they do.)*

**The cast queue is bounded.** A second chip press while a cast is resolving
queues **one** smart cast, in a single slot (not a list). It expires when the
first cast resolves, or after **250 ms**, whichever comes first, and it is
**dropped entirely if the first cast is cancelled** — cancelling is a change of
mind, and it must not fire a different ability as a consolation prize.

`navigator.maxTouchPoints` reports **1** under Playwright emulation even with
`hasTouch: true`; do not gate anything on it.

### 2.10 Gesture precedence

One table, evaluated top to bottom at `pointerdown`, then re-evaluated only at
the thresholds named:

1. **the suspend-reason set is non-empty** → every gameplay recogniser is off,
   and the pointer is born **dead** so its lift resolves to nothing (§2.9a)
2. **chip hit rect** → ability pointer (§2.4); promotion by §2.4a's leaky-origin
   travel test, never by duration
3. **stick zone, no stick live** → stick pointer (§2.3); flick tested from
   velocity *before* recentring (§2.6)
4. **world zone, second pointer within 120 ms** → two-finger candidate; resolves
   to dash-tap inside the §2.6 budget, otherwise to camera (§2.8)
5. **world zone, single pointer** → move order or ping by the single §2.5a
   threshold; there is no duration band that resolves to nothing
6. anything else → dropped

Stick input at any time cancels a live click-move path (§2.5).

---

## 3. FEEL

* **Acknowledgement inside one frame.** Every `pointerdown` paints its own
  response — chip press bevel, stick ring, indicator — from the event handler,
  not from the next sim step. This matters because the sim *freezes* during
  hit-stop and while any panel is open, and edges queue until it thaws; a press
  must never look ignored while the world is paused.

### 3.1 The indicator specification

§1.6 measured what exists: a 0.42-opacity gold plane with no outline, whose
contribution to the frame is at or below the scene's own churn. The replacement
is specified, not adjectival.

**Colour.** The world already owns gold (HUD, chips, torchlight, loot) and
red/orange (enemy ground telegraphs). The player indicator therefore takes a
colour the world does not use:

| state | fill | core / stroke |
|---|---|---|
| valid | cyan `#39c8e8` at 0.30 | white `#eaf9ff` core line/rim at 0.85 |
| out of range | same hue at 0.12 | stroke drops to 0.35, no core |
| **cancel** | **dashed** stroke (8/6 px dash), fill drops to 0.10, plus the ✕ glyph on the chip | desaturated cyan — **not** red |

The cancel state's primary signal is the **dash pattern and the ✕**, not the
colour, and enemy telegraphs keep red exclusively. Colour is the redundant
channel here, not the load-bearing one — which also satisfies §6's colour rule
without a separate accessibility mode.

**Contrast and floors.**

* Every stroke gets a 1 px dark outline (`#08131a` at 0.7) drawn underneath, so
  the indicator reads on both the black basalt and the pale hex floor of
  `r1/iphone13-land-constellation.png`.
* Minimum stroke width **3 CSS px at dpr 1**, scaled by `devicePixelRatio` —
  the current line is a 0.2-world-unit plane, which is what makes it vanish.
* **Minimum on-screen footprint**: no indicator may project smaller than
  **96 × 96 CSS px** in its bounding box. Measured today, the dash arrow
  projects 71 × 28 (§1.6) — under the floor in both axes.
* `depthWrite: false` stays (the ground plane must not z-fight), but the
  indicator renders **after** world geometry with `depthTest: false` for its
  core stroke, so a pack of sprites standing on it cannot swallow it — the
  measured failure in `r5/crop-aim-line.png`.

**Geometry from the ability, in the iso basis.**

* The drag vector is rotated through `isoRotate` **before** its magnitude maps
  to world range, so a 5-tile skillshot aimed up-screen and one aimed sideways
  take the same thumb travel even though they cover very different pixel counts.
* Shapes: a ring for AoE, a line with a terminal disc for skillshots, an arrow
  with a landing footprint for dash, a **cone** for sweeps (does not exist
  today — `setAimIndicator` has exactly three shapes), and a **scatter
  footprint** for airstrike (also new).

**Occlusion.** On a 342px-tall phone the drag path puts the thumb over the
centre of the screen, i.e. over the crawler and the near half of its own
indicator. Mitigations, all cheap: the indicator's near 40% fades toward the
origin; the terminal disc / landing footprint (the part that carries the
information) is always at the *far* end; and while `AIMING`, the camera lifts
its target by 8% of viewport height so the action sits above the thumb.

**Indicator latency** must be under one frame of the *touch* stream, not the
render stream: update the telegraph transform from the `pointermove` handler and
let the renderer read it, rather than waiting for the next sim step.

**Evidence still owed.** No capture of the *specified* indicator exists yet — by
definition; it is unbuilt. The gate in §8.3 requires re-running
`--scenes aim-line,aim-ring,aim-arrow,aim-ult` after implementation and pasting
the four crops here, with the legibility diff showing the indicator's box
clearing the scene-churn floor by ≥ 2×.

### 3.2 Thumb reach — contradiction 4, decided

The first version was a flat pair ("comfortable ≈ 190, stretch ≈ 260"): the
*phone's* value of a rule, promoted to a constant. The second was worse in an
interesting way:

```
comfortable = clamp(0.55 * shortEdge, 150, 300)   CSS px       // REJECTED
stretch     = 1.37 * comfortable
```

**It is dimensionally wrong.** It says a bigger slab grants you a longer thumb.
It does not: a thumb is the same thumb, and what changes across devices is how
much of the screen that thumb can cover. Worse, the upper clamp at 300 means
*every* tablet from 546 px of short edge upward gets the identical number — so
the formula that was introduced to stop a 6.1" phone and an 11" tablet sharing
one arc ends by making an 10.2" iPad, an 11" iPad and a 12.9" iPad share one.
The critique was exactly right.

**Decision: reach is anthropometry, converted per class.**

```
THUMB_COMFORTABLE_MM = 48      // player slider 38-62 mm (§6)
THUMB_STRETCH_MM     = 66      // 1.375 x comfortable

comfortable = min(THUMB_COMFORTABLE_MM / MM_PER_PX[cls], 0.80 * shortEdge)
stretch     = min(THUMB_STRETCH_MM     / MM_PER_PX[cls], 1.00 * shortEdge)
```

The millimetre figures are a reasoned anthropometric model, and they are labelled
as one. Functional thumb area on a touchscreen is set by **thumb length and
grip, not by screen size** — the result Bergstrom-Lehtovirta & Oulasvirta
established in *Modeling the functional area of the thumb on mobile touchscreen
surfaces* (CHI 2011), and the reason every subsequent thumb-zone model is drawn
as an arc around the thumb root rather than as a fraction of the display. Adult
thumb length from the metacarpophalangeal joint runs roughly 60–72 mm;
**comfortable** sweep — no wrist rotation, no grip change, no device shift — is
about 70–75% of that, hence **48 mm** at the 50th percentile, with the 38–62 mm
slider covering roughly the 5th to 95th percentile of adult hands. **Stretch**
is the arc reachable with a small grip shift, ≈ 66 mm. The clamps are the
geometry check: an arc cannot usefully exceed the screen it is drawn on.

Resulting instances, against what the rejected formula produced:

| device | viewport | class | comfortable | (was) | stretch | (was) | error in the old rule |
|---|---|---|---|---|---|---|---|
| Pixel 5 landscape | 802×293 | `compact` | **234** | 161 | **293** | 221 | understated by 31% — 161 px = **26 mm**, half a thumb |
| iPhone 13 landscape | 750×342 | `phone` | **274** | 188 | **342** | 258 | understated by 31% — 188 px = 31 mm |
| iPhone 13 Pro Max | 832×380 | `phone` | **291** | 209 | **380** | 286 | understated by 28% |
| iPad 7 landscape | 1080×810 | `tablet-s` | **250** | 300 | **344** | 411 | **over**stated by 17% — 300 px = **57.6 mm**, past a comfortable arc and into stretch |
| iPad Pro 11 landscape | 1194×834 | `tablet-s` | **250** | 300 | **344** | 411 | overstated by 17% |
| iPad Pro 12.9 | 1366×1024 | `tablet-l` | **250** | 300 | **344** | 411 | overstated by 17% |

One formula, two opposite errors, and both of them are visible in §1's captures.
On phones it cramped the arc to a third of a thumb, which is *why* the Pixel 5
cluster stacks to 64% of the screen height (§1.5): nine controls will not fit on
a 161 px arc, so they climb. On tablets it certified as "comfortable" an arc a
thumb reaches only by shifting its grip — the measured flask at 253 px from the
corner pivot passed a test it should have failed. Fixing the model fixes the
symptom, in both directions, without a per-device table.

**A phone in landscape is not reach-limited; it is occlusion-limited.** At
48 mm on a 64.6 mm-tall screen, a landscape phone's thumbs reach nearly
everything — so the binding constraint there is not "can the thumb get there"
but "does the hand cover the fight". That is a different rule and it is written
as one: on `compact` / `phone`, the cluster's arc radius is additionally capped
at `0.58 × safe.h` so the chips never rise into the upper 32% of the safe box
(§4.2a). On `tablet-*` the cap is `0.62 × safe.h`, which never binds — there,
reach is the real constraint.

**Two pivots, not one.** A phone in landscape is held at the bottom corners; an
11-inch tablet in landscape is gripped at the *sides*, with the thumb rooted
well above the bottom corner. `--reach` draws both — the corner pivot the
current layout assumes, and the side pivot. `r8/ipadpro11-land-combat.png` and
`r8/ipad7-land-combat.png` are the first captures showing the difference.

And re-pivoting alone is not a win. Measured on iPad Pro 11 (chip centres from
`r8/report.json`):

| control | distance from corner pivot (1160, 804) | from side pivot (1168, 517) |
|---|---|---|
| ultimate (slot 4) | 194 | **95** |
| slot 1 | 165 | **318** |
| flask | 253 | **379** |

Re-pivoting alone moves the problem from the ultimate to the flask, because the
*fan* is still authored for a corner. Pivot, radius **and fan** are settled
together in §4.2a. `test/touchLayout.test.ts` asserts **no control that must be
pressed during combat lies outside `comfortable` from its class's pivot** on all
six viewports above, at every slider position.

* **Visual centre ≠ touch bounds.** Chips draw at 48–70px but their hit
  rectangles pad to at least 44×44 CSS **and** overlap-resolve by nearest
  centre, so a press between two chips picks the closer one instead of the one
  that happens to be on top. Chips near a screen edge extend their hit rect
  *into* the edge.
* **Haptics** (`navigator.vibrate`, silently ignored on iOS Safari — that is
  fine, it degrades to nothing):
  | event | pattern |
  |---|---|
  | chip press accepted | 8 ms |
  | chip press refused (cooldown/charge) | 12-40-12 ms |
  | cast released | 14 ms |
  | cancel | 25 ms |
  | crawler takes a big hit (> 12% max HP) | 30 ms |
  | player kill | 10-30-10 ms |
  | level up / draft ready | 20-60-20 ms |
  | potion refilled | 10 ms |
  All fed from the **existing per-frame feedback buffers** (`frameHits`,
  `frameAnns`), rate-limited to one pulse per 60 ms, and switchable off.
* **Cancel / undo affordances.** Cancel band for casts. Panels close on backdrop
  tap, on a swipe-down, and on an explicit button. Destructive shop actions
  (SELL ALL) get a two-step confirm on touch.

---

## 4. HUD AND LAYOUT

### 4.1 Device classes

Replace the current binary (`body.phone` = coarse && `min(screen) < 500`) with
four, because 500–744 is a real gap and because a 10-inch and a 13-inch tablet
are not the same object:

| class | trigger (short edge, CSS px) | posture |
|---|---|---|
| `compact` | coarse, < 380 | Pixel 5 / iPhone SE landscape: everything compresses along the thumb arc |
| `phone` | coarse, 380–559 | iPhone 13 / Pro Max landscape |
| `tablet-s` | coarse, 560–899 | iPad mini / iPad 7 / iPad Pro 11: **side-grip pivot** |
| `tablet-l` | coarse, ≥ 900 | iPad Pro 12.9 and desktop-class touch: side pivot, wider world zone |

Classes pick the *posture* — where the hand grips the slab — and nothing else.
The geometry inside a class is **not** a function of the short edge, which was
the rejected model (§3.2): stick radius, aim throw, cancel radius, chip size and
the reach arcs are **hand constants in millimetres**, converted once through
`MM_PER_PX[cls]` (§2.0) and then *capped* by the viewport. That is what stops an
11-inch and a 13-inch tablet sharing one geometry — they do not share one, they
share the same **physical** geometry, which is the correct answer, because the
same hand holds both. The short edge decides only how much room the posture has,
via the caps in §3.2 and §4.2a.

Keep `?phone=1` and add `?uiclass=` for headless verification.

### 4.2 What moves, scales, hides

* **Minimap → out of the stick zone, and its *control* comes to the thumb.**
  Moving the puck to the top-right fixes the input conflict and creates a reach
  regression, so it is split in two:
  * the puck itself sits top-right as a **display only** —
    `pointer-events: none`, nothing to press;
  * the **MAP chip** lives in the cluster arc, inside `comfortable`, and opens
    the full-screen map (which carries the ping control).

  Measured, this is not optional. A tappable top-right puck (88 px, inside the
  safe inset) sits **262 px** from the right corner pivot on iPhone 13 landscape
  (stretch 258), **299 px** on Pro Max (stretch 286) and **215 px** on Pixel 5
  (stretch 221) — at or past the stretch arc on all three
  (`r8b/report.json` + §3.2). The earlier "top-right, tap expands it" line put an
  in-combat control outside the reach model this document defines.
* **Transient cards (`#tutorial`, toasts, achievements) → the top-centre band**,
  above the world and clear of both thumbs; `pointer-events: none` everywhere
  except an explicitly-sized dismiss target, and auto-dismiss on any gameplay
  input.
* **`#xpbar`** merges into the HP bar as a thin under-rail (it is currently 4px
  *below* the viewport bottom on both phone and tablet).
* **Top HUD** collapses on `compact`: floor + collapse timer + HP in one row;
  viewers/favourites/hype fold into a single tappable "SHOW" pill.
* **Ticker and log** are already hidden on phones — keep, but route their content
  into the modal map/show sheet so nothing is unreachable.
* **Cluster geometry** is arc-based per posture — pivot, radius **and fan** —
  and it is settled in §4.2a.

### 4.2a The cluster: pivot, radius, fan — contradiction 5, decided

The side pivot at `(safeEdge + 26, 0.62 H)` is right about the hand and wrong
about the cluster, and the document contradicted itself because it only fixed
the first half.

**What §1.5 condemns, in its own words:** on the Pixel 5 "the ability cluster is
**64% of the screen height**, and the ultimate chip lands at y = 126, level with
the HP bar." A cluster that climbs the outer edge into the playfield is the
named failure of the phone layout. **What §3.2/§4.2 then proposed for tablets:**
a pivot at 62% of the height with the existing arc fanning `−12°…+100°` — i.e.
almost entirely *upward* from it. Run the numbers on an iPad Pro 11
(`safe.h ≈ 766`, `arcRadius ≈ 206`): the cluster would span y ≈ 322…520, the
CANCEL band (specified as "above the cluster") would land at y ≈ 186 — **22% down
the screen, inside the boss health plate's own zone** — and the ultimate would
sit level with the top HUD. The tablet proposal reproduced, deliberately, the
exact geometry the phone audit calls unusable.

**The actual bug is the fan, not the pivot.** The `ARC` table spans −12° to
+100° about the inboard horizontal because it was authored for a **corner**
grip, where up-and-inboard is the only direction that exists. A thumb rooted
halfway up the side edge sweeps a fan that is *symmetric* about the inboard
horizontal — there is as much room below it as above it. Fanning a side-grip
cluster upward wastes half the thumb's arc and spends the other half on the
playfield.

**Decision: posture selects pivot, radius cap and fan together.**

| | `compact` / `phone` — corner grip | `tablet-s` / `tablet-l` — side grip |
|---|---|---|
| pivot | `(safeOuter − 26, safeBottom − 26)` | `(safeOuter − 26, safe.y + 0.58 × safe.h)` |
| fan | **+6° … +96°** about inboard horizontal (up and inboard — there is nothing below a corner) | **−46° … +46°**, symmetric (the thumb has room both ways) |
| arc radius | `min(comfortable − maxChipHalf − 6, 0.58 × safe.h)` | `min(comfortable − maxChipHalf − 6, 0.62 × safe.h)` |
| CANCEL band | a strip **above** the cluster (§2.2's map) | a strip pinned to the **bottom-outer corner** of the safe box, ≥ 24 px below the lowest chip |
| ultimate | top of the fan (+96°), furthest from a resting thumb | top of the fan (+46°), same reason |
| basic attack | nearest the root (rf 0.30) | on the inboard horizontal (0°), the most-pressed position |

Chip size joins the hand-scale set:
`chipBase = clamp(10.5mm / MM_PER_PX[cls], MIN_TARGET 44, 76)` → **64 px on a
phone, 55 on a tablet**. The old `0.13 × shortEdge` gave 44 px on an iPhone
(7.3 mm — Apple's bare 44 pt floor, not a comfortable target) and a clamped
76 px on an iPad (14.6 mm — oversized). 10.5 mm is the middle of the 9–11 mm
comfortable-target band, on both.

Worked instances:

| device | pivot | arc radius | cluster vertical extent | topmost chip, as % down the safe box |
|---|---|---|---|---|
| Pixel 5 (802×293, `compact`) | (766, 255) | `min(234−45−6, 0.58×269) = 156` | 156 px = 58% of `safe.h` | 41% |
| iPhone 13 (750×342, `phone`) | (677, 297) | `min(274−45−6, 0.58×297) = 172` | 172 px = 58% | 41% |
| iPad Pro 11 (1194×834, `tablet-s`) | (1146, 480) | `min(250−38−6, 0.62×766) = 206` | `2 × 206 × sin46° = 296` px = 39% | 39% |

**The invariant, and it is a test, not a hope** (`test/touchLayout.test.ts`):

1. **No control in `COMBAT_CONTROLS` may have any part of its 44 px hit rect
   inside the top 32% of the safe box.** That band belongs to the boss health
   plate, the headline banner and the HP rail — the things a player reads while
   the cluster is being pressed.
2. **Cluster vertical extent ≤ 46% of `safe.h`** on side grip, `≤ 58%` on corner
   grip (a corner grip has nowhere else to go, and it does not overlap the read
   band because rule 1 still binds).
3. **Every combat control lands inside `comfortable` of its posture's pivot**,
   at every slider position, on all six matrix viewports.
4. **The CANCEL band never overlaps the cluster and never enters the top 40% of
   the safe box.**

Rules 1 and 4 are the ones that were missing, and they are what makes the side
pivot safe to keep rather than something to argue about again next round.

**Versus Wild Rift.** Wild Rift ships one bottom-right cluster shape and lets
the player drag individual buttons anywhere, with per-button scale and opacity —
its answer to "a tablet is not a phone" is *the player fixes it*. We **beat**
that on the default (a tablet gets a correct posture out of the box, which is
what almost every player will actually use) and remain **behind** on the ceiling
until the free-drag editor lands (LATER #20). §5 says so in the same words.

### 4.3 Safe areas

Publish the insets once, then use them everywhere:

```css
:root {
  --sa-t: env(safe-area-inset-top, 0px);
  --sa-r: env(safe-area-inset-right, 0px);
  --sa-b: env(safe-area-inset-bottom, 0px);
  --sa-l: env(safe-area-inset-left, 0px);
  --hud-pad: 12px;                 /* player-adjustable 0-32px */
}
```

Every fixed-position HUD element then offsets by
`calc(var(--sa-*) + var(--hud-pad))` — including the five that use raw pixels
today (`#minimap-frame`, `#t-stairs`, `#xpbar`, `#toasts`, `#tutorial`). The
stick zone and the cluster pivot read the same numbers in JS via
`getComputedStyle(document.documentElement).getPropertyValue('--sa-l')` so the
touch zones and the paint agree.

### 4.4 Orientation

* **Gate gameplay only.** The rotate card should cover the dungeon, not the
  campfire menu, the leaderboard, the recap or the shop — all of which read
  *better* in portrait and are currently walled off (`r2/iphone13-menu.png`).
* Recompute zones on `orientationchange` **and** on the `visualViewport` resize
  that follows it (iOS fires them apart). The `orientation` suspend reason
  (§2.9a) is raised at the boundary and held until **250 ms after the last**
  `visualViewport` resize — same refund, same dead-pointer marking — so a
  rotation mid-drag cannot leave a stuck or queued cast, and the layer is never
  live against stale zones during the two-event window.
* The rotate gate itself raises the `rotate-gate` reason. It is z 40 and
  deliberately outranks `body.modal`, which is exactly why an ID-list gate could
  not see it.
* Tablets get a real portrait gameplay layout: cluster bottom-right, stick
  bottom-left, world square in the middle. A portrait *phone* layout is LATER.

### 4.5 Panels become touch-first, not shrunk desktop

The rules, applied to `#inv`, `#sheet`, `#abil`, `#saferoom`, `#draft`,
`#recap`, `#menu`, `#keys`. Every "today" number is from `--measure` (§1.3).

1. **Every panel gets a close control** — a 44px ✕ at the top-inboard corner
   *and* a full-width DONE bar pinned to the bottom inside the safe gutter.
   Today: **zero close controls on every panel measured**.
2. **Backdrop tap closes. Swipe down closes.** Both, always. Today
   `tap-outside closes = false`.
3. **The shop, corrected.** It is **not** a three-column layout: `.shop-body` is
   a two-track grid (`350px 348px` on a phone, `738px 348px` on a tablet), with
   the bag nested inside the right track. The phone failures are, in order of
   severity: the bag renders at y = 363 on a 342-tall viewport (**off-screen**),
   the detail pane hides 178px of its 176px-tall box, the panel itself overhangs
   both the top and bottom edges by 4px, and **all 8** interactive controls are
   under 44px (SELL ALL is 68×**18**).
   The fix: a segmented control (SHELF · DETAIL · BAG) with one pane visible at a
   time on `compact`/`phone`, tabs raised to 44px on every class, and the panel
   constrained to the safe box with its own internal scroll rather than
   overhanging the viewport.
4. **The shop's actual loop gets a touch spec, not just SELL ALL.** There is no
   buy button today (`buyButtons: []`); purchase is an undiscoverable click on a
   shelf tile. Specified: tap a shelf tile → DETAIL pane with a full-width
   **BUY — 210g** bar (44px, disabled and labelled when unaffordable); tap an
   equipped/bag cell → the same pane with **EQUIP** / **SELL — 105g**; SELL and
   SELL ALL take a two-step confirm; every purchase pushes the existing
   `#sr-stamp` confirmation and a haptic tick. Equip is tap-tap, never drag.
5. **Hover content becomes a tap-to-open sheet.** The character sheet's "hover
   anything for the math" turns into tap-a-row → a bottom sheet with the
   derivation. Same for item tooltips in the shop and inventory.
6. **The character sheet** on a phone is 799px of grid tracks in a 708px
   container (89px severed horizontally, 383px vertically). It becomes stacked
   sections on `compact`/`phone`; it already fits on `tablet-*` and needs only
   the close control and the tap-to-open math sheets.
7. **The inventory** keeps EQUIPPED and BAG side by side at 301px each even on a
   750px phone, with 32px-tall item rows and 160px of hidden scroll. It becomes
   EQUIPPED / BAG tabs with 44px rows.
8. **Glyph socketing is tap-tap, never drag-and-drop.** Nothing in the codebase
   uses HTML5 drag events (which do not fire on touch), so socketing is already
   click-based; it needs bigger targets and a visible
   "select glyph → select socket" pending state, not a new interaction model.
9. **The constellation, corrected.** It is **not** "a fixed-size spine scaled
   down until it is unreadable" — that claim was a source inference and it was
   wrong on both counts. Measured (`r7/`): `#abil .grid` is a `columns: 2` block
   flow of 13 ability cards, 332px wide each, entirely legible
   (`r7/iphone13-land-constellation.png`). Its only interactive elements are the
   per-card SLOT/BENCH buttons, all ≥ 44px; the 8×8 rank pips are **display
   only** — ranks come from level-up drafts, not from tapping the chart.
   The real failure is navigation: a 1492px-tall card grid inside a 295px panel, and
   **1847px of total scroll** once the achievements and run-stats sections
   below it are counted (1433px on an iPad), with no close control, no
   section index, and no way to reach a named ability except thumbing through it.
   The fix is therefore a **sticky ability-picker rail + jump-to-card**, one card
   per screen on `compact`/`phone`, and a "next affordable node" jump — *not* a
   canvas rewrite, and *not* pan-and-pinch. This is scoped at SHOULD #17, and the
   old LATER #24 "controller-style radial" is withdrawn as a solution to a
   problem that does not exist.
10. **Level-up draft cards** already work by tap (they carry click handlers and
    are ~90px tall) — keep, drop the "press its number" hint on touch, and
    **right-align the card row** (mirrored with `handed`) so the tap targets sit
    under the casting thumb. `r4/ipadpro11-land-shop.png` shows them occupying
    the left half of a tablet; "widen to the safe width" would have pushed them
    further from the thumb, which was the wrong instruction.
    *Unverified:* the draft scene could not be opened headlessly (banking a
    level-up requires XP the harness cannot mint cleanly), so the r4 capture is
    the only evidence and no card rects have been measured. The §8.3 gate
    requires a measured draft capture before this item is called done.

---

## 5. BEATING WILD RIFT

**This section is split in two on purpose.** A critic read the old §5 as a
scoreboard — the top of the document says the touch core is shipped and quotes
19 PASS / 0 FAIL, and the table below it said things like "Cancel: better — two
ways to bail" and "Indicator: equal, with a twist they cannot have" about work
that was not on the glass. A heading that says UNSHIPPED does not undo a table
that reads like results. So §5.1 is only rows a battery has measured on a
device, with the measurement; §5.2 is everything still aspirational, and no row
may move up without a number.

### 5.1 SHIPPED AND MEASURED

Every row here is asserted by a check in `tools/mobileshot.mjs` or
`tools/_mobile/r2check.mjs`, driven with real CDP touch on the device matrix,
and every check ends in a value the page or the sim owns.

| interaction | verdict vs Wild Rift | the measurement |
|---|---|---|
| **Movement** | equal | floating stick with origin recentring past 1.35 R; battery moves 4.7-16.2 tiles. Analogue walk/run is **withdrawn** (§2.3) |
| **Resting affordance** | equal | `#t-ghost` paints a solid ring + hub at the anchor, opacity 0.34, 138x138 at (98,175) on an iPhone 13. Round 1's dashed 2px at 12.5% effective alpha measured as nothing |
| **Tap vs aim classification** | **better** | travel-only from a leaky origin; `test/touchIntent.test.ts` asserts a byte-identical Intent for a 40 ms tap and a 3 s hold, and the five speed rows |
| **Aim throw** | **better on the default** | `18 mm` per class, one phone hand constant (§2.0); asserted to the pixel across the matrix |
| **Interruption safety** | **better on the guarantee** | 8 refcounted suspend reasons + an 8 s reaper; `test/panels.test.ts` catches a new overlay |
| **Indicator shape** | *(claim withdrawn — see ROUND 3)* | the six shapes are built from the live `AimSpec` and asserted in `test/aimIndicator.test.ts`, but for four rounds they were built at the wrong PLACE: the host multiplied a tile distance by the drag's pixel magnitude and every placed shape landed 110-175x too far out. A shape nobody could see is not a verdict against anybody |
| **Indicator timing** | equal | appears on `pointerdown`, same frame |
| **Cancel** | **deliberately ONE way on a phone** | `cancelMode: "origin"`, drawn as a 79x79 ringed ✕ at the frozen origin, 0% of it inside the movement thumb's zone. The round-1 band measured 92% inside that zone and 176 px out of reach — see §4.2a |
| **Potion** | n/a (they have none) | `#flask-chip` carries `lowhp` + a running `flask-cry` animation at 32% HP, and a `potion` haptic on refill |
| ~~**Loot**~~ | *(moved to §5.2 — unverified)* | three staged kills across two devices produced no new entry in `state.loot`, and `#pickstrip` measured 0x0 with 0 child rows in every sample. Either the drop staging is wrong or the feature never fires; until a battery shows `bag` or `gold` moving AND a `#pickstrip` row appearing, this does not belong in a table called SHIPPED AND MEASURED |
| **Shop** | **parity on the verb** | a finger tap on a shelf tile renders the card, and a finger tap on BUY moves GOLD (20000 -> 19955) on iPhone 13, Pixel 5 and iPad Pro 11. Price and BUY both report `onScreen: true` |
| **Panels** | equal | ✕, DONE, backdrop tap **and** swipe-down all close `#inv` and `#sheet` by real touch (the swipe runs on the TOUCH stream; the pointer stream is cancelled by Chrome's pan after one move) |
| **Notch / reachability** | **better** | `--sa-*` everywhere + a player HUD-inset slider; battery reports 0 intrusions |
| **Chip hierarchy** | equal | the ultimate is the largest chip in the cluster on both postures, asserted in `test/touchLayout.test.ts` |

### 5.2 STILL A TARGET

Nothing in this table has a measurement behind it. It is what we are aiming at.


| interaction | Wild Rift | us (proposed) | target verdict |
|---|---|---|---|
| **Movement** | floating stick, dead zone | floating stick **with origin recentring** past 1.35 R | **better on recentring** — the stick cannot run out under a drifting thumb. The walk/run half of this claim is **withdrawn**: `game.ts` normalizes `Intent.move`, so analogue speed needs a sim change (§2.3). Whether Wild Rift recentres is asserted from play, not from a source we can cite — treat the movement row as "equal, pending a side-by-side" until someone runs both |
| **Ability activation** | tap = smart cast, drag = aimed, per-slot toggle | same, **plus** a third per-slot mode (`tap` / `tap-release` / `aim-only`) so ultimates can be forced to require a drag | **better** — fat-fingering an ultimate is our worst-case mis-input and theirs too; they do not let you lock it |
| **Tap vs aim classification** | movement-based; holding a button without moving does not arm an aim *(observed, not cited)* | movement-based from a **leaky origin** at 40 px/s (§2.4a) | **better** — a fixed slop cannot tell a 500 ms hold's 1–4 mm of contact-centroid creep from a deliberate 4 mm aim; a leaky origin can, and it is 12 lines |
| **Aim throw** | fixed per-button wheel + a sensitivity slider *(settings-UI report)* | `18 mm` per class → 94–110 CSS px, + a slider (§2.4b) | **better on the default** — theirs is right where the slider was left; ours is 4.8° of angular jitter on every device before the player touches anything |
| **Tap vs long-press on the world** | ping is a drag-out wheel on a ping button, not a world long-press | one threshold at 450 ms, arming announced with a ring + haptic; **no tap ceiling** (§2.5a) | **deliberately different** — one ping type, not four. Equal at best; the win is only over our own 200–450 ms dead band |
| **Interruption safety** | casts cancel and the stick drops on call / app-switch *(observed)* | 8 enumerated refcounted suspend reasons + an 8 s stuck-pointer reaper (§2.9a) | **better on the guarantee** — the reaper covers the iOS background path that fires no pointer event at all, and a new panel is caught by a test rather than by remembering to edit a list |
| **Indicator timing** | appears on touchdown | appears on touchdown | equal (today: only after the drag slop — a fix, not a win) |
| **Indicator legibility** | tuned, high-contrast, reserved palette | §3.1 shipped: reserved cyan/white, dark outline, 3 px stroke floor, 96 px footprint floor | **unproven, and the earlier diffs were measuring nothing.** Every legibility diff before round 3 was taken inside the indicator's own projected box — which, for six of ten abilities, was a degenerate rectangle hundreds of tiles off-screen (ROUND 3). Re-shot with real touch held through the frame, the numbers were iPhone 13 bolt Δ 9.8 vs a Δ 7.8 churn floor = 1.26x, and Δ 5.6 vs Δ 8.1 = 0.69x over the full frame; iPad bolt 1.00x; ultimate 0.85x (iPhone) / 0.96x (iPad). A separate round measured iPhone 2.10x and Pixel 5 1.61x, i.e. the row would close on one phone and not the other. **The shapes are now in frame, so the diff can finally be taken against something real — and it has not been. This row stays here, and it may not be quoted per-device until it is re-shot post-fix on the whole matrix.** |
| **Target priority** | lowest-HP-in-range with a last-hit bias | locked > last-damaged-3s > lowest HP fraction in range > nearest, with a facing cone weight | equal — theirs is tuned by a decade of telemetry; ours matches the shape and we should expect to iterate |
| **Target lock** | dedicated lock toggle | world tap to lock + sticky-lock toggle | equal |
| **Tap to move + auto-attack** | tap ground to move, tap champion to attack | same, reusing `clickMove.ts` verbatim | equal |
| **Dodge** | flash is an ability button | dash chip **plus** flick-on-stick **plus** two-finger tap | **better** — a dungeon crawler dodges far more often than a MOBA flashes; a gesture removes a thumb trip per second |
| **Potion** | no equivalent | flask chip with charge pips and refill haptic | n/a |
| **Loot** | no equivalent | automatic in the sim; ground ring + non-intrusive pickup strip | n/a |
| **Shop ergonomics** | full-screen touch shop, recommended-build row | a one-pane segmented shop that now BUYS (§5.1) | **behind on the surface, level on the verb.** A phone still gets the desktop information architecture with two thirds hidden; their shop is designed for the phone |
| **Haptics** | subtle, on cast and hit | mapped table in §3, off-switchable | **behind on iOS, equal on Android.** "Degrading cleanly" was a euphemism: `navigator.vibrate` does not exist in iOS Safari at all, `Haptics.supported` is false, and every press / cast / cancel / refuse cue is SILENT on iPhone and iPad — which is the larger half of the target platform, and the half whose players are used to a Taptic Engine. The table and the rate limiter are good work aimed at a device that cannot receive them. The compensation is visual: on `pointer: coarse` where `vibrate` is missing, the press state has to carry the whole acknowledgement, and §3.5 owes that |
| **Notch / reachability** | full safe-area respect | `--sa-*` everywhere + a player HUD-inset slider | **better** — the slider covers thick cases, screen protectors and Android OEM oddities that a fixed inset cannot |
| **Reach model across device sizes** | one cluster shape, fixed by the player with per-button drag | posture per class, geometry in **millimetres** (§3.2, §4.2a) | **better on the default, behind on the ceiling** — an iPad gets a correct side-grip fan out of the box; they get whatever the player dragged. Reversed once LATER #20 ships and we have both |
| **Left-handed** | mirrored layout absent; **per-button drag positioning with scale/opacity present** | full mirror (MUST-adjacent, SHOULD #16) + free-drag editor (LATER #20) | **better on mirroring; behind on the editor until #20 ships.** §6 and §8.3 now agree: sliders are SHOULD, the free-drag editor is LATER |
| **Frame budget** | 60 fps target on mid phones | quality ladder with runtime tuner already shipped (`quality.ts`) | **unmeasured on mobile.** §0 rules this harness out for timing and `gpuprobe.mjs` is a desktop D3D11 path. No claim until the real-device gate runs |

Where they are simply ahead and we should not pretend otherwise: shop
ergonomics, indicator legibility as it stands today, the layout editor, and the
sheer amount of tuning behind their target-priority heuristic. All are iteration
problems, not architecture problems — but they are unpaid today.

---

## 6. ACCESSIBILITY AND CUSTOMISATION

A new `TouchPrefs` blob beside the existing `TouchPref`, persisted in
`src/input/bindings.ts` alongside `saveTouch`:

```ts
interface TouchPrefs {
  handed: "right" | "left";          // mirrors zones, cluster, HUD anchors
  stickScale: number;                // 0.7 - 1.4, scales R only (2.3)
  buttonScale: number;               // 0.7 - 1.4, scales chipBase + aimThrow (2.4b)
  thumbReachMm: number;              // 38 - 62, default 48 (3.2) — the one
                                     //   number no formula can see, because it
                                     //   is the player's hand
  mmPerPxOverride: number | null;    // harness / oddball-DPI escape hatch
  opacity: number;                   // 0.35 - 1.0, idle only; full on press
  hudInset: number;                  // 0 - 32px on top of env(safe-area-*)
  haptics: "off" | "light" | "full";
  castMode: Record<SlotIndex, "tap" | "tap-release" | "aim-only">;
  flickDash: boolean;
  tapToMove: boolean;
  stickRecenter: boolean;
  reducedMotion: boolean;            // seeded from prefers-reduced-motion
  layout: Partial<Record<ControlId, {x: number; y: number}>> | null;
}
```

* **Left-handed / mirrored** is a single transform of the zone table plus
  `flex-direction` flips — because zones are data, not CSS constants.
  **Tier: SHOULD #16**, with the size/opacity/inset sliders.
* **The free-drag layout editor is LATER #20**, and this document does not claim
  a win over Wild Rift on it (§5). A "CUSTOMISE CONTROLS" mode dims the world,
  makes every control draggable within its safe region, shows the reach arcs
  live, and offers RESET. Thumb length varies more than screen size, so it is
  warranted — it is simply not this round.
* **Reduced motion** (`prefers-reduced-motion`, overridable): no screen shake,
  no hit-stop freeze, indicator fades instead of pulses, cards do not slide.
  Hit-stop currently also *delays input consumption* — with reduced motion on,
  edges must still be consumed on schedule.
* **Colour**: handled structurally in §3.1 — the cancel state's primary signal
  is a dashed stroke plus a ✕ glyph, and the valid state uses a hue the world
  does not otherwise use. Colour never carries a state alone.
* Everything above is surfaced in the K panel, which becomes a proper
  touch-first settings sheet with a CONTROLS tab.

---

## 7. PERFORMANCE ON PHONES

### 7.1 The preset a phone must pick — and why it probably does not today

`guessQuality()` (`src/render3d/quality.ts`) has a correct mobile branch:

```ts
if (/adreno|mali|powervr|apple a\d/i.test(renderer)) {
  return dpr >= 3 ? "performance" : "balanced";
}
```

…which is reached only if `WEBGL_debug_renderer_info` yields a renderer string.
**Safari does not expose that extension**, so on an iPhone or iPad the string is
`""`, the mobile branch never fires, the integrated-GPU branch never fires, and
control falls to:

```ts
if (cores <= 4) return "high";
return "ultra";
```

`navigator.hardwareConcurrency` is either absent (→ the `|| 8` default) or
comfortably above 4 on modern Apple silicon, so **an iPhone should boot at ULTRA
with no pixel-ratio cap at dpr 3**. Under emulation with the URL override
removed, the harness measured `preset: "ultra"`, backbuffer 2388×1668, on the
iPad descriptor and `preset: "high"` on the iPhone descriptor.

**This is a code-path argument plus a Chromium-emulated corroboration. It has
never been observed on a real iPhone**, because Safari is the whole point of the
claim and Chromium-under-emulation is not Safari. The real-device gate in §8.3
exists primarily to settle this. The fix below is worth shipping either way —
it removes a dependency on a privacy-gated extension — but the *severity* of the
bug is unconfirmed.

**Fix**: make the guess independent of the extension. Order:

1. explicit URL / saved choice (unchanged);
2. `(pointer: coarse)` **and** short screen edge < 560 → `performance`
   (a phone at dpr 3 is 1.0 pixel-ratio-capped; PERFORMANCE keeps GTAO, full FX
   density and full mote density, so nothing a player can *name* is lost —
   only sharpness);
3. `(pointer: coarse)` and short edge ≥ 560 → `balanced`
   (`pixelRatioCap: 1.2`, the measured 60 fps rung);
4. the existing renderer-string branches, which still help on Android Chrome
   where the extension *is* available;
5. today's desktop fallbacks.

Keep `guessQuality` pure and pass the media-query result in, so
`test/quality.test.ts` can drive it. Also lower the tuner's initial climb
ceiling on coarse-pointer devices: a phone that thermally throttles at minute
three must not be climbing at minute two.

### 7.2 Touch-layer frame budget

**Budget: < 0.15 ms per frame and zero steady-state allocations.**

The five allocations per polled frame are real and countable (§1.9); the harm is
not measured, and the one measurement available — a 0-byte heap delta over 240
rendered frames — says they are below Chromium's ~100 KB reporting quantum. The
cleanup is therefore **SHOULD #12**, gated on a profile that shows the layer over
budget, not a MUST.

What the cleanup is, when it happens:

* `TouchController.sample()` returns a **preallocated, mutated** `TouchSample`;
  `castHeld` is a preallocated array; pending casts drain into a preallocated
  ring instead of `splice(0)`.
* `VirtualStick.value` / `.nub` write into caller-supplied out-vectors.
* Zone rectangles are cached and recomputed only on `resize` /
  `orientationchange` / pref change — **this one is not optional and is MUST-side
  anyway**, because the zone table is what §2 is built on.
* The indicator writes into an existing `THREE.Group` transform (already true in
  `setAimIndicator`) and its geometry is rebuilt **only when the ability or its
  computed range changes**.
* DOM writes for the stick and chips go through `style.transform` only — today
  `onStick` writes `left`/`top` on `#t-stick`, which lays out on every
  pointermove. **This one is a MUST**: it is a forced layout inside a drag
  handler, which is a latency bug, not an allocation bug.
* The touch layer never reads layout (`getBoundingClientRect`) inside a pointer
  handler; all hit-testing is arithmetic against cached rects.

Measure with `tools/gpuprobe.mjs` (`--use-angle=d3d11`) for the desktop path and
with Safari Web Inspector against a tethered iPhone for the one that matters.

---

## 8. MIGRATION MAP

### 8.1 Seams

| file | change | size |
|---|---|---|
| `src/input/touch.ts` | keep `VirtualStick` (add recentring); rename `SlotButton` → `AbilityButton` and add `PRESSED/AIMING/CANCEL` + cancel band + per-slot modes + the modal/interrupt cancel path; extract the DOM shell into `touchShell.ts` so the state machines stay DOM-free | 2 d |
| `src/input/touch.ts` — **§2.0 rework** | add the leaky origin (`ORIGIN_LEAK = 40`) and freeze-on-promotion; take `aimThrow`/`cancelRadius` from the zone table instead of borrowing `stickRadius`; **delete `TAP_MS`** and the world recogniser's upper bound; replace `setModalOpen(boolean)` with `suspend()/resume(reason)` over a refcounted `Set<SuspendReason>`; add the `POINTER_TTL = 8000` reaper | **1.5 d** |
| `src/input/touchLayout.ts` | **new, pure.** `computeZones(viewport, insets, prefs) → ZoneTable`. Handedness, scales, pivots and the cluster arc live here. **§2.0 rework**: add `MM_PER_PX`, replace `reachArcs(shortEdge)` with the millimetre model (§3.2), split the corner and side `ARC` tables (§4.2a), emit `aimThrow` + `cancelRadius` and assert the threshold ordering (§2.4a) | 1.5 d + **1 d** |
| `src/input/targeting.ts` | **new, pure.** `pickTarget(candidates, opts) → id \| null` replacing `autoAimDir` | 1 d |
| `src/input/clickMove.ts` | unchanged; wired to the world-zone tap path | 0.5 d |
| `src/input/bindings.ts` | add `TouchPrefs` + load/save | 0.5 d |
| `src/input/haptics.ts` | **new.** Event→pattern table, rate limiter, pref gate, feature check | 0.5 d |
| `src/main3d.ts` | `sampleIntent` keeps its exact shape; swap `autoAimDir` for `pickTarget`; add lock state; feed `haptics` from `frameHits`/`frameAnns`; rebuild the touch wiring against the zone table; **delete the nine-ID modal list and drive `modal` from a `body`-class observer**, then wire the other seven reasons (§2.9a): `[data-sheet]`, `#rotate`, `orientationchange`+`visualViewport`, `visibilitychange`/`pagehide`/`blur`, `state.status`, the editor, `contextmenu`/`gesturestart` | 2 d + **0.5 d** |
| `src/render3d/renderer3d.ts` | `setAimIndicator(kind, from, dir, range, radius, arc)` — real numbers, outline pass, cancel/out-of-range states, new `cone` and `scatter` shapes, min-footprint clamp | 2 d |
| `src/render3d/quality.ts` | `guessQuality` takes a `coarse`/`shortEdge` hint | 0.5 d |
| `iso.html` | **see the risk row below** | 5 d |
| `tools/mobileshot.mjs` | harness upkeep: FAIL-list regression mode, re-run every round | 0.5 d |

**Per-ability indicator inventory** (the split for MUST #6 — the shapes are not
one task, and two abilities have no usable number at all today):

| ability | shape today | real source | work |
|---|---|---|---|
| `nova` | ring 2.0–2.2 | `novaParams().radius` (2.6 base, +25%/rank, staff mult) | plumb |
| `cataclysm` | ring 2.0–2.2 | `cataclysmParams().radius` (**6**) | plumb — 2.3× wrong today |
| `orbit` | — | `orbitParams().radius` (1.6) | plumb |
| `dash` | arrow 2.2 | `dashParams().distance` (3.2 × 1+0.3/rank) | plumb + landing footprint |
| `cutTo` | line 4.2 | `cutToParams().range` (6) | plumb |
| `crowdsurf` | ring | `crowdSurfParams().range` (7) — a **chain reach**, not a radius | **wrong shape**: needs a chain preview |
| `melee` | line 4.2 | `meleeParams().range` (1.3) + `.arc` (90° + 22°/rank) | **new shape**: cone |
| `airstrike` | ring | no radius field; `ultAirstrikeSpread` 2.2 scatter × `ultAirstrikeRadius` 1.6 per shell | **new shape**: scatter footprint |
| `bolt` | line 4.2 | **no range field at all**; reach ≈ `boltSpeed 12 × boltTtl 1.2` = 14.4 tiles before pierce/collision | needs a derived helper in `abilities.ts` (pure, testable) |
| `stance`, `overcharge`, `bulletTime`, `stuntDouble` | line 4.2 | no geometry | draw **nothing** — today they all draw a bogus line |

### 8.2 Tests

* `test/touch.test.ts` — extend: recentring, cancel band entry/exit, per-slot
  cast modes, refused presses on cooldown, flick-from-velocity.
* `test/touchLayout.test.ts` — **new**: zone tables for the six measured
  viewports; mirrored layout is a true reflection; nothing lands in a safe-area
  gutter; **no in-combat control outside `comfortable` from its class's pivot**.
  Plus the four §4.2a invariants and the §2.4a ordering, each at
  `stickScale`/`buttonScale`/`thumbReachMm` = min, default and max:

  | assertion | source |
  |---|---|
  | `AIM_SLOP < cancelRadius < 0.5 × aimThrow` on every class and slider position | §2.4a |
  | `R`, `aimThrow`, `chipBase` are within 4% of 11 / 18 / 10.5 mm once converted back through `MM_PER_PX` | §2.0 |
  | no `COMBAT_CONTROLS` hit rect intersects the top 32% of `safe` | §4.2a 1 |
  | cluster vertical extent ≤ 46% of `safe.h` on side grip, ≤ 58% on corner grip | §4.2a 2 |
  | `cancelBand` overlaps no chip and stays out of the top 40% of `safe` | §4.2a 4 |
  | side-grip fan is symmetric: `\|maxAngle + minAngle\| ≤ 1°` | §4.2a |
* `test/targeting.test.ts` — **new**: the full priority ladder, range respect,
  dormant exclusion, tie-breaks.
* `test/touchIntent.test.ts` — **new, the important one**: a table of gestures
  and the exact `Intent` they must produce, asserted **equal to the `Intent` the
  keyboard produces** for the same action. Required rows:

  | gesture | expected |
  |---|---|
  | press, no travel, release after 40 ms | smart cast at `pickTarget` |
  | press, no travel, release after **300 ms** | smart cast — **identical Intent** to the 40 ms row |
  | press, no travel, release after **3000 ms** | smart cast — still identical (§2.4a: no time term exists) |
  | press, held 800 ms with **12 px/s of drift** (centroid creep) | smart cast — the leaky origin absorbs it; state never leaves PRESSED |
  | press, held 3 s with **30 px/s of drift** | smart cast — still under `ORIGIN_LEAK` |
  | press, **100 px/s** deliberate slow drag | promotes to AIMING at 300 ± 30 ms, aimed cast |
  | press, **300 px/s** drag | promotes at 69 ± 10 ms |
  | promotion, then the finger drifts | the aim vector is measured from the **frozen** origin, not a leaking one |
  | press, travel 19 px, release | aimed cast along the drag |
  | press, travel 19 px, return inside `cancelRadius`, release | cancel — no cast, no cooldown |
  | placed shape (`ring`), drag = 0.5 × `aimThrow` | `dist = (0.15 + 0.85×0.5) × range`; over-throw at 2 × `aimThrow` clamps to `frac = 1.0` |
  | line/cone/chain shape, drag = 0.3 × `aimThrow` | **direction only** — `frac` is ignored, full derived reach |
  | press, travel 19 px, drag magnitude below dead zone at release | smart cast, never a zero-vector aimed cast — asserted as an unreachable-by-construction floor |
  | press, travel 19 px, **each of the eight suspend reasons** raised, release | cancel; **no cast now and none when the reason clears** |
  | two reasons raised, one cleared | still suspended (refcount) |
  | last reason cleared, `pointerdown` at +60 ms | ignored (120 ms deaf frame); at +140 ms it lands |
  | pointer down, no move, no up, 8 s | reaped as cancel; stick zeroed; `castHeld` released |
  | press slot A, then press slot B while A resolves | one queued smart cast for B |
  | …and A is cancelled instead | **B's queued cast is dropped** |
  | queued cast, 250 ms elapse | dropped |
  | stick flick at 2.6 R/s | dash cast + movement `Intent` unchanged in shape |
  | two-finger world tap, both up < 200 ms, < 16 px | dash |
  | two-finger world drag, 250 ms / 40 px | camera peek, **no dash** |
  | world tap, up at 120 ms | click-move target set |
  | world tap, up at **320 ms** (the old dead band) | click-move target set — **identical Intent** to the 120 ms row |
  | world press, up at 449 ms | click-move target set |
  | world press 450 ms → arm fires → release | ping |
  | world press 450 ms → arm fires → slide 20 px → release | **neither** — the abort is the only path that produces nothing, and it is deliberate |
  | click-move live, stick pressed | click-move path cleared |
* `test/panels.test.ts` — **new, and it is what makes §2.9a hold**: parse the
  screen-zone map in `iso.html`, take every overlay at z ≥ 20, and assert each
  one sets `body.modal` while visible. A new panel is then either registered or
  red, and nobody has to remember an ID list.
* `test/quality.test.ts` — extend for the coarse-pointer branches.

Gates: `npx tsc --noEmit` clean, `npx vitest run` green, and a
`node tools/mobileshot.mjs --drive` run with no FAIL rows other than ones
explicitly marked as known.

### 8.3 Scope, sequence and risk

Sizes are engineer-days including tests. Sequence is a dependency order, not a
wish list: **A must land before B**.

**PHASE A — the layout spine (blocks everything else): 6 d**

| # | item | size |
|---|---|---|
| 1 | `touchLayout.ts` + zone table + device classes + **millimetre geometry** (`MM_PER_PX`, reach arcs, two `ARC` tables, `aimThrow`/`cancelRadius`, the four §4.2a invariants) (§2.0, §3.2, §4.1, §4.2a) | 3 d |
| 2 | `--sa-*` safe-area plumbing everywhere; lift `#xpbar` back on screen (§4.3) | 1 d |
| 3 | move the minimap and transient cards out of the stick zone; MAP chip in the arc (§4.2) | 1.5 d |
| 4 | `compact` class so Pixel-5-shaped screens have a layout (§4.1) | 1.5 d |

**PHASE B — the panels (independent of C; the biggest `iso.html` block): 7 d**

| # | item | size |
|---|---|---|
| 5 | close control + backdrop tap + swipe-down on all eight panels (§4.5 1–2) | 2 d |
| 6 | shop: segmented panes, 44px targets, real BUY/EQUIP/SELL flow (§4.5 3–4) | 2.5 d |
| 7 | sheet stacked sections + tap-to-open math sheets; inventory tabs (§4.5 5–7) | 1.5 d |
| 8 | constellation picker rail + jump-to-card (§4.5 9) | 1 d |

**PHASE C — the control model (depends on A): 8 d**

| # | item | size |
|---|---|---|
| 9 | per-slot FSM: **leaky-origin** travel-only AIMING, `aimThrow`-based range mapping, cancel band, refused presses, cast modes (§2.4a, §2.4b) | 2.5 d |
| 9b | world recogniser: **delete `TAP_MS`**, ping arm/commit split (§2.5a) | 0.5 d |
| 10 | **refcounted input authority: eight suspend reasons + stuck-pointer reaper + bounded cast queue** (§2.9a) — fixes §1.7 and the six overlays it missed | 1.5 d |
| 11 | resting ghost ring + indicator on `pointerdown` (§2.3, §2.4) | 0.5 d |
| 12 | indicator geometry from `abilities.ts`, **split by shape**: ring/arrow/line plumbing 1 d · cone (melee) 1 d · scatter (airstrike) 1 d · chain (crowdsurf) 0.5 d · bolt range helper 0.5 d | 4 d |
| 13 | indicator legibility pass: palette, outline, stroke floor, footprint floor, iso mapping, occlusion (§3.1) | 1.5 d — *may run in parallel with 12* |
| 14 | `transform`-only stick/chip DOM writes (the forced-layout fix, §7.2) | 0.5 d |

**PHASE D — the wins (depends on C): 6 d**

| # | item | size |
|---|---|---|
| 15 | `pickTarget` priority + lock + LOCK chip | 1.5 d |
| 16 | world-zone tap-to-move / tap-to-attack via `clickMove.ts` | 1 d |
| 17 | flick-dash + two-finger dash, with the arbitration budget (§2.6) | 1 d |
| 18 | haptics table | 0.5 d |
| 19 | mirrored/left-handed layout + size/opacity/inset sliders | 1.5 d |
| 20 | context chip generalising `#t-stairs` | 0.5 d |

**PHASE E — polish: 3.5 d**

| # | item | size |
|---|---|---|
| 21 | `guessQuality` mobile detection without the debug-renderer extension | 0.5 d |
| 22 | portrait for the menu, recap, shop and leaderboard (gate gameplay only) | 1 d |
| 23 | touch-layer allocation cleanup (**only if a profile shows it over budget**) | 1 d |
| 24 | draft cards right-aligned + measured capture | 1 d |

**LATER (explicitly not this round)**: free-drag control layout editor; tablet
portrait gameplay layout, then phone portrait; two-finger camera peek / pinch
zoom; opt-in auto-potion threshold. *(The old "controller-style radial for the
constellation" is withdrawn — see §4.5 9.)*

**Total: ~33 engineer-days** (was 30.5; §2.0's six resolutions add 2.5 — 1 d of
millimetre geometry and invariants in Phase A, 1.5 d of FSM and input-authority
work in Phase C. Every one of them is cheaper here than after a feel round).

#### Risk register

| risk | why | mitigation |
|---|---|---|
| **`iso.html` is 229 KB / 3,081 lines and Phase A+B+E touch almost all of it** | safe-area custom properties, new control markup, close controls on eight panels, swipe-down, four device classes and segmented layouts all land in one file that other agents also edit | **Split it first.** Extract the panel CSS into `styles/panels.css` and the control-layer markup into a template partial before Phase B starts; land Phase A's `:root` block on its own so later merges are small. Expect to merge `origin/main` daily |
| **§7.1 is unconfirmed on real Safari** | the whole preset argument rests on a browser we have never run | real-device gate below; ship the fix regardless (it is strictly better), but do not cite the severity until observed |
| **Indicator legibility is a taste call** | headless diffing can prove "no signal above noise", not "a human sees it" | real-device gate; the ≥2× diff floor is a necessary, not sufficient, condition |
| **The draft modal is unmeasured** | the harness cannot bank a level-up cleanly | either add a `__dcc.grantLevel()` test hook, or measure it by hand on device and paste the numbers |
| **Phase C touches `sampleIntent`, the desktop input seam** | rule (2): touch is additive and must not steal desktop input | `test/touchIntent.test.ts` asserts Intent equality with the keyboard; the desktop smoke capture runs every round |
| **`MM_PER_PX` is a lookup table pretending to be a measurement** | it is derived from published panel dimensions for five devices. A phone with an unusual point density lands in the wrong class and every hand-scale number is off by that ratio | the spread inside a class is ≤ 2% across the matrix and the two clusters (≈153 pt/in phones, ≈132 pt/in tablets) are platform conventions, not accidents. `thumbReachMm`, `stickScale`, `buttonScale` and `?mmpx=` all absorb the residual. The device gate measures it with a ruler; > 6% error means a fifth class or a runtime probe |
| **`ORIGIN_LEAK = 40 px/s` is the one §2.0 number with no citation** | the drift regime it separates from the aim regime is a claim about skin, and no capture in this repo contains skin | it is bracketed, not guessed: every deliberate aim measured in the literature and in play is ≥ 100 px/s and every hold-drift report is ≤ 30 px/s, so 40 sits in a ~3× empty band. The device gate closes both ends (§8.3 (5)) and the constant moves as a pair with nothing else — it is one line |

#### Exit gate for the round

1. `npx tsc --noEmit` clean; `npx vitest run` green, including every row of the
   §8.2 gesture table.
2. `node tools/mobileshot.mjs --drive` on iPhone 13 / Pro Max / iPad Pro 11 /
   iPad 7 / Pixel 5 landscape with **no FAIL rows** — specifically including the
   `move: thumb lands on minimap`, `safe areas` and `modal: opens mid-aim` rows
   that fail today.
3. `--measure` shows **zero** interactive controls under 44×44 on any panel, no
   panel overhanging the viewport, and a close control on all eight.
4. Aim captures re-shot at all four shapes on `iphone13-land`, pasted into §3.1,
   with the legibility diff clearing the scene-churn floor by ≥ 2×.
5. **Real hardware, and it is not optional**: one iOS Safari device and one
   Android Chrome device, each confirming (a) the quality preset the branch
   actually picks, (b) that the aim indicator is visible mid-fight, (c) that the
   gesture thresholds in §2.4a/§2.4b/§2.5a/§2.6 feel right to a human thumb, and
   (d) no double-tap zoom / pull-to-refresh / text selection. Nothing in this
   document has ever been touched by a finger; until (5) runs, every feel claim
   is a hypothesis.

   §2.0's numbers make (c) falsifiable rather than a vibe check. The four
   measurements the device pass must return, because they are the ones a
   headless harness structurally cannot:

   | measurement | how | what would refute the spec |
   |---|---|---|
   | contact-centroid creep over a 1 s deliberate hold | log `pointermove` from a stationary thumb, 20 trials, both devices | sustained drift **above 40 px/s** — `ORIGIN_LEAK` is then too low and taps promote |
   | deliberate tap duration under combat load | log press→release on ability chips through a real floor-9 run | nothing: the spec has no time term. This is recorded to *retire* the question, and to size the ping threshold |
   | slowest deliberate aim drag | 20 trials, both hands | sustained **below 60 px/s** — the 40 px/s leak then eats real aims and both numbers move together |
   | `MM_PER_PX` | measure a known on-screen length with a ruler on each device | more than **6% off** the class constant — the table needs a fifth class or a runtime probe |
6. **The §2.9a reason set is exercised on device**, not just in tests: put a
   finger mid-aim, then background the app, take a call, pull the notification
   shade, rotate, and open each of the six overlays the old ID list missed.
   Nothing may fire on return, and the stick may not be stuck. This is the one
   §1.7 fix whose failure mode is invisible in a screenshot.
7. Desktop keyboard/mouse untouched — existing suite plus a desktop smoke
   capture.

---

## Appendix — capture index

Ordered by round. **Rounds 1–4 predate the scene-driver fix (§0 lesson 3);
where they claim a panel, check the `scene` column against `panelsOpen` in the
matching `report.json` before citing them.**

| file | what it shows |
|---|---|
| `r1/iphone13-land-combat.png` | phone combat, safe-area + reach overlays; minimap inside the left thumb arc; HP bar and ultimate under the notch band |
| `r1/pixel5-land-combat.png` | 802×293: cluster is 64% of screen height |
| `r1/ipadpro11-land-combat.png` | tablet combat; courtesy card in the movement zone |
| `r1/iphone13-land-constellation.png` | **combat, not the constellation** — the transient card covering x 12–234, y 96–266. Cite it for the card, never for the panel |
| `r1/iphone13-land-inventory.png` | inventory with no close control, content clipped |
| `r1/report.json` | the round that recorded `panelsOpen: []` for every shop/sheet/constellation scene — the evidence that rounds 1–4's panel captures are not panels |
| `r2/iphone13-land-menu.png` | menu: every mode button below the fold |
| `r2/iphone13-menu.png` | portrait: the rotate gate walls off the campfire menu itself |
| `r3/iphone13-land-sheet.png` | character sheet horizontally clipped — CD and DPS columns severed |
| `r3/ipadpro11-land-sheet.png` | the same sheet on a tablet: readable |
| `r3/iphone13-land-shop.png` | **the death recap**, not the shop (staged death; buttons below the fold) |
| `r4/ipadpro11-land-shop.png` | **the level-up draft**, not the shop — the only draft capture that exists, and the source for §4.5 10 |
| `r5/iphone13-land-aim-line.png` · `-ring` · `-arrow` · `-ult` | **the aim indicator, mid-drag, finger down** — the first captures of it |
| `r5/crop-aim-line.png` · `-ring` · `-arrow` | zoomed crops centred on the indicator's projected box; the line crop is the one where nothing is visible |
| `r5/report.json` | projected indicator sizes, material, and the legibility diff against the scene-churn floor (§1.6) |
| `r6/iphone13-land-shop.png` · `ipadpro11-land-shop.png` | **the real shop**, verified `panelsOpen: ["saferoom"]`, with `--measure` geometry (§1.3) |
| `r7/iphone13-land-constellation.png` · `ipadpro11-land-constellation.png` | **the real constellation**, verified `panelsOpen: ["abil"]` — legible, 1847px of scroll, no close control (§4.5 9) |
| `r7/iphone13-land-sheet.png` · `ipadpro11-land-sheet.png` | the sheet with measured grid tracks: 799px in 708 on the phone, no overflow on the tablet |
| `r8/ipad7-land-combat.png` · `ipadpro11-land-combat.png` · `iphone13-land-combat.png` | reach overlays with **short-edge-scaled arcs** and the proposed side pivot (§3.2) |
| `r8b/iphone13promax-land-combat.png` · `pixel5-land-combat.png` | the same, plus the probe data showing the cluster arc is identical on both (§1.5) |
| `r9/iphone13-land-inventory.png` · `ipadpro11-land-inventory.png` | inventory with measured columns and 32px rows |
| `r9/report.json` | also records the two `draft` scenes that **failed to open** — the unverified item in §4.5 10 |
| `drive5/report.json` | the older interaction battery, both devices |
| `drive6.log` | the current battery: the modal-mid-aim FAIL (§1.7), the corrected multi-touch check, the heap-delta reading behind §1.9 |
