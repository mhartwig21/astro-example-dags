/**
 * THE COACH (the tutorial rebuild, HANDOFF §3a): Mordecai's in-play teaching
 * channel. These tests hold TWO bodies of law:
 *
 * 1. THE INVERTED BINDING RULE (the riddle fix). The old two-voice rule
 *    FORBADE Mordecai from teaching mechanics; this file asserts the
 *    opposite, the same way the old rule was asserted — mechanically, over
 *    the beat data. A teaching beat's FIRST sentence must contain the
 *    instruction and the key; wry gets sentence two and may never smuggle
 *    the key. Curriculum tip translations must NAME their mechanism —
 *    coverage asserted where avoidance used to be.
 *
 * 2. THE ONRAMP'S MEASURED MECHANICS, carried over: ≤6 prompt budget
 *    (in-flight counted), floor-1 prompt window, confirmations unbudgeted and
 *    un-floor-gated, live-label refusal, offer/commit/release (a line is
 *    spent when it PAINTS).
 */
import { describe, expect, it } from "vitest";
import {
  COACH_BEATS, COACH_MAX_PROMPTS, COACH_TIP_BEATS, COACH_TIP_IDS, Coach,
  OBJ_DONE_LINES, OBJ_INTRO_BEATS, TOPIC_COLLAPSE, castSlotIndices, coachTipLine,
  renderBeat,
  type CoachEvent, type TeachBeat,
} from "../src/ui/coach";
import { DEFAULT_BINDINGS, keyLabel } from "../src/input/bindings";
import { OBJ_STEP_IDS } from "../src/ui/objectives";

const LIVE = { move: "WASD", attack: "Left click or Space", flask: "X", bag: "I" };
const desktop = (): Coach => new Coach({ ...LIVE });
/** Touch is the same table with chip labels — the host picks the words. */
const TOUCH = {
  move: "a drag on the left half of the glass",
  attack: "the STRIKE chip", flask: "the FLASK chip", bag: "the ☰ menu",
};
const phone = (): Coach => new Coach({ ...TOUCH });

/** Unsolicited lectures: floor 1, budgeted. `pickup` is NOT one: it left the
 *  prompt set in r2 because the bag lesson is an answer to an act (loot the
 *  sim declined to auto-wear), and the floor-1 window plus the budget meant
 *  three cold sessions never heard it at all. */
const PROMPTS: CoachEvent[] = ["start", "dashkit", "contact", "lowhp", "linger"];
/** Earned by an act (or, for the depth pair, by the encounter existing):
 *  any floor, unbudgeted. `elite`/`boss` are the floor-2+ pacing beats —
 *  past floor 1 the prompts are silent and Mordecai only footnotes the FIRST
 *  of each new thing the depth introduces. */
const CONFIRMS: CoachEvent[] = [
  "ability", "cast", "slotted", "ult", "pickup", "equipped", "autoequip", "drink",
  "elite", "boss",
];
/** Those whose {key} is only true per-loadout, handed in at call time. */
const KEYED: CoachEvent[] = ["dashkit", "ability", "slotted", "ult"];
/** Note a prompt with a live label, so the call-keyed ones are not declined. */
const prompt = (o: Coach, ev: CoachEvent, floor = 1): string | null => o.note(ev, floor, "Shift");

/** Every beat in the module, wherever it lives. */
const ALL_BEATS: [string, TeachBeat][] = [
  ...Object.entries(COACH_BEATS),
  ...Object.entries(COACH_TIP_BEATS).map(([k, b]) => [`tip:${k}`, b] as [string, TeachBeat]),
  ...Object.entries(OBJ_INTRO_BEATS).map(([k, b]) => [`intro:${k}`, b] as [string, TeachBeat]),
];
/** Every player-facing line the module can emit. */
const ALL_LINES: string[] = [
  ...ALL_BEATS.map(([, b]) => renderBeat(b, "K")),
  ...Object.values(OBJ_DONE_LINES),
];

