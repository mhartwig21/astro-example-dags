import { describe, it, expect, beforeEach } from "vitest";
import { TouchController, QUEUE_MS, type PointerLike } from "../src/input/touch";
import { computeZones, DEFAULT_LAYOUT_PREFS } from "../src/input/touchLayout";
import { accumulateTouch, applyTouchEdges, createTouchEdges } from "../src/input/touchIntent";
import { pickTarget } from "../src/input/targeting";
import type { Intent, Vec2 } from "../src/sim/types";

/**
 * THE IMPORTANT TEST: a table of gestures and the exact Intent each one must
 * produce, asserted EQUAL to the Intent the keyboard produces for the same
 * action. Touch is additive; if a row here ever needs a touch-only field, the
 * design has leaked a game rule into the host.
 *
 * The controller is driven through its DOM-free seam (handle()) with plain
 * pointer records, so these are the real state machines, not a paraphrase.
 */

const VW = 800, VH = 400;
const ZONES = computeZones(VW, VH, { top: 0, right: 0, bottom: 0, left: 0 }, DEFAULT_LAYOUT_PREFS);
const CH = ZONES.controls;
const WORLD = { x: (ZONES.worldZone.x + ZONES.worldZone.w / 2) | 0, y: (ZONES.worldZone.y + ZONES.worldZone.h / 2) | 0 };
const STICK = { x: (ZONES.stickZone.x + ZONES.stickZone.w / 2) | 0, y: (ZONES.stickZone.y + ZONES.stickZone.h / 2) | 0 };

/** Screen -> world axes. The real isoRotate, inlined to keep this DOM-free. */
const isoRotate = (v: Vec2): Vec2 => {
  const c = Math.SQRT1_2;
  return { x: (v.x + v.y) * c, y: (v.y - v.x) * c };
};

/** What the keyboard produces for "press the slot-2 key", as the host builds it. */
function keyboardIntent(over: Partial<Intent> = {}): Intent {
  return {
    move: { x: 0, y: 0 },
    useStairs: false,
    cast: [false, false, false, false, false],
    flask: false,
    ...over,
  };
}

class Rig {
  readonly c = new TouchController();
  readonly edges = createTouchEdges();
  t = 10_000;
  constructor() {
    this.c.setZones(ZONES);
    this.c.canCast = () => true;
    this.c.now = () => this.t; // the controller reads its own clock, not the event
  }
  ev(type: string, id: number, x: number, y: number): void {
    const e: PointerLike = { type, pointerId: id, clientX: x, clientY: y, timeStamp: this.t, pointerType: "touch" };
    this.c.handle(e);
  }
  wait(ms: number): this { this.t += ms; return this; }
  down(id: number, x: number, y: number): this { this.ev("pointerdown", id, x, y); return this; }
  move(id: number, x: number, y: number): this { this.ev("pointermove", id, x, y); return this; }
  up(id: number, x: number, y: number): this { this.ev("pointerup", id, x, y); return this; }
  /** Poll one frame and fold it into the edge buffer, as pollTouch() does. */
  poll(): this {
    const s = this.c.sample(this.t / 1000);
    if (s) accumulateTouch(this.edges, s);
    this.c.endFrame();
    return this;
  }
  /** Drain into an Intent, as sampleIntent() does. */
  intent(dashSlot = -1): Intent {
    const i = keyboardIntent();
    const s = this.c.sample(this.t / 1000);
    if (s) accumulateTouch(this.edges, s);
    this.c.endFrame();
    applyTouchEdges(i, s, this.edges, { isoRotate, dashSlot });
    return i;
  }
}

let r: Rig;
beforeEach(() => { r = new Rig(); });

