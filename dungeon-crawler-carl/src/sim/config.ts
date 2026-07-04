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

  // Feature switches (disabled by request until the designs are reworked; the
  // code paths stay intact so flipping these back on re-enables everything).
  flaskEnabled: false, // Sponsor Slurp™ flask: drink no-ops, no refill events, chip hidden
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

  // DCC "System" loot boxes: awarded every N kills, granting an immediate buff.
  lootBoxEveryKills: 8,

  // Leveling
  xpBase: 20, // xp to reach level 2
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

  // Monsters (density tuned for the 72x72 floors: it should feel like you
  // could actually die on floor 1, not like an empty museum)
  monsterBaseCountFloor1: 18,
  monsterCountPerFloor: 4,
  monsterMaxCount: 60,
  // Diablo-style PACK spawning: monsters cluster into encounters (a pack turns
  // on you together), with a few lone wanderers between them.
  packSizeMin: 3,
  packSizeMax: 7,
  packLoneFraction: 0.2, // share of the budget spawned as singles
  packEscortFromFloor: 4, // packs may include a shaman healer escort from here
  monsterBaseHp: 24,
  monsterHpPerFloor: 6,
  // Damage is balanced around telegraphed, dodgeable strikes: a clean hit should
  // HURT (a grunt ~15% of starting HP, a brute ~27%), because you saw it coming.
  monsterBaseDamage: 15,
  monsterDamagePerFloor: 2.8,
  monsterSpeed: 2.6, // tiles/sec
  monsterAttackRange: 1.0,
  monsterAttackCooldown: 0.9,
  monsterAggroRange: 8, // tiles
  monsterXp: 10,
  monsterXpPerFloor: 4,

  // Loot
  lootDropChance: 0.45,
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

  // Phantom: fast, fragile skirmisher that blinks toward its prey.
  phantomBlinkDistance: 3, // tiles teleported per blink (wall-clipped)
  phantomBlinkCooldown: 2.8, // seconds between blinks

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
  upgradeDraftSize: 3, // cards offered per level-up

  // Fog of war
  fogVisionRadius: 8.5, // tiles revealed (and entities visible) around the player

  // The Show: viewers / favorites / sponsors economy. Exciting + challenging play
  // generates "hype" (which decays); hype drives viewers, a slice of whom convert to
  // sticky favorites, and favorite thresholds earn sponsors.
  show: {
    baseViewers: 180,
    viewersPerFloor: 90,
    viewersPerHype: 55,
    viewerEase: 0.9, // how fast the live count chases its target (per sec)
    hypeDecay: 4, // hype lost per second
    hypeMax: 140,
    favConvertThreshold: 14, // favorites only accrue while hype is above this
    favPerHypePerSec: 0.7, // favorite gain = (hype-threshold)*this*dt
    sponsorThresholds: [40, 120, 260, 480, 800, 1300, 2000], // favorites needed per sponsor
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
  },

  // Sponsor rewards (end-of-floor draft): one option per sponsor, capped here.
  // Sponsors beyond the cap pitch extra candidates and the best-fitting ones
  // are kept (see generateRewards). No sponsors, no gifts.
  rewardMaxCount: 3,

  // Boss hierarchy (DCC-style):
  // - NEIGHBORHOOD BOSS: one elite monster per ordinary floor (2+) — a beefed-up
  //   archetype with a name, guaranteed loot, and an announcer moment.
  // - CITY BOSS: every 6th floor (6, 12) is a sealed arena with a real boss.
  // - Floor 18 remains the final boss.
  eliteFromFloor: 2,
  // Elite durability tracks the player power curve (measured by the balance
  // bot: player damage/hit grows ~48 -> ~114 -> ~180 -> ~380 over floors
  // 4/6/12/18). Flat multipliers collapse into one-shots by midgame, so the
  // HP multiplier grows per floor; target: a focused 4-8s fight at level.
  eliteHpMult: 3.0, // base multiplier over the archetype's floor-scaled HP...
  eliteHpMultPerFloor: 2.8, // ...plus this much more per floor
  eliteDmgMult: 1.5,
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
  volatileDelay: 0.8, // seconds from death to blast (the dodge window)
  volatileRadius: 1.5, // tiles
  volatileDmgMult: 1.2, // relative to the elite's damage stat
  summonCooldown: 4, // seconds between summons
  summonMax: 6, // lifetime adds per summoner
  splitterCount: 3, // swarmers a splitter elite bursts into on death
  thornsReflectFraction: 0.25, // slice of each hit reflected back at the attacker...
  thornsReflectCapFraction: 0.04, // ...capped at this fraction of the attacker's maxHp per hit
  cityBossEvery: 6, // floors 6 and 12 (18 is the final boss)
  // City-boss pools sized against measured shopping-player DPS, which roughly
  // DOUBLES between arenas (~300 at floor 6, ~1100 at floor 12) — so pools
  // grow per ARENA, not per floor: hp = base * (1 + (arena-1) * growth).
  // Target: a real 15-25s arena fight, not a speed bump.
  cityBossHpBase: 4700,
  cityBossHpArenaGrowth: 2.4, // arena 1 (floor 6) = base; arena 2 (floor 12) = 3.4x
  cityBossAdds: 2, // ranged escorts

  // Boss (floor 18)
  bossHp: 30000,
  bossHpPerFloorOver: 0, // (kept for future scaling)
  bossDamage: 34,
  bossSpeed: 2.2,
  bossXp: 500,
  bossVolleyCooldown: 2.4,
  bossVolleyCount: 8, // projectiles per radial volley
  // Boss phases: crossing 2/3 and 1/3 HP enrages — faster chase, denser volleys.
  bossPhaseSpeedMult: 1.15, // per phase
  bossPhaseVolleyBonus: 3, // extra projectiles per phase
  bossPhaseVolleyHaste: 0.5, // seconds shaved off the volley cooldown per phase
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
};

