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

  it("safe rooms: one beat per visit, B5 → B7 → B6 in priority order (r4)", () => {
    const g = new Guide();
    // Visit 1: everything eligible at once — B5 still wins, alone.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.saferoom");
    // Visit 2: THE SCARCE BEAT GETS THE SCARCE OPPORTUNITY. B7 needs a socket,
    // a safe room and a glyph in hand all at once — the r3 critic never
    // assembled that once in three cold runs — while B6 is eligible at every
    // later visit for the rest of the run. Ordering B6 first is how B7 stayed
    // theoretical.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.glyphs");
    // Visit 3: the Show debrief, which lost nothing but a visit.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.show");
    // Visit 4: nothing left to say.
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })).toBeNull();
  });

  it("B6 still waits for the Show even when it now outranks nothing", () => {
    // Reordering must not let the debrief overtake the demonstration.
    const g = new Guide(["tut.saferoom"]);
    expect(g.safeRoomBeat({ showMet: false, glyphReady: false })).toBeNull();
    expect(g.safeRoomBeat({ showMet: false, glyphReady: true })?.key).toBe("tut.glyphs");
    expect(g.safeRoomBeat({ showMet: true, glyphReady: true })?.key).toBe("tut.show");
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

  it("B6's own name for a Show fact is never the System's name for it", () => {
    // The division-of-labor rule, at the one seam that broke: the System's
    // `sponsors` tip owns the economic chain (hype → favorites → sponsors →
    // gifts between floors). B6 may not restate any link in it.
    const b6 = GUIDE_BEATS["tut.show"].lines.join(" ");
    for (const word of ["favorite", "sponsor", "viewer", "gift", "hype"]) {
      expect(b6.toLowerCase()).not.toContain(word);
    }
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

  // The verbatim check above was green through r3 and still let B6 restate the
  // `sponsors` tip nearly clause-for-clause ("sponsors pay YOU, in gear,
  // between floors" against "sponsors send gifts between floors"). A paraphrase
  // is not a quotation, so quotation-matching cannot see it. This is the
  // coarser instrument that can: two lines about the same MECHANISM converge
  // on the same content words, and the division-of-labor rule says only one
  // voice per mechanism. Domain nouns are not exempted on purpose — if
  // Mordecai needs three of a tip's words to make his point, his point IS the
  // tip's point, and the fix is to find the thing the System will never say.
  const PARAPHRASE_LIMIT = 3;
  const content = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w)));
  const STOP = new Set([
    "that", "this", "with", "your", "yours", "will", "have", "from", "they", "them", "then",
    "than", "what", "when", "were", "been", "into", "just", "only", "does", "doesn't", "them",
    "come", "back", "make", "made", "take", "took", "keep", "kept", "here", "there", "some",
    "much", "more", "most", "same", "very", "also", "over", "after", "before", "about", "like",
    "want", "know", "good", "well", "every", "still", "never", "always", "nothing", "anything",
    "something", "everything", "one", "two", "their", "which", "would", "could", "should",
  ]);

  it("no beat paraphrases a System tip's mechanism (r4 blocker: B6)", () => {
    for (const [id, tip] of Object.entries(TIPS)) {
      const tw = content(tip.replace(/^COURTESY EXPLANATION:\s*/, ""));
      for (const line of beatText) {
        const shared = [...content(line)].filter((w) => tw.has(w));
        expect(
          shared.length,
          `beat line shares ${shared.length} content words with the "${id}" tip `
          + `(${shared.join(", ")}) — the System owns that mechanism:\n  ${line}`,
        ).toBeLessThan(PARAPHRASE_LIMIT);
      }
    }
  });
});

describe("the System never points at the player's chrome (r4 voice)", () => {
  // "banked on the DRAFT badge at the bottom of your HUD" — the System audits
  // ledgers and posts notices; it has never conceded that you have furniture.
  // Its lines name rules, its own instruments, and places in the dungeon.
  it("no tip names a HUD, a badge, a bar, a screen or a panel of yours", () => {
    for (const [id, tip] of Object.entries(TIPS)) {
      expect(tip, id).not.toMatch(/\bHUD\b/i);
      expect(tip, id).not.toMatch(/\bbadge\b/i);
      expect(tip, id).not.toMatch(/\byour (screen|display|panel|bar|interface)\b/i);
      expect(tip, id).not.toMatch(/\b(top|bottom|corner) of (your|the) (screen|HUD|display)\b/i);
    }
  });

  it("no tip glosses a keybind in parentheses like a manual", () => {
    for (const [id, tip] of Object.entries(TIPS)) {
      expect(tip, id).not.toMatch(/\([A-Z]\)/);
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
