/**
 * OBJECTIVES (the tutorial rebuild, HANDOFF §3a): the pure guided-step
 * sequencer — facts in, edges out. These tests hold the doc's binding rules:
 * steps strictly sequential, item order free within a step, latches one-way,
 * completion fact-spent and never re-armed, mid-step progress per-run, the
 * S4 safe-room arm gate, floor-carry (no floor gate exists), and the skip
 * consuming everything.
 */
import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_STEPS, OBJ_STEP_IDS, Objectives, type ObjectiveFacts,
} from "../src/ui/objectives";

const NONE: ObjectiveFacts = {};
const S1_ALL: ObjectiveFacts = { moved: true, blood: true, kills3: true };

describe("the curriculum shape", () => {
  it("four steps, 2-3 checkable items each, ids on the obj.* ledger namespace", () => {
    expect(OBJECTIVE_STEPS.length).toBe(4);
    for (const s of OBJECTIVE_STEPS) {
      expect(s.id).toMatch(/^obj\./);
      expect(s.items.length).toBeGreaterThanOrEqual(2);
      expect(s.items.length).toBeLessThanOrEqual(3);
    }
    expect(OBJ_STEP_IDS).toEqual(["obj.move", "obj.five", "obj.payday", "obj.saferoom"]);
  });
});

describe("steps advance only on fact edges, strictly in order", () => {
  it("items check as their facts arrive, in any order within the step", () => {
    const o = new Objectives();
    expect(o.update({ kills3: true }).checked).toEqual(["kills3"]); // order free
    expect(o.update({ moved: true }).checked).toEqual(["moved"]);
    const last = o.update({ blood: true });
    expect(last.checked).toEqual(["blood"]);
    expect(last.completed).toBe("obj.move");
    expect(o.currentStep()?.id).toBe("obj.five");
  });

  it("a later step's facts do nothing until that step is current", () => {
    const o = new Objectives();
    // The player dashes and casts during S1 — S2 must not pre-check.
    o.update({ castA: true, castB: true, dash: true });
    expect(o.view()?.step.id).toBe("obj.move");
    expect(o.view()?.done.size).toBe(0);
  });

  it("a fact that flickers back to false un-checks nothing (one-way latch)", () => {
    const o = new Objectives();
    o.update({ moved: true });
    o.update({ moved: false });
    expect(o.view()?.done.has("moved")).toBe(true);
  });

  it("a whole step can complete in one call (all facts at once)", () => {
    const o = new Objectives();
    const res = o.update(S1_ALL);
    expect(res.started).toBe("obj.move");
    expect(res.completed).toBe("obj.move");
    expect(new Set(res.checked)).toEqual(new Set(["moved", "blood", "kills3"]));
  });
});

describe("the intro edge (started) fires once per session per step", () => {
  it("the first update introduces the step; later updates do not", () => {
    const o = new Objectives();
    expect(o.update(NONE).started).toBe("obj.move");
    expect(o.update(NONE).started).toBeNull();
    o.update(S1_ALL);
    expect(o.update(NONE).started).toBe("obj.five"); // the next step introduces itself
  });

  it("a run reset does not re-introduce a step already introduced", () => {
    const o = new Objectives();
    o.update({ moved: true });
    o.resetRun();
    expect(o.update(NONE).started).toBeNull(); // same session, same step, no re-intro
  });
});

describe("completion is fact-spent: a completed step never returns", () => {
  it("ledger round-trip: seeded steps are done before the first update", () => {
    const o = new Objectives(["obj.move", "obj.five"]);
    expect(o.currentStep()?.id).toBe("obj.payday");
    // ...and unknown ledger keys (tut.*, sim tipIds) are ignored.
    const o2 = new Objectives(["tut.campfire", "collapse"]);
    expect(o2.currentStep()?.id).toBe("obj.move");
  });

  it("a completed step stays done across run resets", () => {
    const o = new Objectives();
    o.update(S1_ALL);
    o.resetRun();
    expect(o.currentStep()?.id).toBe("obj.five");
    expect(o.update(S1_ALL).completed).toBeNull(); // S1 facts cannot re-complete S1
  });

  it("all steps done => finished, and the sequencer goes inert", () => {
    const o = new Objectives([...OBJ_STEP_IDS]);
    expect(o.finished).toBe(true);
    expect(o.view()).toBeNull();
    expect(o.update(S1_ALL)).toEqual({ started: null, checked: [], completed: null });
  });
});

describe("mid-step progress is per-run; the curriculum is not", () => {
  it("resetRun clears item latches on the step in flight", () => {
    const o = new Objectives();
    o.update({ moved: true, blood: true });
    expect(o.view()?.done.size).toBe(2);
    o.resetRun();
    expect(o.view()?.done.size).toBe(0);
    // The items are re-earnable, and the step still completes.
    expect(o.update(S1_ALL).completed).toBe("obj.move");
  });
});

describe("S4's safe-room gate: armed by standing in one, this run", () => {
  const atS4 = (): Objectives => new Objectives(["obj.move", "obj.five", "obj.payday"]);

  it("before a safe room, the step is hidden and its items are inert", () => {
    const o = atS4();
    // Shop/spend/stairs facts true early (e.g. stale host state) do NOTHING.
    const res = o.update({ shop: true, spend: true, stairs: true });
    expect(res).toEqual({ started: null, checked: [], completed: null });
    expect(o.view()?.armed).toBe(false);
  });

  it("inSafeRoom arms it; the intro fires on the arming edge", () => {
    const o = atS4();
    o.update({ shop: true }); // not armed yet
    const res = o.update({ inSafeRoom: true, shop: true });
    expect(res.started).toBe("obj.saferoom");
    expect(res.checked).toEqual(["shop"]);
    expect(o.view()?.armed).toBe(true);
  });

  it("once armed it stays armed for the run, even after leaving the room", () => {
    const o = atS4();
    o.update({ inSafeRoom: true, shop: true, spend: true });
    // The stairs are taken AFTER leaving the safe room — still counts.
    const res = o.update({ inSafeRoom: false, stairs: true });
    expect(res.completed).toBe("obj.saferoom");
    expect(o.finished).toBe(true);
  });

  it("the arm latch is per-run: a death sends them back through a safe room", () => {
    const o = atS4();
    o.update({ inSafeRoom: true, shop: true });
    o.resetRun();
    expect(o.update({ shop: true, spend: true, stairs: true }))
      .toEqual({ started: null, checked: [], completed: null });
    expect(o.view()?.armed).toBe(false);
  });
});

describe("floor transitions carry a step forward (no floor gate exists)", () => {
  it("a step mid-flight keeps its progress across any number of floors", () => {
    // The module takes no floor input at all — this test documents that the
    // curriculum is the curriculum wherever the crawler is standing.
    const o = new Objectives();
    o.update({ moved: true }); // floor 1, say
    o.update({ blood: true }); // floor 2 now — nothing resets
    expect(o.update({ kills3: true }).completed).toBe("obj.move");
  });
});

describe("the skip consumes everything (a refusal is a delivery)", () => {
  it("skipAll marks every step done and returns every ledger key", () => {
    const o = new Objectives();
    o.update({ moved: true });
    const keys = o.skipAll();
    expect(new Set(keys)).toEqual(new Set(OBJ_STEP_IDS));
    expect(o.finished).toBe(true);
    expect(o.view()).toBeNull();
  });

  it("a persisted skip (ledger) suppresses the card on later sessions too", () => {
    const o = new Objectives(new Objectives().skipAll());
    expect(o.finished).toBe(true);
  });
});
