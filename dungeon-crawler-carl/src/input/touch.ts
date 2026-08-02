import type { Vec2 } from "../sim/types";
import {
  computeZones, hitControl, hitZone, inRect, AIM_SLOP, DEFAULT_LAYOUT_PREFS,
  type ControlId, type Rect, type ZoneTable,
} from "./touchLayout";

export { AIM_SLOP };

/**
 * Touch controls — the third Intent producer beside keyboard/mouse (input.ts)
 * and gamepad (gamepad.ts). Same seam, same rule: fingers become an Intent
 * fragment the host merges in sampleIntent(), and the sim never learns a
 * finger exists.
 *
 * THE STATE MACHINE (MOBILE.md 2)
 *
 *   stick      floating origin, dead zone, recentring past 1.35 R, a resting
 *              ghost at the last lift, and a flick recogniser that reads RAW
 *              pointer velocity (recentring clamps displacement, so a flick
 *              measured from displacement is unmeasurable).
 *   ability    IDLE -> PRESSED -(travel > AIM_SLOP from a LEAKY origin)->
 *              AIMING -> CANCEL. TRAVEL ONLY: no time term exists in this
 *              machine, at any threshold, in any mode. The origin follows the
 *              finger at ORIGIN_LEAK while PRESSED and freezes on promotion,
 *              which is what makes a 3-second hold a tap and a 300 px/s drag
 *              an aim without consulting a clock.
 *   world      ONE threshold: travel <= TAP_TRAVEL and released before the
 *              ping arms = move order at any duration; held to LONG_PRESS_MS
 *              = ping; travel past TAP_TRAVEL aborts both. No dead band.
 *
 * INPUT AUTHORITY. Gameplay is live iff the suspend-reason set is empty
 * (suspend/resume, refcounted, eight enumerated reasons) — plus an 8-second
 * stuck-pointer reaper for the platform paths that fire no event at all.
 *
 * Every gesture has exactly ONE owner, decided at pointerdown by the
 * precedence in routeDown() and never reassigned. Two fingers are two
 * pointerIds with two roles, which is why moving while aiming simply works.
 *
 * INTERRUPTION IS A REFUND. A modal opening, an orientation change, or a
 * browser pointercancel all resolve a live gesture as {kind:"cancel"} — no
 * cooldown, no charge, no queued cast, and the trailing pointerup is eaten so
 * a stale drag cannot detonate when the panel closes.
 *
 * The state machines (VirtualStick, AbilityButton) are pure — the tests drive
 * them with coordinates and no DOM. TouchController is the routing shell.
 */

// ---------------------------------------------------------------- tunables
/** Movement dead zone as a fraction of stick radius. */
export const STICK_DEADZONE = 0.14;
/** Past this many radii from the origin, the origin slides under the thumb. */
export const RECENTER_AT = 1.35;
/**
 * THE PRESS ORIGIN FOLLOWS THE FINGER AT 40 CSS px/s (~6.6 mm/s) WHILE
 * PRESSED, AND FREEZES ON PROMOTION TO AIMING (MOBILE.md 2.4a).
 *
 * Deleting the old dwell term was necessary and not sufficient. A stationary
 * thumb is not stationary: as the pad flattens under pressure the reported
 * contact centroid creeps 1-4 mm over 300-800 ms, which is 6-24 CSS px — so a
 * 500 ms tap crossed a fixed 18 px travel threshold without the player moving
 * their thumb at all.
 *
 * 40 px/s sits above every drift regime and an order of magnitude below every
 * deliberate one. The consequences are arithmetic, and they are the test rows:
 * 12 px/s of centroid creep and 30 px/s of bus-and-shaky-hand drift never
 * promote at any duration; a deliberate slow aim at 100 px/s promotes after
 * 18/(100-40) = 300 ms; an ordinary 300 px/s drag after 69 ms; a 900 px/s
 * flick-aim after 21 ms.
 */
export const ORIGIN_LEAK = 40;
/** World-zone tap: this much travel, at ANY duration. There is no tap ceiling. */
export const TAP_TRAVEL = 16;
/**
 * The ONLY time threshold in the world recogniser (MOBILE.md 2.5a).
 *
 * The old pair (tap = up within 200 ms, long press = 450 ms held) left the
 * 200-450 ms band assigned to nothing — traced in the shipped router it was
 * literally `else { }` — and that is exactly the band a deliberate tap under
 * combat load lands in. The failure mode is the worst available: the finger
 * lifts and the game does not respond, which reads as a dropped input rather
 * than a rejected one. `TAP_MS` is deleted; a release before the ping arms is
 * a move order at 40 ms or at 400 ms.
 */
export const LONG_PRESS_MS = 450;
/** Two pointers landing this close together are a two-finger candidate. */
export const TWO_FINGER_WINDOW = 120;
/** ...and they must both lift this fast to count as a dash tap. */
export const TWO_FINGER_UP = 200;
/**
 * Stick flick that fires a dash: radii per second, sustained over two
 * consecutive samples AND covering real ground in each of them.
 *
 * MOBILE.md 2.6 specifies 2.6 R/s. Do the arithmetic on a phone: R is about
 * 55 px, so 2.6 R/s is 143 px/s — a thumb steering a chase clears that
 * constantly, and the dash would fire on ordinary movement. A deliberate flick
 * covers 1.5-2 R in 60-80 ms, i.e. 20-30 R/s. The threshold is set where a
 * flick actually lives, and the per-sample floor keeps a slow drag sampled at
 * a slow frame rate from adding up to one.
 */
