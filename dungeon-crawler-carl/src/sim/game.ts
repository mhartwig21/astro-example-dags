import { ARCHETYPES, CONFIG, FLOOR_BANDS, floorBand, floorTimeBudget, monsterTempo, xpForLevel, type MonsterArchetype } from "./config";
import { generateFloor, isWalkable, sealRoomOnMap, tileAt, walkableTiles } from "./floor";
import { createRng, nextFloat, nextInt, chance, pick, type Rng } from "./rng";
import { angleBetween, armorReduction, dist, mitigate, normalize, rollDamage } from "./combat";
import { moveWithCollision } from "./movement";
import { springAmbush, stepMonster } from "./ai";
import { generateItem, hasPassive, itemScore } from "./items";
import {
  CATALOG, CATALOG_BY_ID, TIER_RARITY, consumablePrice, consumableStock, gearAffixes, tierStockCount, totalCost,
  type CatalogEntry,
} from "./catalog";
import {
  ABILITY_INFO, ABILITY_SLOTS, DISCOVERABLE_ABILITIES, UPGRADES, airstrikeParams, boltParams, bulletTimeParams,
  crowdSurfParams, cutToParams, stuntDoubleParams,
  cataclysmParams, damageVariance, dashParams, knows, meleeParams,
  rank,
  novaParams, orbitBladePos, orbitParams, overchargeParams, power, rollUpgradeDraft, slotted, stanceMult, startingLoadout,
  unknownAbilities, upgradeDef, type AbilityId, type School, type UpgradeDef,
} from "./abilities";
import { ACHIEVEMENTS } from "./achievements";
import { REVISIONS, revisionPool } from "./revisions";
import { TIPS } from "./tips";
import { applyStatus, statusTimeMult, tickStatuses } from "./status";
import type {
  Announcement, AnnouncementKind, Decoy, BossSignature, EliteAffix, Equipment, FloorWorld, GameState, HitEvent, Intent, Item, Loot,
  MaterialId, Monster, MonsterKind, PartyIntents, Player, Reward, SafeRoom, StatusKind, Vec2,
} from "./types";
import { EQUIP_SLOTS, NO_INTENT, Tile } from "./types";

/** Recompute effective stats: intrinsic(level) + permanent bonuses + equipped affixes. */
export function recomputeStats(p: Player): void {
  // Both schools share the intrinsic level curve — at zero gear a fresh nova
  // hits exactly as hard as it did pre-schools. GEAR is the differentiator.
  const intrinsicPower = CONFIG.playerBaseDamage + (p.level - 1) * CONFIG.damagePerLevel;
  const intrinsicHp = CONFIG.playerMaxHp + (p.level - 1) * CONFIG.hpPerLevel;
  let atk = intrinsicPower + p.bonusDamage;
  let mag = intrinsicPower + p.bonusSpell;
  let hp = intrinsicHp + p.bonusMaxHp;
  let spd = CONFIG.playerSpeed;
  let crit = CONFIG.playerCritChance + p.bonusCrit;
  let arm = CONFIG.playerBaseArmor + p.bonusArmor;
  for (const slot of EQUIP_SLOTS) {
    const it = p.equipment[slot];
    if (!it) continue;
    atk += it.affixes.damage ?? 0;
    mag += it.affixes.spell ?? 0;
    hp += it.affixes.maxHp ?? 0;
    spd += it.affixes.speed ?? 0;
    crit += it.affixes.crit ?? 0;
    arm += it.affixes.armor ?? 0;
  }
  // CLASS REVISIONS (permanent castings) reshape the sheet multiplicatively,
  // so they keep scaling with levels and gear instead of aging out.
  const rv = p.revisions ?? [];
  if (rv.includes("heavy")) { hp *= CONFIG.revisionHeavyHpMult; arm += CONFIG.revisionHeavyArmor; }
  if (rv.includes("parkour")) { hp *= CONFIG.revisionParkourHpMult; spd *= CONFIG.revisionParkourSpeedMult; }
  if (rv.includes("underdog")) hp *= CONFIG.revisionUnderdogHpMult;
  p.attackPower = atk;
  p.spellPower = mag;
  p.maxHp = Math.round(hp);
  p.speed = spd;
  p.critChance = crit;
  p.armor = arm;
  p.weaponRarity = p.equipment.weapon?.rarity ?? "common";
  if (p.hp > p.maxHp) p.hp = p.maxHp;
}

/** A fresh all-empty equipment record (one socket per EQUIP_SLOTS entry). */
export function emptyEquipment(): Equipment {
  return Object.fromEntries(EQUIP_SLOTS.map((s) => [s, null])) as unknown as Equipment;
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
  // Compounding scaling steepens the back half (the linear curve loses to a
  // farming player by midgame). No effect at/under monsterScaleCompoundFrom.
  const compound = Math.pow(CONFIG.monsterScaleCompound, Math.max(0, floor - CONFIG.monsterScaleCompoundFrom));
  const baseHp = (CONFIG.monsterBaseHp + (floor - 1) * CONFIG.monsterHpPerFloor) * mpHp * compound;
  const baseDmg = (CONFIG.monsterBaseDamage + (floor - 1) * CONFIG.monsterDamagePerFloor) * mpDmg * compound;
  const baseXp = CONFIG.monsterXp + (floor - 1) * CONFIG.monsterXpPerFloor;
  const hp = Math.round(baseHp * a.hpMult);
  const m: Monster = {
    id: state.nextEntityId++,
    kind,
    pos: { x: pos.x, y: pos.y },
    hp,
    maxHp: hp,
    damage: baseDmg * a.dmgMult,
    speed: CONFIG.monsterSpeed * a.speedMult * monsterTempo(floor).speed,
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
  // Kind-intrinsic extras (not elite rolls): the drum IS the drummer.
  if (kind === "drummer") m.aura = "frenzy";
  if (kind === "filcher") {
    m.carry = Math.round(CONFIG.filcherGoldBase + CONFIG.filcherGoldPerFloor * floor);
    m.bleedStage = 3;
  }
  return m;
}

/** Pick an archetype mix that gets nastier with depth. */
function rollArchetype(rng: Rng, floor: number): MonsterKind {
  // Deeper floors shift the mix toward brutes/ranged/swarms, then unlock the
  // specialists: bombers (floor 2+), chargers (3+), shamans (4+), spitters
  // (5+), phantoms (6+), necromancers (7+).
  const rangedW = 1 + floor * 0.5;
  const bruteW = floor >= 3 ? floor * 0.4 : 0;
  const swarmW = 2 + floor * 0.3;
  const gruntW = 5;
  const bomberW = floor >= 2 ? floor * 0.3 : 0;
  const shamanW = floor >= 4 ? floor * 0.25 : 0;
  const phantomW = floor >= 6 ? floor * 0.3 : 0;
  const chargerW = floor >= 3 ? floor * 0.3 : 0;
  const spitterW = floor >= 5 ? floor * 0.25 : 0;
  const necroW = floor >= 7 ? floor * 0.2 : 0;
  const broodW = floor >= 5 ? floor * 0.15 : 0; // the nests move in mid-run
  const total = gruntW + swarmW + rangedW + bruteW + bomberW + shamanW + phantomW + chargerW + spitterW + necroW + broodW;
  let r = nextFloat(rng) * total;
  if ((r -= gruntW) < 0) return "grunt";
  if ((r -= swarmW) < 0) return "swarmer";
  if ((r -= rangedW) < 0) return "ranged";
  if ((r -= bomberW) < 0) return "bomber";
  if ((r -= shamanW) < 0) return "shaman";
  if ((r -= phantomW) < 0) return "phantom";
  if ((r -= chargerW) < 0) return "charger";
  if ((r -= spitterW) < 0) return "spitter";
  if ((r -= necroW) < 0) return "necromancer";
  if ((r -= broodW) < 0) return "broodmother";
  return "brute";
}

// Seeded flavor names for neighborhood/city bosses (DCC loves a named menace).
const ELITE_NAMES = [
  "The Gutter King", "Foreman Grizz", "Mama Fangs", "The Rent Collector",
  "Skitters Prime", "Old Chompy", "The Block Captain", "Sewer Baron Vex",
  "Knuckles the Landlord", "The HOA President",
];
// Band-end boss identities: one signature menace per arena (floors 3/6/9/12/15),
// each themed to its band and carrying that band's signature mechanic.
const BAND_BOSSES: { name: string; signature: BossSignature }[] = [
  { name: "The Crypt Concierge", signature: "graverising" }, // THE UNDERCROFT (3)
  { name: "The Sump King", signature: "flood" }, // THE SEWERS (6)
  { name: "The Topiary Warden", signature: "roots" }, // THE GARDEN (9)
  { name: "The Condemned Architect", signature: "debris" }, // THE RUINS (12)
  { name: "The Furnace Marshal", signature: "flamewall" }, // THE IRONWORKS (15)
];

// Affix pool for named elites (floor eliteAffixFromFloor+). One roll per elite.
const ELITE_AFFIXES: EliteAffix[] = [
  "swift", "shielded", "volatile", "summoner", "splitter", "thorns",
  "armored", "warded", "chilling",
];

/** A band-end boss arena floor (3, 6, 9, 12, 15 — never the final floor). */
export function isCityBossFloor(floor: number): boolean {
  return floor < CONFIG.finalFloor && floor >= CONFIG.bossFloorEvery && floor % CONFIG.bossFloorEvery === 0;
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
    boss.bossTier = 3; // Ground Slam + Call for Backup + Dark Ritual — the full kit
    state.monsters.push(boss);
    for (let i = 0; i < 3 && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    return;
  }

  // BAND BOSS floors (every band-end: 3, 6, 9, 12, 15): a sealed arena —
  // boss + escorts + a thinner regular crowd. Each arena's boss carries its
  // band's SIGNATURE mechanic on top of the shared kit; the tier ladder
  // (Ground Slam and its haste) climbs with depth, and the floor-3 opener
  // stays tier-0 gentle. The stairs stay sealed until the boss falls.
  if (isCityBossFloor(floor)) {
    const boss = makeMonster(state, "boss", { x: map.stairs.x, y: map.stairs.y });
    const arena = Math.floor(floor / CONFIG.bossFloorEvery); // 1..5
    const hp = CONFIG.bandBossHp[arena - 1] *
      (1 + extraPlayers(state) * CONFIG.mpBossHpPerExtraPlayer);
    boss.hp = boss.maxHp = Math.round(hp);
    boss.damage = CONFIG.bossDamage * CONFIG.bandBossDmgMult[arena - 1] *
      (1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer);
    boss.speed = CONFIG.bossSpeed;
    boss.xp = Math.round(CONFIG.bossXp * CONFIG.bandBossXpMult[arena - 1]);
    boss.eliteName = BAND_BOSSES[arena - 1].name;
    boss.signature = BAND_BOSSES[arena - 1].signature;
    // Tier ladder: floor 3 has no slam (early-game), 6/9 slam, 12/15 slam faster.
    boss.bossTier = floor >= 12 ? 2 : floor >= 6 ? 1 : undefined;
    state.monsters.push(boss);
    for (let i = 0; i < CONFIG.cityBossAdds && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    // Deep arenas keep the density story (the floor-15 crowd is a contract).
    const crowd = floor >= CONFIG.bossFloorCrowdDeepFrom ? CONFIG.bossFloorCrowdDeep : CONFIG.bossFloorCrowd;
    const count = Math.floor(monsterCount(state, floor) * crowd);
    for (let i = 0; i < count && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, rollArchetype(rng, floor), pos));
    }
    announce(state, "boss", `CITY BOSS: ${boss.eliteName} holds floor ${floor}. The exit is SEALED. Ratings, Crawlers.`, "high");
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
    if (pos) {
      const lone = makeMonster(state, rollArchetype(rng, floor), pos);
      lone.roams = true; // lone WANDERERS live up to the name
      state.monsters.push(lone);
      budget--;
    }
  }
  let guard = 0;
  while (budget > 0 && totalW > 0 && guard++ < 60) {
    const anchor = inRoom(pickRoom());
    if (!anchor) continue;
    const size = Math.min(budget, nextInt(rng, CONFIG.packSizeMin, CONFIG.packSizeMax));
    const kind = rollArchetype(rng, floor);
    const escort = floor >= CONFIG.packEscortFromFloor && kind !== "shaman" && chance(rng, 0.3);
    // Deep-floor AMBUSH: a share of packs lie dormant in the fog and spring as
    // one when a player wanders in (see stepMonster). A ranged/support pack
    // makes a poor ambush, so this favors melee kinds that benefit from surprise.
    const canAmbush =
      kind !== "ranged" && kind !== "shaman" && kind !== "spitter" &&
      kind !== "necromancer" && kind !== "broodmother";
    const ambush = floor >= CONFIG.ambushFromFloor && canAmbush && chance(rng, CONFIG.ambushPackChance);
    // Behavior VARIETY: a share of (non-ambush) packs PATROL their territory
    // together; the rest are sentries that hold the room they spawned in.
    const patrol = !ambush && chance(rng, CONFIG.packPatrolChance);
    for (let k = 0; k < size; k++) {
      // Cluster around the anchor; members that land in a wall squeeze inward.
      const a = nextFloat(rng) * Math.PI * 2;
      const d = 0.4 + nextFloat(rng) * 1.4;
      let pos = { x: anchor.x + Math.cos(a) * d, y: anchor.y + Math.sin(a) * d };
      if (map.tiles[Math.floor(pos.y) * map.w + Math.floor(pos.x)] !== 1) pos = { x: anchor.x, y: anchor.y };
      // The escort slot carries the pack's support: a shaman healer, or (from
      // the SEWERS down) a Drum Sergeant beating the pack into a frenzy — the
      // playbook's "The Drumline". Same kill-order lesson, different verb.
      const escortKind: MonsterKind =
        floor >= CONFIG.drumFromFloor && kind !== "drummer" && chance(rng, CONFIG.drumEscortChance)
          ? "drummer" : "shaman";
      const memberKind =
        escort && k === size - 1 ? escortKind
        : kind === "broodmother" && k > 0 ? "swarmer" // ONE mother + her brood
        : kind;
      const m = makeMonster(state, memberKind, pos);
      if (ambush) m.dormant = true;
      if (patrol) m.roams = true;
      state.monsters.push(m);
      budget--;
    }
  }

  // REPO RAT: from the SEWERS down, most ordinary floors hide one filcher —
  // a fleeing loot-goblin clutching the System's petty cash. Spot it, chase
  // it, or watch the payroll scurry off the show. Always a lone roamer.
  if (floor >= CONFIG.filcherFromFloor && chance(rng, CONFIG.filcherChance) && totalW > 0) {
    const pos = inRoom(pickRoom());
    if (pos) {
      const rat = makeMonster(state, "filcher", pos);
      rat.roams = true;
      state.monsters.push(rat);
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
    // Support castes never take the crown: shamans heal and necromancers raise —
    // neither ever ATTACKS, and a named "boss" that deals zero damage reads as
    // a bug, not a mechanic (packs get shaman escorts from floor 4+, so the
    // landmark pack very often contains one).
    const canBoss = (m: Monster) =>
      m.kind !== "boss" && m.kind !== "shaman" && m.kind !== "necromancer" &&
      m.kind !== "broodmother"; // support castes never take the crown
    const candidates = state.monsters.filter((m) => inLandmark(m) && canBoss(m));
    let m: Monster;
    if (candidates.length > 0) {
      m = candidates[nextInt(rng, 0, candidates.length - 1)];
    } else if (landmarkIdx >= 0) {
      const r = map.rooms[landmarkIdx];
      const rolled = rollArchetype(rng, floor);
      const kind = rolled === "shaman" || rolled === "necromancer" || rolled === "broodmother" ? "brute" : rolled;
      m = makeMonster(state, kind, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      state.monsters.push(m);
    } else {
      const fighters = state.monsters.filter(canBoss);
      m = fighters.length > 0
        ? fighters[nextInt(rng, 0, fighters.length - 1)]
        : state.monsters[nextInt(rng, 0, state.monsters.length - 1)]; // all-support floor: unreachable in practice
    }
    m.elite = true;
    m.eliteName = pick(rng, ELITE_NAMES);
    // HP multiplier grows with depth so elites track the player power curve
    // (a flat 3x is a one-shot by midgame — see the balance bot survey).
    m.hp = m.maxHp = Math.round(m.maxHp * (CONFIG.eliteHpMult + CONFIG.eliteHpMultPerFloor * floor));
    m.damage *= CONFIG.eliteDmgMult;
    m.xp = Math.round(m.xp * CONFIG.eliteXpMult);
    // From floor eliteAffixFromFloor, elites roll one affix mechanic.
    if (floor >= CONFIG.eliteAffixFromFloor) {
      m.affix = pick(rng, ELITE_AFFIXES);
      if (m.affix === "swift") m.speed *= CONFIG.swiftSpeedMult;
    }
    const tag = m.affix ? ` [${m.affix.toUpperCase()}]` : "";
    announce(state, "boss", `NEIGHBORHOOD BOSS: ${m.eliteName}${tag} holds the great hall. Introduce yourselves.`);
  }
}

/** Remove every locked door on the floor — except a timed vault's own doors,
 * which answer only to the vault's timer. Returns how many were opened. */
function unlockDoors(state: GameState): number {
  const { map } = state;
  const vaultDoors =
    state.floorEvent?.type === "vault" ? new Set(state.floorEvent.doors) : null;
  let opened = 0;
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] === Tile.DoorLocked) {
      if (vaultDoors?.has(i)) continue; // the key is not THAT good
      map.tiles[i] = Tile.Floor;
      opened++;
    }
  }
  map.locked = false;
  map.lockedRoomIdx = -1;
  if (opened > 0) state.mapVersion++; // cached floor geometry must rebuild
  return opened;
}

const KEY_AUDIT_INTERVAL = 3; // seconds between locked-door softlock audits

/**
 * Softlock self-healing (runtime): while the stairs district is sealed, audit
 * every few seconds that the KEY — its living carrier, or the dropped loot —
 * is still reachable from the floor entrance without crossing a locked door,
 * and that no living crawler is sealed inside the district. A violation means
 * some vector (a teleport, a knockback, a spawn ring, something not written
 * yet) put the run in an unwinnable state, so the System concedes the door
 * instead of ending the run. Vault doors count as PASSABLE here: they spring
 * open on approach, so a key waiting behind one is not a violation.
 * The spawn-time guard in assignKeyCarrier covers placement; this covers
 * everything that moves. Cost: one BFS over the grid every 3s, locked floors only.
 */
function auditKeyReachability(state: GameState, dt: number): void {
  const { map } = state;
  if (!map.locked) return;
  state.keyAuditT = (state.keyAuditT ?? 0) - dt;
  if (state.keyAuditT > 0) return;
  state.keyAuditT = KEY_AUDIT_INTERVAL;

  const vaultDoors = state.floorEvent?.type === "vault" ? new Set(state.floorEvent.doors) : null;
  const seen = new Uint8Array(map.w * map.h);
  const q = [Math.floor(map.spawn.y) * map.w + Math.floor(map.spawn.x)];
  seen[q[0]] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi] % map.w, y = (q[qi] / map.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni]) continue;
      const t = map.tiles[ni];
      if (t === Tile.Wall) continue;
      if (t === Tile.DoorLocked && !vaultDoors?.has(ni)) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  const ok = (pos: Vec2) => !!seen[Math.floor(pos.y) * map.w + Math.floor(pos.x)];

  const carrier = state.monsters.find((m) => m.hasKey && m.hp > 0);
  const keyLoot = state.loot.find((l) => l.kind === "key");
  const keyPos = carrier?.pos ?? keyLoot?.pos;
  const playerSealed = state.players.some((p) => p.alive && !ok(p.pos));
  if (keyPos && ok(keyPos) && !playerSealed) return; // all lawful — stay locked

  if (unlockDoors(state) > 0) {
    announce(
      state, "progress",
      !keyPos
        ? "The floor key is GONE. The System audits the ledger and WAIVES the door fee."
        : "RULES VIOLATION: the key left the arena of play. The System CONCEDES the door.",
      "high",
    );
  }
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
  // A timed-vault event seals its own room too — its guardian can't carry the key.
  const vault = state.floorEvent?.type === "vault" ? map.rooms[state.floorEvent.roomIdx] : null;
  const inVault = (pos: Vec2) =>
    !!vault && pos.x >= vault.x && pos.x < vault.x + vault.w && pos.y >= vault.y && pos.y < vault.y + vault.h;
  const candidates = state.monsters.filter((m) => m.kind !== "boss" && !inLockedRoom(m.pos) && !inVault(m.pos));
  if (candidates.length === 0) {
    unlockDoors(state);
    return;
  }
  candidates[nextInt(rng, 0, candidates.length - 1)].hasKey = true;
  announce(state, "progress", "The stairs district is LOCKED. One of the residents has the key. Ask nicely.");
}

/**
 * FLOOR EVENTS: most floors 2+ (never boss floors) roll ONE seeded event —
 * a System Shrine (pick-1 bargain at a touchable prop), a timed vault (the
 * vault room seals; approach springs it open on a timer), or a sponsor
 * challenge (clear a room's pack untouched for a purse). Pure sim data:
 * hosts render the prop/doors and relay the announcements.
 */
function maybeSpawnFloorEvent(state: GameState): void {
  const { map, rng, floor } = state;
  if (floor < 2 || floor >= CONFIG.finalFloor || isCityBossFloor(floor)) return;
  if (!chance(rng, CONFIG.eventChance)) return;

  // What this floor's layout supports; the roll picks among the eligible.
  const options: ("shrine" | "vault" | "challenge")[] = ["shrine"];
  const vaultIdx = map.roles.indexOf("vault");
  if (vaultIdx >= 0) options.push("vault");
  const landmarkIdx = map.roles.indexOf("landmark");
  const inRoom = (pos: Vec2, i: number) => {
    const r = map.rooms[i];
    return pos.x >= r.x && pos.x < r.x + r.w && pos.y >= r.y && pos.y < r.y + r.h;
  };
  const packIds = landmarkIdx >= 0
    ? state.monsters.filter((m) => inRoom(m.pos, landmarkIdx)).map((m) => m.id)
    : [];
  if (packIds.length >= 3) options.push("challenge");
  const type = pick(rng, options);

  if (type === "vault") {
    const doors = sealRoomOnMap(map, vaultIdx);
    if (doors) {
      const r = map.rooms[vaultIdx];
      const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      dropBossBonus(state, c, 1); // a sweetener on top of the standing vault haul
      state.floorEvent = { type: "vault", roomIdx: vaultIdx, doors, phase: "sealed", openT: 0 };
      announce(state, "loot", "A TIMED VAULT is sealed on this floor. It opens for whoever knocks — briefly.");
      return;
    }
    // Sealing declined (softlock guard) — fall through to the shrine.
  }

  if (type === "challenge") {
    state.floorEvent = {
      type: "challenge", roomIdx: landmarkIdx, phase: "offered", ids: packIds,
      gold: CONFIG.challengeGoldBase + floor * CONFIG.challengeGoldPerFloor,
    };
    return; // announced when someone steps into the hall
  }

  // System Shrine: a touchable prop in a seeded combat/landmark room.
  const roomChoices = map.rooms
    .map((_r, i) => i)
    .filter((i) => map.roles[i] === "combat" || map.roles[i] === "landmark");
  if (roomChoices.length === 0) return;
  const ri = roomChoices[nextInt(rng, 0, roomChoices.length - 1)];
  const r = map.rooms[ri];
  for (let tries = 0; tries < 12; tries++) {
    const x = nextInt(rng, r.x, r.x + r.w - 1) + 0.5;
    const y = nextInt(rng, r.y, r.y + r.h - 1) + 0.5;
    if (map.tiles[Math.floor(y) * map.w + Math.floor(x)] !== Tile.Floor) continue;
    if (dist({ x, y }, map.spawn) <= 6) continue;
    state.loot.push({ id: state.nextEntityId++, pos: { x, y }, kind: "shrine", amount: 0 });
    state.floorEvent = { type: "shrine" };
    announce(state, "flavor", "A SYSTEM SHRINE hums on this floor. It wants to make a deal.");
    return;
  }
}

