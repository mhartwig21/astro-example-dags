/**
 * THE ONRAMP (NICHE.md 4.4): a cold stranger's first five minutes, held to
 * the doc's exact constraints — ≤6 System lines, each once, floor 1 only,
 * touch names the actual touch controls, desktop names the live binds.
 */
import { describe, it, expect } from "vitest";
import { Onramp, ONRAMP_MAX_LINES, type OnrampEvent } from "../src/ui/onramp";

const desktop = (): Onramp =>
  new Onramp(false, { move: "WASD", attack: "Left click", cast: "1–4", flask: "X" });
const phone = (): Onramp =>
  new Onramp(true, { move: "WASD", attack: "Left click", cast: "1–4", flask: "X" });

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
  it("desktop names the binds it was handed", () => {
    const o = new Onramp(false, { move: "ESDF", attack: "Left click", cast: "1–4", flask: "H" });
    expect(o.note("start", 1)).toContain("ESDF");
    expect(o.note("moved", 1)).toContain("1–4");
    expect(o.note("lowhp", 1)).toContain("H drinks the flask");
  });

  it("touch names the glass and the chips, never a keyboard", () => {
    const o = phone();
    expect(o.note("start", 1)).toMatch(/LEFT HALF of the glass/);
    expect(o.note("moved", 1)).toMatch(/STRIKE chip/);
    expect(o.note("lowhp", 1)).toMatch(/FLASK chip/);
    // No stray desktop vocabulary on a phone.
    for (const ev of ["cast", "pickup", "linger"] as OnrampEvent[]) {
      const line = o.note(ev, 1)!;
      expect(line).not.toMatch(/WASD|click|mouse/i);
    }
  });

  it("teaches where the game takes over: floor 2's glyph socket is the handoff", () => {
    expect(desktop().note("cast", 1)).toMatch(/GLYPH SOCKET/);
    expect(desktop().note("linger", 1)).toMatch(/stairs/i);
  });
});