describe("the inverted binding rule: he TEACHES first (the riddle fix)", () => {
  it("every instruction is exactly ONE sentence and contains its verb", () => {
    for (const [id, b] of ALL_BEATS) {
      // One terminal period, no internal sentence breaks: the instruction is
      // a single imperative, not a paragraph with the lesson buried in it.
      expect(b.instruction, id).toMatch(/^[^.!?]+\.$/);
      expect(b.instruction, `${id} must contain its verb "${b.verb}"`).toContain(b.verb);
    }
  });

  it("a keyed beat's instruction contains {key}; wry NEVER does", () => {
    // The key may not be smuggled into the quip — a player who reads only
    // sentence one must know what to press.
    for (const [id, b] of ALL_BEATS) {
      if (b.needsKey) expect(b.instruction, id).toContain("{key}");
      else expect(b.instruction, id).not.toContain("{key}");
      if (b.wry) expect(b.wry, id).not.toContain("{key}");
    }
  });

  it("the rendered line puts the instruction FIRST, live label substituted", () => {
    for (const [id, b] of ALL_BEATS) {
      const line = renderBeat(b, "Shift, Q");
      expect(line.startsWith(b.instruction.replace(/\{key\}/g, "Shift, Q")), id).toBe(true);
      expect(line, id).not.toContain("{key}");
    }
  });

  it("every curriculum translation NAMES its mechanism (coverage, not avoidance)", () => {
    // The inversion of the old paraphrase ban: the strip's whole job is to
    // say the thing plainly. Each instruction must anchor its mechanism noun.
    expect(COACH_TIP_BEATS.collapse.instruction).toMatch(/stairs|clock/i);
    expect(COACH_TIP_BEATS.draftBanked.instruction).toMatch(/draft/i);
    expect(COACH_TIP_BEATS.hype.instruction).toMatch(/hype/i);
    expect(COACH_TIP_BEATS.glyph.instruction).toMatch(/glyph|socket/i);
  });

  it("the depth beats NAME their mechanism too (floor-2+ pacing)", () => {
    // Elites are the affix lesson; bosses are the telegraph lesson. Sentence
    // one must anchor the noun and the counterplay, not gesture at them.
    expect(COACH_BEATS.elite.instruction).toMatch(/elite/i);
    expect(COACH_BEATS.elite.instruction).toMatch(/named|name/i);
    expect(COACH_BEATS.boss.instruction).toMatch(/boss/i);
    expect(COACH_BEATS.boss.instruction).toMatch(/telegraph|wind/i);
  });

  it("register: no line wears the System's ribbon, and nobody shouts", () => {
    for (const line of ALL_LINES) {
      expect(line).not.toMatch(/COURTESY EXPLANATION/);
      expect(line).not.toMatch(/^NOTICE:/);
      expect(line).not.toMatch(/!/); // register bible: no exclamation marks
    }
  });

  it("completeness: every event, every curriculum tip, every objective step has a line", () => {
    // A silent step is a curriculum hole — the old whitelist dropped tips;
    // the new law is that everything the player is owed has Mordecai's words.
    for (const ev of [...PROMPTS, ...CONFIRMS]) expect(COACH_BEATS[ev], ev).toBeTruthy();
    expect(new Set(COACH_TIP_IDS)).toEqual(new Set(["collapse", "draftBanked", "hype", "glyph"]));
    for (const id of COACH_TIP_IDS) expect(coachTipLine(id), id).toBeTruthy();
    expect(coachTipLine("stagger")).toBeNull(); // untranslated => dropped, never printed
    for (const id of OBJ_STEP_IDS) {
      expect(OBJ_INTRO_BEATS[id], `${id} intro`).toBeTruthy();
      expect(OBJ_DONE_LINES[id], `${id} done`).toBeTruthy();
      expect(OBJ_DONE_LINES[id]).toMatch(/\.$/);
    }
  });
});