/** Tick the floor event: vault trigger/reseal, challenge activation/verdict. */
function updateFloorEvent(state: GameState, dt: number): void {
  const ev = state.floorEvent;
  if (!ev) return;
  if (ev.type === "vault") {
    const room = state.map.rooms[ev.roomIdx];
    const within = (pad: number) => state.players.some(
      (p) => p.alive &&
        p.pos.x >= room.x - pad && p.pos.x < room.x + room.w + pad &&
        p.pos.y >= room.y - pad && p.pos.y < room.y + room.h + pad,
    );
    if (ev.phase === "sealed" && within(CONFIG.vaultTriggerRadius)) {
      for (const i of ev.doors) if (state.map.tiles[i] === Tile.DoorLocked) state.map.tiles[i] = Tile.Floor;
      state.mapVersion++;
      ev.phase = "open";
      ev.openT = CONFIG.vaultOpenSeconds;
      announce(state, "loot", `THE VAULT OPENS. ${CONFIG.vaultOpenSeconds} seconds until it seals again — sprint, Crawler.`);
    } else if (ev.phase === "open") {
      ev.openT -= dt;
      if (ev.openT > 0) return;
      // Never seal a crawler inside: hold until the room and doorways clear.
      if (within(1)) return;
      for (const i of ev.doors) if (state.map.tiles[i] === Tile.Floor) state.map.tiles[i] = Tile.DoorLocked;
      state.mapVersion++;
      ev.phase = "resealed";
      announce(state, "loot", "The vault SEALS. Whatever you grabbed is the haul; the System counts the leftovers.");
    }
    return;
  }
  if (ev.type === "challenge") {
    const total = () => state.players.reduce((s, p) => s + p.damageTaken, 0);
    if (ev.phase === "offered") {
      const room = state.map.rooms[ev.roomIdx];
      const entered = state.players.some(
        (p) => p.alive &&
          p.pos.x >= room.x && p.pos.x < room.x + room.w &&
          p.pos.y >= room.y && p.pos.y < room.y + room.h,
      );
      if (!entered) return;
      ev.ids = ev.ids.filter((id) => state.monsters.some((m) => m.id === id && m.hp > 0));
      if (ev.ids.length === 0) {
        ev.phase = "cleared"; // pack sniped from the doorway — clean, but no dare, no purse
        return;
      }
      ev.phase = "active";
      ev.dmg0 = total();
      announce(state, "show", `SPONSOR CHALLENGE: clear this hall WITHOUT taking a hit. Purse: ${ev.gold} gold. Cameras up.`);
      return;
    }
    if (ev.phase !== "active") return;
    if (total() > (ev.dmg0 ?? 0) + 0.5) {
      ev.phase = "failed";
      announce(state, "show", "Challenge VOID — the sponsors saw that hit. The purse evaporates.");
      return;
    }
    if (!ev.ids.some((id) => state.monsters.some((m) => m.id === id && m.hp > 0))) {
      ev.phase = "cleared";
      for (const p of alivePlayers(state)) {
        p.gold += ev.gold;
        addHype(state, p, CONFIG.challengeHype);
      }
      announce(state, "show", `CHALLENGE COMPLETE — untouched! The sponsors pay ${ev.gold} gold. A CLEAN fight, folks.`);
    }
    return;
  }
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
    attackPower: CONFIG.playerBaseDamage,
    spellPower: CONFIG.playerBaseDamage,
    critChance: CONFIG.playerCritChance,
    armor: CONFIG.playerBaseArmor,
    cd: {},
    dashTime: 0,
    rootT: 0,
    dashCharges: CONFIG.dashCharges,
    flaskCharges: CONFIG.flaskMaxCharges,
    flaskKillProgress: 0,
    frenzy: false,
    novaFlash: 0,
    orbitAngle: 0,
    orbitTick: 0,
    orbitSpiral: 0,
    stance: "melee",
    stanceTime: 0,
    stanceSwapWindow: 0,
    stanceCritReady: false,
    meleeCombo: 0,
    meleeComboT: 0,
    cutMark: null,
    overcharged: false,
    plotArmorUsed: false,
    statuses: [],
    reviveProgress: 0,
    floorNo: 1,
    abilities: startingLoadout(),
    level: 1,
    xp: 0,
    xpToNext: xpForLevel(1),
    gold: 0,
    weaponRarity: "common",
    equipment: emptyEquipment(),
    inventory: [],
    bonusDamage: 0,
    bonusSpell: 0,
    bonusMaxHp: 0,
    bonusCrit: 0,
    bonusArmor: 0,
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
    materials: { elite_trophy: 0, boss_sigil: 0 },
    damageDealt: 0,
    damageTaken: 0,
    hype: 0,
    viewers: CONFIG.show.baseViewers,
    favorites: 0,
    sponsors: 0,
    revisions: [],
    tipsSeen: [],
  };
  recomputeStats(p);
  return p;
}

/** Has this crawler taken the given CLASS REVISION? (revisions.ts ids). */
export function hasRevision(p: Player, id: string): boolean {
  return (p.revisions ?? []).includes(id);
}

/** First-contact rule explainer (tips.ts): fires ONCE per crawler, the first
 * time the rule touches them. The System files a courtesy explanation. */
function systemTip(state: GameState, p: Player, id: string): void {
  const line = TIPS[id];
  if (!line || (p.tipsSeen ?? []).includes(id)) return;
  (p.tipsSeen ??= []).push(id);
  announce(state, "tip", line);
}

/** Max dash charges: base + PARKOUR ARTIST's extra. */
function maxDashCharges(p: Player): number {
  return CONFIG.dashCharges + (hasRevision(p, "parkour") ? CONFIG.revisionParkourCharges : 0);
}

/** Reset a player's transient combat state for a fresh floor (progression carries). */
function resetForFloor(p: Player, spawn: Vec2, offset: number): void {
  // Fan the party out around the spawn tile so nobody stacks.
  const a = offset * (Math.PI * 2 / 6);
  p.pos = { x: spawn.x + (offset === 0 ? 0 : Math.cos(a) * 0.6), y: spawn.y + (offset === 0 ? 0 : Math.sin(a) * 0.6) };
  p.facing = { x: 0, y: 1 };
  p.cd = {};
  p.dashTime = 0;
  p.rootT = 0;
  p.dashCharges = maxDashCharges(p);
  p.flaskCharges = CONFIG.flaskMaxCharges; // safe-room rest tops the Slurps back up
  p.flaskKillProgress = 0;
  p.novaFlash = 0;
  p.attackSwing = 0;
  p.stanceTime = 0; // the stance itself carries — it's part of the build
  p.stanceSwapWindow = 0;
  p.stanceCritReady = false;
  p.overcharged = false;
  p.plotArmorUsed = false; // the writers grant one save per floor
  p.petUsed = false; // the producers grant one save per floor too
  p.statuses = []; // the stairwell air burns the poison right out
  p.reviveProgress = 0;
  // Fallen crawlers rejoin the show at half strength when the party descends.
  if (!p.alive) {
    p.alive = true;
    p.hp = Math.round(p.maxHp * 0.5);
  }
}

// Cosmetic hero skins: every run you drop in as a random adventurer, and party
// members never twin (up to the pool size). Purely DERIVED from (seed, player
// id) — no state, no save field, no rng-stream impact, and every client
// computes the same answer from the shared seed. Becomes real chosen state
// when character types/classes land.
export const HERO_SKINS = ["knight", "barbarian", "mage", "rogue", "hooded"] as const;
export type HeroSkin = (typeof HERO_SKINS)[number];

/** Which adventurer this crawler is for this run (hosts map it to a model). */
export function heroSkin(seed: number, playerId: number): HeroSkin {
  const base = (Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) >>> 8) % HERO_SKINS.length;
  return HERO_SKINS[(base + playerId) % HERO_SKINS.length];
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
  announce(state, "show", `${name} drops into the dungeon. The audience loves fresh meat.`);
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
    announce(state, "progress", `Now entering ${band.name}. ${band.line}`, "high");
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
  state.hazards = [];
  state.corpses = [];
  state.decoys = []; // stunt contracts don't follow you downstairs
  state.encounter = null;
  state.floorEvent = null;
  state.goldSurge = false;
  state.players.forEach((p, i) => resetForFloor(p, state.map.spawn, i));
  state.timeBudget = floorTimeBudget(floor);
  // SERIES REGULAR's debt: the network trims every remaining floor's runtime.
  if (state.players.some((p) => hasRevision(p, "regular"))) {
    state.timeBudget = Math.round(state.timeBudget * CONFIG.revisionRegularTimeMult);
  }
  state.timeRemaining = state.timeBudget;
  state.phase = "safe";
  state.collapseElapsed = 0;
  state.mapVersion++;
  spawnMonsters(state);
  maybeSpawnFloorEvent(state); // before the key roll: a sealed vault never holds the key
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
    bonusSpell?: number;
    bonusMaxHp?: number;
    bonusCrit?: number;
    bonusArmor?: number;
    equipment?: Player["equipment"];
    inventory?: Item[];
    abilities?: Player["abilities"];
    achievements?: string[];
    goldSpent?: number;
    kills?: number;
    name?: string;
    damageDealt?: number;
    damageTaken?: number;
    materials?: Record<MaterialId, number>;
    revisions?: string[]; // CLASS REVISIONS taken (pre-revision saves: absent)
    tipsSeen?: string[]; // first-contact tips already delivered (pre-tips saves: absent)
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
  p.bonusSpell = s.bonusSpell ?? 0;
  p.bonusMaxHp = s.bonusMaxHp ?? 0;
  p.bonusCrit = s.bonusCrit ?? 0;
  p.bonusArmor = s.bonusArmor ?? 0; // pre-armor saves default to 0
  if (s.equipment) {
    // Fold whatever slots the save knew about into the current six-socket
    // shape (pre-#10 saves carried only weapon/armor/trinket) — missing
    // sockets load empty, unknown extras are dropped.
    const e = emptyEquipment();
    for (const slot of EQUIP_SLOTS) e[slot] = s.equipment[slot] ?? null;
    p.equipment = e;
  }
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
  p.revisions = s.revisions ?? []; // CLASS REVISIONS survive the reload
  p.tipsSeen = s.tipsSeen ?? []; // a rule explained once stays explained
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
  if (s.materials) {
    // Legacy saves may carry extra material keys (pre-shop "scrap"); take only
    // what the current economy spends.
    p.materials = {
      elite_trophy: s.materials.elite_trophy ?? 0,
      boss_sigil: s.materials.boss_sigil ?? 0,
    };
  }
  // Legacy saves (pre-itemization) stored effective maxHp/baseDamage directly;
  // fold the surplus over intrinsic into permanent bonuses so old runs resume
  // intact. Pre-schools damage fed EVERY ability, so it folds into both powers.
  if (s.bonusDamage === undefined && s.baseDamage !== undefined) {
    p.bonusDamage = Math.max(0, s.baseDamage - (CONFIG.playerBaseDamage + (p.level - 1) * CONFIG.damagePerLevel));
    p.bonusSpell = p.bonusDamage;
  }
  if (s.bonusMaxHp === undefined && s.maxHp !== undefined) {
    p.bonusMaxHp = Math.max(0, s.maxHp - (CONFIG.playerMaxHp + (p.level - 1) * CONFIG.hpPerLevel));
  }
  recomputeStats(p);
  p.hp = Math.min(s.hp, p.maxHp);
  buildFloor(state, save.floor);
  return state;
}

export interface TestSetup {
  seed?: number;
  floor?: number; // starting floor, clamped to 1..finalFloor
  level?: number; // crawler level; ranks are auto-drafted to match
  gold?: number; // default scales with the floor so the shop is testable
  abilities?: AbilityId[] | "all"; // learned + auto-slotted before leveling
  gear?: boolean; // roll floor-scaled random gear (default true)
}

/**
 * Test-mode bootstrap (hosts gate it behind a ?test URL): a deterministic,
 * stage-representative run — floor N, a crawler leveled through the REAL
 * draft roller (so the constellation build is one a player could hold),
 * floor-scaled gear, and any requested abilities slotted. Only the seeded
 * RNG is used: the same setup always produces the same character.
 */
export function createTestGame(opts: TestSetup = {}): GameState {
  const seed = (opts.seed ?? 0xc0ffee) >>> 0;
  const floor = Math.max(1, Math.min(CONFIG.finalFloor, Math.floor(opts.floor ?? 1)));
  const level = Math.max(1, Math.min(50, Math.floor(opts.level ?? 1)));
  const state = createGame(seed);
  const p = state.players[0];

  const wanted: AbilityId[] = opts.abilities === "all" ? [...DISCOVERABLE_ABILITIES] : opts.abilities ?? [];
  for (const a of wanted) learnAbility(state, p, a);

  while (p.level < level) {
    p.level++;
    p.xpToNext = xpForLevel(p.level);
    const offers = rollUpgradeDraft(state.rng, p, CONFIG.upgradeDraftSize, floor);
    if (offers.length > 0) {
      // Stage-representative drafting: a player builds their core kit first
      // and feeds the ultimate's constellation with the spare picks — random
      // over ALL nodes would scatter a third of the ranks into the ultimate
      // and understate the crawler the deep floors actually face.
      const actives = offers.filter((o) => ABILITY_INFO[o.ability].tier === "active");
      const offer = pick(state.rng, actives.length > 0 ? actives : offers);
      p.abilities.ranks[offer.id] = (p.abilities.ranks[offer.id] ?? 0) + 1;
    }
  }
  p.xp = 0;

  // Floor-scaled loadout: several rolls, wear the upgrades, bag a few spares.
  if (opts.gear !== false) {
    for (let i = 0; i < 8; i++) {
      const item = generateItem(state.rng, floor, () => state.nextEntityId++);
      const worn = p.equipment[item.slot];
      if (!worn || itemScore(item) > itemScore(worn)) {
        p.equipment[item.slot] = item;
        if (worn && p.inventory.length < 4) p.inventory.push(worn);
      } else if (p.inventory.length < 4) {
        p.inventory.push(item);
      }
    }
  }

  p.gold = Math.max(0, Math.floor(opts.gold ?? floor * 40));
  recomputeStats(p);
  p.hp = p.maxHp;
  buildFloor(state, floor);
  state.events.push(`TEST MODE: floor ${floor}, level ${level}, seed ${seed}.`);
  return state;
}

export function createGame(seed: number, mode: GameState["mode"] = "coop"): GameState {
  const state: GameState = {
    mode,
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
    decoys: [],
    hazards: [],
    corpses: [],
    pings: [],
    encounter: null,
    floorEvent: null,
    goldSurge: false,
    killsThisStep: 0,
    escapedCollapse: false,
    elapsed: 0,
  };
  buildFloor(state, 1);
  // Rivals: floor 1 becomes the first concurrent world (others build lazily
  // as the race spreads out). The mounted slots stay live references to it.
  if (mode === "rivals") state.worlds = { 1: captureWorld(state) };
  return state;
}

/** Add excitement to ONE crawler's broadcast. Hype → viewers → favorites → sponsors. */
export function addHype(_state: GameState, p: Player, amount: number): void {
  // CLASS REVISIONS bend the gain: CANCELED halves it, THE UNDERDOG doubles it
  // while hurt, and every REMAIN UNCAST pays its small defiance dividend.
  if (amount > 0) {
    let mult = 1;
    if (hasRevision(p, "canceled")) mult *= CONFIG.revisionCanceledHypeMult;
    if (hasRevision(p, "underdog") && p.hp < p.maxHp * CONFIG.revisionUnderdogThreshold) {
      mult *= CONFIG.revisionUnderdogHypeMult;
    }
    const uncast = (p.revisions ?? []).filter((r) => r === "uncast").length;
    if (uncast > 0) mult *= 1 + uncast * CONFIG.revisionUncastHype;
    amount *= mult;
  }
  p.hype = Math.min(CONFIG.show.hypeMax, p.hype + amount);
}

/** Per-step update of the audience economy (deterministic; time flows via dt). */
function updateShow(state: GameState, dt: number): void {
  const s = CONFIG.show;
  for (const p of state.players) {
    // Hype cools proportionally — the hotter the crowd, the faster it fades.
    // Sustained play finds an equilibrium (input/frac) instead of pinning the
    // cap, which is what lets +hype-per-kill gear shift where you sit.
    p.hype = Math.max(0, p.hype - (s.hypeDecay + p.hype * s.hypeDecayFrac) * dt);
    // Viewers ease toward a target set by floor depth + current hype + fan loyalty.
    const target = s.baseViewers + state.floor * s.viewersPerFloor + p.hype * s.viewersPerHype + p.favorites * 0.5;
    p.viewers += (target - p.viewers) * Math.min(1, s.viewerEase * dt);
    // A slice of the audience converts to sticky favorites while the crowd is
    // hyped. sqrt: excitement spikes convert, camping at the cap can't run away.
    if (p.hype > s.favConvertThreshold) {
      p.favorites += Math.sqrt(p.hype - s.favConvertThreshold) * s.favPerHypePerSec * dt;
      if (p.favorites >= 1) systemTip(state, p, "favorites");
    }
    // Crossing a favorite threshold earns a sponsor (CORPORATE SELLOUT signs early).
    const thMult = hasRevision(p, "sellout") ? CONFIG.revisionSelloutThresholdMult : 1;
    while (p.sponsors < s.sponsorThresholds.length && p.favorites >= s.sponsorThresholds[p.sponsors] * thMult) {
      p.sponsors++;
      announce(state, "show", `NEW SPONSOR for ${p.name}! ${p.sponsors} now bankroll the run. They expect a show.`);
      if (p.sponsors === 1) systemTip(state, p, "sponsors");
    }
    // Crowd Frenzy: sustained hype buffs the crawler (hysteresis so the state
    // doesn't flap as hype oscillates around the threshold).
    if (!p.frenzy && p.hype >= s.frenzyEnter) {
      p.frenzy = true;
      announce(state, "show", `The crowd is CHANTING ${p.name.toUpperCase()}. Frenzy: faster feet, faster hands.`);
    } else if (p.frenzy && p.hype < s.frenzyExit) {
      p.frenzy = false;
    }
  }
}

/** Frenzy shortens ability cooldowns (and the dash recharge). */
function cdMult(p: Player): number {
  let mult = p.frenzy ? CONFIG.frenzyCooldownMult : 1;
  // Tempo (legendary caster staff): every ACTIVE cooldown runs faster —
  // ultimates have their own clause (see the "overtime" hook in step()).
  if (hasPassive(p, "tempo")) mult *= CONFIG.tempoCooldownMult;
  if (hasRevision(p, "typecast")) mult *= CONFIG.revisionTypecastCdMult;
  return mult;
}

// ---- The System intervenes (VOICE.md) ----
// A flatlined broadcast is a business problem, and the System administers
// engagement. Per-crawler: hype below the floor accrues boredom; each trip
// past the threshold fires an intervention one tier meaner than the last.
// Hype above the floor resets BOTH clocks — hype is cover. Suppressed in
// safe rooms, during ringside intros, during collapse, and on floors 1-2.

/** Tier 1: crown the nearest chaff with a bounty — an offer, not a punishment. */
function postBounty(state: GameState, p: Player): void {
  let best: Monster | null = null;
  let bestD = Infinity;
  for (const m of state.monsters) {
    if (m.hp <= 0 || m.kind === "boss" || m.elite || (m.bountyT ?? 0) > 0 || m.dormant) continue;
    const d = dist(p.pos, m.pos);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best) { correctiveAmbush(state, p); return; } // nothing to crown: straight to content
  const gold = CONFIG.interferenceBountyGold + state.floor * CONFIG.interferenceBountyGoldPerFloor;
  best.bountyT = CONFIG.interferenceBountyWindow;
  best.bountyGold = gold;
  best.speed *= CONFIG.interferenceBountySpeedMult; // agitated, permanently
  hit(state, best.pos, 0, "weapon"); // crowning ping for the juice layer
  announce(state, "show", `NOTICE: ${p.name}'s viewership is declining. A bounty has been posted: ${gold} gold, ${CONFIG.interferenceBountyWindow} seconds. Make it interesting.`);
}

/** Tier 2: corrective content — a spawned wave, telegraph-free but chaff-tier. */
function correctiveAmbush(state: GameState, p: Player): void {
  const count = CONFIG.interferenceAmbushCount;
  for (let i = 0; i < count; i++) {
    const kind: MonsterKind = i === count - 1 ? "ranged" : "swarmer";
    const a = (i / count) * Math.PI * 2 + nextFloat(state.rng) * 0.5;
    const d = CONFIG.interferenceAmbushRadius * (0.75 + nextFloat(state.rng) * 0.5);
    let pos = { x: p.pos.x + Math.cos(a) * d, y: p.pos.y + Math.sin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: p.pos.x, y: p.pos.y };
    const add = makeMonster(state, kind, pos);
    add.xp = 1; // corrective content is not a farm
    state.monsters.push(add);
    hit(state, add.pos, 0, "weapon"); // arrival poof
  }
  announce(state, "show", `NOTICE: engagement in ${p.name}'s sector remains unacceptable. Corrective content has been scheduled. Delivery: immediate.`);
}

