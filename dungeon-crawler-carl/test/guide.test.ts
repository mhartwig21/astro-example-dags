/**
 * THE GUIDE (TUTORIAL.md): the pure beat sequencer — sim facts in, at most
 * one never-before-seen beat out. These tests hold the doc's binding rules:
 * once EVER per beat, one beat per surface visit, the System demonstrates
 * before Mordecai debriefs (B6), socketing must be POSSIBLE before B7, the
 * global skip consumes everything, and the two voices never share a line.
 */
import { describe, expect, it } from "vitest";
import {
  GUIDE_BEATS, GUIDE_BEAT_KEYS, GUIDE_SKIP_KEY, Guide,
} from "../src/ui/guide";
import { TIPS } from "../src/sim/tips";

describe("guide: once-ever beats on the shipped ledger pattern", () => {
  it("B0 campfire fires once, then never again", () => {
    const g = new Guide();
    expect(g.campfire()?.key).toBe("tut.campfire");
    expect(g.campfire()).toBeNull();
  });

  it("a beat already on the ledger never replays (cross-session)", () => {
    const g = new Guide(["tut.campfire", "tut.draft"]);
    expect(g.campfire()).toBeNull();
    expect(g.draftOpen()).toBeNull();
    expect(g.menuReturn(3)?.key).toBe("tut.menu2"); // unseen beats still live
  });

  it("B3 rides the first draft only", () => {
    const g = new Guide();
    expect(g.draftOpen()?.key).toBe("tut.draft");
    expect(g.draftOpen()).toBeNull();
  });

  it("safe rooms: one beat per visit, B5 → B6 → B7 in priority order", () => {
    const g = new Guide();
    // Visit 1: everything eligible at once — B5 still wins, alone.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.saferoom");
    // Visit 2: the Show debrief; the glyph beat WAITS (one per visit).
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.show");
    // Visit 3: now the glyph beat.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.glyphs");
    // Visit 4: nothing left to say.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })).toBeNull();
  });

  it("B6 never fires Show-naive: the System demonstrates first, Mordecai debriefs after", () => {
    const g = new Guide(["tut.saferoom"]);
    expect(g.safeRoomBeat({ showMet: false, glyphReady: false })).toBeNull();
    expect(g.safeRoomBeat({ showMet: true, glyphReady: false })?.key).toBe("tut.show");
  });

  it("B7 waits until socketing is actually possible — never as theory", () => {
    const g = new Guide(["tut.saferoom", "tut.show"]);
    expect(g.safeRoomBeat({ showMet: true, glyphReady: false })).toBeNull();
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.glyphs");
  });

  it("B8 verdict aside: one line, once ever", () => {
    const g = new Guide();
    const line = g.verdictLine();
    expect(line).toBe(GUIDE_BEATS["tut.runback"].lines[0]);
    expect(g.verdictLine()).toBeNull();
  });

  it("B9 needs a finished run and fires once", () => {
    const g = new Guide();
    expect(g.menuReturn(0)).toBeNull(); // first session: the campfire owns the menu
    expect(g.menuReturn(1)?.key).toBe("tut.menu2");
    expect(g.menuReturn(5)).toBeNull();
  });

  it("the global skip consumes every beat and silences both voices", () => {
    const g = new Guide();
    const keys = g.skipAll();
    expect(new Set(keys)).toEqual(new Set([...GUIDE_BEAT_KEYS, GUIDE_SKIP_KEY]));
    expect(g.skipped).toBe(true); // onrampObserve reads this: no more onramp lines
    expect(g.campfire()).toBeNull();
    expect(g.draftOpen()).toBeNull();
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })).toBeNull();
    expect(g.verdictLine()).toBeNull();
    expect(g.menuReturn(9)).toBeNull();
  });

  it("a persisted skip (ledger) suppresses everything on later sessions too", () => {
    const g = new Guide([GUIDE_SKIP_KEY]);
    expect(g.skipped).toBe(true);
    expect(g.campfire()).toBeNull();
    expect(g.menuReturn(9)).toBeNull();
  });
});

describe("guide: the two voices never sound like each other (TUTORIAL.md B2)", () => {
  const beatText = Object.values(GUIDE_BEATS).flatMap((b) => [
    ...b.lines,
    ...b.choices.flatMap((c) => (c.reply ? [c.reply] : [])),
  ]);

  it("no Mordecai line wears the System's ribbon or register", () => {
    for (const line of beatText) {
      expect(line).not.toMatch(/COURTESY EXPLANATION/);
      expect(line).not.toMatch(/^NOTICE:/);
      expect(line).not.toMatch(/!/); // register bible: no exclamation marks
    }
  });

  it("no System tip text ever reaches the dialogue surface, verbatim or trimmed", () => {
    for (const tip of Object.values(TIPS)) {
      const body = tip.replace(/^COURTESY EXPLANATION:\s*/, "");
      for (const line of beatText) {
        expect(line).not.toContain(body.slice(0, 40));
      }
    }
  });

  it("every beat's last choice is a farewell (skip is one obvious input away)", () => {
    for (const beat of Object.values(GUIDE_BEATS)) {
      if (beat.choices.length === 0) continue; // B8 is an aside plate, no input cost
      const last = beat.choices[beat.choices.length - 1];
      // B0's list ends on the global skip, which leaves a single farewell
      // behind; everywhere else the last choice closes or opens-through.
      expect(["close", "open", "skipAll"]).toContain(last.effect);
    }
  });
});
