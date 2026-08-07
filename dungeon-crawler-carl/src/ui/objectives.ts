/**
 * OBJECTIVES — the guided "go do x, y, z" curriculum (HANDOFF §3a: "guided
 * tutorials … where the player goes and does x, y, z before that tutorial
 * step ends so they know what they're doing").
 *
 * A pure sequencer in the Guide/Coach mold: facts in, edges out, no DOM, no
 * sim writes, unit-testable. The host renders the current step as a small
 * PERSISTENT card (#objectives, right rail) — nothing auto-dismisses; the card
 * stays until the step's items are all done.
 *
 * "PLAY NEVER PAUSES" WAS THIS HEADER'S LAW AND IT IS RETIRED (r14 — THE HOLD,
 * src/ui/hold.ts). The owner played the shipped build: "no one reads long text
 * while they're actively fighting in an ARPG." A step's FIRST delivery — its
 * intro beat — now stops the world on the #dialogue panel and is stepped
 * through by the player; the CARD is unchanged and is what remembers the ask
 * afterwards. The hold explains, the card remembers.
 *
 * The one thing this module owes the pause: `addVisibleMs` must be fed ZERO for
 * the whole of a hold. Otherwise a twenty-second read pays the 4s
 * OBJ_MIN_VISIBLE_MS gate and a step completes out from under its own
 * introduction — which is r1 blocker 1 arriving through a new door.
 *
 * The rules, held structurally:
 *  - EVERY STEP DECLARES WHERE IT IS TRUE, AND THE CARD SHOWS ONLY A STEP THE
 *    PLAYER'S CURRENT PLACE CAN HONOUR (r3 major). Steps are sequential WITHIN
 *    a place: the card is the first not-yet-done step whose `where` matches the
 *    place the crawler is standing in, and when no step matches there is NO
 *    CARD. Item order within a step is free; only the shown step's items check.
 *
 *    r2 wrote this as a one-off (`preempt` + `armFact` on the safe-room step)
 *    and a third cold pass measured what a one-off leaves behind: the card
 *    still read "Get Moving — put down three monsters" while the player was
 *    standing at the shop counter (obj.saferoom had already been completed, so
 *    the pre-empt stood down and handed the card straight back to the spine),
 *    and the safe room's card was still on the glass one floor later (the
 *    HOST only re-rendered on a fact edge, so a change of PLACE — which is not
 *    an edge in any fact — never repainted it).
 *
 *    So place is a first-class property of a step now, not a special case
 *    bolted to one of them. "Put down three monsters" cannot be the ask in a
 *    room with no monsters in it; "open the shop" cannot be the ask in a
 *    corridor with no shop in it. A persistent always-on surface telling the
 *    player to do something the world has moved past is worse than no surface
 *    at all — so where the world has moved past every remaining step, the
 *    surface goes away until it hasn't.
 *  - A STEP MUST BE TAUGHT BEFORE IT CAN BE SPENT (r1 blocker 1). Two gates,
 *    and both exist because THE FIVE was born completed: `update` ARMS a step
 *    and returns immediately (checked:[], completed:null), so the card and
 *    its intro beat get a frame before any fact is read; and a step may not
 *    complete until the host has reported OBJ_MIN_VISIBLE_MS of card-on-glass
 *    time for it (`addVisibleMs`). The obj.five facts are RUN-CUMULATIVE —
 *    a player who pressed the dash key during their first fight has all three
 *    true the instant obj.move finishes — so without these gates the only
 *    step that teaches the ability kit key-by-key was written to the ledger
 *    as SPENT without ever painting, permanently, for that profile.
 *  - COMPLETION IS FACT-SPENT (done-by-DOING). A completed step never
 *    returns: the host writes the step's id (`obj.*`) to the shipped tips
 *    ledger (dcc:tips:v1, recordTips) on the completion edge. The player
 *    PERFORMED the step — but they can only have performed it against a card
 *    they were shown, which is what the dwell gate above buys.
 *  - THE CURRICULUM IS A PLAYER-KNOWLEDGE LEDGER, NOT A RUN LEDGER (r2
 *    BLOCKER). Item latches were per-run, so a death wiped them — and the
 *    measured consequence was that two of three cold sessions NEVER REACHED
 *    the step that teaches the kit: "put down three monsters" had to be done
 *    IN ONE LIFE, and one pass watched the card cycle 0/3 → 1/3 → 2/3 → reset
 *    twelve consecutive times. The entire downstream spine (abilities → loot
 *    → shop → descent) sat behind a difficulty check the player failed most
 *    of the time, and the only persistent progress indicator on screen became
 *    a counter that visibly wiped every thirty seconds. `resetRun` now clears
 *    ONLY the arm latches (a new run must re-find a safe room); everything
 *    the player has already demonstrated stays demonstrated. Facts that count
 *    (kills) are the host's to accumulate across lives — see main3d's
 *    objSessionKills.
 *  - FLOOR TRANSITIONS CARRY A STEP FORWARD (objectives are the curriculum,
 *    not floor decoration) — there is deliberately no floor gate anywhere in
 *    this module. PLACE is not depth: a field step is as true on floor 5 as on
 *    floor 1, and the only thing `where` refuses is a step whose ask the room
 *    the player is standing in cannot answer.
 *  - THE SKIP CONSUMES EVERYTHING (a refusal is a delivery — the shipped
 *    convention): `skipAll` marks every step done and returns the ledger keys.
 *
 * Veterans never see this: the host only constructs the sequencer for
 * crawlers enrolled in the curriculum (fresh at first boot after ship), and
 * unmounts the card forever once every step is on the ledger.
 */