/** Tier 3: the engagement review — telegraphed impact circles on the offender. */
function hazardReview(state: GameState, p: Player): void {
  const dmg = Math.max(1, Math.round(p.maxHp * CONFIG.interferenceHazardDmgFrac));
  for (let i = 0; i < CONFIG.interferenceHazardCount; i++) {
    const a = nextFloat(state.rng) * Math.PI * 2;
    const d = nextFloat(state.rng) * 2.5;
    const pos = { x: p.pos.x + Math.cos(a) * d, y: p.pos.y + Math.sin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    const delay = CONFIG.interferenceHazardDelay + i * 0.35;
    state.hazards.push({
      id: state.nextEntityId++, pos, t: delay, total: delay,
      radius: CONFIG.interferenceHazardRadius, damage: dmg, // kind absent = blast
    });
  }
  announce(state, "show", `NOTICE: ${p.name}'s sector has failed its engagement review. Environmental corrections are incoming. The System recommends movement.`);
}

/** Tick the boredom clocks and any live bounties (per mounted world). */
function updateInterference(state: GameState, dt: number): void {
  // Bounty windows tick down; a lapsed purse is quietly repossessed.
  for (const m of state.monsters) {
    if ((m.bountyT ?? 0) > 0) {
      m.bountyT = Math.max(0, m.bountyT! - dt);
      if (m.bountyT === 0) state.events.push("The bounty lapses. The System repossesses the purse.");
    }
  }
  if (state.status !== "playing") return;
  if (state.floor <= CONFIG.interferenceGraceFloors) return;
  if (state.safeRoom || state.encounter || state.phase === "collapse") return;
  for (const p of state.players) {
    if (!p.alive || p.safeRoom) { p.boredT = 0; continue; }
    if (p.hype >= CONFIG.interferenceHypeFloor) {
      p.boredT = 0;
      p.boredTier = 0; // a recovered broadcast is forgiven everything
      continue;
    }
    const rate = hasRevision(p, "pet") ? CONFIG.revisionPetBoredomMult : 1;
    p.boredT = (p.boredT ?? 0) + dt * rate;
    if (p.boredT < CONFIG.interferenceBoredom) continue;
    p.boredT = 0;
    systemTip(state, p, "interference"); // the first correction comes with paperwork
    const tier = Math.min(p.boredTier ?? 0, 2);
    p.boredTier = (p.boredTier ?? 0) + 1;
    if (tier === 0) postBounty(state, p);
    else if (tier === 1) correctiveAmbush(state, p);
    else hazardReview(state, p);
  }
}

/** Drink the flask: charge-gated heal; a full-HP chug is not consumed. */
export function useFlask(state: GameState, p: Player): void {
  if (!CONFIG.flaskEnabled) return;
  if (!p.alive || p.flaskCharges <= 0 || p.hp >= p.maxHp) return;
  p.flaskCharges--;
  const amt = Math.round(p.maxHp * CONFIG.flaskHealFraction);
  p.hp = Math.min(p.maxHp, p.hp + amt);
  hit(state, p.pos, amt, "heal");
  state.events.push(`${p.name} chugs a Sponsor Slurp™ (+${amt} HP, ${p.flaskCharges} left).`);
}

/**
 * Ringside introductions: the first time any living player closes within
 * encounterRevealRadius of an unmet boss/elite, freeze the world for the
 * reveal. One introduction per step; each menace gets exactly one.
 */
function maybeStartEncounter(state: GameState): void {
  for (const m of state.monsters) {
    if (m.hp <= 0 || m.introduced) continue;
    if (m.kind !== "boss" && !m.elite) continue;
    const near = state.players.some(
      (p) => p.alive && dist(p.pos, m.pos) <= CONFIG.encounterRevealRadius,
    );
    if (!near) continue;
    m.introduced = true;
    // A ringside introduction blows the trap's cover: a revealed named menace
    // never stands inert — its whole dormant cluster springs with it.
    if (m.dormant) springAmbush(state, m);
    const name = m.eliteName ?? (state.floor >= CONFIG.finalFloor ? "THE FLOOR BOSS" : "THE BOSS");
    state.encounter = {
      monsterId: m.id,
      name,
      kind: m.kind,
      elite: !!m.elite,
      affix: m.affix,
      timeLeft: CONFIG.encounterIntroSeconds,
      total: CONFIG.encounterIntroSeconds,
    };
    const tag = m.affix ? ` [${m.affix.toUpperCase()}]` : "";
    announce(
      state, "boss",
      m.kind === "boss"
        ? `RINGSIDE INTRODUCTION: ${name}. The exit stays sealed while it breathes. FIGHT.`
        : `RINGSIDE INTRODUCTION: ${name}${tag}. The crowd wants a clean fight. They won't get one.`,
      "high",
    );
    for (const p of alivePlayers(state)) addHype(state, p, 8); // entrances play great
    return;
  }
}

/**
 * Necromancer raise resolves: the committed corpse (if it hasn't faded) gets
 * back up as a fresh, weakened minion of its old kind. Worth almost no XP.
 */
export function raiseCorpse(state: GameState, m: Monster): void {
  const idx = state.corpses.findIndex((c) => c.id === m.raiseId);
  m.raiseId = undefined;
  if (idx < 0) return; // the corpse faded mid-ritual — whiffed
  const corpse = state.corpses.splice(idx, 1)[0];
  const raised = makeMonster(state, corpse.kind, corpse.pos);
  raised.hp = raised.maxHp = Math.max(1, Math.round(raised.maxHp * CONFIG.necroRaisedHpMult));
  raised.xp = CONFIG.necroRaisedXp;
  m.summons = (m.summons ?? 0) + 1;
  state.monsters.push(raised);
  hit(state, raised.pos, 0, "weapon"); // a poof for the juice layer
  state.events.push(`A necromancer drags a ${corpse.kind} back to its feet.`);
}

/** Summoner elites call a swarmer add (worth almost no XP — not a farm). */
export function summonMinion(state: GameState, m: Monster): void {
  const a = nextFloat(state.rng) * Math.PI * 2;
  const spawned = makeMonster(state, "swarmer", {
    x: m.pos.x + Math.cos(a) * 0.7, y: m.pos.y + Math.sin(a) * 0.7,
  });
  spawned.xp = 1;
  state.monsters.push(spawned);
  hit(state, spawned.pos, 0, "weapon"); // a poof for the juice layer
}

/**
 * Boss phase transition calls an ADDS WAVE (backlog #11): a ring of chaff
 * plus a ranged flanker so the enrage changes what the party is DOING.
 * Waves are worth almost no XP — the boss is the payday, not its entourage.
 */
export function spawnBossWave(state: GameState, boss: Monster): void {
  const count = CONFIG.bossWaveAdds + (boss.phase ?? 0) * CONFIG.bossWaveAddsPerPhase;
  for (let i = 0; i < count; i++) {
    const kind: MonsterKind = i === count - 1 ? "ranged" : "swarmer";
    const a = (i / count) * Math.PI * 2 + nextFloat(state.rng) * 0.5;
    const d = 1.5 + nextFloat(state.rng) * 1.5;
    let pos = { x: boss.pos.x + Math.cos(a) * d, y: boss.pos.y + Math.sin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: boss.pos.x, y: boss.pos.y };
    const add = makeMonster(state, kind, pos);
    add.xp = 1;
    state.monsters.push(add);
    hit(state, add.pos, 0, "weapon"); // arrival poof for the juice layer
  }
  announce(state, "boss", "The boss calls for BACKUP. The union rules here are grim.");
}

// ---- Band-boss signature mechanics (dispatched from the boss branch in ai.ts).
// Each band-end arena carries exactly ONE of these, themed to its band. All of
// them telegraph: armed pools, ringed impact circles, an interruptible channel.

/** First use of a signature announces it once (normal priority — the visual
 * telegraph carries repeats); later casts run on spectacle alone. */
function announceSignature(state: GameState, m: Monster, line: string): void {
  if (m.sigUsed) return;
  m.sigUsed = true;
  announce(state, "boss", line);
}

/**
 * GRAVE RISING (floor 3, THE UNDERCROFT): the crypt boss drags every fresh
 * corpse in reach back to its feet as a weakened add. Resolves from a "raise"
 * windup committed in ai.ts — stagger it mid-channel and nothing gets up.
 */
export function bossGraveRaise(state: GameState, m: Monster): void {
  const reachable = state.corpses
    .filter((c) => dist(m.pos, c.pos) <= CONFIG.graveRaiseRange)
    .sort((a, b) => b.t - a.t) // freshest first — same taste as the necromancer
    .slice(0, CONFIG.graveRaiseCount);
  if (reachable.length === 0) return; // every corpse faded mid-channel — whiffed
  for (const corpse of reachable) {
    state.corpses.splice(state.corpses.indexOf(corpse), 1);
    const raised = makeMonster(state, corpse.kind, corpse.pos);
    raised.hp = raised.maxHp = Math.max(1, Math.round(raised.maxHp * CONFIG.necroRaisedHpMult));
    raised.xp = CONFIG.necroRaisedXp;
    state.monsters.push(raised);
    hit(state, raised.pos, 0, "weapon"); // a poof per riser for the juice layer
  }
  announce(state, "boss", `${m.eliteName ?? "The boss"} raises the fallen. Check-out time was never on the books.`);
}

/**
 * FLOOD SURGE (floor 6, THE SEWERS): sludge pools blanket a seeded HALF of the
 * arena. Each pool ARMS for floodTelegraph seconds (visible, harmless), then
 * ticks like acid until it drains — reposition to the dry half.
 */
export function bossFloodSurge(state: GameState, m: Monster): void {
  const { map, rng } = state;
  // The arena is the room the boss stands in (fall back to a rect around it).
  const room = map.rooms.find(
    (r) => m.pos.x >= r.x && m.pos.x < r.x + r.w && m.pos.y >= r.y && m.pos.y < r.y + r.h,
  ) ?? { x: m.pos.x - 8, y: m.pos.y - 8, w: 16, h: 16 };
  const vertical = nextInt(rng, 0, 1) === 0; // split axis
  const side = nextInt(rng, 0, 1); // which half floods
  for (let i = 0; i < CONFIG.floodPools; i++) {
    const fx = vertical
      ? room.x + (side * room.w) / 2 + nextFloat(rng) * (room.w / 2)
      : room.x + nextFloat(rng) * room.w;
    const fy = vertical
      ? room.y + nextFloat(rng) * room.h
      : room.y + (side * room.h) / 2 + nextFloat(rng) * (room.h / 2);
    if (!isWalkable(map, fx, fy)) continue;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: fx, y: fy },
      t: CONFIG.floodTelegraph + CONFIG.floodDuration,
      total: CONFIG.floodTelegraph + CONFIG.floodDuration,
      arm: CONFIG.floodTelegraph,
      radius: CONFIG.floodPoolRadius,
      damage: m.damage * CONFIG.floodDmgMult,
      kind: "sludge",
      tick: 0, // first tick bites the moment the pool goes live
    });
  }
  announceSignature(state, m, "THE SLUICES OPEN! Half this arena is about to be soup. Find the dry side, Crawlers.");
}

/**
 * ENTANGLING ROOTS (floor 9, THE GARDEN): root zones bloom under each crawler
 * (plus seeded extras). They arm, then SNARE — a heavy slow, no damage — for
 * as long as you stand in them. Dashing out is the escape.
 */
export function bossRootGrasp(state: GameState, m: Monster): void {
  const { rng } = state;
  const spots: Vec2[] = [];
  for (const p of state.players) {
    if (p.alive && dist(m.pos, p.pos) <= CONFIG.monsterAggroRange * 2.5) {
      spots.push({ x: p.pos.x, y: p.pos.y });
    }
  }
  const anchors = spots.length > 0 ? [...spots] : [{ x: m.pos.x, y: m.pos.y }];
  for (let i = 0; i < CONFIG.rootsExtra; i++) {
    const around = anchors[nextInt(rng, 0, anchors.length - 1)];
    const a = nextFloat(rng) * Math.PI * 2;
    const d = 1.5 + nextFloat(rng) * 2.5;
    spots.push({ x: around.x + Math.cos(a) * d, y: around.y + Math.sin(a) * d });
  }
  for (const pos of spots) {
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    state.hazards.push({
      id: state.nextEntityId++,
      pos,
      t: CONFIG.rootsTelegraph + CONFIG.rootsDuration,
      total: CONFIG.rootsTelegraph + CONFIG.rootsDuration,
      arm: CONFIG.rootsTelegraph,
      radius: CONFIG.rootsRadius,
      damage: 0, // roots grip, they don't bite — the boss does the biting
      kind: "roots",
    });
  }
  announceSignature(state, m, "The garden is GRABBY. Roots incoming — keep those feet moving or lose them.");
}

/**
 * COLLAPSING MASONRY (floor 12, THE RUINS): telegraphed debris circles rain
 * all fight long — one on each crawler, the rest seeded across the arena.
 * Same blast grammar as hazard rain, but it never waits for a phase.
 */
export function bossDebrisRain(state: GameState, m: Monster): void {
  const { rng } = state;
  const targets: Vec2[] = [];
  for (const p of state.players) {
    if (p.alive && dist(m.pos, p.pos) <= CONFIG.monsterAggroRange * 2.5) {
      targets.push({ x: p.pos.x, y: p.pos.y });
    }
  }
  while (targets.length < CONFIG.debrisCount) {
    const a = nextFloat(rng) * Math.PI * 2;
    const d = 2 + nextFloat(rng) * 6;
    targets.push({ x: m.pos.x + Math.cos(a) * d, y: m.pos.y + Math.sin(a) * d });
  }
  for (const pos of targets) {
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    state.hazards.push({
      id: state.nextEntityId++,
      pos,
      t: CONFIG.debrisDelay,
      total: CONFIG.debrisDelay,
      radius: CONFIG.debrisRadius,
      damage: m.damage * CONFIG.debrisDmgMult,
      kind: "blast",
    });
  }
  announceSignature(state, m, "The ceiling is NEGOTIABLE. Masonry incoming — watch the circles, not the boss.");
}

/**
 * FLAME SWEEP (floor 15, THE IRONWORKS): a wall of fire advances row by row
 * toward the boss's target — each row telegraphs, then erupts a beat after
 * the one before it. The lane is the danger; pick a gap and commit.
 */
export function bossFlameSweep(state: GameState, m: Monster): void {
  const prey = nearestPlayer(state, m.pos);
  const raw = prey
    ? { x: prey.pos.x - m.pos.x, y: prey.pos.y - m.pos.y }
    : { x: 1, y: 0 };
  // Axis-snap the advance so the wall reads as clean rows, not a smear.
  const dir = Math.abs(raw.x) >= Math.abs(raw.y)
    ? { x: Math.sign(raw.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(raw.y) || 1 };
  const perp = { x: -dir.y, y: dir.x };
  for (let row = 0; row < CONFIG.flameRows; row++) {
    const cx = m.pos.x + dir.x * (1.5 + row * CONFIG.flameRowSpacing);
    const cy = m.pos.y + dir.y * (1.5 + row * CONFIG.flameRowSpacing);
    const delay = CONFIG.flameTelegraph + row * CONFIG.flameStepDelay;
    for (let j = -CONFIG.flameHalfWidth; j <= CONFIG.flameHalfWidth; j++) {
      const pos = { x: cx + perp.x * j * CONFIG.flameSpacing, y: cy + perp.y * j * CONFIG.flameSpacing };
      if (!isWalkable(state.map, pos.x, pos.y)) continue;
      state.hazards.push({
        id: state.nextEntityId++,
        pos,
        t: delay,
        total: delay,
        radius: CONFIG.flameRadius,
        damage: m.damage * CONFIG.flameDmgMult,
        kind: "blast",
      });
    }
  }
  announceSignature(state, m, "THE FURNACE EXHALES. A wall of fire is coming through — pick a gap and COMMIT.");
}

/**
 * Push a dramatic line in the DCC "System" game-show voice (also logged).
 * `priority: "high"` marks the handful of headline moments (boss down, new
 * band, wipe) that hosts may present bigger than a toast.
 */
function announce(
  state: GameState, kind: AnnouncementKind, line: string,
  priority: Announcement["priority"] = "normal",
): void {
  state.announcements.push({ text: line, kind, priority });
  state.events.push(line);
}

function hit(
  state: GameState, pos: Vec2, amount: number, kind: HitEvent["kind"],
  extra?: { dir?: Vec2; killed?: boolean; school?: School; resisted?: boolean; effect?: StatusKind; to?: Vec2 },
): void {
  state.hits.push({
    pos: { x: pos.x, y: pos.y }, amount, kind,
    dir: extra?.dir, killed: extra?.killed, school: extra?.school, resisted: extra?.resisted,
    effect: extra?.effect, to: extra?.to ? { x: extra.to.x, y: extra.to.y } : undefined,
  });
}

/** Effective incoming-damage reduction from the player's armor (0..cap). */
export function playerMitigation(p: Player): number {
  return armorReduction(p.armor, CONFIG.armorK, CONFIG.armorMaxReduction);
}

/**
 * The single choke point for monster→player damage: roll (unless the caller
 * pre-rolled/capped), mitigate through armor, apply, emit the hit event and
 * low-HP hype. Death stays with the CALLER — every source has its own
 * announcer line. Returns true when the hit dropped them.
 * (The collapse timer bypasses this on purpose: the dungeon itself deals
 * fractional true damage no armor can argue with.)
 */
/**
 * Shove a player (MOB-CONCEPTS verb): queues a knockback that plays out over
 * the next steps at knockbackSpeed through moveWithCollision — walls stop it,
 * and being shoved INTO a hazard is the design, not a bug. Distances stack up
 * to one slam's worth so chain-shoves don't launch anyone across the floor.
 */
export function applyPlayerKnockback(p: Player, dir: Vec2, tiles: number): void {
  if (!p.alive || tiles <= 0 || (dir.x === 0 && dir.y === 0)) return;
  const d = normalize(dir);
  p.knock = { dir: d, left: Math.min(Math.max(p.knock?.left ?? 0, 0) + tiles, CONFIG.bossSlamKnockback) };
}

export function damagePlayerHit(
  state: GameState, p: Player, base: number,
  opts: { dir?: Vec2; roll?: boolean; effect?: StatusKind } = {},
): boolean {
  // Rivals revive grace: a crawler fresh off the timer is briefly untouchable.
  if ((p.reviveGraceT ?? 0) > 0) return false;
  const raw = opts.roll === false ? Math.max(1, Math.round(base)) : rollDamage(state.rng, base);
  const dmg = mitigate(raw, playerMitigation(p));
  p.hp -= dmg;
  p.damageTaken += dmg;
  // Plot Armor (chase legendary): once per floor, the season arc demands you
  // survive — a killing blow leaves you at 1 HP instead. The collapse timer
  // bypasses this whole function, so the dungeon itself still gets the kill.
  if (p.hp <= 0 && !p.plotArmorUsed && hasPassive(p, "plot_armor")) {
    p.plotArmorUsed = true;
    p.hp = 1;
    announce(state, "show", `${p.name} should be DEAD — but the writers disagree. PLOT ARMOR. The crowd is furious and delighted.`);
    addHype(state, p, CONFIG.show.hypeLowHpHit * 2);
  }
  // PRODUCER'S PET (class revision): once per floor, the production saves its
  // star in post — 1 HP and a brief untouchable camera cut (dash i-frames).
  if (p.hp <= 0 && !p.petUsed && hasRevision(p, "pet")) {
    p.petUsed = true;
    p.hp = 1;
    p.dashTime = Math.max(p.dashTime, CONFIG.revisionPetIframes);
    announce(state, "show", `${p.name} is SAVED IN POST. The producers protect their star. Once per floor.`);
    addHype(state, p, CONFIG.show.hypeLowHpHit * 2);
  }
  hit(state, p.pos, dmg, "player", { dir: opts.dir, killed: p.hp <= 0, effect: opts.effect });
  if (opts.effect) systemTip(state, p, "afflicted");
  if (p.hp > 0 && p.hp < p.maxHp * CONFIG.show.lowHpFraction) {
    addHype(state, p, CONFIG.show.hypeLowHpHit); // living dangerously = great television
    systemTip(state, p, "lowhp");
  }
  return p.hp <= 0;
}

/** Grant XP to one player (kill XP is split before calling this). */
function grantXp(state: GameState, p: Player, amount: number): void {
  p.xp += amount;
  const before = p.level;
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level++;
    p.xpToNext = xpForLevel(p.level);
    recomputeStats(p); // intrinsic stats scale with level
    p.hp = p.maxHp; // level-up fully heals
    p.upgradeDraftsOwed++; // each level opens an ability draft (queued if several)
  }
  // One line per XP grant, however many levels it crossed (boss XP jumps 2-3).
  if (p.level > before) {
    const jump = p.level - before > 1 ? ` (+${p.level - before} levels)` : "";
    announce(state, "levelup", `${p.name} hits LEVEL ${p.level}${jump}! The System offers an evolution.`);
  }
}

/** Split kill XP across living party members (no kill-stealing). */
function grantPartyXp(state: GameState, amount: number, killer?: Player): void {
  // Rivals sharing a floor are NOT a party: the killer keeps the whole bounty.
  if (state.mode === "rivals" && killer) {
    grantXp(state, killer, amount);
    return;
  }
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
  if (offer.overrank) {
    // A lottery rank past the printed max — rare enough to headline.
    announce(state, "levelup", `${p.name} seizes OVERRANK ${offer.title} ${offer.nextRank}! Power beyond System limits.`, "high");
    systemTip(state, p, "overrank");
    return;
  }
  const def = upgradeDef(offer.id);
  announce(state, "levelup", `${p.name}: ${offer.title} rank ${offer.nextRank}${def && offer.nextRank >= def.maxRank ? " (MAX)" : ""}. The System approves.`);
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
  announce(state, "levelup", `${p.name} learns ${info.name.toUpperCase()} — ${info.blurb}. ${where}. The crowd demands a demo.`);
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
  // TYPECAST (class revision): the billing is locked. THE FIVE are final.
  if (hasRevision(p, "typecast")) {
    state.events.push("TYPECAST: the System has locked your billing. THE FIVE are final.");
    return;
  }
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
  // TYPECAST (class revision): the billing is locked, ultimate included.
  if (hasRevision(p, "typecast")) {
    state.events.push("TYPECAST: the System has locked your billing. THE FIVE are final.");
    return;
  }
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
  const undiscovered = unknownAbilities(p, state.floor);
  const roll = nextInt(state.rng, 0, undiscovered.length > 0 ? 3 : 2);
  if (roll === 3) {
    const ability = undiscovered[nextInt(state.rng, 0, undiscovered.length - 1)];
    announce(state, "loot", `LOOT BOX #${state.lootBoxes}: a forbidden skill chip!`);
    learnAbility(state, p, ability);
  } else if (roll === 0) {
    const amt = nextInt(state.rng, 3, 6);
    // Permanent power buffs are school-agnostic (both ATK and MAG) so a loot
    // box never rolls dead for a build; gear stays the school differentiator.
    p.bonusDamage += amt;
    p.bonusSpell += amt;
    recomputeStats(p);
    announce(state, "loot", `LOOT BOX #${state.lootBoxes}: a wicked weapon mod! (+${amt} power)`);
  } else if (roll === 1) {
    const amt = nextInt(state.rng, 15, 30);
    p.bonusMaxHp += amt;
    recomputeStats(p);
    p.hp = Math.min(p.maxHp, p.hp + amt);
    announce(state, "loot", `LOOT BOX #${state.lootBoxes}: reinforced plating! (+${amt} max HP)`);
  } else {
    const amt = nextInt(state.rng, 25, 50);
    p.hp = Math.min(p.maxHp, p.hp + amt);
    announce(state, "loot", `LOOT BOX #${state.lootBoxes}: a health surge! (+${amt} HP)`);
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

/** Materialize a catalog entry as a real Item, floor-scaled. Shared by shop
 * purchases and component DROPS (random loot that advances a planned build). */
function makeCatalogItem(state: GameState, entry: CatalogEntry, floor: number): Item {
  return {
    id: state.nextEntityId++,
    slot: entry.slot!,
    rarity: TIER_RARITY[entry.tier as keyof typeof TIER_RARITY],
    name: entry.name,
    affixes: gearAffixes(entry, floor),
    passive: entry.passive,
    catalogId: entry.id,
  };
}

function dropLoot(state: GameState, pos: Vec2): void {
  const { rng, floor } = state;
  // Ability tomes: rare, and only while someone in the party has left to learn.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p, floor)))];
  if (undiscovered.length > 0 && chance(rng, CONFIG.tomeDropChance)) {
    const ability = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "tome", amount: 0, ability });
    announce(state, "loot", `An ABILITY TOME dropped! The System loves an upset.`);
  }
  if (chance(rng, CONFIG.goldDropChance)) {
    // Greed Clause (System Shrine): this floor's gold pays double.
    const surge = state.goldSurge ? CONFIG.shrineGreedGoldMult : 1;
    const amount = (nextInt(rng, CONFIG.goldMin, CONFIG.goldMax) + Math.floor(floor * CONFIG.goldPerFloor)) * surge;
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "gold", amount });
  }
  // Health potions no longer rain from chaff. Measured before removal: they
  // supplied 280-780 free HP per run (~a third of all damage taken absorbed),
  // and winners spent 0.0% of the run below 35% HP — health wasn't scary.
  // Healing is now a DECISION: field rations, sponsor gifts, level-ups, the
  // flask (returning), leech — all chosen, none ambient. lootDropChance was
  // rescaled (0.36 -> 0.22) when the potions' 40% share left, so gear and
  // component drop rates are unchanged.
  if (chance(rng, CONFIG.lootDropChance)) {
    const jitter = { x: pos.x + (nextFloat(rng) - 0.5) * 0.6, y: pos.y + (nextFloat(rng) - 0.5) * 0.6 };
    if (chance(rng, CONFIG.componentDropChance)) {
      // A catalog BASIC drops: it carries its catalogId, so it slots straight
      // into a build path — random loot in service of the plan, not instead of it.
      const basics = CATALOG.filter((e) => e.tier === "basic");
      const entry = basics[nextInt(rng, 0, basics.length - 1)];
      const item = makeCatalogItem(state, entry, floor);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    } else {
      // Equipment drop: a rolled item with a rarity + affixes.
      const item = generateItem(rng, floor, () => state.nextEntityId++);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    }
  }
}

