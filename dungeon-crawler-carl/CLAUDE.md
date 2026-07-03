# Dungeon Crawler Carl — notes for Claude Code

Diablo-like ARPG inspired by *Dungeon Crawler Carl*. Full design: `DESIGN.md`.

## Commands
- `npm run dev` — Vite dev server (`/` = 2D host, `/iso.html` = 3D host)
- `npm run server` — authoritative multiplayer server (ws, port 5281)
- `npm test` / `npm run typecheck` — Vitest + tsc (run both before committing)

## Architecture rules (load-bearing)
- `src/sim/` is a **pure deterministic core**: no DOM, no `Math.random`, no
  `Date.now()`. All randomness through the seeded RNG in state; time only via
  the `dt` passed to `step`. Hosts (main.ts, main3d.ts, server) consume it.
- Feedback flows out of the sim as data: `state.hits` (typed combat events),
  `state.announcements` (DCC "System" lines), `state.events` (log). Hosts turn
  these into particles, damage numbers, toasts, and **sound** — never put
  presentation in the sim.

## Deployment (Fly.io — full detail in `DEPLOY.md`)
Production is one Docker container on Fly.io (app `dungeon-crawler-claude`,
ord, shared-cpu-1x/512MB) serving the built client, `/health`, and the game
WebSocket on port 8080. Deploy process, in order:

1. **Verify the tree**: `npm test` and `npm run typecheck` must pass on the
   exact commit you're shipping (usually merged `main`).
2. **Check production is idle**: party state is in-memory, so a deploy drops
   live runs. `curl https://dungeon-crawler-claude.fly.dev/health` — deploy
   only when `instances`/`players` are 0, or warn the user first.
3. **Deploy**: `fly deploy --yes` from this directory (`dungeon-crawler-carl/`,
   where `fly.toml` and the `Dockerfile` live). flyctl is at
   `$USERPROFILE/.fly/bin/fly.exe` if not on PATH. Builds remotely, then does
   a rolling update of the single machine with health checks.
4. **Verify**: `/health` returns `{"ok":true,...}` with fresh `uptimeMin`,
   and `/iso.html` serves HTTP 200.

Known-benign deploy warnings: "app is not listening on 0.0.0.0:8080" is a
startup race (health checks pass seconds later); DNS verification i/o
timeouts are the checker's network, not the app.

**Never scale beyond exactly 1 machine** (`fly.toml` pins it): party state
lives in process memory, so a second machine splits joins into separate
universes. Capacity, load-testing (`scripts/loadtest.mjs`), and the GCP
migration plan are in `DEPLOY.md`.

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
