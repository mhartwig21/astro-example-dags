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
| **Knockback/pull** | Impulse on players/monsters, `mass`-scaled, wall-clipped | new `applyImpulse` next to `moveWithCollision` (game.ts) | Pit Digger, Line Worker, Vine Lasher, boss slams |
| **Beam telegraph** | Line hazard: arm (thin tracking line) → fire (piercing) | `Hazard` gets a line shape (`a`,`b` endpoints) alongside circles | Quality Control, Archivist, Boom Operator |
| **Generalized auras** | Radius buff/debuff carried by a monster (chilling is the hardcoded prototype) | `Monster.aura?: AuraKind`, ticked where chilling ticks (ai.ts) | Drum Sergeant, Last Rites zone, The Darling |
| **Second stage** | Swap `kind`/model/stats at an HP or timer threshold, announced | small branch in `damageMonster` + `MonsterKind` morph map | Understudy Wolf, Suit Actor, enrage variants |
| **Directional guard** | Frontal arc damage reduction while guarding | angle check in `damageMonster` vs `Monster.facing` | Shieldbearer Husk, late-band elites |
| **Burrow/relocate** | Untargetable traverse, moving ground ripple telegraph, eruption | monster phase flag + a traveling `Hazard` marker | The Thing in the Pipes, phantom variants |
| **Synced pack windup** | Squad members hold fire until all are wound up, release together | pack id already exists (spawn packs); gate `beginWindup` release | Wind-Up Battalion |
| **Riposte stance** | Timed window: melee hits during it reflect + stagger the attacker | flag checked in `damageMonster`, reuses thorns math | Featured Extra, duelist elites |
| **Flee brain** | Path AWAY from players toward a door; despawn (with consequences) on exit | inverse of chase steering (ai.ts) | The Repo Rat, gag mobs |

The tenth verb is free: **player-verb monsters**. RIVALS mode already runs
hostile bot crawlers with dash/bolt/nova through the same intent pipeline —
the Canceled Crawler elite just wears that plumbing as a monster.

## The roster — six bands, a cast per band

The 12 shipped archetypes stay the spine (grunt, swarmer, brute, ranged,
bomber, shaman, phantom, charger, spitter, necromancer, broodmother, boss).
Each band adds 3–6 **band-locked specialists** so descent keeps introducing
new problems. Format: **Name** (model · rig · brain) — the move, *the counter*.

### THE UNDERCROFT (floors 1–3) — the tutorial gets teeth

- **The Cutpurse** (Skeleton_Rogue · medium · new: lunge-stab) — short
  telegraphed dash-strike that STEALS gold on hit; it pockets the purse and
  gets +speed. Killing it refunds everything with interest. *Counter: sidestep
  the thin lunge lane; never let it disengage.* First taste of skillshot
  dodging, stakes in show-economy currency, floor-1 safe (steals, never spikes).
- **The Ossuary Warden** (Skeleton_Golem · **large** · brute+) — slow vault
  guardian; its slam leaves a lingering bone-shard ring (hazard) so each swing
  reshapes the room. High mass: it body-blocks doorways. *Counter: fight it in
  the open, never in the corridor it wants.*
- **The Pit Digger** (Caveman · medium · new: knockback debut) — huge club
  windup (0.9s, longest in the band) that LAUNCHES you on hit. Near-zero damage
  on floor 1–3 — the knockback IS the lesson, before deeper bands combine it
  with hazards. *Counter: it's the slowest tell in the game; walk away.*

### THE SEWERS (floors 4–6) — packs learn teamwork

- **The Drum Sergeant** (OrcRaider + wardrum prop · medium · new: aura) —
  support mob: beats a war-drum that FRENZIES its pack (attack speed + move
  speed aura, visible ring). Worth ~nothing itself. *Counter: kill the drummer
  first — the game's first kill-order test.*
