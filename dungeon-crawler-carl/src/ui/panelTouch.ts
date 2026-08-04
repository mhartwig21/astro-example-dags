/**
 * TOUCH-FIRST PANELS.
 *
 * Measured before this file existed: `#inv`, `#sheet` and `#abil` contained
 * ZERO `<button>` elements, `#saferoom`'s only buttons were its own tabs, and
 * tap-outside-closes was `false` on every one of them (MOBILE.md §1.3). On a
 * phone with no keyboard, opening any panel ended the session.
 *
 * Every panel now closes THREE ways, which is the one row where the target is
 * simply parity with Wild Rift rather than a win:
 *
 *   1. a 44px ✕ at the top-inboard corner (it mirrors with `body.handed-left`,
 *      because "inboard" is a fact about which hand is holding the slab);
 *   2. a full-width DONE bar pinned inside the bottom safe gutter — the thumb
 *      is already down there, and a bar cannot be missed the way a ✕ can;
 *   3. a backdrop tap, plus a swipe-down from the top of the scroller.
 *
 * WHAT THIS FILE MAY NOT DO. It never closes a panel itself: it calls the same
 * `close` the keyboard calls, so there is exactly one close path per panel and
 * `Escape`, the ✕ and a swipe cannot drift apart. It also refuses to claim
 * MOUSE input — `pointerType === "touch"` gates the swipe — because a desktop
 * player dragging to select text inside a panel must not have it dismissed
 * (rule 2: touch is additive).
 */

export interface PanelOpts {
  /** The panel's existing close path. Never a bespoke one. */
  close: () => void;
  /** Bottom bar label. Null suppresses the bar for panels that own their rail. */
  done?: string | null;
  /** Element that actually scrolls; defaults to the `.panel` box. */
  scroller?: () => HTMLElement | null;
}

/** Swipe-down distance that dismisses, in CSS px. Below this it springs back. */
const SWIPE_CLOSE = 84;
/** A gesture is a swipe, not a scroll, only while it stays roughly vertical. */
const SWIPE_SLOPE = 1.4;

export function attachPanel(root: HTMLElement, o: PanelOpts): void {
  const box = (root.querySelector(":scope > .panel") ?? root.firstElementChild) as HTMLElement | null;
  if (!box) return;
  if (box.dataset.touchWired === "1") return;
  box.dataset.touchWired = "1";
  box.classList.add("tpanel");

  // --- 1. the ✕ -----------------------------------------------------------
  const x = document.createElement("button");
  x.type = "button";
  x.className = "tp-x";
  x.setAttribute("aria-label", "Close");
  x.textContent = "✕";
  x.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); o.close(); });
  // FIRST child, not last: a right float takes the line box it is declared
  // beside, so appending it put the ✕ at the BOTTOM of a scrolled panel —
  // visible only if you had already read everything (r2 captures).
  box.insertBefore(x, box.firstChild);

  // --- 2. the DONE bar ----------------------------------------------------
  if (o.done !== null) {
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "tp-done";
    bar.textContent = o.done ?? "DONE";
    bar.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); o.close(); });
    box.appendChild(bar);
  }

  // --- 3a. backdrop tap ---------------------------------------------------
  // `pointerdown` on the ROOT only: a press that starts on the panel and drifts
  // onto the scrim (a sloppy thumb on a scroll) must not dismiss.
  root.addEventListener("pointerdown", (e) => {
    if (e.target !== root) return;
    e.preventDefault();
    o.close();
  });

  // --- 3b. swipe down -----------------------------------------------------
  //
  // ON THE TOUCH STREAM, NOT THE POINTER STREAM. The first implementation used
  // pointerdown/move/up and closed nothing on any device, and the reason is
  // worth keeping: the panel is a scroller with `touch-action: auto`, so
  // Chrome claims a vertical drag as a PAN and fires `pointercancel` after a
  // single `pointermove`. Instrumented on an iPhone 13 (`tools/_mobile/swipe.mjs`):
  //
  //   pointerdown:38 -> pointermove:58 -> POINTERCANCEL -> [9 more touchmoves]
  //
  // The pointer recogniser therefore saw dy = 20 of a 200 px gesture and
  // correctly declined to close. The TOUCH events keep flowing throughout, so
  // the gesture lives there; and because the drag only arms at `scrollTop <= 0`
  // going DOWN, there is nothing for the pan to scroll anyway, which is why
  // taking it with `preventDefault()` costs the scroller nothing.
  let id = -1, y0 = 0, x0 = 0, armed = false, committed = false;
  const scroller = (): HTMLElement => (o.scroller?.() ?? box);
  const reset = (): void => { armed = false; committed = false; id = -1; box.style.transform = ""; };
  box.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { reset(); return; } // a pinch is not a dismiss
    const t = e.changedTouches[0];
    // Only arm at the very top: mid-scroll, a downward drag is a scroll.
    armed = scroller().scrollTop <= 0;
    committed = false;
    if (!armed) return;
    id = t.identifier; y0 = t.clientY; x0 = t.clientX;
  }, { passive: true });
  box.addEventListener("touchmove", (e) => {
    if (!armed) return;
    const t = Array.from(e.changedTouches).find((c) => c.identifier === id);
    if (!t) return;
    const dy = t.clientY - y0, dx = Math.abs(t.clientX - x0);
    if (dy < 0 || dx > Math.abs(dy) * SWIPE_SLOPE) { reset(); return; }
    // Past the slop this IS a dismiss, so take the gesture: without this the
    // browser is free to start a rubber-band overscroll under the transform.
    if (dy > 12) {
      committed = true;
      if (e.cancelable) e.preventDefault();
    }
    // Rubber-band the panel under the thumb so the gesture is acknowledged
    // before it commits — transform only, so this never triggers layout.
    box.style.transform = `translate3d(0, ${Math.min(dy, SWIPE_CLOSE * 1.5) * 0.55}px, 0)`;
  }, { passive: false });
  const end = (e: TouchEvent): void => {
    if (!armed) return;
    const t = Array.from(e.changedTouches).find((c) => c.identifier === id);
    if (!t) return;
    const dy = t.clientY - y0;
    const fire = committed && dy >= SWIPE_CLOSE;
    reset();
    if (fire) o.close();
  };
  box.addEventListener("touchend", end);
  box.addEventListener("touchcancel", end);
}