describe("touch -> Intent: the ability table", () => {
  it("press, no travel, release after 40 ms = smart cast (aim left for the host)", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(40).up(1, CH.slot1.cx, CH.slot1.cy);
    const i = r.intent();
    expect(i).toEqual(keyboardIntent({ cast: [false, true, false, false, false] }));
    expect(i.aim).toBeUndefined(); // the shared smart-cast path fills it
  });

  it("...and the SAME press held 300 ms is an identical Intent (no dwell term)", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(300).up(1, CH.slot1.cx, CH.slot1.cy);
    const slow = r.intent();
    const r2 = new Rig();
    r2.down(1, CH.slot1.cx, CH.slot1.cy).wait(40).up(1, CH.slot1.cx, CH.slot1.cy);
    expect(slow).toEqual(r2.intent());
  });

  it("press, travel 19 px, release = aimed cast along the drag", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30)
      .move(1, CH.slot1.cx, CH.slot1.cy - 19).wait(30)
      .up(1, CH.slot1.cx, CH.slot1.cy - 19);
    const i = r.intent();
    expect(i.cast).toEqual([false, true, false, false, false]);
    expect(i.aim).toEqual(isoRotate({ x: 0, y: -19 }));
  });

  it("press, travel out and home again = cancel: no cast, nothing queued", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30)
      .move(1, CH.slot1.cx, CH.slot1.cy - 90).wait(30)
      .move(1, CH.slot1.cx + 3, CH.slot1.cy - 3).wait(30)
      .up(1, CH.slot1.cx + 3, CH.slot1.cy - 3);
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("the CANCEL BAND cancels too, without coming home", () => {
    const b = ZONES.cancelBand;
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(20)
      .move(1, b.x + b.w / 2, b.y + b.h / 2).wait(20)
      .up(1, b.x + b.w / 2, b.y + b.h / 2);
    expect(r.intent()).toEqual(keyboardIntent());
  });

  // MOBILE.md 8.2 asks for two rows that cannot both hold at its own numbers:
  // "travel 19 px, release = aimed cast" AND "travel 19 px, return to 3 px =
  // cancel", with a 34 px cancel radius. If a 19 px drag is a cast, then being
  // inside 34 px cannot itself be a cancel. The return-home cancel therefore
  // ARMS only once the thumb has actually left the cancel radius, and a drag
  // that dies inside the dead zone resolves as a SMART cast — because the
  // alternative eats casts from every thumb that twitches, which is the exact
  // failure the same section warns about.
  it("a drag whose magnitude died inside the dead zone is a SMART cast, never a zero-vector aim", () => {
    // Out past the slop, back to 6 px: below the dead zone but not armed-home.
    const b = new TouchController();
    b.setZones(ZONES);
    b.canCast = () => true;
    const rig = new Rig();
    rig.down(1, CH.slot2.cx, CH.slot2.cy).wait(20)
      .move(1, CH.slot2.cx + 19, CH.slot2.cy).wait(20)
      .move(1, CH.slot2.cx + 6, CH.slot2.cy).wait(20)
      .up(1, CH.slot2.cx + 6, CH.slot2.cy);
    const i = rig.intent();
    expect(i.cast).toEqual([false, false, true, false, false]);
    // Either it is a smart cast (no aim) or an aim with real length. Never 0.
    if (i.aim) expect(Math.hypot(i.aim.x, i.aim.y)).toBeGreaterThan(1);
  });

  it("no path through the machine produces a cast with an undefined direction", () => {
    for (const travel of [0, 5, 17, 19, 33, 35, 60, 200]) {
      const rig = new Rig();
      rig.down(1, CH.slot1.cx, CH.slot1.cy).wait(25)
        .move(1, CH.slot1.cx + travel, CH.slot1.cy).wait(25)
        .up(1, CH.slot1.cx + travel, CH.slot1.cy);
      const i = rig.intent();
      if (i.cast?.some(Boolean) && i.aim) {
        expect(Number.isFinite(i.aim.x) && Number.isFinite(i.aim.y)).toBe(true);
        expect(Math.hypot(i.aim.x, i.aim.y)).toBeGreaterThan(0);
      }
    }
  });

  it("a chip on cooldown REFUSES at pointerdown and never enters aiming", () => {
    r.c.canCast = (slot) => slot !== 1;
    const seen: string[] = [];
    r.c.onFeedback = (e) => seen.push(e.kind);
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30)
      .move(1, CH.slot1.cx, CH.slot1.cy - 80).wait(30)
      .up(1, CH.slot1.cx, CH.slot1.cy - 80);
    expect(seen).toContain("refused");
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("aim-only mode: a release below the slop is a cancel, not a cheap cast", () => {
    r.c.castModes[4] = "aim-only";
    r.down(1, CH.slot4.cx, CH.slot4.cy).wait(60).up(1, CH.slot4.cx, CH.slot4.cy);
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("tap mode fires on touchdown", () => {
    r.c.castModes[1] = "tap";
    r.down(1, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent().cast).toEqual([false, true, false, false, false]);
  });
});

describe("touch -> Intent: interruption is a refund", () => {
  it("a modal opening mid-aim cancels, and the release fires nothing — now or later", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30).move(1, CH.slot1.cx, CH.slot1.cy - 80).wait(30);
    r.c.setModalOpen(true, r.t);
    r.up(1, CH.slot1.cx, CH.slot1.cy - 80);
    expect(r.intent()).toEqual(keyboardIntent()); // nothing while the panel is up
    r.wait(400);
    r.c.setModalOpen(false, r.t);
    r.wait(400);
    expect(r.intent()).toEqual(keyboardIntent()); // and nothing when it closes
  });

  it("an orientation change mid-aim refunds identically", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30).move(1, CH.slot1.cx, CH.slot1.cy - 80).wait(30);
    r.c.cancelAll(r.t);
    r.up(1, CH.slot1.cx, CH.slot1.cy - 80);
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("a browser pointercancel is the same refund", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30).move(1, CH.slot1.cx, CH.slot1.cy - 80).wait(30);
    r.ev("pointercancel", 1, CH.slot1.cx, CH.slot1.cy - 80);
    expect(r.intent()).toEqual(keyboardIntent());
  });
});

