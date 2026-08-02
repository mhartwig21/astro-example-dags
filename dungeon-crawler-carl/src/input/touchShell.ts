import {
  computeZones, readInsets, type ControlId, type LayoutPrefs, type ZoneTable,
} from "./touchLayout";
import type { TouchController, TouchFeedback } from "./touch";
import type { Haptics } from "./haptics";

/**
 * The DOM shell for the touch layer: the paint and the plumbing, so the state
 * machines in touch.ts stay DOM-free and testable.
 *
 * It owns FOUR things and nothing else:
 *   1. the elements it creates itself (#t-layer: ghost ring, floating stick,
 *      CANCEL band, LOCK chip) — the ability chips keep their CSS home in
 *      iso.html, we only cache their measured rects;
 *   2. the browser-level hostilities: double-tap zoom, pull-to-refresh,
 *      text selection, and the iOS gesture stream;
 *   3. the layout lifecycle: recompute zones on resize / orientationchange /
 *      visualViewport resize / pref change, and NEVER per frame;
 *   4. immediate acknowledgement — every press paints from the event handler,
 *      because the sim freezes during hit-stop and while a panel is open, and
 *      a press must never look ignored while the world is paused.
 *
 * All writes are transform/opacity only: no left/top inside a drag handler
 * (that is a forced layout in the latency path, MOBILE.md 7.2).
 */

const STYLE_ID = "t-shell-style";

const CSS = `
:root {
  --sa-t: env(safe-area-inset-top, 0px);
  --sa-r: env(safe-area-inset-right, 0px);
  --sa-b: env(safe-area-inset-bottom, 0px);
  --sa-l: env(safe-area-inset-left, 0px);
}
html, body { overscroll-behavior: none; }
body.touch {
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
}
/* Chrome and Safari decide "this gesture is a pan" from touch-action, NOT from
   preventDefault: a display-only overlay left at touch-action: manipulation
   fires pointercancel mid-drag and the movement thumb dies. Measured on the
   minimap: the stick claimed the pointer and then lost it to a phantom pan. */
body.touch #minimap-frame, body.touch #tutorial, body.touch #toasts,
body.touch #banner { touch-action: none; }
#t-layer { position: fixed; inset: 0; z-index: 6; pointer-events: none;
  display: none; contain: layout style; }
body.touch #t-layer { display: block; }
body.modal #t-layer { display: none; }
#t-layer .tl { position: fixed; left: 0; top: 0; will-change: transform; }
#t-ghost { border-radius: 50%; border: 2px dashed rgba(201,162,75,0.5);
  background: radial-gradient(circle, rgba(201,162,75,0.10), rgba(0,0,0,0.16));
  opacity: 0.25; transition: opacity 120ms linear; }
#t-stick2 { border-radius: 50%; border: 2px solid rgba(201,162,75,0.62);
  background: radial-gradient(circle, rgba(0,0,0,0.30), rgba(0,0,0,0.10));
  opacity: 0; transition: opacity 90ms linear; }
#t-nub2 { border-radius: 50%; background: rgba(201,162,75,0.72);
  box-shadow: 0 0 14px rgba(201,162,75,0.45); opacity: 0; }
#t-cancel { display: flex; align-items: center; justify-content: center;
  gap: 8px; border-radius: 12px; border: 2px dashed rgba(120,205,232,0.75);
  background: rgba(8,19,26,0.72); color: #eaf9ff; letter-spacing: 0.16em;
  font: 700 12px/1 "Barlow Condensed", system-ui, sans-serif;
  opacity: 0; transform: translate3d(0,0,0) scale(0.96);
  transition: opacity 110ms linear, transform 110ms ease-out; }
#t-cancel.on { opacity: 1; }
#t-cancel.armed { background: rgba(57,200,232,0.30); border-style: solid; }
#t-lock { display: flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 2px solid rgba(201,162,75,0.55);
  background: rgba(8,19,26,0.62); color: #c9a24b; pointer-events: auto;
  font: 700 10px/1 "Barlow Condensed", system-ui, sans-serif;
  letter-spacing: 0.08em; touch-action: none; }
#t-lock.on { border-color: #39c8e8; color: #eaf9ff; background: rgba(57,200,232,0.28); }
#t-layer .press { animation: t-press 140ms ease-out; }
@keyframes t-press { from { transform: scale(0.86); } to { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  #t-layer .press { animation: none; }
  #t-cancel { transition: none; }
}
`;

