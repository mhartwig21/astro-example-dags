/**
 * THE HOLD (TUTORIAL.md r14) — the pause contract for Mordecai's teaching
 * beats.
 *
 * THE OWNER'S VERDICT, VERBATIM, AND WHY THIS MODULE EXISTS: *"I was thinking
 * the tutorial would actually involve pauses of the game and you'd have to go
 * through them (or could dismiss him) so people actually read. As it stands
 * it's just like Mordecai replaced the courtesy explanations for like for like
 * but no one reads long text while they're actively fighting in an ARPG."*
 *
 * That REVERSES HANDOFF §3a's delivery law ("a lightweight in-play strip, not
 * the modal #dialogue panel that pauses the world" / "Play never pauses").
 * §3a's PROSE stays — the words were never the problem. Its DELIVERY law is
 * retired: an instruction the player reads while being hit is an instruction
 * nobody reads.
 *
 * WHAT A HOLD IS, MECHANICALLY: the ABSENCE of step(). main3d's solo loop
 * already drops accumulated time while `dlgOpen` (main3d.ts, the `acc = 0`
 * line), so rendering a beat through the shipped #dialogue surface pauses the
 * world for free. The collapse clock stops by ARITHMETIC and not by a rule —
 * `timeRemaining -= dt` lives inside step(), and step() is not called — and so
 * do cooldowns, monster AI, hype decay and every mercy counter. A hold cannot
 * punish reading because a hold is the absence of time passing.
 *
 * ZERO SIM CHANGES, THEREFORE ZERO REPLAY COST (COMPETITIVE.md MUST-3): a held
 * frame produces no sim sub-steps, so `sampleIntent` is never called and no
 * intent reaches the recorder. A run that held and a run of the same seed that
 * did not are byte-identical on the wire; RULES_HASH does not rotate.
 *
 * This module is the PURE half, in the mould of coach.ts / objectives.ts:
 * world facts in, `hold` / `wait` / `demote` out, plus the paging state and
 * the beat→target table. No DOM, no sim writes, unit-testable. The host owns
 * one thin adapter beside `guideShow`.
 */

import { OBJ_STEP_IDS, type ObjStepId } from "./objectives";
import { OBJ_INTRO_PAGES, type TeachBeat } from "./coach";

/**
 * THE MODALITY REFUSAL, AND IT IS NOT A CURRICULUM REFUSAL.
 *
 * `GUIDE_SKIP_KEY` silences EVERYTHING — the guide beats, the coach strip, the
 * tip translations and the objectives curriculum — and it stays exactly where
 * it is, at B0's campfire ("Skip the hand-holding"). This key is a different
 * promise: it demotes every subsequent beat from a HOLD to the shipped
 * non-pausing strip card and changes nothing else. The checklist stays.
 * Mordecai keeps teaching, quietly, in the channel that already ships.
 *
 * That is the honest reading of the owner's "(or could dismiss him)": a way
 * out of the INTERRUPTION, not a way to delete the tutorial.
 */
export const HOLD_NOHOLD_KEY = "tut.nohold";

/**
 * NO MONSTER WITHIN THIS MANY TILES OR THERE IS NO HOLD. Deliberately much
 * wider than the coach's COACH_CONTACT_TILES (3): three tiles is "already
 * being hit", and a hold that lands mid-swing steals the fight and hands the
 * player a resumed frame they eat a hit in — which teaches "reading is
 * punished", the exact failure this feature exists to end.
 *
 * IT IS ALSO WHAT BUYS A SAFE RESUME, and that is why it is non-negotiable.
 * Because a hold only ever opens with nothing inside eight tiles, and because
 * nothing moves while it is up, the world the player resumes into IS the world
 * they left. No invulnerability grace is needed — which is precisely what
 * keeps this a zero-sim-change feature. If any future change lets the sim tick
 * during a hold, that guarantee dies silently and a resume grace becomes a sim
 * change.
 */
export const HOLD_LULL_TILES = 8;

/**
 * ...and no hold while the crawler is visibly losing. r13's severity-4 finding
 * was "the teaching channel is blind to danger state — inventory prose at 19%
 * HP with 0:10 on the collapse clock". The surface that owns the WHOLE SCREEN
 * must not reintroduce it. Same number as the coach's COACH_LOW_HP, for the
 * same reason.
 */
export const HOLD_LOW_HP = 0.78;