/** The school a monster resists (takes resistDamageTakenMult on), if any:
 * the elite affix wins, else the archetype's innate tag (charger/phantom). */
export function monsterResist(m: Monster): School | null {
  if (m.affix === "armored") return "physical";
  if (m.affix === "warded") return "magic";
  const a: MonsterArchetype = ARCHETYPES[m.kind]; // widen past the as-const literal
  return a.resist ?? null;
}

/**
 * Damage a monster with a player's roll (shared crit/credit path). Beyond the
 * HP: hits SHOVE the target (`knockback` tiles / archetype mass, along `dir`)
 * and build poise damage — crossing maxHp * archetype poise staggers the
 * monster, interrupting any windup in progress. That interrupt is the reward
 * for answering a telegraph with damage instead of a dodge.
 */
export function damageMonster(
  state: GameState, p: Player, m: Monster, base: number,
  opts: {
    allowCrit?: boolean; forceCrit?: boolean; shatterPoise?: boolean;
    poiseMult?: number; school?: School; dir?: Vec2; knockback?: number;
    chained?: boolean; // a conduit arc — never arcs again (no chains of chains)
    effect?: StatusKind; // a DoT tick — hosts tint the number per effect
  } = {},
): void {
  // Signature Choreography: the post-swap surge window carries bonus crit.
  // Dead Eye (Bullet Time fork): inside the slow, everything is a headshot window.
  const critBonus =
    (p.stanceSwapWindow > 0 && hasPassive(p, "choreography") ? CONFIG.choreographyCritBonus : 0) +
    (state.bulletTimeLeft > 0 ? bulletTimeParams(p).critBonus : 0);
  const isCrit = opts.forceCrit === true || ((opts.allowCrit ?? true) && chance(state.rng, p.critChance + critBonus));
  // CLASS REVISIONS: CANCELED's first strike (nobody sees a dead crawler
  // coming) and THE UNDERDOG's desperation bonus scale the incoming base.
  if (hasRevision(p, "canceled") && m.hp >= m.maxHp) base *= CONFIG.revisionCanceledFirstStrike;
  if (hasRevision(p, "underdog") && p.hp < p.maxHp * CONFIG.revisionUnderdogThreshold) base *= CONFIG.revisionUnderdogDamage;
  let dmg = rollDamage(state.rng, base, damageVariance(p)); // the WEAPON sets the dice
  if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
  if (m.affix === "shielded") dmg = Math.max(1, Math.round(dmg * CONFIG.shieldedDamageTakenMult));
  // School resists (5.8 phase 3): armored shrugs physical, warded shrugs magic
  // — from the elite affix roll or the archetype's innate tag. The party's
  // damage MIX is the counterplay, so the reduction reads loud (dim numbers).
  const resisted = monsterResist(m) === (opts.school ?? "physical");
  if (resisted) dmg = Math.max(1, Math.round(dmg * CONFIG.resistDamageTakenMult));
  // One-shot insurance: named menaces never lose more than a capped fraction
  // of their pool to a single hit — a boss fight is a FIGHT, not a screenshot.
  if (m.kind === "boss") dmg = Math.min(dmg, Math.max(1, Math.round(m.maxHp * CONFIG.bossHitCapFraction)));
  else if (m.elite) dmg = Math.min(dmg, Math.max(1, Math.round(m.maxHp * CONFIG.eliteHitCapFraction)));
  // Cancellation Notice (chase legendary): a non-elite this hit would leave in
  // execute range is simply CANCELED — chaff cleanup for heavy, slow builds.
  if (
    dmg < m.hp && m.hp - dmg <= m.maxHp * CONFIG.cancellationThreshold &&
    !m.elite && m.kind !== "boss" && hasPassive(p, "cancellation")
  ) {
    dmg = m.hp;
  }
  m.hp -= dmg;
  m.hitFlash = 0.12;
  m.lastHitBy = p.id;
  if (m.dormant) springAmbush(state, m); // shooting an ambusher springs the whole trap
  // Repo Rat: every HP quarter beaten out of it SPILLS a coin of its carry —
  // the chase pays out as it runs, and the kill drops whatever's left.
  if (m.kind === "filcher" && (m.carry ?? 0) > 0) {
    while ((m.bleedStage ?? 0) > 0 && m.hp <= m.maxHp * ((m.bleedStage ?? 0) / 4)) {
      m.bleedStage = (m.bleedStage ?? 0) - 1;
      const coin = Math.max(1, Math.round((m.carry ?? 0) * CONFIG.filcherBleedFraction));
      m.carry = Math.max(0, (m.carry ?? 0) - coin);
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "gold", amount: coin });
    }
  }
  const a = ARCHETYPES[m.kind];
  const eliteMult = m.elite ? CONFIG.elitePoiseMult : 1;
  if (m.hp > 0) {
    m.poiseDmg += dmg * (opts.poiseMult ?? 1); // heavy weapons stagger harder
    // SYSTEM SHOCK (overcharge capstone): the hit itself is a poise break.
    if ((opts.shatterPoise && m.kind !== "boss") || m.poiseDmg >= m.maxHp * a.poise * eliteMult) {
      m.poiseDmg = 0;
      m.stagger = CONFIG.staggerDuration;
      systemTip(state, p, "stagger");
      m.windup = 0; // interrupted — the committed attack never lands
      m.windupKind = undefined;
      m.chargeT = 0; // a poise break also stops a rush cold
      m.chargeDir = undefined;
    }
    if (opts.dir && opts.knockback) {
      moveWithCollision(state.map, m.pos, opts.dir, opts.knockback / (a.mass * eliteMult), isWalkable);
    }
  }
  hit(state, m.pos, dmg, isCrit ? "crit" : "enemy", {
    dir: opts.dir, killed: m.hp <= 0, school: opts.school, resisted: resisted || undefined,
    effect: opts.effect,
  });
  p.damageDealt += dmg;
  if (isCrit) addHype(state, p, CONFIG.show.hypeCrit);
  // Venom Clause (chase legendary): crits inject a poison stack — the DoT
  // ticks back through this same choke point, so resists/caps keep applying.
  if (isCrit && m.hp > 0 && hasPassive(p, "venom")) {
    applyStatus(m, {
      kind: "poison", duration: CONFIG.poisonDuration, school: "physical",
      magnitude: Math.max(1, Math.round(dmg * CONFIG.venomTickFraction)), sourceId: p.id,
    });
  }
  // Blood Subscription (chase legendary): heal a slice of the damage you deal,
  // capped per hit so ultimates don't refill the bar in one cast. Small drains
  // (orbit ticks) heal silently; only meaningful sips emit a number.
  if (p.alive && p.hp < p.maxHp && hasPassive(p, "leech")) {
    const heal = Math.min(
      Math.round(dmg * CONFIG.leechFraction),
      Math.max(1, Math.round(p.maxHp * CONFIG.leechCapFraction)),
    );
    if (heal > 0) {
      p.hp = Math.min(p.maxHp, p.hp + heal);
      if (heal >= 3) hit(state, p.pos, heal, "heal");
    }
  }
  // Live Feed (chase legendary): crits ARC to the nearest other enemy as a
  // magic-school echo. One bounce only — an arc never arcs again.
  if (isCrit && !opts.chained && hasPassive(p, "conduit")) {
    let target: Monster | null = null;
    let bestD: number = CONFIG.conduitRadius;
    for (const other of state.monsters) {
      if (other === m || other.hp <= 0) continue;
      const d = dist(m.pos, other.pos);
      if (d <= bestD) { bestD = d; target = other; }
    }
    if (target) {
      damageMonster(state, p, target, dmg * CONFIG.conduitFraction, {
        allowCrit: false, school: "magic", chained: true,
        dir: normalize({ x: target.pos.x - m.pos.x, y: target.pos.y - m.pos.y }),
      });
    }
  }
  // Thorns elites bite back: a slice of every hit returns to the attacker,
  // capped per hit so burst builds feel it without getting one-shot by it.
  if (m.affix === "thorns" && p.alive && dmg > 0) {
    const reflect = Math.min(
      Math.round(dmg * CONFIG.thornsReflectFraction),
      Math.max(1, Math.round(p.maxHp * CONFIG.thornsReflectCapFraction)),
    );
    if (damagePlayerHit(state, p, reflect, { roll: false })) {
      handlePlayerDeath(state, p, `${p.name} beat ${m.eliteName ?? "an elite"} to death with their own health bar. THORNS, folks.`);
    }
  }
}

/** Body radius (tiles) a hit check must respect: clipping a brute's shoulder
 * counts. Elites are rendered bigger, so their hitbox grows to match. */
export function bodyRadius(m: Monster): number {
  return ARCHETYPES[m.kind].radius * (m.elite ? CONFIG.eliteScale : 1);
}

/** True when `m` is inside a swing from `pos` along `facing`: reach extends by
 * the target's body radius, and the arc widens by its angular size — the
 * question is "does the sweep touch the BODY", not "is the center on the line". */
function inSwing(pos: Vec2, facing: Vec2, m: Monster, range: number, arc: number): boolean {
  const toMon = { x: m.pos.x - pos.x, y: m.pos.y - pos.y };
  const d = Math.hypot(toMon.x, toMon.y);
  const r = bodyRadius(m);
  if (d - r > range) return false;
  const halfArc = arc / 2 + Math.asin(Math.min(1, r / Math.max(d, r)));
  return angleBetween(facing, toMon) <= halfArc;
}

function doPlayerAttack(state: GameState, p: Player, aim: Vec2): void {
  const mp = meleeParams(p);
  let facing = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = facing;
  p.cd.melee = mp.cooldown * cdMult(p);
  p.attackSwing = 0.15;

  // The swing lunges a short step toward the aim — but never THROUGH a target
  // already in reach. Overshooting point-blank enemies (which puts them BEHIND
  // the swing arc) was the classic "that should have hit" melee whiff.
  let nearestAhead = Infinity;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    if (angleBetween(facing, toMon) > Math.PI / 2) continue; // behind the swing
    const edge = Math.hypot(toMon.x, toMon.y) - bodyRadius(m);
    if (edge < nearestAhead) nearestAhead = edge;
  }
  const lunge = Math.min(CONFIG.meleeLungeDistance, Math.max(0, nearestAhead - 0.55));
  if (lunge > 0) moveWithCollision(state.map, p.pos, facing, lunge, isWalkable);

  // Aim assist: if the swing as aimed would hit nothing but SOMETHING is in
  // arm's reach, snap the swing to the nearest such target — at melee range
  // the player's intent is "hit the thing next to me", not the exact cursor.
  const wouldHit = state.monsters.some(
    (m) => m.hp > 0 && inSwing(p.pos, facing, m, mp.range, mp.arc),
  );
  if (!wouldHit) {
    let snap: Monster | null = null;
    let snapD = Infinity;
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      const edge = dist(p.pos, m.pos) - bodyRadius(m);
      if (edge <= mp.range && edge < snapD) { snapD = edge; snap = m; }
    }
    if (snap) {
      facing = normalize({ x: snap.pos.x - p.pos.x, y: snap.pos.y - p.pos.y });
      p.facing = facing;
    }
  }

  // MOMENTUM (stance capstone) and Overcharge both spend only on a swing that
  // actually connects — whiffing into empty air doesn't waste the setup.
  const momentum = p.stanceCritReady && p.stance === "melee";
  const oc = p.overcharged ? overchargeParams(p) : null;
  // Swift Strikes momentum: this swing rides the stacks the flurry already built.
  const swiftRank = rank(p, "melee.swift");
  const comboMult = 1 + p.meleeCombo * CONFIG.meleeMomentumPerStack;
  const heavySplash = rank(p, "melee.heavy") > 0;
  let connected = false;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    if (!inSwing(p.pos, facing, m, mp.range, mp.arc)) continue;
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    // EXECUTIONER capstone: finish the wounded.
    const execute = rank(p, "melee.execute") > 0 && m.hp < m.maxHp * 0.3 ? 1.6 : 1;
    const dmg = power(p, "melee") * mp.damageMult * execute * stanceMult(p, "melee") * (oc?.mult ?? 1) * comboMult;
    damageMonster(state, p, m, dmg, {
      dir: normalize(toMon), knockback: CONFIG.meleeKnockback, school: "physical",
      forceCrit: momentum, shatterPoise: oc?.shatter, poiseMult: mp.poiseMult,
    });
    // Echo Strike: the overcharged swing lands a second, softer hit.
    if (oc && oc.echoFrac > 0 && m.hp > 0) {
      damageMonster(state, p, m, dmg * oc.echoFrac, { dir: normalize(toMon), school: "physical" });
    }
    // Heavy Blows: a killing swing's OVERKILL splashes to everything nearby —
    // the big hit carries through the corpse.
    if (heavySplash && m.hp < 0) {
      const overkill = -m.hp;
      for (const other of state.monsters) {
        if (other === m || other.hp <= 0) continue;
        if (dist(m.pos, other.pos) > CONFIG.meleeOverkillRadius) continue;
        damageMonster(state, p, other, overkill, { allowCrit: false, school: "physical" });
      }
    }
    connected = true;
  }
  // STUNT DOUBLE: every double you own mirrors the swing from its own mark.
  for (const dc of state.decoys) {
    if (dc.ownerId !== p.id) continue;
    dc.facing = { x: facing.x, y: facing.y };
    const frac = stuntDoubleParams(p).mirrorFrac;
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      if (!inSwing(dc.pos, facing, m, mp.range, mp.arc)) continue;
      damageMonster(state, p, m, power(p, "melee") * mp.damageMult * frac, { allowCrit: false, school: "physical" });
    }
  }
  if (connected) {
    if (momentum) p.stanceCritReady = false;
    if (oc) p.overcharged = false;
    if (swiftRank > 0) {
      p.meleeCombo = Math.min(swiftRank * CONFIG.meleeMomentumStacksPerRank, p.meleeCombo + 1);
      p.meleeComboT = CONFIG.meleeMomentumWindow;
    }
  }
  // RIVALS: the same swing arc also cuts rivals sharing this floor.
  for (const v of rivalTargets(state, p)) {
    const toV = { x: v.pos.x - p.pos.x, y: v.pos.y - p.pos.y };
    const edge = Math.hypot(toV.x, toV.y) - 0.35;
    if (edge > mp.range || angleBetween(facing, toV) > mp.arc / 2) continue;
    const dmg = power(p, "melee") * mp.damageMult * stanceMult(p, "melee") * (oc?.mult ?? 1) * comboMult;
    pvpStrike(state, p, v, dmg, normalize(toV));
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
  charger: CONFIG.show.hypeCharger,
  spitter: CONFIG.show.hypeSpitter,
  necromancer: CONFIG.show.hypeNecromancer,
  broodmother: CONFIG.show.hypeBroodmother,
  drummer: CONFIG.show.hypeDrummer,
  filcher: CONFIG.show.hypeFilcher,
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
    caught++;
    const away = dist(m.pos, p.pos) > 1e-4
      ? normalize({ x: p.pos.x - m.pos.x, y: p.pos.y - m.pos.y })
      : undefined;
    if (damagePlayerHit(state, p, base, { dir: away })) {
      handlePlayerDeath(state, p, `${p.name} was BLOWN APART by a bomber. Sponsors, roll the replay.`);
    }
  }
  if (caught > 0) announce(state, "flavor", "KABOOM! A bomber detonates point-blank. The crowd feels that one.");
  else announce(state, "flavor", "A bomber pops early — all bark, no bite. The System is disappointed.");
}

