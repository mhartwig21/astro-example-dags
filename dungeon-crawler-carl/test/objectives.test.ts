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

/**
 * THE ASK IS WHAT THE PLAYER IS BEING ASKED TO DO RIGHT NOW (r10 root cause).
 * The sequencer names it; the coach's OBJ_ASKS table has the prose; the host
 * keeps that prose permanently on the persistent card. The rule this holds is
 * that the ask FOLLOWS THE WORLD — first unchecked item, honest wording, and
 * nothing at all where the place has no step.
 */
describe("askKey(): the one thing being asked, right now", () => {
  it("is the current step's first UNCHECKED item, and moves as they check", () => {
    const o = new Objectives();
    o.update(NONE);
    expect(o.askKey()).toBe("obj.move/moved");
    o.update({ moved: true });
    expect(o.askKey()).toBe("obj.move/blood");
    o.update({ moved: true, blood: true });
    expect(o.askKey()).toBe("obj.move/kills3");
  });

  it("wears the ALT wording whenever the alt wording is the honest one", () => {
    // The shelf is out of reach, so the ask is READING the shelf — and the
    // prose the player is looking at has to be the prose for that, not for a
    // purchase the economy has priced out of existence.
    const o = new Objectives();
    o.update({ inSafeRoom: true });
    o.update({ inSafeRoom: true, shop: true, brokeAtShop: true });
    expect(o.askKey()).toBe("obj.saferoom/browse");
    o.update({ inSafeRoom: true, brokeAtShop: false });
    expect(o.askKey()).toBe("obj.saferoom/spend");
  });

  it("is NULL where the place has no ask — a stood-down card says nothing", () => {
    const o = new Objectives(["obj.move", "obj.five", "obj.payday", "obj.saferoom"]);
    o.update({ inSafeRoom: true });
    expect(o.view()).toBeNull();
    expect(o.askKey()).toBeNull();
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

describe("A DEATH DOES NOT ERASE TUITION (r2 blocker)", () => {
  // The measured failure: item latches were per-run, so "put down three
  // monsters" had to be done IN ONE LIFE. One cold pass watched the card cycle
  // 0/3 -> 1/3 -> 2/3 -> reset twelve consecutive times and never reached the
  // step that teaches the kit; two of three sessions never saw it at all. The
  // curriculum is a player-knowledge ledger, not a run ledger.
  it("resetRun KEEPS the item latches on the step in flight", () => {
    const o = new Objectives();
    o.update(NONE);
    o.update({ moved: true, blood: true });
    expect(o.view()?.done.size).toBe(2);
    o.resetRun();
    expect(o.view()?.done.size).toBe(2); // the player still knows how to walk
    // ...and one more fact, in the NEXT life, closes the step.
    dwell(o);
    expect(o.update({ kills3: true }).completed).toBe("obj.move");
  });

  it("the progress indicator never counts backwards across a death", () => {
    const o = new Objectives();
    o.update(NONE);
    o.update({ moved: true });
    for (let life = 0; life < 12; life++) {
      o.resetRun();
      expect(o.view()?.done.has("moved")).toBe(true);
    }
  });
});

describe("the shop step is the ask at a counter, and nowhere else", () => {
  const atS4 = (): Objectives => new Objectives(["obj.move", "obj.five", "obj.payday"]);

  it("in the field it is not shown and its items are inert", () => {
    const o = atS4();
    // Shop/spend facts true early (e.g. stale host state) check NOTHING: the
    // card out here belongs to the next FIELD step, which is THE SHOW.
    o.update({ shop: true, spend: true });          // arms obj.show
    expect(o.currentStep()?.id).toBe("obj.show");
    expect(o.update({ shop: true, spend: true }).checked).toEqual([]);
    expect(o.place).toBe("field");
  });

  it("standing at a counter shows it; the intro fires on that edge, checks follow", () => {
    const o = atS4();
    o.update({ shop: true }); // in the field: nothing
    const res = o.update({ inSafeRoom: true, shop: true });
    expect(res.started).toBe("obj.saferoom");
    expect(res.checked).toEqual([]); // the arming call reads no facts
    expect(o.update({ inSafeRoom: true, shop: true }).checked).toEqual(["shop"]);
    expect(o.place).toBe("shop");
  });

  it("both its items are completable INSIDE the room it is about", () => {
    const o = atS4();
    o.update({ inSafeRoom: true });
    dwell(o);
    o.update({ inSafeRoom: true, shop: true });
    const res = o.update({ inSafeRoom: true, shop: true, spend: true });
    expect(res.completed).toBe("obj.saferoom");
    // ...and nothing takes its place at the counter — the curriculum closes on
    // THE SHOW, which is a lesson about fighting, out where the fighting is.
    expect(o.finished).toBe(false);
    expect(o.currentStep()).toBeNull();
    o.update(NONE);
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

  it("a death does not carry the counter with it: the new run starts in the field", () => {
    const o = atS4();
    o.update({ inSafeRoom: true, shop: true }); // at a shelf when they died
    expect(o.place).toBe("shop");
    o.resetRun();
    expect(o.place).toBe("field");
    // ...and the shop step's facts are inert out here, however true they are.
    o.update({ shop: true, spend: true });
    expect(o.currentStep()?.id).toBe("obj.show");
    expect(o.update({ shop: true, spend: true }).checked).toEqual([]);
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
    const res = o.update({ inSafeRoom: true, shop: true, browse: true });
    expect(new Set(res.checked)).toEqual(new Set(["shop", "spend"]));
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

describe("STEPS TRACK WHERE THE PLAYER IS (r3 major)", () => {
  // The picture that forced this, twice: the crawler standing in the first safe
  // room, System Shop open, and the card in the corner reading "Get Moving 2/3
  // — put down three monsters". r2 fixed the case where the shop step was still
  // owed; a third pass met the case where it was NOT — the pre-empt stood down
  // and handed the card straight back to a step about killing things, in a room
  // with nothing to kill. Place is a property of every step now.
  it("standing at a counter hands the card to THE SAFE ROOM, mid-spine", () => {
    const o = new Objectives(); // nothing done: the spine is on obj.move
    o.update(NONE);
    expect(o.currentStep()?.id).toBe("obj.move");
    const res = o.update({ inSafeRoom: true });
    expect(res.started).toBe("obj.saferoom");
    expect(o.currentStep()?.id).toBe("obj.saferoom");
  });

  it("a FIELD step is never the ask at a counter, whatever the spine wants", () => {
    // Every field step still owed, the shop step already done: there is no
    // honest ask in this room, so there is no card. Asking a player at a shop
    // counter to put down three monsters is the exact defect, and hiding is
    // the only answer that is not a lie.
    const o = new Objectives(["obj.saferoom"]);
    o.update(NONE);
    expect(o.currentStep()?.id).toBe("obj.move");
    expect(o.update({ inSafeRoom: true, moved: true, blood: true, kills3: true }))
      .toEqual({ started: null, checked: [], completed: null });
    expect(o.view()).toBeNull();
    // ...and walking out of the room hands the same card straight back.
    expect(o.update({ moved: true }).checked).toEqual(["moved"]);
    expect(o.currentStep()?.id).toBe("obj.move");
  });

  it("a hidden step banks no dwell, so it cannot complete off-screen", () => {
    const o = new Objectives(["obj.saferoom"]);
    o.update(NONE);
    o.update({ inSafeRoom: true }); // card hidden: this place has no ask
    o.addVisibleMs(60000);          // the host would never report it, but even so
    expect(o.visibleMs("obj.move")).toBe(0);
    // Back in the field, the dwell has to be paid for real.
    expect(o.update(S1_ALL).completed).toBeNull();
    dwell(o);
    expect(o.update(S1_ALL).completed).toBe("obj.move");
  });

  it("leaving the room hands it back, with both sides' progress intact", () => {
    const o = new Objectives();
    o.update(NONE);
    o.update({ moved: true });
    o.update({ inSafeRoom: true });          // pre-empt (arming call)
    o.update({ inSafeRoom: true, shop: true }); // ...and the shop checks
    expect(o.view()?.done.has("shop")).toBe(true);
    const back = o.update({ blood: true });  // out of the room again
    expect(o.currentStep()?.id).toBe("obj.move");
    expect(back.checked).toEqual(["blood"]);
    expect(o.view()?.done.has("moved")).toBe(true);
    // ...and the next safe room resumes the safe-room step where it stopped.
    o.update({ inSafeRoom: true });
    expect(o.currentStep()?.id).toBe("obj.saferoom");
    expect(o.view()?.done.has("shop")).toBe(true);
  });

  it("a COMPLETED shop step leaves no card behind at the counter", () => {
    // This is the r3 finding stated exactly: the shop step finishes while the
    // player is still standing at the shelf, and the card must not fall back
    // to "put down three monsters" — the room cannot honour it. r2's model
    // did precisely that, and asserted it.
    const o = new Objectives();
    o.update({ inSafeRoom: true });
    dwell(o);
    o.update({ inSafeRoom: true, shop: true });
    expect(o.update({ inSafeRoom: true, spend: true }).completed).toBe("obj.saferoom");
    expect(o.update({ inSafeRoom: true }).started).toBeNull();
    expect(o.currentStep()).toBeNull();
    expect(o.view()).toBeNull();
    // ...and the spine picks up, and introduces itself, out in the dungeon.
    expect(o.update(NONE).started).toBe("obj.move");
    expect(o.currentStep()?.id).toBe("obj.move");
  });

  it("...and the ASK stands down with it, so no prose outlives its place", () => {
    const o = new Objectives();
    o.update({ inSafeRoom: true });
    dwell(o);
    o.update({ inSafeRoom: true, shop: true });
    o.update({ inSafeRoom: true, spend: true });
    expect(o.askKey()).toBeNull();
  });

  it("its dwell clock is its own — the spine's card time is not borrowed", () => {
    const o = new Objectives();
    o.update(NONE);
    o.addVisibleMs(60000);            // a long look at GET MOVING
    o.update({ inSafeRoom: true });   // at the counter; the clock follows the card
    expect(o.visibleMs("obj.saferoom")).toBe(0);
    o.update({ inSafeRoom: true, shop: true, spend: true });
    expect(o.currentStep()?.id).toBe("obj.saferoom"); // not spendable yet
    o.addVisibleMs(OBJ_MIN_VISIBLE_MS);
    expect(o.update({ inSafeRoom: true }).completed).toBe("obj.saferoom");
  });
});

/**
 * THE EXIT RETIRES ITSELF (r11). The debut's wayfinding — the chart mark, the
 * screen beacon and the lost-crawler ask — is TRAINING FURNITURE, and the host
 * asks this one question to decide whether it still exists (main3d's exitLit).
 * A crawler who has completed PAYDAY has taken a staircase, so they have been
 * taught where a floor's exit is; furniture that outlives its lesson is just a
 * permanent HUD affordance nobody chose to add.
 */
describe("a completed step is readable, so training furniture can retire", () => {
  it("isDone tracks the ledger, not the run", () => {
    const o = new Objectives();
    expect(o.isDone("obj.payday")).toBe(false);
    // Seeded from the ledger: the SECOND session of a crawler who already
    // descended never lights the exit again.
    expect(new Objectives(["obj.payday"]).isDone("obj.payday")).toBe(true);
  });

  it("...and it flips on the completion edge, not on the arming one", () => {
    const o = new Objectives(["obj.move", "obj.five"]);
    o.update(NONE); // arms obj.payday
    expect(o.currentStep()?.id).toBe("obj.payday");
    expect(o.isDone("obj.payday")).toBe(false);
    dwell(o);
    expect(o.update({ loot: true, draft: true, descend: true }).completed).toBe("obj.payday");
    expect(o.isDone("obj.payday")).toBe(true);
  });

  it("the skip retires the furniture too — a refusal is a delivery", () => {
    const o = new Objectives();
    o.skipAll();
    expect(o.isDone("obj.payday")).toBe(true);
  });
});
