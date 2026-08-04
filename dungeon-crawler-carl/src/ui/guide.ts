/**
 * THE GUIDE (TUTORIAL.md): Mordecai's once-ever first-session beats.
 *
 * The reconciliation in one line: the System teaches the controls in the
 * moment (THE ONRAMP + sim tips, both shipped); Mordecai teaches the game at
 * rest — campfire, the first draft pause, safe rooms, the verdict, the second
 * check-in. He never speaks over live combat, never rides the announcer
 * channel, and never pre-explains a rule the System is about to demonstrate.
 *
 * Structure copied from the Onramp mold: a pure module — facts in, at most
 * one beat out per call, unit-testable without a DOM. The host renders beats
 * through the SHIPPED #dialogue presentation (portrait, typewriter, numbered
 * choices, ESC farewell) and persists shown beats on the SHIPPED tips ledger
 * (persist/save.ts `dcc:tips:v1` via recordTips) — extended, never duplicated.
 * A beat is ledgered the moment it is SHOWN (shown = consumed, the tips
 * convention): it never replays, even after a skip.
 *
 * "Shown" means SHOWN (r5). The sequencer OFFERS a beat and waits: `commit`
 * spends it when the panel (or, for B8, the aside plate) is actually on the
 * glass, `release` hands it back when the host declined to paint. r4 spent the
 * beat at the ask, and a cold profile that pressed R 15ms after dying had B8
 * ledgered with the plate never rendered — the beat deleted from that profile
 * forever, in Mordecai's voice, by exactly the defect the ONRAMP had just
 * closed in the System's.
 *
 * Voice rules, binding (TUTORIAL.md §4): short declaratives; wry, never
 * breathless; protective under the gruffness; no exclamation marks; he says
 * "you" and means the person. No Mordecai line may contain "COURTESY
 * EXPLANATION" and no TIPS line may ever reach this module — the two-voice
 * test in test/guide.test.ts holds that line.
 */

/** Once-ever ledger keys. `tut.*` rides the browser tips ledger and flows
 *  into new characters via the shipped seedTips, whence account convergence. */
export type GuideBeatKey =
  | "tut.campfire" // B0 — the campfire intro (organic cold profiles only)
  | "tut.draft"    // B3 — the first draft
  | "tut.saferoom" // B5 — the first safe room
  | "tut.show"     // B6 — the honest version of the Show (debrief, never preview)
  | "tut.glyphs"   // B7 — the first glyph (fires only when socketing is possible)
  | "tut.runback"  // B8 — the verdict aside (death is tuition)
  | "tut.menu2";   // B9 — the second check-in (the menu has doors too)

/** The global skip (B0 choice 3): every beat ledgered + the onramp silenced. */
export const GUIDE_SKIP_KEY = "tut.skipAll";

export const GUIDE_BEAT_KEYS: readonly GuideBeatKey[] = [
  "tut.campfire", "tut.draft", "tut.saferoom", "tut.show",
  "tut.glyphs", "tut.runback", "tut.menu2",
];

export interface GuideChoice {
  id: string;
  label: string;
  /**
   * reply    — Mordecai answers (`reply` text), then returns to the choices;
   *            the asked question is consumed.
   * close    — farewell; the beat's surface proceeds (always last in the list,
   *            and ESC is its keyboard twin everywhere).
   * open     — farewell INTO a surface: the host arms the named panel/tab.
   * skipAll  — B0 only: ledger every beat + silence the remaining onramp
   *            lines, answer with `reply`, then only a close remains.
   */
  effect: "reply" | "close" | "open" | "skipAll";
  reply?: string;
  open?: "draft" | "shop" | "bench";
}

export interface GuideBeat {
  key: GuideBeatKey;
  lines: string[];
  choices: GuideChoice[];
}

