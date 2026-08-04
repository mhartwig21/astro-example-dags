import type { TouchController } from "./touch";

/**
 * `?touchdebug=1` — THE OWNER'S 30-SECOND INSTRUMENT.
 *
 * Every emulated multi-touch battery passes and the owner's real iPhone
 * failed anyway, which means the emulator is not the instrument — the phone
 * is. This overlay turns one screenshot taken mid-gesture into a diagnosis:
 *
 *   TOUCHES 2   ● ●        two dots = iOS DELIVERED both fingers.
 *                          One dot while two fingers are down = Safari ate
 *                          the second touch before the page ever saw it.
 *   stick DOWN · btn aiming(2)   the FSM's verdict on the same moment. Both
 *                          fingers delivered but stick reads idle = OUR layer
 *                          dropped it, not the platform.
 *   suspend [...]          any word here mid-gesture (e.g. system-gesture)
 *                          means the input authority is cancelling play.
 *   the last five events, newest last: start/end/CANCEL with pointer ids,
 *   plus iOS GestureEvents — CANCEL lines are printed in caps because a
 *   touchcancel on finger A the moment finger B lands IS the bug signature.
 *
 * Presentation only: listeners are passive, nothing here routes input, and
 * the whole layer exists only when the query flag is present.
 */

const MAX_LINES = 5;
const DOT_POOL = 6;

export class TouchDebugOverlay {
  private box: HTMLElement;
  private headEl: HTMLElement;
  private fsmEl: HTMLElement;
  private logEl: HTMLElement;
  private dots: HTMLElement[] = [];
  private lines: string[] = [];
  private live = new Map<number, { x: number; y: number }>();
  private lastMoveLog = new Map<number, number>();
  private raf = 0;

  constructor(private readonly touch: TouchController) {
    injectCss();
    this.box = el("div", "tdbg");
    this.headEl = el("div", "tdbg-head");
    this.fsmEl = el("div", "tdbg-fsm");
    this.logEl = el("div", "tdbg-log");
    this.box.append(this.headEl, this.fsmEl, this.logEl);
    document.body.appendChild(this.box);
    for (let i = 0; i < DOT_POOL; i++) {
      const d = el("div", "", "tdbg-dot");
      d.style.display = "none";
      document.body.appendChild(d);
      this.dots.push(d);
    }

    // PASSIVE, capture-phase observation: sees every event the page sees,
    // vetoes nothing, and cannot change what the router does.
    const opts = { capture: true, passive: true } as AddEventListenerOptions;
    document.addEventListener("pointerdown", (e) => this.onPointer(e, "dn"), opts);
    document.addEventListener("pointermove", (e) => this.onPointer(e, "mv"), opts);
    document.addEventListener("pointerup", (e) => this.onPointer(e, "up"), opts);
    document.addEventListener("pointercancel", (e) => this.onPointer(e, "CANCEL"), opts);
    // The iOS-only stream. If `gest:start` prints the moment a second finger
    // lands, Safari's pinch recogniser saw the pair — and any CANCEL printed
    // right after it names the killer.
    for (const g of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(g, () => this.log(`gest:${g.slice(7)}`), opts);
    }
    for (const t of ["touchcancel"]) {
      document.addEventListener(t, (e) => {
        const te = e as TouchEvent;
        const ids = [...te.changedTouches].map((c) => c.identifier).join(",");
        this.log(`TOUCHCANCEL #${ids}`);
      }, opts);
    }

    const tick = (): void => {
      this.paint();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.box.remove();
    for (const d of this.dots) d.remove();
  }

  private onPointer(e: PointerEvent, kind: "dn" | "mv" | "up" | "CANCEL"): void {
    if (e.pointerType === "mouse") return;
    if (kind === "dn" || kind === "mv") this.live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    else this.live.delete(e.pointerId);
    if (kind === "mv") {
      // Moves are the noise floor: log the FIRST move per pointer, then one
      // every 700 ms, so start/end/CANCEL stay on the five-line screen.
      const last = this.lastMoveLog.get(e.pointerId) ?? -Infinity;
      const now = performance.now();
      if (now - last < 700) return;
      this.lastMoveLog.set(e.pointerId, now);
    } else {
      this.lastMoveLog.delete(e.pointerId);
    }
    this.log(`${kind}#${e.pointerId}`);
  }

  private log(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
  }

  private paint(): void {
    const n = this.live.size;
    this.headEl.textContent = `TOUCHES ${n}`;
    this.headEl.classList.toggle("multi", n >= 2);
    const s = this.touch.debugState();
    const roles = s.roles.map((r) => `${r.id}:${r.kind}`).join(" ") || "-";
    this.fsmEl.textContent =
      `stick ${s.stickDown ? "DOWN" : "idle"} · btn ${s.btn}` +
      `${s.aimingSlot >= 0 ? `(${s.aimingSlot})` : s.pressedSlot >= 0 ? `(${s.pressedSlot})` : ""}` +
      ` · roles ${roles}` +
      `${s.reasons.length ? ` · suspend [${s.reasons.join(",")}]` : ""}` +
      `${s.gated ? " · GATED" : ""}`;
    this.logEl.textContent = this.lines.join("  ");
    let i = 0;
    for (const p of this.live.values()) {
      if (i >= DOT_POOL) break;
      const d = this.dots[i++];
      d.style.display = "block";
      d.style.transform = `translate3d(${p.x - 22}px, ${p.y - 22}px, 0)`;
    }
    for (; i < DOT_POOL; i++) this.dots[i].style.display = "none";
  }
}

function el(tag: string, id: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (id) e.id = id;
  if (cls) e.className = cls;
  return e;
}

function injectCss(): void {
  if (document.getElementById("tdbg-style")) return;
  const s = document.createElement("style");
  s.id = "tdbg-style";
  s.textContent = `
#tdbg { position: fixed; left: 50%; top: 4px; transform: translateX(-50%);
  z-index: 99; pointer-events: none; background: rgba(6,10,14,0.82);
  color: #9fe8ff; border: 1px solid rgba(57,200,232,0.5); border-radius: 6px;
  padding: 3px 8px; font: 700 11px/1.45 ui-monospace, Menlo, monospace;
  text-align: center; max-width: 92vw; white-space: nowrap; overflow: hidden; }
#tdbg-head.multi { color: #7dff9a; }
#tdbg-fsm { color: #ffe9b0; }
#tdbg-log { color: #cfd8de; font-weight: 400; }
.tdbg-dot { position: fixed; left: 0; top: 0; width: 44px; height: 44px;
  z-index: 98; pointer-events: none; border-radius: 50%;
  border: 3px solid #39c8e8; background: rgba(57,200,232,0.18);
  will-change: transform; }
`;
  document.head.appendChild(s);
}
