# Open work on `aaa-perfection`

This branch is the INTEGRATION branch: `main@334cc32` plus all four V2 tracks
merged in one place, so critic rounds judge the game a player would actually
load rather than four divergent copies of it.

    social-v2     PR #166, complete    (replay-verified runs, ladders, ghosts, career)
    abilities-v2  PR #167, complete    (kit rework, 3 new abilities, star chart, glyphs)
    bosses-v2     checkpoint, MID-ROUND (18-boss roster + grammar; presentation failing)
    mobile-v2     checkpoint, MID-ROUND (touch core + HUD; spec contradictions open)

Merge decisions worth knowing are in the merge commit messages. The one that
bites: social-v2 introduced `src/sim/dmath.ts`, a deterministic transcendental
layer that the whole replay-verification spine stands on, and a guard in
`test/balance.test.ts` bans `Math.sin/cos/atan2/hypot/pow` anywhere in
`src/sim/`. Both other tracks forked before it existed. **Any sim code written
against `main` needs its transcendentals converted before it merges here**, and
`npx tsx scripts/simhash.ts --write` must be re-run whenever sim rules move
(it retires recorded run proofs by design — that is the system working).

---

## 0. Integration debt — PAID

**`abilities2.test.ts` §6.4.9(i) is green.** The suite is clean.

The red was not the cross-track interaction the merge commit guessed at. It was
never the boss: across the 13 floor-12 windows a boss *was* present in all of
them, and dealt 22 of the 352 damage — all 22 on the arm that was **not**
channelling. `shieldHp` was 0 in 12 of the 13, the one plated boss took nothing
in its window, and `ap.track`/`ap.band` were 0 in every fixture, so Precision
Strike never snapped a shell anywhere. The 300 was trash: `shot` 200,
`swarmer` 70, one blast for 30 that both arms ate identically.

What was broken was the RULER, in two measurable ways: 13 windows could not
resolve the claim (the same fixture on neighbouring seed bases read 101v104,
119v240, 179v418 — the shipped base was the outlier of four), and the "playing
normally" arm was itself pressing the ultimate in 21 of 81 windows, which makes
it a barrage-vs-barrage comparison. No sim rule moved; the fixture was rebuilt.
Details and the falsification check are in the §6.4.9 comment and
ABILITIES-V2 §6.9.

**Carried forward as a watch item:** the barrage's affordability is bought by
its lethality, and shells stop one-shotting the median mob around floor 12
(0.56 shells-to-kill at floor 8, 1.34 at floor 12). Floors 14–16 sit near
parity. If a later band pushes clause (i) past 1.0, the lever is shell damage
at depth, not channel length — the pre-registered 3s -> 2s ladder is aimed at
the wrong axis and measuring it (269 vs 153 at 2s) confirmed that.

---

## 1. Bosses — presentation, not design

Design doc `BOSSES-V2.md` (991 lines) passed a harsh encounter-design critic at
**8.0/10**. The full sim scope shipped: an 18-boss named roster across the six
bands, seeded selection, 8 encounter mutators, phases, plates, shield pools,
tethers, enrage and the punish window, all on the shared `stepBoss` chassis.

Two acceptance rounds on captured frames scored **5.8** then **5.5** against an
8.5 bar. Open blockers, verbatim from the critics:

- **The name card is absent from 8 of 18 intro captures** and unreadable in a
  9th — the marquee beat does not reliably fire.
- **The punish window has no in-world read.** The doc calls it "the one beat
  that most needs to read"; nothing on screen communicates it.
- **Exposure destroys the read on several bosses** despite the claimed shared
  brightness governor (topiary especially).
- **The payoff chain does not land** across rentcollector / permitoffice /
  sumpking — the beat a short-session game lives on.
- **Fights differ by hue, not shape.** PARTIALLY ANSWERED after the last
  checkpoint: `src/render3d/bossSignatures.ts` now assigns each ask its own
  silhouette (lanes / cords / shell / props / cells / column, with the spoked
  ring reserved to one arena signature). Unverified by a critic — the claim
  needs fresh captures, not a re-read of the table.
- **The boss is occluded by its own health plate** in the `-3fight` captures.

