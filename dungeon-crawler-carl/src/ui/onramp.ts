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
 *  - ON TOUCH THE LINES NAME THE ACTUAL CONTROLS (the glass, the chips),
 *    on desktop the actual binds — a tutorial that names a key you rebound
 *    is worse than none, so the host passes the live labels in.
 *
 * ---------------------------------------------------------------------------
 * PROMPTS AND CONFIRMATIONS (r4 blocker 3 — the shape of this module changed)
 * ---------------------------------------------------------------------------
 * r2/r3 taught THE FIVE in one line, on `moved`. A fresh critic measured what
 * that actually looked like: it fired twelve seconds in, with the nearest
 * monster 13.6 tiles away, and named five binds at once while the crawler's
 * real state was slots = [melee, dash, bolt, LOCKED] and ult = LOCKED. Two of
 * the five keys were visibly padlocked, and `ultimateMinFloor` is 7 — the
 * ultimate cannot exist in a first session at all. The System had named three
 * keys that worked and two that did nothing, at a moment when none of them
 * were needed.
 *
 * So the script is now two kinds of line:
 *
 *   PROMPTS — unsolicited, floor 1 only, capped at ONRAMP_MAX_PROMPTS. These
 *   are the lectures, and six was always the right number of those. `start`,
 *   `contact`, `pickup`, `lowhp`, `linger`.
 *
 *   CONFIRMATIONS — `ability`, `cast`, `slotted`, `ult`, `equipped`, `drink`.
 *   Each one exists ONLY because the player just performed the act it
 *   explains, so it is not a lecture and it is not budgeted like one. It also
 *   has no floor window: the confirmation must reach whoever did the thing,
 *   whenever they did it. Gating these by depth is precisely the bug r3 patched
 *   for `cast` alone (a level-1 crawler banked the draft, descended, and the
 *   one ability confirmation became unreachable forever) — the general fix is
 *   to stop pretending the teaching moment is on a clock.
 *
 * The keys a line names are the keys that WORK. `ability`, `slotted` and `ult`
 * take their label at call time (the host reads the live loadout), because a
 * slot's bind is only true once something is in the slot. Nothing in here may
 * name a locked bind.
 */

export type OnrampEvent =
  // ---- prompts (floor 1, budgeted) ----
  | "start"     // gameplay is live (menu closed, sim running)
  | "contact"   // a monster is close enough to be the point — name the swing
  | "pickup"    // first loot/gold pickup
  | "lowhp"     // first time under 40% health
  | "linger"    // still on floor 1 after a while — name the way out
  // ---- confirmations (any floor, earned by the act) ----
  | "ability"   // the player swung: NOW name the slots that are actually live
  | "cast"      // first ability cast
  | "slotted"   // an empty active slot just filled (draft / discovery)
  | "ult"       // the ultimate slot just filled — the one bind that never
                //   exists in a first session (ultimateMinFloor 7)
  | "equipped"  // first equip — the loot lesson's other half
  | "drink";    // first flask press — the low-HP lesson's other half

/** Lines that arrive uninvited. Floor 1 only, and never more than six. */
const PROMPTS: ReadonlySet<OnrampEvent> = new Set<OnrampEvent>([
  "start", "contact", "pickup", "lowhp", "linger",
]);

export interface OnrampControls {
  /** Movement keys, as the player would say them: "WASD". */
  move: string;
  /** The basic strike: "Left click or Space". */
  attack: string;
  /** The flask bind: "X". Desktop only — touch lines name the chips. */
  flask: string;
  /** The inventory bind: "I". Touch names the ☰ menu instead. */
  bag: string;
}

/** The lecture budget. Confirmations do not count against it — see the header. */
export const ONRAMP_MAX_PROMPTS = 6;

export class Onramp {
  private fired = new Set<OnrampEvent>();
  private prompts = 0;
  private lines = 0;

  constructor(private touch: boolean, private c: OnrampControls) {}

  /** How many lines the script has spent, of both kinds. */
  get spent(): number {
    return this.lines;
  }

  /** How many unsolicited lectures have been spent (cap: ONRAMP_MAX_PROMPTS). */
  get promptsSpent(): number {
    return this.prompts;
  }

