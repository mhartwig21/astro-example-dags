import { ARCHETYPES, CONFIG, floorTimeBudget, xpForLevel } from "./config";
import { generateFloor, isWalkable, walkableTiles } from "./floor";
import { createRng, nextFloat, nextInt, chance, type Rng } from "./rng";
import { angleBetween, dist, normalize, rollDamage } from "./combat";
import { moveWithCollision } from "./movement";
import { stepMonster } from "./ai";
import { generateItem, itemScore } from "./items";
import {
  ABILITY_INFO, STARTING_ABILITIES, boltParams, dashParams, knows, meleeParams,
  novaParams, orbitParams, rollUpgradeDraft, unknownAbilities, upgradeDef,
} from "./abilities";
import type {
  GameState, HitEvent, Intent, Item, Loot, Monster, MonsterKind, Player, Reward, Vec2,
} from "./types";

/** Recompute effective stats: intrinsic(level) + permanent bonuses + equipped affixes. */
export function recomputeStats(p: Player): void {
  const intrinsicDmg = CONFIG.playerBaseDamage + (p.level - 1) * CONFIG.damagePerLevel;
  const intrinsicHp = CONFIG.playerMaxHp + (p.level - 1) * CONFIG.hpPerLevel;
  let dmg = intrinsicDmg + p.bonusDamage;
  let hp = intrinsicHp + p.bonusMaxHp;
  let spd = CONFIG.playerSpeed;
  let crit = CONFIG.playerCritChance + p.bonusCrit;
  for (const slot of ["weapon", "armor", "trinket"] as const) {
    const it = p.equipment[slot];
    if (!it) continue;
    dmg += it.affixes.damage ?? 0;
    hp += it.affixes.maxHp ?? 0;
    spd += it.affixes.speed ?? 0;
    crit += it.affixes.crit ?? 0;
  }
  p.baseDamage = dmg;
  p.maxHp = hp;
  p.speed = spd;
  p.critChance = crit;
  p.weaponRarity = p.equipment.weapon?.rarity ?? "common";
  if (p.hp > p.maxHp) p.hp = p.maxHp;
}

/** Equip an item (from anywhere); the currently-equipped item in that slot goes to the bag. */
export function equipItem(p: Player, item: Item): void {
  const prev = p.equipment[item.slot];
  p.equipment[item.slot] = item;
  if (prev) p.inventory.push(prev);
  recomputeStats(p);
}

/** Equip the inventory item at `idx` (removing it from the bag). No-op if out of range. */
export function equipFromInventory(state: GameState, idx: number): void {
  const p = state.player;
  if (idx < 0 || idx >= p.inventory.length) return;
  const item = p.inventory.splice(idx, 1)[0];
  equipItem(p, item);
}

function monsterCount(floor: number): number {
  return Math.min(
    CONFIG.monsterMaxCount,
    Math.round(CONFIG.monsterBaseCountFloor1 + (floor - 1) * CONFIG.monsterCountPerFloor),
  );
}

/** Build a monster of a given archetype with per-floor-scaled, archetype-modified stats. */
function makeMonster(state: GameState, kind: MonsterKind, pos: Vec2): Monster {
  const { floor } = state;
  const a = ARCHETYPES[kind];
  const baseHp = CONFIG.monsterBaseHp + (floor - 1) * CONFIG.monsterHpPerFloor;
  const baseDmg = CONFIG.monsterBaseDamage + (floor - 1) * CONFIG.monsterDamagePerFloor;
  const baseXp = CONFIG.monsterXp + (floor - 1) * CONFIG.monsterXpPerFloor;
  const hp = Math.round(baseHp * a.hpMult);
  return {
    id: state.nextEntityId++,
    kind,
    pos: { x: pos.x, y: pos.y },
    hp,
    maxHp: hp,
    damage: baseDmg * a.dmgMult,
    speed: CONFIG.monsterSpeed * a.speedMult,
    attackRange: a.attackRange,
    attackCooldown: 0,
    shootCd: 0,
    xp: Math.round(baseXp * a.xpMult),
    hitFlash: 0,
  };
}

/** Pick an archetype mix that gets nastier with depth. */
function rollArchetype(rng: Rng, floor: number): MonsterKind {
  // Deeper floors shift the mix toward brutes/ranged/swarms.
  const rangedW = 1 + floor * 0.5;
  const bruteW = floor >= 3 ? floor * 0.4 : 0;
  const swarmW = 2 + floor * 0.3;
  const gruntW = 5;
  const total = gruntW + swarmW + rangedW + bruteW;
  let r = nextFloat(rng) * total;
  if ((r -= gruntW) < 0) return "grunt";
  if ((r -= swarmW) < 0) return "swarmer";
  if ((r -= rangedW) < 0) return "ranged";
  return "brute";
}

