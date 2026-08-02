# MOBILE.md — beating Wild Rift on glass

Scope: the 3D host (`iso.html` + `src/main3d.ts` + `src/input/`) on phones and
tablets. The sim is not touched. Everything below maps a finger to the **same
`Intent` the keyboard produces** — no new game rules in the host.

Status: **plan, not shipped.** Nothing in §2–§7 exists yet unless §1 says it
does. §5's comparison table is a table of *targets*, not results.

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
* `--guides` paints the **hardware safe-area insets** over the frame (Chromium
  reports `env(safe-area-inset-*)` as 0, so the harness supplies the real
  numbers per device); `--reach` paints thumb-reach arcs, now **scaled to the
  device's short edge** and drawn from two pivots (today's bottom corner, and
  the proposed side-grip pivot — §4.2);
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
* **Radius** `R = clamp(0.16 * min(vw, vh), 52, 88)` CSS px. Phone ≈ 55,
  iPad ≈ 88. Player-adjustable 0.7×–1.4×.
* **Dead zone** 0.14 R (current code: 0.15 — keep, it tested clean at 5px of
  thumb jitter).
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
PRESSED ---------------(travel > 18 px)-----------------------> AIMING
 |  up (any duration)                                            |
 v                                                               |
SMART CAST                                                       |
                                       finger in CANCEL BAND     |
                                       or within 34 px of origin |
                                                 v               |
                                              CANCEL <-----------+
                                                 |               | leave
                                                 +---------------+
                                                                 |
                                                            up   v
                                                          AIMED CAST
```

**The transition to AIMING is on travel alone.** There is no dwell term. A
deliberate human tap is routinely 100–150 ms of contact; a dwell threshold puts
every unhurried tap into AIMING with a ~0 px drag vector, which is the game's
most-used verb landing in an undefined state. Wild Rift gates on travel for
exactly this reason. **Dwell may only reveal the indicator** (it already appears
on `pointerdown` — see below), never change the state.

Details that matter:

* **The indicator appears on `pointerdown`, in the same frame**, not after the
  slop threshold. On press you immediately see the ability's real reach; the
  drag only *changes* it. This is the single biggest feel gap versus Wild Rift.
* **`PRESSED` release = smart cast** at the prioritised target (§2.5). If no
  target is in range, cast along facing (current behaviour — keep).
* **`AIMING` release = aimed cast** along the drag vector, scaled: the drag is a
  *direction plus a fraction of range*, not a raw pixel vector. Finger at 1.0
  stick-radius from the chip = maximum range; closer = proportionally shorter,
  clamped to the ability's real range. The screen vector is rotated through
  `isoRotate` **before** the magnitude is scaled to world range (§3), so
  up-screen and sideways drags of equal pixel length mean equal world distance.
* **A null aim resolves as a smart cast, never as a zero-vector aimed cast.**
  Releasing in AIMING with a drag magnitude below the stick dead zone resolves at
  the §2.5 prioritised target. With the default numbers (cancel radius 34 px,
  slop 18 px) the cancel band absorbs most of this case — but the cancel radius
  scales with `buttonScale` and the slop does not, so the two can cross, and a
  state machine that only works at default settings is not a state machine.
  The invariant: **no path through this machine produces a cast with an
  undefined direction.** `test/touchIntent.test.ts` asserts it directly.
* **Cancel is two affordances, both live**: (a) a labelled CANCEL band that
  appears above the cluster the moment `AIMING` starts (Wild Rift's answer, and
  the one people transfer in), and (b) returning within 34 px of the press
  origin (what we have). Entering either turns the indicator to its cancel state
  (§3) and kills the haptic; releasing there costs nothing — no cooldown, no
  charge.
* **Interruption-cancel is refund-identical to a cancel-band exit.** A pointer
  killed by a modal opening (§2.9), an orientation change (§4.4), or a browser
  `pointercancel` resolves as `{kind:"cancel"}`: no cooldown, no charge, no
  queued cast. This is already true of `pointercancel` in `SlotButton.up()`; the
  other two paths must route to the same place.
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

**World-zone taps** otherwise, with the thresholds written down:

| gesture | threshold | result |
|---|---|---|
| tap empty ground | up within **200 ms**, travel < **16 px** | move there via `stepClickMove` |
| tap a monster | same | lock **and** auto-attack toward it |
| long-press empty ground | **450 ms** held, travel < 16 px | party ping (replacing the minimap-tap ping) |

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

**The modal gate** (the fix for §1.7). On any modal opening:

1. every live gameplay pointer resolves as **cancel** — refund-identical to a
   cancel-band exit, no cooldown, no charge, no queued cast;
2. those `pointerId`s are marked **dead**: the trailing `pointerup` /
   `pointercancel` is consumed and routed to nothing. `releasePointerCapture` is
   called so the browser stops delivering them to `#skills`;
