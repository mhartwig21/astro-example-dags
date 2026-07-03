import { ARCHETYPES, CONFIG, FLOOR_BANDS, floorBand, floorTimeBudget, xpForLevel } from "./config";
import { generateFloor, isWalkable, walkableTiles } from "./floor";
import { createRng, nextFloat, nextInt, chance, pick, type Rng } from "./rng";
import { angleBetween, dist, normalize, rollDamage } from "./combat";
import { moveWithCollision } from "./movement";
import { stepMonster } from "./ai";
import { generateItem, itemScore } from "./items";
import {
  ABILITY_INFO, ABILITY_SLOTS, boltParams, dashParams, knows, meleeParams,
  novaParams, orbitParams, rollUpgradeDraft, slotted, startingLoadout,
  unknownAbilities, upgradeDef, type AbilityId,
} from "./abilities";
import { ACHIEVEMENTS } from "./achievements";
import type {
  GameState, HitEvent, Intent, Item, Loot, Monster, MonsterKind, PartyIntents, Player,
  Reward, SafeRoom, ShopItem, Vec2,
} from "./types";
import { NO_INTENT, Tile } from "./types";

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

/** Equip a player's inventory item at `idx` (removing it from the bag). */
export function equipFromInventory(state: GameState, playerId: number, idx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || idx < 0 || idx >= p.inventory.length) return;
  const item = p.inventory.splice(idx, 1)[0];
  equipItem(p, item);
}

/** Extra party members beyond the first (drives multiplayer difficulty). */
function extraPlayers(state: GameState): number {
  return Math.max(0, state.players.length - 1);
}

function monsterCount(state: GameState, floor: number): number {
  const mpMult = 1 + extraPlayers(state) * CONFIG.mpCountPerExtraPlayer;
  return Math.min(
    CONFIG.monsterMaxCount * 2, // party floors may exceed the solo cap
    Math.round((CONFIG.monsterBaseCountFloor1 + (floor - 1) * CONFIG.monsterCountPerFloor) * mpMult),
  );
}

/** Build a monster of a given archetype with per-floor-scaled, archetype-modified stats. */
function makeMonster(state: GameState, kind: MonsterKind, pos: Vec2): Monster {
  const { floor } = state;
  const a = ARCHETYPES[kind];
  const mpHp = 1 + extraPlayers(state) * CONFIG.mpHpPerExtraPlayer;
  const mpDmg = 1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer;
  const baseHp = (CONFIG.monsterBaseHp + (floor - 1) * CONFIG.monsterHpPerFloor) * mpHp;
  const baseDmg = (CONFIG.monsterBaseDamage + (floor - 1) * CONFIG.monsterDamagePerFloor) * mpDmg;
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
    healCd: 0,
    blinkCd: 0,
    xp: Math.round(baseXp * a.xpMult),
    windup: 0,
    windupTotal: 0,
    stagger: 0,
    poiseDmg: 0,
    hitFlash: 0,
  };
}

/** Pick an archetype mix that gets nastier with depth. */
function rollArchetype(rng: Rng, floor: number): MonsterKind {
  // Deeper floors shift the mix toward brutes/ranged/swarms, then unlock the
  // specialists: bombers (floor 2+), shamans (floor 4+), phantoms (floor 6+).
  const rangedW = 1 + floor * 0.5;
  const bruteW = floor >= 3 ? floor * 0.4 : 0;
  const swarmW = 2 + floor * 0.3;
  const gruntW = 5;
  const bomberW = floor >= 2 ? floor * 0.3 : 0;
  const shamanW = floor >= 4 ? floor * 0.25 : 0;
  const phantomW = floor >= 6 ? floor * 0.3 : 0;
  const total = gruntW + swarmW + rangedW + bruteW + bomberW + shamanW + phantomW;
  let r = nextFloat(rng) * total;
  if ((r -= gruntW) < 0) return "grunt";
  if ((r -= swarmW) < 0) return "swarmer";
  if ((r -= rangedW) < 0) return "ranged";
  if ((r -= bomberW) < 0) return "bomber";
  if ((r -= shamanW) < 0) return "shaman";
  if ((r -= phantomW) < 0) return "phantom";
  return "brute";
}

// Seeded flavor names for neighborhood/city bosses (DCC loves a named menace).
const ELITE_NAMES = [
  "The Gutter King", "Foreman Grizz", "Mama Fangs", "The Rent Collector",
  "Skitters Prime", "Old Chompy", "The Block Captain", "Sewer Baron Vex",
  "Knuckles the Landlord", "The HOA President",
];
const CITY_BOSS_NAMES = [
  "The Borough Butcher", "Magistrate Maw", "The Transit Authority", "Commissioner Dread",
];

/** A city-boss arena floor (6, 12, ... but never the final floor). */
export function isCityBossFloor(floor: number): boolean {
  return floor < CONFIG.finalFloor && floor >= CONFIG.cityBossEvery && floor % CONFIG.cityBossEvery === 0;
}