function spawnMonsters(state: GameState): void {
  const { map, rng, floor } = state;
  const tiles = walkableTiles(map).filter(
    (t) => dist(t, map.spawn) > 6 && dist(t, map.stairs) > 2,
  );

  // Floor 18 is a boss arena: one boss + a few ranged adds.
  if (floor >= CONFIG.finalFloor) {
    const bossPos = { x: map.stairs.x, y: map.stairs.y };
    const boss = makeMonster(state, "boss", bossPos);
    boss.hp = boss.maxHp = CONFIG.bossHp;
    boss.damage = CONFIG.bossDamage;
    boss.speed = CONFIG.bossSpeed;
    boss.xp = CONFIG.bossXp;
    state.monsters.push(boss);
    for (let i = 0; i < 3 && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    return;
  }

  const count = monsterCount(floor);
  for (let i = 0; i < count && tiles.length > 0; i++) {
    const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
    state.monsters.push(makeMonster(state, rollArchetype(rng, floor), pos));
  }
}

function makePlayer(seedFrom?: Player): Player {
  const p: Player = seedFrom
    ? {
        // Carry character progression (level, gold, equipment, inventory, bonuses)
        // across floors; reset transient combat state.
        ...seedFrom,
        pos: { x: 0, y: 0 },
        facing: { x: 0, y: 1 },
        attackCooldown: 0,
        dashCd: 0,
        dashTime: 0,
        boltCd: 0,
        novaCd: 0,
        novaFlash: 0,
        orbitAngle: 0,
        orbitTick: 0,
        attackSwing: 0,
        alive: true,
      }
    : {
        pos: { x: 0, y: 0 },
        facing: { x: 0, y: 1 },
        hp: CONFIG.playerMaxHp,
        maxHp: CONFIG.playerMaxHp,
        speed: CONFIG.playerSpeed,
        baseDamage: CONFIG.playerBaseDamage,
        critChance: CONFIG.playerCritChance,
        attackCooldown: 0,
        dashCd: 0,
        dashTime: 0,
        boltCd: 0,
        novaCd: 0,
        novaFlash: 0,
        orbitAngle: 0,
        orbitTick: 0,
        abilities: { known: [...STARTING_ABILITIES], ranks: {} },
        level: 1,
        xp: 0,
        xpToNext: xpForLevel(1),
        gold: 0,
        weaponRarity: "common",
        equipment: { weapon: null, armor: null, trinket: null },
        inventory: [],
        bonusDamage: 0,
        bonusMaxHp: 0,
        bonusCrit: 0,
        alive: true,
        attackSwing: 0,
      };
  recomputeStats(p);
  return p;
}

/** Derive a per-floor sub-seed so each floor is reproducible from the run seed. */
function floorSeed(seed: number, floor: number): number {
  return (seed ^ Math.imul(floor, 0x9e3779b1)) >>> 0;
}

function buildFloor(state: GameState, floor: number): void {
  const rng: Rng = createRng(floorSeed(state.seed, floor));
  state.rng = rng;
  state.floor = floor;
  state.map = generateFloor(rng, floor);
  state.explored = new Uint8Array(state.map.w * state.map.h);
  state.exploredVersion++;
  state.monsters = [];
  state.loot = [];
  state.projectiles = [];
  state.player.pos = { x: state.map.spawn.x, y: state.map.spawn.y };
  state.timeBudget = floorTimeBudget(floor);
  state.timeRemaining = state.timeBudget;
  state.phase = "safe";
  state.collapseElapsed = 0;
  spawnMonsters(state);
}

export interface SavedProgress {
  seed: number;
  floor: number;
  player: {
    hp: number;
    level: number;
    xp: number;
    xpToNext: number;
    gold: number;
    bonusDamage?: number;
    bonusMaxHp?: number;
    bonusCrit?: number;
    equipment?: Player["equipment"];
    inventory?: Item[];
    abilities?: Player["abilities"];
    // Legacy (pre-itemization saves): fold into bonuses so old runs still resume.
    maxHp?: number;
    baseDamage?: number;
  };
  show?: { hype?: number; viewers?: number; favorites?: number; sponsors?: number };
}

/**
 * Rebuild a game from saved character progression. The floor is regenerated
 * deterministically from (seed, floor), then the persisted player stats +
 * equipment are applied and effective stats recomputed. This is the
 * single-player stand-in for "log back in and resume."
 */
export function restoreGame(save: SavedProgress): GameState {
  const state = createGame(save.seed);
  const p = state.player;
  const s = save.player;
  p.level = s.level;
  p.xp = s.xp;
  p.xpToNext = s.xpToNext;
  p.gold = s.gold;
  p.bonusDamage = s.bonusDamage ?? 0;
  p.bonusMaxHp = s.bonusMaxHp ?? 0;
  p.bonusCrit = s.bonusCrit ?? 0;
  if (s.equipment) p.equipment = s.equipment;
  if (s.inventory) p.inventory = s.inventory;
  if (s.abilities) p.abilities = s.abilities;
  if (save.show) {
    state.hype = save.show.hype ?? 0;
    state.viewers = save.show.viewers ?? state.viewers;
    state.favorites = save.show.favorites ?? 0;
    state.sponsors = save.show.sponsors ?? 0;
  }
  // Legacy saves (pre-itemization) stored effective maxHp/baseDamage directly;
  // fold the surplus over intrinsic into permanent bonuses so old runs resume intact.
  if (s.bonusDamage === undefined && s.baseDamage !== undefined) {
    p.bonusDamage = Math.max(0, s.baseDamage - (CONFIG.playerBaseDamage + (p.level - 1) * CONFIG.damagePerLevel));
  }
  if (s.bonusMaxHp === undefined && s.maxHp !== undefined) {
    p.bonusMaxHp = Math.max(0, s.maxHp - (CONFIG.playerMaxHp + (p.level - 1) * CONFIG.hpPerLevel));
  }
  recomputeStats(p);
  p.hp = Math.min(s.hp, p.maxHp);
  buildFloor(state, save.floor);
  return state;
}

export function createGame(seed: number): GameState {
  const state: GameState = {
    rng: createRng(seed),
    seed: seed >>> 0,
    floor: 1,
    map: undefined as unknown as GameState["map"],
    explored: new Uint8Array(0),
    exploredVersion: 0,
    player: makePlayer(),
    monsters: [],
    loot: [],
    projectiles: [],
    nextEntityId: 1,
    timeBudget: 0,
    timeRemaining: 0,
    phase: "safe",
    collapseElapsed: 0,
    status: "playing",
    events: [],
    announcements: [],
    hits: [],
    killCount: 0,
    lootBoxes: 0,
    hype: 0,
    viewers: CONFIG.show.baseViewers,
    favorites: 0,
    sponsors: 0,
    pendingRewards: [],
    pendingUpgrades: [],
    upgradeDraftsOwed: 0,
    elapsed: 0,
  };
  buildFloor(state, 1);
  return state;
}

/** Add excitement. Exciting + challenging play → hype → viewers → favorites → sponsors. */
export function addHype(state: GameState, amount: number): void {
  state.hype = Math.min(CONFIG.show.hypeMax, state.hype + amount);
}

/** Per-step update of the audience economy (deterministic; time flows via dt). */
function updateShow(state: GameState, dt: number): void {
  const s = CONFIG.show;
  // Hype decays toward zero.
  state.hype = Math.max(0, state.hype - s.hypeDecay * dt);
  // Viewers ease toward a target set by floor depth + current hype + fan loyalty.
  const target = s.baseViewers + state.floor * s.viewersPerFloor + state.hype * s.viewersPerHype + state.favorites * 0.5;
  state.viewers += (target - state.viewers) * Math.min(1, s.viewerEase * dt);
  // A slice of the audience converts to sticky favorites while the crowd is hyped.
  if (state.hype > s.favConvertThreshold) {
    state.favorites += (state.hype - s.favConvertThreshold) * s.favPerHypePerSec * dt;
  }
  // Crossing a favorite threshold earns a sponsor.
  while (state.sponsors < s.sponsorThresholds.length && state.favorites >= s.sponsorThresholds[state.sponsors]) {
    state.sponsors++;
    announce(state, `NEW SPONSOR secured! ${state.sponsors} now bankroll your run. They expect a show.`);
  }
}

/** Push a dramatic line in the DCC "System" game-show voice (also logged). */
function announce(state: GameState, line: string): void {
  state.announcements.push(line);
  state.events.push(line);
}

function hit(state: GameState, pos: Vec2, amount: number, kind: HitEvent["kind"]): void {
  state.hits.push({ pos: { x: pos.x, y: pos.y }, amount, kind });
}

function grantXp(state: GameState, amount: number): void {
  const p = state.player;
  p.xp += amount;
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level++;
    p.xpToNext = xpForLevel(p.level);
    recomputeStats(p); // intrinsic stats scale with level
    p.hp = p.maxHp; // level-up fully heals
    state.upgradeDraftsOwed++; // each level opens an ability draft (queued if several)
    announce(state, `LEVEL ${p.level}! The System upgrades you. Choose your evolution.`);
  }
}