function reapDead(state: GameState): void {
  const survivors: Monster[] = [];
  const spawned: Monster[] = []; // splitter children (added after the sweep)
  let killsThisStep = 0;
  for (const m of state.monsters) {
    if (m.hp > 0) {
      survivors.push(m);
      continue;
    }
    // A Repo Rat that made it out isn't a kill — it's a segment. No corpse,
    // no XP, no loot; the payroll leaves the show with it.
    if (m.escaped) {
      announce(state, "show", `THE REPO RAT ESCAPES with ${m.carry ?? 0} gold of the System's petty cash. The accountants are FURIOUS. Great television.`);
      continue;
    }
    // Every fallen regular leaves a raisable corpse (necromancer fuel).
    if (m.kind !== "boss") {
      state.corpses.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: m.kind, t: CONFIG.corpseTtl });
      if (state.corpses.length > CONFIG.corpseMax) state.corpses.shift();
    }
    // A bomber shot down before reaching anyone still cooks off — half radius.
    if (m.kind === "bomber" && !m.exploded) explodeBomber(state, m, CONFIG.bomberDeathRadiusMult);
    // A caught Repo Rat spills the whole remaining purse.
    if (m.kind === "filcher" && (m.carry ?? 0) > 0) {
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "gold", amount: m.carry! });
      m.carry = 0;
    }
    state.killCount++;
    killsThisStep++;
    // Kill credit to the last hitter (loot box milestones + per-player achievements).
    const killer = state.players.find((pl) => pl.id === m.lastHitBy) ?? state.players[0];
    killer.kills++;
    killer.killsThisStep++;
    if (hasPassive(killer, "ledger")) killer.gold += CONFIG.ledgerKillGold; // Landlord's Ledger
    if (hasPassive(killer, "showrunner")) addHype(state, killer, 4); // Headliner
    // REPEAT OFFENDER: the marked target died inside the window; the camera resets.
    for (const pl of state.players) {
      if (pl.cutMark && pl.cutMark.monsterId === m.id) {
        pl.cutMark = null;
        pl.cd.cutto = 0;
      }
    }
    // EXTENSION (Bullet Time capstone): kills inside the slow stretch it out.
    if (state.bulletTimeLeft > 0 && bulletTimeParams(killer).encore) {
      state.bulletTimeLeft = Math.min(CONFIG.ultBulletTimeEncoreCap, state.bulletTimeLeft + CONFIG.ultBulletTimeEncoreExtend);
    }
    if (killer.alive && killer.hp > 0 && killer.hp < killer.maxHp * 0.1) killer.lowHpKill = true;
    addHype(state, killer, KILL_HYPE[m.kind]);
    // A posted bounty collected inside its window pays out, on camera.
    if ((m.bountyT ?? 0) > 0 && (m.bountyGold ?? 0) > 0) {
      killer.gold += m.bountyGold!;
      addHype(state, killer, CONFIG.interferenceBountyHype);
      announce(state, "show", `BOUNTY COLLECTED: ${killer.name} banks ${m.bountyGold} gold. The System considers it money well spent.`);
    }
    // Kills refill the flask (only while a charge is missing): aggression = sustain.
    if (CONFIG.flaskEnabled && killer.flaskCharges < CONFIG.flaskMaxCharges) {
      killer.flaskKillProgress++;
      if (killer.flaskKillProgress >= CONFIG.flaskKillsPerCharge) {
        killer.flaskKillProgress = 0;
        killer.flaskCharges++;
        state.events.push(`${killer.name}'s sponsors send a fresh Slurp™ (${killer.flaskCharges}/${CONFIG.flaskMaxCharges}).`);
      }
    }
    // Volatile elites cook off after death — a telegraphed corpse blast.
    if (m.affix === "volatile") {
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        t: CONFIG.volatileDelay,
        total: CONFIG.volatileDelay,
        radius: CONFIG.volatileRadius,
        damage: m.damage * CONFIG.volatileDmgMult,
      });
      announce(state, "boss", `${m.eliteName ?? "The elite"} is COOKING OFF. Clear the corpse!`);
    }
    // Splitter elites burst into a swarm — the fight isn't over, it multiplied.
    if (m.affix === "splitter") {
      for (let i = 0; i < CONFIG.splitterCount; i++) {
        const a = nextFloat(state.rng) * Math.PI * 2;
        const child = makeMonster(state, "swarmer", {
          x: m.pos.x + Math.cos(a) * 0.6, y: m.pos.y + Math.sin(a) * 0.6,
        });
        child.xp = 1; // the payout was the elite, not the confetti
        spawned.push(child);
        hit(state, child.pos, 0, "weapon"); // a poof per child for the juice layer
      }
      announce(state, "boss", `${m.eliteName ?? "The elite"} SPLITS APART. It's never just one.`);
    }
    grantPartyXp(state, m.xp, killer);
    if (m.hasKey) {
      // The key carrier ALWAYS drops the stairs-district key.
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "key", amount: 0 });
      announce(state, "progress", "The KEYHOLDER is down! That shiny thing it dropped? Take it.");
    }
    dropLoot(state, m.pos);
    if (state.killCount % CONFIG.lootBoxEveryKills === 0) awardLootBox(state, killer);
    // Named menaces shower guaranteed rewards (incl. crafting materials).
    if (m.elite) {
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "material", amount: 1, material: "elite_trophy" });
      dropBossBonus(state, m.pos, 1);
      addHype(state, killer, CONFIG.show.hypeBrute);
      announce(state, "boss", `${m.eliteName} is DOWN. The neighborhood breathes easier. ${killer.name} takes the credit.`);
    }
    if (m.kind === "boss") {
      if (state.floor >= CONFIG.finalFloor) {
        state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "material", amount: 1, material: "boss_sigil" });
        state.status = "won";
        if (state.mode === "rivals") {
          // The RACE: whoever lands the killing blow takes the whole season.
          state.winnerId = killer.id;
          announce(state, "boss", `CONTRACT SECURED: ${killer.name} killed the boss FIRST. One winner. One renewal. That's showbiz.`, "high");
        } else {
          announce(state, "boss", "THE FLOOR BOSS IS DOWN. You beat the dungeon. LEGENDARY, Crawlers.", "high");
        }
      } else {
        state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "material", amount: 1, material: "boss_sigil" });
        dropBossBonus(state, m.pos, 2);
        addHype(state, killer, CONFIG.show.hypeBoss);
        announce(state, "boss", `CITY BOSS ${m.eliteName ?? ""} DEFEATED! The exit is OPEN. Sponsors are weeping with joy.`, "high");
      }
    }
  }
  // Multi-kill combos are a crowd-pleaser (credited to whoever comboed).
  for (const pl of state.players) {
    if (pl.killsThisStep > 1) {
      addHype(state, pl, (pl.killsThisStep - 1) * CONFIG.show.hypeMultiKillPerExtra);
      if (pl.killsThisStep >= 3) announce(state, "show", `${pl.killsThisStep}-KILL COMBO by ${pl.name}! The crowd is on its feet.`);
    }
  }
  state.killsThisStep = killsThisStep;
  state.monsters = spawned.length > 0 ? survivors.concat(spawned) : survivors;
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
      case "gold": {
        // CORPORATE SELLOUT: the network deducts its cut at pickup.
        const take = hasRevision(p, "sellout")
          ? Math.max(1, Math.round(l.amount * CONFIG.revisionSelloutGoldMult))
          : l.amount;
        p.gold += take;
        hit(state, p.pos, take, "gold");
        break;
      }
      case "heal":
        p.hp = Math.min(p.maxHp, p.hp + l.amount);
        hit(state, p.pos, l.amount, "heal");
        state.events.push(`Picked up a health kit (+${l.amount}).`);
        break;
      case "key": {
        unlockDoors(state);
        announce(state, "progress", `${p.name} has the key! The stairs district is OPEN.`);
        addHype(state, p, 12);
        hit(state, p.pos, 0, "weapon");
        break;
      }
      case "material": {
        if (l.material) {
          p.materials[l.material] = (p.materials[l.material] ?? 0) + l.amount;
          state.events.push(`${p.name} picked up ${l.amount}x ${l.material.replace("_", " ")}.`);
          hit(state, p.pos, 0, "weapon");
        }
        break;
      }
      case "shrine": {
        // A bargain, not a pickup: consumed only when the crawler is free to
        // choose (never clobbers a pending sponsor draft — walk by, come back).
        if (p.pendingRewards.length > 0) {
          remaining.push(l);
          break;
        }
        p.pendingRewards = shrineChoices(state, p);
        announce(state, "show", `SYSTEM SHRINE: the System offers ${p.name} a deal. Read the fine print.`);
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
          if (item.rarity === "epic") {
            announce(state, "loot", `EPIC DROP: ${item.name}! Equipped. The crowd loses it.`);
          } else {
            // Rare-and-below equips already have pickup feedback; log only.
            state.events.push(`Equipped ${item.name} (${item.rarity}).`);
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
      announce(state, "progress", "The floor is COLLAPSING, Crawler. Descend, or become a statistic.", "high");
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
      announce(state, "progress", "The floor is destabilizing. The clock is your enemy now.");
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
    announce(state, "progress", `FLOOR ${CONFIG.finalFloor} CLEARED. You escaped the dungeon. LEGENDARY.`, "high");
    return;
  }
  if (state.phase === "collapse") state.escapedCollapse = true;
  const next = state.floor + 1;
  // Descent routes through a safe room: the sim pauses while the crawler shops;
  // leaveSafeRoom() performs the actual floor change (and opens the sponsor draft).
  state.safeRoom = generateSafeRoom(state, next);
  announce(state, "progress", `Safe room reached. Breathe, spend, gear up — floor ${next} is waiting.`);
  // Landlord's Ledger: banked gold pays INTEREST at every safe room (capped)
  // — the greed build's engine: sell everything, buy nothing, watch it grow.
  for (const pl of state.players) {
    if (!hasPassive(pl, "ledger") || pl.gold <= 0) continue;
    const interest = Math.min(
      Math.round(pl.gold * CONFIG.ledgerInterestFraction),
      CONFIG.ledgerInterestCap,
    );
    if (interest > 0) {
      pl.gold += interest;
      announce(state, "show", `${pl.name}'s Ledger pays out: +${interest} gold in interest. The rent collects itself.`);
    }
  }
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

/**
 * Roll the System Shop shelf for the floor ahead. Seeded per (run, floor):
 * reproducible. Consumables/starter/basic are always stocked; advanced and
 * legendary tiers unlock as the run deepens and each shop carries a seeded,
 * growing SUBSET — what's missing today is what the ALL ITEMS view plans around.
 */
function generateSafeRoom(state: GameState, nextFloor: number): SafeRoom {
  const rng = createRng((floorSeed(state.seed, nextFloor) ^ 0x5a4e0000) >>> 0);
  const shopIndex = nextFloor - 1; // shop #1 sits after floor 1
  const available: string[] = [];
  for (const tier of ["consumable", "starter", "basic", "advanced", "legendary"] as const) {
    const pool = CATALOG.filter((e) => e.tier === tier);
    const n = tierStockCount(tier, shopIndex);
    if (n <= 0) continue;
    const picks = n >= pool.length ? pool : shuffle(rng, pool).slice(0, n);
    // Catalog order keeps the shelf layout stable shop to shop.
    available.push(...CATALOG.filter((e) => picks.includes(e)).map((e) => e.id));
  }
  // Today's tome teaches ONE seeded ability someone still lacks; no tome once
  // the party knows everything.
  // The NEXT floor's shop: gate ultimate tomes by the floor being entered.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p, nextFloor)))];
  let tomeAbility: SafeRoom["tomeAbility"];
  if (undiscovered.length > 0) {
    tomeAbility = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
  } else {
    const t = available.indexOf("tome");
    if (t >= 0) available.splice(t, 1);
  }
  return { nextFloor, available, tomeAbility, tip: safeRoomTip(rng, nextFloor), ready: [], purchased: {} };
}

/**
 * Find an owned, unclaimed component with this catalog id: bag first, then
 * equipped gear (buying an upgrade OF your equipped item is the core loop).
 */
function findOwnedComponent(p: Player, catalogId: string, claimed: Set<Item>): Item | null {
  for (const it of p.inventory) if (it.catalogId === catalogId && !claimed.has(it)) return it;
  for (const slot of EQUIP_SLOTS) {
    const it = p.equipment[slot];
    if (it && it.catalogId === catalogId && !claimed.has(it)) return it;
  }
  return null;
}

/**
 * Claim components for one required id: consume an owned copy (crediting its
 * FULL price, LoL-style), else recurse so owned grandchildren still count.
 * Returns the gold credited by everything claimed.
 */
function claimComponents(p: Player, catalogId: string, claimed: Set<Item>): number {
  const owned = findOwnedComponent(p, catalogId, claimed);
  if (owned) {
    claimed.add(owned);
    return totalCost(catalogId);
  }
  let credit = 0;
  for (const sub of CATALOG_BY_ID[catalogId]?.buildsFrom ?? []) {
    credit += claimComponents(p, sub, claimed);
  }
  return credit;
}

/**
 * Direct components (with multiplicity) the player still lacks for a build.
 * Purchases of built gear are GATED on this being empty: the build tree is a
 * path you walk, not a price sheet — assembling the pieces shop-to-shop is
 * the intended rhythm. Exported for the shop UI's lock reason.
 */
export function missingComponents(p: Player, catalogId: string): string[] {
  const need = CATALOG_BY_ID[catalogId]?.buildsFrom ?? [];
  if (need.length === 0) return [];
  const owned: Record<string, number> = {};
  const count = (it: Item | null) => {
    if (it?.catalogId) owned[it.catalogId] = (owned[it.catalogId] ?? 0) + 1;
  };
  for (const it of p.inventory) count(it);
  for (const slot of EQUIP_SLOTS) count(p.equipment[slot]);
  const missing: string[] = [];
  for (const c of need) {
    if ((owned[c] ?? 0) > 0) owned[c]--;
    else missing.push(c);
  }
  return missing;
}

/** What a player would pay for a catalog entry right now (component-discounted). */
export function effectivePrice(p: Player, catalogId: string, nextFloor: number): number {
  const entry = CATALOG_BY_ID[catalogId];
  if (!entry) return 0;
  if (entry.tier === "consumable") return consumablePrice(entry, nextFloor);
  const claimed = new Set<Item>();
  let credit = 0;
  for (const c of entry.buildsFrom ?? []) credit += claimComponents(p, c, claimed);
  return Math.max(0, totalCost(catalogId) - credit);
}

/**
 * Buy a catalog entry from the System Shop. Gear consumes owned build-path
 * components (bag or equipped) and charges the difference; legendaries also
 * spend materials and demand sponsor backing. No-op when unaffordable,
 * ungated, or off today's shelf — the UI communicates why.
 */
export function buyCatalogItem(state: GameState, playerId: number, catalogId: string): void {
  const p = state.players.find((pl) => pl.id === playerId);
  const room = p ? shopRoomFor(state, p) : null;
  const entry = CATALOG_BY_ID[catalogId];
  if (!room || !p || !entry || !room.available.includes(catalogId)) return;

  if (entry.tier === "consumable") {
    // Scarcity: each consumable has a limited per-shop stock (excess gold can no
    // longer buy an unbounded HP graft — that was the maximalist EHP leak).
    if ((room.purchased[catalogId] ?? 0) >= consumableStock(entry)) return;
    const price = consumablePrice(entry, room.nextFloor);
    if (p.gold < price) return;
    if (entry.effect === "tome" && (!room.tomeAbility || knows(p, room.tomeAbility))) return;
    p.gold -= price;
    p.goldSpent += price;
    room.purchased[catalogId] = (room.purchased[catalogId] ?? 0) + 1;
    switch (entry.effect) {
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
      case "mystery":
        awardLootBox(state, p);
        break;
      case "tome":
        learnAbility(state, p, room.tomeAbility);
        break;
      case "favor":
        p.upgradeDraftsOwed++;
        announce(state, "show", `${p.name} calls in a SYSTEM FAVOR. An upgrade draft is owed.`);
        break;
    }
    state.events.push(`${p.name} bought ${entry.name} (-${price} gold).`);
    checkAchievements(state);
    return;
  }

  // Gear: built items REQUIRE their components in hand (see missingComponents);
  // then price the build path and gate on gold + sponsors + materials.
  if (missingComponents(p, catalogId).length > 0) return;
  const claimed = new Set<Item>();
  let credit = 0;
  for (const c of entry.buildsFrom ?? []) credit += claimComponents(p, c, claimed);
  const price = Math.max(0, totalCost(catalogId) - credit);
  if (p.gold < price) return;
  if ((entry.sponsors ?? 0) > p.sponsors) return;
  const mats = entry.materials ?? {};
  for (const [m, n] of Object.entries(mats)) {
    if (p.materials[m as MaterialId] < (n ?? 0)) return;
  }

  p.gold -= price;
  p.goldSpent += price;
  for (const [m, n] of Object.entries(mats)) p.materials[m as MaterialId] -= n ?? 0;
  // Consume claimed components wherever they live.
  p.inventory = p.inventory.filter((it) => !claimed.has(it));
  for (const slot of EQUIP_SLOTS) {
    if (p.equipment[slot] && claimed.has(p.equipment[slot]!)) p.equipment[slot] = null;
  }
  const item = makeCatalogItem(state, entry, room.nextFloor);
  const cur = p.equipment[item.slot];
  if (!cur || itemScore(item) > itemScore(cur)) equipItem(p, item);
  else p.inventory.push(item);
  recomputeStats(p);
  if (entry.tier === "legendary") {
    announce(state, "loot", `SIGNATURE GEAR: ${p.name} claims ${entry.name}. ${entry.desc} The sponsors sign off — this one gets a product page.`);
    addHype(state, p, CONFIG.show.hypeEpicDrop);
  } else {
    state.events.push(`${p.name} bought ${entry.name} (-${price} gold).`);
  }
  // The sim idles in the safe room, so purchase-driven unlocks fire here.
  checkAchievements(state);
}

/** Sell value: 60% of a catalog item's full price; flat by rarity for drops. */
export function sellValue(item: Item): number {
  if (item.catalogId) return Math.round(totalCost(item.catalogId) * 0.6);
  return { common: 10, magic: 25, rare: 50, epic: 100 }[item.rarity];
}

/** Sell a BAG item back to the System Shop. Equipped gear is safe. */
export function sellItem(state: GameState, playerId: number, bagIdx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || !shopRoomFor(state, p)) return;
  if (bagIdx < 0 || bagIdx >= p.inventory.length) return;
  const item = p.inventory.splice(bagIdx, 1)[0];
  const value = sellValue(item);
  p.gold += value;
  state.events.push(`${p.name} sold ${item.name} (+${value} gold).`);
}

/** Sell the WHOLE bag back to the System Shop (equipped gear is safe). */
export function sellAllItems(state: GameState, playerId: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || !shopRoomFor(state, p) || p.inventory.length === 0) return;
  const n = p.inventory.length;
  let total = 0;
  for (const item of p.inventory) total += sellValue(item);
  p.inventory = [];
  p.gold += total;
  state.events.push(`${p.name} liquidated the bag: ${n} item${n === 1 ? "" : "s"}, +${total} gold.`);
}

/** Mark a player ready to descend; the party leaves when everyone is ready. */
/** The shop this player is currently standing in: personal in rivals, shared in co-op. */
export function shopRoomFor(state: GameState, p: Player): SafeRoom | null {
  return state.mode === "rivals" ? p.safeRoom ?? null : state.safeRoom;
}

export function setReady(state: GameState, playerId: number): void {
  if (state.mode === "rivals") {
    // Personal shop: READY means leave NOW — nobody waits for anybody.
    const p = state.players.find((pl) => pl.id === playerId);
    if (p?.safeRoom) leaveRivalSafeRoom(state, p);
    return;
  }
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
  announce(state, "progress", `Descending to floor ${room.nextFloor}. The cameras are rolling, Crawlers.`);
  buildFloor(state, room.nextFloor);
  if (room.bonusTime) {
    state.timeBudget += room.bonusTime;
    state.timeRemaining += room.bonusTime;
  }
  // Between floors, sponsors gift each crawler individually (non-blocking).
  // Milestone floors override the gifts: the System offers a CLASS REVISION.
  const milestone = (CONFIG.revisionFloors as readonly number[]).includes(room.nextFloor);
  let any = false;
  for (const p of state.players) {
    p.pendingRewards = milestone ? revisionChoices(state, p, room.nextFloor) : generateRewards(state, p.id);
    if (p.pendingRewards.length > 0) any = true;
  }
  if (any) {
    announce(state, "show", milestone
      ? "LEVEL MILESTONE. A CLASS REVISION is available. This offer will not be repeated. Choose wisely — statistically, you won't."
      : "Your sponsors have gifts. Choose, Crawlers.");
  }
}

/** The CLASS REVISION draft: the milestone pool plus REMAIN UNCAST. */
function revisionChoices(state: GameState, p: Player, arrivalFloor: number): Reward[] {
  const pool = revisionPool(arrivalFloor, CONFIG.revisionFloors as unknown as number[])
    .filter((id) => !hasRevision(p, id));
  if (pool.length === 0) return [];
  const cards: Reward[] = pool.map((id) => ({
    id: state.nextEntityId++, kind: "revision" as const,
    title: REVISIONS[id].title, desc: REVISIONS[id].desc, amount: 0, revisionId: id,
  }));
  cards.push({
    id: state.nextEntityId++, kind: "revisionDecline", title: "REMAIN UNCAST",
    desc: `Refuse the revision. The System notes the defiance: +${Math.round(CONFIG.revisionUncastHype * 100)}% hype gains, permanently`,
    amount: 0,
  });
  return cards;
}

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Diminishing-returns factor for a permanent stat gift: full value on a fresh
 * axis, tapering as the crawler stacks it (k/(k+owned)). This is what stops
 * "+damage every floor" from being the one true pick — see rewardDr*K. */
export function rewardDr(owned: number, k: number): number {
  return k / (k + Math.max(0, owned));
}

/** Gift kinds sponsors can roll — shrine bargains are built by shrineChoices only. */
type SponsorRewardKind = Exclude<Reward["kind"], "shrineBlood" | "shrineGreed" | "shrineDecline" | "revision" | "revisionDecline">;

/** Roll one sponsor gift of the given kind. `q` scales with backing; permanent
 * stat gifts additionally diminish against what `p` has already banked. */
function makeReward(state: GameState, rng: Rng, p: Player, kind: SponsorRewardKind, q: number): Reward {
  const floor = state.floor;
  const id = state.nextEntityId++;
  switch (kind) {
    case "healFull":
      return { id, kind, title: "Field Medic", desc: "Restore all HP", amount: 0 };
    case "maxHp": {
      const amt = Math.max(6, Math.round((18 + floor * 2) * q * rewardDr(p.bonusMaxHp, CONFIG.rewardDrMaxHpK)));
      return { id, kind, title: "Reinforced Frame", desc: `+${amt} max HP`, amount: amt };
    }
    case "damage": {
      const amt = Math.max(2, Math.round((5 + floor) * Math.min(q, 2) * rewardDr(p.bonusDamage, CONFIG.rewardDrDamageK)));
      return { id, kind, title: "Weapon Mod", desc: `+${amt} damage`, amount: amt };
    }
    case "crit": {
      const pct = Math.max(2, Math.round((4 + q * 2) * rewardDr(p.bonusCrit * 100, CONFIG.rewardDrCritK)));
      return { id, kind, title: "Targeting Chip", desc: `+${pct}% crit`, amount: pct / 100 };
    }
    case "armor": {
      const amt = Math.max(3, Math.round((6 + floor * 1.5) * q * rewardDr(p.bonusArmor, CONFIG.rewardDrArmorK)));
      return { id, kind, title: "Ablative Weave", desc: `+${amt} armor`, amount: amt };
    }
    case "gold": {
      const amt = Math.round((40 + floor * 12) * q);
      return { id, kind, title: "Cash Injection", desc: `+${amt} gold`, amount: amt };
    }
    case "bonusTime": {
      const amt = Math.round(10 + q * 5);
      return { id, kind, title: "Stabilizer", desc: `+${amt}s on this floor`, amount: amt };
    }
    case "materials": {
      // Progress toward SIGNATURE gear — a build-defining pull that never
      // concentrates a stat. Deeper floors owe the rarer boss sigil.
      const mat: MaterialId = floor >= 10 && chance(rng, 0.5) ? "boss_sigil" : "elite_trophy";
      const label = mat === "boss_sigil" ? "Boss Sigil" : "Elite Trophy";
      return { id, kind, title: "Sponsor Bounty", desc: `+1 ${label} (signature crafting)`, amount: 1, material: mat };
    }
    case "favor": {
      // An owed constellation draft — advances the BUILD, self-limiting (nodes cap).
      return { id, kind, title: "System Favor", desc: "An extra ability-upgrade draft", amount: 1 };
    }
    case "retrain": {
      // A mid-run identity pivot: unlearn one fork side, get the ranks back
      // as drafts. Only rolled when a retrainable node exists (see pool).
      const nodes = retrainableNodes(p);
      if (nodes.length === 0) return { id, kind: "favor", title: "System Favor", desc: "An extra ability-upgrade draft", amount: 1 };
      const node = pick(rng, nodes);
      const ranks = p.abilities.ranks[node.id] ?? 0;
      const s = ranks === 1 ? "" : "s";
      return {
        id, kind, title: "Retraining Arc",
        desc: `Unlearn ${node.title} (${ranks} rank${s}) — ${ranks} fresh draft${s}`,
        amount: ranks, nodeId: node.id,
      };
    }
    case "item": {
      const item = generateItem(rng, floor + 2, () => state.nextEntityId++); // sponsor gear runs hot
      return { id, kind, title: item.name, desc: `${item.rarity} ${item.slot}`, amount: 0, item };
    }
  }
}

/**
 * Rank a candidate gift for this crawler: raw power on the itemScore scale
 * (damage 2 / hp 0.5 / crit 300), boosted up to 2x when the gift leans into
 * stats the build already invests in. Deterministic — used only to pick which
 * candidates survive an oversized draft.
 */
function rewardFitScore(p: Player, r: Reward): number {
  // Build affinity per axis: what fraction of the crawler's investment
  // (equipped affixes + permanent bonuses) sits on each stat.
  let dmg = (p.bonusDamage + p.bonusSpell) * 2;
  let hp = p.bonusMaxHp * 0.5;
  let crit = p.bonusCrit * 300;
  for (const it of Object.values(p.equipment)) {
    if (!it) continue;
    dmg += ((it.affixes.damage ?? 0) + (it.affixes.spell ?? 0)) * 2;
    hp += (it.affixes.maxHp ?? 0) * 0.5;
    crit += (it.affixes.crit ?? 0) * 300;
  }
  const total = dmg + hp + crit || 1;
  switch (r.kind) {
    case "damage":
      return r.amount * 2 * (1 + dmg / total);
    case "maxHp":
      return r.amount * 0.5 * (1 + hp / total);
    case "crit":
      return r.amount * 300 * (1 + crit / total);
    case "item": {
      const item = r.item!;
      const cur = p.equipment[item.slot];
      const gain = itemScore(item) - (cur ? itemScore(cur) : 0);
      return itemScore(item) + Math.max(0, gain); // actual upgrades count double
    }
    case "armor":
      return r.amount * 1.5; // EHP on the mitigation curve; not build-axis weighted
    case "healFull":
      return (p.maxHp - p.hp) * 0.5; // worth exactly what it would restore
    case "gold":
      return r.amount * 0.08;
    case "bonusTime":
      return r.amount * 1.5;
    case "materials":
      return 55; // steady pull toward signature gear (flat — it's build variety)
    case "favor":
      return 70; // a constellation rank is strong, but not always the pick
    case "retrain":
      return 60; // a build pivot: worth a slot, never the auto-pick
    case "shrineBlood":
    case "shrineGreed":
    case "shrineDecline":
    case "revision":
    case "revisionDecline":
      return 0; // shrine bargains and castings never enter the sponsor pool
  }
}

