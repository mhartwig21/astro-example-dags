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
  ASK_DRAFT_KEY, ASK_LOST_KEY, ASK_MAX_CARDS, ASK_REPEAT_MS, ASK_STUCK_MS,
  COACH_BEATS, COACH_MAX_PROMPTS, COACH_SHOP_BEATS, COACH_TIP_BEATS, COACH_TIP_IDS,
  Coach, OBJ_ASKS, OBJ_DONE_LINES, OBJ_INTRO_BEATS, StandingAsk,
  TOPIC_BAG, TOPIC_COLLAPSE, TOPIC_SHOW, castKeyIndex,
  castSlotIndices, coachTipLine, diagnoseKnockdown, renderBeat, shopBeatLine,
  type CoachEvent, type TeachBeat,
} from "../src/ui/coach";
import { DEFAULT_BINDINGS, keyLabel } from "../src/input/bindings";
import { OBJECTIVE_STEPS, OBJ_LABEL_TOKENS, OBJ_STEP_IDS } from "../src/ui/objectives";

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
  // THE SHOW's three nouns, fired by its readout first moving (r10, sev 7).
  "showbar",
  // THE KNOCKDOWN DIAGNOSIS (r11, sev 9): the act that earns them is going
  // down, so they are confirmations — unbudgeted, and never floor-gated even
  // though only floor 1 of a debut can currently produce one.
  "downdash", "downflask", "downescort",
];
/** Those whose {key} is only true per-loadout, handed in at call time. */
const KEYED: CoachEvent[] = ["dashkit", "ability", "slotted", "ult", "downdash", "downescort"];
/** Note a prompt with a live label, so the call-keyed ones are not declined. */
const prompt = (o: Coach, ev: CoachEvent, floor = 1): string | null => o.note(ev, floor, "Shift");

/** Every beat in the module, wherever it lives. */
const ALL_BEATS: [string, TeachBeat][] = [
  ...Object.entries(COACH_BEATS),
  ...Object.entries(COACH_TIP_BEATS).map(([k, b]) => [`tip:${k}`, b] as [string, TeachBeat]),
  ...Object.entries(OBJ_INTRO_BEATS).map(([k, b]) => [`intro:${k}`, b] as [string, TeachBeat]),
  // The shelf lines live on the shop panel rather than the strip (body.modal
  // hides the strip), but a beat is a beat: same shape, same binding rule.
  ...Object.entries(COACH_SHOP_BEATS).map(([k, b]) => [`shop:${k}`, b] as [string, TeachBeat]),
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
    expect(desktop().note("pickup", 1)).toMatch(/bag/i);
    expect(desktop().note("equipped", 1)).toMatch(/Compare the numbers/);
    const auto = desktop().note("autoequip", 1)!;
    expect(auto).toMatch(/dressed itself/);
    // The two halves must not be the same paragraph twice.
    expect(auto).not.toMatch(/Compare the numbers/);
  });
});