/** Choose a level-up ability upgrade by index; applies the rank and unpauses. */
export function chooseUpgrade(state: GameState, idx: number): void {
  if (idx < 0 || idx >= state.pendingUpgrades.length) return;
  const offer = state.pendingUpgrades[idx];
  const p = state.player;
  p.abilities.ranks[offer.id] = (p.abilities.ranks[offer.id] ?? 0) + 1;
  state.pendingUpgrades = [];
  const def = upgradeDef(offer.id);
  announce(state, `${offer.title} rank ${offer.nextRank}${def && offer.nextRank >= def.maxRank ? " (MAX)" : ""}. The System approves.`);
}

/** Teach an ability (tome pickup / debug). No-op if already known. */
export function learnAbility(state: GameState, ability: Loot["ability"]): void {
  const p = state.player;
  if (!ability || knows(p, ability)) return;
  p.abilities.known.push(ability);
  const info = ABILITY_INFO[ability];
  announce(state, `NEW ABILITY: ${info.name.toUpperCase()} — ${info.blurb}${info.key === "auto" ? " (automatic)" : ` (${info.key})`}. The crowd demands a demo.`);
  addHype(state, CONFIG.show.hypeEpicDrop);
}

/** Award a loot box: an immediate randomized buff, DCC-style. */
function awardLootBox(state: GameState): void {
  const p = state.player;
  state.lootBoxes++;
  const undiscovered = unknownAbilities(p);
  const roll = nextInt(state.rng, 0, undiscovered.length > 0 ? 3 : 2);
  if (roll === 3) {
    const ability = undiscovered[nextInt(state.rng, 0, undiscovered.length - 1)];
    announce(state, `LOOT BOX #${state.lootBoxes}: a forbidden skill chip!`);
    learnAbility(state, ability);
  } else if (roll === 0) {
    const amt = nextInt(state.rng, 3, 6);
    p.bonusDamage += amt;
    recomputeStats(p);
    announce(state, `LOOT BOX #${state.lootBoxes}: a wicked weapon mod! (+${amt} damage)`);
  } else if (roll === 1) {
    const amt = nextInt(state.rng, 15, 30);
    p.bonusMaxHp += amt;
    recomputeStats(p);
    p.hp = Math.min(p.maxHp, p.hp + amt);
    announce(state, `LOOT BOX #${state.lootBoxes}: reinforced plating! (+${amt} max HP)`);
  } else {
    const amt = nextInt(state.rng, 25, 50);
    p.hp = Math.min(p.maxHp, p.hp + amt);
    announce(state, `LOOT BOX #${state.lootBoxes}: a health surge! (+${amt} HP)`);
  }
}

