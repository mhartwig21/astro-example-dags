# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

1. **Finale borrows band escalations.** The floor-18 boss kept only its tier-3
   kit when the band signatures landed (DESIGN 5.14). Let its phase 1/2 breaks
   additionally borrow one earlier signature each (debris rain, then flame
   sweep) so the finale feels like a greatest-hits reel. Code: the signature
   dispatch in the boss branch of `src/sim/ai.ts` + `boss*` helpers in
   `src/sim/game.ts` (all floor-agnostic already).
2. **More shrine bargains.** The System Shrine ships with two deals + walk-away
   (`shrineChoices` in `src/sim/game.ts`). The plumbing takes any Reward — add
   a couple more floor-scoped trades (e.g. "collapse timer −20s for a free
   upgrade draft") and roll a seeded pair per shrine so repeat visits differ.
3. **Status effects in the 2D host + character sheet.** The 5.13 status layer
   ships with 3D-host presentation only (tinted numbers, HUD/boss-bar pips,
   monster ring). The 2D canvas host (`src/render/`, `src/main.ts`) renders
   DoT numbers untinted and shows no pips; the Crawler Profile (`sheet.ts`)
   doesn't yet print burn/poison DPS rows for Afterburn/Frost/Venom builds.
   Sim data is all there (`statuses`, `HitEvent.effect`).
4. **Status audio cues.** No sounds for ignite/poison/chill apply or DoT
   ticks — deliberately skipped rather than adding asset files. Seam:
   `src/audio/director.ts` maps sim events to clip ids; would key off
   `HitEvent.effect`.
5. **Clown bombs on boss blast telegraphs.** The clown-ordnance prop renders on
   EVERY blast-kind hazard, including the Architect's masonry and the Furnace
   Marshal's flame rows (Hazard carries no source tag). Reads as System
   shelling, but if it grates, add a `src` tag to `Hazard` and gate the bomb
   mesh in `renderer3d.ts`.
