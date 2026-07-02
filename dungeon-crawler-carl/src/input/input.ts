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
  private mouseAttack = false;
  private mouseBolt = false;
  private useStairsEdge = false;
  private dashEdge = false;
  private novaEdge = false;
  private bindings: Bindings = { ...DEFAULT_BINDINGS };
  /** Latest mouse position in canvas coordinates (for aim mapping by the host). */
  mouse: Vec2 | null = null;
  /** Suppress gameplay key handling (e.g. while capturing a rebind). */
  captureMode = false;
  onReset: (() => void) | null = null;
  onAction: ((action: BindableAction) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (this.captureMode) return; // the keybinds panel owns the keyboard
      const k = e.key.toLowerCase();
      const wasDown = this.keys.has(k);
      this.keys.add(k);
      if (this.is("stairs", k)) this.useStairsEdge = true;
      if (this.is("dash", k) && !wasDown) this.dashEdge = true; // edge-trigger
      if (this.is("nova", k) && !wasDown) this.novaEdge = true;
      if (this.is("newRun", k)) this.onReset?.();
      for (const a of ["inventory", "abilities", "keybinds"] as const) {
        if (this.is(a, k) && !wasDown) this.onAction?.(a);
      }
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
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
    const dash = this.dashEdge;
    this.dashEdge = false;
    const nova = this.novaEdge;
    this.novaEdge = false;

    return {
      move,
      attack: this.held("attack") || this.mouseAttack,
      aim,
      useStairs,
      dash,
      bolt: this.held("bolt") || this.mouseBolt,
      nova,
    };
  }
}