function dropLoot(state: GameState, pos: Vec2): void {
  const { rng, floor } = state;
  // Ability tomes: rare, and only while abilities remain undiscovered.
  const undiscovered = unknownAbilities(state.player);
  if (undiscovered.length > 0 && chance(rng, CONFIG.tomeDropChance)) {
    const ability = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "tome", amount: 0, ability });
    announce(state, `An ABILITY TOME dropped! The System loves an upset.`);
  }
  if (chance(rng, CONFIG.goldDropChance)) {
    const amount = nextInt(rng, CONFIG.goldMin, CONFIG.goldMax) + Math.floor(floor * CONFIG.goldPerFloor);
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "gold", amount });
  }
  if (chance(rng, CONFIG.lootDropChance)) {
    const jitter = { x: pos.x + (nextFloat(rng) - 0.5) * 0.6, y: pos.y + (nextFloat(rng) - 0.5) * 0.6 };
    if (chance(rng, 0.4)) {
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "heal", amount: nextInt(rng, 15, 30) });
    } else {
      // Equipment drop: a rolled item with a rarity + affixes.
      const item = generateItem(rng, floor, () => state.nextEntityId++);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    }
  }
}

function doPlayerAttack(state: GameState, aim: Vec2): void {
  const p = state.player;
  const mp = meleeParams(p);
  const facing = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = facing;
  p.attackCooldown = mp.cooldown;
  p.attackSwing = 0.15;

  for (const m of state.monsters) {
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    if (Math.hypot(toMon.x, toMon.y) > CONFIG.playerAttackRange) continue;
    // Must be within the swing arc of the facing direction.
    if (angleBetween(facing, toMon) > mp.arc / 2) continue;
    const isCrit = chance(state.rng, p.critChance);
    let dmg = rollDamage(state.rng, p.baseDamage * mp.damageMult);
    if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
    m.hp -= dmg;
    m.hitFlash = 0.12;
    hit(state, m.pos, dmg, isCrit ? "crit" : "enemy");
    if (isCrit) addHype(state, CONFIG.show.hypeCrit);
  }
}

