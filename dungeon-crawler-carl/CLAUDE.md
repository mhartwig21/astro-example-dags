# Dungeon Crawler Carl — notes for Claude Code

Diablo-like ARPG inspired by *Dungeon Crawler Carl*. Full design: `DESIGN.md`.

## Commands
- `npm run dev` — Vite dev server (`/` = 2D host, `/iso.html` = 3D host)
- `npm run server` — authoritative multiplayer server (ws, port 5281)
- `npm test` / `npm run typecheck` — Vitest + tsc (run both before committing)

## Test mode (jump into any stage)
`/iso.html?test&floor=9&level=12&abilities=all&gold=500&seed=42` (2D: `/?test...`).
Builds a deterministic stage-representative crawler via `createTestGame`
(sim/game.ts): floor clamps to 1..finalFloor, levels auto-draft real
constellation ranks, gear rolls floor-scaled (`gear=0` disables),
`abilities` is `all` or a comma list. Nothing is loaded or saved — the real
run's save is untouched. R rerolls the seed unless `seed=` is pinned.

## Architecture rules (load-bearing)
- `src/sim/` is a **pure deterministic core**: no DOM, no `Math.random`, no
  `Date.now()`. All randomness through the seeded RNG in state; time only via
  the `dt` passed to `step`. Hosts (main.ts, main3d.ts, server) consume it.
- Feedback flows out of the sim as data: `state.hits` (typed combat events),
  `state.announcements` (DCC "System" lines), `state.events` (log). Hosts turn
  these into particles, damage numbers, toasts, and **sound** — never put
  presentation in the sim.

## Assets (models + audio) — silent/placeholder fallback pattern
Both loaders degrade gracefully, so the game always runs with zero assets:
- **Models**: `src/render3d/assets.ts` (`MODEL_MANIFEST`) loads glTF from
  `public/assets/`; missing files → procedural low-poly stand-ins.
- **Audio**: `src/audio/manifest.ts` (`AUDIO_MANIFEST`) loads clips from
  `public/audio/`; missing files → silence. `src/audio/director.ts` maps sim
  events/state edges to sound ids — add new sounds there + in the manifest.
- `ASSETS.md` is the **source of truth for licenses**. Everything committed so
  far is CC0. When fetching new assets (models or audio), record origin +
  license there; CC-BY requires an attribution entry and an in-game credits
  screen. Never commit NC-licensed files. `scripts/fetch-assets.sh` has
  download pointers for both kinds.