/**
 * A DUE BEAT THAT NEVER FINDS A LULL DEMOTES; IT DOES NOT FORCE A PAUSE.
 * A player in continuous combat for twenty-five seconds is having a fine time
 * and does not need the tape stopped — they get the shipped strip card, which
 * is the same demotion path co-op takes (one mechanism, two callers).
 */
export const HOLD_DEADLINE_MS = 25000;

/**
 * THE DWELL FLOOR — the specific defence against the accident this feature has
 * already been bitten by. For the first ~400ms of every page the panel
 * SWALLOWS every input: a player mid-combat who was mashing Space when the
 * world paused would otherwise blow through an entire beat in one frame and
 * never know it existed.
 *
 * This is an INPUT FLUSH, not a read budget. The strip's 28ms/char budget
 * belongs to an auto-dismissing card; a stepped page has no maximum at all —
 * the player leaves when the player leaves.
 */
export const HOLD_DWELL_MS = 400;

/**
 * SIX HOLDS IN A FIRST SESSION, AND IT IS A HARD CAP. INSTRUCTIONAL beats hold;
 * REACTIVE beats (contact, lowhp, elite, boss, pickup, the knockdown diagnoses,
 * every tip translation) stay on the non-pausing strip forever. Pausing on
 * `lowhp` would stop the world at the worst possible moment and hand out a free
 * heal; pausing on `boss` would stop a boss fight.
 *
 * WHICH SIX, amended by r15 (the curriculum round) — the count did not move,
 * one member did. r14 spent a slot on `obj.saferoom`'s introduction and filed
 * the reason it could never open: that step arms while the crawler is standing
 * at a counter, a counter is a modal, and the lull gate refuses a modal — so
 * its hold could only wait out the deadline and demote onto a strip the shop
 * panel is covering. The safe room already HAS a paused teaching moment that
 * fires before the panel opens (B5, `tut.saferoom`), so the slot went to the
 * beat that can actually use it:
 *
 *   B0 `tut.campfire` · obj.move · obj.five · obj.payday · B5 `tut.saferoom`
 *   · obj.show
 *
 * The number is DEFENSIBLE, NOT MEASURED — nobody has watched a cold cohort
 * against this build, and this project's standing lesson is that a defensible
 * number reported as a measured one is how four rounds went wrong.
 */
export const HOLD_MAX_SESSION = 6;

/**
 * WHAT A PAGE POINTS AT. Pausing is what makes "go do x, y, z" followable, so
 * a beat may aim the player's eye at the thing it is talking about — which is
 * only possible because #dialogue is bottom-anchored (`align-items:flex-end`,
 * `margin-bottom: max(11%, 76px)`), leaving the top ~55% of the glass as the
 * paused world. That geometry is the argument against inventing a centre
 * -screen modal.
 *
 *  - `world` — a tile in the dungeon. The host reuses `renderExitMark`'s
 *    projection (worldToScreen + the behind-camera un-mirror + the edge
 *    -chevron clamp): same code path, different anchor.
 *  - `hud`   — a HUD element by id: a ring off `getBoundingClientRect()`.
 *  - `none`  — the beat is prose and points at nothing.
 */
export type HoldTarget =
  | { kind: "none" }
  | { kind: "hud"; id: string }
  | { kind: "world"; what: "stairs" };

/** ONE LINE = ONE PAGE. The player steps through deliberately; no timer ever
 *  advances a page. */
export interface HoldPage {
  text: string;
  target: HoldTarget;
}

/** The world facts the lull test reads. Every one is already read by the host
 *  every frame for something else — nothing here is a new measurement, which
 *  is the reason this costs no sim change. */
export interface HoldWorld {
  /** The run is live (a verdict screen and a menu are not lulls, they are
   *  somewhere else entirely). */
  playing: boolean;
  /** Under net there are NO HOLDS, ever (§7). */
  net: boolean;
  /** Tiles to the nearest living monster; Infinity when the room is empty. */
  nearestMonster: number;
  /** A live encounter, a ringside introduction, or a cinematic. */
  encounter: boolean;
  /** Any modal, or a shop counter. Two nested pauses is one too many. */
  modal: boolean;
  /** hp / hpMax. */
  hpFrac: number;
  /** state.phase === "collapse" — the floor is already trying to kill them. */
  collapse: boolean;
}