export type ObjStepId =
  | "obj.move" | "obj.five" | "obj.payday" | "obj.saferoom" | "obj.show";

export interface ObjectiveItem {
  /** Fact key the host computes each observe call (state diffs + host-surface
   *  facts like "the shop panel is open"). */
  id: string;
  /** Player-facing label. `{tokens}` are LIVE labels the host substitutes at
   *  render time (OBJ_LABEL_TOKENS) — the card obeys the coach's law: it never
   *  names a bind the player cannot use, so key-shaped words are all tokens. */
  label: string;
  /**
   * THE ASK THE GAME CAN ACTUALLY HONOUR (r1: "Spend some gold" with 24 gold
   * and a 35-gold cheapest shelf). A second fact that satisfies the same
   * lesson, with its own wording, for the moments the primary ask is priced
   * out of reach. The host reports both facts; whichever is true checks the
   * item, and the card prints `alt.label` while the host says the alternative
   * form is the live one (`altFact` true). A checklist item a player cannot
   * complete no matter what they do is worse than no item.
   */
  alt?: {
    /** Fact that also satisfies the item. */
    id: string;
    /** Wording shown while `altFact` is true. */
    label: string;
    /** Fact that decides WHICH wording the card prints. */
    altFact: string;
  };
}

/** Every token a label may carry; the host must substitute all of them.
 *  strike/dash/cast are the live control labels for the crawler's CURRENT kit
 *  (desktop binds or touch gestures); move/flask/bag/draft/stairs are the
 *  always-true controls (a rebind moves them, and touch names chips instead of
 *  keys); hypeline is the System's boredom threshold
 *  (CONFIG.interferenceHypeFloor), printed as a number.
 *
 *  The set widened with THE STANDING ASK (coach.ts OBJ_ASKS), which runs its
 *  prose through this same substitution — so an instruction Mordecai keeps on
 *  the glass is under the identical law as a checklist label: it may never
 *  name a control the player does not have.
 *
 *  `bearing` is the odd one out and deliberately so: it is not a control, it is
 *  a live READING of the world (the heading and range to this floor's stairs,
 *  quantised so it does not flicker). It rides this table because the standing
 *  ask's wayfinding line has exactly the same law to obey — the host must be
 *  able to substitute it, and a line naming a direction the world does not
 *  agree with is the same defect as a line naming a key the player does not
 *  have. It renders as prose, never as a key cap. */
export const OBJ_LABEL_TOKENS = [
  "strike", "dash", "cast", "hypeline", "move", "flask", "bag", "draft", "stairs",
  "bearing",
] as const;

/**
 * WHERE THE CRAWLER IS STANDING, in the only two kinds of place this game has
 * asks for: the dungeon proper (`field` — monsters, loot, stairs, a clock) and
 * a shop counter (`shop` — a safe room's shelf, or a settlement outfitter's).
 * The host reports it every frame; a step is only ever the ask in its own
 * place. Deliberately coarse: it is a property of the ASK, not a map region.
 */
export type ObjWhere = "field" | "shop";

export interface ObjectiveStep {
  id: ObjStepId;
  title: string;
  items: readonly ObjectiveItem[];
  /** The place this step's ask is true in (default `field`). A step is never
   *  shown, never checked and never completed anywhere else — which is both
   *  the safe room's arm gate and its pre-empt, said once. */
  where?: ObjWhere;
}

