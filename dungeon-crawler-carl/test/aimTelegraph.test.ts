import { describe, it, expect } from "vitest";
import { aimAnchor, aimSpecFor, type AimSpec } from "../src/input/aimSpec";
import { isoRotate } from "../src/input/gamepad";
import { createTestGame } from "../src/sim/game";
import type { Player, Vec2 } from "../src/sim/types";
import { THEME } from "../src/render3d/theme";

/**
 * THE TELEGRAPH IS ON THE GLASS — projected, not asserted.
 *
 * test/aimIndicator.test.ts already proves the six shapes are BUILT with the
 * ability's own numbers. It builds them at the origin, so it could never see
 * the bug that shipped: the host placed them at `p.pos + isoRotate(aimDir) *
 * tiles`, and `aimDir` is the RAW PIXEL drag vector. Rotation preserves
 * magnitude, so a 175 px drag put nova 455 world units from the crawler and
 * cataclysm 1050 — projected screen boxes at x = -11419 and x = -26803 on a
 * 750x342 iPhone 13, with 0% of their vertices on the glass, in 4 of 4
 * directions on 2 of 2 devices. Six of ten abilities, including both
 * ultimates.
 *
 * A geometry test cannot catch a placement bug. This one therefore does what
 * the harness does: it takes the SAME drag vectors a thumb produces, runs them
 * through the SAME `isoRotate` seam the host uses, and projects the result
 * through the shipping iso camera onto a real device viewport.
 */

// --------------------------------------------------------------- projection
/**
 * The shipping camera, reproduced from `THEME` and `renderer3d.applyProjection`
 * rather than from memory: orthographic, anchored on the crawler, looking down
 * `camDir`, `camOrthoHalfHeight` tiles of world across the viewport's height.
 *
 * Deriving it from THEME is deliberate — if someone re-pitches the camera, the
 * on-screen claim is re-derived with it instead of quietly becoming a lie.
 */
function makeCamera(vw: number, vh: number, anchor: Vec2) {
  const d = THEME.camDir;
  const len = Math.hypot(d.x, d.y, d.z);
  const f = { x: -d.x / len, y: -d.y / len, z: -d.z / len }; // camera -> target
  // right = normalize(f x up), up' = right x f, with up = (0,1,0).
  const rx = -f.z, rz = f.x;
  const rl = Math.hypot(rx, rz);
  const r = { x: rx / rl, y: 0, z: rz / rl };
  const u = {
    x: r.y * f.z - r.z * f.y,
    y: r.z * f.x - r.x * f.z,
    z: r.x * f.y - r.y * f.x,
  };
  // Ortho half-height in tiles; half-width follows the aspect, so the pixels
  // per world unit are the SAME on both axes.
  const pxPerWorld = vh / (2 * THEME.camOrthoHalfHeight);
  return (wx: number, wz: number): Vec2 => {
    const dx = wx - anchor.x, dz = wz - anchor.y;
    const sr = dx * r.x + dz * r.z;
    const su = dx * u.x + dz * u.z;
    return { x: vw / 2 + sr * pxPerWorld, y: vh / 2 - su * pxPerWorld };
  };
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/**
 * Where the shape's ink actually lands, sampled on the ground plane: the
 * anchor's own footprint circle plus, for a shape that reaches, the ribbon
 * from the crawler out to it.
 */
function shapeBox(
  spec: AimSpec, from: Vec2, at: Vec2, dir: Vec2,
  project: (x: number, z: number) => Vec2,
): Box {
  const pts: Vec2[] = [];
  const ring = (c: Vec2, r: number): void => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
  };
  switch (spec.shape) {
    case "ring":
    case "scatter":
      ring(at, spec.radius);
      break;
    case "arrow":
      // The ribbon from the feet to the landing footprint, plus the footprint.
      pts.push(from, at);
      ring(at, Math.max(spec.radius, 0.4));
      break;
    case "line":
    case "chain":
    case "cone": {
      // Direction-only: drawn from the crawler out to the full derived reach.
      const end = { x: from.x + dir.x * spec.range, y: from.y + dir.y * spec.range };
      pts.push(from, end);
      ring(end, Math.max(spec.radius, 0.3));
      break;
    }
    default:
      pts.push(from);
  }
  const px = pts.map((p) => project(p.x, p.y));
  return {
    x0: Math.min(...px.map((p) => p.x)), x1: Math.max(...px.map((p) => p.x)),
    y0: Math.min(...px.map((p) => p.y)), y1: Math.max(...px.map((p) => p.y)),
  };
}

const intersectsViewport = (b: Box, vw: number, vh: number): boolean =>
  b.x1 >= 0 && b.x0 <= vw && b.y1 >= 0 && b.y0 <= vh;

/** Fraction of the box's area that is on the glass — 0 is the shipped bug. */
function onScreenFraction(b: Box, vw: number, vh: number): number {
  const w = Math.max(0, Math.min(b.x1, vw) - Math.max(b.x0, 0));
  const h = Math.max(0, Math.min(b.y1, vh) - Math.max(b.y0, 0));
  const area = Math.max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0));
  return (w * h) / area;
}

// ------------------------------------------------------------------ fixtures
/** The device matrix's landscape viewports, and the drag the harness sends. */
const DEVICES: Array<{ name: string; w: number; h: number }> = [
  { name: "iPhone 13 landscape", w: 750, h: 342 },
  { name: "iPhone 13 Pro Max landscape", w: 832, h: 380 },
  { name: "iPad Pro 11 landscape", w: 1194, h: 790 },
  { name: "Pixel 5 landscape", w: 802, h: 293 },
];