  /**
   * Report an event. Returns the System's line the FIRST time each event
   * arrives inside its window, null otherwise.
   *
   * `keys` is the live bind label for the thing being taught — required by
   * `ability`, `slotted` and `ult`, because those name a control whose truth
   * depends on the loadout at this instant. Passing an empty label means "no
   * such control exists yet", and the line is DECLINED rather than printed
   * with a padlocked key in it: the event stays unfired and can teach later.
   */
  note(ev: OnrampEvent, floor: number, keys = ""): string | null {
    const prompt = PROMPTS.has(ev);
    if (prompt && floor !== 1) return null; // depth is where the game teaches itself
    if (prompt && this.prompts >= ONRAMP_MAX_PROMPTS) return null;
    if (this.fired.has(ev)) return null;
    // Never name a bind the player cannot use (r4 blocker 3). No label, no
    // line, no spend — the moment simply has not arrived.
    if ((ev === "ability" || ev === "slotted" || ev === "ult") && !keys) return null;
    this.fired.add(ev);
    const line = this.script(ev, floor, keys);
    if (line) {
      this.lines++;
      if (prompt) this.prompts++;
    }
    return line;
  }

  private script(ev: OnrampEvent, floor: number, keys: string): string | null {
    const t = this.touch;
    switch (ev) {
      case "start":
        return `COURTESY EXPLANATION: fresh meat detected. ${t
          ? "Drag anywhere on the LEFT HALF of the glass to walk."
          : `${this.c.move} walks; the mouse aims.`} Walking is strongly encouraged. The floor has opinions about the stationary.`;
      case "contact":
        // The swing, at the moment there is finally something to swing at.
        return `COURTESY EXPLANATION: contact. ${t
          ? "Hold the STRIKE chip and it keeps swinging at whatever is nearest."
          : `${this.c.attack} swings at what the mouse points at, and keeps swinging while you hold it.`} The dungeon recognizes no other opening move.`;
      case "ability":
        // Only the slots that are ACTUALLY live, named only after the player
        // has felt why a swing alone is not enough.
        return `COURTESY EXPLANATION: swinging is the floor, not the ceiling. ${t
          ? `The chips beside STRIKE — ${keys} — are your live abilities`
          : `${keys} are your live abilities`}: louder arguments, priced in cooldowns. Slots the System has not issued you yet are locked, and pressing them achieves nothing.`;
      case "cast":
        // On floor 2 the socket the line points at is already open — the
        // same lesson must not name it as a future event.
        return floor >= 2
          ? "COURTESY EXPLANATION: that was an ABILITY. It has a cooldown, not feelings. This floor's GLYPH SOCKET is where builds begin — and builds are why crawlers come back."
          : "COURTESY EXPLANATION: that was an ABILITY. It has a cooldown, not feelings. Floor 2 opens a GLYPH SOCKET — that is where builds begin, and builds are why crawlers come back.";
      case "slotted":
        return `COURTESY EXPLANATION: a slot has been provisioned. ${keys} is live as of this sentence, and its cooldown is already running whether or not you use it. The System does not issue the same slot twice.`;
      case "ult":
        return `COURTESY EXPLANATION: an ULTIMATE is on your record. ${keys} discharges it. The cooldown is measured in minutes, so the System recommends spending it on something the audience would rewind.`;
      case "pickup":
        return `COURTESY EXPLANATION: loot is a raise, not a souvenir. ${t
          ? "Your BAG is under the ☰ menu up top; wear the upgrade between fights."
          : `${this.c.bag} opens your BAG; wear the upgrade between fights.`} Underdressed crawlers make excellent television, briefly.`;
      case "equipped":
        // Fires on a BY-HAND equip only (the host does not call this for the
        // sim's auto-equip), so it also gets to explain why some gear never
        // needed the trip — the rule a player otherwise learns by confusion.
        return "COURTESY EXPLANATION: equipped. Strict upgrades dress themselves on pickup; anything the System considers a judgement call waits for yours. The figure that matters is the one that MOVED. Gear is compared, never collected, and the System awards no points for a full bag.";
      case "lowhp":
        return `COURTESY EXPLANATION: you are leaking. ${t
          ? "Tap the FLASK chip to drink"
          : `${this.c.flask} drinks the flask`}; kills refill it. The System notes that dying pays nothing.`;
      case "drink":
        return "COURTESY EXPLANATION: flask consumed. Charges come back from KILLS, not from time, so the way out of a losing fight is through it. The System finds this arrangement elegant.";
      case "linger":
        return "COURTESY EXPLANATION: down is the only way out. Find the stairs before the collapse clock finds you — the exit is always deeper. Nobody said this was a rescue.";
      default:
        return null;
    }
  }
}
