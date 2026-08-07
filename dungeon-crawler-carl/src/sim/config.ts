import { dpow } from "./dmath";
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

  // Roam mode (v1 â€” SETTLEMENTS.md): one big, low-pressure floor per
  // stairway instead of 18 tight ones. Numbers below are starting guesses,
  // not tuned balance â€” expect to revisit after playtesting.
  roamFloorGridW: 128,
  roamFloorGridH: 128,
  roamFloorMinRooms: 20,
  roamFloorMaxRooms: 28,
  // A large but FINITE budget â€” never Infinity. GameState round-trips through
  // JSON.stringify in snapshot.ts, and Infinity serializes to null, silently
  // corrupting timeBudget/timeRemaining on the first snapshot.
  roamTimeBudget: 1800, // 30 minutes
  roamMonsterDensity: 0.012, // monsters per walkable tile
  roamQuestTarget: 10, // kills required to complete the settlement's killTribe quest

  // Roam settlements (SETTLEMENTS.md): count per megafloor (the entrance one
  // + 2-3 outlying), the sanctuary's no-aggro skirt beyond the room walls,
  // and the in-map safe-room services' pricing.
  roamSettlementsMin: 3,
  roamSettlementsMax: 4,
  roamSettlementPad: 1, // tiles of no-aggro skirt around each settlement room
  roamQuestsPerFloorMin: 2, // active quest board size (killTribe + 1-2 more)
  roamQuestsPerFloorMax: 3,
  roamBeaconCount: 3, // spots the "light the beacons" quest scatters
  roamHealCostBase: 20, // quartermaster patch-up: base gold...
  roamHealCostPerFloor: 5, // ...plus this per floor
  roamRumorCostBase: 15, // rumor-monger's stairway ping: base gold...
  roamRumorCostPerFloor: 3, // ...plus this per floor
  roamVendorGearStock: 5, // seeded gear picks on a settlement vendor's shelf

  // Collapse timer (seconds). Floor 1 is generous; deeper floors tighten.
  // Budgets account for the larger floors (longer traversal to the stairs).
  timerBaseSeconds: 120,
  // 2.5 -> 2.0 (2026-08-04, step 0): retreat-and-regroup packs + heavy-pack
  // rings made deep floors take honestly longer to fight through; a third of
  // measured full-run deaths were collapse/warning-phase clock-outs.
  timerPerFloorFalloff: 1.6, // seconds shaved per floor descended
  timerMinSeconds: 60,
  warningFraction: 0.4, // enter WARNING when remaining < 40% of the floor's budget
  collapseDpsBase: 6, // damage/sec at start of collapse
  collapseDpsRamp: 4, // extra damage/sec added for each second spent in collapse

  // ---- THE DEBUT: the first run of a fresh profile (TUTORIAL.md) ----------
  // Four cold passes measured the same wall: three of four first-timers died
  // on floor 1 without finishing the FIRST objective, and two of three never
  // reached the step that teaches the kit. A first hour that can be failed
  // into confusion is a first hour nobody finishes, so floor 1 of a DEBUT
  // (GameState.firstRun, set by the host from the fresh-profile read and
  // carried in the proof header) has no fail state — and pays for it by being
  // structurally unrankable. Every knob below reads ONLY under that flag;
  // ordinary and competitive play never touches this block.
  //
  // The knockdown: a killing blow becomes a CUT TO COMMERCIAL — the crawler
  // wakes at the floor entrance with this much of their bar, briefly
  // untouchable, with the crowd's excitement spent. It costs position, health
  // and hype; it cannot cost the run.
  firstRunMercyHpFraction: 0.6,
  firstRunMercyGraceSeconds: 2, // untouchable while the broadcast comes back
  // The clock: the debut episode gets its full runtime. Floor 1 counts down
  // normally (so the WARNING phase — and the collapse lesson it carries —
  // lands with its real drums) and then HOLDS here instead of going lethal.
  // Must sit below timerBaseSeconds * warningFraction (48s) or the warning
  // never fires; test/tutorial-firstrun.test.ts asserts exactly that.
  firstRunClockHoldSeconds: 30,
  // The float: a floor-1 take is 3-8 kills at goldMin..goldMax, i.e. 16-30
  // gold, against a cheapest first-shelf entry of 35 — the first shop was a
  // locked door in two consecutive cold rounds. The System advances a debut
  // crawler this much against future earnings, so the first shelf is a shelf
  // and not a window. Must cover cheapestFirstShelfPrice(); the test proves it.
  firstRunStipendGold: 40,

  // Player
  playerMaxHp: 100,
  playerSpeed: 4.2, // tiles/sec
  // Facing sweeps toward the move direction at this rate (rad/s) instead of
  // teleporting between the 8 WASD headings â€” mixing keys can hold every
  // in-between angle (playtest ask: 16+ facing directions). Movement itself
  // is never rate-limited; only the body's heading (and keyboard-aim) sweeps.
  playerTurnRate: 16,
  playerAttackRange: 1.3, // tiles
  playerAttackCooldown: 0.4, // seconds
  playerBaseDamage: 12,
  playerAttackArc: Math.PI / 2, // 90Â° swing in facing direction
  // Bodies one swing connects with. Wide Arc adds one per rank â€” that is the
  // entry node's "what does it touch" half (V2 Â§4.1). Three is the shipped
  // feel (a 3-kill instant is an achievement the game already awards); the cap
  // exists so the arc node has something to change besides a printed angle.
  meleeBaseTargets: 3,
  playerCritChance: 0.18,
  playerCritMult: 2.0,
  // Armor (defense): incoming hits are reduced by armor/(armor+armorK), capped.
  // The player starts with none â€” mitigation is a GEAR story (armor-slot items
  // roll it as their primary affix), so the sheet's DEFENSE panel is earned.
  playerBaseArmor: 0,
  armorK: 60, // 60 armor = 50% reduction; diminishing returns past that
  armorMaxReduction: 0.6, // even a fortress crawler eats 40% of every hit
  meleeLungeDistance: 0.45, // tiles the swing steps toward the aim (aggression + reach)

  // Hit reactions: player damage shoves monsters (divided by archetype mass) and
  // builds poise damage; crossing maxHp * poise staggers them (interrupting any
  // windup and freezing them briefly). Chaff flinches constantly; brutes shrug.
  // Poise is a BUILDUP, not a bank: it drains over time, so an interrupt takes
  // a concentrated burst â€” and headliners (bosses/elites) gain a grace window
  // after each stagger so raw DPS can never stun-lock them.
  meleeKnockback: 0.3, // tiles
  boltKnockback: 0.15,
  novaKnockback: 0.7,
  airstrikeKnockback: 0.5,
  shockstepKnockback: 0.4,
  // Shockstep damages a CAPSULE along the whole dash path (launch -> arrival),
  // this wide â€” dashing THROUGH a pack is the point.
  shockstepPathRadius: 1.0,
  staggerDuration: 0.22, // seconds a staggered monster is helpless
  elitePoiseMult: 1.5, // elites resist stagger (and knockback) this much harder
  poiseDecayPerSec: 0.35, // poise drains at this fraction of the stagger threshold per second
  bossStaggerGrace: 6, // seconds after a boss stagger during which poise cannot build
  eliteStaggerGrace: 2.5, // same composure for named elites, shorter
  // The advertised exception: an interruptible CHANNEL (Dark Ritual) ignores
  // grace and takes double poise â€” burst it down mid-channel or brace.
  channelPoiseTakenMult: 2,

  // Enemy attack telegraphs: every monster attack winds up (per-archetype, see
  // ARCHETYPES.windup) before the strike resolves. The strike re-checks range
  // (+grace) and dash i-frames, so danger is READABLE and DODGEABLE â€” which is
  // why monster damage below runs much hotter than the old instant-hit numbers.
  monsterStrikeGrace: 0.35, // extra tiles beyond attackRange a strike still reaches
  bomberFuse: 0.5, // seconds between contact trigger and detonation (the dodge window)

  // Feature switches (code paths stay intact so these can toggle cleanly).
  flaskEnabled: true, // Sponsor Slurpâ„¢ flask: kill-credit sustain loop (re-enabled with the status pass)
  achievementsEnabled: true, // unlocks + safe-room ACHIEVEMENTS tab (off = hidden)

  // Sponsor Slurpâ„¢ flask: charge-gated heal, refilled by KILLS â€” aggression is
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
  // chill (no damage â€” the afflicted entity's clock runs slower).
  burnDuration: 3, // seconds a burn lasts (re-applying restarts it)
  burnTickSeconds: 0.5, // fast ticks â€” burn is the bursty DoT
  poisonDuration: 5, // seconds a poison lasts (re-applying refreshes + stacks)
  poisonTickSeconds: 1, // slow ticks â€” poison is the lingering DoT
  poisonMaxStacks: 3, // each stack adds a full tick's damage
  chillDuration: 2.5, // seconds a chill lasts (refresh-on-reapply)
  chillBossMult: 0.5, // bosses shrug off half the slow (never immune)
  chillSlowPerRank: 0.3, // FROST BOLTS: slow fraction per node rank (r1 = -30%)
  chillSlowMax: 0.45, // hard cap, whatever overranks roll
  novaScorchFracPerRank: 0.35, // AFTERBURN: burn total = this Ã— nova hit per rank
  venomTickFraction: 0.12, // Venom Clause: poison tick (per stack) = this Ã— the crit
  puddlePoisonFraction: 0.6, // spitter acid: poison tick = this Ã— the puddle tick
  chillingAuraRadius: 3.2, // "chilling" elite: crawlers inside are slowed...
  chillingAuraSlow: 0.3, // ...by this fraction (fades ~a beat after you break away)

  // Party pings: a marked spot the whole party sees (world pulse + minimap).
  pingTtl: 6, // seconds a ping lives
  pingMaxPerPlayer: 3, // oldest ping is replaced beyond this

  // Co-op revives: stand close to a downed crawler to stabilize them. No
  // button â€” proximity IS the channel (the reviver pays in exposure, not APM).
  // Walking away lets the wound reopen (progress decays). Descending still
  // revives everyone at 50% as before; this is the mid-floor rescue.
  reviveRadius: 1.7, // tiles from the downed body
  reviveChannelSec: 3.5, // seconds of continuous proximity to stabilize
  reviveHpFraction: 0.35, // of max HP on revive
  reviveDecayMult: 1.5, // progress decays this much faster than it builds

  // Leveling. xpBase 20 -> 24 (play feedback 2026-07-06: a shopping player
  // hit 12 by floor-4 start â€” the early ramp ran ~2 levels hot). +20% cost
  // shifts the whole curve down ~half a level early, less later.
  xpBase: 24, // xp to reach level 2
  xpGrowth: 1.35, // multiplier per level
  hpPerLevel: 18,
  // 3 -> 2 (build-matters pass, owner-approved 2026-07-26): levels used to be
  // ~65% of attack power, so junk-drawer gear played nearly as well as an
  // optimized build. Intrinsic power came DOWN and gear rolls went UP
  // (gearPowerMult) â€” total power at parity, but gear/build now own ~half the
  // stat instead of a third. HP intrinsic stays (survival isn't the lever).
  damagePerLevel: 2,

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
  monsterMaxCount: 115, // 130 -> 115 (step 0): density was double-charging — swarm pressure AND the collapse clock
  // Diablo-style PACK spawning: monsters cluster into encounters (a pack turns
  // on you together), with a few lone wanderers between them. Bigger packs
  // matter beyond raw count: the balance bot (and a real player's attention)
  // can only fully respect ONE heavy telegraph at a time â€” denser packs create
  // real overlapping-danger moments instead of a queue of solo fights.
  packSizeMin: 5,
  packSizeMax: 13,
  // HEAVY PACKS (owner 2026-07-26): brute-class kinds (archetype hpMult at or
  // above the threshold) run SMALL and SPREAD â€” 2-4 bodies holding a wide
  // ring instead of a 5-13 knot. Each heavy defends its own space, so the
  // room becomes crossing telegraphs to weave through (active dodging), not
  // a blob to arc down. Size derives from the same pack-size draw (~size/3).
  heavyPackHpMult: 2.0, // archetype hpMult threshold for the heavy formation
  heavyPackSpreadBase: 1.6, // ring spacing: base + roll * range (tiles)
  heavyPackSpreadRange: 2.2,
  packLoneFraction: 0.2, // share of the budget spawned as singles
  packEscortFromFloor: 4, // packs may include a shaman healer escort from here
  monsterBaseHp: 24,
  monsterHpPerFloor: 5.2, // 6 -> 5.2 (step 0): faster kills pay the collapse clock back at depth
  // Compounding scaling: linear per-floor growth loses to a farming player by
  // midgame (the maximalist power curve is ~quadratic). Past this floor, HP and
  // damage additionally multiply by monsterScaleCompound each floor, so the deep
  // dungeon steepens instead of flattening. Starts at floor 3 (not 1-2, which
  // stay a soft landing) so the ramp is felt well before the old floor-6 wall â€”
  // 1.055 pre-#10; nudged up for the six-slot gear budget, then again for the
  // ~40% win-rate difficulty pass. Backed off after merging the band-boss
  // rework (bosses every 3 floors, not 6) + monster TEMPO scaling (below) â€”
  // those stack with this, so this alone doesn't need to carry as much.
  // Backed off again 2026-08-04 (NICHE.md step 0): pack AI tiers 1-4, heavy
  // packs, veteran anchors and the bosses-v2 signatures all landed after the
  // 1.08 tune, each making the same monsters collectively more effective.
  // The stacked result measured 2-4% full-run win rate (48-seed sweeps) with
  // deaths spread across floors 3-17, half of them to raw combat pressure.
  monsterScaleCompoundFrom: 3,
  monsterScaleCompound: 1.048, // ~2.0x by floor 18 on top of the linear curve
  // The BUILD CHECK (owner-approved 2026-07-26): the last two bands ramp
  // again on top of the base compound. Floors 13+ demand a coherent build â€”
  // "anyone reaches the Garden, thoughtful builds reach the Ironworks,
  // optimized builds win." The inverse balance-contract test pins this:
  // a junk-drawer build must FAIL deep floors that a coherent one clears.
  deepScaleCompoundFrom: 12, // first ramped floor is 13 (Ironworks)
  deepScaleCompound: 1.035, // extra ~1.23x by floor 18
  // Deep elites lean into resist affixes (armored/warded): mono-school soup
  // without an answer gets checked, not just outstatted.
  deepResistBias: 0.35,
  // How far the balance bot's per-run "taste" can move an ability's slot score
  // (src/sim/bot.ts: tasteBonus). Purely an INSTRUMENT knob â€” nothing the game
  // simulates reads it. At 0 every seed builds the same three abilities and the
  // bottom of the roster is never measured; too high and the bot stops playing
  // a sensible build. 22 keeps melee/dash anchoring most runs while giving the
  // whole shelf real coverage across a sweep.
  botTasteSpread: 22,
  // Damage is balanced around telegraphed, dodgeable strikes: a clean hit should
  // HURT, because you saw it coming â€” see the ~40% target win rate in
  // scripts/balance-sweep.ts's design intent below. Leans on damage/compounding
  // rather than raw density for lethality: density also inflates kill-driven
  // XP pace and can swarm even a stationary player near spawn, which collided
  // with the leveling-curve and hype-economy test fixtures.
  monsterBaseDamage: 21,
  monsterDamagePerFloor: 2.9, // 4.2 -> 2.9 with the 2026-08-04 compound back-off (step 0)
  monsterSpeed: 2.6, // tiles/sec
  monsterAttackRange: 1.0,
  monsterAttackCooldown: 0.9,
  monsterAggroRange: 8, // tiles
  // Pack presence (AI tier 1): monsters take up SPACE. Separation shoves
  // overlapping monsters apart (mass-weighted â€” grunts yield to brutes;
  // winding-up monsters are rooted anchors), so a pack arrives as a crescent
  // instead of a stacked point a single cleave erases. See separateMonsters.
  monsterSeparationRadius: 0.7, // tiles of personal space
  monsterSeparationSpeed: 2.2, // tiles/sec max shove out of a stack
  // Flanking approach: melee chasers blend an id-derived tangential bias into
  // pursuit as they close (see flankVector) â€” the pack fans into a crescent
  // instead of a conga line. Strength is the max tangent-to-pursuit ratio;
  // engage range is how far out the fan starts opening.
  flankStrength: 1.3,
  flankEngageRange: 3, // tiles beyond attack range where the bias ramps in
  // Attack tokens: at most this many BASIC (grunt/swarmer) melee windups in
  // flight at once, per living crawler â€” the rest of the surround waits its
  // turn, so strikes STAGGER around the ring instead of synchronizing into
  // one big dodge. Scales with depth; elites/bosses/named kinds never wait.
  meleeTokensBase: 2, // floors 1-6
  meleeTokensEveryFloors: 6, // +1 token every N floors deeper
  meleeTokensMax: 4,
  // LOS aggro (AI tier 2): the mass archetypes commit when they SEE you (or
  // get hurt, or a packmate raises the alarm), and remember the hunt for a
  // while after losing sight â€” pursuing through the flow field. Walls hide
  // you; breaking contact is a real move. Memory follows the training-wheels
  // ramp (same doctrine as tempo): floors 1-3 are forgetful, the deep
  // dungeon holds a grudge. See monsterMemory().
  monsterMemoryBase: 3, // seconds, floors 1-3
  monsterMemoryPerFloor: 1.5, // + per floor past the ramp...
  monsterMemoryMax: 9, // ...capped (floor 7+)
  packAlertRadius: 4, // tiles the alarm spreads through the pack (LOS-gated)
  // Ranged unit play (tier 2c): archers claim distinct firing arcs â€” a
  // later-arriving caster sharing a bearing (within this angle) strafes
  // sideways until the crossfire opens â€” and when closed on they retreat
  // TOWARD their nearest melee bodyguard instead of into open space.
  rangedLaneAngle: 0.28, // radians (~16 degrees) of "that's my lane"
  rangedGuardRange: 7, // tiles it will look for a bodyguard within
  rangedGuardPull: 0.9, // blend of retreat-vector toward the guard
  // Band group personalities (tier 3): each district fights with its own
  // group doctrine on top of the tier-1/2 machinery.
  drumRushLinger: 2.5, // SEWERS: an alerted drummer's beat holds the frenzy this long (and marches the pack)
  phalanxGuardRange: 8, // RUINS: shieldbearers hold the line for a caster within this range...
  phalanxLineFraction: 0.35, // ...standing this far along the ward->crawler line
  gardenEncircleMult: 1.7, // GARDEN: flanking arcs widen â€” the growth envelops
  // Encounter director (tier 4): retreat-and-regroup. A broken survivor
  // (wounded, packmates dead around it, nobody left beside it) bolts uphill
  // on the flow field; reaching another pack raises the alarm and the fight
  // SPILLS. Once per monster â€” a survivor that finds nobody dies alone.
  regroupFromFloor: 5, // the drama starts past the training bands (probe: spilling fights cost 2 more early-floor seeds)
  regroupHpFraction: 0.5, // wounded below this...
  regroupCorpseCount: 2, // ...with this many packmates dead nearby...
  regroupCorpseRadius: 5, // ...within this radius...
  regroupSeconds: 4, // ...bolts for this long looking for friends
  monsterXp: 10,
  monsterXpPerFloor: 5, // 4 -> 5 (step 0): the 130->115 density cut also cut kill-driven XP at depth; the curve pays it back per kill
  // Depth TEMPO (play feedback: stats alone don't scare a geared crawler).
  // Past the ramp floor, monsters get quicker on every axis â€” faster chase,
  // faster swings, shorter tells. Floors 1-3 keep the training-wheel pace;
  // the caps keep the deep dungeon fast but still READABLE and dodgeable.
  // Steepened 2026-07: at 2%/floor from 4, a floor-7 tell was 94% of floor
  // 1's â€” at player speed 4.2 anything over ~0.3s is a free walk-out, so a
  // human was never hit. TEMPO (not fatter trash) is the axis that scales
  // challenge over a typical run: one-shotting chaff stays legitimate; the
  // chaff that's still alive gets its swing off sooner.
  monsterTempoFrom: 3,
  monsterTempoSpeedPerFloor: 0.03, // +3% move speed per floor past the ramp...
  monsterTempoSpeedMax: 1.45, // ...capped at +45% (still under player speed)
  monsterTempoCdPerFloor: 0.035, // attack cooldowns shrink per floor...
  monsterTempoCdMin: 0.55, // ...to at most 45% faster swings
  monsterTempoWindupPerFloor: 0.045, // telegraphs shorten per floor...
  monsterTempoWindupMin: 0.55, // ...but the tell stays readable

  // Broodmother: a walking nest that BIRTHS swarmers while it lives â€” the
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
  // death â€” and if it stays safely away long enough, it ESCAPES with all of it.
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

  // IRONWORKS cast (floors 13-15) â€” the machine learns your timing.
  ironworksFromFloor: 13,
  // Lineworker piston punch: melee that also LAUNCHES the survivor.
  punchKnockback: 1.4, // tiles
  // Sentinel lock-on: the beam TRACKS you while arming, freezes at the lock,
  // then fires. Dodge when the tracking stops â€” a timing test, not position.
  sentinelBeamCooldown: 5,
  sentinelBeamArm: 1.15, // seconds of telegraph (tracking + locked)
  sentinelBeamLock: 0.4, // final seconds when the line stops tracking
  sentinelBeamLength: 9, // tiles the railshot pierces
  sentinelBeamWidth: 0.38, // half-width
  sentinelBeamDmgMult: 1.4, // Ã— monster damage
  // Slagbreaker heat rhythm: swings until it MUST vent, then pays for it.
  slagVentAfterSwings: 3,
  slagVentWindup: 0.8, // the vent telegraph
  slagVentRadius: 2.3, // scalding cloud around it
  slagVentDmgMult: 1.2, // Ã— monster damage
  slagVentBurnFraction: 0.5, // burn total = this Ã— the vent hit
  slagVentSelfStagger: 1.5, // seconds helpless after venting â€” the punish window
  // Wind-Up Battalion: squads volley as one; broken squads fire ragged.
  toysquadMin: 4,
  toysquadMax: 6,
  toysquadVolleyCooldown: 4.5,
  toysquadWindup: 1.0, // the whole line presents muskets â€” one big dodge
  toysquadSyncMin: 3, // members alive to keep volleying in sync
  // Greeter: sparks on death â€” three short-fused zaps around the chassis.
  greeterSparkCount: 3,
  greeterSparkDelay: 0.45, // fuse on each spark (dodgeable, tight)
  greeterSparkRadius: 0.95,
  greeterSparkDmgMult: 0.5, // Ã— monster damage per spark

  // GARDEN cast (floors 7+) â€” the floor fights back.
  gardenFromFloor: 7,
  // Vine Lasher hook: the longest lane telegraph in the game, then the DRAG.
  lasherHookRange: 5.5, // tiles the whip reaches
  lasherHookWidth: 0.75, // lane half-width
  lasherHookCooldown: 6,
  lasherHookDmgMult: 0.8, // Ã— monster damage on the snag
  lasherHookLandGap: 1.2, // you land this far from the lasher (in the pack)
  // Understudy morph: the vulnerable window before the wolf.
  morphWindup: 1.0, // interruptible â€” stagger it to stay ahead of the curve
  morphHpFraction: 0.5, // transforms when damaged below this
  // Briar Witch hex: a vulnerability mark the whole pack exploits.
  hexRange: 6,
  hexDuration: 6, // seconds marked
  hexVulnerability: 0.3, // +30% damage taken while marked
  hexCooldown: 8,

  // UNDERCROFT trainers (floor 2+ â€” floor 1 stays pristine for the contract).
  undercroftFromFloor: 2,
  // Cutpurse: the lunge-stab that goes for the purse.
  cutpurseLungeRange: 2.6, // tiles the dash-stab covers
  cutpurseLungeCooldown: 4,
  cutpurseStealBase: 6, // gold stolen: base + perFloor * floor
  cutpurseStealPerFloor: 2,
  cutpurseInterest: 1.25, // the refund multiplier when you catch it
  // Ossuary Warden: slam debris â€” a lingering bone-shard zone.
  wardenShardDuration: 5, // seconds the shards stay dangerous
  wardenShardRadius: 1.6,
  wardenShardDmgMult: 0.25, // Ã— monster damage per tick (puddle cadence)
  // Pit Digger: the launch is the lesson, not the damage.
  diggerKnockback: 1.8, // tiles â€” bigger than the piston, gentler hit

  // RUINS cast (floors 10+) â€” the dead civilization drills you.
  ruinsFromFloor: 10,
  // Shieldbearer: the frontal guard (drops while it swings or staggers).
  guardArcCos: 0.5, // attacker within Â±60Â° of its facing = blocked
  guardDamageTakenMult: 0.25, // the shield eats 75% of frontal damage
  // Cleric consecration: contested ground.
  consecrateDuration: 6,
  consecrateRadius: 2.0,
  consecrateHealPerTick: 6, // monster HP per puddle-cadence tick inside
  consecrateDmgMult: 0.35, // Ã— monster damage per tick to crawlers inside
  consecrateCooldown: 9,
  // Archivist sweep: the beam that rotates.
  sweepDuration: 2.6, // seconds of channel (windup holds this long too)
  sweepRate: 1.1, // radians/sec toward the target
  sweepLength: 7, // tiles
  sweepWidth: 0.4, // half-width
  sweepDmgMult: 0.35, // Ã— monster damage per tick on the line
  sweepCooldown: 8,
  // Colossus fissure: a crack that travels â€” perpendicular movement beats it.
  fissureSteps: 5, // eruptions along the lane
  fissureStepGap: 1.15, // tiles between eruptions
  fissureStepDelay: 0.16, // seconds between eruptions (the travel)
  fissureRadius: 0.9,
  fissureDmgMult: 0.8, // Ã— monster damage per eruption

  // THE APPROACH cast (floors 16+) â€” the System fields its own.
  approachFromFloor: 16,
  // Stagehand: two hits, smoke out, marked re-entry. The mark IS the tell.
  stagehandStrikes: 2, // swings before it vanishes
  stagehandVanish: 1.4, // seconds gone (= the re-entry mark's fuse)
  stagehandRetreat: 5, // tiles it smokes away
  stagehandArriveDmgMult: 0.6, // Ã— damage on the re-entry pop (dodge the mark)
  stagehandArriveRadius: 1.0,
  // Sniper: the lane never fires twice from one spot.
  sniperCooldown: 6,
  sniperArm: 1.5, // no tracking â€” a pure position test at extreme length
  sniperLength: 12,
  sniperWidth: 0.35,
  sniperDmgMult: 2.2,
  sniperRelocateSecs: 1.5, // it spends the first part of the cooldown moving
  // Duelist: the flourish answers MELEE only.
  riposteWindow: 1.0, // seconds the blade is up
  riposteCooldown: 4,
  riposteReflectFraction: 0.7, // of the attempted hit, returned to the attacker
  riposteDamageTakenMult: 0.2, // the flourish also parries most of the hit
  // Darling: the stated kill order.
  darlingAuraRadius: 4,
  darlingAuraLinger: 0.6,
  darlingShieldMult: 0.5, // entourage takes half while she lives...
  darlingTakenMult: 1.5, // ...and SHE takes half again more (glass idol)
  // Canceled: player verbs on a monster chassis.
  canceledDashCooldown: 3, // lateral sidestep cadence
  canceledDashDist: 2.2,
  canceledNovaCooldown: 6, // its slam-nova (windup "slam", brute radius)
  // Suitguy: the mercy test â€” sparing him pays the whole party.
  suitguyEscapeHype: 12,

  // Elite affix six-pack (MOB-CONCEPTS.md) â€” the multiplication table.
  linkedRadius: 5, // allies inside soak the linked elite's damage
  linkedSoakFraction: 0.5, // share of each hit redistributed to the pack
  vampiricHealFraction: 0.5, // of damage dealt, drunk back
  juggernautSpeedMult: 0.75, // slower â€” your kiting still works; your CC doesn't
  mortarCooldown: 3.5,
  mortarMinRange: 3, // too close and it can't arc
  mortarMaxRange: 9,
  mortarDelay: 1.1, // shell hang-time (the dodge window)
  mortarRadius: 1.2,
  mortarDmgMult: 0.9, // Ã— monster damage per shell
  berserkThreshold: 0.5, // below this HP fraction the frenzy self-sustains
  executionerThreshold: 0.4, // crawlers below this HP fraction...
  executionerDmgMult: 1.5, // ...take this much more from it

  // Pack playbook (MOB-CONCEPTS.md): designed encounters â€” one mob's ability
  // is the setup for another's payoff. Budget-neutral: a template SPENDS the
  // floor's monster budget. Formation offsets do most of the choreography.
  packTemplateChance: 0.35, // share of pack rolls that use a band template

  // BOSS LAYERS (MOB-CONCEPTS.md).
  // Layer 1 â€” champions (the CHAMPIONS table below drives the spawns).
  foremanVolleyCooldown: 5,
  foremanVolleyCount: 6,
  foremanSlamCooldown: 6,
  // Layer 4 â€” THE DUO: when one QA unit dies, the survivor ENRAGES.
  duoEnrageDamageMult: 1.3,
  duoEnrageSpeedMult: 1.25,
  duoEnrageHealFraction: 0.25, // of max HP, patched in by the grief
  // Layer 3 â€” arena directors: the ROOM acts on a rhythm while the boss
  // lives, reusing the signature helpers on the arena's own metronome
  // (deliberately slower than the boss's sigCd â€” layered, not doubled).
  directorFloodInterval: 14, // floor 6: the sump RISES on its own schedule
  directorRegrowInterval: 16, // floor 9: the garden REGROWS
  directorVentInterval: 12, // floor 15: the wall vents EXHALE flame rows

  // RIVALS (competitive race mode): up to 4 hostile crawlers, individual
  // descent through concurrent floor worlds, first FINAL-BOSS kill wins.
  // Rival kills pay XP, not loot (no naked-respawn snowball).
  rivalsReviveSeconds: 15, // downed timer before auto-revive at the floor entry
  rivalsReviveHpFraction: 0.5, // revive at half HP
  rivalsReviveGraceSeconds: 2.5, // post-revive immunity (no spawn-camping the timer)
  pvpDamageMult: 0.4, // builds are tuned vs telegraphed monsters; PvP is instant
  pkXpBase: 60, // XP for dropping a rival...
  pkXpPerLevel: 30, // ...plus this per victim level â€” killing the LEADER pays most

  // Roaming: SOME monsters patrol when off-duty â€” variety in mob behavior is
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
  // catalog COMPONENTS â€” random loot that advances the build you planned.
  // 0.36 when 40% of drops were health potions; potions are gone (health
  // should be scary â€” see dropLoot), so this holds gear rates steady.
  lootDropChance: 0.22,
  componentDropChance: 0.35, // legacy knob (pre-V2 drop table); kept for reference

  // ---- ITEMIZATION V2 (Â§2): one catalog, rarities on top ----
  // Quality multipliers for CATALOG items only (Â§2.1) â€” a roll ON TOP of the
  // identity's printed line (gearAffixes). The shipped RARITIES.mult table
  // below never touches a catalog item: quality compares within a path, never
  // across (the Â§2.1 guard test pins catalog-identity-first in CI).
  catalogQualityMult: { common: 1.0, magic: 1.15, rare: 1.3, epic: 1.5 } as Record<
    "common" | "magic" | "rare" | "epic", number
  >,
  // Bonus affixes materialized at roll time per quality tier (readable, no soup).
  catalogQualityBonusAffixes: { common: 0, magic: 1, rare: 1, epic: 2 } as Record<
    "common" | "magic" | "rare" | "epic", number
  >,
  // The V2 drop table (Â§2.2), as cumulative shares of one equipment drop:
  // 55% catalog COMPONENT at rolled quality, 15% catalog COMPLETED
  // (floor-gated), 25% commodity gear (commons/magics only), 5% GLYPH (fl 2+).
  dropComponentShare: 0.55,
  dropCompletedShare: 0.15,
  // GLYPH SUPPLY (Â§3.5): sockets open faster than 5% of 22% of kills can fill
  // them â€” nine pips against ~1 glyph per 90 kills left the act-2 rebuild beat
  // staring at empty wells, which is the direct negation of fast-round
  // building. The share now roughly doubles the drip and a per-floor cap keeps
  // a lucky floor from dumping the whole pool at once (supply is steady, not
  // spiky). Paired with the STAGGERED second sockets below.
  dropGlyphShare: 0.11,
  glyphDropsPerFloorCap: 3, // at most this many field glyphs per floor
  dropCompletedFromFloor: 3, // completed works drop once the shop shelf has them
  dropGlyphFromFloor: 2,
  // DISMANTLE / REFIT (Â§2.4): the refit_shard economy.
  dismantleShards: { common: 1, magic: 2, rare: 4, epic: 8 } as Record<
    "common" | "magic" | "rare" | "epic", number
  >,
  refitShardCost: { magic: 3, rare: 6, epic: 12 } as Record<"magic" | "rare" | "epic", number>,
  refitGoldFraction: 0.4, // gold cost = this x the item's totalCost
  // Boss uniques (Â§2.5): drop-only chase items, one per band boss.
  bossUniqueChance: 0.35,
  // Elite bonus roll (Â§2.2): the extra drop is a component most of the time.
  eliteBonusGlyphShare: 0.25,

  // ---- GLYPHS (Â§3): the ability-modifier layer ----
  glyphSocket1Level: 4, // socket 1 of every active slot (~floor 2)
  // SECOND SOCKETS ARE STAGGERED (Â§3.5), one per slot index: opening all four
  // at once outran the glyph supply and turned the act-2 beat into four empty
  // wells. Now the kit grows a socket every couple of levels, so every one of
  // them has a stone waiting for it.
  glyphSocket2Levels: [11, 13, 15, 17] as number[],
  cdrCap: 0.4, // RULE 7: total % cooldown reduction clamps here (LoL-style)
  refundCapFraction: 0.5, // RULE 8: per-cast refunds total at most this x cooldown
  glyphArcSpliceFrac: 0.4,
  glyphSplitfangFrac: 0.45,
  glyphSplitfangCount: 2,
  glyphRepriseFrac: 0.4,
  glyphRepriseDelay: 0.8,
  glyphBrandDuration: 4,
  glyphBrandBonus: 0.12,
  glyphAccelerantFrac: 0.25, // burn total = this x the hit, over burnDuration
  glyphRebateFrac: 0.3, // refund per qualifying kill, of the set cooldown
  glyphRebateWindow: 1, // seconds after the cast a kill still counts
  // THE TEMPO PAIR (Â§3.3): both are DPS-NEUTRAL by construction â€” 1.30/1.30
  // and 0.80/0.80 â€” so neither is a free stat stick and neither is a trap.
  // You buy Heavyweight for burst-per-hit and poise breakpoints, Hair Trigger
  // for uptime and mobility; the `tempo` family stops them sharing a slot to
  // launder each other's downside into a flat +19% damage (the old 1.35/1.20
  // vs 0.88/0.80 pair was strictly dominant on all nine sockets).
  glyphHeavyweightDmgMult: 1.3,
  glyphHeavyweightCd: 0.3, // joins the rule-7 sum as a cooldown INCREASE
  glyphHairTriggerCd: 0.2,
  glyphHairTriggerDmgMult: 0.8,
  glyphSlipstreamSpeedMult: 1.15,
  glyphSlipstreamDmgMult: 1.1,
  glyphSlipstreamDur: 2,
  glyphCacheFromShop: 2, // the shelf row appears from shop #2 (Â§4 cadence)
  // ---- PHASE C (ABILITIES-V2 Â§5.2) ----
  glyphStaticEvery: 3, // Static Charge: every Nth CAST is empowered
  glyphStaticDmgMult: 1.6,
  glyphStaticPoiseMult: 2,
  glyphDemolitionFrac: 1, // Demolition Rider: remaining DoT dealt instantly...
  glyphDemolitionTargets: 3, // ...on at most this many bodies (Â§5.4 flag 6)
  glyphEnvenomedChance: 0.35,
  glyphCryoChill: 0.2,
  glyphCryoDuration: 2,
  glyphGraveCorpses: 3, // Grave Dividend: corpses consumed under the cast
  glyphGraveBonus: 0.15, // ...+15% damage each
  glyphGraveRadius: 2.5,
  glyphCullingBonus: 0.5, // Culling Edge: +50% below the threshold...
  glyphCullingThreshold: 0.25,
  glyphPoiseWreckerMult: 2,
  glyphPoiseWreckerStagger: 0.3,
  glyphPointBlankRange: 2,
  glyphPointBlankBonus: 0.3,
  glyphPointBlankPenalty: 0.15,
  glyphLongshotRange: 4,
  glyphLongshotBonus: 0.3,
  glyphLongshotPenalty: 0.15,
  glyphBloodPriceHpFrac: 0.03, // Blood Price: casts cost 3% max HP...
  glyphBloodPriceDmgMult: 1.3, // ...for +30% damage (family: tempo, Â§5.4 flag 1)
  glyphPhaseEtchIframes: 0.15,
  glyphPhaseEtchFrac: 0.3,
  glyphUnderstudyContract: 2, // Understudy's Rider: +2s on the double's contract
  glyphUnderstudyChill: 0.25,
  glyphEncoreRefund: 0.04, // Encore Clause: per kill inside the ult's window
  glyphEncoreFallbackWindow: 3, // ...an ult with no duration gets this window
  glyphColdOpenRadius: 6,
  glyphColdOpenChill: 0.3,
  glyphColdOpenDuration: 3,

  // ---- New COMPLETED-work passives (Â§2.3) + boss-unique passives (Â§2.5) ----
  longarmMinDist: 1.5, // Pikeman's Rebuttal: melee hits from this far knock back...
  longarmKnockback: 0.5, // ...this many tiles
  wreckerBonus: 1.4, // Demolition Permit: stagger-breaking hits deal this mult
  rentGoldMult: 1.2, // Slumlord's Deposit: monsters drop this much more gold
  chaserFraction: 0.03, // Ambulance Chaser: heal this slice of damage dealt (leech cap applies)
  groundedHpFraction: 0.7, // Grounded Suit: above this HP...
  groundedSpellMult: 1.15, // ...spell power runs this much hotter
  bellCorpseGold: 4, // Front Desk Bell: gold per denied corpse...
  bellCorpseHealFraction: 0.01, // ...and this slice of max HP back
  sumpHazardTakenMult: 0.5, // Sump Crown: ground hazards deal half to the wearer...
  sumpStatusDurMult: 1.5, // ...and the wearer's chill/poison last this much longer
  shearsEveryHits: 3, // Rootcutter Shears: every Nth melee hit...
  shearsSnareSeconds: 0.6, // ...SNARES (heavy chill) the target this long
  girderReflectFraction: 0.3, // Loadbearing Girder: mitigated damage shards back at this rate
  spreadburnRadius: 4, // Furnace Draft: a burning death spreads within this many tiles
  // Build-matters pass: gear's share of the power stat. Applied to damage/spell
  // rolls on BOTH drop generation (items.ts rollAffix) and catalog
  // materialization (catalog.ts gearAffixes) so shop/drop tier parity holds.
  // Paired with damagePerLevel 3 -> 2: total power stays ~flat, but the gap
  // between junk-drawer gear and an optimized loadout roughly doubles.
  gearPowerMult: 1.35,
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
  // Off-class melee: swinging a caster/ranged weapon (arcane/ballistic) is a
  // pommel bash â€” the mirror of boltSidearmMult below. A melee build holding
  // a wand should feel it (gear coherence; owner ruling 2026-07-26).
  offclassMeleeDmgMult: 0.65,
  boltSidearmMult: 0.6, // melee-class weapon: bolt is a thrown sidearm (attack power)
  boltBallisticMult: 1.0, // Crossbow: real bolts, full attack power
  boltBallisticSpeedMult: 1.3, // ...and they MOVE
  boltArcaneMult: 0.9, // Wand/Staff: magic missiles off spell power
  wandBoltCdMult: 0.8, // Wand: faster casts
  staffAoeRadiusMult: 1.25, // Staff: bigger nova
  chaoticBoltMult: 0.75, // the Mug does everything, badly (best school, discounted)
  tempoCooldownMult: 0.85, // "tempo" signature passive: active cooldowns run faster
  // Chase passives (store-only legendary uniques â€” plan three shops ahead):
  encoreOrbitTickMult: 0.75, // "encore": orbit blades tick this much faster (+1 blade too)
  skewerBonusPierce: 2, // "skewer": bolts punch through this many extra bodies
  // "choreography": stance swap resets swing + bolt cooldowns (no knob â€” binary)
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
  // Damage rolls: every player hit rolls Â±variance around its base, and the
  // WEAPON sets the dice. Swift is a metronome, heavy is a gamble per swing,
  // the Mug is a slot machine. Bare hands (and monsters) roll Â±0.15.
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
  shamanHealWindup: 0.8, // channel before the heal lands â€” the interrupt window

  // Phantom: fast, fragile skirmisher that blinks toward its prey.
  phantomBlinkDistance: 3, // tiles teleported per blink (wall-clipped)
  phantomBlinkCooldown: 2.8, // seconds between blinks

  // Brute Ground Slam: its ONE attack is a self-centered AoE (no facing/arc â€”
  // everyone standing close eats it), not a single-target point hit. Same
  // windup as before; the long telegraph is the dodge window either way.
  bruteSlamRadius: 1.5, // tiles from the brute's own position

  // Boss kit escalation (DESIGN: boss-tier fights should feel like escalating
  // KITS, not just bigger numbers on one script). Adds waves at phase breaks +
  // hazard rain are UNIVERSAL boss behavior (backlog #11); the tiers layer on
  // top of that (band-end bosses ALSO carry a per-band signature â€” see below):
  //   tier 0 (floor 3)            â€” melee+volley only (early-game, gentle)
  //   tier 1 (floors 6, 9)        â€” + Ground Slam
  //   tier 2 (floors 12, 15)      â€” Ground Slam cycles faster
  //   tier 3 (floor 18 final boss)â€” + Dark Ritual (a real interrupt-or-hurt stake)
  // Anti-kite (backlog #6, movement half): a boss that can't REACH you loses
  // patience â€” chase speed ramps while you stay out of melee reach, and one
  // moment of contact resets it. Circling the arena stops being free; the
  // counterplay becomes standing your ground in windows, which is the fight.
  bossChaseRampDelay: 3.5, // seconds out of reach before the ramp starts
  bossChaseRampRate: 0.15, // +chase multiplier per second past the delay
  bossChaseRampCap: 1.65, // top multiplier â€” outrunnable only by spending dashes
  bossSlamRadius: 2.4, // tiles: bigger than the brute's â€” it's arena-scale
  bossSlamRange: 3.2, // tiles: max distance the boss will commit a slam from
  bossSlamWindup: 0.9, // seconds telegraphed before it erupts
  bossSlamCooldown: 6.5, // seconds between slams (independent of melee/volley)
  bossSlamHasteT2: 0.65, // tier 2+ slam-cooldown multiplier (the tier-2 escalation)
  bossSlamDmgMult: 0.85, // relative to the boss's own damage stat (it's a BONUS hit)
  ritualRange: 9, // tiles: the boss will channel from anywhere in the arena
  ritualWindup: 1.9, // seconds â€” long and unmistakable; interrupt it or eat it
  ritualCooldown: 14, // seconds between rituals
  ritualRadius: 3.6, // tiles: arena-scale AoE around the boss
  ritualDmgMult: 1.9, // relative to the boss's own damage stat â€” this one HURTS

  // Charger: locks a direction during a LONG windup, then rushes down the line,
  // plowing through anyone still standing on it. Sidestep the lane â€” the commit
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
  corpseMax: 40, // corpse list cap (oldest fall off â€” bounded state)
  necroRaiseRange: 5, // tiles: corpses it can reach
  necroRaiseCooldown: 5, // seconds between raises
  necroRaiseMax: 4, // lifetime raises per necromancer
  necroRaisedHpMult: 0.6, // raised minions come back at reduced HP
  necroRaisedXp: 1, // raised minions are worth almost nothing (not a farm)

  // Ultimates (the fifth slot): long cooldowns, screen-scale impact.
  ultAirstrikeCooldown: 45,
  ultAirstrikeShells: 6,
  ultAirstrikeRadius: 1.6, // per-shell blast radius (tiles)

  // V2 U2: 2.5 -> 1.7 (per-shell damage paying for ~11 shells instead of 6),
  // then 1.7 -> 1.9 when Â§6.4.9(ii) was finally MEASURED: at 1.7 the whole
  // channel delivered 2.34x the best 3s of melee, under the pre-registered
  // 2.5x bar. Channel length is not the lever -- shells and swings both scale
  // with the window, so the ratio sits at ~2.39 whatever the channel is --
  // and the pre-registered fallback ladder (3.0s -> 2.0s, then cut the
  // commitment) is aimed at a commitment that is UNAFFORDABLE, which Â§6.4.9(i)
  // measures it is not (a barrage window takes LESS damage than normal play at
  // floors 4/8/12). So the payoff moved instead: 1.9 lands 2.61x.
  ultAirstrikeDmgMult: 1.9,
  ultAirstrikeSpread: 2.2, // shell scatter around the target point
  ultAirstrikeRange: 8, // max targeting distance from the caster
  ultCataclysmCooldown: 40, // V2 U1: the fissure is worth a longer act
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
  ultBulletTimeSecondWind: 0.4, // Second Wind: the first kill inside adds this

  // Fun-kit wave (ABILITY-CONCEPTS.md): Blindside / Extradition / Stunt Double.
  cutToRange: 6, // tiles the camera can cut
  cutToCooldown: 6, // long enough that each cut is a decision, not a spam
  cutToDmgMult: 1.9, // V2 R6: 1.2 -> 1.9 â€” a strike, not a mobility tax
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
  // Keeping hype above the floor suppresses all of it â€” hype is cover.
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

  // ---- CLASS REVISION (milestone castings â€” the menu lives in revisions.ts) ----
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
  // COLLAPSE (ABILITIES-V2 R1): the cast GATHERS, then detonates. The buff is
  // entirely in N â€” per-target damage is unchanged.
  novaCooldown: 6.0, // V2 R1: 5.0 -> 6.0; the gather is worth a longer phrase
  novaRadius: 2.6,
  novaDamageMult: 1.2, // relative to melee base damage
  // Gather reach = blast radius x this. Â§6.4.2 is what SETS this number: the
  // contract is mean gathered >= 2.5 per cast in bot play at floors 4/8/12,
  // and the doc's illustrative 1.6 measured 1.83 against the shipped spacing
  // (HEAVY PACKS deliberately run spread). The gather deals no damage at its
  // edge â€” its whole job is to make N stop being zero.
  novaGatherMult: 2.3,
  novaGatherRing: 1.2, // dragged bodies land on a ring this far out
  novaGatherStep: 4.5, // max tiles one cast can drag a light body
  novaHeavyDragFrac: 0.4, // elites/bosses resist: they move this fraction
  novaCrushStagger: 0.6, // Crush: dragged targets land staggered this long
  novaCrushBonusPerRank: 0.25, // Crush: extra blast damage to DRAGGED targets
  novaRiftSeconds: 2, // Rift: the implosion point keeps pulling this long
  novaRiftRadius: 2.4, // Rift singularity reach (tiles)
  orbitBladesBase: 2,
  orbitRadius: 1.6,
  orbitRevPerSec: 1.1, // revolutions per second
  // V2 R3: the ambient grind pays for the hurl, so the ability's damage moves
  // from the passive to the PRESS. Â§6.4.5 pins ambient orbit under 40% of
  // melee's single-target DPS AT THE REFERENCE BUILD, and that pin is what
  // sets this number: the ratio is exactly orbitDamageMult x blades x
  // (playerAttackCooldown / orbitTickSeconds) = mult x 2, so the doc's
  // proposed 0.22 reads 0.44 and FAILS its own contract on a bare crawler
  // (it only cleared on fixtures whose gear and ranks happened to favor
  // melee). 0.18 is the largest value that passes, and the test says so.
  orbitDamageMult: 0.18,
  orbitTickSeconds: 0.4,
  // ORBIT HURL (V2 R3): pressing the slot throws the ring out and back. No
  // aura until it returns â€” that is the counterplay window.
  orbitHurlCooldown: 7,
  orbitHurlRange: 5.5, // tiles out (Corkscrew extends by orbitHurlWideBonus)
  orbitHurlSpeed: 10, // tiles/sec, each way
  // Per pass, relative to one grind tick. R3's goal is that the PRESS carries
  // roughly what the aura lost, so this is sized against the ~7s cycle rather
  // than left at the doc's illustrative 2.6 (which would have moved about a
  // tenth of the damage, not half of it).
  orbitHurlPassMult: 6,
  orbitHurlWideBonus: 0.4, // Corkscrew: +40% travel
  orbitHurlHitRadius: 0.6,
  orbitGuardCooldown: 3, // Crossguard: one parried melee hit every this many seconds
  dashVeilSeconds: 1.5, // Smoke Break: monsters inside the puff drop their target
  dashVeilRadius: 1.2,
  dashBlinkPassFrac: 0.4, // Long Blink: pass-through damage, fraction of Shockstep
  orbitBladeHitRadius: 0.5,
  // Swept-path hit test: the damage tick checks this many positions along each
  // blade's travel since the last tick, so blades hit what they visibly passed.
  orbitHitSamples: 8,
  // Corkscrew (orbit.wide): blades spiral between this inner radius and
  // orbitRadius + perRank * rank, oscillating at this rate â€” coverage across
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
  // BREAKER (V2 R5): the poise shatter is BASE now, and the multiplier pays
  // for it (1.5 -> 1.35).
  overchargeDamageMult: 1.35, // the banked attack's base multiplier
  overchargeBossPoiseMult: 2, // a banked hit does this much poise to bosses
  overchargeWindowSeconds: 2, // Open Season: vulnerability window after a break
  overchargeWindowBonus: 0.2, // Open Season: +20% from everything, while it holds
  overchargeChainRadius: 2.5, // CHAIN REACTION: the stagger propagates this far
  // BATTLE STANCE (V2 R4): the swap fires a free strike in the new stance's
  // shape â€” but only if you were SETTLED (Flow ungates it at reduced power).
  stanceStrikeArcMult: 1.3, // the swap swing is wider
  stanceStrikeBoltMult: 1.3, // the swap bolt hits harder
  stanceFlowStrikeMult: 0.6, // Flow ungates the strike at this power
  stanceFootworkRefund: 0.4, // Footwork: seconds refunded (rule-8 budgeted)
  // BLINDSIDE (V2 R6): the roster's single-target BURST.
  cutBrandSeconds: 3, // Continuity rider: brand duration
  cutBrandBonus: 0.12, // ...matching Brandmark exactly; strongest wins, no stack
  // EXTRADITION (V2 R7): the base chain now HITS and drags three.
  surfBaseHitFrac: 0.9, // arriving/landing deals this x power in surfDiveRadius
  surfBaseDrag: 2, // extra light bodies the base chain drags (Long Arm adds)
  // BULWARK (N1): the missing defensive window.
  bulwarkCooldown: 12,
  bulwarkSeconds: 1.5,
  bulwarkMitigation: 0.6, // damage taken is reduced by this while braced
  bulwarkGritMitigation: 0.75, // Grit: harder brace, greedier payout
  bulwarkHealFrac: 0.4, // heal this fraction of what the brace absorbed...
  bulwarkHealCap: 0.25, // ...capped at this fraction of maxHp
  bulwarkRallyFrac: 0.6, // Rally: pays out immediately at this value
  bulwarkAllyRadius: 2, // Dig In: allies (and your double) inside are covered
  bulwarkAllyPerRank: 1, // ...+1 tile per rank
  bulwarkShoveRadius: 2, // Shove rider: expiry knocks back this far
  bulwarkShoveTiles: 1.6,
  bulwarkShoveStagger: 0.6,
  bulwarkSpiteCap: 2, // SPITE: banked damage capped at attackPower x this
  // STAGE CABLES (N2): hard control + zone denial.
  cablesCooldown: 9,
  cablesLength: 6, // tiles of line
  cablesWidth: 1, // half-width of the line (tiles)
  cablesPinSeconds: 1.6, // non-boss pin
  cablesBossPinSeconds: 0.6,
  cablesRepinLockout: 8, // seconds before the same body can be pinned again
  cablesFieldSeconds: 4, // slow field after the pin drops
  cablesFieldSlow: 0.35,
  cablesSpanPerRank: 1.5, // Span: +tiles of line per rank
  cablesLiveFrac: 0.5, // Live Wire: damage/sec while anything is pinned
  cablesSnapTiles: 1.2, // Snapback: yanked back toward the LINE, never the player
  // FAULT LINE (U1, was Cataclysm): the ground stays broken.
  faultLineSeconds: 10, // fissure duration
  faultLineTickFrac: 0.25, // per second, as a fraction of the blast
  faultLineSlow: 0.3,
  faultLineAftermathBonus: 0.6, // Aftermath: the fissure ticks 60% harder
  faultLineEpicenterSeconds: 1.5, // Epicenter: +fissure seconds per rank
  // SPONSOR BARRAGE (U2, was Airstrike): a 3s directed channel.
  barrageSeconds: 3,
  barrageInterval: 0.28, // one shell every this many seconds (~11 shells)
  barrageMoveMult: 0.7, // you move at 70% and cannot attack while directing
  barrageSpreadMult: 0.5, // scatter, relative to ultAirstrikeSpread
  barrageBandWidth: 2, // Saturation: the shells cover a 2-tile band
  barrageTrackRadius: 2, // Precision: shells snap to an elite/boss inside this
  // INJUNCTION (N3): the ultimate about the RUN CLOCK.
  injunctionCooldown: 70,
  injunctionFreeze: 12, // seconds the collapse timer holds
  injunctionDebtRatio: 5 / 3, // DERIVED, never a free knob: debt = freeze x this
  injunctionDamageBonus: 0.25, // you hit this much harder inside
  injunctionCrunchFreeze: 7, // Crunch Time: shorter window...
  injunctionCrunchBonus: 0.4, // ...and a much bigger bonus
  injunctionRecessFreeze: 18, // Recess: longer window, no damage bonus
  injunctionEnrageSpeed: 0.3, // monsters move +30% inside the window
  injunctionEnrageWindup: 0.2, // ...and wind up 20% faster
  injunctionDismissedRadius: 8, // DISMISSED: nothing alive inside cuts the debt
  // How much DISMISSED WITH PREJUDICE takes off the debt. The doc says
  // "halved", and Â§6.4.4 says the net run-clock delta must be NEGATIVE at
  // every rank INCLUDING after DISMISSED. Those two cannot both hold at a 5/3
  // ratio: half of 5/3 is 5/6, i.e. less than the freeze, i.e. the capstone
  // would print time â€” exactly the defect the whole ability was rewritten to
  // avoid. The assertion outranks the adjective, so the relief is a quarter.
  injunctionDismissedRelief: 0.25,
  // STUNT DOUBLE (R8): the double can DIE.
  doubleHpFraction: 0.35, // decoy maxHp = this x the owner's maxHp
  doubleHpPerBreakRank: 0.2, // Big Break: +20% decoy HP per rank
  doubleAwardRefund: 0.6, // AWARD SEASON: a double that DIES refunds this much
  doublePyroBurnSeconds: 3, // Pyro: the blast leaves burning ground
  // Ability tomes: dungeon-found unlocks for undiscovered abilities.
  tomeDropChance: 0.06, // per-kill chance while abilities remain undiscovered
  // Ultimates are the late-run power spike: no discovery pool (tomes, chips)
  // offers one before this floor. Landing right after the Sump King falls,
  // so the second act opens with the big toys.
  ultimateMinFloor: 7,
  upgradeDraftSize: 3, // cards offered per level-up
  // Overranks: lottery ranks past a node's printed max (see rollUpgradeDraft).
  overrankChanceBase: 0.05, // draft chance to dangle one on floor 0
  overrankChancePerFloor: 0.01, // added per floor â€” the deep dungeon tempts harder
  overrankChanceMax: 0.2, // even floor 15+ stays a gamble

  // Fog of war
  fogVisionRadius: 8.5, // tiles revealed (and entities visible) around the player
  // Interest management (net snapshots): ordinary monsters farther than this
  // from every living player are omitted from DYNAMIC snapshots â€” they are
  // hidden by fog anyway, and on dense floors they were most of the payload.
  // Bosses, named elites, and key carriers always ship (boss bar scans to 16
  // tiles; the key matters wherever it is). Must comfortably exceed both
  // fogVisionRadius and the hosts' widest monster scan (controller auto-aim, 8).
  interestRadius: 12.5,

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
    hypeToysoldier: 3, // chaff â€” the VOLLEY dodge is where the hype lives
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
    hypeStagehand: 8, // catching it AT the re-entry mark is prediction on film
    hypeSniper: 8, // closing on the lane-shooter across the room
    hypeDuelist: 8, // out-fencing the fencer
    hypeDarling: 10, // ending the System's favorite, live
    hypeCanceled: 12, // the mirror match â€” beating a former favorite
    hypeSuitactor: 6, // the beast was fine television
    hypeSuitguy: 0, // killing the guy in the suit is BAD television
    hypeForeman: 25, // a champion falls â€” almost boss-grade ratings
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
  // Weapon Mod is juicy; the tenth is a rounding error â€” so stacking one stat
  // every floor stops being the obvious play and the varied pool (armor,
  // materials, favors, gear) competes. Per-axis k (owned units match makeReward).
  rewardDrDamageK: 45, // owned = bonusDamage
  rewardDrMaxHpK: 140, // owned = bonusMaxHp
  rewardDrCritK: 16, // owned = bonusCrit * 100 (percentage points)
  rewardDrArmorK: 40, // owned = bonusArmor

  // Boss hierarchy (DCC-style):
  // - NEIGHBORHOOD BOSS: one elite monster per ordinary floor (2+) â€” a beefed-up
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
  // VETERAN tier (owner 2026-07-26: "more variety in the power levels of
  // mobs"). The power ladder read trash -> named elite -> boss, and on-curve
  // crawlers one-shot ~85% of early spawns â€” there was no fanfare-free
  // middle rung. Veterans are a pack's long-surviving anchor: bigger
  // silhouette, real HP (3-5 on-curve swings), a real hit, triple XP â€” but
  // NO name, affix, or announcement. The silhouette is the whole telegraph.
  veteranFromFloor: 3, // floors 1-2 stay the pure on-ramp (fresh-crawler
  // mortality there is already real: a 20-seed probe at fromFloor 2 dropped
  // floors-1-4 bot survival 12/20 -> 9/20; fromFloor 3 restores it)
  veteranPackChance: 0.35, // share of rolled packs anchored by a veteran
  veteranHpMult: 3.4,
  veteranDmgMult: 1.35,
  veteranSpeedMult: 0.9, // survivors don't hurry
  veteranXpMult: 3,
  veteranScale: 1.25, // body radius + render scale (between grunt and elite)
  // One-shot insurance: a single player hit can never remove more than this
  // fraction of a boss/elite health pool, whatever the build finds next.
  bossHitCapFraction: 0.1,
  eliteHitCapFraction: 0.12,
  // Elite AFFIXES (from this floor): each named elite rolls one mechanic â€”
  // swift (+speed), shielded (takes less damage), volatile (delayed death
  // blast â€” clear the corpse), summoner (calls swarmer adds), splitter
  // (bursts into swarmers on death), thorns (reflects a slice of your hits).
  eliteAffixFromFloor: 3,
  // Ringside introductions: closing within this range of an unmet boss/elite
  // freezes the world for the reveal (nobody gets hit mid-banner).
  encounterRevealRadius: 7, // tiles
  encounterIntroSeconds: 2.2,
  swiftSpeedMult: 1.4,
  shieldedDamageTakenMult: 0.7,
  // School resists (5.8 phase 3): armored/warded elites and resist-tagged
  // archetypes take this fraction of matching-school damage (âˆ’30%).
  resistDamageTakenMult: 0.7,
  volatileDelay: 0.8, // seconds from death to blast (the dodge window)
  volatileRadius: 1.5, // tiles
  volatileDmgMult: 1.2, // relative to the elite's damage stat
  summonCooldown: 4, // seconds between summons
  summonMax: 6, // lifetime adds per summoner
  summonWindup: 0.7, // channel before the add arrives (summoner elites + broodmother)
  // Ambushes (deep-floor tactic): some packs spawn DORMANT â€” inert and quiet in
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
  bandBossHp: [1050, 4320, 8400, 14690, 21600],
  bandBossDmgMult: [0.5, 0.7, 0.7, 0.7, 0.7], // x bossDamage per arena
  bandBossXpMult: [0.2, 0.4, 0.4, 0.4, 0.4], // x bossXp per arena
  cityBossAdds: 2, // ranged escorts
  // Ordinary-crowd share on a boss floor: thinner mid-run so the arena fight
  // stays the show; the final band keeps the deep-dungeon density story.
  bossFloorCrowd: 0.5,
  bossFloorCrowdDeep: 0.8,
  bossFloorCrowdDeepFrom: 13,

  // SIGNATURE boss mechanics â€” one themed ability per band-end arena, layered
  // on the shared melee+volley+phase kit (dispatch in ai.ts, helpers in
  // game.ts). Every one of them telegraphs: pools ARM before they bite,
  // impact circles ring before they land, the raise is an interruptible
  // channel. Floor 18's crown stays the tier-3 Dark Ritual (above).
  // UNDERCROFT (floor 3): Grave Rising â€” raises fresh corpses as weakened adds.
  graveRaiseCooldown: 10, // seconds between raise channels
  graveRaiseWindup: 1.1, // channel length (staggering it cancels the raise)
  graveRaiseRange: 7, // tiles: corpses it can reach
  graveRaiseCount: 3, // corpses raised per channel (freshest first)
  // SEWERS (floor 6): Flood Surge â€” sludge pools blanket a seeded half of the
  // arena; they arm (telegraph), then tick like acid until they drain.
  floodCooldown: 12, // seconds between surges
  floodTelegraph: 1.6, // seconds a pool arms before it goes live (the dodge window)
  floodDuration: 3.5, // seconds a live pool keeps ticking
  floodPools: 12, // pools per surge
  floodPoolRadius: 1.6, // tiles
  floodDmgMult: 0.4, // per-tick damage relative to the boss's damage stat
  // GARDEN (floor 9): Entangling Roots â€” root zones SNARE (heavy slow, no
  // damage) players who stay; dashing out is the escape.
  rootsCooldown: 9, // seconds between casts
  rootsTelegraph: 1.1, // seconds a zone arms before it grips
  rootsDuration: 2.6, // seconds a live zone keeps gripping
  rootsRadius: 1.5, // tiles
  rootsSnare: 0.7, // seconds of snare refreshed while standing in a live zone
  rootsSlowMult: 0.35, // move-speed multiplier while snared
  rootsExtra: 2, // extra seeded zones beyond one per crawler
  // RUINS (floor 12): Collapsing Masonry â€” telegraphed debris impact circles
  // rain all fight (one per crawler + seeded scatter), not just from phase 1.
  debrisCooldown: 6.5, // seconds between volleys
  debrisDelay: 1.3, // seconds from telegraph to impact
  debrisRadius: 1.6, // tiles
  debrisCount: 6, // circles per volley (players targeted first, rest scatter)
  debrisDmgMult: 0.9, // relative to the boss's damage stat
  // IRONWORKS (floor 15): Flame Sweep â€” an advancing wall of fire, row by
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
  // floors ONE of â€” a System Shrine (pick-1 bargain), a timed vault (sealed
  // treasure that opens on approach and re-seals on a timer), or a sponsor
  // challenge (clear a room's pack untouched for a purse). Pure sim data;
  // hosts only render and announce.
  eventChance: 0.7, // share of eligible floors that roll an event at all
  shrineBloodCostFraction: 0.2, // Blood Price: HP offered (of max, floored at 1)
  shrineBloodCrit: 0.03, // ...for this much permanent crit
  shrineGreedSpeedMult: 1.15, // Greed Clause: this floor's monsters speed up...
  shrineDraftTimeCost: 20, // Overtime Draft: seconds the collapse clock loses
  shrineLoanGain: 45, // Time Loan: seconds granted on THIS floor...
  shrineLoanDebt: 30, // ...and what the NEXT floor's budget pays back
  shrineLiquidateBonus: 1.5, // Liquidation Event: bag buyout premium over sell value
  shrinePremiumCostFraction: 0.3, // Insurance Premium: slice of current gold

  // Service rooms (roomPurposes phase 4): RARE room verbs. At most ONE room
  // per floor is "open for business" (serviceChance, rolled in the pure
  // assignment), it must be pristine/overgrown, and every verb costs â€” gold,
  // a losing-odds stake, or it pays in knowledge/time instead of power.
  serviceChance: 0.4, // fraction of eligible floors with a service room
  svcTemperCost: 35, // forge: gold cost base...
  svcTemperCostPerFloor: 8,
  svcTemperDamage: 3, // ...for this much permanent damage (both schools)...
  svcTemperDamagePerFloor: 0.5,
  svcDraughtCost: 25, // apothecary: full heal + cleanse
  svcDraughtCostPerFloor: 5,
  svcWagerStake: 30, // den: double or nothing...
  svcWagerStakePerFloor: 10,
  svcWagerWinChance: 0.45, // ...and the house deals
  svcPlansTime: 20, // war room: seconds added to the collapse clock
  // THE CHASE (floor stories): looters who swept the last floor are ahead,
  // as fleeing Repo Rats carrying the haul.
  chaseFilcherCount: 2,
  chaseFilcherCarry: 40, // gold each carries base...
  chaseFilcherCarryPerFloor: 10,
  // Destructible dressing (phase 5): smashing a hoard pops pocket change.
  breakableGoldBase: 3,
  breakableGoldSpread: 4, // + up to this much, seeded
  breakableCountMin: 2, // per dressed room with an intact corner hoard...
  breakableCountMax: 3,
  // Physical furniture (PHYSICALITY.md Â§1): blocking pieces take real hits.
  blockerHp: 2, // smash through the bookcase in two swings
  blockerRunMin: 2, // bulk wall-furniture run length...
  blockerRunMax: 4,
  // Furniture density budget: at most this fraction of a room's interior may
  // be blocking furniture. Keeps the consistency rule (all bulk furniture
  // blocks, on every wall) from turning small early-floor rooms into mazes â€”
  // measured by the bands bot, uncapped four-wall runs spiked floor-1..3
  // deaths from ~10% to ~60%.
  blockerRoomFraction: 0.16,
  shrineGreedGoldMult: 2, // ...and its gold drops pay double
  vaultOpenSeconds: 45, // how long a sprung timed vault stays open
  vaultTriggerRadius: 3, // tiles beyond the room rect that spring it
  challengeGoldBase: 40, // sponsor-challenge purse...
  challengeGoldPerFloor: 15, // ...plus this per floor
  challengeHype: 25, // hype paid alongside the purse

  // Boss (floor 18)
  bossHp: 34000,
  bossHpPerFloorOver: 0, // (kept for future scaling)
  // 52 -> 44 (2026-08-04, step 0): bossDamage was 38 when the last healthy
  // full-run rate (35.4%) was measured; bosses-v2 raised it to 52 and tuned
  // fight HP with receipts but never re-ran the FULL-RUN sweep. Probed at 52:
  // band-boss fights were killing healthy, full-clock runs at every depth
  // (4 of 15 deaths on seeds 49-64). Still +16% over the pre-V2 value —
  // a clean boss hit keeps hurting; it stops two-shotting the on-curve bot.
  bossDamage: 44,
  bossSpeed: 2.2,
  bossXp: 500,
  bossVolleyCooldown: 2.4,
  bossVolleyCount: 10, // projectiles per radial volley
  // Boss phases: crossing 2/3 and 1/3 HP enrages â€” faster chase, denser volleys.
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
  // each crawler's position â€” standing still through the enrage is a choice.
  bossHazardCooldown: 5, // seconds between hazard volleys (phase >= 1)
  bossHazardDelay: 1.25, // seconds from telegraph to detonation (the dodge window)
  bossHazardRadius: 1.7, // tiles
  bossHazardDmgMult: 1.1, // relative to the boss's damage stat

  // ===== BOSSES V2 (BOSSES-V2.md) ===========================================
  // Everything here answers ONE measured problem: across three runs x six boss
  // floors the audit found 6 distinct bosses, 6 distinct signatures, and 1
  // arena shape â€” variety across runs was literally zero. The knobs below are
  // the price of the fix: mechanics that add real seconds to a fight, paid for
  // by taking HP back out (see bandBossHp above and BALANCE-NOTES.md).

  // -- Verb V1: breakable plates / weak points.
  // Plate pools are a fraction of the boss's own HP, so they scale with the
  // band budget instead of needing per-band tables.
  plateHpFraction: 0.09, // per plate, x the boss's maxHp
  plateBossDamageMult: 0.35, // body damage taken while ANY plate still stands
  plateHitCapFraction: 0.22, // one-shot insurance for plates (they're small)
  plateBreakStagger: 1.2, // seconds the boss reels when a plate goes

  // -- Verb V2: boss shield pool (absorb HP that regrows).
  shieldFraction: 0.16, // pool size, x the boss's maxHp
  shieldRegenDelay: 3.0, // seconds without damage before it starts regrowing
  shieldRegenPerSec: 0.09, // fraction of the pool restored per second
  shieldBreakStagger: 1.6, // seconds of punish window when the pool empties

  // -- Verb V4: the punish window. Every V2 boss over-commits on a readable
  // count and becomes briefly helpless â€” the slagbreaker's vent, at boss
  // scale. This is what makes a fight a rhythm you learn, not a wall you erode.
  bossPunishAfter: 3, // signature commits before the over-extension
  bossPunishWindow: 2.2, // seconds of self-stagger (the unload)
  bossPunishWindup: 0.8, // telegraph before the over-commit resolves

  // -- Verb V5: hard enrage. A ceiling on fight length for a short-session
  // game. Deadline is ~2x the 45-90s target; it should almost never fire.
  bossEnrageDeadline: 150, // seconds of live fight before the System loses patience
  bossEnrageStackSeconds: 10, // seconds per additional stack after that
  bossEnrageDmgPerStack: 0.12, // +damage per stack (multiplicative on the stat)
  bossEnrageMaxStacks: 8,
  mutatorOvertimeFraction: 0.4, // OVERTIME: deadline x this

  // -- Verb V6: intermission ("THE COMMERCIAL BREAK"). The boss goes briefly
  // untargetable, a shockwave CLEARS live hazards, and the adds wave arrives
  // as part of the beat â€” the board is re-dealt rather than compounded.
  bossIntermissionSeconds: 1.6,

  // -- Verb V8: add tether. A tethered add FEEDS its boss until it is killed.
  tetherHealPerSec: 0.003, // fraction of boss maxHp per second per live tether
  tetherRange: 12, // tiles: past this the cord snaps (it stops feeding)
  mutatorUnionReviveDelay: 4.5, // UNION RULES: seconds before an add gets back up

  // -- V9/V10 selection + mutators.
  bossMutatorFromFloor: 6, // floor 3 stays pristine (mirrors "floor 1 stays pristine")
  bossMutatorSecondFromFloor: 15, // two mutators only in the last two bands
  bossRepeatEscalateAt: 2, // Nth defeat: opens at the phase-2 kit, shorter intro
  bossRepeatMutatorAt: 5, // Nth defeat: one free mutator on top of the draw
  bossRepeatIntroMult: 0.55, // intro freeze multiplier on a rematch

  // -- Arena variants (Â§4.3). The arena was a fixed 19x19 empty square on
  // every band, every run. Pillars are ordinary `breakables` with footprints,
  // so the Architect demolishing your cover needs no new verb at all.
  arenaPillarCount: 6, // PILLARED: destructible cover pieces
  arenaPillarHp: 4, // hits to fell one (blockerHp is 2 â€” arena cover is stouter)
  arenaPropCount: 4, // interactive props (floodgates / vents / conveyors)
  arenaPropHp: 3,
  arenaSplitGap: 5, // SPLIT: tiles of chokepoint left open through the divide
  // OPEN IS NOT EMPTY. Â§2.1 names "a featureless square" as the failure
  // condition, and a capture of the floor-3 Rent Collector â€” the first boss
  // most players ever meet â€” was exactly that: beige floor, one ring, nothing
  // else. An open arena keeps its clear middle (lanes, fissures and citations
  // depend on it) and gains a sparse RIM of smashable staging around the
  // outside: scale reference, silhouette, and something to break.
  arenaRimCount: 8,
  arenaRimHp: 2,
  // OPEN: extra tiles per side. Held at ZERO deliberately. Measured: at +2 the
  // 21x21 arena grazes enough corridors that lockStairsRoom's softlock guard
  // reverts the seal, and floors 3+ stop locking at all (three sim.test
  // "locked floors" cases). The arena RECT is a mapgen invariant seam; a
  // layout earns its identity from what is inside it, not from its size.
  arenaOpenSizeBonus: 0,

  // -- Per-boss ability knobs. Grouped by roster entry; each one is a NEW ask
  // expressed in the shipped grammar (armed decals, lanes, channels), never a
  // recolored nova.
  // The Rent Collector: Late Fee seizes gold into a lockbox plate.
  lateFeeCooldown: 9,
  lateFeeWindup: 0.7,
  lateFeeBase: 12, // gold seized per crawler...
  lateFeePerFloor: 4, // ...plus this per floor
  lateFeeInterest: 2.0, // refund multiplier when the lockbox breaks
  // The Temp: Transformation Clause â€” burst it through the threshold or meet
  // the thing it becomes.
  clauseHpFraction: 0.5,
  clauseWindup: 2.4, // a long, unmistakable channel â€” the whole decision
  clauseDmgMult: 1.25, // what it becomes, if you let it
  clauseSpeedMult: 1.3,
  // The Sanitation Inspector: Citation lanes that CONDEMN the tiles they hit.
  citationCooldown: 7,
  citationArm: 1.0,
  citationLength: 16,
  citationWidth: 0.75,
  citationDmgMult: 0.85,
  condemnDuration: 12, // seconds a condemned strip lingers
  condemnDmgMult: 0.25, // per tick â€” the floor shrinks, it doesn't execute
  // The Grease Trap: a STATIONARY boss that pulls and births tethered adds.
  greasePullCooldown: 5,
  greasePullRange: 11,
  greasePullStrength: 3.2, // tiles dragged (uncapped, like the lasher hook)
  greaseAddCooldown: 6,
  greaseAddsPerWave: 2,
  greaseInvertAfter: 5, // tethered adds killed before the pit inverts
  greaseInvertWindow: 4.0, // seconds the exposed core stays helpless
  // The Pollinator: Bloom seeds armed pods; unchecked pods seed more pods.
  bloomCooldown: 6.5,
  bloomPods: 4,
  bloomArm: 1.3,
  bloomRadius: 1.5,
  bloomDmgMult: 0.55,
  bloomChildren: 2, // pods a bloomed pod seeds (bounded by bloomPodCap)
  bloomPodCap: 22,
  bloomWiltAt: 0, // pods left before it wilts into the punish window
  // The Zoning Board: three tethered aides; the survivors inherit the dead
  // one's verb, so killing the wrong one first makes the fight WORSE.
  boardAides: 3,
  boardAideHpMult: 1.6,
  boardShieldMult: 0.3, // damage the Board body takes while any aide stands
  // The Permit Office: four school-immune plates. The build check, escalated.
  permitPlates: 4,
  // STOP-WORK ORDER â€” the Office's own verb. One locked lane per UNBROKEN
  // stamp, fired from that stamp's own angle and armed in sequence. This is
  // what makes the plates a MECHANIC rather than four sub-HP bars: every stamp
  // you break deletes one lane from the pattern, so the ask ("split your
  // schools") pays out in floor space, not in a number.
  stopWorkCooldown: 8,
  stopWorkArm: 1.0,
  stopWorkStagger: 0.3, // seconds between each stamp firing (the sequence)
  stopWorkWidth: 0.85,
  stopWorkDmgMult: 0.65,
  // The Sump King: SLUICE GATE â€” the surge is anchored on the standing
  // FLOODGATES, not on the King, so the prop is the thing you read and the
  // thing you break. `prop: "drain"` was authored and never fired.
  sluiceCooldown: 7,
  sluiceArm: 1.4,
  sluicePools: 5, // pools per gate, marching toward the crawler
  sluiceRadius: 1.7,
  sluiceDmgMult: 0.4,
  // The Standards Board (finale): MOTION CARRIED â€” one lane per LIVING aide,
  // every one converging on the body they are protecting. The council format
  // ESCALATED: the Zoning Board hides behind its aides, the Standards Board
  // fires THROUGH them, so the kill order changes the shape of the floor.
  motionCooldown: 7.5,
  motionArm: 1.1,
  motionWidth: 0.85,
  motionDmgMult: 0.65,
  motionOvershoot: 6, // tiles the lane runs past the body (never a safe pocket)
  // The Foundation: fissures at boss scale, in multiples.
  foundationCooldown: 7.5,
  foundationLanes: 2, // phase 0-1: wedge-shaped safe zones
  foundationRadialLanes: 6, // phase 2: pick a gap and COMMIT
  // The Line Supervisor: conveyors deliver the threat; the boss is the reason.
  conveyorCooldown: 8,
  conveyorSquad: 3, // wind-up battalion members per delivery
  supervisorGuardMult: 0.4, // damage it takes while a conveyor still runs
  // The Topiary Warden: HEDGE REGROWTH. Acceptance review round 3 found the
  // Warden with no kit at all â€” a BREAK-THE-SHIELD headline whose shield only
  // ever ticked back on the chassis' passive trickle, so the fight showed no
  // shield and no ask. The regrow is now its own CHANNEL: interrupt it (poise)
  // and the pool stays broken, miss it and the hedge is back and holding you.
  hedgeRegrowCooldown: 7,
  hedgeRegrowWindup: 1.7, // long enough to be a real interrupt stake
  hedgeRegrowAt: 0.6, // pool fraction below which it re-walls
  hedgeRegrowAmount: 0.75, // fraction of the pool the channel restores
  hedgeRingSpokes: 8, // roots laid on the wall it just rebuilt
  hedgeRingRadius: 3.6,
  // The Furnace Marshal: THREE SWEEPS, THEN IT HAS TO BREATHE. Its epithet
  // promises a COUNT, so the count is the kit â€” the sweeps stoke it and the
  // third forces the vent (a genuine self-stagger) whether you helped or not.
  marshalSweepsPerVent: 3,
  marshalSweepCooldown: 6,
  // The Safety Officer: Compliance Lattice â€” beams arming in sequence.
  latticeCooldown: 9,
  latticeLines: 4,
  latticeArm: 1.1,
  latticeStagger: 0.45, // seconds between each line arming (the sequence)
  latticeWidth: 0.8,
  latticeDmgMult: 0.75,
  // The Showrunner (finale): the set is re-dressed at every phase edge.
  showrunnerSets: ["flood", "roots", "debris", "flamewall"] as const,
  // The Sponsor (finale): Brand Integration â€” a shield only one school erodes.
  sponsorShieldFraction: 0.22,
  // LIVE AUDIENCE mutator: the crowd throws things on a rhythm.
  audienceInterval: 5.5,
  audienceCount: 3,
  audienceDmgMult: 0.7,
  // SPONSORED mutator: a hazard-immune bubble the boss must be pulled out of.
  sponsoredBubbleRadius: 4.5,
  sponsoredDamageMult: 0.25, // damage it takes while it stands in its own bubble
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
  radius: number; // body radius (tiles) for HIT checks â€” matches render bulk,
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
  // off small hits) â€” respect it or interrupt it with something heavy.
  brute: { hpMult: 2.6, dmgMult: 1.8, speedMult: 0.65, attackRange: 1.1, xpMult: 2, ranged: false, windup: 0.75, poise: 0.76, mass: 3, radius: 0.55 },
  // Ranged: windup is its aim flash â€” it stands still to line up the shot.
  ranged: { hpMult: 0.8, dmgMult: 0.6, speedMult: 1.0, attackRange: 6.5, xpMult: 1.3, ranged: true, windup: 0.35, poise: 0.3, mass: 1, radius: 0.35 },
  // Bomber: low HP, medium speed; dmgMult scales its detonation (see bomberExplodeDmgMult).
  // Its "windup" is the fuse (bomberFuse) it lights on contact.
  bomber: { hpMult: 0.55, dmgMult: 1.0, speedMult: 1.15, attackRange: 0.9, xpMult: 1.2, ranged: false, windup: 0.3, poise: 0.2, mass: 1, radius: 0.42 },
  // Shaman: never attacks (dmgMult unused); attackRange is its preferred standoff.
  shaman: { hpMult: 0.9, dmgMult: 0, speedMult: 0.95, attackRange: 5.5, xpMult: 1.5, ranged: true, windup: 0.3, poise: 0.3, mass: 1, radius: 0.38 },
  // Phantom: fast + fragile melee; closes gaps with periodic blinks (see phantomBlink*).
  phantom: { hpMult: 0.45, dmgMult: 1.1, speedMult: 1.5, attackRange: 1.0, xpMult: 1.4, ranged: false, windup: 0.3, poise: 0.15, mass: 0.8, radius: 0.3, resist: "magic" }, // half-spectral: hit it with something solid
  // Charger: its long windup IS the dodge window â€” the rush direction is locked
  // at commit (see charger* knobs). Heavy: hard to stagger out of the commit.
  charger: { hpMult: 1.4, dmgMult: 1.3, speedMult: 0.8, attackRange: 1.0, xpMult: 1.6, ranged: false, windup: 0.85, poise: 0.55, mass: 2.2, radius: 0.45, resist: "physical" }, // plated hide: bring magic
  // Spitter: standoff caster; dmgMult scales its puddle ticks (see spitter*/puddle*).
  spitter: { hpMult: 0.7, dmgMult: 0.9, speedMult: 0.95, attackRange: 5.5, xpMult: 1.4, ranged: true, windup: 0.6, poise: 0.25, mass: 1, radius: 0.38 },
  // Necromancer: never attacks (dmgMult unused); raises fresh corpses instead.
  necromancer: { hpMult: 1.1, dmgMult: 0, speedMult: 0.85, attackRange: 5.5, xpMult: 1.8, ranged: true, windup: 1.0, poise: 0.35, mass: 1.2, radius: 0.4 },
  // Broodmother: never attacks (dmgMult unused); a slow walking nest that
  // births swarmers on a timer (see brood* knobs) â€” the pack GROWS if ignored.
  broodmother: { hpMult: 2.2, dmgMult: 0, speedMult: 0.5, attackRange: 6, xpMult: 2.5, ranged: true, windup: 0.8, poise: 0.6, mass: 2.5, radius: 0.55 },
  // Drummer (Drum Sergeant): a support mob worth ~nothing itself â€” its war-drum
  // FRENZIES the pack (see drum* knobs). Kill-order lesson one: shoot the band.
  drummer: { hpMult: 0.85, dmgMult: 0.5, speedMult: 0.95, attackRange: 1.0, xpMult: 1.5, ranged: false, windup: 0.4, poise: 0.3, mass: 1, radius: 0.38 },
  // Filcher (Repo Rat): never attacks (dmgMult unused); a fast loot-goblin that
  // FLEES on sight, bleeds gold as it's hurt, and ESCAPES if ignored (filcher*).
  filcher: { hpMult: 0.6, dmgMult: 0, speedMult: 1.55, attackRange: 1.0, xpMult: 0.5, ranged: false, windup: 0.3, poise: 0.1, mass: 0.7, radius: 0.32 },
  // IRONWORKS cast (floors 13-15). Lineworker: a sturdy grunt whose piston
  // punch LAUNCHES you â€” never fight with your back to the set dressing.
  lineworker: { hpMult: 1.3, dmgMult: 1.1, speedMult: 0.9, attackRange: 1.1, xpMult: 1.4, ranged: false, windup: 0.55, poise: 0.45, mass: 1.8, radius: 0.42, resist: "physical" },
  // Sentinel: standoff turret-bot â€” its lock-on beam is the threat (sentinel*
  // knobs); dmgMult scales the railshot. Innately warded (energy shielding).
  sentinel: { hpMult: 0.85, dmgMult: 1.5, speedMult: 0.8, attackRange: 7, xpMult: 1.6, ranged: true, windup: 0.35, poise: 0.3, mass: 1.2, radius: 0.38, resist: "magic" },
  // Slagbreaker: a LARGE steam brute on a heat rhythm â€” three swings, then a
  // forced scalding vent + self-stagger (slag* knobs). Count to three.
  slagbreaker: { hpMult: 3.0, dmgMult: 1.5, speedMult: 0.6, attackRange: 1.2, xpMult: 2.4, ranged: false, windup: 0.7, poise: 0.75, mass: 3.2, radius: 0.58, resist: "physical" },
  // Toysoldier: musket squads that volley AS ONE (squad sync in ai.ts);
  // individually chaff â€” the synchronized volley is the encounter.
  toysoldier: { hpMult: 0.5, dmgMult: 0.9, speedMult: 0.9, attackRange: 6, xpMult: 0.9, ranged: true, windup: 1.0, poise: 0.2, mass: 0.9, radius: 0.32 },
  // Greeter: stands dormant among the props (always spawns in ambush), then
  // swings like a grunt; on death it discharges spark blasts (greeterSpark*).
  greeter: { hpMult: 1.1, dmgMult: 1.2, speedMult: 1.05, attackRange: 1.0, xpMult: 1.5, ranged: false, windup: 0.45, poise: 0.35, mass: 1.3, radius: 0.4 },
  // GARDEN cast (floors 7+). Lasher: mid-range whip â€” its HOOK drags you down
  // the lane to the pack (lasher* knobs). attackRange = preferred standoff.
  lasher: { hpMult: 0.95, dmgMult: 1.0, speedMult: 0.9, attackRange: 4, xpMult: 1.5, ranged: true, windup: 0.95, poise: 0.35, mass: 1.2, radius: 0.4 },
  // Understudy: a shuffling extra â€” weak on purpose. At half HP it TRANSFORMS
  // into a full charger (morph* knobs): burst it through the threshold or
  // stagger the morph, or fight the wolf you made.
  understudy: { hpMult: 0.75, dmgMult: 0.6, speedMult: 0.8, attackRange: 1.0, xpMult: 1.3, ranged: false, windup: 0.5, poise: 0.25, mass: 1, radius: 0.36 },
  // Hexer (Briar Witch): never attacks directly (dmgMult unused) â€” she CURSES
  // a crawler with a vulnerability mark her pack cashes in (hex* knobs).
  hexer: { hpMult: 0.8, dmgMult: 0, speedMult: 0.9, attackRange: 5.5, xpMult: 1.6, ranged: true, windup: 0.8, poise: 0.25, mass: 1, radius: 0.38 },
  // UNDERCROFT trainers (floor 2+). Cutpurse: fast, fragile, and after your
  // PURSE, not your HP â€” its lunge-stab steals gold (cutpurse* knobs).
  cutpurse: { hpMult: 0.5, dmgMult: 0.5, speedMult: 1.35, attackRange: 1.0, xpMult: 1.1, ranged: false, windup: 0.55, poise: 0.15, mass: 0.8, radius: 0.32 },
  // Ossuary Warden: a slow bone golem â€” its slam leaves a shard zone that
  // reshapes the room (warden* knobs). High mass: it body-blocks doorways.
  warden: { hpMult: 2.2, dmgMult: 1.3, speedMult: 0.55, attackRange: 1.15, xpMult: 1.9, ranged: false, windup: 0.8, poise: 0.7, mass: 3, radius: 0.55 },
  // Pit Digger: the knockback TUTOR â€” the slowest tell in the game, a gentle
  // hit, and a real launch. Three floors before knockback appears near hazards.
  digger: { hpMult: 1.1, dmgMult: 0.35, speedMult: 0.8, attackRange: 1.1, xpMult: 1.2, ranged: false, windup: 0.9, poise: 0.4, mass: 1.6, radius: 0.42 },
  // RUINS cast (floors 10+). Shieldbearer: tower-shield zealot â€” near-immune
  // from the FRONT while its guard holds; the guard drops mid-swing/stagger.
  shieldbearer: { hpMult: 1.6, dmgMult: 1.2, speedMult: 0.7, attackRange: 1.1, xpMult: 1.8, ranged: false, windup: 0.6, poise: 0.6, mass: 2.4, radius: 0.45, resist: "physical" },
  // Cleric: never attacks (dmgMult unused) â€” consecrates CONTESTED ground
  // that heals monsters and burns crawlers (consecrate* knobs).
  cleric: { hpMult: 0.9, dmgMult: 0, speedMult: 0.9, attackRange: 5.5, xpMult: 1.7, ranged: true, windup: 0.9, poise: 0.3, mass: 1, radius: 0.38 },
  // Archivist: standoff channeler â€” its SWEEPING beam (sweep* knobs) is the
  // first attack you dodge continuously. Stagger the channel to cut it short.
  archivist: { hpMult: 0.85, dmgMult: 1.0, speedMult: 0.8, attackRange: 6, xpMult: 1.8, ranged: true, windup: 0.5, poise: 0.25, mass: 1, radius: 0.38, resist: "magic" },
  // Colossus (The Foundation): animate masonry, LARGE â€” its slam sends a
  // FISSURE travelling down a lane (fissure* knobs). Move perpendicular.
  colossus: { hpMult: 2.8, dmgMult: 1.4, speedMult: 0.55, attackRange: 1.2, xpMult: 2.3, ranged: false, windup: 0.85, poise: 0.75, mass: 3.4, radius: 0.58, resist: "physical" },
  // THE APPROACH cast (floors 16+). Stagehand: fast, fragile hit-and-run â€”
  // two swings, then it smoke-bombs to a MARKED re-entry (stagehand* knobs).
  stagehand: { hpMult: 0.6, dmgMult: 1.2, speedMult: 1.5, attackRange: 1.0, xpMult: 1.7, ranged: false, windup: 0.3, poise: 0.15, mass: 0.8, radius: 0.32, resist: "magic" },
  // Sniper: cross-room lane, heavy hit, relocates after every shot (sniper*).
  sniper: { hpMult: 0.7, dmgMult: 2.0, speedMult: 1.0, attackRange: 10, xpMult: 1.9, ranged: true, windup: 0.4, poise: 0.25, mass: 1, radius: 0.36 },
  // Duelist: melee fencer with a riposte FLOURISH (riposte* knobs) â€” melee
  // into the flourish reflects; hold the swing or answer at range.
  duelist: { hpMult: 1.1, dmgMult: 1.3, speedMult: 1.15, attackRange: 1.1, xpMult: 1.8, ranged: false, windup: 0.45, poise: 0.4, mass: 1.2, radius: 0.4 },
  // Darling: the System's favorite â€” shields her entourage while SHE takes
  // extra (darling* knobs). dmgMult is her token slap; the toys do the work.
  darling: { hpMult: 1.0, dmgMult: 0.5, speedMult: 0.95, attackRange: 1.0, xpMult: 2.2, ranged: false, windup: 0.5, poise: 0.3, mass: 1, radius: 0.36 },
  // Canceled: a former favorite kept as security â€” player verbs (dash
  // sidesteps, nova slams) on a monster chassis (canceled* knobs).
  canceled: { hpMult: 1.5, dmgMult: 1.3, speedMult: 1.2, attackRange: 1.2, xpMult: 2.4, ranged: false, windup: 0.4, poise: 0.5, mass: 1.4, radius: 0.4 },
  // Suit Actor: a classic beast right up until it dies and UNZIPS (reapDead
  // spawns the suitguy). Suitguy: never fights, flees, and sparing him pays.
  suitactor: { hpMult: 1.3, dmgMult: 1.1, speedMult: 1.0, attackRange: 1.0, xpMult: 1.5, ranged: false, windup: 0.45, poise: 0.35, mass: 1.2, radius: 0.42 },
  suitguy: { hpMult: 0.25, dmgMult: 0, speedMult: 1.3, attackRange: 1.0, xpMult: 0.2, ranged: false, windup: 0.3, poise: 0.1, mass: 0.7, radius: 0.3 },
  // CHAMPION tier (boss layer 1). The Foreman: a mini-boss kit â€” slam +
  // radial volley â€” without the arena, the seal, or the boss-kill fanfare.
  // hpMult is a floor here; spawnMonsters scales it up (foremanHpMult).
  foreman: { hpMult: 4, dmgMult: 1.5, speedMult: 0.75, attackRange: 1.3, xpMult: 6, ranged: false, windup: 0.7, poise: 0.85, mass: 4, radius: 0.6, resist: "physical" },
  boss: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.4, xpMult: 1, ranged: false, windup: 0.55, poise: 0.5, mass: 6, radius: 0.8 },
} as const satisfies Record<string, MonsterArchetype>;