/** The first-session curriculum, in teaching order. Every item is provable
 *  from state the host already reads (see main3d's objectivesObserve), and
 *  every fact is SIM-TRUTH where the sim can testify (a dash is p.dashTime
 *  running, a cast is a held slot that actually holds an ability) — a checkbox
 *  that could tick without the thing happening teaches a lie.
 *
 *  Pacing across floors (the curriculum is the curriculum wherever the
 *  crawler stands, but this is where each step lands in a real first run):
 *  S1–S2 are floor 1's first two fights; S3 closes on the first descent; S4
 *  arms in the safe room that descent routes through; S5 is floor 2+ combat,
 *  where hype and favorites actually flow — so the guided spine dissolves
 *  exactly as the game starts teaching itself.
 *
 *  ...AND EACH STEP IS INTRODUCED BY A PAUSE, THEN TRACKED BY THIS CARD (r14
 *  + r15). S1's hold fires at second zero, before anything is in range, which
 *  is why the dash is taught there rather than behind three kills. S4 is the
 *  exception and it is a structural one: its card arms while the crawler is at
 *  a counter, and a counter is a modal the lull gate refuses, so the safe
 *  room's paused teaching is B5 (src/ui/guide.ts) and this step's instruction
 *  lives on the card, the standing ask, and the shelf's own Mordecai row —
 *  all three of which survive the shop panel. The hold explains; the card
 *  remembers; every key an item names, the hold named first (coach.test.ts). */
export const OBJECTIVE_STEPS: readonly ObjectiveStep[] = [
  {
    id: "obj.move", title: "Get Moving",
    items: [
      { id: "moved", label: "Walk somewhere that isn't here" },
      { id: "blood", label: "Draw blood" },
      { id: "kills3", label: "Put down three monsters" },
    ],
  },
  {
    // YOUR KIT, key by key — the three keys a fresh crawler actually owns
    // (slot 4 and the ultimate are padlocked, and the card never names a
    // dead bind; the coach's `slotted`/`ult` beats teach those keys the
    // moment they become true).
    //
    // TITLED FOR A COLD PLAYER, NOT FOR THE LORE (r2 minor). "The Five 0/3" is
    // a header that promises five things, lists three, and defines neither —
    // the design intent (4 slots + an ultimate) is invisible at exactly the
    // moment the kit is formally introduced. The phrase now lives in the
    // arming line, where it gets a clause of explanation (OBJ_INTRO_BEATS).
    id: "obj.five", title: "Your Kit",
    items: [
      { id: "strike", label: "Trade blows with {strike}" },
      { id: "dash", label: "Dash with {dash}" },
      { id: "cast", label: "Cast with {cast}" },
    ],
  },
  {
    id: "obj.payday", title: "Payday",
    items: [
      { id: "loot", label: "Pick up a piece of gear" },
      // THE KEY IS ON THE CHECKLIST, not only on the badge (r10, severity 8:
      // every cold profile ended its session holding unclaimed drafts, so the
      // core progression verb went unlearned by everybody). "Claim a draft"
      // named an act with no control attached to it; the persistent card is
      // the one surface that is always there, so it carries the bind.
      { id: "draft", label: "Claim a draft with {draft}" },
      { id: "descend", label: "Take the stairs down" },
    ],
  },
  {
    // THE ONE SHOP STEP. It is the card the moment the crawler is standing at
    // a counter, whatever the spine was doing, and it is never the card
    // anywhere else — one property, both halves of that. Its items are both
    // completable INSIDE the room: the old third item ("take the stairs down")
    // could only be satisfied by leaving, it duplicated obj.payday's descend,
    // and it was one of the two near-identical "find the stairs" lines the r2
    // pass counted.
    id: "obj.saferoom", title: "The Safe Room", where: "shop",
    items: [
      { id: "shop", label: "Open the shop" },
      {
        // Priced out of the shelf? Then the lesson is READING the shelf, and
        // the card says so instead of asking for a purchase the economy has
        // made impossible (r1: 24 gold against a 35-gold cheapest entry;
        // r2 measured it again at 16 gold against 35).
        id: "spend", label: "Spend some gold",
        alt: { id: "browse", label: "Look over the shelf", altFact: "brokeAtShop" },
      },
    ],
  },
  {
    // THE SHOW, last on purpose: it is the game's identity, so the guided
    // spine ends on it — and by now the crawler is deep enough that hype
    // actually flows. The items are the two numbers the whole economy hangs
    // off: the System's boredom line (hype as cover — interference starts
    // below it) and the first favorite conversion (hype above the threshold
    // converts fans; favorites are the sticky ones).
    id: "obj.show", title: "The Show",
    items: [
      { id: "hype", label: "Push your hype over {hypeline}" },
      { id: "fan", label: "Convert a favorite" },
    ],
  },
];

export const OBJ_STEP_IDS: readonly ObjStepId[] = OBJECTIVE_STEPS.map((s) => s.id);

