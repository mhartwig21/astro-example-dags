/**
 * THE COACH — Mordecai's in-play teaching channel (the tutorial rebuild's
 * ONE VOICE rule; HANDOFF §3a). Replaces src/ui/onramp.ts: the System no
 * longer teaches anything, on any surface — COURTESY EXPLANATION is dead as
 * a format. The System keeps its announcer register for EVENTS (ringside
 * intros, achievements, hype); Mordecai owns every teaching line, live on the
 * non-pausing strip (main3d's #tutorial card surface) and at rest through the
 * modal #dialogue panel (src/ui/guide.ts).
 *
 * THE RIDDLE FIX IS STRUCTURAL, NOT STYLISTIC (owner: "Mordecai is some
 * times talking in riddles"). Every teaching beat is data with a shape the
 * tests can hold:
 *
 *   instruction — EXACTLY ONE sentence, imperative, containing the beat's
 *                 declared verb and, when the beat names a control, the
 *                 {key} placeholder. Sentence ONE of the rendered line is
 *                 always the instruction; a player who reads nothing else
 *                 still knows what to press.
 *   wry         — sentence two and later. Mordecai's register lives here,
 *                 and it may NEVER contain {key}: the key cannot be smuggled
 *                 into the quip.
 *
 * test/coach.test.ts enforces this the same way test/guide.test.ts enforced
 * the old two-voice rule — mechanically, over the data.
 *
 * Everything else the ONRAMP learned the hard way survives verbatim:
 *  - PROMPTS (unsolicited, floor 1 only, ≤ COACH_MAX_PROMPTS) vs
 *    CONFIRMATIONS (earned by the act, any floor, unbudgeted).
 *  - NO LINE MAY NAME A BIND THE PLAYER CANNOT USE: keyed beats handed an
 *    empty label are DECLINED, not printed; the host passes live labels
 *    (chips on touch, binds on desktop) at call time.
 *  - A LINE IS SPENT WHEN IT PAINTS: `note` OFFERS, `commit` spends on the
 *    paint, `release` hands a dropped line back untouched (TUTORIAL.md's one
 *    rule — offer/commit/release, r5 blocker 1).
 *  - The module is a pure observer: no DOM, no sim writes, unit-testable.
 *
 * Voice (TUTORIAL.md register bible): short declaratives; wry, never
 * breathless; no exclamation marks; he says "you" and means the person. But
 * he TEACHES first and quips second — the inversion of the old rule that
 * forbade him from naming mechanics at all.
 */

import { OBJ_STEP_IDS, type ObjStepId } from "./objectives";

/** A teaching beat: the structural shape the riddle-fix tests bind. */
export interface TeachBeat {
  /** The imperative head of the instruction ("Hold", "Press", "Walk"). */
  verb: string;
  /** EXACTLY ONE sentence; contains `verb`, and `{key}` when needsKey. */
  instruction: string;
  /** True when the instruction names a control whose live label the host
   *  substitutes at call time ({key}). */
  needsKey: boolean;
  /** Sentence two and later — the register. Never contains {key}. */
  wry?: string;
}

/** Render a beat: instruction first (live label substituted), quip after. */
export function renderBeat(b: TeachBeat, key = ""): string {
  const head = b.instruction.replace(/\{key\}/g, key);
  return b.wry ? `${head} ${b.wry}` : head;
}