3. the modal accepts input only from a `pointerdown` that **began after it
   opened**, with a ~120 ms input-gate frame as belt-and-braces against a
   pointer that arrives in the same tick;
4. symmetrically, on modal *close*, any pointer still down is dead until it
   lifts — closing a panel with a finger already on the glass must not start a
   cast.

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

1. **modal open** → every gameplay recogniser is off (§2.9)
2. **chip hit rect** → ability pointer (§2.4)
3. **stick zone, no stick live** → stick pointer (§2.3); flick tested from
   velocity *before* recentring (§2.6)
4. **world zone, second pointer within 120 ms** → two-finger candidate; resolves
   to dash-tap inside the §2.6 budget, otherwise to camera (§2.8)
5. **world zone, single pointer** → tap / long-press by the §2.5 thresholds
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

### 3.2 Thumb reach

The old flat pair ("comfortable ≈ 190, stretch ≈ 260") was the *phone's* value
of a rule, promoted to a constant. The rule:

```
comfortable = clamp(0.55 * shortEdge, 150, 300)   CSS px
stretch     = 1.37 * comfortable
```

Measured instances (`--reach` draws these; `r8/`, `r8b/`):

| device | viewport | short edge | comfortable | stretch |
|---|---|---|---|---|
| Pixel 5 landscape | 802×293 | 293 | 161 | 221 |
| iPhone 13 landscape | 750×342 | 342 | 188 | 258 |
| iPhone 13 Pro Max landscape | 832×380 | 380 | 209 | 286 |
| iPad 7 landscape | 1080×810 | 810 | 300 | 411 |
| iPad Pro 11 landscape | 1194×834 | 834 | 300 | 411 |

**Two pivots, not one.** A phone in landscape is held at the bottom corners; an
11-inch tablet in landscape is gripped at the *sides*, with the thumb rooted
well above the bottom corner. `--reach` now draws both — the corner pivot the
current layout assumes, and a proposed side pivot at `(safeEdge + 26, 0.62 H)`.
`r8/ipadpro11-land-combat.png` and `r8/ipad7-land-combat.png` are the first
captures showing the difference.

And the difference is not a simple win. Measured on iPad Pro 11 (chip centres
from `r8/report.json`):

| control | distance from corner pivot (1160, 804) | from side pivot (1168, 517) |
|---|---|---|
| ultimate (slot 4) | 194 | **95** |
| slot 1 | 165 | **318** |
| flask | 253 | **379** |

Re-pivoting alone moves the problem from the ultimate to the flask. The tablet
fix is therefore **pivot *and* radius**: pivot at the side grip, and compress the
arc radius so the whole cluster fits inside `comfortable` from *that* point —
roughly 150–200 px on an 11-inch tablet, not the 175 a three-bucket lookup would
have given. `computeZones` takes the pivot and the radius as functions of the
short edge and the class, and `test/touchLayout.test.ts` asserts **no control
that must be pressed during combat lies outside `comfortable` from its class's
pivot** on all five measured viewports.

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

Classes pick the *posture*. Inside a class, the arc radius, cluster pivot, stick
radius and HUD scale are **continuous functions of the short edge** (§3.2), not
per-class constants — that is what stops an 11-inch and a 13-inch tablet sharing
one geometry.

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
* **Cluster geometry** is arc-based per class, with the pivot and radius from
  §3.2: corner pivot on `compact`/`phone`, side pivot at `(safeEdge + 26, 0.62 H)`
  on `tablet-*`, radius chosen so the outermost chip lands inside `comfortable`.

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
  that follows it (iOS fires them apart), and **cancel every live gameplay
  pointer at the boundary through the §2.9 modal-gate path** — same refund, same
  dead-pointer marking — so a rotation mid-drag cannot leave a stuck or queued
  cast.
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

## 5. BEATING WILD RIFT — TARGET VERDICTS (UNSHIPPED)

Every "us" cell below is a design in this document, not code in the branch. The
verdict column is what we are *aiming at*; nothing here has been played by a
human on a phone.

