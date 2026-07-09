# Mob concepts — the full cast

Design research for scaling the bestiary from 12 archetypes to a **36+ mob
cast** with real boss variety (proposed 2026-07-08, none implemented yet).
Companion to ABILITY-CONCEPTS.md; models come from the owned CC0 pool in
KAYKIT-INVENTORY.md — **zero asset spend**. Delete sections as they ship.

The brief: combat that chases what League, Diablo, and Path of Exile do well.
Distilled into rules this codebase can actually express:

1. **Skillshots with commitment** (LoL). The telegraph system already makes
   every hit dodgeable; the gap is SHAPE variety. Today: circles, cones,
   lanes-by-charge. Missing: beams that sweep, arcs that rain, shots that
   track-then-lock. A monster that aims is a monster you outplay.
2. **Displacement is drama** (LoL). Nothing in the game moves the PLAYER.
   Hooks, knockbacks, and pulls turn positioning from prophylaxis into a
   minigame — one `applyKnockback` respecting `mass` and walls unlocks a
   dozen designs, and it composes with every existing hazard (knocked INTO
   the sludge is a story).
3. **Pack roles create kill-order decisions** (PoE). A drummer buffing a mob
   pack, a cleric consecrating ground, an idol shielding her entourage — the
   fun isn't the support mob, it's the half-second where you choose who dies
   first. Spawn TEMPLATES (support + threats), not just weighted singles.
4. **Vulnerability rhythm** (Diablo bosses, LoL laning). Monsters that
   overheat, vent, reload, or flourish give combat a beat you learn to
   dance to. Poise/stagger is a full shipped system — more designs should
   open with it.
5. **On-death punctuation** (PoE, D3). Volatile exists; the principle
   generalizes: deaths that leave one last decision (a fuse, a split, a
   gag reveal) keep the screen alive after the kill.
6. **Counterplay legibility above all** (house rule). Every design below
   names its counter: dash it, flank it, interrupt it, out-range it, or
   kill its friend first. If we can't name the counter, it doesn't ship.

## New sim verbs (build once, reuse everywhere)

Nine mechanics power the whole roster. Each is a small, deterministic,
host-agnostic addition — feedback flows out as data like everything else.

| Verb | What it is | Seam | Unlocks |
|---|---|---|---|
| ~~**Knockback**~~ | **SHIPPED 2026-07-08**: `applyPlayerKnockback` (game.ts) — queued shove consumed at `knockbackSpeed` through moveWithCollision; brute/boss slams shove survivors | — | Pit Digger, Line Worker, Vine Lasher (pull variant still open) |
| ~~**Beam telegraph**~~ | **SHIPPED 2026-07-08**: `Hazard.kind: "beam"` (pos→`end`, arm → fire once → fade), rendered in both hosts; lock-on tracking (`trackId`) shipped with the sentinel | — | Archivist, Boom Operator reuse the seam |
| ~~**Generalized auras**~~ | **SHIPPED 2026-07-08**: `Monster.aura: "frenzy"` radiates in ai.ts (drum* knobs); cooldown-decay haste + move speed | — | Last Rites zone, The Darling (new aura kinds on the same seam) |
| ~~**Second stage**~~ | **SHIPPED 2026-07-08**: "morph" windup swaps kind/stats (understudy → charger); renderer rebuilds the mesh on kind change | — | Suit Actor, enrage variants reuse the seam |
| **Directional guard** | Frontal arc damage reduction while guarding | angle check in `damageMonster` vs `Monster.facing` | Shieldbearer Husk, late-band elites |
| **Burrow/relocate** | Untargetable traverse, moving ground ripple telegraph, eruption | monster phase flag + a traveling `Hazard` marker | The Thing in the Pipes, phantom variants |
| ~~**Synced pack windup**~~ | **SHIPPED 2026-07-08**: `Monster.squadId` + leader-cadenced squad windups (toysoldier brain) | — | any future squad mob reuses the seam |
| **Riposte stance** | Timed window: melee hits during it reflect + stagger the attacker | flag checked in `damageMonster`, reuses thorns math | Featured Extra, duelist elites |
| ~~**Flee brain**~~ | **SHIPPED 2026-07-08**: filcher brain in ai.ts — flees on notice, escape timer past `filcherEscapeDist` | — | gag mobs reuse the brain |

The tenth verb is free: **player-verb monsters**. RIVALS mode already runs
hostile bot crawlers with dash/bolt/nova through the same intent pipeline —
the Canceled Crawler elite just wears that plumbing as a monster.