describe("the prompt budget is structural (carried from the onramp)", () => {
  it("every prompt fires once, and never more than the budget", () => {
    const o = desktop();
    const lines = PROMPTS.map((ev) => prompt(o, ev));
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    for (const ev of PROMPTS) o.commit(ev); // the paint is the spend
    expect(o.promptsSpent).toBe(PROMPTS.length);
    expect(o.promptsSpent).toBeLessThanOrEqual(COACH_MAX_PROMPTS);
    for (const ev of PROMPTS) expect(prompt(o, ev)).toBeNull();
  });

  it("the budget counts lines still in flight, not just painted ones", () => {
    const o = desktop();
    for (const ev of PROMPTS) expect(prompt(o, ev)).toBeTruthy();
    expect(o.promptsSpent).toBe(0); // nothing has reached the glass yet
    for (const ev of PROMPTS) o.commit(ev);
    expect(o.promptsSpent).toBe(PROMPTS.length);
  });

  it("prompts retire at depth; a floor-2 refusal does not burn the line", () => {
    const o = desktop();
    for (const ev of PROMPTS) expect(prompt(o, ev, 2)).toBeNull();
    expect(o.spent).toBe(0);
    expect(o.note("start", 1)).toContain("WASD");
  });

  it("confirmations are NOT floor-gated — the act is the trigger", () => {
    for (const ev of CONFIRMS) {
      const o = desktop();
      expect(o.note(ev, 5, "K")).toBeTruthy();
    }
  });

  it("confirmations do not spend the lecture budget", () => {
    const o = desktop();
    for (const ev of CONFIRMS) o.note(ev, 1, "K");
    expect(o.promptsSpent).toBe(0);
    expect(PROMPTS.every((ev) => typeof prompt(o, ev) === "string")).toBe(true);
  });
});

describe("survival tools are taught, not awarded (r1 major)", () => {
  it("the dash is a PROMPT — floor 1, uninvited, before anything is earned", () => {
    const o = desktop();
    const line = o.note("dashkit", 1, "Shift")!;
    expect(line).toContain("Shift");
    expect(line).toMatch(/dash/i);
    // Budgeted like every other lecture, and silent at depth.
    o.commit("dashkit");
    expect(o.promptsSpent).toBe(1);
    expect(desktop().note("dashkit", 2, "Shift")).toBeNull();
  });

  it("it names the key it was handed, never a padlocked one", () => {
    expect(desktop().note("dashkit", 1, "")).toBeNull();
    expect(phone().note("dashkit", 1, "a flick")).toMatch(/a flick/);
  });
});

describe("a death does not end the curriculum (r1 major)", () => {
  it("a new run re-arms the PROMPTS so the floor-1 script can run again", () => {
    const o = desktop();
    for (const ev of PROMPTS) { prompt(o, ev); o.commit(ev); }
    expect(PROMPTS.every((ev) => prompt(o, ev) === null)).toBe(true);
    expect(o.reteachPrompts()).toBe(true);
    // ...every prompt except the ones whose LESSON is already delivered: a
    // topic (r2) is a fact about the player, not about the run, so `linger`
    // stays retired while the rest of the script comes back.
    const reArmed = PROMPTS.filter((ev) => !COACH_BEATS[ev].topic);
    expect(reArmed.every((ev) => typeof prompt(o, ev) === "string")).toBe(true);
    expect(prompt(o, "linger")).toBeNull();
    expect(o.promptsSpent).toBe(0); // the budget comes back with the script
  });

  it("confirmations are NOT re-armed — the act happened, and it still counts", () => {
    const o = desktop();
    o.note("autoequip", 1);
    o.commit("autoequip");
    o.reteachPrompts();
    expect(o.note("autoequip", 1)).toBeNull();
  });

  it("re-teaching is capped, so a player dying a lot is not lectured forever", () => {
    const o = desktop();
    expect(o.reteachPrompts(2)).toBe(true);
    expect(o.reteachPrompts(2)).toBe(true);
    expect(o.reteachPrompts(2)).toBe(false);
  });
});

describe("the strip names ONE device — the one in their hands (r1 minor)", () => {
  it("setControls re-states the live labels mid-session", () => {
    const o = new Coach({ ...LIVE, attack: "Left click" });
    o.setControls({ ...LIVE, attack: "Space" });
    const line = o.note("contact", 1)!;
    expect(line).toContain("Space");
    expect(line).not.toMatch(/click/i);
  });
});

