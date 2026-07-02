# Dungeon Crawler Carl — Design Document

A Diablo-like action-RPG dungeon crawler inspired by *Dungeon Crawler Carl*. Players
drop into a deadly, procedurally generated dungeon and must descend to the **18th
floor**. Each floor runs on a **collapse timer** — take too long and the floor turns
lethal. Multiplayer is **party-private**: a small group shares an instanced floor, and
players may **log on and off** without losing their character.

This document describes the full target architecture, then defines the scope of the
**vertical slice** shipped in this repo (single-player, local, no server).

---

## 1. Design pillars

1. **Descend or die.** The core tension is the per-floor collapse timer. Every system
   feeds the "keep moving down" pressure. This is the soul of the game — it ships first.
2. **Server-authoritative.** In multiplayer, clients send *intent*; the server decides
   outcomes. Loot, combat, and the timer are never trusted to the client. (The vertical
   slice runs the same authoritative sim locally so the code ports directly to a server.)
3. **Deterministic sim core.** All game rules live in a pure, DOM-free module that steps
   `(state, intents, dt) -> state`. Determinism buys us replay, server validation,
   headless testing, and a future RL/agent environment for free.
4. **Instanced, not open.** A floor is a bounded instance shared by one party. This makes
   networking and interest-management tractable and matches the "timed descent" premise.
5. **DCC personality on top.** The AI game-show host, loot boxes, achievements, and absurd
   upgrades are an event/notification layer over the sim — added once the loop is solid.

---

## 2. Reference projects — how we use them

