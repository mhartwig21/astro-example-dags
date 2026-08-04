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
 * THE ONE IDEA THIS FILE NOW ENFORCES (MOBILE.md §2.0)
 *
 * A quantity set by the HAND is authored in MILLIMETRES and converted once
 * per device class through `MM_PER_PX`; a quantity set by the SCREEN is
 * authored as a viewport fraction. Four of the six spec contradictions were
 * the same mistake — a hand quantity written as a function of the screen:
 *
 *   hand-scale   stick radius, aim throw, cancel radius, chip size, reach arcs
 *   screen-scale zone rectangles, the status band, the world zone, the caps
 *
 * The viewport decides how much ROOM those quantities have (the caps below),
 * never how BIG they are. A thumb is 48 mm on a 6.0" Pixel and on a 12.9"
 * iPad, and a CSS pixel is not: iOS ships tablets at a deliberately lower
 * point density than phones, which is exactly why the old short-edge model
 * cramped phones by 31% and oversized tablets by 17% with one formula.
 *
 * The second idea: DEVICE CLASS picks the POSTURE, and posture selects pivot,
 * radius cap AND fan together (§4.2a). A phone in landscape is held at the
 * bottom corners, so its fan climbs up-and-inboard (there is nothing below a
 * corner). A tablet is gripped at the SIDES with the thumb rooted well above
 * the corner, so its fan is symmetric about the inboard horizontal — fanning a
 * side grip upward wastes half the thumb's arc and spends the other half on
 * the playfield, which is the geometry §1.5 condemns on the phone.
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

/**
 * NAVIGATION controls — pressed BETWEEN fights, and deliberately NOT held to
 * `comfortable`.
 *
 * `map` measured 290 px from an iPhone 13's pivot against a 274 px comfortable
 * arc, and a critic correctly flagged that `test/touchLayout.test.ts` asserts
 * combat controls are inside `comfortable` while this one is not. It is not
 * inside because it is not a combat control: opening the chart is a decision
 * you make with the pack dead, with time to regrip, and giving it a
 * comfortable-arc slot would cost that slot to a chip you press under fire.
 * The exclusion is now explicit and it carries its own weaker invariant —
 * every nav control must still clear `stretch` (342 px on the same phone), so
 * "not comfortable" can never silently become "not reachable".
 */
export const NAV_CONTROLS: ControlId[] = ["map"];

/**
 * MILLIMETRES PER CSS PIXEL, per class (MOBILE.md §2.0).
 *
 * Derived from published panel dimensions, not measured through the browser —
 * an emulator reports the descriptor's CSS viewport and dpr, never a physical
 * size. Spread inside a class is <= 2%, which is what makes a class-wide
 * constant honest; the residual (and the +/-20% of hand size no formula can
 * see) is what the player sliders are for.
 *
 *   compact + phone   Pixel 5 (156.2 dp/in), iPhone 13 (153.4 pt/in),
 *                     13 Pro Max (152.7) -> 0.163 / 0.165 / 0.165
 *   tablet-s          iPad Pro 11 (132.4), iPad 7 (132.4)
 *   tablet-l          iPad Pro 12.9 (132.3)
 *
 * THE compact/phone BOUNDARY IS ABOUT ROOM, NOT ABOUT HANDS (see
 * `deviceClass`). A critic caught the two tiers disagreeing with §2.0's own
 * device table — §4.1's `short edge < 380` files iPhone 13 landscape under
 * `compact` while §2.0 and §3.2 file the same device under `phone` — and
 * concluded the number came out right by accident. It did. The reconciliation
 * is to stop pretending the tiers are different HANDS: 0.163 and 0.165 are
 * 1.2% apart, well inside the <= 2% intra-class spread this table already
 * declares acceptable, so both phone tiers now share one constant and NO
 * hand-scale quantity depends on which side of 380 a phone lands. The trigger
 * selects posture, arc caps and panel treatment — screen-scale things — and
 * nothing else.
 */
export const PHONE_MM_PER_PX = 0.164;
export const MM_PER_PX: Record<DeviceClass, number> = {
  compact: PHONE_MM_PER_PX, phone: PHONE_MM_PER_PX,
  "tablet-s": 0.192, "tablet-l": 0.192,
};

/** Anthropometry, not taste — see MOBILE.md §3.2 for the CHI 2011 derivation. */
export const THUMB_COMFORTABLE_MM = 48;
export const THUMB_STRETCH_MM = 66;
/** Flexion of the thumb IP joint: the movement stick's throw. */
export const STICK_MM = 11;
/** 1.5 mm of contact jitter over this throw is 4.8 deg of aim error. */
export const AIM_THROW_MM = 18;
/** Middle of the 9-11 mm comfortable-target band. */
export const CHIP_MM = 10.5;
/**
 * THE COMPACT PRESET'S CHIP — the low end of the same 9-11 mm band, never
 * below it. Compact means less padding, spread and decoration, not a target a
 * thumb misses: the OWNER, on a real iPhone in Safari landscape (shortest
 * viewport in the matrix — browser chrome eats ~50 of 390 pt), reported the
 * default cluster "spread out and taking up so much space", and the July
 * layout it replaced held eight controls in a 320x256 box. 9.2 mm is 56 px on
 * a phone (hit rects still floor at MIN_TARGET), and the compact arc tables
 * below shrink the SPREAD — radial ladder, band share, satellite decoration —
 * which is where the sprawl actually lived.
 */
export const CHIP_MM_COMPACT = 9.2;