export const FLICK_R_PER_S = 12;
/** ...and each of those samples must move at least this fraction of R. */
export const FLICK_MIN_STEP_R = 0.25;
export const FLICK_DEBOUNCE_MS = 350;
/** A queued second cast lives this long, and only one is ever held. */
export const QUEUE_MS = 250;
/** After the LAST suspend reason clears, pointers are deaf for this long. */
export const MODAL_GATE_MS = 120;
/**
 * A pointer role with no move and no lift for this long is reaped.
 *
 * The belt to `hidden`'s braces: iOS Safari does not reliably fire
 * pointercancel when the page is backgrounded, an incoming call arrives, or
 * the notification shade is pulled — the captured pointer simply stops
 * existing and the stick stays pushed. There is no legitimate 8-second
 * motionless hold in this game (the basic-attack chip repeats on castHeld,
 * which the reaper releases, and a player genuinely still holding it
 * re-presses in one frame), so the layer never trusts a pointer to tell it
 * when it died.
 */
export const POINTER_TTL = 8000;

/**
 * WHY THIS IS A SET AND NOT A BOOLEAN (MOBILE.md 2.9a).
 *
 * The shipped fix was `setModalOpen(boolean)` driven by a hand-maintained list
 * of nine element IDs, which missed six live overlays (#ladder, #career,
 * #consent, #loading, #recap-tab and #rotate — the one overlay that
 * deliberately outranks everything), missed every non-full-screen [data-sheet],
 * and missed every path that fires no DOM event at all. A boolean also
 * un-suspends on the FIRST close when two reasons overlap: descending opens
 * the SPONSOR DRAFT on top of the safe room, measured.
 */
export type SuspendReason =
  | "modal"          // body.modal, and ONLY body.modal
  | "sheet"          // a visible [data-sheet] bottom sheet
  | "rotate-gate"    // #rotate; z 40, deliberately outranks body.modal
  | "orientation"    // held until 250ms after the last visualViewport resize
  | "hidden"         // visibilitychange -> hidden, pagehide, window.blur
  | "not-playing"    // state.status !== "playing"
  | "editor"         // CUSTOMISE CONTROLS
  | "system-gesture"; // contextmenu, iOS gesturestart

export type CastMode = "tap" | "tap-release" | "aim-only";

// ------------------------------------------------------------ virtual stick
export class VirtualStick {
  origin: Vec2 | null = null;
  /** Last lift position — the resting ghost ring sits here. */
  rest: Vec2 | null = null;
  recenter = true;
  private raw: Vec2 = { x: 0, y: 0 };
  private out: Vec2 = { x: 0, y: 0 };
  private nubOut: Vec2 = { x: 0, y: 0 };
  private flickOut: Vec2 = { x: 0, y: 0 };
  private prev: { x: number; y: number; t: number } | null = null;
  private fastFor = 0; // consecutive samples over the flick speed
  private flickDir: Vec2 | null = null;
  private lastFlickAt = -Infinity;

  constructor(public radius = 60) {}

  down(x: number, y: number, t = 0): void {
    this.origin = { x, y };
    this.raw.x = 0; this.raw.y = 0;
    this.prev = { x, y, t };
    this.fastFor = 0;
    this.flickDir = null;
  }

  move(x: number, y: number, t = 0): void {
    const o = this.origin;
    if (!o) return;
    // 1. FLICK FIRST, from raw velocity — recentring below clamps displacement
    //    to 1.0 R and would otherwise make a fast flick unmeasurable.
    const p = this.prev;
    if (p) {
      const dt = (t - p.t) / 1000;
      const dx = x - p.x, dy = y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dt > 0.0005) {
        const speed = dist / dt; // px/s
        if (speed >= FLICK_R_PER_S * this.radius && dist >= FLICK_MIN_STEP_R * this.radius) {
          this.fastFor++;
          if (this.fastFor >= 2 && t - this.lastFlickAt >= FLICK_DEBOUNCE_MS) {
            this.lastFlickAt = t;
            this.flickOut.x = dx / dist; this.flickOut.y = dy / dist;
            this.flickDir = this.flickOut;
            this.fastFor = 0;
          }
        } else {
          this.fastFor = 0;
        }
      }
    }
    this.prev = { x, y, t };

    // 2. displacement, clamped to the ring
    let dx = (x - o.x) / this.radius;
    let dy = (y - o.y) / this.radius;
    const len = Math.hypot(dx, dy);
    // 3. RECENTRING: past 1.35 R the origin slides along the finger vector so
    //    the finger sits at exactly 1.0 R. The stick can never run out under a
    //    thumb that drifts up the screen, and direction never inverts.
    if (this.recenter && len > RECENTER_AT) {
      const ux = dx / len, uy = dy / len;
      o.x = x - ux * this.radius;
      o.y = y - uy * this.radius;
      dx = ux; dy = uy;
    } else if (len > 1) {
      dx /= len; dy /= len;
    }
    this.raw.x = dx; this.raw.y = dy;
  }

  up(): void {
    if (this.origin) this.rest = { x: this.origin.x, y: this.origin.y };
    this.origin = null;
    this.raw.x = 0; this.raw.y = 0;
    this.prev = null;
    this.fastFor = 0;
    this.flickDir = null;
  }

  /** One-shot: the flick direction if one just happened, else null. */
  takeFlick(): Vec2 | null {
    const f = this.flickDir;
    this.flickDir = null;
    return f;
  }

  /**
   * Screen-space direction past the dead zone, else null. The vector is a
   * REUSED object — read it, do not retain it (zero steady-state allocation
   * is a frame-budget rule, MOBILE.md 7.2).
   */
  get value(): Vec2 | null {
    if (Math.hypot(this.raw.x, this.raw.y) < STICK_DEADZONE) return null;
    this.out.x = this.raw.x; this.out.y = this.raw.y;
    return this.out;
  }

  /** Nub offset in px for rendering (clamped to the base ring). Reused object. */
  get nub(): Vec2 {
    this.nubOut.x = this.raw.x * this.radius;
    this.nubOut.y = this.raw.y * this.radius;
    return this.nubOut;
  }
}

