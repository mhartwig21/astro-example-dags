import type { Vec2 } from "../sim/types";
import type { BindableAction } from "./bindings";

/**
 * Gamepad (controller) input — the third Intent producer beside keyboard/mouse
 * (input.ts) and, eventually, touch. Same seam: raw device state becomes an
 * Intent fragment the host merges in sampleIntent(); the sim never knows a
 * controller exists, so multiplayer works unchanged.
 *
 * The mapping core (mapPad) is a pure function over axis/button snapshots so
 * tests can drive it without a browser Gamepad object. The GamepadController
 * class is the thin DOM shell: polls navigator.getGamepads() once per frame
 * (the Gamepad API is polling-based — no button events), tracks press edges,
 * and owns rumble.
 *
 * Layout (standard mapping, twin-stick ARPG):
 *   left stick   move            right stick  aim (overrides mouse aim)
 *   A/Cross      slot 1          X/Square     slot 2
 *   B/Circle     slot 3          Y/Triangle   slot 4
 *   RT           ultimate        LB           flask
 *   RB           stairs/descend  LT           ping
 *   Start        inventory       Back/Select  crawler profile
 *   D-pad up     claim draft     D-pad down   abilities
 */

// Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping).
const BTN = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5, lt: 6, rt: 7,
  back: 8, start: 9,
  dpadUp: 12, dpadDown: 13,
} as const;

/** Analog triggers count as pressed past this value. */
const TRIGGER_ON = 0.35;
/** Radial dead zones: movement forgiving, aim stiffer so it never drift-aims. */
const MOVE_DEADZONE = 0.18;
const AIM_DEADZONE = 0.32;

export interface PadButton {
  pressed: boolean;
  value: number;
}

/** One frame of controller input, in SCREEN convention (x right, y down). */
export interface PadSample {
  move: Vec2 | null; // left stick past dead zone, else null
  aim: Vec2 | null; // right stick past dead zone, else null
  cast: boolean[]; // held: slots 0-3 + ultimate (matches Intent.cast)
  flaskEdge: boolean;
  stairsEdge: boolean;
  pingEdge: boolean;
  actions: BindableAction[]; // edge-triggered panel toggles
  active: boolean; // any deflection or held button — drives device switching
}

function stick(x: number, y: number, deadzone: number): Vec2 | null {
  const len = Math.hypot(x, y);
  return len >= deadzone ? { x, y } : null;
}

/**
 * Rotate a screen-space vector (x right, y down) into sim/world coordinates
 * for the iso camera. The camera sits along THEME.camDir {1, ·, 1} looking at
 * the player, so screen-up on the ground plane is world (-1,-1)/√2 and
 * screen-right is world (1,-1)/√2 — one fixed -45° rotation. The 2D host is
 * axis-aligned top-down and skips this.
 */
export function isoRotate(v: Vec2): Vec2 {
  const s = Math.SQRT1_2;
  return { x: (v.x + v.y) * s, y: (v.y - v.x) * s };
}

/**
 * Pure mapping: device snapshot + previous pressed-state -> PadSample + the
 * pressed-state to carry to the next frame (edges need it).
 */
export function mapPad(
  axes: readonly number[],
  buttons: readonly PadButton[],
  prev: readonly boolean[],
): { sample: PadSample; pressed: boolean[] } {
  const held = (i: number): boolean => {
    const b = buttons[i];
    if (!b) return false;
    return i === BTN.lt || i === BTN.rt ? b.value >= TRIGGER_ON || b.pressed : b.pressed;
  };
  const pressed = buttons.map((_, i) => held(i));
  const edge = (i: number): boolean => pressed[i] && !prev[i];

  const move = stick(axes[0] ?? 0, axes[1] ?? 0, MOVE_DEADZONE);
  const aim = stick(axes[2] ?? 0, axes[3] ?? 0, AIM_DEADZONE);

  const cast = [held(BTN.a), held(BTN.x), held(BTN.b), held(BTN.y), held(BTN.rt)];

  const actions: BindableAction[] = [];
  if (edge(BTN.start)) actions.push("inventory");
  if (edge(BTN.back)) actions.push("character");
  if (edge(BTN.dpadUp)) actions.push("draft");
  if (edge(BTN.dpadDown)) actions.push("abilities");

  return {
    sample: {
      move,
      aim,
      cast,
      flaskEdge: edge(BTN.lb),
      stairsEdge: edge(BTN.rb),
      pingEdge: edge(BTN.lt),
      actions,
      active: move !== null || aim !== null || pressed.some(Boolean),
    },
    pressed,
  };
}

export class GamepadController {
  /** Connected pad id, or null. Drives the HUD legend + connect toasts. */
  connected: string | null = null;
  /** Host-clock time of the last real input — device-switch arbitration. */
  lastInputAt = -Infinity;
  onConnect: ((id: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  /** Same contract as InputController.onAction (panel toggles). */
  onAction: ((action: BindableAction) => void) | null = null;
  /** Suppress gameplay buttons while a panel captures input (parity with keys). */
  captureMode = false;

  private prev: boolean[] = [];
  private padIndex = -1;

  constructor() {
    window.addEventListener("gamepadconnected", (e) => {
      this.connected = e.gamepad.id;
      this.padIndex = e.gamepad.index;
      this.onConnect?.(e.gamepad.id);
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.connected = null;
      this.padIndex = -1;
      this.prev = [];
      this.onDisconnect?.();
    });
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.padIndex >= 0 && pads[this.padIndex]) return pads[this.padIndex];
    // Some browsers only surface pads via the poll — adopt the first live one.
    for (const p of pads) {
      if (p) {
        this.padIndex = p.index;
        if (!this.connected) {
          this.connected = p.id;
          this.onConnect?.(p.id);
        }
        return p;
      }
    }
    return null;
  }

  /** Poll once per frame. Fires onAction edges; returns null with no pad. */
  poll(now: number): PadSample | null {
    const pad = this.pad();
    if (!pad) return null;
    const { sample, pressed } = mapPad(pad.axes, pad.buttons, this.prev);
    this.prev = pressed;
    if (sample.active) this.lastInputAt = now;
    if (this.captureMode) return null; // a panel owns input; edges already consumed
    for (const a of sample.actions) this.onAction?.(a);
    return sample;
  }

  /** Dual-rumble pulse, best-effort (typed loosely — lib.dom lags the spec). */
  rumble(strong: number, weak: number, ms: number): void {
    const pad = this.pad() as (Gamepad & {
      vibrationActuator?: { playEffect?: (type: string, p: object) => Promise<unknown> };
    }) | null;
    pad?.vibrationActuator?.playEffect?.("dual-rumble", {
      startDelay: 0,
      duration: ms,
      strongMagnitude: Math.min(1, Math.max(0, strong)),
      weakMagnitude: Math.min(1, Math.max(0, weak)),
    })?.catch?.(() => {/* rumble is garnish — never let it throw */});
  }
}