function spawnMonsters(state: GameState): void {
  const { map, rng, floor } = state;
  const tiles = walkableTiles(map).filter(
    (t) => dist(t, map.spawn) > 6 && dist(t, map.stairs) > 2,
  );

  // Floor 18 is the FINAL boss arena: one boss + a few ranged adds.
  if (floor >= CONFIG.finalFloor) {
    const bossPos = { x: map.stairs.x, y: map.stairs.y };
    const boss = makeMonster(state, "boss", bossPos);
    boss.hp = boss.maxHp = Math.round(CONFIG.bossHp * (1 + extraPlayers(state) * CONFIG.mpBossHpPerExtraPlayer));
    boss.damage = CONFIG.bossDamage * (1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer);
    boss.speed = CONFIG.bossSpeed;
    boss.xp = CONFIG.bossXp;
    state.monsters.push(boss);
    for (let i = 0; i < 3 && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    return;
  }

  // CITY BOSS floors: a sealed mid-run arena — smaller boss + escorts + a
  // thinner regular crowd. The stairs stay sealed until the boss falls.
  if (isCityBossFloor(floor)) {
    const boss = makeMonster(state, "boss", { x: map.stairs.x, y: map.stairs.y });
    const hp = (CONFIG.cityBossHpBase + floor * CONFIG.cityBossHpPerFloor) *
      (1 + extraPlayers(state) * CONFIG.mpBossHpPerExtraPlayer);
    boss.hp = boss.maxHp = Math.round(hp);
    boss.damage = CONFIG.bossDamage * 0.7 * (1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer);
    boss.speed = CONFIG.bossSpeed;
    boss.xp = Math.round(CONFIG.bossXp * 0.4);
    boss.eliteName = pick(rng, CITY_BOSS_NAMES);
    state.monsters.push(boss);
    for (let i = 0; i < CONFIG.cityBossAdds && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    const count = Math.floor(monsterCount(state, floor) / 2);
    for (let i = 0; i < count && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, rollArchetype(rng, floor), pos));
    }
    announce(state, `CITY BOSS: ${boss.eliteName} holds floor ${floor}. The exit is SEALED. Ratings, Crawlers.`);
    return;
  }

  // Ordinary floors: INTENT-DRIVEN spawning (mission-lite). The entrance is
  // safe, encounter density ramps along the critical path, the landmark hall is
  // the hottest room and hosts the neighborhood boss, and the vault detour holds
  // a lone guardian standing over guaranteed treasure.
  const count = monsterCount(state, floor);
  const inRoom = (i: number): Vec2 | null => {
    const r = map.rooms[i];
    for (let tries = 0; tries < 12; tries++) {
      const x = nextInt(rng, r.x, r.x + r.w - 1) + 0.5;
      const y = nextInt(rng, r.y, r.y + r.h - 1) + 0.5;
      if (map.tiles[Math.floor(y) * map.w + Math.floor(x)] !== 1) continue; // Floor only
      if (dist({ x, y }, map.spawn) <= 6 || dist({ x, y }, map.stairs) <= 2) continue;
      return { x, y };
    }
    return null;
  };
  const weights = map.rooms.map((r, i) => {
    const role = map.roles[i];
    if (role === "entrance" || role === "vault") return 0;
    const area = r.w * r.h;
    // Ramp toward the stairs, but early rooms stay genuinely dangerous — the
    // pacing is a tilt, not a safety corridor.
    const ramp = 0.55 + 0.45 * (map.depths[i] ?? 0.5);
    return area * ramp * (role === "landmark" ? 1.4 : 1);
  });
  const totalW = weights.reduce((s, x) => s + x, 0);
  const pickRoom = (): number => {
    let roll = nextFloat(rng) * totalW;
    for (let j = 0; j < weights.length; j++) {
      if ((roll -= weights[j]) < 0) return j;
    }
    return 0;
  };

  // Diablo-style encounters: most of the budget spawns as PACKS — a tight
  // cluster sharing an anchor (they aggro together), usually one archetype,
  // sometimes with a shaman healer escort on deeper floors. A small share
  // spawns as lone wanderers so the space between packs isn't sterile.
  let budget = count;
  const singles = Math.round(count * CONFIG.packLoneFraction);
  for (let i = 0; i < singles && totalW > 0; i++) {
    const pos = inRoom(pickRoom());
    if (pos) { state.monsters.push(makeMonster(state, rollArchetype(rng, floor), pos)); budget--; }
  }
  let guard = 0;
  while (budget > 0 && totalW > 0 && guard++ < 60) {
    const anchor = inRoom(pickRoom());
    if (!anchor) continue;
    const size = Math.min(budget, nextInt(rng, CONFIG.packSizeMin, CONFIG.packSizeMax));
    const kind = rollArchetype(rng, floor);
    const escort = floor >= CONFIG.packEscortFromFloor && kind !== "shaman" && chance(rng, 0.3);
    for (let k = 0; k < size; k++) {
      // Cluster around the anchor; members that land in a wall squeeze inward.
      const a = nextFloat(rng) * Math.PI * 2;
      const d = 0.4 + nextFloat(rng) * 1.4;
      let pos = { x: anchor.x + Math.cos(a) * d, y: anchor.y + Math.sin(a) * d };
      if (map.tiles[Math.floor(pos.y) * map.w + Math.floor(pos.x)] !== 1) pos = { x: anchor.x, y: anchor.y };
      const memberKind = escort && k === size - 1 ? "shaman" : kind;
      state.monsters.push(makeMonster(state, memberKind, pos));
      budget--;
    }
  }

  // VAULT: a lone brute guardian over guaranteed treasure (risk/reward detour).
  const vaultIdx = map.roles.indexOf("vault");
  if (vaultIdx >= 0) {
    const r = map.rooms[vaultIdx];
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    state.monsters.push(makeMonster(state, "brute", { x: c.x, y: c.y - 1 }));
    dropBossBonus(state, c, 2);
  }

  // NEIGHBORHOOD BOSS: the named elite ALWAYS holds the LANDMARK hall (2+) —
  // if no pack happened to anchor there, one is summoned for the job. Tougher,
  // meaner, guaranteed loot (see reapDead).
  if (floor >= CONFIG.eliteFromFloor && state.monsters.length > 0) {
    const landmarkIdx = map.roles.indexOf("landmark");
    const inLandmark = (m: Monster) => {
      if (landmarkIdx < 0) return false;
      const r = map.rooms[landmarkIdx];
      return m.pos.x >= r.x && m.pos.x < r.x + r.w && m.pos.y >= r.y && m.pos.y < r.y + r.h;
    };
    const candidates = state.monsters.filter((m) => inLandmark(m) && m.kind !== "boss");
    let m: Monster;
    if (candidates.length > 0) {
      m = candidates[nextInt(rng, 0, candidates.length - 1)];
    } else if (landmarkIdx >= 0) {
      const r = map.rooms[landmarkIdx];
      m = makeMonster(state, rollArchetype(rng, floor), { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      state.monsters.push(m);
    } else {
      m = state.monsters[nextInt(rng, 0, state.monsters.length - 1)];
    }
    m.elite = true;
    m.eliteName = pick(rng, ELITE_NAMES);
    m.hp = m.maxHp = Math.round(m.maxHp * CONFIG.eliteHpMult);
    m.damage *= CONFIG.eliteDmgMult;
    m.xp = Math.round(m.xp * CONFIG.eliteXpMult);
    announce(state, `NEIGHBORHOOD BOSS: ${m.eliteName} holds the great hall. Introduce yourselves.`);
  }
}

/** Remove every locked door on the floor. Returns how many were opened. */
function unlockDoors(state: GameState): number {
  const { map } = state;
  let opened = 0;
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] === Tile.DoorLocked) {
      map.tiles[i] = Tile.Floor;
      opened++;
    }
  }
  map.locked = false;
  map.lockedRoomIdx = -1;
  if (opened > 0) state.mapVersion++; // cached floor geometry must rebuild
  return opened;
}

/**
 * On a locked floor, hand the stairs-district key to one random monster that the
 * party can actually reach (not the boss, and not one sealed inside the stairs
 * room). Softlock guard: no eligible carrier -> the doors simply open.
 */
function assignKeyCarrier(state: GameState): void {
  const { map, rng } = state;
  if (!map.locked) return;
  const room = map.rooms[map.lockedRoomIdx];
  const inLockedRoom = (pos: Vec2) =>
    pos.x >= room.x && pos.x < room.x + room.w && pos.y >= room.y && pos.y < room.y + room.h;
  const candidates = state.monsters.filter((m) => m.kind !== "boss" && !inLockedRoom(m.pos));
  if (candidates.length === 0) {
    unlockDoors(state);
    return;
  }
  candidates[nextInt(rng, 0, candidates.length - 1)].hasKey = true;
  announce(state, "The stairs district is LOCKED. One of the residents has the key. Ask nicely.");
}

function makePlayer(id: number, name: string): Player {
  const p: Player = {
    id,
    name,
    pos: { x: 0, y: 0 },
    facing: { x: 0, y: 1 },
    hp: CONFIG.playerMaxHp,
    maxHp: CONFIG.playerMaxHp,
    speed: CONFIG.playerSpeed,
    baseDamage: CONFIG.playerBaseDamage,
    critChance: CONFIG.playerCritChance,
    cd: {},
    dashTime: 0,
    dashCharges: CONFIG.dashCharges,
    novaFlash: 0,
    orbitAngle: 0,
    orbitTick: 0,
    abilities: startingLoadout(),
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
    pendingUpgrades: [],
    upgradeDraftsOwed: 0,
    pendingRewards: [],
    achievements: [],
    goldSpent: 0,
    kills: 0,
    killsThisStep: 0,
    lowHpKill: false,
    damageDealt: 0,
    damageTaken: 0,
    hype: 0,
    viewers: CONFIG.show.baseViewers,
    favorites: 0,
    sponsors: 0,
  };
  recomputeStats(p);
  return p;
}