export type CoachEvent =
  // ---- prompts (floor 1, budgeted) ----
  | "start"     // gameplay is live (menu closed, sim running)
  | "contact"   // a monster is close enough to be the point — name the swing
  | "pickup"    // first ITEM in the bag (never gold)
  | "lowhp"     // visibly losing, still room to act (host's COACH_LOW_HP)
  | "linger"    // still on floor 1 after a while — name the way out
  // ---- confirmations (any floor, earned by the act) ----
  | "ability"   // the player swung: NOW name the slots that are actually live
  | "cast"      // first ability cast
  | "slotted"   // an empty active slot just filled (draft / discovery)
  | "ult"       // the ultimate slot just filled (ultimateMinFloor 7)
  | "equipped"  // first BY-HAND equip
  | "autoequip" // the sim dressed the crawler on pickup — the reachable half
  | "drink"     // first flask press
  // ---- depth confirmations (floor-2+ pacing: the floors teach past floor 1;
  //      Mordecai footnotes the FIRST of each new thing the depth introduces) ----
  | "elite"     // first named elite in reach — the affix lesson
  | "boss";     // first boss encounter — the telegraph lesson

/** Lines that arrive uninvited. Floor 1 only, and never more than six. */
const PROMPTS: ReadonlySet<CoachEvent> = new Set<CoachEvent>([
  "start", "contact", "pickup", "lowhp", "linger",
]);

/** The in-play beat table. {key} is the live control label the host passes —
 *  a bind on desktop ("WASD", "Q"), a chip or a place on the glass on touch
 *  ("the STRIKE chip", "a drag on the left half of the glass") — so one table
 *  serves both devices and no line can ever name a dead control. */
export const COACH_BEATS: Record<CoachEvent, TeachBeat> = {
  start: {
    verb: "Walk", needsKey: true,
    instruction: "Walk with {key}.",
    wry: "Standing still is a genre of television down here, and it's a short one.",
  },
  contact: {
    verb: "Hold", needsKey: true,
    instruction: "Hold {key} to keep swinging at whatever is in front of you.",
    wry: "That's the whole opening move. Everything else is commentary.",
  },
  ability: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} to cast the abilities you actually own.",
    wry: "The dark slots stay padlocked until the System issues them, so save your fingers.",
  },
  cast: {
    verb: "Watch", needsKey: false,
    instruction: "Watch that ability's cooldown before you lean on it again.",
    wry: "It runs on a timer, not on feelings.",
  },
  slotted: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} to use the ability that just filled that slot.",
    wry: "They don't hand the same slot out twice, so learn this one.",
  },
  ult: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} to discharge your ultimate.",
    wry: "The cooldown runs in minutes, so spend it on something the audience would rewind.",
  },
  pickup: {
    verb: "Open", needsKey: true,
    instruction: "Open your bag with {key} and wear the upgrade.",
    wry: "Underdressed crawlers make great television, briefly.",
  },
  autoequip: {
    verb: "Check", needsKey: false,
    instruction: "Check the number that moved — that upgrade dressed itself.",
    wry: "Strict improvements go straight on; judgement calls wait in the bag for yours.",
  },
  equipped: {
    verb: "Compare", needsKey: false,
    instruction: "Compare the numbers before you wear anything.",
    wry: "Gear is a decision, not a collection, and nobody down here grades you on a full bag.",
  },
  lowhp: {
    verb: "Drink", needsKey: true,
    instruction: "Drink your flask with {key} before that leak finishes the argument.",
    wry: "Dying pays nothing. I've read the contracts.",
  },
  drink: {
    verb: "Kill", needsKey: false,
    instruction: "Kill something to refill that flask.",
    wry: "Charges come back from kills, not from patience, so the way out of a losing fight is through it.",
  },
  linger: {
    verb: "Find", needsKey: false,
    instruction: "Find the stairs down before the collapse clock finds you.",
    wry: "Nobody said this was a rescue.",
  },
  // ---- depth confirmations: fired by the first encounter, wherever it is ----
  elite: {
    verb: "Kill", needsKey: false,
    instruction: "Kill the named one first — an elite carries one extra trick and drops the good loot.",
    wry: "The System names them so the crowd has something to chant. The merchandise follows.",
  },
  boss: {
    verb: "Step", needsKey: false,
    instruction: "Step out of the ring when the boss winds up — every big swing is telegraphed on purpose.",
    wry: "It rehearsed that move for the cameras. You get to rehearse leaving.",
  },
};

