import { describe, it, expect, beforeEach } from "vitest";
import {
  AbilityButton, TouchController, MODAL_GATE_MS, POINTER_TTL, QUEUE_MS,
  type PointerLike,
} from "../src/input/touch";
import { computeZones, DEFAULT_LAYOUT_PREFS } from "../src/input/touchLayout";
import { aimPlacement, isPlacedShape, type AimSpec } from "../src/input/aimSpec";
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
/**
 * A patch of world zone with no chip on it.
 *
 * The world zone now runs to the safe edge, UNDERNEATH the cluster (chips are
 * evaluated first in §2.10, and their padded hit rects leave no tappable
 * interior), so its centre is a chip. The inboard edge is the honest place to
 * drive a world gesture from — and driving one from a covered point is how an
 * earlier round's multi-touch check spent weeks intermittently measuring §1.2.
 */
const WORLD = { x: (ZONES.worldZone.x + 40) | 0, y: (ZONES.worldZone.y + ZONES.worldZone.h / 2) | 0 };
const WORLD2 = { x: WORLD.x + 46, y: WORLD.y - 60 }; // second finger, also clear
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
    r.down(2, WORLD2.x, WORLD2.y).wait(60);
    r.up(1, WORLD.x, WORLD.y);
    r.up(2, WORLD2.x, WORLD2.y);
    expect(r.intent(0).cast).toEqual([true, false, false, false, false]);
  });

  it("...and a slow two-finger DRAG does not (it belongs to the camera)", () => {
    r.down(1, WORLD.x, WORLD.y).wait(40);
    r.down(2, WORLD2.x, WORLD2.y).wait(250);
    r.move(1, WORLD.x + 40, WORLD.y + 20).wait(20);
    r.up(1, WORLD.x + 40, WORLD.y + 20);
    r.up(2, WORLD2.x, WORLD2.y);
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
/**
 * 2.4a — THE TAP/AIM DECISION. Travel only, from a leaky origin.
 *
 * The rejected rule promoted to AIMING on `dwell > 90 ms`, and there is no
 * human population whose taps fit under that ceiling: Android has no maximum
 * tap duration at all, UIKit's tap recogniser has no duration limit, and the
 * accessibility literature puts the workable tap/press separation at
 * 500-1000 ms with some users needing over a second. A 90 ms ceiling put the
 * MEDIAN deliberate tap into AIMING with a drag vector of a few pixels.
 *
 * Deleting dwell was necessary and not sufficient: a stationary thumb's
 * contact centroid creeps 1-4 mm (6-24 CSS px) over 300-800 ms as the pad
 * flattens, so travel alone still misreads a long hold. Hence the leak.
 */
describe("2.4a: the tap/aim threshold is travel from a LEAKY origin", () => {
  /** Drive a finger at a constant speed and report when (ms) it promotes. */
  function promoteAt(pxPerSec: number, forMs = 3000, stepMs = 16): number | null {
    const rig = new Rig();
    rig.down(1, CH.slot1.cx, CH.slot1.cy);
    for (let t = stepMs; t <= forMs; t += stepMs) {
      rig.wait(stepMs).move(1, CH.slot1.cx + (pxPerSec * t) / 1000, CH.slot1.cy);
      if (rig.c.sample(rig.t / 1000)!.aimingSlot >= 0) return t;
      rig.c.endFrame();
    }
    return null;
  }

  it("12 px/s of centroid creep NEVER promotes, at any duration", () => {
    expect(promoteAt(12, 5000)).toBeNull();
  });

  it("30 px/s of drift (a shaking hand, a bus) NEVER promotes over 3 s", () => {
    expect(promoteAt(30, 3000)).toBeNull();
  });

  it("a deliberate slow aim at 100 px/s promotes at 18/(100-40) = 300 ms", () => {
    const t = promoteAt(100)!;
    expect(t).toBeGreaterThan(240);
    expect(t).toBeLessThan(370);
  });

  it("an ordinary 300 px/s drag promotes at ~69 ms, a 900 px/s flick at ~21 ms", () => {
    const slow = promoteAt(300, 1000, 8)!;
    const fast = promoteAt(900, 1000, 4)!;
    expect(slow).toBeGreaterThan(40);
    expect(slow).toBeLessThan(110);
    expect(fast).toBeLessThan(40);
    expect(fast).toBeLessThan(slow);
  });

  it("a 40 ms tap and a 3 s hold produce a BYTE-IDENTICAL Intent", () => {
    const quick = new Rig();
    quick.down(1, CH.slot1.cx, CH.slot1.cy).wait(40).up(1, CH.slot1.cx, CH.slot1.cy);
    const held = new Rig();
    held.down(1, CH.slot1.cx, CH.slot1.cy);
    // Three seconds of holding still, polled every frame, with 0.5 px/frame of
    // contact creep — 31 px/s of raw centroid wander, which is a real thumb.
    let drift = 0;
    for (let t = 16; t <= 3000; t += 16) {
      drift += 0.5;
      held.wait(16).move(1, CH.slot1.cx + drift, CH.slot1.cy).poll();
    }
    held.up(1, CH.slot1.cx + drift, CH.slot1.cy);
    expect(held.intent()).toEqual(quick.intent()); // equality, not similarity
  });

  it("the origin FREEZES on promotion: the aim is measured from one point", () => {
    // Promote fast, then hold the finger still for a second. A leaky origin
    // that kept leaking would walk the aim vector to zero.
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(8).move(1, CH.slot1.cx, CH.slot1.cy - 60);
    for (let k = 0; k < 60; k++) r.wait(16).move(1, CH.slot1.cx, CH.slot1.cy - 60).poll();
    r.up(1, CH.slot1.cx, CH.slot1.cy - 60);
    expect(r.intent().aim).toEqual(isoRotate({ x: 0, y: -60 }));
  });
});

/**
 * 2.5a — WORLD TAP vs LONG PRESS. One threshold, not two.
 *
 * The old pair left the 200-450 ms band assigned to NOTHING, which is exactly
 * the band a deliberate tap under combat load lands in, and the failure mode
 * is the worst available: the finger lifts and the game does not respond.
 */
describe("2.5a: the world recogniser has no dead band", () => {
  const durations = [40, 120, 199, 200, 250, 300, 380, 449, 450, 700, 2000];

  it("every pointerup inside 16 px produces exactly one Intent, never silence", () => {
    for (const ms of durations) {
      const rig = new Rig();
      rig.down(1, WORLD.x, WORLD.y).wait(ms);
      rig.poll(); // let the ping arm if it is going to
      rig.up(1, WORLD.x + 3, WORLD.y + 2);
      const taps = rig.c.sample(rig.t / 1000)!.worldTaps;
      expect(taps.length, `${ms} ms produced ${taps.length} taps`).toBe(1);
      expect(taps[0].long, `${ms} ms verdict`).toBe(ms >= 450);
    }
  });

  it("the old 200-450 ms hole is a MOVE order at every point in it", () => {
    for (const ms of [200, 260, 330, 400, 449]) {
      const rig = new Rig();
      rig.down(1, WORLD.x, WORLD.y).wait(ms).poll().up(1, WORLD.x, WORLD.y);
      expect(rig.c.sample(rig.t / 1000)!.worldTaps)
        .toEqual([{ x: WORLD.x, y: WORLD.y, long: false }]);
    }
  });

  it("the boundary is announced BEFORE it is crossed, and can still be aborted", () => {
    const fb: string[] = [];
    r.c.onFeedback = (e) => fb.push(e.kind);
    r.down(1, WORLD.x, WORLD.y).wait(500);
    r.c.sample(r.t / 1000);
    r.c.endFrame();
    expect(fb).toContain("pingArm"); // ring + haptic, before the lift
    r.move(1, WORLD.x + 40, WORLD.y).wait(20).up(1, WORLD.x + 40, WORLD.y);
    expect(r.c.sample(r.t / 1000)!.worldTaps).toEqual([]); // slid off: aborts BOTH
  });

  it("travel past 16 px hands the gesture to the camera at any duration", () => {
    for (const ms of [60, 300, 900]) {
      const rig = new Rig();
      rig.down(1, WORLD.x, WORLD.y).wait(ms / 2)
        .move(1, WORLD.x + 40, WORLD.y).wait(ms / 2).up(1, WORLD.x + 40, WORLD.y);
      expect(rig.c.sample(rig.t / 1000)!.worldTaps).toEqual([]);
    }
  });
});

/**
 * 2.9a — THE INPUT AUTHORITY. Refcounted, eight reasons, one refund path.
 */
describe("2.9a: refcounted suspend authority", () => {
  const aiming = (rig: Rig): void => {
    rig.down(1, CH.slot1.cx, CH.slot1.cy).wait(30)
      .move(1, CH.slot1.cx, CH.slot1.cy - 80).wait(30);
  };

  it("raising ANY reason refunds the live gesture; the lift fires nothing", () => {
    for (const reason of ["modal", "sheet", "rotate-gate", "orientation", "hidden",
      "not-playing", "editor", "system-gesture"] as const) {
      const rig = new Rig();
      aiming(rig);
      rig.c.suspend(reason, rig.t);
      rig.up(1, CH.slot1.cx, CH.slot1.cy - 80);
      expect(rig.intent(), reason).toEqual(keyboardIntent());
      rig.wait(400);
      rig.c.resume(reason, rig.t);
      rig.wait(400);
      expect(rig.intent(), `${reason} after close`).toEqual(keyboardIntent());
    }
  });

  it("TWO overlapping reasons resume only when BOTH are gone (draft over safe room)", () => {
    r.c.suspend("modal", r.t);       // the safe room
    r.c.suspend("not-playing", r.t); // the sponsor draft freezes the sim
    r.wait(50);
    r.c.resume("modal", r.t);        // the safe room closes first
    r.wait(MODAL_GATE_MS + 50);
    expect(r.c.suspended).toBe(true);
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(40).up(1, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent()).toEqual(keyboardIntent()); // a boolean would have cast here
    r.c.resume("not-playing", r.t);
    r.wait(MODAL_GATE_MS + 50);
    expect(r.c.suspended).toBe(false);
    r.down(2, CH.slot1.cx, CH.slot1.cy).wait(40).up(2, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent().cast).toEqual([false, true, false, false, false]);
  });

  it("suspend is idempotent per reason: a double raise needs one release", () => {
    r.c.suspend("modal", r.t);
    r.c.suspend("modal", r.t);
    r.c.resume("modal", r.t);
    expect(r.c.suspended).toBe(false);
    expect(r.c.suspendReasons()).toEqual([]);
  });

  it("clearing the LAST reason opens a 120 ms deaf frame", () => {
    r.c.suspend("modal", r.t);
    r.c.resume("modal", r.t);
    r.wait(MODAL_GATE_MS - 20);
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(20).up(1, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent()).toEqual(keyboardIntent()); // the press that closed it
    r.wait(MODAL_GATE_MS + 20);
    r.down(2, CH.slot1.cx, CH.slot1.cy).wait(20).up(2, CH.slot1.cx, CH.slot1.cy);
    expect(r.intent().cast).toEqual([false, true, false, false, false]);
  });

  it("the 8 s reaper releases a pointer the platform never lifted", () => {
    // A held basic attack, then the app is backgrounded: iOS Safari fires no
    // pointercancel at all and the finger simply stops existing.
    r.down(1, CH.slot0.cx, CH.slot0.cy).wait(50);
    expect(r.intent().cast?.[0]).toBe(true);
    r.wait(POINTER_TTL + 100);
    expect(r.intent().cast?.[0]).toBe(false);
    // ...and the movement stick is not left pushed either.
    const rig = new Rig();
    rig.down(1, STICK.x, STICK.y).wait(16).move(1, STICK.x + 90, STICK.y).wait(16);
    expect(Math.hypot(rig.intent().move.x, rig.intent().move.y)).toBeGreaterThan(0.5);
    rig.wait(POINTER_TTL + 100);
    expect(rig.intent().move).toEqual({ x: 0, y: 0 });
  });

  it("hit-stop is NOT a suspend reason: a press during a frozen sim looks alive", () => {
    // The host does not call suspend() for a sim freeze; edges accumulate and
    // land when the world thaws, which is what accumulateTouch() is for.
    r.down(1, CH.slot1.cx, CH.slot1.cy).wait(40).up(1, CH.slot1.cx, CH.slot1.cy);
    r.poll(); r.poll(); r.poll(); // three frames of frozen sim
    expect(r.intent().cast).toEqual([false, true, false, false, false]);
  });
});

/**
 * 2.4b — WHAT THE DRAG'S LENGTH MEANS, AND WHERE IT MEANS NOTHING.
 */
describe("2.4b: the aim throw is its own quantity", () => {
  it("the throw scales with buttonScale and is deaf to stickScale", () => {
    const base = computeZones(800, 400, { top: 0, right: 0, bottom: 0, left: 0 },
      DEFAULT_LAYOUT_PREFS);
    const bigStick = computeZones(800, 400, { top: 0, right: 0, bottom: 0, left: 0 },
      { ...DEFAULT_LAYOUT_PREFS, stickScale: 1.4 });
    const bigButtons = computeZones(800, 400, { top: 0, right: 0, bottom: 0, left: 0 },
      { ...DEFAULT_LAYOUT_PREFS, buttonScale: 1.4 });
    expect(bigStick.aimThrow).toBeCloseTo(base.aimThrow, 6);
    expect(bigStick.stickRadius).toBeGreaterThan(base.stickRadius);
    expect(bigButtons.aimThrow).toBeGreaterThan(base.aimThrow);
  });

  it("over-throw is free: any drag past the throw is frac 1.0", () => {
    const b = new AbilityButton();
    b.aimThrow = 109;
    b.down(0, 0, 0);
    b.move(54.5, 0, 100);
    expect(b.aimFrac).toBeCloseTo(0.5, 2);
    b.move(400, 0, 200);
    expect(b.aimFrac).toBe(1);
    b.move(4000, 0, 300);
    expect(b.aimFrac).toBe(1);
  });

  it("frac PLACES a ring/scatter/arrow and is IGNORED by line/cone/chain", () => {
    const ring: AimSpec = { shape: "ring", range: 0, radius: 6, arc: 0 };
    const line: AimSpec = { shape: "line", range: 14.4, radius: 0.25, arc: 0 };
    const cone: AimSpec = { shape: "cone", range: 2.4, radius: 2.4, arc: 0.7 };
    const chain: AimSpec = { shape: "chain", range: 8, radius: 0.5, arc: 0 };
    // The shortest committed drag still clears the crawler's own feet...
    expect(aimPlacement(ring, 0)).toBeCloseTo(0.15 * 6, 6);
    expect(aimPlacement(ring, 1)).toBeCloseTo(6, 6);
    expect(aimPlacement(ring, 0.5)).toBeCloseTo(0.575 * 6, 6);
    // ...and a bolt flies its full derived reach whatever the throw. Reading
    // `frac` for it would be a game rule invented in the input layer.
    for (const f of [0, 0.3, 1]) {
      expect(aimPlacement(line, f)).toBe(0);
      expect(aimPlacement(cone, f)).toBe(0);
      expect(aimPlacement(chain, f)).toBe(0);
    }
    expect(isPlacedShape("ring")).toBe(true);
    expect(isPlacedShape("scatter")).toBe(true);
    expect(isPlacedShape("arrow")).toBe(true);
    expect(isPlacedShape("line")).toBe(false);
  });

  it("equal thumb travel is equal world distance in every screen direction", () => {
    // isoRotate is a pure rotation, so a drag up-screen and a drag sideways of
    // the same length produce the same frac — the 2.5:1 iso foreshortening
    // (measured, §1.6) is in the PROJECTION, not in the mapping.
    const up = new AbilityButton(); up.aimThrow = 100; up.down(0, 0, 0); up.move(0, -50, 100);
    const side = new AbilityButton(); side.aimThrow = 100; side.down(0, 0, 0); side.move(50, 0, 100);
    expect(up.aimFrac).toBeCloseTo(side.aimFrac, 9);
    const a = isoRotate({ x: 0, y: -50 }), b = isoRotate({ x: 50, y: 0 });
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(Math.hypot(b.x, b.y), 9);
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(50, 9);
  });
});