## The roster — six bands, a cast per band

The 12 shipped archetypes stay the spine (grunt, swarmer, brute, ranged,
bomber, shaman, phantom, charger, spitter, necromancer, broodmother, boss).
Each band adds 3–6 **band-locked specialists** so descent keeps introducing
new problems. Format: **Name** (model · rig · brain) — the move, *the counter*.

### THE UNDERCROFT (floors 1–3) — ~~the tutorial gets teeth~~ SHIPPED 2026-07-08

The trainer trio shipped as sim kinds `cutpurse` / `warden` / `digger`,
gated floor 2+ — **floor 1 stays pristine** (a spawn-invariant test now
enforces zero specialists of ANY band there). The cutpurse's lunge draws a
lane telegraph and STEALS gold into its purse (generic carry-drop refunds
with interest — the Repo Rat's seam, generalized); the warden's slam leaves
a `shards` hazard zone (new lingering-zone kind, physical, no poison soak);
the digger reuses the punch resolve with a bigger, gentler launch —
knockback in training dosage, three floors before hazards make it hurt.

### THE SEWERS (floors 4–6) — packs learn teamwork

- ~~**The Drum Sergeant**~~ — **SHIPPED 2026-07-08** (`drummer` kind: escort
  slot from floor 4+, frenzy aura, weak cornered swing; OrcRaider model with
  the wardrum + stick grafted, drumming loop while parked). Still open from
  the concept: a visible aura ring on the buffed pack.
- **The Thing in the Pipes** (Monster · medium · new: burrow) — submerges,
  becomes an untargetable ripple that stalks you, erupts in an armed AoE.
  *Counter: the ripple is slower than you; keep moving, punish the eruption
  recovery.* The Rek'Sai fantasy, sewer-flavored.
- ~~**The Repo Rat**~~ — **SHIPPED 2026-07-08** (`filcher` kind: one per most
  ordinary floors 4+, carries floor-scaled gold, bleeds a coin per HP quarter,
  drops the purse on death, escapes for good after `filcherEscapeSeconds`
  safely away; Hoarder model).

### THE GARDEN (floors 7–9) — ~~the floor fights back~~ SHIPPED 2026-07-08

The whole band shipped as sim kinds `understudy` / `hexer` / `lasher` (floor
7+ spawn weights). The understudy morphs into a fresh CHARGER via the
second-stage verb (kind swap + renderer mesh rebuild + KayKit's
EXPERIMENTAL_Medium_Transform clip); the hexer's mark is `Player.cursedT`
(+30% damage taken, spinning purple hexagon under the marked crawler); the
lasher's hook DRAGS along a rendered lane telegraph (uncapped pull through
the knockback verb), and it never brawls — crowd it and it slinks back to
whip range. Bonus from the lane work: CHARGER rushes now draw their actual
lane too, not a circle. Still open: hook targeting bias toward allies (the
Hook Squad glue) and Briar-Witch line-of-sight interrupt.

### THE RUINS (floors 10–12) — ~~the dead civilization drills you~~ SHIPPED 2026-07-08

The whole band shipped as sim kinds `shieldbearer` / `cleric` / `archivist` /
`colossus` (floor 10+ weights). The shieldbearer's frontal guard lives in
damageMonster (guard drops mid-swing/stagger; guarded hits render dim like
resists; it carries a grafted tower shield and holds the Blocking loop while
parked). The cleric's consecration is a `consecrate` hazard zone (heals
monsters, burns crawlers). The archivist's sweep is a rotating `beam` hazard
bound to its caster — stagger or kill the Archivist and the beam dies
mid-arc. The colossus fissure is a lane of staggered blast eruptions locked
at slam commit. Paladin_with_Helmet and 4GTN_Forgotten ride the elite-skin
seam. Still open: displacement interacting with the phalanx (knockback on
monsters is player-ability-side today).

### THE IRONWORKS (floors 13–15) — ~~the machine learns your timing~~ SHIPPED 2026-07-08

The whole band shipped as sim kinds `lineworker` / `sentinel` / `slagbreaker`
/ `toysoldier` / `greeter` (floor 13+ spawn weights; toysoldiers muster as
squads with a shared `squadId`; greeters ALWAYS spawn dormant and play the
Inactive standing pose — dormant ambush packs everywhere now lie on the floor
in the Inactive floor pose). Animatronic_Creepy rides the new elite-skin seam
(`monster_<kind>_elite` in MODEL_MANIFEST). Punch/aim/vent windups map to the
unarmed-punch, aiming-idle, and 2H-spin clips. Still open from the concepts:
the Greeter's activation jingle (audio seam) and Ironworks grate/spike floor
dressing for the punch to launch people into.