export interface ShellOpts {
  controller: TouchController;
  haptics?: Haptics | null;
  prefs: LayoutPrefs;
  /** Chip opacity at rest (0.35 - 1.0); full while pressed. */
  opacity?: number;
  onLayout?: (z: ZoneTable) => void;
}

export class TouchShell {
  zones: ZoneTable;
  private layer: HTMLElement;
  private ghost: HTMLElement;
  private stick: HTMLElement;
  private nub: HTMLElement;
  private cancel: HTMLElement;
  private lock: HTMLElement;
  private raf = 0;
  private locked = false;

  constructor(private readonly o: ShellOpts) {
    injectStyle();
    this.layer = el("div", "t-layer");
    this.ghost = el("div", "t-ghost", "tl");
    this.stick = el("div", "t-stick2", "tl");
    this.nub = el("div", "t-nub2", "tl");
    this.cancel = el("div", "t-cancel", "tl");
    this.cancel.textContent = "CANCEL";
    this.lock = el("div", "t-lock", "tl");
    this.lock.textContent = "LOCK";
    this.lock.dataset.tctl = "lock";
    this.layer.append(this.ghost, this.stick, this.nub, this.cancel, this.lock);
    document.body.appendChild(this.layer);
    // The context chip already exists in iso.html; tell the router it is ours.
    const stairs = document.getElementById("t-stairs");
    if (stairs) stairs.dataset.tctl = "context";

    this.zones = this.compute();
    this.o.controller.setZones(this.zones);

    // Immediate acknowledgement, painted from the event handler.
    this.o.controller.onStick = (origin, nubOff) => {
      if (!origin) {
        this.stick.style.opacity = "0";
        this.nub.style.opacity = "0";
        this.ghost.style.opacity = "0.25";
        const rest = this.o.controller.stick.rest;
        if (rest) this.place(this.ghost, rest.x, rest.y);
        return;
      }
      this.ghost.style.opacity = "0";
      this.stick.style.opacity = "1";
      this.nub.style.opacity = "1";
      this.place(this.stick, origin.x, origin.y);
      this.place(this.nub, origin.x + nubOff.x, origin.y + nubOff.y);
    };
    this.o.controller.onFeedback = (ev) => this.feedback(ev);

    const relayout = (): void => this.relayout();
    window.addEventListener("resize", relayout);
    window.addEventListener("orientationchange", () => {
      // iOS fires the viewport resize AFTER the orientation event, so do both,
      // and refund every live gesture at the boundary (MOBILE.md 4.4).
      this.o.controller.cancelAll(performance.now());
      relayout();
      setTimeout(relayout, 260);
    });
    window.visualViewport?.addEventListener("resize", relayout);
    // Belt and braces against the browser: iOS pinch-zooms through proprietary
    // GestureEvents that ignore touch-action entirely.
    for (const g of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
    }
    document.addEventListener("dblclick", (e) => {
      if (document.body.classList.contains("touch")) e.preventDefault();
    }, { passive: false });
    // Chip rects are DOM truth but reading them is a layout: measure on the
    // layout lifecycle only, never inside a pointer handler.
    setTimeout(() => this.measureChips(), 400);
    this.apply();
  }

  private compute(): ZoneTable {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    return computeZones(
      window.innerWidth, window.innerHeight,
      readInsets(document.documentElement), this.o.prefs, coarse,
    );
  }

