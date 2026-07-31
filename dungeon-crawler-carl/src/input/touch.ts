import type { Vec2 } from "../sim/types";

/**
 * Touch controls (Wild Rift-style) — the third Intent producer beside
 * keyboard/mouse (input.ts) and gamepad (gamepad.ts). Same seam: pointer
 * events become an Intent fragment the host merges in sampleIntent(); the
 * sim never knows a finger exists.
 *
 * Layout contract (markup lives in iso.html, arranged by CSS):
 *   left zone     floating movement stick — touch anywhere, stick spawns
 *                 under the thumb (screen-space; host applies isoRotate)
 *   skill chips   the EXISTING #skills cooldown chips double as buttons:
 *                 chip 0 (attack) is hold-to-attack; chips 1-4 tap to
 *                 quick-cast (auto-aim) or press-drag to aim — a ground
 *                 telegraph previews, release casts, dragging back to the
 *                 chip cancels. Flask chip taps. Delegation binds the
 *                 CONTAINER, so loadout rebuilds never orphan a pointer.
 *   stairs button contextual chip, tap = descend
 *
 * The state machines (VirtualStick, SlotButton) are pure — tests drive them
 * with coordinates, no DOM. TouchController is the pointer-routing shell.
 */

/** Movement dead zone as a fraction of stick radius. */
const STICK_DEADZONE = 0.15;
/** Finger travel (px) that turns a chip press into a drag-aim. */
const DRAG_SLOP = 22;
/** Dragging back within this many px of the press cancels the cast. */
const CANCEL_RADIUS = 34;

export class VirtualStick {
  origin: Vec2 | null = null;
  private raw: Vec2 = { x: 0, y: 0 };
  constructor(readonly radius = 60) {}

  down(x: number, y: number): void {
    this.origin = { x, y };
    this.raw = { x: 0, y: 0 };
  }

  move(x: number, y: number): void {
    if (!this.origin) return;
    let dx = (x - this.origin.x) / this.radius;
    let dy = (y - this.origin.y) / this.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    this.raw = { x: dx, y: dy };
  }

  up(): void {
    this.origin = null;
    this.raw = { x: 0, y: 0 };
  }

  /** Screen-space direction past the dead zone, else null. */
  get value(): Vec2 | null {
    return Math.hypot(this.raw.x, this.raw.y) >= STICK_DEADZONE ? { ...this.raw } : null;
  }

  /** Nub offset in px for rendering (clamped to the base ring). */
  get nub(): Vec2 {
    return { x: this.raw.x * this.radius, y: this.raw.y * this.radius };
  }
}

/** What a finished chip press means. */
export type SlotRelease =
  | { kind: "tap" } // quick cast — host supplies auto-aim
  | { kind: "aimed"; aim: Vec2 } // drag-cast along this screen direction
  | { kind: "cancel" };

export class SlotButton {
  private origin: Vec2 | null = null;
  private current: Vec2 = { x: 0, y: 0 };
  private dragged = false;

  down(x: number, y: number): void {
    this.origin = { x, y };
    this.current = { x, y };
    this.dragged = false;
  }

  move(x: number, y: number): void {
    if (!this.origin) return;
    this.current = { x, y };
    if (Math.hypot(x - this.origin.x, y - this.origin.y) > DRAG_SLOP) this.dragged = true;
  }

  /** Live aim direction while drag-aiming (screen space), else null. */
  get aimDir(): Vec2 | null {
    if (!this.origin || !this.dragged) return null;
    const dx = this.current.x - this.origin.x;
    const dy = this.current.y - this.origin.y;
    if (Math.hypot(dx, dy) <= CANCEL_RADIUS) return null; // in the cancel zone
    return { x: dx, y: dy };
  }

  up(): SlotRelease {
    const o = this.origin;
    this.origin = null;
    if (!o) return { kind: "cancel" };
    if (!this.dragged) return { kind: "tap" };
    const aim = { x: this.current.x - o.x, y: this.current.y - o.y };
    // A drag that came home is a change of heart, not a cast.
    if (Math.hypot(aim.x, aim.y) <= CANCEL_RADIUS) return { kind: "cancel" };
    return { kind: "aimed", aim };
  }
}

/** One frame of touch input, in SCREEN convention (host applies isoRotate). */
export interface TouchSample {
  move: Vec2 | null;
  /** Slot being drag-aimed right now (-1 none) + its live direction. */
  aimingSlot: number;
  aimDir: Vec2 | null;
  /** Held casts (attack chip while pressed). Indices match Intent.cast. */
  castHeld: boolean[];
  /** One-shot casts released since the last sample: slot -> aim (null = tap). */
  castEdges: { slot: number; aim: Vec2 | null }[];
  flaskEdge: boolean;
  stairsEdge: boolean;
  active: boolean;
}

interface PointerRole {
  kind: "stick" | "attack" | "slot" | "flask" | "stairs";
  slot?: number;
}

export class TouchController {
  readonly stick = new VirtualStick();
  /** Gate every handler; the K panel toggle flips this live (see setEnabled). */
  enabled = true;
  /** Host clock (s) of the last touch — device-switch arbitration. */
  lastInputAt = -Infinity;
  /** Fires when the stick spawns/moves/lifts so the host can draw it. */
  onStick: ((origin: Vec2 | null, nub: Vec2) => void) | null = null;

