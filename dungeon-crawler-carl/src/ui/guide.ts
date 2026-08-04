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
        reply: "Fine by me. Advice keeps. The stairs are down — everything else you'll learn from the floor.",
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
      "Safe room. The one door down here the dungeon can't follow you through. Shop's stocked, the bench will re-slot your kit, and the flask gets topped on the house.",
      "Spend the gold. The exchange rate only gets worse with depth, and nobody's buried with their savings. If you're sitting on a draft, cash it here — nothing's chewing on you for once.",
    ],
    choices: [
      { id: "shop", label: "Open the shop.", effect: "open", open: "shop" },
      { id: "later", label: "Later.", effect: "close" },
    ],
  },
  "tut.show": {
    key: "tut.show",
    lines: [
      "You've noticed the cameras. Here's the honest version: hype is money. Crits, crowds, close calls — the audience pays for all of it, and sponsors pay YOU, in gear, between floors. Play a little louder than survival strictly needs. I hate it too. It works.",
    ],
    choices: [{ id: "noted", label: "Noted.", effect: "close" }],
  },
  "tut.glyphs": {
    key: "tut.glyphs",
    lines: [
      "Your kit grew a socket. Glyphs go in. They don't make an ability bigger — they make it DIFFERENT, and different is what gets you off floor six. Try one. Hate it. Swap it at any bench, free. The first commitment is the hardest; make it anyway.",
    ],
    choices: [
      { id: "bench", label: "Open the bench.", effect: "open", open: "bench" },
      { id: "later", label: "Later.", effect: "close" },
    ],
  },
  // B8 is an aside PLATE inside the verdict layout, not a dialogue modal —
  // THE VERDICT outranks everything and its layout is shipped. One line, no
  // choices, no input cost; the RUN IT BACK CTA below it teaches the input.
  "tut.runback": {
    key: "tut.runback",
    lines: [
      "That floor's still standing, and now you know its streets. Same seed, same doors — run it back and collect what the tuition bought.",
    ],
    choices: [],
  },
  "tut.menu2": {
    key: "tut.menu2",
    lines: [
      "Back for more. Good. Two things worth knowing up top: the DAILY deals every crawler alive the same dungeon — one seed, one board, bragging rights until midnight. And the RUSH always has seats — racing strangers beats dying alone.",
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
    if (this.seen.has(key) || this.skipped) return null;
    this.seen.add(key);
    return GUIDE_BEATS[key];
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
   * beat per visit, priority B5 → B6 → B7, so B6/B7 land on later visits by
   * construction ("second-or-later safe room" is structural, not a counter).
   */
  safeRoomBeat(facts: SafeRoomFacts): GuideBeat | null {
    const first = this.take("tut.saferoom");
    if (first) return first;
    if (facts.showMet) {
      const show = this.take("tut.show");
      if (show) return show;
    }
    if (facts.glyphReady) {
      const glyphs = this.take("tut.glyphs");
      if (glyphs) return glyphs;
    }
    return null;
  }

  /** B8 — the verdict aside line (solo runs only; the host caches it per run
   *  end because the verdict re-renders as boards arrive). */
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
    return keys;
  }
}
