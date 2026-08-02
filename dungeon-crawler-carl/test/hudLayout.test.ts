import { describe, expect, it } from "vitest";
import { computeZones, DEFAULT_LAYOUT_PREFS, type Insets } from "../src/input/touchLayout";
import { bandBottom, hudScale, parseSafeOverride, topBand } from "../src/ui/hudLayout";

/**
 * The HUD's pure half. Everything DOM-shaped in hudLayout.ts is exercised by
 * the device battery (tools/mobileshot.mjs); what belongs in a unit test is
 * the arithmetic the battery cannot see failing — an inset string parsed
 * wrong moves the whole HUD, silently, on one device.
 */

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

describe("parseSafeOverride", () => {
  it("reads the four CSS-shorthand arities", () => {
    expect(parseSafeOverride("10")).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    expect(parseSafeOverride("10,20")).toEqual({ top: 10, right: 20, bottom: 10, left: 20 });
    expect(parseSafeOverride("10,20,30")).toEqual({ top: 10, right: 20, bottom: 30, left: 20 });
    expect(parseSafeOverride("1,2,3,4")).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });

  it("reads the real device insets the battery passes", () => {
    // iPhone 13 landscape: 47px each side for the notch/rounding, 21px home bar.
    expect(parseSafeOverride("0,47,21,47")).toEqual({ top: 0, right: 47, bottom: 21, left: 47 });
    // iPad Pro 11 landscape.
    expect(parseSafeOverride("24,0,20,0")).toEqual({ top: 24, right: 0, bottom: 20, left: 0 });
  });

  it("tolerates whitespace", () => {
    expect(parseSafeOverride(" 4 , 5 , 6 , 7 ")).toEqual({ top: 4, right: 5, bottom: 6, left: 7 });
  });

  /**
   * A typo must not silently move the HUD: the override returns null and the
   * env() values in the stylesheet stand. This is the whole reason the parser
   * is a function rather than four parseFloats at the call site.
   */
  it("refuses anything it cannot read, rather than guessing", () => {
    expect(parseSafeOverride(null)).toBeNull();
    expect(parseSafeOverride("")).toBeNull();
    expect(parseSafeOverride("abc")).toBeNull();
    expect(parseSafeOverride("10,,30")).toBeNull();
    expect(parseSafeOverride("1,2,3,4,5")).toBeNull();
    expect(parseSafeOverride("-4,0,0,0")).toBeNull();   // a negative inset is a bug
    expect(parseSafeOverride("10,NaN")).toBeNull();
  });
});

describe("hudScale", () => {
  it("leaves a mouse-driven desktop alone", () => {
    expect(hudScale(1080, false)).toBe(1);
    expect(hudScale(300, false)).toBe(1);
  });

  it("compresses on a short edge and never past the floor", () => {
    const pixel5 = hudScale(293, true);   // Pixel 5 landscape
    const iphone = hudScale(342, true);   // iPhone 13 landscape
    const ipad = hudScale(834, true);     // iPad Pro 11 landscape
    expect(pixel5).toBeLessThan(iphone);
    expect(iphone).toBeLessThan(ipad);
    expect(pixel5).toBeGreaterThanOrEqual(0.62);
    expect(ipad).toBe(1);
  });

  it("is clamped at both ends, so no screen produces unreadable chrome", () => {
    expect(hudScale(1, true)).toBe(0.62);
    expect(hudScale(99999, true)).toBe(1);
  });
});

describe("the top status band", () => {
  /**
   * A CORRECTION TO MOBILE.md 4.1, found by this test.
   *
   * The class table names "iPhone 13 landscape" as an example of the `phone`
   * class (380-559). Measured, an iPhone 13 in landscape is a 750x342
   * viewport, so its short edge is 342 and it lands in `compact` (< 380). The
   * doc was reasoning from the DEVICE's short edge in portrait (390), not from
   * the viewport the layout actually gets.
   *
   * The boundary is right and the example is wrong: at 342px tall an iPhone 13
   * is in the same bind as a 293px Pixel 5, and the r0 captures agree — the
   * cluster's bottom row and the courtesy card were both clipping. So compact
   * is the correct posture for it, and this test pins that down so nobody
   * "fixes" the boundary to match the prose.
   */
  it("puts iPhone 13 landscape in compact and Pro Max landscape in phone", () => {
    expect(computeZones(750, 342, NO_INSETS, DEFAULT_LAYOUT_PREFS, true).cls).toBe("compact");
    expect(computeZones(802, 293, NO_INSETS, DEFAULT_LAYOUT_PREFS, true).cls).toBe("compact");
    expect(computeZones(926, 428, NO_INSETS, DEFAULT_LAYOUT_PREFS, true).cls).toBe("phone");
    expect(computeZones(1194, 834, NO_INSETS, DEFAULT_LAYOUT_PREFS, true).cls).toBe("tablet-s");
  });

  it("is shorter on compact, where 15% of the height is not available", () => {
    const compact = computeZones(802, 293, NO_INSETS, DEFAULT_LAYOUT_PREFS, true);
    const phone = computeZones(926, 428, NO_INSETS, DEFAULT_LAYOUT_PREFS, true);
    expect(bandBottom(compact)).toBeLessThan(bandBottom(phone));
    expect(bandBottom(compact)).toBeGreaterThanOrEqual(38);
  });

  it("starts inside the safe box and stops short of the minimap puck", () => {
    const insets: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
    const z = computeZones(750, 342, insets, DEFAULT_LAYOUT_PREFS, true);
    const band = topBand(z, 120);
    expect(band.x).toBe(z.safe.x);
    expect(band.y).toBe(z.safe.y);
    expect(band.x).toBeGreaterThanOrEqual(insets.left);
    // The puck's column is reserved: the band must not run under it.
    expect(band.x + band.w).toBeLessThanOrEqual(z.safe.x + z.safe.w - 120);
  });

  it("never collapses to nothing on a narrow screen", () => {
    const z = computeZones(480, 300, NO_INSETS, DEFAULT_LAYOUT_PREFS, true);
    expect(topBand(z, 400).w).toBeGreaterThan(0);
  });

  /**
   * The stick may not reach into the band — that is the contract the band
   * exists to enforce, and it is what the courtesy card violated when it
   * covered x 12-234, y 96-266 of a 750x342 viewport (MOBILE.md 1.2).
   */
  it("ends exactly where the movement stick zone begins", () => {
    for (const insets of [NO_INSETS, { top: 0, right: 47, bottom: 21, left: 47 },
      { top: 24, right: 0, bottom: 20, left: 0 }]) {
      for (const [w, h] of [[750, 342], [802, 293], [926, 428], [1194, 834], [1024, 768]]) {
        const z = computeZones(w, h, insets, DEFAULT_LAYOUT_PREFS, true);
        const band = topBand(z, 120);
        expect(band.y + band.h).toBeCloseTo(z.stickZone.y, 5);
      }
    }
  });
});
