import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  dacos, dasin, datan, datan2, dcos, dhypot, dpow, dsin, dtan, DPI, DTAU,
} from "../src/sim/dmath";

// THE GOLDEN FIXTURE (COMPETITIVE.md MUST-0). The verification spine assumes a
// run replays identically on the machine that recorded it and the machine that
// certifies it. ECMA-262 guarantees that for + - * / and Math.sqrt and for
// nothing else; tools/mathdivergence.ts measures Chromium, Firefox and WebKit
// each disagreeing with Node on sin/cos/atan2 over hundreds of inputs, and two
// different V8 VERSIONS are enough.
//
// So the sim gets its transcendentals from src/sim/dmath.ts, built only from
// the exactly-rounded subset. This hash pins their outputs. If it changes, one
// of two things happened, and both need a human:
//   1. dmath changed - then every recorded proof is retired, and the rules hash
//      must move with it.
//   2. the ENGINE changed the answer - which is the thing dmath exists to make
//      impossible, and means a real portability bug.
const GOLDEN = "7288235be71fe372cb6d83fdd0bedfda8d98fcf6ad7cc911ae69af9c40b4c607";

function fixtureHash(): string {
  const h = createHash("sha256");
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const b = new Uint8Array(buf);
  const put = (v: number): void => { f[0] = v; h.update(b); };
  for (let i = 0; i < 20000; i++) {
    const x = (i / 20000) * 400 - 200;
    put(dsin(x)); put(dcos(x)); put(datan(x));
  }
  for (let i = 0; i < 20000; i++) {
    const y = (i % 141) / 20 - 3.5;
    const x = Math.floor(i / 141) / 20 - 3.5;
    put(datan2(y, x)); put(dhypot(y, x));
  }
  for (let i = 0; i <= 4000; i++) put(dasin(i / 2000 - 1));
  for (let i = 0; i <= 4000; i++) put(dacos(i / 2000 - 1));
  for (let n = 0; n <= 24; n++) { put(dpow(1.08, n)); put(dpow(1.06, n)); put(dpow(1.35, n)); }
  for (const x of [0, 1e-9, 1, 1e3, 1e5, 12345.678, -99999.5]) { put(dsin(x)); put(dcos(x)); }
  return h.digest("hex");
}

describe("dmath: deterministic math", () => {
  it("matches the golden fixture bit for bit", () => {
    expect(fixtureHash()).toBe(GOLDEN);
  });

  it("agrees with the platform Math to sub-ULP accuracy", () => {
    // Accuracy is NOT the requirement - determinism is. This test exists so a
    // future rewrite of a kernel cannot quietly ship something that is stable
    // but wrong, which would be a balance change disguised as a cleanup.
    let worstSin = 0, worstCos = 0, worstAtan = 0, worstAtan2 = 0, worstHypot = 0;
    for (let i = 0; i < 20000; i++) {
      const x = (i / 20000) * 400 - 200;
      worstSin = Math.max(worstSin, Math.abs(dsin(x) - Math.sin(x)));
      worstCos = Math.max(worstCos, Math.abs(dcos(x) - Math.cos(x)));
      worstAtan = Math.max(worstAtan, Math.abs(datan(x) - Math.atan(x)));
    }
    for (let i = 0; i < 5000; i++) {
      const y = (i % 71) / 10 - 3.5;
      const x = Math.floor(i / 71) / 10 - 3.5;
      worstAtan2 = Math.max(worstAtan2, Math.abs(datan2(y, x) - Math.atan2(y, x)));
      worstHypot = Math.max(worstHypot, Math.abs(dhypot(y, x) - Math.hypot(y, x)));
    }
    expect(worstSin).toBeLessThan(1e-15);
    expect(worstCos).toBeLessThan(1e-15);
    expect(worstAtan).toBeLessThan(1e-15);
    expect(worstAtan2).toBeLessThan(1e-15);
    expect(worstHypot).toBeLessThan(1e-12);
  });

  it("reproduces the IEEE special cases atan2 is defined by", () => {
    const cases: [number, number][] = [
      [0, 1], [-0, 1], [0, -1], [-0, -1], [1, 0], [-1, 0], [0, 0], [-0, -0],
      [1, Infinity], [1, -Infinity], [Infinity, 1], [-Infinity, 1],
      [Infinity, Infinity], [-Infinity, -Infinity], [Infinity, -Infinity],
    ];
    for (const [y, x] of cases) {
      expect(Object.is(datan2(y, x), Math.atan2(y, x)), `atan2(${y}, ${x})`).toBe(true);
    }
    expect(Number.isNaN(datan2(NaN, 1))).toBe(true);
    expect(Number.isNaN(dsin(Infinity))).toBe(true);
    expect(Number.isNaN(dcos(NaN))).toBe(true);
  });

  it("clamps asin/acos instead of returning NaN just outside the domain", () => {
    // The sim feeds ratios that can land a few ULP outside [-1, 1]; a NaN there
    // would be a live bug, and inSwing/angleBetween both do exactly this.
    expect(dasin(1 + 1e-16)).toBeCloseTo(Math.PI / 2, 12);
    expect(dacos(-1 - 1e-16)).toBeCloseTo(Math.PI, 12);
    expect(Number.isNaN(dasin(2))).toBe(false);
    expect(Number.isNaN(dacos(-2))).toBe(false);
  });

  it("dpow is exact on integer exponents and handles the edges", () => {
    expect(dpow(2, 10)).toBe(1024);
    expect(dpow(1.08, 0)).toBe(1);
    expect(dpow(2, -2)).toBe(0.25);
    for (let n = 0; n <= 20; n++) {
      expect(Math.abs(dpow(1.08, n) - Math.pow(1.08, n))).toBeLessThan(1e-12);
    }
  });

  it("exposes the constants the codec quantizes against", () => {
    expect(DPI).toBe(Math.PI);
    expect(DTAU).toBe(Math.PI * 2);
    expect(Math.abs(dtan(0.7) - Math.tan(0.7))).toBeLessThan(1e-14);
  });
});
