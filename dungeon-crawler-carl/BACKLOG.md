# Backlog

Play-driven backlog from live runs. Items are roughly in the order reported,
not priority order. Each entry notes the likely code home so any session can
pick one up cold. Delete items when they ship (git history remembers).

1. **More shrine bargains.** The System Shrine ships with two deals + walk-away
   (`shrineChoices` in `src/sim/game.ts`). The plumbing takes any Reward — add
   a couple more floor-scoped trades (e.g. "collapse timer −20s for a free
   upgrade draft") and roll a seeded pair per shrine so repeat visits differ.
2. **Status effects in the 2D host + character sheet.** The 5.13 status layer
   ships with 3D-host presentation only (tinted numbers, HUD/boss-bar pips,
   monster ring). The 2D canvas host (`src/render/`, `src/main.ts`) renders
   DoT numbers untinted and shows no pips; the Crawler Profile (`sheet.ts`)
   doesn't yet print burn/poison DPS rows for Afterburn/Frost/Venom builds.
   Sim data is all there (`statuses`, `HitEvent.effect`).
3. **Status audio cues.** No sounds for ignite/poison/chill apply or DoT
   ticks — deliberately skipped rather than adding asset files. Seam:
   `src/audio/director.ts` maps sim events to clip ids; would key off
   `HitEvent.effect`.
4. **Clown bombs on boss blast telegraphs.** The clown-ordnance prop renders on
   EVERY blast-kind hazard, including the Architect's masonry and the Furnace
   Marshal's flame rows (Hazard carries no source tag). Reads as System
   shelling, but if it grates, add a `src` tag to `Hazard` and gate the bomb
   mesh in `renderer3d.ts`.
5. **iPad touch controls (Wild Rift-style).** Full plan scoped 2026-07-08.
   Everything funnels through the `Intent` seam (`src/sim/types.ts` — move
   vector, aim vector, five held `cast` booleans, edge triggers), so this is
   a second Intent producer beside `InputController` (`src/input/input.ts`):
   **zero sim changes, multiplayer free** (intents already serialize).
   - **Phase 1 — playable slice.** New `TouchController` (~400 lines,
     `src/input/touch.ts`): floating left-thumb movement stick (screen delta
     needs one camera-yaw rotation to become a world direction — same math
     as `renderer.screenToGround`); right-thumb ability cluster (big attack
     button + arced slot buttons feeding the same held `cast` array); tap =
     quick cast with auto-aim at nearest living monster in a facing cone
     (~15-line host helper, cf. the click-move hover check in `main3d.ts`);
     flask + stairs buttons (stairs lit only when standing on them); ping =
     tap the minimap (`intent.ping` takes a world pos). Multi-touch via
     pointer events keyed by `pointerId` (stick thumb + ability press must
     coexist); `touch-action: none` on the play area; suppress double-tap
     zoom. Platform meta: `viewport-fit=cover` + `env(safe-area-inset-*)`
     HUD padding, `apple-mobile-web-app-capable` for home-screen fullscreen,
     cap `devicePixelRatio` ~2 in the Three.js renderer (iPad fill rate).
     Detect via `(pointer: coarse)` + manual settings toggle. Touch HUD is
     ON the fight screen → glass, not stone (STYLEGUIDE rule four). Click-
     move mode stays off on touch.
   - **Phase 2 — drag-to-aim.** Press-and-drag off a slot button shows a
     ground telegraph (line for bolt-class, ring for novas, arrow for dash);
     drag direction IS `intent.aim` (no raycast needed); release casts, drag
     to a cancel zone aborts. Renderer grows `setAimIndicator()`, sibling to
     `setMoveMarker()`. This is what makes it Wild Rift, not twin-stick.
   - **Phase 3 — menu touch pass.** Item tooltips are `mouseover`-driven
     (`main3d.ts` itemTip wiring) → tap-to-inspect, explicit button to act
     (shop already has a Purchase button); check ≥44px hit targets on
     constellation nodes + bag tiles; hide the keybinds panel on touch.
   - Default cast mode: tap = auto-aim, drag = precise (orbit/nova are
     aimless anyway; bolt/dash/slam care). Headless CDP harness can drive
     Phase 1 via `Input.dispatchTouchEvent`; feel-tuning (dead zone, aim
     sensitivity) wants a real iPad.
6. **Boss kiting trivializes fights** (play feedback 2026-07-08). Bosses can
   be walked in circles forever: melee bosses have no gap-closer and nothing
   punishes a crawler who never lets the windup start. The stagger half of the
   same feedback shipped (poise decay + post-stagger grace in
   `damageMonster`/`stepMonster`); the movement half remains. PARTIAL: the
   arena directors (2026-07-09, `arenaDirector` in game.ts) now shrink safe
   orbit paths on floors 6/9/15 on a rhythm. Still open: a leash lunge on the
   boss kit (tier-gated like slam/ritual) or a move-speed ramp when the
   target stays out of reach N seconds. Code: boss branch of `src/sim/ai.ts`,
   `boss*` knobs in `src/sim/config.ts`.