/** Fork-side nodes a Retraining Arc may refund: ranked, exclusive, and safe
 * to unlearn — nothing RANKED sits downstream (no orphaned capstones). */
function retrainableNodes(p: Player): UpgradeDef[] {
  return UPGRADES.filter((u) =>
    (u.excludes?.length ?? 0) > 0 &&
    (p.abilities.ranks[u.id] ?? 0) > 0 &&
    !UPGRADES.some((d) => (d.requires ?? []).includes(u.id) && (p.abilities.ranks[d.id] ?? 0) > 0),
  );
}

/**
 * Build a between-floor sponsor draft for one player. Each sponsor fields one
 * gift, up to rewardMaxCount options — no sponsors, no gifts. Sponsors beyond
 * the cap each pitch an extra candidate and only the best fits for this
 * crawler's build survive, so a heavily-backed run sees stronger, more
 * on-build options. Roll quality also scales with the show (q below).
 */
function generateRewards(state: GameState, playerId: number): Reward[] {
  const pl = state.players.find((pp) => pp.id === playerId) ?? state.players[0];
  const count = Math.min(CONFIG.rewardMaxCount, pl.sponsors);
  if (count <= 0) return [];
  const rng = createRng((floorSeed(state.seed, state.floor) ^ 0x5eed1234 ^ Math.imul(playerId + 1, 0x85ebca6b)) >>> 0);
  const q = 1 + pl.sponsors * 0.4 + Math.min(1, pl.favorites / 1000);
  // Wide pool so the every-floor pick isn't obvious: 4 permanent stat gifts
  // (each diminishing as you stack it) alongside build-variety gifts.
  const pool: SponsorRewardKind[] = [
    "healFull", "maxHp", "damage", "crit", "armor", "item", "gold", "bonusTime", "materials", "favor",
  ];
  // Retraining Arc joins the pool only when there's a fork side to refund.
  if (retrainableNodes(pl).length > 0) pool.push("retrain");
  const surplus = Math.max(0, pl.sponsors - CONFIG.rewardMaxCount);
  const candidates = shuffle(rng, pool)
    .slice(0, Math.min(pool.length, count + surplus))
    .map((kind) => makeReward(state, rng, pl, kind, q));
  if (candidates.length <= count) return candidates;
  // Keep the best-fitting `count`, preserving the rolled order for display.
  // A ±20% seeded jitter keeps this a bias, not a script — surplus backing
  // raises the odds of strong on-build gifts without fixing the draft.
  const scores = new Map(candidates.map((r) => [r, rewardFitScore(pl, r) * (0.8 + 0.4 * nextFloat(rng))]));
  const keep = new Set(
    [...candidates].sort((a, b) => scores.get(b)! - scores.get(a)!).slice(0, count),
  );
  return candidates.filter((r) => keep.has(r));
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
      p.bonusSpell += r.amount; // sponsor buffs serve every build (see loot boxes)
      recomputeStats(p);
      break;
    case "crit":
      p.bonusCrit += r.amount;
      recomputeStats(p);
      break;
    case "armor":
      p.bonusArmor += r.amount;
      recomputeStats(p);
      break;
    case "gold":
      p.gold += r.amount;
      break;
    case "materials":
      if (r.material) p.materials[r.material] += r.amount;
      break;
    case "favor":
      p.upgradeDraftsOwed += r.amount;
      break;
    case "retrain":
      // Unlearn the fork side; the invested ranks come back as fresh drafts.
      // The rival node unlocks naturally (nodeOpen sees zero ranks here now).
      if (r.nodeId && (p.abilities.ranks[r.nodeId] ?? 0) > 0) {
        delete p.abilities.ranks[r.nodeId];
        p.upgradeDraftsOwed += r.amount;
        announce(state, "show", `${p.name} takes a RETRAINING ARC — ${upgradeDef(r.nodeId)?.title ?? r.nodeId} unlearned. The crowd loves a reinvention.`);
      }
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
    // System Shrine bargains (floor events — see shrineChoices):
    case "shrineBlood": {
      const cost = Math.max(1, Math.round(p.maxHp * CONFIG.shrineBloodCostFraction));
      p.hp = Math.max(1, p.hp - cost); // an offering, not a hit — no armor, no death
      p.bonusCrit += r.amount;
      recomputeStats(p);
      announce(state, "show", `${p.name} pays the BLOOD PRICE. The shrine drinks deep. +${Math.round(r.amount * 100)}% crit, forever.`);
      break;
    }
    case "shrineGreed":
      state.goldSurge = true;
      for (const m of state.monsters) m.speed *= CONFIG.shrineGreedSpeedMult;
      announce(state, "show", "GREED CLAUSE signed: everything on this floor is faster, and everything it drops pays double.");
      break;
    case "shrineDecline":
      break; // the shrine dims, unimpressed
    // CLASS REVISION (milestone castings — revisions.ts):
    case "revision": {
      if (!r.revisionId || hasRevision(p, r.revisionId)) break;
      (p.revisions ??= []).push(r.revisionId);
      recomputeStats(p); // hp/speed/armor castings apply immediately
      if (p.hp > p.maxHp) p.hp = p.maxHp;
      if (r.revisionId === "parkour") p.dashCharges = Math.min(p.dashCharges + CONFIG.revisionParkourCharges, maxDashCharges(p));
      if (r.revisionId === "canceled") p.hype = 0; // the System pretends you're dead
      announce(state, "show", `CLASS REVISION: ${p.name} is recast as ${r.title}. The change is permanent. The file has been updated.`);
      break;
    }
    case "revisionDecline":
      (p.revisions ??= []).push("uncast");
      announce(state, "show", `${p.name} REMAINS UNCAST. The System notes the defiance. The crowd respects it.`);
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
  // Direct response to the player's own click — the log entry is enough.
  state.events.push(
    r.kind.startsWith("shrine")
      ? `${p.name} answers the shrine: ${r.title}.`
      : r.kind.startsWith("revision")
        ? `${p.name} answers the casting call: ${r.title}.`
        : `${p.name} accepts a sponsor gift: ${r.title}.`,
  );
}

/** The System Shrine's pick-1 bargain (floor event). Rides pendingRewards —
 * the same non-blocking personal-draft plumbing sponsor gifts use, so hosts
 * need no new UI. Costs are spelled out in the desc; applyReward collects. */
function shrineChoices(state: GameState, p: Player): Reward[] {
  const cost = Math.max(1, Math.round(p.maxHp * CONFIG.shrineBloodCostFraction));
  return [
    {
      id: state.nextEntityId++, kind: "shrineBlood", title: "Blood Price",
      desc: `Offer ${cost} HP on the spot for +${Math.round(CONFIG.shrineBloodCrit * 100)}% crit, permanently`,
      amount: CONFIG.shrineBloodCrit,
    },
    {
      id: state.nextEntityId++, kind: "shrineGreed", title: "Greed Clause",
      desc: `This floor's monsters gain +${Math.round((CONFIG.shrineGreedSpeedMult - 1) * 100)}% speed; its gold drops pay DOUBLE`,
      amount: 0,
    },
    {
      id: state.nextEntityId++, kind: "shrineDecline", title: "Walk Away",
      desc: "No deal. The System respects cowardice; it just doesn't pay for it",
      amount: 0,
    },
  ];
}

/**
 * Dash skill: blink with brief i-frames (dashTime), along the CURRENT move
 * input when there is one (falling back to facing) — firing a bolt sets
 * facing to the aim direction, and a dash should follow your feet, not your
 * last shot. Runs on charges — spending one starts the recharge timer
 * (cd.dash) if it isn't already running.
 */
function doDash(state: GameState, p: Player, move: Vec2): void {
  const dp = dashParams(p);
  p.dashCharges--;
  if ((p.cd.dash ?? 0) <= 0) p.cd.dash = dp.cooldown * cdMult(p);
  // Blastplate Harness: the launch point detonates behind you.
  if (hasPassive(p, "blastplate")) {
    radialDamage(state, p, { x: p.pos.x, y: p.pos.y }, 1.6, power(p, "dash"), 0, "magic");
  }
  p.dashTime = CONFIG.dashDuration;
  const dir = normalize(move.x !== 0 || move.y !== 0 ? move : p.facing);
  p.facing = dir;
  const start = { x: p.pos.x, y: p.pos.y };
  // Walk the dash path in sub-steps so it STOPS at walls. (A single full-
  // distance moveWithCollision only checks the landing point — dashes used to
  // quietly tunnel through one-tile walls, which is now Backstage Pass's job.)
  for (let moved = 0; moved < dp.distance; moved += 0.2) {
    const before = { x: p.pos.x, y: p.pos.y };
    moveWithCollision(state.map, p.pos, dir, Math.min(0.2, dp.distance - moved), isWalkable);
    if (dist(before, p.pos) < 0.01) break; // dead stop: a wall ate the dash
  }
  // Backstage Pass (chase legendary): walls are set dressing. If the ordinary
  // dash slide stopped short but the reach extends to walkable ground on the
  // FAR side, blink there — scanning from full reach backward for the farthest
  // landing. Locked doors are load-bearing (keys, boss seals): crossing one
  // anywhere along the line refuses the phase.
  if (hasPassive(p, "phase")) {
    const slid = dist(start, p.pos);
    for (let d = dp.distance; d > slid + 0.5; d -= 0.25) {
      const landing = { x: start.x + dir.x * d, y: start.y + dir.y * d };
      if (!isWalkable(state.map, landing.x, landing.y)) continue;
      let crossesDoor = false;
      for (let s = 0.25; s < d; s += 0.25) {
        if (tileAt(state.map, start.x + dir.x * s, start.y + dir.y * s) === Tile.DoorLocked) {
          crossesDoor = true;
          break;
        }
      }
      if (crossesDoor) break;
      p.pos.x = landing.x;
      p.pos.y = landing.y;
      hit(state, p.pos, 0, "weapon"); // arrival poof: you exited through the wall
      break;
    }
  }
  // Shockstep: damage along the WHOLE dash path (launch -> arrival capsule),
  // so dashing through a pack connects — and Long Blink extends the reach.
  if (dp.shockMult > 0) {
    segmentDamage(state, p, start, p.pos, CONFIG.shockstepPathRadius,
      power(p, "dash") * dp.shockMult, CONFIG.shockstepKnockback, "magic");
  }
  // AFTERSHOCK capstone: the arrival point additionally detonates outright.
  if (rank(p, "dash.after") > 0) {
    radialDamage(state, p, p.pos, 1.8, power(p, "dash"), 0, "magic");
    p.novaFlash = Math.max(p.novaFlash, 0.18);
  }
}

/**
 * Battle Stance: toggle which attack type the crawler favors (see stanceMult).
 * The swap itself is the cast — Flow builds ride the post-swap surge window,
 * Discipline builds plant their feet and let the stance settle instead.
 */
function doStance(state: GameState, p: Player): void {
  p.stance = p.stance === "melee" ? "ranged" : "melee";
  p.cd.stance = CONFIG.stanceSwapCooldown * cdMult(p);
  p.stanceTime = 0;
  p.stanceSwapWindow = CONFIG.stanceSurgeSeconds;
  if (rank(p, "stance.moment") > 0) p.stanceCritReady = true;
  // Signature Choreography (chase legendary): every swap opens a crit surge —
  // the +crit rides the same post-swap window Flow uses (see damageMonster),
  // so the dance-build's rhythm is swap, spike, swap, spike.
  hit(state, p.pos, 0, "weapon"); // a flourish poof for the juice layer
}

/**
 * Overcharge: bank power now; the NEXT attack (melee swing or bolt volley)
 * spends it — harder-hitting, plus whatever the tree adds (extra bolts, an
 * echo strike, poise-shattering hits). The cooldown starts on cast, so the
 * rhythm is charge -> pick the moment -> spend.
 */
function doOvercharge(state: GameState, p: Player): void {
  p.overcharged = true;
  p.cd.overcharge = CONFIG.overchargeCooldown * cdMult(p);
  hit(state, p.pos, 0, "weapon"); // a crackle poof for the juice layer
}

/** Ranged bolt skill: fire player projectile(s) along facing/aim (Split Shot fans). */
function doBolt(state: GameState, p: Player, aim: Vec2): void {
  const bp = boltParams(p);
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  p.cd.bolt = bp.cooldown * cdMult(p);
  systemTip(state, p, "bolt"); // the weapon throws it; the System explains once
  // Stance judges the CAST (a volley loosed in Deadeye stays hot even if you
  // swap mid-flight). MOMENTUM and Overcharge spend on fire — the shot taken
  // is the shot primed; whether it lands is the archer's problem.
  const momentum = p.stanceCritReady && p.stance === "ranged";
  if (momentum) p.stanceCritReady = false;
  const oc = p.overcharged ? overchargeParams(p) : null;
  if (oc) p.overcharged = false;
  // The weapon decides what a "bolt" even is (boltParams): crossbow bolts off
  // attack power, magic missiles off spell power, or a melee-class sidearm.
  const damage = Math.max(1, Math.round(bp.dmg * stanceMult(p, "ranged") * (oc?.mult ?? 1)));
  const speed = CONFIG.boltSpeed * bp.speedMult;
  const count = bp.count + (oc?.extraBolts ?? 0); // Overcharged Volley widens the fan
  const base = Math.atan2(dir.y, dir.x);
  const spread = 0.22; // radians between fan bolts
  for (let i = 0; i < count; i++) {
    const a = base + (i - (count - 1) / 2) * spread;
    const d = { x: Math.cos(a), y: Math.sin(a) };
    state.projectiles.push({
      id: state.nextEntityId++,
      pos: { x: p.pos.x + d.x * 0.6, y: p.pos.y + d.y * 0.6 },
      vel: { x: d.x * speed, y: d.y * speed },
      damage,
      ttl: CONFIG.boltTtl,
      from: "player",
      ownerId: p.id,
      pierce: bp.pierce,
      crit: momentum || undefined,
      shatter: oc?.shatter || undefined,
      school: bp.school,
      chill: bp.chill > 0 ? bp.chill : undefined,
    });
  }
}

/** Damage every monster within `radius` of `center` (crit-able); used by nova/aftershock.
 * Blasts shove outward from the center when `knockback` > 0. Returns the
 * monsters this blast KILLED (Extinction chains / Sponsor Loyalty refunds). */
function radialDamage(
  state: GameState, p: Player, center: Vec2, radius: number, damage: number,
  knockback = 0, school: School = "physical", poiseMult = 1,
): Monster[] {
  const killed: Monster[] = [];
  for (const m of state.monsters) {
    if (m.hp <= 0) continue; // already dead this step — not this blast's kill
    const d = dist(center, m.pos);
    if (d - bodyRadius(m) > radius) continue; // blasts catch the body, not the center
    const dir = d > 1e-4 ? { x: (m.pos.x - center.x) / d, y: (m.pos.y - center.y) / d } : undefined;
    damageMonster(state, p, m, damage, { dir, knockback, school, poiseMult });
    if (m.hp <= 0) killed.push(m);
  }
  // RIVALS: blasts don't check contracts — rivals in the radius eat it too.
  for (const v of rivalTargets(state, p)) {
    const d = dist(center, v.pos);
    if (d - 0.35 > radius) continue;
    const dir = d > 1e-4 ? { x: (v.pos.x - center.x) / d, y: (v.pos.y - center.y) / d } : undefined;
    pvpStrike(state, p, v, damage, dir);
  }
  return killed;
}

/** EXTINCTION EVENT (Cataclysm capstone): every kill detonates the corpse,
 * chaining a smaller magic blast outward. One generation only — the chain's
 * own kills don't re-detonate, so a packed room pops like a firework, not
 * an infinite loop. */
function extinctionChain(state: GameState, p: Player, killed: Monster[]): void {
  if (killed.length === 0) return;
  const dmg = power(p, "cataclysm") * CONFIG.ultCataclysmDmgMult * CONFIG.ultCataclysmExtinctionFrac;
  for (const corpse of killed) {
    hit(state, corpse.pos, 0, "crit"); // detonation flash for the juice layer
    radialDamage(state, p, corpse.pos, CONFIG.ultCataclysmExtinctionRadius, dmg, 0.4, "magic");
  }
}

/** Damage every monster whose body touches the capsule around segment a->b
 * (Shockstep's dash path). Knockback shoves away from the path. */
function segmentDamage(
  state: GameState, p: Player, a: Vec2, b: Vec2, radius: number, damage: number,
  knockback = 0, school: School = "physical",
): void {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const len2 = ab.x * ab.x + ab.y * ab.y;
  for (const m of state.monsters) {
    const t = len2 > 1e-6
      ? Math.max(0, Math.min(1, ((m.pos.x - a.x) * ab.x + (m.pos.y - a.y) * ab.y) / len2))
      : 0;
    const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(closest, m.pos);
    if (d - bodyRadius(m) > radius) continue;
    const dir = d > 1e-4 ? { x: (m.pos.x - closest.x) / d, y: (m.pos.y - closest.y) / d } : undefined;
    damageMonster(state, p, m, damage, { dir, knockback, school });
  }
  // RIVALS: shockstepping THROUGH a rival counts.
  for (const v of rivalTargets(state, p)) {
    const t = len2 > 1e-6
      ? Math.max(0, Math.min(1, ((v.pos.x - a.x) * ab.x + (v.pos.y - a.y) * ab.y) / len2))
      : 0;
    const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(closest, v.pos);
    if (d - 0.35 > radius) continue;
    pvpStrike(state, p, v, damage, d > 1e-4 ? { x: (v.pos.x - closest.x) / d, y: (v.pos.y - closest.y) / d } : undefined);
  }
}

/** Nova skill: a radial shockwave around the player (must be learned). */
function doNova(state: GameState, p: Player): void {
  const np = novaParams(p);
  p.cd.nova = np.cooldown * cdMult(p);
  // IMPLOSION capstone: drag everything in range toward you first.
  if (rank(p, "nova.implode") > 0) {
    for (const m of state.monsters) {
      const d = dist(p.pos, m.pos);
      if (d > np.radius * 1.6 || d < 1.2) continue;
      const dir = { x: (p.pos.x - m.pos.x) / d, y: (p.pos.y - m.pos.y) / d };
      moveWithCollision(state.map, m.pos, dir, Math.min(d - 1, 2.2), isWalkable);
    }
  }
  p.novaFlash = 0.3;
  const base = power(p, "nova") * np.damageMult;
  radialDamage(state, p, p.pos, np.radius, base, CONFIG.novaKnockback, "magic");
  // AFTERBURN (5.11): the shockwave ignites — everything it touched burns for
  // a fraction of the nova hit, spread over burnDuration. Refresh, no stacking.
  const scorch = rank(p, "nova.scorch");
  if (scorch > 0) {
    const perTick = (base * CONFIG.novaScorchFracPerRank * scorch) /
      (CONFIG.burnDuration / CONFIG.burnTickSeconds);
    for (const m of state.monsters) {
      if (m.hp <= 0 || dist(p.pos, m.pos) - bodyRadius(m) > np.radius) continue;
      applyStatus(m, {
        kind: "burn", duration: CONFIG.burnDuration, school: "magic",
        magnitude: Math.max(1, Math.round(perTick)), sourceId: p.id,
      });
    }
  }
}

/**
 * Orbit blades: automatic contact damage on a fixed tick while slotted. The
 * tick tests the blade's SWEPT path since the last tick (sampled), not just
 * its instantaneous position — blades hit what they visibly passed through.
 * With Corkscrew the radius spirals between inner and outer reach (see
 * orbitBladePos), so coverage spans every range instead of one ring.
 */
function updateOrbit(state: GameState, p: Player, dt: number): void {
  if (!slotted(p, "orbit") || !p.alive) return;
  const op = orbitParams(p);
  p.orbitAngle = (p.orbitAngle + CONFIG.orbitRevPerSec * Math.PI * 2 * dt) % (Math.PI * 2);
  p.orbitSpiral = (p.orbitSpiral + CONFIG.orbitSpiralRevPerSec * Math.PI * 2 * dt) % (Math.PI * 2);
  p.orbitTick -= dt;
  if (p.orbitTick > 0) return;
  p.orbitTick = op.tickSeconds; // Encore spins to a faster beat
  const angleSweep = CONFIG.orbitRevPerSec * Math.PI * 2 * op.tickSeconds;
  const phaseSweep = CONFIG.orbitSpiralRevPerSec * Math.PI * 2 * op.tickSeconds;
  const samples = CONFIG.orbitHitSamples;
  for (const m of state.monsters) {
    const reach = CONFIG.orbitBladeHitRadius + bodyRadius(m);
    let touching = false;
    for (let i = 0; i < op.blades && !touching; i++) {
      for (let k = 0; k < samples; k++) {
        const back = k / samples; // 0 = now, ->1 = start of the tick window
        const blade = orbitBladePos(p, i, angleSweep * back, phaseSweep * back);
        if (dist(blade, m.pos) <= reach) { touching = true; break; }
      }
    }
    if (!touching) continue;
    damageMonster(state, p, m, power(p, "orbit") * op.damageMult * stanceMult(p, "melee"), { allowCrit: false, school: "physical" });
    // GUILLOTINE capstone: chaff the blades have worn down is simply finished.
    // (Exact HP, no damage roll — an execute that sometimes whiffs is a lie.)
    if (
      m.hp > 0 && !m.elite && m.kind !== "boss" &&
      rank(p, "orbit.guillotine") > 0 && m.hp <= m.maxHp * CONFIG.orbitGuillotineThreshold
    ) {
      const left = Math.round(m.hp);
      m.hp = 0;
      m.lastHitBy = p.id;
      hit(state, m.pos, Math.max(1, left), "enemy", { killed: true });
    }
  }
  // RIVALS: walking your blade ring through a rival grinds them too.
  for (const v of rivalTargets(state, p)) {
    let touching = false;
    for (let i = 0; i < op.blades && !touching; i++) {
      const blade = orbitBladePos(p, i, 0, 0);
      if (dist(blade, v.pos) <= CONFIG.orbitBladeHitRadius + 0.35) touching = true;
    }
    if (touching) pvpStrike(state, p, v, power(p, "orbit") * op.damageMult * stanceMult(p, "melee"));
  }
}

// ---- The fun-kit wave: Blindside / Extradition / Stunt Double ----

/** The monster the aim ray points at: closest to the ray within `range`, no
 * more than ~a body off the line. Zero aim falls back to facing. */
function pickAlongAim(state: GameState, p: Player, aim: Vec2, range: number): Monster | null {
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  let best: Monster | null = null;
  let bestPerp = Infinity;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const rel = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    const along = rel.x * dir.x + rel.y * dir.y;
    if (along < 0.3 || along > range) continue;
    const perp = Math.abs(rel.x * dir.y - rel.y * dir.x) - bodyRadius(m);
    if (perp > 1.0) continue; // too far off the line; the camera does not guess
    if (perp < bestPerp) { bestPerp = perp; best = m; }
  }
  return best;
}

