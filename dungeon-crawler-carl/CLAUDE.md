# Dungeon Crawler Carl — agent onboarding

Read this first; it's the map. Everything else is linked from here.

## What we're building

A **Diablo-like multiplayer ARPG inspired by the *Dungeon Crawler Carl* novels**:
Earth's buildings vanish and survivors crawl a dungeon that is also a galactic
reality-TV show. You descend **18 floors** before each floor's **collapse
timer** turns it lethal, killing through themed 3-floor bands (THE UNDERCROFT →
THE SEWERS → THE GARDEN → THE RUINS → THE IRONWORKS → THE APPROACH), leveling
an ability constellation, looting/crafting LoL-style gear, while **The Show**
converts exciting play into viewers → favorites → sponsors. The tone is the
System's game-show announcer voice: loot boxes, RINGSIDE INTRODUCTIONS,
achievements with cash payouts.

**Production**: https://dungeon-crawler-claude.fly.dev/iso.html (Fly.io, one
always-on machine — see DEPLOY.md before touching infra).

## The one architectural idea (load-bearing)

**One deterministic sim, three hosts.** `src/sim/` is a pure core: no DOM, no
`Math.random`, no `Date.now()` — all randomness flows through the seeded RNG
in state, time only via the `dt` passed to `step()`. Identical inputs replay
identical runs. Three hosts consume it:

- `src/main.ts` — 2D canvas host at `/` (debug/truth view)
- `src/main3d.ts` — 3D isometric Three.js host at `/iso.html` (the real game)
- `src/server/` — authoritative multiplayer server (same sim, snapshots out,
  intents in; parties are private via `?join=CODE`)

Feedback leaves the sim **as data**: `state.hits` (typed combat events),
`state.announcements` (System lines with `kind` + `priority`), `state.events`
(log). Hosts turn those into particles, damage numbers, banners/ticker, and
sound. Never put presentation, DOM, or wall-clock time in the sim; never put
game rules in a host. If a rule lives in main3d.ts, it's a bug.

## Doc index

| Doc | What it answers |
|---|---|
| `DESIGN.md` | Full design: pillars, systems (5.x per mechanic), architecture, directory layout, roadmap |
| `README.md` | Player-facing intro + how to run |
| `DEPLOY.md` | Production architecture, Fly.io ops, measured capacity, GCP migration plan |
| `PERSISTENCE.md` | Server-side persistence (SQLite on the Fly volume): accounts + character saves are LIVE; world hibernate/restore is the P2 plan |
| `ASSETS.md` | **Source of truth for asset licenses.** Every model/sound's origin + license. CC0 preferred; CC-BY needs the in-game credits screen; NC never |
| `KAYKIT-INVENTORY.md` | What's in the owner's KayKit Complete Collection zip vs what's in use — rigged-character census (mob-scaling menu), untapped packs, integration seams |
| `MOB-CONCEPTS.md` | The 36-mob roster design: band casts, new sim verbs (knockback/beams/auras), elite affix expansion, boss variety layers. Delete sections as they ship |
| `BIOMES.md` | Art direction notes for floor/room visual variety |
| `BACKLOG.md` | Open play-driven items with code pointers. Delete entries when they ship |
| `GENERATION-BACKLOG.md` | Asset gaps mapped KayKit-first, then the Meshy generation queue (clips, props, the flagship character path). Delete rows as they ship |
| `BUILDER.md` | The /builder.html crafting bench: room templates, custom enemies, and the dev-only Meshy bridge (prop + creature generation). Content lands in `src/content/` |

## Commands

- `npm run dev` — Vite dev server (`/` = 2D host, `/iso.html` = 3D host)
- `npm run server` — multiplayer server (ws; serves static too in prod mode)
- `npm test` / `npm run typecheck` — Vitest + tsc (**both, before every commit**)

## Test mode (jump into any stage)

`/iso.html?test&floor=9&level=12&abilities=all&gold=500&seed=42` (2D: `/?test...`).
Builds a deterministic stage-representative crawler via `createTestGame`
(sim/game.ts): floor clamps to 1..finalFloor, levels auto-draft real
constellation ranks, gear rolls floor-scaled (`gear=0` disables), `abilities`
is `all` or a comma list. Nothing is loaded or saved — the real run's save is
untouched. R rerolls the seed unless `seed=` is pinned. This is also the
fastest way to verify visual/balance changes at depth.

## Codebase map

