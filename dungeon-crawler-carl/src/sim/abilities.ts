import { CONFIG } from "./config";
import { hasPassive, weaponClassOf } from "./items";
import { chance, nextInt, pick, type Rng } from "./rng";
import type { Player } from "./types";

// Ability system (DESIGN.md 5.7 "The Five"): a build is exactly 4 active slots
// + 1 ultimate slot. Abilities are tagged by tier; discovering one auto-slots it
// if a matching slot is open, otherwise it goes to the BENCH; rearranging the
// loadout is a safe-room decision (slotAbility/setUltimate in game.ts). Upgrade
// drafts offer ranks only for SLOTTED abilities. Everything derives from
// Player.abilities, so numbers stay pure/deterministic/serializable.
//
// Adding a new ability = one entry here (+ its cast/passive behavior in
// game.ts's castAbility switch) — the loadout, drafts, tomes, HUD, and net
// protocol all pick it up from this registry.

export type AbilityId =
  | "melee" | "dash" | "bolt" | "nova" | "orbit" | "stance" | "overcharge"
  | "airstrike" | "cataclysm" | "bullettime";

// Battle Stance: which attack TYPE the crawler currently favors. Melee swings
// and orbit blades are melee-type; bolts are ranged-type; everything else is
// stance-neutral. Extensible — a third stance is a union member away.
export type StanceId = "melee" | "ranged";

// Damage schools (DESIGN 5.8). Orthogonal to stance: stance judges RANGE,
// school decides which power stat feeds the hit (and, later, what resists it).
export type School = "physical" | "magic";

/**
 * School routing per ability: weights applied to attackPower/spellPower.
 * Magnitude coefficients stay in CONFIG (novaDamageMult etc.) — this table only
 * says WHICH stat an ability eats. Hybrids are both keys nonzero. Bolt is the
 * one deliberate absentee: its school comes from the equipped WEAPON
 * (boltParams) — a crossbow throws bolts, a staff throws magic missiles.
 */
export const SCALING: Partial<Record<AbilityId, { ap?: number; sp?: number }>> = {
  melee: { ap: 1 },
  orbit: { ap: 1 },
  airstrike: { ap: 1 }, // sponsor ordnance is extremely physical
  dash: { sp: 1 }, // shockstep/aftershock detonations are arcane
  nova: { sp: 1 },
  cataclysm: { sp: 1 },
};

/** The power an ability scales from (defaults to physical for the untabled). */
export function power(p: Player, ability: AbilityId): number {
  const s = SCALING[ability] ?? { ap: 1 };
  return p.attackPower * (s.ap ?? 0) + p.spellPower * (s.sp ?? 0);
}

/** Dominant school of an ability's damage (hit tinting + future resists). */
export function abilitySchool(ability: AbilityId): School {
  const s = SCALING[ability] ?? { ap: 1 };
  return (s.sp ?? 0) > (s.ap ?? 0) ? "magic" : "physical";
}

/**
 * The player's damage-roll variance: the equipped WEAPON sets the dice for
 * every hit they land (swift ±10% metronome … chaotic ±40% slot machine).
 * Bare hands roll the default. The character sheet prints these same bounds.
 */
export function damageVariance(p: Player): number {
  const wc = weaponClassOf(p.equipment.weapon);
  return (wc && CONFIG.weaponVariance[wc]) || 0.15;
}

export type AbilityTier = "active" | "ultimate";

export const ABILITY_SLOTS = 4; // active slots (the ultimate has its own slot)

/** Abilities every crawler starts with (slotted 0..2; slot 3 + ultimate empty). */
export const STARTING_ABILITIES: AbilityId[] = ["melee", "dash", "bolt"];
/** Abilities that must be discovered (tomes/boxes/shop) before they can slot. */
export const DISCOVERABLE_ABILITIES: AbilityId[] = [
  "nova", "orbit", "stance", "overcharge", "airstrike", "cataclysm", "bullettime",
];

