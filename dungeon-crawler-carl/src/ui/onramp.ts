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
 *   CONFIRMATIONS — `ability`, `cast`, `slotted`, `ult`, `equipped`,
 *   `autoequip`, `drink`.
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
 *
 * ---------------------------------------------------------------------------
 * A LINE IS SPENT WHEN IT PAINTS (r5 blocker 1)
 * ---------------------------------------------------------------------------
 * `note` OFFERS a line; `commit` spends it; `release` hands it back. r4 spent
 * it at generation, which was the same defect the tips ledger had one channel
 * over: main3d's card surface may DROP a line — a run boundary, a full queue,
 * a moment that expired while the card waited — and a dropped line that stays
 * fired teaches nobody and can never teach anybody. Released events are
 * offerable again the next time the game makes them true: the next pickup, the
 * next cast, the next flask.
 */

export type OnrampEvent =
  // ---- prompts (floor 1, budgeted) ----
  | "start"     // gameplay is live (menu closed, sim running)
  | "contact"   // a monster is close enough to be the point — name the swing
  | "pickup"    // first loot/gold pickup
  | "lowhp"     // the crawler is visibly losing and still has room to act
                //   (the host's ONRAMP_LOW_HP — 60%, not the 40% that had r4's
                //   card painting 0.3s before a corpse)
  | "linger"    // still on floor 1 after a while — name the way out
  // ---- confirmations (any floor, earned by the act) ----
  | "ability"   // the player swung: NOW name the slots that are actually live
  | "cast"      // first ability cast
  | "slotted"   // an empty active slot just filled (draft / discovery)
  | "ult"       // the ultimate slot just filled — the one bind that never
                //   exists in a first session (ultimateMinFloor 7)
  | "equipped"  // first BY-HAND equip — the loot lesson's other half
  | "autoequip" // the sim dressed the crawler on pickup — the same lesson's
                //   reachable half (r5: `equipped` never fired in any cold run
                //   because floor-1 loot is auto-equipped and the bag is empty)
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
  /**
   * OFFERED, NOT YET SPENT (r5 blocker 1). `note()` hands a line to the host;
   * the host queues it on a shared, paced, modal-aware card surface, and
   * sometimes it never paints — a run boundary drops the queue, a stale moment
   * retires it. r4 marked the event fired at GENERATION, so a measured cold
   * profile drank the flask inside the 9s pacing gap, died, and lost BOTH
   * halves of the flask lesson for the session with neither card ever on the
   * glass: `drink` and `lowhp` were both marked fired and nothing had been
   * shown. (These 11 lines carry no tipId, so displayTutorialCard's ledger
   * write never covered them — the whole of r4's fix missed this channel.)
   *
   * So: `note` OFFERS. `commit(ev)` spends it when the card paints (or when a
   * global skip declines it — a refusal is a delivery). `release(ev)` hands it
   * back untouched, and the moment can teach again when it is next true.
   */
  private offered = new Set<OnrampEvent>();
  private prompts = 0;
  private lines = 0;

  constructor(private touch: boolean, private c: OnrampControls) {}

  /** How many lines the script has actually DELIVERED, of both kinds. */
  get spent(): number {
    return this.lines;
  }

  /** How many unsolicited lectures have been delivered (cap: ONRAMP_MAX_PROMPTS). */
  get promptsSpent(): number {
    return this.prompts;
  }

  /** Delivered + still in flight — what the budget must actually count, or six
   *  queued prompts become a seventh the moment one of them paints. */
  private promptsCommitted(): number {
    let n = this.prompts;
    for (const ev of this.offered) if (PROMPTS.has(ev)) n++;
    return n;
  }

  /** THE PAINT: this line reached the player, so the event is spent for good. */
  commit(ev: OnrampEvent): void {
    if (!this.offered.delete(ev)) return;
    this.fired.add(ev);
    this.lines++;
    if (PROMPTS.has(ev)) this.prompts++;
  }

  /** THE DROP: the line never reached the glass. Unfired, unbudgeted, and
   *  teachable the next time the game makes it true (r5 blocker 1). */
  release(ev: OnrampEvent): void {
    this.offered.delete(ev);
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
    if (prompt && this.promptsCommitted() >= ONRAMP_MAX_PROMPTS) return null;
    if (this.fired.has(ev) || this.offered.has(ev)) return null;
    // Never name a bind the player cannot use (r4 blocker 3). No label, no
    // line, no spend — the moment simply has not arrived.
    if ((ev === "ability" || ev === "slotted" || ev === "ult") && !keys) return null;
    const line = this.script(ev, floor, keys);
    // OFFERED, not fired: the host owes this module a commit() when the card
    // paints or a release() when it does not (see `offered` above).
    if (line) this.offered.add(ev);
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
        // The host only calls this once something is ACTUALLY in the bag (r5:
        // the compliant reader pressed the key on cue and found it empty,
        // because gold used to trip this line).
        return `COURTESY EXPLANATION: loot is a raise, not a souvenir. ${t
          ? "Your BAG is under the ☰ menu up top; wear the upgrade between fights."
          : `${this.c.bag} opens your BAG; wear the upgrade between fights.`} Underdressed crawlers make excellent television, briefly.`;
      case "autoequip":
        // THE REACHABLE HALF (r5). The sim dresses strict upgrades at pickup,
        // so on floor 1 this — not the by-hand equip — is the moment gear
        // demonstrably went on, and the rule is explained where it happened.
        return "COURTESY EXPLANATION: that upgrade dressed itself. Strict improvements are worn on pickup; anything the System rules a judgement call is left in the BAG for yours. The figure that matters is the one that MOVED.";
      case "equipped":
        // Fires on a BY-HAND equip only (the host does not call this for the
        // sim's auto-equip — `autoequip` above owns that moment).
        return "COURTESY EXPLANATION: equipped. Gear is compared, never collected, and the System awards no points for a full bag. The judgement was yours because the numbers disagreed; the figure that matters is the one that MOVED.";
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