describe("GEAR, EQUIPPING AND THE SHELF ARE TAUGHT BY SOMEBODY (r3, finding 4)", () => {
  // Three cold passes finished a session having never been told where gear
  // lives, what "equipped" means, or a single word of the shop's own
  // vocabulary. The bag half failed for a structural reason: `pickup` needs an
  // item to LAND IN THE BAG, and floor-1 loot mostly auto-equips, so the one
  // gear moment floor 1 reliably provides was spent on a line that named
  // neither the bag nor a key.
  it("the reliable floor-1 gear moment names the bag key and the word EQUIPPED", () => {
    const line = desktop().note("autoequip", 1, "")!;
    expect(line).toMatch(/bag with I/);
    expect(line).toMatch(/equipped/i);
  });

  it("...and the bag key is taught ONCE, whichever gear moment gets there first", () => {
    for (const [first, second] of [["pickup", "autoequip"], ["autoequip", "pickup"]] as const) {
      const o = desktop();
      expect(o.note(first, 1)).toBeTruthy();
      o.commit(first);
      expect(o.topicTaught(TOPIC_BAG)).toBe(true);
      expect(o.note(second, 1)).toBeNull(); // declined, not repeated
      expect(o.spent).toBe(1);
    }
  });

  it("the shelf beats define the panel's own words, off the shelf that generated", () => {
    const afford = shopBeatLine("afford", "Field Dressing", 35, 40);
    expect(afford).toContain("Field Dressing");
    expect(afford).toContain("35 gold");
    expect(afford).toMatch(/COMPONENTS/); // the tile label the panel prints
    expect(afford).toMatch(/sell/i);      // ...and that the bag is a source of gold
    const broke = shopBeatLine("broke", "Field Dressing", 35, 16);
    expect(broke).toContain("35 gold");
    expect(broke).toContain("16");        // the number in their purse, said plainly
    expect(broke).toMatch(/keeps between floors/);
    // No token survives to the glass in either form.
    for (const line of [afford, broke]) expect(line).not.toMatch(/\{[a-z]+\}/);
  });

  // r9, severity 5: "the first shelf is 18/24 tiles that do nothing yet". The
  // shelf was never the liar — every basic-tier catalog entry has a `slot` and
  // `affixes`, and buyCatalogItem equips into an empty slot on purchase. The
  // panel's own copy was what deferred them, and a debut crawler is exactly
  // the crawler for whom nothing on that shelf is deferred.
  it("no shelf beat may call a COMPONENTS tile something you cannot wear today", () => {
    for (const [id, b] of Object.entries(COACH_SHOP_BEATS)) {
      const line = renderBeat(b);
      expect(line, `shop:${id}`).not.toMatch(/parts rather than gear/i);
      expect(line, `shop:${id}`).not.toMatch(/build into the real thing/i);
      // Any mention of a later shelf must be the ADDITIONAL claim, never the
      // only one: the tile has to be useful today in the same breath.
      if (/later shelf/i.test(line)) expect(line, `shop:${id}`).toMatch(/wear today/i);
    }
    // The claim that replaced it has to be the true one, in both forms that
    // mention the tile label at all.
    for (const which of ["fits", "afford"] as const) {
      expect(renderBeat(COACH_SHOP_BEATS[which])).toMatch(/COMPONENTS are gear you wear today/);
    }
  });

  it("the `fits` beat names the EMPTY SLOT, so the value is checkable on the equipped row", () => {
    const fits = shopBeatLine("fits", "Boxcutter", 35, 131, "weapon");
    expect(fits).toContain("Boxcutter");
    expect(fits).toContain("35 gold");
    expect(fits).toContain("weapon slot is empty");
    expect(fits).not.toMatch(/\{[a-z]+\}/);
    // ...and the slot token never leaks into the forms that do not take one.
    for (const which of ["afford", "broke"] as const) {
      expect(shopBeatLine(which, "Boxcutter", 35, 131)).not.toMatch(/\{slot\}/);
    }
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

  // ...AND THE OBJECTIVES CARD'S FALLBACK IS THE SAME RULE (r3, finding 5).
  // The card's `{cast}` token re-derived the live cast slot correctly and then
  // fell back to a hardcoded slot index when the crawler owned no castable
  // ability — which is the DASH's slot for anyone who benched it there, so
  // "Cast with Shift" was still reachable from the one surface that is on the
  // glass permanently. The exclusion has to hold at every branch.
  it("castKeyIndex never returns the dash slot, on any loadout", () => {
    expect(castKeyIndex(["strike", "dash", "bolt", null])).toBe(2);   // fresh crawler
    expect(castKeyIndex(["strike", "bolt", "dash", "nova"])).toBe(1);
    // No castable ability at all: it falls back to a slot that can HOLD one,
    // and the dash's slot is not a candidate wherever it sits.
    for (let d = 1; d <= 3; d++) {
      const slots: (string | null)[] = ["strike", null, null, null];
      slots[d] = "dash";
      const i = castKeyIndex(slots);
      expect(i, `dash in slot ${d}`).toBeGreaterThanOrEqual(1);
      expect(slots[i], `dash in slot ${d}`).not.toBe("dash");
    }
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

/**
 * THE STANDING ASK (r10 — "the coach prose slot teaches the wrong thing, once,
 * and never again"). The cohort finding this fixes: half of four cold profiles
 * finished a 7.5-minute first session at level 1, floor 1, still on step 2 of
 * 5, with the teaching channel silent — every line the module owned was an
 * EVENT, spent on one paint, and nothing in the system could say a second,
 * more concrete thing to a player who was visibly stuck.
 */
describe("THE TEACHING CHANNEL IS CONTINUOUS (r10 root cause)", () => {
  /** Every ask the sequencer can produce, plus the pre-empt. */
  const ASK_KEYS: string[] = [
    ...OBJECTIVE_STEPS.flatMap((s) => s.items.flatMap((it) =>
      [`${s.id}/${it.id}`, ...(it.alt ? [`${s.id}/${it.alt.id}`] : [])])),
    ASK_DRAFT_KEY,
    // ...and the two PRE-EMPTS, which are asks the WORLD produces rather than
    // the sequencer: a banked draft (r10) and a crawler who has stopped getting
    // closer to the stairs (r11).
    ASK_LOST_KEY,
  ];

  it("EVERY item the curriculum can stall on has an ask and an escalation", () => {
    // A checklist item with no prose behind it is an item a player can stall
    // on in silence — which is the whole defect, item by item.
    for (const key of ASK_KEYS) {
      expect(OBJ_ASKS[key], `no ask for ${key}`).toBeTruthy();
      expect(OBJ_ASKS[key].stuck, `${key} escalation`).toBeTruthy();
      // ...and the escalation must be MORE than the ask, not a rewording.
      expect(OBJ_ASKS[key].stuck.length, key)
        .toBeGreaterThan(OBJ_ASKS[key].ask.length);
    }
    // No ask exists that nothing can produce — a dead entry is a lie about
    // coverage, and this table's whole job is coverage.
    for (const key of Object.keys(OBJ_ASKS)) expect(ASK_KEYS, key).toContain(key);
  });

  it("asks obey the binding rule: one imperative sentence, tokens the host knows", () => {
    const known = new Set<string>(OBJ_LABEL_TOKENS);
    for (const [key, b] of Object.entries(OBJ_ASKS)) {
      for (const [which, line] of [["ask", b.ask], ["stuck", b.stuck]] as const) {
        expect(line, `${key}.${which}`).toMatch(/^[^.!?]+\.$/);
        for (const m of line.matchAll(/\{([^}]+)\}/g)) {
          expect(known.has(m[1]), `${key}.${which} token {${m[1]}}`).toBe(true);
        }
      }
      // The register lives in the tail, and a control may never hide there:
      // the plate carries the instruction ALONE, so a key smuggled into the
      // quip is a key the permanent surface never shows.
      expect(b.wry, `${key}.wry`).not.toMatch(/\{[a-z]+\}/);
      expect(b.wry, `${key}.wry`).not.toMatch(/!/);
    }
  });

  it("the plate's line is NEVER spent — a hundred frames later it is still there", () => {
    const a = new StandingAsk();
    a.observe("obj.five/dash", 0);
    const first = a.line();
    expect(first).toContain("{dash}");
    for (let i = 0; i < 100; i++) a.observe("obj.five/dash", 16);
    expect(a.line()).toBeTruthy();
    expect(a.current).toBe("obj.five/dash");
  });

  it("a stuck player is ESCALATED to the concrete form, not left in silence", () => {
    const a = new StandingAsk();
    a.observe("obj.five/dash", 0);
    expect(a.observe("obj.five/dash", ASK_STUCK_MS - 1)).toBeNull();
    expect(a.escalated).toBe(false);
    expect(a.line()).toBe(OBJ_ASKS["obj.five/dash"].ask); // instruction alone

    const edge = a.observe("obj.five/dash", 2)!;
    expect(edge.text).toContain(OBJ_ASKS["obj.five/dash"].stuck);
    // ...and the PLATE keeps the concrete form from then on. The escalation is
    // delivered IN PLACE — no second surface, no card to lose (r8 finding 3) —
    // so the only thing that could un-teach it is the player moving on.
    expect(a.escalated).toBe(true);
    expect(a.line()).toContain(OBJ_ASKS["obj.five/dash"].stuck);
    expect(a.line()).toContain(OBJ_ASKS["obj.five/dash"].wry);
  });

  it("time the card was not on the glass does not count as being stuck", () => {
    // The same honest clock the step-dwell gate is paid in: a player cannot be
    // escalated at over an instruction they were never shown.
    const a = new StandingAsk();
    a.observe("obj.move/moved", 0);
    for (let i = 0; i < 500; i++) expect(a.observe("obj.move/moved", 0)).toBeNull();
    expect(a.escalated).toBe(false);
  });

  it("progress resets the escalation — the next item starts clean", () => {
    const a = new StandingAsk();
    a.observe("obj.move/moved", 0);
    a.observe("obj.move/moved", ASK_STUCK_MS);
    expect(a.escalated).toBe(true);
    a.observe("obj.move/blood", 16); // the item checked; the ask moved on
    expect(a.escalated).toBe(false);
    expect(a.line()).toBe(OBJ_ASKS["obj.move/blood"].ask); // and back to instruction alone
  });

  it("re-asserting is bounded; the standing instruction is not", () => {
    const a = new StandingAsk();
    a.observe("obj.move/kills3", 0);
    let edges = 0;
    for (let i = 0; i < 400; i++) if (a.observe("obj.move/kills3", 1000)) edges++;
    expect(edges).toBe(ASK_MAX_CARDS);
    // Bounded ATTENTION-DRAWING is politeness. Bounded teaching is the bug:
    // after the last pulse the concrete instruction is still on the glass.
    expect(a.line()).toContain(OBJ_ASKS["obj.move/kills3"].stuck);
    expect(ASK_REPEAT_MS).toBeGreaterThan(ASK_STUCK_MS / 2);
  });

  it("an ask the host has no key for shows nothing rather than something wrong", () => {
    const a = new StandingAsk();
    a.observe("", 16);
    expect(a.line()).toBe("");
    expect(a.observe("", 100000)).toBeNull();
  });
});

/**
 * THE DRAFT IS THE GAME'S CORE PROGRESSION VERB AND NOBODY LEARNED IT (r10,
 * severity 8): four cold profiles ended their first session holding unclaimed
 * drafts, the best of them holding two.
 */
describe("claiming a draft is impossible to miss", () => {
  it("the draft ask names the claim key and escalates FASTER than a step ask", () => {
    const beat = OBJ_ASKS[ASK_DRAFT_KEY];
    expect(beat.ask).toContain("{draft}");
    expect(beat.stuck).toContain("{draft}");
    expect(beat.after).toBeLessThan(ASK_STUCK_MS);
    const a = new StandingAsk();
    a.observe(ASK_DRAFT_KEY, 0);
    expect(a.observe(ASK_DRAFT_KEY, beat.after!)).toBeTruthy();
  });

  it("the curriculum's own checklist item carries the bind too", () => {
    const payday = OBJECTIVE_STEPS.find((s) => s.id === "obj.payday")!;
    const draft = payday.items.find((it) => it.id === "draft")!;
    expect(draft.label).toContain("{draft}");
  });

  it("...and Mordecai says what the System used to: claim, and what it is for", () => {
    expect(COACH_TIP_BEATS.draftBanked.instruction).toMatch(/claim/i);
    expect(OBJ_ASKS[ASK_DRAFT_KEY].stuck).toMatch(/level/i);
  });
});

/**
 * THE SHOW WAS UNTAUGHT VOCABULARY ON THE GLASS FROM SECOND ZERO (r10,
 * severity 7): a hype bar and three counts nobody defined, and a final
 * curriculum step titled "The Show" asking for two of the undefined words.
 */
describe("THE SHOW is taught, not merely surfaced", () => {
  it("the readout's first movement defines all three nouns", () => {
    const line = renderBeat(COACH_BEATS.showbar);
    expect(line).toMatch(/hype/i);
    expect(line).toMatch(/viewers/i);
    expect(line).toMatch(/favorites/i);
  });

  it("the crit tip and the readout beat are ONE lesson, delivered once", () => {
    expect(COACH_BEATS.showbar.topic).toBe(TOPIC_SHOW);
    expect(COACH_TIP_BEATS.hype.topic).toBe(TOPIC_SHOW);
    const o = desktop();
    o.teachTopic(TOPIC_SHOW); // the crit got there first
    expect(o.note("showbar", 1)).toBeNull();
    expect(o.spent).toBe(0);
  });

  it("the hype tip defines the word it uses, and so does the closing step", () => {
    expect(coachTipLine("hype")).toMatch(/crowd|attention/i);
    const show = renderBeat(OBJ_INTRO_BEATS["obj.show"]);
    expect(show).toMatch(/favorite/i);
    expect(show).toMatch(/attention|crowd/i);
  });
});

/**
 * THE EXIT (r11, severity 9): "the tutorial no longer kills its players, it
 * strands them ... two of four deaths were collapse-timer executions at full HP
 * with zero wayfinding", and "floor 1 is unloseable and also unleaveable —
 * mercy has no escalation or diagnosis".
 */
describe("a lost crawler is given a DIRECTION, not another checkbox", () => {
  it("the lost ask carries a live bearing and the escalation carries the key", () => {
    const beat = OBJ_ASKS[ASK_LOST_KEY];
    // The ask is a heading (the host substitutes {bearing} from the world every
    // frame); the escalation additionally names the control that spends it.
    expect(beat.ask).toContain("{bearing}");
    expect(beat.stuck).toContain("{bearing}");
    expect(beat.stuck).toContain("{stairs}");
    expect(beat.ask).toMatch(/stairs|map/i);
  });

  it("...and it escalates FASTER than an ordinary step ask", () => {
    // The host does not raise this until a measured stall, so by the time it is
    // on the glass the player has already been lost for a while.
    const beat = OBJ_ASKS[ASK_LOST_KEY];
    expect(beat.after).toBeLessThan(ASK_STUCK_MS);
    const a = new StandingAsk();
    a.observe(ASK_LOST_KEY, 0);
    expect(a.observe(ASK_LOST_KEY, beat.after!)).toBeTruthy();
    expect(a.line()).toContain(beat.stuck);
  });

  it("progress toward the exit hands the ask straight back to the spine", () => {
    // The pre-empt is a projection of the world, exactly like the draft one: a
    // key change is progress, and progress resets the clock and the escalation.
    const a = new StandingAsk();
    a.observe(ASK_LOST_KEY, 0);
    a.observe(ASK_LOST_KEY, 60000);
    expect(a.escalated).toBe(true);
    a.observe("obj.payday/descend", 0);
    expect(a.escalated).toBe(false);
    expect(a.line()).toBe(OBJ_ASKS["obj.payday/descend"].ask);
  });

  it("the descend item's own escalation points at the marked exit", () => {
    // The one item that can strand a player names the surfaces that answer it.
    const beat = OBJ_ASKS["obj.payday/descend"];
    expect(beat.stuck).toMatch(/map|marker|EXIT/);
    expect(beat.stuck).toContain("{stairs}");
  });
});

describe("the debut mercy DIAGNOSES instead of repeating itself", () => {
  it("names the survival tool the crawler is measurably not using", () => {
    // Never dashed beats everything but the escort: the dash is the one button
    // that ends the situation that is knocking them down.
    expect(diagnoseKnockdown({ escorted: false, dashed: false, flasks: 3 })).toBe("downdash");
    // Dashing but dying with flasks on the belt is the other measured shape
    // ("You died holding 3 flasks", r5's verdict line).
    expect(diagnoseKnockdown({ escorted: false, dashed: true, flasks: 2 })).toBe("downflask");
  });

  it("the ESCORT outranks every diagnosis — the world just changed under them", () => {
    expect(diagnoseKnockdown({ escorted: true, dashed: false, flasks: 3 })).toBe("downescort");
    expect(diagnoseKnockdown({ escorted: true, dashed: true, flasks: 0 })).toBe("downescort");
  });

  it("a crawler using both tools is told NOTHING — they are losing, not stranded", () => {
    // Silence is the honest answer here: the coach's ordinary combat lines own
    // that player, and a diagnosis that fires on everybody diagnoses nobody.
    expect(diagnoseKnockdown({ escorted: false, dashed: true, flasks: 0 })).toBeNull();
  });

  it("every note the selector can return has a line, and the escort names the key", () => {
    for (const note of ["downdash", "downflask", "downescort"] as const) {
      expect(COACH_BEATS[note], note).toBeTruthy();
    }
    // The escort's whole job is "you are standing on the stairs, press this".
    const line = desktop().note("downescort", 1, ">")!;
    expect(line).toContain(">");
    expect(line).toMatch(/stairs/i);
    expect(desktop().note("downdash", 1, "Shift")).toMatch(/dash/i);
    expect(desktop().note("downflask", 1)).toContain("X"); // the flask control
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