/** Depth tempo multipliers: how much quicker monsters move, swing, and
 * telegraph on a given floor. 1/1/1 through the ramp floor; capped deep. */
/** Pursuit memory after losing sight (LOS aggro): training-wheel floors are
 * forgetful; the deep dungeon holds a grudge. */
export function monsterMemory(floor: number): number {
  return Math.min(CONFIG.monsterMemoryMax, CONFIG.monsterMemoryBase + Math.max(0, floor - 3) * CONFIG.monsterMemoryPerFloor);
}

export function monsterTempo(floor: number): { speed: number; cooldown: number; windup: number } {
  const past = Math.max(0, floor - CONFIG.monsterTempoFrom);
  return {
    speed: Math.min(CONFIG.monsterTempoSpeedMax, 1 + past * CONFIG.monsterTempoSpeedPerFloor),
    cooldown: Math.max(CONFIG.monsterTempoCdMin, 1 - past * CONFIG.monsterTempoCdPerFloor),
    windup: Math.max(CONFIG.monsterTempoWindupMin, 1 - past * CONFIG.monsterTempoWindupPerFloor),
  };
}

// Weapon rarity tiers: spawn weight + damage-bonus multiplier. High tiers
// were tuned DOWN (11/3 -> 8/2) when the store became the build engine â€” a
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

