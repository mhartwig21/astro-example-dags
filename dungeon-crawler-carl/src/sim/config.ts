// Central tunables for the vertical slice. Kept in one place so balance is easy to tweak
// and so the sim has no magic numbers scattered through it.

export const CONFIG = {
  finalFloor: 18,

  // Grid / world. Floors are roomy: a 64x64 grid with more/larger rooms and
  // two-tile-wide corridors, sized for parties fighting side by side.
  tile: 32, // pixels per tile (render); sim positions are in tile units (floats)
  floorMinRooms: 10,
  floorMaxRooms: 16,
  floorGridW: 72,
  floorGridH: 72,

  // Collapse timer (seconds). Floor 1 is generous; deeper floors tighten.
  // Budgets account for the larger floors (longer traversal to the stairs).
  timerBaseSeconds: 120,
  timerPerFloorFalloff: 2.5, // seconds shaved per floor descended
  timerMinSeconds: 60,
  warningFraction: 0.4, // enter WARNING when remaining < 40% of the floor's budget
  collapseDpsBase: 6, // damage/sec at start of collapse
  collapseDpsRamp: 4, // extra damage/sec added for each second spent in collapse

  // Player
  playerMaxHp: 100,
  playerSpeed: 4.2, // tiles/sec
  playerAttackRange: 1.3, // tiles
  playerAttackCooldown: 0.4, // seconds
  playerBaseDamage: 12,
  playerAttackArc: Math.PI / 2, // 90° swing in facing direction
  playerCritChance: 0.18,
  playerCritMult: 2.0,
  // Armor (defense): incoming hits are reduced by armor/(armor+armorK), capped.
  // The player starts with none — mitigation is a GEAR story (armor-slot items
  // roll it as their primary affix), so the sheet's DEFENSE panel is earned.
  playerBaseArmor: 0,
  armorK: 60, // 60 armor = 50% reduction; diminishing returns past that
  armorMaxReduction: 0.6, // even a fortress crawler eats 40% of every hit
  meleeLungeDistance: 0.45, // tiles the swing steps toward the aim (aggression + reach)

  // Hit reactions: player damage shoves monsters (divided by archetype mass) and
  // builds poise damage; crossing maxHp * poise staggers them (interrupting any
  // windup and freezing them briefly). Chaff flinches constantly; brutes shrug.
  meleeKnockback: 0.3, // tiles
  boltKnockback: 0.15,
  novaKnockback: 0.7,
  airstrikeKnockback: 0.5,
  shockstepKnockback: 0.4,
  // Shockstep damages a CAPSULE along the whole dash path (launch -> arrival),
  // this wide — dashing THROUGH a pack is the point.
  shockstepPathRadius: 1.0,
  staggerDuration: 0.22, // seconds a staggered monster is helpless
  elitePoiseMult: 1.5, // elites resist stagger (and knockback) this much harder

  // Enemy attack telegraphs: every monster attack winds up (per-archetype, see
  // ARCHETYPES.windup) before the strike resolves. The strike re-checks range
  // (+grace) and dash i-frames, so danger is READABLE and DODGEABLE — which is
  // why monster damage below runs much hotter than the old instant-hit numbers.
  monsterStrikeGrace: 0.35, // extra tiles beyond attackRange a strike still reaches
  bomberFuse: 0.5, // seconds between contact trigger and detonation (the dodge window)

  // Feature switches (code paths stay intact so these can toggle cleanly).
  flaskEnabled: true, // Sponsor Slurp™ flask: kill-credit sustain loop (re-enabled with the status pass)
  achievementsEnabled: true, // unlocks + safe-room ACHIEVEMENTS tab (off = hidden)

  // Sponsor Slurp™ flask: charge-gated heal, refilled by KILLS — aggression is
  // the sustain loop, so the way out of danger is through the pack.
  flaskMaxCharges: 3,
  flaskHealFraction: 0.35, // of max HP per chug
  flaskKillsPerCharge: 8, // kill credit needed to refill one charge (only below max)

  // Crowd Frenzy: sustained hype makes the crawler literally faster (the show
  // economy feeding back into combat). Enter/exit thresholds live in show{}.
  frenzyMoveMult: 1.12,
  frenzyCooldownMult: 0.85, // melee/bolt/nova cooldowns + dash recharge

  // Status effects (DESIGN 5.13; framework in status.ts). Exactly three:
  // burn (fast magic DoT, refreshes), poison (slow physical DoT, stacks to 3),
  // chill (no damage — the afflicted entity's clock runs slower).
  burnDuration: 3, // seconds a burn lasts (re-applying restarts it)
  burnTickSeconds: 0.5, // fast ticks — burn is the bursty DoT
  poisonDuration: 5, // seconds a poison lasts (re-applying refreshes + stacks)
  poisonTickSeconds: 1, // slow ticks — poison is the lingering DoT
  poisonMaxStacks: 3, // each stack adds a full tick's damage
  chillDuration: 2.5, // seconds a chill lasts (refresh-on-reapply)
  chillBossMult: 0.5, // bosses shrug off half the slow (never immune)
  chillSlowPerRank: 0.3, // FROST BOLTS: slow fraction per node rank (r1 = -30%)
  chillSlowMax: 0.45, // hard cap, whatever overranks roll
  novaScorchFracPerRank: 0.35, // AFTERBURN: burn total = this × nova hit per rank
  venomTickFraction: 0.12, // Venom Clause: poison tick (per stack) = this × the crit
  puddlePoisonFraction: 0.6, // spitter acid: poison tick = this × the puddle tick
  chillingAuraRadius: 3.2, // "chilling" elite: crawlers inside are slowed...
  chillingAuraSlow: 0.3, // ...by this fraction (fades ~a beat after you break away)

  // Party pings: a marked spot the whole party sees (world pulse + minimap).
  pingTtl: 6, // seconds a ping lives
  pingMaxPerPlayer: 3, // oldest ping is replaced beyond this

  // Co-op revives: stand close to a downed crawler to stabilize them. No
  // button — proximity IS the channel (the reviver pays in exposure, not APM).
  // Walking away lets the wound reopen (progress decays). Descending still
  // revives everyone at 50% as before; this is the mid-floor rescue.
  reviveRadius: 1.7, // tiles from the downed body
  reviveChannelSec: 3.5, // seconds of continuous proximity to stabilize
  reviveHpFraction: 0.35, // of max HP on revive
  reviveDecayMult: 1.5, // progress decays this much faster than it builds

  // DCC "System" loot boxes: awarded every N kills, granting an immediate buff.
  lootBoxEveryKills: 8,

  // Leveling. xpBase 20 -> 24 (play feedback 2026-07-06: a shopping player
  // hit 12 by floor-4 start — the early ramp ran ~2 levels hot). +20% cost
  // shifts the whole curve down ~half a level early, less later.
  xpBase: 24, // xp to reach level 2
  xpGrowth: 1.35, // multiplier per level
  hpPerLevel: 18,
  damagePerLevel: 3,

  // Multiplayer difficulty: per EXTRA party member (beyond the first), floors
  // spawn more monsters and each monster gets tougher. Applied at floor build
  // from the party size at that moment (drop-ins mid-floor don't retro-scale).
  mpCountPerExtraPlayer: 0.6, // +60% monster count per extra crawler
  mpHpPerExtraPlayer: 0.35, // +35% monster HP per extra crawler
  mpDamagePerExtraPlayer: 0.15, // +15% monster damage per extra crawler
  mpBossHpPerExtraPlayer: 0.75, // the boss scales harder (it is shared)

  // Monsters (density tuned for the 72x72 floors: crowded, not an empty museum).
  // The full-clear power curve outruns linear scaling by midgame, so the back
  // half leans on DENSITY (more mobs) + COMPOUNDING stats (below).
  monsterBaseCountFloor1: 25,
  monsterCountPerFloor: 11,
  monsterMaxCount: 130,
  // Diablo-style PACK spawning: monsters cluster into encounters (a pack turns
  // on you together), with a few lone wanderers between them. Bigger packs
  // matter beyond raw count: the balance bot (and a real player's attention)
  // can only fully respect ONE heavy telegraph at a time — denser packs create
  // real overlapping-danger moments instead of a queue of solo fights.
  packSizeMin: 5,
  packSizeMax: 13,
  packLoneFraction: 0.2, // share of the budget spawned as singles
  packEscortFromFloor: 4, // packs may include a shaman healer escort from here
  monsterBaseHp: 24,
  monsterHpPerFloor: 6,
  // Compounding scaling: linear per-floor growth loses to a farming player by
  // midgame (the maximalist power curve is ~quadratic). Past this floor, HP and
  // damage additionally multiply by monsterScaleCompound each floor, so the deep
  // dungeon steepens instead of flattening. Starts at floor 3 (not 1-2, which
  // stay a soft landing) so the ramp is felt well before the old floor-6 wall —
  // 1.055 pre-#10; nudged up for the six-slot gear budget, then again for the
  // ~40% win-rate difficulty pass. Backed off after merging the band-boss
  // rework (bosses every 3 floors, not 6) + monster TEMPO scaling (below) —
  // those stack with this, so this alone doesn't need to carry as much.
  monsterScaleCompoundFrom: 3,
  monsterScaleCompound: 1.08, // ~3.2x by floor 18 on top of the linear curve
  // Damage is balanced around telegraphed, dodgeable strikes: a clean hit should
  // HURT, because you saw it coming — see the ~40% target win rate in
  // scripts/balance-sweep.ts's design intent below. Leans on damage/compounding
  // rather than raw density for lethality: density also inflates kill-driven
  // XP pace and can swarm even a stationary player near spawn, which collided
  // with the leveling-curve and hype-economy test fixtures.
  monsterBaseDamage: 21,
  monsterDamagePerFloor: 4.2,
  monsterSpeed: 2.6, // tiles/sec
  monsterAttackRange: 1.0,
  monsterAttackCooldown: 0.9,
  monsterAggroRange: 8, // tiles
  monsterXp: 10,
  monsterXpPerFloor: 4,
  // Depth TEMPO (play feedback: stats alone don't scare a geared crawler).
  // Past the ramp floor, monsters get quicker on every axis — faster chase,
  // faster swings, shorter tells. Floors 1-3 keep the training-wheel pace;
  // the caps keep the deep dungeon fast but still READABLE and dodgeable.
  monsterTempoFrom: 4,
  monsterTempoSpeedPerFloor: 0.025, // +2.5% move speed per floor past the ramp...
  monsterTempoSpeedMax: 1.35, // ...capped at +35% (floor 18)
  monsterTempoCdPerFloor: 0.025, // attack cooldowns shrink per floor...
  monsterTempoCdMin: 0.65, // ...to at most 35% faster swings
  monsterTempoWindupPerFloor: 0.02, // telegraphs shorten per floor...
  monsterTempoWindupMin: 0.75, // ...but the tell stays readable

  // Broodmother: a walking nest that BIRTHS swarmers while it lives — the
  // mob that makes ignoring a pack the wrong call. Kill the mother first.
  broodSpawnCooldown: 6, // seconds between births
  broodSpawnMax: 10, // lifetime births per mother
  broodPopulationCap: 1.4, // no births past monsterMaxCount * this (runaway guard)

  // Drum Sergeant (SEWERS, floor 4+): pack escort that beats a frenzy aura.
  // Worth ~nothing itself; the buffed pack is the problem. Kill-order 101.
  drumFromFloor: 4,
  drumEscortChance: 0.4, // share of escort rolls that pick a drummer over a shaman
  drumAuraRadius: 4, // tiles: pack-mates inside get the beat
  drumAuraLinger: 0.6, // seconds the frenzy holds after leaving the radius
  drumFrenzySpeed: 1.3, // frenzied move-speed multiplier
  drumFrenzyHaste: 1.4, // frenzied attack-cooldown decay multiplier

  // Repo Rat / filcher (SEWERS, floor 4+): a fleeing loot-goblin. It spawns
  // clutching gold, bleeds a coin each HP quarter lost, drops the rest on
  // death — and if it stays safely away long enough, it ESCAPES with all of it.
  filcherFromFloor: 4,
  filcherChance: 0.55, // per ordinary floor: one rat scurries somewhere on it
  filcherGoldBase: 30, // carried gold: base + perFloor * floor
  filcherGoldPerFloor: 8,
  filcherBleedFraction: 0.15, // carry share dropped per HP quarter lost
  filcherEscapeDist: 8, // tiles from every crawler to count as "getting away"
  filcherEscapeSeconds: 9, // safe seconds before it vanishes for good

  // Knockback (MOB-CONCEPTS verb): shove distance is consumed at this speed
  // through moveWithCollision, so walls stop it. Slams shove players.
  knockbackSpeed: 12, // tiles/sec while a shove is in flight
  slamKnockback: 1.3, // tiles: brute/boss Ground Slam shove
  bossSlamKnockback: 2.0, // tiles: the boss slam hits like a truck

  // Beam hazards (MOB-CONCEPTS verb): a line telegraph that fires ONCE along
  // its whole length. The sentinel is the first spawner (below); the Approach
  // mobs (Boom Operator, the Archivist) arrive on the same seam.
  beamFadeSeconds: 0.25, // visible flash after firing

  // IRONWORKS cast (floors 13-15) — the machine learns your timing.
  ironworksFromFloor: 13,
  // Lineworker piston punch: melee that also LAUNCHES the survivor.
  punchKnockback: 1.4, // tiles
  // Sentinel lock-on: the beam TRACKS you while arming, freezes at the lock,
  // then fires. Dodge when the tracking stops — a timing test, not position.
  sentinelBeamCooldown: 5,
  sentinelBeamArm: 1.15, // seconds of telegraph (tracking + locked)
  sentinelBeamLock: 0.4, // final seconds when the line stops tracking
  sentinelBeamLength: 9, // tiles the railshot pierces
  sentinelBeamWidth: 0.38, // half-width
  sentinelBeamDmgMult: 1.4, // × monster damage
  // Slagbreaker heat rhythm: swings until it MUST vent, then pays for it.
  slagVentAfterSwings: 3,
  slagVentWindup: 0.8, // the vent telegraph
  slagVentRadius: 2.3, // scalding cloud around it
  slagVentDmgMult: 1.2, // × monster damage
  slagVentBurnFraction: 0.5, // burn total = this × the vent hit
  slagVentSelfStagger: 1.5, // seconds helpless after venting — the punish window
  // Wind-Up Battalion: squads volley as one; broken squads fire ragged.
  toysquadMin: 4,
  toysquadMax: 6,
  toysquadVolleyCooldown: 4.5,
  toysquadWindup: 1.0, // the whole line presents muskets — one big dodge
  toysquadSyncMin: 3, // members alive to keep volleying in sync
  // Greeter: sparks on death — three short-fused zaps around the chassis.
  greeterSparkCount: 3,
  greeterSparkDelay: 0.45, // fuse on each spark (dodgeable, tight)
  greeterSparkRadius: 0.95,
  greeterSparkDmgMult: 0.5, // × monster damage per spark

  // GARDEN cast (floors 7+) — the floor fights back.
  gardenFromFloor: 7,
  // Vine Lasher hook: the longest lane telegraph in the game, then the DRAG.
  lasherHookRange: 5.5, // tiles the whip reaches
  lasherHookWidth: 0.75, // lane half-width
  lasherHookCooldown: 6,
  lasherHookDmgMult: 0.8, // × monster damage on the snag
  lasherHookLandGap: 1.2, // you land this far from the lasher (in the pack)
  // Understudy morph: the vulnerable window before the wolf.
  morphWindup: 1.0, // interruptible — stagger it to stay ahead of the curve
  morphHpFraction: 0.5, // transforms when damaged below this
  // Briar Witch hex: a vulnerability mark the whole pack exploits.
  hexRange: 6,
  hexDuration: 6, // seconds marked
  hexVulnerability: 0.3, // +30% damage taken while marked
  hexCooldown: 8,

  // UNDERCROFT trainers (floor 2+ — floor 1 stays pristine for the contract).
  undercroftFromFloor: 2,
  // Cutpurse: the lunge-stab that goes for the purse.
  cutpurseLungeRange: 2.6, // tiles the dash-stab covers
  cutpurseLungeCooldown: 4,
  cutpurseStealBase: 6, // gold stolen: base + perFloor * floor
  cutpurseStealPerFloor: 2,
  cutpurseInterest: 1.25, // the refund multiplier when you catch it
  // Ossuary Warden: slam debris — a lingering bone-shard zone.
  wardenShardDuration: 5, // seconds the shards stay dangerous
  wardenShardRadius: 1.6,
  wardenShardDmgMult: 0.25, // × monster damage per tick (puddle cadence)
  // Pit Digger: the launch is the lesson, not the damage.
  diggerKnockback: 1.8, // tiles — bigger than the piston, gentler hit

  // RUINS cast (floors 10+) — the dead civilization drills you.
  ruinsFromFloor: 10,
  // Shieldbearer: the frontal guard (drops while it swings or staggers).
  guardArcCos: 0.5, // attacker within ±60° of its facing = blocked
  guardDamageTakenMult: 0.25, // the shield eats 75% of frontal damage
  // Cleric consecration: contested ground.
  consecrateDuration: 6,
  consecrateRadius: 2.0,
  consecrateHealPerTick: 6, // monster HP per puddle-cadence tick inside
  consecrateDmgMult: 0.35, // × monster damage per tick to crawlers inside
  consecrateCooldown: 9,
  // Archivist sweep: the beam that rotates.
  sweepDuration: 2.6, // seconds of channel (windup holds this long too)
  sweepRate: 1.1, // radians/sec toward the target
  sweepLength: 7, // tiles
  sweepWidth: 0.4, // half-width
  sweepDmgMult: 0.35, // × monster damage per tick on the line
  sweepCooldown: 8,
  // Colossus fissure: a crack that travels — perpendicular movement beats it.
  fissureSteps: 5, // eruptions along the lane
  fissureStepGap: 1.15, // tiles between eruptions
  fissureStepDelay: 0.16, // seconds between eruptions (the travel)
  fissureRadius: 0.9,
  fissureDmgMult: 0.8, // × monster damage per eruption

  // RIVALS (competitive race mode): up to 4 hostile crawlers, individual
  // descent through concurrent floor worlds, first FINAL-BOSS kill wins.
  // Rival kills pay XP, not loot (no naked-respawn snowball).
  rivalsReviveSeconds: 15, // downed timer before auto-revive at the floor entry
  rivalsReviveHpFraction: 0.5, // revive at half HP
  rivalsReviveGraceSeconds: 2.5, // post-revive immunity (no spawn-camping the timer)
  pvpDamageMult: 0.4, // builds are tuned vs telegraphed monsters; PvP is instant
  pkXpBase: 60, // XP for dropping a rival...
  pkXpPerLevel: 30, // ...plus this per victim level — killing the LEADER pays most

  // Roaming: SOME monsters patrol when off-duty — variety in mob behavior is
  // the point. Lone wanderers always roam, packPatrolChance of packs patrol
  // together, the rest are sentries holding their post; dormant ambushers lie
  // perfectly still, the vault guardian never leaves its treasure, and bosses
  // hold their arena. Leashed so encounters stay roughly where placed.
  packPatrolChance: 0.4, // share of (non-ambush) packs that patrol
  wanderSpeedMult: 0.55, // stroll speed, relative to combat speed
  wanderLegSeconds: 2.2, // seconds per wander leg (randomized 0.5-1.5x)
  wanderPauseChance: 0.35, // legs spent just standing around
  wanderLeash: 7, // tiles from the patrol post before the stroll drifts back

  // Loot. Builds come from PLANNING (the System Shop) now, not slot machines:
  // drops run leaner and rarer at the top end, and a slice of item drops are
  // catalog COMPONENTS — random loot that advances the build you planned.
  // 0.36 when 40% of drops were health potions; potions are gone (health
  // should be scary — see dropLoot), so this holds gear rates steady.
  lootDropChance: 0.22,
  componentDropChance: 0.35, // share of equipment drops that are catalog basics
  goldDropChance: 0.8,
  goldMin: 3,
  goldMax: 12,
  goldPerFloor: 2,
  pickupRadius: 0.8, // tiles

  // Skills
  dashDistance: 3.2, // tiles blinked
  dashDuration: 0.14, // seconds of active dash (i-frames)
  dashCharges: 2, // dashes in the tank; each recharges on its own timer
  dashCooldown: 2.2, // seconds to restore ONE charge
  boltCooldown: 0.6,
  boltSpeed: 12, // tiles/sec
  boltTtl: 1.2, // seconds
  boltDamageMult: 0.8, // unarmed/neutral bolt, relative to attack power
  projectileRadius: 0.35, // hit radius (tiles)

  // Genuine itemization (DESIGN 5.8): weapon-class hooks. Melee hooks apply to
  // swings; the bolt profile decides what pressing BOLT actually throws.
  swiftMeleeCdMult: 0.9, // Blade/Cleaver: faster swings
  heavyMeleeDmgMult: 1.3, // Maul/Axe: hits like a truck...
  heavyMeleeCdMult: 1.15, // ...swings like one too
  heavyPoiseMult: 2, // heavy swings break poise twice as fast
  reachRangeBonus: 0.5, // Spear: extra melee reach (tiles)
  boltSidearmMult: 0.6, // melee-class weapon: bolt is a thrown sidearm (attack power)
  boltBallisticMult: 1.0, // Crossbow: real bolts, full attack power
  boltBallisticSpeedMult: 1.3, // ...and they MOVE
  boltArcaneMult: 0.9, // Wand/Staff: magic missiles off spell power
  wandBoltCdMult: 0.8, // Wand: faster casts
  staffAoeRadiusMult: 1.25, // Staff: bigger nova
  chaoticBoltMult: 0.75, // the Mug does everything, badly (best school, discounted)
  tempoCooldownMult: 0.85, // "tempo" signature passive: active cooldowns run faster
  // Chase passives (store-only legendary uniques — plan three shops ahead):
  encoreOrbitTickMult: 0.75, // "encore": orbit blades tick this much faster (+1 blade too)
  skewerBonusPierce: 2, // "skewer": bolts punch through this many extra bodies
  // "choreography": stance swap resets swing + bolt cooldowns (no knob — binary)
  // "plot_armor": once per floor a killing blow leaves you at 1 HP (binary)
  leechFraction: 0.06, // "leech": heal this fraction of damage dealt...
  leechCapFraction: 0.04, // ...capped per hit at this fraction of max HP
  cancellationThreshold: 0.15, // "cancellation": execute non-elites below this HP fraction
  conduitFraction: 0.3, // "conduit": crits arc this fraction of the hit...
  conduitRadius: 3, // ...to the nearest other enemy within this many tiles
  choreographyCritBonus: 0.2, // "choreography": +crit during the post-swap surge window
  ledgerKillGold: 6, // "ledger": gold per kill credit...
  ledgerInterestFraction: 0.1, // ...plus interest on banked gold each safe room...
  ledgerInterestCap: 120, // ...capped per shop (greed compounds, but politely)
  // "phase": dash passes through walls when it reaches the far side (binary)
  // Damage rolls: every player hit rolls ±variance around its base, and the
  // WEAPON sets the dice. Swift is a metronome, heavy is a gamble per swing,
  // the Mug is a slot machine. Bare hands (and monsters) roll ±0.15.
  weaponVariance: {
    swift: 0.1, heavy: 0.3, reach: 0.15, ballistic: 0.15, arcane: 0.2, chaotic: 0.4,
  } as Record<string, number>,

  // Enemy projectiles (ranged archetype + boss)
  monsterProjectileSpeed: 7,
  monsterProjectileTtl: 2.5,

  // Bomber: waddles at the nearest player and detonates on contact (then dies).
  bomberExplodeRadius: 1.6, // tiles: blast radius of a contact detonation
  bomberExplodeDmgMult: 1.8, // blast damage relative to the bomber's damage stat
  bomberDeathRadiusMult: 0.5, // shot down before reaching anyone: half-radius danger zone

  // Shaman: keeps a standoff like ranged, but heals wounded allies instead of shooting.
  shamanHeal: 16, // hp restored to the lowest-HP wounded monster per cast
  shamanHealCooldown: 2.5, // seconds between casts
  shamanHealRange: 6, // tiles: allies it can reach
  shamanHealWindup: 0.8, // channel before the heal lands — the interrupt window

  // Phantom: fast, fragile skirmisher that blinks toward its prey.
  phantomBlinkDistance: 3, // tiles teleported per blink (wall-clipped)
  phantomBlinkCooldown: 2.8, // seconds between blinks

  // Brute Ground Slam: its ONE attack is a self-centered AoE (no facing/arc —
  // everyone standing close eats it), not a single-target point hit. Same
  // windup as before; the long telegraph is the dodge window either way.
  bruteSlamRadius: 1.5, // tiles from the brute's own position

  // Boss kit escalation (DESIGN: boss-tier fights should feel like escalating
  // KITS, not just bigger numbers on one script). Adds waves at phase breaks +
  // hazard rain are UNIVERSAL boss behavior (backlog #11); the tiers layer on
  // top of that (band-end bosses ALSO carry a per-band signature — see below):
  //   tier 0 (floor 3)            — melee+volley only (early-game, gentle)
  //   tier 1 (floors 6, 9)        — + Ground Slam
  //   tier 2 (floors 12, 15)      — Ground Slam cycles faster
  //   tier 3 (floor 18 final boss)— + Dark Ritual (a real interrupt-or-hurt stake)
  bossSlamRadius: 2.4, // tiles: bigger than the brute's — it's arena-scale
  bossSlamRange: 3.2, // tiles: max distance the boss will commit a slam from
  bossSlamWindup: 0.9, // seconds telegraphed before it erupts
  bossSlamCooldown: 6.5, // seconds between slams (independent of melee/volley)
  bossSlamHasteT2: 0.65, // tier 2+ slam-cooldown multiplier (the tier-2 escalation)
  bossSlamDmgMult: 0.85, // relative to the boss's own damage stat (it's a BONUS hit)
  ritualRange: 9, // tiles: the boss will channel from anywhere in the arena
  ritualWindup: 1.9, // seconds — long and unmistakable; interrupt it or eat it
  ritualCooldown: 14, // seconds between rituals
  ritualRadius: 3.6, // tiles: arena-scale AoE around the boss
  ritualDmgMult: 1.9, // relative to the boss's own damage stat — this one HURTS

  // Charger: locks a direction during a LONG windup, then rushes down the line,
  // plowing through anyone still standing on it. Sidestep the lane — the commit
  // point is the tell, the direction never updates after it.
  chargerMinRange: 2.2, // tiles: closer than this it just swings instead
  chargerRange: 7, // tiles: max distance it will commit to a rush from
  chargerDashSpeed: 11, // tiles/sec during the rush
  chargerHitRadius: 0.6, // tiles: how close the rush must pass to clip you
  chargerCooldown: 3.5, // seconds before it can rush again

  // Spitter: keeps a ranged standoff and lobs acid that lingers as a ground
  // puddle. Standing in it is a choice; the damage repeats per tick.
  spitterCooldown: 3.2, // seconds between lobs
  puddleRadius: 1.2, // tiles
  puddleDuration: 3.0, // seconds a puddle lingers
  puddleTickSeconds: 0.5, // seconds between damage ticks while standing in it
  spitterPuddleDmgMult: 0.35, // per-tick damage relative to the spitter's damage stat

  // Necromancer: a back-line caster that RAISES fallen monsters (fresh corpses
  // only). Kill it first or the pack never stays dead.
  corpseTtl: 12, // seconds a corpse stays raisable
  corpseMax: 40, // corpse list cap (oldest fall off — bounded state)
  necroRaiseRange: 5, // tiles: corpses it can reach
  necroRaiseCooldown: 5, // seconds between raises
  necroRaiseMax: 4, // lifetime raises per necromancer
  necroRaisedHpMult: 0.6, // raised minions come back at reduced HP
  necroRaisedXp: 1, // raised minions are worth almost nothing (not a farm)

  // Ultimates (the fifth slot): long cooldowns, screen-scale impact.
  ultAirstrikeCooldown: 45,
  ultAirstrikeShells: 6,
  ultAirstrikeRadius: 1.6, // per-shell blast radius (tiles)
  ultAirstrikeDmgMult: 2.5, // per shell, relative to baseDamage
  ultAirstrikeSpread: 2.2, // shell scatter around the target point
  ultAirstrikeRange: 8, // max targeting distance from the caster
  ultCataclysmCooldown: 35,
  ultCataclysmRadius: 6,
  ultCataclysmDmgMult: 3,
  ultCataclysmKnockback: 2.5, // tiles enemies are hurled
  ultBulletTimeCooldown: 60,
  ultBulletTimeDuration: 4, // seconds
  ultBulletTimeFactor: 0.35, // monster/enemy-projectile time scale while active

  // Ultimate constellations (abilities.ts): rank-scaled knobs per node.
  ultAirstrikePayloadDmg: 0.25, // shell damage per Bigger Payload rank
  ultAirstrikeSaturationShells: 2, // extra shells per Saturation Barrage rank
  ultAirstrikeSaturationSpread: 0.18, // extra scatter per Saturation rank (the cost)
  ultAirstrikePrecisionSpread: 0.3, // scatter removed per Precision Strike rank
  ultAirstrikeLoyaltyRefund: 0.08, // SPONSOR LOYALTY: cooldown fraction per barrage kill
  ultCataclysmEpicenterRadius: 0.15, // radius per Epicenter rank
  ultCataclysmAftermathBase: 0.25, // Aftermath echo fraction at rank 0...
  ultCataclysmAftermathPerRank: 0.15, // ...plus this per rank (rank 1 = 40%, 2 = 55%)
  ultCataclysmAftermathDelay: 1.2, // seconds until the echo shock lands
  ultCataclysmUpheavalKnock: 0.45, // extra hurl per Upheaval rank
  ultCataclysmUpheavalPoise: 2, // Upheaval hits crush poise this much harder (any rank)
  ultCataclysmExtinctionFrac: 0.6, // EXTINCTION corpse blast, fraction of cataclysm power
  ultCataclysmExtinctionRadius: 1.8, // tiles around each detonating corpse
  ultBulletTimeFocusSeconds: 1, // duration per Deep Focus rank
  ultBulletTimeAdrenaline: 0.5, // extra cooldown tick speed per Adrenaline rank, inside
  ultBulletTimeDeadeyeCrit: 0.25, // bonus crit chance per Dead Eye rank, inside
  ultBulletTimeEncoreExtend: 0.5, // EXTENSION: seconds added per kill inside
  ultBulletTimeEncoreCap: 10, // bullet time can never stretch past this

  // Fun-kit wave (ABILITY-CONCEPTS.md): Blindside / Extradition / Stunt Double.
  cutToRange: 6, // tiles the camera can cut
  cutToCooldown: 6, // long enough that each cut is a decision, not a spam
  cutToDmgMult: 1.2, // arrival strike, off attackPower
  cutToStagger: 0.35, // Sucker Punch: non-elite arrival stagger (seconds)
  cutToMatchWindow: 1, // REPEAT OFFENDER: kill inside this window resets the cooldown
  surfRange: 7, // chain reach (tiles)
  surfCooldown: 7,
  surfMassLimit: 1.5, // heavier than this (or elite/boss) pulls YOU instead
  surfStagger: 0.5, // pulled enemies land staggered this long
  surfStaggerPerRank: 0.3, // Contempt: extra stagger per rank
  surfDiveFracPerRank: 0.6, // Gavel Drop: arrival blast fraction of power per rank
  surfDiveRadius: 1.6,
  surfArriveGap: 1.0, // both pull modes stop this far from the target
  surfPathRadius: 1.0, // CLASS ACTION: drag capsule half-width along the chain
  doubleContract: 5, // seconds the stunt performer works
  doubleCooldown: 18,
  doubleTauntRadius: 5, // monsters inside hunt the double instead of players
  doubleMirrorFrac: 0.3, // mirrored swing damage, of the owner's swing
  doubleExplodeFrac: 0.5, // farewell blast = absorbed damage x this...
  doubleExplodeCap: 3, // ...capped at owner attackPower x this (no infinite banks)
  doubleExplodeRadius: 2,

  // ---- The System intervenes (low ratings = corrective content) ----
  // A crawler whose hype flatlines gets escalating attention: a posted bounty,
  // then a spawned wave, then an engagement review (telegraphed impacts).
  // Keeping hype above the floor suppresses all of it — hype is cover.
  interferenceHypeFloor: 25, // hype at/above this resets the flatline clock AND the escalation
  interferenceBoredom: 40, // seconds of flatline before the System acts
  interferenceGraceFloors: 2, // floors 1-2 are never interfered with (the pilot airs itself)
  interferenceBountyWindow: 15, // seconds to collect a posted bounty
  interferenceBountyGold: 15, // purse base + per-floor scaling below
  interferenceBountyGoldPerFloor: 2,
  interferenceBountyHype: 25, // collecting on camera pays hype too
  interferenceBountySpeedMult: 1.3, // the crowned monster is agitated (and stays that way)
  interferenceAmbushCount: 4, // corrective-content wave: swarmers + one ranged flanker
  interferenceAmbushRadius: 4, // ring distance (tiles) around the boring crawler
  interferenceHazardCount: 6, // engagement review: telegraphed impact circles
  interferenceHazardDelay: 1.4, // telegraph seconds before the first impact
  interferenceHazardRadius: 1.4,
  interferenceHazardDmgFrac: 0.18, // each impact hits for this fraction of max HP (pre-armor)

  // ---- CLASS REVISION (milestone castings — the menu lives in revisions.ts) ----
  revisionFloors: [4, 7, 10], // arrival floors (the band bosses at 3/6/9 earn the offer)
  revisionUnderdogThreshold: 0.35, // "below this HP fraction" gate for both bonuses
  revisionUnderdogDamage: 1.25,
  revisionUnderdogHypeMult: 2,
  revisionUnderdogHpMult: 0.9,
  revisionHeavyHpMult: 1.2,
  revisionHeavyArmor: 10,
  revisionHeavyDashCdMult: 1.5,
  revisionParkourCharges: 1, // extra dash charges in the tank
  revisionParkourSpeedMult: 1.1,
  revisionParkourHpMult: 0.85,
  revisionSelloutThresholdMult: 0.75, // sponsor favorite-thresholds scale down
  revisionSelloutGoldMult: 0.85, // the network's cut of gold pickups
  revisionTypecastCdMult: 0.85,
  revisionScavengerRadius: 2, // tiles: corpses inside crumble to gold
  revisionScavengerGold: 2, // gold per crumbled corpse (+1 per 4 floors)
  revisionPetIframes: 2, // seconds of untouchable camera-cut after the save
  revisionPetBoredomMult: 1.5, // the flatline clock runs faster on the star
  revisionCanceledHypeMult: 0.5,
  revisionCanceledFirstStrike: 1.5, // damage mult vs undamaged monsters
  revisionRegularExtraCards: 1, // extra card per level-up draft
  revisionRegularTimeMult: 0.85, // every remaining floor's time budget scales by this
  revisionUncastHype: 0.1, // permanent hype-gain bonus per REMAIN UNCAST

  // Orbit capstone + melee fork identities (abilities.ts constellation pass).
  orbitGuillotineThreshold: 0.12, // GUILLOTINE: blades cancel non-elites below this
  meleeOverkillRadius: 1.4, // Heavy Blows: killing-swing overkill splashes this far
  meleeMomentumPerStack: 0.06, // Swift Strikes: damage per momentum stack
  meleeMomentumStacksPerRank: 2, // stack cap per Swift Strikes rank
  meleeMomentumWindow: 2.5, // seconds between connecting swings before momentum drops

  // Discoverable abilities (learned from tomes; see abilities.ts for upgrade trees)
  novaCooldown: 5.0,
  novaRadius: 2.6,
  novaDamageMult: 1.2, // relative to melee base damage
  orbitBladesBase: 2,
  orbitRadius: 1.6,
  orbitRevPerSec: 1.1, // revolutions per second
  orbitDamageMult: 0.5, // per tick, relative to melee base damage
  orbitTickSeconds: 0.4,
  orbitBladeHitRadius: 0.5,
  // Swept-path hit test: the damage tick checks this many positions along each
  // blade's travel since the last tick, so blades hit what they visibly passed.
  orbitHitSamples: 8,
  // Corkscrew (orbit.wide): blades spiral between this inner radius and
  // orbitRadius + perRank * rank, oscillating at this rate — coverage across
  // every range instead of one ring with a dead zone inside it.
  orbitSpiralInner: 0.7,
  orbitSpiralPerRank: 0.45,
  orbitSpiralRevPerSec: 0.6, // in-out cycles per second
  // Battle Stance: melee-type = swings + orbit blades, ranged-type = bolts.
  stanceSwapCooldown: 3, // seconds between swaps (the dance's tempo floor)
  stanceRightMult: 1.25, // matching attack-type damage
  stanceWrongMult: 0.8, // mismatched attack-type damage
  stanceSettleSeconds: 6, // time-in-stance before Discipline/PERFECT FORM apply
  stanceSurgeSeconds: 3, // Flow's post-swap surge window
  // Overcharge: bank power; the NEXT attack (melee swing or bolt volley) spends it.
  overchargeCooldown: 8, // starts on cast, not on spend
  overchargeDamageMult: 1.5, // the banked attack's base multiplier
  // Ability tomes: dungeon-found unlocks for undiscovered abilities.
  tomeDropChance: 0.06, // per-kill chance while abilities remain undiscovered
  // Ultimates are the late-run power spike: no discovery pool (tomes, chips)
  // offers one before this floor. Landing right after the Sump King falls,
  // so the second act opens with the big toys.
  ultimateMinFloor: 7,
  upgradeDraftSize: 3, // cards offered per level-up
  // Overranks: lottery ranks past a node's printed max (see rollUpgradeDraft).
  overrankChanceBase: 0.05, // draft chance to dangle one on floor 0
  overrankChancePerFloor: 0.01, // added per floor — the deep dungeon tempts harder
  overrankChanceMax: 0.2, // even floor 15+ stays a gamble

  // Fog of war
  fogVisionRadius: 8.5, // tiles revealed (and entities visible) around the player

  // The Show: viewers / favorites / sponsors economy. Exciting + challenging play
  // generates "hype" (which decays); hype drives viewers, a slice of whom convert to
  // sticky favorites, and favorite thresholds earn sponsors.
  //
  // Tuned against the balance bot (a full winning run earns exactly 5 sponsors;
  // thresholds 6-7 sit 35-90% above the bot's best and are reserved for
  // exceptional play). Two shape choices keep it honest:
  //   - decay is PROPORTIONAL (base + hype*frac): the hotter the crowd, the
  //     faster it cools. Sustained good play holds an equilibrium instead of
  //     pinning the cap, so +hype gear raises WHERE you sit, not a dead stat;
  //   - favorite conversion is sqrt(hype - threshold): spikes convert, camping
  //     at high hype doesn't run away (cuts seed variance ~2.4x -> ~7%).
  show: {
    baseViewers: 180,
    viewersPerFloor: 90,
    viewersPerHype: 55,
    viewerEase: 0.9, // how fast the live count chases its target (per sec)
    hypeDecay: 3, // base hype lost per second
    hypeDecayFrac: 0.12, // + this fraction of current hype per second (soft cap)
    hypeMax: 140,
    favConvertThreshold: 10, // favorites only accrue while hype is above this
    favPerHypePerSec: 0.12, // favorite gain = sqrt(hype-threshold)*this*dt
    // Favorites needed per sponsor: #1 lands ~floor 3, #2 ~floor 7, #3 ~floor
    // 10-11, a winning run ends on 5; 6-7 are legend tier (measured, see above).
    sponsorThresholds: [15, 85, 155, 235, 325, 520, 750],
    // Hype awarded per exciting event:
    hypeCrit: 2.5,
    hypeKill: 3,
    hypeSwarmer: 1,
    hypeBrute: 7,
    hypeRanged: 2,
    hypeBomber: 4, // explosive deaths play great on camera
    hypeShaman: 6, // priority target down = crowd relief
    hypePhantom: 5, // catching the fast one is a highlight reel
    hypeCharger: 6, // dodging the freight train, then dropping it
    hypeSpitter: 4,
    hypeNecromancer: 8, // the crowd HATES reruns; ending them pays
    hypeBroodmother: 9, // ending the nest = the whole arena exhales
    hypeDrummer: 6, // silencing the band = the pack deflates on camera
    hypeFilcher: 8, // running down the rat is a highlight-reel chase
    hypeLineworker: 5,
    hypeSentinel: 7, // dodging the lock then dropping the turret = television
    hypeSlagbreaker: 9, // the vent-window execution is a highlight
    hypeToysoldier: 3, // chaff — the VOLLEY dodge is where the hype lives
    hypeGreeter: 6, // it was a prop until it wasn't
    hypeLasher: 7, // dodging the hook is a clip; eating it is a better one
    hypeUnderstudy: 6, // ending the extra BEFORE the transformation clause
    hypeHexer: 7, // dispelling the mark by ending the witch
    hypeCutpurse: 6, // getting the purse BACK (with interest) plays great
    hypeWarden: 6, // toppling the vault's furniture
    hypeDigger: 4, // the launch was the show; the kill is a footnote
    hypeShieldbearer: 7, // cracking the phalanx from behind is choreography
    hypeCleric: 7, // deconsecration, live on camera
    hypeArchivist: 8, // interrupting the beam mid-sweep is a clip
    hypeColossus: 9, // felling the furniture of a dead civilization
    hypeBoss: 50,
    hypeMultiKillPerExtra: 5, // per extra kill in the same step (combo)
    hypeLowHpHit: 9, // taking a hit while below lowHpFraction HP
    hypeCollapsePerSec: 6, // staying on a collapsing floor
    hypeRareDrop: 12,
    hypeEpicDrop: 26,
    lowHpFraction: 0.3,
    // Crowd Frenzy hysteresis: enter hot, drop out only when the hype fades.
    frenzyEnter: 60,
    frenzyExit: 40,
    hypeRevive: 22, // pulling a teammate off the mat is GREAT television
  },

  // Sponsor rewards (end-of-floor draft): one option per sponsor, capped here.
  // Sponsors beyond the cap pitch extra candidates and the best-fitting ones
  // are kept (see generateRewards). No sponsors, no gifts.
  rewardMaxCount: 3,
  // Anti-concentration: a permanent stat gift diminishes against what the
  // crawler has ALREADY banked on that axis (factor = k/(k+owned)). The first
  // Weapon Mod is juicy; the tenth is a rounding error — so stacking one stat
  // every floor stops being the obvious play and the varied pool (armor,
  // materials, favors, gear) competes. Per-axis k (owned units match makeReward).
  rewardDrDamageK: 45, // owned = bonusDamage
  rewardDrMaxHpK: 140, // owned = bonusMaxHp
  rewardDrCritK: 16, // owned = bonusCrit * 100 (percentage points)
  rewardDrArmorK: 40, // owned = bonusArmor

  // Boss hierarchy (DCC-style):
  // - NEIGHBORHOOD BOSS: one elite monster per ordinary floor (2+) — a beefed-up
  //   archetype with a name, guaranteed loot, and an announcer moment.
  // - BAND BOSS: every band-END floor (3, 6, 9, 12, 15) is a sealed arena with
  //   a real boss carrying its band's SIGNATURE mechanic (see the signature
  //   knobs below + ai.ts).
  // - Floor 18 remains the final boss.
  eliteFromFloor: 2,
  // Elite durability tracks the player power curve (measured by the balance
  // bot: player damage/hit grows ~48 -> ~114 -> ~180 -> ~380 over floors
  // 4/6/12/18). Flat multipliers collapse into one-shots by midgame, so the
  // HP multiplier grows per floor; target: a focused 4-8s fight at level.
  eliteHpMult: 3.0, // base multiplier over the archetype's floor-scaled HP...
  eliteHpMultPerFloor: 2.8, // ...plus this much more per floor
  eliteDmgMult: 1.7,
  eliteXpMult: 3.0,
  eliteScale: 1.45, // render scale bump
  // One-shot insurance: a single player hit can never remove more than this
  // fraction of a boss/elite health pool, whatever the build finds next.
  bossHitCapFraction: 0.1,
  eliteHitCapFraction: 0.12,
  // Elite AFFIXES (from this floor): each named elite rolls one mechanic —
  // swift (+speed), shielded (takes less damage), volatile (delayed death
  // blast — clear the corpse), summoner (calls swarmer adds), splitter
  // (bursts into swarmers on death), thorns (reflects a slice of your hits).
  eliteAffixFromFloor: 3,
  // Ringside introductions: closing within this range of an unmet boss/elite
  // freezes the world for the reveal (nobody gets hit mid-banner).
  encounterRevealRadius: 7, // tiles
  encounterIntroSeconds: 2.2,
  swiftSpeedMult: 1.4,
  shieldedDamageTakenMult: 0.7,
  // School resists (5.8 phase 3): armored/warded elites and resist-tagged
  // archetypes take this fraction of matching-school damage (−30%).
  resistDamageTakenMult: 0.7,
  volatileDelay: 0.8, // seconds from death to blast (the dodge window)
  volatileRadius: 1.5, // tiles
  volatileDmgMult: 1.2, // relative to the elite's damage stat
  summonCooldown: 4, // seconds between summons
  summonMax: 6, // lifetime adds per summoner
  summonWindup: 0.7, // channel before the add arrives (summoner elites + broodmother)
  // Ambushes (deep-floor tactic): some packs spawn DORMANT — inert and quiet in
  // the fog until a player strays within trigger range, then the whole cluster
  // springs at once with a brief speed surge to close the gap. A pack that lets
  // you walk into the middle of it is a very different threat from one you saw.
  ambushFromFloor: 4,
  ambushPackChance: 0.3, // share of eligible-floor packs that lie in wait
  ambushTriggerRadius: 5, // tiles: a player this close springs the trap
  ambushWakeRadius: 6.5, // tiles: the sprung monster also wakes its neighbors
  ambushSurgeSpeed: 1.6, // speed multiplier during the surge (the pounce)
  ambushSurgeSeconds: 2.5, // how long the surge lasts after springing
  splitterCount: 3, // swarmers a splitter elite bursts into on death
  thornsReflectFraction: 0.25, // slice of each hit reflected back at the attacker...
  thornsReflectCapFraction: 0.04, // ...capped at this fraction of the attacker's maxHp per hit
  bossFloorEvery: 3, // floors 3, 6, 9, 12, 15 (18 is the final boss)
  // Band-boss pools per arena (floors 3/6/9/12/15), sized against measured
  // shopping-player DPS, which roughly DOUBLES between the floor-6 and
  // floor-12 arenas (~300 -> ~1100); floors 6 and 12 keep their pre-band
  // values (5400 / 18360). Floor 3 is early-game and deliberately GENTLE.
  // Target: a real 15-25s arena fight, not a speed bump.
  bandBossHp: [1500, 5400, 10500, 18360, 27000],
  bandBossDmgMult: [0.5, 0.7, 0.7, 0.7, 0.7], // x bossDamage per arena
  bandBossXpMult: [0.2, 0.4, 0.4, 0.4, 0.4], // x bossXp per arena
  cityBossAdds: 2, // ranged escorts
  // Ordinary-crowd share on a boss floor: thinner mid-run so the arena fight
  // stays the show; the final band keeps the deep-dungeon density story.
  bossFloorCrowd: 0.5,
  bossFloorCrowdDeep: 0.8,
  bossFloorCrowdDeepFrom: 13,

  // SIGNATURE boss mechanics — one themed ability per band-end arena, layered
  // on the shared melee+volley+phase kit (dispatch in ai.ts, helpers in
  // game.ts). Every one of them telegraphs: pools ARM before they bite,
  // impact circles ring before they land, the raise is an interruptible
  // channel. Floor 18's crown stays the tier-3 Dark Ritual (above).
  // UNDERCROFT (floor 3): Grave Rising — raises fresh corpses as weakened adds.
  graveRaiseCooldown: 10, // seconds between raise channels
  graveRaiseWindup: 1.1, // channel length (staggering it cancels the raise)
  graveRaiseRange: 7, // tiles: corpses it can reach
  graveRaiseCount: 3, // corpses raised per channel (freshest first)
  // SEWERS (floor 6): Flood Surge — sludge pools blanket a seeded half of the
  // arena; they arm (telegraph), then tick like acid until they drain.
  floodCooldown: 12, // seconds between surges
  floodTelegraph: 1.6, // seconds a pool arms before it goes live (the dodge window)
  floodDuration: 3.5, // seconds a live pool keeps ticking
  floodPools: 12, // pools per surge
  floodPoolRadius: 1.6, // tiles
  floodDmgMult: 0.4, // per-tick damage relative to the boss's damage stat
  // GARDEN (floor 9): Entangling Roots — root zones SNARE (heavy slow, no
  // damage) players who stay; dashing out is the escape.
  rootsCooldown: 9, // seconds between casts
  rootsTelegraph: 1.1, // seconds a zone arms before it grips
  rootsDuration: 2.6, // seconds a live zone keeps gripping
  rootsRadius: 1.5, // tiles
  rootsSnare: 0.7, // seconds of snare refreshed while standing in a live zone
  rootsSlowMult: 0.35, // move-speed multiplier while snared
  rootsExtra: 2, // extra seeded zones beyond one per crawler
  // RUINS (floor 12): Collapsing Masonry — telegraphed debris impact circles
  // rain all fight (one per crawler + seeded scatter), not just from phase 1.
  debrisCooldown: 6.5, // seconds between volleys
  debrisDelay: 1.3, // seconds from telegraph to impact
  debrisRadius: 1.6, // tiles
  debrisCount: 6, // circles per volley (players targeted first, rest scatter)
  debrisDmgMult: 0.9, // relative to the boss's damage stat
  // IRONWORKS (floor 15): Flame Sweep — an advancing wall of fire, row by
  // row toward the boss's target; each row detonates later than the last, so
  // the wave READS and the play is "pick a gap and commit".
  flameCooldown: 13, // seconds between sweeps
  flameTelegraph: 1.4, // seconds before the FIRST row erupts
  flameStepDelay: 0.35, // extra seconds per row (the advance speed)
  flameRows: 6, // rows the wall advances through
  flameRowSpacing: 1.4, // tiles between rows
  flameSpacing: 1.8, // tiles between circles across a row
  flameHalfWidth: 2, // circles each side of a row's center (5 across)
  flameRadius: 1.1, // tiles per fire circle
  flameDmgMult: 1.0, // relative to the boss's damage stat

  // FLOOR EVENTS (floors 2+, never on boss floors): a seeded roll gives most
  // floors ONE of — a System Shrine (pick-1 bargain), a timed vault (sealed
  // treasure that opens on approach and re-seals on a timer), or a sponsor
  // challenge (clear a room's pack untouched for a purse). Pure sim data;
  // hosts only render and announce.
  eventChance: 0.7, // share of eligible floors that roll an event at all
  shrineBloodCostFraction: 0.2, // Blood Price: HP offered (of max, floored at 1)
  shrineBloodCrit: 0.03, // ...for this much permanent crit
  shrineGreedSpeedMult: 1.15, // Greed Clause: this floor's monsters speed up...
  shrineGreedGoldMult: 2, // ...and its gold drops pay double
  vaultOpenSeconds: 45, // how long a sprung timed vault stays open
  vaultTriggerRadius: 3, // tiles beyond the room rect that spring it
  challengeGoldBase: 40, // sponsor-challenge purse...
  challengeGoldPerFloor: 15, // ...plus this per floor
  challengeHype: 25, // hype paid alongside the purse

  // Boss (floor 18)
  bossHp: 34000,
  bossHpPerFloorOver: 0, // (kept for future scaling)
  bossDamage: 52,
  bossSpeed: 2.2,
  bossXp: 500,
  bossVolleyCooldown: 2.4,
  bossVolleyCount: 10, // projectiles per radial volley
  // Boss phases: crossing 2/3 and 1/3 HP enrages — faster chase, denser volleys.
  bossPhaseSpeedMult: 1.15, // per phase
  bossPhaseVolleyBonus: 4, // extra projectiles per phase
  bossPhaseVolleyHaste: 0.5, // seconds shaved off the volley cooldown per phase
  // Boss MECHANICS (backlog #11): a boss is a fight you learn, not a big grunt.
  // City-boss floors + floor 18 host the fight in a dedicated oversized arena.
  bossArenaSize: 19, // tiles per side (ordinary rooms are 6-12)
  // Phase transitions call ADDS WAVES: a pack of chaff + a ranged flanker so
  // the enrage moment changes what you're doing, not just the numbers.
  bossWaveAdds: 3, // adds per wave...
  bossWaveAddsPerPhase: 2, // ...plus this many more per phase reached
  // From phase 1, the arena itself attacks: telegraphed blast hazards rain on
  // each crawler's position — standing still through the enrage is a choice.
  bossHazardCooldown: 5, // seconds between hazard volleys (phase >= 1)
  bossHazardDelay: 1.25, // seconds from telegraph to detonation (the dodge window)
  bossHazardRadius: 1.7, // tiles
  bossHazardDmgMult: 1.1, // relative to the boss's damage stat
} as const;

