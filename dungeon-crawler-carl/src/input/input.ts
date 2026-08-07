import type { Intent, Vec2 } from "../sim/types";
import { type BindableAction, type Bindings, DEFAULT_BINDINGS } from "./bindings";

/**
 * Translates raw keyboard/mouse into a per-step Intent. The sim never sees the
 * DOM — this is the seam where, in multiplayer, intents are serialized and
 * sent to the authoritative server instead of applied locally.
 *
 * All keys route through a rebindable Bindings map (see bindings.ts). Hosts can
 * swap bindings at runtime via setBindings; UI-only actions (inventory, panels)
 * register through onAction rather than living in the sampled Intent.
 */
export class InputController {
  private keys = new Set<string>();
  private mouseAttack = false; // LMB -> slot 1
  private mouseBolt = false; // RMB -> slot 3
  private useStairsEdge = false;
  private flaskEdge = false;
  /** Edge-triggered ping request. The HOST consumes this (it owns the mouse ->
   *  world mapping) and attaches the world position to the sampled intent. */
  pingEdge = false;
  private bindings: Bindings = { ...DEFAULT_BINDINGS };
  /** Latest mouse position in canvas coordinates (for aim mapping by the host). */
  mouse: Vec2 | null = null;
  /** Diablo-style mouse movement (see clickMove.ts). When on, LMB stops
   *  aliasing slot 1 — the host routes it through stepClickMove instead,
   *  which re-emits the attack only when the press lands on a monster. */
  mouseMoveMode = false;
  /** Suppress gameplay key handling (e.g. while capturing a rebind). */
  captureMode = false;
  onReset: (() => void) | null = null;
  onAction: ((action: BindableAction) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (this.captureMode) return; // the keybinds panel owns the keyboard
      const k = e.key.toLowerCase();
      // A REAL PRESS IS AN EDGE, WHATEVER THE SET SAYS (r2 major: "the V bind
      // for the draft is dead, while the on-screen badge teaches V"). Panel
      // toggles fire on `!wasDown`, and `wasDown` used to mean "this key is in
      // the held set" — a set that goes stale the instant a keyup is swallowed
      // (alt-tab mid-press, a click into devtools, an OS overlay, a modal
      // stealing focus). One lost keyup and the bind was unreachable for the
      // rest of the session, which is the fastest way to lose a new player's
      // trust: the game teaches a key on screen and the key does nothing.
      // The browser marks autorepeat with `e.repeat`, so autorepeat — the only
      // thing this guard actually needs to suppress — is now what it tests.
      // A physical press always produces a non-repeat keydown, so a bind can
      // no longer be latched dead by an event the window never received.
      const wasDown = this.keys.has(k) && e.repeat;
      this.keys.add(k);
      if (this.is("stairs", k)) this.useStairsEdge = true;
      if (this.is("flask", k) && !wasDown) this.flaskEdge = true;
      if (this.is("ping", k) && !wasDown) this.pingEdge = true;
      if (this.is("newRun", k)) this.onReset?.();
      for (const a of ["inventory", "abilities", "character", "ledger", "keybinds", "mute", "draft"] as const) {
        if (this.is(a, k) && !wasDown) this.onAction?.(a);
      }
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    // A KEY THE WINDOW NEVER SAW RELEASED IS A DEAD BIND. Panel toggles fire
    // on the DOWN edge (`!wasDown`), so a keyup swallowed by a focus change —
    // alt-tab mid-press, a click into devtools, an OS overlay — leaves the key
    // latched down and its action permanently unreachable until it is pressed
    // and released again. Blur clears the whole set; nothing may be held
    // through a window that is not listening (r1: the V claim that would not
    // open with two drafts banked).
    window.addEventListener("blur", () => this.clearHeld());
    // ...and a tab that goes to the background never sees the keyup either.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clearHeld();
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.mouseBolt = true; // right-click = ranged bolt
      else this.mouseAttack = true;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.mouseBolt = false;
      else this.mouseAttack = false;
    });
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
  }

  setBindings(b: Bindings): void {
    this.bindings = b;
  }

  /** Drop every held key. Called on blur/hide and whenever a modal opens or
   *  closes — a panel that eats a keyup must not leave a bind latched down
   *  (see the keydown handler's note on the dead V bind). */
  clearHeld(): void {
    this.keys.clear();
  }

  /** Raw LMB state for the click-move host wiring. */
  get lmbHeld(): boolean {
    return this.mouseAttack;
  }

  private is(action: BindableAction, key: string): boolean {
    return this.bindings[action].includes(key);
  }

  private held(action: BindableAction): boolean {
    return this.bindings[action].some((k) => this.keys.has(k));
  }

  /**
   * Sample the current input as an Intent. `aim` is derived from the mouse
   * position relative to the player's screen position (2D host); the 3D host
   * overrides it with a ground-plane raycast (see main3d).
   */
  sample(playerScreen: Vec2, includeAim = true): Intent {
    const move: Vec2 = { x: 0, y: 0 };
    if (this.held("moveUp")) move.y -= 1;
    if (this.held("moveDown")) move.y += 1;
    if (this.held("moveLeft")) move.x -= 1;
    if (this.held("moveRight")) move.x += 1;

    let aim: Vec2 | undefined;
    if (includeAim && this.mouse) {
      const dx = this.mouse.x - playerScreen.x;
      const dy = this.mouse.y - playerScreen.y;
      if (dx !== 0 || dy !== 0) aim = { x: dx, y: dy };
    }

    const useStairs = this.useStairsEdge;
    this.useStairsEdge = false;
    const flask = this.flaskEdge;
    this.flaskEdge = false;

    // Slot casts: indices 0-3 = ability slots, 4 = ultimate. Mouse buttons are
    // fixed aliases (LMB = slot 1, RMB = slot 3) on top of the keyboard binds.
    const cast = [
      this.held("slot1") || (this.mouseAttack && !this.mouseMoveMode),
      this.held("slot2"),
      this.held("slot3") || this.mouseBolt,
      this.held("slot4"),
      this.held("ultimate"),
    ];

    return { move, aim, useStairs, flask, cast };
  }
}