/**
 * Finger travel that promotes a chip press to AIMING. There is NO time term
 * anywhere in the ability FSM (§2.4a); this is the whole classifier, and it is
 * measured from a LEAKY origin (see touch.ts) so a stationary thumb whose
 * contact centroid creeps 1-4 mm under pressure never crosses it.
 *
 * It lives here rather than in touch.ts because `computeZones` asserts the
 * ordering `AIM_SLOP < cancelRadius < 0.5 * aimThrow` on every device at every
 * slider position, which is what makes "no cast has an undefined direction"
 * structural instead of a special case.
 */
export const AIM_SLOP = 18;

/** The top of the safe box belongs to the boss plate, banner and HP rail. */
export const READ_BAND = 0.32;

/**
 * THE CRAWLER KEEPOUT — the one piece of screen a control may never take.
 *
 * The camera follows the crawler, so the crawler is ALWAYS at the middle of
 * the viewport. That makes the middle of the viewport the only region whose
 * contents are known in advance, and the only region no HUD control may
 * occupy — and until this existed, one did. Measured on an iPhone 13
 * landscape: the crawler projects to (375,150); `#t-map` is 51x51 at
 * (370,152), i.e. the MAP chip was painted on the character's chest, and the
 * cluster's bounding box (323x174 = 43% x 51% of a 750x342 screen) contained
 * the crawler outright. The least-used control had been given the most
 * valuable pixels. The iPad was clean, because a tablet's comfortable arc
 * simply does not reach the middle of an 1194 px slab — the phone did not have
 * a different rule, it had less room, and nothing in the layout said so.
 *
 * Sized to the CHARACTER, not to a design instinct: the crawler plus its
 * nameplate measures roughly 60 x 90 CSS px on a phone, so ±7.5% of width and
 * ±13% of height wraps it with a finger's margin and costs the cluster ~40 px
 * of inboard travel. Escapes are OUTBOARD or DOWNWARD only — pushing a chip up
 * would put it in the read band, which §4.2a rule 1 forbids.
 */
export const CRAWLER_KEEPOUT_W = 0.075;
export const CRAWLER_KEEPOUT_H = 0.13;

/** The box the camera keeps the crawler in, in viewport coordinates. */
export function crawlerKeepout(vw: number, vh: number): Rect {
  return {
    x: vw * (0.5 - CRAWLER_KEEPOUT_W), y: vh * (0.5 - CRAWLER_KEEPOUT_H),
    w: vw * CRAWLER_KEEPOUT_W * 2, h: vh * CRAWLER_KEEPOUT_H * 2,
  };
}

/**
 * COMPACT vs LARGE (the owner's verdict, on real glass). `compact` is the
 * DEFAULT: chips at the low end of the 9-11 mm band, a tighter radial ladder,
 * a lower band share, satellites demoted harder. `large` keeps the previous
 * spacious cluster for players who want it — it is a choice in the
 * customisation surface, no longer the thing everyone gets.
 */
export type LayoutPreset = "compact" | "large";

export interface LayoutPrefs {
  handed: "right" | "left";
  /** Movement stick radius multiplier (0.7 - 1.4). */
  stickScale: number;
  /** Chip size multiplier (0.7 - 1.4). ALSO scales the aim throw, never the stick. */
  buttonScale: number;
  /** Extra padding on top of the hardware safe-area inset (0 - 32 px). */
  hudInset: number;
  /** Comfortable thumb sweep in MILLIMETRES (38 - 62; 5th-95th percentile). */
  thumbMm?: number;
  /** Cluster economy. Default COMPACT; `large` is the pre-owner-verdict layout. */
  preset?: LayoutPreset;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  handed: "right", stickScale: 1, buttonScale: 1, hudInset: 12,
  thumbMm: THUMB_COMFORTABLE_MM, preset: "compact",
};

export interface ControlRect extends Rect {
  id: ControlId;
  cx: number;
  cy: number;
  /** Distance of the centre from the class pivot (CSS px). */
  fromPivot: number;
  /**
   * VISUAL diameter, in CSS px — the disc the shell paints, centred on
   * (cx, cy). `w`/`h` stay the HIT rect and never drop below `MIN_TARGET`;
   * this may. The split is what buys Wild Rift's size hierarchy (wr_01/03:
   * utilities visibly smaller than abilities) without shrinking a single
   * touch target: a 38 px LOCK disc still owns a 44 px padded hit box.
   */
  vis: number;
}