/** Boolean facts, keyed by item id (plus arm facts). Computed fresh by the
 *  host every observe call; the sequencer does all the latching. */
export interface ObjectiveFacts {
  [factId: string]: boolean | undefined;
}

export interface ObjectivesUpdate {
  /** The current step armed for the first time this session — the host feeds
   *  its intro beat (coach OBJ_INTRO_BEATS) to the card queue on this edge. */
  started: ObjStepId | null;
  /** Item ids newly checked this call (host: re-render, check animation). */
  checked: string[];
  /** The step that just finished — the host writes this key to the ledger
   *  (fact-spend) and may show the sign-off line. */
  completed: ObjStepId | null;
}

export interface ObjectivesView {
  step: ObjectiveStep;
  /** Item ids already checked (this run). */
  done: ReadonlySet<string>;
  /** Item ids whose ALTERNATIVE wording is the live one right now. */
  alt: ReadonlySet<string>;
}

const NOTHING: ObjectivesUpdate = { started: null, checked: [], completed: null };

/**
 * HOW LONG A STEP'S CARD MUST HAVE BEEN ON THE GLASS before the step may be
 * spent. The host feeds real visible time through `addVisibleMs` (frame delta
 * while the card is mounted and not hidden), so this is wall-clock reading
 * time, not frames — a 3fps software-GL harness and a 144Hz desktop owe the
 * same four seconds.
 *
 * Four, not one: the arm-and-return gate alone would let a step paint for a
 * single sim step (~16ms) and vanish, which is the same defect wearing a
 * shorter clock.
 */
export const OBJ_MIN_VISIBLE_MS = 4000;

export class Objectives {
  /** Completed steps — seeded from the ledger, never un-done. */
  private doneSteps: Set<string>;
  /** Per-run item latches, "stepId/itemId". */
  private itemDone = new Set<string>();
  /** Items that were checked by their ALTERNATIVE fact, so the card can keep
   *  printing the wording the player actually earned. */
  private itemAlt = new Set<string>();
  /** Per-session intro latch: a step introduces itself once, not once per run. */
  private introduced = new Set<ObjStepId>();
  /** Card-on-glass time the host has reported, per step (ms). The completion
   *  gate reads this: a step that never painted was never taught. */
  private seenMs = new Map<ObjStepId, number>();
  /** The last facts observed — the card reads them to choose an item's live
   *  wording (ObjectiveItem.alt). */
  private lastFacts: ObjectiveFacts = {};
  /** Where the crawler is standing, as of the last `update`. The host is the
   *  only thing that knows, and it reports it every frame — including the
   *  frames where the sim is paused, which is exactly when a player is at a
   *  shop counter (main3d's objectivesSync). */
  private where: ObjWhere = "field";

  constructor(seen: Iterable<string> = []) {
    const known = new Set(seen);
    this.doneSteps = new Set([...OBJ_STEP_IDS].filter((id) => known.has(id)));
  }

  /** True once every step is done — the host unmounts the card forever. */
  get finished(): boolean {
    return OBJ_STEP_IDS.every((id) => this.doneSteps.has(id));
  }

  /** Where the sequencer believes the crawler is standing right now. */
  get place(): ObjWhere {
    return this.where;
  }

  /**
   * Has this step been completed (ledgered)? The host reads it to decide how
   * long a piece of TRAINING FURNITURE should exist — the debut's exit marker
   * retires the moment `obj.payday` is done, because that step is the one whose
   * items include taking the stairs. A crawler who has descended once has been
   * taught where a floor's exit is; leaving the marker up after that would make
   * a permanent HUD affordance out of a lesson.
   */
  isDone(id: ObjStepId): boolean {
    return this.doneSteps.has(id);
  }

  /** The step the card is showing: the first not-yet-done step whose place is
   *  the place the crawler is standing in. NULL when this place has no ask
   *  left — a checklist that cannot be honoured here is not shown here. */
  currentStep(): ObjectiveStep | null {
    return OBJECTIVE_STEPS.find((s) =>
      !this.doneSteps.has(s.id) && (s.where ?? "field") === this.where) ?? null;
  }

  /** What the card should show right now (null: show nothing). */
  view(): ObjectivesView | null {
    const step = this.currentStep();
    if (!step) return null;
    const done = new Set<string>();
    const alt = new Set<string>();
    for (const it of step.items) {
      if (this.itemDone.has(`${step.id}/${it.id}`)) {
        done.add(it.id);
        // ...and it keeps the wording it was CHECKED under. That used to be a
        // comment describing a bug: a checked item silently reverted to the
        // primary wording, so an item satisfied by the alternative act printed
        // a struck-through claim about an act the player never performed
        // ("Spend some gold ✓" for a crawler who read the shelf and bought
        // nothing). A checklist that lies about what you did is worse than one
        // that stays open.
        if (this.itemAlt.has(`${step.id}/${it.id}`)) alt.add(it.id);
      } else if (it.alt && this.lastFacts[it.alt.altFact]) alt.add(it.id);
    }
    return { step, done, alt };
  }

