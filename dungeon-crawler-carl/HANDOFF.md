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
contradictions. **All six are now DECIDED on paper — `MOBILE.md` §2.0 is the
decision register and it outranks every other section of that doc.** Nothing is
implemented against them yet. Summary:

| # | was | now |
|---|---|---|
| 1 | AIMING promoted on `travel > 18px` OR `dwell > 90ms`; a deliberate tap runs 100–300ms | travel only, from a **leaky origin** (`ORIGIN_LEAK = 40 px/s`, frozen on promotion). No time term exists in the ability FSM. §2.4a |
| 2 | max range = "1.0 stick-radius from the chip"; R was a clamped viewport function spanning 36–123px | `aimThrow = 18mm` (94–110px), its own hand-scale quantity, `buttonScale` not `stickScale`; `cancelRadius = 0.34 × aimThrow`; ordering asserted. §2.4b |
| 3 | tap ≤ 200ms, long-press 450ms — the 200–450ms band resolved to **nothing** | tap ceiling deleted (`TAP_MS` gone). Release before the 450ms arm = move, after = ping. §2.5a |
| 4 | `comfortable = clamp(0.55 × shortEdge, 150, 300)` — one formula, and its clamp gave every tablet the same number anyway | reach is anthropometry: `48mm` / `66mm` through a per-class `MM_PER_PX` table. Phones gain 31% of arc, tablets lose 17%. §3.2 |
| 5 | tablet side pivot at `0.62 H` reproduced the phone layout §1.5 condemns | pivot kept, **fan** fixed: corner grip +6°…+96°, side grip −46°…+46° at `0.58 H`, with four asserted invariants incl. "no combat chip in the top 32% of the safe box". §4.2a |
| 6 | `setModalOpen(boolean)` over a hand-maintained list of 9 element IDs, missing `#ladder`/`#career`/`#consent`/`#loading`/`#recap-tab`/`#rotate` and every no-event path | refcounted input authority, 8 enumerated suspend reasons driven by `body.modal` + a `test/panels.test.ts` that catches new overlays, + an 8s stuck-pointer reaper. §2.9a |

Four of the six were one mistake: *a quantity set by the hand written as a
function of the screen.* §2.0 splits hand-scale (mm) from screen-scale
(viewport fractions) and that split is now load-bearing.

Implementation cost of the resolutions: +2.5 engineer-days (1d in Phase A's
`touchLayout.ts`, 1.5d in Phase C's FSM + input authority). Total round ~33d.

Then: control skin + customisation surface (size/opacity, mirrored left-handed
layout, and confirm the mobile quality preset auto-selects sanely in
`src/render3d/quality.ts`), the full device x scene capture matrix, and a
desktop regression pass — keyboard+mouse movement, casting, aiming, shop and
panels. Touch is additive; it may not cost the desktop game anything.

## 3. Standing bars

Every round ends at a harsh critic doing a BLIND A/B against the reference
(Diablo II: Resurrected and Hades for bosses, League of Legends for the
competitive and shop surfaces, Wild Rift for touch). The bar is 8.5, and a
critic that has not seen a capture containing the claimed beat has not scored
the beat.

Before any PR: `npx tsc --noEmit`, `npx vitest run`, and
`npx tsx scripts/balance-sweep.ts` when sim rules moved.