/** Blindside: the broadcast cuts to the action. Teleport onto the aimed enemy
 * and strike as you arrive. No target, no cut (the cooldown is not spent). */
function doCutTo(state: GameState, p: Player, aim: Vec2): void {
  const cp = cutToParams(p);
  const target = pickAlongAim(state, p, aim, cp.range);
  if (!target) return;
  p.cd.cutto = cp.cooldown * cdMult(p);
  const d = dist(p.pos, target.pos);
  const dir = d > 1e-4 ? { x: (target.pos.x - p.pos.x) / d, y: (target.pos.y - p.pos.y) / d } : p.facing;
  // The cut slides the whole distance; collision keeps it honest (no walls).
  moveWithCollision(state.map, p.pos, dir, Math.max(0, d - 0.9), isWalkable);
  p.facing = { x: dir.x, y: dir.y };
  p.attackSwing = 0.15;
  hit(state, p.pos, 0, "weapon"); // arrival flash for the juice layer
  // Sucker Punch: the arrival strike shatters poise (non-bosses arrive staggered).
  damageMonster(state, p, target, power(p, "cutto") * cp.dmgMult, {
    dir, school: "physical", shatterPoise: cp.smash, knockback: CONFIG.meleeKnockback,
  });
  // REPEAT OFFENDER: finish them inside the window and the camera resets (reapDead).
  if (cp.match) p.cutMark = { monsterId: target.id, t: CONFIG.cutToMatchWindow };
}

/** Drag one monster to within reach of `p`, staggered; any committed attack
 * or rush is yanked out from under it. */
function dragToPlayer(state: GameState, p: Player, m: Monster, stagger: number): void {
  const d = dist(m.pos, p.pos);
  if (d > CONFIG.surfArriveGap) {
    const dir = { x: (p.pos.x - m.pos.x) / d, y: (p.pos.y - m.pos.y) / d };
    moveWithCollision(state.map, m.pos, dir, d - CONFIG.surfArriveGap, isWalkable);
  }
  m.stagger = Math.max(m.stagger, stagger);
  m.windup = 0;
  m.windupKind = undefined;
  m.chargeT = 0;
  m.chargeDir = undefined;
  hit(state, m.pos, 0, "weapon"); // chain-yank flash
}

/** Extradition: one chain, two verbs decided by weight. Light enemies land in
 * your arms staggered; heavy ones (elites, bosses, the truly massive) hold
 * fast and the chain yanks YOU across the gap instead, i-frames included. */
function doCrowdSurf(state: GameState, p: Player, aim: Vec2): void {
  const sp = crowdSurfParams(p);
  const target = pickAlongAim(state, p, aim, sp.range);
  if (!target) return;
  p.cd.crowdsurf = sp.cooldown * cdMult(p);
  const anchor = { x: target.pos.x, y: target.pos.y }; // chain line, pre-drag
  const d = dist(p.pos, anchor);
  const dir = d > 1e-4 ? { x: (anchor.x - p.pos.x) / d, y: (anchor.y - p.pos.y) / d } : p.facing;
  p.facing = { x: dir.x, y: dir.y };
  // The chain itself, as data: caster's pre-flight position -> the anchor.
  // Hosts draw the link; which end travels is theirs to observe.
  hit(state, p.pos, 0, "chain", { dir, to: anchor });
  const heavy = target.kind === "boss" || target.elite || ARCHETYPES[target.kind].mass > CONFIG.surfMassLimit;
  if (heavy) {
    // The anchor holds: you ride the chain. Brief i-frames cover the flight.
    systemTip(state, p, "extradition");
    p.dashTime = Math.max(p.dashTime, 0.15);
    moveWithCollision(state.map, p.pos, dir, Math.max(0, d - CONFIG.surfArriveGap), isWalkable);
    hit(state, p.pos, 0, "weapon");
    // Gavel Drop: arriving IS the attack.
    if (sp.diveFrac > 0) {
      radialDamage(state, p, p.pos, CONFIG.surfDiveRadius, power(p, "crowdsurf") * sp.diveFrac, CONFIG.shockstepKnockback, "magic");
      hit(state, p.pos, 0, "crit");
    }
  } else {
    dragToPlayer(state, p, target, sp.stagger);
  }
  // CLASS ACTION: everything the chain passed through comes along (light bodies only).
  if (sp.wave) {
    const len2 = d * d;
    for (const m of state.monsters) {
      if (m === target || m.hp <= 0) continue;
      if (m.kind === "boss" || m.elite || ARCHETYPES[m.kind].mass > CONFIG.surfMassLimit) continue;
      const t = len2 > 1e-6
        ? Math.max(0, Math.min(1, ((m.pos.x - p.pos.x) * (anchor.x - p.pos.x) + (m.pos.y - p.pos.y) * (anchor.y - p.pos.y)) / len2))
        : 0;
      const closest = { x: p.pos.x + (anchor.x - p.pos.x) * t, y: p.pos.y + (anchor.y - p.pos.y) * t };
      if (dist(closest, m.pos) - bodyRadius(m) > CONFIG.surfPathRadius) continue;
      dragToPlayer(state, p, m, sp.stagger);
    }
  }
}

/** Stunt Double: the production hires a professional. It taunts (ai.ts hunts
 * it), soaks hits into its contract (never dies; pro), mirrors the owner's
 * swings, and retires with a bang proportional to the beating it took. */
function doStuntDouble(state: GameState, p: Player): void {
  const dp = stuntDoubleParams(p);
  p.cd.stuntdouble = dp.cooldown * cdMult(p);
  state.decoys.push({
    id: state.nextEntityId++,
    ownerId: p.id,
    pos: { x: p.pos.x, y: p.pos.y },
    facing: { x: p.facing.x, y: p.facing.y },
    t: dp.contract,
    absorbed: 0,
  });
  announce(state, "show", `${p.name}'s STUNT DOUBLE takes the floor. The crowd can't tell them apart.`);
}

/** The nearest Stunt Double whose taunt radius covers `pos`; ai.ts targeting
 * prefers this over the nearest player (the whole point of hiring one). */
export function tauntingDecoy(state: GameState, pos: Vec2): Decoy | null {
  let best: Decoy | null = null;
  let bestD = Infinity;
  for (const dc of state.decoys) {
    const owner = state.players.find((pl) => pl.id === dc.ownerId);
    const radius = owner ? stuntDoubleParams(owner).tauntRadius : CONFIG.doubleTauntRadius;
    const d = dist(pos, dc.pos);
    if (d <= radius && d < bestD) { bestD = d; best = dc; }
  }
  return best;
}

/** Route a monster strike into a decoy in reach, if any. The double soaks it
 * (banked for the farewell blast) and the players behind it are spared. */
export function decoySoak(state: GameState, from: Vec2, reach: number, damage: number): boolean {
  for (const dc of state.decoys) {
    if (dist(from, dc.pos) > reach) continue;
    dc.absorbed += damage;
    state.hits.push({ pos: { x: dc.pos.x, y: dc.pos.y }, amount: Math.round(damage), kind: "player" });
    return true;
  }
  return false;
}

/** Tick stunt contracts; expiry = the farewell blast + AWARD SEASON refund. */
function updateDecoys(state: GameState, dt: number): void {
  if (state.decoys.length === 0) return;
  const remaining: Decoy[] = [];
  for (const dc of state.decoys) {
    dc.t -= dt;
    if (dc.t > 0) { remaining.push(dc); continue; }
    const owner = state.players.find((pl) => pl.id === dc.ownerId) ?? state.players[0];
    const dp = stuntDoubleParams(owner);
    const dmg = Math.min(dc.absorbed * dp.explodeFrac, owner.attackPower * CONFIG.doubleExplodeCap);
    if (dmg >= 1) {
      radialDamage(state, owner, dc.pos, CONFIG.doubleExplodeRadius, dmg, 0.5, "physical");
      hit(state, dc.pos, 0, "crit");
      state.events.push(`${owner.name}'s stunt double takes a bow — and EXPLODES.`);
    }
    // AWARD SEASON: a finished contract refunds half of the next booking.
    if (dp.award && (owner.cd.stuntdouble ?? 0) > 0) {
      owner.cd.stuntdouble = (owner.cd.stuntdouble ?? 0) * 0.5;
    }
  }
  state.decoys = remaining;
}

// ---- Ultimates (the fifth slot) ----

/** Sponsor Airstrike: schedule a shell bombardment around the aim point.
 * The constellation shapes the barrage: Payload hardens shells, Saturation
 * adds them (wider), Precision tightens the grouping. */
function doAirstrike(state: GameState, p: Player, aim: Vec2): void {
  p.cd.airstrike = CONFIG.ultAirstrikeCooldown;
  const ap = airstrikeParams(p);
  const len = Math.hypot(aim.x, aim.y);
  const range = Math.min(CONFIG.ultAirstrikeRange, len || 1);
  const dir = len > 0 ? { x: aim.x / len, y: aim.y / len } : p.facing;
  const target = { x: p.pos.x + dir.x * range, y: p.pos.y + dir.y * range };
  for (let i = 0; i < ap.shells; i++) {
    const a = nextFloat(state.rng) * Math.PI * 2;
    const d = nextFloat(state.rng) * ap.spread;
    state.strikes.push({
      pos: { x: target.x + Math.cos(a) * d, y: target.y + Math.sin(a) * d },
      t: 0.45 + i * 0.22,
      ownerId: p.id,
      kind: "shell",
    });
  }
  announce(state, "show", `${p.name}'s sponsors have AUTHORIZED AN AIRSTRIKE. Clear the drop zone. Or don't — ratings.`);
}

/**
 * Tick monster-side status effects (5.11). Due DoT ticks route through
 * damageMonster — the ONE monster choke point — so schools, resists, shielded,
 * one-shot caps, kill credit, and hit events all compose for free. DoT never
 * crits and never builds poise (a burn shouldn't stagger-lock a brute).
 */
function updateMonsterStatuses(state: GameState, dt: number): void {
  for (const m of state.monsters) {
    if (m.hp <= 0 || !m.statuses || m.statuses.length === 0) continue;
    for (const due of tickStatuses(m, dt)) {
      if (m.hp <= 0) break;
      const src = state.players.find((pl) => pl.id === due.sourceId) ?? state.players[0];
      damageMonster(state, src, m, due.damage, {
        allowCrit: false, poiseMult: 0, school: due.school, effect: due.kind,
      });
    }
  }
}

/**
 * Tick ground danger. Blasts (volatile corpses) damage once on expiry;
 * puddles (spitter acid) damage everyone inside on a repeating tick until
 * they dry up; armed zones (boss sludge/roots) telegraph for `arm` seconds,
 * then bite or grip until they expire. Dash i-frames dodge all of it.
 */
