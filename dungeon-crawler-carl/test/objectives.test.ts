/**
 * OBJECTIVES (the tutorial rebuild, HANDOFF §3a): the pure guided-step
 * sequencer — facts in, edges out. These tests hold the doc's binding rules:
 * steps strictly sequential, item order free within a step, latches one-way,
 * completion fact-spent and never re-armed, mid-step progress per-run, the
 * S4 safe-room arm gate, floor-carry (no floor gate exists), and the skip
 * consuming everything.
 *
 * ...and, since r1, the rule the whole module exists to serve: A STEP MUST BE
 * TAUGHT BEFORE IT CAN BE SPENT. THE FIVE's facts are run-cumulative, so a
 * player who dashed once during their first fight had all three true the
 * instant obj.move finished; the old `update` armed, latched and completed in
 * ONE call, so the only step that teaches the ability kit key by key was
 * written to the ledger as spent without ever painting. Both gates below —
 * arm-and-return, and the OBJ_MIN_VISIBLE_MS dwell — are that bug's tests.
 */
import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_STEPS, OBJ_LABEL_TOKENS, OBJ_MIN_VISIBLE_MS, OBJ_STEP_IDS, Objectives,
  type ObjectiveFacts,
} from "../src/ui/objectives";

const NONE: ObjectiveFacts = {};
const S1_ALL: ObjectiveFacts = { moved: true, blood: true, kills3: true };

/** The host's side of the paint contract: the card was on the glass long
 *  enough to be read. Tests that want a step to COMPLETE must pay it. */
function dwell(o: Objectives): void {
  o.addVisibleMs(OBJ_MIN_VISIBLE_MS);
}

describe("the curriculum shape", () => {
  it("five steps, 2-3 checkable items each, ids on the obj.* ledger namespace", () => {
    expect(OBJECTIVE_STEPS.length).toBe(5);
    for (const s of OBJECTIVE_STEPS) {
      expect(s.id).toMatch(/^obj\./);
      expect(s.items.length).toBeGreaterThanOrEqual(2);
      expect(s.items.length).toBeLessThanOrEqual(3);
    }
    // Teaching order: controls first, economy second, identity last — THE
    // SHOW closes the spine because by then hype actually flows (floor 2+).
    expect(OBJ_STEP_IDS).toEqual(["obj.move", "obj.five", "obj.payday", "obj.saferoom", "obj.show"]);
  });

  it("every {token} in an item label is one the host knows how to substitute", () => {
    // The card obeys the coach's law (never name a bind the player cannot
    // use), so key-shaped words are all tokens — and an unknown token would
    // print literally on the glass.
    const known = new Set<string>(OBJ_LABEL_TOKENS);
    for (const s of OBJECTIVE_STEPS) {
      for (const it of s.items) {
        for (const lbl of [it.label, it.alt?.label ?? ""]) {
          for (const m of lbl.matchAll(/\{([^}]+)\}/g)) {
            expect(known.has(m[1]), `${s.id}/${it.id} token {${m[1]}}`).toBe(true);
          }
        }
      }
    }
    // ...and THE FIVE actually is key by key: all three items are keyed.
    const five = OBJECTIVE_STEPS.find((s) => s.id === "obj.five")!;
    for (const it of five.items) expect(it.label).toMatch(/\{(strike|dash|cast)\}/);
  });
});

describe("A STEP MUST PAINT BEFORE IT CAN COMPLETE (r1 blocker 1)", () => {
  it("update() with every fact already true arms and completes NOTHING on the first call", () => {
    // The exact THE FIVE failure: strike/dash/cast are run-cumulative facts,
    // so they are all true the moment the step becomes current.
    const o = new Objectives(["obj.move"]);
    const first = o.update({ strike: true, dash: true, cast: true });
    expect(first.started).toBe("obj.five");
    expect(first.checked).toEqual([]);
    expect(first.completed).toBeNull();
    // ...and the card is showing THE FIVE, with nothing struck through.
    expect(o.view()?.step.id).toBe("obj.five");
    expect(o.view()?.done.size).toBe(0);
  });

  it("the second call checks the items but still cannot spend the step (no dwell)", () => {
    const o = new Objectives(["obj.move"]);
    o.update({ strike: true, dash: true, cast: true });
    const second = o.update({ strike: true, dash: true, cast: true });
    expect(new Set(second.checked)).toEqual(new Set(["strike", "dash", "cast"]));
    expect(second.completed).toBeNull();
    expect(o.currentStep()?.id).toBe("obj.five"); // NOT on the ledger yet
  });

  it("the step completes once the host reports real card-on-glass time", () => {
    const o = new Objectives(["obj.move"]);
    const facts = { strike: true, dash: true, cast: true };
    o.update(facts);
    o.update(facts);
    o.addVisibleMs(OBJ_MIN_VISIBLE_MS - 1);
    expect(o.update(facts).completed).toBeNull(); // one millisecond short
    o.addVisibleMs(1);
    expect(o.update(facts).completed).toBe("obj.five");
  });

  it("visible time is per step and does not leak forward to the next one", () => {
    const o = new Objectives();
    o.update(NONE);
    o.addVisibleMs(60000);
    o.update(S1_ALL);
    expect(o.currentStep()?.id).toBe("obj.five");
    expect(o.visibleMs("obj.five")).toBe(0);
    o.update(NONE); // arms THE FIVE
    expect(o.update({ strike: true, dash: true, cast: true }).completed).toBeNull();
  });
});

