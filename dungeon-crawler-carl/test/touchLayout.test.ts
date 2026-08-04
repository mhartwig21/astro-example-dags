import { describe, it, expect } from "vitest";
import {
  AIM_SLOP, COMBAT_CONTROLS, DEFAULT_LAYOUT_PREFS, MIN_TARGET, NAV_CONTROLS, READ_BAND,
  computeZones, deviceClass, hitControl, hitZone, inRect, isSideGrip, reachArcs,
  type ControlId, type Insets, type ZoneTable,
} from "../src/input/touchLayout";

/**
 * The five measured viewports from the audit, with their real hardware insets.
 * Chromium reports env(safe-area-inset-*) as 0, so these numbers come from the
 * devices, not from the browser.
 */
const DEVICES = [
  { name: "pixel5-land", w: 802, h: 293, safe: { top: 0, right: 24, bottom: 0, left: 0 } },
  { name: "iphone13-land", w: 750, h: 342, safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  { name: "iphone13promax-land", w: 832, h: 380, safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  { name: "ipad7-land", w: 1080, h: 810, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  { name: "ipadpro11-land", w: 1194, h: 834, safe: { top: 24, right: 0, bottom: 20, left: 0 } },
  { name: "ipadpro129-land", w: 1366, h: 1024, safe: { top: 24, right: 0, bottom: 20, left: 0 } },
] as const;

/** Every slider position the four §4.2a invariants must survive. */
const SLIDERS = [
  { buttonScale: 0.7, thumbMm: 48, hudInset: 12 },
  { buttonScale: 1.0, thumbMm: 48, hudInset: 12 },
  { buttonScale: 1.4, thumbMm: 48, hudInset: 12 },
  { buttonScale: 1.0, thumbMm: 38, hudInset: 12 },
  { buttonScale: 1.0, thumbMm: 62, hudInset: 12 },
  { buttonScale: 1.4, thumbMm: 38, hudInset: 0 },
  { buttonScale: 1.4, thumbMm: 38, hudInset: 32 },
  { buttonScale: 0.7, thumbMm: 62, hudInset: 0 },
] as const;

const hitRect = (z: ZoneTable, id: ControlId) => {
  const c = z.controls[id];
  const w = Math.max(MIN_TARGET, c.w), h = Math.max(MIN_TARGET, c.h);
  return { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
};
const overlaps = (a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const prefs = (over: Partial<typeof DEFAULT_LAYOUT_PREFS> = {}) => ({ ...DEFAULT_LAYOUT_PREFS, ...over });

describe("touch layout: device classes and the reach rule", () => {
  it("classes split where the postures actually differ", () => {
    expect(deviceClass(293, true)).toBe("compact");
    // 342 is iPhone 13 LANDSCAPE. MOBILE.md 4.1 lists it under "phone" and also
    // sets that class at 380+; the number wins — a 342-tall landscape phone is
    // as cramped as a Pixel 5 and gets the compact posture.
    expect(deviceClass(342, true)).toBe("compact");
    expect(deviceClass(380, true)).toBe("phone"); // iPhone 13 Pro Max landscape
    expect(deviceClass(810, true)).toBe("tablet-s");
    expect(deviceClass(834, true)).toBe("tablet-s");
    expect(deviceClass(1024, true)).toBe("tablet-l");
    expect(isSideGrip("phone")).toBe(false);
    expect(isSideGrip("tablet-s")).toBe(true);
  });

  /**
   * REACH IS ANTHROPOMETRY, NOT A SCREEN FRACTION (MOBILE.md §3.2).
   *
   * The rejected `clamp(0.55 * shortEdge, 150, 300)` is dimensionally wrong —
   * it says a bigger slab grants you a longer thumb — and its upper clamp gave
   * a 10.2", an 11" and a 12.9" iPad the identical number anyway. These are the
   * §3.2 instance table, to the pixel: phones gain ~31% of arc, tablets lose
   * 17%, and the three iPads share one PHYSICAL geometry because one hand
   * holds all three.
   */
  it("reach is a hand constant in millimetres, converted per class", () => {
    expect(Math.round(reachArcs(293, "compact").comfortable)).toBe(234); // was 161
    expect(Math.round(reachArcs(342, "phone").comfortable)).toBe(274);   // was 188
    expect(Math.round(reachArcs(380, "phone").comfortable)).toBe(293);   // was 209
    expect(Math.round(reachArcs(810, "tablet-s").comfortable)).toBe(250); // was 300
    expect(Math.round(reachArcs(834, "tablet-s").comfortable)).toBe(250);
    expect(Math.round(reachArcs(1024, "tablet-l").comfortable)).toBe(250);
    expect(Math.round(reachArcs(293, "compact").stretch)).toBe(293);
    expect(Math.round(reachArcs(342, "phone").stretch)).toBe(342);
    expect(Math.round(reachArcs(380, "phone").stretch)).toBe(380);
    expect(Math.round(reachArcs(834, "tablet-s").stretch)).toBe(344);
    // A 5th-percentile hand asks for less arc; a 95th-percentile one for more.
    expect(reachArcs(834, "tablet-s", 38).comfortable)
      .toBeLessThan(reachArcs(834, "tablet-s", 62).comfortable);
  });

  /**
   * THE HAND-SCALE SET, to the pixel (§2.0 / §2.3 / §2.4b / §4.2a).
   *
   * The tablet stick gets SMALLER in CSS px and identical in millimetres,
   * which is the whole point: 88 px on an iPad was a 16.9 mm throw a thumb
   * cannot make without regripping.
   */
  it("stick radius, aim throw, cancel radius and chip size are millimetres", () => {
    const rows: [string, number, number, number[], number[]][] = [
      // ONE PHONE HAND CONSTANT. §2.0's table listed `compact` at 0.163 and
      // `phone` at 0.165 — 1.2% apart, inside the <= 2% intra-class spread the
      // table itself declares acceptable, and the source of a contradiction a
      // critic caught: §4.1 files iPhone 13 landscape under `compact` while
      // §2.0 and §3.2 file the same device under `phone`. Both tiers now share
      // 0.164, so no hand quantity depends on which side of the 380 boundary a
      // phone lands and the two tables cannot disagree again. 18/0.164 = 109.8.
      ["compact", 802, 293, [0, 24, 0, 0], [67, 110, 37, 64]],
      ["phone", 832, 380, [0, 47, 21, 47], [67, 110, 37, 64]],
      ["tablet-s", 1194, 834, [24, 0, 20, 0], [57, 94, 32, 55]],
      ["tablet-l", 1366, 1024, [24, 0, 20, 0], [57, 94, 32, 55]],
    ];
    for (const [cls, w, h, ins, want] of rows) {
      const z = computeZones(w, h, { top: ins[0], right: ins[1], bottom: ins[2], left: ins[3] }, prefs());
      expect(z.cls, `${cls} class`).toBe(cls);
      expect.soft(Math.round(z.stickRadius), `${cls} R`).toBe(want[0]);
      expect.soft(Math.round(z.aimThrow), `${cls} aimThrow`).toBe(want[1]);
      expect.soft(Math.round(z.cancelRadius), `${cls} cancelRadius`).toBe(want[2]);
      // chipBase before the packing shrink, read off a mid-size chip.
      expect.soft(Math.round(z.controls.slot1.w), `${cls} chip`).toBeLessThanOrEqual(want[3]);
    }
  });

  /**
   * THE ORDERING THAT MAKES "NO UNDEFINED DIRECTION" STRUCTURAL (§2.4a).
   *
   * The 18px -> cancelRadius band cannot exist, so the old "release below the
   * stick dead zone resolves as a smart cast" special case — unreachable at
   * defaults and UNDEFINED at other slider positions, because cancelRadius
   * scaled with buttonScale and the slop did not — is retired.
   */
  it("AIM_SLOP < cancelRadius < 0.5 x aimThrow, on every device at every slider", () => {
    for (const d of DEVICES) {
      for (const slider of SLIDERS) {
        const z = computeZones(d.w, d.h, d.safe as Insets, prefs(slider));
        const tag = `${d.name} x${slider.buttonScale}`;
        expect.soft(z.cancelRadius, `${tag} slop < cancel`).toBeGreaterThan(AIM_SLOP);
        expect.soft(z.cancelRadius, `${tag} cancel < half throw`).toBeLessThan(0.5 * z.aimThrow);
      }
    }
  });

  it("the cluster is NOT one fixed arc: geometry moves with the short edge", () => {
    const small = computeZones(802, 293, { top: 0, right: 24, bottom: 0, left: 0 }, prefs());
    const big = computeZones(832, 380, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());
    // The measured failure was chip distances IDENTICAL on a 293-tall Pixel 5
    // and a 380-tall Pro Max. They must not be.
    expect(Math.round(small.controls.slot4.fromPivot))
      .not.toBe(Math.round(big.controls.slot4.fromPivot));
    // The stick is now a MILLIMETRE quantity, so two devices in the same
    // class share it by design — what must differ is the cluster geometry.
    expect(small.arcRadius).toBeLessThan(big.arcRadius);
  });
});

/**
 * THE FOUR §4.2a INVARIANTS — asserted, not hoped for.
 *
 * They are what makes the side pivot safe to keep rather than something to
 * argue about again next round, and rules 1 and 4 are the ones that were
 * missing when the tablet proposal reproduced, deliberately, the exact
 * geometry the phone audit calls unusable.
 */
describe("touch layout: the §4.2a cluster invariants", () => {
  for (const d of DEVICES) {
    for (const handed of ["right", "left"] as const) {
      it(`${d.name} ${handed}: cluster invariants hold at every slider position`, () => {
        for (const slider of SLIDERS) {
          const z = computeZones(d.w, d.h, d.safe as Insets, prefs({ handed, ...slider }));
          const tag = `${d.name} ${handed} x${slider.buttonScale} mm${slider.thumbMm}`;
          const readFloor = z.safe.y + READ_BAND * z.safe.h;
          const side = isSideGrip(z.cls);

          // 1. No COMBAT_CONTROLS 44px hit rect inside the top 32% of the safe
          //    box. That band belongs to the boss health plate, the headline
          //    banner and the HP rail — what a player READS while the cluster
          //    is being pressed.
          for (const id of COMBAT_CONTROLS) {
            expect.soft(hitRect(z, id).y, `${tag}: ${id} in the read band`)
              .toBeGreaterThanOrEqual(readFloor - 0.001);
          }

          // 2. Cluster vertical extent <= 46% of safe.h on side grip, 58% on
          //    corner (a corner grip has nowhere else to go).
          const tops = COMBAT_CONTROLS.map((id) => hitRect(z, id).y);
          const bots = COMBAT_CONTROLS.map((id) => hitRect(z, id).y + hitRect(z, id).h);
          const extent = Math.max(...bots) - Math.min(...tops);
          expect.soft(extent / z.safe.h, `${tag}: cluster extent`)
            .toBeLessThanOrEqual((side ? 0.46 : 0.58) + 0.002);

          // 3. Every combat control inside `comfortable` of its posture pivot.
          for (const id of COMBAT_CONTROLS) {
            expect.soft(z.controls[id].fromPivot, `${tag}: ${id} out of reach`)
              .toBeLessThanOrEqual(z.comfortable + 0.001);
          }

          // 4. The CANCEL band overlaps no chip and never enters the top 40%.
          for (const id of Object.keys(z.controls) as ControlId[]) {
            expect.soft(overlaps(hitRect(z, id), z.cancelBand),
              `${tag}: cancel band over ${id}`).toBe(false);
          }
          expect.soft(z.cancelBand.y, `${tag}: cancel band height`)
            .toBeGreaterThanOrEqual(z.safe.y + 0.40 * z.safe.h - 0.001);
        }
      });
    }
  }

  it("posture selects pivot, radius cap AND fan together", () => {
    const phone = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());
    const tablet = computeZones(1194, 834, { top: 24, right: 0, bottom: 20, left: 0 }, prefs());
    // Corner grip roots at the bottom outer corner...
    expect(phone.pivot.y).toBeCloseTo(phone.safe.y + phone.safe.h - 26, 4);
    // ...the side grip well up the outer edge, where an 11-inch slab is held.
    expect(tablet.pivot.y).toBeCloseTo(tablet.safe.y + 0.58 * tablet.safe.h, 4);
    // The ultimate is furthest from a resting thumb on BOTH postures: it is
    // the topmost of the five slots.
    for (const z of [phone, tablet]) {
      for (const id of ["slot0", "slot1", "slot2", "slot3"] as const) {
        // TOP EDGE, NOT CENTRE. The ultimate is now the BIGGEST chip in the
        // cluster (chip hierarchy was inverted: the basic attack measured
        // 92x92 and the ultimate 75x75, backwards for a once-a-fight,
        // under-pressure press). Both it and its neighbours sit against the
        // read band's ceiling on a corner grip, so comparing centres would
        // penalise the ultimate for exactly the size we just gave it.
        // +2 px of slack: the relaxation pass may nudge a rank by a hair.
        expect.soft(hitRect(z, "slot4").y, `${z.cls}: ult above ${id}`)
          .toBeLessThanOrEqual(hitRect(z, id).y + 2);
        // ...and it is the largest thing in the cluster, on every posture.
        expect.soft(z.controls.slot4.w, `${z.cls}: ult bigger than ${id}`)
          .toBeGreaterThanOrEqual(z.controls[id].w);
      }
      // ...and the basic attack is the nearest thing to the thumb root.
      for (const id of ["slot1", "slot2", "slot3", "slot4"] as const) {
        expect.soft(z.controls.slot0.fromPivot, `${z.cls}: basic nearer than ${id}`)
          .toBeLessThan(z.controls[id].fromPivot);
      }
    }
    // The side grip fans SYMMETRICALLY about the inboard horizontal: there is
    // as much cluster below the pivot as above it. A corner grip cannot.
    const below = Object.values(tablet.controls).filter((c) => c.cy > tablet.pivot.y).length;
    expect(below).toBeGreaterThanOrEqual(2);
    expect(Object.values(phone.controls).every((c) => c.cy <= phone.pivot.y + 1)).toBe(true);
  });
});

describe("touch layout: the crawler keepout", () => {
  /**
   * THE CAMERA PUTS THE CRAWLER IN THE MIDDLE OF THE GLASS, so no control may
   * be there. Measured before this rule existed: on an iPhone 13 landscape the
   * crawler projects to (375,150) and `#t-map` was 51x51 at (370,152) — the
   * MAP chip painted on the character's chest, with the cluster's bounding box
   * (43% x 51% of the screen) containing the crawler outright. The iPad was
   * clean for a reason that had nothing to do with intent: a tablet's
   * comfortable arc cannot reach the middle of an 1194 px slab.
   */
  for (const d of DEVICES) {
    for (const handed of ["right", "left"] as const) {
      it(`${d.name} ${handed}: no control's hit rect touches the crawler`, () => {
        for (const slider of SLIDERS) {
          const z = computeZones(d.w, d.h, d.safe as Insets, prefs({ handed, ...slider }));
          const tag = `${d.name} ${handed} x${slider.buttonScale} mm${slider.thumbMm}`;
          expect.soft(z.keepout, `${tag}: keepout missing`).toBeTruthy();
          for (const id of [...COMBAT_CONTROLS, ...NAV_CONTROLS]) {
            expect.soft(overlaps(hitRect(z, id), z.keepout), `${tag}: ${id} on the crawler`)
              .toBe(false);
          }
        }
      });
    }
  }

  it("the keepout is where the camera actually keeps the crawler", () => {
    // It is a fact about the viewport, not about the safe box: the camera does
    // not know about notches.
    const z = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());
    expect(z.keepout.x + z.keepout.w / 2).toBeCloseTo(375, 6);
    expect(z.keepout.y + z.keepout.h / 2).toBeCloseTo(171, 6);
    // ...and it is sized to the CHARACTER, not to a fraction someone liked:
    // roughly a 60x90 crawler-plus-plate with a finger's margin.
    expect(z.keepout.w).toBeGreaterThan(80);
    expect(z.keepout.w).toBeLessThan(160);
    expect(z.keepout.h).toBeGreaterThan(60);
  });
});

describe("touch layout: the reach invariant", () => {
  for (const d of DEVICES) {

    it(`${d.name}: nothing lands in a safe-area gutter, and every target is 44px`, () => {
      const z = computeZones(d.w, d.h, d.safe as Insets, prefs());
      for (const id of Object.keys(z.controls) as ControlId[]) {
        const c = z.controls[id];
        expect.soft(c.x, `${id} left`).toBeGreaterThanOrEqual(d.safe.left);
        expect.soft(c.y, `${id} top`).toBeGreaterThanOrEqual(d.safe.top);
        expect.soft(c.x + c.w, `${id} right`).toBeLessThanOrEqual(d.w - d.safe.right);
        expect.soft(c.y + c.h, `${id} bottom`).toBeLessThanOrEqual(d.h - d.safe.bottom);
        expect.soft(Math.min(c.w, c.h), `${id} size`).toBeGreaterThanOrEqual(MIN_TARGET);
      }
      // The CANCEL band is zero-area where the posture ships none — see
      // `cancelMode`. A corner grip's only cancel is return-to-origin, drawn
      // at the frozen press origin, because every band placement that clears
      // the movement thumb also sits one `aimThrow` inboard of the nearest
      // chip and would eat a full-range leftward aim.
      const zones = z.cancelMode === "band"
        ? [z.stickZone, z.worldZone, z.cancelBand]
        : [z.stickZone, z.worldZone];
      for (const r of zones) {
        expect.soft(r.x).toBeGreaterThanOrEqual(d.safe.left);
        expect.soft(r.x + r.w).toBeLessThanOrEqual(d.w - d.safe.right + 0.001);
        expect.soft(r.h).toBeGreaterThan(0);
        expect.soft(r.w).toBeGreaterThan(0);
      }
      expect.soft(z.cancelMode, `${d.name} cancel mode`)
        .toBe(isSideGrip(z.cls) ? "band" : "origin");
    });

    /**
     * MAP IS NOT A COMBAT CONTROL, AND THAT IS NOW WRITTEN DOWN.
     *
     * A critic measured `map` at 290 px from an iPhone 13's pivot against a
     * 274 px comfortable arc and observed, correctly, that the reach test
     * asserts combat controls are inside `comfortable` while this one is not.
     * It is not inside because opening the chart is a between-fights decision
     * with time to regrip, and giving it a comfortable-arc slot would spend
     * that slot on something you never press under pressure. The exclusion is
     * deliberate; this is its weaker invariant, so "not comfortable" can never
     * quietly become "not reachable".
     */
    it(`${d.name}: navigation controls clear STRETCH even though they skip COMFORTABLE`, () => {
      const z = computeZones(d.w, d.h, d.safe as Insets, prefs());
      for (const id of NAV_CONTROLS) {
        expect.soft(COMBAT_CONTROLS.includes(id), `${id} must not be a combat control`).toBe(false);
        expect.soft(z.controls[id].fromPivot, `${id} out of stretch`)
          .toBeLessThanOrEqual(z.stretch + 0.001);
      }
    });

    it(`${d.name}: the stick zone and the cluster do not overlap`, () => {
      const z = computeZones(d.w, d.h, d.safe as Insets, prefs());
      for (const id of COMBAT_CONTROLS) {
        const c = z.controls[id];
        const overlaps = c.x < z.stickZone.x + z.stickZone.w && c.x + c.w > z.stickZone.x &&
          c.y < z.stickZone.y + z.stickZone.h && c.y + c.h > z.stickZone.y;
        expect.soft(overlaps, `${id} sits in the movement thumb zone`).toBe(false);
      }
    });
  }
});

describe("touch layout: mirroring is a true reflection", () => {
  it("left-handed mirrors every control about the viewport centre", () => {
    const right = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());
    const left = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 }, prefs({ handed: "left" }));
    for (const id of Object.keys(right.controls) as ControlId[]) {
      expect.soft(left.controls[id].cx, id).toBeCloseTo(750 - right.controls[id].cx, 4);
      expect.soft(left.controls[id].cy, id).toBeCloseTo(right.controls[id].cy, 4);
      expect.soft(left.controls[id].fromPivot, id).toBeCloseTo(right.controls[id].fromPivot, 4);
    }
    expect(left.stickZone.x + left.stickZone.w).toBeCloseTo(750 - right.stickZone.x, 4);
  });

  it("a mirrored layout still keeps every combat control inside comfortable", () => {
    for (const d of DEVICES) {
      const z = computeZones(d.w, d.h, d.safe as Insets, prefs({ handed: "left" }));
      for (const id of COMBAT_CONTROLS) {
        expect.soft(z.controls[id].fromPivot, `${id} on ${d.name}`).toBeLessThanOrEqual(z.comfortable);
      }
    }
  });
});

