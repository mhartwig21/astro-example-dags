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
  phantom / charger / spitter / necromancer / broodmother): stats scale per floor and are
  modified per archetype (see `ARCHETYPES` in config); behavior branches in `ai.ts` (melee
  chase, ranged kite-and-shoot, bomber contact-fuse, shaman standoff-heal, phantom blink,
  charger locked-lane rush, spitter acid lobs that linger as ticking ground puddles,
  necromancer corpse-raising — deaths leave TTL-capped `GameState.corpses` it consumes —
  broodmother nest-births (a walking spawner that BIRTHS swarmers on a timer, lifetime-
  capped + population-guarded, so an ignored pack grows), and boss chase + radial volley).
  The spawn mix shifts toward tougher enemies with depth; specialists unlock by floor
  (bomber 2+, charger 3+, shaman 4+, spitter 5+/broodmother 5+, phantom 6+, necromancer 7+).
- **Depth tempo** (`monsterTempo` in config): past floor 4 monsters get QUICKER, not just
  fatter — move speed ramps to +35%, attack cooldowns shrink to −35%, telegraph windups
  shorten to −25% (capped so tells stay readable). Floors 1–3 keep the training pace.
- **Roaming / behavior variety** (`wander` in ai.ts): monsters aren't all statues waiting
  for aggro. Lone wanderers PATROL (always), ~40% of packs patrol their territory together,
  the rest are sentries holding their post; dormant ambushers lie perfectly still, the
  vault guardian never leaves its treasure, bosses hold their arena. Patrols stroll in
  short randomized legs at 0.55× speed, leashed ~7 tiles to their post so encounters stay
  roughly where the floor placed them — and the moment a player is in range, the kind's
  combat brain takes over. The dungeon reads alive; danger sometimes walks into YOU.
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

### 5.8 Genuine itemization (phases 1–3 SHIPPED, caster catalog included)

**Problem.** Every ability scales off ONE stat (`baseDamage`) at fixed coefficients, and a
weapon's noun is pure cosmetics — a Crossbow is a stat stick wearing a crossbow mesh. Items
can't push builds, and "magical attack" isn't a real concept the sim can price.

**Three moves, in dependency order:**

**(1) Damage schools.** Split the one damage stat into two:
- `attackPower` (physical) and `spellPower` (magic) on `Player`, both = intrinsic(level) +
  bonuses + equipment. `maxHp`/`speed`/`crit` stay shared (crit applies to both schools).
- The affix pool gains `spell`; `damage` becomes the physical stat. Item generation rolls
  the school that fits the item (see move 3) — finding a great caster weapon IS the nudge
  toward a caster build.
- **Every ability declares its scaling in the registry** (next to `ABILITY_INFO`, so a new
  ability declares its school the same place it declares everything else):
  `SCALING: Record<AbilityId, { ap: number; sp: number }>` — e.g. melee `{ap:1}`, orbit
  `{ap:0.5}`, nova `{sp:1.2}`, cataclysm `{sp:3}`, airstrike `{ap:2.5}` (sponsor ordnance is
  very physical), dash-shockstep `{sp:0.5}`. Hybrids are just both keys nonzero.
- Damage instances carry a `school` tag (extends the existing `HitEvent`/damage plumbing),
  which move (3)'s resistances and the juice layer (color-coded numbers) read.

**(2) Bolt becomes the weapon's projectile — the crossbow finally IS a crossbow.**
Bolt is the one ability whose school and feel come FROM the equipped weapon:
- **Ballistic** weapon (Crossbow): physical bolts off `attackPower`, +30% projectile speed,
  +1 pierce at rare+. **Arcane** weapon (Wand/Staff): magic missiles off `spellPower` (wand:
  −20% bolt cooldown; staff: +25% nova/AoE radius instead). **Melee** weapons: a thrown
  sidearm — weak default (0.5×AP), using the rig's `Throw` clip. The renderer already grafts
  real weapon models and has shoot/spellcast animations; this move makes mechanics match.

