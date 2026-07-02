import { CONFIG, floorTimeBudget, xpForLevel } from "./config";
import { generateFloor, isWalkable, walkableTiles } from "./floor";
import { createRng, nextFloat, nextInt, pick, chance, type Rng } from "./rng";
import { angleBetween, dist, normalize, rollDamage } from "./combat";
import { moveWithCollision } from "./movement";
import { stepMonster } from "./ai";
import type { GameState, HitEvent, Intent, Loot, Monster, Player, Vec2 } from "./types";

function monsterCount(floor: number): number {
  return Math.min(
    CONFIG.monsterMaxCount,
    Math.round(CONFIG.monsterBaseCountFloor1 + (floor - 1) * CONFIG.monsterCountPerFloor),
  );
}

function spawnMonsters(state: GameState): void {
  const { map, rng, floor } = state;
  // Candidate tiles far enough from the player spawn that the first seconds are safe.
  const tiles = walkableTiles(map).filter(
    (t) => dist(t, map.spawn) > 6 && dist(t, map.stairs) > 2,
  );
  const count = monsterCount(floor);
  for (let i = 0; i < count && tiles.length > 0; i++) {
    const ti = nextInt(rng, 0, tiles.length - 1);
    const pos = tiles.splice(ti, 1)[0];
    const hp = CONFIG.monsterBaseHp + (floor - 1) * CONFIG.monsterHpPerFloor;
    state.monsters.push({
      id: state.nextEntityId++,
      pos: { x: pos.x, y: pos.y },
      hp,
      maxHp: hp,
      damage: CONFIG.monsterBaseDamage + (floor - 1) * CONFIG.monsterDamagePerFloor,
      speed: CONFIG.monsterSpeed,
      attackCooldown: 0,
      xp: CONFIG.monsterXp + (floor - 1) * CONFIG.monsterXpPerFloor,
      hitFlash: 0,
    });
  }
}

function makePlayer(seedFrom?: Player): Player {
  if (seedFrom) {
    // Carry character progression across floors; reset transient combat state.
    return {
      ...seedFrom,
      pos: { x: 0, y: 0 },
      facing: { x: 0, y: 1 },
      attackCooldown: 0,
      attackSwing: 0,
      alive: true,
    };
  }
  return {
    pos: { x: 0, y: 0 },
    facing: { x: 0, y: 1 },
    hp: CONFIG.playerMaxHp,
    maxHp: CONFIG.playerMaxHp,
    speed: CONFIG.playerSpeed,
    baseDamage: CONFIG.playerBaseDamage,
    attackCooldown: 0,
    level: 1,
    xp: 0,
    xpToNext: xpForLevel(1),
    gold: 0,
    alive: true,
    attackSwing: 0,
  };
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
  state.monsters = [];
  state.loot = [];
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
    maxHp: number;
    baseDamage: number;
    level: number;
    xp: number;
    xpToNext: number;
    gold: number;
  };
}

/**
 * Rebuild a game from saved character progression. The floor is regenerated
 * deterministically from (seed, floor), then the persisted player stats are
 * applied. This is the single-player stand-in for "log back in and resume."
 */
export function restoreGame(save: SavedProgress): GameState {
  const state = createGame(save.seed);
  const p = state.player;
  p.maxHp = save.player.maxHp;
  p.hp = Math.min(save.player.hp, save.player.maxHp);
  p.baseDamage = save.player.baseDamage;
  p.level = save.player.level;
  p.xp = save.player.xp;
  p.xpToNext = save.player.xpToNext;
  p.gold = save.player.gold;
  buildFloor(state, save.floor);
  return state;
}

export function createGame(seed: number): GameState {
  const state: GameState = {
    rng: createRng(seed),
    seed: seed >>> 0,
    floor: 1,
    map: undefined as unknown as GameState["map"],
    player: makePlayer(),
    monsters: [],
    loot: [],
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
    elapsed: 0,
  };
  buildFloor(state, 1);
  return state;
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
    p.maxHp += CONFIG.hpPerLevel;
    p.hp = p.maxHp; // level-up fully heals
    p.baseDamage += CONFIG.damagePerLevel;
    p.xpToNext = xpForLevel(p.level);
    announce(state, `LEVEL ${p.level}! The System upgrades you. Sponsors are thrilled.`);
  }
}

