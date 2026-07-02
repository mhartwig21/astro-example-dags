import { CONFIG } from "./config";
import { nextInt, type Rng } from "./rng";
import type { Player } from "./types";

// Ability system: a Vampire Survivors-style upgrade tree over the active kit.
// Each ability owns a small track of upgrade nodes; level-ups open a seeded
// 3-card draft of node rank-ups for KNOWN abilities, and new abilities are
// discovered in the dungeon as tomes (see dropLoot/collectLoot in game.ts).
// Everything derives from Player.abilities (known + node ranks), so effective
// numbers are pure functions and the sim stays deterministic and serializable.

export type AbilityId = "melee" | "dash" | "bolt" | "nova" | "orbit";

/** Abilities every crawler starts with. */
export const STARTING_ABILITIES: AbilityId[] = ["melee", "dash", "bolt"];
/** Abilities that must be discovered (tomes) before they appear in drafts. */
export const DISCOVERABLE_ABILITIES: AbilityId[] = ["nova", "orbit"];

export const ABILITY_INFO: Record<AbilityId, { name: string; blurb: string; key: string }> = {
  melee: { name: "Melee", blurb: "Your trusty swing", key: "Space" },
  dash: { name: "Dash", blurb: "Blink with i-frames", key: "Shift" },
  bolt: { name: "Bolt", blurb: "Ranged projectile", key: "Q" },
  nova: { name: "Nova", blurb: "Radial shockwave", key: "F" },
  orbit: { name: "Orbit", blurb: "Auto blades circle you", key: "auto" },
};

export interface UpgradeDef {
  id: string; // "bolt.split"
  ability: AbilityId;
  title: string;
  maxRank: number;
  /** Human description of what the NEXT rank grants. */
  desc: (nextRank: number) => string;
}

export const UPGRADES: UpgradeDef[] = [
  // Melee
  { id: "melee.heavy", ability: "melee", title: "Heavy Blows", maxRank: 3, desc: (r) => `Melee damage +${r * 20}%` },
  { id: "melee.swift", ability: "melee", title: "Swift Strikes", maxRank: 3, desc: (r) => `Melee cooldown -${r * 12}%` },
  { id: "melee.arc", ability: "melee", title: "Wide Arc", maxRank: 2, desc: (r) => `Swing arc +${r * 22}°` },
  // Dash
  { id: "dash.quick", ability: "dash", title: "Quickstep", maxRank: 3, desc: (r) => `Dash cooldown -${r * 18}%` },
  { id: "dash.blink", ability: "dash", title: "Long Blink", maxRank: 2, desc: (r) => `Dash distance +${r * 30}%` },
  { id: "dash.shock", ability: "dash", title: "Shockstep", maxRank: 3, desc: (r) => `Arrival burst: ${r * 50}% damage nearby` },
  // Bolt
  { id: "bolt.split", ability: "bolt", title: "Split Shot", maxRank: 2, desc: (r) => `Fire ${1 + r} bolts in a fan` },
  { id: "bolt.pierce", ability: "bolt", title: "Piercing Bolts", maxRank: 2, desc: (r) => `Bolts pierce ${r} extra ${r === 1 ? "enemy" : "enemies"}` },
  { id: "bolt.rapid", ability: "bolt", title: "Rapid Bolts", maxRank: 3, desc: (r) => `Bolt cooldown -${r * 15}%` },
  // Nova
  { id: "nova.bang", ability: "nova", title: "Bigger Bang", maxRank: 2, desc: (r) => `Nova radius +${r * 25}%` },
  { id: "nova.after", ability: "nova", title: "Aftershock", maxRank: 3, desc: (r) => `Nova cooldown -${r * 15}%` },
  { id: "nova.conc", ability: "nova", title: "Concussive", maxRank: 3, desc: (r) => `Nova damage +${r * 30}%` },
  // Orbit
  { id: "orbit.blade", ability: "orbit", title: "Extra Blade", maxRank: 2, desc: (r) => `${CONFIG.orbitBladesBase + r} orbiting blades` },
  { id: "orbit.razor", ability: "orbit", title: "Razor's Edge", maxRank: 3, desc: (r) => `Blade damage +${r * 35}%` },
  { id: "orbit.wide", ability: "orbit", title: "Wide Orbit", maxRank: 2, desc: (r) => `Orbit radius +${r * 20}%` },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgradeDef(id: string): UpgradeDef | undefined {
  return BY_ID.get(id);
}

export function rank(p: Player, id: string): number {
  return p.abilities.ranks[id] ?? 0;
}

export function knows(p: Player, ability: AbilityId): boolean {
  return p.abilities.known.includes(ability);
}

/** Abilities not yet discovered (tomes can drop for these). */
export function unknownAbilities(p: Player): AbilityId[] {
  return DISCOVERABLE_ABILITIES.filter((a) => !knows(p, a));
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

export function orbitParams(p: Player) {
  return {
    blades: CONFIG.orbitBladesBase + rank(p, "orbit.blade"),
    radius: CONFIG.orbitRadius * (1 + rank(p, "orbit.wide") * 0.2),
    damageMult: CONFIG.orbitDamageMult * (1 + rank(p, "orbit.razor") * 0.35),
  };
}

// ---- Level-up draft ----

export interface UpgradeOffer {
  id: string; // upgrade node id
  ability: AbilityId;
  title: string;
  desc: string;
  nextRank: number;
}

/** Nodes still below max rank for abilities the player knows. */
export function availableUpgrades(p: Player): UpgradeDef[] {
  return UPGRADES.filter((u) => knows(p, u.ability) && rank(p, u.id) < u.maxRank);
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