Harness: `tools/bossshot.mjs`. Do not trust a capture that does not visibly
contain the beat it claims — several earlier ones did not, which is how a
5.5 round got mistaken for a 7.

## 2. Mobile — precision problems in the spec

Design doc `MOBILE.md` (~1,301 lines), audit-first: `tools/mobileshot.mjs`
drove iPhone 13, iPhone 13 Pro Max, iPad Pro 11 landscape and Pixel 5 with REAL
touch events before a line of design was written. Shipped: the touch state
machine (floating-origin stick, tap-vs-drag activation with aim indicators and
a cancel zone, target selection, dodge, potion, loot, interact, multi-touch),
and responsive HUD/layout with `env(safe-area-inset-*)` handling plus
touch-first passes on the close controls, shop, sheet, inventory, constellation
and glyph socketing. Everything maps onto the SAME `Intent` the keyboard
produces — no host-side rules.

Design critiques scored **6.5** then **7.0** against an 8.0 bar on six spec
contradictions. **All six are DECIDED in `MOBILE.md` §2.0 (the decision
register, which outranks every other section of that doc) and all six are now
IMPLEMENTED on `trk-mobile`**, each with the test that holds it. Summary:

| # | was | now |
|---|---|---|
| 1 | AIMING promoted on `travel > 18px` OR `dwell > 90ms`; a deliberate tap runs 100–300ms | travel only, from a **leaky origin** (`ORIGIN_LEAK = 40 px/s`, frozen on promotion). No time term exists in the ability FSM. §2.4a — **SHIPPED**: `AbilityButton.move()`; the five speed rows + byte-identical Intent in `test/touchIntent.test.ts` |
| 2 | max range = "1.0 stick-radius from the chip"; R was a clamped viewport function spanning 36–123px | `aimThrow = 18mm` (94–110px), its own hand-scale quantity, `buttonScale` not `stickScale`; `cancelRadius = 0.34 × aimThrow`; ordering asserted. §2.4b — **SHIPPED**, plus `aimPlacement()` for the placed-shape half |
| 3 | tap ≤ 200ms, long-press 450ms — the 200–450ms band resolved to **nothing** | tap ceiling deleted (`TAP_MS` gone). Release before the 450ms arm = move, after = ping. §2.5a — **SHIPPED**; 11 durations asserted to produce exactly one Intent each |
| 4 | `comfortable = clamp(0.55 × shortEdge, 150, 300)` — one formula, and its clamp gave every tablet the same number anyway | reach is anthropometry: `48mm` / `66mm` through a per-class `MM_PER_PX` table. Phones gain 31% of arc, tablets lose 17%. §3.2 — **SHIPPED**, with a 38–62mm player slider |
| 5 | tablet side pivot at `0.62 H` reproduced the phone layout §1.5 condemns | pivot kept, **fan** fixed: corner grip +6°…+96°, side grip −46°…+46° at `0.58 H`, with four asserted invariants incl. "no combat chip in the top 32% of the safe box". §4.2a — **SHIPPED**; three of four invariants are structural (a cluster box the relaxation pass cannot escape), all four asserted over 6 viewports × 2 hands × 8 slider positions |
| 6 | `setModalOpen(boolean)` over a hand-maintained list of 9 element IDs, missing `#ladder`/`#career`/`#consent`/`#loading`/`#recap-tab`/`#rotate` and every no-event path | refcounted input authority, 8 enumerated suspend reasons driven by `body.modal` + a `test/panels.test.ts` that catches new overlays, + an 8s stuck-pointer reaper. §2.9a — **SHIPPED**; overlays declare `data-overlay` in the markup and the test parses the screen-zone map |

Four of the six were one mistake: *a quantity set by the hand written as a
function of the screen.* §2.0 splits hand-scale (mm) from screen-scale
(viewport fractions) and that split is now load-bearing, and it is what
`computeZones()` is organised around.

**Implementation round 1 landed** — see the commit on `trk-mobile` and the
"IMPLEMENTED" table at the top of `MOBILE.md`, which also records the three
places the implementation had to contradict the prose (the corner CANCEL band
cannot sit above the cluster; `rf` runs past 1.0 on a corner fan; the size
slider is a request the packer may refuse). Evidence lives in
`tools/_mobile/i2.log` and `tools/_mobile/i3.log`.

