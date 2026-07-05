import { CONFIG } from "./config";
import type { StatusEffect, StatusKind } from "./types";

// Status-effect framework (DESIGN 5.11): three effects, deterministic, ticked
// by dt. This module owns the pure apply/stack/expiry rules; game.ts routes
// the DoT ticks it reports back through the damageMonster / damagePlayerHit
// choke points so schools, resists, armor, caps, and hit events all compose.
//
//   burn   — fast DoT, MAGIC school, short, refresh-on-reapply (no stacking)
//   poison — slow DoT, PHYSICAL school, stacks to poisonMaxStacks (each adds)
//   chill  — no damage; slows move AND attack/windup speed (the afflicted
//            entity simply experiences slowed time — see statusTimeMult)

/** Anything that can carry statuses (Monster or Player — structural). */
export interface StatusTarget {
  statuses?: StatusEffect[];
}

/** Seconds between DoT ticks per kind (chill never ticks damage). */
export function statusTickSeconds(kind: StatusKind): number {
  return kind === "burn" ? CONFIG.burnTickSeconds : CONFIG.poisonTickSeconds;
}

/** The active entry of `kind` on a target, if any. */
export function statusOf(t: StatusTarget, kind: StatusKind): StatusEffect | undefined {
  return t.statuses?.find((s) => s.kind === kind);
}

/**
 * Apply (or re-apply) a status. Rules per kind:
 * - burn/chill: REFRESH — duration restarts, magnitude keeps the stronger roll.
 * - poison: STACK — up to poisonMaxStacks; each stack adds a full tick's
 *   damage (tick damage = magnitude × stacks); duration refreshes.
 */
export function applyStatus(
  t: StatusTarget,
  s: { kind: StatusKind; duration: number; magnitude: number; school: StatusEffect["school"]; sourceId?: number },
): void {
  const list = (t.statuses ??= []);
  const cur = list.find((e) => e.kind === s.kind);
  if (!cur) {
    list.push({
      kind: s.kind,
      remaining: s.duration,
      magnitude: s.magnitude,
      stacks: 1,
      tick: s.kind === "chill" ? 0 : statusTickSeconds(s.kind),
      school: s.school,
      sourceId: s.sourceId,
    });
    return;
  }
  cur.remaining = s.duration;
  cur.magnitude = Math.max(cur.magnitude, s.magnitude);
  if (s.kind === "poison") cur.stacks = Math.min(CONFIG.poisonMaxStacks, cur.stacks + 1);
  if (s.sourceId !== undefined) cur.sourceId = s.sourceId;
}

/** A DoT tick that came due this step (damage = magnitude × stacks). */
export interface DueTick {
  kind: StatusKind;
  damage: number;
  school: StatusEffect["school"];
  sourceId?: number;
}

/**
 * Advance a target's statuses by dt: counts down durations, collects the DoT
 * ticks that came due, prunes expired entries. Pure bookkeeping — the CALLER
 * turns DueTicks into damage through the proper choke point.
 */
export function tickStatuses(t: StatusTarget, dt: number): DueTick[] {
  if (!t.statuses || t.statuses.length === 0) return [];
  const due: DueTick[] = [];
  for (const s of t.statuses) {
    s.remaining -= dt;
    if (s.kind === "chill") continue;
    s.tick -= dt;
    // Catch up on ticks even across a large dt (headless/test steps), but
    // never past the effect's own expiry (epsilons: the final tick lands
    // exactly at expiry and must not be lost to float noise).
    while (s.tick <= 1e-6 && s.remaining + s.tick >= -1e-6) {
      due.push({
        kind: s.kind,
        damage: Math.max(1, Math.round(s.magnitude * s.stacks)),
        school: s.school,
        sourceId: s.sourceId,
      });
      s.tick += statusTickSeconds(s.kind);
    }
  }
  t.statuses = t.statuses.filter((s) => s.remaining > 0);
  return due;
}

/**
 * Time multiplier from chill (1 = normal, 0.7 = -30%): the afflicted entity's
 * combat clock — movement, windups, cooldown recovery — runs this much slower.
 * Hosts may read it too (animation pacing), but the SIM decides.
 */
export function statusTimeMult(t: StatusTarget): number {
  const chill = statusOf(t, "chill");
  return chill ? Math.max(0.25, 1 - chill.magnitude) : 1;
}
