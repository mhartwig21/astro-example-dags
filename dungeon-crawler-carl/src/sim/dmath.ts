/**
 * DETERMINISTIC MATH - the floor the whole verification spine stands on.
 * (COMPETITIVE.md 2.1 / MUST-0.)
 *
 * ECMA-262 requires exactly-rounded IEEE-754 results for + - * / and
 * Math.sqrt and NOTHING ELSE. Every transcendental - sin, cos, atan2, pow,
 * hypot - is explicitly "implementation-approximated", and
 * tools/mathdivergence.ts measures the consequence: Chromium, Firefox and
 * WebKit each disagree with Node on sin/cos/atan2 for hundreds of inputs out
 * of 20,000, and two different V8 VERSIONS are enough to diverge. A replay
 * that re-executes on a different engine than it was recorded on therefore
 * drifts, silently, and the verifier calls an honest player a cheater.
 *
 * So the sim calls nothing from Math except the exactly-specified subset:
 *   + - * /   Math.sqrt   Math.abs   Math.floor/ceil/round/trunc
 *   Math.min/max   Math.sign   Math.imul
 * and gets its transcendentals from here. Every routine below is built from
 * that subset alone, in a fixed operation order, so it produces bit-identical
 * results on every conforming engine.
 *
 * ACCURACY IS NOT THE REQUIREMENT - DETERMINISM IS. A sine 2 ULP from true is
 * fine as long as it is the same 2 ULP everywhere. (The kernels below are
 * fdlibm derived, so in practice they are also sub-ULP.)
 * test/determinism-portability.test.ts pins the outputs with a golden
 * fixture; tools/mathdivergence.ts stays as the cross-engine canary.
 *
 * Two rules for anyone editing src/sim/:
 *  1. Never call a Math transcendental in the sim. The determinism guard in
 *     test/balance.test.ts fails the build if you do.
 *  2. Never "improve" a constant or reorder an expression in here without
 *     accepting that it moves RULES_HASH and retires every recorded proof.
 */

// ---------------------------------------------------------------------------
// hypot
// ---------------------------------------------------------------------------

/**
 * Math.hypot replacement. Not the overflow-safe algorithm - deliberately.
 * The sim's magnitudes are dungeon tiles (length under 1e3), so the naive form
 * is three exactly-rounded operations and measurably faster than the scaling
 * dance. Values beyond ~1e150 would overflow; nothing in the sim is within 140
 * orders of magnitude of that.
 */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Squared length - no sqrt at all. Prefer this when only comparing. */
export function dlen2(x: number, y: number): number {
  return x * x + y * y;
}

// ---------------------------------------------------------------------------
// sin / cos - Cody-Waite reduction + fdlibm minimax kernels
// ---------------------------------------------------------------------------

const INV_PIO2 = 6.36619772367581382433e-01; // 2/pi
// pi/2 split into three doubles: PIO2_1 holds the leading 33 bits, so
// (n * PIO2_1) is exact for small n and the subtraction loses nothing.
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;

// __kernel_sin coefficients (fdlibm), |x| <= pi/4.
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// __kernel_cos coefficients (fdlibm), |x| <= pi/4.
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

const PIO4 = 7.85398163397448278999e-01;

// Reduced argument + quadrant from the last remPio2 call. Module-level rather
// than an allocated pair: sin/cos run tens of thousands of times per sim tick
// at depth and this path must not produce garbage.
let remR = 0;
let remQ = 0;

/**
 * Cody-Waite argument reduction: x = q*(pi/2) + r with |r| <= pi/4.
 * The second correction stage runs UNCONDITIONALLY - fdlibm branches on the
 * exponent of the partial result to skip it, and a branch is one more thing an
 * engine could get subtly different. Unconditional buys ~118 bits of pi/2,
 * good for arguments up to about a million - the sim's largest angle argument
 * is elapsed run seconds times a small frequency, well under 1e5.
 */
function remPio2(x: number): void {
  const fn = Math.round(x * INV_PIO2);
  // r0 = x - fn*(pi/2 high) is EXACT: PIO2_1 carries only 33 mantissa bits.
  const r0 = x - fn * PIO2_1;
  // Then subtract the rest of pi/2 in two pieces, carrying the cancellation
  // error forward - this is fdlibm's 2nd-iteration path, worth ~118 bits.
  const w1 = fn * PIO2_2;
  const r1 = r0 - w1;
  const w2 = fn * PIO2_2T - ((r0 - r1) - w1);
  remR = r1 - w2;
  remQ = fn % 4;
  if (remQ < 0) remQ += 4;
}

/** fdlibm __kernel_sin with the tail term dropped (reduction is exact enough). */
function ksin(x: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

/** fdlibm __kernel_cos, tail term dropped. The w + ((1-w)-hz) dance is not
 *  decoration: it recovers the bits (1 - 0.5*z) throws away near pi/4. */
function kcos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}

/** Deterministic Math.sin. */
export function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x >= -PIO4 && x <= PIO4) return ksin(x);
  remPio2(x);
  switch (remQ) {
    case 0: return ksin(remR);
    case 1: return kcos(remR);
    case 2: return -ksin(remR);
    default: return -kcos(remR);
  }
}

/** Deterministic Math.cos. */
export function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (x >= -PIO4 && x <= PIO4) return kcos(x);
  remPio2(x);
  switch (remQ) {
    case 0: return kcos(remR);
    case 1: return -ksin(remR);
    case 2: return -kcos(remR);
    default: return ksin(remR);
  }
}