/** Is this a moment the tape may be stopped in? All of it, or none of it. */
export function lullOk(w: HoldWorld): boolean {
  return w.playing && !w.net && !w.encounter && !w.modal && !w.collapse
    && w.nearestMonster > HOLD_LULL_TILES && w.hpFrac > HOLD_LOW_HP;
}

/** A beat that fires the instant it is due may still not fire into a modal, a
 *  dead run or a networked world — it only skips the LULL, which floor 1's
 *  opening seconds cannot provide because nothing is in range yet. */
function immediateOk(w: HoldWorld): boolean {
  return w.playing && !w.net && !w.modal;
}

export interface HoldTickResult {
  /** The beat the host must open on this frame (null: nothing to open). */
  open: string | null;
  /** Beats that will never hold and are owed the strip instead. */
  demote: string[];
}

/**
 * THE SCHEDULER. Due beats + world facts in; hold / wait / demote out.
 *
 * A HOLD IS A SCHEDULED BEAT, NOT A REACTION, and the line is testable off the
 * beat table: instructional → hold, reactive → strip. A beat becomes DUE, then
 * WAITS for a lull, and if no lull arrives inside HOLD_DEADLINE_MS of live
 * play it DEMOTES to a strip card rather than forcing a pause into a fight.
 */
export class HoldScheduler {
  private pending: { key: string; ms: number; immediate: boolean }[] = [];
  private open = false;
  private opened = 0;
  /** The profile said "stop interrupting me": every beat demotes from here on. */
  private refused: boolean;
  /** Co-op: the server sim is authoritative and shared, so nothing pauses. */
  private net: boolean;

  constructor(o: { refused?: boolean; net?: boolean } = {}) {
    this.refused = !!o.refused;
    this.net = !!o.net;
  }

  /** Holds actually opened this session (the HOLD_MAX_SESSION cap's counter). */
  get openedCount(): number {
    return this.opened;
  }

  /** Is a hold on the glass right now? */
  get holding(): boolean {
    return this.open;
  }

  /** Beats due but not yet delivered (a probe reads this; nothing else). */
  get pendingKeys(): string[] {
    return this.pending.map((p) => p.key);
  }

  /** True once the modality refusal is taken — the host also ledgers it. */
  get isRefused(): boolean {
    return this.refused;
  }

  /** The host opened / closed a hold. Closing is the edge that lets the next
   *  due beat compete for a lull; two beats may never share a frame. */
  setHolding(v: boolean): void {
    this.open = v;
  }

  /** "Stop stopping the game" (§3.3, two inputs, off the number row). */
  refuse(): void {
    this.refused = true;
  }

  /**
   * A beat is DUE. Returns `demote` when this beat can never hold — refused,
   * networked, or past the session cap — so the host delivers it as a strip
   * card in the same breath and the curriculum never goes quiet.
   */
  request(key: string, immediate = false): "queued" | "demote" {
    if (this.refused || this.net) return "demote";
    if (this.opened >= HOLD_MAX_SESSION) return "demote";
    if (this.pending.some((p) => p.key === key)) return "queued";
    this.pending.push({ key, ms: 0, immediate });
    return "queued";
  }

  /**
   * A HOLD THE HOST OPENED OUT OF BAND. B0's campfire fires AT the campfire —
   * there is no dungeon behind it, so there is no lull to wait for and never
   * was; it has held since r6. It still counts against the session cap and it
   * still obeys the refusal, because a cap that one caller can walk around is
   * not a cap. False means "you may not open this" and the host stands down.
   */
  take(key: string): boolean {
    if (this.refused || this.net) return false;
    if (this.open || this.opened >= HOLD_MAX_SESSION) return false;
    this.drop(key);
    this.opened++;
    this.open = true;
    return true;
  }