// ----------------------------------------------------------- ability button
/** What a finished chip press means. */
export type SlotRelease =
  | { kind: "tap" } // smart cast — host picks the target
  | { kind: "aimed"; aim: Vec2; frac: number } // drag-cast: direction + range fraction
  | { kind: "cancel" };

export type ButtonState = "idle" | "pressed" | "aiming" | "cancel";

export class AbilityButton {
  state: ButtonState = "idle";
  mode: CastMode = "tap-release";
  /** Live CANCEL band rect (screen px); null while none is painted. */
  cancelBand: Rect | null = null;
  /**
   * Drag length that means "maximum range" — its OWN hand-scale quantity
   * (18 mm, 88-124 CSS px), not the movement stick's radius on the other hand.
   * Borrowing R made the full-range throw span 36-123 px across the matrix,
   * and at the small end the entire aim range lived inside the cancel radius:
   * maximum range and "never mind" were the same gesture (MOBILE.md 2.4b).
   */
  aimThrow = 109;
  /** Set from the zone table: clamp(0.34 * aimThrow, 30, 42). */
  cancelRadius = 37;
  /**
   * The press origin. LEAKY while PRESSED (see ORIGIN_LEAK), FROZEN the
   * instant the state promotes to AIMING — the aim vector, the range fraction
   * and the cancel radius are all measured from the frozen point, so the leak
   * can never distort an aim in progress.
   */
  private origin: Vec2 | null = null;
  private current: Vec2 = { x: 0, y: 0 };
  /** Previous reported contact: what the leak chases. See move(). */
  private last: Vec2 = { x: 0, y: 0 };
  private lastT = 0;
  private aimOut: Vec2 = { x: 0, y: 0 };
  /**
   * The return-home cancel only ARMS once the thumb has actually left the
   * cancel radius, so a short aim is never born already cancelled. With the
   * ordering AIM_SLOP < cancelRadius < 0.5 * aimThrow asserted in
   * computeZones(), a promotion at 18 px is always INSIDE the cancel radius,
   * which is exactly why this latch has to exist.
   */
  private armed = false;

  /** Returns true when the mode says "fire on touchdown" (tap mode). */
  down(x: number, y: number, t = 0): boolean {
    this.origin = { x, y };
    this.current.x = x; this.current.y = y;
    this.last.x = x; this.last.y = y;
    this.lastT = t;
    this.state = "pressed";
    this.armed = false;
    return this.mode === "tap";
  }

  move(x: number, y: number, t = this.lastT): void {
    const o = this.origin;
    if (!o) return;
    if (this.state === "pressed") {
      // THE LEAK CHASES THE PREVIOUS CONTACT POINT, NOT THIS ONE.
      //
      // Leaking toward the current sample would drag the origin along with a
      // deliberate flick — the faster the drag, the faster the origin runs
      // after it, and nothing would ever promote. Chasing where the finger
      // already WAS makes the origin a rate-limited follower with exactly one
      // sample of lag, which is the continuous model the numbers above were
      // derived from: travel grows at (v - ORIGIN_LEAK) for v > ORIGIN_LEAK,
      // and does not grow at all below it.
      const dt = Math.max(0, (t - this.lastT) / 1000);
      const gx = this.last.x - o.x, gy = this.last.y - o.y;
      const g = Math.hypot(gx, gy);
      const step = Math.min(g, ORIGIN_LEAK * dt);
      if (g > 1e-6 && step > 0) { o.x += (gx / g) * step; o.y += (gy / g) * step; }
    }
    this.last.x = x; this.last.y = y;
    this.lastT = t;
    this.current.x = x; this.current.y = y;
    const travel = Math.hypot(x - o.x, y - o.y);
    // TRAVEL ONLY. No time term exists in this machine, at any threshold, in
    // any mode: every platform that has shipped a tap recogniser to a billion
    // hands agrees that duration does not classify a tap.
    if (this.state === "pressed" && travel > AIM_SLOP) this.state = "aiming";
    if (travel > this.cancelRadius) this.armed = true;
    if (this.state === "aiming" || this.state === "cancel") {
      const bail = (this.armed && travel <= this.cancelRadius) ||
        (this.cancelBand !== null && inRect(this.cancelBand, x, y));
      this.state = bail ? "cancel" : "aiming";
    }
  }

  /** Raw screen drag vector while aiming (reused object), else null. */
  get aimDir(): Vec2 | null {
    const o = this.origin;
    if (!o || this.state !== "aiming") return null;
    this.aimOut.x = this.current.x - o.x;
    this.aimOut.y = this.current.y - o.y;
    return this.aimOut;
  }

  /**
   * 0..1 of the ability real range. OVER-THROW IS FREE: any drag past
   * `aimThrow` clamps to 1.0, because the thumb runs out of screen long before
   * it runs out of intent on a 342 px-tall viewport, and punishing that would
   * be punishing the device.
   */
  get aimFrac(): number {
    const o = this.origin;
    if (!o) return 0;
    const m = Math.hypot(this.current.x - o.x, this.current.y - o.y);
    return Math.max(0, Math.min(1, m / Math.max(1, this.aimThrow)));
  }

  get inCancel(): boolean { return this.state === "cancel"; }

