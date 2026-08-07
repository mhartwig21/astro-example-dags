import { ARCHETYPES, CHAMPIONS, CONFIG, FLOOR_BANDS, PACK_TEMPLATES, floorBand, floorTimeBudget, monsterTempo, roamTribeId, xpForLevel, type MonsterArchetype } from "./config";
import { generateFloor, isWalkable, sealRoomOnMap, tileAt, walkableTiles } from "./floor";
import { createRng, nextFloat, nextInt, chance, pick, type Rng } from "./rng";
import { angleBetween, armorReduction, dist, mitigate, normalize, rollDamage, turnToward } from "./combat";
import { moveWithCollision } from "./movement";
import { alertMonster, separateMonsters, springAmbush, stepMonster } from "./ai";
import {
  catalogQualityAffixes, generateItem, hasPassive, itemScore, makeQualityCatalogItem, rollCatalogDrop, wantsAutoEquip,
} from "./items";
import {
  GLYPH_IDS, GLYPH_INFO, defaultGlyphs, glyphHitMult, glyphMatches, glyphPoiseMult, glyphSocketCount,
  glyphWindow, hasGlyph, socketLegal, totalSocketsOpen, type GlyphId,
} from "./glyphs";
import {
  applyRoamSave, breakablePosKey, creditCachePickup, creditQuestKill, npcsOf, playerInSettlement,
  settlementShopFor, spawnSettlement, startDialogue, updateRoam, type RoamSaveState,
} from "./npc";
import {
  BOSS_UNIQUES, CATALOG, CATALOG_BY_ID, consumablePrice, consumableStock, gearAffixes, tierStockCount, totalCost,
  type CatalogEntry,
} from "./catalog";
import {
  ABILITY_INFO, ABILITY_SLOTS, DISCOVERABLE_ABILITIES, UPGRADES, airstrikeParams, boltParams, bulletTimeParams,
  bulwarkParams, cablesParams, injunctionParams,
  castSchool, crowdSurfParams, cutToParams, stuntDoubleParams,
  cataclysmParams, damageVariance, dashParams, knows, meleeParams,
  rank,

  novaParams, orbitBladePos, orbitHurlPoint, orbitParams, overchargeParams, power, rollUpgradeDraft, slotted, stanceMult,
  stanceParams, stanceStrikePower, startingLoadout,
  unknownAbilities, upgradeDef, type AbilityId, type School, type UpgradeDef,
} from "./abilities";
import {
  bandForBossFloor, bandSignatureLabel, bossDef, bossMutatorInfo, drawBossEncounter,
  type BossDef,
} from "./bosses";
// (bossDef is the roster lookup for name cards; drawBossEncounter is the draw)
import { ACHIEVEMENTS } from "./achievements";
import { REVISIONS, revisionPool } from "./revisions";
import { PURPOSE_RESIDENTS, RESIDENT_LINES, STORY_LINES, assignRoomPurposes } from "./roomPurposes";
// (service verbs ride the same plan: plan.service marks the open room)
import { TIPS } from "./tips";
import {
  DAILY_RULES, ruleBossDamageMult, ruleCollapseMult, ruleEliteSeverance,
  ruleGoldMult, ruleSecondElite, type DailyRuleId,
} from "./dailyRules";
import { defsFor } from "../content/mobs";
import { applyStatus, statusTimeMult, tickStatuses } from "./status";
import type {
  Announcement, AnnouncementKind, Breakable, Decoy, BossEvent, BossId,
  BossPhaseReason, BossPlate, BossSignature, EliteAffix, Equipment, FloorWorld, GameState, HitEvent, Intent, Item, ItemSlot, Loot,
  Hazard, MaterialId, Monster, MonsterKind, Npc, PartyIntents, Player, Rarity, Reward, SafeRoom, StatusKind, Vec2,
} from "./types";
import { EQUIP_SLOTS, NO_INTENT, Tile } from "./types";
import { dasin, datan2, dcos, dhypot, dpow, dsin } from "./dmath";

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
  if (state.runKind === "roam") {
    // Density scales with the floor's actual walkable area instead of a flat
    // per-floor formula — Roam floors are much bigger than Race's.
    return Math.round(walkableTiles(state.map).length * CONFIG.roamMonsterDensity * mpMult);
  }
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
  const compound = dpow(CONFIG.monsterScaleCompound, Math.max(0, floor - CONFIG.monsterScaleCompoundFrom));
  // The BUILD CHECK: floors past deepScaleCompoundFrom ramp again — the last
  // two bands demand a coherent build, not just a leveled crawler (config.ts).
  const deep = dpow(CONFIG.deepScaleCompound, Math.max(0, floor - CONFIG.deepScaleCompoundFrom));
  const baseHp = (CONFIG.monsterBaseHp + (floor - 1) * CONFIG.monsterHpPerFloor) * mpHp * compound * deep;
  const baseDmg = (CONFIG.monsterBaseDamage + (floor - 1) * CONFIG.monsterDamagePerFloor) * mpDmg * compound * deep;
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
    staggerGraceT: 0,
    hitFlash: 0,
  };
  // Kind-intrinsic extras (not elite rolls): the drum IS the drummer.
  if (kind === "drummer") m.aura = "frenzy";
  if (kind === "darling") m.aura = "shield";
  if (kind === "filcher") {
    m.carry = Math.round(CONFIG.filcherGoldBase + CONFIG.filcherGoldPerFloor * floor);
    m.bleedStage = 3;
  }
  // Every toy soldier belongs to SOME squad — a stray gets a squad of one
  // (ragged solo shots); pack spawning overwrites with the shared squadId.
  if (kind === "toysoldier") m.squadId = state.nextEntityId++;
  // CRAFTED ENEMIES (builder.html → src/content/mobs): a def registered for
  // this behavior + band may substitute — same brain, different body and
  // numbers. The roll is data-gated (no rng draw when no def applies), so
  // floors without matching defs replay exactly as before.
  const candidates = defsFor(kind, floorBand(floor));
  if (candidates.length > 0) {
    const vanillaWeight = 2; // the stock archetype stays the common sight
    const total = vanillaWeight + candidates.reduce((s, d) => s + (d.weight ?? 1), 0);
    let roll = nextFloat(state.rng) * total - vanillaWeight;
    for (const d of candidates) {
      roll -= d.weight ?? 1;
      if (roll < 0) {
        m.defId = d.id;
        m.hp = m.maxHp = Math.round(m.hp * (d.hpMult ?? 1));
        m.damage *= d.damageMult ?? 1;
        m.speed *= d.speedMult ?? 1;
        m.xp = Math.round(m.xp * (d.xpMult ?? 1));
        if (d.name) m.eliteName = d.name;
        break;
      }
    }
  }
  return m;
}

/** The middle rung of the power ladder: a pack anchor that has SURVIVED down
 * here. Bigger silhouette, real HP, a real hit, triple XP — no name, no
 * affix, no announcement (fanfare is the elite's job; the veteran just takes
 * 3-5 on-curve swings to die while its pack dies in one). */
function promoteVeteran(m: Monster): void {
  m.veteran = true;
  m.hp = m.maxHp = Math.round(m.maxHp * CONFIG.veteranHpMult);
  m.damage = Math.round(m.damage * CONFIG.veteranDmgMult);
  m.speed *= CONFIG.veteranSpeedMult;
  m.xp = Math.round(m.xp * CONFIG.veteranXpMult);
}

/** Pack kinds that can carry the veteran anchor: real fighters only — props,
 * parades, and support castes keep their own acts. */
function canVeteran(kind: MonsterKind): boolean {
  return kind !== "toysoldier" && kind !== "greeter" && kind !== "shaman" &&
    kind !== "necromancer" && kind !== "broodmother" && kind !== "drummer" &&
    kind !== "suitguy";
}

/** Pick an archetype mix that gets nastier with depth. */
function rollArchetype(rng: Rng, floor: number): MonsterKind {
  // Deeper floors shift the mix toward brutes/ranged/swarms, then unlock the
  // specialists: bombers (floor 2+), chargers (3+), shamans (4+), spitters
  // (5+), phantoms (6+), necromancers (7+).
  const rangedW = 1 + floor * 0.5;
  // VANILLA HEFT (owner 2026-07-26, after the veteran pass): D2-style — some
  // ordinary kinds are just TOUGHER, learnable by silhouette, no tier badge.
  // The heavies existed (brute 2.6x, warden 2.2x, colossus 2.8x, slagbreaker
  // 3.0x) but the weights buried them at ~8-14% of spawns; they now carry
  // ~25% of the mix from floor 2-3 on, pinned by the HEFT MIX contract.
  const bruteW = floor >= 2 ? floor * 0.7 : 0;
  const swarmW = 2 + floor * 0.3;
  const gruntW = 5;
  const bomberW = floor >= 2 ? floor * 0.3 : 0;
  const shamanW = floor >= 4 ? floor * 0.25 : 0;
  const phantomW = floor >= 6 ? floor * 0.3 : 0;
  const chargerW = floor >= 3 ? floor * 0.45 : 0;
  const spitterW = floor >= 5 ? floor * 0.25 : 0;
  const necroW = floor >= 7 ? floor * 0.2 : 0;
  const broodW = floor >= 5 ? floor * 0.25 : 0; // the nests move in mid-run
  // THE UNDERCROFT trainers (2+): floor 1 stays pristine — the contract floor.
  const crypt = floor >= CONFIG.undercroftFromFloor;
  const cutW = crypt ? Math.max(0.8, floor * 0.25) : 0;
  const wardW = crypt ? Math.max(1.2, floor * 0.35) : 0; // the band's vanilla heavy
  const digW = crypt ? Math.max(0.7, floor * 0.2) : 0;
  // THE RUINS (10+): the dead civilization drills you — walls, blessings,
  // beams, and the furniture itself.
  const ruins = floor >= CONFIG.ruinsFromFloor;
  const bearW = ruins ? floor * 0.3 : 0;
  const clericW = ruins ? floor * 0.2 : 0;
  const archW = ruins ? floor * 0.22 : 0;
  const colW = ruins ? floor * 0.25 : 0; // the band's vanilla heavy
  // THE GARDEN (7+): the floor fights back — hooks, morphs, and marks.
  const garden = floor >= CONFIG.gardenFromFloor;
  const lashW = garden ? floor * 0.25 : 0;
  const understudyW = garden ? floor * 0.3 : 0;
  const hexW = garden ? floor * 0.2 : 0;
  // THE IRONWORKS (13+): the machine shift clocks in — robots, turret-bots,
  // steam brutes, and prop-mimic greeters join the mix for the band.
  const iron = floor >= CONFIG.ironworksFromFloor;
  const lineW = iron ? floor * 0.45 : 0;
  const sentW = iron ? floor * 0.3 : 0;
  const slagW = iron ? floor * 0.28 : 0; // the band's vanilla heavy
  const greetW = iron ? floor * 0.22 : 0;
  const toyW = iron ? floor * 0.25 : 0; // a roll = a whole squad (see spawnMonsters)
  // THE APPROACH (16+): the System fields its own. (The suitguy never rolls —
  // he only ever crawls out of a dead suitactor.)
  const approach = floor >= CONFIG.approachFromFloor;
  const stageW = approach ? floor * 0.25 : 0;
  const snipW = approach ? floor * 0.2 : 0;
  const duelW = approach ? floor * 0.25 : 0;
  const darlW = approach ? floor * 0.12 : 0;
  const cancW = approach ? floor * 0.1 : 0;
  const suitW = approach ? floor * 0.18 : 0;
  const total = gruntW + swarmW + rangedW + bruteW + bomberW + shamanW + phantomW + chargerW + spitterW + necroW + broodW
    + cutW + wardW + digW + lashW + understudyW + hexW + bearW + clericW + archW + colW
    + lineW + sentW + slagW + greetW + toyW
    + stageW + snipW + duelW + darlW + cancW + suitW;
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
  if ((r -= cutW) < 0) return "cutpurse";
  if ((r -= wardW) < 0) return "warden";
  if ((r -= digW) < 0) return "digger";
  if ((r -= lashW) < 0) return "lasher";
  if ((r -= understudyW) < 0) return "understudy";
  if ((r -= hexW) < 0) return "hexer";
  if ((r -= bearW) < 0) return "shieldbearer";
  if ((r -= clericW) < 0) return "cleric";
  if ((r -= archW) < 0) return "archivist";
  if ((r -= colW) < 0) return "colossus";
  if ((r -= lineW) < 0) return "lineworker";
  if ((r -= sentW) < 0) return "sentinel";
  if ((r -= slagW) < 0) return "slagbreaker";
  if ((r -= greetW) < 0) return "greeter";
  if ((r -= toyW) < 0) return "toysoldier";
  if ((r -= stageW) < 0) return "stagehand";
  if ((r -= snipW) < 0) return "sniper";
  if ((r -= duelW) < 0) return "duelist";
  if ((r -= darlW) < 0) return "darling";
  if ((r -= cancW) < 0) return "canceled";
  if ((r -= suitW) < 0) return "suitactor";
  return "brute";
}

// Seeded flavor names for neighborhood/city bosses (DCC loves a named menace).
const ELITE_NAMES = [
  "The Gutter King", "Foreman Grizz", "Mama Fangs", "The Rent Collector",
  "Skitters Prime", "Old Chompy", "The Block Captain", "Sewer Baron Vex",
  "Knuckles the Landlord", "The HOA President",
];
// BOSSES V2: the fixed BAND_BOSSES array is gone. A band's identity is now
// DRAWN from a three-strong pool (src/sim/bosses.ts) using a dedicated hash of
// (runSeed, band) — see applyBossDraw below.

/** Signatures RETROFIT can swap in (the mutator's whole point is that the
 *  telegraph is unfamiliar on a familiar body). */
const RETROFIT_SIGNATURES: BossSignature[] = ["graverising", "flood", "roots", "debris", "flamewall"];

/** The aide roster for the council-format bosses (The Zoning Board / The
 *  Standards and Practices Board). Each carries ONE shipped support verb, so
 *  the kill order is legible from the intro: whichever one you leave standing
 *  is the verb you fight for the rest of the encounter. */
const BOARD_AIDES: { kind: MonsterKind; name: string }[] = [
  { kind: "cleric", name: "MEMBER: CONSECRATION" },
  { kind: "hexer", name: "MEMBER: VARIANCE" },
  { kind: "shieldbearer", name: "MEMBER: SETBACK" },
  { kind: "sentinel", name: "MEMBER: SURVEY" },
  { kind: "duelist", name: "MEMBER: APPEALS" },
];

/**
 * Push a typed boss beat for the presentation layer (BOSSES-V2 §5). The sim
 * never reads this channel back — it is the boss-fight sibling of state.hits.
 */
export function bossEvent(state: GameState, e: BossEvent): void {
  (state.bossEvents ??= []).push(e);
}

/**
 * V9 + V10 + §4.3 — stamp a drawn identity onto a freshly-made boss body.
 * Everything here is derived from the PURE draw (bosses.ts), so a coop client
 * restoring a snapshot and a fresh local run agree to the field.
 *
 * Deliberately RNG-free: the whole point of the dedicated hash is that adding
 * eighteen bosses does not re-roll a single existing spawn fixture.
 */
function applyBossDraw(state: GameState, boss: Monster, floor: number): BossDef {
  const draw = drawBossEncounter(state.seed, floor, state.bossPrevLineup, state.bossDefeats);
  const def = draw.def;
  (state.bossLineup ??= {})[String(def.band)] = def.id;
  state.arenaVariant = draw.arena;
  boss.bossId = def.id;
  boss.eliteName = def.name;
  boss.signature = def.signature;
  boss.maxPhase = def.maxPhase ?? 2;
  if (draw.mutators.length > 0) boss.bossMutators = [...draw.mutators];
  if (def.hpMult) boss.hp = boss.maxHp = Math.max(1, Math.round(boss.maxHp * def.hpMult));
  if (def.dmgMult) boss.damage *= def.dmgMult;
  // A FIXTURE, not a creature: the Grease Trap never takes a step, so its
  // whole threat has to be pull + adds + the ground. The anti-kite ramp is
  // meaningless for it and simply never engages (speed 0).
  if (def.stationary) boss.speed = 0;
  // RETROFIT: a familiar boss with an unfamiliar telegraph. Deterministic —
  // the swap is part of the encounter identity, not a per-step coin flip.
  if (boss.bossMutators?.includes("retrofit") && def.signature) {
    const others = RETROFIT_SIGNATURES.filter((s) => s !== def.signature);
    boss.signature = others[def.band % others.length];
  }
  // V1 — plates. Pools scale off the boss's own HP so they track the band
  // budget without a per-band table. A plate with a school IGNORES it.
  if (def.plates && def.plates.length > 0) {
    boss.plates = def.plates.map((p, i) => ({
      key: p.key,
      label: p.label,
      hp: Math.max(1, Math.round(boss.maxHp * CONFIG.plateHpFraction)),
      maxHp: Math.max(1, Math.round(boss.maxHp * CONFIG.plateHpFraction)),
      angle: (i / def.plates!.length) * Math.PI * 2,
      school: p.school,
    }));
  }
  // V2 — the shield pool. The Sponsor's is bigger and school-locked.
  if (def.shield) {
    const frac = def.shieldSchool ? CONFIG.sponsorShieldFraction : CONFIG.shieldFraction;
    boss.shieldMax = Math.max(1, Math.round(boss.maxHp * frac));
    boss.shieldHp = boss.shieldMax;
    boss.shieldSchool = def.shieldSchool;
  }
  // §4.4 — ESCALATION ON REPEAT. A boss you have already put down does not
  // wait to respect you: it opens at the phase-2 kit. Mechanics, never stats.
  if (draw.defeats >= CONFIG.bossRepeatEscalateAt) {
    boss.phase = 1;
    boss.speed *= CONFIG.bossPhaseSpeedMult;
  }
  return def;
}

/**
 * Council format without a new spawn shape (§3.3 / §3.6): the Board body is
 * shielded while any AIDE stands, and each aide's death hands its verb to the
 * body. Placement is deterministic (a ring by index) so no RNG is consumed.
 */
function spawnBossAides(state: GameState, boss: Monster, count: number): void {
  for (let i = 0; i < count; i++) {
    const entry = BOARD_AIDES[i % BOARD_AIDES.length];
    const a = (i / count) * Math.PI * 2;
    let pos = { x: boss.pos.x + dcos(a) * 2.6, y: boss.pos.y + dsin(a) * 2.6 };
    if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: boss.pos.x, y: boss.pos.y };
    const aide = makeMonster(state, entry.kind, pos);
    aide.hp = aide.maxHp = Math.round(aide.maxHp * CONFIG.boardAideHpMult);
    aide.eliteName = entry.name; // named, but NOT elite — no second ringside intro
    aide.tetherId = boss.id;
    aide.xp = Math.max(1, Math.round(aide.xp * 0.5));
    state.monsters.push(aide);
  }
}

// Affix pool for named elites (floor eliteAffixFromFloor+). One roll per elite.
const ELITE_AFFIXES: EliteAffix[] = [
  "swift", "shielded", "volatile", "summoner", "splitter", "thorns",
  "armored", "warded", "chilling",
  // The six-pack (MOB-CONCEPTS.md): each one sentence of counterplay.
  "linked", "vampiric", "juggernaut", "mortar", "berserking", "executioner",
];

/** One elite-affix roll. Deep floors (past deepScaleCompoundFrom) lean into
 * the RESIST affixes at deepResistBias — part of the build check: mono-school
 * stat soup without a second answer gets checked, not just outstatted. */
function rollEliteAffix(rng: Rng, floor: number): EliteAffix {
  if (floor > CONFIG.deepScaleCompoundFrom && chance(rng, CONFIG.deepResistBias)) {
    return chance(rng, 0.5) ? "armored" : "warded";
  }
  return pick(rng, ELITE_AFFIXES);
}

/** A band-end boss arena floor (3, 6, 9, 12, 15 — never the final floor). */
export function isCityBossFloor(floor: number): boolean {
  return floor < CONFIG.finalFloor && floor >= CONFIG.bossFloorEvery && floor % CONFIG.bossFloorEvery === 0;
}

function spawnMonsters(state: GameState): void {
  const { map, rng, floor } = state;
  const tiles = walkableTiles(map).filter(
    (t) => dist(t, map.spawn) > 6 && dist(t, map.stairs) > 2,
  );

  // Floor 18 is the FINAL boss arena: one boss + a few ranged adds. Roam
  // floors regenerate open-endedly past 18 with no boss roster to draw from
  // out there, and floor.ts never carves a boss arena for them — this check
  // must agree, or a "boss" spawns into an ordinary room with no sealed exit.
  if (state.runKind !== "roam" && floor >= CONFIG.finalFloor) {
    const bossPos = { x: map.stairs.x, y: map.stairs.y };
    const boss = makeMonster(state, "boss", bossPos);
    boss.hp = boss.maxHp = Math.round(CONFIG.bossHp * (1 + extraPlayers(state) * CONFIG.mpBossHpPerExtraPlayer));
    boss.damage = CONFIG.bossDamage * (1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer)
      * ruleBossDamageMult(state.dailyRule); // TODAY'S RULE — HAIR TRIGGER
    boss.speed = CONFIG.bossSpeed;
    boss.xp = CONFIG.bossXp;
    boss.bossTier = 3; // Ground Slam + Call for Backup + Dark Ritual — the full kit
    // BOSSES V2: the finale finally has a NAME (three of them, drawn).
    const finaleDef = applyBossDraw(state, boss, floor);
    state.monsters.push(boss);
    if (finaleDef.aides) spawnBossAides(state, boss, finaleDef.aides);
    for (let i = 0; i < 3 && tiles.length > 0; i++) {
      const pos = tiles.splice(nextInt(rng, 0, tiles.length - 1), 1)[0];
      state.monsters.push(makeMonster(state, "ranged", pos));
    }
    announce(state, "boss", `THE APPROACH ENDS HERE: ${boss.eliteName} holds floor ${floor}. ${finaleDef.line}`, "high");
    return;
  }

  // BAND BOSS floors (every band-end: 3, 6, 9, 12, 15): a sealed arena —
  // boss + escorts + a thinner regular crowd. Each arena's boss carries its
  // band's SIGNATURE mechanic on top of the shared kit; the tier ladder
  // (Ground Slam and its haste) climbs with depth, and the floor-3 opener
  // stays tier-0 gentle. The stairs stay sealed until the boss falls.
  if (state.runKind !== "roam" && isCityBossFloor(floor)) {
    const boss = makeMonster(state, "boss", { x: map.stairs.x, y: map.stairs.y });
    const arena = Math.floor(floor / CONFIG.bossFloorEvery); // 1..5
    const hp = CONFIG.bandBossHp[arena - 1] *
      (1 + extraPlayers(state) * CONFIG.mpBossHpPerExtraPlayer);
    boss.hp = boss.maxHp = Math.round(hp);
    boss.damage = CONFIG.bossDamage * CONFIG.bandBossDmgMult[arena - 1] *
      (1 + extraPlayers(state) * CONFIG.mpDamagePerExtraPlayer)
      * ruleBossDamageMult(state.dailyRule); // TODAY'S RULE — HAIR TRIGGER
    boss.speed = CONFIG.bossSpeed;
    boss.xp = Math.round(CONFIG.bossXp * CONFIG.bandBossXpMult[arena - 1]);
    // Tier ladder: floor 3 has no slam (early-game), 6/9 slam, 12/15 slam faster.
    boss.bossTier = floor >= 12 ? 2 : floor >= 6 ? 1 : undefined;
    // BOSSES V2: name, signature, plates, shield, mutators and arena all come
    // from the seeded draw — this is the line that ends "the same six bosses,
    // in the same order, every run".
    const bandDef = applyBossDraw(state, boss, floor);
    state.monsters.push(boss);
    if (bandDef.aides) spawnBossAides(state, boss, bandDef.aides);
    // ENTOURAGED: a champion-grade escort arrives with it. Split attention.
    if (boss.bossMutators?.includes("entouraged")) {
      const escort = makeMonster(state, "foreman", { x: boss.pos.x + 2, y: boss.pos.y });
      escort.hp = escort.maxHp = Math.round(escort.maxHp * 1.6);
      escort.elite = true;
      escort.eliteName = "THE ENTOURAGE";
      // No SECOND ringside banner: the boss's intro is the beat, and the
      // mutator line already named the escort (announcement etiquette).
      escort.introduced = true;
      state.monsters.push(escort);
    }
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
    const mutTag = (boss.bossMutators ?? []).map((x) => `[${bossMutatorInfo(x).label}]`).join(" ");
    announce(state, "boss", `CITY BOSS: ${boss.eliteName}${mutTag ? " " + mutTag : ""} holds floor ${floor}. The exit is SEALED. Ratings, Crawlers.`, "high");
    for (const mut of boss.bossMutators ?? []) {
      const info = bossMutatorInfo(mut);
      announce(state, "boss", `${info.label}: ${info.note}`);
    }
    return;
  }

  // Ordinary floors: INTENT-DRIVEN spawning (mission-lite). The entrance is
  // safe, encounter density ramps along the critical path, the landmark hall is
  // the hottest room and hosts the neighborhood boss, and the vault detour holds
  // a lone guardian standing over guaranteed treasure.
  const roam = state.runKind === "roam";
  // Roam: the floor's tribe IS its band (roamTribeId tracks floorBand, same
  // clamp themeForFloor uses) — ordinary spawns roll the SAME archetypes
  // Race would for this band; every monster created below just additionally
  // gets tagged with the tribe id for quest kill-credit.
  const tribeId = roam ? roamTribeId(floor) : undefined;
  const count = monsterCount(state, floor);
  const inRoom = (i: number): Vec2 | null => {
    const r = map.rooms[i];
    for (let tries = 0; tries < 12; tries++) {
      const x = nextInt(rng, r.x, r.x + r.w - 1) + 0.5;
      const y = nextInt(rng, r.y, r.y + r.h - 1) + 0.5;
      if (!isWalkable(map, x, y)) continue; // Floor only, and never inside furniture
      if (dist({ x, y }, map.spawn) <= 6 || dist({ x, y }, map.stairs) <= 2) continue;
      return { x, y };
    }
    return null;
  };
  const weights = map.rooms.map((r, i) => {
    const role = map.roles[i];
    if (role === "entrance" || role === "vault" || role === "settlement" || role === "stronghold") return 0;
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

  // OCCUPANCY (vignette grammar phase 3): dressed rooms are USED rooms.
  // The same pure assignment the renderer dresses from tells the sim where
  // each room's furniture stands — a pack that spawns in the mess hall
  // gathers AT the table instead of scattering. Spawn-safety rules still
  // apply (the social anchor is skipped if it sits too near spawn/stairs).
  const dressings = assignRoomPurposes(state.seed, floor, map).dressings;
  const dressingByRoom = new Map(dressings.map((d) => [d.roomIdx, d] as const));
  const socialAnchor = new Map(
    dressings
      .filter((d) => d.anchor && dist(d.anchor, map.spawn) > 6 && dist(d.anchor, map.stairs) > 2)
      .map((d) => [d.roomIdx, d.anchor!] as const),
  );

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
      if (roam) lone.tribe = tribeId;
      // Lone WANDERERS live up to the name — except greeters, whose whole act
      // is standing perfectly still among the props until you get close.
      if (lone.kind === "greeter") lone.dormant = true;
      else lone.roams = true;
      state.monsters.push(lone);
      budget--;
    }
  }
  let guard = 0;
  while (budget > 0 && totalW > 0 && guard++ < 60) {
    const roomIdx = pickRoom();
    let anchor = inRoom(roomIdx);
    if (!anchor) continue;
    const dressing = dressingByRoom.get(roomIdx);
    // Looted and scarred rooms tell a story of ABSENCE: whatever lived here
    // is gone or dead, so half the packs that would spawn here live
    // elsewhere instead (budget unspent — the loop re-rolls another room).
    if (dressing && (dressing.condition === "looted" || dressing.condition === "scarred") && chance(rng, 0.5)) {
      continue;
    }
    // The resident pack of a dressed room stands where the furniture is.
    const social = socialAnchor.get(roomIdx);
    if (social) anchor = { x: social.x, y: social.y };
    // THE PACK PLAYBOOK (MOB-CONCEPTS.md): a share of pack rolls spawn a
    // DESIGNED encounter for this band — one mob's ability set up by
    // another's, choreographed by formation offsets. Budget-neutral: the
    // template spends the same monster budget a rolled pack would have.
    // Floors 1-2 stay template-free: the balance contract clears BOTH, and a
    // clustered Reception on floor 2 proved hotter than loose trainers.
    if (floor >= 3 && chance(rng, CONFIG.packTemplateChance)) {
      const bandTemplates = PACK_TEMPLATES[floorBand(floor)];
      const template = bandTemplates[nextInt(rng, 0, bandTemplates.length - 1)];
      if (template.members.length <= budget) {
        const squadId = state.nextEntityId++; // toysoldier members share it
        for (const member of template.members) {
          let pos = { x: anchor.x + member.dx, y: anchor.y + member.dy };
          if (!isWalkable(map, pos.x, pos.y)) pos = { x: anchor.x, y: anchor.y };
          if (!isWalkable(map, pos.x, pos.y)) pos = { x: anchor.x + 1, y: anchor.y }; // the table itself blocks now
          const m = makeMonster(state, member.kind, pos);
          if (roam) m.tribe = tribeId;
          if (member.kind === "toysoldier") m.squadId = squadId;
          if (member.kind === "greeter") m.dormant = true;
          state.monsters.push(m);
          budget--;
        }
        continue;
      }
    }
    const size = Math.min(budget, nextInt(rng, CONFIG.packSizeMin, CONFIG.packSizeMax));
    // OCCUPANCY v2: a dressed room's pack usually draws from its RESIDENTS —
    // the ossuary keeps its necromancer, the barracks its garrison.
    const residents = dressing ? PURPOSE_RESIDENTS[dressing.purposeId] : undefined;
    const kind = residents && chance(rng, 0.7)
      ? residents[nextInt(rng, 0, residents.length - 1)]
      : rollArchetype(rng, floor);
    const escort = floor >= CONFIG.packEscortFromFloor && kind !== "shaman" && chance(rng, 0.3);
    // Deep-floor AMBUSH: a share of packs lie dormant in the fog and spring as
    // one when a player wanders in (see stepMonster). A ranged/support pack
    // makes a poor ambush, so this favors melee kinds that benefit from
    // surprise — plus the greeter, whose entire act is being furniture.
    const canAmbush =
      kind !== "ranged" && kind !== "shaman" && kind !== "spitter" &&
      kind !== "necromancer" && kind !== "broodmother" && kind !== "toysoldier" &&
      kind !== "sentinel";
    const ambush =
      kind === "greeter" || // greeters ALWAYS spawn dormant: props until they aren't
      (floor >= CONFIG.ambushFromFloor && canAmbush && chance(rng, CONFIG.ambushPackChance));
    // Behavior VARIETY: a share of (non-ambush) packs PATROL their territory
    // together; the rest are sentries that hold the room they spawned in.
    // (the chance is still DRAWN for seated packs — overriding the result
    // instead of skipping the roll keeps the rng stream fixture-stable)
    const patrol = !ambush && chance(rng, CONFIG.packPatrolChance) && !social;
    // Wind-Up Battalions muster at parade strength — the synced volley IS the
    // encounter, so the squad claims its own size band and a shared squadId.
    const squadId = kind === "toysoldier" ? state.nextEntityId++ : undefined;
    // HEAVY PACK formation (config.ts heavyPack*): brute-class kinds spawn
    // 2-4 spread bodies, not a knot. Broodmother keeps her clustered brood.
    const heavyPack = ARCHETYPES[kind].hpMult >= CONFIG.heavyPackHpMult && kind !== "broodmother";
    const packSize = kind === "toysoldier"
      ? Math.min(budget, nextInt(rng, CONFIG.toysquadMin, CONFIG.toysquadMax))
      : heavyPack ? Math.min(budget, Math.max(2, Math.min(4, Math.round(size / 3))))
      : size;
    // VETERAN anchor: a share of packs are led by the middle rung (drawn for
    // every pack, then gated — draw-then-override keeps the rng stream
    // fixture-stable when the gate knobs move).
    const vetRoll = chance(rng, CONFIG.veteranPackChance);
    const veteranAnchor = vetRoll && floor >= CONFIG.veteranFromFloor && canVeteran(kind);
    for (let k = 0; k < packSize; k++) {
      // Cluster around the anchor; members that land in a wall squeeze inward.
      // Heavy packs take the WIDE ring — same two draws, different spacing.
      const a = nextFloat(rng) * Math.PI * 2;
      const d = heavyPack
        ? CONFIG.heavyPackSpreadBase + nextFloat(rng) * CONFIG.heavyPackSpreadRange
        : 0.4 + nextFloat(rng) * 1.4;
      let pos = { x: anchor.x + dcos(a) * d, y: anchor.y + dsin(a) * d };
      if (!isWalkable(map, pos.x, pos.y)) pos = { x: anchor.x, y: anchor.y };
      if (!isWalkable(map, pos.x, pos.y)) pos = { x: anchor.x + 1, y: anchor.y }; // seats ring a table that BLOCKS
      // STAGING v2: residents take the PLAN'S seat slots first — the sim owns
      // where the pack sits, so the chairs and the sitting actors agree. The
      // ring draws above STAY in the stream (draw-then-override convention).
      const seat = social && dressing ? dressing.seats[k] : undefined;
      const seatOk = seat !== undefined && isWalkable(map, seat.x, seat.y);
      if (seat && seatOk) pos = { x: seat.x, y: seat.y };
      // The escort slot carries the pack's support: a shaman healer, or (from
      // the SEWERS down) a Drum Sergeant beating the pack into a frenzy — the
      // playbook's "The Drumline". Same kill-order lesson, different verb.
      const escortKind: MonsterKind =
        floor >= CONFIG.drumFromFloor && kind !== "drummer" && chance(rng, CONFIG.drumEscortChance)
          ? "drummer" : "shaman";
      const memberKind =
        escort && k === packSize - 1 && kind !== "toysoldier" ? escortKind
        : kind === "broodmother" && k > 0 ? "swarmer" // ONE mother + her brood
        : kind;
      const m = makeMonster(state, memberKind, pos);
      if (veteranAnchor && k === 0 && memberKind === kind) promoteVeteran(m);
      if (roam) m.tribe = tribeId;
      if (ambush) m.dormant = true;
      if (patrol) m.roams = true;
      // Seated residents HOLD their room (sentries) and remember whose room
      // it is — the scene breaks on detection (ai.ts) or first blood.
      if (social && dressing) m.residentOf = dressing.purposeId;
      if (seatOk) m.seated = true;
      if (squadId !== undefined && memberKind === "toysoldier") m.squadId = squadId;
      state.monsters.push(m);
      budget--;
    }
  }

  // STRONGHOLD (Roam only): a guaranteed garrison + a named leader, spawned
  // directly rather than left to the weighted picker (which already zero-
  // weights this room, same reason vault/entrance/settlement are). Clearing
  // it — killing the leader — is the settlement's second quest.
  if (roam && map.strongholdRoomIdx >= 0) {
    const r = map.rooms[map.strongholdRoomIdx];
    const anchor = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const bandTemplates = PACK_TEMPLATES[floorBand(floor)];
    const template = bandTemplates[nextInt(rng, 0, bandTemplates.length - 1)];
    const squadId = state.nextEntityId++;
    for (const member of template.members) {
      let pos = { x: anchor.x + member.dx, y: anchor.y + member.dy };
      if (map.tiles[Math.floor(pos.y) * map.w + Math.floor(pos.x)] !== 1) pos = { x: anchor.x, y: anchor.y };
      const m = makeMonster(state, member.kind, pos);
      m.tribe = tribeId;
      if (member.kind === "toysoldier") m.squadId = squadId;
      if (member.kind === "greeter") m.dormant = true;
      state.monsters.push(m);
    }
    // The leader uses the same elite-scaling formula as the neighborhood
    // boss above, so it tracks the player power curve instead of being a
    // one-shot or a pushover depending on floor depth.
    const leader = makeMonster(state, rollArchetype(rng, floor), { x: anchor.x, y: anchor.y - 1 });
    leader.tribe = tribeId;
    leader.elite = true;
    leader.eliteName = pick(rng, ELITE_NAMES);
    leader.hp = leader.maxHp = Math.round(leader.maxHp * (CONFIG.eliteHpMult + CONFIG.eliteHpMultPerFloor * floor));
    leader.damage *= CONFIG.eliteDmgMult;
    leader.xp = Math.round(leader.xp * CONFIG.eliteXpMult);
    if (floor >= CONFIG.eliteAffixFromFloor) leader.affix = rollEliteAffix(rng, floor);
    state.monsters.push(leader);
    state.strongholdLeaderId = leader.id;
    state.strongholdLeaderName = leader.eliteName;
    announce(state, "boss", `HOSTILE CAMP: ${leader.eliteName} holds ground nearby. Someone should deal with that.`);
  }

  // Roam v1 keeps the rest of the encounter to the settlement/stronghold —
  // no loot-goblin, vault guardian, or neighborhood-boss dressing yet.
  if (roam) return;

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

  // THE CHAMPION TIER (boss layer 1) + DUOS (layer 4): named checkpoint
  // fights from the CHAMPIONS table — mini-bosses without the arena or the
  // seal. Elite plumbing provides ringside intros and guaranteed drops;
  // duo members share a duoId (the survivor ENRAGES — see reapDead).
  for (const entry of CHAMPIONS) {
    if (entry.floor !== floor || totalW <= 0) continue;
    const anchor = inRoom(pickRoom());
    if (!anchor) continue;
    const duoId = entry.members.length > 1 ? state.nextEntityId++ : undefined;
    entry.members.forEach((member, i) => {
      let pos = { x: anchor.x + i * 1.4, y: anchor.y + (i % 2) * 1.1 };
      if (map.tiles[Math.floor(pos.y) * map.w + Math.floor(pos.x)] !== 1) pos = { x: anchor.x, y: anchor.y };
      const champ = makeMonster(state, member.kind, pos);
      champ.hp = champ.maxHp = Math.round(champ.maxHp * member.hpMult);
      champ.elite = true;
      champ.eliteName = member.name;
      champ.duoId = duoId;
      state.monsters.push(champ);
    });
    const names = entry.members.map((m) => m.name).join(" & ");
    announce(state, "boss", entry.members.length > 1
      ? `CHAMPIONS ON THE FLOOR: ${names}. A double act — and whichever falls first, the other takes it PERSONALLY.`
      : `CHAMPION ON THE FLOOR: ${names}. A checkpoint fight with a name and a purse.`);
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
      m.kind !== "broodmother" && // support castes never take the crown
      m.kind !== "foreman" && // the CHAMPION outranks the neighborhood — no re-crowning
      !m.veteran; // already promoted once — elite mults must not stack on veteran mults
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
      m.affix = rollEliteAffix(rng, floor);
      if (m.affix === "swift") m.speed *= CONFIG.swiftSpeedMult;
      if (m.affix === "juggernaut") m.speed *= CONFIG.juggernautSpeedMult; // your CC is void; your kiting isn't
    }
    const tag = m.affix ? ` [${m.affix.toUpperCase()}]` : "";
    announce(state, "boss", `NEIGHBORHOOD BOSS: ${m.eliteName}${tag} holds the great hall. Introduce yourselves.`);

    // TODAY'S RULE — OVERSTAFFED (§4.8): management fields a SECOND named
    // menace, drawn from the rest of the floor (never re-crowning the hall's).
    if (ruleSecondElite(state.dailyRule)) {
      const rest = state.monsters.filter((x) => x !== m && !x.elite && canBoss(x));
      if (rest.length > 0) {
        const e = rest[nextInt(rng, 0, rest.length - 1)];
        e.elite = true;
        e.eliteName = pick(rng, ELITE_NAMES);
        e.hp = e.maxHp = Math.round(e.maxHp * (CONFIG.eliteHpMult + CONFIG.eliteHpMultPerFloor * floor));
        e.damage *= CONFIG.eliteDmgMult;
        e.xp = Math.round(e.xp * CONFIG.eliteXpMult);
        if (floor >= CONFIG.eliteAffixFromFloor) {
          e.affix = rollEliteAffix(rng, floor);
          if (e.affix === "swift") e.speed *= CONFIG.swiftSpeedMult;
          if (e.affix === "juggernaut") e.speed *= CONFIG.juggernautSpeedMult;
        }
        announce(state, "boss", `MANAGEMENT ADDENDUM: ${e.eliteName} is also on shift today. The dungeon apologizes for the staffing.`);
      }
    }
  }
}