/**
 * THE TIP TRANSLATIONS. The sim's curriculum tips (Player.tipsSeen and the
 * TIPS text are untouched — zero sim changes, rulesHash does not rotate)
 * arrive at the host as tipIds; the host paints THESE lines instead of the
 * System's text. This table's key set IS the curriculum: an untranslated
 * tipId is dropped unspent (no tip is ever printed in the System's voice).
 * Each instruction names its mechanism anchor — the INVERSION of the old
 * paraphrase ban: coverage is asserted where avoidance used to be.
 */
export const COACH_TIP_BEATS: Record<string, TeachBeat> = {
  collapse: {
    verb: "Take", needsKey: false,
    instruction: "Take the stairs down before this floor's clock runs out.",
    wry: "Past zero the floor itself becomes the hazard, and it does not negotiate.",
  },
  draftBanked: {
    verb: "Claim", needsKey: false,
    instruction: "Claim your banked draft when you find a quiet corner.",
    wry: "Drafts keep. The crawlers who forget them usually don't.",
  },
  hype: {
    verb: "Fight", needsKey: false,
    instruction: "Fight loud to keep your hype climbing — the cameras pay for loud.",
    wry: "It sinks the second you play it safe, and safe doesn't sell tickets.",
  },
  glyph: {
    verb: "Socket", needsKey: false,
    instruction: "Socket that glyph into one ability at a safe room bench.",
    wry: "It rewires how the ability behaves — swaps are free, so commit and find out.",
  },
};

export const COACH_TIP_IDS: readonly string[] = Object.keys(COACH_TIP_BEATS);

/** The host-side translation seam: a curriculum tipId in, Mordecai's line
 *  out; null means DROP (the System never teaches again, on any surface). */
export function coachTipLine(tipId: string): string | null {
  const beat = COACH_TIP_BEATS[tipId];
  return beat ? renderBeat(beat) : null;
}

// ---------------------------------------------------------------------------
// OBJECTIVE STEP LINES — Mordecai frames each guided step (src/ui/objectives)
// as it arms, and signs it off when the player has DONE all of it.
// ---------------------------------------------------------------------------

/** Step intro beats: the same structural shape, one per objective step. */
export const OBJ_INTRO_BEATS: Record<ObjStepId, TeachBeat> = {
  "obj.move": {
    verb: "Move", needsKey: false,
    instruction: "Move out, draw blood, and put three kills on the board.",
    wry: "The dungeon grades on participation first.",
  },
  "obj.five": {
    verb: "Work", needsKey: false,
    instruction: "Work through your kit once — strike, dash, and cast each sit on their own key.",
    wry: "The other two slots stay padlocked until the System issues you something worth slotting. It enjoys the suspense.",
  },
  "obj.payday": {
    verb: "Loot", needsKey: false,
    instruction: "Loot some gear, claim a draft, and take the stairs down.",
    wry: "Depth pays. The surface never did.",
  },
  "obj.saferoom": {
    verb: "Open", needsKey: false,
    instruction: "Open the shop, spend some gold, then take the stairs when you're done.",
    wry: "Gold you spend is gear; gold you hoard is ballast.",
  },
  "obj.show": {
    verb: "Fight", needsKey: false,
    instruction: "Fight loud enough to push your hype over the line and convert a favorite.",
    wry: "Below the line the System gets creative on your behalf. You want it bored.",
  },
};

/** Step sign-offs: one line each, register-bound, no teaching duty. */
export const OBJ_DONE_LINES: Record<ObjStepId, string> = {
  "obj.move": "Three down. That's the job, and the job doesn't change.",
  "obj.five": "That's the whole toolkit moving. Now it's reps.",
  "obj.payday": "Paid, drafted, and deeper. That's the shape of a career.",
  "obj.saferoom": "Rested, spent, and moving. You might actually last.",
  "obj.show": "A favorite of your own. You stopped being content and started being a show.",
};

