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
} as const;

/** Collapse timer budget (seconds) for a given floor (1-indexed). */
export function floorTimeBudget(floor: number): number {
  const raw = CONFIG.timerBaseSeconds - (floor - 1) * CONFIG.timerPerFloorFalloff;
  return Math.max(CONFIG.timerMinSeconds, raw);
}

/** XP required to advance FROM the given level to the next. */
export function xpForLevel(level: number): number {
  return Math.round(CONFIG.xpBase * Math.pow(CONFIG.xpGrowth, level - 1));
}