// The beat table as DATA (TUTORIAL.md §3, lines verbatim).
export const GUIDE_BEATS: Record<GuideBeatKey, GuideBeat> = {
  "tut.campfire": {
    key: "tut.campfire",
    lines: [
      "Name's Mordecai. I managed crawlers before the dungeon ate my license. Now I mind the fires and try to keep a few of you alive past the first week.",
      "The System talks a lot down there. Listen to WHAT it says, never HOW it says it. I'll be at the safe rooms when you want an answer from someone with a pulse.",
    ],
    choices: [
      {
        id: "whatfor", label: "What am I in for?", effect: "reply",
        reply: "Eighteen floors, every one on a clock. Kill fast, loot faster, take the stairs before the ceiling does. Everything past that is detail, and detail keeps.",
      },
      { id: "go", label: "Let's go.", effect: "close" },
      {
        id: "skip", label: "Skip the hand-holding.", effect: "skipAll",
        // "Advice keeps." is kept verbatim — the r3 critic named it as one of
        // the lines that already work. What followed it was the `collapse`
        // tip's own sentence, word for word ("The stairs are down"), which is
        // the System's to say and nobody else's.
        reply: "Fine by me. Advice keeps. Go on, then — you'll pick it up the hard way, same as I did.",
      },
    ],
  },
  "tut.draft": {
    key: "tut.draft",
    lines: [
      "First draft. Everything on the table is real — the lottery isn't rigged, it's just indifferent. Take what changes HOW you fight, not what pads a number. Numbers come free with levels. A new move is a new way out of a bad room.",
    ],
    // ESC does the same as the one choice — there is no way to lose the draft.
    choices: [{ id: "picks", label: "Show me the picks.", effect: "open", open: "draft" }],
  },
  "tut.saferoom": {
    key: "tut.saferoom",
    lines: [
      // r4 voice: line 1 was a panel-affordance list in his idiom — a tooltip
      // wearing a portrait. He doesn't inventory the room; he tells you what
      // the room is FOR, which is the one thing the panel can't.
      "Safe room. Nothing in here is trying to kill you, and that stops being true the second you take those stairs. Sit down. Breathe. It counts as work.",
      "Spend the gold. The exchange rate only gets worse with depth, and nobody's buried with their savings. If you're sitting on a draft, cash it here — nothing's chewing on you for once.",
    ],
    choices: [
      { id: "shop", label: "Open the shop.", effect: "open", open: "shop" },
      { id: "later", label: "Later.", effect: "close" },
    ],
  },
  // B6 DEBRIEFS; IT DOES NOT PARAPHRASE (r4 voice). The old line restated the
  // System's `sponsors` tip nearly clause-for-clause — "sponsors pay YOU, in
  // gear, between floors" against "sponsors send gifts between floors" — which
  // is the division-of-labor rule broken in the one place it was written down.
  // The System owns the mechanism. Mordecai owns the part the System will
  // never say: what it costs you, and why you should pay it anyway.
  "tut.show": {
    key: "tut.show",
    lines: [
      "You've noticed the cameras. Nobody down here will tell you the honest part, so I will: the numbers are not a scoreboard. They are a leash, and it is already on. You will start choosing the loud option because it pays, and one day the loud option will be the stupid one and you'll take it anyway.",
      "Take it on the fights you can afford. Not the ones you can't. I hate it too. It works.",
    ],
    choices: [{ id: "noted", label: "Noted.", effect: "close" }],
  },
  // r4: the mechanism (firmware, one ability, behaviour not size, banks until
  // a socket) now belongs to the System's `glyph` tip, which fires the instant
  // the stone is in hand. What was left over here was a restatement of it, so
  // the beat starts from the thing the System will never file: the reason
  // people fail this system is nerve, not information. The two sentences the
  // r3 critic praised are kept exactly as they were.
  "tut.glyphs": {
    key: "tut.glyphs",
    lines: [
      "Here's what kills builds: people hold the stone back, waiting for the perfect place to put it, and they hit floor six with it still on the bench. Try one. Hate it. Swap it at any bench, free. The first commitment is the hardest; make it anyway.",
    ],
    choices: [
      { id: "bench", label: "Open the bench.", effect: "open", open: "bench" },
      { id: "later", label: "Later.", effect: "close" },
    ],
  },
  // B8 is an aside PLATE inside the verdict layout, not a dialogue modal —
  // THE VERDICT outranks everything and its layout is shipped. One line, no
  // choices, no input cost; the RUN IT BACK CTA below it teaches the input.
  // The line must survive every death the verdict can show (r2 minor: "that
  // floor's still standing" was a lie after a collapse) — streets stay known
  // however the floor killed you.
  "tut.runback": {
    key: "tut.runback",
    lines: [
      "You know that floor's streets now — that's what the tuition bought. Same seed, same doors. Run it back and collect.",
    ],
    choices: [],
  },
  // r4 voice: the old B9 was menu copy in his idiom — two feature blurbs with
  // a portrait attached. He is not the front page. He is the man who has
  // watched a lot of people crawl alone and stop coming back.
  "tut.menu2": {
    key: "tut.menu2",
    lines: [
      "Back for more. Most aren't. The ones who last don't crawl alone — not because it's safer, it isn't, but because you learn twice as fast watching someone else make the mistake you were about to.",
      "So take the DAILY, or take the RUSH. Same dungeon as everyone else breathing today, and a seat is always open. Dying in company is still dying. It's just cheaper tuition.",
    ],
    choices: [
      {
        id: "roam", label: "And Roam?", effect: "reply",
        reply: "The long clock. Settlements, contracts, nobody counting your ratings. When you'd rather walk than sprint, it's there.",
      },
      { id: "thanks", label: "Thanks.", effect: "close" },
    ],
  },
};

/** What the first safe-room-visit decision needs to know. Both are sim facts
 *  the host reads off the state; the module only sequences them. */