// Enemy archetype stat multipliers (relative to the per-floor base) + behavior.
export type MonsterArchetype = {
  hpMult: number;
  dmgMult: number;
  speedMult: number;
  attackRange: number;
  xpMult: number;
  ranged: boolean; // keeps a standoff distance and fires projectiles
  windup: number; // seconds an attack telegraphs before the strike resolves
  poise: number; // fraction of maxHp in accumulated damage that triggers a stagger
  mass: number; // knockback divisor (heavier archetypes barely move)
  radius: number; // body radius (tiles) for HIT checks — matches render bulk,
  // so clipping a brute's shoulder counts (elites scale by eliteScale)
  // School resist (DESIGN 5.8 phase 3): this archetype takes
  // resistDamageTakenMult on hits of the matching school.
  resist?: "physical" | "magic";
};

export const ARCHETYPES = {
  grunt: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.0, xpMult: 1, ranged: false, windup: 0.4, poise: 0.36, mass: 1, radius: 0.35 },
  // Swarmer: dies to one clean hit (that's the fantasy); threat comes from volume.
  swarmer: { hpMult: 0.35, dmgMult: 0.6, speedMult: 1.7, attackRange: 0.9, xpMult: 0.7, ranged: false, windup: 0.25, poise: 0.15, mass: 0.8, radius: 0.28 },
  // Brute: long, scary windup that lands a chunk of your HP; high poise (shrugs
  // off small hits) — respect it or interrupt it with something heavy.
  brute: { hpMult: 2.6, dmgMult: 1.8, speedMult: 0.65, attackRange: 1.1, xpMult: 2, ranged: false, windup: 0.75, poise: 0.76, mass: 3, radius: 0.55 },
  // Ranged: windup is its aim flash — it stands still to line up the shot.
  ranged: { hpMult: 0.8, dmgMult: 0.6, speedMult: 1.0, attackRange: 6.5, xpMult: 1.3, ranged: true, windup: 0.35, poise: 0.3, mass: 1, radius: 0.35 },
  // Bomber: low HP, medium speed; dmgMult scales its detonation (see bomberExplodeDmgMult).
  // Its "windup" is the fuse (bomberFuse) it lights on contact.
  bomber: { hpMult: 0.55, dmgMult: 1.0, speedMult: 1.15, attackRange: 0.9, xpMult: 1.2, ranged: false, windup: 0.3, poise: 0.2, mass: 1, radius: 0.42 },
  // Shaman: never attacks (dmgMult unused); attackRange is its preferred standoff.
  shaman: { hpMult: 0.9, dmgMult: 0, speedMult: 0.95, attackRange: 5.5, xpMult: 1.5, ranged: true, windup: 0.3, poise: 0.3, mass: 1, radius: 0.38 },
  // Phantom: fast + fragile melee; closes gaps with periodic blinks (see phantomBlink*).
  phantom: { hpMult: 0.45, dmgMult: 1.1, speedMult: 1.5, attackRange: 1.0, xpMult: 1.4, ranged: false, windup: 0.3, poise: 0.15, mass: 0.8, radius: 0.3, resist: "magic" }, // half-spectral: hit it with something solid
  // Charger: its long windup IS the dodge window — the rush direction is locked
  // at commit (see charger* knobs). Heavy: hard to stagger out of the commit.
  charger: { hpMult: 1.4, dmgMult: 1.3, speedMult: 0.8, attackRange: 1.0, xpMult: 1.6, ranged: false, windup: 0.85, poise: 0.55, mass: 2.2, radius: 0.45, resist: "physical" }, // plated hide: bring magic
  // Spitter: standoff caster; dmgMult scales its puddle ticks (see spitter*/puddle*).
  spitter: { hpMult: 0.7, dmgMult: 0.9, speedMult: 0.95, attackRange: 5.5, xpMult: 1.4, ranged: true, windup: 0.6, poise: 0.25, mass: 1, radius: 0.38 },
  // Necromancer: never attacks (dmgMult unused); raises fresh corpses instead.
  necromancer: { hpMult: 1.1, dmgMult: 0, speedMult: 0.85, attackRange: 5.5, xpMult: 1.8, ranged: true, windup: 1.0, poise: 0.35, mass: 1.2, radius: 0.4 },
  // Broodmother: never attacks (dmgMult unused); a slow walking nest that
  // births swarmers on a timer (see brood* knobs) — the pack GROWS if ignored.
  broodmother: { hpMult: 2.2, dmgMult: 0, speedMult: 0.5, attackRange: 6, xpMult: 2.5, ranged: true, windup: 0.8, poise: 0.6, mass: 2.5, radius: 0.55 },
  // Drummer (Drum Sergeant): a support mob worth ~nothing itself — its war-drum
  // FRENZIES the pack (see drum* knobs). Kill-order lesson one: shoot the band.
  drummer: { hpMult: 0.85, dmgMult: 0.5, speedMult: 0.95, attackRange: 1.0, xpMult: 1.5, ranged: false, windup: 0.4, poise: 0.3, mass: 1, radius: 0.38 },
  // Filcher (Repo Rat): never attacks (dmgMult unused); a fast loot-goblin that
  // FLEES on sight, bleeds gold as it's hurt, and ESCAPES if ignored (filcher*).
  filcher: { hpMult: 0.6, dmgMult: 0, speedMult: 1.55, attackRange: 1.0, xpMult: 0.5, ranged: false, windup: 0.3, poise: 0.1, mass: 0.7, radius: 0.32 },
  // IRONWORKS cast (floors 13-15). Lineworker: a sturdy grunt whose piston
  // punch LAUNCHES you — never fight with your back to the set dressing.
  lineworker: { hpMult: 1.3, dmgMult: 1.1, speedMult: 0.9, attackRange: 1.1, xpMult: 1.4, ranged: false, windup: 0.55, poise: 0.45, mass: 1.8, radius: 0.42, resist: "physical" },
  // Sentinel: standoff turret-bot — its lock-on beam is the threat (sentinel*
  // knobs); dmgMult scales the railshot. Innately warded (energy shielding).
  sentinel: { hpMult: 0.85, dmgMult: 1.5, speedMult: 0.8, attackRange: 7, xpMult: 1.6, ranged: true, windup: 0.35, poise: 0.3, mass: 1.2, radius: 0.38, resist: "magic" },
  // Slagbreaker: a LARGE steam brute on a heat rhythm — three swings, then a
  // forced scalding vent + self-stagger (slag* knobs). Count to three.
  slagbreaker: { hpMult: 3.0, dmgMult: 1.5, speedMult: 0.6, attackRange: 1.2, xpMult: 2.4, ranged: false, windup: 0.7, poise: 0.75, mass: 3.2, radius: 0.58, resist: "physical" },
  // Toysoldier: musket squads that volley AS ONE (squad sync in ai.ts);
  // individually chaff — the synchronized volley is the encounter.
  toysoldier: { hpMult: 0.5, dmgMult: 0.9, speedMult: 0.9, attackRange: 6, xpMult: 0.9, ranged: true, windup: 1.0, poise: 0.2, mass: 0.9, radius: 0.32 },
  // Greeter: stands dormant among the props (always spawns in ambush), then
  // swings like a grunt; on death it discharges spark blasts (greeterSpark*).
  greeter: { hpMult: 1.1, dmgMult: 1.2, speedMult: 1.05, attackRange: 1.0, xpMult: 1.5, ranged: false, windup: 0.45, poise: 0.35, mass: 1.3, radius: 0.4 },
  // GARDEN cast (floors 7+). Lasher: mid-range whip — its HOOK drags you down
  // the lane to the pack (lasher* knobs). attackRange = preferred standoff.
  lasher: { hpMult: 0.95, dmgMult: 1.0, speedMult: 0.9, attackRange: 4, xpMult: 1.5, ranged: true, windup: 0.95, poise: 0.35, mass: 1.2, radius: 0.4 },
  // Understudy: a shuffling extra — weak on purpose. At half HP it TRANSFORMS
  // into a full charger (morph* knobs): burst it through the threshold or
  // stagger the morph, or fight the wolf you made.
  understudy: { hpMult: 0.75, dmgMult: 0.6, speedMult: 0.8, attackRange: 1.0, xpMult: 1.3, ranged: false, windup: 0.5, poise: 0.25, mass: 1, radius: 0.36 },
  // Hexer (Briar Witch): never attacks directly (dmgMult unused) — she CURSES
  // a crawler with a vulnerability mark her pack cashes in (hex* knobs).
  hexer: { hpMult: 0.8, dmgMult: 0, speedMult: 0.9, attackRange: 5.5, xpMult: 1.6, ranged: true, windup: 0.8, poise: 0.25, mass: 1, radius: 0.38 },
  // UNDERCROFT trainers (floor 2+). Cutpurse: fast, fragile, and after your
  // PURSE, not your HP — its lunge-stab steals gold (cutpurse* knobs).
  cutpurse: { hpMult: 0.5, dmgMult: 0.5, speedMult: 1.35, attackRange: 1.0, xpMult: 1.1, ranged: false, windup: 0.55, poise: 0.15, mass: 0.8, radius: 0.32 },
  // Ossuary Warden: a slow bone golem — its slam leaves a shard zone that
  // reshapes the room (warden* knobs). High mass: it body-blocks doorways.
  warden: { hpMult: 2.2, dmgMult: 1.3, speedMult: 0.55, attackRange: 1.15, xpMult: 1.9, ranged: false, windup: 0.8, poise: 0.7, mass: 3, radius: 0.55 },
  // Pit Digger: the knockback TUTOR — the slowest tell in the game, a gentle
  // hit, and a real launch. Three floors before knockback appears near hazards.
  digger: { hpMult: 1.1, dmgMult: 0.35, speedMult: 0.8, attackRange: 1.1, xpMult: 1.2, ranged: false, windup: 0.9, poise: 0.4, mass: 1.6, radius: 0.42 },
  // RUINS cast (floors 10+). Shieldbearer: tower-shield zealot — near-immune
  // from the FRONT while its guard holds; the guard drops mid-swing/stagger.
  shieldbearer: { hpMult: 1.6, dmgMult: 1.2, speedMult: 0.7, attackRange: 1.1, xpMult: 1.8, ranged: false, windup: 0.6, poise: 0.6, mass: 2.4, radius: 0.45, resist: "physical" },
  // Cleric: never attacks (dmgMult unused) — consecrates CONTESTED ground
  // that heals monsters and burns crawlers (consecrate* knobs).
  cleric: { hpMult: 0.9, dmgMult: 0, speedMult: 0.9, attackRange: 5.5, xpMult: 1.7, ranged: true, windup: 0.9, poise: 0.3, mass: 1, radius: 0.38 },
  // Archivist: standoff channeler — its SWEEPING beam (sweep* knobs) is the
  // first attack you dodge continuously. Stagger the channel to cut it short.
  archivist: { hpMult: 0.85, dmgMult: 1.0, speedMult: 0.8, attackRange: 6, xpMult: 1.8, ranged: true, windup: 0.5, poise: 0.25, mass: 1, radius: 0.38, resist: "magic" },
  // Colossus (The Foundation): animate masonry, LARGE — its slam sends a
  // FISSURE travelling down a lane (fissure* knobs). Move perpendicular.
  colossus: { hpMult: 2.8, dmgMult: 1.4, speedMult: 0.55, attackRange: 1.2, xpMult: 2.3, ranged: false, windup: 0.85, poise: 0.75, mass: 3.4, radius: 0.58, resist: "physical" },
  boss: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.4, xpMult: 1, ranged: false, windup: 0.55, poise: 0.5, mass: 6, radius: 0.8 },
} as const satisfies Record<string, MonsterArchetype>;