/** Reset a player's transient combat state for a fresh floor (progression carries). */
function resetForFloor(p: Player, spawn: Vec2, offset: number): void {
  // Fan the party out around the spawn tile so nobody stacks.
  const a = offset * (Math.PI * 2 / 6);
  p.pos = { x: spawn.x + (offset === 0 ? 0 : Math.cos(a) * 0.6), y: spawn.y + (offset === 0 ? 0 : Math.sin(a) * 0.6) };
  p.facing = { x: 0, y: 1 };
  p.cd = {};
  p.dashTime = 0;
  p.dashCharges = CONFIG.dashCharges;
  p.novaFlash = 0;
  p.attackSwing = 0;
  // Fallen crawlers rejoin the show at half strength when the party descends.
  if (!p.alive) {
    p.alive = true;
    p.hp = Math.round(p.maxHp * 0.5);
  }
}

/** Living party members (most systems only care about these). */
export function alivePlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.alive);
}

/** Nearest living player to a position, or null if the party is wiped. */
export function nearestPlayer(state: GameState, pos: Vec2): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (!p.alive) continue;
    const d = dist(pos, p.pos);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Add a player to the party (drop-in). Spawns near the others on the current floor. */
export function addPlayer(state: GameState, name: string): Player {
  const id = state.players.length === 0 ? 0 : Math.max(...state.players.map((p) => p.id)) + 1;
  const p = makePlayer(id, name);
  resetForFloor(p, state.map.spawn, state.players.length);
  state.players.push(p);
  announce(state, `${name} drops into the dungeon. The audience loves fresh meat.`);
  return p;
}

/** Derive a per-floor sub-seed so each floor is reproducible from the run seed. */
function floorSeed(seed: number, floor: number): number {
  return (seed ^ Math.imul(floor, 0x9e3779b1)) >>> 0;
}

function buildFloor(state: GameState, floor: number): void {
  // Announce a tonal shift when the party crosses into a new 4-floor band.
  const prevBand = floorBand(state.floor);
  const newBand = floorBand(floor);
  if (floor === 1 || newBand !== prevBand) {
    const band = FLOOR_BANDS[newBand];
    announce(state, `Now entering ${band.name}. ${band.line}`);
  }
  const rng: Rng = createRng(floorSeed(state.seed, floor));
  state.rng = rng;
  state.floor = floor;
  state.map = generateFloor(rng, floor);
  state.explored = new Uint8Array(state.map.w * state.map.h);
  state.exploredVersion++;
  state.monsters = [];
  state.loot = [];
  state.projectiles = [];
  state.players.forEach((p, i) => resetForFloor(p, state.map.spawn, i));
  state.timeBudget = floorTimeBudget(floor);
  state.timeRemaining = state.timeBudget;
  state.phase = "safe";
  state.collapseElapsed = 0;
  state.mapVersion++;
  spawnMonsters(state);
  assignKeyCarrier(state);
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
    achievements?: string[];
    goldSpent?: number;
    kills?: number;
    name?: string;
    damageDealt?: number;
    damageTaken?: number;
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
  const p = state.players[0];
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
  if (s.abilities) {
    const legacy = s.abilities as unknown as { known?: AbilityId[]; ranks?: Record<string, number> };
    if (Array.isArray(legacy.known)) {
      // Pre-loadout save: fill slots from `known` in discovery order, bench the rest.
      const fresh = startingLoadout();
      fresh.ranks = legacy.ranks ?? {};
      for (const a of legacy.known) {
        if (fresh.slots.includes(a) || fresh.ultimate === a) continue;
        const tier = ABILITY_INFO[a]?.tier;
        if (tier === "ultimate" && fresh.ultimate === null) fresh.ultimate = a;
        else if (tier === "active" && fresh.slots.includes(null)) fresh.slots[fresh.slots.indexOf(null)] = a;
        else fresh.bench.push(a);
      }
      p.abilities = fresh;
    } else {
      p.abilities = s.abilities;
    }
  }
  if (s.achievements) p.achievements = s.achievements;
  p.goldSpent = s.goldSpent ?? 0;
  p.kills = s.kills ?? 0;
  if (save.show) {
    p.hype = save.show.hype ?? 0;
    p.viewers = save.show.viewers ?? p.viewers;
    p.favorites = save.show.favorites ?? 0;
    p.sponsors = save.show.sponsors ?? 0;
  }
  p.damageDealt = s.damageDealt ?? 0;
  p.damageTaken = s.damageTaken ?? 0;
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
    mapVersion: 0,
    players: [makePlayer(0, "Carl")],
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
    safeRoom: null,
    strikes: [],
    bulletTimeLeft: 0,
    killsThisStep: 0,
    escapedCollapse: false,
    elapsed: 0,
  };
  buildFloor(state, 1);
  return state;
}

/** Add excitement to ONE crawler's broadcast. Hype → viewers → favorites → sponsors. */
export function addHype(_state: GameState, p: Player, amount: number): void {
  p.hype = Math.min(CONFIG.show.hypeMax, p.hype + amount);
}

/** Per-step update of the audience economy (deterministic; time flows via dt). */
function updateShow(state: GameState, dt: number): void {
  const s = CONFIG.show;
  for (const p of state.players) {
    // Hype decays toward zero.
    p.hype = Math.max(0, p.hype - s.hypeDecay * dt);
    // Viewers ease toward a target set by floor depth + current hype + fan loyalty.
    const target = s.baseViewers + state.floor * s.viewersPerFloor + p.hype * s.viewersPerHype + p.favorites * 0.5;
    p.viewers += (target - p.viewers) * Math.min(1, s.viewerEase * dt);
    // A slice of the audience converts to sticky favorites while the crowd is hyped.
    if (p.hype > s.favConvertThreshold) {
      p.favorites += (p.hype - s.favConvertThreshold) * s.favPerHypePerSec * dt;
    }
    // Crossing a favorite threshold earns a sponsor.
    while (p.sponsors < s.sponsorThresholds.length && p.favorites >= s.sponsorThresholds[p.sponsors]) {
      p.sponsors++;
      announce(state, `NEW SPONSOR for ${p.name}! ${p.sponsors} now bankroll the run. They expect a show.`);
    }
  }
}

/** Push a dramatic line in the DCC "System" game-show voice (also logged). */
function announce(state: GameState, line: string): void {
  state.announcements.push(line);
  state.events.push(line);
}

function hit(
  state: GameState, pos: Vec2, amount: number, kind: HitEvent["kind"],
  extra?: { dir?: Vec2; killed?: boolean },
): void {
  state.hits.push({ pos: { x: pos.x, y: pos.y }, amount, kind, dir: extra?.dir, killed: extra?.killed });
}

/** Grant XP to one player (kill XP is split before calling this). */
function grantXp(state: GameState, p: Player, amount: number): void {
  p.xp += amount;
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level++;
    p.xpToNext = xpForLevel(p.level);
    recomputeStats(p); // intrinsic stats scale with level
    p.hp = p.maxHp; // level-up fully heals
    p.upgradeDraftsOwed++; // each level opens an ability draft (queued if several)
    announce(state, `${p.name} hits LEVEL ${p.level}! The System offers an evolution.`);
  }
}

/** Split kill XP across living party members (no kill-stealing). */
function grantPartyXp(state: GameState, amount: number): void {
  const alive = alivePlayers(state);
  if (alive.length === 0) return;
  const share = Math.max(1, Math.round(amount / alive.length));
  for (const p of alive) grantXp(state, p, share);
}

/** Choose a level-up ability upgrade for one player. The world does not pause. */
export function chooseUpgrade(state: GameState, playerId: number, idx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || idx < 0 || idx >= p.pendingUpgrades.length) return;
  const offer = p.pendingUpgrades[idx];
  p.abilities.ranks[offer.id] = (p.abilities.ranks[offer.id] ?? 0) + 1;
  p.pendingUpgrades = [];
  const def = upgradeDef(offer.id);
  announce(state, `${p.name}: ${offer.title} rank ${offer.nextRank}${def && offer.nextRank >= def.maxRank ? " (MAX)" : ""}. The System approves.`);
}