export interface SafeRoomFacts {
  /** The System has demonstrated the Show (any of the shipped interference /
   *  sponsors / favorites tips fired) — Mordecai debriefs AFTER, never before. */
  showMet: boolean;
  /** Socketing is actually possible on THIS visit: socket 1 open (level) and
   *  a glyph owned or the shelf stocking the Glyph Cache. Never theory. */
  glyphReady: boolean;
}

/**
 * The sequencer: sim facts in, at most one never-before-seen beat out.
 * Construct once per session with the browser ledger (knownTips()); the host
 * records each returned beat's key back onto the ledger (shown = consumed).
 */
export class Guide {
  private seen: Set<string>;
  /**
   * OFFERED, NOT YET SPENT (r5 blocker 1). A beat leaves this module when the
   * host asks for one; it reaches the GLASS some time later, and sometimes
   * never — `guideShow` refuses while another beat or a Roam conversation owns
   * the panel, and B8's aside plate is revealed by a 620ms timer that a fast R
   * cancels outright. r4 wrote the ledger at the ask, so one impatient R
   * deleted B8 from that profile forever with the plate never once painted.
   *
   * So `take` only OFFERS. `commit` (the paint) spends it; `release` (the
   * refusal, the cancelled reveal) hands it back untouched. Nothing here is a
   * "seen" claim until presentation says it saw the light.
   */
  private offered = new Set<GuideBeatKey>();

  constructor(seen: Iterable<string> = []) {
    this.seen = new Set(seen);
  }

  /** True once the global skip has been taken (this session or any before):
   *  the remaining ONRAMP lines are silenced too — a player who declined the
   *  hand-holding gets no more of it from either voice. */
  get skipped(): boolean {
    return this.seen.has(GUIDE_SKIP_KEY);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  private take(key: GuideBeatKey): GuideBeat | null {
    if (this.seen.has(key) || this.offered.has(key) || this.skipped) return null;
    this.offered.add(key);
    return GUIDE_BEATS[key];
  }

  /** THE PAINT. The beat reached the glass, so it is spent forever; the host
   *  writes the same key to the browser ledger in the same breath. */
  commit(key: GuideBeatKey): void {
    this.offered.delete(key);
    this.seen.add(key);
  }

  /** THE REFUSAL. The beat never reached the glass — hand it back, unspent, so
   *  the next honest moment can offer it again (r5 blocker 1). */
  release(key: GuideBeatKey): void {
    this.offered.delete(key);
  }

  /** B0 — the campfire intro. The host gates on the organic fresh-crawler
   *  path (never link arrivals, never mid-casting reopens). */
  campfire(): GuideBeat | null {
    return this.take("tut.campfire");
  }

  /** B3 — the first level-up draft, as the panel would open. */
  draftOpen(): GuideBeat | null {
    return this.take("tut.draft");
  }

  /**
   * B5/B6/B7 — called once per safe-room VISIT (rising edge): at most one
   * beat per visit, so "second-or-later safe room" stays structural rather
   * than a counter.
   *
   * B5 always goes first. After that, B7 OUTRANKS B6 (r4): B7 is only
   * offerable when a socket, a safe room and an actual glyph have lined up —
   * a rare conjunction the r3 critic never once reached in three cold runs —
   * while B6 is offerable at every later visit for the rest of the run. Giving
   * the scarce opportunity to the scarce beat is the only way B7 is reachable
   * at all; B6 loses nothing but a visit.
   */
  safeRoomBeat(facts: SafeRoomFacts): GuideBeat | null {
    const first = this.take("tut.saferoom");
    if (first) return first;
    if (facts.glyphReady) {
      const glyphs = this.take("tut.glyphs");
      if (glyphs) return glyphs;
    }
    if (facts.showMet) {
      const show = this.take("tut.show");
      if (show) return show;
    }
    return null;
  }

  /** B8 — the verdict aside line (solo DEATHS only: the host gates wins out
   *  — "run it back and collect" is death-tuition talk, not victory-lap talk
   *  (r2 minor) — and a win does NOT consume the beat, so the first death
   *  still gets it. Cached per run end: the verdict re-renders as boards
   *  arrive). */
  verdictLine(): string | null {
    return this.take("tut.runback")?.lines[0] ?? null;
  }

  /** B9 — the second organic check-in, panel stage, with a history. */
  menuReturn(finishedRuns: number): GuideBeat | null {
    if (finishedRuns < 1) return null;
    return this.take("tut.menu2");
  }

  /**
   * The global skip (B0 choice 3): every beat is consumed and the skip flag
   * set. Returns every key now owed to the ledger — the host records them all
   * (and the onramp reads `skipped` from here on).
   */
  skipAll(): string[] {
    const keys: string[] = [...GUIDE_BEAT_KEYS, GUIDE_SKIP_KEY];
    for (const k of keys) this.seen.add(k);
    this.offered.clear(); // an explicit refusal outranks every pending offer
    return keys;
  }
}