  private roles = new Map<number, PointerRole>();
  private slotBtn = new SlotButton();
  private aimingSlot = -1;
  private attackHeld = false;
  private attackLatch = false; // a tap shorter than one sim step still lands
  private pending: { slot: number; aim: Vec2 | null }[] = [];
  private flaskPending = false;
  private stairsPending = false;
  private touched = false;

  /**
   * Wire the shell. stickZone is the left-half overlay; chips is the LIVE
   * #skills container (chips are matched per-event, so per-frame innerHTML
   * rebuilds are safe); stairsBtn the contextual descend chip.
   */
  bind(stickZone: HTMLElement, chips: HTMLElement, stairsBtn: HTMLElement): void {
    const mark = () => { this.touched = true; };

    stickZone.addEventListener("pointerdown", (e) => {
      if (!this.enabled || this.roles.has(e.pointerId)) return;
      // One thumb owns movement: a second finger (or a grazing palm) in the
      // zone must not re-base the stick under the new touch mid-fight.
      for (const r of this.roles.values()) if (r.kind === "stick") return;
      this.roles.set(e.pointerId, { kind: "stick" });
      stickZone.setPointerCapture(e.pointerId);
      this.stick.down(e.clientX, e.clientY);
      this.onStick?.({ x: e.clientX, y: e.clientY }, { x: 0, y: 0 });
      mark();
      e.preventDefault();
    });
    stickZone.addEventListener("pointermove", (e) => {
      if (this.roles.get(e.pointerId)?.kind !== "stick") return;
      this.stick.move(e.clientX, e.clientY);
      if (this.stick.origin) this.onStick?.(this.stick.origin, this.stick.nub);
      mark();
    });
    const stickEnd = (e: PointerEvent) => {
      if (this.roles.get(e.pointerId)?.kind !== "stick") return;
      this.roles.delete(e.pointerId);
      this.stick.up();
      this.onStick?.(null, { x: 0, y: 0 });
    };
    stickZone.addEventListener("pointerup", stickEnd);
    stickZone.addEventListener("pointercancel", stickEnd);

    chips.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return; // touch OFF: chips are plain cooldown chips
      if (e.pointerType === "mouse") return; // desktop keeps click semantics
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".skill");
      if (!chip) return;
      if (chip.id === "flask-chip") {
        this.roles.set(e.pointerId, { kind: "flask" });
      } else {
        const i = Number(chip.dataset.i ?? -1);
        if (i < 0) return;
        if (i === 0) {
          this.roles.set(e.pointerId, { kind: "attack" });
          this.attackHeld = true;
          this.attackLatch = true;
        } else if (this.aimingSlot === -1) { // one aimed cast at a time
          this.roles.set(e.pointerId, { kind: "slot", slot: i });
          this.slotBtn.down(e.clientX, e.clientY);
          this.aimingSlot = i;
        }
      }
      chips.setPointerCapture(e.pointerId); // survives chip innerHTML rebuilds
      mark();
      e.preventDefault();
    });
    chips.addEventListener("pointermove", (e) => {
      const role = this.roles.get(e.pointerId);
      if (role?.kind !== "slot") return;
      this.slotBtn.move(e.clientX, e.clientY);
      mark();
    });
    const chipEnd = (e: PointerEvent) => {
      const role = this.roles.get(e.pointerId);
      if (!role) return;
      this.roles.delete(e.pointerId);
      if (role.kind === "attack") this.attackHeld = false;
      else if (role.kind === "flask") this.flaskPending = true;
      else if (role.kind === "slot") {
        const rel = e.type === "pointercancel" ? { kind: "cancel" as const } : this.slotBtn.up();
        this.aimingSlot = -1;
        if (rel.kind === "tap") this.pending.push({ slot: role.slot!, aim: null });
        else if (rel.kind === "aimed") this.pending.push({ slot: role.slot!, aim: rel.aim });
      }
      mark();
    };
    chips.addEventListener("pointerup", chipEnd);
    chips.addEventListener("pointercancel", chipEnd);

    stairsBtn.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      this.stairsPending = true;
      mark();
      e.preventDefault();
    });
  }

  /** Toggle the whole controller. Disabling clears every in-flight press. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.roles.clear();
      this.stick.up();
      this.onStick?.(null, { x: 0, y: 0 });
      this.aimingSlot = -1;
      this.attackHeld = this.attackLatch = false;
      this.pending.length = 0;
      this.flaskPending = this.stairsPending = false;
    }
  }

  /** Poll once per frame (mirrors GamepadController.poll). */
  sample(now: number): TouchSample | null {
    const move = this.stick.value;
    const aimDir = this.aimingSlot >= 0 ? this.slotBtn.aimDir : null;
    const castHeld = [this.attackHeld || this.attackLatch, false, false, false, false];
    this.attackLatch = false;
    const castEdges = this.pending.splice(0);
    const flaskEdge = this.flaskPending;
    const stairsEdge = this.stairsPending;
    this.flaskPending = this.stairsPending = false;
    const active =
      this.touched || move !== null || this.attackHeld || this.aimingSlot >= 0 ||
      castEdges.length > 0 || flaskEdge || stairsEdge;
    this.touched = false;
    if (active) this.lastInputAt = now;
    return { move, aimingSlot: this.aimingSlot, aimDir, castHeld, castEdges, flaskEdge, stairsEdge, active };
  }
}