- **The Thing in the Pipes** (Monster · medium · new: burrow) — submerges,
  becomes an untargetable ripple that stalks you, erupts in an armed AoE.
  *Counter: the ripple is slower than you; keep moving, punish the eruption
  recovery.* The Rek'Sai fantasy, sewer-flavored.
- **The Repo Rat** (Hoarder · medium · new: flee brain) — spawns clutching a
  loot sack, runs the moment it's seen, drops a gold trail as it bleeds. If it
  reaches a door it ESCAPES with the floor's vault bonus. *Counter: burst it —
  mobility skills finally have a chase.* The Diablo treasure-goblin dopamine,
  and it makes the owner's beloved mobility kit the right tool.

### THE GARDEN (floors 7–9) — the floor fights back

- **The Moon-Cursed Understudy** (Werewolf_Man → Werewolf_Wolf · medium ·
  new: second stage) — shuffling extra in man-form; at half HP it
  TRANSFORMS (announced, 1s vulnerable morph) into a full charger with
  restored HP. *Counter: burst through the threshold or stagger the morph —
  or fight the wolf you made.* Two models, one mob, pure drama.
- **The Briar Witch** (Tiefling · medium · caster) — curses one crawler:
  a vine MARK (+30% damage taken, 6s, visible ring). The pack suddenly cares
  about the marked player. *Counter: break line of sight to interrupt the
  cast; in co-op, peel for the marked.* First target-priority mechanic
  pointed at the PARTY.
- **The Vine Lasher** (PlantWarrior alt-texture · medium · new: pull) — cone
  sweep, then a whip-HOOK along a thin lane that drags you to it — into
  whatever the Garden has underfoot. *Counter: the hook telegraphs longest of
  any lane; dash breaks the drag.* The Blitzcrank moment, and roots/pools make
  every landing spot matter.

### THE RUINS (floors 10–12) — the dead civilization drills you

- **The Shieldbearer Husk** (Paladin, helmeted variant as elite skin · medium ·
  new: directional guard) — tower-shield zealot: near-immune from the front,
  normal from behind. Advances in a slow phalanx step. *Counter: flank it,
  displace it, or put a wall of your own pack-mates between you — footwork
  as damage multiplier.*
- **The Last Rites Cleric** (Cleric · medium · shaman++) — consecrates ground:
  a zone that HEALS monsters and burns crawlers, contested-space chess.
  *Counter: fight outside it, kill the cleric, or stand in it anyway and
  race the math.*
- **The Archivist** (Lorekeeper · medium · new: beam) — channels a sweeping
  beam that rotates toward you with audible pace; the first monster whose
  attack you dodge CONTINUOUSLY rather than once. *Counter: walk the sweep's
  speed, or stagger the channel (poise) — the interrupt button finally sings.*
- **The Foundation** (4GTN · **large** · brute++) — animate masonry. Ground-
  slam sends a traveling CRACK down a lane (fissure hazard that erupts
  sequentially, like flame sweep at mob scale). 4GTN_Forgotten is its ruined
  elite skin. *Counter: perpendicular movement; the crack can't turn.*

### THE IRONWORKS (floors 13–15) — the machine learns your timing

- **The Line Worker** (Robot_One · medium · grunt+knockback) — piston punch
  with a hydraulic hiss tell; the punch LAUNCHES you meaningfully now, and
  Ironworks floors carry grate/spike dressing worth being launched into.
  *Counter: never fight with your back to the set dressing.*
- **Quality Control** (Robot_Two · medium · new: lock-on beam) — paints you
  with a thin tracking laser (1.2s, lags your movement), then fires a
  piercing railshot along the locked line. *Counter: juke at the lock click,
  not before — a timing test, not a position test.* The Caitlyn-ult dodge,
  every pack fight.
- **The Slagbreaker** (Clanker · **large** · new: rhythm brute) — steam brute
  with a heat gauge: three swings, then it MUST vent — a scalding burn cone
  followed by 1.5s of staggered cooldown. *Counter: count to three, dodge the
  vent, unload into the window. Vulnerability rhythm as a core loop.*
