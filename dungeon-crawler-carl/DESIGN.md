# Dungeon Crawler Claude — Design Document

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
- **Enemy archetypes** (grunt / swarmer / brute / ranged / boss / bomber / shaman /
  phantom / charger / spitter / necromancer): stats scale per floor and are modified per
  archetype (see `ARCHETYPES` in config); behavior branches in `ai.ts` (melee chase,
  ranged kite-and-shoot, bomber contact-fuse, shaman standoff-heal, phantom blink,
  charger locked-lane rush, spitter acid lobs that linger as ticking ground puddles,
  necromancer corpse-raising — deaths leave TTL-capped `GameState.corpses` it consumes —
  and boss chase + radial volley). The spawn mix shifts toward tougher enemies with
  depth; specialists unlock by floor (bomber 2+, charger 3+, shaman 4+, spitter 5+,
  phantom 6+, necromancer 7+).
- **Active skills** — **dash** (blink in facing with brief i-frames, running on **2
  charges** that refill one at a time so dodges weave into offense) and a **ranged bolt**
  on a cooldown. Skills produce intents like everything else, so they port to the server.
- **Projectiles** (`GameState.projectiles`): one system for player bolts and enemy shots —
  moved and collision-resolved deterministically each step.
- **Telegraphed enemy attacks (the "risky" pillar):** no monster damage is instant. Every
  attack winds up (`Monster.windup`, per-archetype length — swarmer 0.25s … brute 0.75s;
  ranged aim before firing; bombers light a **fuse** on contact and detonate where it runs
  out), roots the attacker, and re-checks range + dash i-frames when it resolves. Because
  hits are readable and dodgeable, monster damage runs HOT (a clean grunt hit ~15% of
  starting HP, a brute slam ~27%) — danger comes in avoidable spikes, not chip.
- **Hit reactions (the "impact" pillar):** player damage shoves monsters (knockback ÷
  archetype `mass`) and builds **poise damage**; crossing `maxHp × poise` **staggers** the
  target, canceling its windup. Chaff flinches off every hit; brutes/bosses shrug off small
  hits, so interrupting a big slam takes a heavy answer. The melee swing also **lunges** a
  short step toward the aim. Hosts layer the cosmetics: telegraph rings + windup/stagger
  animation from the sim state, kill pops (hit-stop + directed bursts) from `HitEvent.dir`
  / `HitEvent.killed`, and swing/tell/kill audio cues.
- **Aggression is sustain (the "frenetic" pillar):** the **Sponsor Slurp™ flask** heals
  35% of max HP per charge and is refilled by **kill credit** (8 kills per charge, safe
  rooms top it up) — the way out of danger is through the pack. **Crowd Frenzy** feeds the
  show economy back into combat: sustained hype (enter 60 / exit 40, hysteresis) grants
  +12% move speed and −15% cooldowns while the crowd chants.
- **Elite affixes (floor 3+):** every named elite rolls one mechanic — **swift** (+40%
  speed), **shielded** (takes 30% less damage), **volatile** (0.8s delayed corpse blast,
  telegraphed by a ground ring — clear the corpse), **summoner** (calls swarmer adds,
  lifetime-capped, worth ~no XP), **splitter** (bursts into swarmers on death), or
  **thorns** (reflects a slice of every hit back at the attacker, capped per hit at a
  fraction of their max HP). **Boss phases:** crossing 2/3 and 1/3 HP enrages bosses
  (faster chase, +3 volley projectiles and a shorter volley cooldown per phase, announced).
- **Ringside introductions:** the first time any player closes within 7 tiles of an unmet
  boss/elite, the sim FREEZES the whole world (`GameState.encounter`, like the safe-room
  pause — multiplayer-consistent) for ~2.2s while the System introduces the menace by name
  and affix. Nobody can be hit mid-reveal. Hosts render an intro splash over the freeze
  and, for the rest of the fight, a persistent top-center **boss health bar** (icon, name,
  affix, HP) for the nearest introduced boss/elite. One introduction per menace, ever.

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
  Implemented via `GameState.announcements` — a curated, DCC-voiced subset of events, each
  typed `{ text, kind, priority }` — with no coupling into core rules. The sim merges
  intrinsically-batchy sources (multi-level XP grants, same-step achievement unlocks) into
  one line; the 3D host shows `priority: "high"` lines as an exclusive center-screen banner
  and paces the rest through a capped toast queue (max 3 visible, ~0.65s stagger, stale
  lines fall back to the log) so a boss kill doesn't wallpaper the screen.
- **Loot boxes** (in the slice): every N kills the System awards a randomized buff
  (weapon mod / max-HP / heal) with an announcer line, tracked in `GameState.lootBoxes`.

### 5.6 The Show — audience economy (in the slice)
- **Hype** (`GameState.hype`): a decaying excitement meter. Exciting + challenging play adds
  hype — crits, multi-kill combos, tough-enemy kills (brute/boss weighted), taking hits at
  low HP, surviving a collapsing floor, and rare/epic drops.
- **Viewers / favorites / sponsors** (`updateShow`, deterministic): viewers ease toward a
  target set by floor depth + hype + fan loyalty; a slice of the crowd converts to sticky
  **favorites** while hyped; crossing favorite thresholds earns **sponsors**. So "exciting →
  sponsors" is emergent, not scripted.
- **Sponsor draft** (`generateRewards` / `chooseReward`): on descending, sponsors present a
  pick-1 reward draft (heal / +max HP / +damage / +crit / gear / gold / bonus floor time).
  Each sponsor fields one option, capped at 3 — no sponsors, no gifts. Sponsors beyond the
  cap each pitch an extra candidate and only the best fits for the crawler's build survive
  (`rewardFitScore`), so heavy backing skews the draft toward stronger, on-build options.
  Roll quality also scales with sponsors + favorites; the draft pauses the sim
  (enforced in `step`) until the player chooses. Rewards roll off a dedicated per-floor RNG
  so the offer is reproducible. Metrics persist for log on/off.
