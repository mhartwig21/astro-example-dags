# Bosses V2 — variety across runs, and the encounter as an event

Encounter-design round for boss fights (audited against `main@334cc32`).
Companion to MOB-CONCEPTS.md (which closed the *roster* problem) and
ITEMIZATION-V2.md (which closed the *payoff* problem). This doc closes the two
that are left: **the same boss appears every run**, and **a boss fight plays
like a big trash mob with a name plate.**

The brief, from the owner: far more NAMED bosses with real variety, and every
boss encounter should feel ELEVATED. The game is built for SHORT SESSIONS
PLAYED OVER AND OVER — so **the same boss appearing every run is the enemy.
Variety across runs is the design problem, not just count.**

Benchmarks: **Diablo** (spectacle, phases, arena hazards, loot payoff) and
**Hades** (encounter readability, personality, and the way repeated runs stay
fresh through variation and voice).

House rule that outranks everything below — **DUNGEON CRAWLER FIRST**: the
System may announce and hype a boss; the fight itself is never a gameshow
minigame. Every mechanic here is an ARPG mechanic wearing civic satire.

Delete sections from this doc as they ship (BACKLOG.md convention).

---

## 1. AUDIT — SHIPPED, and answered

*(Deleted per the BACKLOG convention. The audit's findings are now code and
tests. Kept here only as the scoreboard, because the numbers are the argument.)*

| The audit measured | Now |
|---|---|
| 6 boss names, fixed to their floors; **variety across runs literally zero** | **18 named bosses, three per band, DRAWN per run** (`src/sim/bosses.ts`) — 3^6 = 729 lineups before mutators and arenas |
| The finale is called "THE BOSS" | Three named finales: The Showrunner, The Standards and Practices Board, The Sponsor |
| One `m.kind === "boss"` brain, ~150 lines | A shared **chassis + per-boss override** (`stepBoss` / `BOSS_KITS` in `ai.ts`) |
| The Crypt Concierge: 62 melee windups and **zero** of anything else in 90s | It RINGS FOR SERVICE with no corpse in reach; the staff are tethered and feed it. Covered by a test that would have caught the original |
| No boss has a punish window | Every boss does (V4). Asserted for all 18 in `bosses.test.ts` |
| No breakable plates / weak points | V1, incl. the Permit Office's four school-immune stamps |
| Arena `breakables` measured 0, 0, 0 ... 3 | Three seeded arena layouts with destructible cover, chokepoints and interactive props |
| Nothing bounds fight length | Hard enrage (V5), deadline ~2x the target |
| Phase edges are a line of text | Every edge is an **intermission** that re-deals the board (V6) |

Two things the audit said to KEEP were kept verbatim: the `arm` telegraph
primitive (every new mechanic uses it) and `bossHitCapFraction: 0.1`.
---

## 2. THE BOSS GRAMMAR — the vocabulary a fight is built from

Before adding names, define what a fight is made OF. Every boss in section 3
is assembled from this vocabulary, and nothing in section 3 uses a mechanic
not defined here. This is the anti-reskin rule: **a new boss must differ in
its ASK, and the ask is expressed in this grammar.**

### 2.1 The six asks

Every fight is primarily ONE of these. A boss that asks two is two bosses; a
boss whose ask you cannot name in four words is a big monster with more HP.

| Ask | The player's verb | Fails when |
|---|---|---|
| **Dodge-the-lane** | read a locked line, step perpendicular | lanes are so wide it is a slow zone |
| **Break-the-shield** | burst a targetable thing on a timer | the shield is just extra HP |
| **Kill-the-adds** | retarget under pressure, kill order | adds are optional chaff |
| **Use-the-arena** | move the fight to good ground | the arena is a featureless square |
| **Burst-the-window** | recognize and unload in a punish beat | the window is too small to matter |
| **Survive-the-storm** | sustain and reposition through a phase | it is unavoidable chip damage |

### 2.2 Phases and what triggers them

Today: HP gates only (2/3, 1/3). The grammar needs four trigger types, all
deterministic:

- **HP gate** — keep. Cheap, readable, already plumbed.
- **Mechanic completion** — the shield broke; the last pylon fell; the lockbox
  opened. *This is the one that makes a fight feel authored*, because the
  player caused it.
- **Timer** — the fight escalates on the clock (pairs with soft enrage).
- **Positional** — the boss reaches a spot, or the arena state changes.

**Rule:** at least one phase per fight must be *mechanic-completion*
triggered, so the player's play — not their damage — advances the story.

### 2.3 Telegraph language (four shapes, all already shipped)

| Shape | Primitive | Reads in | Existing users |
|---|---|---|---|
| **Ground decal** | `Hazard` with `arm` (armed, harmless, then live) | 0.2s | flood pools, roots |
| **Lane** | `Hazard.kind: "beam"` (`pos` to `end`), or locked `chargeDir` | 0.15s | sniper, charger, lasher, colossus fissure |
| **Channel** | `beginWindup` + rooted + interruptible by poise stagger | 0.3s | ritual, grave rising, archivist sweep |
| **Arena-wide** | announcement + multi-hazard schedule | 0.5s+ | flood surge, flame sweep, debris rain |

**Hard rule (unchanged): every telegraph must read in 0.2s.** New mechanics
compose these four; they do not invent a fifth shape. FX must use the existing
shader vocabulary (`fx.ts` / `fxParticles.ts` / `fxTrails.ts`) at the
established AAA bar — **never a recolored nova.**

### 2.4 Counterplay windows

Six exist; the sixth is the one bosses are missing.

