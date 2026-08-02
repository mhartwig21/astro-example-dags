import type { Vec2 } from "../sim/types";

/**
 * Touch layout: zones and control geometry as DATA, not CSS constants.
 *
 * Everything the touch state machine needs to decide "what did this finger
 * land on" is computed here, once per layout change (resize /
 * orientationchange / pref change) — never per frame and never inside a
 * pointer handler. Pure: viewport + insets + prefs in, a ZoneTable out, so
 * test/touchLayout.test.ts can assert reach and mirroring without a DOM.
 *
 * Two ideas carry the file:
 *
 *  1. DEVICE CLASS picks the POSTURE (where the hand grips the slab); the
 *     geometry inside a class is a continuous function of the short edge, so
 *     an 11-inch and a 13-inch tablet do not share one hardcoded arc.
 *  2. THE PIVOT is the thumb root, not the screen corner. A phone in
 *     landscape is held at the bottom corners; a tablet is gripped at the
 *     sides with the thumb rooted well above the corner. Controls sit on an
 *     arc around the pivot whose radius is chosen so every in-combat control
 *     lands inside `comfortable` — and that invariant is a test.
 *
 * Left-handed is a single reflection of the table about the viewport vertical
 * centre line: zones are data, so mirroring is arithmetic.
 */

export type DeviceClass = "compact" | "phone" | "tablet-s" | "tablet-l";

export interface Insets { top: number; right: number; bottom: number; left: number }

export interface Rect { x: number; y: number; w: number; h: number }

/** Controls the layout owns. Chips keep their DOM home; these are hit rects. */
export type ControlId =
  | "slot0" | "slot1" | "slot2" | "slot3" | "slot4"
  | "flask" | "context" | "lock" | "map";

/** Controls a player must press mid-fight — the reach invariant covers these. */
export const COMBAT_CONTROLS: ControlId[] = [
  "slot0", "slot1", "slot2", "slot3", "slot4", "flask", "context", "lock",
];

export interface LayoutPrefs {
  handed: "right" | "left";
  /** Movement stick radius multiplier (0.7 - 1.4). */
  stickScale: number;
  /** Chip size multiplier (0.7 - 1.4). */
  buttonScale: number;
  /** Extra padding on top of the hardware safe-area inset (0 - 32 px). */
  hudInset: number;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  handed: "right", stickScale: 1, buttonScale: 1, hudInset: 12,
};

export interface ControlRect extends Rect {
  id: ControlId;
  cx: number;
  cy: number;
  /** Distance of the centre from the class pivot (CSS px). */
  fromPivot: number;
}

export interface ZoneTable {
  cls: DeviceClass;
  viewport: { w: number; h: number };
  insets: Insets;
  /** The box every control must live inside (hardware inset + player pad). */
  safe: Rect;
  /** Movement thumb territory. Excludes the top status band and the gutter. */
  stickZone: Rect;
  /** Taps here select / lock / move. Everything not a zone or a chip. */
  worldZone: Rect;
  /** Labelled CANCEL band; live only while a chip is AIMING. */
  cancelBand: Rect;
  /** Floating stick radius in CSS px (dead zone and recentring scale off it). */
  stickRadius: number;
  /** Where the resting ghost ring sits before the first touch. */
  stickAnchor: Vec2;
  /** Thumb root for the ability cluster. */
  pivot: Vec2;
  /** Radius of the cluster arc. */
  arcRadius: number;
  comfortable: number;
  stretch: number;
  /** Chip geometry: hit rects the router uses, and the shell paints. */
  controls: Record<ControlId, ControlRect>;
}

/** Short-edge to thumb reach, in CSS px. The rule, not one phone instance of it. */
export function reachArcs(shortEdge: number): { comfortable: number; stretch: number } {
  const comfortable = Math.max(150, Math.min(300, 0.55 * shortEdge));
  return { comfortable, stretch: 1.37 * comfortable };
}

/** Four classes, because 500-744 is a real gap and a 10-inch is not a 13-inch. */
export function deviceClass(shortEdge: number, coarse: boolean): DeviceClass {
  if (!coarse) return shortEdge < 560 ? "phone" : "tablet-l";
  if (shortEdge < 380) return "compact";
  if (shortEdge < 560) return "phone";
  if (shortEdge < 900) return "tablet-s";
  return "tablet-l";
}

