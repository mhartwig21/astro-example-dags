import { describe, it, expect } from "vitest";
import { mapPad, isoRotate, type PadButton } from "../src/input/gamepad";

// The pure controller-mapping core: device axis/button snapshots in, Intent
// fragments out. No browser Gamepad object needed — these snapshots are what
// navigator.getGamepads() would hand the GamepadController shell.

const IDLE_AXES = [0, 0, 0, 0];

function buttons(overrides: Record<number, Partial<PadButton>> = {}): PadButton[] {
  return Array.from({ length: 17 }, (_, i) => ({
    pressed: overrides[i]?.pressed ?? false,
    value: overrides[i]?.value ?? 0,
  }));
}

describe("gamepad mapping: sticks", () => {
  it("ignores sticks inside the dead zone, passes them through past it", () => {
    const idle = mapPad([0.1, 0.1, 0, 0], buttons(), []).sample;
    expect(idle.move).toBeNull();
    expect(idle.active).toBe(false);

    const walking = mapPad([0.6, -0.3, 0, 0], buttons(), []).sample;
    expect(walking.move).toEqual({ x: 0.6, y: -0.3 });
    expect(walking.active).toBe(true);
  });

  it("holds the aim stick to a stiffer dead zone than movement (no drift-aim)", () => {
    // 0.25 deflection: enough to walk, not enough to aim.
    const s = mapPad([0.25, 0, 0.25, 0], buttons(), []).sample;
    expect(s.move).not.toBeNull();
    expect(s.aim).toBeNull();

    const aiming = mapPad([0, 0, 0.8, 0.2], buttons(), []).sample;
    expect(aiming.aim).toEqual({ x: 0.8, y: 0.2 });
  });
});

describe("gamepad mapping: iso rotation", () => {
  const s = Math.SQRT1_2;

  it("maps screen-up on the stick to world northwest (the iso camera diagonal)", () => {
    const v = isoRotate({ x: 0, y: -1 }); // stick pushed up (screen y is down)
    expect(v.x).toBeCloseTo(-s);
    expect(v.y).toBeCloseTo(-s);
  });

  it("maps screen-right to world northeast and preserves length", () => {
    const v = isoRotate({ x: 1, y: 0 });
    expect(v.x).toBeCloseTo(s);
    expect(v.y).toBeCloseTo(-s);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
  });
});

describe("gamepad mapping: buttons", () => {
  it("routes face buttons to ability slots 1-4 (A X B Y order)", () => {
    const a = mapPad(IDLE_AXES, buttons({ 0: { pressed: true } }), []).sample;
    expect(a.cast).toEqual([true, false, false, false, false]);
    const x = mapPad(IDLE_AXES, buttons({ 2: { pressed: true } }), []).sample;
    expect(x.cast[1]).toBe(true);
    const b = mapPad(IDLE_AXES, buttons({ 1: { pressed: true } }), []).sample;
    expect(b.cast[2]).toBe(true);
    const y = mapPad(IDLE_AXES, buttons({ 3: { pressed: true } }), []).sample;
    expect(y.cast[3]).toBe(true);
  });

  it("treats the right trigger as the ultimate, honoring analog values", () => {
    // Some pads report triggers as value-only (pressed stays false).
    const soft = mapPad(IDLE_AXES, buttons({ 7: { value: 0.2 } }), []).sample;
    expect(soft.cast[4]).toBe(false);
    const pulled = mapPad(IDLE_AXES, buttons({ 7: { value: 0.8 } }), []).sample;
    expect(pulled.cast[4]).toBe(true);
  });

  it("edge-triggers flask/stairs/ping: fire on press, not while held", () => {
    const first = mapPad(IDLE_AXES, buttons({ 4: { pressed: true }, 5: { pressed: true } }), []);
    expect(first.sample.flaskEdge).toBe(true);
    expect(first.sample.stairsEdge).toBe(true);

    // Same buttons still down next frame: edges must not repeat.
    const held = mapPad(IDLE_AXES, buttons({ 4: { pressed: true }, 5: { pressed: true } }), first.pressed);
    expect(held.sample.flaskEdge).toBe(false);
    expect(held.sample.stairsEdge).toBe(false);

    // Release, then press again: a fresh edge.
    const released = mapPad(IDLE_AXES, buttons(), held.pressed);
    const again = mapPad(IDLE_AXES, buttons({ 4: { pressed: true } }), released.pressed);
    expect(again.sample.flaskEdge).toBe(true);
  });

  it("emits panel actions on edges (Start, Back, D-pad)", () => {
    const first = mapPad(
      IDLE_AXES,
      buttons({ 9: { pressed: true }, 12: { pressed: true } }),
      [],
    );
    expect(first.sample.actions).toEqual(["inventory", "draft"]);
    const held = mapPad(
      IDLE_AXES,
      buttons({ 9: { pressed: true }, 12: { pressed: true } }),
      first.pressed,
    );
    expect(held.sample.actions).toEqual([]);
  });

  it("marks the pad active on any held button (device-switch arbitration)", () => {
    const s = mapPad(IDLE_AXES, buttons({ 0: { pressed: true } }), []).sample;
    expect(s.active).toBe(true);
  });
});