/**
 * §4.3 — STOCK THE ARENA. The measured audit found `breakables` inside a boss
 * arena across eighteen boots: 0, 0, 0 ... 3. The arena was a featureless
 * 19x19 square on every band, every run, and "use the arena" was not a real
 * ask because there was no arena to use.
 *
 * Everything here is built from primitives that already shipped —
 * `breakables` with footprints (which the blocked mask and SMASH_KINDS already
 * understand) plus the new `onBreak` hook — so a layout can never break a
 * mapgen invariant. Deterministic: no RNG is consumed, which is what keeps
 * every existing spawn fixture intact.
 */
function stockBossArena(state: GameState, floor: number): void {
  const variant = state.arenaVariant;
  if (!variant || !state.map.blocked) return;
  const roomIdx = state.map.roles.indexOf("stairs");
  if (roomIdx < 0) return;
  const room = state.map.rooms[roomIdx];
  const stairs = { x: Math.floor(state.map.stairs.x), y: Math.floor(state.map.stairs.y) };
  const put = (tx: number, ty: number, key: string, hp: number, onBreak?: Breakable["onBreak"], label?: string) => {
    if (tx <= room.x || ty <= room.y || tx >= room.x + room.w - 1 || ty >= room.y + room.h - 1) return;
    if (Math.abs(tx - stairs.x) <= 1 && Math.abs(ty - stairs.y) <= 1) return; // the boss needs its mark
    const ti = ty * state.map.w + tx;
    if (state.map.tiles[ti] !== Tile.Floor || state.map.blocked![ti]) return;
    state.map.blocked![ti] = 1;
    state.breakables!.push({
      id: state.nextEntityId++,
      pos: { x: tx + 0.5, y: ty + 0.5 },
      key, hp, footprint: [ti], onBreak, label,
    });
  };

  // THE TEACHING BAND STAYS LEGIBLE (the floor-1-stays-pristine rule, one
  // band down): floor 3 gets HALF the cover and a wide chokepoint. Measured —
  // a full-density floor-3 arena cost the bot 2 clears in 32 on its own,
  // which is a lot of tax for a crawler who has never met an arena before.
  const teaching = floor <= CONFIG.bossFloorEvery;
  if (variant === "pillared") {
    // A lattice of destructible cover: line-of-sight play, and the Condemned
    // Architect eats it column by column until the room is open ground.
    const want = teaching ? Math.ceil(CONFIG.arenaPillarCount / 2) : CONFIG.arenaPillarCount;
    let placed = 0;
    for (let gy = room.y + 3; gy < room.y + room.h - 3 && placed < want; gy += 4) {
      for (let gx = room.x + 3; gx < room.x + room.w - 3 && placed < want; gx += 4) {
        put(gx, gy, "pillar", CONFIG.arenaPillarHp);
        placed++;
      }
    }
  } else if (variant === "split") {
    // A blocking run divides the arena, connected at a central chokepoint:
    // routing and displacement matter, and standing on the wrong side of the
    // divide when a signature lands is a real mistake.
    const ly = room.y + Math.floor(room.h / 2) - 4;
    const gap = CONFIG.arenaSplitGap + (teaching ? 4 : 0);
    const gapFrom = room.x + Math.floor(room.w / 2) - Math.floor(gap / 2);
    for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
      if (x >= gapFrom && x < gapFrom + gap) continue;
      put(x, ly, "barricade", CONFIG.arenaPillarHp);
    }
  } else {
    // OPEN: the middle stays clear, the RIM does not. Eight pieces of
    // smashable staging around the outside, with wide gaps between them, so
    // the room reads as an arena instead of a beige square without costing
    // the lane bosses (the Inspector, the Foundation) a single tile of the
    // ground their whole ask is made of.
    const rx = room.x + Math.floor(room.w / 2);
    const ry = room.y + Math.floor(room.h / 2);
    const rad = Math.floor(Math.min(room.w, room.h) / 2) - 2;
    for (let i = 0; i < CONFIG.arenaRimCount; i++) {
      const a = (i / CONFIG.arenaRimCount) * Math.PI * 2 + Math.PI / 8;
      put(
        rx + Math.round(dcos(a) * rad), ry + Math.round(dsin(a) * rad),
        "rubble", CONFIG.arenaRimHp,
      );
    }
  }

  // INTERACTIVE PROPS (V3). Only the bosses whose ask depends on them get
  // them, and the boss's own smash-through never touches them (see
  // smashBlockersAt) — the mechanic is the player's, not the boss's.
  const draw = drawBossEncounter(state.seed, floor, state.bossPrevLineup, state.bossDefeats);
  const prop = draw.def.prop;
  if (!prop) return;
  const label = prop === "drain" ? "FLOODGATE" : prop === "vent" ? "WALL VENT" : prop === "shutdown" ? "CONVEYOR" : "SUPPORT";
  const cx = room.x + Math.floor(room.w / 2), cy = room.y + Math.floor(room.h / 2);
  const reach = Math.floor(Math.min(room.w, room.h) / 2) - 2;
  for (let i = 0; i < CONFIG.arenaPropCount; i++) {
    const a = (i / CONFIG.arenaPropCount) * Math.PI * 2 + Math.PI / 4;
    put(
      cx + Math.round(dcos(a) * reach), cy + Math.round(dsin(a) * reach),
      prop, CONFIG.arenaPropHp, prop, label,
    );
  }
}

/**
 * V3 — an interactive prop fires. This is the seam that turns "there is
 * scenery in here" into "the scenery is the counterplay": floodgates DRAIN the
 * flooded half, wall vents force the furnace to cough early, conveyors stop
 * feeding the line. Every one of them is a `breakable` that answers back.
 */
function fireArenaProp(state: GameState, b: Breakable): void {
  const boss = state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
  bossEvent(state, {
    kind: "prop", monsterId: boss?.id ?? -1, bossId: boss?.bossId,
    label: b.label ?? String(b.onBreak).toUpperCase(), pos: { x: b.pos.x, y: b.pos.y },
  });
  const left = (state.breakables ?? []).filter((o) => o !== b && o.onBreak === b.onBreak && o.hp > 0).length;
  switch (b.onBreak) {
    case "drain": {
      // The flooded half DRAINS: every live ground zone in the arena goes.
      const before = state.hazards.length;
      state.hazards = state.hazards.filter((h) => h.kind !== "sludge" && h.kind !== "puddle" && h.kind !== "spore");
      announce(state, "boss", left > 0
        ? `A FLOODGATE GIVES. The level drops — ${left} more and the court adjourns.`
        : "THE LAST FLOODGATE GIVES. The King is BEACHED. Get in there.");
      if (boss) {
        boss.stagger = Math.max(boss.stagger, left > 0 ? 0.6 : CONFIG.bossPunishWindow);
        if (left === 0) {
          boss.staggerGraceT = 0;
          advanceBossPhase(state, boss, "mechanic");
        }
      }
      state.events.push(`A floodgate drains ${before - state.hazards.length} pools.`);
      break;
    }
    case "vent": {
      // Cooling it EARLY: the next thing the furnace does is over-commit.
      if (boss) {
        boss.punishArmed = true;
        boss.heat = CONFIG.bossPunishAfter;
      }
      announce(state, "boss", "A WALL VENT IS OPEN. The furnace has to breathe NOW, on your schedule.");
      break;
    }
    case "shutdown": {
      announce(state, "boss", left > 0
        ? `A CONVEYOR STOPS. ${left} still running.`
        : "THE LINE IS DOWN. The Supervisor has to do this personally now. It is bad at it.");
      if (boss && left === 0) advanceBossPhase(state, boss, "mechanic");
      break;
    }
    case "collapse": {
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: b.pos.x, y: b.pos.y },
        t: CONFIG.debrisDelay, total: CONFIG.debrisDelay,
        radius: CONFIG.debrisRadius, damage: (boss?.damage ?? 10) * CONFIG.debrisDmgMult,
        kind: "blast", flavor: "debris",
      });
      break;
    }
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
    if (!isWalkable(map, x, y)) continue; // never inside furniture (the mask)
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
    unclaimedAchievements: [],
    goldSpent: 0,
    kills: 0,
    killsThisStep: 0,
    lowHpKill: false,
    materials: { elite_trophy: 0, boss_sigil: 0, refit_shard: 0 },
    glyphs: defaultGlyphs(),
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
 * time the rule touches them. The System files a courtesy explanation.
 * `priority` is presentation pacing, not headline routing: the host's card
 * surface holds a "high" tip only for the active card, never for the 9s
 * politeness gap — reserved for tips whose moment expires (collapse).
 *
 * `tipsSeen` is the SIM's once-per-crawler latch — it stops this rule
 * re-announcing every step of the run that generated it, and that is ALL it
 * means. The once-EVER ledger belongs to presentation: the line rides `tipId`
 * out to the host, which writes `dcc:tips:v1` when the card actually paints
 * (r4 blocker 1). A tip generated into a queue that never drains is therefore
 * not spent, and the next run gets to teach the concept properly. */
function systemTip(
  state: GameState, p: Player, id: string,
  priority: Announcement["priority"] = "normal",
): void {
  const line = TIPS[id];
  if (!line || (p.tipsSeen ?? []).includes(id)) return;
  (p.tipsSeen ??= []).push(id);
  // Addressed: the System explains the rule to the crawler it touched, not
  // to party veterans who dismissed this explanation runs ago.
  announce(state, "tip", line, priority, p.id, id);
}

/** Max dash charges: base + PARKOUR ARTIST's extra. */
function maxDashCharges(p: Player): number {
  // Quickstep rank 2 is a CHARGE, not another percentage (V2 §4.3) — it comes
  // through dashParams so the node and the revision stack in one place.
  return dashParams(p).charges + (hasRevision(p, "parkour") ? CONFIG.revisionParkourCharges : 0);
}

/** Reset a player's transient combat state for a fresh floor (progression carries). */
function resetForFloor(p: Player, spawn: Vec2, offset: number): void {
  // Fan the party out around the spawn tile so nobody stacks.
  const a = offset * (Math.PI * 2 / 6);
  p.pos = { x: spawn.x + (offset === 0 ? 0 : dcos(a) * 0.6), y: spawn.y + (offset === 0 ? 0 : dsin(a) * 0.6) };
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
  p.slipstreamT = 0; // glyph transients never cross a stairwell
  p.rebateAbility = undefined;
  p.rebateT = 0;
  p.rebateBudget = 0;
  p.rebateCd0 = 0;
  p.shearsCount = 0;
  // ABILITIES-V2 transients: same rule as slipstreamT/rebateT — optional
  // fields, reset per floor, so an old save that never had them loads clean.
  p.barrageT = 0;
  p.barrageAim = undefined;
  p.barrageNext = 0;
  p.bulwarkT = 0;
  p.bulwarkAbsorbed = 0;
  p.bulwarkHits = 0;
  p.spiteBank = 0;
  p.injunctionT = 0;
  p.injunctionDebt = 0;
  p.orbitHurlT = 0;
  p.orbitHurlDir = undefined;
  p.orbitHurlHits = [];
  p.orbitGuardT = 0;
  p.cutCharges = cutToParams(p).charges;
  p.glyphCastCount = {};
  p.doubleCueUsed = false;
  // Fallen crawlers rejoin the show at half strength when the party descends.
  if (!p.alive) {
    p.alive = true;
    p.hp = Math.round(p.maxHp * 0.5);
  }
}

// Cosmetic hero skins: every run you drop in as a random adventurer, and party
// members never twin (up to the pool size). Purely DERIVED from (seed, player
// id) — no state, no save field, no rng-stream impact, and every client
// computes the same answer from the shared seed. The FALLBACK for crawlers
// who never stood at the campfire (below).
export const HERO_SKINS = ["knight", "barbarian", "mage", "rogue", "hooded"] as const;
export type HeroSkin = (typeof HERO_SKINS)[number];

// CHOSEN crawler looks: the campfire check-in lineup (Adventurers 2.0, CC0).
// Cosmetic only — the constellation stays the build. Stored on Player.skin,
// persisted per account, validated by the server on join. The books let you
// change your race at level 3; for now the fire is where you decide who you
// are.
export const CRAWLER_SKINS = [
  "knight", "barbarian", "druid", "engineer", "mage", "ranger", "rogue", "hooded",
] as const;
export type CrawlerSkin = (typeof CRAWLER_SKINS)[number];

export function isCrawlerSkin(v: unknown): v is CrawlerSkin {
  return typeof v === "string" && (CRAWLER_SKINS as readonly string[]).includes(v);
}

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
    // Roam sanctuary (SETTLEMENTS.md): a crawler inside a settlement is not
    // a target — monsters neither chase, shoot at, nor mark them. Every
    // monster targeting decision flows through here, so this one check IS
    // the no-aggro rule (movement is separately fenced by
    // isWalkableForMonster's sanctuary skirt).
    if (playerInSettlement(state, p)) continue;
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

/** Derive a per-floor sub-seed so each floor is reproducible from the run
 *  seed. Exported for the builder's test-drive seed search (it hunts a seed
 *  whose floor actually stamps your template, using the real derivation). */
export function floorSeed(seed: number, floor: number): number {
  return (seed ^ Math.imul(floor, 0x9e3779b1)) >>> 0;
}

export function buildFloor(state: GameState, floor: number): void {
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
  // BOSSES V2 §4.3 — the arena LAYOUT is drawn before mapgen, from the same
  // pure hash the boss identity comes from, so the room and its occupant
  // always agree. Ordinary floors draw nothing and behave exactly as before.
  state.arenaVariant =
    state.runKind !== "roam" && (floor >= CONFIG.finalFloor || isCityBossFloor(floor))
      ? drawBossEncounter(state.seed, floor, state.bossPrevLineup, state.bossDefeats).arena
      : undefined;
  state.map = generateFloor(rng, floor, state.runKind, state.arenaVariant);
  state.explored = new Uint8Array(state.map.w * state.map.h);
  state.exploredVersion++;
  state.monsters = [];
  state.loot = [];
  state.projectiles = [];
  state.hazards = [];
  state.arenaT = 0; // the next arena's director starts its clock fresh
  state.bossEvents = []; // typed boss beats are per-step transients
  state.corpses = [];
  state.decoys = []; // stunt contracts don't follow you downstairs
  state.breakables = []; // the plan below restocks the smashables
  state.residentAggro = []; // fresh floor, fresh grievances
  state.encounter = null;
  state.floorEvent = null;
  state.goldSurge = false;
  state.glyphsDroppedThisFloor = 0; // §3.5: the per-floor glyph budget resets
  state.roamSmashed = []; // fresh floor, fresh hoards (#25: saves overlay this)
  state.dialogue = null; // nobody talks through a floor transition
  state.players.forEach((p, i) => resetForFloor(p, state.map.spawn, i));
  // TODAY'S RULE — RUSH HOUR shortens every race clock (roam has no clock).
  // No rounding: base budgets are legitimately fractional (timer falloff),
  // and the multiplier must be an exact identity when no rule is dealt.
  state.timeBudget = state.runKind === "roam"
    ? CONFIG.roamTimeBudget
    : floorTimeBudget(floor) * ruleCollapseMult(state.dailyRule);
  // SERIES REGULAR's debt: the network trims every remaining floor's runtime.
  if (state.players.some((p) => hasRevision(p, "regular"))) {
    state.timeBudget = Math.round(state.timeBudget * CONFIG.revisionRegularTimeMult);
  }
  // TIME LOAN (shrine): the System collects on arrival, then closes the book.
  if ((state.pendingTimeDebt ?? 0) > 0) {
    state.timeBudget = Math.max(30, state.timeBudget - state.pendingTimeDebt!);
    announce(state, "progress", `The System collects its TIME LOAN: this floor's clock is ${state.pendingTimeDebt}s shorter.`);
    state.pendingTimeDebt = 0;
  }
  state.timeRemaining = state.timeBudget;
  state.phase = "safe";
  state.collapseElapsed = 0;
  state.mapVersion++;
  state.strongholdLeaderId = -1;
  state.strongholdLeaderName = "";
  state.strongholdCleared = false;
  // PHYSICAL FURNITURE (PHYSICALITY.md §1): stamp the blocked mask and spawn
  // the blocking pieces BEFORE monsters, so every spawn (they all flow
  // through isWalkable) respects the furniture. The plan is pure — this is
  // the same answer the renderer and spawnMonsters compute.
  const plan = assignRoomPurposes(state.seed, floor, state.map);
  state.map.blocked = new Uint8Array(state.map.w * state.map.h);
  for (const d of plan.dressings) {
    for (const bl of d.blockers) {
      state.map.blocked[bl.tile] = 1;
      state.breakables!.push({
        id: state.nextEntityId++,
        pos: { x: (bl.tile % state.map.w) + 0.5, y: Math.floor(bl.tile / state.map.w) + 0.5 },
        key: bl.key,
        hp: CONFIG.blockerHp,
        footprint: [bl.tile],
      });
    }
  }
  stockBossArena(state, floor); // §4.3: cover, chokepoints, interactive props
  spawnMonsters(state);
  // The floor's STORY + SERVICES (roomPurposes): if a seeded event swept the
  // dressing, the System mentions it exactly once; if a room is open for
  // business (rare — plan.service), its contract sits beside the furniture.
  {
    if (plan.story) announce(state, "flavor", STORY_LINES[plan.story]);
    // Destructible dressing (phase 5): the corner hoards the plan marked
    // become sim entities — one good hit pops them for pocket gold.
    for (const d of plan.dressings) {
      for (const b of d.breakables) {
        state.breakables!.push({ id: state.nextEntityId++, pos: { x: b.x, y: b.y }, key: b.key, hp: 1 });
      }
    }
    if (plan.service && state.runKind !== "roam") {
      const d = plan.dressings.find((dd) => dd.roomIdx === plan.service!.roomIdx);
      if (d?.anchor) {
        // The contract sits on a walkable tile nudged off the furniture.
        for (const [dx, dy] of [[0.9, 0.4], [-0.9, 0.4], [0.4, 0.9], [0.4, -0.9]] as const) {
          const x = d.anchor.x + dx, y = d.anchor.y + dy;
          if (isWalkable(state.map, x, y)) {
            state.loot.push({ id: state.nextEntityId++, pos: { x, y }, kind: "service", amount: 0, service: plan.service.purposeId });
            break;
          }
        }
      }
    }
    // THE CHASE: looters who swept the LAST floor are still ahead of you,
    // as fleeing Repo Rats carrying the haul. Floors regenerate purely from
    // (seed, floor), so yesterday's story is recomputable today. Floor 4+
    // only: the Repo Rat is a SEWERS specialist (mobs.test encodes the
    // roster rule — no filchers prowling the UNDERCROFT).
    if (floor >= 4 && state.runKind !== "roam") {
      const prevMap = generateFloor(createRng(floorSeed(state.seed, floor - 1)), floor - 1, state.runKind);
      if (assignRoomPurposes(state.seed, floor - 1, prevMap).story === "looters") {
        const carry = CONFIG.chaseFilcherCarry + floor * CONFIG.chaseFilcherCarryPerFloor;
        const spots = walkableTiles(state.map).filter(
          (tl) => dist(tl, state.map.spawn) > 7 && dist(tl, state.map.spawn) < 16 && dist(tl, state.map.stairs) > 3,
        );
        for (let i = 0; i < CONFIG.chaseFilcherCount && spots.length > 0; i++) {
          const pos = spots.splice(nextInt(state.rng, 0, spots.length - 1), 1)[0];
          const m = makeMonster(state, "filcher", pos);
          m.carry = carry;
          state.monsters.push(m);
        }
        announce(state, "show", "The looters from the last floor are still AHEAD of you, carrying everything they took. The System recommends repossession.");
      }
    }
  }
  if (state.runKind === "roam") {
    spawnSettlement(state);
  } else {
    maybeSpawnFloorEvent(state); // before the key roll: a sealed vault never holds the key
    assignKeyCarrier(state);
  }
}

export interface SavedProgress {
  seed: number;
  floor: number;
  // BACKLOG #11: absent on pre-Roam saves — CONTINUE defaults to Race.
  runKind?: GameState["runKind"];
  // Roam campaign overlay (quest progress, consumed stock/hoards) — applied
  // after the floor rebuilds. Absent on Race saves and pre-Roam saves.
  roam?: RoamSaveState;
  // THE DEBUT (TUTORIAL.md): a fresh profile's first run, so a resume after a
  // refresh rebuilds the same merciful floor 1 rather than quietly promoting
  // a first-timer into the real game mid-lesson. Absent = an ordinary run.
  firstRun?: boolean;
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
    unclaimedAchievements?: string[]; // achievement loot boxes not yet opened
    goldSpent?: number;
    kills?: number;
    name?: string;
    skin?: string; // chosen campfire look; absent on pre-select saves
    damageDealt?: number;
    damageTaken?: number;
    materials?: Partial<Record<MaterialId, number>>;
    revisions?: string[]; // CLASS REVISIONS taken (pre-revision saves: absent)
    tipsSeen?: string[]; // first-contact tips already delivered (pre-tips saves: absent)
    glyphs?: Player["glyphs"]; // V2 §3 sockets + bench (pre-glyph saves: absent)
    // Legacy (pre-itemization saves): fold into bonuses so old runs still resume.
    maxHp?: number;
    baseDamage?: number;
  };
  show?: { hype?: number; viewers?: number; favorites?: number; sponsors?: number };
  // ---- BOSSES V2 cross-run memory (PERSISTENCE.md gets a row) -------------
  // The ANTI-REPEAT rule (§4.1) needs to know which boss each band slot served
  // LAST run, and the escalation rule (§4.4) needs a per-profile defeat count.
  // Both are tiny, both are optional, and both are read-only inputs to a PURE
  // draw — a save without them simply gets the plain seeded lineup.
  bosses?: {
    lastLineup?: Record<string, BossId>; // band index (as a string) -> boss id
    defeats?: Record<string, number>; // BossId -> times this profile beat it
  };
}

/**
 * Apply saved character progression to a live player: stats, equipment,
 * abilities, Show standing — then recompute effective stats and clamp hp.
 * Shared by the single-player resume (restoreGame) and the server's
 * per-account persistence (a rejoining crawler gets their character back
 * even after the instance was dropped and regenerated from seed).
 */
/**
 * Retired constellation node ids -> the node that inherited their meaning
 * (ABILITIES-V2 §4.3). Every mapping is a RENAME of a surviving idea, never a
 * merge of two live nodes: Concussive's damage became Crush's dragged-target
 * bonus, Aftershock's cooldown became Rift's, Short Notice became Second
 * Take's charge, IMPLOSION moved into the base and its capstone slot became
 * SINGULARITY, SYSTEM SHOCK moved into the base and its slot became CHAIN
 * REACTION. Exported so the persistence test can assert the whole table.
 */
export const RANK_MIGRATIONS: Record<string, string> = {
  "nova.conc": "nova.crush",
  "nova.after": "nova.rift",
  "nova.implode": "nova.singular",
  "cut.jump": "cut.encore",
  "overcharge.shock": "overcharge.chain",
};

/** Fold retired node ids into their heirs. Pure; safe to run on any save. */
export function migrateRanks(ranks: Record<string, number>): Record<string, number> {
  let touched = false;
  for (const old of Object.keys(RANK_MIGRATIONS)) if (ranks[old] !== undefined) touched = true;
  if (!touched) return ranks;
  const out: Record<string, number> = {};
  for (const [id, r] of Object.entries(ranks)) {
    const to = RANK_MIGRATIONS[id] ?? id;
    // A crawler could hold ranks in BOTH sides of a retired fork only if the
    // save predates the exclusion; keep the larger rather than summing past max.
    out[to] = Math.max(out[to] ?? 0, r);
  }
  return out;
}

export function applySavedPlayer(p: Player, save: SavedProgress): void {
  const s = save.player;
  if (isCrawlerSkin(s.skin)) p.skin = s.skin; // the look follows the character
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
    // ABILITIES-V2 §7: retired node ids are MIGRATED, not dropped. rank()
    // ignores unknown keys, so a resumed run would silently lose ranks the
    // player earned — the same ranks, under the name the node kept.
    p.abilities.ranks = migrateRanks(p.abilities.ranks);
  }
  if (s.achievements) p.achievements = s.achievements;
  p.unclaimedAchievements = s.unclaimedAchievements ?? []; // loot boxes wait for a Safe Room
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
    // what the current economy spends. refit_shard: pre-V2 saves default to 0.
    p.materials = {
      elite_trophy: s.materials.elite_trophy ?? 0,
      boss_sigil: s.materials.boss_sigil ?? 0,
      refit_shard: s.materials.refit_shard ?? 0,
    };
  }
  // GLYPHS (V2 §3): optional field + load-time default (pre-glyph saves).
  p.glyphs = s.glyphs ?? defaultGlyphs();
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
}

/**
 * Rebuild a game from saved character progression. The floor is regenerated
 * deterministically from (seed, floor), then the persisted player stats +
 * equipment are applied and effective stats recomputed. This is the
 * single-player stand-in for "log back in and resume."
 */
export function restoreGame(save: SavedProgress): GameState {
  // BACKLOG #11 fixed: the run kind round-trips — CONTINUE on a Roam
  // campaign resumes a Roam campaign instead of silently rebuilding as Race.
  const state = createGame(save.seed, "coop", save.runKind ?? "race", null, !!save.firstRun);
  // BOSSES V2 §4.1/§4.4 — hand the cross-run memory in BEFORE the floor
  // builds, because the arena layout and the boss identity are both drawn
  // during buildFloor and both read it.
  if (save.bosses?.lastLineup) state.bossPrevLineup = { ...save.bosses.lastLineup };
  if (save.bosses?.defeats) state.bossDefeats = { ...save.bosses.defeats };
  applySavedPlayer(state.players[0], save);
  // A resumed debut keeps its mercy but not its opening line: the float was
  // announced (and possibly spent) in the session that granted it, and the
  // save's gold is the truth. Announcing "40 gold advanced" to a crawler
  // holding 12 would be the System lying about its own ledger.
  if (state.firstRun) state.firstRunFloatSaid = true;
  buildFloor(state, save.floor);
  // Roam: overlay the campaign's quest/stock/hoard state onto the rebuilt
  // floor (quests match by key — generation is deterministic per seed+floor).
  if (state.runKind === "roam" && save.roam) applyRoamSave(state, save.roam);
  return state;
}

export interface TestSetup {
  seed?: number;
  floor?: number; // starting floor, clamped to 1..finalFloor
  level?: number; // crawler level; ranks are auto-drafted to match
  gold?: number; // default scales with the floor so the shop is testable
  abilities?: AbilityId[] | "all"; // learned + auto-slotted before leveling
  gear?: boolean; // roll random gear (default true)
  // Which floor's loot table the gear rolls from (default: the starting
  // floor). Hosts map `gear=level` to naturalFloorForLevel(level) so an
  // off-curve crawler can be dressed for their LEVEL, not their location.
  gearFloor?: number;
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

  // V2 §7: test mode used to learn DISCOVERABLE_ABILITIES in DECLARATION
  // ORDER, so `abilities=all` slotted the identical kit every time — across
  // 20 seeds the loadout was [melee, dash, bolt, nova] + airstrike 20/20, and
  // 36 of 54 constellation nodes were never drafted once. Shuffle from the
  // seeded RNG so a fixture measures a KIT rather than the array's order.
  const wanted: AbilityId[] = opts.abilities === "all"
    ? shuffle(state.rng, [...DISCOVERABLE_ABILITIES])
    : opts.abilities ?? [];
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

  // Scaled loadout: several rolls, wear the upgrades, bag a few spares.
  // ITEMIZATION-V2 §2.2: dress the crawler the way the DROP TABLE dresses one —
  // catalog identities at rolled quality first (components, then completed
  // works once they're floor-legal), commodity gear as the remainder. A test
  // crawler wearing only freeform affix soup understates every stage.
  if (opts.gear !== false) {
    const gearFloor = Math.max(1, Math.min(CONFIG.finalFloor, Math.floor(opts.gearFloor ?? floor)));
    const completedOk = gearFloor >= CONFIG.dropCompletedFromFloor;
    for (let i = 0; i < 8; i++) {
      const roll = nextFloat(state.rng);
      const item =
        roll < CONFIG.dropComponentShare || (!completedOk && roll < CONFIG.dropComponentShare + CONFIG.dropCompletedShare)
          ? rollCatalogDrop(state.rng, gearFloor, "basic", () => state.nextEntityId++)
        : roll < CONFIG.dropComponentShare + CONFIG.dropCompletedShare
          ? rollCatalogDrop(state.rng, gearFloor, "advanced", () => state.nextEntityId++)
        : generateItem(state.rng, gearFloor, () => state.nextEntityId++);
      const worn = p.equipment[item.slot];
      if (wantsAutoEquip(item, worn)) {
        p.equipment[item.slot] = item;
        if (worn && p.inventory.length < 4) p.inventory.push(worn);
      } else if (p.inventory.length < 4) {
        p.inventory.push(item);
      }
    }
  }

  // A stage-representative crawler did not just find their first glyph, and
  // the grants below run at CONSTRUCTION — without this, every test-mode URL
  // would open with a COURTESY card sitting over the frame someone came here
  // to look at. The `glyph` tip alone: every other tip still fires normally in
  // test mode, because test mode is how the sim's tip sites get exercised.
  (p.tipsSeen ??= []).push("glyph");

  // GLYPHS (V2 §3): a stage-representative crawler has found firmware by now —
  // one per unlocked socket across the kit, seeded, auto-filling compatible
  // slots exactly as a field pickup would (leftovers land on the bench).
  const socketsOpen = totalSocketsOpen(p.level, !!p.abilities.ultimate);
  for (let i = 0; i < socketsOpen; i++) {
    grantGlyph(state, p, GLYPH_IDS[nextInt(state.rng, 0, GLYPH_IDS.length - 1)]);
  }

  p.gold = Math.max(0, Math.floor(opts.gold ?? floor * 40));
  recomputeStats(p);
  p.hp = p.maxHp;
  buildFloor(state, floor);
  state.events.push(`TEST MODE: floor ${floor}, level ${level}, seed ${seed}.`);
  return state;
}

