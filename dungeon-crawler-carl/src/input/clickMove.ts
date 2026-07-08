import type { Vec2 } from "../sim/types";

/**
 * Diablo-style mouse movement (opt-in via the K panel, next to mouse aim).
 * Pure host-side input interpretation: the module turns cursor + LMB state
 * into a per-step move DIRECTION, and the host feeds it into the ordinary
 * Intent — the sim never learns the mouse exists, so determinism, replays,
 * and the multiplayer intent pipe are untouched.
 *
 * Grammar (matching the genre's muscle memory):
 * - press/hold on ground  -> walk toward the cursor while held (steering)
 * - TAP on ground         -> walk to that spot (autopilot until arrival)
 * - press on a monster    -> slot-1 attack, exactly like mode-off LMB
 * - any WASD input        -> keyboard wins; autopilot cancels instantly
 *
 * No pathfinding by design: steering is straight-line and the sim's
 * moveWithCollision slides along walls. A stall guard clears an autopilot
 * target that stops making progress (walked into a dead end) so the
 * crawler never treadmills against a wall.
 */

export const ARRIVE_RADIUS = 0.2; // tiles: close enough = arrived
export const TAP_SECONDS = 0.25; // presses shorter than this persist a target
export const STALL_SECONDS = 0.6; // autopilot progress timeout
const STALL_EPSILON = 0.004; // tiles per step below which we count as stuck

export interface ClickMoveState {
  /** Persisted walk-to target (world coords) — the tap-to-move autopilot. */
  target: Vec2 | null;
  /** LMB currently held for steering (pressed on ground). */
  holding: boolean;
  /** LMB went down on a monster; keeps attacking while held. */
  attacking: boolean;
  wasHeld: boolean;
  heldFor: number;
  stall: number;
  lastPos: Vec2 | null;
}

export function createClickMove(): ClickMoveState {
  return { target: null, holding: false, attacking: false, wasHeld: false, heldFor: 0, stall: 0, lastPos: null };
}

export interface ClickMoveFrame {
  playerPos: Vec2;
  /** Cursor mapped to world/ground coords by the host (null: off-map). */
  cursorWorld: Vec2 | null;
  lmbHeld: boolean;
  /** Cursor is over a live monster (host decides — it owns the state read). */
  hoverMonster: boolean;
  /** WASD active this step: keyboard always wins over the mouse. */
  keyboardMove: boolean;
  dt: number;
}

export interface ClickMoveOut {
  /** Normalized move direction to substitute into the intent, or null. */
  move: Vec2 | null;
  /** Cast slot 1 (the mode-on replacement for the raw LMB->slot1 alias). */
  attack: boolean;
}

export function stepClickMove(s: ClickMoveState, f: ClickMoveFrame): ClickMoveOut {
  const pressed = f.lmbHeld && !s.wasHeld;
  const released = !f.lmbHeld && s.wasHeld;
  s.wasHeld = f.lmbHeld;

  if (f.keyboardMove) {
    s.target = null;
    s.holding = false;
    s.stall = 0;
  }

  if (pressed) {
    s.heldFor = 0;
    if (f.hoverMonster) {
      s.attacking = true;
      s.holding = false;
      s.target = null;
    } else if (f.cursorWorld && !f.keyboardMove) {
      s.holding = true;
      s.target = { x: f.cursorWorld.x, y: f.cursorWorld.y };
    }
  }
  if (f.lmbHeld) {
    s.heldFor += f.dt;
    if (s.holding && f.cursorWorld) s.target = { x: f.cursorWorld.x, y: f.cursorWorld.y };
  }
  if (released) {
    s.attacking = false;
    if (s.holding) {
      s.holding = false;
      // A quick tap commits the autopilot; releasing a longer steer stops.
      if (s.heldFor >= TAP_SECONDS) s.target = null;
    }
  }

  let move: Vec2 | null = null;
  if (s.target && !s.attacking) {
    const dx = s.target.x - f.playerPos.x;
    const dy = s.target.y - f.playerPos.y;
    const d = Math.hypot(dx, dy);
    if (d <= ARRIVE_RADIUS) {
      s.target = null;
      s.stall = 0;
    } else {
      move = { x: dx / d, y: dy / d };
      if (!s.holding) {
        // Autopilot only: give up on targets we stop progressing toward.
        const stepped = s.lastPos
          ? Math.hypot(f.playerPos.x - s.lastPos.x, f.playerPos.y - s.lastPos.y)
          : Infinity;
        if (stepped < STALL_EPSILON) {
          s.stall += f.dt;
          if (s.stall >= STALL_SECONDS) {
            s.target = null;
            s.stall = 0;
            move = null;
          }
        } else {
          s.stall = 0;
        }
      } else {
        s.stall = 0;
      }
    }
  }
  s.lastPos = { x: f.playerPos.x, y: f.playerPos.y };
  return { move, attack: s.attacking && f.lmbHeld };
}