- Still to come: achievements, recurring announcer personality/banter, cosmetic absurdity,
  and leaderboards.

### 5.7 Ability loadout (planned — supersedes the flat ability tree)

Today (`abilities.ts`) every discovered ability just stacks — no scarcity, so there is no
"what's my build?" decision. This spec adds a **fixed loadout** that forces build identity
while keeping the existing tree, drafts, tomes, bindings, and safe rooms.

**The Five — a player's build is exactly 5 slots:**
- **4 ability slots** + **1 ultimate slot** (a distinct, longer-cooldown tier).
- Abilities are tagged by `tier`: `active` (fill the 4 slots) or `ultimate` (fills the 1).
- **Start:** slots begin as `[Melee, Dash, Bolt, empty]` for the four abilities, ultimate
  slot **empty**. Melee, Dash, and the ranged Bolt are your opening kit; the 4th ability
  and the ultimate are discovered.

**Melee & Dash are normal slotted abilities that can be freed.**
- They start *in* the five (not innate/off-loadout) and keep their upgrade node tracks, so
  Dash can still be built into a centerpiece (Shockstep/Long Blink/Quickstep).
- You may **free** a melee/dash slot to run a discovered ability in its place. Freeing them
  removes them from your kit entirely — a real commitment (e.g. an all-cooldowns, no-basic-
  attack build). Invested ranks persist if you re-slot later. *(Balance note: freed = truly
  gone, no innate fallback; add a weak fallback only if playtesting says it feels bad.)*

**Slotting rules (the core UX ruling):**
- **Slot immediately when a slot is open** — discovering an ability while a matching slot is
  empty installs it on the spot (field pickup keeps momentum; you can use a fresh find right
  away). Same for the ultimate slot.
- **Re-slot / swap / free only in safe rooms** — once slots are full, a new discovery goes to
  the **bench**; rearranging the build (swapping, freeing melee/dash, changing the ultimate)
  is a committed **safe-room** decision. No mid-fight reshuffling. (Gate on the existing
  safe-room state.)

**Consequences that make it a build:**
- Once you know more than 4 actives + 1 ult, you must **choose** which to slot — that choice
  *is* the build.
- The **level-up upgrade draft offers ranks only for currently-slotted abilities**, so
  investment follows the kit you're actually running (benched/freed abilities aren't offered).
- **Ultimate** = long cooldown (~20–60s) + screen-scale impact (Meteor Storm, Bullet Time,
  Cataclysm Nova, Summon Champion, on-brand "Sponsor Airstrike"). Exactly one slotted.

**Keys:** 4 ability binds + 1 ultimate bind, all via the existing rebindable `Bindings` map
(melee defaults LMB, dash Shift). Because melee/dash are slots now, they rebind/replace like
any slot.

**Data model impact (`Player`):** add `slots: (AbilityId|null)[4]`, `ultimate: AbilityId|null`,
and a `bench` (known-but-unslotted). Cast path reads slots (not `known`); discovery adds to an
open slot or the bench; a `T`-panel slotting UI performs safe-room re-slots. All pure/
deterministic, so multiplayer + tests hold.

---

## 6. Tech stack

- **Language:** TypeScript throughout (sim, client, future server all share types).
- **Client build:** Vite. **Render (slice):** Canvas2D top-down — fast to ship and enough
  to prove the loop. **Render (later):** isometric sprites or Three.js for the Diablo feel.
- **Server (later):** Node + `ws` (WebSocket), Postgres for persistence.
- **Testing:** Vitest against the pure sim core (deterministic → trivial to assert),
  including a **scripted balance bot** (`src/sim/bot.ts`): a deterministic policy
  (BFS pathing to the floor objective, fight/dodge/flask heuristics, wedge escape)
  that plays whole floors headlessly. `test/balance.test.ts` asserts playability
  invariants across fixed seeds — floors 1-2 clearable before collapse, the dungeon
  still deals real damage — so tuning changes are regression-tested, not vibed. It
  also emits per-floor metrics (`runBot`) for tuning sweeps, doubles as a seed-scale
  softlock fuzzer, and is the scripted-policy seed of the future RL env / MP load
  tests. A determinism guard test keeps `Math.random`/wall-clock out of `src/sim/`.

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

1. ~~**Extract the server.**~~ **DONE.** The sim is multiplayer-native (party of N,
   per-player intents, non-blocking drafts, ready-up safe rooms; solo = party of one).
   `src/server/gameServer.ts` runs authoritative instances behind `ws`: clients send
   intents/choices, the server ticks at 30Hz and broadcasts snapshots
   (`src/sim/snapshot.ts`, golden-tested for determinism) + event streams. One instance
   per invite code; the code seeds the dungeon. `npm run server`; verified headless with
   two WebSocket clients sharing an instance (`test/server.test.ts`).
2. **Network client + party persistence.** Browser client that joins over WebSocket
   (lobby UI, `?join=CODE`), interpolated snapshots; then Postgres character store and
   drop-in/drop-out rejoin (seats already survive disconnects in-memory).
3. **Depth on the game.** Full itemization, classes/skills, boss on floor 18.
4. **DCC layer.** The System announcer, loot boxes, achievements, humor.
5. **Isometric/3D render.** Upgrade the view for the Diablo feel.
6. **Headless RL env.** Wrap the sim in a Gymnasium-style interface for agents.