// ------------------------------------------------------------ bottom sheet

/**
 * THE DERIVATION SHEET — what "hover anything for the math" becomes.
 *
 * The character sheet told a phone player to hover, which touch does not have,
 * so the entire derivation layer was invisible on glass (§1.3). A tap on a row
 * now raises this: one sheet, reused, drawn from the bottom where the thumb is.
 */
let sheetEl: HTMLElement | null = null;

export function showSheet(title: string, html: string): void {
  const el = ensureSheet();
  (el.querySelector(".ts-title") as HTMLElement).textContent = title;
  (el.querySelector(".ts-body") as HTMLElement).innerHTML = html;
  el.classList.add("on");
}

export function hideSheet(): void {
  sheetEl?.classList.remove("on");
}

export function sheetOpen(): boolean {
  return !!sheetEl?.classList.contains("on");
}

function ensureSheet(): HTMLElement {
  if (sheetEl) return sheetEl;
  const el = document.createElement("div");
  el.id = "tsheet";
  // The `sheet` suspend reason keys off this attribute (MOBILE.md 2.9a): a
  // bottom sheet is not full-screen so it never sets body.modal, yet it sits
  // directly on top of the ability cluster.
  el.dataset.sheet = "math";
  el.innerHTML =
    `<div class="ts-scrim"></div>` +
    `<div class="ts-box"><div class="ts-grip"></div>` +
    `<div class="ts-title"></div><div class="ts-body"></div>` +
    `<button type="button" class="ts-close">CLOSE</button></div>`;
  document.body.appendChild(el);
  el.querySelector(".ts-scrim")!.addEventListener("pointerdown", (e) => { e.preventDefault(); hideSheet(); });
  el.querySelector(".ts-close")!.addEventListener("click", (e) => { e.preventDefault(); hideSheet(); });
  sheetEl = el;
  return el;
}

// --------------------------------------------------------- segmented panes

/**
 * ONE PANE AT A TIME, on the screens that cannot hold two.
 *
 * The shop is a two-track grid; on a 342-tall iPhone the second track put the
 * bag at y=363 — 21px BELOW the viewport, i.e. the player's own inventory was
 * unreachable (§1.3). Rather than shrink the tracks until nothing is legible,
 * `compact`/`phone` show one pane and a segmented control switches between
 * them. On a tablet the panes coexist and the control hides itself in CSS.
 */
export interface SegmentSpec {
  id: string;
  label: string;
  pane: HTMLElement;
}

export class Segmented {
  private cur = "";
  readonly el: HTMLElement;

  constructor(private readonly segs: SegmentSpec[], private readonly onPick?: (id: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "tp-seg";
    for (const s of segs) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.seg = s.id;
      b.textContent = s.label;
      b.addEventListener("click", (e) => { e.preventDefault(); this.show(s.id); });
      this.el.appendChild(b);
    }
    this.show(segs[0]?.id ?? "");
  }

  /** Which pane is live. Cheap to call repeatedly; a no-op when unchanged. */
  show(id: string): void {
    if (!id || id === this.cur) return;
    this.cur = id;
    for (const s of this.segs) s.pane.classList.toggle("seg-on", s.id === id);
    for (const b of Array.from(this.el.children) as HTMLElement[]) {
      b.classList.toggle("on", b.dataset.seg === id);
    }
    this.onPick?.(id);
  }

  get active(): string { return this.cur; }

  /** Badge a segment (the bag's item count, say) without rebuilding it. */
  badge(id: string, text: string): void {
    const b = this.el.querySelector(`[data-seg="${id}"]`) as HTMLElement | null;
    if (b) b.dataset.badge = text;
  }
}