describe("touch layout: hit testing", () => {
  const z = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());

  it("a press between two chips picks the NEAREST CENTRE, not the top one", () => {
    // Pick the CLOSEST pair on this device rather than naming two chips: the
    // arc is posture-dependent, and a test that hardcodes neighbours is
    // testing the table, not the resolver.
    const ids = Object.keys(z.controls) as ControlId[];
    let pair: [ControlId, ControlId] = ["slot0", "slot1"], best = Infinity;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = Math.hypot(z.controls[ids[i]].cx - z.controls[ids[j]].cx,
          z.controls[ids[i]].cy - z.controls[ids[j]].cy);
        if (d < best) { best = d; pair = [ids[i], ids[j]]; }
      }
    }
    const a = z.controls[pair[0]], b = z.controls[pair[1]];
    const midX = (a.cx + b.cx) / 2, midY = (a.cy + b.cy) / 2;
    expect(hitControl(z, midX + (a.cx - midX) * 0.6, midY + (a.cy - midY) * 0.6)).toBe(pair[0]);
    expect(hitControl(z, midX + (b.cx - midX) * 0.6, midY + (b.cy - midY) * 0.6)).toBe(pair[1]);
  });

  it("zones route what the chips do not claim", () => {
    expect(hitZone(z, z.stickZone.x + 10, z.stickZone.y + 10)).toBe("stick");
    expect(hitZone(z, z.worldZone.x + 10, z.worldZone.y + 10)).toBe("world");
    // `z` is a phone here, so there is no band to hit-test: the corner grip's
    // cancel is the frozen origin (`cancelMode: "origin"`), and touch.ts
    // refuses to hit-test a zero-area rect for exactly this reason.
    expect(z.cancelMode).toBe("origin");
    expect(inRect(z.cancelBand, z.cancelBand.x + 2, z.cancelBand.y + 2)).toBe(false);
    const tab = computeZones(1194, 834, { top: 24, right: 0, bottom: 20, left: 0 }, prefs());
    expect(tab.cancelMode).toBe("band");
    expect(inRect(tab.cancelBand, tab.cancelBand.x + 2, tab.cancelBand.y + 2)).toBe(true);
  });

  /**
   * THE SIZE SLIDER IS A REQUEST, AND THE LAYOUT ANSWERS IT HONESTLY.
   *
   * Nine controls, a 44px hit floor and 1.4x buttons do not fit inside a
   * landscape phone's cluster box — that is arithmetic, not a bug. The old
   * layout let relaxation resolve it by pushing chips past `comfortable` and
   * into the movement thumb's zone; both are worse than a smaller chip. So the
   * request is stepped down until the cluster packs, and what may NEVER give
   * is reach or non-overlap.
   */
  it("the size slider is honoured as far as the hand and the box allow", () => {
    const small = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 },
      prefs({ buttonScale: 0.7, stickScale: 0.7 }));
    const big = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 },
      prefs({ buttonScale: 1.4, stickScale: 1.4, hudInset: 24 }));
    expect(small.controls.slot1.w).toBeLessThan(z.controls.slot1.w);
    expect(big.controls.slot1.w).toBeGreaterThanOrEqual(small.controls.slot1.w);
    expect(big.stickRadius).toBeGreaterThan(z.stickRadius);
    // The aim throw follows buttonScale, NEVER stickScale (contradiction 2).
    expect(big.aimThrow).toBeGreaterThan(z.aimThrow);
    expect(computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 },
      prefs({ stickScale: 1.4 })).aimThrow).toBeCloseTo(z.aimThrow, 6);
    // Reach holds outright at EVERY scale — no stretch-arc concession.
    for (const t of [small, z, big]) {
      for (const id of COMBAT_CONTROLS) {
        expect.soft(t.controls[id].fromPivot, `${t.controls[id].w.toFixed(0)}px ${id}`)
          .toBeLessThanOrEqual(t.comfortable + 0.001);
      }
    }
  });

  /**
   * NO TWO CONTROLS MAY OVERLAP — the invariant the route probe bought.
   *
   * `controlAt()` resolves an overlap by nearest centre; `chipUnder()` asks the
   * DOM, which answers with whichever chip PAINTS last. When two rects overlap
   * the two disagree and the DOM wins. Measured on a Pixel 5 (802x293), the
   * flask's rect covered slot 1's own centre, so tapping DASH drank a potion.
   */
  it("never overlaps two controls, on any measured viewport or grip", () => {
    const VIEWPORTS: [number, number, Insets][] = [
      [750, 342, { top: 0, right: 47, bottom: 21, left: 47 }],   // iPhone 13
      [832, 380, { top: 0, right: 47, bottom: 21, left: 47 }],   // 13 Pro Max
      [802, 293, { top: 0, right: 24, bottom: 0, left: 0 }],     // Pixel 5
      [1194, 834, { top: 24, right: 0, bottom: 20, left: 0 }],   // iPad Pro 11
      [1080, 810, { top: 0, right: 0, bottom: 0, left: 0 }],     // iPad 7
      [568, 320, { top: 0, right: 0, bottom: 0, left: 0 }],      // iPhone SE, the floor
    ];
    for (const [w, h, insets] of VIEWPORTS) {
      for (const handed of ["right", "left"] as const) {
        for (const buttonScale of [0.7, 1, 1.4]) {
          const t = computeZones(w, h, insets, prefs({ handed, buttonScale }));
          const ids = Object.keys(t.controls) as ControlId[];
          for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
              const a = t.controls[ids[i]], b = t.controls[ids[j]];
              const gapX = Math.abs(a.cx - b.cx) - (a.w + b.w) / 2;
              const gapY = Math.abs(a.cy - b.cy) - (a.h + b.h) / 2;
              expect.soft(
                Math.max(gapX, gapY),
                `${w}x${h} ${handed} x${buttonScale}: ${ids[i]} vs ${ids[j]}`,
              ).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    }
  });

  /** Separation may move a chip, but the table must never lie about where. */
  it("keeps rect, centre and pivot distance consistent after separation", () => {
    const t = computeZones(802, 293, { top: 0, right: 24, bottom: 0, left: 0 }, prefs({}));
    for (const id of Object.keys(t.controls) as ControlId[]) {
      const c = t.controls[id];
      expect.soft(c.x + c.w / 2, id).toBeCloseTo(c.cx, 6);
      expect.soft(c.y + c.h / 2, id).toBeCloseTo(c.cy, 6);
      expect.soft(c.fromPivot, id).toBeCloseTo(Math.hypot(c.cx - t.pivot.x, c.cy - t.pivot.y), 6);
      // And nothing may be sitting in a safe-area gutter.
      expect.soft(c.x, id).toBeGreaterThanOrEqual(t.safe.x - 0.001);
      expect.soft(c.x + c.w, id).toBeLessThanOrEqual(t.safe.x + t.safe.w + 0.001);
    }
  });
});