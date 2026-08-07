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
  /**
   * THE LESSON, NOT THE LINE (r2 minor). Two beats may teach the same thing
   * from different triggers — `linger` and the sim's `collapse` tip are both
   * "the stairs are the exit and the clock is real", and a cold pass measured
   * them landing 21.3 seconds apart, the second one carrying no new
   * information. A beat may declare the TOPIC it spends; the first delivery
   * claims it and every other beat on that topic is declined, whatever
   * surface it arrived from.
   */
  topic?: string;
}

/** Render a beat: instruction first (live label substituted), quip after. */
export function renderBeat(b: TeachBeat, key = ""): string {
  const head = b.instruction.replace(/\{key\}/g, key);
  return b.wry ? `${head} ${b.wry}` : head;
}

export type CoachEvent =
  // ---- prompts (floor 1, budgeted) ----
  | "start"     // gameplay is live (menu closed, sim running)
  | "dashkit"   // SURVIVAL IS NOT A REWARD (r1): the dash, before the first pack
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

/** Lines that arrive uninvited. Floor 1 only, and never more than the budget.
 *
 *  `pickup` LEFT THIS SET (r2 major: "gear, inventory/equip … never actually
 *  taught in any observed session"). It is not an unsolicited lecture — it is
 *  the answer to a thing the player just did, and gating the bag key behind
 *  the floor-1 window AND the prompt budget meant three cold passes never
 *  heard it: floor-1 loot mostly auto-equips, so the FIRST item that actually
 *  lands in the bag is often deeper than floor 1, by which point the prompt
 *  window had closed. An act is the trigger, so it is a confirmation. */
const PROMPTS: ReadonlySet<CoachEvent> = new Set<CoachEvent>([
  "start", "dashkit", "contact", "lowhp", "linger",
]);

/** The one exit lesson, however it is triggered (see TeachBeat.topic). */
export const TOPIC_COLLAPSE = "collapse";

/**
 * THE BAG KEY IS TAUGHT ONCE, BY WHICHEVER GEAR MOMENT ARRIVES FIRST (r3,
 * finding 4). `pickup` (an item landed in the bag) and `autoequip` (the sim
 * dressed the crawler) are two halves of the loot lesson and both of them have
 * to name where gear LIVES — which on floor 1 is the half that never fired,
 * because floor-1 loot mostly auto-equips and the bag stays empty, so three
 * cold passes were never told the word "equipped" or the key that opens the
 * bag by anybody. Both name it now, and the topic makes sure the player hears
 * it exactly once whichever way the dungeon gets there first.
 */
export const TOPIC_BAG = "bag";

/**
 * THE CAST KEYS, AND ONLY THE CAST KEYS (r2 blocker). Slot 0 is the strike and
 * the dash is an ability like any other — it lives in whichever slot the
 * crawler benched it in, which on a fresh crawler is slot 2 (Shift). Any label
 * built for "the abilities you cast" must exclude it: `dashkit` already owns
 * that key, and naming it twice, for two different verbs, is a false fact
 * about a core input. Pure so the rule is testable off the loadout alone.
 */
export function castSlotIndices(slots: readonly (string | null | undefined)[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] && slots[i] !== "dash") out.push(i);
  }
  return out;
}

/**
 * THE ONE SLOT A "CAST" LABEL MAY NAME (r3, finding 5). `castSlotIndices` was
 * the rule for the strip; the objectives card's `{cast}` token re-derived it
 * and then fell back to `slots[2]` when the crawler owned no castable ability
 * — which is the dash's slot for anyone who benched it there, so the card
 * could still print the dash key under the word "Cast". The exclusion has to
 * be structural in the FALLBACK too, not only in the happy path.
 *
 * First choice: a slot that actually holds a castable ability. Failing that,
 * the first slot on the row that is NOT the dash — a key that is padlocked
 * today and will hold an ability when the draft fills it. Never the dash, at
 * any branch. -1 when the crawler has no such slot at all (the host then has
 * no honest label and must decline the line, per the coach's law).
 */
