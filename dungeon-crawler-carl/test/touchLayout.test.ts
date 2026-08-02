import { describe, it, expect } from "vitest";
import {
  COMBAT_CONTROLS, DEFAULT_LAYOUT_PREFS, MIN_TARGET, computeZones, deviceClass,
  hitControl, hitZone, inRect, isSideGrip, reachArcs, type ControlId, type Insets,
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
] as const;

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

  it("reach is a rule of the short edge, not one phone's constant", () => {
    expect(Math.round(reachArcs(293).comfortable)).toBe(161);
    expect(Math.round(reachArcs(342).comfortable)).toBe(188);
    expect(Math.round(reachArcs(380).comfortable)).toBe(209);
    expect(Math.round(reachArcs(834).comfortable)).toBe(300); // capped
    expect(reachArcs(342).stretch).toBeCloseTo(1.37 * reachArcs(342).comfortable, 6);
  });

  it("the cluster is NOT one fixed arc: geometry moves with the short edge", () => {
    const small = computeZones(802, 293, { top: 0, right: 24, bottom: 0, left: 0 }, prefs());
    const big = computeZones(832, 380, { top: 0, right: 47, bottom: 21, left: 47 }, prefs());
    // The measured failure was chip distances IDENTICAL on a 293-tall Pixel 5
    // and a 380-tall Pro Max. They must not be.
    expect(Math.round(small.controls.slot4.fromPivot))
      .not.toBe(Math.round(big.controls.slot4.fromPivot));
    expect(small.stickRadius).toBeLessThan(big.stickRadius);
  });
});

describe("touch layout: the reach invariant", () => {
  for (const d of DEVICES) {
    it(`${d.name}: no in-combat control lies outside comfortable from its pivot`, () => {
      const z = computeZones(d.w, d.h, d.safe as Insets, prefs());
      for (const id of COMBAT_CONTROLS) {
        const c = z.controls[id];
        expect.soft(c.fromPivot, `${id} on ${d.name}`).toBeLessThanOrEqual(z.comfortable);
      }
    });

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
      for (const r of [z.stickZone, z.worldZone, z.cancelBand]) {
        expect.soft(r.x).toBeGreaterThanOrEqual(d.safe.left);
        expect.soft(r.x + r.w).toBeLessThanOrEqual(d.w - d.safe.right + 0.001);
        expect.soft(r.h).toBeGreaterThan(0);
        expect.soft(r.w).toBeGreaterThan(0);
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
    const a = z.controls.slot2, b = z.controls.slot3;
    const midX = (a.cx + b.cx) / 2, midY = (a.cy + b.cy) / 2;
    const nearA = { x: midX + (a.cx - midX) * 0.6, y: midY + (a.cy - midY) * 0.6 };
    expect(hitControl(z, nearA.x, nearA.y)).toBe("slot2");
    const nearB = { x: midX + (b.cx - midX) * 0.6, y: midY + (b.cy - midY) * 0.6 };
    expect(hitControl(z, nearB.x, nearB.y)).toBe("slot3");
  });

  it("zones route what the chips do not claim", () => {
    expect(hitZone(z, z.stickZone.x + 10, z.stickZone.y + 10)).toBe("stick");
    expect(hitZone(z, z.worldZone.x + 10, z.worldZone.y + 10)).toBe("world");
    expect(inRect(z.cancelBand, z.cancelBand.x + 2, z.cancelBand.y + 2)).toBe(true);
  });

  it("player scales change the geometry without breaking reach", () => {
    const big = computeZones(750, 342, { top: 0, right: 47, bottom: 21, left: 47 },
      prefs({ buttonScale: 1.4, stickScale: 1.4, hudInset: 24 }));
    expect(big.controls.slot1.w).toBeGreaterThan(z.controls.slot1.w);
    expect(big.stickRadius).toBeGreaterThan(z.stickRadius);
    for (const id of COMBAT_CONTROLS) {
      expect.soft(big.controls[id].fromPivot, id).toBeLessThanOrEqual(big.comfortable);
    }
  });
});