```
src/sim/            THE GAME. Pure, deterministic, fully unit-testable.
  game.ts           step() + almost every rule: combat resolution, XP/drafts,
                    loot, shop purchases, safe rooms, collapse, The Show
  config.ts         every tuning knob + FLOOR_BANDS; balance changes start here
  abilities.ts      The Five (4 slots + ultimate), constellation UPGRADES
                    (forks/capstones/overranks), damage schools (AP/SP)
  items.ts          generated gear: rarities, affixes, weapon classes
  catalog.ts        System Shop: tiered catalog, components build into gear
  floor.ts          mapgen: rooms with roles (entrance/landmark/vault/stairs),
                    boss arenas, door seals
  ai.ts             monster archetypes + elite affixes + boss phases
  bot.ts            competent scripted player — powers the balance tests
  sheet.ts          derived character-sheet numbers (the P panel reads this)
  snapshot.ts       net serialization
hosts:
  main.ts/main3d.ts hosts (above); main3d.ts also owns ALL UI panels
  src/server/       gameServer: parties, intents in, snapshots out, /health
  src/net/          client side of the same
presentation:
  src/render/       2D canvas renderer + fog pattern
  src/render3d/     renderer3d (scene, juice: shake/particles), assets.ts
                    (MODEL_MANIFEST — KayKit glTF with procedural fallbacks),
                    floorThemes.ts (per-band reskin), fogOfWar.ts, ambient.ts,
                    weaponry.ts (noun→mesh for held weapons)
  src/audio/        engine + manifest (clips, silent fallback) + director
                    (maps sim events → sound ids)
support:
  src/input/        rebindable keys + mouse aim + notify verbosity (dcc:* keys)
  src/persist/      localStorage save (SavedProgress; floor regenerates
                    from seed — only progression persists)
test/               sim.test.ts (rules), balance.test.ts (the difficulty
                    CONTRACT — a bot must clear early floors; keep it green,
                    it encodes "playable", not "current numbers"), server,
                    audio, bindings
```

UI overlays in `iso.html` follow a **screen-zone map** (comment block in its
CSS): every fixed overlay claims exactly one zone; new overlays must pick a
zone there first. Announcements route by priority: high → the one center
banner, normal → the right-rail ticker (filtered by the K-panel verbosity
setting).

## Assets (models + audio) — silent/placeholder fallback pattern

Both loaders degrade gracefully, so the game always runs with zero assets:
- **Models**: `src/render3d/assets.ts` (`MODEL_MANIFEST`) loads glTF from
  `public/assets/`; missing files → procedural low-poly stand-ins. The clip
  animator fuzzy-matches animation names, so new rigged packs inherit the
  animation state machine.
- **Audio**: `src/audio/manifest.ts` loads from `public/audio/`; missing →
  silence. New sounds: add to the manifest + map in `src/audio/director.ts`.
- Record every new asset's origin + license in `ASSETS.md` (CC-BY additionally
  requires the in-game credits entry). `scripts/fetch-assets.sh` has download
  pointers.

## Working practices

- **Branch from `origin/main`, PR to main.** Several agent sessions often work
  this repo **in parallel** — main moves while you work. Before merging your
  PR: `git fetch`, merge `origin/main` into your branch, resolve, re-run
  tests + typecheck, then merge. BACKLOG.md conflicts are usually "both sides
  deleted different shipped items" — delete both.
- **Verify visually before shipping visual changes**: drive the real app, not
  just tests. Headless Chrome recipe (flags, CDP driving, SwiftShader
  gotchas — it runs ~3fps, hold keys ≥450ms, sim time dilates) lives in
  `.claude/skills/verify/SKILL.md` if present locally; the test-mode URL is
  the fast path to any game state.
- **Deploy runbook** (after merging to main):
  1. `git checkout origin/main` and run `npm test` + `npm run typecheck` on
     the exact commit you'll ship.
  2. Deploys are SURVIVABLE (PERSISTENCE.md): live worlds checkpoint to
     SQLite on SIGTERM and clients auto-reconnect (~a few seconds of pause).
     Still glance at https://dungeon-crawler-claude.fly.dev/health — deploying
     while someone's mid-boss is rude, just no longer destructive.
  3. `fly deploy --yes` from `dungeon-crawler-carl/` (flyctl:
     `$USERPROFILE/.fly/bin/fly.exe` on the dev box).
  4. Verify `/health` shows fresh `uptimeMin` and `/iso.html` returns 200.
  Known-benign deploy warnings: "not listening on 0.0.0.0:8080" (startup
  race) and the DNS-verification i/o timeout. **Never scale past exactly one
  machine** — party state is in-memory (DEPLOY.md explains).
- **Announcement etiquette**: sim-side `announce()` sets kind + priority
  ("high" is reserved for headline moments — boss intros/kills, new band,
  wipe/win). Don't flood; hosts already pace presentation.
- Play-driven bugs/ideas go in `BACKLOG.md` with code pointers; delete the
  entry in the PR that ships it.
