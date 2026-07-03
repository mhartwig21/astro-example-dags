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
  monsterBaseCountFloor1: 13,
  monsterCountPerFloor: 3,
  monsterMaxCount: 44,
  // Diablo-style PACK spawning: monsters cluster into encounters (a pack turns
  // on you together), with a few lone wanderers between them.
  packSizeMin: 3,
  packSizeMax: 6,
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
  boltDamageMult: 0.8, // relative to melee base damage
  projectileRadius: 0.35, // hit radius (tiles)

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

  // Sponsor rewards (end-of-floor draft)
  rewardBaseCount: 3,
  rewardMaxCount: 4,

  // Boss hierarchy (DCC-style):
  // - NEIGHBORHOOD BOSS: one elite monster per ordinary floor (2+) — a beefed-up
  //   archetype with a name, guaranteed loot, and an announcer moment.
  // - CITY BOSS: every 6th floor (6, 12) is a sealed arena with a real boss.
  // - Floor 18 remains the final boss.
  eliteFromFloor: 2,
  eliteHpMult: 3.0,
  eliteDmgMult: 1.5,
  eliteXpMult: 3.0,
  eliteScale: 1.45, // render scale bump
  // Elite AFFIXES (from this floor): each named elite rolls one mechanic —
  // swift (+speed), shielded (takes less damage), volatile (delayed death
  // blast — clear the corpse), summoner (calls swarmer adds).
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
  cityBossEvery: 6, // floors 6 and 12 (18 is the final boss)
  cityBossHpBase: 320,
  cityBossHpPerFloor: 25,
  cityBossAdds: 2, // ranged escorts

  // Boss (floor 18)
  bossHp: 900,
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
};

export const ARCHETYPES = {
  grunt: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.0, xpMult: 1, ranged: false, windup: 0.4, poise: 0.25, mass: 1 },
  // Swarmer: dies to one clean hit (that's the fantasy); threat comes from volume.
  swarmer: { hpMult: 0.35, dmgMult: 0.6, speedMult: 1.7, attackRange: 0.9, xpMult: 0.7, ranged: false, windup: 0.25, poise: 0.1, mass: 0.8 },
  // Brute: long, scary windup that lands a chunk of your HP; high poise (shrugs
  // off small hits) — respect it or interrupt it with something heavy.
  brute: { hpMult: 2.6, dmgMult: 1.8, speedMult: 0.65, attackRange: 1.1, xpMult: 2, ranged: false, windup: 0.75, poise: 0.7, mass: 3 },
  // Ranged: windup is its aim flash — it stands still to line up the shot.
  ranged: { hpMult: 0.8, dmgMult: 0.6, speedMult: 1.0, attackRange: 6.5, xpMult: 1.3, ranged: true, windup: 0.35, poise: 0.3, mass: 1 },
  // Bomber: low HP, medium speed; dmgMult scales its detonation (see bomberExplodeDmgMult).
  // Its "windup" is the fuse (bomberFuse) it lights on contact.
  bomber: { hpMult: 0.55, dmgMult: 1.0, speedMult: 1.15, attackRange: 0.9, xpMult: 1.2, ranged: false, windup: 0.3, poise: 0.2, mass: 1 },
  // Shaman: never attacks (dmgMult unused); attackRange is its preferred standoff.
  shaman: { hpMult: 0.9, dmgMult: 0, speedMult: 0.95, attackRange: 5.5, xpMult: 1.5, ranged: true, windup: 0.3, poise: 0.3, mass: 1 },
  // Phantom: fast + fragile melee; closes gaps with periodic blinks (see phantomBlink*).
  phantom: { hpMult: 0.45, dmgMult: 1.1, speedMult: 1.5, attackRange: 1.0, xpMult: 1.4, ranged: false, windup: 0.3, poise: 0.15, mass: 0.8 },
  boss: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.4, xpMult: 1, ranged: false, windup: 0.55, poise: 0.5, mass: 6 },
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