| interaction | Wild Rift | us (proposed) | target verdict |
|---|---|---|---|
| **Movement** | floating stick, dead zone | floating stick **with origin recentring** past 1.35 R | **better on recentring** — the stick cannot run out under a drifting thumb. The walk/run half of this claim is **withdrawn**: `game.ts` normalizes `Intent.move`, so analogue speed needs a sim change (§2.3). Whether Wild Rift recentres is asserted from play, not from a source we can cite — treat the movement row as "equal, pending a side-by-side" until someone runs both |
| **Resting affordance** | base ring always visible | ghost ring at last lift, whole zone still live | equal |
| **Ability activation** | tap = smart cast, drag = aimed, per-slot toggle | same, **plus** a third per-slot mode (`tap` / `tap-release` / `aim-only`) so ultimates can be forced to require a drag | **better** — fat-fingering an ultimate is our worst-case mis-input and theirs too; they do not let you lock it |
| **Indicator** | exact range/AoE per ability, updates live | exact range/AoE **derived from the player's own `abilities.ts` params**, so glyphs and ranks change the drawn circle | **equal, with a twist they cannot have** — our ranges are build-dependent, so the indicator teaches itemisation |
| **Indicator timing** | appears on touchdown | appears on touchdown | equal (today: only after the drag slop — a fix, not a win) |
| **Indicator legibility** | tuned, high-contrast, reserved palette | §3.1 spec: reserved cyan/white, dark outline, 3px stroke floor, 96px footprint floor | **behind until it ships.** Measured today, our telegraph changes the frame no more than one frame of torchlight does (§1.6) |
| **Cancel** | labelled cancel band above the cluster | labelled band **and** return-to-origin | **better** — two ways to bail, one of them muscle memory from every other MOBA |
| **Target priority** | lowest-HP-in-range with a last-hit bias | locked > last-damaged-3s > lowest HP fraction in range > nearest, with a facing cone weight | equal — theirs is tuned by a decade of telemetry; ours matches the shape and we should expect to iterate |
| **Target lock** | dedicated lock toggle | world tap to lock + sticky-lock toggle | equal |
| **Tap to move + auto-attack** | tap ground to move, tap champion to attack | same, reusing `clickMove.ts` verbatim | equal |
| **Dodge** | flash is an ability button | dash chip **plus** flick-on-stick **plus** two-finger tap | **better** — a dungeon crawler dodges far more often than a MOBA flashes; a gesture removes a thumb trip per second |
| **Potion** | no equivalent | flask chip with charge pips and refill haptic | n/a |
| **Loot** | no equivalent | automatic in the sim; ground ring + non-intrusive pickup strip | n/a |
| **Shop** | full-screen touch shop, recommended-build row | segmented one-pane shop with a real BUY control | **honestly: theirs is better today.** Ours currently renders the bag off-screen and has no buy button at all (§1.3). Parity is the goal |
| **Haptics** | subtle, on cast and hit | mapped table in §3, off-switchable | equal, degrading cleanly on iOS where `vibrate` is a no-op |
| **Notch / reachability** | full safe-area respect | `--sa-*` everywhere + a player HUD-inset slider | **better** — the slider covers thick cases, screen protectors and Android OEM oddities that a fixed inset cannot |
| **Left-handed** | mirrored layout absent; **per-button drag positioning with scale/opacity present** | full mirror (MUST-adjacent, SHOULD #16) + free-drag editor (LATER #20) | **better on mirroring; behind on the editor until #20 ships.** §6 and §8.3 now agree: sliders are SHOULD, the free-drag editor is LATER |
| **Frame budget** | 60 fps target on mid phones | quality ladder with runtime tuner already shipped (`quality.ts`) | **unmeasured on mobile.** §0 rules this harness out for timing and `gpuprobe.mjs` is a desktop D3D11 path. No claim until the real-device gate runs |
| **Panels** | every panel closes by touch | every panel closes three ways | **better than us today**; parity with them |

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
  stickScale: number;                // 0.7 - 1.4
  buttonScale: number;               // 0.7 - 1.4
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
| `src/input/touchLayout.ts` | **new, pure.** `computeZones(viewport, insets, prefs) → ZoneTable`. Handedness, scales, pivots and the cluster arc live here | 1.5 d |
| `src/input/targeting.ts` | **new, pure.** `pickTarget(candidates, opts) → id \| null` replacing `autoAimDir` | 1 d |
| `src/input/clickMove.ts` | unchanged; wired to the world-zone tap path | 0.5 d |
| `src/input/bindings.ts` | add `TouchPrefs` + load/save | 0.5 d |
| `src/input/haptics.ts` | **new.** Event→pattern table, rate limiter, pref gate, feature check | 0.5 d |
| `src/main3d.ts` | `sampleIntent` keeps its exact shape; swap `autoAimDir` for `pickTarget`; add lock state; feed `haptics` from `frameHits`/`frameAnns`; rebuild the touch wiring against the zone table; **cancel gameplay pointers from the existing `body.modal` MutationObserver** | 2 d |
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
* `test/touchLayout.test.ts` — **new**: zone tables for the five measured
  viewports; mirrored layout is a true reflection; nothing lands in a safe-area
  gutter; **no in-combat control outside `comfortable` from its class's pivot**.
* `test/targeting.test.ts` — **new**: the full priority ladder, range respect,
  dormant exclusion, tie-breaks.
* `test/touchIntent.test.ts` — **new, the important one**: a table of gestures
  and the exact `Intent` they must produce, asserted **equal to the `Intent` the
  keyboard produces** for the same action. Required rows:

  | gesture | expected |
  |---|---|
  | press, no travel, release after 40 ms | smart cast at `pickTarget` |
  | press, no travel, release after **300 ms** | smart cast — **identical Intent** to the 40 ms row |
  | press, travel 19 px, release | aimed cast along the drag |
  | press, travel 19 px, return to 3 px, release | cancel — no cast, no cooldown |
  | press, travel 19 px, drag magnitude below dead zone at release | smart cast, never a zero-vector aimed cast |
  | press, travel 19 px, modal opens, release | cancel; **no cast now and none when the modal closes** |
  | press, travel 19 px, orientation change, release | cancel, same refund |
  | press slot A, then press slot B while A resolves | one queued smart cast for B |
  | …and A is cancelled instead | **B's queued cast is dropped** |
  | queued cast, 250 ms elapse | dropped |
  | stick flick at 2.6 R/s | dash cast + movement `Intent` unchanged in shape |
  | two-finger world tap, both up < 200 ms, < 16 px | dash |
  | two-finger world drag, 250 ms / 40 px | camera peek, **no dash** |
  | world tap < 200 ms | click-move target set |
  | world press 450 ms | ping |
  | click-move live, stick pressed | click-move path cleared |
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
| 1 | `touchLayout.ts` + zone table + device classes + continuous geometry (§3.2, §4.1) | 2 d |
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
| 9 | per-slot FSM: travel-only AIMING, cancel band, refused presses, cast modes (§2.4) | 2 d |
| 10 | **modal / orientation pointer gate + bounded cast queue** (§2.9) — fixes §1.7 | 1 d |
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

**Total: ~30.5 engineer-days.**

#### Risk register

| risk | why | mitigation |
|---|---|---|
| **`iso.html` is 229 KB / 3,081 lines and Phase A+B+E touch almost all of it** | safe-area custom properties, new control markup, close controls on eight panels, swipe-down, four device classes and segmented layouts all land in one file that other agents also edit | **Split it first.** Extract the panel CSS into `styles/panels.css` and the control-layer markup into a template partial before Phase B starts; land Phase A's `:root` block on its own so later merges are small. Expect to merge `origin/main` daily |
| **§7.1 is unconfirmed on real Safari** | the whole preset argument rests on a browser we have never run | real-device gate below; ship the fix regardless (it is strictly better), but do not cite the severity until observed |
| **Indicator legibility is a taste call** | headless diffing can prove "no signal above noise", not "a human sees it" | real-device gate; the ≥2× diff floor is a necessary, not sufficient, condition |
| **The draft modal is unmeasured** | the harness cannot bank a level-up cleanly | either add a `__dcc.grantLevel()` test hook, or measure it by hand on device and paste the numbers |
| **Phase C touches `sampleIntent`, the desktop input seam** | rule (2): touch is additive and must not steal desktop input | `test/touchIntent.test.ts` asserts Intent equality with the keyboard; the desktop smoke capture runs every round |

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
   gesture thresholds in §2.4/§2.5/§2.6 feel right to a human thumb, and (d) no
   double-tap zoom / pull-to-refresh / text selection. Nothing in this document
   has ever been touched by a finger; until (5) runs, every feel claim is a
   hypothesis.
6. Desktop keyboard/mouse untouched — existing suite plus a desktop smoke
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
