/**
 * OBJECTIVES — the guided "go do x, y, z" curriculum (HANDOFF §3a: "guided
 * tutorials … where the player goes and does x, y, z before that tutorial
 * step ends so they know what they're doing").
 *
 * A pure sequencer in the Guide/Coach mold: facts in, edges out, no DOM, no
 * sim writes, unit-testable. The host renders the current step as a small
 * PERSISTENT card (#objectives, right rail) — play never pauses, nothing
 * auto-dismisses; the card stays until the step's items are all done.
 *
 * The rules, held structurally:
 *  - STEPS ARE STRICTLY SEQUENTIAL. Only the current step's items can check;
 *    a later step's fact being true early does nothing until that step is
 *    current. Item order WITHIN a step is free.
 *  - COMPLETION IS FACT-SPENT (done-by-DOING). A completed step never
 *    returns: the host writes the step's id (`obj.*`) to the shipped tips
 *    ledger (dcc:tips:v1, recordTips) on the completion edge. This is exempt
 *    from the paint rule on purpose — the player PERFORMED the step; there
 *    is no card whose non-painting could un-do that. (The step's INTRO line
 *    is a different thing: it rides the card surface and follows
 *    offer/commit/release there.)
 *  - MID-STEP PROGRESS IS PER-RUN. `resetRun` clears item latches and arm
 *    latches; a death mid-step re-runs the step's items, never the steps
 *    already completed.
 *  - FLOOR TRANSITIONS CARRY A STEP FORWARD (objectives are the curriculum,
 *    not floor decoration) — there is deliberately no floor gate anywhere in
 *    this module. The one gate is S4's: it ARMS only once the crawler has
 *    actually stood in a safe room this run (`armFact`), because "open the
 *    shop" is a lie anywhere else.
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
}

/** Every token a label may carry; the host must substitute all of them.
 *  strike/dash/cast are the live control labels for the crawler's CURRENT kit
 *  (desktop binds or touch gestures); hypeline is the System's boredom
 *  threshold (CONFIG.interferenceHypeFloor), printed as a number. */
export const OBJ_LABEL_TOKENS = ["strike", "dash", "cast", "hypeline"] as const;

export interface ObjectiveStep {
  id: ObjStepId;
  title: string;
  items: readonly ObjectiveItem[];
  /** The step only arms (card shows, items check) once this fact has been
   *  true this run. S4: a safe room must exist before it can be a lesson. */
  armFact?: "inSafeRoom";
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
 *  exactly as the game starts teaching itself. */
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
    // THE FIVE, key by key — the three keys a fresh crawler actually owns
    // (slot 4 and the ultimate are padlocked, and the card never names a
    // dead bind; the coach's `slotted`/`ult` beats teach those keys the
    // moment they become true).
    id: "obj.five", title: "The Five",
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
      { id: "draft", label: "Claim a draft" },
      { id: "descend", label: "Take the stairs down" },
    ],
  },
  {
    id: "obj.saferoom", title: "The Safe Room", armFact: "inSafeRoom",
    items: [
      { id: "shop", label: "Open the shop" },
      { id: "spend", label: "Spend some gold" },
      { id: "stairs", label: "Take the stairs down" },
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
  /** False while an armFact step waits for its moment — the card stays hidden. */
  armed: boolean;
}

const NOTHING: ObjectivesUpdate = { started: null, checked: [], completed: null };

export class Objectives {
  /** Completed steps — seeded from the ledger, never un-done. */
  private doneSteps: Set<string>;
  /** Per-run item latches, "stepId/itemId". */
  private itemDone = new Set<string>();
  /** Per-session intro latch: a step introduces itself once, not once per run. */
  private introduced = new Set<ObjStepId>();
  /** Per-run arm latches for armFact steps. */
  private armed = new Set<ObjStepId>();

  constructor(seen: Iterable<string> = []) {
    const known = new Set(seen);
    this.doneSteps = new Set([...OBJ_STEP_IDS].filter((id) => known.has(id)));
  }

  /** True once every step is done — the host unmounts the card forever. */
  get finished(): boolean {
    return OBJ_STEP_IDS.every((id) => this.doneSteps.has(id));
  }

  /** The first not-yet-done step, in curriculum order. */
  currentStep(): ObjectiveStep | null {
    return OBJECTIVE_STEPS.find((s) => !this.doneSteps.has(s.id)) ?? null;
  }

  /** What the card should show right now (null: show nothing). */
  view(): ObjectivesView | null {
    const step = this.currentStep();
    if (!step) return null;
    const done = new Set<string>();
    for (const it of step.items) {
      if (this.itemDone.has(`${step.id}/${it.id}`)) done.add(it.id);
    }
    return { step, done, armed: !step.armFact || this.armed.has(step.id) };
  }

  /** One observe call: current facts in, edges out. Latching is one-way —
   *  a fact that flickers back to false un-checks nothing. */
  update(facts: ObjectiveFacts): ObjectivesUpdate {
    const step = this.currentStep();
    if (!step) return NOTHING;
    if (step.armFact && !this.armed.has(step.id)) {
      if (!facts[step.armFact]) return NOTHING; // not armed: card hidden, items inert
      this.armed.add(step.id);
    }
    let started: ObjStepId | null = null;
    if (!this.introduced.has(step.id)) {
      this.introduced.add(step.id);
      started = step.id;
    }
    const checked: string[] = [];
    for (const it of step.items) {
      const k = `${step.id}/${it.id}`;
      if (!this.itemDone.has(k) && facts[it.id]) {
        this.itemDone.add(k);
        checked.push(it.id);
      }
    }
    let completed: ObjStepId | null = null;
    if (step.items.every((it) => this.itemDone.has(`${step.id}/${it.id}`))) {
      this.doneSteps.add(step.id);
      completed = step.id;
    }
    return { started, checked, completed };
  }

  /** A new run is a new crawler: mid-step item progress and arm latches are
   *  re-earned; completed steps and this session's intros are not. */
  resetRun(): void {
    this.itemDone.clear();
    this.armed.clear();
  }

  /** The global skip (B0 / GUIDE_SKIP_KEY): every step consumed. Returns the
   *  keys owed to the ledger — a refusal is a delivery. */
  skipAll(): string[] {
    for (const id of OBJ_STEP_IDS) this.doneSteps.add(id);
    return [...OBJ_STEP_IDS];
  }
}
