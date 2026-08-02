import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  AIM_CORE, AIM_FILL, AIM_MIN_FOOTPRINT_PX, AIM_OUTLINE, AIM_STROKE_PX,
  buildAimShape, type AimIndicatorShape,
} from "../src/render3d/aimIndicator";
import { aimSpecFor } from "../src/input/aimSpec";
import type { Player } from "../src/sim/types";
import { createTestGame } from "../src/sim/game";

/**
 * THE TELEGRAPH IS THE SINGLE READ A TOUCH ARPG LIVES ON, so it gets a test.
 *
 * What this locks down is the thing §1.6 measured and could not previously
 * catch: three hardcoded meshes meant nova (radius 2.6) and cataclysm
 * (radius 6) drew the PIXEL-IDENTICAL ring, and `cone` / `scatter` / `chain`
 * did not exist. Geometry only — no GL context, no renderer.
 */

const bbox = (objs: THREE.Object3D[]): THREE.Box3 => {
  const g = new THREE.Group();
  for (const o of objs) g.add(o);
  g.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(g);
};

/** Ground-plane span, i.e. what the player sees: x is reach, z is width. */
const span = (objs: THREE.Object3D[]): { x: number; z: number } => {
  const b = bbox(objs);
  return { x: b.max.x - b.min.x, z: b.max.z - b.min.z };
};

const SHAPES: AimIndicatorShape[] = ["line", "ring", "arrow", "cone", "scatter", "chain"];

describe("the aim telegraph", () => {
  it("draws all six shapes the aim spec knows — cone and scatter included", () => {
    for (const k of SHAPES) {
      const objs = buildAimShape(k, 5, 2, 0.6, 0.14, 4);
      expect.soft(objs.length, `${k} produced no geometry`).toBeGreaterThan(0);
    }
    // "none" is a real answer: self-buffs and summons have no geometry, and
    // drawing a bogus line at them promised a direction that does not exist.
    expect(buildAimShape("none", 5, 2, 0, 0.14, 4)).toHaveLength(0);
  });

  it("SIZES FROM THE ABILITY: nova and cataclysm are no longer the same ring", () => {
    const nova = span(buildAimShape("ring", 0, 2.6, 0, 0.14, 1));
    const cata = span(buildAimShape("ring", 0, 6, 0, 0.14, 1));
    expect(cata.x).toBeGreaterThan(nova.x * 2);
    expect(cata.z).toBeGreaterThan(nova.z * 2);
  });

  it("a skillshot's REACH is the ability's, never inflated to suit a screen", () => {
    // The footprint floor applies to the readable terminal disc, not to the
    // range — inflating reach would be a game rule invented in presentation.
    // So the overhang past `range` is the disc, and it is the SAME on every
    // range: the drawn reach tracks the ability 1:1 and nothing else does.
    const over = [3, 8, 14.4].map((range) =>
      bbox(buildAimShape("line", range, 0.25, 0, 0.14, 6)).max.x - range);
    for (const o of over) expect.soft(o).toBeCloseTo(over[0], 4);
    expect(over[0]).toBeLessThan(2);
  });

  it("the minimum footprint binds on the shapes that would otherwise vanish", () => {
    // dash measured 71x28 CSS px — under the 96px floor in BOTH axes.
    const small = span(buildAimShape("arrow", 3.2, 0.6, 0, 0.14, 5));
    const tiny = span(buildAimShape("arrow", 3.2, 0.6, 0, 0.14, 0.01));
    expect(small.z).toBeGreaterThan(tiny.z);
  });

  it("takes the reserved palette, and the core stroke draws over world geometry", () => {
    const objs = buildAimShape("line", 6, 0.25, 0, 0.14, 4);
    const mats: THREE.MeshBasicMaterial[] = [];
    for (const o of objs) o.traverse((n) => { if ((n as THREE.Mesh).isMesh) mats.push((n as THREE.Mesh).material as THREE.MeshBasicMaterial); });
    const cols = new Set(mats.map((m) => m.color.getHex()));
    // Gold is the HUD, the chips, the torchlight and the loot glow; red/orange
    // is the ENEMY ground telegraph. Neither may appear here.
    expect(cols.has(AIM_FILL)).toBe(true);
    expect(cols.has(AIM_CORE)).toBe(true);
    expect(cols.has(AIM_OUTLINE)).toBe(true);
    expect(cols.has(0xc9a24b)).toBe(false);
    // A pack standing on the telegraph must not swallow it (r5's measured
    // failure), but nothing here may z-fight the floor.
    expect(mats.some((m) => m.depthTest === false)).toBe(true);
    expect(mats.every((m) => m.depthWrite === false)).toBe(true);
  });

  it("the floors are the numbers §3.1 published", () => {
    expect(AIM_STROKE_PX).toBe(3);
    expect(AIM_MIN_FOOTPRINT_PX).toBe(96);
  });

  it("every ability in a real loadout resolves to a shape with real numbers", () => {
    const s = createTestGame({ floor: 6, level: 14, abilities: "all", seed: 7 });
    const p: Player = s.players[0];
    const seen = new Set<string>();
    for (const id of [...p.abilities.slots, p.abilities.ultimate]) {
      const spec = aimSpecFor(id, p);
      seen.add(spec.shape);
      if (spec.shape === "none") continue;
      // A drawn shape must have SOMETHING to draw: the old renderer had a
      // constant for every one of these, which is how a 6-radius ultimate and
      // a 2.6-radius nova became the same picture.
      expect.soft(Math.max(spec.range, spec.radius), `${id} has no geometry`).toBeGreaterThan(0);
      expect.soft(buildAimShape(spec.shape, spec.range, spec.radius, spec.arc, 0.14, 4).length,
        `${id} drew nothing`).toBeGreaterThan(0);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