/**
 * Real thumb drags in SCREEN pixels — the magnitudes the harness measured
 * (110-175 px), not unit vectors. A unit-vector test would have passed against
 * the shipped bug, which is exactly why it never caught it.
 */
const DRAGS: Array<{ name: string; v: Vec2 }> = [
  { name: "up", v: { x: 0, y: -175 } },
  { name: "down", v: { x: 0, y: 171 } },
  { name: "inboard", v: { x: -150, y: 90 } },
  { name: "outboard", v: { x: 129, y: -74 } },
];

function loadout(): { p: Player; specs: Array<{ id: string; spec: AimSpec }> } {
  const s = createTestGame({ floor: 8, level: 16, abilities: "all", seed: 11 });
  const p = s.players[0];
  const specs = [...p.abilities.slots, p.abilities.ultimate]
    .map((id) => ({ id: String(id), spec: aimSpecFor(id, p) }))
    .filter((e) => e.spec.shape !== "none");
  return { p, specs };
}

describe("the aim telegraph lands on the glass", () => {
  it("every placed shape, every direction, frac 0 and frac 1, on every device", () => {
    const { p, specs } = loadout();
    const from = { x: p.pos.x, y: p.pos.y };
    expect(specs.length).toBeGreaterThanOrEqual(4);
    for (const dev of DEVICES) {
      const project = makeCamera(dev.w, dev.h, from);
      for (const { id, spec } of specs) {
        for (const drag of DRAGS) {
          for (const frac of [0, 0.5, 1]) {
            const a = aimAnchor(spec, from, isoRotate(drag.v), frac, p.facing);
            const box = shapeBox(spec, from, a.at, a.dir, project);
            expect.soft(
              intersectsViewport(box, dev.w, dev.h),
              `${id} (${spec.shape}) drag ${drag.name} frac ${frac} on ${dev.name}: ` +
              `box (${box.x0.toFixed(0)},${box.y0.toFixed(0)})-` +
              `(${box.x1.toFixed(0)},${box.y1.toFixed(0)}) misses a ${dev.w}x${dev.h} frame`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("a PLACED shape never lands further out than the ability actually reaches", () => {
    // The bug's signature was a distance that scaled with the DRAG's pixel
    // length: nova at 455 units and cataclysm at 1050, in a ratio equal to
    // their radii. Distance may depend on `frac` and on the ability, and on
    // nothing else — feed the same frac at three drag magnitudes and get one
    // answer.
    const { p, specs } = loadout();
    const from = { x: p.pos.x, y: p.pos.y };
    for (const { id, spec } of specs) {
      const at = [40, 175, 900].map((m) =>
        aimAnchor(spec, from, isoRotate({ x: m * 0.6, y: -m * 0.8 }), 1, p.facing).distance);
      expect.soft(at[1], `${id} distance moved with the drag magnitude`).toBeCloseTo(at[0], 9);
      expect.soft(at[2], `${id} distance moved with the drag magnitude`).toBeCloseTo(at[0], 9);
      const reach = Math.max(spec.range, spec.radius);
      expect.soft(at[0], `${id} placed past its own reach`).toBeLessThanOrEqual(reach + 1e-6);
    }
  });

  it("the direction handed to the renderer is a UNIT vector, whatever the drag", () => {
    const { p, specs } = loadout();
    const from = { x: p.pos.x, y: p.pos.y };
    for (const { id, spec } of specs) {
      for (const drag of DRAGS) {
        const a = aimAnchor(spec, from, isoRotate(drag.v), 0.7, p.facing);
        expect.soft(Math.hypot(a.dir.x, a.dir.y), `${id} ${drag.name}`).toBeCloseTo(1, 9);
      }
    }
    // ...and with no drag at all it falls back to facing, still unit.
    const fb = aimAnchor(specs[0].spec, from, null, 0, { x: 3, y: -4 });
    expect(Math.hypot(fb.dir.x, fb.dir.y)).toBeCloseTo(1, 9);
    expect(fb.dir.x).toBeCloseTo(0.6, 9);
  });

  it("REGRESSION: the shipped host arithmetic is off the glass, and this proves it", () => {
    // Reproduce the exact line that shipped —
    //   const dir = isoRotate(touchHeld.aimDir);   // raw pixels
    //   const at  = p.pos + dir * aimPlacement(spec, frac);
    // — so the test's own sensitivity is demonstrated rather than assumed. If
    // this ever passes, the projection above has stopped measuring anything.
    const { p, specs } = loadout();
    const from = { x: p.pos.x, y: p.pos.y };
    const project = makeCamera(750, 342, from);
    const placed = specs.filter((e) => ["ring", "scatter", "arrow"].includes(e.spec.shape));
    expect(placed.length).toBeGreaterThan(0);
    for (const { id, spec } of placed) {
      const bad = isoRotate({ x: -150, y: 90 }); // |v| = 175 px, unnormalised
      const dist = (0.15 + 0.85) * Math.max(spec.range, spec.radius);
      const at = { x: from.x + bad.x * dist, y: from.y + bad.y * dist };
      const box = shapeBox(spec, from, at, bad, project);
      expect.soft(onScreenFraction(box, 750, 342), `${id} would have been visible`)
        .toBeLessThan(0.02);
    }
  });
});