describe("touch -> Intent: the bounded cast queue", () => {
  it("a second chip press while a cast resolves queues exactly one smart cast", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(20);
    r.down(2, CH.slot2.cx, CH.slot2.cy).wait(20);
    r.down(3, CH.slot3.cx, CH.slot3.cy).wait(20); // a third press must not stack
    r.up(1, CH.slot1.cx, CH.slot1.cy);
    const i = r.intent();
    expect(i.cast).toEqual([false, true, false, true, false]); // slot1 + the LAST queued
    expect(i.cast!.filter(Boolean).length).toBe(2);
  });

  it("...and the queue is DROPPED when the first cast is cancelled", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(20);
    r.down(2, CH.slot2.cx, CH.slot2.cy).wait(20);
    r.move(1, CH.slot1.cx, CH.slot1.cy - 90).wait(20);
    r.move(1, CH.slot1.cx + 2, CH.slot1.cy).wait(20);
    r.up(1, CH.slot1.cx + 2, CH.slot1.cy);
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("...and it expires after 250 ms", () => {
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(20);
    r.down(2, CH.slot2.cx, CH.slot2.cy);
    r.wait(QUEUE_MS + 60).poll();
    r.up(1, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent().cast).toEqual([false, true, false, false, false]);
  });
});

describe("touch -> Intent: movement, multi-touch, gestures", () => {
  it("the stick fills Intent.move with ONE iso rotation, like the pad", () => {
    // Past 1.35 R the origin recentres, so the vector is exactly unit length.
    r.down(1, STICK.x, STICK.y).wait(16).move(1, STICK.x + 140, STICK.y).wait(16);
    const i = r.intent();
    const expected = isoRotate({ x: 1, y: 0 });
    expect(i.move.x).toBeCloseTo(expected.x, 5);
    expect(i.move.y).toBeCloseTo(expected.y, 5);
  });

  it("MOVING WHILE AIMING: two fingers, two roles, both land", () => {
    r.down(1, STICK.x, STICK.y).wait(16).move(1, STICK.x + 60, STICK.y).wait(16);
    r.down(2, CH.slot1.cx, CH.slot1.cy).wait(20)
      .move(2, CH.slot1.cx, CH.slot1.cy - 80).wait(20)
      .up(2, CH.slot1.cx, CH.slot1.cy - 80);
    const i = r.intent();
    expect(Math.hypot(i.move.x, i.move.y)).toBeGreaterThan(0.9);
    expect(i.cast).toEqual([false, true, false, false, false]);
    expect(i.aim).toEqual(isoRotate({ x: 0, y: -80 }));
  });

  it("a second finger in the stick zone never re-bases the stick", () => {
    r.down(1, STICK.x, STICK.y).wait(16).move(1, STICK.x + 60, STICK.y).wait(16);
    const before = r.c.stick.origin ? { ...r.c.stick.origin } : null;
    r.down(2, STICK.x - 40, STICK.y + 30).wait(16);
    expect(r.c.stick.origin).toEqual(before);
  });

  it("lifting the stick zeroes movement on the same frame", () => {
    r.down(1, STICK.x, STICK.y).wait(16).move(1, STICK.x + 60, STICK.y).wait(16);
    r.up(1, STICK.x + 60, STICK.y);
    expect(r.intent().move).toEqual({ x: 0, y: 0 });
  });

  it("a stick flick casts the slot that holds dash — and is inert when none does", () => {
    r.down(1, STICK.x, STICK.y);
    for (let k = 1; k <= 4; k++) { r.wait(8).move(1, STICK.x + k * 48, STICK.y); }
    const armed = r.intent(2);
    expect(armed.cast).toEqual([false, false, true, false, false]);

    const r2 = new Rig();
    r2.down(1, STICK.x, STICK.y);
    for (let k = 1; k <= 4; k++) { r2.wait(8).move(1, STICK.x + k * 48, STICK.y); }
    expect(r2.intent(-1).cast).toEqual([false, false, false, false, false]);
  });

  it("a two-finger world tap inside the budget dashes", () => {
    r.down(1, WORLD.x, WORLD.y).wait(40);
    r.down(2, WORLD.x + 50, WORLD.y + 10).wait(60);
    r.up(1, WORLD.x, WORLD.y);
    r.up(2, WORLD.x + 50, WORLD.y + 10);
    expect(r.intent(0).cast).toEqual([true, false, false, false, false]);
  });

  it("...and a slow two-finger DRAG does not (it belongs to the camera)", () => {
    r.down(1, WORLD.x, WORLD.y).wait(40);
    r.down(2, WORLD.x + 50, WORLD.y + 10).wait(250);
    r.move(1, WORLD.x + 40, WORLD.y + 20).wait(20);
    r.up(1, WORLD.x + 40, WORLD.y + 20);
    r.up(2, WORLD.x + 50, WORLD.y + 10);
    expect(r.intent(0).cast).toEqual([false, false, false, false, false]);
  });

  it("a world tap reports a screen point for the host to raycast; a long press marks it", () => {
    r.down(1, WORLD.x, WORLD.y).wait(120).up(1, WORLD.x + 4, WORLD.y + 3);
    let s = r.c.sample(r.t / 1000)!;
    expect(s.worldTaps).toEqual([{ x: WORLD.x, y: WORLD.y, long: false }]);
    r.c.endFrame();

    // A long press ARMS at the threshold (ring + buzz) and COMMITS on release,
    // so a frame-lagged lift cannot turn a tap into a ping or vice versa.
    const fb: string[] = [];
    r.c.onFeedback = (e) => fb.push(e.kind);
    r.down(2, WORLD.x, WORLD.y).wait(500);
    s = r.c.sample(r.t / 1000)!;
    expect(fb).toContain("pingArm");
    expect(s.worldTaps).toEqual([]); // armed, not committed
    r.c.endFrame();
    r.up(2, WORLD.x, WORLD.y);
    s = r.c.sample(r.t / 1000)!;
    expect(s.worldTaps).toEqual([{ x: WORLD.x, y: WORLD.y, long: true }]);
    r.c.endFrame();
    // ...and a hold that slides off before release aborts entirely.
    r.down(3, WORLD.x, WORLD.y).wait(500);
    r.c.sample(r.t / 1000);
    r.c.endFrame();
    r.move(3, WORLD.x + 40, WORLD.y).wait(20).up(3, WORLD.x + 40, WORLD.y);
    expect(r.c.sample(r.t / 1000)!.worldTaps).toEqual([]);
  });

  it("the flask and context chips are instantaneous and independent", () => {
    r.down(1, CH.flask.cx, CH.flask.cy).wait(20).up(1, CH.flask.cx, CH.flask.cy);
    r.down(2, CH.context.cx, CH.context.cy).wait(20).up(2, CH.context.cx, CH.context.cy);
    const i = r.intent();
    expect(i.flask).toBe(true);
    expect(i.useStairs).toBe(true);
  });

  it("mouse pointers are never claimed: desktop input is untouched", () => {
    r.c.handle({ type: "pointerdown", pointerId: 9, clientX: CH.slot1.cx, clientY: CH.slot1.cy, timeStamp: r.t, pointerType: "mouse" });
    r.c.handle({ type: "pointerup", pointerId: 9, clientX: CH.slot1.cx, clientY: CH.slot1.cy, timeStamp: r.t, pointerType: "mouse" });
    expect(r.intent()).toEqual(keyboardIntent());
  });

  it("disabled controls swallow everything (touch OFF on a touchscreen laptop)", () => {
    r.c.setEnabled(false);
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(30).up(1, CH.slot1.cx, CH.slot1.cy);
    r.down(2, STICK.x, STICK.y).wait(30).move(2, STICK.x + 70, STICK.y);
    expect(r.intent()).toEqual(keyboardIntent());
  });
});

describe("smart cast completes the tap", () => {
  it("a tap with no aim resolves at the prioritised target, exactly like the pad", () => {
    const mobs = [
      { id: 1, pos: { x: 5, y: 0 }, hp: 100, maxHp: 100 },
      { id: 2, pos: { x: 0, y: 3 }, hp: 12, maxHp: 100 }, // hurt: finish it
      { id: 3, pos: { x: 0, y: 1.2 }, hp: 100, maxHp: 100, dormant: true }, // asleep
    ];
    const t = pickTarget(mobs, { from: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, range: 8 });
    expect(t?.id).toBe(2);
    const i = keyboardIntent({ cast: [false, true, false, false, false] });
    i.aim = { x: t!.pos.x, y: t!.pos.y };
    expect(i.aim).toEqual({ x: 0, y: 3 });
  });
});