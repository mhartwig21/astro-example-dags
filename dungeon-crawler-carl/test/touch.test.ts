import { describe, it, expect } from "vitest";
import { VirtualStick, SlotButton, AbilityButton } from "../src/input/touch";
import { Haptics } from "../src/input/haptics";

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

describe("touch: stick recentring and the flick", () => {
  it("past 1.35 R the origin slides so the finger sits at exactly 1.0 R", () => {
    const s = new VirtualStick(60);
    s.down(200, 500, 0);
    s.move(400, 500, 100); // 200px = 3.3 R
    expect(Math.hypot(s.value!.x, s.value!.y)).toBeCloseTo(1);
    expect(s.origin!.x).toBeCloseTo(340); // 400 - 1.0 R
    // Direction never inverts, and the stick cannot run out: drag back 30px
    // and the vector shortens instead of flipping.
    s.move(370, 500, 200);
    expect(s.value!.x).toBeGreaterThan(0);
    expect(Math.hypot(s.value!.x, s.value!.y)).toBeCloseTo(0.5);
  });

  it("recentring is switchable off for players who want a fixed origin", () => {
    const s = new VirtualStick(60);
    s.recenter = false;
    s.down(200, 500, 0);
    s.move(400, 500, 100);
    expect(s.origin!.x).toBe(200);
    expect(Math.hypot(s.value!.x, s.value!.y)).toBeCloseTo(1);
  });

  it("the resting ghost remembers where the thumb lifted", () => {
    const s = new VirtualStick(60);
    expect(s.rest).toBeNull();
    s.down(310, 480, 0);
    s.move(340, 480, 60);
    s.up();
    expect(s.rest).toEqual({ x: 310, y: 480 });
  });

  it("a flick is read from RAW VELOCITY, which recentring cannot hide", () => {
    const s = new VirtualStick(60);
    s.down(200, 500, 0);
    // 2 consecutive samples at ~4 R/s (60px in 8ms = 7500 px/s = 125 R/s).
    s.move(260, 500, 8);
    expect(s.takeFlick()).toBeNull(); // one fast sample is a twitch
    s.move(320, 500, 16);
    const f = s.takeFlick();
    expect(f).not.toBeNull();
    expect(f!.x).toBeCloseTo(1);
    expect(s.takeFlick()).toBeNull(); // one-shot
  });

  it("a thumb steering a chase is not a flick", () => {
    const s = new VirtualStick(60);
    s.down(200, 500, 0);
    // 20 px per 100 ms = 200 px/s = 3.3 R/s. Brisk steering, not a flick —
    // and the reason the threshold is not MOBILE.md's 2.6 R/s (see the
    // constant): at 2.6 this ordinary drag would have dashed.
    s.move(220, 500, 100);
    s.move(240, 500, 200);
    expect(s.takeFlick()).toBeNull();
    // A real flick: 90 px in 60 ms, twice.
    s.move(330, 500, 260);
    s.move(420, 500, 320);
    expect(s.takeFlick()).not.toBeNull();
  });
});

describe("touch: ability button modes and the cancel band", () => {
  it("a short drag aims; the cancel-home rule only ARMS once you leave", () => {
    const b = new AbilityButton();
    b.aimThrow = 109;
    b.down(1000, 700);
    b.move(1000, 681); // 19px: past the slop, inside the 37px cancel radius
    expect(b.state).toBe("aiming");
    const rel = b.up();
    expect(rel.kind).toBe("aimed");
  });

  it("the CANCEL BAND cancels wherever the finger is", () => {
    const b = new AbilityButton();
    b.cancelBand = { x: 400, y: 300, w: 200, h: 60 };
    b.down(1000, 700);
    b.move(900, 600);
    expect(b.state).toBe("aiming");
    b.move(500, 330);
    expect(b.inCancel).toBe(true);
    expect(b.up()).toEqual({ kind: "cancel" });
    // ...and leaving the band re-arms the cast.
    const b2 = new AbilityButton();
    b2.cancelBand = { x: 400, y: 300, w: 200, h: 60 };
    b2.down(1000, 700);
    b2.move(500, 330);
    b2.move(900, 600);
    expect(b2.up().kind).toBe("aimed");
  });

  it("aim-only refuses a tap; tap fires on touchdown", () => {
    const only = new AbilityButton();
    only.mode = "aim-only";
    expect(only.down(10, 10)).toBe(false);
    expect(only.up()).toEqual({ kind: "cancel" });

    const now = new AbilityButton();
    now.mode = "tap";
    expect(now.down(10, 10)).toBe(true);
  });

  it("the drag fraction is 1.0 at one AIM THROW and over-throw is free", () => {
    const b = new AbilityButton();
    b.aimThrow = 80;
    b.down(0, 0);
    b.move(40, 0);
    expect(b.aimFrac).toBeCloseTo(0.5);
    b.move(200, 0);
    expect(b.aimFrac).toBe(1);
  });

  it("an interruption is refund-identical to a cancel-band exit", () => {
    const b = new AbilityButton();
    b.down(1000, 700);
    b.move(900, 600);
    expect(b.interrupt()).toEqual({ kind: "cancel" });
    expect(b.state).toBe("idle");
  });
});

describe("touch: haptics", () => {
  it("maps events to patterns, rate-limits, and respects the level", () => {
    const fired: (number | number[])[] = [];
    let t = 0;
    const h = new Haptics((p) => fired.push(p), () => t);
    expect(h.fire("press")).toBe(true);
    expect(h.fire("cast")).toBe(false); // inside the 60ms window
    t = 100;
    expect(h.fire("cast")).toBe(true);
    expect(fired).toEqual([8, 14]);

    t = 1000;
    h.level = "light";
    expect(h.fire("kill")).toBe(false); // not a control acknowledgement
    expect(h.fire("cancel")).toBe(true);

    t = 2000;
    h.level = "off";
    expect(h.fire("press")).toBe(false);
  });

  it("degrades to nothing where vibrate does not exist (iOS Safari)", () => {
    const h = new Haptics(null);
    expect(h.supported).toBe(false);
    expect(h.fire("press")).toBe(false);
  });
});