1. **Dash i-frames** (`dashTime`) — beats any single hit
2. **Sidestep** — beats lanes
3. **Interrupt** (poise stagger vs a channel) — beats channels
4. **Out-range** — beats standoffs, soft-countered by the anti-kite ramp
5. **Kill-the-friend** — beats supported bosses
6. **PUNISH WINDOW** — *missing on every boss.* A boss over-commits, becomes
   briefly helpless (`m.stagger`, exactly like the slagbreaker's vent), and the
   player unloads. **Every V2 boss must have one.** This is what makes a fight
   a rhythm you learn instead of a wall you erode.

### 2.5 Add waves — adds need a JOB

Current adds are 1-XP chaff spawned in a ring. Grammar for V2 adds — a wave
must do exactly one of:

- **carry** something (a plate, a key, the boss's shield anchor)
- **feed** the boss (heals it, extends its shield) — kill them or the fight stalls
- **deny** ground (they hold a zone the player wants)
- **punish** a stance (they arrive where the player has been parked)

An add wave that does none of these is decoration and should be cut, not
spawned. Waves stay near-worthless in XP (the boss is the payday).

### 2.6 Arena interaction

The most under-used seam in the codebase. Three primitives, two of which
already exist:

- **Hazards** — `state.hazards` already supports armed/lingering/lane zones.
  Arena-owned hazards (not boss-cast) come from `arenaDirector`, which is
  already shipped for floors 6/9/15 and simply needs arena-authored content.
- **Cover / destructibles** — `state.breakables` with `footprint` already block
  movement, and `SMASH_KINDS` (which includes `"boss"`) already lets a boss
  *destroy* them. **This is a complete, shipped, unused mechanic:** put pillars
  in the arena and the boss demolishes your cover over the fight, with zero new
  sim verbs.
- **Interactive props** — NEW: a breakable that *does* something when broken (a
  floodgate that drains the pools, a vent that staggers the boss).

### 2.7 Soft and hard enrage

- **Soft enrage — SHIPPED.** The anti-kite chase ramp (`bossChaseRampDelay`
  3.5s to `bossChaseRampCap` 1.65x) already punishes infinite kiting, and it
  even has a voice line. Keep as-is.
- **Hard enrage — MISSING.** Nothing bounds fight length. A short-session game
  needs a ceiling: past a per-band deadline the boss gains a stacking damage
  multiplier and the arena starts closing. It should read as the System losing
  patience with the broadcast slot, not as a fail-state.

### 2.8 The payoff beat

Already the strongest part of the encounter and mostly needs *staging*, not
mechanics: `boss_sigil` material, `dropBossBonus(2)`, a guaranteed glyph, a 35%
band unique with a TITLE BELT announcement, hype, and the seal opening. V2 adds
only: a kill-moment camera beat and loot that lands *ringside* rather than
under the corpse (section 5.7).

### 2.9 Sim verbs: what exists vs what is needed

MOB-CONCEPTS.md names knockback / beams / auras as the missing verbs.
**Checked against the code: all three shipped.** The real gaps are different.

**Already implemented (reuse, do not rebuild):**

| Verb | Seam |
|---|---|
| Knockback + uncapped PULL | `applyPlayerKnockback` (game.ts); lasher hook is the pull variant |
| Beams — static, sweeping, lock-on | `Hazard.kind: "beam"` with `arm` / `sweep` / `trackId` / `srcId` |
| Auras | `Monster.aura: "frenzy"` or `"shield"`, radiated in ai.ts |
| Armed ground zones | `Hazard.arm` (+ kinds `sludge`/`roots`/`shards`/`consecrate`/`puddle`) |
| Second stage / morph | `"morph"` windup swaps kind+stats; renderer rebuilds the mesh |
| Synced squad windups | `Monster.squadId`, leader-cadenced |
| Riposte stance | `riposteT`, melee-only reflection |
| Directional guard | shieldbearer frontal arc in `damageMonster` |
| Self-stagger punish | `m.stagger` (slagbreaker vent) — exists, unused by bosses |
| Corpse economy | `state.corpses`, raise/deny |
| Poise / stagger / grace | `poiseDmg`, `staggerGraceT`, `bossStaggerGrace` |
| Arena director | `arenaDirector` (floors 6/9/15) |

**Needed for V2 (the real new-verb list):**

| # | Verb | What it is | Seam | Unlocks |
|---|---|---|---|---|
| V1 | **Breakable plate / weak point** | a targetable sub-object on a boss with its own HP; breaking it triggers a phase | `Monster.plates` + a branch in `damageMonster` | break-the-shield asks; Permit Office, Topiary Warden, Rent Collector |
| V2 | **Boss shield pool** | absorb-HP that regenerates unless a condition is met | `Monster.shieldHp` (distinct from the `shieldT` aura flag) | Topiary Warden, The Sponsor |
| V3 | **Interactive prop** | a `Breakable` that fires an effect on destruction | `Breakable.onBreak` (drain / vent / collapse) | use-the-arena asks; floodgates, conveyors |
| V4 | **Boss punish window** | commit, over-extend, self-stagger, on a readable count | reuse `m.stagger` + a heat counter (`m.heat`, already on slagbreaker) | every V2 boss |
| V5 | **Hard enrage** | deadline, then stacking damage + arena closes | `state.bossFightT` + config per band | fight-length ceiling |
| V6 | **Intermission / invuln beat** | boss briefly untargetable while the arena re-deals | `Monster.invulnT` + hazard clear | phase spectacle ("The Commercial Break") |
| V7 | **Boss displacement** | knock the BOSS, not just the player | generalize `applyPlayerKnockback` over an entity | arena-hazard synergy, player agency |
| V8 | **Add tether** | an add linked to the boss (feeds/shields it) until killed | `Monster.tetherId` (the `linked` affix is 80% of this) | adds-with-a-job |
| V9 | **Seeded boss selection** | pick a boss identity per band from the run seed | `pickBandBoss(seed, band)` | **the entire section 4** |
| V10 | **Boss mutators** | affix-style layers that change the ASK | `Monster.bossMutator` | **the entire section 4** |

V9 and V10 are the two that actually solve the owner's stated problem. V1-V8
are what make the roster in section 3 differ by more than a hazard color.

Every one of these is deterministic, host-agnostic, and unit-testable —
feedback flows out as data like everything else in `src/sim/`.

---

## 3. THE ROSTER — SHIPPED

*(Deleted per the BACKLOG convention: all 18 entries live in `BOSS_POOL`
(`src/sim/bosses.ts`) with their epithet, ask, legal arenas and System line as
DATA, and their verbs as one short block each in `BOSS_KITS` (`src/sim/ai.ts`).
The doc is no longer the source of truth for the roster; the table is.)*

The ask distribution the doc committed to, as it shipped:

| Ask | Bosses |
|---|---|
| Dodge-the-lane | Sanitation Inspector, The Foundation |
| Break-the-shield | Topiary Warden, Permit Office, The Sponsor |
| Kill-the-adds | Crypt Concierge, Grease Trap, Zoning Board, Line Supervisor, Standards Board |
| Use-the-arena | Sump King, Condemned Architect, The Showrunner |
| Burst-the-window | Rent Collector, The Temp, Furnace Marshal |
| Survive-the-storm | The Pollinator, Safety Officer |

`bosses.test.ts` pins the shape: 18 entries, three per band, at least three
different asks per band (the UNDERCROFT is the deliberate exception — it is
the teaching band, and two of its three candidates both teach "recognise the
window and unload").

**Two deviations from the doc, both deliberate and both documented in code:**

1. **The council format shipped WITHOUT a new spawn shape.** §7.2 filed the
   Zoning Board under LATER because "three elites on one health plate" needs a
   different spawner. It did not: the Board is one body plus three TETHERED
   aides that shield it, and each aide's death hands its verb to the body — so
   killing the wrong one first genuinely makes the fight worse. Same ask, same
   kill-order lesson, zero new spawn plumbing.
2. **The Sponsor is a SCHOOL lock, not an ability suspension.** §7.2 called
   ability-suspension the riskiest idea against the dungeon-crawler-first rule
   and said to cut it freely. It is cut. Brand Integration is a shield pool
   that only one damage school erodes, and the school flips every phase —
   Diablo's "immune to X" wearing a sponsorship joke, which is exactly the
   dungeon-crawler check §3.6 asked it to pass.
---

## 4. VARIETY ACROSS RUNS — SHIPPED (this was the owner's actual ask)

*(Deleted per the BACKLOG convention. All four layers are live and tested.)*

- **Layer 1 — seeded selection (V9).** `pickBandBoss(seed, band, prevId)`, from
  a dedicated FNV+avalanche hash of `(runSeed, band, salt)` — never
  `state.rng`. `bosses.test.ts` asserts the draw consumes no RNG *and* that
  `bosses.ts` cannot even import it. The anti-repeat rule is in: a band slot
  will not serve the same boss two runs running when the pool allows.
- **Layer 2 — mutators (V10).** Eight, each one sentence of counterplay, each
  changing what the player DOES. Gating shipped as specified: **none on floor
  3**, one from 6-12, up to two from 15 — never two that both add bodies, and
  never one the boss cannot carry (`retrofit` needs a signature,
  `understudied` needs armour).
- **Layer 3 — arena variants.** PILLARED / OPEN / SPLIT, drawn from the boss's
  LEGAL set, built entirely out of shipped `breakables` + the new `onBreak`
  hook. The Sanitation Inspector never draws pillars; the Grease Trap never
  draws open; the Architect only ever draws pillared, because it eats them.
- **Layer 4 — escalation on repeat.** `SavedProgress.bosses.defeats` (see
  PERSISTENCE.md). 2nd+ meeting opens at the phase-2 kit with a shortened
  intro; 5th+ adds a free mutator. Mechanics only — a rematch has identical
  HP and damage, asserted.

**Running total per band slot: 3 bosses x 8 mutators x ~2 legal arenas ≈ 48
distinct encounters, from 1.**

The one open item from this section is the SAVE WRITE: the sim reads
`save.bosses` and maintains `state.bossLineup` / `state.bossDefeats`, but the
host still has to persist them at its checkpoint (PERSISTENCE.md names the
seam). Until it does, anti-repeat and escalation are inert — everything else
in this section works from the seed alone.
---

## 5. ELEVATION — SHIPPED (presentation round)

*(Deleted per the BACKLOG convention. Every beat below is live in
`src/render3d/bossFx.ts` + `renderer3d.ts` + `main3d.ts` + `iso.html` +
`audio/director.ts`, driven entirely by the §7.4 event vocabulary — the
presentation layer added no sim state and reads no sim internals.)*

| §5 asked for | Where it lives now |
|---|---|
| 5.1 The approach: ambient DUCKS to a drone before the arena | `AudioDirector` — a boss that exists, is un-introduced and within 34 tiles ducks the music bus to 0.22 (`AudioSink.duck`) and releases it at the reveal |
| 5.2 The reveal is its own beat, before the freeze | `BossFx.intro` — arena lift light, mote column, and the contracting arena ring (the seal closing) fire on the `intro` event; the card animates on top |
| 5.3 The name card: title, epithet, ASK, mutator tags, System line | `#bossintro` rebuilt in `iso.html` + `updateBossBar` — the ASK plate is tinted by its hue family, mutator tags carry their counterplay sentence as a tooltip, and the kicker reads "WE HAVE MET N TIMES" on a rematch |
| 5.3 Camera orbit ending on the silhouette | `BossFx.orbit` — the anchor slides toward the boss and the fixed iso yaw offsets; **the reveal pushes IN (zoom 0.78), it does not pull back** — the pull-back is the approach's beat, and doing it during the card shrank the star of the introduction to a thumbnail |
| 5.4 Phase stinger, low-HP layer, per-boss telegraph SOUND | `BEAT_SOUNDS` in `director.ts`; the low-HP layer swaps any boss to the colossal bed on its final phase; every named signature pitches the shared `tell` clip by its own `rate` (`BOSS_SIGNATURES`) — 18 distinguishable tells out of one file |
| 5.5 Pull back one step per phase; snap in on the intermission; slow-mo | `BossFx.zoom` (eased, capped 1.3) + `slowmo`, which the host folds into the existing `hitStop` so it composes with combat feel instead of fighting it |
| 5.6 Intermission spectacle: the board is visibly RE-DEALT | The `intermission` beat runs the arena shader OUTWARD as a sweep, the plate greys out (`#bossbar.intermission`) and the boss reads as lifted out of the fight |
| 5.7 Kill moment + ringside loot payoff | `BossFx.defeat` (slow-mo, push-in, twin sweeps, the arena keeps the mark) and `stageBossPayoff` in `main3d.ts`, which throws a rarity-coloured arc from the corpse to every fresh drop and lights where it lands |
| Plates / shields / tethers / enrage as things in the WORLD | `BossFx.update` reconciles a plate panel per weak point, a hex-lattice shield shell that dies bottom-up as the pool drains, a cord per tethered add with pulses travelling ADD → BOSS, and enrage embers |
| The plate answers "what is different THIS run?" | `#bossbar` gained a mutator row, a shield rail with the SCHOOL LOCK tag, a plate-chip row (broken chips stay, struck through) and a live beat line; pips now mirror the real `maxPhase` |

**The readability contract this round committed to, in code:** no beat is a
recolored nova. The shield is a fresnel shell that CRACKS, the tether is a cord
whose pulses TRAVEL, the punish beacon is a column that converges DOWNWARD, and
the arena warning is the only ring in the game that CONTRACTS. Hue comes second
and follows the fight's ASK (`ASK_PAL`), so the player learns the verb before
the name.

**Two things the capture round caught that the design did not:**

1. **Exposure is a readability problem, not a taste problem.** At the first
   tuning the punish beacon and the intermission sweep were additive, arena
   sized, and stacked with the ritual circle the boss already stands on — the
   frame went to white and the beat became invisible *because* it was bright.
   Every boss FX now has a stated brightness budget, and the read comes from
   shape.
2. **The punish beacon's drain was inverted**, so it vanished at exactly the
   instant the window opened — the one frame it exists to sell. Fixed and
   commented; §7.4 is right that this is the beat that most needs to read.

**Still open (presentation):** the 2D host (`src/render/renderer.ts`) has no
dispatch for `"spore"` or for the boss rigs, so it falls back to its existing
zone drawing. 3D is the shipping host; the 2D one is a debug view.

### 5.9 ACCEPTANCE ROUND 2 — what the capture review caught, and the answers

The first capture round shipped shots that flattered the code. An acceptance
review of those shots found five blockers and five majors. Every one of them
was a real defect, and every one is closed below. They are worth keeping in the
doc because four of them are the same lesson: **a system can be correct and
still be unreadable, and only a capture tells you which.**

| Finding | The defect | The answer |
|---|---|---|
| The boss sat BEHIND its own health plate in all fourteen fight shots | The plate owns the top of the screen and the boss stands UP-SCREEN of the crawler. Nobody had ever framed the two together. | `BossFx.frameBias` / `frameDrop` (§5.5's camera seam): the anchor slides half-way to the boss AND is pushed along screen-up, so the fight lands mid-frame. Applied by the renderer, which owns `camDir`. |
| Fights differed by HUE, not SHAPE | Seven signatures across five ASKS all resolved to a concentric ring plus white radial spokes. | Each ask owns a silhouette that survives being reduced to a black-and-white mask: `lanes` (chevroned rectangles), `cords` (converging, pulses inward), `shell` (a cracking dome), `props` (geometry clamped on the arena's own objects), `cells` (safe squares lighting in sequence), `set` (flats sliding in from the wings). The radial-spoke ring is now reserved to ONE signature. |
| The finales were not three fights | `standards` was an ALIAS onto the floor-9 Zoning Board's kit object, and the Showrunner and the Sponsor shared a disc. | `standards` has its own kit (MOTION CARRIED: every living aide is the muzzle of a lane that fires through the body it protects) and the Showrunner owns the `set` silhouette. `RITUAL_LABEL` also gives every channeling boss its own name for the shared channel, so DARK RITUAL stopped being three finales' signature. |
| Two headline bosses had no kit at all | The Permit Office's four stamps were sub-HP bars; the Sump King's authored `prop: "drain"` never fired. | STOP-WORK ORDER (one locked lane per unbroken stamp, so breaking a stamp deletes a lane) and SLUICE GATE (the surge vents FROM the standing floodgates, anchored on the prop). Both covered in `bosses.test.ts`. |
| The punish window did not read | The beat §7.4 calls the most important in the fight was a dim grey line INSIDE the boss panel, clipped by the panel's own edge, over a starburst identical to every routine telegraph. | A dedicated CALL-OUT layer (`#bosscall`) outside every panel at announcement contrast, plus a ground RETICLE (four corner brackets closing on the core) that nothing else in the game draws. |
| A phase transition read as a DEATH | `filter: brightness(0.55)` on the intermission plate pushed the fill down to the track's own value: a boss at 70% looked like a boss at zero. | The fill holds its real value and goes COLD (steel, hatched), and the intermission line was promoted to the call-out layer. |
| Exposure blew out at the finale | §5's per-beat brightness budgets could not see the case that actually broke: two or three beats OVERLAPPING inside half a second. | A shared governor in `BossFx`: every beat declares a cost, the load decays over about a second, and bloom kicks and light peaks are scaled while it is high. Shapes are never scaled — the read is geometry. |
| "OPEN" arenas were featureless squares | The floor-3 Rent Collector — the first boss most players ever meet — was beige floor and one ring, the exact failure condition §2.1 names. | OPEN keeps its clear middle (the lane bosses depend on it) and gains a sparse smashable RIM. |
| Interactive props rendered as NOTHING | `drain` / `vent` / `shutdown` are gameplay keys, not asset keys, so `modelInstance` returned null for every one of them. | `BREAKABLE_MODEL` aliases them onto the KayKit pool, and live props tick a light and embers in their counterplay's hue. |
| The plate titled itself THE ENTOURAGE mid-boss-fight | The plate picked the NEAREST elite-or-boss, and the ENTOURAGED mutator's escort walked a step closer than the boss. | A boss always outranks an elite for the marquee. |

**And the finding that changed the harness rather than the game:** the kill beat
was staged by pushing a synthetic `BossEvent`, so the shot proved the FX layer
renders when poked. `tools/bossshot.mjs` now fights: it walks the crawler in
until the sim raises its own encounter, then drives real intents until the sim
emits each beat by itself, and kills the boss for the kill shot. Nothing in a
capture is invented any more — the health plate tells the fight's arc because
the health is real.

### 5.10 ACCEPTANCE ROUND 4 — the blockers round 3 left standing

Round 3 closed the name card (18/18) and the HUD call-out and left four
blockers alive. Every one of them was real, and three of the four were the same
mistake: **an ask that the signature table promised and the renderer never
built.**

| Finding | The defect | The answer |
|---|---|---|
| The `column` beat blew the whole frame to gold on floors 3 and 6 | `case "column"` was the one ask silhouette with NO geometry: gatherBurst + a 20-mote column + ten radial streaks + an **un-governed** light of peak 9, every layer additive and every layer in `ASK_PAL.window`. LATE FEE and the Grease Trap — the first two bosses anyone meets — rendered as a flat gold wash with the boss a pale ghost inside it. | The WINDOW ask owns a **shaft**: the crossed punish column stands up over the first third of the beat, then drains from the top down while the reticle closes on the spot. The streaks are deleted, the light is halved and governed, and the read is geometry. Verified: `tools/_r4d/rentcollector-3fight.png`, probe `shapes:{column:2}`. |
| `burrow` was the shared arena ring, and so was every boss's punish tell | `case "burrow"` called `arenaBeat` — the same contracting ring as the arena warning, the approach seal AND (through `OVER-COMMIT`, which all eighteen bosses fire) the punish telegraph. Four sentences, one shape. `signatureFor` also fell back to `shape:"ring"`, so any unlisted label quietly borrowed the one shape §5.9 reserved. | `burrow` owns a five-vaned **pinwheel** sweeping into a mouth that contracts — the only curved geometry in the game. `OVER-COMMIT` moved to the window's own shaft, so the punish tell and the punish window speak one sentence a beat apart. The fallback resolves through `FAMILY_SHAPE`, and "ring" appears nowhere in it. |
| The payoff never landed ringside | §5.7/§2.8 promise loot "ringside rather than under the corpse". `dropBossBonus` dropped every item at pos ± 0.6 tiles, so `stageBossPayoff` threw its rarity arc from the corpse to a point half a tile away, and `lootArc` was 21 sparks and one one-frame light — nothing persistent. Two capture runs counted two loot glows against a fifty-item drop. | Where loot lands is a RULE, so it moved in the SIM: `ringsidePos` throws the sigil, the glyph, the title belt and the bonus roll onto a `CONFIG.bossLootRing` ring, spread by index, pulled back only if the ring point is not walkable. The arc is sampled by distance and lands on a four-second **beacon**. Verified: `tools/_r4d/rentcollector-6kill.png` — six ringside beacons in frame, probe `shapes.loot:8`. |
| 340 mojibake em-dashes in `ai.ts` and `config.ts` | Every em-dash in those two files was stored as the mis-decoded bytes `â€”` (171 + 169; zero clean em-dashes in `ai.ts`). Thirteen were player-facing System lines and two were legible in capture. A boss round whose premise is the System's voice cannot ship with the voice broken. | Both files re-decoded (latin1→utf8 over the mojibake runs only); `§`, `°`, `±` and `™` came back with them. Strings are part of the rules projection, so the era stamp moved. |
| The exposure governor was floor-biased, not beat-biased | Measured on the real clock with a driven fight: floor 9 ran a median `exposureScale` of 0.61 against floor 3's 1.00, driven entirely by the luma term against a 0.45 knee. Identical beats rendered at ~60% brightness in THE GARDEN for a reason that had nothing to do with the beat, and the punish rig paid it with no floor. | The knee moved to 0.62, the coefficients came down, saturation is charged only above a deadband, the `measSat > 0.22` hard clamp is gone, and the scale has a floor of 0.45 — below that the beat stops existing, which is the failure the governor exists to prevent, arriving from the other side. The punish reticle and shaft have their own higher floor: the one beat that must survive a bright frame cannot be the beat dimmed by how bright the frame is. |
| The card's rows were still on the wall clock | r3 moved the card's OVERALL opacity to `encounter.timeLeft` and left the six ROW entrances as CSS animation-delays finishing at 1.22s — longer than a rematch freeze (2.2 × 0.55 = 1.21s) even exists for. The System line was missing from five of six intro captures whose shutter opened inside a second. | Every row's opacity is a custom property the host writes as a FRACTION of the freeze, so the card is fully assembled by ~52% of whatever length this intro is. Verified: `tools/_r4d/topiary-2intro.png`, all six rows present. |
| The mutator chips were the lowest-contrast element on the highest-stakes screen | `#ffc79a` at 12px next to a 46px gold title. §5.3 makes this row the answer to "why is THIS run different?" and it was the row least likely to be read. | Ember face on a near-black plate at the affix plaque's weight, pinned by a lit diamond. |
| The harness shipped frames that did not contain their beat | `guard()` read `state.status`, which `bf.tick` force-writes back to "playing" every step — so the sim looked alive while every frame was THE VERDICT. Separately, `hold()` had no inverse: `release()` cleared the host flag and left every renderer rig pinned at 600s, so stale seals stood in later frames. And three bosses died during the phase hunt, filing nine corpses as live beats. | `guard()` measures the SCREEN (any named overlay covering a quarter of the viewport, plus `elementFromPoint` at the centre) and takes a `bossAlive` assertion the fight/phase/punish beats pass; the kill shot refuses unless the boss really reached zero. `BossFx.release()` hands back every borrowed lifetime. `bf.until` takes a `floorHp` that lets every phase gate land while making it impossible for the boss to die inside a hunt. The probe now reports `shapes` — what is actually drawing, by silhouette, this frame. |

**Still open after this round** (honest list, not a plan): `linesupervisor`,
`safetyofficer` and `sponsor` still report `fight=OVER-COMMIT`, because
`stepBoss` checks the punish window BEFORE the boss's own kit and returns early
— that is a sim-ordering question with balance consequences, not a
presentation one, and it is not fixed here. Per-archetype telegraph
differentiation (every slam from every archetype is still one red disc) and the
melee swing arc's placement are likewise untouched.

### 5.11 ACCEPTANCE ROUND 5 — the round that stopped treating it as a paint job

Round 4 closed two ask silhouettes and landed the loot ringside, and scored
5.8 / 5.5 across two capture reviews against an 8.5 bar. The review that
followed was 33 findings deep and the shape of it is the finding: **eleven of
the twelve blockers were not presentation defects.** They were a boss body
keyed to the FLOOR, two variety layers that no host ever wrote to disk, a
mutator with no counterplay on the boss that draws it, and a punish window that
arrived on a metronome. The round before had been polishing a system that was
not yet doing what the doc says it does.

| Finding | The defect | The answer |
|---|---|---|
| **The boss body was keyed to the FLOOR, not the boss** | `renderer3d` resolved `monster_boss_${floor}` and `assets.ts` defined six entries, so eighteen named bosses rendered as six models. On floor 3 the Concierge, the Rent Collector and The Temp were the same necromancer mesh differing only by name plate and rim hue — every layer of the seeded-variety system was invisible, because the thing the eye locks onto was band-fixed. | One `monster_bossid_*` row per roster id, eighteen distinct files, all already in the shipped KayKit collection. Where a body is shared with a trash kind it is deliberately not that band's trash. |
| **Nothing wrote `SavedProgress.bosses`** | `grep -rn '\.bosses\s*=' src/` returned zero hits. The sim READ `save.bosses` and MAINTAINED `state.bossLineup` / `state.bossDefeats`; no host persisted either, so Layer 1's anti-repeat rule and Layer 4's escalation were inert. With a fresh seed per run the draw is uniform 1-in-3: a player replaying floor 3 saw the same boss back-to-back one run in three. | A browser-level ledger (`persist/save.ts`, the same pattern the first-contact tips already use, because the run save dies with the run), seeded into every new run before its first boss floor and merged back on every checkpoint. The run save round-trips the draw's INPUTS so a resume rebuilds the same floor. |
| **`sponsored` was legal on the STATIONARY Grease Trap** | Its counterplay sentence is "a hazard-immune bubble it must be pulled out of. Move the fight" — and `def.stationary` sets `speed = 0`, so the bubble was permanent damage reduction with no answer. Measured over 60s of fixed 200 dps: 98% HP remaining and 1,231 damage landed, against 34% and 4,151 clean. | `legal: (def) => !def.stationary`. A mutator whose only verb the boss cannot offer is a stat line, and stat-line mutators are banned by the table's own rule. |
| **The punish window was a metronome** | One shared `m.heat` that every slam, ritual and hazard tick incremented, one threshold, one label (OVER-COMMIT), on all eighteen bosses. The Pollinator opened 21 windows in 75s and spent 44.7 of them staggered. Nothing to learn: the window was not caused by a read the player made. | Three changes. The chassis feeds the count NOTHING (only the boss's own verbs do). **The read pays**: a telegraphed heavy that catches nobody advances the count in full. And every boss owns its own WORD, its own core name and its own count (`BOSS_PUNISH`), with `bossPunishRecovery` as a floor on how often a window may come round at all. |
| **The window had no world read and overlapped lethal ground** | The frame said UNLOAD / EXPOSED CORE over a ten-tile wall of live fire. The game was telling the player "stand here and commit" and "this floor kills you" in the same breath, and the second sentence was the true one. | `punishQuietT`: for the window's duration the boss lays no ground, fires no volley, and the ARENA DIRECTOR holds its breath — and opening the window sweeps the boss's own standing hazards off the arena. Player-owned zones are untouched: they are the DPS this beat exists to spend. |
| **Three bosses committed no verb of their own** | Census over 75s: Zoning Board 0% identity share (its only named beat was a renamed borrowed band hazard), Sponsor 3%, Showrunner 7%. All three kits were one-shot phase triggers returning false every other step, so the shared chassis ran the whole fight — including both finales. | SETBACK REQUIRED (every seated member condemns the ground around its own chair, so the kill order is a route), CAMERA MOVE (only the wedge the Showrunner is shooting is safe ground — the one beat whose read is the SAFE ground), and BRAND ACTIVATION + CROSS-PROMOTION (tethered placements that pump the pool, and two branded lanes on a clock). |
| **The arena director fired the band signature at all three of a band's bosses** | Whichever boss floor 9 drew, the garden regrew roots; whichever floor 15 drew, the wall vented flame. A Safety Officer with no `signature` at all spent its punish frame inside a flamewall indistinguishable from the Furnace Marshal's own. | The room's verb comes from the ARENA VARIANT and may never be the boss's own signature. Same three shipped helpers, three times the combinations, zero chance of the room impersonating the fight. |
| **`overtime` was a no-op; `retrofit` was a no-op on the Marshal; `redacted` inverted its own difficulty** | 150 × 0.4 = a 60s deadline against 16-52s fights (`enrage=0` in every measured trial). The Marshal's kit called `bossFlameSweep` by name and never read `m.signature`, the only thing retrofit mutates — one capture holds the RETROFIT chip and the beat line FLAME SWEEP in the same frame. And shortening the punish tell only got the storm boss to its own helplessness sooner: 29,089 damage taken with `redacted` against 150,554 clean. | Deadline fraction 0.4 → 0.22 (33s, just under the measured median) and the fight clock lifted out of `stepBoss` so it measures the SEGMENT rather than the seconds the boss spent swinging. Kits cast through `castBandSignature`, which reads `m.signature`. `redacted` no longer redacts the punish tell and buys its shorter tells with TEMPO. |
| **Only 2 of 8 mutators changed the ask, and they were the two rarest** | The two with legality conditions drew 4-10%; the six ambient-pressure affixes drew 13-36%. | The ask-changers get three tickets in the same seeded draw (~25% → ~50% combined where both are legal). Weighted, not filtered — restricting the slot outright would have handed the Architect `retrofit` every single run, which is variety subtracted in the name of variety. |
| **The chassis was ~4 of every 5 things a boss did** | Median identity-verb share ~18%, plus a 10-18 projectile volley every 2.4s, a slam every 6.5s and hazard rain every 5s on every boss. | Half the answer was giving the three silent bosses verbs. The other half is the chassis talking less: volley 2.4s → 3.4s, rain 5s → 6.5s. Re-measured against `balance.test.ts`'s boss suite — `minTtk` (12/15/20s) and "bosses hit back" both still hold, because what came out is ambient chip, not telegraphed hits. |
| **The phase beat was unphotographable on 3 of 11 fights** | The Topiary Warden, the Zoning Board and the Crypt Concierge each fired exactly ONE `intermission`, early, and never again — a 9,000-step driven hunt at 30% HP found no second one. `advanceBossPhase` returns false once `maxPhase` is spent, and all three of those mechanics are repeatable (the hedge regrows, the ledger refills, the board can be re-seated). | `bossMechanicBeat`: advance the phase if there is one left, otherwise still run THE COMMERCIAL BREAK. Plus THE BOARD RECONVENES — clearing the council refills it, one chair fewer each session, so the format's own promise ("the kill order IS the fight") survives past the first clear. |

And the presentation half, which was real too:

| Finding | The answer |
|---|---|
| The approach was a rendering artifact in 10/10 captures: a screen-sized ring clipped by the viewport, over the HUD chips, with no boss in frame | The seal is a THRESHOLD ring bounded by the arena, and the approach takes a framing of its own (a third of the way to the boss, widened a step) — §5.2 asked for a pull-back on arena entry and it had never been wired |
| The shield shell was an opaque low-poly egg with the boss invisible inside it, two of them at once on the Permit Office | `DoubleSide` additive was drawing and summing every pixel twice; the fill carried the read where a shell is a RIM. Front face only, the interior nearly empty, unconditional stress fractures that widen with damage, one dome at a time, and sized to the body |
| The exposure governor was pinned at its floor — 24 of 45 probed frames at exactly 0.45, every fight/phase/punish/kill frame among them | The load coefficient halved, the load itself CAPPED (a governor that saturates is a clamp), decay doubled, floor 0.45 → 0.62. The measured term is untouched: a genuinely clipping frame still gets gripped |
| The call-out double-rendered two strings in one box at the finale's phase edge | `#headline` and `#bosscall` were the same band; the headline steps down while a call-out is live |
| The ringside payoff did not land in frame: 12 beacons live, one visible | Every framing term keyed off a boss with `hp > 0`, so the camera left on the exact frame the payoff fired. The corpse holds the frame for the payoff, and the beacon filter tightened from a 7-tile disc to the ring itself |
| The boss had no death — the corpse was the live mesh, standing, unposed | Most KayKit boss bodies carry no death clip, and nothing else moved them. A boss TOPPLES now, on its own script, and starts eroding at 0.12s instead of waiting 0.8s for a clip that never comes. The harness ages the kill frame past the beat instead of shooting 0.4s into it |
| The whole Garden band was played behind trees | `updateCanopy` only ever registered the instanced open-air terrain, never the per-room props. Tall props are registered at dress time and eased by the same cone test |
| 35-70% of every fight frame was dead black | Sealing an arena REVEALS it (the sim lights the fog) and LIGHTS it (the band mood's own fill, raised while the segment runs) |
| The boss was a thumbnail in its own introduction (6-10% of frame height) | 0.78 is not a push-in at KayKit character scale. 0.52 |
| The cream ring was doing three jobs | The intermission owns a BAR WIPE (single-axis, directional, the only one); the kill's ring COMES APART into four retreating arcs; the contracting warning is unchanged |
| `0:00 COLLAPSE` in red beside every headline moment on floors 9/15/18 | It was not false, which is worse. The System does not cut away from its own marquee segment: the clock HOLDS while an introduced boss is alive, and fight length already has a hard ceiling |
| The kill beat dropped the name at the moment it should be biggest | The kill card names the boss; DEFEATED is the subtitle |
| The centre banner outlived the state it described (BRAND: STEEL over a MAGIC ONLY rail) | A beat that changes the state retires the banner that described it |
| Arena dressing was grid-stamped copies | Per-band cover POOLS indexed by the breakable's own id, plus seeded yaw and a scale wobble on every piece |

**Deliberately NOT done, and why:** the shared chassis is quieter but it is still
the chassis — moving melee/volley/slam wholesale into the kits is a balance
round with its own measurement pass, not a bug fix. The 2D host still has no
dispatch for the new silhouettes (it is the debug view). And
`abilities2.test.ts` §6.4.9(i) remains red exactly as HANDOFF §0 describes it:
it fails identically on the branch without this round's changes, and it is a
cross-doc design question about Barrage's channel, not about bosses.

### 5.12 ACCEPTANCE ROUND 6 — the round the ablation drove

Round 5's review was 34 findings deep and its blockers were, again, mostly not
paint. The two that mattered most were measurements, not screenshots: an
**ablation** (delete `BOSS_KITS[id]`, bot-driven, 2-3 seeds x 70s) showing the
shared chassis carrying the fight on most of the roster, and a bot run showing
**the last boss in the game could not be killed**. Everything below is measured
against those two harnesses, and the numbers are quoted both ways.

| Finding | The defect | The answer |
|---|---|---|
| **Two teaching-band bosses had no BODY** | `monster_bossid_rentcollector` pointed at `extradition.glb` and `monster_bossid_temp` at `stuntdouble_cast.glb`. Both are `HERO_CLIP_MANIFEST` entries — ASSETS.md documents the first as "armature + animation only, NO MESH". They load, bind and animate perfectly and draw nothing, so the first boss most players ever meet was an empty white seal over bare floor at its own reveal. Nothing in the build said so. | `hoarder.glb` (a collector) and `beast_costume.glb` (a temp in a costume whose CLAUSE is the reveal of what is under it). Plus `test/bossbody.test.ts`: every roster id has a row, the file exists, it is not a clip-only rig, and eighteen bosses are still eighteen distinct bodies. |
| **The Pollinator's fight beat drew NOTHING** | `case "swarm"` in `telegraph()` was a particle burst, a ring of embers and a light — no geometry at all. Probe: `shapes:{}` while the sim emitted `telegraph:BLOOM`. The one survive-the-storm boss in the roster had no storm on screen. | A **SEED BED** silhouette (`SEED_FRAG`): the disc is cut into cells, each holds one hash-jittered pod that SWELLS with petal seams opening across it — the same language `makeSporeMat` gives the live hazard. The only DISCONTINUOUS shape in the game. Verified: `tools/_r6/pollinator-3fight.png`, probe `shapes:{seed:2}`. |
| **The punish silhouette was not exclusive to the punish beat** | The rig's gate was `m.stagger > 0 \|\| windupKind === "punish" \|\| held`, and `m.stagger` is set by a plate break, a shield break, a poise interrupt and a floodgate. `shaft`+`reticle` drew in the `-3fight` frames of four bosses and the `-4phase` frames of five: the one shape that means "the window is open" was on screen for three of the six beats. | The rig belongs to the WINDOW alone (`marked`, written by `punishOpen` and nothing else) plus the punish tell's own windup — one sentence, one beat apart, exactly as r4 intended. |
| **The punish window was the worst-composed beat in the fight** | §5.5 pulls back one step per phase, so by the window the shot had widened twice and the encounter occupied ~15% of a 1600x900 frame. The tell's shaft (drawn at the boss's position a beat earlier) and the window's reticle (which follows the BODY) were anchored ~12 tiles apart. | `PUNISH_ZOOM` — the window pushes in past every phase pull-back and HOLDS it for its own duration, and centres its subject (the drop is cut to 42%, because the drop exists to clear the health plate, not to push the boss into the ability bar). Opening the window retires the tell's shaft: one beat, one anchor. |
| **The kill card fired on about one frame in three, and the probe lied about it** | `hold()` pushes `bossCallUntil` only if the call-out is still live when it is called — and `shoot()` calls it AFTER ageing the frame. A card that expired in that gap was retired before the shutter opened, while the probe (taken before the shutter) reported it present. | The card holds for 5.4s, the retirement honours `captureHold`, and `shoot()` now BRACKETS the shutter: it re-probes afterwards and prints a loud `!! DRIFT ACROSS THE SHUTTER` with the after-column whenever anything moved. A probe taken only before the shutter is a claim about a frame nobody saved. |
| **The band's arena verb was the wrong band's** | `roomScript()` was a fixed variant→script map (open→flamewall, pillared→roots, split→flood) with one "step along if it equals the boss's signature" rule — not seeded at all, three room verbs in the whole game, and every measured floor-9 boss ran FLAME SWEEP. A break-the-shield boss's headline frame was 60% Ironworks orange with the hedge invisible. | `BAND_ROOM_SCRIPTS`: each band owns a palette of verbs that are its OWN element or one from a band already played — a room may reach backwards, never forwards — and the pick inside it is a seeded hash of (runSeed, band, variant). The garden regrows and irrigates; the ironworks vents and sheds; nothing floods a foundry. Verified: `tools/_r6/pollinator-*` runs `RUNNER ROOTS`, not FLAME SWEEP. |
| **The Permit Office's lanes were not drawn** | STOP-WORK ORDER is "one locked lane per unbroken stamp" and its probe read `shapes:{shell,column,reticle,shaft,plate:4}` — no `lanes`. The ask table has one shape per label and this beat is genuinely two things. | A telegraph that laid BEAM hazards draws the lanes too, in the ask's own hue, whatever silhouette the ask owns. Not a special case: a telegraph must show the ground it locked. Verified: `shapes:{lanes:1,shell:1,plate:3}`. |
| **The exposure governor was saturated, just at a higher number** | 20 of 32 fight/phase/punish/kill probes read exactly 0.62 — the new floor. At `LOAD_MAX 1.5` and a 0.9 coefficient the load term alone reaches 0.43, i.e. it dives THROUGH the floor, so the floor becomes the operating point the moment two beats overlap. r5 moved the clamp; it did not remove it. | A governor charges OVERLAP: the first `LOAD_FREE` (0.5) of load is free, the coefficient is 0.7 and the cap is 1.2, so the worst case the load term can produce is 0.68 — above the floor. The floor is now reachable only through the MEASURED term, which is the case it exists for. Measured after: 1.00 / 0.96 / 0.76 / 0.68 on frames that used to read 0.62. |
| **THE CHASSIS WAS THE FIGHT ON ALL 18** | Ablation: ≤8% damage delta on 8 of 18 and the fight HARDER without the boss's own kit on 11 of 18. A kit that reduces the threat is a kit whose verbs are strictly safer than the ambient the player is actually dodging — and they are, because every kit verb is telegraphed and the radial volley and hazard rain are not. | The ambient budget MOVED. Chassis: volley 10→6 bolts on 3.4s→4.6s (-58% ambient chip), rain 6.5s→9s, slam 6.5s→8s. Kits: every kit-owned hazard routes through `kitDmg` and is scaled by one number (`bossKitDmgMult 1.5`), so the trade is re-measurable rather than eleven hand-tuned multipliers. Plus three kits that were buying themselves OUT of the fight moved to the off-beat (`affixCd`), so a boss's identity adds to its fight instead of deleting a band signature. **Re-measured: 11 of 18 now harder WITH the kit (was 5), 7 easier (was 11), 4 inside ±8% (was 8).** The Showrunner went -146% → +45%, the Sponsor +3% → +50%. Not all eighteen; the receipt is `tools/_r6-ablate.log`. |
| **Two bosses committed nothing in a real fight** | The Condemned Architect ablated to BYTE-IDENTICAL numbers (0% delta, 48/48 hazards, the same four labels) because its only kit branch gated on `cover <= 2` and nothing in the fight destroyed cover. The Showrunner ablated to 0%. | CONTROLLED DEMOLITION fires on a CLOCK and fells the cover the crawlers are actually standing behind — it DEMOLISHES rather than waiting — which also makes its positional edge reachable in play. CAMERA MOVE got a real stake (arc 2.1→1.7 rad, dwell 1.6→2.4s, cue 8→6.5s) and its own cooldown track. |
| **THE FINALE COULD NOT BE KILLED** | The Sponsor ended a 70s bot fight at 100% HP, 0/2 seeds killed — and ablating its OWN kit ended the same fight at 20% with 1/2 killed. Four anchors were stacked on one boss: a school-locked pool, placements pumping that pool at 3.2x, the council's tether damage tax, the chassis tether HEAL, and (through `sentinel`) a radiated shield aura. Wrong-school damage was flattened to 1 on a 34,000 HP boss, and the school only flips at an HP gate the player cannot reach. | One boss, one armour mechanic. Pylon regen 3.2→1.6; damaging a placement HOLDS the pool outright; the council's tether tax and the chassis tether heal both stand down for a boss that has a shield POOL; placements carry no aura; and wrong-school damage reaches the BODY at `brandOffSchoolMult` (0.25) instead of 1, so an off-school build is four times slower rather than mathematically incapable. **Measured: killed at 102.9s by a bot-driven reference crawler, inside the §6.2 finale target.** Guarded by a new `balance.test.ts` assertion — `minTtk` is a lower bound and a boss that never dies passes it. |
| **The teaching band was a trash pack with a name card** | TTK 11-14s against the 45-90s target, and 0.0 punish windows opened per fight on two of the three candidates: their own counts cannot come round inside twelve seconds. The band whose job is teaching the grammar ended before its most important beat existed. | Both levers §6.4 names: `bandBossHp[0]` 1050 → 1500 (the pre-r4 pool) AND `BOSS_PUNISH.after` 3 → 2 on the two silent candidates. The Concierge keeps 4 — its window is a MECHANIC it already opens, and cutting the count would let the shared clock pre-empt the beat the player earned. |
| **SPONSORED was a stat line, and the most common mutator in the game** | 90.6% of runs, 26.2% of every slot (4,000-seed sweep) because r5 gave every ask-changer three tickets and it is the only shaper legal almost everywhere. Occupancy was bimodal and neither half a verb: 79-100% on bands 1-2 (a permanent 75% damage cut) and 3-15% on bands 4-6, where the anti-kite chase walked the boss out of its own bubble unprompted. | Tickets are DECLARED, not derived from `changesAsk`: `retrofit` and `understudied` carry them and `sponsored` draws at ordinary weight. And it acquires the verb its own counterplay sentence promised — the boss DEFENDS the placement (`sponsoredLeash`), so it can be pulled off its mark but not led round the arena, and the cut halves (0.25 → 0.5). |
| **The mechanic-completion phase edge fired on 11 of 18** | §2.2's hard rule. Missing entirely from seven bosses whose edges gate on arena states a real fight rarely reaches (every floodgate down, every conveyor broken, every pillar gone). | The shared edge is the READ: `m.reads` counts telegraphed heavies that caught NOBODY, and enough of them advances the fight once (`bossReadsForPhase`). It never pre-empts a kit's own edge. **Re-measured: 16 of 18** (`sumpking` and `inspector` still show `hp` only). |
| **A floor-15 arena held 145-151 live bodies** | Whatever the boss's ask was, the thing the player read at depth was a mob field, and kill-the-adds bosses were indistinguishable by add pressure. | `bossFloorCrowdDeep` 0.8 → 0.5. Wave sizes and the mid-run share are untouched. |
| The approach was staged mid-brawl with achievement spam; the Sponsor duplicated its own copy over the mechanic; an unrelated RULES VIOLATION banner sat in the middle of two fight frames | §5.1's hush lived in the audio bus and nowhere in the frame. | The hush is a property of the SEGMENT: from the approach onward the LIVE FEED carries the fight and nothing else (the archive keeps every line), a BOSS high-priority line steps down to the ticker because the beat that raised it already owns `#bossbar` and `#bosscall`, and `body.bossseg` parks the System's headline band low for the whole segment. |
| The intro card cropped or buried its own star in 3 of 8 | `frameDrop` is in WORLD units and the ortho half-height is scaled by `bossFx.zoom`, so r5's reveal push-in (0.78 → 0.52) silently multiplied the framing offset by 1.9. | The drop is multiplied by the zoom, which makes it the constant fraction of the FRAME it always meant. |
| The arena seal was one fat white ellipse on all eight bosses | The most-repeated element in the boss presentation and the least authored: same stroke, same pure white, no glyphs, no tie to band or ask. | `uTicks` — hard glyph bars standing across the ring, one per BAND, and with glyphs on the core mix halves so the ASK's hue survives the additive pass. The Undercroft's threshold carries one mark; THE APPROACH's carries six. |
| The harness could file a frame whose call-out was a different beat | `guard()` asserted the boss was alive and the playfield unobstructed, and nothing about the BEAT. | `guard()` takes a `wantBeat` and reads `#bb-beat` / `#bc-word` / `#bc-sub` off the screen; a mismatch re-hunts the headline (three attempts) and, failing that, files the frame under `-3fight-MISSED` so nothing is mis-labelled. It caught the Sump King's SLUICE GATE and the Sponsor's CROSS-PROMOTION being overwritten by their own punish tells within a beat. |

**Deliberately NOT done, and why** — the honest list:

- **The ablation bar is not fully met.** The stated bar was "deleting a kit makes
  each fight EASIER". It now does on 11 of 18 rather than 5, and 7 bosses
  (Concierge, Topiary, Zoning Board, Architect, Marshal, Standards, Safety
  Officer) still measure SAFER with their kit. The residual cause is structural
  and named: a kit that opens punish windows donates ~3s of total quiet per
  window, and on those seven the kit's telegraphed verbs do not out-threaten
  what the chassis would have done in that time. Closing it needs per-boss
  verb tuning with its own measurement pass, not another shared multiplier.
- **The Sponsor's kill beat is not photographed.** The sim change is measured
  (bot kill at 102.9s, asserted in `balance.test.ts`), but `bossshot.mjs`'s
  naive strafe-and-swing driver still cannot put it down inside the capture
  budget, so the harness has no `sponsor-6kill.png`. Per the capture-honesty
  rule that is reported as a missing frame rather than staged.
- The Sump King's sluice gates still render as untextured quads, the
  Showrunner's safe wedge still has no camera language of its own (frame lines /
  vignette on the unsafe ground), the corpse still reads hot rather than dead,
  the loot ring is still camouflaged in the Marshal's crate-strewn arena, the
  Marshal's rig still goes prone mid-fight, floors 12 and 18 still share a
  dressing palette, and the four band signatures still separate more by hue
  than by silhouette. All real, all untouched.

### 5.13 ACCEPTANCE ROUND 7 — the round the harness stopped flattering the code

Round 6's review was 34 findings deep, and its shape is different from every
round before it: **the harness itself shipped two dishonest frames inside the
critic's own run**, and four of the blockers are measurements taken with tools
(`tools/_ed3ask.ts`, `_ed3census.ts`, `_ed3len.ts`, `_ed3variety.ts`) rather
than screenshots. The two halves reinforce each other — the picture round could
not be trusted because the capture rules were not enforced, and the design round
could not be seen because the ask on the name card was not measurable in play.

| Finding | The defect | The answer |
|---|---|---|
| **The punish rig owned the PHASE beat too** | `sumpking-4phase.png` and `-5punish.png` were the same picture: both read UNLOAD in the call-out and drew reticle + shaft. §5.12 says the rig "belongs to the WINDOW alone (`marked`)" — true of who WRITES it, and nothing ever took it away, so an intermission crossing inside `MARK_MIN_SPAN` left the window's silhouette standing over a beat that is its exact opposite. It was not a composition problem, it was a LIE: during the break the boss is `invulnT`, so "commit here now" is false. | The intermission RETIRES the rig (`marked.delete`, shafts down, `punishFrameT` released), the rig is gated off entirely while `invulnT` runs, and the call-out has an unconditional retirement on the same condition — deliberately NOT honouring `captureHold`, because a capture may not hold a sentence open past the moment it stopped being true. |
| **The intermission had no call-out on half the roster** | `CALL_RANK` makes `punish` (3) outrank `intermission` (2), so four of eight captured bosses filed their `-4phase` frame with UNLOAD still up. The ranking was written for a phase edge crossing mid-window, where the window is still true a moment later; here the beat that fired is the one that made the window false. | The intermission takes the layer outright (`retireBossCall`) and holds it for the break's own length plus 1.4s, so the call-out cannot expire inside the beat it names. Verified: `rentcollector-4phase` probes `shapes:{wipe:1}`, call THE COMMERCIAL BREAK, no reticle and no shaft. |
| **The whole Garden band was STILL played behind trees** | §5.11 registered per-room props and eased them on a cone — and the CONE was a flat `u < 3.4`, the occlusion depth of a prop about 2.8 units tall. `camDir` is (1, 1.15, 1), so a piece of height h hides the ground for about 1.23h units down the screen diagonal: a 5-unit Garden conifer occludes for ~6.1 and was being tested against 3.4. The registration was never the bug. | The cone is the PROP'S OWN, from its measured height and footprint at dress time, capped at 9 units; the same correction applies to the instanced canopy (per-instance height off the source geometry and its own matrix), and the candidate-cell scan widened to match. The arena's own centre joins the entity list, so the threshold ring is not bisected either. |
| **The payoff beat did not land, on every band** | Three separate causes, all fatal to the same frame. The corpse dissolved at delay 0.12 + dur 1.5 = GONE 1.62s after death, and the kill frame is shot at 1.8s (it has to be — the topple alone takes 0.75s), so every `-6kill` capture was of the particle system that used to be a boss. The beacons expired at 4s while the last drops were still being thrown. And `frameDrop` — which exists to clear the HEALTH PLATE, an object that does not exist at the kill — slid a four-tile loot ring down until its lower arc was under the ability bar. | The corpse lies there for the whole aftermath (delay 2.6, dur 2.2, matching `focusT`) and erodes on a dull ember instead of the celebration's gold; beacons hold 7s at flat value; the aftermath frames the middle (`frameDrop` x0.3). The kill's particle count is cut two thirds and its floor light halved twice — the body is the subject, not the confetti. Verified: `tools/_r7fix/rentcollector-6kill.png`, `sumpking-6kill.png`, `marshal-6kill.png` — a toppled body, the name card, 6-14 beacons. |
| **The loot beacon and the punish reticle were the same silhouette** | Both were white/gold square brackets on the ground: the beacon borrowed `AIDE_FRAG` (a notched square = four corner brackets) and `MARK_FRAG` is four corner brackets. The one shape that means "commit here NOW" also meant "a sword dropped here" — the exact collision §5.9 established the rule against. | Split on the axis that reads first. PUNISH = OPEN corner brackets that CLOSE inward under a vertical shaft; LOOT = a SOLID chamfered diamond pad with a descending CARET over it (`LOOT_FRAG`, new). One is an outline, the other is a blob with an arrow on it. |
| **THE ENTOURAGE owned the marquee at two headline beats** | §5.9's rule was a TIE-BREAK between candidates, and at the approach (boss un-introduced) and the kill (boss at zero HP) the boss is not a candidate at all, so the escort won by walkover. | The rule is exclusive, not comparative: while a boss segment is live in ANY phase, the marquee belongs to the boss or to nothing. |
| **THE ASK ON THE NAME CARD WAS NOT MEASURABLE IN PLAY** | `tools/_ed3ask.ts` (3 seeds x 60s x 18 bosses): mean concurrent live adds was a pure function of the FLOOR. Grouped BY ASK: storm 66.3 > lane 52.6 > window 40.8 > **adds 39.5** > shield 38.4 > arena 34.4 — the ask literally named "kill the adds", five of eighteen bosses, ranked FOURTH in add pressure. §5.12 cut the deep share 0.8 to 0.5 against 145-151 bodies and the re-measurement was still 93-101: a cut to a number that was never the right SHAPE of knob. | `CONFIG.bossFloorCrowdByAsk` — the arena's ambient crowd is a function of the DRAWN BOSS'S ASK (adds 0.10, storm 0.14, lane 0.16, shield/window 0.18, arena 0.20). Wave sizes, tether counts and the ordinary-floor share are untouched; this deletes ambient bodies only, which is the layer nobody chose. Asserted in `balance.test.ts` ("a BOSS arena is thinner than the floor around it, and by its ASK"), and the deep-density contract moved to floor 16 — an ordinary deep floor — with its bar unchanged at >80. |
| **THE SHARED RADIAL VOLLEY WAS THE MODAL EVENT ON 12 OF 18** | `ch_volley` was the top threat-vector entry on twelve bosses and #2 on the other five. Median chassis share 58%; on the teaching band 78%, with the boss's own kit windups at 6%. §5.12 moved it 3.4s to 4.6s and 10 to 6 bolts; slowing a universal does not stop it being a universal. | `ASK_CHASSIS` (bosses.ts): cadence, density and EXISTENCE come from the ask. `adds` and `storm` do not fire one at all — their mechanic already owns the air — `lane` fires a thin slow one that cannot bury the line it wants read, `window` fires the densest on the shortest clock (its fight IS pressure-then-relief), and what those asks give up comes back as hazard RAIN, which arms. A roster entry may also state its own (`BossDef.chassis`); The Temp does, because "a pushover with a visible ticking clause" had been fighting exactly like The Rent Collector beside it (cosine 0.972). |
| **DODGE-THE-LANE PUT NO LANE UNDER THE CRAWLER** | Seconds spent inside a `kind:"beam"` hazard, 3 seeds x 60s: inspector **0.0**, foundation **0.0**, and every other boss 0.0 except the Sponsor at 0.3. The Foundation's FISSURE resolved to `fissureSteps` separate `blast:debris` discs — the same primitive as the chassis rain, 163 a fight — and the Inspector's CITATION was a 0.75-tile half-width lane, narrower than the crawler plus a step. | FISSURE lays one real `beam` per lane on the same staggered clock, running the full reach the discs used to walk (`bossFissureReach` 11, `bossFissureWidth` 1.3), with two eruption discs left as the crack's leading and trailing edge so it still reads as masonry. `citationWidth` 0.75 to 1.35. Asserted in `bosses.test.ts`. |
| **THE CAPTURE HARNESS ASSERTED THE BEAT ON 1 OF 6 FRAMES** | `wantBeat` was passed only when the fight hunt landed an event, and only on `-3fight` — so a TIMED-OUT hunt saved under the clean name with no assertion, and the other five beats were never asserted at all. It shipped `concierge-3fight.png` (a punish frame filed as the fight beat) and `topiary-4phase.png` (a timeout, no wipe, no call-out). DRIFT ACROSS THE SHUTTER fired five times and every drifted frame was still filed under the beat's clean name. | Every beat names what its pixels must contain: the boss's name for `-2intro` and `-6kill`, COMMERCIAL BREAK for `-4phase`, `BOSS_PUNISH[id].core` for `-5punish`, the hunted label for `-3fight`. A hunt that did not land its event asserts an impossible string, so it is a MISS whatever the frame looks like. The assertion moved AFTER the ageing (it is a claim about the frame that will be saved). The drift check re-runs the assertion against the AFTER column and a frame that drifted off its beat is **deleted from disk**, not merely logged. `guard()` also reads `#bi-name` and `#bb-name`, the two name surfaces outside the plate and the call-out. |
| **The punish tell took the plate line off the boss's own verb** | MOTION CARRIED lost the shutter 6 times out of 6, and STOP-WORK ORDER three times in this round: the boss commits its named signature and, ~200ms later, its punish TELL — also a `telegraph` — replaces the line. Both are true, the plate can say one, and the one it kept was the one all eighteen share. | The plate's beat line holds a named signature for 1.4s before a PEER may take it. Not a priority hack: the tell keeps its world silhouette throughout, and the WINDOW is locked and still overrides instantly. |
| **Every punish frame printed its own sentence twice** | "THE EMPTY TILL — UNLOAD" on the plate and "UNLOAD / THE EMPTY TILL" in the call-out, ~180px apart — and the duplicated half was the wrong half: the chassis word UNLOAD was 46px on all eighteen bosses while the boss's own name for its window was the 14px subtitle. | Split by JOB, sharing no words: the CALL-OUT carries the identity (this boss's `core`, at announcement contrast) over the grammar lesson; the PLATE carries the verb, which is the same on every boss and belongs on the small always-present surface. |
| **The hit flash saturated the whole boss body** | Six combat frames rendered the boss as a featureless pale mass against a live-clock control (`body-f12-noswing.png`) of the same rig reading as shaded bronze. Neither the envelope nor the gains were wrong for what they were built for — ONE hit on ONE trash body. What they never modelled is that a boss is hit every ~0.25s for a minute, so the strike term never returns to zero and a flash meaning "this just took damage" is on for the entire fight. | A DUTY GOVERNOR: the flash is charged for how much of the recent past it has been on, so a first hit after a quiet moment is as bright as ever and a body being hammered settles to about a third. Plus the flat emissive term (a body-wide wash) is a quarter of what it was and the RIM carries the read. Not boss-specific — the same thing was happening to any tanky elite. |
| **BLOOM was ~30 identical glowing donuts** | `SPORE_FRAG`'s read was a bright rim band at r 0.82-0.95 plus a bright core — a donut, drawn 22 times at one size in one green, i.e. the ring silhouette §5.9 reserves to a single signature, multiplied. And every pod was byte-identical. | The pod is an INDIVIDUAL and a BULB: a filled body with petal seams cut through it, a bud that comes up late, a lit petal EDGE (not a circle), and a per-pod seed off the hazard id turning seam count, facing, size and hue lean. Children are smaller than parents and the bed is clamped to the arena, so it reads as a population growing rather than a pattern stamped. |
| **The Permit Office's four stamps were four blank white quads** | Three defects in one quad: the school hue was being passed and spent on the near-black FIELD while every lit pixel came from a fixed cream; there was no icon on four objects whose whole mechanic is "these two want a different school"; and the outline was a plain square, the shape reserved for "aim here". | A stamp is a CHAMFERED tablet whose bezel and rule carry the SCHOOL's hue, wearing a procedural glyph keyed off its index: wedge / bolt / arch / slash. Only the cracks run to the hot core, so "this one is nearly off" stays the brightest thing on it. |
| **SLUICE GATE drew nothing in the world** | `BREAKABLE_MODEL.drain` was `floor_tile_grate_open` — a FLOOR TILE. The four objects the use-the-arena boss's whole ask is about were, at the fixed iso camera, four slightly different patches of floor. (§5.12's honest list said "untextured quads"; they were quads because the asset is one.) | `wall_gated`: a standing sluice gate you can walk up to and break. And the beat shows the ground it claimed — a lane bar per anchor along the prop-to-middle heading, plus a scorch and sparks running inward from each gate, so the read is "it is coming from there, to here". Verified: `sumpking-3fight.png`, probe `shapes:{props:1, lanes:1}`. |
| **CAMERA MOVE had no safe-wedge language** | The one beat in the game whose read is the SAFE ground drew three flats in a corner and nothing on the floor, because the host had no way to know WHICH wedge — the sim computed the angle to place hazards and threw it away. | `BossEvent.angle` / `.arc` (data, not presentation — the same number the sim already used). `SET_FRAG` draws the SHOT: lit safe ground between two hard frame lines, with the struck ground HATCHED and darkened around it. The flats are the set; this is the camera. A zero arc drops the whole term, so every other `set` caster is unchanged. |
| **RETROFIT contradicted itself inside one frame** | The plate carried the RETROFIT chip and HEDGE REGROWTH while the LIVE FEED read "THE FURNACE EXHALES: A wall of fire is coming through". §5.9 made the band signature's LABEL identity and left the ANNOUNCE COPY hardcoded in the helper, so the borrowed hazard kept its own voice over the boss's own plate. | All four shared band signatures announce the boss's own label followed by the counterplay — the label is identity, the sentence after it is a property of the hazard and true whoever cast it. |
| **§2.2's HARD RULE failed on 4 of 18 in play** | sumpking 0/6, inspector 0/6, architect 1/6, safetyofficer 1/6. §5.12's shared fallback counts `m.reads`, and `reads` only ever incremented on a whiffed SLAM or RITUAL — verbs a lane boss and an arena boss do not own. | The read is the counterplay the fight actually asks for: a lane you stepped out of, a telegraphed disc you walked out of, a boss ground zone that finished ARMING with nobody in it, and breaking an arena prop all credit `m.reads` (`creditBossRead`). Asserted for all four in `bosses.test.ts`. |
| **The punish window had a 28x cadence range** | temp 0.3 windows/fight (none at all in 4 of 6), rentcollector 0.5, against marshal **8.5** and sponsor 5.2. `bossPunishRecovery` is a floor on frequency with no ceiling. | Both ends. `bossPunishGuaranteeT` (16s) arms the next window outright after that long without one, so the beat the teaching band exists to teach cannot simply not happen; `bossPunishFatigue` lengthens each recovery by 35% per window already opened this fight (capped at 2.4x), so a boss whose kit commits constantly slows down instead of metronoming. |
| **The system's own chrome sat on top of the boss beat** | `body.bossseg #headline { top: max(52%, 430px) }` parks the non-boss banner at the VERTICAL CENTRE of a 900px frame, which after §5.9's framing is where the boss and the reticle are. And the LIVE FEED hush was a text-PREFIX regex, so "NEW SPONSOR for Carl!" and a three-line COURTESY EXPLANATION rode the punish window. | The hush classifies on `Announcement.kind` — which the sim has always assigned and the host was throwing away (`flushFeedback` pairs each event line back to the announcement that produced it). Untyped lines are the world describing itself mid-fight and pass. And EVERY high-priority line steps down to the ticker for the segment, not only boss ones; the band itself is pinned below the playfield rather than in it. |
| **The teaching band was one 15-second fight wearing three hats** | Pairwise cosine 0.993 / 0.972 / 0.968 across two different asks; TTK 7-21s against a 45-90s target; and floor 3 drew ZERO mutators by design, so each candidate had 2-3 (mutator x arena) fingerprints IN EXISTENCE — in the one boss slot every short session reaches. | The "floor 1 stays pristine" analogy is wrong for a stated reason: FLOOR 1 HAS NO BOSS. Floor 3 draws one mutator from a TEACHING subset (`BossMutatorInfo.teaching`: ENTOURAGED, RETROFIT, UNDERSTUDIED — one more verb to read or one more body to prioritise, never ambient pressure, a clock, or a text test). Plus the two structural halves above: the Concierge stops firing the volley entirely and The Temp declares its own chassis. **Not closed**: TTK is still short, and closing it wants the mechanics-not-HP lever with its own measurement pass. |
| **The Standards Board could not be captured or killed** | Three full attempts, kill timed out at 24,105 HP each time: two of three finales had an unphotographable kill. | The kill segment's damage is scaled to the pool in front of it (~90 landed hits to zero, whatever the band) rather than a flat multiplier that was a floor-3 number, and a COUNCIL body's aides — already photographed at `-3fight`, where the kill order IS the fight — are allowed to finish. A harness change: how the harness FIGHTS, never what the boss does. |
| **Stage Cables were untextured cyan slabs** | Two 0.075-thick boxes of flat additive cyan at opacity 0.9, in 9 of 12 boss frames. The abilities track's asset, but it is in the boss frames. | A material: a dark braided core with a hot CURRENT travelling along it, half the thickness, lit only where the current is — and the current stalls when the line is spent, so the cable's own motion is what says "armed". |

**Deliberately NOT done, and why** — the honest list:

- **The Topiary Warden still emits no second intermission and no punish window
  in a 9,000-step driven hunt.** `tools/_r7fix3.log` files its `-4phase` and
  `-5punish` frames as `-MISSED`, which is the harness working correctly and
  the boss still not doing the thing §5.11 says `bossMechanicBeat` fixed. It
  looks like a shield-break stagger loop, not a presentation defect, and it
  wants its own measurement pass.
- **Fight length is still decided by the mutator roll** (zoningboard 31s..114s,
  sponsor 105s..>180s on one boss across six seeds). Real, untouched, and a
  balance round rather than a fix.
- **The roster's median pairwise threat similarity** is improved by the
  ask-derived chassis but was not re-measured across all 153 pairs. The claim
  in this round is only that the CROSS-ASK half of the collision is
  structurally closed, not that the number moved to a stated target.
- **The break-the-plate ask still has no separate object in the world.** The
  Rent Collector's lockbox is a plate panel hung on the body, not a lockbox
  standing on the floor, and the Topiary Warden's hedge is still the generic
  shell dome.
- The Standards Board's council format still does not READ (cords and aides
  probe present and are not identifiable in the pixels), the loot ring is still
  camouflaged in the Marshal's crate arena, and floors 12 and 18 still share a
  dressing palette.


---

## 6. BALANCE FRAME

### 6.1 Where the numbers are today (measured)

| Floor | Boss maxHp | Boss dmg | Player maxHp (natural) | Damage to a STATIONARY crawler |
|---|---|---|---|---|
| 3 | 1,500 | 26 | 238 | 1,230 / 10s |
| 6 | 5,400 | 36 | 275 | 2,422 / 10s |
| 9 | 10,500 | 36 | 316 | 2,829 / 10s |
| 12 | 18,360 | 36 | 370 | 4,708 / 10s |
| 15 | 27,000 | 36 | 466 | 6,384 / 10s |
| 18 | 34,000 | 52 | 442 | 4,147 / 10s |

Read that last column carefully: **a crawler who stops moving dies in about two
seconds on every boss floor.** The fights are already tuned so that movement is
the whole defense. That is the correct foundation, and V2 must not raise it,
because every mechanic added below *also* competes for the player's movement
budget.

### 6.2 Targets

- **Fight length: 45-90 seconds** for a band boss; up to 120s for the finale.
  Short sessions cannot carry a three-minute erosion. This is the number the
  whole balance frame serves.
- **Time-to-kill floor:** `bossHitCapFraction: 0.1` already guarantees at least
  10 landed hits. Keep it.
- **Damage budget per hit:** any single *telegraphed* hit at most 25% of player
  maxHp (so two mistakes are survivable, three are not). Unavoidable chip at
  most 5% per tick. Today's boss melee is 8-11% — that band is right; new
  mechanics must fit inside it, not stack on top of it.
- **Adds:** a wave must never exceed the damage of the boss itself. Adds create
  *decisions*, not damage.
- **Hard enrage (V5):** deadline at about 2x the target fight length, then a
  stacking multiplier. It should almost never fire for a competent player.

### 6.3 What the bot must survive

The shipped contract (`balance.test.ts`) has two relevant halves:

- **Early game:** floors 1-2, at least 4 of 6 seeds, cleared before collapse.
  Nothing in this doc touches floors 1-2, so this half must not move at all.
- **Boss difficulty (already exists — do not break it):** the "boss arenas are
  fights, not screenshots" suite runs reference builds against floors 6, 12 and
  18 and asserts a **minimum time-to-kill floor** of 12s / 15s / 20s, plus
  "bosses hit back" (the party must lose real HP across the reference fights)
  and "early elites are never one-shot".

Note the shape of that existing contract: it is a **lower** bound on fight
length. The 45-90s target in 6.2 is an **upper** bound. They are compatible —
V2 lives in the band between them — but the `minTtk` numbers are the most
likely thing to need re-tuning if `bandBossHp` comes down (6.4), and they are
exactly the numbers that must not be quietly relaxed to make a regression pass.

V2 additions to the contract (new assertions, not weakened ones):

1. `pickBandBoss` is **deterministic and stable** — same seed gives the same
   lineup, and the draw does not consume `state.rng` (assert the post-spawn RNG
   state is unchanged vs. the fixed-boss baseline).
2. Every boss in the pool **spawns and runs 60 sim-seconds without throwing**,
   on every band, with every legal mutator.
3. Every boss commits **at least one non-melee windup** in 60s against a live
   target — the assertion that would have caught the Crypt Concierge.
4. Every boss has a **punish window** (V4): assert `m.stagger > 0` occurs at
   least once in a scripted fight.
5. **Damage budget:** no single hit exceeds 25% of the era-appropriate player
   maxHp on any boss floor.
6. The **floor 1-2 contract is untouched** — nothing in this doc spawns on
   floors 1-2.

### 6.4 Contract numbers that moved — MEASURED

The full receipt (every knob, the measurement that justified it, and the
`main`-equivalent control it was measured against) is **BALANCE-NOTES.md,
round 2**. The short version:

- **`bandBossHp` came down** — 30% on the teaching band, 20% elsewhere. §6.4
  called it, and the measurement backed it: at the old pools the bot's floor-3
  clear rate collapsed from 26/32 (control) to 15/32, because plates, shields,
  tethers and intermissions all buy time with the player's HP bar. The fights
  are harder AND shorter, which is the trade this section asked for.
- **`bossWaveAdds` did NOT move.** Waves stayed as-is; the "adds with jobs"
  pressure came from TETHERS instead (they feed the boss), which is a job the
  wave count cannot express.
- **`bossVolleyCount` / `bossHazardCooldown` did NOT move.** Measured fight
  lengths land at 16-52s — the movement budget held.
- **`minTtk` (12s/15s/20s) did NOT move**, and did not need to: measured
  medians are 36.6s (floor 6) and 51.6s (floor 12), comfortably clear of the
  floors even after the HP cut. Re-measure before touching `bandBossHp` again.
- **The floor 1-2 contract is untouched, and proven so**: 40-seed sweep, deaths
  by floor, V2 vs control — floor 1 = 3/3, floor 2 = 7/7, identical.
- **Plates learned a rule the doc did not anticipate**: only school-tagged
  ARMOUR plates tax the body. A bare plate (the Rent Collector's lockbox) is a
  bonus OBJECTIVE; taxing the body behind one tripled floor-3 TTK. A plate must
  change the ASK, not the HP.

**No test band was widened to hide a regression.** Exactly one assertion moved
— `bandBossHp` in `bands.test.ts` — and it moved to the new numbers with the
measurement written beside it.

---

## 7. MIGRATION MAP

Scoped MUST / SHOULD / LATER. MUST is the smallest set that delivers the owner's
actual ask (variety across runs + elevated encounters).

### 7.1 Seams by file

**`src/sim/config.ts`**
- `BOSS_POOL` — 6 bands x 3 candidates, replacing `BAND_BOSSES`
- `BOSS_MUTATORS` table + per-floor gating weights
- `ARENA_VARIANTS` per band + legality flags
- new knobs: plate HP, shield regen, punish-window seconds, enrage deadlines
- **`CHAMPIONS` becomes a seeded pool** rather than fixed floor entries

**`src/sim/game.ts`**
- `spawnMonsters` boss branch: `BAND_BOSSES[arena-1]` becomes
  `pickBandBoss(seed, band)` plus `rollBossMutator`
- new signature helpers alongside the shipped `bossFloodSurge` /
  `bossRootGrasp` / `bossDebrisRain` / `bossFlameSweep` / `bossGraveRaise` —
  **same shape, same file, same announce discipline**
- `damageMonster`: plate/weak-point branch (V1), shield pool (V2)
- `spawnBossWave`: give adds a job + tether (V8)
- `arenaDirector`: extend from 3 floors to all boss floors, driven by the arena
  variant

**`src/sim/ai.ts`**
- The `m.kind === "boss"` monolith becomes a **shared chassis + per-boss
  override**, keyed off a new `boss.bossId`. Chase / volley / slam / phase
  bookkeeping stay shared (they are good); each boss supplies its own
  ability-selection block, exactly as the trash kinds already do. **This is the
  single most important refactor in the doc** — without it, boss #7 is another
  `if` in a 150-line branch.
- new windup kinds route through the existing `resolveStrike` switch

**`src/sim/floor.ts`**
- arena carve gains a **variant**: pillar/cover placement into `breakables`,
  hazard bands, chokepoints. The carve already replaces the farthest room; the
  variant only decides what goes *inside*.

**`src/sim/types.ts`**
- `Monster`: `bossId`, `bossMutator`, `plates`, `shieldHp`, `invulnT`,
  `tetherId`, `enrageT`
- `Breakable.onBreak` (V3)
- extend `BossSignature`, `windupKind`, and `Hazard.kind` unions

**`src/sim/snapshot.ts` + persistence**
- `bossId` / `bossMutator` / plate + shield state **must serialize** — coop
  clients and save/resume both reconstruct from the snapshot, and a boss whose
  identity is not in the snapshot desyncs
- **new save field: per-profile boss defeat counts** (4.4) and last-run boss
  lineup (4.1 anti-repeat rule) — PERSISTENCE.md gets a row

**Renderers (`renderer3d.ts`, 2D `renderer.ts`)**
- new `Hazard` kinds need dispatch in **both** hosts
- plate/shield visualization on the boss plate (the phase-pip chassis extends
  naturally)
- intro card, camera beats, intermission staging
- FX strictly from `fx.ts` / `fxParticles.ts` / `fxTrails.ts`

**Tests**
- `bands.test.ts` — pool coverage per band
- `mobs.test.ts` — every boss spawns, every mutator legal
- `sim.test.ts` — each new verb (plates, shields, tether, punish window, enrage,
  intermission)
- `balance.test.ts` — the six assertions in 6.3
- a new `bosses.test.ts` — selection determinism + RNG-stream stability

### 7.2 Scope

**MUST — SHIPPED IN THE SIM** (all eight; see §1/§3/§4 above)
1. ~~`pickBandBoss` seeded selection + `BOSS_POOL` (V9)~~ — `src/sim/bosses.ts`
2. ~~The ai.ts boss-brain refactor (chassis + per-boss override)~~ — `stepBoss` + `BOSS_KITS`
3. ~~Boss mutator layer (V10), gated floor 6+~~
4. ~~Punish window on every boss (V4)~~ — reuses `m.stagger`, asserted for all 18
5. ~~Breakable plates / weak points (V1)~~ — armour plates tax the body, bare plates do not (BALANCE-NOTES round 2)
6. ~~Arena variants incl. destructible cover (V3)~~ — `stockBossArena` + `Breakable.onBreak`
7. ~~Name the floor-18 boss~~ — three of them
8. ~~Snapshot + save fields; the 6.3 test suite~~ — `test/bosses.test.ts` (41 cases)

**SHOULD — the sim half also shipped** (they were what made the roster differ
by more than a hazard colour, so they came with the MUST scope):
9. ~~Boss shield pools (V2)~~ — incl. The Sponsor's school lock
10. ~~Adds-with-jobs + tether (V8)~~ — capped at 4 feeding cords
11. ~~Hard enrage (V5)~~ — deadline + stacking damage, OVERTIME mutator moves the clock
12. ~~Intermission / phase spectacle (V6)~~ — every phase edge re-deals the board

**SHOULD — still open**
13. Repeat escalation: the SIM half is done (`SavedProgress.bosses`); the HOST
    still has to write the two maps at its checkpoint.
14. Seeded champion pool (`CHAMPIONS` is still three fixed floors)
15. ~~Intro card, camera beats, audio hooks (section 5)~~ — **SHIPPED**, see the
    §5 scoreboard. `src/render3d/bossFx.ts` is the whole presentation seam; the
    3D host consumes `state.bossEvents` alongside hits/announcements and adds
    no sim state of its own.

**LATER**
16. Boss displacement (V7)
17. The Council format (Zoning Board / Standards Board) — a different spawn
    shape, worth its own round
18. The Sponsor's ability-suspension (needs an ability-layer hook; also the
    riskiest against the dungeon-crawler-first rule — build it last, cut it
    freely)
19. Burrow/relocate (still open from MOB-CONCEPTS)
20. Boss-specific models beyond the KayKit pool

### 7.3 Shipping order (PR-sized bites)

1. **Selection + refactor** — `BOSS_POOL`, `pickBandBoss`, the ai.ts chassis
   split, snapshot fields, determinism tests. *No new bosses yet* — the five
   existing ones move into the pool unchanged. This PR is pure plumbing and
   should show zero gameplay diff.
2. **The verbs** — plates, punish window, arena variants, adds-with-jobs, each
   with vitest coverage. Still no new bosses.
3. **Band 1-2 bosses** (6 entries incl. the two reworks) + mutator layer.
4. **Band 3-4 bosses**, then **band 5-6** incl. naming the finale.
5. **Elevation pass** (section 5) as its own round — intro card, camera, audio,
   intermission.

Rationale: bites 1-2 are invisible and fully testable; every later bite is
content on a proven chassis. The balance contract is re-run at every bite, and
`npx tsc --noEmit` + `npx vitest run` gate each one.

### 7.4 THE EVENT VOCABULARY the presentation layer reads

The sim owns no presentation, so everything §5 needs leaves as DATA. Three
channels, all already flowing:

**`state.bossEvents: BossEvent[]`** — transient, cleared every step exactly
like `state.hits`. Each entry carries `monsterId`, `bossId`, and optionally
`pos`, `label`, `value`, `duration`, `phase`, `reason`:

| `kind` | When | Carries | The beat it should drive |
|---|---|---|---|
| `intro` | the ringside reveal fires | `label` = boss name, `value` = times beaten, `duration` = freeze length | the NAME CARD (§5.3); `value > 0` means shorten it |
| `phase` | a phase edge crossed | `phase`, `reason` (`hp`/`mechanic`/`timer`/`positional`) | camera pull-back + stinger; `mechanic` is "the player caused this" and should read louder than `hp` |
| `intermission` | THE COMMERCIAL BREAK | `duration`, `value` = hazards swept | snap-to, boss untargetable, shockwave clearing ground FX |
| `punish` | the boss over-commits | `duration` = window seconds, `label` on an exposed core | the unload window — this is the one beat that most needs to read |
| `plate` | a plate broke | `label` = plate name, `value` = plates left | the boss health plate's pip row |
| `shieldbreak` | the absorb pool emptied | `duration` = stagger | shield shatter |
| `enrage` | past the hard-enrage deadline | `value` = stacks | the System losing patience with the slot |
| `telegraph` | a named signature commits | `label` (e.g. `CITATION`, `BLOOM`, `FISSURE: RADIAL`, `BRAND: MAGIC`) | the per-boss signature FX + its unique telegraph SOUND (§5.4). **Must read in 0.2s.** |
| `prop` | an interactive arena prop fired | `label` (`FLOODGATE` / `WALL VENT` / `CONVEYOR`), `pos` | the arena reacting |

**`state.encounter`** now carries the whole name card: `bossId`, `epithet`,
`ask`, `mutators`, `line`, `repeat`, plus the existing `timeLeft` / `total`
(already shortened on a rematch — do not shorten it again host-side).

**`Monster`** carries the persistent state a boss plate needs: `bossId`,
`bossMutators`, `plates` (each with `label`, `hp`, `maxHp`, `angle`, `school`),
`shieldHp` / `shieldMax` / `shieldSchool`, `invulnT`, `tetherId` (draw the
cord), `enrageStacks`, `phase` / `maxPhase`. All of it ships in coop snapshots
on purpose — a boss whose identity is not in the snapshot desyncs the moment a
phase lands.

**New `Hazard.kind`: `"spore"`** (the Pollinator's armed pods) — arms like
sludge, blooms once, seeds children. **The 3D host has its own primitive for it
now** (`makeSporeMat`: petal seams that SPREAD as it arms and a core that
swells, so the countdown is the pod's silhouette); the 2D host still falls back
to its sludge-family zone drawing, which is correct-looking.

**The four SHIPPED band signatures now name themselves on this channel too**
(`FLOOD SURGE`, `ENTANGLING ROOTS`, `DEBRIS RAIN`, `FLAME SWEEP`). They are the
only telegraphs that were emitting hazards without emitting an event, which
left four of the eighteen bosses with no per-boss FX or telegraph sound. Four
additive `bossEvent` calls; no mechanic changed, no test moved.

**New `windupKind`s: `punish`, `latefee`, `bloom`, `pull`** — four, deliberately.
Everything else the roster does reuses a shipped windup (`morph`, `summon`,
`slam`, `aim`, `raise`, `hook`) with a per-boss branch, the way the colossus
already branches inside `slam`. `punish` is the one that matters most: it is
the universal over-commit, and the frames after it resolve are the fight's
whole payoff.

---

## 8. Open questions for the owner

1. **Pool size vs. depth.** Three bosses per band (18 total) is the number this
   doc commits to. Would you rather have **two per band, built deeper** (more
   phases, more bespoke FX each), or **four per band, lighter**? The variety
   math wants four; the elevation bar wants two.
2. **The anti-repeat rule needs cross-run memory.** 4.1 wants to avoid serving
   the same band boss two runs running, which means persisting the last run's
   lineup. Acceptable to add to the save file, or should selection stay purely
   seed-derived (and occasionally repeat)?
3. **Repeat intros.** 4.4 shortens the ringside freeze on bosses you have beaten
   before. That trades away a signature beat for session speed — right trade, or
   should the intro always play in full?
4. ~~**The Sponsor.**~~ **Decided and shipped as a school lock, not an ability
   suspension** — the ability-layer hook is the part that flirted with the
   gameshow-minigame line, and it is not needed to make the fight interesting.
   Say the word if you want the real suspension and it can be layered on.
5. ~~**Council format.**~~ **Shipped, and cheaper than the doc feared**: one
   body plus tethered aides that shield it and bequeath their verb on death.
   No new spawn shape, and the kill order genuinely is the fight. Still worth
   your eye on whether it READS as a boss in play.
6. ~~**`bandBossHp` reduction.**~~ **Taken, and measured** — 30% on the teaching
   band, 20% elsewhere, receipts in BALANCE-NOTES round 2. Fight lengths now
   land at 16-52s, i.e. at the SHORT end of the 45-90s target. If that reads as
   too brisk in play, the honest lever is more mechanics per fight, not more HP.
7. **The one thing still blocking §4.4 end-to-end**: the sim reads and
   maintains the cross-run boss memory, but the HOST has to write
   `state.bossLineup` / `state.bossDefeats` into `SavedProgress.bosses` at its
   checkpoint. Until it does, anti-repeat and "it remembers you" are inert —
   everything else in §4 works from the seed alone.