  up(): SlotRelease {
    const o = this.origin;
    const st = this.state;
    this.origin = null;
    this.state = "idle";
    if (!o) return { kind: "cancel" };
    if (st === "cancel") return { kind: "cancel" };
    if (st === "pressed") {
      // THE TAP BAND: 0 -> 18 px of leak-corrected travel, at ANY duration.
      // A 40 ms tap and a 3 s hold-and-release produce a byte-identical
      // Intent, and test/touchIntent.test.ts asserts equality, not similarity.
      //
      // aim-only exists so an ultimate can be made to REQUIRE a drag: a
      // release below the slop is a change of mind, not a cheap cast.
      return this.mode === "aim-only" ? { kind: "cancel" } : { kind: "tap" };
    }
    const ax = this.current.x - o.x, ay = this.current.y - o.y;
    const mag = Math.hypot(ax, ay);
    // A drag that went out and came home is a change of heart, not a cast.
    if (this.armed && mag <= this.cancelRadius) return { kind: "cancel" };
    // A DEFENSIVE FLOOR, DOCUMENTED AS UNREACHABLE BY CONSTRUCTION. The old
    // "release below the stick dead zone resolves as a smart cast" special
    // case was unreachable at defaults (0.14 x 55 = 7.7 px, well inside the
    // 34 px cancel radius) and UNDEFINED at other slider positions, because
    // cancelRadius scaled with buttonScale and the slop did not. With
    // AIM_SLOP < cancelRadius asserted, an unarmed release below the slop can
    // only happen if a host drove move() out of order; it still resolves as a
    // smart cast rather than a zero-length aim.
    if (mag < AIM_SLOP) return { kind: "tap" };
    return {
      kind: "aimed", aim: { x: ax, y: ay },
      frac: Math.max(0, Math.min(1, mag / Math.max(1, this.aimThrow))),
    };
  }

  /** Interruption: refund-identical to a cancel-band exit. */
  interrupt(): SlotRelease {
    this.origin = null;
    this.state = "idle";
    this.armed = false;
    return { kind: "cancel" };
  }
}

/** Kept for the older name used by test/touch.test.ts and the shell. */
export const SlotButton = AbilityButton;
export type SlotButton = AbilityButton;

// ------------------------------------------------------------------ sample
export interface CastEdge { slot: number; aim: Vec2 | null; frac: number }
export interface WorldTap { x: number; y: number; long: boolean }

/** One frame of touch input, in SCREEN convention (host applies isoRotate). */
export interface TouchSample {
  move: Vec2 | null;
  /** Slot with a finger DOWN on it (indicator shows from the first frame). */
  pressedSlot: number;
  /** Slot being drag-aimed right now (-1 none) + its live direction. */
  aimingSlot: number;
  aimDir: Vec2 | null;
  /** 0..1 of the ability real range. */
  aimFrac: number;
  /** The aim is currently in its CANCEL state (host paints the dashed form). */
  aimCancel: boolean;
  /** Held casts (attack chip while pressed). Indices match Intent.cast. */
  castHeld: boolean[];
  /** One-shot casts released since the last sample. */
  castEdges: CastEdge[];
  flaskEdge: boolean;
  /** The context chip: descend / talk / open — maps to Intent.useStairs. */
  stairsEdge: boolean;
  mapEdge: boolean;
  lockToggleEdge: boolean;
  /** Flick-on-stick or two-finger tap; the host casts whatever slot holds dash. */
  dashEdge: boolean;
  /** Screen-space world-zone taps for the host to raycast. */
  worldTaps: WorldTap[];
  active: boolean;
}

type RoleKind = "stick" | "chip" | "world" | "two" | "dead" | "ignored";

interface PointerRole {
  kind: RoleKind;
  control?: ControlId;
  slot?: number;
  x0: number; y0: number;
  /** EVENT time of the press: compared only against other event stamps. */
  t0: number;
  /** LOCAL time of the press: compared only against this.now(). */
  tLocal: number;
  /** LOCAL time of the last event on this pointer — the TTL reaper reads it. */
  seen: number;
  moved: number;
  consumed: boolean; // resolved early: the lift must not also produce a tap
  armed?: boolean; // held past the long-press threshold; the ping is armed
}

const SLOT_OF: Partial<Record<ControlId, number>> = {
  slot0: 0, slot1: 1, slot2: 2, slot3: 3, slot4: 4,
};

export class TouchController {
  readonly stick = new VirtualStick();
  /** Gate every handler; the K panel toggle flips this live (see setEnabled). */
  enabled = true;
  /** Host clock (s) of the last touch — device-switch arbitration. */
  lastInputAt = -Infinity;
  /** Fires when the stick spawns/moves/lifts so the shell can draw it. */
  onStick: ((origin: Vec2 | null, nub: Vec2) => void) | null = null;
  /** Fires on every state change the shell paints inside the same frame. */
  onFeedback: ((ev: TouchFeedback) => void) | null = null;
  /** Host answer to "may this slot cast right now" (cooldown / charges). */
  canCast: ((slot: number) => boolean) | null = null;
  /** Fired on every accepted gameplay press: the host dismisses transient UI. */
  onGameplayInput: (() => void) | null = null;
  /**
   * ONE CLOCK, in milliseconds, and it is NOT PointerEvent.timeStamp.
   *
   * Measured: events synthesised through CDP (which is how the device harness
   * drives real multi-touch) carry a timeStamp on a different origin from
   * performance.now(). Every duration in this file was therefore nonsense
   * under test — a 110 ms tap was classified as a 450 ms long press and
   * dropped a ping instead of a move order. Reading our own clock at handling
   * time is accurate to a frame and cannot be lied to.
   */
  now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  /**
   * When a gesture HAPPENED, not when we got round to it.
   *
   * PointerEvent.timeStamp is the moment the browser saw the finger; our own
   * clock is the moment the main thread got free to tell us. On a phone
   * dropping frames — or under a software renderer at 2 fps — those differ by
   * whole frames, and a 110 ms tap gets classified as a 450 ms long press and
   * drops a ping instead of a move order (measured, exactly that). Event time
   * decides every duration WITHIN a gesture (down vs up on the same finger).
   *
   * The two clocks are never compared to each other. Anything judged in
   * sample() — the long-press arm, the queue expiry, the modal input gate —
   * reads this.now(); anything judged between two pointer events reads their
   * stamps. Mixing them once cost an afternoon: a gate armed on the local
   * clock was compared against event stamps from a harness whose virtual clock
   * lagged real time by minutes, and every pointer was born dead.
   */
  private stamp(e: PointerLike): number {
    const ts = e.timeStamp;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : this.now();
  }
  /** Per-slot cast mode, from prefs. */
  castModes: CastMode[] = ["tap-release", "tap-release", "tap-release", "tap-release", "tap-release"];
  flickDash = true;
  twoFingerDash = true;

