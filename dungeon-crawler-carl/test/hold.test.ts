/**
 * THE HOLD (TUTORIAL.md r14) — the pause contract's pure half.
 *
 * The owner played the integrated build and reversed HANDOFF §3a's delivery
 * law: *"the tutorial would actually involve pauses of the game and you'd have
 * to go through them (or could dismiss him) so people actually read ... no one
 * reads long text while they're actively fighting in an ARPG."*
 *
 * These tests hold the four bodies of law that verdict implies:
 *
 *  1. WHEN THE TAPE MAY BE STOPPED. A hold is a SCHEDULED beat that waits for a
 *     lull and DEMOTES rather than forcing a pause into a fight. The lull gate
 *     is also what buys a safe resume, so every clause of it is a test.
 *  2. HOW A BEAT IS STEPPED THROUGH. One line, one page; a dwell floor that
 *     swallows the input of a player who was mid-combat when the world stopped;
 *     no timer ever advancing anything.
 *  3. DISMISSAL IS THREE VERBS AT THREE SCOPES, and the destructive one is a
 *     MODALITY refusal — it demotes the delivery and never touches the
 *     curriculum.
 *  4. THE TWO-VOICE BINDING RULE SURVIVES THE NEW SURFACE. The pause mechanism
 *     inherited the riddle fix's prose shape rather than inventing one: a
 *     step's hold pages along the instruction/wry seam that test/coach.test.ts
 *     already holds.
 */
import { describe, expect, it } from "vitest";
import {
  HOLD_CAMPFIRE_KEY, HOLD_DEADLINE_MS, HOLD_DWELL_MS, HOLD_LOW_HP, HOLD_LULL_TILES,
  HOLD_MAX_SESSION, HOLD_NOHOLD_KEY, HOLD_REFUSE_ASK, HOLD_REFUSE_DONE,
  HOLD_REFUSE_LABEL, HOLD_REFUSE_SAFE, HOLD_REFUSE_TAKE, HOLD_RESUME_KEY,
  HOLD_SAFEROOM_KEY, HOLD_STEPS, HOLD_STEP_KEYS, HoldPager, HoldScheduler,
  OBJ_HOLD_HANDOFF, OBJ_HOLD_PAGE_TARGETS, OBJ_HOLD_TARGETS,
  advanceLabel, decodeHoldResume, encodeHoldResume, holdKeyForGuide, holdKeyForStep,
  linesHoldPages, lullOk, objHoldPages,
  type HoldWorld,
} from "../src/ui/hold";
import { OBJ_INTRO_BEATS, OBJ_INTRO_PAGES } from "../src/ui/coach";
import { OBJ_STEP_IDS } from "../src/ui/objectives";
import { GUIDE_BEATS, GUIDE_SKIP_KEY } from "../src/ui/guide";

/** A quiet corridor: nothing in reach, full health, nothing on the glass. */
const CALM: HoldWorld = {
  playing: true, net: false, nearestMonster: Infinity, encounter: false,
  modal: false, hpFrac: 1, collapse: false,
};
const world = (o: Partial<HoldWorld> = {}): HoldWorld => ({ ...CALM, ...o });