/**
 * Teach an ability (tome pickup / shop / debug). Auto-slots into an open slot of
 * its tier (field pickups keep momentum); otherwise it goes to the BENCH and
 * re-slotting waits for a safe room. No-op if already known.
 */
export function learnAbility(state: GameState, p: Player, ability: Loot["ability"]): void {
  if (!ability || knows(p, ability)) return;
  const info = ABILITY_INFO[ability];
  const L = p.abilities;
  let where: string;
  if (info.tier === "ultimate") {
    if (L.ultimate === null) { L.ultimate = ability; where = "SLOTTED as your ultimate"; }
    else { L.bench.push(ability); where = "BENCHED (swap ultimates in a safe room)"; }
  } else if (L.slots.includes(null)) {
    L.slots[L.slots.indexOf(null)] = ability;
    where = "SLOTTED";
  } else {
    L.bench.push(ability);
    where = "BENCHED (re-slot in a safe room)";
  }
  announce(state, `${p.name} learns ${info.name.toUpperCase()} — ${info.blurb}. ${where}. The crowd demands a demo.`);
  addHype(state, p, CONFIG.show.hypeEpicDrop);
}

/**
 * Re-slot an ACTIVE ability (or free a slot with null). Safe-room only — the
 * build is a committed decision, not a mid-fight reshuffle. Displaced abilities
 * go to the bench; ranks always persist.
 */
export function slotAbility(state: GameState, playerId: number, slotIdx: number, ability: AbilityId | null): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || !state.safeRoom) return;
  if (slotIdx < 0 || slotIdx >= ABILITY_SLOTS) return;
  if (ability !== null && (!knows(p, ability) || ABILITY_INFO[ability].tier !== "active")) return;
  const L = p.abilities;
  // Pull the incoming ability out of wherever it lives.
  if (ability !== null) {
    L.bench = L.bench.filter((a) => a !== ability);
    const from = L.slots.indexOf(ability);
    if (from >= 0) L.slots[from] = null;
  }
  const displaced = L.slots[slotIdx];
  if (displaced) L.bench.push(displaced);
  L.slots[slotIdx] = ability;
  state.events.push(
    ability === null
      ? `${p.name} freed slot ${slotIdx + 1}.`
      : `${p.name} slotted ${ABILITY_INFO[ability].name} into slot ${slotIdx + 1}.`,
  );
}

/** Set (or clear) the ultimate slot. Safe-room only; displaced ult is benched. */
export function setUltimate(state: GameState, playerId: number, ability: AbilityId | null): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || !state.safeRoom) return;
  if (ability !== null && (!knows(p, ability) || ABILITY_INFO[ability].tier !== "ultimate")) return;
  const L = p.abilities;
  if (ability !== null) L.bench = L.bench.filter((a) => a !== ability);
  if (L.ultimate) L.bench.push(L.ultimate);
  L.ultimate = ability;
  state.events.push(
    ability === null ? `${p.name} cleared the ultimate slot.` : `${p.name} slotted ${ABILITY_INFO[ability].name} as their ULTIMATE.`,
  );
}

/** Award a loot box to one player: an immediate randomized buff, DCC-style. */
function awardLootBox(state: GameState, p: Player): void {
  state.lootBoxes++;
  const undiscovered = unknownAbilities(p);
  const roll = nextInt(state.rng, 0, undiscovered.length > 0 ? 3 : 2);
  if (roll === 3) {
    const ability = undiscovered[nextInt(state.rng, 0, undiscovered.length - 1)];
    announce(state, `LOOT BOX #${state.lootBoxes}: a forbidden skill chip!`);
    learnAbility(state, p, ability);
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

/** Guaranteed boss/elite reward: item(s) + a fat gold pile at the corpse. */
function dropBossBonus(state: GameState, pos: Vec2, items: number): void {
  const { rng, floor } = state;
  for (let i = 0; i < items; i++) {
    const jitter = { x: pos.x + (nextFloat(rng) - 0.5) * 1.2, y: pos.y + (nextFloat(rng) - 0.5) * 1.2 };
    const item = generateItem(rng, floor + 2, () => state.nextEntityId++);
    state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
  }
  const gold = nextInt(rng, 25, 45) + floor * 6;
  state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "gold", amount: gold });
}

