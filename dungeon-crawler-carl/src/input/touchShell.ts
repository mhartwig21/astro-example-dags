import {
  computeZones, readInsets, type ControlId, type LayoutPrefs, type ZoneTable,
} from "./touchLayout";
import type { SuspendReason, TouchController, TouchFeedback } from "./touch";
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
    window.visualViewport?.addEventListener("resize", relayout);
    this.bindAuthority();
    document.addEventListener("dblclick", (e) => {
      if (document.body.classList.contains("touch")) e.preventDefault();
    }, { passive: false });
    // Chip rects are DOM truth but reading them is a layout: measure on the
    // layout lifecycle only, never inside a pointer handler.
    setTimeout(() => this.measureChips(), 400);
    this.apply();
  }

  /**
   * THE INPUT AUTHORITY'S DOM HALF (MOBILE.md 2.9a).
   *
   * Seven of the eight suspend reasons are events; the eighth (`not-playing`)
   * is a sim fact the host raises from its frame loop. Nothing here maintains
   * a list of element IDs — that is the shape of the bug being fixed. `modal`
   * reads `body.modal` and ONLY `body.modal`, and `syncOverlays()` in the host
   * is what puts the class there, driven by `[data-overlay]` markup that
   * test/panels.test.ts checks against the screen-zone map.
   */
  private bindAuthority(): void {
    const c = this.o.controller;
    const raise = (r: SuspendReason): void => c.suspend(r);
    const clear = (r: SuspendReason): void => c.resume(r);
    // `.closing` is a fade-out and `.done` is a retired boot screen; both stay
    // in the layout with a real box, so neither may read as open. See the
    // matching note in main3d's syncModal — `#loading.done` pinned the whole
    // layer dead after boot on an iPad until this predicate learned about it.
    const shown = (el: Element | null): boolean => {
      if (!el || el.classList.contains("closing") || el.classList.contains("done")) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (cs.pointerEvents === "none" && parseFloat(cs.opacity) === 0) return false;
      const e = el as HTMLElement;
      return e.offsetWidth > 0 || e.offsetHeight > 0;
    };

    // modal / rotate-gate / sheet: one observer, three predicates. Reading
    // offsetWidth is a layout, so this runs on MUTATION, never per frame.
    const sync = (): void => {
      const body = document.body;
      if (body.classList.contains("modal")) raise("modal"); else clear("modal");
      if (shown(document.getElementById("rotate"))) raise("rotate-gate"); else clear("rotate-gate");
      let sheet = false;
      for (const el of document.querySelectorAll("[data-sheet]")) { if (shown(el)) { sheet = true; break; } }
      if (sheet) raise("sheet"); else clear("sheet");
    };
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    for (const el of document.querySelectorAll("[data-overlay], [data-sheet]")) {
      obs.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    }
    // A sheet is created lazily by panelTouch, so watch for it arriving too.
    new MutationObserver((recs) => {
      for (const rec of recs) {
        for (const n of rec.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = n as Element;
          if (el.matches?.("[data-overlay], [data-sheet]")) {
            obs.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
          }
        }
      }
      sync();
    }).observe(document.body, { childList: true });
    sync();

    // ORIENTATION. iOS fires orientationchange and the visualViewport resize
    // APART; releasing on the first one re-arms the layer against stale zones,
    // so the reason is held until 250ms after the LAST resize.
    let orientTimer = 0;
    const holdOrientation = (): void => {
      raise("orientation");
      clearTimeout(orientTimer);
      orientTimer = window.setTimeout(() => { clear("orientation"); this.relayout(); }, 250);
    };
    window.addEventListener("orientationchange", () => { holdOrientation(); this.relayout(); });
    window.visualViewport?.addEventListener("resize", () => {
      if (orientTimer) holdOrientation();
    });

    // HIDDEN. The class of bug that leaves a phone player running into a wall
    // after a phone call: no pointer event is emitted at all.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") raise("hidden"); else clear("hidden");
    });
    window.addEventListener("pagehide", () => raise("hidden"));
    window.addEventListener("pageshow", () => clear("hidden"));
    window.addEventListener("blur", () => raise("hidden"));
    window.addEventListener("focus", () => clear("hidden"));

    // SYSTEM GESTURE. The OS has taken the finger; there is nothing to refund
    // it to. iOS pinch-zooms through proprietary GestureEvents that ignore
    // touch-action entirely, so those are cancelled here as well.
    // A CONTEXT MENU WE PREVENTED IS NOT A FINGER THE OS TOOK.
    //
    // Measured (tools/_mobile/i2.log): raising `system-gesture` on every
    // contextmenu killed the party ping outright on both phones — the ping IS
    // a 450ms hold, and a 450ms hold is exactly what fires contextmenu. The
    // reason means "the OS has taken the finger"; if preventDefault worked, it
    // has not, and cancelling would be us taking it instead.
    document.addEventListener("contextmenu", (e) => {
      // Desktop keeps its right-click menu; only touch mode swallows it.
      if (document.body.classList.contains("touch") && e.cancelable) e.preventDefault();
      if (e.defaultPrevented) return; // we kept the finger; nothing to refund
      raise("system-gesture");
      setTimeout(() => clear("system-gesture"), 200);
    });
    for (const g of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(g, (e) => {
        e.preventDefault();
        if (g === "gesturestart") raise("system-gesture");
        if (g === "gestureend") setTimeout(() => clear("system-gesture"), 120);
      }, { passive: false });
    }
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
   * Park the LOCK chip WHERE THE TABLE SAYS.
   *
   * This used to measure the cluster and hang the chip above it, because the
   * ability chips were still placed by their own CSS and a table-placed chip
   * landed on top of the ultimate. `ui/hudLayout.ts` now paints the cluster
   * from the same table, so the two agree — and the measured version had
   * become the bug: photographed on `i1/iphone13-land-combat.png` and
   * `i1/pixel5-land-combat.png`, it hung the chip in the top-right corner
   * against the boss health plate, which is the exact §4.2a rule-1 violation
   * the table exists to make impossible.
   */
  private placeLock(): void {
    const l = this.zones.controls.lock;
    this.lock.style.width = `${l.w}px`;
    this.lock.style.height = `${l.h}px`;
    this.lock.style.transform = `translate3d(${l.x}px, ${l.y}px, 0)`;
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