const KILL_HYPE: Record<Monster["kind"], number> = {
  grunt: CONFIG.show.hypeKill,
  swarmer: CONFIG.show.hypeSwarmer,
  ranged: CONFIG.show.hypeRanged,
  brute: CONFIG.show.hypeBrute,
  boss: CONFIG.show.hypeBoss,
};

function reapDead(state: GameState): void {
  const survivors: Monster[] = [];
  let killsThisStep = 0;
  for (const m of state.monsters) {
    if (m.hp > 0) {
      survivors.push(m);
      continue;
    }
    state.killCount++;
    killsThisStep++;
    addHype(state, KILL_HYPE[m.kind]);
    grantXp(state, m.xp);
    dropLoot(state, m.pos);
    if (state.killCount % CONFIG.lootBoxEveryKills === 0) awardLootBox(state);
    if (m.kind === "boss") {
      state.status = "won";
      announce(state, "THE FLOOR BOSS IS DOWN. You beat the dungeon. LEGENDARY, Crawler.");
    }
  }
  // Multi-kill combos are a crowd-pleaser.
  if (killsThisStep > 1) {
    addHype(state, (killsThisStep - 1) * CONFIG.show.hypeMultiKillPerExtra);
    if (killsThisStep >= 3) announce(state, `${killsThisStep}-KILL COMBO! The crowd is on its feet.`);
  }
  state.monsters = survivors;
}

function collectLoot(state: GameState): void {
  const p = state.player;
  const remaining: Loot[] = [];
  for (const l of state.loot) {
    if (dist(l.pos, p.pos) > CONFIG.pickupRadius) {
      remaining.push(l);
      continue;
    }
    switch (l.kind) {
      case "gold":
        p.gold += l.amount;
        hit(state, p.pos, l.amount, "gold");
        break;
      case "heal":
        p.hp = Math.min(p.maxHp, p.hp + l.amount);
        hit(state, p.pos, l.amount, "heal");
        state.events.push(`Picked up a health kit (+${l.amount}).`);
        break;
      case "tome": {
        if (l.ability && !knows(p, l.ability)) {
          learnAbility(state, l.ability);
          hit(state, p.pos, 0, "weapon");
        } else {
          // Learned it since the drop (e.g. another tome): sells to the crowd.
          p.gold += 50;
          hit(state, p.pos, 50, "gold");
          state.events.push("Duplicate tome sold to a collector (+50 gold).");
        }
        break;
      }
      case "item": {
        if (!l.item) break;
        const item = l.item;
        hit(state, p.pos, 0, "weapon");
        if (item.rarity === "epic") addHype(state, CONFIG.show.hypeEpicDrop);
        else if (item.rarity === "rare") addHype(state, CONFIG.show.hypeRareDrop);
        // Auto-equip if strictly better than what's in that slot, else stash in the bag.
        const equipped = p.equipment[item.slot];
        if (!equipped || itemScore(item) > itemScore(equipped)) {
          equipItem(p, item);
          if (item.rarity === "rare" || item.rarity === "epic") {
            announce(state, `${item.rarity.toUpperCase()} DROP: ${item.name}! Equipped. The crowd loses it.`);
          } else {
            state.events.push(`Equipped ${item.name}.`);
          }
        } else {
          p.inventory.push(item);
          state.events.push(`Picked up ${item.name} (${item.rarity}).`);
        }
        break;
      }
    }
  }
  state.loot = remaining;
}

function updateTimer(state: GameState, dt: number): void {
  state.timeRemaining -= dt;
  const warnAt = state.timeBudget * CONFIG.warningFraction;

  if (state.timeRemaining <= 0) {
    if (state.phase !== "collapse") {
      state.phase = "collapse";
      announce(state, "The floor is COLLAPSING, Crawler. Descend, or become a statistic.");
    }
    state.collapseElapsed += dt;
    const dps = CONFIG.collapseDpsBase + state.collapseElapsed * CONFIG.collapseDpsRamp;
    const p = state.player;
    if (p.alive) {
      const dmg = dps * dt;
      p.hp -= dmg;
      hit(state, p.pos, Math.max(1, Math.round(dmg)), "player");
      addHype(state, CONFIG.show.hypeCollapsePerSec * dt); // clutch escape = ratings gold
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        state.status = "dead";
        announce(state, "The collapsing floor claimed another Crawler. The crowd goes wild.");
      }
    }
  } else if (state.timeRemaining <= warnAt) {
    if (state.phase === "safe") {
      state.phase = "warning";
      announce(state, "The floor is destabilizing. The clock is your enemy now.");
    }
  }
}