// Roam mode: a floor's tribe IS its band â€” the existing cast + PACK_TEMPLATES
// for that band, just wearing a tribe id (see spawnMonsters/roamTribeId
// call sites in game.ts). No separate Roam-only tribe roster. Floors deep
// past the final band (floorBand clamps) keep reading as "the Approach" â€”
// same clamp themeForFloor already relies on for Race, so visuals and tribe
// identity always agree.
export const ROAM_TRIBE_IDS = ["undercroft", "sewers", "garden", "ruins", "ironworks", "approach"] as const;
export function roamTribeId(floor: number): string {
  return ROAM_TRIBE_IDS[floorBand(floor)];
}

// The PACK PLAYBOOK (MOB-CONCEPTS.md): designed encounters, keyed by band.
// One mob's ability is the SETUP for another's payoff; formation offsets do
// most of the choreography (support center/rear, threats front). Each pack
// asks exactly ONE question â€” kill order, positioning, or timing.
export interface PackTemplateMember {
  kind: import("./types").MonsterKind;
  dx: number;
  dy: number;
}
export const PACK_TEMPLATES: { name: string; members: PackTemplateMember[] }[][] = [
  // THE UNDERCROFT (2+; spawnMonsters gates templates off floor 1)
  [
    { name: "The Reception", members: [
      { kind: "warden", dx: 0, dy: 0 }, { kind: "swarmer", dx: -1, dy: 0.8 },
      { kind: "swarmer", dx: 1, dy: 0.8 }, { kind: "cutpurse", dx: 0, dy: 1.6 },
    ] },
    { name: "Grave Shift", members: [
      { kind: "digger", dx: 0, dy: 0.8 }, { kind: "ranged", dx: 0.6, dy: -1.2 },
    ] },
  ],
  // THE SEWERS â€” kill-order kindergarten
  [
    { name: "The Drumline", members: [
      { kind: "drummer", dx: 0, dy: -1.2 }, { kind: "grunt", dx: -1.2, dy: 0.6 },
      { kind: "grunt", dx: 0, dy: 0.9 }, { kind: "grunt", dx: 1.2, dy: 0.6 },
    ] },
    { name: "The Acid Choir", members: [
      { kind: "spitter", dx: -1, dy: -0.8 }, { kind: "spitter", dx: 1, dy: -0.8 },
      { kind: "shaman", dx: 0, dy: -1.8 }, { kind: "bomber", dx: 0, dy: 1 },
    ] },
  ],
  // THE GARDEN â€” the hook squad band
  [
    { name: "The Hook Squad", members: [
      { kind: "lasher", dx: 0, dy: -1 }, { kind: "hexer", dx: -1.4, dy: -1.6 },
      { kind: "brute", dx: 0.8, dy: 0.8 },
    ] },
    { name: "Moonlit Understudies", members: [
      { kind: "understudy", dx: -1, dy: 0.5 }, { kind: "understudy", dx: 1, dy: 0.5 },
      { kind: "understudy", dx: 0, dy: 1.2 }, { kind: "shaman", dx: 0, dy: -1.5 },
    ] },
  ],
  // THE RUINS â€” formation warfare
  [
    { name: "The Procession", members: [
      { kind: "shieldbearer", dx: -0.8, dy: 0.9 }, { kind: "shieldbearer", dx: 0.8, dy: 0.9 },
      { kind: "cleric", dx: 0, dy: -0.4 }, { kind: "archivist", dx: 0, dy: -1.8 },
    ] },
    { name: "Falling Masonry", members: [
      { kind: "colossus", dx: 0, dy: 0.5 }, { kind: "necromancer", dx: 0, dy: -1.8 },
    ] },
  ],
  // THE IRONWORKS â€” timing collision
  [
    { name: "The Assembly Line", members: [
      { kind: "lineworker", dx: -1, dy: 0.8 }, { kind: "lineworker", dx: 1, dy: 0.8 },
      { kind: "sentinel", dx: 0, dy: -1.6 },
    ] },
    { name: "Shift Change", members: [
      { kind: "slagbreaker", dx: 0, dy: 0.8 }, { kind: "toysoldier", dx: -1.5, dy: -1 },
      { kind: "toysoldier", dx: -0.5, dy: -1.4 }, { kind: "toysoldier", dx: 0.5, dy: -1.4 },
      { kind: "toysoldier", dx: 1.5, dy: -1 },
    ] },
  ],
  // THE APPROACH â€” finals week (+ the reruns: cross-band remixes)
  [
    { name: "The Entourage", members: [
      { kind: "darling", dx: 0, dy: -1 }, { kind: "toysoldier", dx: -1.4, dy: 0.4 },
      { kind: "toysoldier", dx: -0.5, dy: 0.8 }, { kind: "toysoldier", dx: 0.5, dy: 0.8 },
      { kind: "toysoldier", dx: 1.4, dy: 0.4 }, { kind: "duelist", dx: 0, dy: 0 },
    ] },
    { name: "The Crew", members: [
      { kind: "sniper", dx: 0, dy: -2 }, { kind: "stagehand", dx: 0.5, dy: 1 },
    ] },
    { name: "Rerun: Frenzied Volleys", members: [
      { kind: "drummer", dx: 0, dy: -1 }, { kind: "toysoldier", dx: -1, dy: 0.5 },
      { kind: "toysoldier", dx: 0, dy: 0.9 }, { kind: "toysoldier", dx: 1, dy: 0.5 },
    ] },
    { name: "Rerun: Into the Vent", members: [
      { kind: "lasher", dx: 0, dy: -1.5 }, { kind: "slagbreaker", dx: 0, dy: 0.8 },
    ] },
    { name: "Rerun: Marked for the Lane", members: [
      { kind: "hexer", dx: -1, dy: -1.5 }, { kind: "sniper", dx: 1, dy: -2 },
    ] },
  ],
];