  zones: ZoneTable = computeZones(1280, 720, { top: 0, right: 0, bottom: 0, left: 0 }, DEFAULT_LAYOUT_PREFS);
  /** Measured chip rects (DOM truth), keyed by control. Empty = use zones. */
  private rects = new Map<ControlId, Rect>();

  private roles = new Map<number, PointerRole>();
  private btn = new AbilityButton();
  private aimingSlot = -1;
  private pressedSlot = -1;
  private attackHeld = false;
  private attackLatch = false; // a tap shorter than one sim step still lands
  private readonly reasons = new Set<SuspendReason>();
  private gateUntil = -Infinity;
  private queued: { slot: number; at: number } | null = null;
  private twoCandidate: { ids: number[]; t0: number } | null = null;
  private touched = false;
  private captureEl: Element | null = null;

  // Preallocated: sample() must not allocate (MOBILE.md 7.2).
  private readonly castHeld = [false, false, false, false, false];
  private readonly castEdges: CastEdge[] = [];
  private readonly castPool: CastEdge[] = [];
  private readonly worldTaps: WorldTap[] = [];
  private readonly tapPool: WorldTap[] = [];
  private readonly sampleOut: TouchSample = {
    move: null, pressedSlot: -1, aimingSlot: -1, aimDir: null, aimFrac: 0, aimCancel: false,
    castHeld: this.castHeld, castEdges: this.castEdges, flaskEdge: false, stairsEdge: false,
    mapEdge: false, lockToggleEdge: false, dashEdge: false, worldTaps: this.worldTaps, active: false,
  };
  private flaskPending = false;
  private stairsPending = false;
  private mapPending = false;
  private lockPending = false;
  private dashPending = false;

  // ------------------------------------------------------------- geometry
  /** Recompute-on-layout-change only: never called from a pointer handler. */
  setZones(z: ZoneTable): void {
    this.zones = z;
    this.stick.radius = z.stickRadius;
    // Two different hands, two different quantities, two different sliders.
    this.btn.aimThrow = z.aimThrow;
    this.btn.cancelRadius = z.cancelRadius;
  }

  /** DOM-measured chip rects (the chips keep their CSS home; we cache boxes). */
  setControlRect(id: ControlId, r: Rect | null): void {
    if (r) this.rects.set(id, r); else this.rects.delete(id);
  }

  /**
   * Which control a point claims: measured rects padded to 44px, resolved by
   * NEAREST CENTRE so a press between two chips picks the closer one rather
   * than whichever paints on top. Arithmetic only — no layout reads.
   */
  controlAt(x: number, y: number): ControlId | null {
    if (this.rects.size === 0) return hitControl(this.zones, x, y);
    let best: ControlId | null = null;
    let bestD = Infinity;
    for (const [id, r] of this.rects) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const halfW = Math.max(44, r.w) / 2 + 6, halfH = Math.max(44, r.h) / 2 + 6;
      if (Math.abs(x - cx) > halfW || Math.abs(y - cy) > halfH) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** What a point would route to. Harness and debug only; allocates. */
  debugRoute(x: number, y: number): { control: ControlId | null; zone: string | null } {
    return { control: this.controlAt(x, y), zone: hitZone(this.zones, x, y) };
  }

  // ---------------------------------------------------------------- gates
  /**
   * THE INPUT AUTHORITY (MOBILE.md 2.9a). Idempotent per reason; gameplay
   * input is live iff the reason set is EMPTY.
   *
   * Raising ANY reason resolves every live gameplay pointer as cancel —
   * refund-identical to a cancel-band exit: no cooldown, no charge, no queued
   * cast, stick zeroed the same frame — and marks those pointerIds dead so the
   * trailing lift is routed to nothing.
   *
   * Explicitly NOT reasons: hit-stop and any sim freeze. The
   * acknowledge-inside-one-frame rule exists precisely so a press during a
   * frozen sim looks alive; suspending there would be the opposite of the fix.
   */
  suspend(reason: SuspendReason, now = this.now()): void {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    this.cancelAll(now, false);
  }

  /**
   * Clearing the LAST reason starts a MODAL_GATE_MS deaf frame on the local
   * clock; any pointer still on the glass stays dead until it lifts. Closing a
   * panel with a finger already down must not start a cast, and a panel must
   * not accept the same press that dismissed the thing before it.
   *
   * Refcounted, so draft-over-safe-room resumes only when BOTH are gone — the
   * measured case a boolean got wrong.
   */
  resume(reason: SuspendReason, now = this.now()): void {
    if (!this.reasons.delete(reason)) return;
    if (this.reasons.size === 0) this.gateUntil = now + MODAL_GATE_MS;
  }

  get suspended(): boolean { return this.reasons.size > 0; }
  /** Debug/harness: which reasons are holding input right now. */
  suspendReasons(): SuspendReason[] { return [...this.reasons]; }

  /** Compat shim for the one caller that only knows about panels. */
  setModalOpen(open: boolean, now = this.now()): void {
    if (open) this.suspend("modal", now); else this.resume("modal", now);
  }

  /** Orientation change / disable / suspend: one refund path for all of them. */
  cancelAll(now = this.now(), gate = true): void {
    if (this.aimingSlot >= 0 || this.pressedSlot >= 0) {
      this.btn.interrupt();
      this.onFeedback?.({ kind: "cancel", slot: this.aimingSlot >= 0 ? this.aimingSlot : this.pressedSlot });
    }
    this.aimingSlot = -1;
    this.pressedSlot = -1;
    this.attackHeld = false;
    this.queued = null; // cancelling is a change of mind: no consolation cast
    this.twoCandidate = null;
    for (const [id, role] of this.roles) {
      if (role.kind !== "ignored") this.releaseCapture(id);
      role.kind = "dead"; // the trailing up/cancel is routed to nothing
    }
    this.stick.up();
    this.onStick?.(null, ZERO);
    if (gate) this.gateUntil = now + MODAL_GATE_MS;
  }

  private releaseCapture(id: number): void {
    const el = this.captureEl as (Element & { releasePointerCapture?: (i: number) => void }) | null;
    try { el?.releasePointerCapture?.(id); } catch { /* not captured */ }
  }

  /** Toggle the whole controller. Disabling clears every in-flight press. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.cancelAll();
      this.roles.clear();
      this.attackLatch = false;
      this.castEdges.length = 0;
      this.worldTaps.length = 0;
      this.flaskPending = this.stairsPending = this.mapPending = false;
      this.lockPending = this.dashPending = false;
    }
  }

  // ------------------------------------------------------------- pointers
  /**
   * Bind at the DOCUMENT, capture phase: one router sees every finger, so the
   * world zone (which owns no element) works, and role assignment is one
   * written precedence order instead of whichever element happened to be on
   * top. Mouse events are never claimed — desktop input is untouched.
   */
  bind(root: Document | HTMLElement, capture: Element | null = null): void {
    this.captureEl = capture ?? (typeof document !== "undefined" ? document.body : null);
    const opts = { capture: true, passive: false } as AddEventListenerOptions;
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      root.addEventListener(type, (e) => this.handle(e as PointerEvent), opts);
    }
  }