export const ABILITY_INFO: Record<AbilityId, { name: string; blurb: string; tier: AbilityTier; passive?: boolean }> = {
  melee: { name: "Melee", blurb: "Your trusty swing", tier: "active" },
  dash: { name: "Dash", blurb: "Blink with i-frames", tier: "active" },
  bolt: { name: "Bolt", blurb: "Ranged projectile", tier: "active" },
  nova: { name: "Nova", blurb: "Radial shockwave", tier: "active" },
  orbit: { name: "Orbit", blurb: "Auto blades circle you", tier: "active", passive: true },
  stance: { name: "Battle Stance", blurb: "Toggle Brawler/Deadeye: matching attacks hit harder, mismatched softer", tier: "active" },
  overcharge: { name: "Overcharge", blurb: "Bank power: your next attack hits much harder", tier: "active" },
  airstrike: { name: "Sponsor Airstrike", blurb: "Your sponsors deliver ordnance at the cursor", tier: "ultimate" },
  cataclysm: { name: "Cataclysm", blurb: "A floor-shaking blast that hurls enemies back", tier: "ultimate" },
  bullettime: { name: "Bullet Time", blurb: "The world slows; you do not", tier: "ultimate" },
};

export interface UpgradeDef {
  id: string; // "bolt.split"
  ability: AbilityId;
  title: string;
  maxRank: number;
  /** Overrank headroom: chase-able ranks past maxRank that only ever appear
   * through the draft lottery (rollUpgradeDraft) — never guaranteed. */
  over?: number;
  /** Human description of what the NEXT rank grants. */
  desc: (nextRank: number) => string;
  /** Node ids that must all hold rank > 0 before this node can be offered. */
  requires?: string[];
  /** Fork exclusivity: holding rank in any of these locks THIS node (and vice versa). */
  excludes?: string[];
  /** Hand-authored constellation position (0-100 space) for the T-panel graph. */
  pos: { x: number; y: number };
  /** Capstone: a build-defining behavior change, not a number (drawn as a diamond). */
  capstone?: boolean;
}

