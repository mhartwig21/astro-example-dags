/**
 * THE GUIDE (TUTORIAL.md): the pure beat sequencer — sim facts in, at most
 * one never-before-seen beat out. These tests hold the doc's binding rules:
 * once EVER per beat, one beat per surface visit, the System demonstrates
 * before Mordecai debriefs (B6), socketing must be POSSIBLE before B7, and
 * the global skip consumes everything.
 *
 * RESCOPED by the tutorial rebuild (ONE VOICE): the old "two voices never
 * share a line" tests now bind the MODAL surface only. Mordecai teaches
 * mechanics on the STRIP by design (src/ui/coach.ts — test/coach.test.ts
 * asserts coverage there); what stays forbidden HERE is the modal beats
 * restating the sim TIPS' mechanism text — the modal is judgement, the strip
 * is instruction, and no line may live on both sides of that seam.
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

  it("the global skip consumes every beat and silences every surface", () => {
    const g = new Guide();
    const keys = g.skipAll();
    expect(new Set(keys)).toEqual(new Set([...GUIDE_BEAT_KEYS, GUIDE_SKIP_KEY]));
    expect(g.skipped).toBe(true); // coachObserve/objectivesObserve read this: no more lines
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

describe("a beat is spent when it PAINTS (r5 blocker 1)", () => {
  // maybeShowRecap took B8 and wrote the ledger, THEN scheduled the 620ms
  // reveal whose own first line stands down if a fast R already started the
  // next run. Measured from a cold profile: ledger=[tut.campfire,tut.runback],
  // verdict frames 0, aside frames 0 — B8 deleted from that profile forever by
  // one impatient keypress, with the plate never once on the glass.
  it("an offered beat that is RELEASED is offerable again", () => {
    const g = new Guide();
    expect(g.verdictLine()).toBe(GUIDE_BEATS["tut.runback"].lines[0]);
    expect(g.verdictLine()).toBeNull(); // in flight — never offered twice
    g.release("tut.runback");
    expect(g.verdictLine()).toBe(GUIDE_BEATS["tut.runback"].lines[0]);
  });

  it("an offered beat that is COMMITTED never comes back", () => {
    const g = new Guide();
    expect(g.campfire()?.key).toBe("tut.campfire");
    g.commit("tut.campfire");
    expect(g.campfire()).toBeNull();
    g.release("tut.campfire"); // a late refusal must not un-show a shown beat
    expect(g.campfire()).toBeNull();
  });

  it("the panel refusing a beat costs nothing: the next rest moment gets it", () => {
    // guideShow declines while another beat or a Roam conversation owns the
    // panel; every one of those paths hands the beat back.
    const g = new Guide();
    expect(g.safeRoomBeat({ showMet: true, glyphReady: false })?.key).toBe("tut.saferoom");
    g.release("tut.saferoom");
    expect(g.safeRoomBeat({ showMet: true, glyphReady: false })?.key).toBe("tut.saferoom");
  });

  it("the global skip outranks every offer still in flight", () => {
    const g = new Guide();
    expect(g.draftOpen()?.key).toBe("tut.draft");
    g.skipAll();
    g.release("tut.draft"); // the offer comes back mid-skip...
    expect(g.draftOpen()).toBeNull(); // ...and stays silenced anyway
  });
});

describe("guide: THE MODAL SURFACE — judgement, never the System's text (rescoped)", () => {
  // These tests bind GUIDE_BEATS (the #dialogue modal) and ONLY that surface.
  // The strip (src/ui/coach.ts) deliberately names mechanisms and keys — its
  // inverse rule lives in test/coach.test.ts. A line moved between surfaces
  // changes which law applies; the surface is named here so a green suite
  // stays green about the right thing.
  const beatText = Object.values(GUIDE_BEATS).flatMap((b) => [
    ...b.lines,
    ...b.choices.flatMap((c) => (c.reply ? [c.reply] : [])),
  ]);

  it("no modal line wears the dead COURTESY ribbon or the announcer register", () => {
    for (const line of beatText) {
      expect(line).not.toMatch(/COURTESY EXPLANATION/);
      expect(line).not.toMatch(/^NOTICE:/);
      expect(line).not.toMatch(/!/); // register bible: no exclamation marks
    }
  });

  it("no System tip text ever reaches the MODAL surface, verbatim or trimmed", () => {
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
  // on the same content words, and only one surface owns a mechanism. The
  // STRIP (coach.ts) owns mechanism now — so a MODAL beat needing three of a
  // tip's content words means his modal point IS the strip's point, and the
  // fix is still the same: the modal says the thing the mechanism line will
  // never say (what it costs you, and why you should pay it anyway).
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

  it("no MODAL beat paraphrases a sim tip's mechanism (r4 blocker: B6; modal-only law)", () => {
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
