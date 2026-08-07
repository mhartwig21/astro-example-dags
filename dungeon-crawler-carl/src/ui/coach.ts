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
  | "boss"      // first boss encounter — the telegraph lesson
  | "showbar"   // the hype reading first moves — THE SHOW's three nouns, defined
  // ---- THE KNOCKDOWN DIAGNOSIS (r11): the debut mercy caught them again, and
  //      the game says WHY rather than repeating the same edit in silence ----
  | "downdash"  // they have gone down without ever dashing
  | "downflask" // they went down holding flask charges
  | "downescort"; // the production has walked them to the exit — take it

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
 * THE SHOW IS THREE NOUNS AND A READOUT, AND NOBODY EVER DEFINED ANY OF THEM
 * (r10, severity 7 — "untaught vocabulary was relocated rather than
 * eliminated; The Show is now the offender"). `#show` is on the glass from
 * second zero of the first run: a hype bar, a viewer count, a favorite count,
 * a sponsor count. The curriculum's LAST step is titled "The Show" and asks
 * the player to push hype over a number and convert a favorite — two words
 * the product had never said out loud, on a step most first sessions never
 * reach.
 *
 * The fix is a carrier that cannot be missed instead of one that needs a crit:
 * `showbar` fires the instant the hype reading first MOVES, which every
 * crawler makes happen with their first kill, and it defines all three nouns
 * in one line. It shares this topic with the sim's `hype` tip, so whichever
 * gets to the glass first teaches the Show and the other stands down — the
 * same one-lesson-one-delivery rule as the collapse pair.
 */
export const TOPIC_SHOW = "show";

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
  // THE SHOW, DEFINED THE MOMENT ITS READOUT MOVES (r10, severity 7). See
  // TOPIC_SHOW: the chips and the bar have been on the glass since second zero
  // and nothing had ever said what any of them counts.
  showbar: {
    verb: "Watch", needsKey: false, topic: TOPIC_SHOW,
    instruction: "Watch your hype climb: it is the crowd's attention, it rises when you fight fast and loud, and it sinks the moment you go quiet.",
    wry: "Viewers are how many are watching right now. Favorites are the ones who stay yours and keep paying after they look away. Those numbers are the Show, and the Show is who is funding this.",
  },
  // ---- THE KNOCKDOWN DIAGNOSIS (r11, severity 9: "mercy has no escalation or
  // diagnosis"). The debut mercy converts a killing blow into a knockdown, and
  // before this round it did so IDENTICALLY, forever, saying nothing about why
  // it kept happening. A safety net that never comments is indistinguishable
  // from a floor that will not kill you and will not let you leave. These are
  // CONFIRMATIONS — the act that earns them is going down — and each names the
  // one survival tool this crawler is measurably not using (diagnoseKnockdown).
  downdash: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} the moment something closes on you — the dash carries you clear and nothing can touch you while it runs.",
    wry: "You have not used it once yet. That is most of the difference between a bad fight and a short one.",
  },
  downflask: {
    verb: "Drink", needsKey: true,
    instruction: "Drink with {key} at half a bar, not at the end — you went down with charges still on your belt.",
    wry: "Kills refill it. Corpses do not.",
  },
  downescort: {
    verb: "Press", needsKey: true,
    instruction: "Press {key} where you are standing — the production has walked you onto the stairs and down is the only thing left to do.",
    wry: "Nobody gets a fourth edit. The next floor is the one that counts, and you get to arrive on it standing up.",
  },
};

/**
 * THE DIAGNOSIS (r11). What the game says to a crawler the debut mercy has just
 * caught. The critic's finding, verbatim: "Floor 1 is unloseable and also
 * unleaveable — mercy has no escalation or diagnosis", against two of four cold
 * deaths that were executions at full HP with zero wayfinding. A knockdown that
 * repeats without ever naming a cause teaches the player that nothing they do
 * matters, which is the worst thing a tutorial can teach.
 *
 * Pure, so the priority order is testable off the facts alone: the ESCORT
 * outranks everything (the world just changed under the player and the line
 * that explains it is the only one worth saying), then the tool they have never
 * once used, then the tool they were still carrying when they folded. Null when
 * the crawler is already using both — that player is not stranded, they are
 * losing a fight, and the coach's ordinary lines own that.
 */