### THE APPROACH (floors 16–18) — ~~the System fields its own~~ SHIPPED 2026-07-09

The finale cast shipped as sim kinds `stagehand` / `sniper` / `duelist` /
`darling` / `canceled` / `suitactor` (+ the spawned-only `suitguy`), floor
16+ weights. The stagehand smoke-bombs after two swings to a marked re-entry
blast; the sniper's lane is locked at cast and it relocates before it can
fire again; the duelist's riposte reads ONLY melee (a `melee` flag on the
swing choke points) and holds the blade-up pose; the darling's shield aura +
glass-idol multipliers live in damageMonster (dim numbers on sheltered
hits); the canceled runs sidestep dashes + a nova-slam on player-ish
cadences; and the suit actor unzips in reapDead — the fleeing suitguy pays
the whole party hype if he escapes (killing him pays 0 hype; the crowd
boos). Still open from the concepts: the canceled using the full RIVALS bot
brain (today it's an idiomatic imitation, not the real intent pipeline).

**ROSTER COMPLETE: all 24 concept mobs + 12 original archetypes = 36
distinct monster kinds are now LIVE**, before elite affixes and skins
multiply looks. What remains from this doc is composition: elite affix
six-pack, the pack playbook, champions, and the boss layers.

## Elite affix expansion (PoE soul, Diablo grammar) — SHIPPED 2026-07-09

All six landed in the elite roll pool (15 affixes total), each with a
semantic glow tint: linked (pack soaks half of every hit while allies
stand), vampiric (drinks landed melee), juggernaut (stagger+knockback
immune, −25% speed), mortar (arcing shells over walls, min-range
counterplay), berserking (self-sustaining frenzy below half via the drum
plumbing), executioner (+50% vs crawlers under 40%). The original six-pack
sketch, for the record:

- **linked** — pack-mates share incoming damage while the linked elite lives
  (kill-order pressure without a support model).
- **vampiric** — heals off landed hits; starve it by not getting hit (it
  makes dodging worth double).
- **juggernaut** — immune to stagger/knockback, −25% speed; your CC is void,
  your kiting isn't.
- **mortar** — lobs slow arcing shells over walls (arc telegraph lands as an
  armed circle); cover stops being safe.
- **berserking** — below 50% HP: +speed, +attack speed, −armor; finish what
  you start.
- **executioner** — +50% damage vs crawlers under 40% HP; retreat thresholds
  become real decisions.

## Boss variety — four layers

**Layer 1: Champions (the missing tier).** Between named elites and band
bosses: one seeded CHAMPION per non-boss floor, a band-themed mini-arena
fight with a signature-lite and a guaranteed reward (material/component).
Candidates from the untapped pool: **The Foreman** (CombatMech, Ironworks),
**The Ratings Grab** (Monstrosity — custom rig, verify clips first; Approach),
**The Pack Alpha** (Werewolf_Wolf oversized, Garden), **The Debt Collector**
(Skeleton_Golem named, Undercroft). Diablo's purple-name dopamine, and a
pacing beat between band bosses. Seam: the elite spawn path + a small arena
carve like vaults.

**Layer 2: Signature stacking (backlog #1, generalized).** Band bosses
currently run ONE signature for the whole fight. Give every boss a phase
SCRIPT: phase 2 adds a second signature borrowed from an earlier band, phase 3
overlaps both. The finale runs the greatest-hits reel (backlog already wants
this — same dispatch, extended). Fights escalate in mechanics, not just stats.

**Layer 3: Arena directors.** Each boss arena gets ONE environmental script
that runs independent of the boss — the Sump King's arena FLOODS from the
edges as the fight runs (shrinking safe ground, collapse-clock in miniature);
the Furnace Marshal's wall vents exhale flame rows on a rhythm; the Topiary
Warden's arena regrows a root maze every 45s. The boss + the room is the
fight. Seam: a per-arena tick hook next to the signature dispatch.

**Layer 4: New boss FORMATS (pick 2–3, don't ship all):**
- **The Duo** — two mid-HP bosses with complementary kits (QA Team:
  Robot_One tank + Robot_Two sniper); when one dies the other ENRAGES.
  Kill-order at boss scale, brutal in the best way.
- **The Council** — three champion-grade elites introduced TOGETHER
  (RINGSIDE handles it — "THE PANEL WILL SEE YOU NOW"). Cheaper than a real
  boss, reads completely different.
- **The Commercial Break** — any boss, at each phase edge, becomes briefly
  untargetable while the arena reshuffles (adds sweep in, hazards clear and
  re-arm) and the ticker sells ad time. A breather that re-deals the board —
  and pure DCC television.

## The pack playbook — abilities that set each other up

Singles-with-weights can't express "drummer + three raiders." The deeper
point: the mobs above are solo acts; PACKS are where their abilities become
combos — the monster-side mirror of the owner's stated player-kit taste
("press multiple buttons to set up attacks"). One mob creates the condition,
another cashes it in.

**Design rules for packs:**
- **One question per pack.** Kill order, positioning, OR timing — never all
  three. A pack that asks two questions is two packs.
- **Setup telegraphs before payoff lands.** The hook winds up before the
  brute's axe does; readable combos, or it's just noise.
- **Two answers minimum.** Every pack must be beatable by at least two build
  archetypes (melee answer + ranged answer), or it's a gear check.
- **Budget-neutral.** A template SPENDS the floor's existing monster budget
  (density/count knobs unchanged) — packs recompose difficulty, they don't
  add it.
- **Synergy is mostly spatial, not coded.** Formation offsets + facing at
  spawn (shields front, drummer center, sniper rear) produce 80% of the
  combo. Only two designs need explicit AI glue, flagged below.

Seam: a per-band template table in config (like FLOOR_BANDS), consumed by
`spawnMonsters`; each template lists members with formation offsets. Seeded
pick per pack site. Solo specialists (Repo Rat, Thing in the Pipes) stay
singles.

### The playbook (2 per band, flagship first) — SHIPPED 2026-07-09

Live as `PACK_TEMPLATES` in config.ts, consumed by spawnMonsters: 35% of
pack rolls muster a band template (floor 3+ — the contract floors stay
loose; a clustered floor-2 Reception provably killed the bot). Formation
offsets place supports rear/center; toysoldier members share a squadId,
greeters spawn dormant. Substitutions from the concepts: Ambush Plumbing
(needs the unshipped Thing in the Pipes) became The Acid Choir; three
late-run Reruns shipped as Approach templates. The original designs:

**THE UNDERCROFT — training combos (the tutorial teaches teamwork too)**
- **The Reception** `[Ossuary Warden + 2 Skeleton Minions + Cutpurse]` — the
  Warden plugs the doorway, minions harass, the Cutpurse lunges for your
  purse while you're wedged. *Question: positioning — back out, fight in the
  open you chose.*
- **Grave Shift** `[Pit Digger + Skeleton Mage]` — the club launches you into
  the mage's bolt line. Training-dosage displacement-into-projectile: the
  combo every later band escalates. *Question: positioning.*

**THE SEWERS — kill-order kindergarten**
- **The Drumline** `[Drum Sergeant + 3 Orc Raiders]` — frenzied raiders are
  scary; the drummer making them frenzied is worth nothing himself.
  *Question: kill order — the game's first "shoot the healer" moment.*
- **Ambush Plumbing** `[Thing in the Pipes + 2 Spitters]` — acid puddles
  herd you onto the only clean ground; the ripple is already stalking it.
  Zone denial hands the burrower its eruption spot. *Question: positioning —
  stand IN old puddle edges, take the tick, deny the ambush.*

**THE GARDEN — the hook squad band**
- **The Hook Squad** `[Vine Lasher + Briar Witch + Brute]` — the flagship
  LoL pack: Witch marks you (+damage taken), Lasher hooks you into the
  Brute's already-winding axe. Full Blitzcrank-Morgana-Darius. Needs one
  line of AI glue: *the Lasher prefers hook angles that land you near
  allies* (targeting bias, not choreography). *Question: timing — break LoS
  on the witch, dash the hook's long telegraph.*
- **Moonlit Understudies** `[2 Werewolf_Man + Shaman]` — a weak-looking pack,
  but the shaman heals the shufflers back ABOVE their transform threshold.
  Burst them through it, or kill the shaman, or fight two wolves.
  *Question: kill order, with a countdown.*

**THE RUINS — formation warfare**
- **The Procession** `[2 Shieldbearer Husks + Last Rites Cleric + Archivist]`
  — the raid-lite flagship: shields advance in phalanx, cleric consecrates
  the ground UNDER them, Archivist beams over their heads. Frontal assault
  fails three ways; flanking collapses all of it at once. *Question:
  positioning — the pack is a fortress with exactly one blind side.*
- **Falling Masonry** `[The Foundation + Necromancer]` — fissure lanes crack
  the room while the necromancer raises everything that dies in them. Your
  own kills feed the second wave. *Question: kill order — necro first, or
  drown in your own efficiency.*

**THE IRONWORKS — timing collision**
- **The Assembly Line** `[2 Line Workers + Quality Control]` — the signature
  Ironworks combo: piston punches launch you mid-juke, and QC's lock-on
  punishes exactly the movement the punch forced. Needs the second line of
  AI glue: *QC's lock decays slower against recently-displaced targets*.
  *Question: positioning — never let a worker stand between you and the
  laser.*
- **Shift Change** `[Slagbreaker + Wind-Up Battalion]` — the battalion syncs
  its volley to the Slagbreaker's vent window: the moment you want to unload
  into the stagger is the moment six muskets fire. Punish the vent OR dodge
  the volley — the fight asks you to choose every cycle. *Question: timing.*

**THE APPROACH — finals week**
- **The Entourage** `[The Darling + 4 ToySoldiers + Featured Extra]` — 
  shielded toys volley in sync, a riposte duelist bodyguards the idol, and
  the only correct target takes +50% damage if you can reach her.
  Kill-order finals: the answer is stated, the execution is the exam.
  *Question: kill order.*
- **The Crew** `[Boom Operator + Stagehand]` — the sniper lane forces you to
  move; the assassin punishes movement. Hammer and anvil at range — hold the
  Stagehand's re-entry mark while walking the lane's re-aim window.
  *Question: timing.*

### Late-run remixes (floors 16–18)

The System airs RERUNS: Approach floors seed one cross-band remix pack per
floor, pulling earlier specialists into new pairings — *Drum Sergeant +
Wind-Up Battalion* (frenzied synced volleys), *Vine Lasher + Slagbreaker*
(hooked into the vent cone), *Briar Witch + Boom Operator* (marked for the
lane). Familiar mobs, new questions — the endgame reads as a season finale
clip show that fights back.

### Elite affixes × packs (the multiplication table)

Affixes roll on pack LEADERS and recolor the whole question: a **mortar**
Drum Sergeant shells you from behind his raiders; a **linked** Darling makes
the stated kill order a lie until the link breaks; a **juggernaut**
Shieldbearer can't be displaced out of the phalanx. One seeded affix per
pack leader, floor 8+, never two auras in one pack (readability rule).

## Shipping order (each wave is one PR-sized bite)

1. **Verbs first** (knockback + beam + aura + flee — 4 small sim mechanics,
   fully unit-testable, zero models needed).
2. **Sewers + Ironworks casts** (6 mobs) — they exercise all four verbs and
   those bands are the most visually starved today.
3. **Elite affix six-pack + the pack playbook** (templates land with the
   bands whose members have shipped; The Drumline and The Assembly Line
   first) — multiplies the existing AND new cast at zero model cost.
4. **Undercroft/Garden/Ruins/Approach casts** in band order (the remaining
   18), champions landing with their band.
5. **Boss layers 2–3** (signature stacking + arena directors), then ONE new
   format (recommend the Duo) as its own event.

**Balance contract:** the bot must still clear floors 1–2 (balance.test.ts is
the gate). New mobs are floor-gated like the shipped specialists (Cutpurse 2+,
nothing new on floor 1), knockback appears in TRAINING dosage (Pit Digger)
three floors before it appears with hazards to be knocked into (Line Worker).
Every new verb gets a sim test the day it lands; every new mob gets a line in
the spawn-mix tests. Add one balance test per band: "the bot survives the
band's template pack at the band's median build."

## Model logistics (one afternoon, batched)

All 20 new characters are self-contained GLBs in the collection zip (census +
extraction recipe in KAYKIT-INVENTORY.md). Every one is medium/large rig —
they inherit the full animation state machine via `CHARACTER_RIGS`; only
Monstrosity needs rig verification before its champion ships. Alt-texture
elite skins (Paladin helmeted, Animatronic_Creepy, 4GTN_Forgotten) are free
variant rows in `MODEL_MANIFEST`. Record each pack row in ASSETS.md and flip
the KAYKIT-INVENTORY row from untapped to used as they land.
