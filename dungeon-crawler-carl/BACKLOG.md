# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

1. **Finale borrows band escalations.** The floor-18 boss kept only its tier-3
   kit when the band signatures landed (DESIGN 5.11). Let its phase 1/2 breaks
   additionally borrow one earlier signature each (debris rain, then flame
   sweep) so the finale feels like a greatest-hits reel. Code: the signature
   dispatch in the boss branch of `src/sim/ai.ts` + `boss*` helpers in
   `src/sim/game.ts` (all floor-agnostic already).
2. **More shrine bargains.** The System Shrine ships with two deals + walk-away
   (`shrineChoices` in `src/sim/game.ts`). The plumbing takes any Reward — add
   a couple more floor-scoped trades (e.g. "collapse timer −20s for a free
   upgrade draft") and roll a seeded pair per shrine so repeat visits differ.
