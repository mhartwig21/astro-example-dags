import type { ControlId, Insets, Rect, ZoneTable } from "../input/touchLayout";

/**
 * THE HUD'S HALF OF THE ZONE TABLE.
 *
 * `touchLayout.computeZones()` decides where a thumb can reach; this file makes
 * the PAINT agree with it. Before this module the ability cluster was a stack
 * of hardcoded pixel offsets in iso.html, which is why the measured chip
 * distances from the corner pivot were *identical* on a 293-tall Pixel 5 and a
 * 380-tall iPhone 13 Pro Max (MOBILE.md §1.5): one fixed arc, five device
 * shapes. Now there is one source of truth, and `TouchShell.measureChips()`
 * reads back exactly the rects the table published.
 *
 * THE RULES THIS FILE OBEYS
 *
 *  1. It runs on the LAYOUT lifecycle only — resize, orientationchange,
 *     visualViewport resize, a pref change, or a skill-bar rebuild. Never per
 *     frame, and never inside a pointer handler.
 *  2. Every write is `transform` / `width` / `height` / a custom property.
 *     No `left`/`top` writes in a hot path.
 *  3. Nothing here is a game rule. It moves boxes.
 *
 * SAFE AREAS. `env(safe-area-inset-*)` is published once by the touch shell as
 * `--sa-t/r/b/l`, and every fixed HUD element in iso.html offsets by
 * `calc(var(--sa-X) + var(--hud-pad))`. Chromium reports 0 for `env()` under
 * device emulation, so `?safe=t,r,b,l` overrides the four properties — that is
 * how the headless battery can assert "given the browser reports inset N, does
 * every HUD rect clear N", which is the part of safe-area handling that is
 * actually ours. Whether Safari reports the right N is Safari's business.
 */

export type UiClass = ZoneTable["cls"];

export const UI_CLASSES: readonly UiClass[] = ["compact", "phone", "tablet-s", "tablet-l"];

/** Controls this module paints into place from the table. */
const CLUSTER: ControlId[] = ["slot0", "slot1", "slot2", "slot3", "slot4", "flask"];

// --------------------------------------------------------------- pure bits

/**
 * `?safe=47,21,47` / `?safe=0,24,20,0` -> an inset override, or null.
 *
 * One value = all four. Two = vertical, horizontal. Three = top, horizontal,
 * bottom (the CSS shorthand order, because that is the order people expect).
 * Four = top, right, bottom, left. Anything else is a typo, and a typo must
 * not silently move the HUD, so it returns null and `env()` stands.
 */
export function parseSafeOverride(raw: string | null): Insets | null {
  if (!raw) return null;
  const n = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (n.some((v) => !Number.isFinite(v) || v < 0)) return null;
  if (n.length === 1) return { top: n[0], right: n[0], bottom: n[0], left: n[0] };
  if (n.length === 2) return { top: n[0], right: n[1], bottom: n[0], left: n[1] };
  if (n.length === 3) return { top: n[0], right: n[1], bottom: n[2], left: n[1] };
  if (n.length === 4) return { top: n[0], right: n[1], bottom: n[2], left: n[3] };
  return null;
}

/**
 * The band's BOTTOM EDGE, measured from the viewport top — not its height.
 *
 * This is deliberately the same expression `computeZones` uses to pick
 * `stickZone.y`, and it is measured from y=0 rather than from the safe box,
 * so the two agree BY CONSTRUCTION. When they were computed independently they
 * disagreed by exactly the HUD padding, and a card parked at the band's bottom
 * edge reached 12px into the movement thumb's territory — which is the same
 * class of bug as the courtesy card that covered the stick outright (§1.2).
 */
export function bandBottom(z: ZoneTable): number {
  const vh = z.viewport.h;
  return z.cls === "compact" ? Math.max(38, vh * 0.14) : Math.max(44, vh * 0.15);
}

/**
 * The top status band: the strip transient cards, the banner and the show
 * chips own, and which the movement stick is forbidden from reaching into.
 * It stops short of the minimap puck so a toast can never hide the chart.
 */
export function topBand(z: ZoneTable, puckW: number): Rect {
  const s = z.safe;
  const right = Math.max(s.x + 120, s.x + s.w - puckW - 16);
  return { x: s.x, y: s.y, w: right - s.x, h: Math.max(0, bandBottom(z) - s.y) };
}

/**
 * HUD chrome scale. A 293-tall Pixel 5 and an 834-tall iPad Pro cannot share a
 * font size any more than they can share a cluster arc, so the chrome rides a
 * continuous curve off the short edge and is clamped at both ends.
 */