describe("no line ever names a bind the player cannot use", () => {
  it("a keyed line with no live label is DECLINED, not printed", () => {
    for (const ev of KEYED) {
      const o = desktop();
      expect(o.note(ev, 1, "")).toBeNull();
      // ...and declining does not spend it: the moment simply had not come.
      expect(o.note(ev, 1, "Q")).toContain("Q");
    }
  });

  it("the ability line names ONLY the slots it was handed", () => {
    const line = desktop().note("ability", 1, "Shift, Q")!;
    expect(line).toContain("Shift, Q");
    expect(line).not.toMatch(/\bC\b/);
    expect(line).not.toMatch(/\bF\b/);
    expect(line).not.toMatch(/ultimate/i); // ultimateMinFloor is 7
    // It says WHY the rest of the row is dark, rather than pretending.
    expect(line).toMatch(/lock/i);
  });

  it("the ultimate is only ever named at the moment it exists", () => {
    const o = desktop();
    for (const ev of [...PROMPTS, "ability", "cast", "slotted", "equipped", "drink", "elite", "boss"] as CoachEvent[]) {
      const line = o.note(ev, 1, "Shift, Q");
      if (line) expect(line).not.toMatch(/ultimate/i);
    }
    expect(desktop().note("ult", 7, "F")).toMatch(/ultimate/i);
    expect(desktop().note("ult", 7, "F")).toContain("Press F");
  });

  it("desktop names the binds it was handed; touch names the glass and chips", () => {
    const d = new Coach({ move: "ESDF", attack: "Left click or Space", flask: "H", bag: "B" });
    expect(d.note("start", 1)).toContain("ESDF");
    expect(d.note("contact", 1)).toContain("Left click or Space");
    expect(d.note("pickup", 1)).toContain("bag with B");
    expect(d.note("lowhp", 1)).toContain("flask with H");
    expect(d.note("slotted", 1, "C")).toContain("Press C");

    const t = phone();
    expect(t.note("start", 1)).toMatch(/left half of the glass/);
    expect(t.note("contact", 1)).toMatch(/STRIKE chip/);
    expect(t.note("lowhp", 1)).toMatch(/FLASK chip/);
    expect(t.note("pickup", 1)).toMatch(/☰ menu/);
    for (const ev of ["cast", "linger", "equipped", "drink", "elite", "boss"] as CoachEvent[]) {
      const line = t.note(ev, 1)!;
      expect(line).not.toMatch(/WASD|click|mouse/i);
    }
  });
});

describe("a line is spent when it PAINTS (offer/commit/release, inherited)", () => {
  it("an offered line that is RELEASED is offerable again", () => {
    const o = desktop();
    expect(o.note("drink", 1)).toMatch(/refill that flask/i);
    expect(o.note("drink", 1)).toBeNull(); // in flight — not offered twice
    o.release("drink");
    expect(o.spent).toBe(0); // nothing painted, nothing spent
    expect(o.note("drink", 1)).toMatch(/refill that flask/i);
  });

  it("an offered line that is COMMITTED never comes back", () => {
    const o = desktop();
    expect(o.note("contact", 1)).toBeTruthy();
    o.commit("contact");
    expect(o.spent).toBe(1);
    expect(o.promptsSpent).toBe(1);
    expect(o.note("contact", 1)).toBeNull();
    o.release("contact"); // a late drop must not un-teach a painted card
    expect(o.note("contact", 1)).toBeNull();
  });

  it("a released prompt gives its budget back", () => {
    const o = desktop();
    for (const ev of PROMPTS) prompt(o, ev);
    for (const ev of PROMPTS) o.release(ev);
    expect(o.spent).toBe(0);
    expect(o.promptsSpent).toBe(0);
    expect(PROMPTS.every((ev) => typeof prompt(o, ev) === "string")).toBe(true);
  });

  it("commit is idempotent and only counts a line that was actually offered", () => {
    const o = desktop();
    o.commit("linger"); // never offered — nothing to spend
    expect(o.spent).toBe(0);
    o.note("linger", 1);
    o.commit("linger");
    o.commit("linger");
    expect(o.spent).toBe(1);
  });
});

