/**
 * THE ONRAMP (NICHE.md 4.4): a cold stranger's first five minutes, held to
 * the doc's exact constraints — ≤6 System lines, each once, floor 1 only,
 * touch names the actual touch controls, desktop names the live binds.
 */
import { describe, it, expect } from "vitest";
import { Onramp, ONRAMP_MAX_LINES, type OnrampEvent } from "../src/ui/onramp";

// The host passes LIVE labels (r2 blocker: the shipped Five default to
// Space/Shift/Q/C + F — hardcoded "1–4" named keys that do nothing).
const LIVE = {
  move: "WASD", attack: "Left click or Space", cast: "Shift, Q, C",
  ult: "F", flask: "X", bag: "I",
};
const desktop = (): Onramp => new Onramp(false, { ...LIVE });
const phone = (): Onramp => new Onramp(true, { ...LIVE });

const ALL: OnrampEvent[] = ["start", "moved", "cast", "pickup", "lowhp", "linger"];

describe("the onramp budget is structural", () => {
  it("six events, six lines, each exactly once — never a seventh", () => {
    const o = desktop();
    const lines = ALL.map((ev) => o.note(ev, 1));
    expect(lines.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    expect(o.spent).toBe(ONRAMP_MAX_LINES);
    // Replays of every event: silence.
    for (const ev of ALL) expect(o.note(ev, 1)).toBeNull();
  });

  it("floor 1 only: the script never speaks at depth", () => {
    const o = desktop();
    for (const ev of ALL) expect(o.note(ev, 2)).toBeNull();
    expect(o.spent).toBe(0);
    // ...and a floor-2 refusal does not burn the line: back on floor 1 it fires.
    expect(o.note("start", 1)).toMatch(/fresh meat/i);
  });

  it("every line is the System's voice: COURTESY EXPLANATION, rule + snark", () => {
    const o = desktop();
    for (const ev of ALL) {
      expect(o.note(ev, 1)).toMatch(/^COURTESY EXPLANATION:/);
    }
  });
});

describe("the lines name the actual controls (4.4.2)", () => {
  it("desktop names the binds it was handed — every slot of the Five, live", () => {
    const o = new Onramp(false, {
      move: "ESDF", attack: "Left click or Space", cast: "Shift, Q, C", ult: "F", flask: "H", bag: "B",
    });
    expect(o.note("start", 1)).toContain("ESDF");
    const moved = o.note("moved", 1)!;
    expect(moved).toContain("Left click or Space");
    expect(moved).toContain("Shift, Q, C");
    expect(moved).toContain("F is the ultimate");
    // NEVER the digits nobody bound (r2 blocker: the shipped defaults are
    // Space/Shift/Q/C + F; "press 1–4" taught a key that does nothing).
    expect(moved).not.toMatch(/1–4|1-4/);
    expect(o.note("pickup", 1)).toContain("BAG (B)"); // gear has a key, named
    expect(o.note("lowhp", 1)).toContain("H drinks the flask");
  });

  it("touch names the glass and the chips, never a keyboard", () => {
    const o = phone();
    expect(o.note("start", 1)).toMatch(/LEFT HALF of the glass/);
    expect(o.note("moved", 1)).toMatch(/STRIKE chip/);
    expect(o.note("lowhp", 1)).toMatch(/FLASK chip/);
    // ...and the BAG line points at the glass's own menu, not a key.
    expect(o.note("pickup", 1)).toMatch(/☰ menu/);
    // No stray desktop vocabulary on a phone.
    for (const ev of ["cast", "linger"] as OnrampEvent[]) {
      const line = o.note(ev, 1)!;
      expect(line).not.toMatch(/WASD|click|mouse/i);
    }
  });

  it("teaches where the game takes over: floor 2's glyph socket is the handoff", () => {
    expect(desktop().note("cast", 1)).toMatch(/GLYPH SOCKET/);
    expect(desktop().note("linger", 1)).toMatch(/stairs/i);
  });
});