/** Distance from a point to the segment a-b (beam hazards hit by half-width). */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq < 1e-8 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function updateHazards(state: GameState, dt: number): void {
  if (state.hazards.length === 0) return;
  const remaining: GameState["hazards"] = [];
  for (const hz of state.hazards) {
    hz.t -= dt;
    if (hz.kind === "beam" && hz.end) {
      // Beam: telegraph for `arm` seconds, fire ONCE along the whole segment
      // (piercing — cover doesn't help, sidestepping does), fade briefly.
      if (hz.t <= 0) continue; // flash spent
      const live = hz.total - hz.t >= (hz.arm ?? 0);
      if (live && !hz.fired) {
        hz.fired = true;
        hz.t = Math.min(hz.t, CONFIG.beamFadeSeconds); // whatever remains is the flash
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue; // dash i-frames beat the shot
          if (distToSegment(p.pos, hz.pos, hz.end) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage)) {
            handlePlayerDeath(state, p, `${p.name} stood on the dotted line. The System appreciates the composition.`);
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "sludge" || hz.kind === "roots") {
      if (hz.t <= 0) continue; // drained / withered
      const live = hz.total - hz.t >= (hz.arm ?? 0); // past the telegraph
      if (live && hz.kind === "roots") {
        // Roots GRIP: refresh the snare on anyone standing in the zone.
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue; // dashing THROUGH is the escape
          if (dist(hz.pos, p.pos) > hz.radius) continue;
          p.rootT = Math.max(p.rootT, CONFIG.rootsSnare);
        }
      } else if (live) {
        // Sludge bites on the puddle cadence.
        hz.tick = (hz.tick ?? 0) - dt;
        if (hz.tick <= 0) {
          hz.tick = CONFIG.puddleTickSeconds;
          for (const p of state.players) {
            if (!p.alive || p.dashTime > 0) continue;
            if (dist(hz.pos, p.pos) > hz.radius) continue;
            if (damagePlayerHit(state, p, hz.damage)) {
              handlePlayerDeath(state, p, `${p.name} tried to swim the surge. The sludge won. Smell-o-vision regrets everything.`);
            }
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "puddle") {
      if (hz.t <= 0) continue; // dried up, harmless
      hz.tick = (hz.tick ?? 0) - dt;
      if (hz.tick <= 0) {
        hz.tick = CONFIG.puddleTickSeconds;
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue;
          if (dist(hz.pos, p.pos) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage)) {
            handlePlayerDeath(state, p, `${p.name} stood in the acid until the acid won. Chat is typing.`);
          } else {
            // The acid SOAKS IN (5.11): every tick in the puddle also stacks
            // poison, so lingering costs you after you finally step out.
            applyStatus(p, {
              kind: "poison", duration: CONFIG.poisonDuration, school: "physical",
              magnitude: Math.max(1, Math.round(hz.damage * CONFIG.puddlePoisonFraction)),
            });
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.t > 0) { remaining.push(hz); continue; }
    hit(state, hz.pos, 0, "crit"); // impact flash for the juice layer
    for (const p of state.players) {
      if (!p.alive || p.dashTime > 0) continue; // dash i-frames dodge the blast
      if (dist(hz.pos, p.pos) > hz.radius) continue;
      const d = dist(hz.pos, p.pos);
      const away = d > 1e-4
        ? { x: (p.pos.x - hz.pos.x) / d, y: (p.pos.y - hz.pos.y) / d }
        : undefined;
      if (damagePlayerHit(state, p, hz.damage, { dir: away })) {
        handlePlayerDeath(state, p, `${p.name} looted a corpse that was still ticking. The crowd howls.`);
      }
    }
  }
  state.hazards = remaining;
}

/** Tick raisable corpses: past their TTL they're too cold for the necromancer. */
function updateCorpses(state: GameState, dt: number): void {
  if (state.corpses.length === 0) return;
  for (const c of state.corpses) c.t -= dt;
  // SCAVENGER ROYALTY (class revision): corpses near the crowned crawler
  // crumble into gold — and out of every necromancer's reach.
  const scavs = state.players.filter((p) => p.alive && hasRevision(p, "scavenger"));
  if (scavs.length > 0) {
    for (const c of state.corpses) {
      if (c.t <= 0) continue;
      const p = scavs.find((s) => dist(s.pos, c.pos) <= CONFIG.revisionScavengerRadius);
      if (!p) continue;
      c.t = 0;
      const gold = CONFIG.revisionScavengerGold + Math.floor(state.floor / 4);
      p.gold += gold;
      hit(state, c.pos, gold, "gold");
    }
  }
  state.corpses = state.corpses.filter((c) => c.t > 0);
}

/** Tick scheduled blasts: airstrike shells (per-owner constellation shapes
 * them) and Cataclysm's Aftermath echo (pre-computed at schedule time). */
function updateStrikes(state: GameState, dt: number): void {
  if (state.strikes.length === 0) return;
  const remaining: GameState["strikes"] = [];
  for (const s of state.strikes) {
    s.t -= dt;
    if (s.t > 0) { remaining.push(s); continue; }
    const owner = state.players.find((pl) => pl.id === s.ownerId) ?? state.players[0];
    const ap = airstrikeParams(owner);
    const radius = s.radius ?? CONFIG.ultAirstrikeRadius;
    const dmg = s.dmg ?? power(owner, "airstrike") * ap.dmgMult;
    const killed = radialDamage(state, owner, s.pos, radius, dmg, s.knockback ?? CONFIG.airstrikeKnockback, s.school ?? "physical");
    hit(state, s.pos, 0, "crit"); // impact flash for the juice layer
    if (s.kind === "echo") {
      // The echo is still a Cataclysm: EXTINCTION chains off its kills too.
      if (cataclysmParams(owner).extinction) extinctionChain(state, owner, killed);
    } else if (ap.loyalty && killed.length > 0 && (owner.cd.airstrike ?? 0) > 0) {
      // SPONSOR LOYALTY: the network pays per confirmed kill, in cooldown.
      owner.cd.airstrike = Math.max(
        0, (owner.cd.airstrike ?? 0) - killed.length * CONFIG.ultAirstrikeLoyaltyRefund * CONFIG.ultAirstrikeCooldown,
      );
    }
  }
  state.strikes = remaining;
}

/** Cataclysm Nova: a floor-shaking blast that hurls enemies back. The
 * constellation shapes it: Epicenter widens, Upheaval hurls harder and
 * crushes poise, Aftermath schedules an echo shock, EXTINCTION chains kills. */
function doCataclysm(state: GameState, p: Player): void {
  p.cd.cataclysm = CONFIG.ultCataclysmCooldown;
  const cp = cataclysmParams(p);
  p.novaFlash = 0.3; // reuse the ring effect
  const blastDmg = power(p, "cataclysm") * CONFIG.ultCataclysmDmgMult;
  const killed = radialDamage(state, p, p.pos, cp.radius, blastDmg, 0, "magic", cp.poiseMult);
  // Corpses detonate where they DIED — before the survivors get hurled.
  if (cp.extinction) extinctionChain(state, p, killed);
  for (const m of state.monsters) {
    if (m.hp <= 0) continue; // the dead don't fly
    const d = dist(p.pos, m.pos);
    if (d > cp.radius || d < 1e-4) continue;
    const dir = { x: (m.pos.x - p.pos.x) / d, y: (m.pos.y - p.pos.y) / d };
    moveWithCollision(state.map, m.pos, dir, cp.knockback, isWalkable);
  }
  if (cp.echoFrac > 0) {
    state.strikes.push({
      pos: { x: p.pos.x, y: p.pos.y }, // the ground remembers where you stood
      t: CONFIG.ultCataclysmAftermathDelay,
      ownerId: p.id,
      kind: "echo",
      radius: cp.radius,
      dmg: blastDmg * cp.echoFrac,
      knockback: 0,
      school: "magic",
    });
  }
  announce(state, "show", `${p.name} CRACKS THE FLOOR. Everything airborne is a highlight.`);
}

/** Bullet Time: the world slows; crawlers do not. Deep Focus stretches it. */
function doBulletTime(state: GameState, p: Player): void {
  p.cd.bullettime = CONFIG.ultBulletTimeCooldown;
  state.bulletTimeLeft = bulletTimeParams(p).duration;
  announce(state, "show", `${p.name} bends the broadcast frame rate. BULLET TIME.`);
}

/**
 * Cast the ability in a slot. One switch = the whole cast surface; adding an
 * ability means one case here + a registry entry in abilities.ts.
 */
function castAbility(state: GameState, p: Player, ability: AbilityId, aim: Vec2, move: Vec2): void {
  // Dash is charge-gated, not cooldown-gated: cd.dash is its recharge timer,
  // which may be ticking while a banked charge is still ready to spend.
  if (ability === "dash") {
    if (p.dashCharges > 0) doDash(state, p, move);
    return;
  }
  if ((p.cd[ability] ?? 0) > 0) return;
  switch (ability) {
    case "melee": doPlayerAttack(state, p, aim); break;
    case "bolt": doBolt(state, p, aim); break;
    case "nova": doNova(state, p); break;
    case "stance": doStance(state, p); break;
    case "overcharge": doOvercharge(state, p); break;
    case "orbit": break; // passive: runs via updateOrbit while slotted
    case "cutto": doCutTo(state, p, aim); break;
    case "crowdsurf": doCrowdSurf(state, p, aim); break;
    case "stuntdouble": doStuntDouble(state, p); break;
    case "airstrike": doAirstrike(state, p, aim); break;
    case "cataclysm": doCataclysm(state, p); break;
    case "bullettime": doBulletTime(state, p); break;
  }
}

// hasPassive lives in items.ts now (abilities.ts needs it too); re-exported
// so existing importers keep working.
export { hasPassive };

/** A player died; the run only ends when the whole party is down. */
export function handlePlayerDeath(state: GameState, p: Player, line: string): void {
  p.hp = 0;
  p.alive = false;
  p.reviveProgress = 0;
  announce(state, "progress", line);
  // RIVALS: death is a 15-second time-out, never a run end — the race only
  // ends when someone kills the final boss. Gear stays yours (rival kills pay
  // the killer XP instead; see pvpStrike).
  if (state.mode === "rivals") {
    p.downedT = CONFIG.rivalsReviveSeconds;
    announce(state, "progress", `${p.name} is DOWN — ${CONFIG.rivalsReviveSeconds} seconds on the contract clock.`);
    return;
  }
  if (alivePlayers(state).length === 0) {
    state.status = "dead";
    announce(state, "progress", "PARTY WIPE. The season finale nobody wanted. The crowd goes wild.", "high");
  } else {
    announce(state, "progress", `${p.name} is DOWN. Stand close to stabilize them.`);
  }
}

/** Drop a party ping at a world position (clamped into the map). Few per player. */
function addPing(state: GameState, p: Player, at: Vec2): void {
  const pos = {
    x: Math.max(0, Math.min(state.map.w - 1, at.x)),
    y: Math.max(0, Math.min(state.map.h - 1, at.y)),
  };
  const mine = state.pings.filter((pg) => pg.byId === p.id);
  if (mine.length >= CONFIG.pingMaxPerPlayer) {
    const oldest = mine.reduce((a, b) => (a.t < b.t ? a : b));
    state.pings.splice(state.pings.indexOf(oldest), 1);
  }
  state.pings.push({ id: state.nextEntityId++, pos, byId: p.id, t: CONFIG.pingTtl, total: CONFIG.pingTtl });
}

function updatePings(state: GameState, dt: number): void {
  for (const pg of state.pings) pg.t -= dt;
  state.pings = state.pings.filter((pg) => pg.t > 0);
}

/**
 * Co-op revives: a living crawler standing within reviveRadius of a downed one
 * stabilizes them by PROXIMITY (no button — the reviver pays in exposure, not
 * APM). Walking away lets the wound reopen. The descend-revive at 50% remains
 * the fallback; this is the mid-floor rescue.
 */
function updateRevives(state: GameState, dt: number): void {
  if (state.mode === "rivals") return; // rivals revive on their own timer (stepRivals)
  for (const down of state.players) {
    if (down.alive) continue;
    const medic = state.players.find(
      (pl) => pl.alive && pl.id !== down.id && dist(pl.pos, down.pos) <= CONFIG.reviveRadius,
    );
    if (!medic) {
      down.reviveProgress = Math.max(
        0, down.reviveProgress - (dt / CONFIG.reviveChannelSec) * CONFIG.reviveDecayMult,
      );
      continue;
    }
    if (down.reviveProgress === 0) state.events.push(`${medic.name} is stabilizing ${down.name}…`);
    down.reviveProgress += dt / CONFIG.reviveChannelSec;
    if (down.reviveProgress >= 1) {
      down.reviveProgress = 0;
      down.alive = true;
      down.hp = Math.max(1, Math.round(down.maxHp * CONFIG.reviveHpFraction));
      addHype(state, medic, CONFIG.show.hypeRevive);
      announce(state, "show", `${down.name} is BACK IN THE FIGHT — ${medic.name} with the save! The crowd erupts.`);
    }
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
        if (dist(pr.pos, m.pos) <= CONFIG.projectileRadius + bodyRadius(m)) {
          damageMonster(state, owner, m, pr.damage, {
            dir: normalize(pr.vel), knockback: CONFIG.boltKnockback,
            forceCrit: pr.crit, shatterPoise: pr.shatter, school: pr.school,
          });
          // Frost Bolts (5.11): the impact CHILLS — move + attack/windup speed
          // slowed. Bosses shrug off half the slow (meaningful, never immune).
          if (pr.chill && m.hp > 0) {
            applyStatus(m, {
              kind: "chill", duration: CONFIG.chillDuration, school: "magic",
              magnitude: m.kind === "boss" ? pr.chill * CONFIG.chillBossMult : pr.chill,
            });
          }
          // RICOCHET capstone: bounce once to a nearby enemy at 60% damage.
          if (rank(owner, "bolt.ricochet") > 0 && !pr.bounced) {
            let best: Monster | null = null;
            let bestD = 4.5;
            for (const o of state.monsters) {
              if (o === m || o.hp <= 0) continue;
              const d = dist(pr.pos, o.pos);
              if (d < bestD) { bestD = d; best = o; }
            }
            if (best) {
              const dir = normalize({ x: best.pos.x - pr.pos.x, y: best.pos.y - pr.pos.y });
              state.projectiles.push({
                id: state.nextEntityId++,
                pos: { x: pr.pos.x, y: pr.pos.y },
                vel: { x: dir.x * CONFIG.boltSpeed, y: dir.y * CONFIG.boltSpeed },
                damage: pr.damage * 0.6, ttl: 0.8, from: "player", ownerId: owner.id,
                bounced: true, hitIds: [m.id], school: pr.school, chill: pr.chill,
              });
            }
          }
          if (pr.pierce && pr.pierce > 0) {
            pr.pierce--;
            (pr.hitIds ??= []).push(m.id); // keep flying through
          } else {
            consumed = true;
          }
          break;
        }
      }
      // RIVALS: player bolts also strike rivals (a hit always consumes the
      // bolt — nobody pierces through a person, that's a different show).
      if (!consumed && state.mode === "rivals") {
        for (const v of rivalTargets(state, owner)) {
          if (dist(pr.pos, v.pos) <= CONFIG.projectileRadius + 0.35) {
            pvpStrike(state, owner, v, pr.damage, normalize(pr.vel));
            consumed = true;
            break;
          }
        }
      }
      if (consumed) continue;
    } else {
      // Enemy projectile: a stunt double bodily catches bolts first, then the
      // first living player in radius (dash = i-frames).
      let absorbed = false;
      for (const dc of state.decoys) {
        if (dist(pr.pos, dc.pos) > CONFIG.projectileRadius + 0.35) continue;
        dc.absorbed += pr.damage;
        state.hits.push({ pos: { x: dc.pos.x, y: dc.pos.y }, amount: Math.round(pr.damage), kind: "player" });
        absorbed = true;
        break;
      }
      if (!absorbed) for (const p of state.players) {
        if (!p.alive || p.dashTime > 0) continue;
        if (dist(pr.pos, p.pos) > CONFIG.projectileRadius + 0.3) continue;
        if (damagePlayerHit(state, p, pr.damage, { dir: normalize(pr.vel) })) {
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

  const intents: PartyIntents =
    "move" in intent ? { [state.players[0]?.id ?? 0]: intent as Intent } : (intent as PartyIntents);

  // RIVALS: several floor worlds run concurrently; each is mounted into the
  // classic slots and stepped with its own residents (see stepRivals).
  if (state.mode === "rivals") {
    stepRivals(state, intents, dt);
    return state;
  }

  stepFloor(state, intents, dt);
  return state;
}

/**
 * One floor's step: the classic sim body. In co-op this IS the game; in
 * rivals it runs once per mounted world with that floor's residents in
 * state.players. Every early return below scopes to this floor only.
 */
function stepFloor(state: GameState, intents: PartyIntents, dt: number): void {
  // The safe room is the one world-level pause in CO-OP: the whole party is
  // between floors. (Rivals never sets state.safeRoom — shops are personal
  // and the race keeps running; see tryDescendRival/setReady.)
  if (state.safeRoom) return;

  // Ringside introduction: the world holds its breath (players AND monsters)
  // while the banner plays, so the reveal can never be the thing that kills you.
  if (state.encounter) {
    state.encounter.timeLeft -= dt;
    if (state.encounter.timeLeft <= 0) state.encounter = null;
    return;
  }
  maybeStartEncounter(state);
  if (state.encounter) return;

  if (state.mode !== "rivals") state.elapsed += dt; // rivals adds ONCE, outside the world loop

  // Per-player: timers, movement, skills, attack — in stable id order so the
  // seeded RNG stream is reproducible regardless of intent-map key order.
  const ordered = [...state.players].sort((a, b) => a.id - b.id);
  for (const p of ordered) {
    const pi = intents[p.id] ?? NO_INTENT;

    // Status effects (5.11): DoT ticks route through the player choke point
    // (armor mitigates every tick); chill slows this crawler's whole combat
    // clock — movement below and cooldown recovery here both run on ptime.
    if (p.alive) {
      for (const due of tickStatuses(p, dt)) {
        if (!p.alive) break;
        if (damagePlayerHit(state, p, due.damage, { roll: false, effect: due.kind })) {
          handlePlayerDeath(state, p, due.kind === "poison"
            ? `${p.name} succumbed to the poison. The System sells antidotes, for the record.`
            : `${p.name} burned out of the season. Literally.`);
        }
      }
    }
    const ptime = statusTimeMult(p);

    // Adrenaline (Bullet Time fork) races cooldowns inside the slow; a chill
    // stretches them — both scale the same recovery clock.
    const cdt = (state.bulletTimeLeft > 0 ? dt * bulletTimeParams(p).cdTickMult : dt) * ptime;
    for (const key of Object.keys(p.cd) as AbilityId[]) {
      if ((p.cd[key] ?? 0) > 0) p.cd[key] = Math.max(0, (p.cd[key] ?? 0) - cdt);
    }
    // Swift Strikes momentum drops when the flurry pauses.
    if (p.meleeComboT > 0) {
      p.meleeComboT = Math.max(0, p.meleeComboT - dt);
      if (p.meleeComboT === 0) p.meleeCombo = 0;
    }
    // REPEAT OFFENDER window closes on its own.
    if (p.cutMark) {
      p.cutMark.t -= dt;
      if (p.cutMark.t <= 0) p.cutMark = null;
    }
    // Dash recharge: an expired timer banks a charge and, while still below
    // max, immediately starts refilling the next one.
    if (p.dashCharges < maxDashCharges(p) && (p.cd.dash ?? 0) <= 0) {
      p.dashCharges++;
      if (p.dashCharges < maxDashCharges(p)) p.cd.dash = dashParams(p).cooldown * cdMult(p);
    }
    if (p.attackSwing > 0) p.attackSwing = Math.max(0, p.attackSwing - dt);
    if (p.dashTime > 0) p.dashTime = Math.max(0, p.dashTime - dt);
    if (p.rootT > 0) p.rootT = Math.max(0, p.rootT - dt);
    if (p.novaFlash > 0) p.novaFlash = Math.max(0, p.novaFlash - dt);
    p.stanceTime += dt; // time-in-stance settles toward Discipline's threshold
    if (p.stanceSwapWindow > 0) p.stanceSwapWindow = Math.max(0, p.stanceSwapWindow - dt);

    // Knockback in flight: the shove consumes its distance first — it doesn't
    // cancel input, it just moves the ground under the argument.
    if (p.knock && p.alive) {
      const stepLen = Math.min(p.knock.left, CONFIG.knockbackSpeed * dt);
      moveWithCollision(state.map, p.pos, p.knock.dir, stepLen, isWalkable);
      p.knock.left -= stepLen;
      if (p.knock.left <= 1e-4) p.knock = undefined;
    }

    const move = pi.move;
    if ((move.x !== 0 || move.y !== 0) && p.alive) {
      const dir = normalize(move);
      p.facing = dir;
      // Root snare (boss roots zones): a heavy slow — dashing is unaffected.
      // Chill (ptime) and roots stack multiplicatively; both are escape tests.
      const speed = p.speed * (p.frenzy ? CONFIG.frenzyMoveMult : 1) * ptime * (p.rootT > 0 ? CONFIG.rootsSlowMult : 1);
      moveWithCollision(state.map, p.pos, dir, speed * dt, isWalkable);
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
        if (cast[s] && ability) castAbility(state, p, ability, aim, pi.move);
      }
      if (cast[ABILITY_SLOTS] && p.abilities.ultimate) {
        castAbility(state, p, p.abilities.ultimate, aim, pi.move);
        // Overtime Clause: the network wants MORE ultimates.
        const ult = p.abilities.ultimate;
        if (hasPassive(p, "overtime") && (p.cd[ult] ?? 0) > 0) {
          p.cd[ult] = (p.cd[ult] ?? 0) * 0.75;
        }
      }
      if (pi.flask) useFlask(state, p);
    }
    // Pings are allowed dead or alive — calling for help is content.
    if (pi.ping) addPing(state, p, pi.ping);
    updateOrbit(state, p, dt);
  }

  // Monsters + projectiles (bullet time slows the world, not the crawlers).
  // A CHILLED monster's clock runs slower still (5.11): movement, windups,
  // and cooldowns all stretch — same trick bullet time uses, per-monster.
  if (state.bulletTimeLeft > 0) state.bulletTimeLeft = Math.max(0, state.bulletTimeLeft - dt);
  const mdt = state.bulletTimeLeft > 0 ? dt * CONFIG.ultBulletTimeFactor : dt;
  for (const m of state.monsters) stepMonster(state, m, mdt * statusTimeMult(m));
  updateMonsterStatuses(state, mdt); // DoT burns on WORLD time (chill can't slow its own poison)
  updateHazards(state, mdt); // enemy-side blasts run on world (slowable) time
  updateCorpses(state, mdt);
  updateStrikes(state, dt);
  updateDecoys(state, dt);
  updateProjectiles(state, dt);

  reapDead(state);
  collectLoot(state);
  updatePings(state, dt);
  updateRevives(state, dt);

  // Floor event bookkeeping (vault trigger/reseal, challenge verdicts) —
  // after combat so it can read this step's deaths and damage.
  updateFloorEvent(state, dt);

  // Softlock self-healing: if the stairs key ever becomes unreachable (or a
  // crawler gets sealed in), the System concedes the door instead of ending
  // the run. Covers vectors no spawn-time guard can: anything that MOVES.
  auditKeyReachability(state, dt);

  // Collapse timer (applied after combat so its DoT can be the killing blow).
  if (state.status === "playing" && alivePlayers(state).length > 0) updateTimer(state, dt);

  // The Show: convert this step's hype into viewers / favorites / sponsors.
  updateShow(state, dt);

  // The System gets bored: flatlined broadcasts earn corrective content.
  updateInterference(state, dt);

  // Fog of war: reveal tiles around every living player.
  revealAround(state);

  // Level-ups earned this step open personal ability drafts (queued if several).
  if (state.status === "playing") {
    for (const p of ordered) {
      if (p.upgradeDraftsOwed > 0 && p.pendingUpgrades.length === 0) {
        // SERIES REGULAR deals an extra card into every level-up draft.
        const size = CONFIG.upgradeDraftSize + (hasRevision(p, "regular") ? CONFIG.revisionRegularExtraCards : 0);
        const offers = rollUpgradeDraft(state.rng, p, size, state.floor);
        if (offers.length > 0) {
          p.upgradeDraftsOwed--;
          p.pendingUpgrades = offers;
        } else {
          p.upgradeDraftsOwed = 0; // every node maxed — nothing to offer
        }
      }
    }
  }

  // Descent request from anyone on the stairs (opens the safe room; in
  // rivals, EVERY resident may descend this step — the race is individual).
  if (state.status === "playing" && !state.safeRoom) {
    for (const p of ordered) {
      const pi = intents[p.id] ?? NO_INTENT;
      if (pi.useStairs && p.alive) {
        if (state.mode === "rivals") {
          tryDescendRival(state, p);
          continue;
        }
        tryDescend(state, p);
        break;
      }
    }
  }

  // Achievements last, so they see everything this step did (kills, descent, buys).
  checkAchievements(state);
}

// ---- RIVALS: the competitive race (concurrent floor worlds) ----

/** Every per-floor GameState slot; mounting a world swaps these wholesale. */
const WORLD_FIELDS = [
  "floor", "rng", "map", "explored", "exploredVersion", "mapVersion",
  "monsters", "loot", "projectiles", "strikes", "bulletTimeLeft", "decoys",
  "hazards", "corpses", "pings", "encounter", "floorEvent", "goldSurge",
  "timeBudget", "timeRemaining", "phase", "collapseElapsed",
] as const;

function captureWorld(state: GameState): FloorWorld {
  const w = {} as Record<string, unknown>;
  for (const f of WORLD_FIELDS) w[f] = state[f];
  return w as unknown as FloorWorld;
}

function mountWorld(state: GameState, w: FloorWorld): void {
  for (const f of WORLD_FIELDS) (state as unknown as Record<string, unknown>)[f] = w[f];
}

/** Get (or lazily build) the world for a floor. Deterministic per (seed, floor). */
export function ensureWorld(state: GameState, floor: number): FloorWorld {
  const worlds = state.worlds!;
  if (worlds[floor]) return worlds[floor];
  const saved = captureWorld(state);
  const savedPlayers = state.players;
  state.players = []; // buildFloor resets residents; the arriving rival is placed by the caller
  buildFloor(state, floor);
  const built = captureWorld(state);
  worlds[floor] = built;
  state.players = savedPlayers;
  mountWorld(state, saved);
  return built;
}

/**
 * The rivals step: revive timers tick globally, then every ACTIVE world
 * (a floor with at least one non-shopping resident) is mounted and stepped
 * with exactly its residents. Announcements/hits from every floor share the
 * step buffers — each rival's client hears the whole race's drama.
 */
function stepRivals(state: GameState, intents: PartyIntents, dt: number): void {
  state.elapsed += dt;
  const worlds = state.worlds!;
  const roster = state.players;

  // Downed rivals tick toward their revive wherever they fell.
  for (const p of roster) {
    if ((p.reviveGraceT ?? 0) > 0) p.reviveGraceT = Math.max(0, (p.reviveGraceT ?? 0) - dt);
    if (!p.alive && (p.downedT ?? 0) > 0) {
      p.downedT = Math.max(0, (p.downedT ?? 0) - dt);
      if (p.downedT === 0) reviveRival(state, p);
    }
  }

  const floors = Object.keys(worlds).map(Number).sort((a, b) => a - b);
  for (const f of floors) {
    const residents = roster.filter((p) => p.floorNo === f && !p.safeRoom);
    if (residents.length === 0) continue;
    mountWorld(state, worlds[f]);
    state.players = residents;
    stepFloor(state, intents, dt);
    worlds[f] = captureWorld(state);
    state.players = roster;
    if (state.status !== "playing") break; // the contract has been secured
  }

  // Hosts read the classic slots directly: keep the local (first) player's
  // world mounted between steps. Server snapshots re-mount per client.
  const anchor = roster[0];
  const view = worlds[anchor?.floorNo ?? floors[0]] ?? worlds[floors[0]];
  if (view) mountWorld(state, view);

  // Worlds nobody can ever return to (every rival is past them) get dropped.
  const lowest = Math.min(...roster.map((p) => (p.safeRoom ? p.safeRoom.nextFloor : p.floorNo)));
  for (const f of floors) if (f < lowest) delete worlds[f];
}

/** Rivals descent: THIS crawler steps out of the race into their personal
 * shop; the world keeps running — shopping costs race time. */
function tryDescendRival(state: GameState, p: Player): void {
  if (dist(p.pos, state.map.stairs) > 1.0) {
    state.events.push("No stairs here. Find the stairs down.");
    return;
  }
  if (state.monsters.some((m) => m.kind === "boss")) {
    state.events.push("The boss seals the only way out. Put it down.");
    return;
  }
  // The final floor has no descent — the BOSS is the finish line.
  if (state.floor >= CONFIG.finalFloor) return;
  p.safeRoom = generateSafeRoom(state, state.floor + 1);
  announce(state, "progress", `${p.name} reaches the floor-${state.floor} safe room. The race does not wait.`);
  if (hasPassive(p, "ledger") && p.gold > 0) {
    const interest = Math.min(Math.round(p.gold * CONFIG.ledgerInterestFraction), CONFIG.ledgerInterestCap);
    if (interest > 0) {
      p.gold += interest;
      announce(state, "show", `${p.name}'s Ledger pays out: +${interest} gold in interest.`);
    }
  }
}

/** Rivals: leave the personal shop and drop onto the next floor's world. */
function leaveRivalSafeRoom(state: GameState, p: Player): void {
  const room = p.safeRoom;
  if (!room) return;
  const next = room.nextFloor;
  p.safeRoom = null;
  const w = ensureWorld(state, next);
  if (room.bonusTime) w.timeRemaining += room.bonusTime; // stabilizers help whoever's floor it is
  p.floorNo = next;
  const a = (p.id % 6) * (Math.PI * 2 / 6);
  p.pos = { x: w.map.spawn.x + Math.cos(a) * 0.5, y: w.map.spawn.y + Math.sin(a) * 0.5 };
  // Per-player floor reset (the slice of resetForFloor that is personal).
  p.facing = { x: 0, y: 1 };
  p.cd = {};
  p.dashTime = 0;
  p.dashCharges = maxDashCharges(p);
  p.flaskCharges = CONFIG.flaskMaxCharges;
  p.flaskKillProgress = 0;
  p.novaFlash = 0;
  p.attackSwing = 0;
  p.stanceTime = 0;
  p.stanceSwapWindow = 0;
  p.stanceCritReady = false;
  p.overcharged = false;
  p.plotArmorUsed = false;
  p.petUsed = false;
  p.statuses = [];
  announce(state, "progress", `${p.name} descends to floor ${next}. The standings shift.`);
  // Sponsor draft between floors, same as co-op's leaveSafeRoom rhythm —
  // milestone floors offer the CLASS REVISION instead.
  if ((CONFIG.revisionFloors as readonly number[]).includes(next)) {
    if (p.pendingRewards.length === 0) {
      p.pendingRewards = revisionChoices(state, p, next);
      if (p.pendingRewards.length > 0) {
        announce(state, "show", `LEVEL MILESTONE. A CLASS REVISION is available for ${p.name}. This offer will not be repeated.`);
      }
    }
  } else if (p.sponsors > 0 && p.pendingRewards.length === 0) {
    p.pendingRewards = generateRewards(state, p.id);
  }
}

/** The 15 seconds are up: back on your feet at the floor entry, briefly immune. */
function reviveRival(state: GameState, p: Player): void {
  const w = state.worlds?.[p.floorNo];
  p.alive = true;
  p.hp = Math.max(1, Math.round(p.maxHp * CONFIG.rivalsReviveHpFraction));
  p.reviveGraceT = CONFIG.rivalsReviveGraceSeconds;
  p.downedT = 0;
  p.statuses = [];
  if (w) p.pos = { x: w.map.spawn.x, y: w.map.spawn.y };
  announce(state, "show", `${p.name} is BACK. The System loves a comeback arc.`);
}

/**
 * PvP damage (rivals only): every player-damage source routes rival hits
 * through here. Tuned down by pvpDamageMult (builds are balanced against
 * telegraphed monsters; player attacks are instant). A killing blow pays the
 * attacker a BIG XP bounty that scales with the victim's level — dropping
 * the race leader is worth the detour.
 */
export function pvpStrike(
  state: GameState, attacker: Player, victim: Player, base: number, dir?: Vec2,
): boolean {
  if (state.mode !== "rivals" || attacker.id === victim.id) return false;
  if (!victim.alive || (victim.reviveGraceT ?? 0) > 0 || victim.safeRoom) return false;
  const dead = damagePlayerHit(state, victim, base * CONFIG.pvpDamageMult, { dir });
  if (dead) {
    const bounty = CONFIG.pkXpBase + victim.level * CONFIG.pkXpPerLevel;
    announce(state, "show",
      `CONTRACT DISPUTE: ${attacker.name} drops ${victim.name}! The sponsors pay ${bounty} XP for the highlight.`, "high");
    addHype(state, attacker, CONFIG.show.hypeBoss / 2);
    grantXp(state, attacker, bounty);
    handlePlayerDeath(state, victim, `${victim.name} lost the exchange. ${CONFIG.rivalsReviveSeconds} seconds on the clock.`);
  }
  return dead;
}

/** Living, hittable rivals sharing the attacker's mounted floor. */
function rivalTargets(state: GameState, attacker: Player): Player[] {
  if (state.mode !== "rivals") return [];
  return state.players.filter(
    (v) => v.id !== attacker.id && v.alive && (v.reviveGraceT ?? 0) <= 0 && !v.safeRoom && v.dashTime <= 0,
  );
}

/** Unlock any achievement whose condition now holds for a player; announce + pay out. */
function checkAchievements(state: GameState): void {
  if (!CONFIG.achievementsEnabled) return;
  for (const p of state.players) {
    // Big moments (boss kills, level bursts) unlock several at once — collect
    // them and announce one combined line so the toast layer isn't flooded.
    const unlocked: (typeof ACHIEVEMENTS)[number][] = [];
    for (const a of ACHIEVEMENTS) {
      if (p.achievements.includes(a.id)) continue;
      if (!a.test(state, p)) continue;
      p.achievements.push(a.id);
      p.gold += a.gold;
      if (a.hype > 0) addHype(state, p, a.hype);
      unlocked.push(a);
    }
    if (unlocked.length === 1) {
      const a = unlocked[0];
      const payout = a.gold > 0 ? ` Reward: ${a.gold} gold.` : "";
      announce(state, "achievement", `ACHIEVEMENT (${p.name}): ${a.title} — ${a.desc}${payout}`);
    } else if (unlocked.length > 1) {
      const gold = unlocked.reduce((sum, a) => sum + a.gold, 0);
      const payout = gold > 0 ? ` Reward: ${gold} gold.` : "";
      const titles = unlocked.map((a) => a.title).join(", ");
      announce(state, "achievement", `${unlocked.length} ACHIEVEMENTS (${p.name}): ${titles}.${payout}`);
      // The log still gets each unlock's full description.
      for (const a of unlocked) state.events.push(`ACHIEVEMENT (${p.name}): ${a.title} — ${a.desc}`);
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