// Completeness is a test (coach.test.ts): every objective step id must have
// an intro beat and a done line — a silent step is a curriculum hole.
void OBJ_STEP_IDS;

// ---------------------------------------------------------------------------
// The sequencer — the Onramp's measured mechanics, carried over verbatim.
// ---------------------------------------------------------------------------

export interface CoachControls {
  /** Movement, as the player would say it: "WASD" / "a drag on the left half of the glass". */
  move: string;
  /** The basic strike: "Left click or Space" / "the STRIKE chip". */
  attack: string;
  /** The flask: "X" / "the FLASK chip". */
  flask: string;
  /** The bag: "I" / "the ☰ menu". */
  bag: string;
}

/** Which control label each beat's {key} takes: a constructor control, a
 *  live label passed at call time, or none. */
const KEY_SOURCE: Record<CoachEvent, keyof CoachControls | "call" | null> = {
  start: "move", contact: "attack", pickup: "bag", lowhp: "flask",
  ability: "call", slotted: "call", ult: "call",
  cast: null, autoequip: null, equipped: null, drink: null, linger: null,
  elite: null, boss: null,
};

/** The lecture budget. Confirmations do not count against it. */
export const COACH_MAX_PROMPTS = 6;

export class Coach {
  private fired = new Set<CoachEvent>();
  /** OFFERED, NOT YET SPENT (r5 blocker 1, inherited): `note` hands a line to
   *  the host's card surface, and sometimes it never paints — a run boundary
   *  drops the queue, a stale moment retires it. The host owes a `commit`
   *  when the card paints or a `release` when it does not; a released event
   *  is offerable again the next time the game makes it true. */
  private offered = new Set<CoachEvent>();
  private prompts = 0;
  private lines = 0;

  constructor(private c: CoachControls) {}

  /** How many lines have actually been DELIVERED, of both kinds. */
  get spent(): number {
    return this.lines;
  }

  /** How many unsolicited lectures have been delivered (cap: COACH_MAX_PROMPTS). */
  get promptsSpent(): number {
    return this.prompts;
  }

  /** Delivered + still in flight — what the budget must count, or six queued
   *  prompts become a seventh the moment one of them paints. */
  private promptsCommitted(): number {
    let n = this.prompts;
    for (const ev of this.offered) if (PROMPTS.has(ev)) n++;
    return n;
  }

  /** THE PAINT: this line reached the player, so the event is spent for good. */
  commit(ev: CoachEvent): void {
    if (!this.offered.delete(ev)) return;
    this.fired.add(ev);
    this.lines++;
    if (PROMPTS.has(ev)) this.prompts++;
  }

  /** THE DROP: the line never reached the glass. Unfired, unbudgeted, and
   *  teachable the next time the game makes it true. */
  release(ev: CoachEvent): void {
    this.offered.delete(ev);
  }

  /**
   * Report an event. Returns Mordecai's line the FIRST time each event
   * arrives inside its window, null otherwise.
   *
   * `keys` is the live label for a "call"-keyed beat (`ability`, `slotted`,
   * `ult`) — the truth of those binds depends on the loadout at this instant.
   * An empty label means "no such control exists yet": the line is DECLINED
   * rather than printed with a padlocked key in it, and stays unfired.
   */
  note(ev: CoachEvent, floor: number, keys = ""): string | null {
    const prompt = PROMPTS.has(ev);
    if (prompt && floor !== 1) return null; // depth is where the game teaches itself
    if (prompt && this.promptsCommitted() >= COACH_MAX_PROMPTS) return null;
    if (this.fired.has(ev) || this.offered.has(ev)) return null;
    const src = KEY_SOURCE[ev];
    const key = src === "call" ? keys : src ? this.c[src] : "";
    // Never name a bind the player cannot use: no label, no line, no spend.
    if (COACH_BEATS[ev].needsKey && !key) return null;
    this.offered.add(ev);
    return renderBeat(COACH_BEATS[ev], key);
  }
}
