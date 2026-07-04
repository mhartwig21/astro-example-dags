import { CONFIG } from "./config";
import { rollBounds } from "./combat";
import {
  ABILITY_INFO, boltParams, damageVariance, dashParams, meleeParams, novaParams,
  orbitParams, overchargeParams, power, rank,
  type AbilityId, type School,
} from "./abilities";
import { hasPassive, playerMitigation } from "./game";
import { weaponClassOf, type WeaponClass } from "./items";
import type { GameState, Player } from "./types";

// The character sheet as DATA (DESIGN: sim is pure, hosts render). Every number
// here is derived from the same param functions combat actually calls —
// rollBounds/damageVariance for the dice, armorReduction for mitigation — so
// the sheet can never drift from the fight. Estimates deliberately show BASE
// numbers: situational multipliers (stance, overcharge, execute, frenzy) are
// listed as notes, not folded in, so the ranges match an ordinary hit.

/** One damage estimate: the roll bounds of a single hit and what it sustains. */
export interface SheetHit {
  min: number; // one hit's low roll
  max: number; // one hit's high roll
  critMin: number;
  critMax: number;
  count: number; // hits per use (bolts in the fan, shells in the strike, 1 otherwise)
  cooldown: number; // seconds between uses (ticks for orbit)
  dps: number; // sustained estimate: avg roll * count * crit factor / cooldown
}

export interface SheetAbilityRow {
  id: AbilityId;
  name: string;
  school: School;
  ultimate: boolean;
  hit?: SheetHit; // absent = pure utility (stance, bullet time...)
  note: string; // one line of mechanics: "×3 bolts", "blink 3.2 tiles, 2 charges"
}

export interface CharacterSheet {
  identity: {
    name: string;
    level: number;
    xp: number;
    xpToNext: number;
    gold: number;
    floor: number;
    weaponName: string; // "Bare Hands" when nothing equipped
    weaponClass: WeaponClass | null;
    variance: number; // the weapon's dice, e.g. 0.3 = every hit rolls ±30%
  };
  attributes: {
    attackPower: number;
    spellPower: number;
    critChance: number;
    critMult: number;
    speed: number;
    armor: number;
    maxHp: number;
    hp: number;
  };
  offense: SheetAbilityRow[]; // slotted actives in slot order, then the ultimate
  defense: {
    armor: number;
    reduction: number; // 0..armorMaxReduction
    reductionCap: number;
    armorK: number; // for the "how it works" tooltip
    effectiveHp: number; // maxHp scaled by mitigation
    exampleRaw: number; // a typical monster hit on the CURRENT floor...
    exampleTaken: number; // ...and what actually lands after armor
    dashCharges: number;
  };
  show: {
    viewers: number;
    favorites: number;
    sponsors: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
  };
}

/** Crit bounds mirror combat's order of operations: roll first, then ×critMult. */
function makeHit(p: Player, base: number, cooldown: number, count = 1): SheetHit {
  const v = damageVariance(p);
  const { min, max } = rollBounds(base, v);
  const critFactor = 1 + p.critChance * (CONFIG.playerCritMult - 1);
  const avg = (min + max) / 2;
  return {
    min, max,
    critMin: Math.round(min * CONFIG.playerCritMult),
    critMax: Math.round(max * CONFIG.playerCritMult),
    count,
    cooldown,
    dps: cooldown > 0 ? (avg * count * critFactor) / cooldown : 0,
  };
}