| Project | Role in this design |
|---|---|
| [`diasurgical/devilution`](https://github.com/diasurgical/devilution) | **Reference manual only.** Reverse-engineered Diablo (C++, Win95). Non-commercial license, requires original game assets to run. We read it to understand Diablo's *formulas* — damage, itemization tiers, monster density per level, isometric camera feel — and reimplement them cleanly in TypeScript. We do **not** fork or link it. |
| [`levy-street/world-of-claudecraft`](https://github.com/levy-street/world-of-claudecraft) | **Architectural blueprint.** Its "one deterministic sim, three hosts (offline browser / authoritative server / headless RL env)" pattern, server-authoritative model ("clients send intent, server decides outcomes"), interest-scoped WebSocket snapshots, and Postgres persistence are the spine we adopt — with the game rules swapped for DCC and the open world replaced by instanced floors. |

---

## 3. Target architecture ("one sim, three hosts")

```
                    ┌───────────────────────────┐
                    │   sim/  (deterministic)    │
                    │   pure TS, no DOM, no net   │
                    │   step(state, intents, dt)  │
                    └─────────────┬───────────────┘
             ┌────────────────────┼─────────────────────┐
             │                    │                      │
   ┌─────────▼────────┐  ┌────────▼─────────┐  ┌─────────▼─────────┐
   │  Offline client  │  │ Authoritative     │  │  Headless env     │
   │  (browser, solo) │  │ server (Node)     │  │  (RL / tests)     │
   │  render + input  │  │ owns instances,   │  │  scripted intents │
   │  runs sim locally│  │ timers, persist   │  │  no render        │
   └──────────────────┘  └───────────────────┘  └───────────────────┘
```

- **`sim/`** — deterministic core. Seeded RNG, floor generation, movement, combat, loot,
  stats, and the collapse timer. No wall-clock, no `Math.random`, no DOM. Steps on a fixed
  timestep. This is the only place game rules live.
- **Offline client** — renders sim state (Canvas2D top-down for the slice; isometric /
  Three.js later), maps keyboard/mouse to intents, runs the sim in the browser.
- **Authoritative server** (future) — owns floor instances, runs the sim at fixed tick,
  validates intents, broadcasts interest-scoped snapshots over WebSocket, persists
  characters to Postgres.
- **Headless env** (future) — drives the same sim with scripted/agent intents for tests
  and RL training.

### Determinism rules
- Single seeded PRNG (mulberry32/xorshift) threaded through state. No `Math.random`.
- No `Date.now()` inside sim; time advances only via `dt` passed to `step`.
- Fixed timestep (e.g. 60 Hz sim tick) with an accumulator in the host loop.

---

## 4. Multiplayer model (party-private, drop-in/drop-out)

- **Instance = one party on one floor.** 1–6 players. When the party descends, the server
  spins up the next floor instance and moves everyone into it.
- **Log on / off.** Character state (level, stats, inventory, current floor, gold) is
  persisted server-side. On login the player rejoins their party's current instance if it
  exists, otherwise resumes solo at their saved floor. Disconnect leaves a "downed"/ghost
  marker briefly, then the character is removed from the live instance but its progress is
  saved. (The vertical slice models this with `localStorage` save/load so the persistence
  seam exists from day one.)
- **Authority.** Server runs the instance sim. Clients send intents; server returns
  snapshots. Client-side prediction/interpolation is a later optimization, not required
  for correctness.
- **Party lifecycle.** Create/join via invite code. Empty instances (all players logged
  off) are snapshotted and torn down; first player back respawns the floor from the seed +
  saved progress.

---

## 5. Core game systems

### 5.1 Floors & descent
- 18 floors. Each is a procedurally generated grid of rooms joined by corridors, with a
  **stairs-down** tile. Reaching it descends the party to the next floor.
- Difficulty scales with depth: monster count, monster stats, archetype mix, and loot
  quality all rise.
- **Floor 18 is a boss arena**: the exit is sealed until the boss (melee chase + radial
  projectile volleys, plus ranged adds) is defeated; killing it wins the run. A live
  **minimap** helps navigate each floor to the stairs.

### 5.2 Collapse timer (the central mechanic)
- Each floor starts with a countdown (scaled per floor). It is **authoritative** and lives
  in sim state.
- Phases: **Safe** (full duration) → **Warning** (visual/audio escalation) → **Collapse**
  (floor becomes lethal: escalating damage-over-time to anyone still on it). Descending
  resets the timer for the new floor.
- This mechanic ships first because it defines the game and is cheap to build.

### 5.3 Combat
- Real-time. Player has a melee attack (slice) with cooldown and range; monsters have HP,
  damage, and simple chase AI.
- Damage formula reimplemented in the spirit of Diablo: `damage = base + weapon − armor
  mitigation`, with hit variance from the seeded RNG. Kept simple in the slice, expandable.
- **Crits** (seeded roll) and a **structured hit-event channel** (`GameState.hits`): the
  sim emits typed feedback events (enemy/crit/player/heal/gold/weapon) that hosts turn into
  floating damage numbers, particle bursts, and camera shake. Because the crit roll uses the
  same seeded RNG stream, these effects are deterministic and replay identically.
- **Enemy archetypes** (grunt / swarmer / brute / ranged / boss): stats scale per floor and
  are modified per archetype (see `ARCHETYPES` in config); behavior branches in `ai.ts`
  (melee chase, ranged kite-and-shoot, boss chase + radial volley). The spawn mix shifts
  toward tougher enemies with depth.
- **Active skills** — **dash** (blink in facing with brief i-frames) and a **ranged bolt**,
  each on a cooldown. Skills produce intents like everything else, so they port to the server.
- **Projectiles** (`GameState.projectiles`): one system for player bolts and enemy shots —
  moved and collision-resolved deterministically each step.

### 5.4 Stats, leveling, loot
- Character: HP, damage, speed, level, XP, gold. Kill XP → level up → stat increases.
- Loot: monsters drop gold, health, and **equipment items** (weapon / armor / trinket) with
  a rarity tier (common / magic / rare / epic — weighted) and rolled **affixes** (damage,
  maxHp, speed, crit). Items go to an inventory; a better item auto-equips, and an
  **inventory panel** lets the player equip from the bag (game pauses).
- **Stat model:** effective stats are recomputed as `intrinsic(level) + permanent bonuses
  (loot boxes) + equipped affixes` (`recomputeStats`), so equipping/unequipping is clean and
  order-independent. Equipment + inventory are persisted for log on/off.

### 5.5 DCC flavor layer (started)
- AI "System" announcer emitting event messages, loot boxes, achievements, absurd upgrades.
  Implemented via `GameState.announcements` — a curated, DCC-voiced subset of events the
  host surfaces as game-show toasts — with no coupling into core rules.
- **Loot boxes** (in the slice): every N kills the System awards a randomized buff
  (weapon mod / max-HP / heal) with an announcer line, tracked in `GameState.lootBoxes`.
- Still to come: achievements, the recurring announcer personality/banter, cosmetic
  absurdity, and the meta "show" framing (sponsors, audience, leaderboards).

---

## 6. Tech stack

- **Language:** TypeScript throughout (sim, client, future server all share types).
- **Client build:** Vite. **Render (slice):** Canvas2D top-down — fast to ship and enough
  to prove the loop. **Render (later):** isometric sprites or Three.js for the Diablo feel.
- **Server (later):** Node + `ws` (WebSocket), Postgres for persistence.
- **Testing:** Vitest against the pure sim core (deterministic → trivial to assert).

Rationale: staying single-language and keeping the sim pure means the exact code that runs
in the browser slice will run unmodified inside the authoritative server and a headless
test/RL harness.

---

## 7. Vertical slice scope (what's in THIS repo)

**Goal:** prove the DCC core loop end-to-end, single-player, running locally in a browser.
No server, no networking, no accounts — but built on the deterministic sim so it ports.

**In scope**
- Deterministic sim core: seeded RNG, grid floor generation, movement, melee combat,
  monster chase AI, loot pickups, stats/leveling, and the **collapse timer**.
- 18 floors with descent via stairs and depth-scaled difficulty.
- Canvas2D top-down renderer + HUD (HP, floor #, timer with phase color, level/gold).
- Keyboard/mouse input → intents → sim.
- Fixed-timestep game loop with accumulator (deterministic sim, smooth render).
- **Log on/off** modeled via `localStorage` save/load of character + run progress.
- Vitest unit tests over the sim.

**Explicitly out of scope (documented, not built)**
- Any server, WebSocket, multiplayer, or party code (architecture defined above).
- Postgres / real accounts.
- Isometric/3D rendering, art, audio.
- Full itemization, skills/classes, the DCC announcer layer.

**Definition of done for the slice**
- `npm install && npm run dev` launches a playable game.
- You can move, fight monsters, take loot, level up, watch the collapse timer escalate,
  find the stairs, and descend through floors toward 18.
- Refreshing the page resumes your character (log on/off seam).
- `npm test` passes deterministic sim tests.

---

## 8. Directory layout

```
dungeon-crawler-carl/
  DESIGN.md              ← this file
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    sim/                 ← deterministic core (no DOM, no net)
      rng.ts             ← seeded PRNG
      types.ts           ← shared data model
      config.ts          ← tunables (floor count, timer, scaling)
      floor.ts           ← procedural floor generation
      combat.ts          ← damage/attack resolution
      ai.ts              ← monster behavior
      game.ts            ← createGame + step(state, intents, dt)
    render/
      renderer.ts        ← Canvas2D top-down draw + HUD
    input/
      input.ts           ← keyboard/mouse → intents
    persist/
      save.ts            ← localStorage save/load (log on/off seam)
    main.ts              ← host loop wiring sim + render + input
  test/
    sim.test.ts          ← deterministic sim tests
```

---

## 9. Roadmap beyond the slice

1. **Extract the server.** Move the sim behind a Node authoritative loop; client sends
   intents over WebSocket, receives snapshots. Single-player client keeps running the sim
   locally as the "offline host."
2. **Party instancing + real persistence.** Invite codes, shared floor instances, Postgres
   character store, drop-in/drop-out rejoin.
3. **Depth on the game.** Full itemization, classes/skills, boss on floor 18.
4. **DCC layer.** The System announcer, loot boxes, achievements, humor.
5. **Isometric/3D render.** Upgrade the view for the Diablo feel.
6. **Headless RL env.** Wrap the sim in a Gymnasium-style interface for agents.