**Implementation round 2 landed** — a device-driven acceptance round found the
touch LAYER was sound and the SURFACES were not. `MOBILE.md`'s new "ROUND 2"
section carries the five findings that mattered and what each actually turned
out to be. The headline: *a phone player could not buy anything*, and the cause
was `srPageShop.style.display = "grid"` — one inline style, which beats every
stylesheet rule and silently defeated the whole one-pane shop treatment, leaving
the shelf in 40% of the panel with **not one hit-testable tile**. The
select→detail→BUY chain was never broken; there was nothing a finger could press
to start it.

Also landed: §3.1's indicator (`src/render3d/aimIndicator.ts`, six shapes,
cyan/white/outline, stroke and footprint floors, fed the live `AimSpec`); loot
feedback (ground ring + `#pickstrip`); the low-HP flask pulse and refill haptic;
swipe-to-close (moved onto the TOUCH stream — Chrome cancels the POINTER stream
after one move when a scroller claims the pan, which is why round 1's swipe
closed nothing anywhere); the phone recap; the toast rail's width; the boss
plate off the crawler's own vitals; and the desktop regression where touch
chrome was injected into every fine-pointer panel.

**Implementation round 3 landed** — and its headline is that the round-2
telegraph work was correct and **invisible**. `src/main3d.ts` placed every
telegraph at `p.pos + isoRotate(aimDir) * tiles`, and `aimDir` is the RAW PIXEL
drag vector, so the anchor was 110-175x too far out for every PLACED shape:
nova 455 world units from the crawler, cataclysm 1050, **0% of the projected
vertices on screen** for six of ten abilities including both ultimates. Line,
cone and chain survived only because `aimPlacement()` returns 0 for them.
Direction and anchor now come from one pure `aimAnchor()`
(`src/input/aimSpec.ts`), and `test/aimTelegraph.test.ts` projects the result
through an iso camera rebuilt from `THEME` onto four real viewports — including
a REGRESSION row that reproduces the shipped arithmetic and asserts it is off
the glass, so the test's own sensitivity is proved rather than assumed. Measured
after, on a 750x342 iPhone 13 with the finger held through the frame: 78-100%
of the telegraph's vertices on screen in all four drag directions, all three
shapes (`tools/_mobile/r3.mjs`).

Also landed: the camera now LEADS a live aim (up to 4.2 tiles of slide and 22%
of frame widening, easing back the instant the finger lifts) because bolt
reaches 14.4 tiles and the frame shows 8.5; two drawn target markers (a
persistent bracket on the locked target, a 420 ms cyan reticle on whatever the
smart cast just chose — `lockedTargetId` had steered `pickTarget` for four
rounds with nothing on the glass); a **crawler keepout** in `computeZones()`,
because `#t-map` measured 51x51 at (370,152) on a phone whose crawler projects
to (375,150) — the least-used control had the most valuable pixels; a
`CastVerdict` log on every chip press, so a refusal, a queue expiry, a deaf
modal gate, a re-entrant pointerId and a cancel stop being the same silence;
panel stacking that raises an overlay above whatever is already open (`#sheet`
is z 20 and `#saferoom` z 24, so a sheet opened over the shop opened
UNDERNEATH it and its own ✕ could not be tapped); a sticky `.tp-done` (it was
`position: absolute` inside a scroller, i.e. not pinned at all — measured at
y = -105 after 361 px of scroll); a pinned recap fork; the shop's own 40 px tab
rules raised to the 44 px gate they were undercutting; an 11.5 px floor inside
panels; and the transient System card clamped out of the sight line.

**Three round-2 findings turned out to be the HARNESS, and they are worth more
than the fixes.**

- *Flick-to-dash fires on 1 of 4 profiles.* Instrumented, the page received
  every dispatched `pointermove` — no coalescing, no lost samples.
  `FLICK_DEBOUNCE_MS` is judged on EVENT time and the driver's virtual clock
  only advances when the script calls `tick()`, so five profiles driven back to
  back all landed inside 350 ms of each other and every one after the first was
  correctly debounced. **5 of 5 fire on both devices** once the clock advances.
  The recogniser did have a real and different defect: a 900 px/s thumb stir
  cleared the iPad's per-sample floor by a tenth of a pixel and dashed, so the
  latch now also requires net travel and straightness.