function dropLoot(state: GameState, pos: Vec2): void {
  const { rng, floor } = state;
  // Ability tomes: rare, and only while someone in the party has left to learn.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p)))];
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

/**
 * Damage a monster with a player's roll (shared crit/credit path). Beyond the
 * HP: hits SHOVE the target (`knockback` tiles / archetype mass, along `dir`)
 * and build poise damage — crossing maxHp * archetype poise staggers the
 * monster, interrupting any windup in progress. That interrupt is the reward
 * for answering a telegraph with damage instead of a dodge.
 */
function damageMonster(
  state: GameState, p: Player, m: Monster, base: number,
  opts: { allowCrit?: boolean; dir?: Vec2; knockback?: number } = {},
): void {
  const isCrit = (opts.allowCrit ?? true) && chance(state.rng, p.critChance);
  let dmg = rollDamage(state.rng, base);
  if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
  m.hp -= dmg;
  m.hitFlash = 0.12;
  m.lastHitBy = p.id;
  const a = ARCHETYPES[m.kind];
  const eliteMult = m.elite ? CONFIG.elitePoiseMult : 1;
  if (m.hp > 0) {
    m.poiseDmg += dmg;
    if (m.poiseDmg >= m.maxHp * a.poise * eliteMult) {
      m.poiseDmg = 0;
      m.stagger = CONFIG.staggerDuration;
      m.windup = 0; // interrupted — the committed attack never lands
      m.windupKind = undefined;
    }
    if (opts.dir && opts.knockback) {
      moveWithCollision(state.map, m.pos, opts.dir, opts.knockback / (a.mass * eliteMult), isWalkable);
    }
  }
  hit(state, m.pos, dmg, isCrit ? "crit" : "enemy", { dir: opts.dir, killed: m.hp <= 0 });
  p.damageDealt += dmg;
  if (isCrit) addHype(state, p, CONFIG.show.hypeCrit);
}

function doPlayerAttack(state: GameState, p: Player, aim: Vec2): void {
  const mp = meleeParams(p);
  const facing = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = facing;
  p.cd.melee = mp.cooldown;
  p.attackSwing = 0.15;
  // The swing lunges a short step toward the aim — attacks feel aggressive and
  // close those just-out-of-reach misses (walls stop it like any movement).
  moveWithCollision(state.map, p.pos, facing, CONFIG.meleeLungeDistance, isWalkable);

  for (const m of state.monsters) {
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    if (Math.hypot(toMon.x, toMon.y) > CONFIG.playerAttackRange) continue;
    // Must be within the swing arc of the facing direction.
    if (angleBetween(facing, toMon) > mp.arc / 2) continue;
    damageMonster(state, p, m, p.baseDamage * mp.damageMult, {
      dir: normalize(toMon), knockback: CONFIG.meleeKnockback,
    });
  }
}

const KILL_HYPE: Record<Monster["kind"], number> = {
  grunt: CONFIG.show.hypeKill,
  swarmer: CONFIG.show.hypeSwarmer,
  ranged: CONFIG.show.hypeRanged,
  brute: CONFIG.show.hypeBrute,
  bomber: CONFIG.show.hypeBomber,
  shaman: CONFIG.show.hypeShaman,
  phantom: CONFIG.show.hypePhantom,
  boss: CONFIG.show.hypeBoss,
};

/**
 * Bomber detonation: radial damage to every living player in range, then the
 * bomber dies (reapDead handles credit/XP/loot as with any other death). Called
 * from ai.ts on contact (full radius) and from reapDead when a bomber is shot
 * down before reaching anyone (radiusMult < 1: a smaller danger zone).
 */
export function explodeBomber(state: GameState, m: Monster, radiusMult = 1): void {
  if (m.exploded) return; // a bomber only gets one blast
  m.exploded = true;
  m.hp = 0; // the explosion is always fatal to the bomber itself
  const radius = CONFIG.bomberExplodeRadius * radiusMult;
  const base = m.damage * CONFIG.bomberExplodeDmgMult;
  let caught = 0;
  for (const p of state.players) {
    if (!p.alive || p.dashTime > 0) continue; // dash i-frames dodge the blast
    if (dist(m.pos, p.pos) > radius) continue;
    const dmg = rollDamage(state.rng, base);
    p.hp -= dmg;
    p.damageTaken += dmg;
    caught++;
    const away = dist(m.pos, p.pos) > 1e-4
      ? normalize({ x: p.pos.x - m.pos.x, y: p.pos.y - m.pos.y })
      : undefined;
    hit(state, p.pos, dmg, "player", { dir: away, killed: p.hp <= 0 });
    if (p.hp <= 0) {
      handlePlayerDeath(state, p, `${p.name} was BLOWN APART by a bomber. Sponsors, roll the replay.`);
    } else if (p.hp < p.maxHp * CONFIG.show.lowHpFraction) {
      addHype(state, p, CONFIG.show.hypeLowHpHit);
    }
  }
  if (caught > 0) announce(state, "KABOOM! A bomber detonates point-blank. The crowd feels that one.");
  else announce(state, "A bomber pops early — all bark, no bite. The System is disappointed.");
}

function reapDead(state: GameState): void {
  const survivors: Monster[] = [];
  let killsThisStep = 0;
  for (const m of state.monsters) {
    if (m.hp > 0) {
      survivors.push(m);
      continue;
    }
    // A bomber shot down before reaching anyone still cooks off — half radius.
    if (m.kind === "bomber" && !m.exploded) explodeBomber(state, m, CONFIG.bomberDeathRadiusMult);
    state.killCount++;
    killsThisStep++;
    // Kill credit to the last hitter (loot box milestones + per-player achievements).
    const killer = state.players.find((pl) => pl.id === m.lastHitBy) ?? state.players[0];
    killer.kills++;
    killer.killsThisStep++;
    if (killer.alive && killer.hp > 0 && killer.hp < killer.maxHp * 0.1) killer.lowHpKill = true;
    addHype(state, killer, KILL_HYPE[m.kind]);
    grantPartyXp(state, m.xp);
    if (m.hasKey) {
      // The key carrier ALWAYS drops the stairs-district key.
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "key", amount: 0 });
      announce(state, "The KEYHOLDER is down! That shiny thing it dropped? Take it.");
    }
    dropLoot(state, m.pos);
    if (state.killCount % CONFIG.lootBoxEveryKills === 0) awardLootBox(state, killer);
    // Named menaces shower guaranteed rewards.
    if (m.elite) {
      dropBossBonus(state, m.pos, 1);
      addHype(state, killer, CONFIG.show.hypeBrute);
      announce(state, `${m.eliteName} is DOWN. The neighborhood breathes easier. ${killer.name} takes the credit.`);
    }
    if (m.kind === "boss") {
      if (state.floor >= CONFIG.finalFloor) {
        state.status = "won";
        announce(state, "THE FLOOR BOSS IS DOWN. You beat the dungeon. LEGENDARY, Crawlers.");
      } else {
        dropBossBonus(state, m.pos, 2);
        addHype(state, killer, CONFIG.show.hypeBoss);
        announce(state, `CITY BOSS ${m.eliteName ?? ""} DEFEATED! The exit is OPEN. Sponsors are weeping with joy.`);
      }
    }
  }
  // Multi-kill combos are a crowd-pleaser (credited to whoever comboed).
  for (const pl of state.players) {
    if (pl.killsThisStep > 1) {
      addHype(state, pl, (pl.killsThisStep - 1) * CONFIG.show.hypeMultiKillPerExtra);
      if (pl.killsThisStep >= 3) announce(state, `${pl.killsThisStep}-KILL COMBO by ${pl.name}! The crowd is on its feet.`);
    }
  }
  state.killsThisStep = killsThisStep;
  state.monsters = survivors;
}