export const ARCHETYPES = {
  grunt: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.0, xpMult: 1, ranged: false, windup: 0.4, poise: 0.25, mass: 1, radius: 0.35 },
  // Swarmer: dies to one clean hit (that's the fantasy); threat comes from volume.
  swarmer: { hpMult: 0.35, dmgMult: 0.6, speedMult: 1.7, attackRange: 0.9, xpMult: 0.7, ranged: false, windup: 0.25, poise: 0.1, mass: 0.8, radius: 0.28 },
  // Brute: long, scary windup that lands a chunk of your HP; high poise (shrugs
  // off small hits) — respect it or interrupt it with something heavy.
  brute: { hpMult: 2.6, dmgMult: 1.8, speedMult: 0.65, attackRange: 1.1, xpMult: 2, ranged: false, windup: 0.75, poise: 0.7, mass: 3, radius: 0.55 },
  // Ranged: windup is its aim flash — it stands still to line up the shot.
  ranged: { hpMult: 0.8, dmgMult: 0.6, speedMult: 1.0, attackRange: 6.5, xpMult: 1.3, ranged: true, windup: 0.35, poise: 0.3, mass: 1, radius: 0.35 },
  // Bomber: low HP, medium speed; dmgMult scales its detonation (see bomberExplodeDmgMult).
  // Its "windup" is the fuse (bomberFuse) it lights on contact.
  bomber: { hpMult: 0.55, dmgMult: 1.0, speedMult: 1.15, attackRange: 0.9, xpMult: 1.2, ranged: false, windup: 0.3, poise: 0.2, mass: 1, radius: 0.42 },
  // Shaman: never attacks (dmgMult unused); attackRange is its preferred standoff.
  shaman: { hpMult: 0.9, dmgMult: 0, speedMult: 0.95, attackRange: 5.5, xpMult: 1.5, ranged: true, windup: 0.3, poise: 0.3, mass: 1, radius: 0.38 },
  // Phantom: fast + fragile melee; closes gaps with periodic blinks (see phantomBlink*).
  phantom: { hpMult: 0.45, dmgMult: 1.1, speedMult: 1.5, attackRange: 1.0, xpMult: 1.4, ranged: false, windup: 0.3, poise: 0.15, mass: 0.8, radius: 0.3 },
  // Charger: its long windup IS the dodge window — the rush direction is locked
  // at commit (see charger* knobs). Heavy: hard to stagger out of the commit.
  charger: { hpMult: 1.4, dmgMult: 1.3, speedMult: 0.8, attackRange: 1.0, xpMult: 1.6, ranged: false, windup: 0.85, poise: 0.55, mass: 2.2, radius: 0.45 },
  // Spitter: standoff caster; dmgMult scales its puddle ticks (see spitter*/puddle*).
  spitter: { hpMult: 0.7, dmgMult: 0.9, speedMult: 0.95, attackRange: 5.5, xpMult: 1.4, ranged: true, windup: 0.6, poise: 0.25, mass: 1, radius: 0.38 },
  // Necromancer: never attacks (dmgMult unused); raises fresh corpses instead.
  necromancer: { hpMult: 1.1, dmgMult: 0, speedMult: 0.85, attackRange: 5.5, xpMult: 1.8, ranged: true, windup: 1.0, poise: 0.35, mass: 1.2, radius: 0.4 },
  boss: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.4, xpMult: 1, ranged: false, windup: 0.55, poise: 0.5, mass: 6, radius: 0.8 },
} as const satisfies Record<string, MonsterArchetype>;

// Weapon rarity tiers: spawn weight + damage-bonus multiplier.
export const RARITIES = [
  { name: "common", weight: 60, mult: 1.0 },
  { name: "magic", weight: 26, mult: 1.6 },
  { name: "rare", weight: 11, mult: 2.4 },
  { name: "epic", weight: 3, mult: 3.6 },
] as const;

// Theme bands: the dungeon shifts tone every 4 floors. The sim announces the
// district on entry; the renderers pick art/palettes from the same index.
export const FLOOR_BANDS = [
  { name: "THE UNDERCROFT", line: "Clean stone, warm torches. Don't get comfortable." },
  { name: "THE SEWERS", line: "Mind the weeds. Mind the smell. The cameras have smell-o-vision now." },
  { name: "THE RUINS", line: "Whoever lived here lost. Try to break the pattern." },
  { name: "THE IRONWORKS", line: "Steel grates and cold drafts. The machinery remembers." },
  { name: "THE APPROACH", line: "Banners, spikes, and something enormous breathing below." },
] as const;

/** Band index (0-4) for a floor: 1-4, 5-8, 9-12, 13-16, 17-18. */
export function floorBand(floor: number): number {
  return Math.min(FLOOR_BANDS.length - 1, Math.floor((Math.max(1, floor) - 1) / 4));
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
