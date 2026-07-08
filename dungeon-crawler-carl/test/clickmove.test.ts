import { describe, expect, it } from "vitest";
import {
  ARRIVE_RADIUS, STALL_SECONDS, TAP_SECONDS,
  createClickMove, stepClickMove, type ClickMoveFrame,
} from "../src/input/clickMove";
const DT = 1 / 60;

function frame(over: Partial<ClickMoveFrame> = {}): ClickMoveFrame {
  return {
    playerPos: { x: 5, y: 5 },
    cursorWorld: { x: 10, y: 5 },
    lmbHeld: false,
    hoverMonster: false,
    keyboardMove: false,
    dt: DT,
    ...over,
  };
}

describe("click-to-move: tap autopilot", () => {
  it("a tap commits a walk-to target that persists after release", () => {
    const s = createClickMove();
    // press for 3 frames (a tap), release
    stepClickMove(s, frame({ lmbHeld: true }));
    stepClickMove(s, frame({ lmbHeld: true }));
    stepClickMove(s, frame({ lmbHeld: true }));
    const out = stepClickMove(s, frame()); // released
    expect(s.target).toEqual({ x: 10, y: 5 });
    expect(out.move).not.toBeNull();
    expect(out.move!.x).toBeCloseTo(1);
    expect(out.move!.y).toBeCloseTo(0);
  });

  it("arrival clears the target", () => {
    const s = createClickMove();
    stepClickMove(s, frame({ lmbHeld: true }));
    stepClickMove(s, frame()); // release -> tap
    const out = stepClickMove(s, frame({ playerPos: { x: 10 - ARRIVE_RADIUS / 2, y: 5 } }));
    expect(out.move).toBeNull();
    expect(s.target).toBeNull();
  });

  it("keyboard movement cancels the autopilot instantly", () => {
    const s = createClickMove();
    stepClickMove(s, frame({ lmbHeld: true }));
    stepClickMove(s, frame()); // tap committed
    const out = stepClickMove(s, frame({ keyboardMove: true }));
    expect(out.move).toBeNull();
    expect(s.target).toBeNull();
  });

  it("gives up on a target it stops progressing toward (wall stall)", () => {
    const s = createClickMove();
    stepClickMove(s, frame({ lmbHeld: true }));
    stepClickMove(s, frame()); // tap committed
    // Simulate being stuck: identical playerPos every step.
    const stuck = frame({ playerPos: { x: 5, y: 5 } });
    let out = stepClickMove(s, stuck);
    for (let t = 0; t < STALL_SECONDS + 0.1; t += DT) out = stepClickMove(s, stuck);
    expect(s.target).toBeNull();
    expect(out.move).toBeNull();
  });
});

describe("click-to-move: hold steering", () => {
  it("steers toward a moving cursor while held", () => {
    const s = createClickMove();
    stepClickMove(s, frame({ lmbHeld: true }));
    const out = stepClickMove(s, frame({ lmbHeld: true, cursorWorld: { x: 5, y: 12 } }));
    expect(out.move!.x).toBeCloseTo(0);
    expect(out.move!.y).toBeCloseTo(1);
  });

  it("releasing a long hold stops (no lingering target)", () => {
    const s = createClickMove();
    let held = frame({ lmbHeld: true });
    stepClickMove(s, held);
    for (let t = 0; t < TAP_SECONDS + 0.1; t += DT) stepClickMove(s, held);
    const out = stepClickMove(s, frame()); // release after a long steer
    expect(s.target).toBeNull();
    expect(out.move).toBeNull();
  });
});

describe("click-to-move: attacking", () => {
  it("a press on a monster attacks instead of moving, while held", () => {
    const s = createClickMove();
    const out1 = stepClickMove(s, frame({ lmbHeld: true, hoverMonster: true }));
    expect(out1.attack).toBe(true);
    expect(out1.move).toBeNull();
    const out2 = stepClickMove(s, frame({ lmbHeld: true })); // cursor slid off
    expect(out2.attack).toBe(true); // sticky while held
    const out3 = stepClickMove(s, frame()); // released
    expect(out3.attack).toBe(false);
    expect(s.target).toBeNull();
  });

  it("attacking does not disturb an off-map cursor or emit movement", () => {
    const s = createClickMove();
    const out = stepClickMove(s, frame({ lmbHeld: true, hoverMonster: true, cursorWorld: null }));
    expect(out.attack).toBe(true);
    expect(out.move).toBeNull();
  });
});

describe("click-to-move: determinism plumbing", () => {
  it("emits normalized directions (the sim normalizes again, but stay honest)", () => {
    const s = createClickMove();
    stepClickMove(s, frame({ lmbHeld: true, cursorWorld: { x: 9, y: 8 } }));
    const out = stepClickMove(s, frame({ lmbHeld: true, cursorWorld: { x: 9, y: 8 } }));
    const len = Math.hypot(out.move!.x, out.move!.y);
    expect(len).toBeCloseTo(1);
  });

  it("same input sequence, same outputs (pure state machine)", () => {
    const seq = [
      frame({ lmbHeld: true }),
      frame({ lmbHeld: true, cursorWorld: { x: 8, y: 9 } }),
      frame(),
      frame({ playerPos: { x: 6, y: 6 } }),
    ];
    const a = createClickMove();
    const b = createClickMove();
    const outsA = seq.map((f) => stepClickMove(a, { ...f }));
    const outsB = seq.map((f) => stepClickMove(b, { ...f }));
    expect(outsA).toEqual(outsB);
  });
});