- *Move while aiming fails on iPad in 2 of 2 runs.* Unreproduced: 4.25-9.56
  tiles kept in every direction of two independent runs.
- *One aimed cast in four produces no cast.* Unreproduced: 80 of 80 identical
  aimed casts fired, and all 80 of the layer's own verdicts read `aimed`.
- *The desktop gate's two ability-key FAILs are "a bindings mismatch that
  predates this track".* **That diagnosis was wrong** and is corrected below.

**Still open in this track:**

- **The legibility diff still has no honest number, and now for a new reason.**
  Every diff taken before round 3 was measured inside the indicator's own
  projected box, which for six of ten abilities was a degenerate rectangle
  hundreds of tiles off-screen — so the "at or below the scene churn" result
  reproduced no matter what the palette did. The shapes are in frame now, so
  the measurement can finally mean something, and it has not been taken. §5.2
  keeps the row.
- **The world zone is two slivers on a phone.** `readability.json` reported 2 of
  4 on-screen monsters under the HUD on an iPhone 13 combat frame and 1 of 4 on
  the boss scene (iPad: 0 of 5). Chips win at `pointerdown` so world taps still
  resolve, and `world: tap to move` / `long press pings` now pass on the phones
  — but the *visual* crowding is untouched, and it wants a HUD-density or camera
  decision, not another zone tweak.
- **The phone shop is still the desktop information architecture, segmented.**
  It buys now, the tabs finally clear 44 px and the prices clear 11.5 px, but a
  phone still gets 11 of 55 shelf tiles behind four stacked rows of navigation
  that eat 59% of the panel, in a fixed 11-column desktop grid that does not
  reflow. The iPad shop in the same build is excellent, which is the proof that
  the phone was segmented rather than redesigned. `#sr-detail` (610x155 with
  185 px of hidden scroll) and the 1149 px unnavigated character sheet are the
  same debt.
- **Haptics are a no-op on iOS**, which is the larger half of the target
  platform: `navigator.vibrate` does not exist in Safari, so every press / cast
  / cancel / refuse cue is silent on iPhone and iPad. §5.2 now says "behind on
  iOS" instead of "degrading cleanly", and the compensation — a louder visual
  press state where `vibrate` is missing — is owed.
- The §8.3 real-hardware gate still owes: `ORIGIN_LEAK` against a real thumb,
  `MM_PER_PX` against a real panel, and what preset Safari picks.
- `tools/desktopsmoke.mjs`'s cast check asserts `cast || facingChanged` and
  passes on the facing half alone. An OR satisfied by the clause that is not the
  claim is not a check.
- **CORRECTION.** `tools/_mobile/deskdeep.mjs`'s two ability-key FAILs were NOT
  a bindings mismatch. The probe used `page.keyboard.press(k)` — a ~10 ms key
  edge — against a host that samples the keyboard once per sim step on a page
  running at ~3 fps under SwiftShader, which is the gotcha CLAUDE.md documents
  ("hold keys >= 450 ms"). Stashing could not have shown a bindings mismatch,
  because the branch was never the variable. The probe now holds for 520 ms and
  all five ability keys fire (Space/melee 2239->2210 mob hp, Shift/dash charges
  2->1, q/bolt 2210->2051, c and f cooldowns started). Desktop is fine; the
  gate was producing phantom FAILs and a wrong root cause, which is how a real
  regression eventually gets waved through.

## 3. Standing bars

Every round ends at a harsh critic doing a BLIND A/B against the reference
(Diablo II: Resurrected and Hades for bosses, League of Legends for the
competitive and shop surfaces, Wild Rift for touch). The bar is 8.5, and a
critic that has not seen a capture containing the claimed beat has not scored
the beat.

Before any PR: `npx tsc --noEmit`, `npx vitest run`, and
`npx tsx scripts/balance-sweep.ts` when sim rules moved.