function tryDescend(state: GameState): void {
  const p = state.player;
  if (dist(p.pos, state.map.stairs) > 1.0) {
    state.events.push("No stairs here. Find the stairs down.");
    return;
  }
  if (state.floor >= CONFIG.finalFloor) {
    // Floor 18 is a boss arena — the exit is sealed until the boss falls.
    if (state.monsters.some((m) => m.kind === "boss")) {
      state.events.push("The boss guards the only way out. Put it down.");
      return;
    }
    state.status = "won";
    announce(state, `FLOOR ${CONFIG.finalFloor} CLEARED. You escaped the dungeon. LEGENDARY.`);
    return;
  }
  const next = state.floor + 1;
  announce(state, `Descending to floor ${next}. The cameras are rolling, Crawler.`);
  buildFloor(state, next);
  // Between floors, sponsors present a draft of rewards (host pauses to let you pick).
  state.pendingRewards = generateRewards(state);
  if (state.pendingRewards.length > 0) {
    announce(state, "Your sponsors have gifts. Choose one, Crawler.");
  }
}

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build the between-floor sponsor draft. Quality + count scale with sponsors/favorites. */
function generateRewards(state: GameState): Reward[] {
  const rng = createRng((floorSeed(state.seed, state.floor) ^ 0x5eed1234) >>> 0);
  const q = 1 + state.sponsors * 0.4 + Math.min(1, state.favorites / 1000);
  const count = Math.min(CONFIG.rewardMaxCount, CONFIG.rewardBaseCount + (state.sponsors >= 2 ? 1 : 0));
  const pool: Reward["kind"][] = ["healFull", "maxHp", "damage", "crit", "item", "gold", "bonusTime"];
  const floor = state.floor;
  return shuffle(rng, pool).slice(0, count).map((kind): Reward => {
    const id = state.nextEntityId++;
    switch (kind) {
      case "healFull":
        return { id, kind, title: "Field Medic", desc: "Restore all HP", amount: 0 };
      case "maxHp": {
        const amt = Math.round((18 + floor * 2) * q);
        return { id, kind, title: "Reinforced Frame", desc: `+${amt} max HP`, amount: amt };
      }
      case "damage": {
        const amt = Math.round((5 + floor) * q);
        return { id, kind, title: "Weapon Mod", desc: `+${amt} damage`, amount: amt };
      }
      case "crit": {
        const pct = Math.round(4 + q * 2);
        return { id, kind, title: "Targeting Chip", desc: `+${pct}% crit`, amount: pct / 100 };
      }
      case "gold": {
        const amt = Math.round((40 + floor * 12) * q);
        return { id, kind, title: "Cash Injection", desc: `+${amt} gold`, amount: amt };
      }
      case "bonusTime": {
        const amt = Math.round(10 + q * 5);
        return { id, kind, title: "Stabilizer", desc: `+${amt}s on this floor`, amount: amt };
      }
      case "item": {
        const item = generateItem(rng, floor + 2, () => state.nextEntityId++); // sponsor gear runs hot
        return { id, kind, title: item.name, desc: `${item.rarity} ${item.slot}`, amount: 0, item };
      }
    }
  });
}

function applyReward(state: GameState, r: Reward): void {
  const p = state.player;
  switch (r.kind) {
    case "healFull":
      p.hp = p.maxHp;
      break;
    case "maxHp":
      p.bonusMaxHp += r.amount;
      recomputeStats(p);
      p.hp = Math.min(p.maxHp, p.hp + r.amount);
      break;
    case "damage":
      p.bonusDamage += r.amount;
      recomputeStats(p);
      break;
    case "crit":
      p.bonusCrit += r.amount;
      recomputeStats(p);
      break;
    case "gold":
      p.gold += r.amount;
      break;
    case "bonusTime":
      state.timeBudget += r.amount;
      state.timeRemaining += r.amount;
      break;
    case "item":
      if (r.item) {
        const cur = p.equipment[r.item.slot];
        if (!cur || itemScore(r.item) > itemScore(cur)) equipItem(p, r.item);
        else p.inventory.push(r.item);
      }
      break;
  }
}

/** Choose a sponsor reward by index; applies it and clears the draft. */
export function chooseReward(state: GameState, idx: number): void {
  if (idx < 0 || idx >= state.pendingRewards.length) return;
  const r = state.pendingRewards[idx];
  applyReward(state, r);
  state.pendingRewards = [];
  announce(state, `Sponsor gift accepted: ${r.title}.`);
}