export interface KnockdownFacts {
  /** Has the production just walked them to the exit (the sim's escalation)? */
  escorted: boolean;
  /** Has this crawler EVER dashed this session? */
  dashed: boolean;
  /** Flask charges still unspent at the moment they went down. */
  flasks: number;
}

export type KnockdownNote = "downescort" | "downdash" | "downflask" | null;

export function diagnoseKnockdown(f: KnockdownFacts): KnockdownNote {
  if (f.escorted) return "downescort";
  if (!f.dashed) return "downdash";
  if (f.flasks > 0) return "downflask";
  return null;
}

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
  // Shares TOPIC_SHOW with the `showbar` beat: the crit that fires this tip is
  // the earlier, prettier carrier when it happens, and the first point of hype
  // is the one that always happens. Whichever paints defines the nouns.
  hype: {
    verb: "Fight", needsKey: false, topic: TOPIC_SHOW,
    instruction: "Fight loud to keep your hype climbing — hype is the crowd's attention, and the cameras pay for loud.",
    wry: "Viewers are how many are watching; favorites are the ones who stay yours and keep paying. It all sinks the second you play it safe, and safe doesn't sell tickets.",
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
// r9 (critic finding, severity 5) — THE SHELF'S OWN COPY WAS THE DEFECT.
//
// The finding was "18 of 24 buyable tiles do nothing yet, against an empty
// equipped row". The shelf is not the liar; this paragraph was. Every
// basic-tier entry in `sim/catalog.ts` carries a `slot` AND `affixes` — they
// are wearable stat sticks — and `buyCatalogItem` (sim/game.ts) equips a
// bought piece the instant its slot is empty or its score beats what is worn.
// A debut crawler's equipped row is six empty slots, so on the FIRST shelf
// every one of those tiles goes ON THE CRAWLER at the moment of purchase.
// The only sentence on the glass about them said the opposite — "parts rather
// than gear ... they build into the real thing at a later shelf" — so the
// panel talked a first-timer out of the one shelf where nothing is deferred.
// It says the true thing now, and there is a third variant for the case the
// critic was actually looking at: an EMPTY SLOT, named, with the tile that
// fills it. `{slot}` is a host substitution off the crawler's own equipment.
export const COACH_SHOP_BEATS: Record<"afford" | "broke" | "fits", TeachBeat> = {
  fits: {
    verb: "Buy", needsKey: false,
    instruction: "Buy the {item} for {price} gold — your {slot} slot is empty, so it goes straight on you.",
    wry: "Tiles marked COMPONENTS are gear you wear today that a later shelf builds into something bigger; nothing here is saving itself for later, and anything already in your bag sells here.",
  },
  afford: {
    verb: "Buy", needsKey: false,
    instruction: "Buy the {item} for {price} gold — it is the one thing on this shelf your purse can reach.",
    wry: "Gold you spend is gear; gold you hoard is ballast. Tiles marked COMPONENTS are gear you wear today that a later shelf builds into something bigger, and anything already in your bag sells here.",
  },
  broke: {
    verb: "Read", needsKey: false,
    instruction: "Read the shelf anyway — the cheapest thing on it is the {item} at {price} gold and you are carrying {gold}.",
    wry: "Sell what is in your bag here if you want the difference. Gold keeps between floors, so the shelf you cannot afford today is a price list for the one that matters.",
  },
};

/** Render a shop beat with the live shelf numbers substituted. `slot` is the
 *  empty equipment slot the `fits` form names; the other two ignore it. */
export function shopBeatLine(
  which: "afford" | "broke" | "fits", item: string, price: number, gold: number, slot = "",
): string {
  return renderBeat(COACH_SHOP_BEATS[which])
    .replace(/\{item\}/g, item)
    .replace(/\{price\}/g, String(price))
    .replace(/\{gold\}/g, String(gold))
    .replace(/\{slot\}/g, slot);
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
    wry: "Hype is the crowd's attention and it decays when you go quiet; a favorite is a viewer who stays yours and keeps paying. Below the line the System gets creative on your behalf. You want it bored.",
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
// THE STANDING ASK (r10 — the root cause: "the coach prose slot teaches the
// wrong thing, once, and never again").
//
// Every teaching line in this module before now was an EVENT: something became
// true, a line was offered, a card painted, the opportunity was spent forever.
// That is the right shape for a confirmation ("you just auto-equipped, here is
// what that was") and exactly the wrong shape for an INSTRUCTION, and the
// measured cost was a cohort that finished a 7.5-minute first session at level
// 1, floor 1, still on step 2 of 5. Three defects, one cause:
//
//  - the current step's instruction was spent on ONE paint. Dropped by a queue
//    cap, a stale moment or a modal? Then the only prose that ever said what
//    to do is gone for that profile, and the checklist's four-word item labels
//    are all that is left.
//  - a player STUCK on an item got silence. Prompts are floor-1 only and
//    budgeted; confirmations need the act the player cannot perform; the step
//    intro already fired. Nothing in the system could say a SECOND, more
//    concrete thing about the item the player is visibly failing at.
//  - the prose that did paint was the prose for the STEP, or for an event 40
//    seconds ago, not for the thing being asked right now.
//
// So the teaching channel gets a second half that is a PROJECTION, not a
// message: one ask, derived every frame from the sequencer's current step and
// its first unchecked item, rendered on the persistent card (which survives a
// modal — the panel a step points at must not hide the step). It is never
// spent, it re-reads the world every frame, and it cannot go stale. Cards
// remain the alert channel; the plate is the reference channel, and losing a
// card now costs a nudge instead of the lesson.
//
// ESCALATION IS THE OTHER HALF. An ask that has been on the glass for
// `ASK_STUCK_MS` of REAL on-glass time without the item checking is a player
// who did not understand it, so the ask is REPLACED by the concrete form —
// the exact key, the exact place, the thing they are probably doing wrong —
// permanently for that item, and delivered once as a card (repeated at most
// ASK_MAX_CARDS times, so escalation cannot become the metronome r5 killed).
// Any progress moves the ask to the next item and resets the clock.
// ---------------------------------------------------------------------------

/** The ask key for a banked, unclaimed draft. It PRE-EMPTS the step's own ask
 *  wherever the player is (r10, severity 8: every cold profile — including the
 *  best one — ended the session with unclaimed drafts, so the game's core
 *  progression verb was never learned by anybody). A draft is the one thing
 *  the player can always act on, from any room, and it is pure gain. */
export const ASK_DRAFT_KEY = "draft.banked";

/**
 * THE ASK BECOMES A DIRECTION WHEN THE PLAYER IS LOST (r11, severity 9: "two of
 * four deaths were collapse-timer executions at full HP with zero wayfinding",
 * and "floor 1 is unloseable and also unleaveable").
 *
 * This pre-empt OUTRANKS THE DRAFT, which outranks the spine — and the order is
 * the finding. A crawler who cannot find the stairs is not making a mistake
 * inside a step; the step has stopped being the problem. Claiming a draft in a
 * room you cannot leave is still a stranded session, and the draft ask stands
 * un-actioned indefinitely for exactly the player this pre-empt exists for, so
 * leaving it in front would guarantee the direction never gets a turn.
 *
 * The host only raises it after a MEASURED stall — real on-glass time in which
 * the crawler's own best distance to the exit has not improved — so a player
 * who is fighting, looting or exploring toward the stairs never sees it.
 * `{bearing}` is the live heading and range, recomputed from the world every
 * frame like every other part of the standing ask: it is a projection, so it
 * cannot point at where the stairs used to be.
 */
export const ASK_LOST_KEY = "lost.stairs";

export interface AskBeat {
  /** THE STANDING ASK: one imperative sentence naming the control, on the
   *  glass for as long as this item is the thing being asked. */
  ask: string;
  /** THE ESCALATION: the same instruction made concrete — the key, the place,
   *  the failure mode. Replaces `ask` once the player is visibly stuck. */
  stuck: string;
  /** The register. The standing ask is instruction ONLY — a permanent surface
   *  has no room for a quip and a first-timer scanning it needs the verb — but
   *  once the ask has escalated, the player has been on this one item for
   *  half a minute and the tail is the part that says he has been there too. */
  wry: string;
  /** On-glass ms before this ask escalates (default ASK_STUCK_MS). */
  after?: number;
}

/** How long an ask may stand un-actioned before it escalates. On-glass time,
 *  not wall time — the same clock OBJ_MIN_VISIBLE_MS is paid in. */
export const ASK_STUCK_MS = 25000;
/** ...and how long between re-deliveries of the concrete form while the player
 *  is still stuck on the same item. The plate never stops carrying it; this is
 *  only how often it also gets a card. */
export const ASK_REPEAT_MS = 45000;
/** Cards per item. The channel never goes silent (the plate is permanent), so
 *  this caps the NAGGING, not the teaching. */
export const ASK_MAX_CARDS = 3;

/**
 * One entry per objective item, keyed `${stepId}/${itemId}` — plus the safe
 * room's alternative wording (`obj.saferoom/browse`, the ask when the shelf is
 * genuinely out of reach) and the draft pre-empt. Completeness is a test: an
 * item with no ask is an item a player can stall on in silence, which is the
 * defect this table exists to make impossible.
 *
 * `{tokens}` are the host's live control labels (OBJ_LABEL_TOKENS) — the same
 * substitution the checklist runs, so an ask can never name a bind the player
 * does not have or a key they rebound.
 */
export const OBJ_ASKS: Record<string, AskBeat> = {
  "obj.move/moved": {
    ask: "Hold {move} and get off this tile.",
    stuck: "Press and hold one of {move} — those four keys are the only thing that walks you, and nothing down here starts until you do.",
    wry: "The floor is on a clock. Standing still spends it for nothing.",
  },
  "obj.move/blood": {
    ask: "Find something that moves and hit it with {strike}.",
    stuck: "Walk right up against a monster before you press {strike} — your swing has the reach of an arm, not of a room.",
    wry: "Nothing down here is impressed by a near miss.",
  },
  "obj.move/kills3": {
    ask: "Put three monsters down with {strike}.",
    stuck: "Take them one at a time with {strike}, drink with {flask} at half a bar, and leave with {dash} the moment a second one joins in.",
    wry: "The count carries across deaths. Whatever the first two cost you, you have already paid it.",
  },
  "obj.five/strike": {
    ask: "Press {strike} with a monster inside arm's reach.",
    stuck: "Stand against something alive and press {strike} — that key is your basic attack, and it is the one you will press more than all the others together.",
    wry: "Everything else in the kit is an argument about how to get here safely.",
  },
  "obj.five/dash": {
    ask: "Press {dash} to dash.",
    stuck: "Press {dash} right now, standing still, with nothing chasing you — you are untouchable for the length of it, and this is the cheapest possible time to find that out.",
    wry: "Learning where the exit is during the emergency is how crawlers end up on the highlight reel.",
  },
  "obj.five/cast": {
    ask: "Press {cast} to throw the ability in that slot.",
    stuck: "Press {cast} with something in front of you — the dark slots on that row are padlocked until the System issues them, but that one is already loaded.",
    wry: "It costs a cooldown, not a resource. Spending it is the only way it pays anything.",
  },
  "obj.payday/loot": {
    ask: "Kill something and walk over what it drops.",
    stuck: "Step onto the loot lying on the floor — gear is picked up by standing on it, a strict upgrade dresses itself, and everything else waits in your bag under {bag}.",
    wry: "Nobody hands you a receipt down here. The numbers just move.",
  },
  "obj.payday/draft": {
    ask: "Press {draft} to claim a banked draft.",
    stuck: "Press {draft}, then take one of the offered cards with 1, 2 or 3 — a draft you never claim is a level you are not wearing.",
    wry: "The System banks them because it expects you to forget. Disappoint it.",
  },
  // THE ONE ITEM THAT CAN STRAND A PLAYER (r11). It used to ask a crawler to
  // stand on something without ever saying where it was; the whole cohort
  // finding — "unloseable and also unleaveable" — is downstream of that. The
  // ask carries the live heading now, and the escalation names the two surfaces
  // that are answering it while the exit is lit: the beacon and the chart.
  "obj.payday/descend": {
    ask: "Walk {bearing} to the stairs and press {stairs}.",
    stuck: "Follow the gold EXIT marker on your glass, or the gold diamond on your map, until the stairs are under you and press {stairs} — the clock on this floor does not stop for a tidy floor.",
    wry: "Down is the only direction that has ever paid anybody.",
  },
  "obj.saferoom/shop": {
    ask: "Open the shelf and see what a floor costs.",
    stuck: "Open the safe room's SHOP tab — those tiles are the shelf, and the number on each one is what it wants from you.",
    wry: "This is the only room on the floor that bills you in gold instead of blood.",
  },
  "obj.saferoom/spend": {
    ask: "Buy something off the shelf.",
    stuck: "Take a tile whose price is not red and confirm it — your equipment slots are empty, so whatever you buy goes straight onto you.",
    wry: "Gold you carry down is gold the next floor takes for free.",
  },
  "obj.saferoom/browse": {
    ask: "Read the shelf even though you cannot afford it.",
    stuck: "Read the prices and remember the cheapest one — gold keeps between floors, so today's shelf is next floor's shopping list.",
    wry: "Knowing what a floor costs is worth the walk on its own.",
  },
  "obj.show/hype": {
    ask: "Fight fast and loud to push your hype past {hypeline}.",
    stuck: "Chain kills without stopping to push hype over {hypeline} — hype is the crowd's attention, and below that line the System starts arranging entertainment on your behalf.",
    wry: "It decays the second you go quiet. That is the whole contract.",
  },
  "obj.show/fan": {
    ask: "Hold your hype over {hypeline} until the crowd picks a favorite.",
    stuck: "Keep fighting with hype above {hypeline} — viewers are the people watching right now, and a favorite is one who stays yours and keeps paying after they look away.",
    wry: "Viewers are weather. Favorites are income.",
  },
  [ASK_LOST_KEY]: {
    ask: "Walk {bearing} — that is where the stairs are, and they are marked on your map.",
    stuck: "Follow the gold EXIT marker {bearing} until you are standing on the stairs, then press {stairs} — the floor has nothing else left to give you.",
    wry: "Every floor down here is a room you are meant to leave. Wandering one is not a strategy, it is just a long scene.",
    // The player is already visibly lost when this ask is raised — the host
    // does not raise it until a measured stall — so the concrete form is owed
    // sooner than a step's ordinary instruction.
    after: 12000,
  },
  [ASK_DRAFT_KEY]: {
    ask: "Press {draft} to claim the draft you have banked.",
    stuck: "Press {draft} and take one of the cards with 1, 2 or 3 — claiming is how you actually level, and the pick is not yours until you do.",
    wry: "Banked power is not power. It is paperwork.",
    // Faster than an ordinary ask: a banked draft is free strength the player
    // already earned, it can be claimed from anywhere, and four cold profiles
    // ended their session still holding one.
    after: 8000,
  },
};

/** An escalation edge: the ask just got more concrete (or is being re-asserted
 *  while the player is still stuck). The host draws attention to the plate —
 *  it does NOT open a second surface, which is r8's finding 3 and the reason
 *  this is an edge and not a card. */
export interface AskEdge {
  key: string;
  /** The line the plate is now carrying, for a host that wants to log it. */
  text: string;
}

/**
 * The standing ask's state machine. Pure, unit-testable, no DOM: the host
 * feeds it the live ask key, that ask's fallback prose, and the ms of REAL
 * on-glass time since the last frame; it hands back the line the plate must
 * be carrying and, on an escalation, a card to paint.
 */
export class StandingAsk {
  private key = "";
  private ms = 0;
  private hot = false;
  private cards = 0;
  private sinceCard = 0;
  /**
   * THE ESCALATION IS PER ITEM, AND IT SURVIVES A PRE-EMPT (r13, critic
   * severity 5 — "the escalation is not reverting, it is being EVICTED").
   *
   * r10 wrote the escalated form down as PERMANENT for an item, and it
   * demonstrably was not: the pre-empts (a banked draft, a lost crawler) take
   * the slot, which is a KEY CHANGE, and a key change resets `hot` — so when
   * the pre-empt stood down, the item the player was actually stuck on
   * re-entered at its SOFT form and had to earn its 25 seconds all over again.
   * A cold profile measured the consequence exactly: the same concrete
   * sentence delivered at 100.5s, 175.7s, 281.6s and 380.6s across a
   * 258-second stall on one item. Delivering an escalation four times is not
   * an escalation, it is a loop.
   *
   * A key change is still PROGRESS for a key the player has never been stuck
   * on (that test is the r10 law and stays green). It is not amnesia for one
   * they have: an item that has earned its escalation keeps it, and its card
   * budget, for the rest of the session. The item can never come back after it
   * is checked, so this cannot nag past its own lesson.
   */
  private hotKeys = new Set<string>();
  private cardsByKey = new Map<string, number>();

  /** The ask key currently live ("" for none). */
  get current(): string {
    return this.key;
  }

  /** True once this ask has escalated — the host draws the line hotter. */
  get escalated(): boolean {
    return this.hot;
  }

  /**
   * Feed once per rendered frame. `key` is `${stepId}/${itemId}` (or
   * ASK_DRAFT_KEY), "" when the player has no ask at all. `dtMs` is on-glass
   * time — zero while the card is hidden, so a lesson cannot be escalated at a
   * player who was never shown it. A change of key is PROGRESS: the clock, the
   * escalation and the card budget all reset.
   */
  observe(key: string, dtMs: number): AskEdge | null {
    if (key !== this.key) {
      this.key = key;
      // An item this player has already been stuck on comes back STUCK — the
      // pre-empt borrowed the slot, it did not teach the lesson (see hotKeys).
      this.hot = this.hotKeys.has(key);
      this.ms = this.hot ? (OBJ_ASKS[key]?.after ?? ASK_STUCK_MS) : 0;
      this.cards = this.cardsByKey.get(key) ?? 0;
      this.sinceCard = 0;
      return null;
    }
    const beat = OBJ_ASKS[key];
    if (!key || !beat || !(dtMs > 0)) return null;
    this.ms += dtMs;
    this.sinceCard += dtMs;
    if (!this.hot && this.ms >= (beat.after ?? ASK_STUCK_MS)) {
      this.hot = true;
      this.hotKeys.add(key);
      this.cards = 1;
      this.cardsByKey.set(key, this.cards);
      this.sinceCard = 0;
      return { key, text: this.line() };
    }
    // STILL STUCK ON THE SAME THING: re-assert the concrete form rather than
    // going quiet — bounded, because the plate never stopped carrying it. The
    // budget is per ITEM and banked with it, so a pre-empt cycling in and out
    // cannot refund the nag either.
    if (this.hot && this.cards < ASK_MAX_CARDS && this.sinceCard >= ASK_REPEAT_MS) {
      this.cards++;
      this.cardsByKey.set(key, this.cards);
      this.sinceCard = 0;
      return { key, text: this.line() };
    }
    return null;
  }

  /** THE PROSE THE PLATE IS CARRYING. Never null while an ask is live, never
   *  spent, re-derived from the sequencer every frame. */
  line(): string {
    const beat = OBJ_ASKS[this.key];
    if (!beat) return "";
    return this.hot ? `${beat.stuck} ${beat.wry}` : beat.ask;
  }
}

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
  elite: null, boss: null, showbar: null,
  // The diagnosis names a control the crawler owns RIGHT NOW: the dash wherever
  // they benched it, the flask, the stairs bind. All handed in at call time.
  downdash: "call", downescort: "call", downflask: "flask",
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