describe("steps advance only on fact edges, strictly in order", () => {
  it("items check as their facts arrive, in any order within the step", () => {
    const o = new Objectives();
    expect(o.update(NONE).started).toBe("obj.move"); // the arming call reads nothing
    expect(o.update({ kills3: true }).checked).toEqual(["kills3"]); // order free
    expect(o.update({ moved: true }).checked).toEqual(["moved"]);
    dwell(o);
    const last = o.update({ blood: true });
    expect(last.checked).toEqual(["blood"]);
    expect(last.completed).toBe("obj.move");
    expect(o.currentStep()?.id).toBe("obj.five");
  });

  it("a later step's facts do nothing until that step is current", () => {
    const o = new Objectives();
    // The player strikes, dashes and casts during S1 — S2 must not pre-check.
    o.update({ strike: true, dash: true, cast: true });
    o.update({ strike: true, dash: true, cast: true });
    expect(o.view()?.step.id).toBe("obj.move");
    expect(o.view()?.done.size).toBe(0);
  });

  it("a fact that flickers back to false un-checks nothing (one-way latch)", () => {
    const o = new Objectives();
    o.update(NONE);
    o.update({ moved: true });
    o.update({ moved: false });
    expect(o.view()?.done.has("moved")).toBe(true);
  });

  it("a whole step can check in one call, but never in the call that armed it", () => {
    const o = new Objectives();
    const armed = o.update(S1_ALL);
    expect(armed.started).toBe("obj.move");
    expect(armed.checked).toEqual([]);
    expect(armed.completed).toBeNull();
    dwell(o);
    const res = o.update(S1_ALL);
    expect(res.started).toBeNull();
    expect(res.completed).toBe("obj.move");
    expect(new Set(res.checked)).toEqual(new Set(["moved", "blood", "kills3"]));
  });
});

describe("the intro edge (started) fires once per session per step", () => {
  it("the first update introduces the step; later updates do not", () => {
    const o = new Objectives();
    expect(o.update(NONE).started).toBe("obj.move");
    expect(o.update(NONE).started).toBeNull();
    dwell(o);
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
    o.update(NONE);
    dwell(o);
    o.update(S1_ALL);
    o.resetRun();
    expect(o.currentStep()?.id).toBe("obj.five");
    dwell(o);
    o.update(S1_ALL);
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
    o.update(NONE);
    o.update({ moved: true, blood: true });
    expect(o.view()?.done.size).toBe(2);
    o.resetRun();
    expect(o.view()?.done.size).toBe(0);
    // The items are re-earnable, and the step still completes.
    dwell(o);
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

  it("inSafeRoom arms it; the intro fires on the arming edge, checks follow", () => {
    const o = atS4();
    o.update({ shop: true }); // not armed yet
    const res = o.update({ inSafeRoom: true, shop: true });
    expect(res.started).toBe("obj.saferoom");
    expect(res.checked).toEqual([]); // arming reads no facts
    expect(o.update({ inSafeRoom: true, shop: true }).checked).toEqual(["shop"]);
    expect(o.view()?.armed).toBe(true);
  });

  it("once armed it stays armed for the run, even after leaving the room", () => {
    const o = atS4();
    o.update({ inSafeRoom: true });
    dwell(o);
    o.update({ inSafeRoom: true, shop: true, spend: true });
    // The stairs are taken AFTER leaving the safe room — still counts.
    const res = o.update({ inSafeRoom: false, stairs: true });
    expect(res.completed).toBe("obj.saferoom");
    // ...and the curriculum closes on THE SHOW, not here.
    expect(o.finished).toBe(false);
    expect(o.currentStep()?.id).toBe("obj.show");
  });

  it("THE SHOW closes the curriculum: hype over the line + a favorite", () => {
    const o = new Objectives(["obj.move", "obj.five", "obj.payday", "obj.saferoom"]);
    o.update(NONE);
    dwell(o);
    expect(o.update({ hype: true }).checked).toEqual(["hype"]);
    const res = o.update({ fan: true });
    expect(res.completed).toBe("obj.show");
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

describe("an item the economy has priced out of reach falls back (r1)", () => {
  const atSafeRoom = (): Objectives => {
    const o = new Objectives(["obj.move", "obj.five", "obj.payday"]);
    o.update({ inSafeRoom: true }); // arm + intro
    return o;
  };

  it("the alternative fact satisfies the same item", () => {
    const o = atSafeRoom();
    dwell(o);
    // 24 gold, cheapest shelf price 35: 'spend' can never be true, so the
    // host reports `browse` instead and the step is still completable.
    const res = o.update({ inSafeRoom: true, shop: true, browse: true, stairs: true });
    expect(new Set(res.checked)).toEqual(new Set(["shop", "spend", "stairs"]));
    expect(res.completed).toBe("obj.saferoom");
  });

  it("the card prints the alternative wording only while the host says so", () => {
    const o = atSafeRoom();
    o.update({ inSafeRoom: true, brokeAtShop: true });
    expect(o.view()?.alt.has("spend")).toBe(true);
    o.update({ inSafeRoom: true, brokeAtShop: false });
    expect(o.view()?.alt.has("spend")).toBe(false);
  });
});

describe("floor transitions carry a step forward (no floor gate exists)", () => {
  it("a step mid-flight keeps its progress across any number of floors", () => {
    // The module takes no floor input at all — this test documents that the
    // curriculum is the curriculum wherever the crawler is standing.
    const o = new Objectives();
    o.update(NONE);
    o.update({ moved: true }); // floor 1, say
    o.update({ blood: true }); // floor 2 now — nothing resets
    dwell(o);
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