describe("the lull gate — a hold never lands mid-swing", () => {
  it("a quiet room is a lull", () => {
    expect(lullOk(CALM)).toBe(true);
  });

  it("a monster inside HOLD_LULL_TILES is not", () => {
    // Deliberately much wider than the coach's COACH_CONTACT_TILES (3): three
    // tiles is "already being hit", and stopping the tape there steals the
    // fight and hands back a frame the player eats a hit in.
    expect(HOLD_LULL_TILES).toBeGreaterThan(3);
    expect(lullOk(world({ nearestMonster: HOLD_LULL_TILES }))).toBe(false);
    expect(lullOk(world({ nearestMonster: HOLD_LULL_TILES - 4 }))).toBe(false);
    expect(lullOk(world({ nearestMonster: HOLD_LULL_TILES + 0.1 }))).toBe(true);
  });

  it("a losing crawler is not — the surface that owns the screen is not blind to danger", () => {
    // r13's severity-4 finding was "the teaching channel is blind to danger
    // state — inventory prose at 19% HP with 0:10 on the collapse clock".
    expect(lullOk(world({ hpFrac: HOLD_LOW_HP }))).toBe(false);
    expect(lullOk(world({ hpFrac: 0.2 }))).toBe(false);
    expect(lullOk(world({ hpFrac: HOLD_LOW_HP + 0.01 }))).toBe(true);
  });

  it("an encounter, a modal, a collapse and a dead run are each disqualifying", () => {
    expect(lullOk(world({ encounter: true }))).toBe(false);
    expect(lullOk(world({ modal: true }))).toBe(false); // two nested pauses is one too many
    expect(lullOk(world({ collapse: true }))).toBe(false);
    expect(lullOk(world({ playing: false }))).toBe(false);
  });

  it("IN CO-OP THERE IS NO HOLD, EVER", () => {
    // The server sim is authoritative and shared: pausing one client would not
    // desync anything, it would leave that player standing still while monsters
    // hit them. A pause that does not pause the world is a blindfold.
    expect(lullOk(world({ net: true }))).toBe(false);
  });
});

describe("the scheduler — hold, wait, or demote", () => {
  it("a due beat waits for a lull and then opens", () => {
    const s = new HoldScheduler();
    expect(s.request("hold.a")).toBe("queued");
    expect(s.tick(world({ nearestMonster: 2 }), 500).open).toBeNull();
    expect(s.holding).toBe(false);
    expect(s.tick(CALM, 500).open).toBe("hold.a");
    expect(s.holding).toBe(true);
  });

  it("a beat that never finds a lull DEMOTES at the deadline instead of forcing a pause", () => {
    // A player in continuous combat for twenty-five seconds is having a fine
    // time and does not need the tape stopped.
    const s = new HoldScheduler();
    s.request("hold.a");
    const fight = world({ nearestMonster: 2 });
    let out = s.tick(fight, HOLD_DEADLINE_MS - 1000);
    expect(out.demote).toEqual([]);
    out = s.tick(fight, 2000);
    expect(out.demote).toEqual(["hold.a"]);
    expect(out.open).toBeNull();
    // ...and it is gone: a demoted beat is delivered, not owed twice.
    expect(s.tick(CALM, 1000).open).toBeNull();
  });

  it("an IMMEDIATE beat skips the lull but not the world", () => {
    // obj.move's intro at second zero, before anything is in range: floor 1
    // opens quiet by construction and there is no lull to wait for.
    const s = new HoldScheduler();
    s.request("hold.move", true);
    expect(s.tick(world({ nearestMonster: 1 }), 16).open).toBe("hold.move");
    const t = new HoldScheduler();
    t.request("hold.move", true);
    expect(t.tick(world({ modal: true }), 16).open).toBeNull();
    // ...and it never expires: it is the one beat with nothing else to do.
    expect(t.tick(world({ modal: true }), HOLD_DEADLINE_MS * 3).demote).toEqual([]);
  });

  it("no beat may share a frame with another: one hold at a time", () => {
    const s = new HoldScheduler();
    s.request("hold.a");
    s.request("hold.b");
    expect(s.tick(CALM, 100).open).toBe("hold.a");
    expect(s.tick(CALM, 100).open).toBeNull();
    s.setHolding(false);
    expect(s.tick(CALM, 100).open).toBe("hold.b");
  });

  it("SIX HOLDS IN A FIRST SESSION IS A HARD CAP, and the seventh demotes", () => {
    // The campfire B0 plus the five objective-step introductions. The number is
    // defensible, not measured — see the module header.
    expect(HOLD_MAX_SESSION).toBe(1 + OBJ_STEP_IDS.length);
    const s = new HoldScheduler();
    for (let i = 0; i < HOLD_MAX_SESSION; i++) {
      s.request(`hold.${i}`);
      expect(s.tick(CALM, 50).open).toBe(`hold.${i}`);
      s.setHolding(false);
    }
    expect(s.openedCount).toBe(HOLD_MAX_SESSION);
    expect(s.request("hold.extra")).toBe("demote");
  });

  it("the campfire's out-of-band open still counts against the cap and still obeys the refusal", () => {
    const s = new HoldScheduler();
    expect(s.take(HOLD_CAMPFIRE_KEY)).toBe(true);
    expect(s.openedCount).toBe(1);
    expect(s.holding).toBe(true);
    const refused = new HoldScheduler({ refused: true });
    expect(refused.take(HOLD_CAMPFIRE_KEY)).toBe(false);
    const coop = new HoldScheduler({ net: true });
    expect(coop.take(HOLD_CAMPFIRE_KEY)).toBe(false);
  });

  it("under net every beat demotes on request — ONE demotion mechanism, not a special case", () => {
    const s = new HoldScheduler({ net: true });
    expect(s.request("hold.a")).toBe("demote");
    expect(s.tick(CALM, 1000).open).toBeNull();
  });

  it("a refusal hands every pending beat to the strip at once rather than letting them rot", () => {
    const s = new HoldScheduler();
    s.request("hold.a");
    s.request("hold.b");
    s.refuse();
    const out = s.tick(CALM, 16);
    expect(out.open).toBeNull();
    expect(out.demote.sort()).toEqual(["hold.a", "hold.b"]);
    expect(s.request("hold.c")).toBe("demote");
  });

  it("a beat the world moved past is DROPPED, not demoted", () => {
    const s = new HoldScheduler();
    s.request("hold.a");
    s.drop("hold.a");
    expect(s.pendingKeys).toEqual([]);
    expect(s.tick(CALM, 16)).toEqual({ open: null, demote: [] });
  });
});

