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

## 0. Integration debt — owed first

**`abilities2.test.ts` §6.4.9(i) fails at floor 12.** A Sponsor Barrage window
costs 300 damage against 52 for playing normally. Neither track had this alone;
it is a real cross-track interaction, not a merge error. Standing still for 3s
at 70% move speed is affordable against V1 trash and unaffordable against a V2
boss with a shield pool the barrage cannot burst. The abilities design
pre-registered a ladder (3s -> 2s -> cut the channel); 2s measures 269 vs 153
and still fails, so **channel length is not the lever** and this wants
diagnosis, not tuning. Decide it as a design question across both docs
(`ITEMIZATION-V2.md` / `BOSSES-V2.md` §2.4 counterplay windows), not by
weakening whichever side is easier to edit.

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

**Still open in this track:**

- **§1.6's legibility DIFF has not been re-shot.** The indicator's palette,
  outline and floors are on the glass and asserted (`test/aimIndicator.test.ts`,
  §5.1), but the "indicator on vs off, inside its own projected box, against
  the scene's churn floor" measurement is round 1's. §5.2 keeps the legibility
  row until that diff clears the floor by 2x.
- **The world zone is two slivers on a phone.** `readability.json` reported 2 of
  4 on-screen monsters under the HUD on an iPhone 13 combat frame and 1 of 4 on
  the boss scene (iPad: 0 of 5). Chips win at `pointerdown` so world taps still
  resolve, and `world: tap to move` / `long press pings` now pass on the phones
  — but the *visual* crowding is untouched, and it wants a HUD-density or camera
  decision, not another zone tweak.
- **The phone shop is still the desktop information architecture, segmented.**
  It buys now, and the price and BUY are on screen; it is not the icon grid with
  a persistent BUY that the iPad gets.
- The §8.3 real-hardware gate still owes: `ORIGIN_LEAK` against a real thumb,
  `MM_PER_PX` against a real panel, and what preset Safari picks.
- `tools/desktopsmoke.mjs`'s cast check asserts `cast || facingChanged` and
  passes on the facing half alone. An OR satisfied by the clause that is not the
  claim is not a check. `tools/_mobile/deskdeep.mjs` drives each desktop verb
  separately; its two ability-key FAILs are a bindings mismatch that predates
  this track (verified by stashing the branch's changes).

## 3. Standing bars

Every round ends at a harsh critic doing a BLIND A/B against the reference
(Diablo II: Resurrected and Hades for bosses, League of Legends for the
competitive and shop surfaces, Wild Rift for touch). The bar is 8.5, and a
critic that has not seen a capture containing the claimed beat has not scored
the beat.

Before any PR: `npx tsc --noEmit`, `npx vitest run`, and
`npx tsx scripts/balance-sweep.ts` when sim rules moved.
