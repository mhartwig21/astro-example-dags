// Central tunables for the vertical slice. Kept in one place so balance is easy to tweak
// and so the sim has no magic numbers scattered through it.

export const CONFIG = {
  finalFloor: 18,

  // Grid / world
  tile: 32, // pixels per tile (render); sim positions are in tile units (floats)
  floorMinRooms: 5,
  floorMaxRooms: 9,
  floorGridW: 48,
  floorGridH: 48,

  // Collapse timer (seconds). Floor 1 is generous; deeper floors tighten.
  timerBaseSeconds: 90,
  timerPerFloorFalloff: 2.5, // seconds shaved per floor descended
  timerMinSeconds: 45,
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

  // DCC "System" loot boxes: awarded every N kills, granting an immediate buff.
  lootBoxEveryKills: 8,

  // Leveling
  xpBase: 20, // xp to reach level 2
  xpGrowth: 1.35, // multiplier per level
  hpPerLevel: 18,
  damagePerLevel: 3,

  // Monsters
  monsterBaseCountFloor1: 4,
  monsterCountPerFloor: 1.5,
  monsterMaxCount: 22,
  monsterBaseHp: 24,
  monsterHpPerFloor: 6,
  monsterBaseDamage: 6,
  monsterDamagePerFloor: 1.4,
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
  dashCooldown: 1.4,
  boltCooldown: 0.6,
  boltSpeed: 12, // tiles/sec
  boltTtl: 1.2, // seconds
  boltDamageMult: 0.8, // relative to melee base damage
  projectileRadius: 0.35, // hit radius (tiles)

  // Enemy projectiles (ranged archetype + boss)
  monsterProjectileSpeed: 7,
  monsterProjectileTtl: 2.5,

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
    hypeBoss: 50,
    hypeMultiKillPerExtra: 5, // per extra kill in the same step (combo)
    hypeLowHpHit: 9, // taking a hit while below lowHpFraction HP
    hypeCollapsePerSec: 6, // staying on a collapsing floor
    hypeRareDrop: 12,
    hypeEpicDrop: 26,
    lowHpFraction: 0.3,
  },

  // Sponsor rewards (end-of-floor draft)
  rewardBaseCount: 3,
  rewardMaxCount: 4,

  // Boss (floor 18)
  bossHp: 900,
  bossHpPerFloorOver: 0, // (kept for future scaling)
  bossDamage: 26,
  bossSpeed: 2.2,
  bossXp: 500,
  bossVolleyCooldown: 2.4,
  bossVolleyCount: 8, // projectiles per radial volley
} as const;

// Enemy archetype stat multipliers (relative to the per-floor base) + behavior.
export type MonsterArchetype = {
  hpMult: number;
  dmgMult: number;
  speedMult: number;
  attackRange: number;
  xpMult: number;
  ranged: boolean; // keeps a standoff distance and fires projectiles
};

export const ARCHETYPES = {
  grunt: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.0, xpMult: 1, ranged: false },
  swarmer: { hpMult: 0.5, dmgMult: 0.7, speedMult: 1.7, attackRange: 0.9, xpMult: 0.7, ranged: false },
  brute: { hpMult: 2.6, dmgMult: 1.8, speedMult: 0.65, attackRange: 1.1, xpMult: 2, ranged: false },
  ranged: { hpMult: 0.8, dmgMult: 1.0, speedMult: 1.0, attackRange: 6.5, xpMult: 1.3, ranged: true },
  boss: { hpMult: 1, dmgMult: 1, speedMult: 1, attackRange: 1.4, xpMult: 1, ranged: false },
} as const satisfies Record<string, MonsterArchetype>;

// Weapon rarity tiers: spawn weight + damage-bonus multiplier.
export const RARITIES = [
  { name: "common", weight: 60, mult: 1.0 },
  { name: "magic", weight: 26, mult: 1.6 },
  { name: "rare", weight: 11, mult: 2.4 },
  { name: "epic", weight: 3, mult: 3.6 },
] as const;

/** Collapse timer budget (seconds) for a given floor (1-indexed). */
export function floorTimeBudget(floor: number): number {
  const raw = CONFIG.timerBaseSeconds - (floor - 1) * CONFIG.timerPerFloorFalloff;
  return Math.max(CONFIG.timerMinSeconds, raw);
}

/** XP required to advance FROM the given level to the next. */
export function xpForLevel(level: number): number {
  return Math.round(CONFIG.xpBase * Math.pow(CONFIG.xpGrowth, level - 1));
}