// Each ability's nodes form a small constellation: an entry node, an exclusive
// FORK (pick a side — that choice is the build), and a CAPSTONE that changes
// behavior rather than numbers. Level-up drafts (Hades) roll from what the
// graph says is reachable (PoE): requires gate, excludes lock the road not taken.
//
// `over` is each node's OVERRANK headroom: ranks past the printed max that only
// the draft lottery can offer (backlog #7 — OP builds exist, but hitting one is
// a run-to-run chase, not a guarantee). Cooldown nodes get 1 (they compound the
// hardest); other numeric nodes get 2; capstones are behavior bits and get none.
export const UPGRADES: UpgradeDef[] = [
  // Melee: arc -> (heavy XOR swift) -> Executioner
  { id: "melee.arc", ability: "melee", title: "Wide Arc", maxRank: 2, over: 2, desc: (r) => `Swing arc +${r * 22}°`, pos: { x: 50, y: 12 } },
  // The fork sides carry an IDENTITY, not just a number: Heavy's killing
  // swings splash their overkill, Swift's connecting swings stack momentum.
  { id: "melee.heavy", ability: "melee", title: "Heavy Blows", maxRank: 3, over: 2, desc: (r) => `Melee damage +${r * 20}%${r === 1 ? "; killing-swing overkill splashes nearby" : ""}`, requires: ["melee.arc"], excludes: ["melee.swift"], pos: { x: 22, y: 48 } },
  { id: "melee.swift", ability: "melee", title: "Swift Strikes", maxRank: 3, over: 1, desc: (r) => `Melee cooldown -${r * 12}%; momentum stacks to +${r * CONFIG.meleeMomentumStacksPerRank * Math.round(CONFIG.meleeMomentumPerStack * 100)}%`, requires: ["melee.arc"], excludes: ["melee.heavy"], pos: { x: 78, y: 48 } },
  { id: "melee.execute", ability: "melee", title: "EXECUTIONER", maxRank: 1, desc: () => "Melee deals +60% to enemies below 30% HP", requires: ["melee.arc"], capstone: true, pos: { x: 50, y: 86 } },
  // Dash: (quick XOR blink) -> shock -> Aftershock
  { id: "dash.quick", ability: "dash", title: "Quickstep", maxRank: 3, over: 1, desc: (r) => `Dash cooldown -${r * 18}%`, excludes: ["dash.blink"], pos: { x: 22, y: 14 } },
  { id: "dash.blink", ability: "dash", title: "Long Blink", maxRank: 2, over: 2, desc: (r) => `Dash distance +${r * 30}%`, excludes: ["dash.quick"], pos: { x: 78, y: 14 } },
  { id: "dash.shock", ability: "dash", title: "Shockstep", maxRank: 3, over: 2, desc: (r) => `Arrival burst: ${r * 50}% damage nearby`, pos: { x: 50, y: 50 } },
  { id: "dash.after", ability: "dash", title: "AFTERSHOCK", maxRank: 1, desc: () => "Your dash also detonates at the arrival point", requires: ["dash.shock"], capstone: true, pos: { x: 50, y: 86 } },
  // Bolt: rapid -> (split XOR pierce) -> Ricochet
  { id: "bolt.rapid", ability: "bolt", title: "Rapid Bolts", maxRank: 3, over: 1, desc: (r) => `Bolt cooldown -${r * 15}%`, pos: { x: 50, y: 12 } },
  { id: "bolt.split", ability: "bolt", title: "Split Shot", maxRank: 2, over: 2, desc: (r) => `Fire ${1 + r} bolts in a fan`, requires: ["bolt.rapid"], excludes: ["bolt.pierce"], pos: { x: 22, y: 48 } },
  { id: "bolt.pierce", ability: "bolt", title: "Piercing Bolts", maxRank: 2, over: 2, desc: (r) => `Bolts pierce ${r} extra ${r === 1 ? "enemy" : "enemies"}`, requires: ["bolt.rapid"], excludes: ["bolt.split"], pos: { x: 78, y: 48 } },
  // Status rider (5.11): a single behavior rank beside the split/pierce fork
  // (not inside it — any bolt build can run cold). One rank keeps the draft
  // pool lean; the overrank lottery can push the slow deeper.
  { id: "bolt.frost", ability: "bolt", title: "Frost Bolts", maxRank: 1, over: 1, desc: (r) => `Bolts CHILL: −${Math.round(Math.min(CONFIG.chillSlowMax, r * CONFIG.chillSlowPerRank) * 100)}% move & attack speed for ${CONFIG.chillDuration}s`, requires: ["bolt.rapid"], pos: { x: 50, y: 52 } },
  { id: "bolt.ricochet", ability: "bolt", title: "RICOCHET", maxRank: 1, desc: () => "Bolts bounce to a nearby enemy on hit (60% damage)", requires: ["bolt.rapid"], capstone: true, pos: { x: 50, y: 86 } },
  // Nova: bang -> (after XOR conc) -> Implosion
  { id: "nova.bang", ability: "nova", title: "Bigger Bang", maxRank: 2, over: 2, desc: (r) => `Nova radius +${r * 25}%`, pos: { x: 50, y: 12 } },
  { id: "nova.after", ability: "nova", title: "Aftershock", maxRank: 3, over: 1, desc: (r) => `Nova cooldown -${r * 15}%`, requires: ["nova.bang"], excludes: ["nova.conc"], pos: { x: 22, y: 48 } },
  { id: "nova.conc", ability: "nova", title: "Concussive", maxRank: 3, over: 2, desc: (r) => `Nova damage +${r * 30}%`, requires: ["nova.bang"], excludes: ["nova.after"], pos: { x: 78, y: 48 } },
  // Status rider (5.11): one behavior rank beside the after/conc fork —
  // either side can burn; overranks stoke it hotter.
  { id: "nova.scorch", ability: "nova", title: "Afterburn", maxRank: 1, over: 1, desc: (r) => `Nova IGNITES: burn for ${Math.round(r * CONFIG.novaScorchFracPerRank * 100)}% of its damage over ${CONFIG.burnDuration}s`, requires: ["nova.bang"], pos: { x: 50, y: 52 } },
  { id: "nova.implode", ability: "nova", title: "IMPLOSION", maxRank: 1, desc: () => "Nova first drags everything in range toward you", requires: ["nova.bang"], capstone: true, pos: { x: 50, y: 86 } },
  // Stance: edge -> (discipline XOR flow) -> a capstone per side. The fork IS
  // the playstyle question: plant your feet in one stance, or dance between them.
  { id: "stance.edge", ability: "stance", title: "Honed Edge", maxRank: 2, over: 2, desc: (r) => `Matching-stance damage +${r * 8}%`, pos: { x: 50, y: 12 } },
  { id: "stance.discipline", ability: "stance", title: "Discipline", maxRank: 3, over: 2, desc: (r) => `Settled (${CONFIG.stanceSettleSeconds}s+ in one stance): matching damage +${r * 10}%`, requires: ["stance.edge"], excludes: ["stance.flow"], pos: { x: 22, y: 48 } },
  { id: "stance.flow", ability: "stance", title: "Flow", maxRank: 3, over: 2, desc: (r) => `For ${CONFIG.stanceSurgeSeconds}s after a swap: matching damage +${r * 15}%`, requires: ["stance.edge"], excludes: ["stance.discipline"], pos: { x: 78, y: 48 } },
  { id: "stance.perfect", ability: "stance", title: "PERFECT FORM", maxRank: 1, desc: () => "While settled, BOTH attack types count as matching", requires: ["stance.discipline"], capstone: true, pos: { x: 22, y: 86 } },
  { id: "stance.moment", ability: "stance", title: "MOMENTUM", maxRank: 1, desc: () => "Swapping stances primes a guaranteed crit on your next matching attack", requires: ["stance.flow"], capstone: true, pos: { x: 78, y: 86 } },
  // Overcharge: surge -> (volley XOR echo) -> System Shock. The fork picks
  // WHICH attack the banked power is built around: bolt volleys or swings.
  { id: "overcharge.surge", ability: "overcharge", title: "Surge", maxRank: 3, over: 2, desc: (r) => `Overcharged damage bonus +${r * 25}%`, pos: { x: 50, y: 12 } },
  { id: "overcharge.volley", ability: "overcharge", title: "Overcharged Volley", maxRank: 2, over: 1, desc: (r) => `Overcharged bolt casts fire ${r} extra bolt${r === 1 ? "" : "s"}`, requires: ["overcharge.surge"], excludes: ["overcharge.echo"], pos: { x: 22, y: 48 } },
  { id: "overcharge.echo", ability: "overcharge", title: "Echo Strike", maxRank: 2, over: 1, desc: (r) => `Overcharged swings strike twice (echo at ${r * 40}% damage)`, requires: ["overcharge.surge"], excludes: ["overcharge.volley"], pos: { x: 78, y: 48 } },
  { id: "overcharge.shock", ability: "overcharge", title: "SYSTEM SHOCK", maxRank: 1, desc: () => "Overcharged hits shatter poise — non-boss enemies stagger instantly", requires: ["overcharge.surge"], capstone: true, pos: { x: 50, y: 86 } },
  // Orbit: blade -> (razor XOR corkscrew) -> GUILLOTINE. The fork is the
  // build question: a close-in grinder or a whirling every-range sweeper.
  { id: "orbit.blade", ability: "orbit", title: "Extra Blade", maxRank: 2, over: 2, desc: (r) => `${CONFIG.orbitBladesBase + r} orbiting blades`, pos: { x: 50, y: 14 } },
  { id: "orbit.razor", ability: "orbit", title: "Razor's Edge", maxRank: 3, over: 2, desc: (r) => `Blade damage +${r * 35}%`, requires: ["orbit.blade"], excludes: ["orbit.wide"], pos: { x: 25, y: 48 } },
  {
    id: "orbit.wide", ability: "orbit", title: "Corkscrew", maxRank: 2, over: 1,
    desc: (r) => `Blades spiral ${CONFIG.orbitSpiralInner}–${(CONFIG.orbitRadius + CONFIG.orbitSpiralPerRank * r).toFixed(1)} tiles, sweeping every range`,
    requires: ["orbit.blade"], excludes: ["orbit.razor"], pos: { x: 75, y: 48 },
  },
  { id: "orbit.guillotine", ability: "orbit", title: "GUILLOTINE", maxRank: 1, desc: () => `Blades CANCEL non-elites below ${Math.round(CONFIG.orbitGuillotineThreshold * 100)}% HP`, requires: ["orbit.blade"], capstone: true, pos: { x: 50, y: 86 } },
  // Sponsor Airstrike: payload -> (saturation XOR precision) -> SPONSOR LOYALTY
  { id: "air.payload", ability: "airstrike", title: "Bigger Payload", maxRank: 2, over: 2, desc: (r) => `Shell damage +${Math.round(r * CONFIG.ultAirstrikePayloadDmg * 100)}%`, pos: { x: 50, y: 12 } },
  { id: "air.saturation", ability: "airstrike", title: "Saturation Barrage", maxRank: 2, over: 1, desc: (r) => `+${r * CONFIG.ultAirstrikeSaturationShells} shells, wider scatter`, requires: ["air.payload"], excludes: ["air.precision"], pos: { x: 22, y: 48 } },
  { id: "air.precision", ability: "airstrike", title: "Precision Strike", maxRank: 2, over: 1, desc: (r) => `Shell scatter -${Math.round(r * CONFIG.ultAirstrikePrecisionSpread * 100)}%`, requires: ["air.payload"], excludes: ["air.saturation"], pos: { x: 78, y: 48 } },
  { id: "air.loyalty", ability: "airstrike", title: "SPONSOR LOYALTY", maxRank: 1, desc: () => `Every barrage kill refunds ${Math.round(CONFIG.ultAirstrikeLoyaltyRefund * 100)}% of the cooldown`, requires: ["air.payload"], capstone: true, pos: { x: 50, y: 86 } },
  // Cataclysm: epicenter -> (aftermath XOR upheaval) -> EXTINCTION EVENT
  { id: "cata.epicenter", ability: "cataclysm", title: "Epicenter", maxRank: 2, over: 2, desc: (r) => `Cataclysm radius +${Math.round(r * CONFIG.ultCataclysmEpicenterRadius * 100)}%`, pos: { x: 50, y: 12 } },
  { id: "cata.aftermath", ability: "cataclysm", title: "Aftermath", maxRank: 2, over: 1, desc: (r) => `An echo shock ${CONFIG.ultCataclysmAftermathDelay}s later at ${Math.round((CONFIG.ultCataclysmAftermathBase + r * CONFIG.ultCataclysmAftermathPerRank) * 100)}% power`, requires: ["cata.epicenter"], excludes: ["cata.upheaval"], pos: { x: 22, y: 48 } },
  { id: "cata.upheaval", ability: "cataclysm", title: "Upheaval", maxRank: 2, over: 1, desc: (r) => `Hurl +${Math.round(r * CONFIG.ultCataclysmUpheavalKnock * 100)}%; the blast crushes poise`, requires: ["cata.epicenter"], excludes: ["cata.aftermath"], pos: { x: 78, y: 48 } },
  { id: "cata.extinction", ability: "cataclysm", title: "EXTINCTION EVENT", maxRank: 1, desc: () => "Enemies killed by Cataclysm DETONATE, chaining the blast outward", requires: ["cata.epicenter"], capstone: true, pos: { x: 50, y: 86 } },
  // Bullet Time: focus -> (adrenaline XOR dead eye) -> ENCORE
  { id: "bt.focus", ability: "bullettime", title: "Deep Focus", maxRank: 2, over: 2, desc: (r) => `Bullet time lasts +${r * CONFIG.ultBulletTimeFocusSeconds}s`, pos: { x: 50, y: 12 } },
  { id: "bt.adrenaline", ability: "bullettime", title: "Adrenaline", maxRank: 2, over: 1, desc: (r) => `YOUR cooldowns tick ${Math.round(r * CONFIG.ultBulletTimeAdrenaline * 100)}% faster inside`, requires: ["bt.focus"], excludes: ["bt.deadeye"], pos: { x: 22, y: 48 } },
  { id: "bt.deadeye", ability: "bullettime", title: "Dead Eye", maxRank: 2, over: 1, desc: (r) => `+${Math.round(r * CONFIG.ultBulletTimeDeadeyeCrit * 100)}% crit chance inside`, requires: ["bt.focus"], excludes: ["bt.adrenaline"], pos: { x: 78, y: 48 } },
  { id: "bt.encore", ability: "bullettime", title: "ENCORE", maxRank: 1, desc: () => `Kills inside extend bullet time ${CONFIG.ultBulletTimeEncoreExtend}s. The show must go on.`, requires: ["bt.focus"], capstone: true, pos: { x: 50, y: 86 } },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgradeDef(id: string): UpgradeDef | undefined {
  return BY_ID.get(id);
}

export function rank(p: Player, id: string): number {
  return p.abilities.ranks[id] ?? 0;
}

/** Known = anywhere in the loadout: a slot, the ultimate slot, or the bench. */
export function knows(p: Player, ability: AbilityId): boolean {
  return (
    p.abilities.slots.includes(ability) ||
    p.abilities.ultimate === ability ||
    p.abilities.bench.includes(ability)
  );
}

/** Slotted = currently castable (drafts and the cast path read this). */
export function slotted(p: Player, ability: AbilityId): boolean {
  return p.abilities.slots.includes(ability) || p.abilities.ultimate === ability;
}

/** Abilities not yet discovered (tomes can drop for these). */
export function unknownAbilities(p: Player): AbilityId[] {
  return DISCOVERABLE_ABILITIES.filter((a) => !knows(p, a));
}

/** Fresh loadout for a new crawler. */
export function startingLoadout(): Player["abilities"] {
  return {
    slots: [...STARTING_ABILITIES, null] as (AbilityId | null)[],
    ultimate: null,
    bench: [],
    ranks: {},
  };
}

// ---- Effective ability parameters (pure; read CONFIG + node ranks) ----

export function meleeParams(p: Player) {
  // Weapon-class hooks (DESIGN 5.8): swift swings faster, heavy hits harder
  // (and staggers harder) but slower, reach extends the arc's radius. The Mug
  // does a little of everything, badly.
  const wc = weaponClassOf(p.equipment.weapon);
  const classDmg = wc === "heavy" ? CONFIG.heavyMeleeDmgMult : wc === "chaotic" ? 1.15 : 1;
  const classCd = wc === "swift" ? CONFIG.swiftMeleeCdMult : wc === "heavy" ? CONFIG.heavyMeleeCdMult : wc === "chaotic" ? 0.95 : 1;
  return {
    damageMult: (1 + rank(p, "melee.heavy") * 0.2) * classDmg,
    cooldown: CONFIG.playerAttackCooldown * (1 - rank(p, "melee.swift") * 0.12) * classCd,
    arc: CONFIG.playerAttackArc + rank(p, "melee.arc") * (22 * Math.PI / 180),
    range: CONFIG.playerAttackRange + (wc === "reach" ? CONFIG.reachRangeBonus : wc === "chaotic" ? 0.25 : 0),
    poiseMult: wc === "heavy" ? CONFIG.heavyPoiseMult : 1,
  };
}

export function dashParams(p: Player) {
  return {
    cooldown: CONFIG.dashCooldown * (1 - rank(p, "dash.quick") * 0.18),
    distance: CONFIG.dashDistance * (1 + rank(p, "dash.blink") * 0.3),
    shockMult: rank(p, "dash.shock") * 0.5, // fraction of dash power dealt along the path
  };
}

/**
 * Bolt is the weapon's projectile (DESIGN 5.8): what pressing BOLT throws —
 * and which school pays for it — comes from the equipped weapon. Crossbows
 * loose real bolts (attack power, fast, pierce at rare+); wands/staffs cast
 * magic missiles (spell power; wand = faster casts, staff pays out on nova);
 * melee-class weapons fall back to a weak thrown sidearm; bare hands throw a
 * plain 0.8× jab. The Mug throws whatever's strongest, poorly.
 */
export function boltParams(p: Player) {
  const w = p.equipment.weapon;
  const wc = weaponClassOf(w);
  const rareUp = w && (w.rarity === "rare" || w.rarity === "epic");
  const profile =
    wc === "ballistic" ? { dmg: p.attackPower * CONFIG.boltBallisticMult, school: "physical" as School, speedMult: CONFIG.boltBallisticSpeedMult, bonusPierce: rareUp ? 1 : 0, cdMult: 1 }
    : wc === "arcane" ? { dmg: p.spellPower * CONFIG.boltArcaneMult, school: "magic" as School, speedMult: 1, bonusPierce: 0, cdMult: /Wand$/.test(w!.name) ? CONFIG.wandBoltCdMult : 1 }
    : wc === "chaotic" ? { dmg: Math.max(p.attackPower, p.spellPower) * CONFIG.chaoticBoltMult, school: (p.spellPower > p.attackPower ? "magic" : "physical") as School, speedMult: 1.15, bonusPierce: 0, cdMult: 0.95 }
    : wc !== null ? { dmg: p.attackPower * CONFIG.boltSidearmMult, school: "physical" as School, speedMult: 1, bonusPierce: 0, cdMult: 1 } // melee-class sidearm
    : { dmg: p.attackPower * CONFIG.boltDamageMult, school: "physical" as School, speedMult: 1, bonusPierce: 0, cdMult: 1 }; // bare hands
  return {
    count: 1 + rank(p, "bolt.split"),
    // Standing Ovation (chase legendary): +2 pierce on top of tree + weapon.
    pierce: rank(p, "bolt.pierce") + profile.bonusPierce + (hasPassive(p, "skewer") ? CONFIG.skewerBonusPierce : 0),
    cooldown: CONFIG.boltCooldown * (1 - rank(p, "bolt.rapid") * 0.15) * profile.cdMult,
    dmg: profile.dmg,
    school: profile.school,
    speedMult: profile.speedMult,
    // Frost Bolts (5.11): impacts chill by this slow fraction (0 = node untaken).
    chill: Math.min(CONFIG.chillSlowMax, rank(p, "bolt.frost") * CONFIG.chillSlowPerRank),
  };
}

export function novaParams(p: Player) {
  // Staff hook: the caster's weapon pays out on the AoE, not the missile.
  const w = p.equipment.weapon;
  const staff = weaponClassOf(w) === "arcane" && /Staff$/.test(w!.name);
  return {
    radius: CONFIG.novaRadius * (1 + rank(p, "nova.bang") * 0.25) * (staff ? CONFIG.staffAoeRadiusMult : 1),
    cooldown: CONFIG.novaCooldown * (1 - rank(p, "nova.after") * 0.15),
    damageMult: CONFIG.novaDamageMult * (1 + rank(p, "nova.conc") * 0.3),
  };
}

/**
 * Battle Stance damage multiplier for an attack of the given type. Neutral (1)
 * unless stance is slotted; then matching attacks are boosted and mismatched
 * ones penalized. Discipline rewards settling in (stanceTime past the settle
 * threshold); Flow rewards the beats right after a swap (stanceSwapWindow);
 * PERFECT FORM makes a settled crawler transcend the tradeoff entirely.
 */
export function stanceMult(p: Player, kind: StanceId): number {
  if (!slotted(p, "stance")) return 1;
  const settled = p.stanceTime >= CONFIG.stanceSettleSeconds;
  const match = p.stance === kind || (settled && rank(p, "stance.perfect") > 0);
  if (!match) return CONFIG.stanceWrongMult;
  let mult = CONFIG.stanceRightMult + rank(p, "stance.edge") * 0.08;
  if (settled) mult *= 1 + rank(p, "stance.discipline") * 0.1;
  if (p.stanceSwapWindow > 0) mult *= 1 + rank(p, "stance.flow") * 0.15;
  return mult;
}

/** What the banked Overcharge does when the next attack spends it. */
export function overchargeParams(p: Player) {
  return {
    mult: CONFIG.overchargeDamageMult + rank(p, "overcharge.surge") * 0.25,
    extraBolts: rank(p, "overcharge.volley"),
    echoFrac: rank(p, "overcharge.echo") * 0.4,
    shatter: rank(p, "overcharge.shock") > 0,
  };
}

export function orbitParams(p: Player) {
  // Perpetual Encore (chase legendary): one more blade, spinning to a faster
  // damage beat — the orbit build's payoff you shop three floors toward.
  const encore = hasPassive(p, "encore");
  return {
    blades: CONFIG.orbitBladesBase + rank(p, "orbit.blade") + (encore ? 1 : 0),
    radius: CONFIG.orbitRadius,
    damageMult: CONFIG.orbitDamageMult * (1 + rank(p, "orbit.razor") * 0.35),
    spiralRank: rank(p, "orbit.wide"),
    tickSeconds: CONFIG.orbitTickSeconds * (encore ? CONFIG.encoreOrbitTickMult : 1),
  };
}

/**
 * World position of orbit blade `i`. With Corkscrew (orbit.wide) taken, the
 * blade radius oscillates between the inner spiral radius and a rank-scaled
 * outer reach (blades phase-offset so they cover different ranges at once).
 * `angleBack`/`phaseBack` rewind the rotation and spiral by that many radians —
 * the sim's damage tick uses this to test the SWEPT path since the last tick,
 * and renderers call it with no rewind so visuals match hits exactly.
 */
export function orbitBladePos(p: Player, i: number, angleBack = 0, phaseBack = 0): { x: number; y: number } {
  const op = orbitParams(p);
  const offset = (i * Math.PI * 2) / op.blades;
  const a = p.orbitAngle - angleBack + offset;
  let rad = op.radius;
  if (op.spiralRank > 0) {
    const outer = CONFIG.orbitRadius + CONFIG.orbitSpiralPerRank * op.spiralRank;
    const ph = p.orbitSpiral - phaseBack + offset;
    rad = CONFIG.orbitSpiralInner + (outer - CONFIG.orbitSpiralInner) * 0.5 * (1 - Math.cos(ph));
  }
  return { x: p.pos.x + Math.cos(a) * rad, y: p.pos.y + Math.sin(a) * rad };
}

// ---- Ultimate constellation params (pure; read CONFIG + node ranks) ----

export function airstrikeParams(p: Player) {
  const sat = rank(p, "air.saturation");
  return {
    shells: CONFIG.ultAirstrikeShells + sat * CONFIG.ultAirstrikeSaturationShells,
    spread: CONFIG.ultAirstrikeSpread
      * (1 + sat * CONFIG.ultAirstrikeSaturationSpread)
      * Math.max(0.1, 1 - rank(p, "air.precision") * CONFIG.ultAirstrikePrecisionSpread),
    dmgMult: CONFIG.ultAirstrikeDmgMult * (1 + rank(p, "air.payload") * CONFIG.ultAirstrikePayloadDmg),
    loyalty: rank(p, "air.loyalty") > 0,
  };
}

export function cataclysmParams(p: Player) {
  const after = rank(p, "cata.aftermath");
  const up = rank(p, "cata.upheaval");
  return {
    radius: CONFIG.ultCataclysmRadius * (1 + rank(p, "cata.epicenter") * CONFIG.ultCataclysmEpicenterRadius),
    knockback: CONFIG.ultCataclysmKnockback * (1 + up * CONFIG.ultCataclysmUpheavalKnock),
    poiseMult: up > 0 ? CONFIG.ultCataclysmUpheavalPoise : 1,
    echoFrac: after > 0 ? CONFIG.ultCataclysmAftermathBase + after * CONFIG.ultCataclysmAftermathPerRank : 0,
    extinction: rank(p, "cata.extinction") > 0,
  };
}

export function bulletTimeParams(p: Player) {
  return {
    duration: CONFIG.ultBulletTimeDuration + rank(p, "bt.focus") * CONFIG.ultBulletTimeFocusSeconds,
    cdTickMult: 1 + rank(p, "bt.adrenaline") * CONFIG.ultBulletTimeAdrenaline,
    critBonus: rank(p, "bt.deadeye") * CONFIG.ultBulletTimeDeadeyeCrit,
    encore: rank(p, "bt.encore") > 0,
  };
}

// ---- Level-up draft ----

export interface UpgradeOffer {
  id: string; // upgrade node id
  ability: AbilityId;
  title: string;
  desc: string;
  nextRank: number;
  /** Lottery offer past the node's printed max — hosts style it as a jackpot. */
  overrank?: boolean;
}

/** The true rank ceiling: printed max plus overrank headroom. */
export function effectiveMaxRank(u: UpgradeDef): number {
  return u.maxRank + (u.over ?? 0);
}

/** True when the node's graph position allows investment: prerequisites taken,
 * and no rank held in a node it forks against (the road not taken is CLOSED). */
export function nodeOpen(p: Player, u: UpgradeDef): boolean {
  if (u.requires && !u.requires.every((id) => rank(p, id) > 0)) return false;
  if (u.excludes && u.excludes.some((id) => rank(p, id) > 0)) return false;
  return true;
}

/** Nodes still below max rank for abilities the player has SLOTTED, respecting
 * the graph: prerequisites gate, exclusive forks lock. Drafts roll from this. */
export function availableUpgrades(p: Player): UpgradeDef[] {
  return UPGRADES.filter((u) => slotted(p, u.ability) && rank(p, u.id) < u.maxRank && nodeOpen(p, u));
}

/** Nodes eligible for the overrank lottery: at printed max, headroom left. */
export function overrankUpgrades(p: Player): UpgradeDef[] {
  return UPGRADES.filter(
    (u) => slotted(p, u.ability) && nodeOpen(p, u) && rank(p, u.id) >= u.maxRank && rank(p, u.id) < effectiveMaxRank(u),
  );
}

/** Odds that a draft on this floor dangles an overrank (deeper = luckier). */
export function overrankChance(floor: number): number {
  return Math.min(CONFIG.overrankChanceMax, CONFIG.overrankChanceBase + floor * CONFIG.overrankChancePerFloor);
}

/**
 * Roll a level-up draft: up to `count` distinct node rank-ups, seeded from the
 * sim's RNG stream so replays reproduce the same offers. At most ONE slot may
 * carry an overrank — a rare, floor-weighted lottery rank past a node's printed
 * max. Missing the roll leaves overranked power on the table; that scarcity is
 * the design (backlog #7).
 */
export function rollUpgradeDraft(rng: Rng, p: Player, count: number, floor = 1): UpgradeOffer[] {
  const offers: UpgradeOffer[] = [];
  const overPool = overrankUpgrades(p);
  if (overPool.length > 0 && chance(rng, overrankChance(floor))) {
    const won = pick(rng, overPool);
    const next = rank(p, won.id) + 1;
    offers.push({ id: won.id, ability: won.ability, title: won.title, desc: won.desc(next), nextRank: next, overrank: true });
  }
  const pool = availableUpgrades(p);
  while (offers.length < count && pool.length > 0) {
    const drawn = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    const next = rank(p, drawn.id) + 1;
    offers.push({ id: drawn.id, ability: drawn.ability, title: drawn.title, desc: drawn.desc(next), nextRank: next });
  }
  return offers;
}
