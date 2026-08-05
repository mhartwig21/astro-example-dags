/**
 * THE ONRAMP (NICHE.md 4.4): a cold stranger's first five minutes, held to
 * the doc's exact constraints — ≤6 unsolicited System lines, each once, floor
 * 1 only, touch names the actual touch controls, desktop names the live binds.
 *
 * r4 blocker 3 split the script into PROMPTS (the six lectures, still floor 1,
 * still capped) and CONFIRMATIONS (earned by an act the player performed, so
 * neither budgeted nor floor-gated). The hard new rule this file exists to
 * hold: NO LINE MAY EVER NAME A BIND THE PLAYER CANNOT USE.
 */
import { describe, it, expect } from "vitest";
import { Onramp, ONRAMP_MAX_PROMPTS, type OnrampEvent } from "../src/ui/onramp";

// The host passes LIVE labels (r2 blocker: the shipped Five default to
// Space/Shift/Q/C + F — hardcoded "1–4" named keys that do nothing).
const LIVE = { move: "WASD", attack: "Left click or Space", flask: "X", bag: "I" };
const desktop = (): Onramp => new Onramp(false, { ...LIVE });
const phone = (): Onramp => new Onramp(true, { ...LIVE });

/** Unsolicited lectures: floor 1, budgeted. */
const PROMPTS: OnrampEvent[] = ["start", "contact", "pickup", "lowhp", "linger"];
/** Earned by an act: any floor, unbudgeted. */
const CONFIRMS: OnrampEvent[] = [
  "ability", "cast", "slotted", "ult", "equipped", "autoequip", "drink",
];
/** The three whose text is a KEY NAME, so they must be handed a live label. */
const KEYED: OnrampEvent[] = ["ability", "slotted", "ult"];

describe("the prompt budget is structural", () => {
  it("every prompt fires once, and never more than the budget", () => {
    const o = desktop();
    const lines = PROMPTS.map((ev) => o.note(ev, 1));
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    for (const ev of PROMPTS) o.commit(ev); // the paint is the spend (r5)
    expect(o.promptsSpent).toBe(PROMPTS.length);
    expect(o.promptsSpent).toBeLessThanOrEqual(ONRAMP_MAX_PROMPTS);
    for (const ev of PROMPTS) expect(o.note(ev, 1)).toBeNull();
  });

  it("the budget counts lines still in flight, not just painted ones", () => {
    // Six offers outstanding must block a seventh, or the cap is only a cap
    // for a player whose cards happen to have painted already.
    const o = desktop();
    const all: OnrampEvent[] = ["start", "contact", "pickup", "lowhp", "linger"];
    for (const ev of all) expect(o.note(ev, 1)).toBeTruthy();
    expect(o.promptsSpent).toBe(0); // nothing has reached the glass yet
    for (const ev of all) o.commit(ev);
    expect(o.promptsSpent).toBe(all.length);
  });

  it("prompts retire at depth; a floor-2 refusal does not burn the line", () => {
    const o = desktop();
    for (const ev of PROMPTS) expect(o.note(ev, 2)).toBeNull();
    expect(o.spent).toBe(0);
    expect(o.note("start", 1)).toMatch(/fresh meat/i);
  });

  it("confirmations are NOT floor-gated — the act is the trigger (r4)", () => {
    // r3 carved `cast` out of the floor-1 retirement because a level-1
    // crawler can reach the stairs with every slot locked. Every other
    // confirmation earns the same exemption on the same argument: gating a
    // confirmation by depth makes it unreachable for whoever was slow.
    for (const ev of CONFIRMS) {
      const o = desktop();
      expect(o.note(ev, 5, "K")).toMatch(/^COURTESY EXPLANATION:/);
    }
  });

  it("confirmations do not spend the lecture budget", () => {
    const o = desktop();
    for (const ev of CONFIRMS) o.note(ev, 1, "K");
    expect(o.promptsSpent).toBe(0);
    // ...and all six prompts are still available afterwards.
    expect(PROMPTS.every((ev) => typeof o.note(ev, 1) === "string")).toBe(true);
  });

  it("every line is the System's voice: COURTESY EXPLANATION, rule + snark", () => {
    const o = desktop();
    for (const ev of [...PROMPTS, ...CONFIRMS]) {
      expect(o.note(ev, 1, "K")).toMatch(/^COURTESY EXPLANATION:/);
    }
  });
});

describe("no line ever names a bind the player cannot use (r4 blocker 3)", () => {
  it("a keyed line with no live label is DECLINED, not printed", () => {
    for (const ev of KEYED) {
      const o = desktop();
      expect(o.note(ev, 1, "")).toBeNull();
      // ...and declining does not spend it: the moment simply had not come.
      expect(o.note(ev, 1, "Q")).toContain("Q");
    }
  });

  it("the ability line names ONLY the slots it was handed", () => {
    // The measured r3 failure: slots = [melee, dash, bolt, LOCKED], ult =
    // LOCKED, and the line said "Shift, Q, C are abilities and F is the
    // ultimate" — two padlocked keys out of five.
    const line = desktop().note("ability", 1, "Shift, Q")!;
    expect(line).toContain("Shift, Q");
    expect(line).not.toMatch(/\bC\b/);
    expect(line).not.toMatch(/\bF\b/);
    expect(line).not.toMatch(/ultimate/i); // ultimateMinFloor is 7
    expect(line).not.toMatch(/1–4|1-4/);
    // It does say WHY the rest of the row is dark, rather than pretending.
    expect(line).toMatch(/lock/i);
  });

  it("the ultimate is only ever named at the moment it exists", () => {
    // No prompt and no confirmation may mention the ultimate's bind unless
    // the ultimate slot itself was the thing that changed.
    const o = desktop();
    for (const ev of [...PROMPTS, "ability", "cast", "slotted", "equipped", "drink"] as OnrampEvent[]) {
      const line = o.note(ev, 1, "Shift, Q");
      if (line) expect(line).not.toMatch(/ULTIMATE/);
    }
    expect(desktop().note("ult", 7, "F")).toMatch(/ULTIMATE/);
    expect(desktop().note("ult", 7, "F")).toContain("F discharges it");
  });
});