describe("the pager — the player steps through, and nothing else does", () => {
  const pages = linesHoldPages(["one", "two", "three"]);

  it("ONE LINE = ONE PAGE", () => {
    expect(pages.length).toBe(3);
    expect(pages.map((p) => p.text)).toEqual(["one", "two", "three"]);
  });

  it("the dwell floor SWALLOWS input — a mashed Space cannot blow through a beat", () => {
    // The specific accident this defends against: a player mid-combat who was
    // holding Space when the world paused would otherwise consume an entire
    // beat in one frame and never know it existed.
    const p = new HoldPager(pages);
    expect(p.ready).toBe(false);
    expect(p.advance()).toBe("swallowed");
    expect(p.index).toBe(0);
    p.tick(HOLD_DWELL_MS - 1);
    expect(p.advance()).toBe("swallowed");
    p.tick(2);
    expect(p.ready).toBe(true);
    expect(p.advance()).toBe("next");
    expect(p.index).toBe(1);
  });

  it("the flush is paid again on EVERY page, not once per beat", () => {
    const p = new HoldPager(pages);
    p.tick(HOLD_DWELL_MS);
    expect(p.advance()).toBe("next");
    expect(p.ready).toBe(false);
    expect(p.advance()).toBe("swallowed");
  });

  it("no timer advances a page: there is a minimum dwell and never a maximum", () => {
    const p = new HoldPager(pages);
    p.tick(HOLD_DWELL_MS * 1000);
    expect(p.index).toBe(0); // still page one after sixteen minutes
    expect(p.advance()).toBe("next");
  });

  it("the last page ENDS rather than paging into nothing, and says so", () => {
    const p = new HoldPager(pages);
    for (let i = 0; i < 2; i++) { p.tick(HOLD_DWELL_MS); expect(p.advance()).toBe("next"); }
    expect(p.last).toBe(true);
    p.tick(HOLD_DWELL_MS);
    expect(p.advance()).toBe("end");
  });

  it("the advance affordance is LABELLED, and the last one is labelled differently", () => {
    // A player who does not know a press is owed is a player stuck in a paused
    // game — strictly worse than the bug this feature fixes.
    expect(advanceLabel(false)).toContain("SPACE");
    expect(advanceLabel(true)).toContain("BACK TO IT");
    expect(advanceLabel(true)).not.toBe(advanceLabel(false));
  });

  it("seek restores a saved page and re-arms that page's flush", () => {
    const p = new HoldPager(pages);
    p.seek(2);
    expect(p.index).toBe(2);
    expect(p.ready).toBe(false);
    p.seek(99);
    expect(p.index).toBe(2); // clamped: a saved page can outlive its beat's edits
    p.seek(-3);
    expect(p.index).toBe(0);
  });
});

