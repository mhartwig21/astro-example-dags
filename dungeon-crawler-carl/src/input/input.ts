import type { Intent, Vec2 } from "../sim/types";

/**
 * Translates raw keyboard/mouse into a per-step Intent. The sim never sees the
 * DOM — this is the seam where, in multiplayer, intents would be serialized and
 * sent to the authoritative server instead of applied locally.
 */
export class InputController {
  private keys = new Set<string>();
  private attackHeld = false;
  private useStairsEdge = false;
  private dashEdge = false;
  private boltHeld = false;
  private novaEdge = false;
  private aimScreen: Vec2 | null = null;
  onReset: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      const wasDown = this.keys.has(k);
      this.keys.add(k);
      if (k === " ") this.attackHeld = true;
      if (k === "e") this.useStairsEdge = true;
      if ((k === "shift" || k === "control") && !wasDown) this.dashEdge = true; // edge-trigger dash
      if (k === "q") this.boltHeld = true;
      if (k === "f" && !wasDown) this.novaEdge = true; // edge-trigger nova
      if (k === "r") this.onReset?.();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === " ") this.attackHeld = false;
      if (k === "q") this.boltHeld = false;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.boltHeld = true; // right-click = ranged bolt
      else this.attackHeld = true;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.boltHeld = false;
      else this.attackHeld = false;
    });
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.aimScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
  }

  /**
   * Sample the current input as an Intent. `aim` is derived from the mouse
   * position relative to the player's screen position (passed in by the host).
   */
  sample(playerScreen: Vec2, includeAim = true): Intent {
    const move: Vec2 = { x: 0, y: 0 };
    if (this.keys.has("w") || this.keys.has("arrowup")) move.y -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) move.y += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) move.x -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) move.x += 1;

    let aim: Vec2 | undefined;
    if (includeAim && this.aimScreen) {
      const dx = this.aimScreen.x - playerScreen.x;
      const dy = this.aimScreen.y - playerScreen.y;
      if (dx !== 0 || dy !== 0) aim = { x: dx, y: dy };
    }

    const useStairs = this.useStairsEdge;
    this.useStairsEdge = false;
    const dash = this.dashEdge;
    this.dashEdge = false;
    const nova = this.novaEdge;
    this.novaEdge = false;

    return { move, attack: this.attackHeld, aim, useStairs, dash, bolt: this.boltHeld, nova };
  }
}