- **The Greeter** (Animatronic_Normal, _Creepy as elite skin · medium ·
  ambusher+) — stands among the props, perfectly still (ambush dormancy
  exists), activates with a doo-doo-doo jingle when flanked or approached. On
  death: sparks — three quick arc zaps at short range (on-death punctuation).
  *Counter: notice it (fog + prop literacy), pull it from range.*
- **The Wind-Up Battalion** (ToySoldier · medium · new: synced volley) —
  spawns only in squads of 4–6; all members hold their musket windup until
  the squad is ready, then FIRE AS ONE announced volley. *Counter: one dash
  beats six bullets — the game's most cinematic single dodge; break the squad
  and survivors fire ragged and weak.*

### THE APPROACH (floors 16–18) — the System fields its own

- **The Stagehand** (Ninja · medium · phantom++) — blinks in, two fast hits,
  smoke-bombs OUT to a marked re-entry point (the mark is your telegraph).
  *Counter: hold the re-entry, make it land into your nova.* Hit-and-run that
  teaches prediction instead of reaction.
- **The Boom Operator** (Marksman · medium · new: cross-room lane) — sniper:
  laser-thin lane across half the arena, heavy hit, long re-aim during which
  it relocates. The whole room becomes cover-and-angles. *Counter: use the
  relocate window; the lane never fires twice from one spot.*
- **The Featured Extra** (AvianSwordsman · medium · new: riposte) — duelist
  that periodically takes a FLOURISH stance (blade up, 0.8s): melee into it
  gets riposted (reflect + brief self-stagger). *Counter: hold the swing —
  hardest thing to teach an ARPG player — or shoot it; flourish only answers
  melee.*
- **The Darling** (MagicalGirl · medium · new: aura, kill-order boss-let) —
  the System's current favorite. Projects a stardust shield over her
  entourage (they take −50% while she lives); she takes +50% (glass idol).
  *Counter: the game states the kill order and dares you to execute it inside
  her entourage's screen.*
- **The Canceled Crawler** (Superhero · medium · player-verb elite) — a
  former favorite, kept as security. Runs the RIVALS bot brain: dashes with
  i-frames, bolts, novas on YOUR cooldown grammar. *Counter: everything you'd
  do to a player — bait the dash, punish the nova recovery.* PoE's rogue
  exiles; the mirror-match spike the endgame deserves.
- **The Suit Actor** (Monster → MonsterCostume · medium · gag splitter) — a
  monster that, on death, unzips: a terrified guy in a costume crawls out
  (weak, flees, worth hype not XP; letting him go is worth MORE hype).
  *Counter: none needed — it's a mercy test on camera.* Pure DCC.

**Count: 24 new + 12 shipped archetypes = 36 distinct mobs**, before elite
affixes multiply looks (most models ship 2+ alternate textures for recolors).

## Elite affix expansion (PoE soul, Diablo grammar)

Current nine: swift, shielded, volatile, summoner, splitter, thorns, armored,
warded, chilling. Add six — each one sentence of counterplay:

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

## Pack composition — spawn templates

Singles-with-weights can't express "drummer + three raiders." Add seeded
**pack templates** per band to `spawnMonsters` (config-driven, like
FLOOR_BANDS): e.g. UNDERCROFT `[warden + 2 minions]`, SEWERS
`[sergeant + 3 raiders]`, IRONWORKS `[2 workers + QC]`, APPROACH
`[darling + 4 toys]`. Each template is a composed encounter with a built-in
kill-order question. Solo specialists (Repo Rat, Thing in the Pipes) keep
spawning as singles.

## Shipping order (each wave is one PR-sized bite)

1. **Verbs first** (knockback + beam + aura + flee — 4 small sim mechanics,
   fully unit-testable, zero models needed).
2. **Sewers + Ironworks casts** (6 mobs) — they exercise all four verbs and
   those bands are the most visually starved today.
3. **Elite affix six-pack + pack templates** — multiplies the existing AND
   new cast at zero model cost.
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