  /** The world moved past this beat before it could be held (the step
   *  completed, the run ended): forget it without demoting. */
  drop(key: string): void {
    const i = this.pending.findIndex((p) => p.key === key);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /**
   * Feed once per RENDERED frame. `dtMs` is live on-glass time — the host
   * feeds ZERO while a hold is up, so a deadline can never expire behind the
   * panel that is delivering a different beat.
   */
  tick(w: HoldWorld, dtMs: number): HoldTickResult {
    const demote: string[] = [];
    if (this.pending.length === 0) return { open: null, demote };
    // The two conditions under which nothing will ever hold again: hand every
    // pending beat to the strip at once rather than letting them rot.
    if (this.refused || this.net || this.opened >= HOLD_MAX_SESSION) {
      for (const p of this.pending.splice(0)) demote.push(p.key);
      return { open: null, demote };
    }
    if (dtMs > 0) for (const p of this.pending) p.ms += dtMs;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.immediate || p.ms < HOLD_DEADLINE_MS) continue;
      this.pending.splice(i, 1);
      demote.push(p.key);
    }
    if (this.open) return { open: null, demote };
    const i = this.pending.findIndex((p) => (p.immediate ? immediateOk(w) : lullOk(w)));
    if (i < 0) return { open: null, demote };
    const [p] = this.pending.splice(i, 1);
    this.opened++;
    this.open = true;
    return { open: p.key, demote };
  }
}

/**
 * THE PAGING STATE. Space or Enter advances, and NOTHING ELSE does — the panel
 * already trains the double duty (first press finishes the typewriter, the
 * next advances) and that is the shipped semantic plus the universal dialogue
 * contract. No timer ever advances a page: there is a MINIMUM dwell and never
 * a maximum.
 */
export class HoldPager {
  private i = 0;
  private ms = 0;

  constructor(readonly pages: readonly HoldPage[]) {}

  get index(): number {
    return this.i;
  }

  get page(): HoldPage {
    return this.pages[Math.min(this.i, Math.max(0, this.pages.length - 1))];
  }

  /** The last page's control reads BACK TO IT, not SPACE: the next press is
   *  known to return a live dungeon rather than show more text. */
  get last(): boolean {
    return this.i >= this.pages.length - 1;
  }

  /** ms this page has been on the glass (the flush's clock). */
  get dwellMs(): number {
    return this.ms;
  }

  /** THE ADVANCE AFFORDANCE IS VISIBLE OR THE FEATURE IS A HANG. The host only
   *  paints the chevron once this is true AND the typewriter has finished. */
  get ready(): boolean {
    return this.ms >= HOLD_DWELL_MS;
  }

  tick(dtMs: number): void {
    if (dtMs > 0) this.ms += dtMs;
  }

  /**
   * One advance input. `swallowed` is the flush doing its job — a player who
   * was holding Space when the world stopped has not read anything yet.
   */
  advance(): "swallowed" | "next" | "end" {
    if (!this.ready) return "swallowed";
    if (this.last) return "end";
    this.i++;
    this.ms = 0;
    return "next";
  }

  /** Restore to a saved page (a refresh mid-lesson resumes where it was). */
  seek(i: number): void {
    this.i = Math.max(0, Math.min(this.pages.length - 1, Math.floor(i) || 0));
    this.ms = 0;
  }
}

// ---------------------------------------------------------------------------
// A REFRESH MID-LESSON DOES NOT EAT THE LESSON.
//
// A beat is ledgered the moment it is SHOWN (the tips convention, and it stays
// — shown = consumed). That is exactly right for a card that painted and
// exactly wrong for a five-page hold the player reloaded on page two: without
// this, F5 on page 2 spends the beat with three pages never read, forever, for
// that profile. The active hold's key and page ride their own tiny browser key
// and are restored on the next boot of the same run.
// ---------------------------------------------------------------------------

export const HOLD_RESUME_KEY = "dcc:hold:v1";

export interface HoldResume {
  key: string;
  page: number;
}

export function encodeHoldResume(r: HoldResume): string {
  return JSON.stringify({ key: r.key, page: Math.max(0, Math.floor(r.page)) });
}

export function decodeHoldResume(raw: string | null | undefined): HoldResume | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<HoldResume>;
    if (typeof j?.key !== "string" || !j.key) return null;
    const page = typeof j.page === "number" && Number.isFinite(j.page) ? Math.max(0, Math.floor(j.page)) : 0;
    return { key: j.key, page };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE BEAT → TARGET TABLE, and the pages themselves.
// ---------------------------------------------------------------------------

/** The scheduler's key for an objective step's introduction. Namespaced away
 *  from the `obj.*` ledger ids on purpose: a hold is a DELIVERY, the step is a
 *  curriculum entry, and conflating them is how a dropped card once spent a
 *  step. */
export function holdKeyForStep(id: ObjStepId): string {
  return `hold.${id}`;
}

export const HOLD_STEP_KEYS: readonly string[] = OBJ_STEP_IDS.map(holdKeyForStep);