/** Tablets are gripped at the sides; phones at the bottom corners. */
export function isSideGrip(cls: DeviceClass): boolean {
  return cls === "tablet-s" || cls === "tablet-l";
}

/**
 * Cluster arc: angle from the inboard horizontal (0 = straight inboard,
 * 90 = straight up the outer edge) and a fraction of the arc radius. The
 * basic-attack chip sits nearest the thumb root; the ultimate rides up the
 * outer edge where a stray thumb cannot brush it.
 */
const ARC: { id: ControlId; ang: number; rf: number; size: number }[] = [
  { id: "slot0", ang: 40, rf: 0.30, size: 1.40 }, // basic attack, hold-to-repeat
  { id: "flask", ang: -12, rf: 0.66, size: 0.92 },
  { id: "slot1", ang: 8, rf: 0.74, size: 1.0 },
  { id: "slot2", ang: 34, rf: 0.80, size: 1.0 },
  { id: "slot3", ang: 60, rf: 0.80, size: 1.0 },
  { id: "slot4", ang: 86, rf: 0.72, size: 1.14 }, // ultimate
  { id: "context", ang: 22, rf: 1.0, size: 0.86 },
  { id: "lock", ang: 72, rf: 1.0, size: 0.80 },
  { id: "map", ang: 100, rf: 0.94, size: 0.80 },
];

const RAD = Math.PI / 180;