describe("a refresh mid-lesson does not eat the lesson", () => {
  it("the resume record round-trips", () => {
    const raw = encodeHoldResume({ key: "hold.obj.five", page: 2 });
    expect(decodeHoldResume(raw)).toEqual({ key: "hold.obj.five", page: 2 });
  });

  it("garbage, absence and a missing key all decode to nothing rather than to a lie", () => {
    expect(decodeHoldResume(null)).toBeNull();
    expect(decodeHoldResume("")).toBeNull();
    expect(decodeHoldResume("{oh no")).toBeNull();
    expect(decodeHoldResume('{"page":3}')).toBeNull();
    expect(decodeHoldResume('{"key":"hold.a"}')).toEqual({ key: "hold.a", page: 0 });
    expect(decodeHoldResume('{"key":"hold.a","page":-4}')).toEqual({ key: "hold.a", page: 0 });
  });

  it("it rides its OWN browser key — never the tips ledger, which means something else", () => {
    // The tips ledger is a once-EVER record of what has been shown. A page
    // number is not a lesson; putting it there would make an interrupted read
    // indistinguishable from a delivered one.
    expect(HOLD_RESUME_KEY).toMatch(/^dcc:/);
    expect(HOLD_RESUME_KEY).not.toBe("dcc:tips:v1");
  });
});

describe("dismissal — three verbs, three scopes, three controls", () => {
  it("THE REFUSAL IS A MODALITY REFUSAL, NOT A CURRICULUM REFUSAL", () => {
    // GUIDE_SKIP_KEY silences EVERYTHING — guide beats, the coach strip, the
    // tip translations, the objectives curriculum. This key demotes the
    // DELIVERY and changes nothing else: the checklist stays and Mordecai keeps
    // teaching in the channel that already ships. Conflating the two is how
    // "stop interrupting me" would become "delete the tutorial".
    expect(HOLD_NOHOLD_KEY).not.toBe(GUIDE_SKIP_KEY);
    const s = new HoldScheduler({ refused: true });
    // Everything it does is demote. There is no curriculum surface on it at all.
    expect(s.request("hold.a")).toBe("demote");
    expect(Object.keys(s)).not.toContain("steps");
  });

  it("the total curriculum skip stays exactly where it already is: B0's campfire", () => {
    const skip = GUIDE_BEATS["tut.campfire"].choices.find((c) => c.effect === "skipAll");
    expect(skip).toBeTruthy();
    expect(skip!.label).toMatch(/skip/i);
  });

  it("the confirmation NAMES ITS UNDO before it takes the answer", () => {
    // A destructive control that does not name its undo is a trap. The undo is
    // the shipped two-press K-panel control, and the sentence says so.
    expect(HOLD_REFUSE_ASK).toMatch(/KEYS/);
    expect(HOLD_REFUSE_ASK).toMatch(/guidance/i);
    // ...and it promises the thing that is actually true: he keeps talking.
    expect(HOLD_REFUSE_ASK).toMatch(/list stays|still talk/i);
  });

  it("the SAFE answer is distinct from the destructive one and reads as the safe one", () => {
    expect(HOLD_REFUSE_SAFE).not.toBe(HOLD_REFUSE_TAKE);
    expect(HOLD_REFUSE_SAFE).toMatch(/^No/);
    expect(HOLD_REFUSE_TAKE).toMatch(/sure/i);
  });

  it("every line of the refusal obeys the register bible: no exclamation marks", () => {
    for (const line of [HOLD_REFUSE_LABEL, HOLD_REFUSE_ASK, HOLD_REFUSE_SAFE,
      HOLD_REFUSE_TAKE, HOLD_REFUSE_DONE]) {
      expect(line, line).not.toContain("!");
      expect(line.trim().length, line).toBeGreaterThan(0);
    }
  });
});