/** Deterministic Math.tan. Unused by the sim today; here so a future caller
 *  does not reach for Math.tan and quietly reopen the hole. */
export function dtan(x: number): number {
  const c = dcos(x);
  return c === 0 ? NaN : dsin(x) / c;
}

// ---------------------------------------------------------------------------
// atan / atan2 - fdlibm
// ---------------------------------------------------------------------------

const ATAN_HI = [
  4.63647609000806093515e-01, // atan(0.5) hi
  7.85398163397448278999e-01, // atan(1.0) hi
  9.82793723247329054082e-01, // atan(1.5) hi
  1.57079632679489655800e+00, // atan(inf) hi
];
const ATAN_LO = [
  2.26987774529616870924e-17,
  3.06161699786838301793e-17,
  1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT0 = 3.33333333333329318027e-01;
const AT1 = -1.99999999998764832476e-01;
const AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01;
const AT4 = 9.09088713343650656196e-02;
const AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02;
const AT7 = -5.83357013379057348645e-02;
const AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02;
const AT10 = 1.62858201153657823623e-02;

const PI = 3.14159265358979311600e+00;
const PI_LO = 1.22464679914735317722e-16;
const PI_O_2 = 1.57079632679489655800e+00;
const PI_O_2_LO = 6.12323399573676603587e-17;

function signbit(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

/** Deterministic Math.atan. */
export function datan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const neg = signbit(x);
  let ax = neg ? -x : x;
  if (!Number.isFinite(ax)) return neg ? -PI_O_2 : PI_O_2;
  let id: number;
  if (ax < 0.4375) {
    if (ax < 3.725290298461914e-09) return x; // below 2^-28 atan(x) rounds to x
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); }
    else { id = 1; ax = (ax - 1) / (ax + 1); }
  } else if (ax < 2.4375) {
    id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3; ax = -1 / ax;
  }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) {
    const r0 = ax - ax * (s1 + s2);
    return neg ? -r0 : r0;
  }
  const r1 = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r1 : r1;
}

/** Deterministic Math.atan2, including the IEEE signed-zero / infinity cases. */
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 1 && !signbit(x)) return datan(y);
  // fdlibm's quadrant selector: bit 0 is sign(y), bit 1 is sign(x).
  const m = (signbit(y) ? 1 : 0) + (signbit(x) ? 2 : 0);
  if (y === 0) {
    switch (m) {
      case 0: case 1: return y; // atan(+-0, +anything) is +-0
      case 2: return PI;        // atan(+0, -anything) is +pi
      default: return -PI;      // atan(-0, -anything) is -pi
    }
  }
  if (x === 0) return signbit(y) ? -PI_O_2 : PI_O_2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) {
      switch (m) {
        case 0: return PIO4;
        case 1: return -PIO4;
        case 2: return 3 * PIO4;
        default: return -3 * PIO4;
      }
    }
    switch (m) {
      case 0: return 0;
      case 1: return -0;
      case 2: return PI;
      default: return -PI;
    }
  }
  if (!Number.isFinite(y)) return signbit(y) ? -PI_O_2 : PI_O_2;

  const q = y / x;
  const z = Number.isFinite(q)
    ? datan(q < 0 ? -q : q)
    : PI_O_2 + 0.5 * PI_O_2_LO; // the ratio overflowed: effectively infinite
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ---------------------------------------------------------------------------
// asin / acos - via the deterministic atan (COMPETITIVE.md 2.1 census)
// ---------------------------------------------------------------------------

/** Deterministic Math.asin. Domain-clamped: the sim feeds ratios that can land
 *  a few ULP outside [-1,1], and a NaN there would be a live bug. */
export function dasin(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x >= 1) return PI_O_2;
  if (x <= -1) return -PI_O_2;
  return datan2(x, Math.sqrt((1 - x) * (1 + x)));
}

/** Deterministic Math.acos. Same clamping rationale as dasin. */
export function dacos(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x >= 1) return 0;
  if (x <= -1) return PI;
  return datan2(Math.sqrt((1 - x) * (1 + x)), x);
}

// ---------------------------------------------------------------------------
// pow - integer exponents only
// ---------------------------------------------------------------------------

/**
 * Deterministic Math.pow for INTEGER exponents - which is every site in the
 * sim (floor counts and level counts). Exponentiation by squaring: error grows
 * with log2(n) instead of n, and every step is an exactly-rounded multiply.
 *
 * A fractional exponent would need a deterministic exp/log pair. Rather than
 * ship one nobody calls, this rounds the exponent, and
 * test/determinism-portability.test.ts asserts the sim never asks for a
 * fractional one. If you need real fractional powers, write dexp/dlog HERE -
 * do not reach for Math.pow.
 */
export function dpow(base: number, exp: number): number {
  let n = Math.round(exp);
  if (n === 0) return 1;
  let b = base;
  if (n < 0) { b = 1 / b; n = -n; }
  let acc = 1;
  while (n > 0) {
    if (n & 1) acc = acc * b;
    n = n >>> 1;
    if (n > 0) b = b * b;
  }
  return acc;
}

/** pi and tau, as the exact doubles the reduction constants were derived from. */
export const DPI = PI;
export const DTAU = 6.28318530717958623200e+00;