/** Minimum touch target, both axes. Visual size may be smaller; the rect is not. */
export const MIN_TARGET = 44;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function computeZones(
  vw: number, vh: number, insets: Insets, prefs: LayoutPrefs, coarse = true,
): ZoneTable {
  const pad = clamp(prefs.hudInset, 0, 32);
  const safe: Rect = {
    x: insets.left + pad,
    y: insets.top + pad,
    w: Math.max(80, vw - insets.left - insets.right - pad * 2),
    h: Math.max(80, vh - insets.top - insets.bottom - pad * 2),
  };
  const shortEdge = Math.min(vw, vh);
  const cls = deviceClass(shortEdge, coarse);
  const { comfortable, stretch } = reachArcs(shortEdge);
  const mirror = prefs.handed === "left";

  // --- cluster ----------------------------------------------------------
  const chipBase = clamp(0.13 * shortEdge, MIN_TARGET, 76) * clamp(prefs.buttonScale, 0.7, 1.4);
  const maxHalf = (chipBase * 1.40) / 2; // the biggest chip on the arc
  const side = isSideGrip(cls);
  // Corner grip roots the thumb at the bottom outer corner; a side grip roots
  // it up the outer edge at 62% height. Measured on an iPad, re-pivoting ALONE
  // moves the problem from the ultimate to the flask — so the radius
  // compresses with the pivot, and both come from the short edge.
  const pivotOuter = safe.x + safe.w - 26;
  const pivot: Vec2 = {
    x: mirror ? vw - pivotOuter : pivotOuter,
    y: side ? insets.top + vh * 0.62 : safe.y + safe.h - 26,
  };
  // The invariant: centre + half a chip must land inside `comfortable`.
  const arcRadius = Math.max(64, comfortable - maxHalf - 6);

  const controls = {} as Record<ControlId, ControlRect>;
  for (const spec of ARC) {
    const size = Math.max(MIN_TARGET, chipBase * spec.size);
    // A CORNER GRIP HAS NO ROOM BELOW THE PIVOT. The arc is authored with the
    // flask just under the horizontal (ang -12), which is right for a side
    // grip — the tablet pivot sits at 62% height with room underneath. On a
    // phone the pivot IS the bottom of the safe box, so a negative angle puts
    // the chip outside it, the clamp drags it back to the edge, and it can
    // then never move down to make room for its neighbours: the whole cluster
    // jams against a chip that cannot yield.
    const ang = side ? spec.ang : Math.max(6, spec.ang);
    const dx = Math.cos(ang * RAD) * arcRadius * spec.rf;
    const dy = Math.sin(ang * RAD) * arcRadius * spec.rf;
    let cx = mirror ? pivot.x + dx : pivot.x - dx;
    let cy = pivot.y - dy;
    // Never let a chip hang into a gutter — clamp the CENTRE, then re-measure
    // reach so the table never lies about where the thumb has to travel.
    cx = clamp(cx, safe.x + size / 2, safe.x + safe.w - size / 2);
    cy = clamp(cy, safe.y + size / 2, safe.y + safe.h - size / 2);
    controls[spec.id] = {
      id: spec.id, cx, cy, x: cx - size / 2, y: cy - size / 2, w: size, h: size,
      fromPivot: Math.hypot(cx - pivot.x, cy - pivot.y),
    };
  }
  separate(controls, safe, pivot);

  // --- zones ------------------------------------------------------------
  // The status band owns the top of the screen; the stick never reaches into
  // it (that is where the HUD and the transient cards live).
  const bandH = cls === "compact" ? Math.max(38, vh * 0.14) : Math.max(44, vh * 0.15);
  const stickW = Math.min(safe.w * 0.46, vw * 0.46);
  const stickTop = Math.max(safe.y, bandH);
  const stickZone: Rect = {
    x: mirror ? safe.x + safe.w - stickW : safe.x,
    y: stickTop,
    w: stickW,
    h: Math.max(80, safe.y + safe.h - stickTop),
  };
  // The world zone is everything between the stick and the cluster.
  const clusterLeft = Math.min(...ARC.map((s) => controls[s.id].x));
  const clusterRight = Math.max(...ARC.map((s) => controls[s.id].x + controls[s.id].w));
  const clusterTop = Math.min(...ARC.map((s) => controls[s.id].y));
  const worldTop = Math.max(safe.y, bandH * 0.62);
  const worldX = mirror ? safe.x : stickZone.x + stickZone.w;
  const worldRight = mirror
    ? Math.max(worldX + 60, Math.min(stickZone.x, clusterLeft))
    : Math.max(worldX + 60, clusterLeft);
  const worldZone: Rect = {
    x: worldX, y: worldTop,
    w: worldRight - worldX,
    h: Math.max(80, safe.y + safe.h - worldTop),
  };

  // CANCEL band: a labelled strip directly above the cluster, inside reach and
  // wide enough that a panicked thumb finds it without aiming at it.
  const bandHeight = Math.max(MIN_TARGET, chipBase * 0.9);
  const cancelW = Math.min(safe.w * 0.52, Math.max(200, arcRadius * 1.7));
  const cancelX = mirror
    ? clamp(clusterLeft - 8, safe.x, safe.x + safe.w - cancelW)
    : clamp(clusterRight - cancelW + 8, safe.x, safe.x + safe.w - cancelW);
  const cancelBand: Rect = {
    x: cancelX,
    y: clamp(clusterTop - bandHeight - 14, safe.y, safe.y + safe.h - bandHeight),
    w: cancelW, h: bandHeight,
  };

  const stickRadius = clamp(0.16 * shortEdge, 52, 88) * clamp(prefs.stickScale, 0.7, 1.4);
  const anchorX = mirror ? vw - vw * 0.22 : vw * 0.22;
  const stickAnchor: Vec2 = {
    x: clamp(anchorX, stickZone.x + stickRadius,
      Math.max(stickZone.x + stickRadius, stickZone.x + stickZone.w - stickRadius)),
    y: clamp(vh * 0.72, stickZone.y + stickRadius,
      Math.max(stickZone.y + stickRadius, stickZone.y + stickZone.h - stickRadius)),
  };

  return {
    cls, viewport: { w: vw, h: vh }, insets, safe, stickZone, worldZone, cancelBand,
    stickRadius, stickAnchor, pivot, arcRadius, comfortable, stretch, controls,
  };
}

