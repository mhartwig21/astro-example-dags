import { CONFIG } from "../sim/config";
import type { Player } from "../sim/types";
import {
  cataclysmParams, crowdSurfParams, cutToParams, dashParams, meleeParams,
  novaParams, orbitParams, airstrikeParams, boltParams, type AbilityId,
} from "../sim/abilities";

/**
 * What the aim telegraph must DRAW, derived from the crawler own numbers.
 *
 * The measured failure this replaces: every skillshot drew the same 4.2-unit
 * plane and every AoE the same 2.0-2.2 ring, so the ultimate that detonates at
 * radius 6 was pixel-identical to the nova that detonates at 2.6. Reading the
 * real params means the indicator TEACHES itemisation — glyphs and ranks change
 * the drawn circle, which is something Wild Rift structurally cannot do.
 *
 * Pure: Player in, geometry out. No THREE, no DOM.
 */

export type AimShape = "line" | "ring" | "arrow" | "cone" | "scatter" | "chain" | "none";

export interface AimSpec {
  shape: AimShape;
  /** How far the cast reaches, in tiles. 0 for self-centred shapes. */
  range: number;
  /** Radius of the affected circle, in tiles. 0 when the shape has none. */
  radius: number;
  /** Half-arc in radians for a cone, else 0. */
  arc: number;
}

const NONE: AimSpec = { shape: "none", range: 0, radius: 0, arc: 0 };

/**
 * Bolt has no range field anywhere: its reach is a consequence of the
 * projectile living boltTtl seconds at boltSpeed tiles per second (before
 * pierce or a wall ends it early). Derived here, once, so both the telegraph
 * and the smart-cast range agree on what "in range" means.
 */
export function boltReach(p: Player): number {
  return CONFIG.boltSpeed * boltParams(p).speedMult * CONFIG.boltTtl;
}

export function aimSpecFor(a: AbilityId | null, p: Player): AimSpec {
  switch (a) {
    case "melee": {
      const m = meleeParams(p);
      return { shape: "cone", range: m.range, radius: m.range, arc: m.arc / 2 };
    }
    case "dash": {
      return { shape: "arrow", range: dashParams(p).distance, radius: 0.6, arc: 0 };
    }
    case "bolt":
      return { shape: "line", range: boltReach(p), radius: 0.25, arc: 0 };
    case "nova":
      return { shape: "ring", range: 0, radius: novaParams(p).radius, arc: 0 };
    case "orbit":
      return { shape: "ring", range: 0, radius: orbitParams(p).radius, arc: 0 };
    case "cutto": {
      const c = cutToParams(p);
      return { shape: "arrow", range: c.range, radius: 0.8, arc: 0 };
    }
    case "crowdsurf":
      // A CHAIN reach, not a radius: the old ring lied about the shape.
      return { shape: "chain", range: crowdSurfParams(p).range, radius: 0.5, arc: 0 };
    case "cataclysm":
      return { shape: "ring", range: 0, radius: cataclysmParams(p).radius, arc: 0 };
    case "airstrike": {
      const a2 = airstrikeParams(p);
      return { shape: "scatter", range: 0, radius: a2.spread, arc: 0 };
    }
    // Self-buffs and summons have no geometry. Drawing a bogus line at them
    // was worse than drawing nothing: it promised a direction that does not
    // exist.
    case "stance":
    case "overcharge":
    case "bullettime":
    case "stuntdouble":
      return NONE;
    default:
      return NONE;
  }
}

/** Smart-cast reach for target picking: the ability real range, with a floor. */
export function castRange(a: AbilityId | null, p: Player): number {
  const s = aimSpecFor(a, p);
  if (s.range > 0) return s.range;
  if (s.radius > 0) return s.radius;
  return CONFIG.playerAttackRange;
}