/** Depth tempo multipliers: how much quicker monsters move, swing, and
 * telegraph on a given floor. 1/1/1 through the ramp floor; capped deep. */
export function monsterTempo(floor: number): { speed: number; cooldown: number; windup: number } {
  const past = Math.max(0, floor - CONFIG.monsterTempoFrom);
  return {
    speed: Math.min(CONFIG.monsterTempoSpeedMax, 1 + past * CONFIG.monsterTempoSpeedPerFloor),
    cooldown: Math.max(CONFIG.monsterTempoCdMin, 1 - past * CONFIG.monsterTempoCdPerFloor),
    windup: Math.max(CONFIG.monsterTempoWindupMin, 1 - past * CONFIG.monsterTempoWindupPerFloor),
  };
}

// Weapon rarity tiers: spawn weight + damage-bonus multiplier. High tiers
// were tuned DOWN (11/3 -> 8/2) when the store became the build engine — a
// rare drop should feel like a windfall, not a plan.
export const RARITIES = [
  { name: "common", weight: 64, mult: 1.0 },
  { name: "magic", weight: 26, mult: 1.6 },
  { name: "rare", weight: 8, mult: 2.4 },
  { name: "epic", weight: 2, mult: 3.6 },
] as const;

// Theme bands: the dungeon shifts tone every 3 floors. The sim announces the
// district on entry; the renderers pick art/palettes from the same index.
export const FLOOR_BANDS = [
  { name: "THE UNDERCROFT", line: "Clean stone, warm torches. Don't get comfortable." },
  { name: "THE SEWERS", line: "Mind the weeds. Mind the smell. The cameras have smell-o-vision now." },
  { name: "THE GARDEN", line: "The System grew you a garden. Everything in it is dead, and most of it is still hungry." },
  { name: "THE RUINS", line: "Whoever lived here lost. Try to break the pattern." },
  { name: "THE IRONWORKS", line: "Steel grates and cold drafts. The machinery remembers." },
  { name: "THE APPROACH", line: "Banners, spikes, and something enormous breathing below." },
] as const;

/** Band index (0-5) for a floor: 1-3, 4-6, 7-9, 10-12, 13-15, 16-18. */
export function floorBand(floor: number): number {
  return Math.min(FLOOR_BANDS.length - 1, Math.floor((Math.max(1, floor) - 1) / 3));
}

/** Collapse timer budget (seconds) for a given floor (1-indexed). */
export function floorTimeBudget(floor: number): number {
  const raw = CONFIG.timerBaseSeconds - (floor - 1) * CONFIG.timerPerFloorFalloff;
  return Math.max(CONFIG.timerMinSeconds, raw);
}

/** XP required to advance FROM the given level to the next. */
export function xpForLevel(level: number): number {
  return Math.round(CONFIG.xpBase * Math.pow(CONFIG.xpGrowth, level - 1));
}