/**
   * NO TWO CHIPS MAY OVERLAP.
   *
   * The arc is authored in angles and radius fractions, so its spacing scales
   * with `arcRadius` — but the 44px hit-target floor does not. Below roughly
   * 130px of arc radius the chips start to collide, and an overlap is not a
   * cosmetic problem: `controlAt()` resolves it by nearest centre, while the
   * DOM hit-test in `chipUnder()` returns whichever chip PAINTS last. The two
   * disagree, and the DOM wins.
   *
   * Measured on a Pixel 5 (802x293): the flask's rect covered slot 1's own
   * centre, so tapping DASH drank a potion.
   *
   * This is a few passes of pair relaxation: push overlapping boxes apart along
   * their axis of LEAST penetration (they are axis-aligned squares, so that is
   * the cheapest way out), re-clamp into the safe box, repeat. Order-stable
   * because every pair moves both members by the same half-step, and bounded
   * because each pass strictly reduces total penetration or stops.
   */
function separate(
  controls: Record<ControlId, ControlRect>, safe: Rect, pivot: Vec2,
): void {
  const ids = Object.keys(controls) as ControlId[];
  const GAP = 2; // a hair of daylight, so "adjacent" never rounds into "over"
  for (let pass = 0; pass < 48; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = controls[ids[i]], b = controls[ids[j]];
        const needX = (a.w + b.w) / 2 + GAP, needY = (a.h + b.h) / 2 + GAP;
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const penX = needX - Math.abs(dx), penY = needY - Math.abs(dy);
        if (penX <= 0 || penY <= 0) continue;
        moved = true;
        // Push along the LINE BETWEEN THE CENTRES, not along the axis of least
        // penetration. Least-penetration is the cheaper exit in open space,
        // but it grinds when that axis is the one the safe box has already
        // clamped: the pass makes no progress and the next pass picks the same
        // axis again. Sliding along the centre line lets a jammed pair travel
        // around an edge instead of into it.
        const len = Math.hypot(dx, dy);
        // Coincident centres have no direction; break the tie deterministically
        // rather than dividing by zero.
        const ux = len > 1e-6 ? dx / len : 1, uy = len > 1e-6 ? dy / len : 0;
        const push = Math.min(penX, penY) / 2 + 0.25;
        a.cx -= ux * push; a.cy -= uy * push;
        b.cx += ux * push; b.cy += uy * push;
      }
    }
    for (const id of ids) {
      const c = controls[id];
      c.cx = clamp(c.cx, safe.x + c.w / 2, safe.x + safe.w - c.w / 2);
      c.cy = clamp(c.cy, safe.y + c.h / 2, safe.y + safe.h - c.h / 2);
    }
    if (!moved) break;
  }
  // The table must never lie about reach, so re-derive the rects and the
  // pivot distances from wherever separation actually left each centre.
  for (const id of ids) {
    const c = controls[id];
    c.x = c.cx - c.w / 2;
    c.y = c.cy - c.h / 2;
    c.fromPivot = Math.hypot(c.cx - pivot.x, c.cy - pivot.y);
  }
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Which control a press claims. Rects pad to MIN_TARGET and OVERLAP-RESOLVE by
 * nearest centre, so a press between two chips picks the closer one instead of
 * whichever happens to paint on top. `slack` extends the search a little past
 * the rect: thumbs land short of what they aim at.
 */
export function hitControl(
  z: ZoneTable, x: number, y: number, slack = 6,
): ControlId | null {
  let best: ControlId | null = null;
  let bestD = Infinity;
  for (const id of Object.keys(z.controls) as ControlId[]) {
    const c = z.controls[id];
    const halfW = Math.max(MIN_TARGET, c.w) / 2 + slack;
    const halfH = Math.max(MIN_TARGET, c.h) / 2 + slack;
    if (Math.abs(x - c.cx) > halfW || Math.abs(y - c.cy) > halfH) continue;
    const d = Math.hypot(x - c.cx, y - c.cy);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/** Coarse routing for a pointer that did not land on a control. */
export function hitZone(z: ZoneTable, x: number, y: number): "stick" | "world" | null {
  if (inRect(z.stickZone, x, y)) return "stick";
  if (inRect(z.worldZone, x, y)) return "world";
  return null;
}

/** Reads the published --sa-* custom properties (0 where the browser lies). */
export function readInsets(el?: Element | null): Insets {
  if (typeof getComputedStyle !== "function" || !el) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(el);
  const num = (name: string): number => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return { top: num("--sa-t"), right: num("--sa-r"), bottom: num("--sa-b"), left: num("--sa-l") };
}