export interface ZoneTable {
  cls: DeviceClass;
  /** Which economy built this table — hosts stamp it on the body for CSS. */
  preset: LayoutPreset;
  viewport: { w: number; h: number };
  insets: Insets;
  /** The box every control must live inside (hardware inset + player pad). */
  safe: Rect;
  /** Movement thumb territory. Excludes the top status band and the gutter. */
  stickZone: Rect;
  /** Taps here select / lock / move. Everything not a zone or a chip. */
  worldZone: Rect;
  /**
   * Labelled CANCEL band; live only while a chip is AIMING. Zero-area when
   * `cancelMode === "origin"` — see the derivation at the assignment.
   */
  cancelBand: Rect;
  /**
   * Which cancel affordance this posture actually ships.
   *
   * `band`   a labelled strip, reachable without crossing the screen (tablets)
   * `origin` return inside `cancelRadius` of the FROZEN press origin, drawn as
   *          a ringed ✕ at that origin. The only cancel on a corner grip.
   */
  cancelMode: "band" | "origin";
  /** Floating stick radius in CSS px (dead zone and recentring scale off it). */
  stickRadius: number;
  /**
   * Drag length that means "maximum range" for an AIMED cast. Its own
   * hand-scale quantity: it is NOT the movement stick's radius, and it scales
   * with buttonScale, never stickScale (§2.4b).
   */
  aimThrow: number;
  /** Returning inside this of the FROZEN press origin abandons the cast. */
  cancelRadius: number;
  /** Millimetres per CSS px for this class — published so the host can too. */
  mmPerPx: number;
  /** The box the camera keeps the crawler in. No control's hit rect enters it. */
  keepout: Rect;
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

/**
 * Reach is ANTHROPOMETRY, converted per class, then capped by geometry.
 *
 * The rejected model was `clamp(0.55 * shortEdge, 150, 300)`, which is
 * dimensionally wrong — it says a bigger slab grants you a longer thumb — and
 * whose upper clamp gave a 10.2", an 11" and a 12.9" iPad the identical
 * number anyway. The clamps here are the geometry check only: an arc cannot
 * usefully exceed the screen it is drawn on.
 */
export function reachArcs(
  shortEdge: number, cls: DeviceClass = "phone", thumbMm = THUMB_COMFORTABLE_MM,
): { comfortable: number; stretch: number } {
  const mm = MM_PER_PX[cls];
  const c = clamp(thumbMm, 38, 62);
  const s = c * (THUMB_STRETCH_MM / THUMB_COMFORTABLE_MM);
  return {
    comfortable: Math.min(c / mm, 0.80 * shortEdge),
    stretch: Math.min(s / mm, 1.00 * shortEdge),
  };
}

/**
 * Four classes, because 500-744 is a real gap and a 10-inch is not a 13-inch.
 *
 * READ THIS AS A ROOM TIER, NOT A HAND SIZE. The viewport short edge in
 * landscape is the device minus the browser's own chrome (a Pixel 5 reports
 * 293 where an iPhone 13 reports 342, on two phones whose physical widths are
 * within 1% of each other), so this number measures how much ROOM a layout
 * has, not how long a thumb is. Every hand-scale quantity goes through
 * `MM_PER_PX`, which is now one constant for both phone tiers precisely so
 * that this boundary cannot move a thumb constant — see the note there.
 */
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

interface ArcSpec { id: ControlId; ang: number; rf: number; size: number }

/**
 * CORNER GRIP (compact / phone) — WILD RIFT'S CONTROL CORNER, mapped to this
 * kit. Three rounds skinned the chips and never changed the ARRANGEMENT; the
 * owner rejected all three. The arrangement is the thing (wr_01/wr_03):
 *
 *   - ONE LARGE PRIMARY anchored IN the corner. `rf: 0` — the pivot IS its
 *     centre, parked a hair off the safe corner. Ours is MELEE (slot0),
 *     hold-to-repeat, the forgiving press, exactly WR's basic attack.
 *   - THE FAN: the other three actives plus the ultimate on ONE tight ring
 *     around the primary (`rf: 1` = ring radius = primary radius + chip
 *     radius + a small gap), sweeping from just below the inboard horizontal
 *     (-10 deg, WR starts its fan at about -13) up past vertical (92 deg).
 *     The ultimate takes the TOP of the fan and a distinct size — the one
 *     chip that is different inside the organism.
 *   - UTILITIES TUCKED, NOT ORBITING: the flask and the context pill run
 *     inboard along the BOTTOM edge (WR's summoner-spell row), and LOCK / MAP
 *     drop to small sockets in the fan's outer notches (WR parks its level-up
 *     pips there). No free-floating full-size coins anywhere.
 *
 * Angles are degrees about the inboard horizontal (0 = inboard, 90 = up);
 * `rf` multiplies the RING radius, which for this posture is derived from
 * chip geometry (see `computeZones`), not from the reach arc — the fan must
 * hug the primary whatever the thumb length is. Reach is still asserted on
 * `fromPivot` against `comfortable` for every combat control.
 */
const ARC_CORNER: ArcSpec[] = [
  { id: "slot0", ang: 0, rf: 0, size: 1.50 },  // THE PRIMARY: melee, in the corner
  { id: "slot1", ang: -10, rf: 1.00, size: 1.00 },
  { id: "slot2", ang: 22, rf: 1.00, size: 1.00 },
  { id: "slot3", ang: 54, rf: 1.00, size: 1.00 },
  { id: "slot4", ang: 92, rf: 1.05, size: 1.26 }, // the ult: top of the fan, distinct
  { id: "flask", ang: -6, rf: 1.75, size: 0.82 },
  { id: "context", ang: -4, rf: 2.45, size: 0.82 },
  { id: "lock", ang: 38, rf: 1.62, size: 0.62 },
  { id: "map", ang: 73, rf: 1.60, size: 0.62 },
];

/**
 * CORNER GRIP, COMPACT (the default). The SAME arrangement — one primary, one
 * ring, tucked utilities — with the economy in the sizes: chips off
 * CHIP_MM_COMPACT, the hero tiers a step quieter, satellites a tier lower.
 * Compact vs large must read as one family whose difference is how much glass
 * it spends, never a different geometry.
 */
const ARC_CORNER_COMPACT: ArcSpec[] = [
  { id: "slot0", ang: 0, rf: 0, size: 1.50 },
  { id: "slot1", ang: -10, rf: 1.00, size: 1.00 },
  { id: "slot2", ang: 22, rf: 1.00, size: 1.00 },
  { id: "slot3", ang: 54, rf: 1.00, size: 1.00 },
  { id: "slot4", ang: 92, rf: 1.05, size: 1.22 },
  { id: "flask", ang: -6, rf: 1.75, size: 0.80 },
  { id: "context", ang: -4, rf: 2.45, size: 0.80 },
  { id: "lock", ang: 38, rf: 1.62, size: 0.60 },
  { id: "map", ang: 73, rf: 1.60, size: 0.60 },
];

/** Edge gap between the primary's rim and a fan chip's rim, CSS px. */
const RING_GAP: Record<LayoutPreset, number> = { compact: 8, large: 12 };
/** The fan's angular step (deg) — sets the spacing floor's chord factor. */
const RING_STEP = 32;

/**
 * SIDE GRIP (tablet-s / tablet-l) — fan -46 to +46 degrees, SYMMETRIC about
 * the inboard horizontal. A thumb rooted halfway up the side edge has as much
 * room below it as above it; the basic attack takes 0 degrees (the
 * most-pressed position is the shortest reach), the ultimate the top of the
 * fan, and nothing climbs into the read band.
 */
const ARC_SIDE: ArcSpec[] = [
  { id: "slot0", ang: 0, rf: 0.34, size: 1.22 }, // basic attack, inboard horizontal
  { id: "slot1", ang: -30, rf: 0.86, size: 1.00 },
  { id: "slot2", ang: 0, rf: 0.94, size: 1.00 },
  { id: "slot3", ang: 30, rf: 0.86, size: 1.00 },
  { id: "slot4", ang: 46, rf: 0.60, size: 1.42 }, // ultimate: top of the fan AND the biggest chip
  { id: "flask", ang: -46, rf: 0.58, size: 0.92 },
  { id: "context", ang: -22, rf: 0.34, size: 0.86 },
  { id: "lock", ang: 24, rf: 0.36, size: 0.64 },
  { id: "map", ang: -46, rf: 0.94, size: 0.64 },
];

/** SIDE GRIP, COMPACT: same fan (tablets have the room), quieter hero and
 * satellite tiers so the two presets read as one family. */
const ARC_SIDE_COMPACT: ArcSpec[] = [
  { id: "slot0", ang: 0, rf: 0.34, size: 1.16 },
  { id: "slot1", ang: -30, rf: 0.86, size: 1.00 },
  { id: "slot2", ang: 0, rf: 0.94, size: 1.00 },
  { id: "slot3", ang: 30, rf: 0.86, size: 1.00 },
  { id: "slot4", ang: 46, rf: 0.60, size: 1.28 },
  { id: "flask", ang: -46, rf: 0.58, size: 0.84 },
  { id: "context", ang: -22, rf: 0.34, size: 0.74 },
  { id: "lock", ang: 24, rf: 0.36, size: 0.52 },
  { id: "map", ang: -46, rf: 0.94, size: 0.52 },
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
  const mmPerPx = MM_PER_PX[cls];
  // COMPACT is the default; `large` must be asked for. An absent preset (an
  // old saved pref blob, a bare test call) gets the economy the owner chose.
  const preset: LayoutPreset = prefs.preset === "large" ? "large" : "compact";
  const compact = preset === "compact";
  const bs = clamp(prefs.buttonScale, 0.7, 1.4);
  const ss = clamp(prefs.stickScale, 0.7, 1.4);
  const { comfortable, stretch } =
    reachArcs(shortEdge, cls, prefs.thumbMm ?? THUMB_COMFORTABLE_MM);
  const mirror = prefs.handed === "left";

  // --- hand-scale quantities -------------------------------------------
  // Authored in millimetres, converted once, clamped for sanity, THEN scaled
  // by the player's slider. Note which slider: the aim throw is a BUTTON-hand
  // quantity and the stick radius a STICK-hand one. Borrowing the stick's
  // radius for the aim throw is contradiction 2, and it made maximum range and
  // "never mind" the same gesture at the small end of the matrix.
  const chipBase0 = clamp((compact ? CHIP_MM_COMPACT : CHIP_MM) / mmPerPx, MIN_TARGET, 76) * bs;
  const aimThrow = clamp(AIM_THROW_MM / mmPerPx, 88, 124) * bs;
  const stickRadius = clamp(STICK_MM / mmPerPx, 56, 76) * ss;
  // THE THRESHOLD ORDERING IS STRUCTURAL, not a coincidence of the defaults:
  //     AIM_SLOP (18) < cancelRadius < 0.5 * aimThrow
  // 0.34 * aimThrow satisfies it by construction across the whole matrix
  // (18 < 30..42 < 44..62); the final clamp holds it at extreme slider
  // positions too, so "no path through the FSM casts with an undefined
  // direction" needs no special case anywhere.
  const cancelRadius = clamp(
    clamp(0.34 * aimThrow, 30, 42),
    AIM_SLOP + 2, Math.max(AIM_SLOP + 3, 0.5 * aimThrow - 1),
  );

  // --- zones the cluster must respect -----------------------------------
  // The status band owns the top of the screen; the stick never reaches into
  // it (that is where the HUD and the transient cards live). Both are computed
  // BEFORE the cluster, because the cluster is the thing that has to yield: a
  // chip that a relaxation pass shoved into the movement thumb's territory is
  // the §1.2 bug with a new cause.
  const bandH = cls === "compact" ? Math.max(38, vh * 0.14) : Math.max(44, vh * 0.15);
  const stickW = Math.min(safe.w * 0.46, vw * 0.46);
  const stickTop = Math.max(safe.y, bandH);
  const stickZone: Rect = {
    x: mirror ? safe.x + safe.w - stickW : safe.x,
    y: stickTop,
    w: stickW,
    h: Math.max(80, safe.y + safe.h - stickTop),
  };

  // --- cluster ----------------------------------------------------------
  const side = isSideGrip(cls);
  // Side grip roots the thumb up the outer edge at 58% of the safe height,
  // where an 11-inch slab is actually held. The CORNER grip's pivot is the
  // PRIMARY's own centre, anchored in the corner, so it depends on the chip
  // size and is computed inside the packing loop below.
  const sidePivotOuter = safe.x + safe.w - 26;
  let pivot: Vec2 = {
    x: mirror ? vw - sidePivotOuter : sidePivotOuter,
    y: side ? safe.y + 0.58 * safe.h : safe.y + safe.h - 26,
  };

  // THE BOX CHIPS MAY OCCUPY. The top never enters the read band (§4.2a rule
  // 1) and the inboard wall keeps the cluster out of the movement thumb's
  // zone. On a corner grip the box runs from the read band's floor to the
  // safe bottom — the WR fan is TALL and thin, so the vertical budget is
  // enforced as an EXTENT check in `clusterFits` (rule 2: combat extent
  // <= 58% of safe.h, compact 57%) rather than as a shorter box that a
  // clamped ultimate would fold into the ring.
  const bandFrac = side ? 0.46 : 1 - READ_BAND;
  const extentCap = side ? 0.46 : compact ? 0.57 : 0.58;
  const readFloor = safe.y + READ_BAND * safe.h;
  const box = {
    x0: mirror ? safe.x : Math.max(safe.x, stickZone.x + stickZone.w),
    x1: mirror ? Math.min(safe.x + safe.w, stickZone.x) : safe.x + safe.w,
    y0: Math.max(readFloor, side
      ? pivot.y - bandFrac * safe.h / 2
      : safe.y + safe.h - bandFrac * safe.h),
    y1: Math.min(safe.y + safe.h, side ? pivot.y + bandFrac * safe.h / 2 : safe.y + safe.h),
  };

  /*
   * THE SIZE SLIDER IS A REQUEST, NOT A COMMAND.
   *
   * Nine controls, a 44 px hit floor and 1.4x buttons do not fit inside a
   * landscape phone's cluster box — that is arithmetic, not a bug. So the
   * requested `chipBase` is tried first and stepped down 5% at a time until
   * the cluster packs: no residual crowding, every combat control inside
   * `comfortable`, the combat extent inside the posture's band share. A
   * player who asks for huge buttons on a Pixel 5 gets the biggest buttons a
   * Pixel 5 can hold, which is the honest answer to the request.
   */
  const keepout = crawlerKeepout(vw, vh);
  const arc = side
    ? (compact ? ARC_SIDE_COMPACT : ARC_SIDE)
    : (compact ? ARC_CORNER_COMPACT : ARC_CORNER);
  const maxCombatRf = Math.max(
    ...arc.filter((s) => COMBAT_CONTROLS.includes(s.id)).map((s) => s.rf),
  );
  const sPrim = arc.find((s) => s.id === "slot0")?.size ?? 1.5;
  const sFan = arc.find((s) => s.id === "slot1")?.size ?? 1.0;
  let chipBase = chipBase0;
  let controls = {} as Record<ControlId, ControlRect>;
  let arcRadius = 0;
  let sy = 1;
  for (let attempt = 0; ; attempt++) {
    const maxHalf = Math.max(MIN_TARGET, chipBase * 1.40) / 2;
    if (side) {
      // Side grip: `rf = 1` is normalised so the outermost combat chip lands
      // exactly on `comfortable` — the tablet fan is reach-scaled.
      arcRadius = Math.max(56, Math.min(
        comfortable - maxHalf - 6,
        (comfortable - 2) / maxCombatRf,
        0.62 * safe.h,
      ));
    } else {
      // CORNER GRIP: the ring is CHIP-scaled, not reach-scaled — the fan must
      // hug the primary whatever the thumb length. `rf = 1` is the ring:
      // primary radius + fan-chip radius + RING_GAP, floored so two adjacent
      // 44 px tap circles on a RING_STEP chord can never collide, and capped
      // so the outermost combat control stays inside `comfortable` (when the
      // cap binds, chips crowd, `clusterFits` fails and the size steps down —
      // the same honest answer the slider gets).
      const ringGeom = chipBase * (sPrim + sFan) / 2 + RING_GAP[preset];
      const ringFloor = (MIN_TARGET + 2) / (2 * Math.sin((RING_STEP / 2) * RAD));
      arcRadius = Math.min(
        Math.max(ringGeom, ringFloor),
        (comfortable - 2) / maxCombatRf,
        0.62 * safe.h,
      );
      // The primary is anchored IN the corner: its centre is the pivot.
      const primHalf = Math.max(MIN_TARGET, chipBase * sPrim) / 2;
      const outer = safe.x + safe.w - primHalf - 2;
      pivot = {
        x: mirror ? vw - outer : outer,
        y: safe.y + safe.h - primHalf - 2,
      };
      // THE FAN GOES ELLIPTICAL BEFORE THE CHIPS SHRINK. On a short safe box
      // (a Pixel 5, or a player-padded inset) the full circular fan cannot fit
      // the posture's extent budget — and WR's own default fan is not circular
      // either: its ring radii measure 180 -> 113 px climbing from the first
      // ability to the top of the fan (wr_01), i.e. the TOP compresses. `sy`
      // scales every chip's vertical offset so the tallest combat chip meets
      // the budget; the relaxation pass restores neighbour spacing sideways,
      // which flattens the fan exactly the way WR's editor does. Chips only
      // step down 5% when even a 0.55 squeeze cannot fit the glass.
      let rise = 0;
      for (const s of arc) {
        if (!COMBAT_CONTROLS.includes(s.id) || s.ang <= 0) continue;
        rise = Math.max(rise,
          Math.sin(s.ang * RAD) * arcRadius * s.rf + Math.max(MIN_TARGET, chipBase * s.size) / 2);
      }
      const maxRise = extentCap * safe.h - primHalf - 1;
      sy = rise > 0 ? clamp(maxRise / rise, 0.55, 1) : 1;
    }
    controls = placeCluster(arc, chipBase, arcRadius, pivot, mirror, box, keepout, side ? 1 : sy);
    if (!side) {
      // The relaxation can push a squeezed fan back UP past the prediction
      // (spacing is restored along the centre lines), so the squeeze is
      // refined against the MEASURED extent, not the predicted one.
      for (let t = 0; t < 4 && sy > 0.551; t++) {
        const ext = combatExtent(controls);
        const budget = extentCap * safe.h;
        if (ext <= budget + 0.4) break;
        sy = Math.max(0.55, sy - (ext - budget) / Math.max(40, arcRadius * 1.05));
        controls = placeCluster(arc, chipBase, arcRadius, pivot, mirror, box, keepout, sy);
      }
    }
    if (attempt >= 12 || clusterFits(controls, comfortable, keepout, safe, extentCap)) break;
    chipBase *= 0.95;
  }

  // --- zones ------------------------------------------------------------
  // The world zone is everything between the stick and the cluster.
  const ids = Object.keys(controls) as ControlId[];
  const clusterLeft = Math.min(...ids.map((id) => controls[id].x));
  const clusterRight = Math.max(...ids.map((id) => controls[id].x + controls[id].w));
  const clusterBottom = Math.max(...ids.map((id) => controls[id].y + controls[id].h));
  /*
   * THE WORLD ZONE RUNS TO THE EDGE, UNDER THE CLUSTER.
   *
   * It used to stop at the cluster's left edge, which was fine when the arc
   * was a tight quarter-disc and fatal once the arc flattened into two ranks:
   * on a 750 px-wide iPhone the strip between the stick zone and the cluster
   * measured 37 px, so tap-to-move — a whole verb — had nowhere to land.
   *
   * The fix is precedence, not geometry. §2.10 evaluates chips BEFORE zones,
   * and `hitControl` pads every rect to 44 px plus 6 px of slack while
   * `separate()` leaves only 2 px of daylight between neighbours: adjacent hit
   * rects therefore overlap, so the cluster exposes no tappable interior. A
   * finger in the cluster hits a chip; a finger anywhere else on the right of
   * the screen gets the world.
   */
  const worldTop = Math.max(safe.y, bandH * 0.62);
  const worldX = mirror ? safe.x : stickZone.x + stickZone.w;
  const worldRight = mirror ? stickZone.x : safe.x + safe.w;
  const worldZone: Rect = {
    x: worldX, y: worldTop,
    w: Math.max(60, worldRight - worldX),
    h: Math.max(80, safe.y + safe.h - worldTop),
  };

  /*
   * THE CANCEL AFFORDANCE — and why a corner grip does not get a band.
   *
   * Round 1 pinned the band to the bottom-INBOARD corner on a corner grip.
   * Measured on an iPhone 13 landscape that put a 258x58 strip at (146,272)
   * while the cluster occupied x 449-712: reaching it is a ~176 px
   * cross-screen drag, well past the 109 px `aimThrow`, so the band was
   * decorative — and 92% of its area (231x57 px) lay inside the MOVEMENT
   * thumb's zone, so a giant CANCEL bar painted under the walking thumb every
   * time you aimed. It did not block walking, but it taught the wrong hand,
   * which is worse than teaching nothing.
   *
   * The obvious repair — put the band inboard of the cluster on the CASTING
   * side — does not survive its own arithmetic either. The gap between the
   * stick zone (ends at x 350) and the cluster (starts at x 449) is 87 px on
   * an iPhone 13, under the 96 px this file will accept as a band; and a band
   * there sits exactly one `aimThrow` (109 px) inboard of the nearest chip, so
   * every full-range LEFTWARD aim would land in it and cancel. A cancel target
   * that eats the most natural aim direction is not a cancel target.
   *
   * DECISION. The band is placed only where it can be reached WITHOUT crossing
   * the movement thumb and without colliding with the aim throw — the side
   * grip's bottom-outer corner, which measured 0% stick overlap and is left
   * exactly as it was. A corner grip gets `cancelMode: "origin"`: return
   * inside `cancelRadius` (37 px) of the frozen press origin. That was already
   * the only cancel a phone player could actually perform; what was missing
   * was that nothing DREW it. `touchShell` now paints a ringed ✕ at the frozen
   * origin the moment AIMING starts, so the affordance is visible, is by
   * construction inside the thumb's reach (it is where the thumb already is),
   * and cannot be confused with an aim direction.
   */
  const bandHeight = Math.max(MIN_TARGET, chipBase * 0.9);
  const inboardGap = mirror
    ? (stickZone.x - 12) - (clusterRight + 12)
    : (clusterLeft - 12) - (stickZone.x + stickZone.w + 12);
  // POSTURE DECIDES, NOT THE GAP (§2.0 register + the §4.2a derivation): a
  // corner grip ships `origin`, full stop. The old `|| inboardGap >= 96`
  // escape hatch was dormant until the satellite chips slimmed down — then a
  // Pixel 5 suddenly earned a band that sits one aimThrow inboard of the
  // nearest chip, which is exactly the placement the derivation rejects.
  const wantBand = side;
  const cancelMode: "band" | "origin" = wantBand ? "band" : "origin";
  const cancelW = side
    ? Math.min(safe.w * 0.42, Math.max(180, arcRadius * 1.4))
    : Math.max(0, inboardGap);
  const cancelX = clamp(
    side
      ? (mirror ? safe.x : safe.x + safe.w - cancelW)
      : (mirror ? clusterRight + 12 : stickZone.x + stickZone.w + 12),
    safe.x, Math.max(safe.x, safe.x + safe.w - cancelW),
  );
  const cancelY = clamp(
    side ? Math.max(clusterBottom + 24, safe.y + safe.h - bandHeight)
      : safe.y + safe.h - bandHeight,
    safe.y, Math.max(safe.y, safe.y + safe.h - bandHeight),
  );
  const cancelBand: Rect = wantBand
    ? { x: cancelX, y: cancelY, w: cancelW, h: bandHeight }
    // Zero-area, and parked at the bottom-inboard corner of the CASTING half
    // so a consumer that paints it unconditionally paints nothing rather than
    // painting it over the stick.
    : { x: clamp(clusterLeft - 12, safe.x, safe.x + safe.w), y: safe.y + safe.h - bandHeight, w: 0, h: 0 };

  const anchorX = mirror ? vw - vw * 0.22 : vw * 0.22;
  const stickAnchor: Vec2 = {
    x: clamp(anchorX, stickZone.x + stickRadius,
      Math.max(stickZone.x + stickRadius, stickZone.x + stickZone.w - stickRadius)),
    y: clamp(vh * 0.72, stickZone.y + stickRadius,
      Math.max(stickZone.y + stickRadius, stickZone.y + stickZone.h - stickRadius)),
  };

  return {
    cls, preset, viewport: { w: vw, h: vh }, insets, safe, stickZone, worldZone, cancelBand,
    cancelMode, stickRadius, aimThrow, cancelRadius, mmPerPx, keepout, stickAnchor,
    pivot, arcRadius, comfortable, stretch, controls,
  };
}

interface ClusterBox { x0: number; x1: number; y0: number; y1: number }

/** One placement attempt at a given chip size: polar layout, then relaxation. */
function placeCluster(
  arc: ArcSpec[], chipBase: number, arcRadius: number, pivot: Vec2,
  mirror: boolean, box: ClusterBox, keepout: Rect, sy = 1,
): Record<ControlId, ControlRect> {
  const controls = {} as Record<ControlId, ControlRect>;
  for (const spec of arc) {
    const size = Math.max(MIN_TARGET, chipBase * spec.size);
    // The paint may be smaller than the target, never the other way round.
    const vis = Math.min(size, Math.max(30, chipBase * spec.size));
    const dx = Math.cos(spec.ang * RAD) * arcRadius * spec.rf;
    const dy = Math.sin(spec.ang * RAD) * arcRadius * spec.rf * sy;
    const cx = mirror ? pivot.x + dx : pivot.x - dx;
    const cy = pivot.y - dy;
    controls[spec.id] = {
      id: spec.id, cx, cy, x: cx - size / 2, y: cy - size / 2, w: size, h: size,
      fromPivot: Math.hypot(cx - pivot.x, cy - pivot.y), vis,
    };
  }
  separate(controls, box, pivot, keepout);
  return controls;
}

/**
 * THE SPACING METRIC IS CIRCULAR, BECAUSE THE CLUSTER IS (the WR round).
 *
 * The old invariant demanded axis-aligned 44 px BOXES never overlap, which
 * forbids the one thing Wild Rift's corner is made of: a tight arc whose
 * neighbours visually kiss (wr_01: ability discs at centre spacing ~= their
 * own diameter). What a thumb actually needs is an EXCLUSIVE LANDING ZONE,
 * and the router resolves by NEAREST CENTRE (`controlAt`), so the honest
 * floor is a centre distance: at >= MIN_TARGET + 2 apart, every chip keeps an
 * exclusive corridor at least 46 px wide through the Voronoi split — the same
 * guarantee the boxes gave, without banning the arc. Bigger chips scale the
 * floor at 0.82x their mean hit size, which allows up to ~18% visual overlap
 * between hero discs — deliberately: WR overlaps its edges, and the paint
 * (`vis`) is never larger than the hit rect. What stays forbidden outright is
 * a chip whose padded rect covers a NEIGHBOUR'S CENTRE (the Pixel 5 "tapping
 * DASH drank a potion" bug) — structural here, since dmin always exceeds any
 * padded half-rect.
 */
function minCentreDist(a: ControlRect, b: ControlRect): number {
  const mean = (Math.max(MIN_TARGET, a.w) + Math.max(MIN_TARGET, b.w)) / 2;
  return Math.max(MIN_TARGET + 2, 0.82 * mean);
}

/** Vertical extent of the combat cluster's padded hit rects. */
function combatExtent(controls: Record<ControlId, ControlRect>): number {
  let top = Infinity, bot = -Infinity;
  for (const id of COMBAT_CONTROLS) {
    const c = controls[id];
    const half = Math.max(MIN_TARGET, c.h) / 2;
    top = Math.min(top, c.cy - half);
    bot = Math.max(bot, c.cy + half);
  }
  return bot - top;
}

/** Did the attempt pack cleanly AND keep every combat control in reach? */
function clusterFits(
  controls: Record<ControlId, ControlRect>, comfortable: number, keepout: Rect,
  safe: Rect, extentCap: number,
): boolean {
  const ids = Object.keys(controls) as ControlId[];
  for (const id of COMBAT_CONTROLS) {
    if (controls[id].fromPivot > comfortable) return false;
  }
  // Rule 2 as arithmetic: the combat cluster's vertical extent must fit the
  // posture's share of the safe box. The corner box runs to the read band's
  // floor (a clamped fan folds into the ring, which is worse than smaller
  // chips), so the budget is enforced here instead.
  const tops = COMBAT_CONTROLS.map((id) => controls[id].cy - Math.max(MIN_TARGET, controls[id].h) / 2);
  const bots = COMBAT_CONTROLS.map((id) => controls[id].cy + Math.max(MIN_TARGET, controls[id].h) / 2);
  if (Math.max(...bots) - Math.min(...tops) > extentCap * safe.h + 0.5) return false;
  // A chip left sitting on the crawler is a failed pack, not a cosmetic
  // problem: it is the §1.2 bug (chrome inside a thumb's territory) aimed at
  // the one thing the player is actually looking at.
  for (const id of ids) {
    const c = controls[id];
    const halfW = Math.max(MIN_TARGET, c.w) / 2, halfH = Math.max(MIN_TARGET, c.h) / 2;
    if (Math.abs(c.cx - (keepout.x + keepout.w / 2)) < halfW + keepout.w / 2 &&
      Math.abs(c.cy - (keepout.y + keepout.h / 2)) < halfH + keepout.h / 2) return false;
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = controls[ids[i]], b = controls[ids[j]];
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      // 0.75 px of slack: the relaxation converges, it does not solve.
      if (d < minCentreDist(a, b) - 0.75) return false;
    }
  }
  return true;
}