export function castKeyIndex(slots: readonly (string | null | undefined)[]): number {
  const live = castSlotIndices(slots);
  if (live.length > 0) return live[0];
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] !== "dash") return i;
  }
  return -1;
}

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
  // SURVIVAL TOOLS ARE NOT REWARDS FOR SURVIVING (r1 major). The dash lesson
  // used to live inside THE FIVE, behind "put down three monsters" — a gate
  // three of four cold runs died before clearing, so the one button that gets
  // a first-timer out of a pack was taught to nobody who needed it. It is a
  // PROMPT now, and the host fires it in the opening seconds, before the first
  // pack rather than as a trophy for outliving one.
  dashkit: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} to dash clear when something has you cornered.",
    wry: "You're untouchable for the length of it. Not long. Long enough.",
  },
  contact: {
    verb: "Hold", needsKey: true,
    instruction: "Hold {key} to keep swinging at whatever is in front of you.",
    wry: "That's the whole opening move. Everything else is commentary.",
  },
  // THE CAST KEYS ARE THE KEYS THAT CAST (r2 BLOCKER). The host used to hand
  // this line every filled slot's bind — and slot 2 is the DASH — so the strip
  // printed "Press Shift, Q to cast the abilities you actually own" 21 seconds
  // before printing "Press Shift to dash clear". The game stated a false fact
  // about the second key a player ever presses, contradicting the hotbar, the
  // objectives card and itself. The label now comes from `castSlotIndices`,
  // which excludes the dash slot by construction (dashkit owns that key), and
  // a crawler whose only non-strike slot is the dash gets NO ability line at
  // all — the beat is declined rather than printed with a lie in it.
  ability: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} to cast the abilities you actually own.",
    wry: "That is your spell key, not your dash; the dark slots stay padlocked until the System issues them.",
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
    verb: "Open", needsKey: true, topic: TOPIC_BAG,
    instruction: "Open your bag with {key} and equip the piece of gear you just picked up.",
    wry: "Underdressed crawlers make great television, briefly.",
  },
  // GEAR AND EQUIPPING WERE TAUGHT BY NOBODY (r3, finding 4). This beat fires
  // on the one gear moment floor 1 reliably provides — the sim dressing the
  // crawler — and it used to spend that moment on "check the number that
  // moved", naming no key, no bag, and not the word EQUIPPED. It names the
  // vocabulary now: gear, equipped, and the key that opens the place it lives.
  autoequip: {
    verb: "Open", needsKey: true, topic: TOPIC_BAG,
    instruction: "Open your bag with {key} to see everything you have equipped.",
    wry: "That upgrade dressed itself on the way past. Strict improvements go straight on; the judgement calls wait in there for yours.",
  },
  equipped: {
    verb: "Compare", needsKey: false,
    instruction: "Compare the numbers before you equip anything.",
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
  // Shares TOPIC_COLLAPSE with the sim's `collapse` tip: whichever gets to the
  // glass first teaches the exit, and the other is declined. Two near-identical
  // stairs lectures 21s apart is a guide repeating himself, which is the one
  // thing a wry voice cannot survive twice.
  linger: {
    verb: "Find", needsKey: false, topic: TOPIC_COLLAPSE,
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
    verb: "Take", needsKey: false, topic: TOPIC_COLLAPSE,
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

// ---------------------------------------------------------------------------
// THE SHELF (r3, finding 4) — the shop's own vocabulary, in Mordecai's voice,
// on the shop's own surface.
//
// Nothing in the product had ever defined a shop word for anybody: three cold
// passes met 21 tiles reading IN STOCK / COMPONENTS / THE CHASE with prices in
// red and no sentence anywhere on the glass saying what a component is, that a
// bag sells, or that gold survives a floor. The strip cannot carry this — the
// panel is a modal and `body.modal` hides the strip by design (r3's card
// visibility contract) — so these beats are rendered INSIDE the panel, on the
// row that already carries Mordecai's name. Same TeachBeat shape, same binding
// rule, same tests; only the surface differs.
//
// `{item}` / `{price}` / `{gold}` are host substitutions, live off the shelf
// that actually generated (main3d's shopLessonLine), so the lesson can never
// name a tile that is not there or a price that is not the one on it.
// ---------------------------------------------------------------------------
export const COACH_SHOP_BEATS: Record<"afford" | "broke", TeachBeat> = {
  afford: {
    verb: "Buy", needsKey: false,
    instruction: "Buy the {item} for {price} gold — it is the one thing on this shelf your purse can reach.",
    wry: "Gold you spend is gear; gold you hoard is ballast. Tiles marked COMPONENTS are parts rather than gear — they build into the real thing at a later shelf — and anything already in your bag sells here.",
  },
  broke: {
    verb: "Read", needsKey: false,
    instruction: "Read the shelf anyway — the cheapest thing on it is the {item} at {price} gold and you are carrying {gold}.",
    wry: "Sell what is in your bag here if you want the difference. Gold keeps between floors, so the shelf you cannot afford today is a price list for the one that matters.",
  },
};

/** Render a shop beat with the live shelf numbers substituted. */
export function shopBeatLine(
  which: "afford" | "broke", item: string, price: number, gold: number,
): string {
  return renderBeat(COACH_SHOP_BEATS[which])
    .replace(/\{item\}/g, item)
    .replace(/\{price\}/g, String(price))
    .replace(/\{gold\}/g, String(gold));
}

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
  // "THE FIVE" WAS JARGON THAT LISTED THREE THINGS (r2 minor). The step's card
  // read "The Five 0/3" with nothing on screen having ever defined the phrase.
  // The card is titled YOUR KIT now, and the arming line spends one clause on
  // what the System means by five — four slots and an ultimate — so the two
  // padlocks on the hotbar are an explanation instead of a riddle.
  "obj.five": {
    verb: "Work", needsKey: false,
    instruction: "Work through your kit once — strike, dash, and cast each sit on their own key.",
    wry: "The System calls a full loadout The Five: four slots and an ultimate. You own three keys today; the padlocked two get issued when you have earned something to put in them.",
  },
  "obj.payday": {
    verb: "Loot", needsKey: false,
    instruction: "Loot some gear, claim a draft, and take the stairs down.",
    wry: "Depth pays. The surface never did.",
  },
  // The step is the SAFE ROOM, so it ends in the safe room (r2 major: the
  // third item used to be "take the stairs down", which cannot be done from
  // inside the room the step is about — so the step could not close where it
  // was taught, and the descent lesson was already obj.payday's).
  "obj.saferoom": {
    verb: "Open", needsKey: false,
    instruction: "Open the shop and turn some of that gold into gear.",
    wry: "Nothing on the shelf inside your purse? Then read it anyway — knowing what a floor costs is the lesson either way.",
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
  "obj.saferoom": "Shelf read, purse lighter, and still breathing. You might actually last.",
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
  start: "move", contact: "attack", pickup: "bag", autoequip: "bag", lowhp: "flask",
  // The dash key is a LOADOUT fact (the crawler may have benched it), so it is
  // handed in at call time exactly like the ability row's.
  dashkit: "call",
  ability: "call", slotted: "call", ult: "call",
  cast: null, equipped: null, drink: null, linger: null,
  elite: null, boss: null,
};

/** The lecture budget. Confirmations do not count against it. Seven, not six:
 *  the dash prompt joined the floor-1 script (r1) and a budget that starved
 *  `linger` to pay for it would just be the old bug in a new place. It is
 *  deliberately slack now that `pickup` has left the prompt set (r2) — the
 *  budget exists to stop a metronome, not to ration a five-line script. */
export const COACH_MAX_PROMPTS = 7;

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
  /** Topics already delivered, whatever surface carried them (TeachBeat.topic).
   *  Never cleared by a death: the lesson landed, and re-teaching it is the
   *  duplication this ledger exists to stop. */
  private topics = new Set<string>();

  /** How many times the floor-1 script has been re-armed after a death. */
  private reteaches = 0;
  /** The live control label the last offered line was rendered with — the host
   *  reads it to draw that run of text as a KEY CAP rather than as a word in
   *  the middle of a sentence (r2 minor: the strip's craft). "" when the beat
   *  names no control. */
  private key = "";

  /** @see key */
  get lastKey(): string {
    return this.key;
  }

  constructor(private c: CoachControls) {}

  /**
   * ONE DEVICE, THE ONE IN THEIR HANDS (r1 minor). The static labels are the
   * player's CURRENT controls, and "current" changes mid-session: a keyboard
   * player who never touches the mouse should never be told "Left click or
   * Space" at the moment of highest cognitive load. The host re-states the
   * labels whenever the last input source changes, so the strip holds the
   * same discipline the objectives card already does.
   */
  setControls(c: CoachControls): void {
    this.c = c;
  }

  /**
   * A DEATH ON STEP ONE TAUGHT NOTHING (r1 major). Four cold runs measured the
   * same shape: the player dies on floor 1, presses R, and the strip never
   * speaks again for the rest of the session — `fired` holds every prompt that
   * painted in run 1, so the crawler who most needs the floor-1 script is the
   * one guaranteed not to get it. A new run re-arms the PROMPTS (never the
   * confirmations: those are earned by acts, and the act still counts), up to
   * a small number of times, so the lecture cannot become a metronome for a
   * player who is simply dying a lot.
   */
  reteachPrompts(max = 3): boolean {
    if (this.reteaches >= max) return false;
    this.reteaches++;
    for (const ev of PROMPTS) {
      this.fired.delete(ev);
      this.offered.delete(ev);
    }
    this.prompts = 0;
    return true;
  }

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

  /** Has this TOPIC already been taught, on any surface? (The tip-translation
   *  seam asks before painting a curriculum tip — see TeachBeat.topic.) */
  topicTaught(topic: string): boolean {
    return this.topics.has(topic);
  }

  /** Claim a topic for a line that reached the glass from OUTSIDE this class
   *  (the host's sim-tip path). Idempotent. */
  teachTopic(topic: string): void {
    this.topics.add(topic);
  }

  /** THE PAINT: this line reached the player, so the event is spent for good. */
  commit(ev: CoachEvent): void {
    if (!this.offered.delete(ev)) return;
    this.fired.add(ev);
    this.lines++;
    const topic = COACH_BEATS[ev].topic;
    if (topic) this.topics.add(topic);
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
    // ONE LESSON, ONE DELIVERY: another beat already taught this topic.
    const topic = COACH_BEATS[ev].topic;
    if (topic && this.topics.has(topic)) return null;
    const src = KEY_SOURCE[ev];
    const key = src === "call" ? keys : src ? this.c[src] : "";
    // Never name a bind the player cannot use: no label, no line, no spend.
    if (COACH_BEATS[ev].needsKey && !key) return null;
    this.offered.add(ev);
    this.key = COACH_BEATS[ev].needsKey ? key : "";
    return renderBeat(COACH_BEATS[ev], key);
  }
}