describe("the lines name the actual controls (4.4.2)", () => {
  it("desktop names the binds it was handed", () => {
    const o = new Onramp(false, {
      move: "ESDF", attack: "Left click or Space", flask: "H", bag: "B",
    });
    expect(o.note("start", 1)).toContain("ESDF");
    expect(o.note("contact", 1)).toContain("Left click or Space");
    expect(o.note("pickup", 1)).toContain("B opens your BAG");
    expect(o.note("lowhp", 1)).toContain("H drinks the flask");
    expect(o.note("slotted", 1, "C")).toContain("C is live");
  });

  it("the System points at rules, never at the player's chrome (r4 voice)", () => {
    // The System audits ledgers; it has never conceded you have a HUD, and it
    // does not gloss keys in parentheses like a manual.
    const o = desktop();
    for (const ev of [...PROMPTS, ...CONFIRMS]) {
      const line = o.note(ev, 1, "Q");
      if (!line) continue;
      expect(line).not.toMatch(/\bHUD\b/i);
      expect(line).not.toMatch(/\([A-Z]\)/); // "BAG (I)" — a manual, not a voice
    }
  });

  it("touch names the glass and the chips, never a keyboard", () => {
    const o = phone();
    expect(o.note("start", 1)).toMatch(/LEFT HALF of the glass/);
    expect(o.note("contact", 1)).toMatch(/STRIKE chip/);
    expect(o.note("lowhp", 1)).toMatch(/FLASK chip/);
    expect(o.note("pickup", 1)).toMatch(/☰ menu/);
    expect(o.note("ability", 1, "the two beside it")).toMatch(/chips beside STRIKE/);
    for (const ev of ["cast", "linger", "equipped", "drink"] as OnrampEvent[]) {
      const line = o.note(ev, 1)!;
      expect(line).not.toMatch(/WASD|click|mouse/i);
    }
  });

  it("teaches where the game takes over: floor 2's glyph socket is the handoff", () => {
    expect(desktop().note("cast", 1)).toMatch(/Floor 2 opens a GLYPH SOCKET/);
    // On floor 2 the socket is already open — the same lesson must not name it
    // as a future event (r3).
    expect(desktop().note("cast", 2)).toMatch(/This floor's GLYPH SOCKET/);
    expect(desktop().note("linger", 1)).toMatch(/stairs/i);
  });
});

describe("a line is spent when it PAINTS (r5 blocker 1)", () => {
  // The measured failure: a cold profile drank the flask inside the 9s card
  // pacing gap, died before the confirmation painted, pressed R — and BOTH
  // halves of the flask lesson were gone for the session with neither card
  // ever on the glass. These eleven lines carry no tipId, so r4's
  // ledger-on-paint rule never covered them; `note` was the spend.
  it("an offered line that is RELEASED is offerable again", () => {
    const o = desktop();
    expect(o.note("drink", 1)).toMatch(/flask consumed/i);
    expect(o.note("drink", 1)).toBeNull(); // in flight — not offered twice
    o.release("drink");
    expect(o.spent).toBe(0); // nothing painted, nothing spent
    expect(o.note("drink", 1)).toMatch(/flask consumed/i);
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
    for (const ev of PROMPTS) o.note(ev, 1);
    for (const ev of PROMPTS) o.release(ev);
    expect(o.spent).toBe(0);
    expect(o.promptsSpent).toBe(0);
    expect(PROMPTS.every((ev) => typeof o.note(ev, 1) === "string")).toBe(true);
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

describe("the teach-by-doing pairs (r4)", () => {
  it("the flask lesson has a second half that only a PRESS can reach", () => {
    // "You died holding 3 flasks" was the critic's verdict on r3.
    const o = desktop();
    expect(o.note("lowhp", 1)).toMatch(/drinks the flask|FLASK chip/);
    expect(o.note("drink", 1)).toMatch(/KILLS, not from time/);
  });

  it("the loot lesson has a second half that only an EQUIP can reach", () => {
    const o = desktop();
    expect(o.note("pickup", 1)).toMatch(/BAG/);
    const eq = o.note("equipped", 1)!;
    expect(eq).toMatch(/MOVED/);
    expect(eq).toMatch(/compared, never collected/);
  });

  it("...and a REACHABLE half, because floor-1 loot dresses itself (r5)", () => {
    // `equipped` never fired in four cold runs: the sim auto-equips strict
    // upgrades, so the bag the pickup card points at is empty and there is
    // nothing to put on by hand. The auto-equip is the moment gear
    // demonstrably went on, and it explains why the trip was not needed.
    const auto = desktop().note("autoequip", 1)!;
    expect(auto).toMatch(/dressed itself/);
    expect(auto).toMatch(/judgement call/);
    expect(auto).toMatch(/BAG/);
    // The two halves must not be the same paragraph twice.
    expect(auto).not.toMatch(/compared, never collected/);
  });
});