/**
   * NO TWO CHIPS MAY CROWD PAST `minCentreDist`, AND NONE MAY LEAVE THE
   * CLUSTER BOX.
   *
   * The arc is authored in angles and radius fractions, so its spacing scales
   * with `arcRadius` — but the 46 px centre-distance floor does not. Below it
   * the router's nearest-centre split gives a chip less than a thumb's worth
   * of exclusive corridor, and (the measured Pixel 5 bug) one chip's rect can
   * cover another's CENTRE, at which point `controlAt()` and the DOM path
   * disagree and the DOM wins: tapping DASH drank a potion.
   *
   * This is a few passes of pair relaxation: push crowded pairs apart along
   * the line between their centres, re-clamp into the safe box AND into the
   * posture's cluster band, repeat. The band clamp is what makes §4.2a's
   * rule 1 structural — a chip pushed out of a collision cannot escape upward
   * into the read band, it has to travel sideways instead.
   *
   * Order-stable because every pair moves both members by the same half-step,
   * and bounded because each pass strictly reduces total penetration or stops.
   */
function separate(
  controls: Record<ControlId, ControlRect>, box: ClusterBox, pivot: Vec2,
  keepout: Rect,
): void {
  const ids = Object.keys(controls) as ControlId[];
  const GAP = 2; // a hair of daylight, so "adjacent" never rounds into "over"
  const fit = (c: ControlRect): void => {
    const halfW = Math.max(MIN_TARGET, c.w) / 2, halfH = Math.max(MIN_TARGET, c.h) / 2;
    c.cx = clamp(c.cx, box.x0 + halfW, Math.max(box.x0 + halfW, box.x1 - halfW));
    c.cy = clamp(c.cy, box.y0 + halfH, Math.max(box.y0 + halfH, box.y1 - halfH));
    // THE CRAWLER KEEPOUT. Applied after the box clamp and re-applied every
    // pass, because a chip pushed out of a collision can be pushed back onto
    // the character. Escapes are outboard or downward — never upward, which
    // would put the chip in the read band §4.2a rule 1 reserves.
    if (c.cx + halfW <= keepout.x || c.cx - halfW >= keepout.x + keepout.w) return;
    if (c.cy + halfH <= keepout.y || c.cy - halfH >= keepout.y + keepout.h) return;
    const outX = pivot.x > keepout.x + keepout.w / 2
      ? keepout.x + keepout.w + halfW - c.cx // push toward an outboard pivot
      : keepout.x - halfW - c.cx;
    const outY = keepout.y + keepout.h + halfH - c.cy; // downward only
    // Take the cheaper escape, but never one the cluster box cannot hold.
    const roomX = c.cx + outX >= box.x0 + halfW && c.cx + outX <= box.x1 - halfW;
    const roomY = c.cy + outY <= box.y1 - halfH;
    if (roomX && (!roomY || Math.abs(outX) <= Math.abs(outY))) c.cx += outX;
    else if (roomY) c.cy += outY;
    else if (roomX) c.cx += outX;
    else {
      // NEITHER ESCAPE FITS — which means the requested chip size does not fit
      // this device, not that the crawler has to share. Take the outboard move
      // anyway, clamped, and let `clusterFits` see the residual overlap and
      // step the chips down: the size slider is a request (§4.2a), and this is
      // one more thing the packer may refuse.
      c.cx = clamp(c.cx + outX, box.x0 + halfW, Math.max(box.x0 + halfW, box.x1 - halfW));
    }
  };
  for (const id of ids) fit(controls[id]);
  for (let pass = 0; pass < 64; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = controls[ids[i]], b = controls[ids[j]];
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const len = Math.hypot(dx, dy);
        const pen = minCentreDist(a, b) + GAP - len;
        if (pen <= 0) continue;
        moved = true;
        // Push along the LINE BETWEEN THE CENTRES — the direction the circular
        // metric actually measures — so a jammed pair can slide around a
        // clamped edge instead of grinding into it. Coincident centres have no
        // direction; break the tie deterministically rather than divide by 0.
        const ux = len > 1e-6 ? dx / len : 1, uy = len > 1e-6 ? dy / len : 0;
        const push = pen / 2 + 0.25;
        a.cx -= ux * push; a.cy -= uy * push;
        b.cx += ux * push; b.cy += uy * push;
      }
    }
    for (const id of ids) fit(controls[id]);
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
