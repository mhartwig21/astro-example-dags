import { CONFIG } from "./config";
import { nextInt, type Rng } from "./rng";
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
  | "melee" | "dash" | "bolt" | "nova" | "orbit" | "stance"
  | "airstrike" | "cataclysm" | "bullettime";

// Battle Stance: which attack TYPE the crawler currently favors. Melee swings
// and orbit blades are melee-type; bolts are ranged-type; everything else is
// stance-neutral. Extensible — a third stance is a union member away.
export type StanceId = "melee" | "ranged";

export type AbilityTier = "active" | "ultimate";

export const ABILITY_SLOTS = 4; // active slots (the ultimate has its own slot)

/** Abilities every crawler starts with (slotted 0..2; slot 3 + ultimate empty). */
export const STARTING_ABILITIES: AbilityId[] = ["melee", "dash", "bolt"];
/** Abilities that must be discovered (tomes/boxes/shop) before they can slot. */
export const DISCOVERABLE_ABILITIES: AbilityId[] = [
  "nova", "orbit", "stance", "airstrike", "cataclysm", "bullettime",
];

export const ABILITY_INFO: Record<AbilityId, { name: string; blurb: string; tier: AbilityTier; passive?: boolean }> = {
  melee: { name: "Melee", blurb: "Your trusty swing", tier: "active" },
  dash: { name: "Dash", blurb: "Blink with i-frames", tier: "active" },
  bolt: { name: "Bolt", blurb: "Ranged projectile", tier: "active" },
  nova: { name: "Nova", blurb: "Radial shockwave", tier: "active" },
  orbit: { name: "Orbit", blurb: "Auto blades circle you", tier: "active", passive: true },
  stance: { name: "Battle Stance", blurb: "Toggle Brawler/Deadeye: matching attacks hit harder, mismatched softer", tier: "active" },
  airstrike: { name: "Sponsor Airstrike", blurb: "Your sponsors deliver ordnance at the cursor", tier: "ultimate" },
  cataclysm: { name: "Cataclysm", blurb: "A floor-shaking blast that hurls enemies back", tier: "ultimate" },
  bullettime: { name: "Bullet Time", blurb: "The world slows; you do not", tier: "ultimate" },
};

