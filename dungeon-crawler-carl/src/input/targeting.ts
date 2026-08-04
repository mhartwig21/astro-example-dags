import type { Vec2 } from "../sim/types";

/**
 * Smart-cast target selection. Pure and DOM-free so the priority ladder can be
 * unit-tested (test/targeting.test.ts) instead of eyeballed on a phone.
 *
 * This replaces the host old autoAimDir(), which picked the nearest living
 * monster full stop: no lock, no last-hit bias, no respect for the ability
 * range, and no exclusion of dormant ambushers (which made half the phone
 * casts fly at a monster that had not woken up yet).
 *
 * Priority, first match wins:
 *   1. the LOCKED target, if alive and in range;
 *   2. the target you DAMAGED in the last 3 s, if alive and in range —
 *      this is what makes finishing a kill feel intentional;
 *   3. inside range, the lowest CURRENT HP FRACTION, weighted by a facing
 *      cone and a modest elite/boss bonus;
 *   4. otherwise the nearest thing in range.
 * Nothing outside the ability real range is ever chosen: a cast with no
 * candidate falls back to facing, which is the keyboard behaviour.
 */

export interface TargetCandidate {
  id: number;
  pos: Vec2;
  hp: number;
  maxHp: number;
  /** Ambushers lie inert until sprung; smart cast must not aim at furniture. */
  dormant?: boolean;
  elite?: boolean;
  boss?: boolean;
}

export interface PickOpts {
  from: Vec2;
  /** Unit facing; used for the cone weight only (never a hard filter). */
  facing?: Vec2 | null;
  /** The ability real reach in world units. */
  range: number;
  lockedId?: number | null;
  lastDamagedId?: number | null;
  /** Seconds since that damage landed. Over LAST_HIT_WINDOW it stops counting. */
  lastDamagedAge?: number;
}

export const LAST_HIT_WINDOW = 3;
/** How much a target dead ahead outscores one at the edge of vision. */
const CONE_WEIGHT = 0.22;
const ELITE_BONUS = 0.08;
const BOSS_BONUS = 0.14;

function alive(c: TargetCandidate): boolean {
  return c.hp > 0 && !c.dormant;
}

export function pickTarget(cands: readonly TargetCandidate[], o: PickOpts): TargetCandidate | null {
  const r2 = o.range * o.range;
  const inRange = (c: TargetCandidate): boolean => {
    const dx = c.pos.x - o.from.x, dy = c.pos.y - o.from.y;
    const d2 = dx * dx + dy * dy;
    return d2 <= r2 && d2 > 1e-6;
  };

  // 1. lock
  if (o.lockedId != null) {
    const locked = cands.find((c) => c.id === o.lockedId);
    if (locked && alive(locked) && inRange(locked)) return locked;
  }
  // 2. last damaged, inside the window
  if (o.lastDamagedId != null && (o.lastDamagedAge ?? Infinity) <= LAST_HIT_WINDOW) {
    const last = cands.find((c) => c.id === o.lastDamagedId);
    if (last && alive(last) && inRange(last)) return last;
  }
  // 3 + 4. score everything in range; the score IS the tie-break, so there is
  // no separate nearest pass — an all-full-health field scores by distance.
  let best: TargetCandidate | null = null;
  let bestScore = -Infinity;
  const fx = o.facing?.x ?? 0, fy = o.facing?.y ?? 0;
  const fl = Math.hypot(fx, fy);
  for (const c of cands) {
    if (!alive(c) || !inRange(c)) continue;
    const dx = c.pos.x - o.from.x, dy = c.pos.y - o.from.y;
    const d = Math.hypot(dx, dy);
    const frac = c.maxHp > 0 ? Math.max(0, Math.min(1, c.hp / c.maxHp)) : 1;
    // Executable things first, near things next, and a nudge toward whatever
    // the crawler is already facing so a smart cast does not spin them around.
    let score = (1 - frac) + (1 - d / o.range) * 0.5;
    if (fl > 1e-6 && d > 1e-6) {
      const dot = (dx / d) * (fx / fl) + (dy / d) * (fy / fl);
      score += ((dot + 1) / 2) * CONE_WEIGHT;
    }
    if (c.boss) score += BOSS_BONUS;
    else if (c.elite) score += ELITE_BONUS;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Direction from the crawler to a target, unnormalised (the sim normalises). */
export function aimAt(from: Vec2, t: TargetCandidate): Vec2 {
  return { x: t.pos.x - from.x, y: t.pos.y - from.y };
}

/**
 * The target a world-zone tap grabs: nearest candidate whose body circle
 * contains the tap, else the nearest inside `slop`. Host-side only.
 */
export function tapTarget(
  cands: readonly TargetCandidate[], at: Vec2, slop = 0.9,
): TargetCandidate | null {
  let best: TargetCandidate | null = null;
  let bestD = slop * slop;
  for (const c of cands) {
    if (!alive(c)) continue;
    const dx = c.pos.x - at.x, dy = c.pos.y - at.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD) { bestD = d2; best = c; }
  }
  return best;
}