// THE CHAMPION TIER (boss layer 1) + THE DUO (layer 4): named checkpoint
// fights on mid-band floors, spawned via the elite plumbing (ringside intro,
// guaranteed drops). Multi-member entries are DUOS: the members share a
// duoId, and when one dies the survivor ENRAGES (duoEnrage* knobs).
export const CHAMPIONS: {
  floor: number;
  members: { kind: import("./types").MonsterKind; name: string; hpMult: number }[];
}[] = [
  // THE GARDEN's apex predator: an oversized alpha on the charger brain â€”
  // champion-scale HP behind the locked-lane rushes players already read.
  { floor: 8, members: [{ kind: "charger", name: "The Pack Alpha", hpMult: 2.6 }] },
  // THE IRONWORKS' middle manager (the tier's pilot, migrated to the table).
  { floor: 14, members: [{ kind: "foreman", name: "The Foreman", hpMult: 2.2 }] },
  // THE APPROACH's pre-finale audit: a DUO â€” the tank punches, the turret
  // paints, and whichever one you drop first, the other takes it PERSONALLY.
  { floor: 17, members: [
    { kind: "lineworker", name: "QA UNIT ONE", hpMult: 3.2 },
    { kind: "sentinel", name: "QA UNIT TWO", hpMult: 2.4 },
  ] },
];