  /**
   * The one entry point for a pointer event. The DOM is a caller, not a
   * dependency: test/touchIntent.test.ts drives the whole state machine
   * through here with plain objects and no browser.
   */
  handle(e: PointerLike): void {
    switch (e.type) {
      case "pointerdown": this.onDown(e); break;
      case "pointermove": this.onMove(e); break;
      case "pointerup":
      case "pointercancel": this.onUp(e); break;
    }
  }

  /** True when this event belongs to gameplay rather than a panel or button. */
  private isGameplayTarget(e: PointerLike): boolean {
    const t = e.target as (Element & { closest?: (s: string) => Element | null }) | null;
    if (!t || typeof t.closest !== "function") return true;
    if (t.closest("#skills, [data-tctl], #t-stickzone, #t-layer")) return true;
    if (t.closest("#game, #touch")) return true;
    // Display-only chrome that PARKS INSIDE A THUMB ZONE — the minimap and the
    // transient System cards both sit in the left stick zone on a phone, and
    // both used to eat the movement thumb mid-fight. Inside a zone they are
    // gameplay surface; outside one they stay ordinary UI.
    if (t.closest("#minimap-frame, #tutorial, #toasts, #banner")) {
      return hitZone(this.zones, e.clientX, e.clientY) !== null;
    }
    // Anything else is HUD or a panel: let it behave like a web page.
    return false;
  }

  private onDown(e: PointerLike): void {
    if (!this.enabled || e.pointerType === "mouse") return;
    const now = this.stamp(e);
    const local = this.now();
    const deaf = this.reasons.size > 0 || local < this.gateUntil;
    if (deaf || !this.isGameplayTarget(e)) {
      // Deaf, but remembered: the matching up must not fall through to a role.
      if (deaf) {
        this.roles.set(e.pointerId, {
          kind: "dead", x0: e.clientX, y0: e.clientY, t0: now, tLocal: local,
          seen: local, moved: 0, consumed: true,
        });
      }
      return;
    }
    if (this.roles.has(e.pointerId)) return;
    const role = this.routeDown(e, now);
    if (!role) return;
    this.roles.set(e.pointerId, role);
    if (role.kind !== "ignored") {
      // Capture on a STABLE element: #skills rebuilds its chips every frame,
      // and implicit capture on a removed node fires a phantom pointercancel.
      try { (this.captureEl as Element & { setPointerCapture?: (i: number) => void })?.setPointerCapture?.(e.pointerId); } catch { /* fine */ }
      e.preventDefault?.();
      this.onGameplayInput?.();
    }
    this.touched = true;
  }