describe("what may hold: instructional beats, and the checklist they hand off to", () => {
  it("the hold set is six, and the safe room's slot belongs to the beat that can use it", () => {
    // r15 amended WHICH six, not how many. `obj.saferoom`'s introduction arms
    // while the crawler is standing at a counter, a counter is a modal, and the
    // lull gate refuses a modal — so its hold could only ever burn the deadline
    // and demote onto a strip the shop panel is covering. B5 fires in the gap
    // between the safe room stopping the world and the panel opening, which is
    // the one paused moment the shelf lesson has, so it took the slot.
    const SET = [HOLD_CAMPFIRE_KEY, HOLD_SAFEROOM_KEY, ...HOLD_STEPS.map(holdKeyForStep)];
    expect(SET.length).toBe(HOLD_MAX_SESSION);
    expect(new Set(SET).size).toBe(HOLD_MAX_SESSION); // six distinct deliveries
    expect(HOLD_STEPS).not.toContain("obj.saferoom");
    expect(HOLD_STEPS.length).toBe(OBJ_STEP_IDS.length - 1);
    // ...and a guide beat's hold key is built the same way a step's is, so the
    // resume record and the scheduler cannot tell them apart.
    expect(HOLD_CAMPFIRE_KEY).toBe(holdKeyForGuide("tut.campfire"));
    expect(HOLD_SAFEROOM_KEY).toBe(holdKeyForGuide("tut.saferoom"));
    for (const id of OBJ_STEP_IDS) expect(HOLD_STEP_KEYS).toContain(holdKeyForStep(id));
  });

  it("a hold key is never a ledger id — a delivery is not a curriculum entry", () => {
    // Conflating them is how a dropped card once spent a step it never painted.
    for (const k of HOLD_STEP_KEYS) expect(OBJ_STEP_IDS as readonly string[]).not.toContain(k);
  });

  it("every step declares what its first page points at", () => {
    for (const id of OBJ_STEP_IDS) expect(OBJ_HOLD_TARGETS[id]).toBeTruthy();
  });

  it("THE TWO-VOICE BINDING RULE SURVIVES THE PAUSE: page one is the instruction, alone", () => {
    // The pause mechanism did not invent a prose format. The riddle fix already
    // splits every teaching beat into `instruction` (exactly one imperative
    // sentence, the key in it) and `wry` (the register, never the key), and
    // THAT SEAM IS THE PAGE BREAK. A player who reads one page has the
    // instruction; a player who reads both has Mordecai.
    //
    // r15 put the pages a PAUSE can afford between them (OBJ_INTRO_PAGES) —
    // which changes neither end of the seam: the instruction is still first and
    // still alone, and the quip is still last.
    for (const id of OBJ_STEP_IDS) {
      const beat = OBJ_INTRO_BEATS[id];
      const pages = objHoldPages(id, beat);
      expect(pages.length, id).toBe(2 + OBJ_INTRO_PAGES[id].length);
      expect(pages[0].text, id).toBe(beat.instruction);
      expect(pages[pages.length - 1].text, id).toBe(beat.wry);
      expect(pages.slice(1, -1).map((p) => p.text), id).toEqual([...OBJ_INTRO_PAGES[id]]);
      // Sentence one is still exactly one sentence, on its own page.
      expect(pages[0].text, id).toMatch(/^[^.!?]+\.$/);
    }
  });

  it("the first page points at the thing it names; the LAST page hands off to the checklist", () => {
    // §8: the card is the hold's continuity. The hold explains; the card
    // remembers — and pointing at it on the way out is what turns the checklist
    // from furniture into something the player was introduced to.
    for (const id of OBJ_STEP_IDS) {
      const pages = objHoldPages(id, OBJ_INTRO_BEATS[id]);
      expect(pages[0].target, id).toEqual(OBJ_HOLD_TARGETS[id]);
      expect(pages[pages.length - 1].target, id).toEqual(OBJ_HOLD_HANDOFF);
    }
    expect(OBJ_HOLD_HANDOFF).toEqual({ kind: "hud", id: "objectives" });
  });

  it("EVERY page a pause pays for is pointed at something (r15)", () => {
    // Pointing is the whole argument for pausing: "press this, over there" is
    // followable only while nothing is moving. A middle page with no target
    // declared would silently fall back to pointing nowhere — which is a page
    // that could just as well have been a strip card.
    for (const id of OBJ_STEP_IDS) {
      const targets = OBJ_HOLD_PAGE_TARGETS[id];
      expect(targets.length, `${id} page targets`).toBe(OBJ_INTRO_PAGES[id].length);
      const pages = objHoldPages(id, OBJ_INTRO_BEATS[id]);
      pages.slice(1, -1).forEach((p, i) => {
        expect(p.target, `${id} page ${i + 1}`).toEqual(targets[i]);
        expect(p.target.kind, `${id} page ${i + 1}`).not.toBe("none");
      });
    }
    // The one page that points INTO THE WORLD is the descent — the lesson two
    // of four cold deaths died without (r11: "zero wayfinding").
    expect(OBJ_HOLD_PAGE_TARGETS["obj.payday"]).toContainEqual({ kind: "world", what: "stairs" });
  });

  it("a wry-less beat still ends on the checklist rather than pointing nowhere", () => {
    const pages = objHoldPages("obj.move", {
      verb: "Move", needsKey: false, instruction: "Move out.",
    }, []);
    expect(pages.length).toBe(1);
    expect(pages[0].target).toEqual(OBJ_HOLD_HANDOFF);
  });

  it("the two guide holds page their shipped lines and point at nothing", () => {
    // B0 is a conversation at a campfire with no dungeon behind it; B5 fires in
    // the beat before the shop panel it is about has opened. Neither has
    // anything on the glass to ring, and their last page carries the beat's own
    // numbered choices, which are the hand-off.
    for (const key of ["tut.campfire", "tut.saferoom"] as const) {
      const pages = linesHoldPages(GUIDE_BEATS[key].lines);
      expect(pages.length, key).toBe(GUIDE_BEATS[key].lines.length);
      expect(pages.length, key).toBeGreaterThan(1); // a one-page hold is a card with extra steps
      for (const p of pages) expect(p.target, key).toEqual({ kind: "none" });
    }
  });

  it("B0's own middle page teaches the interruption it is an example of (r15)", () => {
    // A player is about to be stopped five more times by a man they have met
    // once. The honest place to say so is inside the first interruption, which
    // is the only one that costs them nothing — and it must name the two
    // controls the panel advertises, or the first pause in a corridor reads as
    // a crash rather than as a promise being kept.
    const lines = GUIDE_BEATS["tut.campfire"].lines.join(" ");
    expect(lines).toMatch(/stop the clock/i);
    expect(lines).toMatch(/\bSpace\b/);
    expect(lines).toMatch(/\bEsc\b/);
  });
});
