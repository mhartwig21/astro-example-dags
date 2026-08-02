import { CONFIG } from "../sim/config";
import type { Player, Vec2 } from "../sim/types";
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

/**
 * Shapes the drag PLACES rather than merely points (MOBILE.md §2.4b).
 *
 * For `ring`, `scatter` and the landing footprint of `arrow` the drag carries
 * direction AND distance. For `line`, `cone` and `chain` it is DIRECTION ONLY:
 * a bolt flies its full derived reach whatever the throw, and pretending
 * otherwise would invent a game rule in the input layer, which §2.1 forbids.
 */
export function isPlacedShape(shape: AimShape): boolean {
  return shape === "ring" || shape === "scatter" || shape === "arrow";
}

/**
 * How far from the crawler a PLACED shape lands, given the drag fraction.
 *
 * `dist = (0.15 + 0.85 * frac) * range`, so the shortest committed drag still
 * clears the crawler's own feet rather than dropping the shape on them. Over-
 * throw is free: `frac` is already clamped to 1 by the FSM, because the thumb
 * runs out of screen long before it runs out of intent on a 342px-tall
 * viewport, and punishing that would be punishing the device.
 *
 * Returns 0 for a direction-only shape — the caller draws it at full reach.
 */
export function aimPlacement(spec: AimSpec, frac: number): number {
  if (!isPlacedShape(spec.shape)) return 0;
  const reach = spec.range > 0 ? spec.range : spec.radius;
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return (0.15 + 0.85 * f) * reach;
}

/**
 * WHERE THE TELEGRAPH GOES — direction and anchor, in ONE place, because the
 * host got it wrong for six of ten abilities and nothing caught it.
 *
 * The shipped host did:
 *
 *   const dir = isoRotate(touchHeld.aimDir);          // aimDir is RAW PIXELS
 *   const at  = { x: p.pos.x + dir.x * place, ... };  // place is in TILES
 *
 * `isoRotate` is a pure rotation, so `dir` kept the drag's PIXEL magnitude
 * (~110-175 on the matrix) while the `p.facing` fallback was unit. Multiplying
 * a tile distance by a pixel magnitude put every PLACED shape 110-175x too far
 * out: measured on an iPhone 13 with the crawler at world (50.79, 62.32), nova
 * landed 455 units away and cataclysm 1050 — projected screen boxes at
 * x = -11419 and x = -26803, with 0% of their vertices inside a 750x342 frame,
 * in 4 of 4 drag directions on 2 of 2 devices. That is ring | scatter | arrow =
 * nova, orbit, cataclysm, airstrike, cutto AND dash, including both ultimates.
 * Line, cone and chain survived only because `aimPlacement()` returns 0 for
 * them and the renderer reads their `dir` through `atan2`, which discards
 * magnitude.
 *
 * The repair is not "remember to normalize at the call site" — that is the bug
 * with a comment on it. Direction and anchor are derived together, here, from
 * data, and `test/aimTelegraph.test.ts` projects the result through an iso
 * camera and asserts the box lands on the glass for every shape at frac 0 and
 * frac 1. A host that hands this function a 175 px vector gets the same answer
 * as one that hands it a unit vector.
 */
export interface AimAnchor {
  /** UNIT world-space direction. Never carries the drag's pixel magnitude. */
  dir: Vec2;
  /** Where the shape is centred, in world units. */
  at: Vec2;
  /** How far `at` is from the crawler, in tiles (0 for a direction-only shape). */
  distance: number;
}

export function aimAnchor(
  spec: AimSpec, from: Vec2, worldDir: Vec2 | null, frac: number, facing: Vec2,
): AimAnchor {
  const raw = worldDir && (worldDir.x !== 0 || worldDir.y !== 0) ? worldDir : facing;
  const m = Math.hypot(raw.x, raw.y);
  // A zero-length facing is possible on the first frame of a fresh crawler;
  // pick a stable axis rather than emitting NaN into the scene graph.
  const dir: Vec2 = m > 1e-6 ? { x: raw.x / m, y: raw.y / m } : { x: 1, y: 0 };
  const distance = aimPlacement(spec, frac);
  return {
    dir,
    at: distance > 0
      ? { x: from.x + dir.x * distance, y: from.y + dir.y * distance }
      : { x: from.x, y: from.y },
    distance,
  };
}

/** Smart-cast reach for target picking: the ability real range, with a floor. */
export function castRange(a: AbilityId | null, p: Player): number {
  const s = aimSpecFor(a, p);
  if (s.range > 0) return s.range;
  if (s.radius > 0) return s.radius;
  return CONFIG.playerAttackRange;
}