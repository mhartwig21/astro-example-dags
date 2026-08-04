/**
 * Haptics: the touch layer answer to controller rumble. One table, one rate
 * limiter, one pref gate, and a feature check that degrades to nothing — iOS
 * Safari does not implement navigator.vibrate, which is fine: every pattern
 * here is punctuation on top of a visual that already fired.
 *
 * Injectable clock and vibrate fn so test/haptics coverage needs no browser.
 */

export type HapticEvent =
  | "press"      // chip press accepted
  | "refused"    // pressed a chip on cooldown / with no charge
  | "cast"       // a cast actually released
  | "cancel"     // aim abandoned in the cancel band
  | "lock"       // target locked / unlocked
  | "hurt"       // the crawler took a big hit
  | "kill"       // your kill confirmed
  | "levelup"    // level / draft ready
  | "potion"     // a flask charge refilled
  | "pickup";    // loot collected

export type HapticLevel = "off" | "light" | "full";

/** Patterns in ms, navigator.vibrate convention (on, off, on, ...). */
const PATTERNS: Record<HapticEvent, number | number[]> = {
  press: 8,
  refused: [12, 40, 12],
  cast: 14,
  cancel: 25,
  lock: 10,
  hurt: 30,
  kill: [10, 30, 10],
  levelup: [20, 60, 20],
  potion: 10,
  pickup: 6,
};

/** LIGHT keeps only the events a thumb needs to trust its own input. */
const LIGHT: HapticEvent[] = ["press", "refused", "cast", "cancel"];

/** One pulse per this many ms — a pack death must not buzz like a phone call. */
const MIN_GAP_MS = 60;

export class Haptics {
  level: HapticLevel = "full";
  private last = -Infinity;
  private readonly vibrate: ((p: number | number[]) => void) | null;

  constructor(
    vibrate?: ((p: number | number[]) => void) | null,
    private readonly now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  ) {
    if (vibrate !== undefined) {
      this.vibrate = vibrate;
    } else if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      this.vibrate = (p) => { try { navigator.vibrate(p); } catch { /* ignore */ } };
    } else {
      this.vibrate = null;
    }
  }

  get supported(): boolean { return this.vibrate !== null; }

  /** Returns true when a pulse was actually issued (tests read this). */
  fire(ev: HapticEvent): boolean {
    if (!this.vibrate || this.level === "off") return false;
    if (this.level === "light" && !LIGHT.includes(ev)) return false;
    const t = this.now();
    if (t - this.last < MIN_GAP_MS) return false;
    this.last = t;
    this.vibrate(PATTERNS[ev]);
    return true;
  }

  /** Cancel anything mid-pattern (modal opening, controls disabled). */
  silence(): void {
    if (this.vibrate) this.vibrate(0);
  }
}