/** A guide beat's hold key (B0's campfire, B5's safe room). Same namespacing
 *  rule as the steps': a DELIVERY is not a ledger entry. */
export function holdKeyForGuide(beatKey: string): string {
  return `hold.${beatKey}`;
}

/** The campfire (B0) — the guide beat that has held since r6. */
export const HOLD_CAMPFIRE_KEY = holdKeyForGuide("tut.campfire");
/**
 * THE SAFE ROOM (B5) — the hold r15 moved the fifth step's slot to.
 *
 * `obj.saferoom`'s introduction could never open one: it arms at a counter,
 * a counter is a modal, and the lull gate refuses a modal. B5 fires on the
 * rising edge of the safe-room VISIT, before the shop panel opens, in a world
 * the safe room has already stopped — the one paused moment the shelf lesson
 * actually has. So it pages now, like the campfire, and takes the slot.
 */
export const HOLD_SAFEROOM_KEY = holdKeyForGuide("tut.saferoom");

/** Steps whose introduction is delivered as a HOLD. `obj.saferoom` is not one
 *  (see HOLD_SAFEROOM_KEY): its instruction lives on the persistent card and
 *  the standing ask, both of which survive the shop modal, and its paused
 *  teaching is B5's. */
export const HOLD_STEPS: readonly ObjStepId[] =
  OBJ_STEP_IDS.filter((id) => id !== "obj.saferoom");

/**
 * WHAT EACH STEP'S FIRST PAGE POINTS AT. All are elements the host already
 * draws; none is new furniture.
 *  - obj.move   — nothing. Walking is the ask and the world is the illustration.
 *  - obj.five   — the hotbar, which is the row of keys the page is naming.
 *  - obj.payday — nothing: the page is the step's three asks in one sentence,
 *    and the two that need a finger get their own pointed page below.
 *  - obj.saferoom — the safe room panel, which is the thing to open. (Kept
 *    honest for the demotion path and for a probe; this step does not hold.)
 *  - obj.show   — the Show readout, the numbers the page is about.
 */
export const OBJ_HOLD_TARGETS: Record<ObjStepId, HoldTarget> = {
  "obj.move": { kind: "none" },
  "obj.five": { kind: "hud", id: "cockpit" },
  "obj.payday": { kind: "none" },
  "obj.saferoom": { kind: "hud", id: "saferoom" },
  "obj.show": { kind: "hud", id: "show" },
};

/**
 * ...AND WHAT EACH OF THE PAGES BETWEEN POINTS AT (r15), index for index with
 * `OBJ_INTRO_PAGES`. Pointing is the whole argument for pausing: an instruction
 * that says "press this, over there" is followable only while nothing is moving.
 *  - obj.move's dash page lights the hotbar the key sits on;
 *  - obj.five's dash page and FIVE page keep it lit — the padlocked slots the
 *    second page explains are on that same row;
 *  - obj.payday's draft page lights the DRAFT badge (which is only on the glass
 *    when something is actually banked — the host refuses to ring a hidden
 *    element rather than draw a lie), and its descent page points INTO THE
 *    WORLD at the stairs, through the shipped exit beacon;
 *  - obj.show's page lights the Show readout it is defining.
 */
export const OBJ_HOLD_PAGE_TARGETS: Record<ObjStepId, readonly HoldTarget[]> = {
  "obj.move": [{ kind: "hud", id: "cockpit" }],
  "obj.five": [{ kind: "hud", id: "cockpit" }, { kind: "hud", id: "cockpit" }],
  "obj.payday": [{ kind: "hud", id: "draft-badge" }, { kind: "world", what: "stairs" }],
  "obj.saferoom": [],
  "obj.show": [{ kind: "hud", id: "show" }],
};

/** The checklist the hold hands off to. §8: the card is the hold's CONTINUITY,
 *  so the final page ends on the list and points at it — which turns the
 *  checklist from furniture into something the player was introduced to. */
export const OBJ_HOLD_HANDOFF: HoldTarget = { kind: "hud", id: "objectives" };