/** Award a loot box: an immediate randomized buff, DCC-style. */
function awardLootBox(state: GameState): void {
  const p = state.player;
  state.lootBoxes++;
  const roll = nextInt(state.rng, 0, 2);
  if (roll === 0) {
    const amt = nextInt(state.rng, 3, 6);
    p.baseDamage += amt;
    announce(state, `LOOT BOX #${state.lootBoxes}: a wicked weapon mod! (+${amt} damage)`);
  } else if (roll === 1) {
    const amt = nextInt(state.rng, 15, 30);
    p.maxHp += amt;
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
  if (chance(rng, CONFIG.goldDropChance)) {
    const amount = nextInt(rng, CONFIG.goldMin, CONFIG.goldMax) + Math.floor(floor * CONFIG.goldPerFloor);
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "gold", amount });
  }
  if (chance(rng, CONFIG.lootDropChance)) {
    const kind = pick(rng, ["heal", "weapon"] as const);
    const amount = kind === "heal" ? nextInt(rng, 15, 30) : nextInt(rng, 2, 4) + floor;
    // Nudge the second drop so stacked pickups don't perfectly overlap.
    state.loot.push({
      id: state.nextEntityId++,
      pos: { x: pos.x + (nextFloat(rng) - 0.5) * 0.6, y: pos.y + (nextFloat(rng) - 0.5) * 0.6 },
      kind,
      amount,
    });
  }
}

function doPlayerAttack(state: GameState, aim: Vec2): void {
  const p = state.player;
  const facing = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = facing;
  p.attackCooldown = CONFIG.playerAttackCooldown;
  p.attackSwing = 0.15;

  for (const m of state.monsters) {
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    if (Math.hypot(toMon.x, toMon.y) > CONFIG.playerAttackRange) continue;
    // Must be within the swing arc of the facing direction.
    if (angleBetween(facing, toMon) > CONFIG.playerAttackArc / 2) continue;
    const isCrit = chance(state.rng, CONFIG.playerCritChance);
    let dmg = rollDamage(state.rng, p.baseDamage);
    if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
    m.hp -= dmg;
    m.hitFlash = 0.12;
    hit(state, m.pos, dmg, isCrit ? "crit" : "enemy");
  }
}

function reapDead(state: GameState): void {
  const survivors: Monster[] = [];
  for (const m of state.monsters) {
    if (m.hp > 0) {
      survivors.push(m);
      continue;
    }
    state.killCount++;
    grantXp(state, m.xp);
    dropLoot(state, m.pos);
    if (state.killCount % CONFIG.lootBoxEveryKills === 0) awardLootBox(state);
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
      case "weapon":
        p.baseDamage += l.amount;
        hit(state, p.pos, l.amount, "weapon");
        state.events.push(`Found a better weapon (+${l.amount} damage).`);
        break;
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
    state.status = "won";
    announce(state, `FLOOR ${CONFIG.finalFloor} CLEARED. You escaped the dungeon. LEGENDARY.`);
    return;
  }
  const next = state.floor + 1;
  announce(state, `Descending to floor ${next}. The cameras are rolling, Crawler.`);
  buildFloor(state, next);
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

  state.elapsed += dt;
  const p = state.player;

  // Cooldowns / transient timers.
  if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);
  if (p.attackSwing > 0) p.attackSwing = Math.max(0, p.attackSwing - dt);

  // Movement.
  const move = intent.move;
  if ((move.x !== 0 || move.y !== 0) && p.alive) {
    const dir = normalize(move);
    p.facing = dir;
    moveWithCollision(state.map, p.pos, dir, p.speed * dt, isWalkable);
  }

  // Attack.
  if (intent.attack && p.alive && p.attackCooldown === 0) {
    doPlayerAttack(state, intent.aim ?? p.facing);
  }

  // Monsters.
  for (const m of state.monsters) stepMonster(state, m, dt);

  reapDead(state);
  collectLoot(state);

  // Collapse timer (applied after combat so its DoT can be the killing blow).
  if (p.alive) updateTimer(state, dt);

  // Descent request.
  if (intent.useStairs && p.alive && state.status === "playing") tryDescend(state);

  return state;
}