export function createGame(
  seed: number,
  mode: GameState["mode"] = "coop",
  runKind: GameState["runKind"] = "race",
  // TODAY'S RULE (NICHE.md §4.8): the daily mutator, dealt by the HOST from
  // the day string (dailyRuleFor) — the sim never touches a calendar. Null =
  // base game; every rule seam collapses to a no-op.
  dailyRule: DailyRuleId | null = null,
  // THE DEBUT (TUTORIAL.md): the host's fresh-profile read. Off for every
  // other world the game ever builds — including createTestGame's, the
  // server's, and the bot's — so the three floor-1 mercy rules are unreachable
  // outside a first-timer's first descent.
  firstRun = false,
): GameState {
  const state: GameState = {
    mode,
    runKind,
    dailyRule,
    firstRun: firstRun || undefined,
    npc: null,
    quests: [],
    strongholdLeaderId: -1,
    strongholdLeaderName: "",
    strongholdCleared: false,
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
    breakables: [],
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
  // THE DEBUT'S FLOAT (TUTORIAL.md, the affordable first shelf). Two cold
  // rounds arrived at the first shop with 24 then 16 gold against a 35-gold
  // cheapest entry: the shop step asked the player to spend money the
  // curriculum had not given them, and the panel was a wall of red. The fix is
  // at the cause and it is deterministic — a debut crawler is ADVANCED enough
  // to clear the cheapest shelf entry before they have killed anything, so the
  // first shelf is guaranteed to hold something they can buy whatever floor 1
  // paid them. Never a drop-rate change: ordinary runs earn exactly what they
  // always earned.
  // (The gold lands here so the HUD and the first save are right from second
  // zero; the LINE is said on the first step — see stepFloor — because step()
  // clears the announcement buffer at the top of every frame and a line
  // emitted at construction is deleted before any host can drain it.)
  if (state.firstRun) {
    for (const p of state.players) p.gold += CONFIG.firstRunStipendGold;
  }
  // TODAY'S RULE announces itself at second zero, in the System's voice —
  // after the floor build so it lands on top of the band introduction.
  if (dailyRule) {
    announce(state, "show", DAILY_RULES[dailyRule].line, "high");
  }
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
    let pos = { x: p.pos.x + dcos(a) * d, y: p.pos.y + dsin(a) * d };
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
    const pos = { x: p.pos.x + dcos(a) * d, y: p.pos.y + dsin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    const delay = CONFIG.interferenceHazardDelay + i * 0.35;
    state.hazards.push({
      id: state.nextEntityId++, pos, t: delay, total: delay,
      radius: CONFIG.interferenceHazardRadius, damage: dmg, // kind absent = blast
      flavor: "debris", // the review drops masonry, not clowns
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
    // BOSSES V2 §5.3 — the name card as DATA. Title, epithet, ask, mutator
    // tags and the boss's own System line all ship to the host, so the intro
    // can be a designed card instead of a toast. §4.4: a boss you have already
    // beaten gets a SHORTER freeze — a 2.2s beat you have seen ten times is a
    // tax, not a beat, and this is a short-session game.
    const def = m.bossId ? bossDef(m.bossId) : undefined;
    const beaten = m.bossId ? (state.bossDefeats?.[m.bossId] ?? 0) : 0;
    const intro = CONFIG.encounterIntroSeconds *
      (beaten >= CONFIG.bossRepeatEscalateAt ? CONFIG.bossRepeatIntroMult : 1);
    state.encounter = {
      monsterId: m.id,
      name,
      kind: m.kind,
      elite: !!m.elite,
      affix: m.affix,
      timeLeft: intro,
      total: intro,
      bossId: m.bossId,
      epithet: def?.epithet,
      ask: def?.ask,
      mutators: m.bossMutators ? [...m.bossMutators] : undefined,
      line: def?.line,
      repeat: beaten,
    };
    if (def) {
      bossEvent(state, {
        kind: "intro", monsterId: m.id, bossId: m.bossId, label: def.name,
        value: beaten, duration: intro, pos: { x: m.pos.x, y: m.pos.y },
      });
      announce(state, "boss", beaten >= CONFIG.bossRepeatEscalateAt
        ? `${def.name} again. It remembers. It is not waiting to respect you this time.`
        : def.line, "high");
    }
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
  let pos = { x: m.pos.x + dcos(a) * 0.7, y: m.pos.y + dsin(a) * 0.7 };
  // Never born INTO furniture (the blocked mask) — a swarmer wedged inside a
  // bookcase is stuck for good; the mother's own tile is always safe ground.
  if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: m.pos.x, y: m.pos.y };
  const spawned = makeMonster(state, "swarmer", pos);
  spawned.xp = 1;
  state.monsters.push(spawned);
  hit(state, spawned.pos, 0, "weapon"); // a poof for the juice layer
}

/**
 * Boss phase transition calls an ADDS WAVE (backlog #11): a ring of chaff
 * plus a ranged flanker so the enrage changes what the party is DOING.
 * Waves are worth almost no XP — the boss is the payday, not its entourage.
 */
/**
 * V8 — ADD TETHER. An add spawned by a boss and LINKED to it: while the cord
 * holds it feeds the boss a slow heal and shields it (see damageMonster), so
 * ignoring the wave stalls the fight instead of merely being untidy. This is
 * the "adds need a JOB" rule (§2.5) in one function.
 */
export function makeBossAdd(
  state: GameState, boss: Monster, kind: MonsterKind, at: Vec2, tether: boolean,
): Monster {
  let pos = { x: at.x, y: at.y };
  if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: boss.pos.x, y: boss.pos.y };
  const add = makeMonster(state, kind, pos);
  add.xp = 1; // waves stay near-worthless: the boss is the payday
  if (tether) add.tetherId = boss.id;
  state.monsters.push(add);
  hit(state, add.pos, 0, "weapon"); // arrival poof for the juice layer
  return add;
}

export function spawnBossWave(state: GameState, boss: Monster): void {
  const count = CONFIG.bossWaveAdds + (boss.phase ?? 0) * CONFIG.bossWaveAddsPerPhase;
  for (let i = 0; i < count; i++) {
    const kind: MonsterKind = i === count - 1 ? "ranged" : "swarmer";
    const a = (i / count) * Math.PI * 2 + nextFloat(state.rng) * 0.5;
    const d = 1.5 + nextFloat(state.rng) * 1.5;
    let pos = { x: boss.pos.x + dcos(a) * d, y: boss.pos.y + dsin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: boss.pos.x, y: boss.pos.y };
    const add = makeMonster(state, kind, pos);
    add.xp = 1;
    state.monsters.push(add);
    hit(state, add.pos, 0, "weapon"); // arrival poof for the juice layer
  }
  announce(state, "boss", "The boss calls for BACKUP. The union rules here are grim.");
}

// ---- BOSSES V2 chassis: phases, intermissions, punish windows -------------

/**
 * PHASE MACHINE (§2.2). Four trigger types share ONE counter, so a fight never
 * double-counts a beat: HP gates (the shipped 2/3 and 1/3), MECHANIC (the
 * shield broke, the last conveyor fell), TIMER, and POSITIONAL. The rule the
 * roster is built against is that at least one phase per fight is
 * mechanic-triggered — the player's PLAY advances the story, not their DPS.
 *
 * Every edge is an INTERMISSION (V6): the boss goes briefly untargetable, the
 * live hazards are swept, and the adds wave arrives as part of the beat. That
 * is spectacle AND pacing — the board gets re-dealt instead of compounding.
 */
export function advanceBossPhase(state: GameState, boss: Monster, reason: BossPhaseReason): boolean {
  const max = boss.maxPhase ?? 2;
  if ((boss.phase ?? 0) >= max || boss.hp <= 0) return false;
  boss.phase = (boss.phase ?? 0) + 1;
  boss.phaseReason = reason;
  boss.speed *= CONFIG.bossPhaseSpeedMult;
  bossIntermission(state, boss);
  spawnBossWave(state, boss); // the enrage brings friends (backlog #11)
  bossEvent(state, {
    kind: "phase", monsterId: boss.id, bossId: boss.bossId,
    phase: boss.phase, reason, pos: { x: boss.pos.x, y: boss.pos.y },
  });
  const name = boss.eliteName ?? "The boss";
  announce(state, "boss", reason === "mechanic"
    ? `${name} did not choose that. YOU did. Phase ${boss.phase + 1}.`
    : reason === "timer"
      ? `${name} escalates on the clock. Phase ${boss.phase + 1} — the slot is booked.`
      : reason === "positional"
        ? `${name} takes the ground it wanted. Phase ${boss.phase + 1}.`
        : boss.phase === 1
          ? "The boss is ANGRY now. Phase two — the sponsors love a comeback arc."
          : "The boss is DESPERATE. Everything is a projectile. RATINGS.");
  state.events.push(`Boss phase ${boss.phase + 1} (${reason}).`);
  return true;
}

/**
 * V1 — a plate falls. Every plate break is a MECHANIC-triggered phase edge:
 * the player caused it, so the fight visibly answers. The Rent Collector's
 * lockbox additionally refunds everything it seized, with interest — which is
 * the entire reason its ask is "burst the window".
 */
export function breakBossPlate(state: GameState, m: Monster, plate: BossPlate): void {
  plate.hp = 0;
  plate.broken = true;
  m.stagger = Math.max(m.stagger, CONFIG.plateBreakStagger);
  m.staggerGraceT = 0;
  const left = (m.plates ?? []).filter((p) => !p.broken).length;
  bossEvent(state, {
    kind: "plate", monsterId: m.id, bossId: m.bossId, label: plate.label,
    value: left, pos: { x: m.pos.x, y: m.pos.y }, duration: CONFIG.plateBreakStagger,
  });
  if (plate.key === "lockbox" && (m.lockbox ?? 0) > 0) {
    const refund = Math.round((m.lockbox ?? 0) * CONFIG.lateFeeInterest);
    m.lockbox = 0;
    state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "gold", amount: refund });
    announce(state, "loot", `THE LOCKBOX SPLITS. ${refund} gold, refunded WITH INTEREST. The System notes the irony and moves on.`, "high");
  } else {
    announce(state, "boss", `${plate.label} BREAKS. ${left > 0 ? `${left} to go.` : "It has nothing left to hide behind."}`);
  }
  advanceBossPhase(state, m, "mechanic");
}

/**
 * V6 — THE COMMERCIAL BREAK. Briefly untargetable while the arena re-deals:
 * a shockwave clears LIVE ground danger so the next phase starts on a clean
 * board rather than on top of the last one's leftovers.
 */
export function bossIntermission(state: GameState, boss: Monster): void {
  boss.invulnT = CONFIG.bossIntermissionSeconds;
  boss.windup = 0;
  boss.windupKind = undefined;
  const before = state.hazards.length;
  state.hazards = state.hazards.filter((h) => h.kind === "beam" && (h.fired ?? false));
  bossEvent(state, {
    kind: "intermission", monsterId: boss.id, bossId: boss.bossId,
    duration: CONFIG.bossIntermissionSeconds, value: before - state.hazards.length,
    pos: { x: boss.pos.x, y: boss.pos.y },
  });
}

/**
 * V4 — THE PUNISH WINDOW, the counterplay every shipped boss was missing. The
 * boss over-commits on a readable count, coughs out one scalding beat, and is
 * then genuinely HELPLESS (plain `m.stagger`, so every existing stagger rule
 * composes for free). This is what turns a fight into a rhythm you learn
 * instead of a wall you erode.
 */
export function bossPunishVent(state: GameState, m: Monster): void {
  const dmg = m.damage * CONFIG.slagVentDmgMult;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue;
    if (dist(m.pos, player.pos) > CONFIG.bossSlamRadius) continue;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, dmg, { dir })) {
      handlePlayerDeath(state, player, `${player.name} stood inside the over-commit. Timing is a skill.`);
    } else {
      applyPlayerKnockback(player, dir, CONFIG.slamKnockback);
    }
  }
  m.heat = 0;
  m.punishArmed = false;
  m.stagger = CONFIG.bossPunishWindow; // over-extended and helpless — UNLOAD
  m.staggerGraceT = 0; // this window is EARNED by reading it, not by DPS
  bossEvent(state, {
    kind: "punish", monsterId: m.id, bossId: m.bossId,
    duration: CONFIG.bossPunishWindow, pos: { x: m.pos.x, y: m.pos.y },
  });
  announce(state, "boss", `${m.eliteName ?? "The boss"} OVER-COMMITS. It is wide open. Spend everything.`);
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
  if (reachable.length === 0) {
    // No bodies? Then the Concierge checks in STAFF (see the concierge kit in
    // ai.ts). A boss whose only verb is conditional on the room having already
    // died is a boss with no verb — that was the audit's headline finding.
    if (m.bossId === "concierge") {
      for (let i = 0; i < CONFIG.graveRaiseCount; i++) {
        const a = (i / CONFIG.graveRaiseCount) * Math.PI * 2 + (m.bossCount ?? 0);
        makeBossAdd(state, m, "grunt", {
          x: m.pos.x + dcos(a) * 1.8, y: m.pos.y + dsin(a) * 1.8,
        }, true);
        m.bossCount = (m.bossCount ?? 0) + 1;
      }
      announce(state, "boss", "THE BELL RINGS. Staff arrive, and they are ON THE PAYROLL — every one of them is feeding it.");
    }
    return; // every corpse faded mid-channel — whiffed
  }
  for (const corpse of reachable) {
    state.corpses.splice(state.corpses.indexOf(corpse), 1);
    const raised = makeMonster(state, corpse.kind, corpse.pos);
    raised.hp = raised.maxHp = Math.max(1, Math.round(raised.maxHp * CONFIG.necroRaisedHpMult));
    raised.xp = CONFIG.necroRaisedXp;
    // BOSSES V2 §3.1 — the risen are TETHERED: each one feeds the Concierge,
    // so "ignore the adds and hit the boss" stalls the fight outright. That is
    // what turns the audit's worst offender (62 melee windups and nothing
    // else, measured over 90 seconds) into a kill-the-adds fight.
    raised.tetherId = m.id;
    m.bossCount = (m.bossCount ?? 0) + 1;
    state.monsters.push(raised);
    hit(state, raised.pos, 0, "weapon"); // a poof per riser for the juice layer
  }
  announce(state, "boss", `${m.eliteName ?? "The boss"} raises the fallen — and they are FEEDING it. Check-out time was never on the books.`);
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
  // §7.4 — the four SHIPPED band signatures name themselves on the boss
  // channel too, so every one of the eighteen has a per-boss telegraph FX and
  // telegraph SOUND, not just the ones whose verbs were new in V2.
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    // The HAZARD is shared; the NAME is identity (bandSignatureLabel). Three
    // floor-9 bosses with three different asks were all reading ENTANGLING
    // ROOTS, which is the readout saying they are the same fight.
    label: bandSignatureLabel("flood", m.bossId),
    value: CONFIG.floodPools, pos: { x: m.pos.x, y: m.pos.y },
  });
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
    spots.push({ x: around.x + dcos(a) * d, y: around.y + dsin(a) * d });
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
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    label: bandSignatureLabel("roots", m.bossId),
    value: spots.length, pos: { x: m.pos.x, y: m.pos.y },
  });
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
    targets.push({ x: m.pos.x + dcos(a) * d, y: m.pos.y + dsin(a) * d });
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
      flavor: "debris", // falling masonry, not falling ordnance (backlog #4)
      srcId: m.id, // the Architect's masonry EATS cover where it lands
    });
  }
  // ...and it aims at the columns on purpose. Ration your cover.
  if (m.bossId === "architect") {
    for (const b of (state.breakables ?? []).filter((bb) => bb.footprint && !bb.onBreak).slice(0, 2)) {
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: b.pos.x, y: b.pos.y },
        t: CONFIG.debrisDelay, total: CONFIG.debrisDelay,
        radius: CONFIG.debrisRadius,
        damage: m.damage * CONFIG.debrisDmgMult,
        kind: "blast", flavor: "debris", srcId: m.id,
      });
    }
  }
  announceSignature(state, m, "The ceiling is NEGOTIABLE. Masonry incoming — watch the circles, not the boss.");
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    label: bandSignatureLabel("debris", m.bossId),
    value: CONFIG.debrisCount, pos: { x: m.pos.x, y: m.pos.y },
  });
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
        flavor: "flame", // hosts draw fire, not falling ordnance (BACKLOG #5)
      });
    }
  }
  announceSignature(state, m, "THE FURNACE EXHALES. A wall of fire is coming through — pick a gap and COMMIT.");
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    label: bandSignatureLabel("flamewall", m.bossId),
    value: CONFIG.flameRows, pos: { x: m.pos.x, y: m.pos.y },
  });
}

// ---- BOSSES V2 signatures. Same shape, same file, same announce discipline
// as the five above: everything ARMS, rings, or channels first. Nothing here
// invents a fifth telegraph shape (§2.3) — armed ground decals, locked lanes,
// interruptible channels, and arena-wide schedules are the whole vocabulary.

/**
 * LATE FEE (The Rent Collector, floor 3): it seizes gold from every crawler in
 * reach into the lockbox on its back — and the lockbox is a PLATE with its own
 * health pip. Break it inside the window and the party is refunded WITH
 * INTEREST and the Collector reels. Miss it and you paid for the privilege.
 */
export function bossLateFee(state: GameState, m: Monster): void {
  const take = Math.round(CONFIG.lateFeeBase + CONFIG.lateFeePerFloor * state.floor);
  let seized = 0;
  for (const p of state.players) {
    if (!p.alive || dist(m.pos, p.pos) > CONFIG.monsterAggroRange * 2) continue;
    const amount = Math.min(p.gold, take);
    if (amount <= 0) continue;
    p.gold -= amount;
    seized += amount;
    hit(state, p.pos, amount, "gold");
  }
  // Even a broke party gets billed: the lockbox always opens, because the
  // BURST WINDOW is the mechanic and a poor run must still get to learn it.
  m.lockbox = (m.lockbox ?? 0) + Math.max(seized, take);
  const plate = m.plates?.find((p) => p.key === "lockbox");
  if (plate && plate.broken) {
    // Re-latched for the next collection round: the window comes back.
    plate.broken = false;
    plate.hp = plate.maxHp;
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "LATE FEE",
    value: m.lockbox, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "LATE FEE ASSESSED. The lockbox is OPEN — break it before it latches, and take it back with interest.");
}

/**
 * CITATION (The Sanitation Inspector, floor 6): a lock-on lane across the
 * arena (the shipped sentinel beam), and then it CONDEMNS the tiles it hit —
 * lingering strips, so the safe floor shrinks as the fight runs. The ask is
 * "sidestep the lock, and SPEND clean ground deliberately".
 */
export function bossCitation(state: GameState, m: Monster): void {
  const prey = nearestPlayer(state, m.pos);
  if (!prey) return;
  const base = normalize({ x: prey.pos.x - m.pos.x, y: prey.pos.y - m.pos.y });
  // Phase 1+ paints TWO lanes at 90 degrees — the safe wedge gets narrow.
  const lanes = (m.phase ?? 0) >= 1 ? 2 : 1;
  for (let i = 0; i < lanes; i++) {
    const dir = i === 0 ? base : { x: -base.y, y: base.x };
    const end = {
      x: m.pos.x + dir.x * CONFIG.citationLength,
      y: m.pos.y + dir.y * CONFIG.citationLength,
    };
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: m.pos.x, y: m.pos.y },
      end,
      t: CONFIG.citationArm + CONFIG.beamFadeSeconds,
      total: CONFIG.citationArm + CONFIG.beamFadeSeconds,
      arm: CONFIG.citationArm,
      radius: CONFIG.citationWidth,
      damage: m.damage * CONFIG.citationDmgMult,
      kind: "beam",
      trackId: i === 0 ? prey.id : undefined, // the first lane LOCKS ON
    });
    // ...and the tiles it crosses are condemned behind it. Armed for exactly
    // as long as the beam, so one telegraph covers both.
    const steps = Math.floor(CONFIG.citationLength / 2.4);
    for (let s = 1; s <= steps; s++) {
      const pos = { x: m.pos.x + dir.x * s * 2.4, y: m.pos.y + dir.y * s * 2.4 };
      if (!isWalkable(state.map, pos.x, pos.y)) continue;
      state.hazards.push({
        id: state.nextEntityId++,
        pos,
        t: CONFIG.citationArm + CONFIG.condemnDuration,
        total: CONFIG.citationArm + CONFIG.condemnDuration,
        arm: CONFIG.citationArm,
        radius: 1.2,
        damage: Math.max(1, m.damage * CONFIG.condemnDmgMult),
        kind: "sludge",
        tick: 0,
      });
    }
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "CITATION",
    value: lanes, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "CITATION ISSUED. Everything that lane touches is CONDEMNED. You have a floor's worth of mistakes, and no more.");
}

/**
 * THE PIT PULLS (The Grease Trap, floor 6): a rhythmic, uncapped drag toward
 * a boss that never moves — the lasher's pull verb at arena scale. Fighting
 * facing OUTWARD, braced behind cover, is the whole posture.
 */
export function bossGreasePull(state: GameState, m: Monster): void {
  for (const p of state.players) {
    if (!p.alive || p.dashTime > 0) continue; // dash i-frames beat the drag
    const d = dist(m.pos, p.pos);
    if (d > CONFIG.greasePullRange || d < 1.2) continue;
    const toPit = normalize({ x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y });
    const drag = Math.min(CONFIG.greasePullStrength, d - 1.0);
    applyPlayerKnockback(p, toPit, drag, drag); // a PULL: full-length, uncapped
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "THE PIT PULLS",
    pos: { x: m.pos.x, y: m.pos.y }, value: CONFIG.greasePullRange,
  });
  announceSignature(state, m, "THE PIT PULLS. It will not come to you. It does not have to.");
}

/** Seed one armed spore pod (The Pollinator). Shared by the Bloom cast and by
 *  a pod's own detonation — an unchecked bloom compounds. */
export function seedSporePod(state: GameState, m: Monster, at: Vec2): void {
  if (!isWalkable(state.map, at.x, at.y)) return;
  if (state.hazards.reduce((n, h) => n + (h.kind === "spore" ? 1 : 0), 0) >= CONFIG.bloomPodCap) return;
  state.hazards.push({
    id: state.nextEntityId++,
    pos: { x: at.x, y: at.y },
    t: CONFIG.bloomArm,
    total: CONFIG.bloomArm,
    arm: CONFIG.bloomArm,
    radius: CONFIG.bloomRadius,
    damage: m.damage * CONFIG.bloomDmgMult,
    kind: "spore",
    srcId: m.id, // so a bloomed pod knows whose garden it is
  });
}

/**
 * BLOOM (The Pollinator, floor 9): armed pods across the arena; a pod left to
 * bloom seeds MORE pods, so the arena saturates if you fight the boss instead
 * of the storm. Clear the pods and it wilts (the mechanic phase + the punish
 * window). Population-capped, so "survive the storm" never becomes "survive
 * the frame budget".
 */
export function bossBloom(state: GameState, m: Monster): void {
  const { rng } = state;
  const targets: Vec2[] = [];
  for (const p of state.players) {
    if (p.alive && dist(m.pos, p.pos) <= CONFIG.monsterAggroRange * 2.5) {
      targets.push({ x: p.pos.x, y: p.pos.y });
    }
  }
  const pods = CONFIG.bloomPods + (m.phase ?? 0);
  for (let i = 0; i < pods; i++) {
    const anchor = targets.length > 0 ? targets[i % targets.length] : m.pos;
    const a = nextFloat(rng) * Math.PI * 2;
    const d = 1.4 + nextFloat(rng) * 3.2;
    seedSporePod(state, m, { x: anchor.x + dcos(a) * d, y: anchor.y + dsin(a) * d });
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "BLOOM",
    value: pods, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "IT IS BLOOMING. Pods that go off make more pods. Clear the garden or drown in it.");
}

/**
 * FISSURES (The Foundation, floor 12): the shipped colossus crack at boss
 * scale and in MULTIPLES — a fan of staggered eruptions that leaves
 * wedge-shaped safe ground, then a radial set that asks for one committed
 * decision. Move perpendicular; never along the lane.
 */
export function bossFissureFan(state: GameState, m: Monster, lanes: number, radial: boolean): void {
  const prey = nearestPlayer(state, m.pos);
  const base = prey
    ? datan2(prey.pos.y - m.pos.y, prey.pos.x - m.pos.x)
    : 0;
  for (let l = 0; l < lanes; l++) {
    const a = radial
      ? base + (l / lanes) * Math.PI * 2
      : base + (l - (lanes - 1) / 2) * 0.55;
    const dir = { x: dcos(a), y: dsin(a) };
    for (let i = 1; i <= CONFIG.fissureSteps; i++) {
      const pos = {
        x: m.pos.x + dir.x * CONFIG.fissureStepGap * i,
        y: m.pos.y + dir.y * CONFIG.fissureStepGap * i,
      };
      if (!isWalkable(state.map, pos.x, pos.y)) break; // the crack stops at the wall
      state.hazards.push({
        id: state.nextEntityId++,
        pos,
        t: CONFIG.fissureStepDelay * i + 0.25,
        total: CONFIG.fissureStepDelay * i + 0.25,
        radius: CONFIG.fissureRadius,
        damage: m.damage * CONFIG.fissureDmgMult,
        kind: "blast",
        flavor: "debris",
      });
    }
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    label: radial ? "FISSURE: RADIAL" : "FISSURE: FAN",
    value: lanes, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "THE FLOOR SPLITS. Move ACROSS the crack, never along it.");
}

/**
 * COMPLIANCE LATTICE (The Safety Officer, floor 15): a grid of lanes that arm
 * IN SEQUENCE, turning the arena into moving safe cells. Read the order, move
 * early, never panic-dash. Phase 1 rotates the whole lattice.
 */
export function bossLattice(state: GameState, m: Monster): void {
  const lines = CONFIG.latticeLines + (m.phase ?? 0);
  const twist = (m.phase ?? 0) * 0.4 + (state.arenaT ?? 0) * 0.05;
  for (let i = 0; i < lines; i++) {
    const a = twist + (i / lines) * Math.PI; // lanes, not spokes: they cross the room
    const dir = { x: dcos(a), y: dsin(a) };
    const half = CONFIG.bossArenaSize / 2;
    const off = ((i % 2 === 0 ? 1 : -1) * (1 + Math.floor(i / 2) * 2.6));
    const perp = { x: -dir.y * off, y: dir.x * off };
    const arm = CONFIG.latticeArm + i * CONFIG.latticeStagger;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: m.pos.x + perp.x - dir.x * half, y: m.pos.y + perp.y - dir.y * half },
      end: { x: m.pos.x + perp.x + dir.x * half, y: m.pos.y + perp.y + dir.y * half },
      t: arm + CONFIG.beamFadeSeconds,
      total: arm + CONFIG.beamFadeSeconds,
      arm,
      radius: CONFIG.latticeWidth,
      damage: m.damage * CONFIG.latticeDmgMult,
      kind: "beam",
    });
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "COMPLIANCE LATTICE",
    value: lines, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "COMPLIANCE LATTICE ONLINE. They arm in ORDER. Stand where it hasn't got to yet.");
}

/**
 * PRODUCTION QUOTA (The Line Supervisor, floor 15): the conveyors deliver a
 * synced wind-up battalion (the shipped squadId brain). The squads are the
 * threat; the Supervisor is the reason they exist — and it is nearly immune
 * while a conveyor still runs, so the answer is the SYSTEM, not the boss.
 */
export function bossConveyorRun(state: GameState, m: Monster): void {
  const props = (state.breakables ?? []).filter((b) => b.onBreak === "shutdown");
  const anchors = props.length > 0
    ? props.map((b) => b.pos)
    : [{ x: m.pos.x + 3, y: m.pos.y }];
  const squadId = state.nextEntityId++;
  const lines = Math.min(anchors.length, 1 + (m.phase ?? 0));
  for (let l = 0; l < lines; l++) {
    const at = anchors[l % anchors.length];
    for (let i = 0; i < CONFIG.conveyorSquad; i++) {
      let pos = { x: at.x + (i - 1) * 0.9, y: at.y + 0.8 };
      if (!isWalkable(state.map, pos.x, pos.y)) pos = { x: at.x, y: at.y };
      if (!isWalkable(state.map, pos.x, pos.y)) continue;
      const add = makeMonster(state, "toysoldier", pos);
      add.squadId = squadId;
      add.xp = 1;
      state.monsters.push(add);
      hit(state, add.pos, 0, "weapon");
    }
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "PRODUCTION QUOTA",
    value: lines, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "THE LINE IS RUNNING. Break the CONVEYORS — the Supervisor is a paperwork problem, not a damage one.");
}

/**
 * STOP-WORK ORDER (The Permit Office, floor 12) — the verb the audit said this
 * boss did not have. Its four stamps were sub-HP bars: you could ignore them
 * entirely and the fight did not change shape, which fails §2.1's rule that a
 * plate must change the ASK and not the HP.
 *
 * Now every UNBROKEN stamp fires one locked lane along its own hanging angle,
 * armed in sequence, so the pattern the player has to read is literally the
 * plate row on the health plate. Break a stamp and that lane is gone for the
 * rest of the fight — a mono-school build physically cannot delete the lanes it
 * has no answer for, which is the entire point of the school-immune plates.
 */
export function bossStopWork(state: GameState, m: Monster): void {
  const live = (m.plates ?? []).filter((p) => !p.broken);
  const half = CONFIG.bossArenaSize / 2;
  const lanes = live.length > 0
    ? live.map((p) => p.angle)
    // Stamps all gone: the Office signs the order itself, at the crawler.
    : [(() => {
      const prey = nearestPlayer(state, m.pos);
      return prey ? datan2(prey.pos.y - m.pos.y, prey.pos.x - m.pos.x) : 0;
    })()];
  for (let i = 0; i < lanes.length; i++) {
    const dir = { x: dcos(lanes[i]), y: dsin(lanes[i]) };
    const arm = CONFIG.stopWorkArm + i * CONFIG.stopWorkStagger;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: m.pos.x, y: m.pos.y },
      end: { x: m.pos.x + dir.x * half, y: m.pos.y + dir.y * half },
      t: arm + CONFIG.beamFadeSeconds,
      total: arm + CONFIG.beamFadeSeconds,
      arm,
      radius: CONFIG.stopWorkWidth,
      damage: m.damage * CONFIG.stopWorkDmgMult,
      kind: "beam",
    });
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "STOP-WORK ORDER",
    value: lanes.length, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "STOP-WORK ORDER. One lane per stamp, and they fire IN ORDER. Break a stamp, delete a lane.");
}

/**
 * HEDGE REGROWTH (The Topiary Warden, floor 9) — the Warden's OWN verb.
 *
 * Acceptance review round 3: the Warden is one of only three break-the-shield
 * bosses and it had no kit at all. Its shield only ever crept back on the
 * chassis' passive trickle, so a fight whose whole ask is "burst the pool
 * inside the gap" showed neither a gap nor a pool moving — its beat line read
 * the band-generic ENTANGLING ROOTS and nothing about it was a shield fight.
 *
 * The regrow is now a CHANNEL with a stake, which is what makes the ask real:
 * stagger it mid-channel (poise, exactly like every other channel in the game)
 * and the hedge stays broken; let it land and the pool is back AND the wall it
 * grew is standing on you as armed roots. Zero new telegraph shapes — an armed
 * ground zone and an interruptible channel, both shipped (§2.3).
 */
export function bossHedgeRegrow(state: GameState, m: Monster): void {
  const pool = m.shieldMax ?? 0;
  const before = m.shieldHp ?? 0;
  m.shieldHp = Math.min(pool, before + pool * CONFIG.hedgeRegrowAmount);
  // The passive trickle waits its turn: the channel IS the regen now, so the
  // player is reading one clock instead of two.
  m.shieldRegenT = CONFIG.shieldRegenDelay;
  // THE WALL IT JUST GREW, on the floor: a ring of armed roots at hedge
  // radius. It holds you at exactly the distance the pool needs to survive.
  for (let i = 0; i < CONFIG.hedgeRingSpokes; i++) {
    const a = (i / CONFIG.hedgeRingSpokes) * Math.PI * 2;
    const pos = {
      x: m.pos.x + dcos(a) * CONFIG.hedgeRingRadius,
      y: m.pos.y + dsin(a) * CONFIG.hedgeRingRadius,
    };
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    state.hazards.push({
      id: state.nextEntityId++,
      pos,
      t: CONFIG.rootsTelegraph + CONFIG.rootsDuration,
      total: CONFIG.rootsTelegraph + CONFIG.rootsDuration,
      arm: CONFIG.rootsTelegraph,
      radius: CONFIG.rootsRadius,
      damage: 0, // the hedge holds; the Warden does the cutting
      kind: "roots",
    });
  }
  announce(state, "boss", `THE HEDGE IS BACK UP (${Math.round((m.shieldHp / Math.max(1, pool)) * 100)}%). Interrupt the next one or you will do this all night.`);
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "HEDGE REGROWTH",
    value: CONFIG.hedgeRingSpokes, pos: { x: m.pos.x, y: m.pos.y },
  });
}

/**
 * SLUICE GATE (The Sump King, floor 6) — the King's `prop: "drain"` was
 * authored in the roster and never fired, so the headline use-the-arena boss
 * shipped with a generic ring and a floodgate nobody had a reason to look at.
 *
 * The surge is anchored on the STANDING GATES, not on the King: each gate vents
 * a marching crescent of armed sludge toward the nearest crawler, so the thing
 * you read (where the water is coming from) and the thing you break (the gate)
 * are the same object. Break them all and `fireArenaProp` beaches him.
 */
export function bossSluice(state: GameState, m: Monster): void {
  const gates = (state.breakables ?? []).filter((b) => b.onBreak === "drain" && b.hp > 0);
  const anchors = gates.length > 0 ? gates.map((b) => b.pos) : [{ x: m.pos.x, y: m.pos.y }];
  const prey = nearestPlayer(state, m.pos);
  const aim = prey?.pos ?? m.pos;
  let seeded = 0;
  for (const at of anchors) {
    const dir = normalize({ x: aim.x - at.x, y: aim.y - at.y });
    if (dir.x === 0 && dir.y === 0) continue;
    for (let s = 0; s < CONFIG.sluicePools; s++) {
      // A CRESCENT, not a ring: it widens as it travels, so the safe ground is
      // behind you and to the side — the read is "step off the line", which is
      // the same verb the whole floor-6 band teaches.
      const step = 1.8 + s * 1.9;
      const spread = (s % 2 === 0 ? 1 : -1) * s * 0.55;
      const pos = {
        x: at.x + dir.x * step - dir.y * spread,
        y: at.y + dir.y * step + dir.x * spread,
      };
      if (!isWalkable(state.map, pos.x, pos.y)) continue;
      const arm = CONFIG.sluiceArm + s * 0.18;
      state.hazards.push({
        id: state.nextEntityId++,
        pos,
        t: arm + CONFIG.floodDuration,
        total: arm + CONFIG.floodDuration,
        arm,
        radius: CONFIG.sluiceRadius,
        damage: m.damage * CONFIG.sluiceDmgMult,
        kind: "sludge",
        tick: 0,
      });
      seeded++;
    }
  }
  // The beat is posted at the GATE, not at the boss: the presentation layer
  // anchors its geometry on the prop, which is what "use the arena" has to
  // look like from the first frame.
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "SLUICE GATE",
    value: gates.length, pos: { x: anchors[0].x, y: anchors[0].y },
  });
  if (seeded > 0) {
    announceSignature(state, m, "THE SLUICES OPEN. It rises FROM THE GATES — break them and the court adjourns.");
  }
}

/**
 * MOTION CARRIED (The Standards and Practices Board, floor 18) — the finale's
 * own verb, and the reason `standards` no longer aliases the Zoning Board's
 * kit. Both fights are kill-order fights; this one makes the order VISIBLE on
 * the floor: every living aide is the muzzle of one lane that runs straight
 * through the body it is protecting and out the far side.
 *
 * Kill the aide standing where you want to fight and that lane is gone. There
 * is no safe pocket behind the Board, because the lane overshoots it.
 */