/** Dash skill: blink in the facing direction with brief i-frames (dashTime). */
function doDash(state: GameState): void {
  const p = state.player;
  const dp = dashParams(p);
  p.dashCd = dp.cooldown;
  p.dashTime = CONFIG.dashDuration;
  const dir = normalize(p.facing);
  moveWithCollision(state.map, p.pos, dir, dp.distance, isWalkable);
  // Shockstep: a damage burst around the arrival point.
  if (dp.shockMult > 0) {
    radialDamage(state, p.pos, 1.6, p.baseDamage * dp.shockMult);
  }
}

/** Ranged bolt skill: fire player projectile(s) along facing/aim (Split Shot fans). */
function doBolt(state: GameState, aim: Vec2): void {
  const p = state.player;
  const bp = boltParams(p);
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  p.boltCd = bp.cooldown;
  const base = Math.atan2(dir.y, dir.x);
  const spread = 0.22; // radians between fan bolts
  for (let i = 0; i < bp.count; i++) {
    const a = base + (i - (bp.count - 1) / 2) * spread;
    const d = { x: Math.cos(a), y: Math.sin(a) };
    state.projectiles.push({
      id: state.nextEntityId++,
      pos: { x: p.pos.x + d.x * 0.6, y: p.pos.y + d.y * 0.6 },
      vel: { x: d.x * CONFIG.boltSpeed, y: d.y * CONFIG.boltSpeed },
      damage: Math.max(1, Math.round(p.baseDamage * CONFIG.boltDamageMult)),
      ttl: CONFIG.boltTtl,
      from: "player",
      pierce: bp.pierce,
    });
  }
}

/** Damage every monster within `radius` of `center` (crit-able); used by nova/shockstep. */
function radialDamage(state: GameState, center: Vec2, radius: number, damage: number): void {
  const p = state.player;
  for (const m of state.monsters) {
    if (dist(center, m.pos) > radius) continue;
    const isCrit = chance(state.rng, p.critChance);
    let dmg = rollDamage(state.rng, damage);
    if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
    m.hp -= dmg;
    m.hitFlash = 0.12;
    hit(state, m.pos, dmg, isCrit ? "crit" : "enemy");
    if (isCrit) addHype(state, CONFIG.show.hypeCrit);
  }
}

/** Nova skill: a radial shockwave around the player (must be learned). */
function doNova(state: GameState): void {
  const p = state.player;
  const np = novaParams(p);
  p.novaCd = np.cooldown;
  p.novaFlash = 0.3;
  radialDamage(state, p.pos, np.radius, p.baseDamage * np.damageMult);
}

/** Orbit blades: automatic contact damage on a fixed tick while learned. */
function updateOrbit(state: GameState, dt: number): void {
  const p = state.player;
  if (!knows(p, "orbit")) return;
  const op = orbitParams(p);
  p.orbitAngle = (p.orbitAngle + CONFIG.orbitRevPerSec * Math.PI * 2 * dt) % (Math.PI * 2);
  p.orbitTick -= dt;
  if (p.orbitTick > 0) return;
  p.orbitTick = CONFIG.orbitTickSeconds;
  for (const m of state.monsters) {
    let touching = false;
    for (let i = 0; i < op.blades; i++) {
      const a = p.orbitAngle + (i * Math.PI * 2) / op.blades;
      const blade = { x: p.pos.x + Math.cos(a) * op.radius, y: p.pos.y + Math.sin(a) * op.radius };
      if (dist(blade, m.pos) <= CONFIG.orbitBladeHitRadius) { touching = true; break; }
    }
    if (!touching) continue;
    const dmg = rollDamage(state.rng, p.baseDamage * op.damageMult);
    m.hp -= dmg;
    m.hitFlash = 0.12;
    hit(state, m.pos, dmg, "enemy");
  }
}

/** Advance every projectile: move, expire, hit walls/entities. */
function updateProjectiles(state: GameState, dt: number): void {
  const p = state.player;
  const survivors: GameState["projectiles"] = [];
  for (const pr of state.projectiles) {
    pr.ttl -= dt;
    pr.pos.x += pr.vel.x * dt;
    pr.pos.y += pr.vel.y * dt;
    if (pr.ttl <= 0 || !isWalkable(state.map, pr.pos.x, pr.pos.y)) continue;

    if (pr.from === "player") {
      let consumed = false;
      for (const m of state.monsters) {
        if (pr.hitIds?.includes(m.id)) continue; // pierced through this one already
        if (dist(pr.pos, m.pos) <= CONFIG.projectileRadius + 0.3) {
          const isCrit = chance(state.rng, p.critChance);
          let dmg = rollDamage(state.rng, pr.damage);
          if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
          m.hp -= dmg;
          m.hitFlash = 0.12;
          hit(state, m.pos, dmg, isCrit ? "crit" : "enemy");
          if (isCrit) addHype(state, CONFIG.show.hypeCrit);
          if (pr.pierce && pr.pierce > 0) {
            pr.pierce--;
            (pr.hitIds ??= []).push(m.id); // keep flying through
          } else {
            consumed = true;
          }
          break;
        }
      }
      if (consumed) continue;
    } else {
      // Enemy projectile: hits the player unless dashing (i-frames).
      if (p.alive && p.dashTime <= 0 && dist(pr.pos, p.pos) <= CONFIG.projectileRadius + 0.3) {
        p.hp -= pr.damage;
        hit(state, p.pos, Math.round(pr.damage), "player");
        if (p.hp > 0 && p.hp < p.maxHp * CONFIG.show.lowHpFraction) addHype(state, CONFIG.show.hypeLowHpHit);
        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; state.status = "dead";
          announce(state, "Shot down in the arena. The audience is on its feet.");
        }
        continue;
      }
    }
    survivors.push(pr);
  }
  state.projectiles = survivors;
}

