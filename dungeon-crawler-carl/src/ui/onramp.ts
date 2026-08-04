/**
 * THE ONRAMP (NICHE.md 4.4): the first five minutes for someone a card
 * dragged in. Not a tutorial level — the System doing what it already does
 * (courtesy explanations, after the fact, condescendingly) at the one
 * audience it never addresses: the fresh meat.
 *
 * The doc's constraints, held structurally:
 *  - FIRST-CONTACT ONLY: the host constructs this at most once, for a
 *    browser with no account token and no run history. Veterans never see it.
 *  - THE RUN IS A NORMAL RUN: this module observes and speaks; it never
 *    touches the sim, the seed, or the spawn. Zero sim changes.
 *  - TEACH BY DOING, FLOOR 1 ONLY: lines are keyed to first-time events —
 *    first move, first strike, first cast, first pickup, low health — and
 *    the whole script retires the moment floor 2 begins (where the glyph
 *    socket opens and the real game starts teaching itself).
 *  - BUDGET ≤ 6 LINES, each at most once, in the System's voice.
 *  - ON TOUCH THE LINES NAME THE ACTUAL CONTROLS (the glass, the chips),
 *    on desktop the actual binds — a tutorial that names a key you rebound
 *    is worse than none, so the host passes the live labels in.
 *
 * Pure module: events in, at most one line out per call. Unit-testable
 * without a DOM, like the rest of src/ui.
 */

export type OnrampEvent =
  | "start"    // gameplay is live (menu closed, sim running)
  | "moved"    // first deliberate movement input
  | "cast"     // first ability cast
  | "pickup"   // first loot/gold pickup
  | "lowhp"    // first time under 40% health
  | "linger";  // still on floor 1 after a while — name the way out

export interface OnrampControls {
  /** Movement keys, as the player would say them: "WASD". */
  move: string;
  /** The basic strike: "Left click". */
  attack: string;
  /** Ability activation: "1–4". */
  cast: string;
  /** The flask bind: "X". Desktop only — touch lines name the chips. */
  flask: string;
}

export const ONRAMP_MAX_LINES = 6;

export class Onramp {
  private fired = new Set<OnrampEvent>();
  private lines = 0;

  constructor(private touch: boolean, private c: OnrampControls) {}

  /** How many lines the script has spent (cap: ONRAMP_MAX_LINES). */
  get spent(): number {
    return this.lines;
  }

  /**
   * Report an event. Returns the System's line the FIRST time each event
   * arrives on floor 1, null otherwise. Six events, six possible lines,
   * once each — the ≤6 budget is the structure, not a counter to trust.
   */
  note(ev: OnrampEvent, floor: number): string | null {
    if (floor !== 1) return null; // floor 2 is where the game teaches itself
    if (this.fired.has(ev) || this.lines >= ONRAMP_MAX_LINES) return null;
    this.fired.add(ev);
    const line = this.script(ev);
    if (line) this.lines++;
    return line;
  }

  private script(ev: OnrampEvent): string | null {
    const t = this.touch;
    switch (ev) {
      case "start":
        return `COURTESY EXPLANATION: fresh meat detected. ${t
          ? "Drag anywhere on the LEFT HALF of the glass to walk."
          : `${this.c.move} walks; the mouse aims.`} Walking is strongly encouraged. The floor has opinions about the stationary.`;
      case "moved":
        return `COURTESY EXPLANATION: locomotion confirmed. ${t
          ? "Hold the STRIKE chip to swing; the chips beside it are abilities — louder arguments."
          : `${this.c.attack} swings at what the mouse points at; ${this.c.cast} are abilities — louder arguments.`} The dungeon will supply practice targets momentarily.`;
      case "cast":
        return "COURTESY EXPLANATION: that was an ABILITY. It has a cooldown, not feelings. Floor 2 opens a GLYPH SOCKET — that is where builds begin, and builds are why crawlers come back.";
      case "pickup":
        return "COURTESY EXPLANATION: loot is a raise, not a souvenir. Open your BAG between fights and wear the upgrade. Underdressed crawlers make excellent television, briefly.";
      case "lowhp":
        return `COURTESY EXPLANATION: you are leaking. ${t
          ? "Tap the FLASK chip to drink"
          : `${this.c.flask} drinks the flask`}; kills refill it. The System notes that dying pays nothing.`;
      case "linger":
        return "COURTESY EXPLANATION: down is the only way out. Find the stairs before the collapse clock finds you — the exit is always deeper. Nobody said this was a rescue.";
      default:
        return null;
    }
  }
}