/** Collapse timer budget (seconds) for a given floor (1-indexed). */
export function floorTimeBudget(floor: number): number {
  const raw = CONFIG.timerBaseSeconds - (floor - 1) * CONFIG.timerPerFloorFalloff;
  return Math.max(CONFIG.timerMinSeconds, raw);
}

/** XP required to advance FROM the given level to the next. */
export function xpForLevel(level: number): number {
  return Math.round(CONFIG.xpBase * dpow(CONFIG.xpGrowth, level - 1));
}

/**
 * The floor a crawler of this level is representative of â€” the inverse of the
 * natural leveling pace (a typical run clears ~60% of each floor's cast).
 * Test mode's `gear=level` dresses an off-curve crawler with THIS floor's
 * loot, so "level 1 dropped onto floor 7" wears starter gear, not floor-7
 * gear. Derived from the same knobs as the XP economy: retunes track it.
 */
export function naturalFloorForLevel(level: number): number {
  const clearFraction = 0.6;
  let lvl = 1, xp = 0, need = xpForLevel(1);
  for (let f = 1; f <= CONFIG.finalFloor; f++) {
    if (lvl >= level) return f;
    const mobs = Math.min(CONFIG.monsterBaseCountFloor1 + (f - 1) * CONFIG.monsterCountPerFloor, CONFIG.monsterMaxCount);
    xp += mobs * (CONFIG.monsterXp + (f - 1) * CONFIG.monsterXpPerFloor) * clearFraction;
    while (xp >= need) { xp -= need; lvl++; need = xpForLevel(lvl); }
  }
  return CONFIG.finalFloor;
}