function collectLoot(state: GameState): void {
  const remaining: Loot[] = [];
  for (const l of state.loot) {
    // First living player (in party order) within radius picks it up.
    const p = state.players.find((pl) => pl.alive && dist(l.pos, pl.pos) <= CONFIG.pickupRadius);
    if (!p) {
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
      case "key": {
        unlockDoors(state);
        announce(state, `${p.name} has the key! The stairs district is OPEN.`);
        addHype(state, p, 12);
        hit(state, p.pos, 0, "weapon");
        break;
      }
      case "tome": {
        if (l.ability && !knows(p, l.ability)) {
          learnAbility(state, p, l.ability);
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
        if (item.rarity === "epic") addHype(state, p, CONFIG.show.hypeEpicDrop);
        else if (item.rarity === "rare") addHype(state, p, CONFIG.show.hypeRareDrop);
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
    for (const p of state.players) {
      if (!p.alive) continue;
      addHype(state, p, CONFIG.show.hypeCollapsePerSec * dt); // clutch escape = ratings gold
      const dmg = dps * dt;
      p.hp -= dmg;
      p.damageTaken += dmg;
      hit(state, p.pos, Math.max(1, Math.round(dmg)), "player", { killed: p.hp <= 0 });
      if (p.hp <= 0) {
        handlePlayerDeath(state, p, `The collapsing floor claimed ${p.name}. The crowd goes wild.`);
      }
    }
  } else if (state.timeRemaining <= warnAt) {
    if (state.phase === "safe") {
      state.phase = "warning";
      announce(state, "The floor is destabilizing. The clock is your enemy now.");
    }
  }
}

/** Any living player on the stairs can pull the party down (DCC: descend together). */
function tryDescend(state: GameState, p: Player): void {
  if (dist(p.pos, state.map.stairs) > 1.0) {
    state.events.push("No stairs here. Find the stairs down.");
    return;
  }
  // Boss floors (city arenas + the final floor) seal the exit until the boss falls.
  if (state.monsters.some((m) => m.kind === "boss")) {
    state.events.push("The boss seals the only way out. Put it down.");
    return;
  }
  if (state.floor >= CONFIG.finalFloor) {
    state.status = "won";
    announce(state, `FLOOR ${CONFIG.finalFloor} CLEARED. You escaped the dungeon. LEGENDARY.`);
    return;
  }
  if (state.phase === "collapse") state.escapedCollapse = true;
  const next = state.floor + 1;
  // Descent routes through a safe room: the sim pauses while the crawler shops;
  // leaveSafeRoom() performs the actual floor change (and opens the sponsor draft).
  state.safeRoom = generateSafeRoom(state, next);
  announce(state, `Safe room reached. Breathe, spend, gear up — floor ${next} is waiting.`);
}

/** Mordecai-style manager advice for the floor ahead (deterministic flavor). */
function safeRoomTip(rng: Rng, floor: number): string {
  const tips = [
    `Floor ${floor}: more of everything that just tried to kill you. Hydrate.`,
    `Brutes get bolder down on ${floor}. Keep the dash charged and your knees bent.`,
    `The collapse timer runs tighter on ${floor}. Loot fast, cry later.`,
    `Ranged mobs love the long halls on ${floor}. Make friends with corners.`,
    `Word is the sponsors are watching floor ${floor} closely. Give them a show.`,
    `Floor ${floor}? I've seen crawlers do it on half your gear. They're dead now, but still.`,
  ];
  return tips[nextInt(rng, 0, tips.length - 1)];
}

/** Roll the safe-room shop for the floor ahead. Seeded per (run, floor): reproducible. */
function generateSafeRoom(state: GameState, nextFloor: number): SafeRoom {
  const rng = createRng((floorSeed(state.seed, nextFloor) ^ 0x5a4e0000) >>> 0);
  const floor = nextFloor;
  const stock: ShopItem[] = [];
  const id = () => state.nextEntityId++;

  // Staples: a heal and a stabilizer are always on the shelf.
  stock.push({
    id: id(), kind: "heal", title: "Field Ration", sold: false,
    desc: "Restore 50% HP", price: 25 + floor * 5,
  });
  stock.push({
    id: id(), kind: "time", title: "Stabilizer Rod", sold: false,
    desc: "+15s on the next floor", price: 30 + floor * 6,
  });
  // Two rolled gear pieces, priced by rarity.
  for (let i = 0; i < 2; i++) {
    const item = generateItem(rng, floor + 1, id);
    const mult = { common: 1, magic: 2, rare: 3.5, epic: 6 }[item.rarity];
    stock.push({
      id: id(), kind: "item", title: item.name, sold: false,
      desc: `${item.rarity} ${item.slot}`, price: Math.round((20 + floor * 8) * mult), item,
    });
  }
  // A permanent max-HP shot.
  stock.push({
    id: id(), kind: "maxHp", title: "Plating Kit", sold: false,
    desc: `+${12 + floor * 2} max HP (permanent)`, price: 45 + floor * 9,
  });
  // A tome, if anything is left to discover — expensive, but guaranteed learning.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p)))];
  if (undiscovered.length > 0) {
    const ability = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
    stock.push({
      id: id(), kind: "tome", title: `Tome of ${ABILITY_INFO[ability].name}`, sold: false,
      desc: `Learn ${ABILITY_INFO[ability].name} (${ABILITY_INFO[ability].blurb})`, price: 120 + floor * 10, ability,
    });
  } else {
    // Otherwise a mystery box: a loot-box roll, paid for.
    stock.push({
      id: id(), kind: "mystery", title: "Mystery Box", sold: false,
      desc: "A loot-box roll. The System giggles.", price: 60 + floor * 8,
    });
  }
  return { nextFloor, stock, tip: safeRoomTip(rng, floor), ready: [] };
}

/** Buy the safe-room shop item at `idx` for one player. No-op if sold/unaffordable. */
export function buyShopItem(state: GameState, playerId: number, idx: number): void {
  const room = state.safeRoom;
  if (!room || idx < 0 || idx >= room.stock.length) return;
  const s = room.stock[idx];
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || s.sold || p.gold < s.price) return;
  p.gold -= s.price;
  p.goldSpent += s.price;
  s.sold = true;
  switch (s.kind) {
    case "heal":
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.5));
      break;
    case "time":
      // Applied to the NEXT floor when it is built (leaveSafeRoom).
      room.bonusTime = (room.bonusTime ?? 0) + 15;
      break;
    case "maxHp": {
      const amt = 12 + room.nextFloor * 2;
      p.bonusMaxHp += amt;
      recomputeStats(p);
      p.hp = Math.min(p.maxHp, p.hp + amt);
      break;
    }
    case "item":
      if (s.item) {
        const cur = p.equipment[s.item.slot];
        if (!cur || itemScore(s.item) > itemScore(cur)) equipItem(p, s.item);
        else p.inventory.push(s.item);
      }
      break;
    case "tome":
      learnAbility(state, p, s.ability);
      break;
    case "mystery":
      awardLootBox(state, p);
      break;
  }
  state.events.push(`${p.name} bought ${s.title} (-${s.price} gold).`);
  // The sim idles in the safe room, so purchase-driven unlocks fire here.
  checkAchievements(state);
}

/** Mark a player ready to descend; the party leaves when everyone is ready. */
export function setReady(state: GameState, playerId: number): void {
  const room = state.safeRoom;
  if (!room) return;
  if (!room.ready.includes(playerId)) room.ready.push(playerId);
  const allReady = state.players.every((p) => room.ready.includes(p.id));
  if (allReady) leaveSafeRoom(state);
  else state.events.push(`${state.players.find((p) => p.id === playerId)?.name ?? "?"} is ready to descend (${room.ready.length}/${state.players.length}).`);
}

/** Leave the safe room: build the next floor and open per-player sponsor drafts. */
export function leaveSafeRoom(state: GameState): void {
  const room = state.safeRoom;
  if (!room) return;
  state.safeRoom = null;
  announce(state, `Descending to floor ${room.nextFloor}. The cameras are rolling, Crawlers.`);
  buildFloor(state, room.nextFloor);
  if (room.bonusTime) {
    state.timeBudget += room.bonusTime;
    state.timeRemaining += room.bonusTime;
  }
  // Between floors, sponsors gift each crawler individually (non-blocking).
  let any = false;
  for (const p of state.players) {
    p.pendingRewards = generateRewards(state, p.id);
    if (p.pendingRewards.length > 0) any = true;
  }
  if (any) announce(state, "Your sponsors have gifts. Choose, Crawlers.");
}

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build a between-floor sponsor draft for one player. Quality scales with the show. */
function generateRewards(state: GameState, playerId: number): Reward[] {
  const rng = createRng((floorSeed(state.seed, state.floor) ^ 0x5eed1234 ^ Math.imul(playerId + 1, 0x85ebca6b)) >>> 0);
  const pl = state.players.find((pp) => pp.id === playerId) ?? state.players[0];
  const q = 1 + pl.sponsors * 0.4 + Math.min(1, pl.favorites / 1000);
  const count = Math.min(CONFIG.rewardMaxCount, CONFIG.rewardBaseCount + (pl.sponsors >= 2 ? 1 : 0));
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

function applyReward(state: GameState, p: Player, r: Reward): void {
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

/** Choose a sponsor reward for one player; applies it and clears their draft. */
export function chooseReward(state: GameState, playerId: number, idx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || idx < 0 || idx >= p.pendingRewards.length) return;
  const r = p.pendingRewards[idx];
  applyReward(state, p, r);
  p.pendingRewards = [];
  announce(state, `${p.name} accepts a sponsor gift: ${r.title}.`);
}

/**
 * Dash skill: blink in the facing direction with brief i-frames (dashTime).
 * Runs on charges — spending one starts the recharge timer (cd.dash) if it
 * isn't already running; the step loop restores charges as it expires.
 */
function doDash(state: GameState, p: Player): void {
  const dp = dashParams(p);
  p.dashCharges--;
  if ((p.cd.dash ?? 0) <= 0) p.cd.dash = dp.cooldown;
  p.dashTime = CONFIG.dashDuration;
  const dir = normalize(p.facing);
  moveWithCollision(state.map, p.pos, dir, dp.distance, isWalkable);
  // Shockstep: a damage burst around the arrival point.
  if (dp.shockMult > 0) {
    radialDamage(state, p, p.pos, 1.6, p.baseDamage * dp.shockMult, CONFIG.shockstepKnockback);
  }
}

/** Ranged bolt skill: fire player projectile(s) along facing/aim (Split Shot fans). */
function doBolt(state: GameState, p: Player, aim: Vec2): void {
  const bp = boltParams(p);
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  p.cd.bolt = bp.cooldown;
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
      ownerId: p.id,
      pierce: bp.pierce,
    });
  }
}