function abilityRow(p: Player, id: AbilityId): SheetAbilityRow {
  const info = ABILITY_INFO[id];
  const base = { id, name: info.name, ultimate: info.tier === "ultimate" };
  const overtime = hasPassive(p, "overtime") ? 0.75 : 1;
  switch (id) {
    case "melee": {
      const mp = meleeParams(p);
      return {
        ...base, school: "physical",
        hit: makeHit(p, power(p, "melee") * mp.damageMult, mp.cooldown),
        note: `${mp.range.toFixed(1)}-tile arc${rank(p, "melee.execute") > 0 ? " · +60% below 30% HP" : ""}`,
      };
    }
    case "bolt": {
      const bp = boltParams(p);
      return {
        ...base, school: bp.school,
        hit: makeHit(p, bp.dmg, bp.cooldown, bp.count),
        note: `${bp.count > 1 ? `×${bp.count} fan · ` : ""}${bp.pierce > 0 ? `pierces ${bp.pierce} · ` : ""}per bolt`,
      };
    }
    case "nova": {
      const np = novaParams(p);
      return {
        ...base, school: "magic",
        hit: makeHit(p, power(p, "nova") * np.damageMult, np.cooldown),
        note: `${np.radius.toFixed(1)}-tile shockwave${rank(p, "nova.implode") > 0 ? " · drags enemies in" : ""}`,
      };
    }
    case "dash": {
      const dp = dashParams(p);
      const detonates = hasPassive(p, "blastplate") || rank(p, "dash.after") > 0;
      const note = `blink ${dp.distance.toFixed(1)} tiles · i-frames · ${CONFIG.dashCharges} charges`;
      // Strongest component: shockstep path (power × rank mult) vs a full-power
      // detonation (Aftershock capstone / Blastplate Harness).
      const burst = Math.max(dp.shockMult, detonates ? 1 : 0);
      if (burst <= 0) return { ...base, school: "magic", note };
      return {
        ...base, school: "magic",
        hit: makeHit(p, power(p, "dash") * burst, dp.cooldown),
        note: `${note} · detonates`,
      };
    }
    case "orbit": {
      const op = orbitParams(p);
      return {
        ...base, school: "physical",
        hit: makeHit(p, power(p, "orbit") * op.damageMult, CONFIG.orbitTickSeconds),
        note: `${op.blades} blades · per touch, every ${CONFIG.orbitTickSeconds}s`,
      };
    }
    case "stance": {
      const right = (CONFIG.stanceRightMult + rank(p, "stance.edge") * 0.08) * 100 - 100;
      return {
        ...base, school: "physical",
        note: `${p.stance === "melee" ? "BRAWLER" : "DEADEYE"} · matching +${Math.round(right)}% / off ${Math.round(CONFIG.stanceWrongMult * 100 - 100)}%`,
      };
    }
    case "overcharge": {
      const oc = overchargeParams(p);
      return { ...base, school: "physical", note: `next attack ×${oc.mult.toFixed(2)}${oc.shatter ? " · shatters poise" : ""}` };
    }
    case "airstrike":
      return {
        ...base, school: "physical",
        hit: makeHit(p, power(p, "airstrike") * CONFIG.ultAirstrikeDmgMult, CONFIG.ultAirstrikeCooldown * overtime, CONFIG.ultAirstrikeShells),
        note: `${CONFIG.ultAirstrikeShells} shells · per shell`,
      };
    case "cataclysm":
      return {
        ...base, school: "magic",
        hit: makeHit(p, power(p, "cataclysm") * CONFIG.ultCataclysmDmgMult, CONFIG.ultCataclysmCooldown * overtime),
        note: `${CONFIG.ultCataclysmRadius}-tile blast · hurls enemies back`,
      };
    case "bullettime":
      return {
        ...base, school: "magic",
        note: `world at ${Math.round(CONFIG.ultBulletTimeFactor * 100)}% speed for ${CONFIG.ultBulletTimeDuration}s`,
      };
  }
}

/** A typical (unrolled) monster swing on this floor — the defense example. */
function typicalFloorHit(state: GameState): number {
  return Math.round(CONFIG.monsterBaseDamage + (state.floor - 1) * CONFIG.monsterDamagePerFloor);
}

/**
 * Everything the Crawler Profile panel prints, straight from the combat math.
 * Pure: no RNG draws, no mutation — safe to call every render frame.
 */
export function buildCharacterSheet(state: GameState, p: Player): CharacterSheet {
  const weapon = p.equipment.weapon;
  const reduction = playerMitigation(p);
  const raw = typicalFloorHit(state);
  const offense: SheetAbilityRow[] = [];
  for (const id of p.abilities.slots) {
    if (id) offense.push(abilityRow(p, id));
  }
  if (p.abilities.ultimate) offense.push(abilityRow(p, p.abilities.ultimate));
  return {
    identity: {
      name: p.name,
      level: p.level,
      xp: p.xp,
      xpToNext: p.xpToNext,
      gold: p.gold,
      floor: state.floor,
      weaponName: weapon?.name ?? "Bare Hands",
      weaponClass: weaponClassOf(weapon),
      variance: damageVariance(p),
    },
    attributes: {
      attackPower: p.attackPower,
      spellPower: p.spellPower,
      critChance: p.critChance,
      critMult: CONFIG.playerCritMult,
      speed: p.speed,
      armor: p.armor,
      maxHp: p.maxHp,
      hp: p.hp,
    },
    offense,
    defense: {
      armor: p.armor,
      reduction,
      reductionCap: CONFIG.armorMaxReduction,
      armorK: CONFIG.armorK,
      effectiveHp: Math.round(p.maxHp / (1 - reduction)),
      exampleRaw: raw,
      exampleTaken: Math.max(1, Math.round(raw * (1 - reduction))),
      dashCharges: CONFIG.dashCharges,
    },
    show: {
      viewers: Math.round(p.viewers),
      favorites: Math.floor(p.favorites),
      sponsors: p.sponsors,
      kills: p.kills,
      damageDealt: Math.round(p.damageDealt),
      damageTaken: Math.round(p.damageTaken),
    },
  };
}