**(3) Weapon classes.** Noun → class, each with ONE mechanical hook (house capstone style —
a behavior, not a stat pile):

| Class | Nouns | Hook |
|---|---|---|
| Swift | Blade, Cleaver | melee cooldown −10% |
| Heavy | Maul, Axe | melee +30% damage, 2× poise damage, cooldown +15% |
| Reach | Spear | melee range +0.5 tiles |
| Ballistic | Crossbow | bolt profile above |
| Arcane | Wand, Staff | bolt/AoE profile above; weapon rolls `spell` affixes |
| ??? | Mug | all of the above, badly (the joke stays) |

Generation picks class with the slot, then rolls class-fitting affixes. The catalog carries a
CASTER branch (SHIPPED): Ozone Wand + Cursed Amplifier (basic `spell` components) build into
the Stormcall Staff (advanced), topped by the Sweeps Week Staff (legendary, `tempo` passive:
active cooldowns −15%) — SP builds shop like AP builds do. Magic hits also tint their damage
numbers arcane-purple, so a mixed build can SEE its schools mid-fight. Armor/trinkets stay
school-agnostic until proven boring.

**Planning-first itemization (SHIPPED).** Builds come from the STORE, not slot machines:
- **Chase uniques** — store-only legendaries you cannot loot (12 total), each warping one
  build around itself: *Perpetual Encore* (+1 orbit blade, 25% faster ticks), *Standing
  Ovation Crossbow* (bolts pierce +2), *Signature Choreography* (stance swap resets
  swing+bolt cooldowns — the swap IS the rotation), *Plot Armor* (once per floor a killing
  blow leaves you at 1 HP), plus the original signature set (Headliner/Blastplate/Ledger/
  Overtime/Sweeps Week). Every one sits atop a basic → advanced → legendary build path plus
  sponsor/material gates, so getting there is a run-long plan, not a lucky corpse.
- **Novel-mechanic uniques** — mechanics that exist NOWHERE else (no tree node, no drop
  affix; the item IS the mechanic): *Blood Subscription* (charm — lifesteal: heal 6% of
  damage dealt, per-hit cap), *Cancellation Axe* (heavy weapon — strikes execute non-elite
  monsters below 15% HP), *Live Feed* (trinket — crits arc 30% of the hit to the nearest
  other enemy as a magic-school echo, one bounce), *Backstage Pass* (armor — the dash
  phases through walls it can clear; locked doors refuse it, keys stay load-bearing),
  *Location Scout* (charm — the stairs are marked on the minimap from arrival, fog or
  no fog; a pure host-side read of the passive, the sim reveals nothing). Combat hooks
  live at the one damageMonster choke point, so they compose with schools/resists/caps
  for free.
- Reworks from play feedback (2026-07-05): *Landlord's Ledger* pays +6 gold per kill AND
  10% interest on banked gold every safe room (cap 120) — a greed engine, not a tip jar.
  *Signature Choreography* grants +20% crit during the post-swap surge window instead of
  resetting the (already short) attack cooldowns — swap, spike, swap, spike. All
  legendaries also carry meaningfully fatter stat lines now; they should read best-in-slot
  before the passive even triggers.
- **Drops tuned down** — rare/epic weights 11/3 → 8/2, item drop chance 0.45 → 0.36. A rare
  drop is a windfall now, not a strategy.
- **Component drops** — ~35% of equipment drops are catalog BASICS carrying their catalogId,
  so random loot advances the build you planned (they gate-check, price-credit, and combine
  like bought components).
- Higher shop tiers stock deeper per shop (advanced 4+/shop, legendary 2+), and the shop UI
  grew SELL ALL + hover stat tooltips so managing the plan is one screen.

**Counterplay (phase 3 — SHIPPED):** monster resist tags — `armored` (physical −30%) and
`warded` (magic −30%) — as elite affixes plus archetype defaults (charger is innately
armored, phantom innately warded; `monsterResist` in game.ts, `resistDamageTakenMult`).
The party's school MIX starts mattering per pack; a warded elite pack is the crossbow
crawler's fight. Resisted hits emit `HitEvent.resisted` — the 3D host renders them as
muted gray numbers with a ⛨ so the lesson is legible mid-fight.