/** Damage every monster within `radius` of `center` (crit-able); used by nova/shockstep.
 * Blasts shove outward from the center when `knockback` > 0. */
function radialDamage(
  state: GameState, p: Player, center: Vec2, radius: number, damage: number, knockback = 0,
): void {
  for (const m of state.monsters) {
    const d = dist(center, m.pos);
    if (d > radius) continue;
    const dir = d > 1e-4 ? { x: (m.pos.x - center.x) / d, y: (m.pos.y - center.y) / d } : undefined;
    damageMonster(state, p, m, damage, { dir, knockback });
  }
}

/** Nova skill: a radial shockwave around the player (must be learned). */
function doNova(state: GameState, p: Player): void {
  const np = novaParams(p);
  p.cd.nova = np.cooldown;
  p.novaFlash = 0.3;
  radialDamage(state, p, p.pos, np.radius, p.baseDamage * np.damageMult, CONFIG.novaKnockback);
}

/** Orbit blades: automatic contact damage on a fixed tick while learned. */
function updateOrbit(state: GameState, p: Player, dt: number): void {
  if (!slotted(p, "orbit") || !p.alive) return;
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
    damageMonster(state, p, m, p.baseDamage * op.damageMult, { allowCrit: false });
  }
}

// ---- Ultimates (the fifth slot) ----

/** Sponsor Airstrike: schedule a shell bombardment around the aim point. */
function doAirstrike(state: GameState, p: Player, aim: Vec2): void {
  p.cd.airstrike = CONFIG.ultAirstrikeCooldown;
  const len = Math.hypot(aim.x, aim.y);
  const range = Math.min(CONFIG.ultAirstrikeRange, len || 1);
  const dir = len > 0 ? { x: aim.x / len, y: aim.y / len } : p.facing;
  const target = { x: p.pos.x + dir.x * range, y: p.pos.y + dir.y * range };
  for (let i = 0; i < CONFIG.ultAirstrikeShells; i++) {
    const a = nextFloat(state.rng) * Math.PI * 2;
    const d = nextFloat(state.rng) * CONFIG.ultAirstrikeSpread;
    state.strikes.push({
      pos: { x: target.x + Math.cos(a) * d, y: target.y + Math.sin(a) * d },
      t: 0.45 + i * 0.22,
      ownerId: p.id,
    });
  }
  announce(state, `${p.name}'s sponsors have AUTHORIZED AN AIRSTRIKE. Clear the drop zone. Or don't — ratings.`);
}

/** Tick scheduled airstrike shells; each impact is a radial blast. */
function updateStrikes(state: GameState, dt: number): void {
  if (state.strikes.length === 0) return;
  const remaining: GameState["strikes"] = [];
  for (const s of state.strikes) {
    s.t -= dt;
    if (s.t > 0) { remaining.push(s); continue; }
    const owner = state.players.find((pl) => pl.id === s.ownerId) ?? state.players[0];
    radialDamage(state, owner, s.pos, CONFIG.ultAirstrikeRadius, owner.baseDamage * CONFIG.ultAirstrikeDmgMult, CONFIG.airstrikeKnockback);
    hit(state, s.pos, 0, "crit"); // impact flash for the juice layer
  }
  state.strikes = remaining;
}

/** Cataclysm Nova: a floor-shaking blast that hurls enemies back. */
function doCataclysm(state: GameState, p: Player): void {
  p.cd.cataclysm = CONFIG.ultCataclysmCooldown;
  p.novaFlash = 0.3; // reuse the ring effect
  radialDamage(state, p, p.pos, CONFIG.ultCataclysmRadius, p.baseDamage * CONFIG.ultCataclysmDmgMult);
  for (const m of state.monsters) {
    const d = dist(p.pos, m.pos);
    if (d > CONFIG.ultCataclysmRadius || d < 1e-4) continue;
    const dir = { x: (m.pos.x - p.pos.x) / d, y: (m.pos.y - p.pos.y) / d };
    moveWithCollision(state.map, m.pos, dir, CONFIG.ultCataclysmKnockback, isWalkable);
  }
  announce(state, `${p.name} CRACKS THE FLOOR. Everything airborne is a highlight.`);
}

/** Bullet Time: the world slows; crawlers do not. */
function doBulletTime(state: GameState, p: Player): void {
  p.cd.bullettime = CONFIG.ultBulletTimeCooldown;
  state.bulletTimeLeft = CONFIG.ultBulletTimeDuration;
  announce(state, `${p.name} bends the broadcast frame rate. BULLET TIME.`);
}

/**
 * Cast the ability in a slot. One switch = the whole cast surface; adding an
 * ability means one case here + a registry entry in abilities.ts.
 */
function castAbility(state: GameState, p: Player, ability: AbilityId, aim: Vec2): void {
  // Dash is charge-gated, not cooldown-gated: cd.dash is its recharge timer,
  // which may be ticking while a banked charge is still ready to spend.
  if (ability === "dash") {
    if (p.dashCharges > 0) doDash(state, p);
    return;
  }
  if ((p.cd[ability] ?? 0) > 0) return;
  switch (ability) {
    case "melee": doPlayerAttack(state, p, aim); break;
    case "bolt": doBolt(state, p, aim); break;
    case "nova": doNova(state, p); break;
    case "orbit": break; // passive: runs via updateOrbit while slotted
    case "airstrike": doAirstrike(state, p, aim); break;
    case "cataclysm": doCataclysm(state, p); break;
    case "bullettime": doBulletTime(state, p); break;
  }
}

/** A player died; the run only ends when the whole party is down. */
export function handlePlayerDeath(state: GameState, p: Player, line: string): void {
  p.hp = 0;
  p.alive = false;
  announce(state, line);
  if (alivePlayers(state).length === 0) {
    state.status = "dead";
    announce(state, "PARTY WIPE. The season finale nobody wanted. The crowd goes wild.");
  }
}