export function bossMotion(state: GameState, m: Monster): void {
  const aides = state.monsters.filter((o) => o.hp > 0 && o.tetherId === m.id);
  const seats = aides.length > 0
    ? aides.map((a) => ({ x: a.pos.x, y: a.pos.y }))
    // Adjourned: the Board signs its own motions, from every side at once.
    : [0, 1, 2].map((i) => ({
      x: m.pos.x + dcos((i / 3) * Math.PI * 2) * 5,
      y: m.pos.y + dsin((i / 3) * Math.PI * 2) * 5,
    }));
  for (let i = 0; i < seats.length; i++) {
    const at = seats[i];
    const dir = normalize({ x: m.pos.x - at.x, y: m.pos.y - at.y });
    if (dir.x === 0 && dir.y === 0) continue;
    const arm = CONFIG.motionArm + i * 0.28;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: at.x, y: at.y },
      end: {
        x: m.pos.x + dir.x * CONFIG.motionOvershoot,
        y: m.pos.y + dir.y * CONFIG.motionOvershoot,
      },
      t: arm + CONFIG.beamFadeSeconds,
      total: arm + CONFIG.beamFadeSeconds,
      arm,
      radius: CONFIG.motionWidth,
      damage: m.damage * CONFIG.motionDmgMult,
      kind: "beam",
    });
  }
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId, label: "MOTION CARRIED",
    value: seats.length, pos: { x: m.pos.x, y: m.pos.y },
  });
  announceSignature(state, m, "MOTION CARRIED. Every seat is a muzzle, and it fires THROUGH the chair. Pick which one stops existing.");
}

/**
 * THE SET CHANGES (The Showrunner, floor 18): the greatest-hits reel, EARNED —
 * each phase it re-dresses the arena into a previous band's, hazards and all,
 * and the counterplay is whatever that band taught you.
 */
export function bossShowSetChange(state: GameState, m: Monster): void {
  const sets = CONFIG.showrunnerSets;
  const set = sets[Math.min(sets.length - 1, m.phase ?? 0)];
  m.signature = set as BossSignature;
  m.sigUsed = false;
  m.sigCd = 0;
  bossEvent(state, {
    kind: "telegraph", monsterId: m.id, bossId: m.bossId,
    label: `SET: ${String(set).toUpperCase()}`, pos: { x: m.pos.x, y: m.pos.y },
  });
  announce(state, "boss", `THE SET CHANGES. We are shooting the ${String(set).toUpperCase()} episode now. You have done this one.`);
}

/**
 * LIVE AUDIENCE (mutator): the crowd throws things on a rhythm. The arena
 * does damage now, not just the boss — arena-first movement.
 */
export function bossAudienceThrow(state: GameState, boss: Monster): void {
  const { rng } = state;
  for (let i = 0; i < CONFIG.audienceCount; i++) {
    const target = state.players[i % Math.max(1, state.players.length)];
    const base = target?.alive ? target.pos : boss.pos;
    const a = nextFloat(rng) * Math.PI * 2;
    const d = nextFloat(rng) * 2.5;
    const pos = { x: base.x + dcos(a) * d, y: base.y + dsin(a) * d };
    if (!isWalkable(state.map, pos.x, pos.y)) continue;
    state.hazards.push({
      id: state.nextEntityId++,
      pos,
      t: CONFIG.bossHazardDelay,
      total: CONFIG.bossHazardDelay,
      radius: CONFIG.bossHazardRadius * 0.8,
      damage: boss.damage * CONFIG.audienceDmgMult,
      kind: "blast",
    });
  }
}

/**
 * Expose a weak point mid-fight (V1, the runtime half): the Grease Trap's pit
 * INVERTS, the Furnace Marshal CRACKS OPEN. A plate that appears is a punish
 * window with a health bar — hit the thing that just became hittable.
 */
export function bossExposeCore(state: GameState, m: Monster, key: string, label: string, seconds: number): void {
  m.plates = [{
    key, label,
    hp: Math.max(1, Math.round(m.maxHp * CONFIG.plateHpFraction)),
    maxHp: Math.max(1, Math.round(m.maxHp * CONFIG.plateHpFraction)),
    angle: 0,
  }];
  m.stagger = Math.max(m.stagger, seconds);
  m.staggerGraceT = 0;
  bossEvent(state, {
    kind: "punish", monsterId: m.id, bossId: m.bossId, label,
    duration: seconds, pos: { x: m.pos.x, y: m.pos.y },
  });
  announce(state, "boss", `${label} IS EXPOSED. That is the whole reason you did that. GO.`);
}

/**
 * Push a dramatic line in the DCC "System" game-show voice (also logged).
 * `priority: "high"` marks the handful of headline moments (boss down, new
 * band, wipe) that hosts may present bigger than a toast.
 */
/** STAGING v2: the room's scene is over — they SAW you (ai.ts detection)
 *  or FELT you (damageMonster). The whole purpose wakes at once, the
 *  interruption line fires once per floor, perception snaps to normal, and
 *  the renderer plays the stand-up transition off this same flag. */
export function breakResidentScene(state: GameState, m: Monster): void {
  if (!m.residentOf || (state.residentAggro ?? []).includes(m.residentOf)) return;
  (state.residentAggro ??= []).push(m.residentOf);
  const line = RESIDENT_LINES[m.residentOf];
  if (line) announce(state, "flavor", line);
}

function announce(
  state: GameState, kind: AnnouncementKind, line: string,
  priority: Announcement["priority"] = "normal",
  forPlayer?: number,
  tipId?: string,
): void {
  state.announcements.push({ text: line, kind, priority, forPlayer, tipId });
  state.events.push(line);
}

function hit(
  state: GameState, pos: Vec2, amount: number, kind: HitEvent["kind"],
  extra?: { dir?: Vec2; killed?: boolean; overkill?: boolean; school?: School; resisted?: boolean; effect?: StatusKind; to?: Vec2 },
): void {
  state.hits.push({
    pos: { x: pos.x, y: pos.y }, amount, kind,
    dir: extra?.dir, killed: extra?.killed, overkill: extra?.overkill,
    school: extra?.school, resisted: extra?.resisted,
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
export function applyPlayerKnockback(p: Player, dir: Vec2, tiles: number, cap: number = CONFIG.bossSlamKnockback): void {
  if (!p.alive || tiles <= 0 || (dir.x === 0 && dir.y === 0)) return;
  // Loadbearing Girder (boss unique, V2 §2.5): the wearer cannot be moved.
  if (hasPassive(p, "unmoved")) return;
  const d = normalize(dir);
  // Shoves stack only up to a slam's worth; PULLS (the lasher's hook) pass
  // their own cap because the whole point is crossing the room.
  p.knock = { dir: d, left: Math.min(Math.max(p.knock?.left ?? 0, 0) + tiles, Math.max(cap, tiles)) };
}

/** Stable machine key for a hazard that killed someone (Player.lastHitSrc).
 *  Hazards have no owner in the sim, so the zone kind IS the attacker. */
function hazardSrc(hz: Hazard): string {
  return "hazard:" + (hz.kind ?? "blast");
}
export function damagePlayerHit(
  state: GameState, p: Player, base: number,
  opts: { dir?: Vec2; roll?: boolean; effect?: StatusKind; hazard?: boolean; melee?: boolean; src?: Monster | string } = {},
): boolean {
  // Rivals revive grace: a crawler fresh off the timer is briefly untouchable.
  if ((p.reviveGraceT ?? 0) > 0) return false;
  // Sump Crown (boss unique, V2 §2.5): ground hazards deal half to the wearer.
  if (opts.hazard && hasPassive(p, "sumpcrown")) base *= CONFIG.sumpHazardTakenMult;
  // CROSSGUARD (orbit rider): while the ring is HOME it parries — the first
  // melee hit every few seconds is simply negated. It costs nothing while the
  // blades are thrown, which is the whole trade the hurl introduced.
  if (
    opts.melee && !opts.effect && (p.orbitGuardT ?? 0) <= 0 && (p.orbitHurlT ?? 0) <= 0 &&
    slotted(p, "orbit") && orbitParams(p).guard
  ) {
    p.orbitGuardT = CONFIG.orbitGuardCooldown;
    hit(state, p.pos, 0, "weapon"); // parried: the ring answers for you
    return false;
  }
  const raw = opts.roll === false ? Math.max(1, Math.round(base)) : rollDamage(state.rng, base);
  let dmg = mitigate(raw, playerMitigation(p));
  // BULWARK (V2 N1): you took the hit ON PURPOSE. The brace mitigates and
  // BANKS what it stopped — the heal (or SPITE) pays out on expiry. No
  // i-frames: dash owns those, and the two must never be interchangeable.
  if ((p.bulwarkT ?? 0) > 0) {
    const bp = bulwarkParams(p);
    const stopped = dmg * bp.mitigation;
    dmg = Math.max(1, Math.round(dmg - stopped));
    p.bulwarkAbsorbed = (p.bulwarkAbsorbed ?? 0) + stopped;
    p.bulwarkHits = (p.bulwarkHits ?? 0) + 1;
    // Rally is the SAFETY side of the fork: it pays immediately, at 60%.
    if (bp.rally) bulwarkHeal(state, p, stopped * bp.healFrac * CONFIG.bulwarkRallyFrac);
  }
  // Dig In (entry): the brace COVERS allies standing close — it changes what
  // the ability touches, which is what an entry node is for.
  for (const ally of state.players) {
    if (ally === p || (ally.bulwarkT ?? 0) <= 0) continue;
    const abp = bulwarkParams(ally);
    if (abp.allyRadius <= 0 || dist(ally.pos, p.pos) > abp.allyRadius) continue;
    const stopped = dmg * abp.mitigation;
    dmg = Math.max(1, Math.round(dmg - stopped));
    ally.bulwarkAbsorbed = (ally.bulwarkAbsorbed ?? 0) + stopped;
    ally.bulwarkHits = (ally.bulwarkHits ?? 0) + 1;
    break;
  }
  // The Briar Witch's mark: everything hits harder while it holds. Kill the
  // witch, outlast the mark, or in co-op peel for the marked crawler.
  if ((p.cursedT ?? 0) > 0) dmg = Math.round(dmg * (1 + CONFIG.hexVulnerability));
  // Loadbearing Girder (boss unique, V2 §2.5): a slice of what the armor ATE
  // shards back at the nearest attacker in arm's reach — the building
  // disagrees. (Ranged snipers stay safe: shards are shrapnel, not homing.)
  if (hasPassive(p, "unmoved") && raw > dmg && p.alive) {
    let src: Monster | null = null;
    let bestD = 1.8;
    for (const mm of state.monsters) {
      if (mm.hp <= 0) continue;
      const d = dist(p.pos, mm.pos);
      if (d < bestD) { bestD = d; src = mm; }
    }
    if (src) {
      const shard = Math.max(1, Math.round((raw - dmg) * CONFIG.girderReflectFraction));
      src.hp -= shard;
      src.lastHitBy = p.id;
      hit(state, src.pos, shard, "enemy", { school: "physical", killed: src.hp <= 0 });
    }
  }
  // The one-field ride-along that makes THE DEATH, NAMED possible
  // (COMPETITIVE.md 6 Beat 3): remember the attacker BEFORE the bar moves.
  // Written on every hit, read only at the death tick by the verifier.
  p.lastHitSrc = {
    by: typeof opts.src === "string" ? opts.src : opts.src ? opts.src.kind : "unknown",
    label: typeof opts.src === "object" ? opts.src.eliteName : undefined,
    dmg,
    hpBefore: p.hp,
    maxHp: p.maxHp,
  };
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
    // The Show's take waits for the SECOND distinct brush with death (r3
    // fold-in): the first one already carries the host's flask lecture (THE
    // ONRAMP's lowhp line) — two lectures on the same wound read as nagging.
    // A brush is an EDGE (crossing under the line); the latch clears in the
    // per-player step loop once the crawler climbs back over it. Once-ever
    // is untouched — tipsSeen still owns the ledger, so a run that ends on
    // its first brush simply leaves the tip for a later near-death.
    if (!p.lowHpNow) { p.lowHpNow = true; p.lowHpBrushes = (p.lowHpBrushes ?? 0) + 1; }
    if ((p.lowHpBrushes ?? 0) >= 2) systemTip(state, p, "lowhp");
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
    // First-ever banked draft (TUTORIAL.md B3/§5): the badge flow explained
    // once — this is what makes the draft reachable by badge-blind players.
    systemTip(state, p, "draftBanked");
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
  announce(state, "progress", `${p.name}: ${offer.title} rank ${offer.nextRank}${def && offer.nextRank >= def.maxRank ? " (MAX)" : ""}. The System approves.`);
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
  announce(state, "progress", `${p.name} learns ${info.name.toUpperCase()} — ${info.blurb}. ${where}. The crowd demands a demo.`);
  addHype(state, p, CONFIG.show.hypeEpicDrop);
}

/**
 * Re-slot an ACTIVE ability (or free a slot with null). Safe-room only — the
 * build is a committed decision, not a mid-fight reshuffle. Displaced abilities
 * go to the bench; ranks always persist.
 */
export function slotAbility(state: GameState, playerId: number, slotIdx: number, ability: AbilityId | null): void {
  const p = state.players.find((pl) => pl.id === playerId);
  // Loadout changes happen in safety: the between-floor safe room, or —
  // Roam — inside a settlement's walls (the safe-room service, in-map).
  if (!p || (!state.safeRoom && !playerInSettlement(state, p))) return;
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

/** The school this crawler's build leans toward (auto-equip bias). */
function dominantSchool(p: Player): School {
  return p.spellPower > p.attackPower ? "magic" : "physical";
}

/**
 * Give a glyph to a crawler (drop pickup / cache / sponsor gift). Fresh finds
 * keep momentum (V2 §3.1): an unlocked EMPTY socket whose current ability
 * accepts the glyph fills immediately in the field — the same exception
 * ability discovery gets; otherwise it banks on the glyph bench and waits for
 * a safe room. Rearranging is always the safe-room verb (socketGlyph).
 */
export function grantGlyph(state: GameState, p: Player, id: GlyphId): void {
  const g = (p.glyphs ??= defaultGlyphs());
  // GLYPHS, TAUGHT BY OWNING ONE (r4). Mordecai's B7 beat needs a safe room
  // AND an open socket AND a glyph in hand, which a first session mostly never
  // assembles — so the concept's first-session coverage is here, at the moment
  // the stone is actually in the crawler's possession.
  systemTip(state, p, "glyph");
  const trySlot = (slotIdx: number): boolean => {
    const ability = slotIdx === ABILITY_SLOTS ? p.abilities.ultimate : p.abilities.slots[slotIdx];
    if (!ability || !glyphMatches(id, ability)) return false;
    const arr = slotIdx === ABILITY_SLOTS ? g.ultimate : g.slots[slotIdx];
    const unlocked = slotIdx === ABILITY_SLOTS ? 1 : glyphSocketCount(p.level, slotIdx);
    for (let s = 0; s < unlocked && s < arr.length; s++) {
      if (arr[s] === null && socketLegal(p, slotIdx === ABILITY_SLOTS ? 4 : slotIdx, s, id)) {
        arr[s] = id;
        announce(state, "loot", `${p.name} sockets ${GLYPH_INFO[id].name} into ${ABILITY_INFO[ability].name}. Firmware applied.`, "normal", p.id);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < ABILITY_SLOTS; i++) if (trySlot(i)) return;
  if (trySlot(ABILITY_SLOTS)) return;
  g.bench.push(id);
  state.events.push(`${p.name} banks ${GLYPH_INFO[id].name} on the glyph bench (socket it in a safe room).`);
}

/**
 * Socket a BENCHED glyph into (slotIdx 0-3 actives | 4 = ultimate, socketIdx).
 * A SAFE-ROOM decision (same gate as re-slotting): sockets belong to the SLOT,
 * so "this slot is my projectile slot" is itself a build verb. The displaced
 * glyph returns to the bench — removal is lossless; scarcity is in FINDING.
 * No-ops (the UI communicates why): locked socket, family clash, duplicate
 * copy in the slot, glyph not on the bench, ultimate socket without an ult.
 */
export function socketGlyph(state: GameState, playerId: number, slotIdx: number, socketIdx: number, glyph: GlyphId): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || (!shopRoomFor(state, p) && !playerInSettlement(state, p))) return;
  const g = (p.glyphs ??= defaultGlyphs());
  if (!g.bench.includes(glyph)) return;
  if (slotIdx < 0 || slotIdx > ABILITY_SLOTS) return;
  const arr = slotIdx === ABILITY_SLOTS ? g.ultimate : g.slots[slotIdx];
  const unlocked = slotIdx === ABILITY_SLOTS ? (p.abilities.ultimate ? 1 : 0) : glyphSocketCount(p.level, slotIdx);
  if (socketIdx < 0 || socketIdx >= unlocked || socketIdx >= arr.length) return;
  if (!socketLegal(p, slotIdx === ABILITY_SLOTS ? 4 : slotIdx, socketIdx, glyph)) return;
  g.bench.splice(g.bench.indexOf(glyph), 1);
  const displaced = arr[socketIdx];
  if (displaced) g.bench.push(displaced);
  arr[socketIdx] = glyph;
  state.events.push(`${p.name} sockets ${GLYPH_INFO[glyph].name} (slot ${slotIdx === ABILITY_SLOTS ? "ULT" : slotIdx + 1}).`);
}

/** Pull a socketed glyph back to the bench (safe-room gated, free, lossless). */
export function unsocketGlyph(state: GameState, playerId: number, slotIdx: number, socketIdx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || (!shopRoomFor(state, p) && !playerInSettlement(state, p))) return;
  const g = p.glyphs;
  if (!g || slotIdx < 0 || slotIdx > ABILITY_SLOTS) return;
  const arr = slotIdx === ABILITY_SLOTS ? g.ultimate : g.slots[slotIdx];
  if (!arr || socketIdx < 0 || socketIdx >= arr.length) return;
  const id = arr[socketIdx];
  if (!id) return;
  arr[socketIdx] = null;
  g.bench.push(id);
  state.events.push(`${p.name} pulls ${GLYPH_INFO[id].name} back to the glyph bench.`);
}

/** Set (or clear) the ultimate slot. Safe-room only; displaced ult is benched. */
export function setUltimate(state: GameState, playerId: number, ability: AbilityId | null): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || (!state.safeRoom && !playerInSettlement(state, p))) return;
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

/**
 * Open a loot box for one player: an immediate randomized buff, DCC-style.
 * Exported so any claim source (achievements today; a future "events" system)
 * can trigger the same roll — the queueing/claiming lives with the source.
 */
export function openLootBox(state: GameState, p: Player): void {
  state.lootBoxes++;
  const undiscovered = unknownAbilities(p, state.floor, state.seed);
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

/** Materialize a catalog entry as a real Item, floor-scaled, at COMMON
 * quality — the shop sells certainty and build paths, never jackpots
 * (V2 §2.1: `rarity` is the QUALITY field on catalog items; drops roll it,
 * REFIT raises it). Shared by shop purchases and quality-common paths. */
function makeCatalogItem(state: GameState, entry: CatalogEntry, floor: number): Item {
  return {
    id: state.nextEntityId++,
    slot: entry.slot!,
    rarity: "common",
    name: entry.name,
    affixes: gearAffixes(entry, floor),
    passive: entry.passive,
    catalogId: entry.id,
  };
}

/** Drop a seeded glyph (V2 §3.1 acquisition): the modifier stone as loot. */
function dropGlyph(state: GameState, pos: Vec2): void {
  state.glyphsDroppedThisFloor = (state.glyphsDroppedThisFloor ?? 0) + 1;
  const glyph = GLYPH_IDS[nextInt(state.rng, 0, GLYPH_IDS.length - 1)];
  state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "glyph", amount: 0, glyph });
  announce(state, "loot", `A GLYPH dropped: ${GLYPH_INFO[glyph].name}. System firmware, finders keepers.`);
}

function dropLoot(state: GameState, pos: Vec2): void {
  const { rng, floor } = state;
  // Ability tomes: rare, and only while someone in the party has left to learn.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p, floor, state.seed)))];
  if (undiscovered.length > 0 && chance(rng, CONFIG.tomeDropChance)) {
    const ability = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "tome", amount: 0, ability });
    announce(state, "loot", `An ABILITY TOME dropped! The System loves an upset.`);
  }
  if (chance(rng, CONFIG.goldDropChance)) {
    // Greed Clause (System Shrine): this floor's gold pays double.
    // Slumlord's Deposit (V2 §2.3): the landlord's cut, in reverse.
    const surge = state.goldSurge ? CONFIG.shrineGreedGoldMult : 1;
    const rent = state.players.some((p) => p.alive && hasPassive(p, "rent")) ? CONFIG.rentGoldMult : 1;
    const amount = Math.round((nextInt(rng, CONFIG.goldMin, CONFIG.goldMax) + Math.floor(floor * CONFIG.goldPerFloor)) * surge * rent);
    state.loot.push({ id: state.nextEntityId++, pos: { x: pos.x, y: pos.y }, kind: "gold", amount });
  }
  // Health potions no longer rain from chaff. Measured before removal: they
  // supplied 280-780 free HP per run (~a third of all damage taken absorbed),
  // and winners spent 0.0% of the run below 35% HP — health wasn't scary.
  // Healing is now a DECISION: field rations, sponsor gifts, level-ups, the
  // flask (returning), leech — all chosen, none ambient.
  //
  // THE V2 DROP TABLE (§2.2) — one seeded draw per equipment drop:
  //   55% catalog COMPONENT at rolled quality (loot advances the plan, and
  //       sometimes spectacularly), 15% catalog COMPLETED (floor-gated, the
  //       "skipped the shop line" windfall), 25% commodity gear (commons/
  //       magics only — dismantle fodder), 5% GLYPH (floor 2+).
  if (chance(rng, CONFIG.lootDropChance)) {
    const jitter = { x: pos.x + (nextFloat(rng) - 0.5) * 0.6, y: pos.y + (nextFloat(rng) - 0.5) * 0.6 };
    const roll = nextFloat(rng);
    const completedOk = floor >= CONFIG.dropCompletedFromFloor;
    // §3.5: glyphs drip at a rate that can actually fill nine sockets, but a
    // per-floor budget keeps supply STEADY instead of spiky — a hot floor no
    // longer hands over half the pool, and a cold one still pays out.
    const glyphOk = floor >= CONFIG.dropGlyphFromFloor
      && (state.glyphsDroppedThisFloor ?? 0) < CONFIG.glyphDropsPerFloorCap;
    const compEnd = CONFIG.dropComponentShare;
    const complEnd = compEnd + CONFIG.dropCompletedShare;
    const glyphStart = 1 - CONFIG.dropGlyphShare;
    if (glyphOk && roll >= glyphStart) {
      dropGlyph(state, jitter);
    } else if (roll < compEnd || (roll < complEnd && !completedOk)) {
      const item = rollCatalogDrop(rng, floor, "basic", () => state.nextEntityId++);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    } else if (roll < complEnd) {
      const item = rollCatalogDrop(rng, floor, "advanced", () => state.nextEntityId++);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    } else {
      // Commodity gear: worn for two floors, then dismantled (shard fodder).
      const item = generateItem(rng, floor, () => state.nextEntityId++);
      state.loot.push({ id: state.nextEntityId++, pos: jitter, kind: "item", amount: 0, item, rarity: item.rarity });
    }
  }
}

/** Duration of a chill/poison THIS player applies: the Sump Crown (boss
 * unique, V2 §2.5) stretches the wearer's slows and toxins by half. */
function statusDuration(p: Player, base: number): number {
  return hasPassive(p, "sumpcrown") ? base * CONFIG.sumpStatusDurMult : base;
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
    melee?: boolean; // a SWING (not a bolt): the duelist's flourish answers these

    ability?: AbilityId; // the casting ability (glyph hooks: brand/accelerant)
    empowered?: boolean; // Static Charge's every-3rd cast
    breaker?: boolean; // this is a BANKED Breaker hit (Open Season / CHAIN REACTION)
    // §6.4.6: this damage cost the player NO ATTENTION (the orbit grind is
    // the only one today). Purely an instrument tag — nothing in the sim
    // branches on it — but it is the difference between "the passive is the
    // game" and "the press is the game", which is the whole of R3.
    ambient?: boolean;
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
  // Slipstream glyph: the post-movement surge sharpens everything briefly.
  if ((p.slipstreamT ?? 0) > 0) base *= CONFIG.glyphSlipstreamDmgMult;
  // PHASE-C conditional glyphs (V2 §5.2): Culling Edge, Point Blank, Longshot
  // and Static Charge all read the SITUATION, so they resolve here rather than
  // in a param function that cannot know how far away the body is.
  if (opts.ability && !opts.effect) {
    base *= glyphHitMult(p, opts.ability, {
      range: dist(p.pos, m.pos),
      hpFrac: m.maxHp > 0 ? m.hp / m.maxHp : 1,
      empowered: opts.empowered,
    });
  }
  // OPEN SEASON (Breaker rider): break, then dump. The window is on the
  // MONSTER, so the whole party cashes it in — that is the point of a
  // cross-ability combo hook.
  if ((m.vulnT ?? 0) > 0 && !opts.effect) base *= 1 + (m.vulnBonus ?? 0);
  // INJUNCTION: you bought twelve violent seconds; this is the violence.
  if ((p.injunctionT ?? 0) > 0 && !opts.effect) base *= 1 + injunctionParams(p).damageBonus;
  // Brandmark glyph: a branded enemy takes more from this crawler's OTHER
  // abilities — the mark is the setup, the cash-in comes from a second slot.
  if (
    (m.brandT ?? 0) > 0 && m.brandBy === p.id &&
    opts.ability && opts.ability !== m.brandAbility && !opts.effect
  ) {
    base *= 1 + CONFIG.glyphBrandBonus;
  }
  let dmg = rollDamage(state.rng, base, damageVariance(p)); // the WEAPON sets the dice
  if (isCrit) dmg = Math.round(dmg * CONFIG.playerCritMult);
  if (m.affix === "shielded") dmg = Math.max(1, Math.round(dmg * CONFIG.shieldedDamageTakenMult));
  // Shieldbearer's FRONTAL GUARD (directional-guard verb): while it is
  // neither swinging nor staggered, hits from inside its facing arc (it
  // faces its prey) are mostly eaten by the tower shield. Make it swing,
  // stagger it, or hit it from behind — footwork as a damage multiplier.
  let guarded = false;
  if (m.kind === "shieldbearer" && m.windup <= 0 && m.stagger <= 0) {
    const prey = nearestPlayer(state, m.pos);
    if (prey) {
      const facing = normalize({ x: prey.pos.x - m.pos.x, y: prey.pos.y - m.pos.y });
      const toAttacker = normalize({ x: p.pos.x - m.pos.x, y: p.pos.y - m.pos.y });
      if (facing.x * toAttacker.x + facing.y * toAttacker.y > CONFIG.guardArcCos) {
        dmg = Math.max(1, Math.round(dmg * CONFIG.guardDamageTakenMult));
        guarded = true;
        if (!m.noticed) {
          m.noticed = true;
          state.events.push("The husk takes it ON THE SHIELD. Make it swing, or go around.");
        }
      }
    }
  }
  // The Darling's stardust (shield-aura verb): her entourage takes half
  // while she lives — and SHE takes half again more. The kill order is
  // stated out loud; execution inside her entourage's screen is the exam.
  if ((m.shieldT ?? 0) > 0) {
    dmg = Math.max(1, Math.round(dmg * CONFIG.darlingShieldMult));
    guarded = true; // dim numbers: the shield is doing the work
  }
  if (m.kind === "darling") dmg = Math.round(dmg * CONFIG.darlingTakenMult);
  // Featured Extra's FLOURISH (riposte verb): melee into the raised blade is
  // parried AND returned. Hold the swing — hardest lesson in the game — or
  // answer with ranged/magic; the flourish only reads steel.
  if (m.kind === "duelist" && (m.riposteT ?? 0) > 0 && opts.melee) {
    dmg = Math.max(1, Math.round(dmg * CONFIG.riposteDamageTakenMult));
    guarded = true;
    const reflect = Math.max(1, Math.round(base * CONFIG.riposteReflectFraction));
    if (damagePlayerHit(state, p, reflect, { dir: normalize({ x: p.pos.x - m.pos.x, y: p.pos.y - m.pos.y }), src: m })) {
      handlePlayerDeath(state, p, `${p.name} swung into the flourish. The riposte was the whole show.`);
    }
    if (!m.noticed) {
      m.noticed = true;
      state.events.push("RIPOSTED! The Extra's flourish answers steel with steel. Wait it out, or shoot it.");
    }
  }
  // School resists (5.8 phase 3): armored shrugs physical, warded shrugs magic
  // — from the elite affix roll or the archetype's innate tag. The party's
  // damage MIX is the counterplay, so the reduction reads loud (dim numbers).
  const resisted = monsterResist(m) === (opts.school ?? "physical");
  if (resisted) dmg = Math.max(1, Math.round(dmg * CONFIG.resistDamageTakenMult));
  // Demolition Permit (V2 §2.3): a hit that BREAKS poise lands +40% —
  // predicted with the same grace/juggernaut rules the poise section applies.
  if (m.hp > 0 && hasPassive(p, "wrecker") && !opts.effect) {
    const aw = ARCHETYPES[m.kind];
    const em = m.elite ? CONFIG.elitePoiseMult : 1;
    const jug = m.affix === "juggernaut";
    const chan = m.windupKind === "ritual";
    const graced = (jug || (m.staggerGraceT ?? 0) > 0) && !chan;
    const poiseAdd = dmg * (opts.poiseMult ?? 1) * (chan ? CONFIG.channelPoiseTakenMult : 1);
    const breaks = !graced && ((opts.shatterPoise && m.kind !== "boss") || m.poiseDmg + poiseAdd >= m.maxHp * aw.poise * em);
    if (breaks) dmg = Math.round(dmg * CONFIG.wreckerBonus);
  }
  // ---- BOSSES V2 damage routing ------------------------------------------
  // Order matters and it is the order a player reads it in: an intermission
  // eats everything, then the shield pool, then the plates, then whatever is
  // still shielding the body (aides, conveyors, a sponsor bubble).
  if (m.kind === "boss" && (m.invulnT ?? 0) > 0) {
    // V6 — THE COMMERCIAL BREAK. Untargetable while the arena re-deals.
    hit(state, m.pos, 0, "enemy", { school: opts.school, resisted: true });
    return;
  }
  // V2 — SHIELD POOL: absorb-HP in front of the health bar that regrows unless
  // it is being broken. The Sponsor's only erodes to ONE school — Diablo's
  // "immune to X" wearing a sponsorship joke, not a different genre.
  if ((m.shieldHp ?? 0) > 0 && dmg > 0) {
    const school = opts.school ?? "physical";
    if (m.shieldSchool && m.shieldSchool !== school) {
      dmg = 1; // the brand holds. Bring the other school.
      guarded = true;
    } else {
      const absorbed = Math.min(m.shieldHp!, dmg);
      m.shieldHp! -= absorbed;
      dmg -= absorbed;
      m.shieldRegenT = CONFIG.shieldRegenDelay;
      guarded = true;
      if (m.shieldHp! <= 0) {
        m.shieldHp = 0;
        m.stagger = Math.max(m.stagger, CONFIG.shieldBreakStagger);
        m.staggerGraceT = 0;
        bossEvent(state, {
          kind: "shieldbreak", monsterId: m.id, bossId: m.bossId,
          duration: CONFIG.shieldBreakStagger, pos: { x: m.pos.x, y: m.pos.y },
        });
        advanceBossPhase(state, m, "mechanic"); // the PLAYER moved the story
      }
    }
  }
  // V1 — PLATES / WEAK POINTS. The front plate that does not ignore this
  // school eats the hit; the body only takes a fraction while any stands.
  if (m.plates && m.plates.length > 0 && dmg > 0) {
    const live = m.plates.filter((pl) => !pl.broken);
    if (live.length > 0) {
      const school = opts.school ?? "physical";
      const target = live.find((pl) => pl.school !== school);
      if (target) {
        const capped = Math.min(dmg, Math.max(1, Math.round(target.maxHp * CONFIG.plateHitCapFraction)));
        target.hp -= capped;
        hit(state, { x: m.pos.x, y: m.pos.y + 0.6 }, capped, "enemy", { school: opts.school });
        if (target.hp <= 0) breakBossPlate(state, m, target);
      } else {
        guarded = true; // every remaining plate shrugs this school off
      }
      // ARMOUR plates (the school-tagged ones) are what actually shield the
      // body. A bare plate — the Rent Collector's lockbox — is a bonus
      // OBJECTIVE, not extra health: measured, taxing the body behind a
      // single lockbox tripled the floor-3 time-to-kill and dropped bot clear
      // rate from 26/32 to 15/32. A plate must change the ASK, not the HP.
      if (live.some((pl) => pl.school)) {
        dmg = Math.max(1, Math.round(dmg * CONFIG.plateBossDamageMult));
      }
    }
  }
  // Shield ANCHORS: things that must die before the body opens up. Aides
  // (the council format), running conveyors (The Line Supervisor), and the
  // SPONSORED mutator's hazard-immune bubble it has to be pulled out of.
  if (m.kind === "boss") {
    if (state.monsters.some((o) => o.hp > 0 && o.tetherId === m.id)) {
      dmg = Math.max(1, Math.round(dmg * CONFIG.boardShieldMult));
      guarded = true;
    }
    if (m.bossId === "linesupervisor" && (state.breakables ?? []).some((b) => b.onBreak === "shutdown")) {
      dmg = Math.max(1, Math.round(dmg * CONFIG.supervisorGuardMult));
      guarded = true;
    }
    if (m.bossMutators?.includes("sponsored") && m.home && dist(m.pos, m.home) <= CONFIG.sponsoredBubbleRadius) {
      dmg = Math.max(1, Math.round(dmg * CONFIG.sponsoredDamageMult));
      guarded = true;
    }
  }
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
  // Getting hurt IS being seen (LOS aggro): the victim commits to the hunt
  // and raises the pack's alarm — even a killing shot wakes the neighbors.
  alertMonster(state, m);
  // Interrupting the residents: damage breaks the scene too (staging v2 —
  // detection in ai.ts is the usual path; an opening shot from the dark
  // still counts as introducing yourself).
  breakResidentScene(state, m);
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
  // LINKED elites (six-pack): their pack SOAKS a share of every hit while
  // any ally stands in the link — thin the pack, then break the elite.
  if (m.affix === "linked" && dmg > 1) {
    const allies = state.monsters.filter(
      (o) => o !== m && o.hp > 0 && dist(m.pos, o.pos) <= CONFIG.linkedRadius,
    );
    if (allies.length > 0) {
      const soaked = Math.round(dmg * CONFIG.linkedSoakFraction);
      m.hp += soaked; // the elite keeps this share...
      const share = Math.max(1, Math.round(soaked / allies.length));
      for (const ally of allies) {
        ally.hp -= share; // ...the link pays it forward (no re-triggered effects)
        ally.lastHitBy = p.id;
        hit(state, ally.pos, share, "enemy", { school: opts.school });
      }
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("The pack SOAKS the hit — a soul link. Thin the pack, then break the elite.");
      }
    }
  }
  const a = ARCHETYPES[m.kind];
  const eliteMult = m.elite ? CONFIG.elitePoiseMult : 1;
  if (m.hp > 0) {
    // Interrupts are EARNED, not free: poise drains over time (stepMonster),
    // and a freshly-staggered boss/elite keeps its composure for a grace
    // window where poise doesn't build at all — raw DPS can't stun-lock a
    // headliner. The advertised exception: an interruptible CHANNEL (Dark
    // Ritual) always listens, and poise counts double while it runs.
    // JUGGERNAUT (six-pack): immune to stagger AND knockback — the poise
    // meter never fills and shoves bounce off. Kite it; don't CC it.
    const juggernaut = m.affix === "juggernaut";
    const channeling = m.windupKind === "ritual";
    const graced = (juggernaut || (m.staggerGraceT ?? 0) > 0) && !channeling;
    // POISE WRECKER (Phase C): double poise, and your staggers last longer.
    const glyphPoise = opts.ability && !opts.effect
      ? glyphPoiseMult(p, opts.ability, opts.empowered) : 1;
    if (!graced) {
      m.poiseDmg += dmg * (opts.poiseMult ?? 1) * glyphPoise * (channeling ? CONFIG.channelPoiseTakenMult : 1);
    }
    // BREAKER (V2 R5): the banked hit's poise shatter is BASE kit now — the
    // telegraph system finally has the answer it never shipped. Bosses are not
    // outright staggered by it; they eat double poise instead (overchargeParams).
    if (!graced && ((opts.shatterPoise && m.kind !== "boss") || m.poiseDmg >= m.maxHp * a.poise * eliteMult)) {
      m.poiseDmg = 0;
      m.stagger = CONFIG.staggerDuration
        + (opts.ability && hasGlyph(p, opts.ability, "poise_wrecker") ? CONFIG.glyphPoiseWreckerStagger : 0);
      breakerStaggerRiders(state, p, m, opts.breaker);
      if (m.kind === "boss" || m.elite) {
        m.staggerGraceT = m.kind === "boss" ? CONFIG.bossStaggerGrace : CONFIG.eliteStaggerGrace;
        if (m.kind === "boss") systemTip(state, p, "staggerGrace");
      }
      systemTip(state, p, "stagger");
      m.windup = 0; // interrupted — the committed attack never lands
      m.windupKind = undefined;
      m.chargeT = 0; // a poise break also stops a rush cold
      m.chargeDir = undefined;
    }
    // Pikeman's Rebuttal (V2 §2.3): melee hits landed from real range shove
    // harder — the hallway is a weapon.
    const longarm =
      opts.melee && hasPassive(p, "longarm") && dist(p.pos, m.pos) >= CONFIG.longarmMinDist
        ? CONFIG.longarmKnockback : 0;
    const kb = (opts.knockback ?? 0) + longarm;
    if (opts.dir && kb > 0 && !juggernaut) {
      moveWithCollision(state.map, m.pos, opts.dir, kb / (a.mass * eliteMult), isWalkable);
    }
  }
  hit(state, m.pos, dmg, isCrit ? "crit" : "enemy", {
    dir: opts.dir, killed: m.hp <= 0,
    // Deleted, not defeated: the blow overshot by a third of the bar.
    overkill: (m.hp <= -0.35 * m.maxHp) || undefined,
    school: opts.school,
    resisted: (resisted || guarded) || undefined, // guarded hits read dim too
    effect: opts.effect,
  });

  p.damageDealt += dmg;
  if (state.dmgBySource) {
    // §6.4.6's reciprocal contract. Untagged paths bucket as "other" rather
    // than vanishing, so the denominator is genuinely ALL damage dealt.
    const key = (opts.ability ?? (opts.effect ? "dot" : "other")) + (opts.ambient ? ":ambient" : "");
    state.dmgBySource[key] = (state.dmgBySource[key] ?? 0) + dmg;
  }
  if (isCrit) {
    addHype(state, p, CONFIG.show.hypeCrit);
    // THE SHOW, TAUGHT ON A HYPE EVENT THE PLAYER CAUSED (r4). The hype bar and
    // the viewer count are on the glass from second one and nothing ever
    // explained them; a crit is the cheapest honest hook — the number visibly
    // jumps in the same frame the crawler made it jump.
    systemTip(state, p, "hype");
  }
  // Venom Clause (chase legendary): crits inject a poison stack — the DoT
  // ticks back through this same choke point, so resists/caps keep applying.
  // (statusDuration: the Sump Crown stretches the wearer's poison/chill.)
  if (isCrit && m.hp > 0 && hasPassive(p, "venom")) {
    applyStatus(m, {
      kind: "poison", duration: statusDuration(p, CONFIG.poisonDuration), school: "physical",
      magnitude: Math.max(1, Math.round(dmg * CONFIG.venomTickFraction)), sourceId: p.id,
    });
  }
  // GLYPH RIDERS (V2 §3.3) — never re-triggered by DoT ticks (rule 6-adjacent:
  // a burn tick must not brand or re-ignite).
  if (opts.ability && !opts.effect && m.hp > 0 && dmg > 0) {
    // Accelerant: hits IGNITE for a fraction of the hit over the burn window.
    if (hasGlyph(p, opts.ability, "accelerant")) {
      const perTick = (dmg * CONFIG.glyphAccelerantFrac) / (CONFIG.burnDuration / CONFIG.burnTickSeconds);
      applyStatus(m, {
        kind: "burn", duration: CONFIG.burnDuration, school: "magic",
        magnitude: Math.max(1, Math.round(perTick)), sourceId: p.id,
      });
    }
    // Brandmark: stamp the target — this crawler's OTHER abilities cash in.
    if (hasGlyph(p, opts.ability, "brandmark")) {
      m.brandT = CONFIG.glyphBrandDuration;
      m.brandAbility = opts.ability;
      m.brandBy = p.id;
    }
    // ENVENOMED (Phase C): a chance to inject a poison stack. Seeded — the
    // roll comes from state.rng like every other chance in the sim.
    if (hasGlyph(p, opts.ability, "envenomed") && chance(state.rng, CONFIG.glyphEnvenomedChance)) {
      applyStatus(m, {
        kind: "poison", duration: statusDuration(p, CONFIG.poisonDuration), school: "physical",
        magnitude: Math.max(1, Math.round(dmg * CONFIG.venomTickFraction)), sourceId: p.id,
      });
    }
    // CRYO-ETCH (Phase C): hits chill.
    if (hasGlyph(p, opts.ability, "cryo_etch")) {
      applyStatus(m, {
        kind: "chill", duration: statusDuration(p, CONFIG.glyphCryoDuration), school: "magic",
        magnitude: m.kind === "boss" ? CONFIG.glyphCryoChill * CONFIG.chillBossMult : CONFIG.glyphCryoChill,
      });
    }
  }
  // Ragged Edge (melee.bleed): crits bleed, using the shipped poison rules.
  if (isCrit && m.hp > 0 && opts.ability === "melee" && rank(p, "melee.bleed") > 0) {
    applyStatus(m, {
      kind: "poison", duration: statusDuration(p, CONFIG.poisonDuration), school: "physical",
      magnitude: Math.max(1, Math.round(dmg * CONFIG.venomTickFraction)), sourceId: p.id,
    });
  }
  // Rootcutter Shears (boss unique): every 3rd melee hit SNARES the target —
  // implemented as a heavy chill (move + windup crawl), refresh-on-reapply.
  if (opts.melee && !opts.effect && m.hp > 0 && hasPassive(p, "snare3")) {
    p.shearsCount = (p.shearsCount ?? 0) + 1;
    if (p.shearsCount >= CONFIG.shearsEveryHits) {
      p.shearsCount = 0;
      applyStatus(m, {
        kind: "chill", duration: statusDuration(p, CONFIG.shearsSnareSeconds), school: "magic",
        magnitude: m.kind === "boss" ? 0.8 * CONFIG.chillBossMult : 0.8,
      });
      hit(state, m.pos, 0, "weapon"); // snip — the snare reads on camera
    }
  }
  // Blood Subscription (chase legendary) / Ambulance Chaser (V2 completed
  // work): heal a slice of the damage you deal, capped per hit so ultimates
  // don't refill the bar in one cast. Subscription supersedes its own rung.
  const leechFrac = hasPassive(p, "leech") ? CONFIG.leechFraction
    : hasPassive(p, "chaser") ? CONFIG.chaserFraction : 0;
  if (p.alive && p.hp < p.maxHp && leechFrac > 0) {
    const heal = Math.min(
      Math.round(dmg * leechFrac),
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
    if (damagePlayerHit(state, p, reflect, { roll: false, src: m })) {
      handlePlayerDeath(state, p, `${p.name} beat ${m.eliteName ?? "an elite"} to death with their own health bar. THORNS, folks.`);
    }
  }
}