/**
 * A STEP'S HOLD IS ITS TeachBeat, PAGED ALONG THE BINDING RULE'S OWN SEAM.
 *
 * The two-voice binding rule (coach.ts, held by test/coach.test.ts) already
 * splits every teaching beat into `instruction` — exactly one imperative
 * sentence, the key in it — and `wry`, the register, which may never carry the
 * key. That seam IS the page break: page one is the instruction, alone, with
 * the pointer on the thing it names; the LAST page is the quip, with the
 * pointer on the checklist that will remember it. A player who reads one page
 * has the instruction; a player who reads both has Mordecai.
 *
 * So the pause mechanism did not invent a prose format — it inherited the one
 * the riddle fix already proved, and paging it is what makes the rule visible
 * instead of merely tested.
 *
 * BETWEEN THEM, WHAT THE PAUSE PAYS FOR (r15). `OBJ_INTRO_PAGES` is prose that
 * would be indefensible on a strip card during a fight and is exactly right on
 * a page the player advances by hand: two or three sentences, a key, a pointer
 * on the thing being named. The seam is unchanged — the instruction is still
 * first and alone, the quip is still last and still key-free — and the middle
 * is where the lessons four rounds could not land finally have room.
 */
export function objHoldPages(
  id: ObjStepId, beat: TeachBeat, middle: readonly string[] = OBJ_INTRO_PAGES[id] ?? [],
): HoldPage[] {
  const targets = OBJ_HOLD_PAGE_TARGETS[id] ?? [];
  const pages: HoldPage[] = [{ text: beat.instruction, target: OBJ_HOLD_TARGETS[id] }];
  middle.forEach((text, i) => pages.push({ text, target: targets[i] ?? { kind: "none" } }));
  if (beat.wry) pages.push({ text: beat.wry, target: OBJ_HOLD_HANDOFF });
  // A beat with no quip still ends on the checklist rather than pointing
  // nowhere: the hand-off is a law of the last page, not of the wry.
  else pages[pages.length - 1] = { ...pages[pages.length - 1], target: OBJ_HOLD_HANDOFF };
  return pages;
}

/** A guide beat's lines, one page each, pointing at nothing. Neither of the two
 *  guide beats that hold has anything to point AT: B0 is a conversation at a
 *  campfire with no dungeon behind it, and B5 fires in the beat before the shop
 *  panel it is about has opened. Their last page carries the beat's own
 *  numbered choices, which are the hand-off. */
export function linesHoldPages(lines: readonly string[]): HoldPage[] {
  return lines.map((text) => ({ text, target: { kind: "none" } as HoldTarget }));
}

// ---------------------------------------------------------------------------
// THE CONTROLS' OWN WORDS.
// ---------------------------------------------------------------------------

/** The advance affordance, measured as a RECT in acceptance and never asserted
 *  from CSS: a player who does not know a press is owed is a player stuck in a
 *  paused game, which is strictly worse than the bug this feature fixes. */
export function advanceLabel(last: boolean): string {
  return last ? "▸ BACK TO IT (SPACE)" : "▸ SPACE";
}

/**
 * THE REFUSAL, IN THREE PARTS — and it is the r6-fix-1 pattern, called rather
 * than re-invented. Double-tapping `2` at the campfire once destroyed an entire
 * curriculum because a destructive control had been promoted into a slot a
 * benign choice had just vacated. So: the control is off the number row, taking
 * it only OPENS a confirmation, the SAFE answer is slot 1, and only the second
 * explicit input consumes it.
 *
 * ...and the confirmation NAMES ITS UNDO BEFORE IT TAKES THE ANSWER. A
 * destructive control that does not name its undo is a trap.
 */
export const HOLD_REFUSE_LABEL = "Stop stopping the game.";
export const HOLD_REFUSE_ASK =
  "Then I'll keep it moving. I'll still talk, on the side of the glass, and the list stays where it is — "
  + "you just won't get stopped for it. If you want the holds back, it's under KEYS, Mordecai's guidance.";
/** Slot 1, always: the safe answer sits where the habitual digit lands. */
export const HOLD_REFUSE_SAFE = "No. Keep stopping it.";
export const HOLD_REFUSE_TAKE = "I'm sure. Stop stopping the game.";
export const HOLD_REFUSE_DONE =
  "Fine. I'll be off to the side, then. The list is still yours, and so am I when you want me.";

/** ESC — SKIP THIS BEAT: one press, no confirmation, non-destructive (the
 *  curriculum continues, the next beat still fires, the checklist stands), so
 *  it is safe to be one input. ESC is already "a polite farewell, one input,
 *  everywhere". */
export const HOLD_ESC_HINT = "Esc skip";