/** Advance every projectile: move, expire, hit walls/entities. */
function updateProjectiles(state: GameState, dt: number): void {
  const survivors: GameState["projectiles"] = [];
  const slow = state.bulletTimeLeft > 0 ? CONFIG.ultBulletTimeFactor : 1;
  for (const pr of state.projectiles) {
    const pdt = pr.from === "enemy" ? dt * slow : dt;
    pr.ttl -= pdt;
    pr.pos.x += pr.vel.x * pdt;
    pr.pos.y += pr.vel.y * pdt;
    if (pr.ttl <= 0 || !isWalkable(state.map, pr.pos.x, pr.pos.y)) continue;

    if (pr.from === "player") {
      const owner = state.players.find((pl) => pl.id === pr.ownerId) ?? state.players[0];
      let consumed = false;
      for (const m of state.monsters) {
        if (pr.hitIds?.includes(m.id)) continue; // pierced through this one already
        if (dist(pr.pos, m.pos) <= CONFIG.projectileRadius + 0.3) {
          damageMonster(state, owner, m, pr.damage, {
            dir: normalize(pr.vel), knockback: CONFIG.boltKnockback,
          });
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
      // Enemy projectile: hits the first living player in its radius (dash = i-frames).
      let absorbed = false;
      for (const p of state.players) {
        if (!p.alive || p.dashTime > 0) continue;
        if (dist(pr.pos, p.pos) > CONFIG.projectileRadius + 0.3) continue;
        p.hp -= pr.damage;
        p.damageTaken += pr.damage;
        hit(state, p.pos, Math.round(pr.damage), "player", { dir: normalize(pr.vel), killed: p.hp <= 0 });
        if (p.hp > 0 && p.hp < p.maxHp * CONFIG.show.lowHpFraction) addHype(state, p, CONFIG.show.hypeLowHpHit);
        if (p.hp <= 0) {
          handlePlayerDeath(state, p, `${p.name} was shot down in the arena. The audience is on its feet.`);
        }
        absorbed = true;
        break;
      }
      if (absorbed) continue;
    }
    survivors.push(pr);
  }
  state.projectiles = survivors;
}

/**
 * Advance the simulation by one fixed step. Pure with respect to wall-clock time:
 * all time flows through `dt`. Mutates and returns `state` (host owns the instance).
 *
 * Accepts either a single Intent (applied to the first player — the solo/local
 * convenience used by tests and the offline host) or a PartyIntents map keyed by
 * player id (the multiplayer form). Missing players get NO_INTENT.
 */
export function step(state: GameState, intent: Intent | PartyIntents, dt: number): GameState {
  state.events = [];
  state.announcements = [];
  state.hits = [];
  state.killsThisStep = 0;
  state.escapedCollapse = false;
  for (const p of state.players) {
    p.killsThisStep = 0;
    p.lowHpKill = false;
  }
  if (state.status !== "playing") return state;
  // The safe room is the one world-level pause: the whole party is between floors.
  // Personal drafts do NOT pause the world (multiplayer-safe); hosts may pause
  // locally in solo as a UX choice.
  if (state.safeRoom) return state;

  const intents: PartyIntents =
    "move" in intent ? { [state.players[0]?.id ?? 0]: intent as Intent } : (intent as PartyIntents);

  state.elapsed += dt;

  // Per-player: timers, movement, skills, attack — in stable id order so the
  // seeded RNG stream is reproducible regardless of intent-map key order.
  const ordered = [...state.players].sort((a, b) => a.id - b.id);
  for (const p of ordered) {
    const pi = intents[p.id] ?? NO_INTENT;

    for (const key of Object.keys(p.cd) as AbilityId[]) {
      if ((p.cd[key] ?? 0) > 0) p.cd[key] = Math.max(0, (p.cd[key] ?? 0) - dt);
    }
    // Dash recharge: an expired timer banks a charge and, while still below
    // max, immediately starts refilling the next one.
    if (p.dashCharges < CONFIG.dashCharges && (p.cd.dash ?? 0) <= 0) {
      p.dashCharges++;
      if (p.dashCharges < CONFIG.dashCharges) p.cd.dash = dashParams(p).cooldown;
    }
    if (p.attackSwing > 0) p.attackSwing = Math.max(0, p.attackSwing - dt);
    if (p.dashTime > 0) p.dashTime = Math.max(0, p.dashTime - dt);
    if (p.novaFlash > 0) p.novaFlash = Math.max(0, p.novaFlash - dt);

    const move = pi.move;
    if ((move.x !== 0 || move.y !== 0) && p.alive) {
      const dir = normalize(move);
      p.facing = dir;
      moveWithCollision(state.map, p.pos, dir, p.speed * dt, isWalkable);
    }

    // Slot-cast dispatch: explicit cast[] flags (slots 0-3 + ultimate at 4)
    // union'd with legacy per-ability flags mapped to wherever that ability is
    // slotted (tests/bots keep working; unslotted = no-op).
    if (p.alive) {
      const cast = [...(pi.cast ?? [])];
      while (cast.length < ABILITY_SLOTS + 1) cast.push(false);
      const legacy: [boolean | undefined, AbilityId][] = [
        [pi.attack, "melee"], [pi.dash, "dash"], [pi.bolt, "bolt"], [pi.nova, "nova"],
      ];
      for (const [flag, ability] of legacy) {
        if (!flag) continue;
        const idx = p.abilities.slots.indexOf(ability);
        if (idx >= 0) cast[idx] = true;
        else if (p.abilities.ultimate === ability) cast[ABILITY_SLOTS] = true;
      }
      const aim = pi.aim ?? p.facing;
      for (let s = 0; s < ABILITY_SLOTS; s++) {
        const ability = p.abilities.slots[s];
        if (cast[s] && ability) castAbility(state, p, ability, aim);
      }
      if (cast[ABILITY_SLOTS] && p.abilities.ultimate) castAbility(state, p, p.abilities.ultimate, aim);
    }
    updateOrbit(state, p, dt);
  }

  // Monsters + projectiles (bullet time slows the world, not the crawlers).
  if (state.bulletTimeLeft > 0) state.bulletTimeLeft = Math.max(0, state.bulletTimeLeft - dt);
  const mdt = state.bulletTimeLeft > 0 ? dt * CONFIG.ultBulletTimeFactor : dt;
  for (const m of state.monsters) stepMonster(state, m, mdt);
  updateStrikes(state, dt);
  updateProjectiles(state, dt);

  reapDead(state);
  collectLoot(state);

  // Collapse timer (applied after combat so its DoT can be the killing blow).
  if (state.status === "playing" && alivePlayers(state).length > 0) updateTimer(state, dt);

  // The Show: convert this step's hype into viewers / favorites / sponsors.
  updateShow(state, dt);

  // Fog of war: reveal tiles around every living player.
  revealAround(state);

  // Level-ups earned this step open personal ability drafts (queued if several).
  if (state.status === "playing") {
    for (const p of ordered) {
      if (p.upgradeDraftsOwed > 0 && p.pendingUpgrades.length === 0) {
        const offers = rollUpgradeDraft(state.rng, p, CONFIG.upgradeDraftSize);
        if (offers.length > 0) {
          p.upgradeDraftsOwed--;
          p.pendingUpgrades = offers;
        } else {
          p.upgradeDraftsOwed = 0; // every node maxed — nothing to offer
        }
      }
    }
  }

  // Descent request from anyone on the stairs (opens the safe room).
  if (state.status === "playing" && !state.safeRoom) {
    for (const p of ordered) {
      const pi = intents[p.id] ?? NO_INTENT;
      if (pi.useStairs && p.alive) {
        tryDescend(state, p);
        break;
      }
    }
  }

  // Achievements last, so they see everything this step did (kills, descent, buys).
  checkAchievements(state);

  return state;
}

/** Unlock any achievement whose condition now holds for a player; announce + pay out. */
function checkAchievements(state: GameState): void {
  for (const p of state.players) {
    for (const a of ACHIEVEMENTS) {
      if (p.achievements.includes(a.id)) continue;
      if (!a.test(state, p)) continue;
      p.achievements.push(a.id);
      p.gold += a.gold;
      if (a.hype > 0) addHype(state, p, a.hype);
      const payout = a.gold > 0 ? ` Reward: ${a.gold} gold.` : "";
      announce(state, `ACHIEVEMENT (${p.name}): ${a.title} — ${a.desc}${payout}`);
    }
  }
}

/** Mark tiles within any living player's vision radius as explored (shared fog). */
function revealAround(state: GameState): void {
  const { map, explored } = state;
  const r = CONFIG.fogVisionRadius;
  const r2 = r * r;
  let changed = false;
  for (const player of state.players) {
    if (!player.alive) continue;
    const px = player.pos.x, py = player.pos.y;
    const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(map.w - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(map.h - 1, Math.ceil(py + r));
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
  }
  if (changed) state.exploredVersion++;
}