/** Body radius (tiles) a hit check must respect: clipping a brute's shoulder
 * counts. Elites are rendered bigger, so their hitbox grows to match. */
export function bodyRadius(m: Monster): number {
  return ARCHETYPES[m.kind].radius * (m.elite ? CONFIG.eliteScale : m.veteran ? CONFIG.veteranScale : 1);
}

/** True when `m` is inside a swing from `pos` along `facing`: reach extends by
 * the target's body radius, and the arc widens by its angular size — the
 * question is "does the sweep touch the BODY", not "is the center on the line". */
function inSwing(pos: Vec2, facing: Vec2, m: Monster, range: number, arc: number): boolean {
  const toMon = { x: m.pos.x - pos.x, y: m.pos.y - pos.y };
  const d = dhypot(toMon.x, toMon.y);
  const r = bodyRadius(m);
  if (d - r > range) return false;
  const halfArc = arc / 2 + dasin(Math.min(1, r / Math.max(d, r)));
  return angleBetween(facing, toMon) <= halfArc;
}

function doPlayerAttack(state: GameState, p: Player, aim: Vec2, move: Vec2, arcMult = 1): void {
  const mp = meleeParams(p);
  let facing = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = facing;
  p.cd.melee = mp.cooldown * cdMult(p);
  p.attackSwing = 0.15;
  // R4: a stance swap fires this as a FREE strike at a wider arc (Brawler) —
  // the caller restores the cooldown, so the swap never eats the melee beat.
  const swapStrike = p.stanceStrikeMult ?? 0;
  const arc = mp.arc * arcMult;
  bloodPrice(state, p, "melee");
  const empowered = staticCharged(p, "melee");

  // The swing lunges a short step toward the aim — but never THROUGH a target
  // already in reach. Overshooting point-blank enemies (which puts them BEHIND
  // the swing arc) was the classic "that should have hit" melee whiff.
  // And never AGAINST the run: mouse aim lets you swing behind yourself
  // mid-sprint, and a backward yank while sprinting forward read as pure
  // jitter (playtest). Planted crawlers lunge anywhere; runners only when
  // the swing agrees with their heading.
  const moveDir = normalize(move);
  const withTheRun =
    (moveDir.x === 0 && moveDir.y === 0) || facing.x * moveDir.x + facing.y * moveDir.y > 0;
  let nearestAhead = Infinity;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    if (angleBetween(facing, toMon) > Math.PI / 2) continue; // behind the swing
    const edge = dhypot(toMon.x, toMon.y) - bodyRadius(m);
    if (edge < nearestAhead) nearestAhead = edge;
  }
  const lunge = Math.min(CONFIG.meleeLungeDistance, Math.max(0, nearestAhead - 0.55));
  if (lunge > 0 && withTheRun) moveWithCollision(state.map, p.pos, facing, lunge, isWalkable);

  // Aim assist: if the swing as aimed would hit nothing but SOMETHING is in
  // arm's reach, snap the swing to the nearest such target — at melee range
  // the player's intent is "hit the thing next to me", not the exact cursor.
  const wouldHit = state.monsters.some(
    (m) => m.hp > 0 && inSwing(p.pos, facing, m, mp.range, arc),
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
  // Arcane Lens glyph: the swing deals MAGIC off spell power (power() and
  // castSchool are both lens-aware) — an explicit socket beats a default.
  const school = castSchool(p, "melee");
  let connected = false;
  // Wide Arc is an ENTRY node: it changes what the swing TOUCHES. The target
  // cap is the honest half of that (a wider arc with no cap would have been
  // the same printed number in a different unit), and Surge widens it further
  // on a BANKED hit.
  const cap = mp.targetCap + (oc ? oc.extraTargets : 0);
  let touched = 0;
  // SPITE (Bulwark capstone): everything the brace absorbed rides this swing.
  const spite = p.spiteBank ?? 0;
  if (spite > 0) p.spiteBank = 0;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    if (touched >= cap) break;
    if (!inSwing(p.pos, facing, m, mp.range, arc)) continue;
    touched++;
    const toMon = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
    // EXECUTIONER capstone: finish the wounded.
    const execute = rank(p, "melee.execute") > 0 && m.hp < m.maxHp * 0.3 ? 1.6 : 1;
    const swap = swapStrike > 0 ? swapStrike : 1;
    const dmg = power(p, "melee") * mp.damageMult * execute * stanceMult(p, "melee") * (oc?.mult ?? 1) * comboMult * swap
      + (touched === 1 ? spite : 0);
    damageMonster(state, p, m, dmg, {
      dir: normalize(toMon), knockback: CONFIG.meleeKnockback, school, melee: true, ability: "melee",
      forceCrit: momentum, shatterPoise: oc?.shatter, poiseMult: mp.poiseMult,
      breaker: oc ? true : undefined, empowered,
    });
    // Echo Strike: the overcharged swing lands a second, softer hit.
    if (oc && oc.echoFrac > 0 && m.hp > 0) {
      damageMonster(state, p, m, dmg * oc.echoFrac, { dir: normalize(toMon), school, ability: "melee" });
    }
    // Heavy Blows: a killing swing's OVERKILL splashes to everything nearby —
    // the big hit carries through the corpse.
    if (heavySplash && m.hp < 0) {
      const overkill = -m.hp;
      for (const other of state.monsters) {
        if (other === m || other.hp <= 0) continue;
        if (dist(m.pos, other.pos) > CONFIG.meleeOverkillRadius) continue;

        // §7: every damage path carries its ability tag. This IS the melee
        // swing, carried through the corpse — so it routes melee glyphs and
        // counts against §6.4.6's melee share like the swing it came from.
        damageMonster(state, p, other, overkill, { allowCrit: false, school: "physical", ability: "melee" });
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
      if (!inSwing(dc.pos, facing, m, mp.range, arc)) continue;
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
  // The swing pops smashable dressing in the arc (phase 5): the Diablo
  // barrel, at last. Same reach test the monsters get.
  smashBreakables(state, ({ pos }) => {
    const to = { x: pos.x - p.pos.x, y: pos.y - p.pos.y };
    return dhypot(to.x, to.y) <= mp.range + 0.25 && angleBetween(facing, to) <= arc / 2;
  });
  // RIVALS: the same swing arc also cuts rivals sharing this floor.
  for (const v of rivalTargets(state, p)) {
    const toV = { x: v.pos.x - p.pos.x, y: v.pos.y - p.pos.y };
    const edge = dhypot(toV.x, toV.y) - 0.35;
    if (edge > mp.range || angleBetween(facing, toV) > arc / 2) continue;
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
  lineworker: CONFIG.show.hypeLineworker,
  sentinel: CONFIG.show.hypeSentinel,
  slagbreaker: CONFIG.show.hypeSlagbreaker,
  toysoldier: CONFIG.show.hypeToysoldier,
  greeter: CONFIG.show.hypeGreeter,
  lasher: CONFIG.show.hypeLasher,
  understudy: CONFIG.show.hypeUnderstudy,
  hexer: CONFIG.show.hypeHexer,
  cutpurse: CONFIG.show.hypeCutpurse,
  warden: CONFIG.show.hypeWarden,
  digger: CONFIG.show.hypeDigger,
  shieldbearer: CONFIG.show.hypeShieldbearer,
  cleric: CONFIG.show.hypeCleric,
  archivist: CONFIG.show.hypeArchivist,
  colossus: CONFIG.show.hypeColossus,
  stagehand: CONFIG.show.hypeStagehand,
  sniper: CONFIG.show.hypeSniper,
  duelist: CONFIG.show.hypeDuelist,
  darling: CONFIG.show.hypeDarling,
  canceled: CONFIG.show.hypeCanceled,
  suitactor: CONFIG.show.hypeSuitactor,
  suitguy: CONFIG.show.hypeSuitguy,
  foreman: CONFIG.show.hypeForeman,
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
    if (damagePlayerHit(state, p, base, { dir: away, src: m })) {
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
    // An escape isn't a kill — it's a segment. No corpse, no XP, no loot.
    if (m.escaped) {
      if (m.kind === "suitguy") {
        // The MERCY TEST: letting the guy in the suit go pays the whole
        // party in hype. The crowd loves a spared civilian.
        announce(state, "show", "THE SUIT ACTOR GETS AWAY. The crowd is ON ITS FEET — mercy plays HUGE in the overnights.");
        for (const pl of state.players) if (pl.alive) addHype(state, pl, CONFIG.suitguyEscapeHype);
      } else {
        announce(state, "show", `THE REPO RAT ESCAPES with ${m.carry ?? 0} gold of the System's petty cash. The accountants are FURIOUS. Great television.`);
      }
      continue;
    }
    // ---- BOSSES V2: what a boss's ADDS do when they die -------------------
    const tetherBoss = m.tetherId !== undefined
      ? state.monsters.find((o) => o.id === m.tetherId && o.hp > 0)
      : undefined;
    if (tetherBoss) {
      // UNION RULES (mutator): its adds get back up ONCE, on a delay. Kill
      // them away from the boss (past tetherRange they stop feeding it) or
      // simply burst them twice — but the wave costs you two clears, not one.
      if (tetherBoss.bossMutators?.includes("unionrules") && !m.tetherRevived) {
        m.tetherRevived = true;
        m.hp = Math.max(1, Math.round(m.maxHp * 0.4));
        m.stagger = CONFIG.mutatorUnionReviveDelay; // down, not out
        m.windup = 0;
        m.windupKind = undefined;
        survivors.push(m);
        state.events.push("UNION RULES: it is getting back up. Finish it properly.");
        continue;
      }
      // THE COUNCIL FORMAT: an aide's death hands its VERB to the body, so
      // the kill ORDER is the fight — leave the wrong one for last and you
      // spend the rest of the encounter fighting the verb you gave away.
      if (m.eliteName?.startsWith("MEMBER:")) {
        const inherited: Partial<Record<MonsterKind, EliteAffix>> = {
          cleric: "vampiric", hexer: "executioner", shieldbearer: "armored",
          sentinel: "mortar", duelist: "thorns",
        };
        const gained = inherited[m.kind];
        if (gained) {
          tetherBoss.affix = gained;
          tetherBoss.affixCd = 0;
          announce(state, "boss", `${m.eliteName} IS EXCUSED — and the Board takes the seat. It is [${gained.toUpperCase()}] now.`);
        }
        advanceBossPhase(state, tetherBoss, "mechanic");
      } else {
        // A plain tethered add: one link fewer feeding the thing you came for.
        tetherBoss.bossCount = (tetherBoss.bossCount ?? 0) + 1;
      }
    }
    // Kill credit to the last hitter (computed early — several V2 passive
    // hooks below read it; loot boxes + per-player achievements still apply).
    const killer = state.players.find((pl) => pl.id === m.lastHitBy) ?? state.players[0];
    // Every fallen regular leaves a raisable corpse (necromancer fuel) —
    // unless the killer rings the Front Desk Bell (boss unique, V2 §2.5):
    // checkout is immediate, and every denied corpse pays out.
    if (m.kind !== "boss") {
      if (hasPassive(killer, "denycorpse")) {
        killer.gold += CONFIG.bellCorpseGold;
        if (killer.alive && killer.hp > 0) {
          killer.hp = Math.min(killer.maxHp, killer.hp + Math.max(1, Math.round(killer.maxHp * CONFIG.bellCorpseHealFraction)));
        }
        hit(state, m.pos, CONFIG.bellCorpseGold, "gold");
      } else {
        state.corpses.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: m.kind, t: CONFIG.corpseTtl });
        if (state.corpses.length > CONFIG.corpseMax) state.corpses.shift();
      }
    }
    // Furnace Draft (boss unique, V2 §2.5): a death by fire is contagious —
    // the burn jumps to the nearest living enemy, stacks and all.
    const burning = m.statuses?.find((s) => s.kind === "burn");
    if (burning && hasPassive(killer, "spreadburn")) {
      let tgt: Monster | null = null;
      let bd: number = CONFIG.spreadburnRadius;
      for (const o of state.monsters) {
        if (o === m || o.hp <= 0) continue;
        const d = dist(m.pos, o.pos);
        if (d < bd) { bd = d; tgt = o; }
      }
      if (tgt) {
        applyStatus(tgt, {
          kind: "burn", duration: CONFIG.burnDuration, school: "magic",
          magnitude: burning.magnitude, sourceId: killer.id,
        });
        hit(state, m.pos, 0, "chain", { to: tgt.pos });
      }
    }
    // Executioner's Rebate glyph (rule 8): a kill inside the cast window
    // refunds a slice of the cooldown — capped per cast by the budget.
    // ENCORE CLAUSE rides the SAME accumulator (V2 §5.4 flag 2): one budget,
    // one clamp, whichever glyph armed the window. On floor 15 Fault Line's
    // raw refund would be 4% x ~20 kills = 80% of a 40s cooldown; the budget
    // is what holds it to 50%, so §6.4.10 pins the budget rather than the rate.
    if ((killer.rebateT ?? 0) > 0 && killer.rebateAbility && (killer.rebateBudget ?? 0) > 0) {
      const rate = hasGlyph(killer, killer.rebateAbility, "encore_clause")
        ? CONFIG.glyphEncoreRefund : CONFIG.glyphRebateFrac;
      const refund = Math.min((killer.rebateCd0 ?? 0) * rate, killer.rebateBudget ?? 0);
      if (refund > 0) {
        killer.cd[killer.rebateAbility] = Math.max(0, (killer.cd[killer.rebateAbility] ?? 0) - refund);
        killer.rebateBudget = (killer.rebateBudget ?? 0) - refund;
      }
    }
    // A bomber shot down before reaching anyone still cooks off — half radius.
    if (m.kind === "bomber" && !m.exploded) explodeBomber(state, m, CONFIG.bomberDeathRadiusMult);
    // Any purse-carrier spills what it holds: the caught Repo Rat drops its
    // whole remaining haul; a cutpurse refunds your gold WITH interest.
    if ((m.carry ?? 0) > 0) {
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "gold", amount: m.carry! });
      m.carry = 0;
    }
    // A destroyed greeter DISCHARGES: short-fused spark blasts around the
    // chassis (on-death punctuation — one last decision after the kill).
    if (m.kind === "greeter") {
      for (let i = 0; i < CONFIG.greeterSparkCount; i++) {
        const a = (i / CONFIG.greeterSparkCount) * Math.PI * 2 + m.id * 0.7;
        state.hazards.push({
          id: state.nextEntityId++,
          pos: { x: m.pos.x + dcos(a) * 0.7, y: m.pos.y + dsin(a) * 0.7 },
          t: CONFIG.greeterSparkDelay,
          total: CONFIG.greeterSparkDelay,
          radius: CONFIG.greeterSparkRadius,
          damage: m.damage * CONFIG.greeterSparkDmgMult,
          kind: "blast",
        });
      }
    }
    state.killCount++;
    killsThisStep++;
    killer.kills++;
    killer.killsThisStep++;
    creditQuestKill(state, m);
    // Killing the tracked stronghold leader clears it — even before any
    // clearStronghold quest exists to track it (talkToNpc reads this flag).
    if (state.strongholdLeaderId >= 0 && m.id === state.strongholdLeaderId && !state.strongholdCleared) {
      state.strongholdCleared = true;
      state.events.push(`${m.eliteName ?? "The stronghold's leader"} falls. The camp scatters.`);
    }
    if (hasPassive(killer, "ledger")) killer.gold += CONFIG.ledgerKillGold; // Landlord's Ledger
    if (hasPassive(killer, "showrunner")) addHype(state, killer, 4); // Headliner
    // REPEAT OFFENDER: the marked target died inside the window; the camera resets.
    for (const pl of state.players) {
      if (pl.cutMark && pl.cutMark.monsterId === m.id) {
        pl.cutMark = null;
        pl.cd.cutto = 0;
        pl.cutCharges = Math.max(pl.cutCharges ?? 1, 1);
      }
    }
    // EXTENSION (Bullet Time capstone): kills inside the slow stretch it out.
    if (state.bulletTimeLeft > 0 && bulletTimeParams(killer).encore) {
      state.bulletTimeLeft = Math.min(CONFIG.ultBulletTimeEncoreCap, state.bulletTimeLeft + CONFIG.ultBulletTimeEncoreExtend);
    }
    // Second Wind (bt.reel): the FIRST kill inside pauses the world a beat
    // longer. A free extension, always — the rider any Bullet Time build gets.
    if (state.bulletTimeLeft > 0 && state.btSecondWind) {
      state.btSecondWind = false;
      state.bulletTimeLeft = Math.min(
        CONFIG.ultBulletTimeEncoreCap, state.bulletTimeLeft + CONFIG.ultBulletTimeSecondWind,
      );
    }
    // CURTAIN CALL (cables capstone): a body that dies PINNED leaves the line
    // live — the field re-pins once more.
    if ((m.pinnedT ?? 0) > 0 && cablesParams(killer).curtain) {
      for (const hz of state.hazards) {
        if (hz.kind !== "cables" || hz.ownerId !== killer.id) continue;
        hz.rearms = (hz.rearms ?? 0) + 1;
      }
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
    // THE DUO (boss layer 4): a fallen unit's partner ENRAGES — permanent
    // frenzy, hotter hits, a grief-heal, and a very personal grudge.
    if (m.duoId !== undefined) {
      const partner = state.monsters.find((o) => o !== m && o.duoId === m.duoId && o.hp > 0);
      if (partner && !partner.enraged) {
        partner.enraged = true;
        partner.damage *= CONFIG.duoEnrageDamageMult;
        partner.speed *= CONFIG.duoEnrageSpeedMult;
        partner.hp = Math.min(partner.maxHp, partner.hp + Math.round(partner.maxHp * CONFIG.duoEnrageHealFraction));
        announce(state, "boss", `${partner.eliteName ?? "The survivor"} has flagged your existence as a DEFECT. It took that PERSONALLY.`, "high");
      }
    }
    // The Suit Actor UNZIPS: a terrified extra crawls out and runs for it.
    // Killing him is worth ~nothing; letting him reach the exit pays hype.
    if (m.kind === "suitactor") {
      const guy = makeMonster(state, "suitguy", { x: m.pos.x, y: m.pos.y });
      guy.noticed = true; // he starts running IMMEDIATELY
      spawned.push(guy);
      announce(state, "show", "WAIT — it unzips. IT WAS A GUY IN A SUIT. He's making a run for it. Your move, Crawler.");
    }
    // Splitter elites burst into a swarm — the fight isn't over, it multiplied.
    if (m.affix === "splitter") {
      for (let i = 0; i < CONFIG.splitterCount; i++) {
        const a = nextFloat(state.rng) * Math.PI * 2;
        const child = makeMonster(state, "swarmer", {
          x: m.pos.x + dcos(a) * 0.6, y: m.pos.y + dsin(a) * 0.6,
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
    // Named menaces shower guaranteed rewards (incl. crafting materials).
    if (m.elite) {
      state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "material", amount: 1, material: "elite_trophy" });
      dropBossBonus(state, m.pos, 1);
      // V2 §2.2: elites owe one EXTRA roll, biased component/glyph — the
      // named hunt always advances the plan.
      if (state.floor >= CONFIG.dropGlyphFromFloor && chance(state.rng, CONFIG.eliteBonusGlyphShare)) {
        dropGlyph(state, m.pos);
      } else {
        const comp = rollCatalogDrop(state.rng, state.floor, "basic", () => state.nextEntityId++);
        state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "item", amount: 0, item: comp, rarity: comp.rarity });
      }
      // TODAY'S RULE — OVERSTAFFED: named menaces carry severance — one
      // guaranteed catalog component on top of the usual roll.
      if (ruleEliteSeverance(state.dailyRule)) {
        const sev = rollCatalogDrop(state.rng, state.floor, "basic", () => state.nextEntityId++);
        state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "item", amount: 0, item: sev, rarity: sev.rarity });
      }
      addHype(state, killer, CONFIG.show.hypeBrute);
      announce(state, "boss", `${m.eliteName} is DOWN. The neighborhood breathes easier. ${killer.name} takes the credit.`);
    }
    if (m.kind === "boss") {
      // §4.4 — the profile REMEMBERS. Next time this one comes up in the draw
      // it opens at its phase-2 kit, with a shortened intro; five defeats in
      // and it brings a free mutator. Escalation in mechanics, never stats.
      if (m.bossId) {
        state.bossDefeats = { ...(state.bossDefeats ?? {}) };
        state.bossDefeats[m.bossId] = (state.bossDefeats[m.bossId] ?? 0) + 1;
      }
      bossEvent(state, {
        kind: "phase", monsterId: m.id, bossId: m.bossId, label: "DEFEATED",
        phase: m.phase ?? 0, pos: { x: m.pos.x, y: m.pos.y },
      });
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
        // V2 §3.1: band bosses guarantee a glyph — the modifier layer arrives
        // on the run's chapter beats, not the lottery's.
        dropGlyph(state, m.pos);
        // V2 §2.5: the band's drop-only unique — announced like a title belt.
        const uniqueId = BOSS_UNIQUES[state.floor];
        if (uniqueId && chance(state.rng, CONFIG.bossUniqueChance)) {
          const entry = CATALOG_BY_ID[uniqueId];
          const unique = makeQualityCatalogItem(state.rng, entry, state.floor, () => state.nextEntityId++, "common");
          state.loot.push({ id: state.nextEntityId++, pos: { x: m.pos.x, y: m.pos.y }, kind: "item", amount: 0, item: unique, rarity: unique.rarity });
          announce(state, "loot", `TITLE BELT ON THE MAT: ${entry.name.toUpperCase()} DROPS. You cannot buy this. You could only take it.`, "high");
        }
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
        // TODAY'S RULE — RUSH HOUR raises appearance fees at the source;
        // CORPORATE SELLOUT still deducts the network's cut at pickup.
        const paid = Math.round(l.amount * ruleGoldMult(state.dailyRule));
        const take = hasRevision(p, "sellout")
          ? Math.max(1, Math.round(paid * CONFIG.revisionSelloutGoldMult))
          : paid;
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
      case "cache": {
        // Roam quest prop: the recovered cache. Turn-in happens back at the
        // quartermaster; picking it up just checks the objective off.
        creditCachePickup(state, p);
        hit(state, p.pos, 0, "weapon");
        break;
      }
      case "service": {
        // A room taking customers: same non-blocking pick-1 plumbing as the
        // shrine; the contract is consumed whether you buy or walk.
        if (p.pendingRewards.length > 0) {
          remaining.push(l);
          break;
        }
        p.pendingRewards = serviceChoices(state, l.service ?? "");
        systemTip(state, p, "service");
        announce(state, "show", `OPEN FOR BUSINESS: the ${l.service ?? "room"} takes customers. The System takes a cut.`);
        hit(state, p.pos, 0, "weapon");
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
      case "glyph": {
        if (l.glyph) {
          grantGlyph(state, p, l.glyph);
          hit(state, p.pos, 0, "weapon");
          addHype(state, p, CONFIG.show.hypeRareDrop);
        }
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
        // Auto-equip if strictly better than what's in that slot, else stash in
        // the bag. School-guarded for weapons (wantsAutoEquip): a wand never
        // auto-replaces a blade — switching schools is a by-hand decision.
        // The compare is school-aware (V2 §1.2): a caster's dead attack power
        // counts half, and a build passive is worth more than a stat stick.
        const equipped = p.equipment[item.slot];
        if (wantsAutoEquip(item, equipped, dominantSchool(p))) {
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
  // INJUNCTION (V2 N3): the collapse timer FREEZES while any crawler holds a
  // stay. It is not free — the debt (5/3 of the freeze) is deducted in one
  // lump when the window closes, so the net delta is always negative.
  if (state.players.some((pl) => (pl.injunctionT ?? 0) > 0)) return;
  state.timeRemaining -= dt;
  const warnAt = state.timeBudget * CONFIG.warningFraction;

  // THE DEBUT'S RUNTIME (TUTORIAL.md — first-run mercy, the clock half).
  // Floor 1's budget is 120 seconds, and a first-timer spends most of that
  // learning which key walks. Converting killing blows and then letting the
  // FLOOR kill them anyway would be a mercy that lies, and a knockdown loop
  // inside a collapsing floor is the "reads as broken" failure this round was
  // told to avoid. So on floor 1 of a debut the clock counts down normally —
  // through the WARNING, whose System line is the collapse lesson the
  // curriculum is built on — and then HOLDS. It is announced, once, as the
  // production decision it is, and floor 2's clock is a real clock.
  if (state.firstRun && state.floor === 1 && state.timeRemaining < CONFIG.firstRunClockHoldSeconds) {
    state.timeRemaining = CONFIG.firstRunClockHoldSeconds;
    if (!state.firstRunClockHeld) {
      state.firstRunClockHeld = true;
      announce(state, "progress",
        `PRODUCTION NOTE: the debut episode runs long. The floor-one clock HOLDS at `
        + `${CONFIG.firstRunClockHoldSeconds} seconds. It will not hold on floor two — take the stairs.`, "high");
    }
  }

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
      // First-ever Safe→Warning (TUTORIAL.md B4): the collapse rule explained
      // the moment it first bites, once per crawler, in the System's voice.
      // "high" (r3 fold-in): the moment IS the lesson — queued behind a 9s
      // pacing gap the card drifted 15-25s from the first Warning tick and
      // once landed inside the safe room. It jumps the gap, never a card.
      for (const p of state.players) systemTip(state, p, "collapse", "high");
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
  // Roam has no finish line — it regenerates open-endedly past floor 18.
  if (state.runKind !== "roam" && state.floor >= CONFIG.finalFloor) {
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
    // Drop-only boss uniques (V2 §2.5) never reach a shelf — they cannot be
    // bought, only taken. The Glyph Cache row waits for shop 2 (§4 cadence:
    // socket 1 opens at level ~4, and shop 1 is the school-pick shop).
    const pool = CATALOG.filter((e) =>
      e.tier === tier && !e.dropOnly && (e.id !== "glyph_cache" || shopIndex >= CONFIG.glyphCacheFromShop));
    const n = tierStockCount(tier, shopIndex);
    if (n <= 0) continue;
    const picks = n >= pool.length ? pool : shuffle(rng, pool).slice(0, n);
    // Catalog order keeps the shelf layout stable shop to shop.
    available.push(...CATALOG.filter((e) => picks.includes(e)).map((e) => e.id));
  }
  // Today's tome teaches ONE seeded ability someone still lacks; no tome once
  // the party knows everything.
  // The NEXT floor's shop: gate ultimate tomes by the floor being entered.
  const undiscovered = [...new Set(state.players.flatMap((p) => unknownAbilities(p, nextFloor, state.seed)))];
  let tomeAbility: SafeRoom["tomeAbility"];
  if (undiscovered.length > 0) {
    tomeAbility = undiscovered[nextInt(rng, 0, undiscovered.length - 1)];
  } else {
    const t = available.indexOf("tome");
    if (t >= 0) available.splice(t, 1);
  }
  const room: SafeRoom = {
    nextFloor, available, tomeAbility, tip: safeRoomTip(rng, nextFloor),
    ready: [], purchased: {}, boughtThisShop: [],
  };
  // THE DEBUT'S SHELF IS NOT A WINDOW (TUTORIAL.md — the affordable first
  // shop). The production float at createGame already covers the cheapest
  // entry, but the guarantee is stated HERE, against the shelf that actually
  // generated, so it survives a price change, a shuffled shelf, or a crawler
  // who spent the float on the way down: a debut crawler standing at their
  // FIRST shop can always afford at least one useful thing. The difference is
  // advanced, not gifted — it is the same float, topped up, and it happens
  // exactly once because shop 1 happens exactly once.
  if (state.firstRun && shopIndex === 1) {
    for (const p of state.players) {
      const need = cheapestUsefulShelfPrice(p, room);
      if (need <= 0 || p.gold >= need) continue;
      p.gold = need;
      announce(state, "show",
        `THE FLOAT IS TOPPED UP to ${need} gold. The System does not run a shop a debut crawler cannot shop in. `
        + "It runs one they cannot afford to leave.");
    }
  }
  return room;
}

/**
 * The cheapest thing on a shelf that a crawler could buy TODAY and be glad of:
 * gear (a stat stick is always a stat stick) and the plain consumables. The
 * gated curiosities are excluded on purpose — a tome needs an ability nobody
 * in the party lacks, a Favor buys a draft, a legendary wants sponsors and
 * trophies — because "affordable" has to mean "buyable by this crawler, now".
 * Returns 0 when the shelf holds nothing of the kind (never true at shop 1).
 * Exported: the first-shelf guarantee above and its test read the same number.
 */
export function cheapestUsefulShelfPrice(p: Player, room: SafeRoom): number {
  let best = 0;
  for (const id of room.available) {
    const e = CATALOG_BY_ID[id];
    if (!e || e.tier === "legendary") continue;
    const useful = e.slot !== undefined
      || e.effect === "heal" || e.effect === "time" || e.effect === "maxHp";
    if (!useful) continue;
    if (missingComponents(p, id).length > 0) continue; // a build you cannot buy yet
    const price = effectivePrice(p, id, room.nextFloor);
    if (best === 0 || price < best) best = price;
  }
  return best;
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
      case "tome":
        learnAbility(state, p, room.tomeAbility);
        break;
      case "favor":
        p.upgradeDraftsOwed++;
        announce(state, "show", `${p.name} calls in a SYSTEM FAVOR. An upgrade draft is owed.`);
        break;
      case "glyph": {
        // Glyph Cache (V2 §3.1): the roll inside is seeded — certified random.
        const glyph = GLYPH_IDS[nextInt(state.rng, 0, GLYPH_IDS.length - 1)];
        announce(state, "loot", `${p.name} cracks a GLYPH CACHE: ${GLYPH_INFO[glyph].name}.`);
        grantGlyph(state, p, glyph);
        break;
      }
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
  // Consume claimed components wherever they live. A consumed component
  // leaves the same-shop refund list (V2 §4 eviction: combining IS modifying).
  for (const it of claimed) evictBought(room, it.id);
  p.inventory = p.inventory.filter((it) => !claimed.has(it));
  for (const slot of EQUIP_SLOTS) {
    if (p.equipment[slot] && claimed.has(p.equipment[slot]!)) p.equipment[slot] = null;
  }
  const item = makeCatalogItem(state, entry, room.nextFloor);
  // Same-shop full refund (V2 §4): the fresh purchase is undo-able until
  // it's modified, consumed, or the shop closes.
  (room.boughtThisShop ??= []).push(item.id);
  const cur = p.equipment[item.slot];
  if (!cur || itemScore(item, dominantSchool(p)) > itemScore(cur, dominantSchool(p))) equipItem(p, item);
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

/** Same-shop full refund (V2 §4): an UNMODIFIED purchase from THIS safe room
 * sells back at 100% of its sticker price — the LoL undo. Modified/consumed
 * items were evicted from boughtThisShop, so they fall back to 60%. */
function refundValue(room: SafeRoom | null, item: Item): number {
  if (room?.boughtThisShop?.includes(item.id) && item.catalogId) return totalCost(item.catalogId);
  return sellValue(item);
}

/** Drop an item id from the same-shop refund list (modified/consumed/sold). */
function evictBought(room: SafeRoom | null, itemId: number): void {
  if (!room?.boughtThisShop) return;
  const i = room.boughtThisShop.indexOf(itemId);
  if (i >= 0) room.boughtThisShop.splice(i, 1);
}

/** Sell a BAG item back to the System Shop. Equipped gear is safe. */
export function sellItem(state: GameState, playerId: number, bagIdx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  const room = p ? shopRoomFor(state, p) : null;
  if (!p || !room) return;
  if (bagIdx < 0 || bagIdx >= p.inventory.length) return;
  const item = p.inventory.splice(bagIdx, 1)[0];
  const value = refundValue(room, item);
  evictBought(room, item.id);
  p.gold += value;
  state.events.push(`${p.name} sold ${item.name} (+${value} gold).`);
}

/** Sell the WHOLE bag back to the System Shop (equipped gear is safe). */
export function sellAllItems(state: GameState, playerId: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  const room = p ? shopRoomFor(state, p) : null;
  if (!p || !room || p.inventory.length === 0) return;
  const n = p.inventory.length;
  let total = 0;
  for (const item of p.inventory) {
    total += refundValue(room, item);
    evictBought(room, item.id);
  }
  p.inventory = [];
  p.gold += total;
  state.events.push(`${p.name} liquidated the bag: ${n} item${n === 1 ? "" : "s"}, +${total} gold.`);
}

// ---- The SAFE-ROOM BENCH (ITEMIZATION-V2 §2.4): dismantle + refit ----

/** Shards a dismantled item yields (preview + the verb share this). */
export function dismantleYield(item: Item): number {
  return CONFIG.dismantleShards[item.rarity];
}

/**
 * DISMANTLE a bag item into refit shards (safe-room bench). The gold-vs-
 * shards call is the real decision: catalog items can still be SOLD for the
 * 60% gold path; junk commodity drops feed the refit economy instead.
 * Dismantling a same-shop purchase forfeits its 100% refund (eviction rule).
 */
export function dismantleItem(state: GameState, playerId: number, bagIdx: number): void {
  const p = state.players.find((pl) => pl.id === playerId);
  const room = p ? shopRoomFor(state, p) : null;
  if (!p || !room) return;
  if (bagIdx < 0 || bagIdx >= p.inventory.length) return;
  const item = p.inventory.splice(bagIdx, 1)[0];
  const shards = dismantleYield(item);
  evictBought(room, item.id);
  p.materials.refit_shard = (p.materials.refit_shard ?? 0) + shards;
  state.events.push(`${p.name} dismantles ${item.name}: +${shards} refit shard${shards === 1 ? "" : "s"}. Scrap, certified.`);
}

/** The next quality step up, or null at the cap. */
function nextQuality(r: Rarity): Exclude<Rarity, "common"> | null {
  return r === "common" ? "magic" : r === "magic" ? "rare" : r === "rare" ? "epic" : null;
}

/** Refit costs for an item (UI preview + the verb share this). Null when the
 * item cannot be refitted (not a catalog identity, or already epic). */
export function refitCost(item: Item): { shards: number; gold: number; sigils: number; to: Rarity } | null {
  if (!item.catalogId) return null;
  const to = nextQuality(item.rarity);
  if (!to) return null;
  const entry = CATALOG_BY_ID[item.catalogId];
  if (!entry) return null;
  return {
    shards: CONFIG.refitShardCost[to],
    gold: Math.round(totalCost(item.catalogId) * CONFIG.refitGoldFraction),
    sigils: entry.dropOnly ? 1 : 0, // boss uniques refit with a sigil on top
    to,
  };
}

/**
 * REFIT (safe-room bench): upgrade an OWNED catalog item's quality one step —
 * shards + gold (+ a boss sigil for boss uniques). Re-rolls its bonus-affix
 * additions at the new tier and FLOOR-RESCALES the base line to the floor
 * ahead: the "my floor-4 item stays alive" verb, strictly better than
 * re-buying. `ref` is a bag index (number) or an equipped slot name.
 */
export function refitItem(state: GameState, playerId: number, ref: number | ItemSlot): void {
  const p = state.players.find((pl) => pl.id === playerId);
  const room = p ? shopRoomFor(state, p) : null;
  if (!p || !room) return;
  const item = typeof ref === "number"
    ? (ref >= 0 && ref < p.inventory.length ? p.inventory[ref] : null)
    : p.equipment[ref];
  if (!item) return;
  const cost = refitCost(item);
  if (!cost) return;
  if ((p.materials.refit_shard ?? 0) < cost.shards) return;
  if (p.gold < cost.gold) return;
  if (cost.sigils > 0 && (p.materials.boss_sigil ?? 0) < cost.sigils) return;
  const entry = CATALOG_BY_ID[item.catalogId!];
  p.materials.refit_shard = (p.materials.refit_shard ?? 0) - cost.shards;
  if (cost.sigils > 0) p.materials.boss_sigil -= cost.sigils;
  p.gold -= cost.gold;
  p.goldSpent += cost.gold;
  item.rarity = cost.to;
  item.affixes = catalogQualityAffixes(state.rng, entry, room.nextFloor, cost.to);
  evictBought(room, item.id); // a refit purchase leaves the 100% refund path
  recomputeStats(p);
  announce(state, "loot", `REFIT: ${p.name}'s ${item.name} is certified ${cost.to.toUpperCase()}. The System stamps the paperwork.`);
  checkAchievements(state);
}

/** Mark a player ready to descend; the party leaves when everyone is ready. */
/** The shop this player is currently standing in: personal in rivals, shared
 * in co-op — and, on Roam floors, the settlement vendor's shelf when the
 * crawler is inside a settlement (buy/sell work unchanged through it). */
export function shopRoomFor(state: GameState, p: Player): SafeRoom | null {
  if (state.mode === "rivals") return p.safeRoom ?? null;
  return state.safeRoom ?? settlementShopFor(state, p);
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
type SponsorRewardKind = Exclude<
  Reward["kind"],
  | "shrineBlood" | "shrineGreed" | "shrineDecline"
  | "shrineDraft" | "shrineLoan" | "shrineLiquidate" | "shrinePremium"
  | "svcTemper" | "svcDraught" | "svcWager" | "svcMap" | "svcPlans"
  | "revision" | "revisionDecline"
>;

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
    case "glyph": {
      // A sponsored firmware patch (V2 §3.1): the Show may GIFT a glyph —
      // glyphs stay loot, the crowd just occasionally pays for one.
      const glyph = GLYPH_IDS[nextInt(rng, 0, GLYPH_IDS.length - 1)];
      const info = GLYPH_INFO[glyph];
      return { id, kind, title: `Glyph: ${info.name}`, desc: info.blurb, amount: 0, glyph };
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
    case "glyph":
      return 65; // a new behavior beats a stat bump, most floors
    case "favor":
      return 70; // a constellation rank is strong, but not always the pick
    case "retrain":
      return 60; // a build pivot: worth a slot, never the auto-pick
    case "shrineBlood":
    case "shrineGreed":
    case "shrineDecline":
    case "shrineDraft":
    case "shrineLoan":
    case "shrineLiquidate":
    case "shrinePremium":
    case "svcTemper":
    case "svcDraught":
    case "svcWager":
    case "svcMap":
    case "svcPlans":
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
  // Glyphs join the pool once sockets exist to care (V2 §3.1 acquisition).
  if (state.floor >= CONFIG.dropGlyphFromFloor) pool.push("glyph");
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
    case "glyph":
      if (r.glyph) grantGlyph(state, p, r.glyph);
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
        if (wantsAutoEquip(r.item, cur)) equipItem(p, r.item);
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
    case "shrineDraft":
      state.timeRemaining = Math.max(5, state.timeRemaining - CONFIG.shrineDraftTimeCost);
      p.upgradeDraftsOwed += 1;
      announce(state, "show", `${p.name} signs the OVERTIME DRAFT: the floor loses ${CONFIG.shrineDraftTimeCost}s and the System owes an evolution.`);
      break;
    case "shrineLoan":
      state.timeBudget += CONFIG.shrineLoanGain;
      state.timeRemaining += CONFIG.shrineLoanGain;
      state.pendingTimeDebt = (state.pendingTimeDebt ?? 0) + CONFIG.shrineLoanDebt;
      announce(state, "show", `TIME LOAN approved: +${CONFIG.shrineLoanGain}s now. The next floor repays it. The System always collects.`);
      break;
    case "shrineLiquidate": {
      const n = p.inventory.length;
      let total = 0;
      for (const it of p.inventory) total += sellValue(it);
      total = Math.round(total * CONFIG.shrineLiquidateBonus);
      p.inventory = [];
      p.gold += total;
      announce(state, "show", `LIQUIDATION EVENT: the shrine buys ${p.name}'s bag — ${n} item${n === 1 ? "" : "s"}, +${total} gold. All sales final.`);
      break;
    }
    case "shrinePremium": {
      const cost = Math.max(1, Math.round(p.gold * CONFIG.shrinePremiumCostFraction));
      p.gold -= cost;
      p.hp = p.maxHp;
      p.statuses = [];
      hit(state, p.pos, p.maxHp, "heal");
      announce(state, "show", `${p.name} pays the INSURANCE PREMIUM (${cost} gold): fully restored, statuses cleansed. The claims department is now closed.`);
      break;
    }
    // SERVICE ROOMS (roomPurposes phase 4 — every verb costs):
    case "svcTemper": {
      const cost = CONFIG.svcTemperCost + Math.round(state.floor * CONFIG.svcTemperCostPerFloor);
      if (p.gold < cost) {
        announce(state, "show", `${p.name} cannot afford the tempering. The System does not extend credit.`);
        break;
      }
      p.gold -= cost;
      const amt = CONFIG.svcTemperDamage + Math.round(state.floor * CONFIG.svcTemperDamagePerFloor);
      p.bonusDamage += amt;
      p.bonusSpell += amt;
      recomputeStats(p);
      announce(state, "show", `${p.name}'s arms are TEMPERED at the forge: +${amt} damage, both schools, permanent. The receipt is nailed to the anvil.`);
      break;
    }
    case "svcDraught": {
      const cost = CONFIG.svcDraughtCost + Math.round(state.floor * CONFIG.svcDraughtCostPerFloor);
      if (p.gold < cost) {
        announce(state, "show", `${p.name} cannot afford the draught. The apothecary suggests dying cheaper.`);
        break;
      }
      p.gold -= cost;
      p.hp = p.maxHp;
      p.statuses = [];
      hit(state, p.pos, p.maxHp, "heal");
      announce(state, "show", `${p.name} downs the HOUSE DRAUGHT (${cost} gold): fully restored, chemically forgiven.`);
      break;
    }
    case "svcWager": {
      const stake = CONFIG.svcWagerStake + state.floor * CONFIG.svcWagerStakePerFloor;
      if (p.gold < stake) {
        announce(state, "show", `${p.name} cannot cover the stake. The table has standards.`);
        break;
      }
      p.gold -= stake;
      if (chance(state.rng, CONFIG.svcWagerWinChance)) {
        p.gold += stake * 2;
        addHype(state, p, 15);
        announce(state, "show", `${p.name} WINS the hand: +${stake} gold. The dealer files a complaint.`);
      } else {
        addHype(state, p, 5);
        announce(state, "show", `${p.name} loses the hand (${stake} gold). The house always wins. The crowd loves it.`);
      }
      break;
    }
    case "svcMap":
      state.explored.fill(1);
      state.exploredVersion++;
      addHype(state, p, 8);
      announce(state, "show", `${p.name} reads the LEDGER: the floor's layout, filed and cross-referenced. The System admires thorough paperwork.`);
      break;
    case "svcPlans":
      state.timeBudget += CONFIG.svcPlansTime;
      state.timeRemaining += CONFIG.svcPlansTime;
      announce(state, "show", `${p.name} studies the PLANS: the shortcuts are marked. +${CONFIG.svcPlansTime}s on the clock.`);
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

/** A service room's menu (roomPurposes phase 4): ONE verb + Walk Away.
 * Rare by design and priced by contract — see CONFIG service knobs. */
function serviceChoices(state: GameState, purposeId: string): Reward[] {
  const floor = state.floor;
  const card = (kind: Reward["kind"], title: string, desc: string): Reward =>
    ({ id: state.nextEntityId++, kind, title, desc, amount: 0 });
  const verb =
    purposeId === "forge"
      ? card("svcTemper", "Temper Your Arms", `Pay ${CONFIG.svcTemperCost + Math.round(floor * CONFIG.svcTemperCostPerFloor)} gold: +${CONFIG.svcTemperDamage + Math.round(floor * CONFIG.svcTemperDamagePerFloor)} damage, both schools, permanent`)
      : purposeId === "apothecary"
        ? card("svcDraught", "Buy the House Draught", `Pay ${CONFIG.svcDraughtCost + Math.round(floor * CONFIG.svcDraughtCostPerFloor)} gold: full heal, every status cleansed`)
        : purposeId === "den"
          ? card("svcWager", "Play a Hand", `Stake ${CONFIG.svcWagerStake + floor * CONFIG.svcWagerStakePerFloor} gold: win double or lose it. The house deals`)
          : purposeId === "warroom"
            ? card("svcPlans", "Study the Plans", `Free. The shortcuts are marked: +${CONFIG.svcPlansTime}s on the collapse clock`)
            : card("svcMap", "Read the Ledger", "Free. The floor's layout, filed and cross-referenced");
  return [
    verb,
    { id: state.nextEntityId++, kind: "shrineDecline", title: "Walk Away", desc: "No sale. The proprietor is dead anyway", amount: 0 },
  ];
}

/** The System Shrine's pick-1 bargain (floor event). Rides pendingRewards —
 * the same non-blocking personal-draft plumbing sponsor gifts use, so hosts
 * need no new UI. Costs are spelled out in the desc; applyReward collects. */
export function shrineChoices(state: GameState, p: Player): Reward[] {
  const bloodCost = Math.max(1, Math.round(p.maxHp * CONFIG.shrineBloodCostFraction));
  // The full menu. Each shrine deals a seeded TWO of these (+ Walk Away), so
  // repeat visits differ; gates keep dead deals off the table.
  const pool: Reward[] = [
    {
      id: state.nextEntityId++, kind: "shrineBlood", title: "Blood Price",
      desc: `Offer ${bloodCost} HP on the spot for +${Math.round(CONFIG.shrineBloodCrit * 100)}% crit, permanently`,
      amount: CONFIG.shrineBloodCrit,
    },
    {
      id: state.nextEntityId++, kind: "shrineGreed", title: "Greed Clause",
      desc: `This floor's monsters gain +${Math.round((CONFIG.shrineGreedSpeedMult - 1) * 100)}% speed; its gold drops pay DOUBLE`,
      amount: 0,
    },
    {
      id: state.nextEntityId++, kind: "shrineDraft", title: "Overtime Draft",
      desc: `The collapse clock loses ${CONFIG.shrineDraftTimeCost}s; the System owes you an ability draft`,
      amount: 0,
    },
    {
      id: state.nextEntityId++, kind: "shrineLoan", title: "Time Loan",
      desc: `+${CONFIG.shrineLoanGain}s on THIS floor's clock; the next floor starts ${CONFIG.shrineLoanDebt}s shorter`,
      amount: 0,
    },
  ];
  if (p.inventory.length >= 2) {
    pool.push({
      id: state.nextEntityId++, kind: "shrineLiquidate", title: "Liquidation Event",
      desc: `The shrine buys your ENTIRE bag (${p.inventory.length} items) at a premium. Non-negotiable`,
      amount: 0,
    });
  }
  if (p.gold >= 30 && p.hp < p.maxHp) {
    pool.push({
      id: state.nextEntityId++, kind: "shrinePremium", title: "Insurance Premium",
      desc: `Pay ${Math.round(CONFIG.shrinePremiumCostFraction * 100)}% of your gold: full heal, every status cleansed`,
      amount: 0,
    });
  }
  const dealt = shuffle(state.rng, pool).slice(0, 2);
  dealt.push({
    id: state.nextEntityId++, kind: "shrineDecline", title: "Walk Away",
    desc: "No deal. The System respects cowardice; it just doesn't pay for it",
    amount: 0,
  });
  return dealt;
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
  // DASH VAULT (furniture-feel): knee-high furniture is mobility TEXTURE,
  // not masonry. If the slide stopped short and what stopped it is BLOCKED
  // FURNITURE, scan the remaining reach for open floor with nothing but
  // furniture in between and go OVER the table. Walls and locked doors
  // still eat the dash — crossing masonry is Backstage Pass's job below.
  {
    const slid = dist(start, p.pos);
    const bx = p.pos.x + dir.x * 0.45, by = p.pos.y + dir.y * 0.45;
    const bi = Math.floor(by) * state.map.w + Math.floor(bx);
    if (slid < dp.distance - 0.4 && state.map.blocked?.[bi]) {
      for (let dd = dp.distance; dd > slid + 0.5; dd -= 0.25) {
        const landing = { x: start.x + dir.x * dd, y: start.y + dir.y * dd };
        if (!isWalkable(state.map, landing.x, landing.y)) continue;
        let crossesWall = false;
        for (let s = 0.25; s < dd; s += 0.25) {
          const t = tileAt(state.map, start.x + dir.x * s, start.y + dir.y * s);
          if (t === Tile.Wall || t === Tile.DoorLocked) { crossesWall = true; break; }
        }
        if (crossesWall) continue; // a shorter hop may still clear the table
        p.pos.x = landing.x;
        p.pos.y = landing.y;
        break;
      }
    }
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
  // V2 R2: the school is HYBRID now (SCALING dash = ap .5 / sp .5), so a
  // physical crawler's detonation stops being a rounding error.
  if (dp.shockMult > 0) {
    segmentDamage(state, p, start, p.pos, CONFIG.shockstepPathRadius,
      power(p, "dash") * dp.shockMult, CONFIG.shockstepKnockback, castSchool(p, "dash"), "dash");
  }
  // Long Blink: the long dash is a PLAY, not a retreat — bodies you cross eat
  // a share of Shockstep even without the node's own damage rank.
  if (dp.passFrac > 0) {
    segmentDamage(state, p, start, p.pos, CONFIG.shockstepPathRadius,
      power(p, "dash") * dp.passFrac, 0, castSchool(p, "dash"), "dash");
  }
  // PHASE ETCH (Phase C): more i-frames, and passed-through enemies take a
  // slice of ability power as steel.
  if (hasGlyph(p, "dash", "phase_etch")) {
    p.dashTime = Math.max(p.dashTime, CONFIG.dashDuration + CONFIG.glyphPhaseEtchIframes);
    segmentDamage(state, p, start, p.pos, CONFIG.shockstepPathRadius,
      power(p, "dash") * CONFIG.glyphPhaseEtchFrac, 0, "physical", "dash");
  }
  // Smoke Break (rider): the launch point blooms into a blind puff. Monsters
  // inside DROP their current target — the decoy taunt seam, inverted.
  if (dp.veil) {
    for (const m of state.monsters) {
      if (m.hp <= 0 || dist(start, m.pos) > CONFIG.dashVeilRadius) continue;
      m.blindT = CONFIG.dashVeilSeconds;
      m.alertT = 0;
    }
  }
  // AFTERSHOCK capstone: the arrival point additionally detonates outright.
  if (rank(p, "dash.after") > 0) {
    radialDamage(state, p, p.pos, 1.8, power(p, "dash"), 0, "magic", 1, "dash");
    p.novaFlash = Math.max(p.novaFlash, 0.18);
  }
  // SLIPSTREAM glyph: the movement resolved — the surge window opens.
  if (hasGlyph(p, "dash", "slipstream")) p.slipstreamT = CONFIG.glyphSlipstreamDur;
}

/**
 * Battle Stance: toggle which attack type the crawler favors (see stanceMult).
 * The swap itself is the cast — Flow builds ride the post-swap surge window,
 * Discipline builds plant their feet and let the stance settle instead.
 */
function doStance(state: GameState, p: Player, aim: Vec2, move: Vec2): void {
  const sp = stanceParams(p);
  // R4: the swap IS an attack — but ONLY if you were SETTLED. Without the
  // gate, swapping every 3s becomes the optimal line and Discipline (which
  // only pays while settled) and PERFECT FORM become strictly worse to play:
  // the base rework would be attacking one side of the roster's best fork,
  // which is the exact defect this document indicts elsewhere. Flow UNGATES
  // it at 60% power — Discipline uses the strike, Flow spams it.
  const strike = stanceStrikePower(p);
  p.stance = p.stance === "melee" ? "ranged" : "melee";
  p.cd.stance = sp.cooldown * cdMult(p); // rule-7 clamped (glyph CDR folds in)
  p.stanceTime = 0;
  p.stanceSwapWindow = CONFIG.stanceSurgeSeconds;
  if (rank(p, "stance.moment") > 0) p.stanceCritReady = true;
  if (strike > 0) {
    const kind: AbilityId = p.stance === "melee" ? "melee" : "bolt";
    const cd0 = p.cd[kind] ?? 0; // the strike is FREE: no cooldown cost
    p.stanceStrikeMult = strike;
    if (kind === "melee") doPlayerAttack(state, p, aim, move, CONFIG.stanceStrikeArcMult);
    else doBolt(state, p, aim, CONFIG.stanceStrikeBoltMult);
    p.stanceStrikeMult = undefined;
    p.cd[kind] = cd0;
    // Footwork (rider): the strike REFUNDS a slice of the swapped-to attack's
    // cooldown. It is the first RANK that grants a refund, so it routes
    // through rule 8's per-cast refund budget rather than around it (§5.4 #4).
    if (sp.footworkRefund > 0 && cd0 > 0) {
      p.cd[kind] = Math.max(0, cd0 - refundAllowance(p, kind, sp.footworkRefund));
    }
  }
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
  p.cd.overcharge = overchargeParams(p).cooldown * cdMult(p); // rule-7 clamped
  bloodPrice(state, p, "overcharge");
  hit(state, p.pos, 0, "weapon"); // a crackle poof for the juice layer
}

/**
 * RULE 8's budget, shared by every refund source. Executioner's Rebate armed
 * it per cast; Footwork is the first RANK to spend from it, and it goes
 * through the same accumulator rather than around it (§5.4 flag 4). Returns
 * how many seconds may actually be refunded right now.
 */
function refundAllowance(p: Player, ability: AbilityId, want: number): number {
  if (p.rebateAbility !== ability || (p.rebateT ?? 0) <= 0) {
    // No armed window: the budget is this cooldown's own cap, computed fresh.
    const cd0 = p.cd[ability] ?? 0;
    return Math.min(want, cd0 * CONFIG.refundCapFraction);
  }
  const left = Math.max(0, p.rebateBudget ?? 0);
  const give = Math.min(want, left);
  p.rebateBudget = left - give;
  return give;
}

/** Ranged bolt skill: fire player projectile(s) along facing/aim (Split Shot fans). */
function doBolt(state: GameState, p: Player, aim: Vec2, dmgMult = 1): void {
  const bp = boltParams(p);
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  p.cd.bolt = bp.cooldown * cdMult(p);
  bloodPrice(state, p, "bolt");
  const empowered = staticCharged(p, "bolt");
  // R4: a stance swap fires a free bolt at 1.3x (Deadeye's shape).
  const swap = p.stanceStrikeMult ?? 0;
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
  const damage = Math.max(1, Math.round(
    bp.dmg * stanceMult(p, "ranged") * (oc?.mult ?? 1) * dmgMult * (swap > 0 ? swap : 1)
      * (empowered ? CONFIG.glyphStaticDmgMult : 1),
  ));
  const speed = CONFIG.boltSpeed * bp.speedMult;
  const count = bp.count + (oc?.extraBolts ?? 0); // Overcharged Volley widens the fan
  const base = datan2(dir.y, dir.x);
  const spread = 0.22; // radians between fan bolts
  for (let i = 0; i < count; i++) {
    const a = base + (i - (count - 1) / 2) * spread;
    const d = { x: dcos(a), y: dsin(a) };
    state.projectiles.push({
      id: state.nextEntityId++,
      pos: { x: p.pos.x + d.x * 0.6, y: p.pos.y + d.y * 0.6 },
      vel: { x: d.x * speed, y: d.y * speed },
      damage,
      ttl: CONFIG.boltTtl,
      from: "player",
      ownerId: p.id,
      // Surge (Breaker entry): a banked bolt PIERCES further — the entry
      // changes what the hit touches instead of what it prints.
      pierce: bp.pierce + (oc?.extraTargets ?? 0),
      crit: momentum || undefined,
      shatter: oc?.shatter || undefined,
      breaker: oc ? true : undefined,
      school: bp.school,
      chill: bp.chill > 0 ? bp.chill : undefined,
      ability: "bolt", // glyph hooks (brand/accelerant/splitfang/arc-splice)
    });
  }
}

/** Damage every monster within `radius` of `center` (crit-able); used by nova/aftershock.
 * Blasts shove outward from the center when `knockback` > 0. Returns the
 * monsters this blast KILLED (Extinction chains / Sponsor Loyalty refunds). */
function radialDamage(
  state: GameState, p: Player, center: Vec2, radius: number, damage: number,
  knockback = 0, school: School = "physical", poiseMult = 1, ability?: AbilityId,
): Monster[] {
  const killed: Monster[] = [];
  for (const m of state.monsters) {
    if (m.hp <= 0) continue; // already dead this step — not this blast's kill
    const d = dist(center, m.pos);
    if (d - bodyRadius(m) > radius) continue; // blasts catch the body, not the center
    const dir = d > 1e-4 ? { x: (m.pos.x - center.x) / d, y: (m.pos.y - center.y) / d } : undefined;
    damageMonster(state, p, m, damage, { dir, knockback, school, poiseMult, ability });
    if (m.hp <= 0) killed.push(m);
  }
  // Blasts pop the smashable dressing too — nova through the storeroom.
  smashBreakables(state, ({ pos }) => dist(center, pos) <= radius);
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
  knockback = 0, school: School = "physical", ability?: AbilityId,
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
    damageMonster(state, p, m, damage, { dir, knockback, school, ability });
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

// ---- PHASE-C GLYPH MACHINERY (ABILITIES-V2 §5) ----
// Each of these is the ONE place its glyph resolves, so every ability that
// exposes the matching channel gets the behavior for free — the rule-6
// contract in glyphs.ts stays true by construction rather than by discipline.

/** STATIC CHARGE: count this cast and report whether it is the empowered one.
 * Reads the `cast` channel — which is exactly why Orbit's AURA does not get
 * it and Orbit's HURL does. */
function staticCharged(p: Player, ability: AbilityId): boolean {
  if (!hasGlyph(p, ability, "static_charge")) return false;
  const counts = (p.glyphCastCount ??= {});
  const n = ((counts[ability] ?? 0) + 1) % CONFIG.glyphStaticEvery;
  counts[ability] = n;
  return n === 0;
}

/** GRAVE DIVIDEND: consume up to N corpses under the cast for +15% each. */
function graveDividend(state: GameState, p: Player, at: Vec2, ability: AbilityId): number {
  if (!hasGlyph(p, ability, "grave_dividend")) return 1;
  let eaten = 0;
  state.corpses = state.corpses.filter((c) => {
    if (eaten >= CONFIG.glyphGraveCorpses || dist(at, c.pos) > CONFIG.glyphGraveRadius) return true;
    eaten++;
    return false;
  });
  return 1 + eaten * CONFIG.glyphGraveBonus;
}

/**
 * DEMOLITION RIDER: the blast consumes burn/poison on what it hit and deals
 * the remaining DoT at once. Capped at glyphDemolitionTargets bodies (§5.4
 * flag 6) — with Collapse's gather landing 3+ every cast, an uncapped version
 * was the set's strongest glyph by a distance.
 */
function demolitionRider(state: GameState, p: Player, at: Vec2, radius: number, ability: AbilityId): void {
  if (!hasGlyph(p, ability, "demolition_rider")) return;
  let done = 0;
  for (const m of state.monsters) {
    if (done >= CONFIG.glyphDemolitionTargets) break;
    if (m.hp <= 0 || !m.statuses?.length) continue;
    if (dist(at, m.pos) - bodyRadius(m) > radius) continue;
    let owed = 0;
    for (const s of m.statuses) {
      if (s.kind !== "burn" && s.kind !== "poison") continue;
      owed += s.magnitude * s.stacks * Math.max(0, Math.floor(s.remaining / CONFIG.burnTickSeconds));
    }
    if (owed < 1) continue;
    m.statuses = m.statuses.filter((s) => s.kind !== "burn" && s.kind !== "poison");
    done++;
    damageMonster(state, p, m, owed * CONFIG.glyphDemolitionFrac, {
      allowCrit: false, poiseMult: 0, school: "magic", effect: "burn",
    });
  }
}

/** COLD OPEN: the ultimate's cast chills the room it opens on. */
function coldOpen(state: GameState, p: Player, ability: AbilityId): void {
  if (!hasGlyph(p, ability, "cold_open")) return;
  for (const m of state.monsters) {
    if (m.hp <= 0 || dist(p.pos, m.pos) > CONFIG.glyphColdOpenRadius) continue;
    applyStatus(m, {
      kind: "chill", duration: CONFIG.glyphColdOpenDuration, school: "magic",
      magnitude: m.kind === "boss" ? CONFIG.glyphColdOpenChill * CONFIG.chillBossMult : CONFIG.glyphColdOpenChill,
    });
  }
}

/** BLOOD PRICE: casts cost 3% max HP for +30% damage. Never lethal — a glyph
 * that can kill you by pressing a button is a bug, not a drawback. */
function bloodPrice(state: GameState, p: Player, ability: AbilityId): void {
  if (!hasGlyph(p, ability, "blood_price")) return;
  const cost = Math.max(1, Math.round(p.maxHp * CONFIG.glyphBloodPriceHpFrac));
  p.hp = Math.max(1, p.hp - cost);
  hit(state, p.pos, cost, "player");
}

/**
 * BREAKER's stagger riders (V2 R5 + §4.3). Open Season opens a vulnerability
 * window on the MONSTER (so the whole party cashes it in) and CHAIN REACTION
 * propagates the stagger — party-scale control, once per phrase.
 */
function breakerStaggerRiders(state: GameState, p: Player, m: Monster, breaker?: boolean): void {
  if (!breaker) return;
  const op = overchargeParams(p);
  if (op.window > 0) {
    m.vulnT = CONFIG.overchargeWindowSeconds;
    m.vulnBonus = op.window;
  }
  if (op.chain) {
    for (const o of state.monsters) {
      if (o === m || o.hp <= 0 || o.kind === "boss") continue;
      if (dist(m.pos, o.pos) > CONFIG.overchargeChainRadius) continue;
      if ((o.staggerGraceT ?? 0) > 0 || o.affix === "juggernaut") continue;
      o.stagger = Math.max(o.stagger, CONFIG.staggerDuration);
      o.poiseDmg = 0;
      o.windup = 0;
      o.windupKind = undefined;
    }
  }
}

/**
 * COLLAPSE (ABILITIES-V2 R1). The measured trap fixed with the game's own
 * idea: IMPLOSION stops being a capstone and becomes the BASE. The cast drags
 * every non-boss body inside `gatherRadius` onto a ring at your feet, THEN
 * detonates at the (smaller) blast radius. Per-target damage is unchanged —
 * the entire buff is in N, because N's measured median was zero and the
 * dungeon's spacing contract deliberately keeps it there.
 */
function doNova(state: GameState, p: Player): void {
  const np = novaParams(p);
  p.cd.nova = np.cooldown * cdMult(p);
  bloodPrice(state, p, "nova");
  // THE GATHER. Elites and bosses RESIST (40% of the distance) rather than
  // ignore — a gather that cannot touch the thing you want gathered is the
  // same trap in a different costume.
  const dragged = new Set<number>();
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const d = dist(p.pos, m.pos);
    if (d > np.gatherRadius || d < CONFIG.novaGatherRing) continue;
    const heavy = m.kind === "boss" || m.elite;
    const want = Math.min(d - CONFIG.novaGatherRing, CONFIG.novaGatherStep);
    const pull = want * (heavy ? CONFIG.novaHeavyDragFrac : 1);
    if (pull <= 0.01) continue;
    const dir = { x: (p.pos.x - m.pos.x) / d, y: (p.pos.y - m.pos.y) / d };
    const before = { x: m.pos.x, y: m.pos.y };
    moveWithCollision(state.map, m.pos, dir, pull, isWalkable);
    if (dist(before, m.pos) > 0.05) {
      dragged.add(m.id);
      // CRUSH: they land staggered. The fork rewards the SETUP, not the number.
      if (np.crush > 0 && m.kind !== "boss") {
        m.stagger = Math.max(m.stagger, CONFIG.novaCrushStagger);
        m.windup = 0;
        m.windupKind = undefined;
      }
    }
  }
  state.gatheredLast = dragged.size; // §6.4.2's gather contract reads this
  p.novaFlash = 0.3;
  const base = power(p, "nova") * np.damageMult;
  // GRAVE DIVIDEND / DEMOLITION RIDER (Phase C) read the ground the gather
  // just made — corpses under the cast, and DoTs on everything it caught.
  const zoneMult = graveDividend(state, p, p.pos, "nova");
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const d = dist(p.pos, m.pos);
    if (d - bodyRadius(m) > np.radius) continue;
    const dir = d > 1e-4 ? { x: (m.pos.x - p.pos.x) / d, y: (m.pos.y - p.pos.y) / d } : undefined;
    const crushed = dragged.has(m.id) ? 1 + np.crushBonus : 1;
    damageMonster(state, p, m, base * zoneMult * crushed, {
      dir, knockback: CONFIG.novaKnockback, school: castSchool(p, "nova"),
      ability: "nova", empowered: staticCharged(p, "nova"),
    });
  }
  demolitionRider(state, p, p.pos, np.radius, "nova");
  smashBreakables(state, ({ pos }) => dist(p.pos, pos) <= np.radius);
  // RIFT: the implosion point keeps working — anything that walks near the
  // crater for the next two seconds is dragged back into it.
  if (np.rift) {
    state.hazards.push({
      id: state.nextEntityId++, pos: { x: p.pos.x, y: p.pos.y },
      t: CONFIG.novaRiftSeconds, total: CONFIG.novaRiftSeconds, radius: CONFIG.novaRiftRadius,
      damage: 0, kind: "fissure", ownerId: p.id, ability: "nova", slow: 0, tick: 0.25,
    });
  }
  // REPRISE glyph: the blast re-detonates on the same spot a beat later.
  if (hasGlyph(p, "nova", "reprise")) {
    state.strikes.push({
      pos: { x: p.pos.x, y: p.pos.y }, t: CONFIG.glyphRepriseDelay, ownerId: p.id,
      kind: "echo", radius: np.radius, dmg: base * CONFIG.glyphRepriseFrac, knockback: 0, school: "magic",
      ability: "nova",
    });
  }
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
  // SINGULARITY capstone: the collapse pulls PROJECTILES too. The answer to
  // toysoldier volleys, sentinel railshots and boss radial fire — a capstone
  // the AI roster demands rather than one the ability wanted.
  if (np.singularity) {
    state.projectiles = state.projectiles.filter(
      (pr) => pr.from !== "enemy" || dist(p.pos, pr.pos) > np.gatherRadius,
    );
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
  if ((p.orbitGuardT ?? 0) > 0) p.orbitGuardT = Math.max(0, (p.orbitGuardT ?? 0) - dt);
  // THE HURL (V2 R3) runs first: while the ring is away there is NO aura. You
  // spent your bodyguard — that is the counterplay window the ability never had.
  if ((p.orbitHurlT ?? 0) > 0) { updateOrbitHurl(state, p, dt, op); return; }
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

    // AMBIENT: the grind tick is the one damage source in the game the player
    // never pressed. §6.4.5 caps its DPS; §6.4.6 caps its share.
    damageMonster(state, p, m, power(p, "orbit") * op.damageMult * stanceMult(p, "melee"), { allowCrit: false, school: castSchool(p, "orbit"), ability: "orbit", ambient: true });
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

/**
 * The thrown ring (V2 R3). Blades fly out to hurlRange and return along the
 * same line, hitting everything BOTH ways at hurlPassMult x a grind tick. The
 * ambient grind pays for it (orbitDamageMult 0.5 -> 0.22), which is the whole
 * point: the ability's damage moves from the passive to the press.
 */
function updateOrbitHurl(state: GameState, p: Player, dt: number, op: ReturnType<typeof orbitParams>): void {
  const travel = op.hurlRange / CONFIG.orbitHurlSpeed;
  const prev = p.orbitHurlT ?? 0;
  const next = Math.max(0, prev - dt);
  p.orbitHurlT = next;

  const dir = p.orbitHurlDir ?? p.facing;
  // t counts DOWN across two legs: [2*travel .. travel] outbound, then inbound.
  const outbound = next > travel;
  if (!outbound && (prev > travel)) p.orbitHurlHits = []; // the return pass is a new pass
  p.orbitHurlOut = outbound;
  // ONE source of truth for where the ring is (abilities.ts). The hosts call
  // the same function, so no renderer can drift from the damage pass again.
  const at = orbitHurlPoint(p) ?? { x: p.pos.x, y: p.pos.y };
  const dmg = power(p, "orbit") * op.damageMult * op.hurlPassMult * stanceMult(p, "melee");
  const hits = (p.orbitHurlHits ??= []);
  for (const m of state.monsters) {
    if (m.hp <= 0 || hits.includes(m.id)) continue;
    if (dist(at, m.pos) - bodyRadius(m) > CONFIG.orbitHurlHitRadius) continue;
    hits.push(m.id);
    damageMonster(state, p, m, dmg, {
      school: castSchool(p, "orbit"), ability: "orbit", allowCrit: false,
      dir: { x: dir.x, y: dir.y }, empowered: false,
    });
    // Razor's Edge: hurled blades PIERCE. Without it the throw stops on the
    // first body it finds (which is what makes the fork a real choice).
    if (!op.hurlPierce) { p.orbitHurlT = Math.min(next, travel); break; }
  }
  if (next <= 0) { p.orbitHurlHits = []; p.orbitHurlDir = undefined; }
}

/** ORBIT's press: throw the ring. */
function doOrbitHurl(state: GameState, p: Player, aim: Vec2): void {
  const op = orbitParams(p);
  p.cd.orbit = op.hurlCooldown * cdMult(p);
  bloodPrice(state, p, "orbit");
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  p.orbitHurlDir = dir;
  p.orbitHurlHits = [];
  p.orbitHurlT = (op.hurlRange / CONFIG.orbitHurlSpeed) * 2;
  p.orbitHurlOut = true;
  hit(state, p.pos, 0, "weapon");
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
  // Second Take: charges, like dash's — a charge is an identity where a second
  // cooldown percentage was not (V2 §4.3).
  p.cutCharges = Math.max(0, (p.cutCharges ?? cp.charges) - 1);
  if ((p.cd.cutto ?? 0) <= 0) p.cd.cutto = cp.cooldown * cdMult(p);
  bloodPrice(state, p, "cutto");
  const d = dist(p.pos, target.pos);
  const dir = d > 1e-4 ? { x: (target.pos.x - p.pos.x) / d, y: (target.pos.y - p.pos.y) / d } : p.facing;
  // The cut slides the whole distance; collision keeps it honest (no walls).
  moveWithCollision(state.map, p.pos, dir, Math.max(0, d - 0.9), isWalkable);
  p.facing = { x: dir.x, y: dir.y };
  p.attackSwing = 0.15;
  hit(state, p.pos, 0, "weapon"); // arrival flash for the juice layer
  // R6: BURST. The arrival strike CRITS a target that is not currently aggroed
  // on you — behind their caster that is ~3.8x a melee swing in one frame;
  // into the brute already chasing you it is the flat 1.9x and you took the
  // trip for the reach. That is the honest trade and the counterplay window.
  const unaware = (target.alertT ?? 0) <= 0 && target.windup <= 0 && !target.chargeT;
  damageMonster(state, p, target, power(p, "cutto") * cp.dmgMult, {
    dir, school: castSchool(p, "cutto"), shatterPoise: cp.smash, knockback: CONFIG.meleeKnockback,
    melee: true, ability: "cutto", forceCrit: unaware, empowered: staticCharged(p, "cutto"),
  });
  // Continuity (rider): the arrival target is BRANDED — deliberately the same
  // language and the same number as the Brandmark glyph. They do NOT stack;
  // strongest wins, which is what one shared brand field enforces for free.
  if (cp.brand && target.hp > 0) {
    target.brandT = Math.max(target.brandT ?? 0, CONFIG.cutBrandSeconds);
    target.brandAbility = "cutto";
    target.brandBy = p.id;
  }
  // PHASE ETCH / SLIPSTREAM: Blindside teleports, so it is movement (R6).
  if (hasGlyph(p, "cutto", "slipstream")) p.slipstreamT = CONFIG.glyphSlipstreamDur;
  if (hasGlyph(p, "cutto", "phase_etch")) p.dashTime = Math.max(p.dashTime, CONFIG.glyphPhaseEtchIframes);
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
  bloodPrice(state, p, "crowdsurf");
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
    // SLIPSTREAM glyph: the self-pull is movement — the surge window opens.
    if (hasGlyph(p, "crowdsurf", "slipstream")) p.slipstreamT = CONFIG.glyphSlipstreamDur;
  } else {
    dragToPlayer(state, p, target, sp.stagger);
  }
  // R7: the base chain HITS. A zero-damage base is why nobody drafted into the
  // roster's best verb; Gavel Drop now scales ON TOP of this rather than being
  // the only reason the ability does anything.
  const hitDmg = power(p, "crowdsurf") * (sp.hitFrac + sp.diveFrac);
  radialDamage(state, p, heavy ? p.pos : target.pos, CONFIG.surfDiveRadius, hitDmg,
    CONFIG.shockstepKnockback, castSchool(p, "crowdsurf"), 1, "crowdsurf");
  hit(state, heavy ? p.pos : target.pos, 0, "crit");
  // CLASS ACTION's spirit lives in the BASE at half strength: the chain drags
  // the nearest few light bodies it passes through, not just the anchor. The
  // capstone then upgrades that to everything, which makes it a real upgrade
  // over a base that already does something.
  const cap = sp.wave ? Infinity : sp.drag;
  if (cap > 0) {
    const len2 = d * d;
    const along: { m: Monster; t: number }[] = [];
    for (const m of state.monsters) {
      if (m === target || m.hp <= 0) continue;
      if (m.kind === "boss" || m.elite || ARCHETYPES[m.kind].mass > CONFIG.surfMassLimit) continue;
      const t = len2 > 1e-6
        ? Math.max(0, Math.min(1, ((m.pos.x - p.pos.x) * (anchor.x - p.pos.x) + (m.pos.y - p.pos.y) * (anchor.y - p.pos.y)) / len2))
        : 0;
      const closest = { x: p.pos.x + (anchor.x - p.pos.x) * t, y: p.pos.y + (anchor.y - p.pos.y) * t };
      if (dist(closest, m.pos) - bodyRadius(m) > CONFIG.surfPathRadius) continue;
      along.push({ m, t });
    }
    // Deterministic order: nearest to the caster first, id as the tiebreak.
    along.sort((a, b) => a.t - b.t || a.m.id - b.m.id);
    for (const e of along.slice(0, cap === Infinity ? along.length : cap)) {
      dragToPlayer(state, p, e.m, sp.stagger);
    }
  }
  // Writ of Attachment (rider): hazard interaction — a verb no other ability
  // has. The chain drags the nearest ground danger off the line and kills it,
  // or yanks YOU out of the one you are standing in.
  if (sp.hook) {
    const mine = state.hazards.find((hz) => hz.ownerId === undefined && dist(p.pos, hz.pos) <= hz.radius);
    if (mine) state.hazards = state.hazards.filter((hz) => hz !== mine);
    else {
      const near = state.hazards.find((hz) => hz.ownerId === undefined && dist(anchor, hz.pos) <= sp.range);
      if (near) state.hazards = state.hazards.filter((hz) => hz !== near);
    }
  }
}

/** Stunt Double: the production hires a professional. It taunts (ai.ts hunts
 * it), soaks hits into its contract (never dies; pro), mirrors the owner's
 * swings, and retires with a bang proportional to the beating it took. */
function doStuntDouble(state: GameState, p: Player): void {
  const dp = stuntDoubleParams(p);
  p.cd.stuntdouble = dp.cooldown * cdMult(p);
  bloodPrice(state, p, "stuntdouble");
  // R8: the double has HP, scaled by the OWNER's pool so it stays relevant at
  // depth. "Decoys have no HP" was the roster's biggest lie: it made a damage
  // ability secretly the strongest defensive button in the game, and made
  // AWARD SEASON a flat -50% cooldown drawn as a diamond.
  const maxHp = Math.max(1, Math.round(p.maxHp * dp.hpFrac));
  const understudy = hasGlyph(p, "stuntdouble", "understudy_rider");
  p.doubleCueUsed = false;
  state.decoys.push({
    id: state.nextEntityId++,
    ownerId: p.id,
    pos: { x: p.pos.x, y: p.pos.y },
    facing: { x: p.facing.x, y: p.facing.y },
    t: dp.contract + (understudy ? CONFIG.glyphUnderstudyContract : 0),
    absorbed: 0,
    hp: maxHp,
    maxHp,
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
    // R8: the double is MORTAL. `hp` is optional, so a pre-rework decoy still
    // in flight (an old snapshot) loads invulnerable and expires normally.
    if (dc.hp !== undefined) {
      dc.hp -= damage;
      if (dc.hp <= 0) dc.died = true;
    }
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
    if (dc.t > 0 && !dc.died) { remaining.push(dc); continue; }
    const owner = state.players.find((pl) => pl.id === dc.ownerId) ?? state.players[0];
    const dp = stuntDoubleParams(owner);
    const radius = CONFIG.doubleExplodeRadius * (1 + dp.pyro * 0.4);
    const dmg = Math.min(dc.absorbed * dp.explodeFrac, owner.attackPower * CONFIG.doubleExplodeCap);
    if (dmg >= 1) {
      radialDamage(state, owner, dc.pos, radius, dmg, 0.5, "physical");
      hit(state, dc.pos, 0, "crit");
      state.events.push(`${owner.name}'s stunt double takes a bow — and EXPLODES.`);
      // Understudy's Rider: the farewell blast CHILLS.
      if (hasGlyph(owner, "stuntdouble", "understudy_rider")) {
        for (const m of state.monsters) {
          if (m.hp <= 0 || dist(dc.pos, m.pos) > radius) continue;
          applyStatus(m, {
            kind: "chill", duration: CONFIG.glyphCryoDuration, school: "magic",
            magnitude: m.kind === "boss" ? CONFIG.glyphUnderstudyChill * CONFIG.chillBossMult : CONFIG.glyphUnderstudyChill,
          });
        }
      }
    }
    // Pyrotechnic Exit (V2 §4.3): +40% blast was a number sitting opposite a
    // Method Actor that had just become a behavior — a dead fork. The blast
    // now LEAVES something: burning ground, scaled by what it absorbed.
    if (dp.pyro > 0 && dmg >= 1) {
      state.hazards.push({
        id: state.nextEntityId++, pos: { x: dc.pos.x, y: dc.pos.y },
        t: CONFIG.doublePyroBurnSeconds, total: CONFIG.doublePyroBurnSeconds,
        radius, damage: 0, kind: "fissure", ownerId: owner.id, ability: "stuntdouble",
        tick: 0.5, slow: 0,
      });
      const burn = Math.max(1, Math.round(dmg * 0.2));
      for (const m of state.monsters) {
        if (m.hp <= 0 || dist(dc.pos, m.pos) > radius) continue;
        applyStatus(m, {
          kind: "burn", duration: CONFIG.doublePyroBurnSeconds, school: "magic",
          magnitude: burn, sourceId: owner.id,
        });
      }
    }
    // AWARD SEASON, inverted (V2 §4.3): a double that DIES on the clock did
    // its job and refunds; one that expires unharmed refunds nothing. It used
    // to fire unconditionally, because surviving was the only thing a decoy
    // could do — a flat cooldown cut drawn as a diamond.
    if (dp.award && dc.died && (owner.cd.stuntdouble ?? 0) > 0) {
      owner.cd.stuntdouble = (owner.cd.stuntdouble ?? 0) * (1 - CONFIG.doubleAwardRefund);
    }
  }
  state.decoys = remaining;
}

// ---- Ultimates (the fifth slot) ----

/** Sponsor Airstrike: schedule a shell bombardment around the aim point.
 * The constellation shapes the barrage: Payload hardens shells, Saturation
 * adds them (wider), Precision tightens the grouping. */
/**
 * SPONSOR BARRAGE (V2 U2). The worst-measured ultimate becomes a DECISION: a
 * 3s directed channel that walks with your cursor at 70% move speed with no
 * attacking. Pressing it and continuing to swing — today's optimal play — now
 * gets you nothing. §6.4.9 makes the commitment pay for itself or the channel
 * shrinks; a commitment that fails those assertions is a tax, not a decision.
 */
function doAirstrike(state: GameState, p: Player, aim: Vec2): void {
  const ap = airstrikeParams(p);
  p.cd.airstrike = ap.cooldown; // rule-7 clamped (glyph CDR folds in)
  p.barrageT = ap.channel;
  p.barrageNext = 0;
  p.barrageAim = barrageAimPoint(p, aim);
  coldOpen(state, p, "airstrike"); // chill the room the barrage opens on
  bloodPrice(state, p, "airstrike");
  armEncore(p, "airstrike", ap.channel);
  announce(state, "show", `${p.name} takes the fire-control handset. SPONSOR BARRAGE — walk it in.`);
}

/** Where the barrage is pointed right now (clamped to the ultimate's reach). */
function barrageAimPoint(p: Player, aim: Vec2): Vec2 {
  const len = dhypot(aim.x, aim.y);
  const range = Math.min(CONFIG.ultAirstrikeRange, len || 1);
  const dir = len > 0 ? { x: aim.x / len, y: aim.y / len } : p.facing;
  return { x: p.pos.x + dir.x * range, y: p.pos.y + dir.y * range };
}

/** The channel: one shell every `interval`, wherever the cursor is NOW. */
function updateBarrage(state: GameState, p: Player, aim: Vec2, dt: number): void {
  if ((p.barrageT ?? 0) <= 0) return;
  const ap = airstrikeParams(p);
  p.barrageT = Math.max(0, (p.barrageT ?? 0) - dt);
  p.barrageAim = barrageAimPoint(p, aim);
  p.barrageNext = (p.barrageNext ?? 0) - dt;
  if (p.barrageNext > 0) return;
  p.barrageNext = ap.interval;
  let at = { x: p.barrageAim.x, y: p.barrageAim.y };
  // Precision Strike: shells TRACK the nearest elite/boss near the aim point.
  if (ap.track > 0) {
    let best: Monster | null = null;
    let bestD = ap.track;
    for (const m of state.monsters) {
      if (m.hp <= 0 || (!m.elite && m.kind !== "boss")) continue;
      const d = dist(at, m.pos);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) at = { x: best.pos.x, y: best.pos.y };
  }
  const a = nextFloat(state.rng) * Math.PI * 2;
  const r = nextFloat(state.rng) * ap.spread;
  // Saturation Barrage: the drop covers a BAND across the aim, not a point.
  const band = ap.band > 0 ? (nextFloat(state.rng) - 0.5) * ap.band : 0;
  const perp = { x: -(at.y - p.pos.y), y: at.x - p.pos.x };
  const plen = dhypot(perp.x, perp.y) || 1;
  state.strikes.push({
    pos: {
      x: at.x + dcos(a) * r + (perp.x / plen) * band,
      y: at.y + dsin(a) * r + (perp.y / plen) * band,
    },
    t: 0.35,
    ownerId: p.id,
    kind: "shell",
    ability: "airstrike",
  });
}

/**
 * Tick monster-side status effects (5.11). Due DoT ticks route through
 * damageMonster — the ONE monster choke point — so schools, resists, shielded,
 * one-shot caps, kill credit, and hit events all compose for free. DoT never
 * crits and never builds poise (a burn shouldn't stagger-lock a brute).
 */
function updateMonsterStatuses(state: GameState, dt: number): void {
  for (const m of state.monsters) {
    // Brandmark glyph: the mark fades on the world clock.
    if ((m.brandT ?? 0) > 0) m.brandT = Math.max(0, (m.brandT ?? 0) - dt);
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
/**
 * ARENA DIRECTOR (boss layer 3): each band-boss arena runs ONE environmental
 * script independent of the boss — the boss + the ROOM is the fight.
 * Floor 6: the sump RISES (sludge creeps in). Floor 9: the garden REGROWS
 * (root zones return). Floor 15: the wall vents EXHALE flame rows. All of it
 * telegraphed like everything else; all of it stops the moment the boss falls.
 */
function arenaDirector(state: GameState, dt: number): void {
  const bossFloor = isCityBossFloor(state.floor) ||
    (state.runKind !== "roam" && state.floor >= CONFIG.finalFloor);
  if (!bossFloor) return;
  const boss = state.monsters.find((m) => m.kind === "boss");
  if (!boss || !boss.introduced) return; // the show starts at the intro
  const arena = bandForBossFloor(state.floor); // 1..6
  const prev = state.arenaT ?? 0;
  state.arenaT = prev + dt;
  const crossed = (interval: number) =>
    Math.floor((state.arenaT ?? 0) / interval) > Math.floor(prev / interval);
  if (alivePlayers(state).length === 0) return;
  // BOSSES V2 — LIVE AUDIENCE (mutator): the crowd throws things on a rhythm.
  // The ROOM does damage now, so arena-first movement beats boss-first.
  if (boss.bossMutators?.includes("liveaudience") && crossed(CONFIG.audienceInterval)) {
    bossAudienceThrow(state, boss);
    if ((state.arenaT ?? 0) < CONFIG.audienceInterval * 1.5) {
      announce(state, "boss", "The LIVE AUDIENCE is throwing things. Legal says that's on you now.");
    }
  }
  if (arena !== 2 && arena !== 3 && arena !== 5) return; // 6 / 9 / 15 have directors
  // The room reuses the SAME telegraphed helpers the signatures taught — the
  // grammar players already learned, now on the arena's own metronome.
  if (arena === 2 && crossed(CONFIG.directorFloodInterval)) {
    bossFloodSurge(state, boss);
    if ((state.arenaT ?? 0) < CONFIG.directorFloodInterval * 1.5) {
      announce(state, "boss", "The sump is RISING on its own schedule. The arena shrinks while the King holds court.");
    }
  } else if (arena === 3 && crossed(CONFIG.directorRegrowInterval)) {
    bossRootGrasp(state, boss);
    if ((state.arenaT ?? 0) < CONFIG.directorRegrowInterval * 1.5) {
      announce(state, "boss", "The garden REGROWS as fast as you trample it. Keep your feet moving.");
    }
  } else if (arena === 5 && crossed(CONFIG.directorVentInterval)) {
    bossFlameSweep(state, boss);
    if ((state.arenaT ?? 0) < CONFIG.directorVentInterval * 1.5) {
      announce(state, "boss", "The wall vents EXHALE on a rhythm. Learn the room's breathing.");
    }
  }
}

/** Distance from a point to the segment a-b (beam hazards hit by half-width). */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq < 1e-8 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  return dhypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function updateHazards(state: GameState, dt: number): void {
  if (state.hazards.length === 0) return;
  const remaining: GameState["hazards"] = [];
  for (const hz of state.hazards) {
    hz.t -= dt;
    // ---- PLAYER-OWNED GROUND (ABILITIES-V2) ----
    // The hazard system already ticks, slows and renders; both new zones ride
    // it rather than inventing a parallel one. Owner-side zones never touch
    // crawlers, and they route damage through damageMonster so schools,
    // resists, kill credit and glyph riders all compose for free.
    if (hz.kind === "fissure" || hz.kind === "cables") {
      if (hz.t <= 0) continue;
      const owner = state.players.find((pl) => pl.id === hz.ownerId);
      if (!owner) continue;
      hz.tick = (hz.tick ?? 0) - dt;
      const due = (hz.tick ?? 0) <= 0;
      if (due) hz.tick = hz.kind === "cables" ? 0.25 : 1;
      for (const m of state.monsters) {
        if (m.hp <= 0) continue;
        const inside = hz.kind === "cables" && hz.end
          ? distToSegment(m.pos, hz.pos, hz.end) - bodyRadius(m) <= hz.radius
          : dist(hz.pos, m.pos) - bodyRadius(m) <= hz.radius;
        if (!inside) continue;
        // FAULT LINE's fissure and Live Wire both bite on their own tick.
        if (due && hz.damage > 0) {
          damageMonster(state, owner, m, hz.damage, {
            allowCrit: false, poiseMult: 0, school: castSchool(owner, hz.ability ?? "cataclysm"),
            ability: hz.ability,
          });
        }
        // Both zones SLOW (chill is the shipped slow verb; refresh, no stack).
        if (due && (hz.slow ?? 0) > 0) {
          applyStatus(m, {
            kind: "chill", duration: 0.6, school: "magic",
            magnitude: m.kind === "boss" ? (hz.slow ?? 0) * CONFIG.chillBossMult : (hz.slow ?? 0),
          });
        }
        // THE PIN. Non-boss bodies are held for the full duration, bosses
        // briefly; nothing is re-pinned inside its lockout. A pinned enemy
        // does NOT move — and is not moved: cables never relocate a body,
        // which is what keeps them out of §2.2's gather budget.
        if ((hz.pin ?? 0) > 0 && (m.pinLockT ?? 0) <= 0) {
          const cp = cablesParams(owner);
          m.pinnedT = m.kind === "boss" ? cp.bossPin : cp.pin;
          m.pinLockT = CONFIG.cablesRepinLockout;
        }
      }
      // Taut: the line RE-ARMS once the pin window lapses — timing, not
      // duration, so one cast holds a lane through two waves.
      if ((hz.pin ?? 0) > 0 && hz.t <= CONFIG.cablesFieldSeconds && (hz.rearms ?? 0) > 0) {
        hz.rearms = (hz.rearms ?? 0) - 1;
        hz.t += CONFIG.cablesPinSeconds;
        for (const m of state.monsters) if ((m.pinLockT ?? 0) > 0) m.pinLockT = 0;
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "beam" && hz.end && hz.sweep === undefined) {
      // Beam: telegraph for `arm` seconds, fire ONCE along the whole segment
      // (piercing — cover doesn't help, sidestepping does), fade briefly.
      // (Sweeping beams — the Archivist — are handled in their own branch.)
      if (hz.t <= 0) continue; // flash spent
      // Lock-on (the sentinel): while arming, the line TRACKS its player —
      // until the final lock window, when it freezes. Juke at the click.
      if (hz.trackId !== undefined && !hz.fired) {
        const untilFire = hz.t - (hz.total - (hz.arm ?? 0));
        if (untilFire <= CONFIG.sentinelBeamLock) {
          hz.trackId = undefined; // LOCKED — the last dodge window opens
        } else {
          const target = state.players.find((p) => p.id === hz.trackId && p.alive);
          if (target) {
            const d = dhypot(target.pos.x - hz.pos.x, target.pos.y - hz.pos.y);
            if (d > 1e-4) {
              hz.end = {
                x: hz.pos.x + ((target.pos.x - hz.pos.x) / d) * CONFIG.sentinelBeamLength,
                y: hz.pos.y + ((target.pos.y - hz.pos.y) / d) * CONFIG.sentinelBeamLength,
              };
            }
          }
        }
      }
      const live = hz.total - hz.t >= (hz.arm ?? 0);
      if (live && !hz.fired) {
        hz.fired = true;
        hz.t = Math.min(hz.t, CONFIG.beamFadeSeconds); // whatever remains is the flash
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue; // dash i-frames beat the shot
          if (distToSegment(p.pos, hz.pos, hz.end) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage, { src: hazardSrc(hz) })) {
            handlePlayerDeath(state, p, `${p.name} stood on the dotted line. The System appreciates the composition.`);
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "spore") {
      // BOSSES V2 — a Pollinator pod. It ARMS like everything else, then
      // BLOOMS: one bite in radius, and it seeds children. Left alone the
      // arena saturates, which is what makes "survive the storm" a real ask
      // instead of unavoidable chip. Bounded by bloomPodCap.
      if (hz.t > 0) { remaining.push(hz); continue; }
      for (const p of state.players) {
        if (!p.alive || p.dashTime > 0) continue;
        if (dist(hz.pos, p.pos) > hz.radius) continue;
        if (damagePlayerHit(state, p, hz.damage, { hazard: true })) {
          handlePlayerDeath(state, p, `${p.name} let the garden finish a cycle. It is thriving.`);
        }
      }
      const parent = state.monsters.find((mm) => mm.id === hz.srcId && mm.hp > 0);
      if (parent) {
        for (let i = 0; i < CONFIG.bloomChildren; i++) {
          const a = (i / CONFIG.bloomChildren) * Math.PI * 2 + hz.id;
          seedSporePod(state, parent, {
            x: hz.pos.x + dcos(a) * (hz.radius + 0.8),
            y: hz.pos.y + dsin(a) * (hz.radius + 0.8),
          });
        }
      }
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
            if (damagePlayerHit(state, p, hz.damage, { hazard: true, src: hazardSrc(hz) })) {
              handlePlayerDeath(state, p, `${p.name} tried to swim the surge. The sludge won. Smell-o-vision regrets everything.`);
            }
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "beam" && hz.sweep !== undefined && hz.end) {
      // SWEEPING beam (the Archivist): the segment rotates around its caster,
      // ticking anyone it crosses, for as long as the channel holds — the
      // caster staggering or dying cuts it off instantly.
      const src = state.monsters.find((mm) => mm.id === hz.srcId);
      if (hz.t <= 0 || !src || src.hp <= 0 || src.stagger > 0 || src.windupKind !== "sweep") continue;
      hz.fired = true; // renders HOT from the first frame — it is live
      const dx = hz.end.x - hz.pos.x, dy = hz.end.y - hz.pos.y;
      const dth = hz.sweep * dt;
      const cos = dcos(dth), sin = dsin(dth);
      hz.end = { x: hz.pos.x + dx * cos - dy * sin, y: hz.pos.y + dx * sin + dy * cos };
      hz.tick = (hz.tick ?? 0) - dt;
      if (hz.tick <= 0) {
        hz.tick = CONFIG.puddleTickSeconds * 0.5; // the beam bites fast
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue;
          if (distToSegment(p.pos, hz.pos, hz.end) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage, { src: hazardSrc(hz) })) {
            handlePlayerDeath(state, p, `${p.name} read along with the Archivist. The text was a beam.`);
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "consecrate") {
      // Contested ground (the Ruins cleric): monsters standing in the light
      // are MENDED; crawlers standing in it BURN. Fight outside it, kill the
      // cleric, or stand in it anyway and race the math.
      if (hz.t <= 0) continue; // the blessing fades
      hz.tick = (hz.tick ?? 0) - dt;
      if (hz.tick <= 0) {
        hz.tick = CONFIG.puddleTickSeconds;
        for (const mm of state.monsters) {
          if (mm.hp <= 0 || mm.hp >= mm.maxHp) continue;
          if (dist(hz.pos, mm.pos) > hz.radius) continue;
          const heal = Math.min(CONFIG.consecrateHealPerTick, mm.maxHp - mm.hp);
          mm.hp += heal;
          hit(state, mm.pos, heal, "heal");
        }
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue;
          if (dist(hz.pos, p.pos) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage, { hazard: true, src: hazardSrc(hz) })) {
            handlePlayerDeath(state, p, `${p.name} stood on holy ground uninvited. The congregation objected.`);
          }
        }
      }
      remaining.push(hz);
      continue;
    }
    if (hz.kind === "shards") {
      // The Ossuary Warden's slam debris: puddle cadence, physical bite,
      // no poison soak — the room just got smaller.
      if (hz.t <= 0) continue; // the shards crumble
      hz.tick = (hz.tick ?? 0) - dt;
      if (hz.tick <= 0) {
        hz.tick = CONFIG.puddleTickSeconds;
        for (const p of state.players) {
          if (!p.alive || p.dashTime > 0) continue;
          if (dist(hz.pos, p.pos) > hz.radius) continue;
          if (damagePlayerHit(state, p, hz.damage, { hazard: true, src: hazardSrc(hz) })) {
            handlePlayerDeath(state, p, `${p.name} lay down on the bone pile. The ossuary accepts the donation.`);
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
          if (damagePlayerHit(state, p, hz.damage, { hazard: true, src: hazardSrc(hz) })) {
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
    // THE CONDEMNED ARCHITECT (BOSSES-V2 §3.4): its masonry destroys the
    // arena's cover FOR REAL — the fight starts cover-based and ends in open
    // ground. Scoped to its own casts (srcId) so an ordinary boss's hazard
    // rain never quietly flattens a PILLARED arena it was not designed to eat.
    if (hz.srcId !== undefined) {
      const caster = state.monsters.find((mm) => mm.id === hz.srcId);
      if (caster?.bossId === "architect") smashBlockersAt(state, hz.pos, hz.radius);
    }
    for (const p of state.players) {
      if (!p.alive || p.dashTime > 0) continue; // dash i-frames dodge the blast
      if (dist(hz.pos, p.pos) > hz.radius) continue;
      const d = dist(hz.pos, p.pos);
      const away = d > 1e-4
        ? { x: (p.pos.x - hz.pos.x) / d, y: (p.pos.y - hz.pos.y) / d }
        : undefined;
      if (damagePlayerHit(state, p, hz.damage, { dir: away, hazard: true, src: hazardSrc(hz) })) {
        handlePlayerDeath(state, p, `${p.name} looted a corpse that was still ticking. The crowd howls.`);
      }
    }
  }
  state.hazards = remaining;
}

/** Tick raisable corpses: past their TTL they're too cold for the necromancer. */
/** Pop every smashable the hit test reaches: pocket gold + a poof. */
/** BRUTE SMASH-THROUGH (PHYSICALITY.md §1 v2): a committed big-frame swing
 *  also clears blocking furniture in its arc — the table explodes and the
 *  fight arrives. Clutter hoards are NOT touched (their gold stays a player
 *  verb); only footprint pieces fall, and they fall in one blow. */
export function smashBlockersAt(state: GameState, center: Vec2, radius: number): void {
  // Arena INTERACTIVE props are exempt: the Architect is welcome to eat your
  // cover, but a boss must never be able to solve its own mechanic by
  // flattening the floodgates/vents/conveyors that counter it.
  smashBreakables(state, (b) => !!b.footprint && !b.onBreak && dist(center, b.pos) <= radius, 999);
}

function smashBreakables(state: GameState, hits: (b: Breakable) => boolean, dmg = 1): void {
  const bs = state.breakables ?? [];
  if (bs.length === 0) return;
  const left: Breakable[] = [];
  for (const b of bs) {
    if (!hits(b)) {
      left.push(b);
      continue;
    }
    b.hp -= dmg;
    if (b.hp > 0) {
      hit(state, b.pos, 0, "weapon"); // it cracks; one more should do it
      left.push(b);
      continue;
    }
    // Blocking furniture opens the lane when it dies (PHYSICALITY.md §1) —
    // the mask mutates in place; no floor rebuild.
    if (b.footprint && state.map.blocked) {
      for (const ti of b.footprint) state.map.blocked[ti] = 0;
    }
    // V3 — an interactive prop does something on the way out.
    if (b.onBreak) fireArenaProp(state, b);
    // Roam (#25): remember what was consumed so a save/load rebuild of this
    // floor doesn't restock the hoard for free.
    if (state.runKind === "roam") (state.roamSmashed ??= []).push(breakablePosKey(b.pos));
    const gold = CONFIG.breakableGoldBase + Math.floor(nextFloat(state.rng) * (CONFIG.breakableGoldSpread + 1)) + Math.floor(state.floor / 3);
    state.loot.push({ id: state.nextEntityId++, pos: { x: b.pos.x, y: b.pos.y }, kind: "gold", amount: gold });
    hit(state, b.pos, 0, "weapon"); // the pop — hosts particle it
  }
  state.breakables = left;
}

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
    // Which ability owns this blast: tagged at schedule time (V2 §3), with the
    // legacy reading for pre-tag snapshots (shell = airstrike, echo = cataclysm).
    const source = s.ability ?? (s.kind === "echo" ? "cataclysm" : "airstrike");
    const killed = radialDamage(
      state, owner, s.pos, radius, dmg, s.knockback ?? CONFIG.airstrikeKnockback, s.school ?? "physical",
      1, source,
    );
    hit(state, s.pos, 0, "crit"); // impact flash for the juice layer
    if (s.kind === "echo") {
      // A CATACLYSM echo is still a Cataclysm: EXTINCTION chains off its kills
      // too. A Reprise NOVA echo is a nova — the ultimate's capstone stays the
      // ultimate's (rule 4: behaviors compose, they never leak across kits).
      if (source === "cataclysm" && cataclysmParams(owner).extinction) extinctionChain(state, owner, killed);
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
  const cp = cataclysmParams(p);
  p.cd.cataclysm = cp.cooldown; // rule-7 clamped (glyph CDR folds in)
  p.novaFlash = 0.3; // reuse the ring effect
  coldOpen(state, p, "cataclysm");
  bloodPrice(state, p, "cataclysm");
  armEncore(p, "cataclysm", cp.fissureSeconds);
  const blastDmg = power(p, "cataclysm") * cp.dmgMult * graveDividend(state, p, p.pos, "cataclysm");
  const killed = radialDamage(state, p, p.pos, cp.radius, blastDmg, 0, "magic", cp.poiseMult, "cataclysm");
  // Corpses detonate where they DIED — before the survivors get hurled.
  if (cp.extinction) extinctionChain(state, p, killed);
  for (const m of state.monsters) {
    if (m.hp <= 0) continue; // the dead don't fly
    const d = dist(p.pos, m.pos);
    if (d > cp.radius || d < 1e-4) continue;
    const dir = { x: (m.pos.x - p.pos.x) / d, y: (m.pos.y - p.pos.y) / d };
    moveWithCollision(state.map, m.pos, dir, cp.knockback, isWalkable);
  }
  // FAULT LINE (V2 U1): THE GROUND STAYS BROKEN. This is the whole rework —
  // knockback and zone finally cooperate instead of fighting (Upheaval used to
  // throw targets clear of Aftermath's echo, a fork anti-synergistic inside
  // one ability). Enemies hurled out have to walk back through the fissure.
  state.hazards.push({
    id: state.nextEntityId++,
    pos: { x: p.pos.x, y: p.pos.y },
    t: cp.fissureSeconds,
    total: cp.fissureSeconds,
    radius: cp.radius,
    damage: Math.max(1, Math.round(blastDmg * cp.fissureTickFrac)),
    kind: "fissure",
    ownerId: p.id,
    ability: "cataclysm",
    slow: cp.fissureSlow,
    blocks: cp.chasm,
    tick: 1,
  });
  demolitionRider(state, p, p.pos, cp.radius, "cataclysm");
  // REPRISE glyph (ultimate socket): a second, smaller detonation — additive
  // with the Aftermath node (rule 4: behaviors compose, families exclude).
  if (hasGlyph(p, "cataclysm", "reprise")) {
    state.strikes.push({
      pos: { x: p.pos.x, y: p.pos.y }, t: CONFIG.glyphRepriseDelay, ownerId: p.id,
      kind: "echo", radius: cp.radius, dmg: blastDmg * CONFIG.glyphRepriseFrac, knockback: 0, school: "magic",
      ability: "cataclysm",
    });
  }
  announce(state, "show", `${p.name} CRACKS THE FLOOR. Everything airborne is a highlight.`);
}

/** Bullet Time: the world slows; crawlers do not. Deep Focus stretches it. */
function doBulletTime(state: GameState, p: Player): void {
  const bp = bulletTimeParams(p);
  p.cd.bullettime = bp.cooldown; // rule-7 clamped (glyph CDR folds in)
  state.bulletTimeLeft = bp.duration;
  state.btSecondWind = bp.secondWind;
  coldOpen(state, p, "bullettime");
  bloodPrice(state, p, "bullettime");
  armEncore(p, "bullettime", bp.duration);
  announce(state, "show", `${p.name} bends the broadcast frame rate. BULLET TIME.`);
}

/** ENCORE CLAUSE: arm the refund window for an ultimate ACTIVE duration.
 * "During the ultimate" is not a definition (§5.4 flag 2) — Bullet Time and
 * Injunction have durations, Barrage has a 3s channel, Fault Line's fissure
 * lasts 10s, and a bare Cataclysm cast is one frame. glyphWindow settles it,
 * and rule 8's per-cast budget does the rest of the work. */
function armEncore(p: Player, ability: AbilityId, activeDuration?: number): void {
  if (!hasGlyph(p, ability, "encore_clause")) return;
  const cd0 = p.cd[ability] ?? 0;
  if (cd0 <= 0) return;
  p.rebateAbility = ability;
  p.rebateT = glyphWindow(ability, activeDuration);
  p.rebateCd0 = cd0;
  // On floor 15 Fault Line's raw refund would be 4% x ~20 kills = 80% of a 40s
  // cooldown; the budget clamps it to 20s. §6.4.10 pins exactly that.
  p.rebateBudget = cd0 * CONFIG.refundCapFraction;
}

/**
 * Cast the ability in a slot. One switch = the whole cast surface; adding an
 * ability means one case here + a registry entry in abilities.ts.
 */
/**
 * BULWARK (V2 N1). 1.5s of 60% mitigation, paid back as a heal on what it
 * absorbed. Movement is unrestricted and there are NO i-frames — that is
 * dash's job, and the two must never be interchangeable. The first ability in
 * the game that rewards standing still.
 */
function doBulwark(state: GameState, p: Player): void {
  const bp = bulwarkParams(p);
  p.cd.bulwark = bp.cooldown * cdMult(p);
  p.bulwarkT = bp.duration;
  p.bulwarkAbsorbed = 0;
  p.bulwarkHits = 0;
  bloodPrice(state, p, "bulwark");
  hit(state, p.pos, 0, "weapon");
}

/** Tick the brace; expiry pays the heal, SPITE banks, and Shove clears space. */
function updateBulwark(state: GameState, p: Player, dt: number): void {
  if ((p.bulwarkT ?? 0) <= 0) return;
  const bp = bulwarkParams(p);
  const left = Math.max(0, (p.bulwarkT ?? 0) - dt);
  p.bulwarkT = left;
  if (left > 0) return;
  const absorbed = p.bulwarkAbsorbed ?? 0;
  // Grit is GREED: harder brace, but the payout only lands if you actually
  // stood in it. Rally is SAFETY and already paid on cast. The fork is
  // EXCLUSIVE, which is why the kit still reads in one breath (§2.3).
  const owed = bp.gritHits > 0 && (p.bulwarkHits ?? 0) < bp.gritHits ? 0 : absorbed;
  if (!bp.rally && owed > 0) bulwarkHeal(state, p, owed * bp.healFrac);
  if (bp.spite) p.spiteBank = Math.min(absorbed, p.attackPower * CONFIG.bulwarkSpiteCap);
  if (bp.shove) {
    for (const m of state.monsters) {
      if (m.hp <= 0 || dist(p.pos, m.pos) > CONFIG.bulwarkShoveRadius) continue;
      const d = Math.max(1e-4, dist(p.pos, m.pos));
      moveWithCollision(state.map, m.pos, { x: (m.pos.x - p.pos.x) / d, y: (m.pos.y - p.pos.y) / d },
        CONFIG.bulwarkShoveTiles, isWalkable);
      if (m.kind !== "boss" && m.affix !== "juggernaut") {
        m.stagger = Math.max(m.stagger, CONFIG.bulwarkShoveStagger);
      }
    }
    hit(state, p.pos, 0, "weapon");
  }
  p.bulwarkAbsorbed = 0;
  p.bulwarkHits = 0;
}

function bulwarkHeal(state: GameState, p: Player, amount: number): void {
  const heal = Math.min(Math.round(amount), Math.round(p.maxHp * CONFIG.bulwarkHealCap));
  if (heal <= 0) return;
  p.hp = Math.min(p.maxHp, p.hp + heal);
  hit(state, p.pos, heal, "heal");
}

/**
 * STAGE CABLES (V2 N2). Throw a line; everything non-boss that crosses is
 * PINNED. The cables never MOVE a body — a pinned enemy stays exactly where it
 * was pinned — which is what keeps this out of the gather budget (§2.2's
 * two-owner cap, machine-checked in §6.4.8). The pin is control, not a stun:
 * pinned enemies can still finish a windup. Breaker is the stun.
 */
function doCables(state: GameState, p: Player, aim: Vec2): void {
  const cp = cablesParams(p);
  p.cd.cables = cp.cooldown * cdMult(p);
  bloodPrice(state, p, "cables");
  const dir = normalize(aim.x === 0 && aim.y === 0 ? p.facing : aim);
  p.facing = dir;
  const mid = { x: p.pos.x + dir.x * cp.length * 0.5, y: p.pos.y + dir.y * cp.length * 0.5 };
  const end = { x: p.pos.x + dir.x * cp.length, y: p.pos.y + dir.y * cp.length };
  state.hazards.push({
    id: state.nextEntityId++,
    pos: mid,
    end,
    t: cp.fieldSeconds + cp.pin,
    total: cp.fieldSeconds + cp.pin,
    radius: cp.width,
    damage: 0,
    kind: "cables",
    ownerId: p.id,
    ability: "cables",
    slow: cp.fieldSlow,
    pin: cp.pin,
    rearms: cp.rearms,
    tick: 0.25,
  });
  hit(state, p.pos, 0, "chain", { dir, to: end });
}

/**
 * INJUNCTION (V2 N3). The collapse clock STAYS — and the dungeon fights back
 * for exactly as long as you hold it. The debt is DERIVED from the freeze
 * (injunctionDebtRatio 5/3), never a free knob, so the net run-clock delta is
 * negative at every rank and no node can make the trade profitable.
 */
function doInjunction(state: GameState, p: Player): void {
  const ip = injunctionParams(p);
  p.cd.injunction = ip.cooldown; // rule-7 clamped (glyph CDR folds in)
  p.injunctionT = ip.freeze;
  p.injunctionDebt = ip.debt;
  coldOpen(state, p, "injunction");
  bloodPrice(state, p, "injunction");
  armEncore(p, "injunction", ip.freeze);
  // §2.1's third property says ultimates need the BIGGEST counterplay window.
  // Here it is: every monster on the floor is ENRAGED for the duration. Press
  // this into a full room with no plan and you take the worst twelve seconds
  // of the floor — and still owe twenty.
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    m.injRageT = ip.freeze;
  }
  announce(state, "show", `The System has GRANTED ${p.name} a stay. Terms apply — and the floor has been told.`, "high");
}

/** Tick the stay; release pays the debt (DISMISSED can halve it, never cancel). */
function updateInjunction(state: GameState, p: Player, dt: number): void {
  if ((p.injunctionT ?? 0) <= 0) return;
  const left = Math.max(0, (p.injunctionT ?? 0) - dt);
  p.injunctionT = left;
  if (left > 0) return;
  let debt = p.injunctionDebt ?? 0;
  p.injunctionDebt = 0;
  if (rank(p, "inj.dismissed") > 0) {
    const anyone = state.monsters.some(
      (m) => m.hp > 0 && dist(p.pos, m.pos) <= CONFIG.injunctionDismissedRadius,
    );
    if (!anyone) debt *= 1 - CONFIG.injunctionDismissedRelief; // cut, never cancelled
  }
  state.timeRemaining -= debt;
  for (const m of state.monsters) m.injRageT = 0;
  announce(state, "progress", `The stay EXPIRES. ${Math.round(debt)} seconds come off ${p.name}'s clock. Terms were disclosed.`);
}

/** Executioner's Rebate glyph (rule 8): arm the per-cast refund window. The
 * budget caps this cast's total refunds at refundCapFraction of the cooldown
 * it just set; re-casting resets window AND budget (never banks across casts). */
function armRebate(p: Player, ability: AbilityId): void {
  if (!hasGlyph(p, ability, "executioners_rebate")) return;
  const cd0 = p.cd[ability] ?? 0;
  if (cd0 <= 0) return;
  p.rebateAbility = ability;
  p.rebateT = CONFIG.glyphRebateWindow;
  p.rebateCd0 = cd0;
  p.rebateBudget = cd0 * CONFIG.refundCapFraction;
}

function castAbility(state: GameState, p: Player, ability: AbilityId, aim: Vec2, move: Vec2): void {
  // Dash is charge-gated, not cooldown-gated: cd.dash is its recharge timer,
  // which may be ticking while a banked charge is still ready to spend.
  if (ability === "dash") {
    if (p.dashCharges > 0) {
      doDash(state, p, move);
      armRebate(p, "dash");
    }
    return;
  }
  // Blindside runs on charges too once Second Take is drafted (V2 §4.3) —
  // same shape as dash, so the recharge timer can tick with a charge banked.
  if (ability === "cutto") {
    const cp = cutToParams(p);
    const have = Math.min(p.cutCharges ?? cp.charges, cp.charges);
    if (have <= 0) return;
    doCutTo(state, p, aim);
    if ((p.cd.cutto ?? 0) > 0) armRebate(p, "cutto");
    return;
  }
  // The Barrage is a CHANNEL: pressing again mid-cast does nothing (and you
  // cannot swing while directing — that is the commitment being bought).
  if ((p.barrageT ?? 0) > 0 && ability !== "airstrike") return;
  if ((p.cd[ability] ?? 0) > 0) return;
  switch (ability) {
    case "melee": doPlayerAttack(state, p, aim, move); break;
    case "bolt": doBolt(state, p, aim); break;
    case "nova": doNova(state, p); break;
    case "stance": doStance(state, p, aim, move); break;
    case "overcharge": doOvercharge(state, p); break;
    case "orbit": doOrbitHurl(state, p, aim); break; // V2 R3: the ring is a PRESS
    case "crowdsurf": doCrowdSurf(state, p, aim); break;
    case "stuntdouble": doStuntDouble(state, p); break;
    case "bulwark": doBulwark(state, p); break;
    case "cables": doCables(state, p, aim); break;
    case "airstrike": doAirstrike(state, p, aim); break;
    case "cataclysm": doCataclysm(state, p); break;
    case "bullettime": doBulletTime(state, p); break;
    case "injunction": doInjunction(state, p); break;
  }
  // A cast that actually happened set its cooldown; the rebate window opens.
  if ((p.cd[ability] ?? 0) > 0) armRebate(p, ability);
}

// hasPassive lives in items.ts now (abilities.ts needs it too); re-exported
// so existing importers keep working.
export { hasPassive };

/**
 * THE DEBUT'S SAFETY NET (TUTORIAL.md — first-run mercy). Is this crawler
 * inside the one window where the game refuses to end their run?
 *
 * The window is deliberately the narrowest one that covers the measured
 * failure: FLOOR 1 of a world the host flagged as a fresh profile's FIRST run,
 * co-op only. It opens at second zero and closes the instant they take the
 * stairs — there is no counter to read, no step to finish, nothing a player
 * can be confused about, and nothing a competitive run can reach (a flagged
 * world is unrankable by header, and no other constructor sets the flag).
 */
export function firstRunMercyActive(state: GameState, p: Player): boolean {
  return !!state.firstRun && state.floor === 1 && state.mode !== "rivals" && !p.safeRoom;
}

/**
 * CUT TO COMMERCIAL: the killing blow a debut crawler does not die from.
 *
 * Hades' Tartarus and Diablo IV's prologue are unloseable by design, and this
 * is the same promise made in the System's idiom: the production does not let
 * the pilot end on a floor-1 wipe, it EDITS. What the crawler loses is real —
 * their position on the floor (they wake at the entrance, whatever they had
 * fought their way past is between them and the stairs again), most of their
 * bar, and every point of hype the fight had earned. What they keep is the
 * run. It is not a resource, it cannot be hoarded, and it cannot be reached on
 * floor 2, which is where the game starts meaning it.
 *
 * Pure: no RNG is drawn, so a mercied run replays byte-exactly.
 */
/**
 * ...AND THE THIRD ONE IS AN ESCORT (r11, the critic's severity-9 pair: "two of
 * four deaths were collapse-timer executions at full HP with zero wayfinding"
 * and "floor 1 is unloseable and also unleaveable — mercy has no escalation or
 * diagnosis").
 *
 * The edit above is unanswerable the first time and a shrug the third: waking a
 * crawler at the entrance is the RIGHT punishment for a fight they lost and the
 * WRONG answer for a floor they cannot find their way off, because it puts them
 * back at the start of the search that already beat them. Measured, that reads
 * as a room that will not kill you and will not let you leave — a worse session
 * than a death, which is the finding this round exists to answer.
 *
 * So the mercy notices. On the Nth save (`firstRunEscortSaves`) the production
 * stops re-staging the same scene: security walks the crawler to the stairs and
 * the show says so out loud. What it does NOT do is descend for them — the
 * descend key is the curriculum's verb and the player still presses it — and it
 * cannot leak past the debut, because every caller is already inside
 * `firstRunMercyActive` (a flagged world, floor 1, co-op, not in a safe room).
 * Pure: no RNG, one known position, so the run still replays byte-exactly.
 */
function firstRunKnockdown(state: GameState, p: Player): void {
  p.mercySaves = (p.mercySaves ?? 0) + 1;
  const escort = p.mercySaves >= CONFIG.firstRunEscortSaves;
  p.hp = Math.max(1, Math.round(p.maxHp * CONFIG.firstRunMercyHpFraction));
  p.statuses = [];
  p.knock = undefined;
  p.rootT = 0;
  p.reviveGraceT = CONFIG.firstRunMercyGraceSeconds;
  const to = escort ? state.map.stairs : state.map.spawn;
  p.pos = { x: to.x, y: to.y };
  p.hype = 0; // the crowd watched you fold; excitement is not free
  p.lowHpNow = false;
  if (escort) {
    // A ping is the game's existing "over THERE" verb (it pierces fog on both
    // the chart and the floor), so the exit is marked in the world as well as
    // named in the line — the crawler wakes standing in a gold ring.
    state.pings.push({
      id: state.nextEntityId++, pos: { x: to.x, y: to.y }, byId: p.id,
      t: CONFIG.pingTtl, total: CONFIG.pingTtl,
    });
    announce(state, "show",
      `${p.name} goes down again — and PRODUCTION HAS SEEN ENOUGH. `
      + "Security walks you to the stairwell on the network's dime. "
      + "You are standing on the way down. Take it.", "high");
    state.events.push(`${p.name} was escorted to the stairs by the debut edit.`);
    return;
  }
  announce(state, "show",
    `${p.name} goes down — and the broadcast CUTS TO COMMERCIAL. `
    + "Debut episode: the network does not air a floor-one funeral. "
    + "You wake at the entrance. The edit comes out of your hype.", "high");
  state.events.push(`${p.name} was saved by the debut edit (floor 1 only).`);
}

/** A player died; the run only ends when the whole party is down. */
export function handlePlayerDeath(state: GameState, p: Player, line: string): void {
  // THE DEBUT (TUTORIAL.md): every death in the game — monsters, hazards,
  // statuses, bombers, the collapsing floor — arrives HERE, which is why the
  // mercy sits here and not at any one of the twenty-odd call sites. A first
  // run cannot be failed out of floor 1; nothing else in the game changes.
  if (firstRunMercyActive(state, p)) {
    firstRunKnockdown(state, p);
    return;
  }
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
          // Court Order (V2 §2.3): bolts against UNALERTED monsters always
          // crit — the paperwork is served before the fight starts.
          const served = hasPassive(owner, "served") && (m.alertT ?? 0) <= 0 && m.windup <= 0;
          damageMonster(state, owner, m, pr.damage, {
            dir: normalize(pr.vel), knockback: CONFIG.boltKnockback,
            forceCrit: pr.crit || served || undefined, shatterPoise: pr.shatter, breaker: pr.breaker, school: pr.school,
            ability: pr.ability,
          });
          // ARC-SPLICE glyph: the hit arcs a fraction to the nearest other
          // enemy — one link, never a chain of chains (mirrors conduit).
          if (pr.ability && hasGlyph(owner, pr.ability, "arc_splice")) {
            let best: Monster | null = null;
            let bestD: number = CONFIG.conduitRadius;
            for (const o of state.monsters) {
              if (o === m || o.hp <= 0) continue;
              const d = dist(m.pos, o.pos);
              if (d <= bestD) { bestD = d; best = o; }
            }
            if (best) {
              hit(state, m.pos, 0, "chain", { to: best.pos });
              damageMonster(state, owner, best, pr.damage * CONFIG.glyphArcSpliceFrac, {
                allowCrit: false, school: pr.school, chained: true,
                dir: normalize({ x: best.pos.x - m.pos.x, y: best.pos.y - m.pos.y }),
              });
            }
          }
          // SPLITFANG glyph: the first impact forks the shot outward. Forks
          // never re-fork (and ricochet bounces never fork) — rule 4's
          // additive-behaviors line, with hitIds preventing re-hits.
          if (pr.ability && !pr.forked && !pr.bounced && hasGlyph(owner, pr.ability, "splitfang")) {
            const baseA = datan2(pr.vel.y, pr.vel.x);
            const speed = dhypot(pr.vel.x, pr.vel.y);
            for (let f = 0; f < CONFIG.glyphSplitfangCount; f++) {
              const a = baseA + (f === 0 ? -0.35 : 0.35);
              state.projectiles.push({
                id: state.nextEntityId++,
                pos: { x: pr.pos.x, y: pr.pos.y },
                vel: { x: dcos(a) * speed, y: dsin(a) * speed },
                damage: pr.damage * CONFIG.glyphSplitfangFrac,
                ttl: 0.8, from: "player", ownerId: owner.id,
                forked: true, hitIds: [m.id], school: pr.school, chill: pr.chill,
                ability: pr.ability,
              });
            }
          }
          // Frost Bolts (5.11): the impact CHILLS — move + attack/windup speed
          // slowed. Bosses shrug off half the slow (meaningful, never immune).
          if (pr.chill && m.hp > 0) {
            // (statusDuration: the Sump Crown stretches the WEARER's chill —
            // the boss unique reads at its one real source, not just venom.)
            applyStatus(m, {
              kind: "chill", duration: statusDuration(owner, CONFIG.chillDuration), school: "magic",
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
        if (damagePlayerHit(state, p, pr.damage, { dir: normalize(pr.vel), src: "shot" })) {
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
  state.bossEvents = []; // typed boss beats: same transient contract as hits
  state.killsThisStep = 0;
  state.escapedCollapse = false;
  for (const p of state.players) {
    p.killsThisStep = 0;
    p.lowHpKill = false;
  }
  if (state.status !== "playing") return state;

  const intents: PartyIntents =
    "move" in intent ? { [state.players[0]?.id ?? 0]: intent as Intent } : (intent as PartyIntents);

  // THE DEBUT'S FLOAT, SAID WHERE IT CAN BE HEARD (TUTORIAL.md: a line is
  // delivered when it PAINTS, not when something decides to say it). The gold
  // is granted in createGame — the HUD and the first save need it at second
  // zero — but the buffer above is cleared at the top of every frame, so a
  // construction-time announcement is deleted before any host drains it.
  if (state.firstRun && !state.firstRunFloatSaid) {
    state.firstRunFloatSaid = true;
    announce(state, "show",
      `PRODUCTION FLOAT: ${CONFIG.firstRunStipendGold} gold advanced against your first paycheck. `
      + "Spend it in the safe room. The System itemizes everything.");
  }

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
        if (damagePlayerHit(state, p, due.damage, { roll: false, effect: due.kind, src: "status:" + due.kind })) {
          handlePlayerDeath(state, p, due.kind === "poison"
            ? `${p.name} succumbed to the poison. The System sells antidotes, for the record.`
            : `${p.name} burned out of the season. Literally.`);
        }
      }
    }
    // THE DEBUT, as a property of the STATE rather than of call sites: a
    // damage source that drops a crawler to zero without routing its own
    // death (any caller that ignores damagePlayerHit's return) would otherwise
    // leave a floor-1 first-runner walking around at zero until something else
    // finished the job. Asked once per player per step, so "cannot be failed
    // out of floor 1" does not depend on twenty callers remembering.
    if (p.alive && p.hp <= 0 && firstRunMercyActive(state, p)) firstRunKnockdown(state, p);

    const ptime = statusTimeMult(p);

    // Near-death brush bookkeeping (r3): the "currently low" latch opens
    // again once the crawler climbs back over the line, so the next dip
    // counts as a NEW brush (damagePlayerHit sets it; the lowhp tip waits
    // for the second).
    if (p.lowHpNow && p.hp >= p.maxHp * CONFIG.show.lowHpFraction) p.lowHpNow = false;

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
    // The untouchable beat after a rivals revive — and after a DEBUT's cut to
    // commercial (firstRunKnockdown). Rivals ticks it in its own outer loop,
    // where downed racers are counted; co-op has no such loop, and a grace
    // that never decays is permanent invulnerability, so it decays HERE.
    if (state.mode !== "rivals" && (p.reviveGraceT ?? 0) > 0) {
      p.reviveGraceT = Math.max(0, (p.reviveGraceT ?? 0) - dt);
    }
    if (p.rootT > 0) p.rootT = Math.max(0, p.rootT - dt);
    if ((p.cursedT ?? 0) > 0) p.cursedT = Math.max(0, (p.cursedT ?? 0) - dt);
    if (p.novaFlash > 0) p.novaFlash = Math.max(0, p.novaFlash - dt);
    p.stanceTime += dt; // time-in-stance settles toward Discipline's threshold
    if (p.stanceSwapWindow > 0) p.stanceSwapWindow = Math.max(0, p.stanceSwapWindow - dt);
    // Blindside recharge (Second Take): charges bank exactly like dash's.
    {
      const maxCut = cutToParams(p).charges;
      if (p.cutCharges === undefined) p.cutCharges = maxCut;
      if (p.cutCharges < maxCut && (p.cd.cutto ?? 0) <= 0) {
        p.cutCharges++;
        if (p.cutCharges < maxCut) p.cd.cutto = cutToParams(p).cooldown * cdMult(p);
      }
    }
    // ABILITIES-V2 transients.
    updateBulwark(state, p, dt);
    updateInjunction(state, p, dt);
    // Glyph transients: the Slipstream surge and the Rebate kill window.
    if ((p.slipstreamT ?? 0) > 0) p.slipstreamT = Math.max(0, (p.slipstreamT ?? 0) - dt);
    if ((p.rebateT ?? 0) > 0) {
      p.rebateT = Math.max(0, (p.rebateT ?? 0) - dt);
      if (p.rebateT === 0) p.rebateBudget = 0; // the window closed; the budget dies with it
    }

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
      // While a swing is in flight (~0.15s) the body stays committed to the
      // attack aim — movement stealing facing back the very next tick made the
      // model whip cursor→run-dir→cursor on every swing (the "attack jitter").
      // Otherwise facing SWEEPS toward the feet at playerTurnRate: WASD only
      // offers 8 headings, but the sweep passes through (and key-mixing can
      // hold) every angle between them. Movement itself is never rate-limited.
      if (p.attackSwing <= 0) p.facing = turnToward(p.facing, dir, CONFIG.playerTurnRate * dt);
      // Root snare (boss roots zones): a heavy slow — dashing is unaffected.
      // Chill (ptime) and roots stack multiplicatively; both are escape tests.
      const slip = (p.slipstreamT ?? 0) > 0 ? CONFIG.glyphSlipstreamSpeedMult : 1; // Slipstream glyph surge
      // Directing the Barrage costs you your feet — 70% move speed and no
      // swinging. That commitment IS the ultimate (V2 U2).
      const chan = (p.barrageT ?? 0) > 0 ? CONFIG.barrageMoveMult : 1;
      const speed = p.speed * (p.frenzy ? CONFIG.frenzyMoveMult : 1) * ptime * slip * chan * (p.rootT > 0 ? CONFIG.rootsSlowMult : 1);
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
      updateBarrage(state, p, aim, dt); // the shells walk with the cursor
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
  for (const m of state.monsters) {
    // ---- ABILITIES-V2 monster-side timers ----
    if ((m.pinLockT ?? 0) > 0) m.pinLockT = Math.max(0, (m.pinLockT ?? 0) - mdt);
    if ((m.vulnT ?? 0) > 0) m.vulnT = Math.max(0, (m.vulnT ?? 0) - mdt);
    if ((m.injRageT ?? 0) > 0) m.injRageT = Math.max(0, (m.injRageT ?? 0) - mdt);
    if ((m.blindT ?? 0) > 0) {
      m.blindT = Math.max(0, (m.blindT ?? 0) - mdt);
      m.alertT = 0; // Smoke Break: it lost you
    }
    // INJUNCTION's enrage: the dungeon fights back for exactly as long as you
    // hold its clock. One dt multiplier moves BOTH halves of the promise —
    // move speed and windup speed — the same way bullet time and chill do.
    const rage = (m.injRageT ?? 0) > 0 ? 1 + CONFIG.injunctionEnrageSpeed : 1;
    // THE PIN (Stage Cables): a pinned body cannot MOVE or close, but it can
    // still finish a windup — the pin is control, Breaker is the stun. Holding
    // the position across the AI step is what enforces that without teaching
    // forty movement branches about a new field (and it is exactly why the
    // cables can never be a gather: nothing is relocated, only held).
    const pinned = (m.pinnedT ?? 0) > 0 || (m.blindT ?? 0) > 0;
    const held = pinned ? { x: m.pos.x, y: m.pos.y } : null;
    if ((m.pinnedT ?? 0) > 0) m.pinnedT = Math.max(0, (m.pinnedT ?? 0) - mdt);
    stepMonster(state, m, mdt * statusTimeMult(m) * rage);
    if (held) { m.pos.x = held.x; m.pos.y = held.y; }
  }
  separateMonsters(state, mdt); // pack presence: bodies take up space (AI tier 1)
  updateMonsterStatuses(state, mdt); // DoT burns on WORLD time (chill can't slow its own poison)
  arenaDirector(state, mdt); // boss layer 3: the ROOM fights on its own rhythm
  updateHazards(state, mdt); // enemy-side blasts run on world (slowable) time
  updateCorpses(state, mdt);
  updateStrikes(state, dt);
  updateDecoys(state, dt);
  updateProjectiles(state, dt);

  reapDead(state);
  collectLoot(state);
  updatePings(state, dt);
  updateRevives(state, dt);

  // Roam upkeep: beacon lighting by proximity + dialogue auto-close when the
  // crawler walks off mid-sentence. Early-outs on Race floors.
  updateRoam(state);

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
        // Roam only: the same interact key talks to the nearest settlement
        // resident in range, instead of trying the stairs — NPCs and stairs
        // are never in proximity range at once, so no new Intent field is
        // needed. Opens a dialogue session (state.dialogue); hosts render it
        // and answer through chooseDialogue/closeDialogue.
        if (state.runKind === "roam") {
          let talk: Npc | null = null;
          let talkD = 1.6;
          for (const n of npcsOf(state)) {
            const d = dist(p.pos, n.pos);
            if (d <= talkD) { talkD = d; talk = n; }
          }
          if (talk) {
            startDialogue(state, p, talk);
            continue;
          }
        }
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
  "monsters", "loot", "projectiles", "strikes", "bulletTimeLeft", "decoys", "breakables",
  "hazards", "corpses", "pings", "encounter", "floorEvent", "goldSurge", "glyphsDroppedThisFloor",
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
  // A shopper still anchors their CURRENT floor: floorNo doesn't advance until
  // they leave the safe room, and their client renders (and the server
  // serializes) that world behind the shop every snapshot. Counting them as
  // already on nextFloor deleted the last world under a solo rival and
  // crashed the server.
  const lowest = Math.min(...roster.map((p) => p.floorNo));
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
  p.pos = { x: w.map.spawn.x + dcos(a) * 0.5, y: w.map.spawn.y + dsin(a) * 0.5 };
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

/**
 * DEATH IS A DOOR (NICHE.md 4.7): the second door on the rivals death screen.
 * Valid only while DOWNED in a rivals race — concede is the choice the
 * 15-second clock exists to frame, not a mid-fight ragequit verb. Terminal:
 * the revive timer stops, the crawler stays down, and the race stops waiting
 * for them (their superlative is still computed at race end — leaving early
 * costs nothing). If every seat has conceded, the dungeon takes the race.
 * A sim rule, so the server and every client agree about who is still racing.
 */
export function concedeRival(state: GameState, playerId: number): boolean {
  if (state.mode !== "rivals" || state.status !== "playing") return false;
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || p.alive || p.conceded) return false;
  p.conceded = true;
  p.downedT = 0;
  p.reviveProgress = 0;
  announce(state, "progress", `${p.name} CONCEDES. The System respects the math, if not the spirit.`);
  if (state.players.every((pl) => pl.conceded)) {
    state.status = "dead";
    announce(state, "progress", "EVERY CONTRACT CONCEDED. The dungeon takes the race by forfeit. It is not gracious about it.", "high");
  }
  return true;
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
  const dead = damagePlayerHit(state, victim, base * CONFIG.pvpDamageMult, { dir, src: "crawler" });
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
    const firstEver = p.achievements.length === 0;
    // Big moments (boss kills, level bursts) unlock several at once — collect
    // them and announce one combined line so the toast layer isn't flooded.
    const unlocked: (typeof ACHIEVEMENTS)[number][] = [];
    for (const a of ACHIEVEMENTS) {
      if (p.achievements.includes(a.id)) continue;
      if (!a.test(state, p)) continue;
      p.achievements.push(a.id);
      p.gold += a.gold;
      if (a.hype > 0) addHype(state, p, a.hype);
      (p.unclaimedAchievements ??= []).push(a.id);
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
    if (firstEver && unlocked.length > 0) systemTip(state, p, "achievementClaim");
  }
}

/** Claim one player's achievement-earned loot box: verifies, opens, pays out. */
export function claimAchievementLootBox(state: GameState, playerId: number, achievementId: string): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p) return;
  const idx = (p.unclaimedAchievements ?? []).indexOf(achievementId);
  if (idx < 0) return;
  p.unclaimedAchievements!.splice(idx, 1);
  openLootBox(state, p);
}

/**
 * Mark tiles within the given crawlers' vision radius as explored. Pure grid
 * math, exported because net clients maintain fog LOCALLY: recurring wire
 * snapshots stopped shipping the (huge, monotonic) mask — see snapshot.ts.
 */
export function revealExplored(
  map: { w: number; h: number }, explored: Uint8Array,
  players: readonly { alive: boolean; pos: Vec2 }[],
): boolean {
  const r = CONFIG.fogVisionRadius;
  const r2 = r * r;
  let changed = false;
  for (const player of players) {
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
  return changed;
}

/** Mark tiles within any living player's vision radius as explored (shared fog). */
function revealAround(state: GameState): void {
  if (revealExplored(state.map, state.explored, state.players)) state.exploredVersion++;
}