**Interactions with existing systems:**
- **Battle Stance** stays about attack RANGE (Brawler/Deadeye); school is orthogonal — a
  Deadeye wand build is ranged-magic, and PERFECT FORM still reads range, not school.
- **Overcharge** multiplies whatever the spent attack's school computes — no change.
- **Balance bot / regression tests** exercise legacy intents and auto-equip; auto-equip's
  `itemScore` must learn schools (score an item BY the build's dominant school, so a caster
  doesn't auto-equip a maul).
- **Saves:** fold legacy `damage` affixes/`bonusDamage` into physical; `spellPower` starts at
  intrinsic. Same migration pattern as the loadout rework.

### 5.9 Damage rolls, armor & the Crawler Profile (SHIPPED)

**Damage rolls.** Every hit was already a ±15% roll (`rollDamage`); now the WEAPON sets the
player's dice (`CONFIG.weaponVariance`, read via `damageVariance`): swift ±10% (a metronome),
reach/ballistic ±15%, arcane ±20%, heavy ±30% (a gamble per swing), chaotic ±40% (the Mug is
a slot machine). Averages unchanged — variance is feel + itemization texture, not power.

**Armor.** The first defense stat. Armor-slot items lead with an `armor` affix (HP moved to
their extra pool; trinkets can roll it too). Mitigation = `armor/(armor+armorK)` capped at
`armorMaxReduction` (60 armor = 50%, hard cap 60%) — diminishing returns by construction.
All monster→player damage funnels through ONE choke point (`damagePlayerHit` in game.ts):
roll → mitigate → apply → hit event → low-HP hype; death lines stay with the caller. The
collapse timer bypasses it on purpose (the dungeon deals true damage). Phase-3 resistances
(5.8) slot naturally beside it as per-school branches.

**Crawler Profile (P).** The System's personnel file: a pure sim module
(`buildCharacterSheet` in `sheet.ts`) derives every number from the SAME param functions
combat calls — per-ability `[min–max]` roll bounds, crit range, cooldown, sustained-DPS
estimate, armor → reduction % → effective HP, plus a concrete "a floor-N hit: X raw → Y
taken" example. The host panel (`renderSheet`, `#sheet`) only formats: gear rows +
LoL-style attribute tiles (game-icons stats set) left; D4-style damage rows + defense meter
+ Show chips right. Estimates show BASE numbers; situational mults (stance, overcharge,
execute) are notes, so the ranges match an ordinary hit.

**Effort:** three sessions, shippable independently — (1) stats + scaling table + migration +
tests; (2) bolt-from-weapon + classes + generation + UI (item cards show class + school, stat
panel shows AP/SP); (3) resistances + catalog caster branch + balance pass.

### 5.10 Difficulty pass — scarcity, gift variety, density, ambushes (SHIPPED)

A maximalist full-clear run (all XP, all gold, always 3 sponsors) was trivializing the back
half: player power compounds ~quadratically while monster scaling was linear and count-capped
at floor 11, so a floor-18 crawler needed ~214 grunt hits to die. The measured leaks and
their fixes:

- **Consumable scarcity.** Plating kits (a permanent HP graft, ~80% of the maximalist HP pool)
  were unlimited per shop. All consumables now have a per-shop `stock` (`consumableStock` in
  catalog.ts; plating 2, rations 3, tome/favor 1), tracked in `SafeRoom.purchased`. Excess
  gold can no longer buy infinite EHP. Shop tiles show remaining stock (`×N`) and a sold-out
  state.
- **Sponsor gift variety + anti-concentration.** Picking +damage every floor was optimal and
  compounded. The permanent stat gifts (damage/maxHp/crit/armor) now DIMINISH against what
  you've already banked (`rewardDr` = k/(k+owned)), and the pool widened with build-variety
  gifts that never concentrate a stat: **armor**, **materials** (toward signature gear), and
  **favor** (an owed constellation draft). Gifts still feel important on a fresh axis; the
  tenth +damage is a rounding error.
- **Density + compounding scaling.** Base count 18→24, per-floor 4→6, cap 60→110, packs up to
  9 — the floors were "too empty." Past floor 6, monster HP and damage additionally compound
  (`monsterScaleCompound` 1.055/floor, ~1.85× by floor 18), so the deep dungeon steepens
  instead of flattening. Early floors (1–6, the playability net) are untouched.
- **Ambushes (deep-floor tactic).** From floor 8, a share of packs spawn **dormant** — inert
  and quiet in the fog until a player strays within `ambushTriggerRadius`, then the whole
  cluster springs at once (`springAmbush` in ai.ts) with a brief speed surge to close. Hitting
  a dormant monster springs it early. A pack you walk into the middle of is a very different
  threat from one you saw coming.
- **Balance bot asserts difficulty now.** Beyond "still playable," the suite now fails if the
  back half flattens: a fully-kitted bot must lose real HP on floor 12, floor 15 must spawn
  >80 monsters, and floor-16 stats must exceed the linear projection. Post-change, floor-18
  hits-to-die fell ~214→~52 and floor-clear DPS-time roughly doubled.

### 5.11 Co-op verbs — party pings + proximity revives (SHIPPED)

**Pings.** `G` (rebindable) marks the spot under the cursor: `GameState.pings`
(TTL 6s, 3 per player, oldest replaced), pure sim data that rides snapshots so
the whole party sees it. Hosts render an expanding gold pulse in the world and
on the minimap — pings pierce fog on purpose ("over THERE" must work unseen) —
and the audio director chimes once per fresh mark, panned toward it. Downed
players may ping (calling for help is content).

**Revives.** In a party, death is now DOWNED, not benched-until-descent: a
living crawler standing within `reviveRadius` of a downed one stabilizes them
by proximity — no button, the reviver pays in exposure, not APM
(`updateRevives` in game.ts). ~3.5s of continuous closeness revives at 35% max
HP (+hype for the medic: a save is great television); walking away decays the
progress 1.5× faster than it built. Hosts show a green ring tightening around
the body, a hollow red minimap ring saying "stand here", and a DOWNED line in
the HUD. Solo death and full wipes are unchanged, and the descend-revive at
50% remains the fallback.

### 5.12 Ringside Check-in + the Daily Crawl (SHIPPED)

**Entry menu.** `iso.html` opens on the RINGSIDE CHECK-IN (`#menu`, z 28): name
field (persisted, `dcc:name:v1`), CONTINUE RUN (when a mid-run save exists),
DAILY CRAWL, NEW RUN, PARTY CRAWL (rolls a readable 5-char code — the code IS
the seed, the URL is the invite), and TEST CHAMBER (builds the existing `?test`
deep link). `?join=` and `?test` URLs skip the menu — they already carry a
complete decision. While open the menu freezes the local sim (backdrop dungeon)
and owns the keyboard via `input.captureMode`. Nothing is saved until a mode is
picked, and R / NEW SEASON reruns **in the same mode** — a daily rerun replays
today's dungeon.

**The Daily Crawl.** One dungeon per UTC day, shared by every crawler:
`dailySeed(day)` (`src/sim/daily.ts`, pure djb2 over the date — client and
server derive identically). The run's mode + day persist in the save, so a
resumed daily still reports to the right board.

**Leaderboard.** The game server exposes `GET/POST /leaderboard`
(`src/server/leaderboard.ts`): hard shape validation, best-entry-per-name per
day (retrying all day is playing, not cheating), rank = full clears → depth →
speed → kills, 200 entries/day, 30 days kept, JSON-file persistence
(`LEADERBOARD_FILE`, default `leaderboard.json`; a redeploy resets it — the
Postgres upgrade rides with accounts). Solo daily runs submit fire-and-forget
on win/wipe; the menu shows today's top 10, the recap shows your rank. Trust
model: solo sims run client-side, so scores are self-reported bragging rights —
shape is validated, numbers are believed.

### 5.13 Status effects + the flask returns (SHIPPED)

A small, deterministic status layer for BOTH sides of the fight — exactly three
effects, each with one player source and one monster source, all ticked by `dt`
in `status.ts` (`Monster.statuses` / `Player.statuses`):

- **Burn** — fast magic DoT (0.5s ticks, 3s), refresh-on-reapply, no stacking.
  Source: the **Afterburn** nova node (nova ignites for 35%/rank of its hit).
- **Poison** — slow physical DoT (1s ticks, 5s), stacks to 3, each stack adds.
  Sources: **spitter acid** (every puddle tick also stacks poison, so lingering
  costs you after you step out) and the **Venom Clause** legendary charm
  (crits inject a stack — the only lootless poison source).
- **Chill** — no damage; the afflicted entity's combat clock runs at −30%:
  movement, windups, and cooldown recovery all stretch (the same per-entity
  time-scale trick bullet time uses). Sources: the **Frost Bolts** node and the
  new **chilling** elite affix (a cold aura that slows crawlers inside it).
  Bosses take half the slow — meaningful, never immune.

DoT ticks route back through the SAME choke points as every other hit
(`damageMonster` / `damagePlayerHit`), so schools, resists (a warded elite
shrugs 30% of a burn), armor, shielded, one-shot caps, kill credit, and hit
events compose for free. DoT never crits and never builds poise (a burn can't
stagger-lock a brute). `HitEvent.effect` tags DoT numbers so the 3D host tints
them (burn ember-orange, poison toxin-green), status pips render on the boss
bar + a debuff row under the player HP readout, and a faint colored ring hums
under statused monsters. Statuses reset every floor.

**The Sponsor Slurp™ flask is back on** (`flaskEnabled: true`, unchanged
tuning: 35% heal, 8 kills per charge, safe-room top-up) — aggression is the
sustain loop again, and it doubles as the answer to "I'm poisoned and low."

### 5.14 Band bosses + floor events (SHIPPED)

Every themed band now ENDS in a boss, and ordinary floors carry seeded events, so descent
reads as chapters instead of a corridor of identical floors.

- **A signature boss per band.** Every band-end floor (3, 6, 9, 12, 15) is a sealed arena
  (`bossFloorEvery` in config; floor.ts carves the oversized arena, the stairs stay sealed
  until the boss falls). Each boss keeps the shared melee+volley+phase script and layers
  exactly ONE band-themed signature (dispatch in ai.ts, helpers in game.ts; every one
  telegraphs — pools ARM, circles ring, channels can be staggered out):
  - **Floor 3, The Crypt Concierge (UNDERCROFT):** *Grave Rising* — an interruptible channel
    that raises fresh `GameState.corpses` as weakened adds (necromancer plumbing reused).
    Tier 0: no Ground Slam — deliberately the trainer boss (bot TTK ~20-35s at level ~6).
  - **Floor 6, The Sump King (SEWERS):** *Flood Surge* — sludge pools blanket a seeded half
    of the arena; they arm for 1.6s, then tick like acid until they drain (`Hazard.kind:
    "sludge"` with an `arm` telegraph window).
  - **Floor 9, The Topiary Warden (GARDEN):** *Entangling Roots* — root zones under each
    crawler that SNARE (`Player.rootT`, heavy slow, zero damage) anyone who stays; dash out.
  - **Floor 12, The Condemned Architect (RUINS):** *Collapsing Masonry* — telegraphed debris
    impact circles rain all fight (phase 0 onward), one targeting each crawler.
  - **Floor 15, The Furnace Marshal (IRONWORKS):** *Flame Sweep* — a wall of fire advances
    row by row toward the boss's target; each row erupts a beat after the last.
  - **Floor 18 (APPROACH):** unchanged tier-3 finale — Dark Ritual stays the crown.
  HP ladder per arena (`bandBossHp`): 1.5k / 5.4k / 10.5k / 18.4k / 27k — floors 6 and 12
  keep their pre-band pools, so the boss-difficulty contract bands held without retuning.
  The renderer keys boss models by floor (necromancer / black knight / plant warrior / frost
  golem / orc brute / demon lord — all cast reuses, no new assets). The balance bot dodges
  ground hazards now (swinging on the way out) and must clear floors 1–3 in the suite.
- **Floor events (floors 2+, never boss floors).** `maybeSpawnFloorEvent` rolls at most ONE
  seeded event per floor (~70% of eligible floors; `GameState.floorEvent`):
  - **System Shrine:** a touchable prop (loot kind `"shrine"`) offering a pick-1 bargain
    through the SAME `pendingRewards` plumbing as sponsor drafts (no new host UI): *Blood
    Price* (pay 20% max HP on the spot for +3% permanent crit), *Greed Clause* (this floor's
    monsters gain +15% speed, its gold drops pay double — `GameState.goldSurge`), or *Walk
    Away*.
  - **Timed vault:** the vault room is sealed at build (`sealRoomOnMap`, softlock-guarded);
    approaching springs it open for 45s of sprint-for-loot, then it seals forever. It never
    seals a crawler inside (holds until the room clears), and the floor KEY never opens the
    vault's own doors.
  - **Sponsor challenge:** entering the landmark hall arms a dare — clear its tracked pack
    without ANY crawler taking a hit — paying gold + hype on a clean clear, voiding on the
    first point of damage.

### 5.15 RIVALS — the competitive race (SHIPPED)

Up to **4 hostile crawlers**, one dungeon, one rule: **first killing blow on the final
boss wins.** Four sponsored rivals, one contract renewal — the Show format writes itself.

- **Concurrent floor worlds.** `GameState.mode: "rivals"` + `worlds: Record<floor,
  FloorWorld>`: every per-floor slot (map/monsters/loot/projectiles/hazards/timer/
  encounter/rng/…) lives in a world instance. `stepRivals` MOUNTS each active world into
  the classic GameState slots, runs the ordinary floor logic with exactly that floor's
  residents, and captures it back — the whole sim body is reused untouched, and co-op
  never allocates worlds. Worlds build lazily (deterministic per floorSeed) and are
  dropped once every rival is past them.
- **Individual descent.** Stairs open a PERSONAL safe room (`Player.safeRoom`) — the race
  keeps running while you shop, so shopping costs race time. READY drops you onto the
  next floor's world immediately; nobody waits for anybody. Ledger interest, sponsor
  drafts, and the full planning-first shop all work per player.
- **PvP.** Rivals sharing a floor are hittable at every player-damage choke point (melee
  arc, bolts — no piercing through people, AoE radials/segments, orbit blades) at
  `pvpDamageMult` (0.4×: builds are tuned vs telegraphed monsters, player attacks are
  instant). Kill XP is never split between rivals — the killer takes the whole bounty.
- **Death = 15 seconds, gear stays yours.** A downed rival auto-revives at the floor
  entry at 50% HP with brief grace (no spawn-camping the timer). Killing a rival pays a
  BIG XP bounty (`pkXpBase + pkXpPerLevel × victim level`) — dropping the race LEADER
  pays the most, a built-in rubber band. No item looting: no naked-respawn snowball.
- **Netcode.** Personal snapshots: each client receives THEIR floor's world mounted as a
  classic state (renderer/UI unchanged), their own shop as `state.safeRoom`, same-floor
  players only, plus `rivals[]` standings meta (name/floor/level/alive/downedT) for the
  race ticker. Announcements from every floor are shared — you hear the race's drama.
- **UI.** RIVALS button on the party menu (`?rivals=1&join=CODE`), standings chip,
  downed-countdown overlay, and a recap that ends in either CONTRACT SECURED or
  "{RIVAL} TOOK THE CONTRACT" with final standings.

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