  /** The precedence table (MOBILE.md 2.10), evaluated top to bottom. */
  private routeDown(e: PointerLike, now: number): PointerRole | null {
    const x = e.clientX, y = e.clientY;
    const local = this.now();
    const base = { x0: x, y0: y, t0: now, tLocal: local, seen: local, moved: 0, consumed: false };
    // 2. a chip
    const ctl = this.chipUnder(e, x, y);
    if (ctl) {
      const slot = SLOT_OF[ctl];
      if (ctl === "flask") { this.flaskPending = true; this.fb("press"); return { kind: "chip", control: ctl, ...base }; }
      if (ctl === "context") { this.stairsPending = true; this.fb("press"); return { kind: "chip", control: ctl, ...base }; }
      if (ctl === "map") { this.mapPending = true; this.fb("press"); return { kind: "chip", control: ctl, ...base }; }
      if (ctl === "lock") { this.lockPending = true; this.fb("press"); return { kind: "chip", control: ctl, ...base }; }
      if (slot === undefined) return { kind: "ignored", ...base };
      // A dead chip must REFUSE at pointerdown, buzz, and never enter AIMING.
      if (this.canCast && !this.canCast(slot)) {
        this.onFeedback?.({ kind: "refused", slot });
        return { kind: "ignored", ...base };
      }
      if (slot === 0) {
        this.attackHeld = true;
        this.attackLatch = true;
        this.onFeedback?.({ kind: "press", slot });
        return { kind: "chip", control: ctl, slot, ...base };
      }
      if (this.aimingSlot >= 0 || this.pressedSlot >= 0) {
        // One aimed cast at a time; a second press queues exactly ONE smart
        // cast, in a single slot, and it dies with the first cast.
        this.queued = { slot, at: this.now() };
        this.onFeedback?.({ kind: "press", slot });
        return { kind: "ignored", ...base };
      }
      this.btn.mode = this.castModes[slot] ?? "tap-release";
      const fireNow = this.btn.down(x, y, now);
      this.pressedSlot = slot;
      this.onFeedback?.({ kind: "press", slot });
      if (fireNow) {
        this.pushCast(slot, null, 0);
        this.btn.interrupt();
        this.pressedSlot = -1;
        return { kind: "ignored", ...base };
      }
      return { kind: "chip", control: ctl, slot, ...base };
    }
    // 3. the stick zone, if no stick pointer is already live
    if (hitZone(this.zones, x, y) === "stick") {
      for (const r of this.roles.values()) if (r.kind === "stick") return { kind: "ignored", ...base };
      this.stick.down(x, y, now);
      this.onStick?.(this.stick.origin, this.stick.nub);
      return { kind: "stick", ...base };
    }
    // 4/5. the world zone: two-finger candidate, else tap / long press
    if (hitZone(this.zones, x, y) === "world") {
      const other = this.liveWorldPointer();
      if (other !== null && now - (this.roles.get(other)?.t0 ?? 0) <= TWO_FINGER_WINDOW) {
        const o = this.roles.get(other)!;
        o.kind = "two";
        this.twoCandidate = { ids: [other, e.pointerId], t0: o.t0 };
        return { kind: "two", ...base };
      }
      return { kind: "world", ...base };
    }
    return { kind: "ignored", ...base };
  }

  private liveWorldPointer(): number | null {
    for (const [id, r] of this.roles) if (r.kind === "world") return id;
    return null;
  }

  /** DOM chip first (it owns its CSS), then the cached-rect arithmetic. */
  private chipUnder(e: PointerLike, x: number, y: number): ControlId | null {
    const t = e.target as (Element & { closest?: (s: string) => Element | null }) | null;
    const el = typeof t?.closest === "function" ? t.closest("[data-tctl], .skill") : null;
    if (el) {
      const ctl = (el as HTMLElement).dataset?.tctl as ControlId | undefined;
      if (ctl) return ctl;
      if ((el as HTMLElement).id === "flask-chip") return "flask";
      const i = Number((el as HTMLElement).dataset?.i ?? -1);
      if (i >= 0 && i <= 4) return `slot${i}` as ControlId;
    }
    return this.controlAt(x, y);
  }

  private onMove(e: PointerLike): void {
    const role = this.roles.get(e.pointerId);
    if (!role || role.kind === "dead") return;
    role.seen = this.now();
    const dx = e.clientX - role.x0, dy = e.clientY - role.y0;
    role.moved = Math.max(role.moved, Math.hypot(dx, dy));
    if (role.kind === "stick") {
      this.stick.move(e.clientX, e.clientY, this.stamp(e));
      if (this.stick.origin) this.onStick?.(this.stick.origin, this.stick.nub);
      if (this.flickDash) {
        const f = this.stick.takeFlick();
        if (f) { this.dashPending = true; this.onFeedback?.({ kind: "dash" }); }
      }
      this.touched = true;
      e.preventDefault?.();
      return;
    }
    if (role.kind === "chip" && role.slot !== undefined && role.slot > 0) {
      const wasAiming = this.aimingSlot >= 0;
      const wasCancel = this.btn.inCancel;
      this.btn.cancelBand = this.zones.cancelBand;
      this.btn.move(e.clientX, e.clientY, this.stamp(e));
      if (this.btn.state === "aiming" || this.btn.state === "cancel") {
        this.aimingSlot = role.slot;
        if (!wasAiming) this.onFeedback?.({ kind: "aimStart", slot: role.slot });
        if (this.btn.inCancel !== wasCancel) {
          this.onFeedback?.({ kind: this.btn.inCancel ? "cancelEnter" : "cancelLeave", slot: role.slot });
        }
      }
      this.touched = true;
      e.preventDefault?.();
    }
  }