export function hudScale(shortEdge: number, coarse: boolean): number {
  if (!coarse) return 1;
  return clamp(0.62 + (shortEdge - 280) * 0.0011, 0.62, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ------------------------------------------------------------------ shell

const MAP_ICON = "/icons/ui/marker.svg";

export interface HudLayoutOpts {
  /** Idle chip opacity (0.35 - 1.0). Full while pressed — the shell does that. */
  opacity: number;
  /** Opens the full-screen map. The same seam the MAP chip edge drives. */
  onMap?: () => void;
}

export class HudLayout {
  private zones: ZoneTable | null = null;
  private mapChip: HTMLElement | null = null;
  private fanArc: HTMLElement | null = null;
  private opacity = 1;

  constructor(private readonly o: HudLayoutOpts) {
    this.opacity = o.opacity;
    if (typeof document === "undefined") return;
    // THE FAN TRACK (wr_01/wr_03): a faint annular band under the ability
    // ring, clipped to the fan's span, so the corner cluster reads as ONE
    // quarter-circle organism instead of loose coins. It must paint UNDER the
    // chips: the chips are z-auto fixed elements, so the track is inserted
    // EARLIER in the DOM (before #cockpit) rather than given a z-index that
    // would lift it above them. Pointer-transparent; geometry inline from the
    // zone table; visibility via class so a stylesheet keeps authority over
    // modal/cine/checkin standdowns (never inline display — the shop lesson).
    const fan = document.createElement("div");
    fan.id = "t-fanarc";
    const cockpit = document.getElementById("cockpit");
    if (cockpit?.parentElement) cockpit.parentElement.insertBefore(fan, cockpit);
    else document.body.appendChild(fan);
    this.fanArc = fan;
    const layer = document.createElement("div");
    layer.id = "hud-chips";
    const map = document.createElement("button");
    map.id = "t-map";
    map.dataset.tctl = "map";
    map.type = "button";
    map.setAttribute("aria-label", "Open map");
    map.innerHTML =
      `<i class="uic" style="mask-image:url(${MAP_ICON});-webkit-mask-image:url(${MAP_ICON})"></i>`;
    // The chip is also a plain button, so the map still opens on a touch laptop
    // and for a screen reader even when the gameplay router is off.
    map.addEventListener("click", (e) => { e.preventDefault(); this.o.onMap?.(); });
    layer.appendChild(map);
    document.body.appendChild(layer);
    this.mapChip = map;
  }

  /** Seed `--sa-*` from a URL override so the headless battery can assert them. */
  static applySafeOverride(insets: Insets | null): void {
    if (!insets || typeof document === "undefined") return;
    const r = document.documentElement.style;
    r.setProperty("--sa-t", `${insets.top}px`);
    r.setProperty("--sa-r", `${insets.right}px`);
    r.setProperty("--sa-b", `${insets.bottom}px`);
    r.setProperty("--sa-l", `${insets.left}px`);
  }

  /** The whole layout pass. Called from `TouchShell.onLayout` and nowhere hot. */
  apply(z: ZoneTable, opacity = this.opacity): void {
    this.zones = z;
    this.opacity = opacity;
    if (typeof document === "undefined") return;
    const root = document.documentElement.style;
    document.body.dataset.uiclass = z.cls;
    // The economy the table was built with, for CSS that must agree with it
    // (compact demotes the context pill's padding, the empty-slot treatment).
    document.body.dataset.tpreset = z.preset;
    root.setProperty("--hud-scale", hudScale(Math.min(z.viewport.w, z.viewport.h), true).toFixed(3));
    // --band-h is the band's BOTTOM in viewport px, so a card can sit at
    // `top: var(--band-h)` and be guaranteed clear of the stick zone.
    root.setProperty("--band-h", `${Math.round(bandBottom(z))}px`);
    root.setProperty("--chip-op", String(clamp(opacity, 0.35, 1)));
    // Published so the CSS can keep decoration out of the movement thumb's box.
    root.setProperty("--stick-w", `${Math.round(z.stickZone.w)}px`);
    this.placeCluster();
    this.placeMap();
    this.placeFanArc();
    this.measureChrome();
  }

  /**
   * THE FAN TRACK — the one paint that makes the corner cluster read as a
   * single quarter-circle unit (wr_01/wr_03 both draw a faint band under the
   * ability ring). A translucent annulus centred on the PRIMARY, clipped to
   * the fan's angular span with a conic mask, squeezed vertically by the same
   * ellipse the layout applied to the ring. Corner grips only; the side-grip
   * fan is symmetric and needs no unifying band.
   */
  private placeFanArc(): void {
    const z = this.zones, el = this.fanArc;
    if (!z || !el || typeof document === "undefined") return;
    const corner = z.cls === "compact" || z.cls === "phone";
    el.classList.toggle("on", corner && document.body.classList.contains("touch"));
    if (!corner) return;
    const s1 = z.controls.slot1, ult = z.controls.slot4;
    const fanVis = s1.vis ?? s1.w;
    const ultVis = ult.vis ?? ult.w;
    const R = z.arcRadius;
    // The layout may have squeezed the fan vertically (short glass); read the
    // actual ellipse off the ultimate's landed position rather than guessing.
    const sy = Math.max(0.5, Math.min(1, (z.pivot.y - ult.cy) / (R * 1.05 * 0.999)));
    // THE TRACK IS A RIM AROUND THE DISCS, NOT A MOAT. Its width is now read
    // off the discs the ring actually carries — the ultimate sets the outer
    // edge because it is both the widest fan chip and the furthest out — with
    // a fifth of a disc of margin. Pinned to a constant 8 px it read fine at
    // r3's 56 px chips and would read as a wide empty band under the
    // reference-sized 42.8 px ones.
    const pad = Math.max(5, fanVis * 0.2);
    const Ro = R * 1.05 + ultVis / 2 + pad;
    const Ri = Math.max(24, R - fanVis / 2 - pad);
    const size = Math.ceil(Ro * 2);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.transform =
      `translate3d(${Math.round(z.pivot.x - Ro)}px, ${Math.round(z.pivot.y - Ro * sy)}px, 0) scaleY(${sy.toFixed(3)})`;
    el.style.transformOrigin = "50% 0%";
    el.style.background =
      `radial-gradient(circle, rgba(0,0,0,0) ${Math.round(Ri - 1)}px, rgba(201,162,75,0.14) ${Math.round(Ri)}px, ` +
      `rgba(10,12,16,0.30) ${Math.round(Ri + 5)}px, rgba(10,12,16,0.30) ${Math.round(Ro - 6)}px, ` +
      `rgba(201,162,75,0.14) ${Math.round(Ro - 1)}px, rgba(0,0,0,0) ${Math.round(Ro)}px)`;
    // The fan sweeps -14..92 deg about the inboard horizontal (`wr_01`'s own
    // angles); in conic terms (0 = up, clockwise) a chip at `a` sits at
    // 270 + a right-handed and 90 - a mirrored, so the span is 256..362 and
    // -2..104. The track runs a chip's half-width past each end so the first
    // and last discs sit ON the band rather than hanging off it.
    const mirror = document.body.classList.contains("handed-left");
    const from = mirror ? -20 : 240;
    const mask =
      `conic-gradient(from ${from}deg, rgba(0,0,0,0) 0deg 2deg, #000 16deg, #000 123deg, rgba(0,0,0,0) 139deg 360deg)`;
    el.style.webkitMask = mask;
    el.style.mask = mask;
  }

  /**
   * Place the ability cluster from the table.
   *
   * Also called after `updateSkills()` rewrites `#skills.innerHTML` — a loadout
   * or glyph change replaces every chip element, and an unplaced chip would
   * collapse into the top-left corner until the next resize.
   */
  placeCluster(): void {
    const z = this.zones;
    if (!z || typeof document === "undefined") return;
    if (!document.body.classList.contains("touch")) return;
    for (const id of CLUSTER) {
      const el = chipEl(id);
      if (!el) continue;
      const c = z.controls[id];
      // Paint the VISUAL disc, centred on the hit rect's own centre. The hit
      // target is still >= 44px: the router pads every cached rect to 44
      // (`controlAt`), so a smaller paint never shrinks what a thumb can hit.
      //
      // A LOCKED slot is a fact, not a control: a full-size circle advertising
      // an absence is what put "two locked-slot circles" (one of them the
      // biggest disc on the glass — the empty ultimate) in the owner's
      // screenshot. Empty ability slots paint at a satellite-of-satellites
      // 40%, floored at 22 px so the socket still reads as "earnable"; the
      // flask keeps its size (a SPENT flask is a live control refilling), and
      // slot0 is never empty. The width/height here are inline styles, so
      // this is the one place the demotion can live — a stylesheet rule would
      // lose to the very pixels this module writes.
      const locked = id !== "slot0" && id !== "flask" && el.classList.contains("empty");
      const v = Math.round(locked
        ? Math.max(22, (c.vis ?? c.w) * 0.4)
        : (c.vis ?? c.w));
      el.style.width = `${v}px`;
      el.style.height = `${v}px`;
      el.style.transform = `translate3d(${Math.round(c.cx - v / 2)}px, ${Math.round(c.cy - v / 2)}px, 0)`;
    }
    // The context chip is a labelled pill, not a disc: centre it on the arc
    // point instead of sizing it, so "DESCEND" never gets clipped to a circle.
    const ctx = document.getElementById("t-stairs");
    if (ctx) {
      const c = z.controls.context;
      ctx.style.transform =
        `translate3d(${Math.round(c.cx)}px, ${Math.round(c.cy)}px, 0) translate(-50%, -50%)`;
    }
  }

  private placeMap(): void {
    const z = this.zones, el = this.mapChip;
    if (!z || !el) return;
    const c = z.controls.map;
    const v = Math.round(c.vis ?? c.w);
    el.style.width = `${v}px`;
    el.style.height = `${v}px`;
    el.style.transform = `translate3d(${Math.round(c.cx - v / 2)}px, ${Math.round(c.cy - v / 2)}px, 0)`;
  }

  /**
    * THE TOP BAND'S TWO MEASURED FACTS.
    *
    * 1. `#xpbar` lived at `bottom: -14px` inside `#cockpit` — measured 4px
    *    BELOW the viewport on both the phone and the tablet, i.e. permanently
    *    invisible. On touch it becomes a thin under-rail of the HP block.
    * 2. The transient-card column runs BETWEEN the two plaques. Both plaques
    *    size themselves from their content (floor number, gold, level), so the
    *    gap is not a constant and cannot be one in CSS.
    *
    * Both read layout, so both are on the layout lifecycle — never per frame,
    * and never from inside a pointer handler.
    */
  private measureChrome(): void {
    const z = this.zones;
    if (!z || typeof document === "undefined") return;
    const root = document.documentElement.style;
    if (!document.body.classList.contains("touch")) {
      for (const p of ["--xp-top", "--xp-w", "--card-x", "--card-w"]) root.removeProperty(p);
      return;
    }
    const tl = document.getElementById("hud-tl")?.getBoundingClientRect();
    const tr = document.getElementById("hud-tr")?.getBoundingClientRect();
    if (tr && tr.width > 0) {
      root.setProperty("--xp-top", `${Math.round(tr.bottom + 4)}px`);
      root.setProperty("--xp-w", `${Math.round(tr.width)}px`);
    }
    // THE CARD MUST NOT CLIP THE COLLAPSE CLOCK. `--card-x` was `tl.right + 8`
    // measured on the layout lifecycle, but `#hud-tl`'s content — the floor
    // number and the collapse clock — changes width every second, so the gap
    // this measured went stale between resizes and the card crept back over
    // the plaque (29% of `#hud-tl` covered, the state word clipped 'SAFE' ->
    // 'S', which the CSS comment beside it explicitly promised not to do).
    // A fraction-of-safe-box floor is stable against content that breathes.
    const left = Math.max(
      tl && tl.width > 0 ? tl.right + 10 : z.safe.x,
      z.safe.x + 0.22 * z.safe.w,
    );
    const right = tr && tr.width > 0 ? tr.left - 8 : z.safe.x + z.safe.w;
    // A card narrower than this is unreadable; below the floor it is better to
    // overlap a plaque than to hyphenate every word.
    const w = Math.max(220, right - left);
    root.setProperty("--card-x", `${Math.round(left)}px`);
    root.setProperty("--card-w", `${Math.round(Math.min(w, z.viewport.w - left - 8))}px`);

    // THE TOAST RAIL'S WIDTH, exactly.
    //
    // The CSS used to derive it as `100vw - stick-w*2 - 32`, subtracting the
    // stick zone from BOTH sides of a layout that has a stick on one side and
    // a cluster on the other: 76 px on a Pixel 5, i.e. one word per line, and
    // the column grew tall enough to start above the top of the screen. The
    // rail runs from the outer gutter to the CLUSTER's inboard edge — it may
    // overlap the stick zone (it is pointer-events: none and the stick takes a
    // press anywhere), it may never overlap a chip.
    const ids = Object.keys(z.controls) as ControlId[];
    const clusterLeft = Math.min(...ids.map((id) => z.controls[id].x));
    const clusterRight = Math.max(...ids.map((id) => z.controls[id].x + z.controls[id].w));
    const mirror = document.body.classList.contains("handed-left");
    const avail = mirror
      ? (z.safe.x + z.safe.w) - clusterRight - 12
      : clusterLeft - 12 - z.safe.x;
    root.setProperty("--toast-w", `${Math.round(Math.max(200, avail))}px`);
  }

  /** The map chip is the only control this layer owns; hand back its rect. */
  mapRect(): Rect | null {
    const z = this.zones;
    if (!z || !this.mapChip) return null;
    const c = z.controls.map;
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  }

  setOpacity(op: number): void {
    this.opacity = clamp(op, 0.35, 1);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--chip-op", String(this.opacity));
    }
  }
}

function chipEl(id: ControlId): HTMLElement | null {
  if (id === "flask") return document.getElementById("flask-chip");
  const i = Number(id.slice(4));
  return document.querySelector(`#skills .skill[data-i="${i}"]`);
}