export interface UpgradeDef {
  id: string; // "bolt.split"
  ability: AbilityId;
  title: string;
  maxRank: number;
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
export const UPGRADES: UpgradeDef[] = [
  // Melee: arc -> (heavy XOR swift) -> Executioner
  { id: "melee.arc", ability: "melee", title: "Wide Arc", maxRank: 2, desc: (r) => `Swing arc +${r * 22}°`, pos: { x: 50, y: 12 } },
  { id: "melee.heavy", ability: "melee", title: "Heavy Blows", maxRank: 3, desc: (r) => `Melee damage +${r * 20}%`, requires: ["melee.arc"], excludes: ["melee.swift"], pos: { x: 22, y: 48 } },
  { id: "melee.swift", ability: "melee", title: "Swift Strikes", maxRank: 3, desc: (r) => `Melee cooldown -${r * 12}%`, requires: ["melee.arc"], excludes: ["melee.heavy"], pos: { x: 78, y: 48 } },
  { id: "melee.execute", ability: "melee", title: "EXECUTIONER", maxRank: 1, desc: () => "Melee deals +60% to enemies below 30% HP", requires: ["melee.arc"], capstone: true, pos: { x: 50, y: 86 } },
  // Dash: (quick XOR blink) -> shock -> Aftershock
  { id: "dash.quick", ability: "dash", title: "Quickstep", maxRank: 3, desc: (r) => `Dash cooldown -${r * 18}%`, excludes: ["dash.blink"], pos: { x: 22, y: 14 } },
  { id: "dash.blink", ability: "dash", title: "Long Blink", maxRank: 2, desc: (r) => `Dash distance +${r * 30}%`, excludes: ["dash.quick"], pos: { x: 78, y: 14 } },
  { id: "dash.shock", ability: "dash", title: "Shockstep", maxRank: 3, desc: (r) => `Arrival burst: ${r * 50}% damage nearby`, pos: { x: 50, y: 50 } },
  { id: "dash.after", ability: "dash", title: "AFTERSHOCK", maxRank: 1, desc: () => "Your dash also detonates at the arrival point", requires: ["dash.shock"], capstone: true, pos: { x: 50, y: 86 } },
  // Bolt: rapid -> (split XOR pierce) -> Ricochet
  { id: "bolt.rapid", ability: "bolt", title: "Rapid Bolts", maxRank: 3, desc: (r) => `Bolt cooldown -${r * 15}%`, pos: { x: 50, y: 12 } },
  { id: "bolt.split", ability: "bolt", title: "Split Shot", maxRank: 2, desc: (r) => `Fire ${1 + r} bolts in a fan`, requires: ["bolt.rapid"], excludes: ["bolt.pierce"], pos: { x: 22, y: 48 } },
  { id: "bolt.pierce", ability: "bolt", title: "Piercing Bolts", maxRank: 2, desc: (r) => `Bolts pierce ${r} extra ${r === 1 ? "enemy" : "enemies"}`, requires: ["bolt.rapid"], excludes: ["bolt.split"], pos: { x: 78, y: 48 } },
  { id: "bolt.ricochet", ability: "bolt", title: "RICOCHET", maxRank: 1, desc: () => "Bolts bounce to a nearby enemy on hit (60% damage)", requires: ["bolt.rapid"], capstone: true, pos: { x: 50, y: 86 } },
  // Nova: bang -> (after XOR conc) -> Implosion
  { id: "nova.bang", ability: "nova", title: "Bigger Bang", maxRank: 2, desc: (r) => `Nova radius +${r * 25}%`, pos: { x: 50, y: 12 } },
  { id: "nova.after", ability: "nova", title: "Aftershock", maxRank: 3, desc: (r) => `Nova cooldown -${r * 15}%`, requires: ["nova.bang"], excludes: ["nova.conc"], pos: { x: 22, y: 48 } },
  { id: "nova.conc", ability: "nova", title: "Concussive", maxRank: 3, desc: (r) => `Nova damage +${r * 30}%`, requires: ["nova.bang"], excludes: ["nova.after"], pos: { x: 78, y: 48 } },
  { id: "nova.implode", ability: "nova", title: "IMPLOSION", maxRank: 1, desc: () => "Nova first drags everything in range toward you", requires: ["nova.bang"], capstone: true, pos: { x: 50, y: 86 } },
  // Stance: edge -> (discipline XOR flow) -> a capstone per side. The fork IS
  // the playstyle question: plant your feet in one stance, or dance between them.
  { id: "stance.edge", ability: "stance", title: "Honed Edge", maxRank: 2, desc: (r) => `Matching-stance damage +${r * 8}%`, pos: { x: 50, y: 12 } },
  { id: "stance.discipline", ability: "stance", title: "Discipline", maxRank: 3, desc: (r) => `Settled (${CONFIG.stanceSettleSeconds}s+ in one stance): matching damage +${r * 10}%`, requires: ["stance.edge"], excludes: ["stance.flow"], pos: { x: 22, y: 48 } },
  { id: "stance.flow", ability: "stance", title: "Flow", maxRank: 3, desc: (r) => `For ${CONFIG.stanceSurgeSeconds}s after a swap: matching damage +${r * 15}%`, requires: ["stance.edge"], excludes: ["stance.discipline"], pos: { x: 78, y: 48 } },
  { id: "stance.perfect", ability: "stance", title: "PERFECT FORM", maxRank: 1, desc: () => "While settled, BOTH attack types count as matching", requires: ["stance.discipline"], capstone: true, pos: { x: 22, y: 86 } },
  { id: "stance.moment", ability: "stance", title: "MOMENTUM", maxRank: 1, desc: () => "Swapping stances primes a guaranteed crit on your next matching attack", requires: ["stance.flow"], capstone: true, pos: { x: 78, y: 86 } },
  // Orbit: blade -> razor + corkscrew (no fork; the passive stays simple)
  { id: "orbit.blade", ability: "orbit", title: "Extra Blade", maxRank: 2, desc: (r) => `${CONFIG.orbitBladesBase + r} orbiting blades`, pos: { x: 50, y: 14 } },
  { id: "orbit.razor", ability: "orbit", title: "Razor's Edge", maxRank: 3, desc: (r) => `Blade damage +${r * 35}%`, requires: ["orbit.blade"], pos: { x: 25, y: 62 } },
  {
    id: "orbit.wide", ability: "orbit", title: "Corkscrew", maxRank: 2,
    desc: (r) => `Blades spiral ${CONFIG.orbitSpiralInner}–${(CONFIG.orbitRadius + CONFIG.orbitSpiralPerRank * r).toFixed(1)} tiles, sweeping every range`,
    requires: ["orbit.blade"], pos: { x: 75, y: 62 },
  },
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
  return {
    damageMult: 1 + rank(p, "melee.heavy") * 0.2,
    cooldown: CONFIG.playerAttackCooldown * (1 - rank(p, "melee.swift") * 0.12),
    arc: CONFIG.playerAttackArc + rank(p, "melee.arc") * (22 * Math.PI / 180),
  };
}

export function dashParams(p: Player) {
  return {
    cooldown: CONFIG.dashCooldown * (1 - rank(p, "dash.quick") * 0.18),
    distance: CONFIG.dashDistance * (1 + rank(p, "dash.blink") * 0.3),
    shockMult: rank(p, "dash.shock") * 0.5, // fraction of baseDamage dealt on arrival
  };
}

export function boltParams(p: Player) {
  return {
    count: 1 + rank(p, "bolt.split"),
    pierce: rank(p, "bolt.pierce"),
    cooldown: CONFIG.boltCooldown * (1 - rank(p, "bolt.rapid") * 0.15),
  };
}

export function novaParams(p: Player) {
  return {
    radius: CONFIG.novaRadius * (1 + rank(p, "nova.bang") * 0.25),
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

export function orbitParams(p: Player) {
  return {
    blades: CONFIG.orbitBladesBase + rank(p, "orbit.blade"),
    radius: CONFIG.orbitRadius,
    damageMult: CONFIG.orbitDamageMult * (1 + rank(p, "orbit.razor") * 0.35),
    spiralRank: rank(p, "orbit.wide"),
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

// ---- Level-up draft ----

export interface UpgradeOffer {
  id: string; // upgrade node id
  ability: AbilityId;
  title: string;
  desc: string;
  nextRank: number;
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

/**
 * Roll a level-up draft: up to `count` distinct node rank-ups, seeded from the
 * sim's RNG stream so replays reproduce the same offers.
 */
export function rollUpgradeDraft(rng: Rng, p: Player, count: number): UpgradeOffer[] {
  const pool = availableUpgrades(p);
  const offers: UpgradeOffer[] = [];
  while (offers.length < count && pool.length > 0) {
    const pick = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    const next = rank(p, pick.id) + 1;
    offers.push({ id: pick.id, ability: pick.ability, title: pick.title, desc: pick.desc(next), nextRank: next });
  }
  return offers;
}