  private onUp(e: PointerLike): void {
    const role = this.roles.get(e.pointerId);
    if (!role) return;
    this.roles.delete(e.pointerId);
    const now = this.stamp(e);
    const cancelled = e.type === "pointercancel";
    this.releaseCapture(e.pointerId);
    switch (role.kind) {
      case "dead":
      case "ignored":
        break;
      case "stick":
        this.stick.up();
        this.onStick?.(null, ZERO);
        break;
      case "chip": {
        if (role.slot === 0) { this.attackHeld = false; break; }
        if (role.slot === undefined) break;
        const rel = cancelled ? this.btn.interrupt() : this.btn.up();
        this.aimingSlot = -1;
        this.pressedSlot = -1;
        if (rel.kind === "tap") { this.pushCast(role.slot, null, 0); this.flushQueue(); this.fb("cast"); }
        else if (rel.kind === "aimed") { this.pushCast(role.slot, rel.aim, rel.frac); this.flushQueue(); this.fb("cast"); }
        else { this.queued = null; this.fb("cancel"); } // no consolation prize
        break;
      }
      case "world": {
        if (role.consumed || cancelled) break;
        // ONE THRESHOLD, NOT TWO — there is no dead band, and no third
        // outcome. Every pointerup inside TAP_TRAVEL produces exactly one of
        // two Intents; sliding off past it aborts BOTH and hands the gesture
        // to the camera recogniser.
        //
        // BOTH verdicts come from EVENT time. The threshold crossing only ARMS
        // the ping (ring + buzz, so the hold is acknowledged and the boundary
        // is announced BEFORE it is crossed); the commit happens here, where
        // the true duration is finally known and a lagging frame cannot turn a
        // 110 ms tap into a 450 ms long press — measured, exactly that, when
        // both were read from one clock.
        if (role.moved > TAP_TRAVEL) break;
        const dt = now - role.t0;
        if (dt >= LONG_PRESS_MS) { this.pushTap(role.x0, role.y0, true); this.onFeedback?.({ kind: "ping" }); }
        else { this.pushTap(role.x0, role.y0, false); this.fb("press"); }
        break;
      }
      case "two": {
        const cand = this.twoCandidate;
        this.twoCandidate = null;
        if (!cand || cancelled || !this.twoFingerDash) break;
        // The ONE arbitration point: inside the budget it is a dash tap;
        // outside it, the gesture belongs to the camera recogniser (LATER).
        const partner = cand.ids.find((i) => i !== e.pointerId);
        const p = partner !== undefined ? this.roles.get(partner) : undefined;
        const slow = now - cand.t0 > TWO_FINGER_UP;
        const far = role.moved > TAP_TRAVEL || (p ? p.moved > TAP_TRAVEL : false);
        if (!slow && !far) { this.dashPending = true; this.onFeedback?.({ kind: "dash" }); }
        break;
      }
    }
    this.touched = true;
  }

  private fb(kind: TouchFeedback["kind"]): void {
    this.onFeedback?.({ kind });
  }

  private pushCast(slot: number, aim: Vec2 | null, frac: number): void {
    let e = this.castPool[this.castEdges.length];
    if (!e) { e = { slot, aim: null, frac: 0 }; this.castPool.push(e); }
    e.slot = slot;
    if (aim) {
      if (!e.aim) e.aim = { x: 0, y: 0 };
      e.aim.x = aim.x; e.aim.y = aim.y;
    } else { e.aim = null; }
    e.frac = frac;
    this.castEdges.push(e);
  }

  private pushTap(x: number, y: number, long: boolean): void {
    let t = this.tapPool[this.worldTaps.length];
    if (!t) { t = { x, y, long }; this.tapPool.push(t); }
    t.x = x; t.y = y; t.long = long;
    this.worldTaps.push(t);
  }

  private flushQueue(): void {
    const q = this.queued;
    this.queued = null;
    if (!q || this.now() - q.at > QUEUE_MS) return;
    this.pushCast(q.slot, null, 0);
  }

  // ---------------------------------------------------------------- sample
  /**
   * Poll once per frame (mirrors GamepadController.poll). The returned object
   * and its arrays are REUSED: the host consumes them in the same frame.
   */
  sample(now: number): TouchSample | null {
    const s = this.sampleOut;
    const nowMs = this.now();
    // THE STUCK-POINTER REAPER. A role that has neither moved nor lifted for
    // POINTER_TTL is reaped through the same cancelAll() path, because the
    // platform paths that strand a pointer (backgrounding, an incoming call,
    // the notification shade) emit no DOM event at all.
    for (const role of this.roles.values()) {
      if (role.kind === "dead" || role.kind === "ignored") continue;
      if (nowMs - role.seen >= POINTER_TTL) { this.cancelAll(nowMs); break; }
    }
    for (const role of this.roles.values()) {
      if (role.kind !== "world" || role.consumed || role.armed) continue;
      if (nowMs - role.tLocal >= LONG_PRESS_MS && role.moved <= TAP_TRAVEL) {
        role.armed = true;
        this.onFeedback?.({ kind: "pingArm" });
      }
    }
    if (this.queued && nowMs - this.queued.at > QUEUE_MS) this.queued = null;

    s.move = this.stick.value;
    s.pressedSlot = this.pressedSlot;
    s.aimingSlot = this.aimingSlot;
    s.aimDir = this.aimingSlot >= 0 ? this.btn.aimDir : null;
    s.aimFrac = this.aimingSlot >= 0 ? this.btn.aimFrac : 0;
    s.aimCancel = this.aimingSlot >= 0 && this.btn.inCancel;
    this.castHeld[0] = this.attackHeld || this.attackLatch;
    this.attackLatch = false;
    s.flaskEdge = this.flaskPending;
    s.stairsEdge = this.stairsPending;
    s.mapEdge = this.mapPending;
    s.lockToggleEdge = this.lockPending;
    s.dashEdge = this.dashPending;
    this.flaskPending = this.stairsPending = this.mapPending = false;
    this.lockPending = this.dashPending = false;
    s.active = this.touched || s.move !== null || this.castHeld[0] || this.aimingSlot >= 0 ||
      this.castEdges.length > 0 || this.worldTaps.length > 0 ||
      s.flaskEdge || s.stairsEdge || s.mapEdge || s.lockToggleEdge || s.dashEdge;
    this.touched = false;
    if (s.active) this.lastInputAt = now;
    return s;
  }

  /** Call after the host has read a sample: clears the one-shot buffers. */
  endFrame(): void {
    this.castEdges.length = 0;
    this.worldTaps.length = 0;
  }
}

/**
 * The subset of PointerEvent this layer reads. Structurally satisfied by a
 * real PointerEvent, and by a plain object in a test.
 */
export interface PointerLike {
  type: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  pointerType?: string;
  target?: EventTarget | null;
  preventDefault?: () => void;
}

export interface TouchFeedback {
  kind: "press" | "refused" | "cast" | "cancel" | "aimStart" | "cancelEnter" | "cancelLeave" | "dash" | "ping" | "pingArm";
  slot?: number;
}

const ZERO: Vec2 = { x: 0, y: 0 };