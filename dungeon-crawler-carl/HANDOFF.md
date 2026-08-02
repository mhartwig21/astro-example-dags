# Mobile controls — checkpoint handoff

**Status: work in progress, checkpointed mid-flight.** Agents were still editing
this worktree when the snapshot was taken. Treat this as a save point, not a
finished round. Run `npx tsc --noEmit` and `npx vitest run` before building on it.

Branch: `mobile-v2`, forked from `main@334cc32`.
Design doc: `MOBILE.md` (~1,301 lines after its rewrite).
Dev server used during the round: `http://localhost:5370`.
Device harness: `tools/mobileshot.mjs` (Playwright device emulation with REAL
touch events — mouse events do not exercise the touch path).

## What landed

1. **Audit** — the harness was built first and four devices were driven with real
   touch (iPhone 13, iPhone 13 Pro Max, iPad Pro 11 landscape, Pixel 5) before a
   line of design was written. `MOBILE.md` records what actually broke per device.
2. **Design** — rewritten against all 9 findings from the first critique.
3. **Control core** — the touch state machine from §2/§3: floating-origin stick,
   tap-vs-drag ability activation with aim indicators and a cancel zone, target
   selection, dodge, potion, loot, interact, and multi-touch (move while aiming).
   Everything maps onto the SAME Intent the keyboard produces — no host-side rules.
4. **HUD/layout** — responsive per device class with `env(safe-area-inset-*)`
   handling, and touch-first passes on the close controls, shop, sheet, inventory,
   constellation and glyph socketing.

## Why it is NOT finished

Design critiques scored **6.5** then **7.0** against an 8.0 bar. Remaining
blockers are precision problems in the spec, which matter because they decide
whether a tap feels like a tap:

- **Tap/aim threshold conflict.** The per-slot FSM promotes PRESSED → AIMING on
  `travel > 18px OR dwell > 90ms`. A deliberate human tap often exceeds 90ms, so
  taps get read as aims.
- **Max-range vs stick-radius contradiction.** §2.4 sets max range at "finger at
  1.0 stick-radius from the chip" while §2.3 defines R as a clamped function of
  viewport — the two do not agree on any device.
- **World-zone tap vs long-press overlap** (tap: up within 200ms, travel < 16px;
  long-press: 450ms held, travel < 16px) leaves the 200–450ms band ambiguous.
- **The reach model is one pair of numbers for every device** — a 6.1" phone and
  an 11" tablet cannot share a comfortable arc.
- **Tablet side pivot** would place the ability cluster exactly where the design
  elsewhere says not to.
- **Modal/pointer-cancel rule covers modals but not all UI states.**

## What to do next — remaining stages

1. **Control skin + customisation surface** — stick/button styling in the house
   language, size/opacity sliders, mirrored (left-handed) layout, and confirming
   the mobile quality preset auto-selects sanely (`src/render3d/quality.ts`).
2. **Full device × scene matrix capture** and iterate on the frames.
3. Resolve the six spec contradictions above BEFORE more implementation — they
   are cheap to fix on paper and expensive to fix in feel.
4. **Desktop must not regress**: drive keyboard+mouse and verify movement,
   casting, aiming, shop and panels still work. Touch is additive.
5. Then `npx tsc --noEmit`, `npx vitest run`, and open a PR against `main`.

## Resuming the workflow

    Workflow({ scriptPath: "C:\Users\hartw\.claude\projects\C--Users-hartw-astro-example-dags--claude-worktrees-aaa-refinement\3a9dd2e4-b17a-4269-ba2d-1295fe0446c5\workflows\scripts\mobile-controls-wf_7015e6b6-0e9.js",
               resumeFromRunId: "wf_7015e6b6-0e9" })

Completed agents replay from cache; edited or new stages run live.
