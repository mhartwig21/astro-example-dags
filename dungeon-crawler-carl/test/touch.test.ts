import { describe, it, expect } from "vitest";
import { VirtualStick, SlotButton } from "../src/input/touch";

// The pure touch state machines: coordinates in, movement vectors and cast
// decisions out. The DOM shell (TouchController) is exercised by the headless
// probe; these lock the tap/drag/cancel semantics the shell relies on.

describe("touch: virtual stick", () => {
  it("spawns under the thumb and reports direction past the dead zone", () => {
    const s = new VirtualStick(60);
    expect(s.value).toBeNull();
    s.down(200, 500);
    expect(s.value).toBeNull(); // no drag yet
    s.move(200, 470); // 30px up = half the radius
    expect(s.value).not.toBeNull();
    expect(s.value!.x).toBeCloseTo(0);
    expect(s.value!.y).toBeCloseTo(-0.5);
  });

  it("ignores micro-jitter inside the dead zone", () => {
    const s = new VirtualStick(60);
    s.down(200, 500);
    s.move(204, 503); // 5px — a resting thumb
    expect(s.value).toBeNull();
  });

  it("clamps to unit length at the ring's edge and beyond", () => {
    const s = new VirtualStick(60);
    s.down(200, 500);
    s.move(200 + 300, 500); // far past the ring
    expect(Math.hypot(s.value!.x, s.value!.y)).toBeCloseTo(1);
    expect(s.nub.x).toBeCloseTo(60); // nub renders clamped to the base
  });

  it("stops on lift", () => {
    const s = new VirtualStick(60);
    s.down(200, 500);
    s.move(260, 500);
    s.up();
    expect(s.value).toBeNull();
    expect(s.origin).toBeNull();
  });
});

describe("touch: slot button (tap / drag-aim / cancel)", () => {
  it("a short press is a tap (quick cast, host auto-aims)", () => {
    const b = new SlotButton();
    b.down(1000, 700);
    b.move(1008, 706); // within slop
    expect(b.up()).toEqual({ kind: "tap" });
  });

  it("dragging past the slop aims, and release casts along the drag", () => {
    const b = new SlotButton();
    b.down(1000, 700);
    b.move(1000, 640); // 60px up
    expect(b.aimDir).toEqual({ x: 0, y: -60 });
    const rel = b.up();
    expect(rel.kind).toBe("aimed");
    if (rel.kind === "aimed") expect(rel.aim).toEqual({ x: 0, y: -60 });
  });

  it("dragging out and back home cancels instead of casting", () => {
    const b = new SlotButton();
    b.down(1000, 700);
    b.move(1000, 600); // committed to a drag
    b.move(1004, 692); // ...changed their mind, thumb back on the chip
    expect(b.aimDir).toBeNull(); // preview hides in the cancel zone
    expect(b.up()).toEqual({ kind: "cancel" });
  });

  it("aim preview is live only while actually dragging", () => {
    const b = new SlotButton();
    b.down(1000, 700);
    expect(b.aimDir).toBeNull(); // pressed, not dragged
    b.move(1010, 700); // still within slop
    expect(b.aimDir).toBeNull();
    b.move(1080, 700);
    expect(b.aimDir).toEqual({ x: 80, y: 0 });
  });
});