describe("the teach-by-doing pairs (carried from the onramp)", () => {
  it("the flask lesson has a second half only a PRESS can reach", () => {
    const o = desktop();
    expect(o.note("lowhp", 1)).toMatch(/Drink your flask/);
    expect(o.note("drink", 1)).toMatch(/kills, not from patience/);
  });

  it("the loot lesson has a by-hand half and a reachable auto-equip half", () => {
    const o = desktop();
    expect(o.note("pickup", 1)).toMatch(/bag/i);
    expect(o.note("equipped", 1)).toMatch(/Compare the numbers/);
    const auto = o.note("autoequip", 1)!;
    expect(auto).toMatch(/dressed itself/);
    // The two halves must not be the same paragraph twice.
    expect(auto).not.toMatch(/Compare the numbers/);
  });
});

describe("SHIFT IS THE DASH, AND THE STRIP MAY NOT SAY OTHERWISE (r2 blocker)", () => {
  // The measured defect: the `ability` beat printed "Press Shift, Q to cast the
  // abilities you actually own" at T+42.1s and "Press Shift to dash clear" at
  // T+63.4s — the same key taught as two different verbs, contradicting the
  // hotbar (SHIFT->DASH), the objectives card, and itself. The host built that
  // label by joining EVERY filled slot's bind; the rule is now a pure function.
  const FRESH_SLOTS = ["strike", "dash", "bolt", null];

  it("the cast-key list never contains the slot the dash sits in", () => {
    const cast = castSlotIndices(FRESH_SLOTS);
    expect(cast).not.toContain(1); // slot2 = the dash on a fresh crawler
    expect(cast).toEqual([2]);
    // ...and stated the way the bug was stated: the label handed to the
    // `ability` beat must not be the slot2 bind while slot2 holds the dash.
    const keyOf = (i: number): string =>
      keyLabel(DEFAULT_BINDINGS[(["slot1", "slot2", "slot3", "slot4"] as const)[i]][0]);
    const label = cast.map(keyOf).join(", ");
    expect(label).toBe("Q");
    expect(label).not.toContain(keyOf(1)); // "Shift"
    const line = desktop().note("ability", 1, label)!;
    expect(line).toContain("Q");
    expect(line).not.toMatch(/shift/i);
    // The dash lesson owns that key, and says the other verb.
    expect(desktop().note("dashkit", 1, keyOf(1))).toMatch(/Shift/);
  });

  it("wherever the crawler benched the dash, it is the one slot excluded", () => {
    expect(castSlotIndices(["strike", "bolt", "dash", "nova"])).toEqual([1, 3]);
    // A crawler whose only other slot IS the dash gets NO ability line at all:
    // an empty label is DECLINED, never printed with a lie in it.
    expect(castSlotIndices(["strike", "dash", null, null])).toEqual([]);
    expect(desktop().note("ability", 1, "")).toBeNull();
  });
});

describe("one lesson, one delivery (r2 minor: the duplicated collapse beat)", () => {
  it("the linger prompt and the collapse tip share a topic", () => {
    expect(COACH_BEATS.linger.topic).toBe(TOPIC_COLLAPSE);
    expect(COACH_TIP_BEATS.collapse.topic).toBe(TOPIC_COLLAPSE);
  });

  it("whichever paints first, the other is declined", () => {
    // Measured: "Take the stairs down before this floor's clock runs out" at
    // T+95.7s and "Find the stairs down before the collapse clock finds you"
    // at T+117.0s — same instruction, same verb, no new information.
    const o = desktop();
    expect(o.note("linger", 1)).toBeTruthy();
    o.commit("linger");
    expect(o.topicTaught(TOPIC_COLLAPSE)).toBe(true);

    const other = desktop();
    other.teachTopic(TOPIC_COLLAPSE); // the sim tip got there first
    expect(other.note("linger", 1)).toBeNull();
    expect(other.spent).toBe(0); // declined, not spent
  });

  it("a topic survives the post-death re-teach (the lesson landed)", () => {
    const o = desktop();
    o.note("linger", 1);
    o.commit("linger");
    o.reteachPrompts();
    expect(o.note("linger", 1)).toBeNull();
    expect(o.note("start", 1)).toBeTruthy(); // ...but the rest of the script returns
  });
});

describe("the key the line names is the key the card draws as a cap", () => {
  it("lastKey reports the live label, and is empty for unkeyed beats", () => {
    const o = desktop();
    o.note("ability", 1, "Q");
    expect(o.lastKey).toBe("Q");
    o.note("cast", 1);
    expect(o.lastKey).toBe("");
  });
});
