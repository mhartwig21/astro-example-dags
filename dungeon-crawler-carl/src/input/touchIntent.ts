import type { Intent, Vec2 } from "../sim/types";
import type { TouchSample } from "./touch";

/**
 * The seam where a finger becomes an ordinary Intent — the SAME Intent the
 * keyboard produces. It lives here, pure, rather than inline in the host, so
 * test/touchIntent.test.ts can assert Intent equality with the keyboard for
 * every gesture in the table instead of trusting a comment.
 *
 * Two rules this file exists to keep honest:
 *   - screen space is rotated into world axes ONCE, at this seam (isoRotate),
 *     exactly as the pad does;
 *   - a gesture only ever fills fields the keyboard also fills. There is no
 *     touch-only field, no host-side speed scalar, and no new verb: the dash
 *     gesture casts whatever SLOT holds dash, and is inert if none does.
 */

export interface TouchCastEdge { slot: number; aim: Vec2 | null; frac: number }

export interface TouchEdges {
  /** Released casts since the last drain. */
  casts: TouchCastEdge[];
  attack: boolean;
  flask: boolean;
  stairs: boolean;
  ping: Vec2 | null;
  dash: boolean;
}

export function createTouchEdges(): TouchEdges {
  return { casts: [], attack: false, flask: false, stairs: false, ping: null, dash: false };
}

/**
 * Accumulate one polled sample. Edges ACCUMULATE rather than being read
 * straight into an Intent because the sim can be paused (hit-stop, an open
 * panel) for many frames: a tap must still land when the world thaws.
 */
export function accumulateTouch(edges: TouchEdges, s: TouchSample): void {
  for (const c of s.castEdges) {
    // The controller reuses its edge objects; copy the scalars out.
    edges.casts.push({ slot: c.slot, aim: c.aim ? { x: c.aim.x, y: c.aim.y } : null, frac: c.frac });
  }
  edges.attack ||= s.castHeld[0];
  edges.flask ||= s.flaskEdge;
  edges.stairs ||= s.stairsEdge;
  edges.dash ||= s.dashEdge;
}

export interface TouchMergeCtx {
  /** Screen -> world axes. The host passes the shared isoRotate. */
  isoRotate: (v: Vec2) => Vec2;
  /** Which cast slot currently holds dash, or -1. */
  dashSlot: number;
}

/**
 * Drain the edge buffer into an Intent. Returns true when the gesture supplied
 * an EXPLICIT aim (an aimed cast), so the caller knows not to overwrite it with
 * the smart-cast or mouse aim.
 */
export function applyTouchEdges(
  intent: Intent, sample: TouchSample | null, edges: TouchEdges, ctx: TouchMergeCtx,
): boolean {
  if (!sample) return false;
  let explicitAim = false;
  if (sample.move) intent.move = ctx.isoRotate(sample.move);
  if (intent.cast) {
    if (edges.attack) intent.cast[0] = true;
    for (const c of edges.casts) {
      intent.cast[c.slot] = true;
      if (c.aim) {
        // The drag LENGTH stays a presentation value (it drives the
        // telegraph): game.ts normalizes Intent.aim and Intent.move, so a
        // host-side magnitude would be discarded, and making the sim read it
        // would be a new game rule.
        intent.aim = ctx.isoRotate(c.aim);
        explicitAim = true;
      }
    }
    if (edges.dash && ctx.dashSlot >= 0) intent.cast[ctx.dashSlot] = true;
  }
  if (edges.flask) intent.flask = true;
  if (edges.stairs) intent.useStairs = true;
  if (edges.ping) intent.ping = edges.ping;
  edges.casts.length = 0;
  edges.attack = edges.flask = edges.stairs = edges.dash = false;
  edges.ping = null;
  return explicitAim;
}