/**
 * Advance the simulation by one fixed step. Pure with respect to wall-clock time:
 * all time flows through `dt`. Mutates and returns `state` (host owns the instance).
 */
export function step(state: GameState, intent: Intent, dt: number): GameState {
  state.events = [];
  state.announcements = [];
  state.hits = [];
  if (state.status !== "playing") return state;
  // A pending sponsor draft or level-up draft pauses the world until the player
  // chooses (chooseReward / chooseUpgrade).
  if (state.pendingRewards.length > 0 || state.pendingUpgrades.length > 0) return state;

  state.elapsed += dt;
  const p = state.player;

  // Cooldowns / transient timers.
  if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);
  if (p.attackSwing > 0) p.attackSwing = Math.max(0, p.attackSwing - dt);
  if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.dashTime > 0) p.dashTime = Math.max(0, p.dashTime - dt);
  if (p.boltCd > 0) p.boltCd = Math.max(0, p.boltCd - dt);
  if (p.novaCd > 0) p.novaCd = Math.max(0, p.novaCd - dt);
  if (p.novaFlash > 0) p.novaFlash = Math.max(0, p.novaFlash - dt);

  // Movement.
  const move = intent.move;
  if ((move.x !== 0 || move.y !== 0) && p.alive) {
    const dir = normalize(move);
    p.facing = dir;
    moveWithCollision(state.map, p.pos, dir, p.speed * dt, isWalkable);
  }

  // Skills.
  if (intent.dash && p.alive && p.dashCd === 0) doDash(state);
  if (intent.bolt && p.alive && p.boltCd === 0) doBolt(state, intent.aim ?? p.facing);
  if (intent.nova && p.alive && p.novaCd === 0 && knows(p, "nova")) doNova(state);
  updateOrbit(state, dt);

  // Attack.
  if (intent.attack && p.alive && p.attackCooldown === 0) {
    doPlayerAttack(state, intent.aim ?? p.facing);
  }

  // Monsters + projectiles.
  for (const m of state.monsters) stepMonster(state, m, dt);
  updateProjectiles(state, dt);

  reapDead(state);
  collectLoot(state);

  // Collapse timer (applied after combat so its DoT can be the killing blow).
  if (p.alive) updateTimer(state, dt);

  // The Show: convert this step's hype into viewers / favorites / sponsors.
  updateShow(state, dt);

  // Fog of war: reveal tiles around the player.
  revealAround(state);

  // Level-ups earned this step open an ability draft (queued if several).
  if (state.upgradeDraftsOwed > 0 && state.pendingUpgrades.length === 0 && state.status === "playing") {
    const offers = rollUpgradeDraft(state.rng, p, CONFIG.upgradeDraftSize);
    if (offers.length > 0) {
      state.upgradeDraftsOwed--;
      state.pendingUpgrades = offers;
    } else {
      state.upgradeDraftsOwed = 0; // every node maxed — nothing to offer
    }
  }

  // Descent request (may open a sponsor draft, which pauses subsequent steps).
  if (intent.useStairs && p.alive && state.status === "playing") tryDescend(state);

  return state;
}

/** Mark tiles within the vision radius as explored (fog of war). */
function revealAround(state: GameState): void {
  const { map, explored, player } = state;
  const r = CONFIG.fogVisionRadius;
  const r2 = r * r;
  const px = player.pos.x, py = player.pos.y;
  const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(map.w - 1, Math.ceil(px + r));
  const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(map.h - 1, Math.ceil(py + r));
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * map.w + x;
      if (explored[i]) continue;
      const dx = x + 0.5 - px, dy = y + 0.5 - py;
      if (dx * dx + dy * dy > r2) continue;
      explored[i] = 1;
      changed = true;
    }
  }
  if (changed) state.exploredVersion++;
}
