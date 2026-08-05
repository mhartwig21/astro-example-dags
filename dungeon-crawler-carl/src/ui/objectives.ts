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

export type ObjStepId = "obj.move" | "obj.five" | "obj.payday" | "obj.saferoom";

export interface ObjectiveItem {
  /** Fact key the host computes each observe call (state diffs + host-surface
   *  facts like "the shop panel is open"). */
  id: string;
  /** Player-facing label (host may substitute live key labels). */
  label: string;
}

export interface ObjectiveStep {
  id: ObjStepId;
  title: string;
  items: readonly ObjectiveItem[];
  /** The step only arms (card shows, items check) once this fact has been
   *  true this run. S4: a safe room must exist before it can be a lesson. */
  armFact?: "inSafeRoom";
}

/** The first-session curriculum. Every item is provable from state the host
 *  already reads (see main3d's objectivesObserve). */
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
    id: "obj.five", title: "The Five",
    items: [
      { id: "castA", label: "Cast an ability" },
      { id: "castB", label: "Cast a second, different ability" },
      { id: "dash", label: "Dash" },
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