  /**
   * THE ONE THING BEING ASKED RIGHT NOW, as a key into the coach's standing-ask
   * table (`${stepId}/${itemId}`). It is the current step's FIRST unchecked
   * item, in whichever wording the world makes honest — the safe room's `alt`
   * form when the shelf is out of reach, so the prose on the glass is the prose
   * for the thing the player is actually being asked to do.
   *
   * Null when this place has no ask left, which is the same condition that
   * shows no card: a surface that keeps instructing after the world has moved
   * past the instruction is worse than a surface that stands down.
   */
  askKey(): string | null {
    const v = this.view();
    if (!v) return null;
    const it = v.step.items.find((i) => !v.done.has(i.id));
    if (!it) return null;
    return `${v.step.id}/${v.alt.has(it.id) && it.alt ? it.alt.id : it.id}`;
  }

  /**
   * The host reports how long the CURRENT step's card has actually been on
   * the glass (frame delta, ms). This is the paint gate: `update` refuses to
   * complete a step that has not been readable for OBJ_MIN_VISIBLE_MS.
   */
  addVisibleMs(ms: number): void {
    const step = this.currentStep();
    if (!step || !(ms > 0)) return;
    this.seenMs.set(step.id, (this.seenMs.get(step.id) ?? 0) + ms);
  }

  /** Card-on-glass time reported for a step so far (ms). */
  visibleMs(id: ObjStepId): number {
    return this.seenMs.get(id) ?? 0;
  }

  /** One observe call: current facts in, edges out. Latching is one-way —
   *  a fact that flickers back to false un-checks nothing. */
  update(facts: ObjectiveFacts): ObjectivesUpdate {
    this.lastFacts = facts;
    // WHERE THE PLAYER ACTUALLY IS, asked first and asked every call: the card
    // follows the crawler, not the queue. Standing at a counter hands the card
    // to the shop step wherever the spine had got to; walking out hands it
    // back, latches and dwell intact; and a place with no ask left shows
    // nothing rather than the nearest ask from somewhere else.
    this.where = facts.inSafeRoom ? "shop" : "field";
    const step = this.currentStep();
    if (!step) return NOTHING;
    // ARMING IS NOT CHECKING (r1 blocker 1). The call that introduces a step
    // reads no facts and completes nothing: the card and the intro beat get
    // the next frame to exist before the step can be spent against them.
    if (!this.introduced.has(step.id)) {
      this.introduced.add(step.id);
      return { started: step.id, checked: [], completed: null };
    }
    const checked: string[] = [];
    for (const it of step.items) {
      const k = `${step.id}/${it.id}`;
      if (this.itemDone.has(k)) continue;
      if (facts[it.id] || (it.alt && facts[it.alt.id])) {
        this.itemDone.add(k);
        if (!facts[it.id] && it.alt && facts[it.alt.id]) this.itemAlt.add(k);
        checked.push(it.id);
      }
    }
    let completed: ObjStepId | null = null;
    // ...and the step is only SPENT once its card has been readable. Items
    // stay latched, so a step whose facts all landed early completes the
    // moment the dwell is paid — late, but taught, and never never.
    if (step.items.every((it) => this.itemDone.has(`${step.id}/${it.id}`))
      && this.visibleMs(step.id) >= OBJ_MIN_VISIBLE_MS) {
      this.doneSteps.add(step.id);
      completed = step.id;
    }
    return { started: null, checked, completed };
  }

  /**
   * A new run is a new crawler in the dungeon, but the SAME PERSON at the
   * keyboard (r2 blocker — see the header). Item latches are NOT cleared: they
   * record what the player has been taught, and erasing tuition on death is
   * what made the curriculum unreachable for two of three cold sessions. All
   * that resets is the PLACE — the new crawler starts in the field, and the
   * next `update` re-reads it from the world anyway.
   */
  resetRun(): void {
    this.where = "field";
  }

  /** The global skip (B0 / GUIDE_SKIP_KEY): every step consumed. Returns the
   *  keys owed to the ledger — a refusal is a delivery. */
  skipAll(): string[] {
    for (const id of OBJ_STEP_IDS) this.doneSteps.add(id);
    return [...OBJ_STEP_IDS];
  }
}