  /** Recompute + repaint, coalesced to one animation frame. */
  relayout(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.zones = this.compute();
      this.o.controller.setZones(this.zones);
      this.measureChips();
      this.apply();
      this.o.onLayout?.(this.zones);
    });
  }

  /** Cache the measured rect of every chip the router may need to hit-test. */
  measureChips(): void {
    const c = this.o.controller;
    const put = (id: ControlId, sel: string): void => {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e) { c.setControlRect(id, null); return; }
      const r = e.getBoundingClientRect();
      c.setControlRect(id, r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null);
    };
    for (let i = 0; i <= 4; i++) put(`slot${i}` as ControlId, `#skills .skill[data-i="${i}"]`);
    put("flask", "#flask-chip");
    put("context", "#t-stairs");
    this.placeLock();
    const r = this.lock.getBoundingClientRect();
    c.setControlRect("lock", { x: r.x, y: r.y, w: r.width, h: r.height });
  }

  /**
   * Park the LOCK chip against the MEASURED cluster, not the zone table.
   *
   * The table says where the arc SHOULD be; the ability chips are still placed
   * by their own CSS, and until those two agree a table-placed chip lands on
   * top of the ultimate (photographed on both the phone and the Pixel). Reading
   * the real cluster box costs one layout per relayout and can never overlap.
   */
  private placeLock(): void {
    const z = this.zones;
    const l = z.controls.lock;
    let top = Infinity, left = Infinity, right = -Infinity;
    for (const sel of ["#skills .skill[data-i=\"4\"]", "#skills .skill[data-i=\"3\"]", "#skills"]) {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0) continue;
      top = r.top; left = r.left; right = r.right;
      break;
    }
    // The chip hugs the cluster OUTER edge, which mirrors with the layout.
    const mirror = this.o.prefs.handed === "left";
    const found = Number.isFinite(top);
    const x = !found ? l.x
      : mirror ? Math.max(z.safe.x, left)
        : Math.min(z.safe.x + z.safe.w - l.w, right - l.w);
    const y = found ? Math.max(z.safe.y, top - l.h - 10) : l.y;
    this.lock.style.width = `${l.w}px`;
    this.lock.style.height = `${l.h}px`;
    this.lock.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  /** Size + place everything the shell owns, from the zone table. */
  private apply(): void {
    const z = this.zones;
    const d = z.stickRadius * 2;
    size(this.ghost, d, d);
    size(this.stick, d, d);
    size(this.nub, d * 0.42, d * 0.42);
    const anchor = this.o.controller.stick.rest ?? z.stickAnchor;
    this.place(this.ghost, anchor.x, anchor.y);
    const b = z.cancelBand;
    this.cancel.style.width = `${b.w}px`;
    this.cancel.style.height = `${b.h}px`;
    this.cancel.style.transform = `translate3d(${b.x}px, ${b.y}px, 0)`;
    this.placeLock();
    const op = Math.max(0.35, Math.min(1, this.o.opacity ?? 1));
    this.lock.style.opacity = String(op);
    this.ghost.style.opacity = "0.25";
  }

  /** Centre an element on a point with a transform (never left/top). */
  private place(e: HTMLElement, x: number, y: number): void {
    const w = parseFloat(e.style.width) || 0, h = parseFloat(e.style.height) || 0;
    e.style.transform = `translate3d(${x - w / 2}px, ${y - h / 2}px, 0)`;
  }

  private feedback(ev: TouchFeedback): void {
    const h = this.o.haptics;
    switch (ev.kind) {
      case "press": h?.fire("press"); this.pulseChip(ev.slot); break;
      case "refused": h?.fire("refused"); this.shakeChip(ev.slot); break;
      case "cast": h?.fire("cast"); this.showCancel(false); break;
      case "cancel": h?.fire("cancel"); this.showCancel(false); break;
      case "aimStart": this.showCancel(true); break;
      case "cancelEnter": this.cancel.classList.add("armed"); h?.fire("cancel"); break;
      case "cancelLeave": this.cancel.classList.remove("armed"); break;
      case "dash": h?.fire("cast"); break;
      case "pingArm": h?.fire("lock"); break; // the hold is acknowledged...
      case "ping": h?.fire("lock"); break;       // ...and this is the commit
    }
  }

  private showCancel(on: boolean): void {
    this.cancel.classList.toggle("on", on);
    if (!on) this.cancel.classList.remove("armed");
  }

  private chipEl(slot?: number): HTMLElement | null {
    if (slot === undefined) return null;
    return document.querySelector(`#skills .skill[data-i="${slot}"]`);
  }

  private pulseChip(slot?: number): void {
    const e = this.chipEl(slot);
    if (!e) return;
    e.classList.remove("press");
    void e.offsetWidth; // restart the animation
    e.classList.add("press");
  }

  private shakeChip(slot?: number): void {
    const e = this.chipEl(slot);
    if (!e) return;
    e.animate?.(
      [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" },
        { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
      { duration: 160, easing: "ease-out" },
    );
  }

  /** Paint the LOCK chip state; the host owns the actual lock. */
  setLocked(on: boolean): void {
    if (this.locked === on) return;
    this.locked = on;
    this.lock.classList.toggle("on", on);
  }

  setPrefs(prefs: LayoutPrefs, opacity?: number): void {
    Object.assign(this.o.prefs, prefs);
    if (opacity !== undefined) this.o.opacity = opacity;
    this.relayout();
  }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag: string, id: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (cls) e.className = cls;
  return e;
}

function size(e: HTMLElement, w: number, h: number): void {
  e.style.width = `${w}px`;
  e.style.height = `${h}px`;
}