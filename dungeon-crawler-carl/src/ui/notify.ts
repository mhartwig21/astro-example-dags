import type { Announcement, AnnouncementKind } from "../sim/types";

// ===========================================================================
// THE NOTIFICATION MIX — prioritisation and masking for the System's glass.
//
// WHY THIS EXISTS (owner verdict, 2026-08-07, after playing the integrated
// build): "Same with in late levels notifications... they're a total mess!"
// — the same defect the audio round fixed (src/audio/mix.ts), in the other
// channel. AAA-AUDIT.md gap #7 ("Climax UI stacking: the HUD buries the
// game's best moments", sev 4) is the same finding from a critic.
//
// THE MEASUREMENT BEHIND IT (tools/_mixbrowser.mjs over the shipping build,
// the census in SOUNDPLAN §2.5's sibling report):
//   - floor 13-17 pack density puts 63-72 toast lines/min on the glass, of
//     which 32-43 are literally the same sentence ("N-KILL COMBO by Carl!");
//   - the declared TOAST_MAX = 3 measured up to TEN visible toasts at once,
//     because showToast()'s eviction path did not mark the node it evicted,
//     so every toast arriving inside its 350ms fade re-evicted the SAME dying
//     node and the layer grew unbounded through a burst;
//   - 93-100% of the frames where a boss health bar was up ALSO carried an
//     unrelated overlay line; 79-92% carried three or more;
//   - the instant of death arrived under a "PARTY WIPE" banner AND a
//     "succumbed to the poison" toast.
//
// FIVE RULES, applied in this order. Each one is a policy, not a new
// mechanism — the surfaces already existed, nothing was choosing between
// them:
//
//   1. RANK. A normal-priority line is ranked by kind: the fight's own news
//      (boss) > the run's news (progress/achievement) > gain (loot) > the
//      audience economy (show/flavor). Ties break oldest-first, so ranking
//      re-orders a burst without starving anything inside a rank.
//   2. CLIMAX LOCK (gap #7 verbatim). While a boss bar is up, a death beat
//      is playing or a descent is happening, lower ranks are HELD rather
//      than painted, and drained when the moment is over. A boss climax
//      still lets the fight's own lines through — the punish window is news
//      about the thing you are looking at; the kill-combo counter is not.
//   3. COALESCE. Lines whose shape is identical modulo their numbers are ONE
//      line with a running count ("N-KILL COMBO by Carl! ×7"), whether the
//      earlier copy is on the glass or still waiting. This is the measured
//      half of the channel: the screen-time was not being spent on news, it
//      was being spent on a counter.
//   4. CAP + GRACEFUL OVERFLOW. At most `max` toasts on the glass, released
//      no faster than `gapMs` apart. Everything else waits; the host shows a
//      single compact "+N more" chip for the backlog rather than growing the
//      column (OWNER STANDING RULE: no scrollbars, panels fit the viewport —
//      overflow is never solved with a scrolling log). A line that waits
//      past `staleMs` is dropped: the archive feed still has it, and news
//      that arrives a minute late is not news.
//   5. ONE SENTENCE, ONE SURFACE. A high-priority line claims its shape for
//      the length of the banner: the ticker may not print what the banner is
//      showing, and any toast already carrying that shape is retired. (The
//      audit measured the descent firing three stacked subtitles plus four
//      duplicated ticker lines at once.)
//
// WHAT THIS DELIBERATELY DOES NOT DO: silence a channel. Every line still
// reaches the HUD archive log through the separate state.events drain — this
// module only decides what is worth a LOUD surface at this instant. And no
// line is ever yanked mid-read: the climax lock stops new arrivals, it does
// not clear the glass. (The one exception is death, which is a hard cut: see
// setClimax.)
//
// THE CLOCK IS THE HOST'S (performance.now()), not the sim's — unlike the
// audio mixer, this is presentation pacing measured in reading time, and a
// dilated frame rate must not make a player read faster. Every number here
// is a millisecond of wall time.
// ===========================================================================

/** What the glass is busy with. `null` = ordinary play. */
export type ClimaxKind = "boss" | "death" | "descend" | null;

/**
 * Rank of a normal-priority line. Higher wins a slot, and survives a boss
 * climax. `tip` and `levelup` never reach this module (Mordecai's strip and
 * the world-space level ring own them) — they are listed for totality so a
 * new AnnouncementKind cannot be added without ranking it.
 */
export const NOTIF_RANK: Record<AnnouncementKind, number> = {
  boss: 3, // the fight's own news: phases, punish windows, adds, the corpse warning
  progress: 2, // floors, bands, keys/doors, the collapse clock
  achievement: 2,
  loot: 1,
  levelup: 1,
  show: 0, // the audience economy — 105-148 lines/min of it at pack density
  flavor: 0,
  tip: 0,
};

/** The rank a boss climax lets through: the fight's own news, nothing else. */
export const RANK_BOSS_NEWS = 3;

/** How long a lower-ranked line already on the glass keeps it once a boss
 *  climax starts — a glance to finish, not a full hold, and not a yank. */
export const CLIMAX_YIELD_MS = 1200;

export type NotifOp =
  | { op: "banner"; a: Announcement }
  | { op: "toast"; a: Announcement; key: string; count: number; holdMs: number }
  | { op: "bump"; key: string; text: string; count: number; holdMs: number }
  | { op: "hold"; key: string; holdMs: number }
  | { op: "retire"; key: string }
  | { op: "drop"; a: Announcement; why: "banner" | "stale" | "overflow" | "death" };

export interface NotifOpts {
  /** Simultaneous toasts on the glass. */
  max: number;
  /** How long a released toast owns its slot (hold + fade). */
  holdMs: number;
  /** Minimum wall time between two releases. */
  gapMs: number;
  /** Lines waiting at once before the cheapest one spills. */
  queueMax: number;
  /** A held line older than this is no longer news. */
  staleMs: number;
  /** How long a banner owns its shape against the ticker. */
  bannerMs: number;
  /**
   * The longest a COALESCED line may hold its slot. Each repeat refreshes the
   * hold (that is what makes the counter readable), so without a ceiling a
   * sustained stream pins the slot forever — measured in the first pass of
   * this round: one "6-KILL COMBO" line owned a slot for 445 consecutive
   * frames, and was the sole reason 100% of that scenario's boss-bar frames
   * still carried an unrelated line. Past this the line goes; the next repeat
   * opens a fresh one, and the reader gets a break.
   */
  maxLifeMs: number;
}

export const NOTIF_DEFAULTS: NotifOpts = {
  max: 3,
  holdMs: 3550, // TOAST_HOLD_MS + the 350ms fade the host actually takes
  gapMs: 700,
  queueMax: 6,
  staleMs: 12000,
  bannerMs: 3400, // BANNER_HOLD_MS
  maxLifeMs: 7100, // two holds
};

/**
 * The identity of a SENTENCE, not of a string: case, surrounding space,
 * terminal punctuation and every NUMBER in it are presentation. "7-KILL COMBO
 * by Carl!" and "12-KILL COMBO by Carl!" are one line with a counter, and
 * collapsing them is rule 3 — measured as 32-43 of every 67 toasts per minute
 * at floor-13 pack density.
 */
export function shapeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d[\d,.]*/g, "#")
    .replace(/\s+/g, " ")
    .replace(/[\s.!:—-]+$/g, "")
    .trim();
}

/**
 * Normalized so "Descending to floor 2." and "Descending to floor 2" are one
 * line. Numbers are NOT collapsed here — this is the exact-sentence key the
 * live-feed dedupe has always used, and it must keep meaning what it meant.
 */
export function annKey(text: string): string {
  return text.toLowerCase().replace(/[\s.!:—-]+$/g, "").replace(/\s+/g, " ").trim();
}

interface Live {
  key: string;
  rank: number;
  count: number;
  until: number;
  /** When this line first reached the glass — the ceiling on its refreshes. */
  openedAt: number;
}

interface Held {
  a: Announcement;
  key: string;
  rank: number;
  at: number;
  count: number;
}

export class NotifMix {
  private readonly o: NotifOpts;
  /** The module's model of the glass, keyed by shape. */
  private readonly live = new Map<string, Live>();
  /** Shapes a banner owns right now → expiry. */
  private readonly banners = new Map<string, number>();
  private held: Held[] = [];
  private climax: ClimaxKind = null;
  private lastAt = -Infinity;
  private lastDwell = 0;

  constructor(opts: Partial<NotifOpts> = {}) {
    this.o = { ...NOTIF_DEFAULTS, ...opts };
  }

  /** Lines waiting for the glass — what the host's "+N more" chip reports. */
  pending(): number {
    return this.held.length;
  }

  /** What the module believes is on the glass (tests + the host's backstop). */
  liveCount(): number {
    return this.live.size;
  }

  climaxNow(): ClimaxKind {
    return this.climax;
  }

  /** A new run: the previous one's backlog is not this one's news. */
  reset(): void {
    this.live.clear();
    this.banners.clear();
    this.held = [];
    this.climax = null;
    this.lastAt = -Infinity;
    this.lastDwell = 0;
  }

  /**
   * The host tells the module what the glass is busy with, every frame.
   *
   * Entering a climax does NOT clear the column — a line the player is
   * halfway through reading is not noise, and yanking it is the r2 mistake
   * ("the player never read the news, they watched two sentences flick
   * past"). The one exception is DEATH: the census found the IN MEMORIAM
   * card itself clean but the INSTANT of death unprotected, arriving under a
   * "PARTY WIPE" banner plus a "succumbed to the poison" toast. That moment
   * is a hard cut — the glass goes to the banner alone.
   */
  setClimax(kind: ClimaxKind, now: number): NotifOp[] {
    if (kind === this.climax) return [];
    const was = this.climax;
    this.climax = kind;
    const ops: NotifOp[] = [];
    if (kind === "death" && was !== "death") {
      for (const key of this.live.keys()) ops.push({ op: "retire", key });
      this.live.clear();
      for (const h of this.held) ops.push({ op: "drop", a: h.a, why: "death" });
      this.held = [];
      return ops;
    }
    if (kind !== "boss") return ops;
    // A line the boss bar arrived UNDER is given a glance to finish and then
    // it goes. This is the difference between "never yanked mid-read" and
    // "rides a full seven-second hold across the fight": the first browser
    // pass measured one kill-combo line live for 254 of 340 boss-bar frames
    // purely because it had been released a moment before the plate came up.
    for (const l of this.live.values()) {
      if (l.rank >= RANK_BOSS_NEWS) continue;
      const until = Math.min(l.until, now + CLIMAX_YIELD_MS);
      if (until >= l.until) continue;
      l.until = until;
      ops.push({ op: "hold", key: l.key, holdMs: Math.max(0, until - now) });
    }
    return ops;
  }

  /**
   * Offer one announcement. Returns what presentation should do RIGHT NOW —
   * banner lines and coalesces are immediate; a fresh toast is queued and
   * comes back out of `pump`, so the cap and the gap can never be bypassed
   * by a burst that all arrives in one frame (which is exactly how a floor
   * transition arrives).
   */
  offer(a: Announcement, now: number): NotifOp[] {
    this.expire(now);
    const key = shapeKey(a.text);
    if (a.priority === "high") return this.offerBanner(a, key, now);

    // Rule 5: the ticker may not print what the banner is showing.
    if ((this.banners.get(key) ?? 0) > now) return [{ op: "drop", a, why: "banner" }];

    const rank = NOTIF_RANK[a.kind] ?? 0;

    // Rule 3, on the glass: the copy already up gets the count and the newest
    // wording, and keeps its slot for a fresh hold rather than taking a second.
    const on = this.live.get(key);
    if (on) {
      on.count++;
      on.until = Math.min(now + this.o.holdMs, on.openedAt + this.o.maxLifeMs);
      on.rank = Math.max(on.rank, rank);
      return [{ op: "bump", key, text: a.text, count: on.count, holdMs: Math.max(0, on.until - now) }];
    }

    // Rule 3, in the queue: a burst of one sentence waits as ONE line.
    const waiting = this.held.find((h) => h.key === key);
    if (waiting) {
      waiting.count++;
      waiting.a = a; // newest wording, original arrival — a group cannot outlive staleMs
      waiting.rank = Math.max(waiting.rank, rank);
      return [];
    }

    this.held.push({ a, key, rank, at: now, count: 1 });
    return this.spill();
  }

  private offerBanner(a: Announcement, key: string, now: number): NotifOp[] {
    const ops: NotifOp[] = [];
    // ONE BANNER PER SHAPE: a repeated headline (the net path replays the
    // batch's own announcements) does not queue behind itself.
    if ((this.banners.get(key) ?? 0) > now) return ops;
    this.banners.set(key, now + this.o.bannerMs);
    // ...and the quieter copy stands down, wherever it is.
    if (this.live.has(key)) {
      this.live.delete(key);
      ops.push({ op: "retire", key });
    }
    for (let i = this.held.length - 1; i >= 0; i--) {
      if (this.held[i].key !== key) continue;
      ops.push({ op: "drop", a: this.held[i].a, why: "banner" });
      this.held.splice(i, 1);
    }
    ops.push({ op: "banner", a });
    return ops;
  }

  /**
   * One frame of pacing: retire what the glass has finished with, reap the
   * backlog that stopped being news, and release AT MOST ONE line. One per
   * pump is what makes a burst read as sequential news instead of as a wall
   * that grew — the gap does the rest.
   */
  pump(now: number): NotifOp[] {
    this.expire(now);
    const ops: NotifOp[] = [];
    for (let i = this.held.length - 1; i >= 0; i--) {
      const h = this.held[i];
      if (now - h.at <= this.o.staleMs) continue;
      this.held.splice(i, 1);
      ops.push({ op: "drop", a: h.a, why: "stale" });
    }
    if (this.held.length === 0) return ops;
    if (this.live.size >= this.slots()) return ops;
    if (now < this.lastAt + this.gap()) return ops;
    const i = this.pick();
    if (i < 0) return ops;
    const [h] = this.held.splice(i, 1);
    this.live.set(h.key, {
      key: h.key, rank: h.rank, count: h.count,
      until: now + this.o.holdMs, openedAt: now,
    });
    this.lastAt = now;
    this.lastDwell = dwellMs(h.a.text);
    ops.push({ op: "toast", a: h.a, key: h.key, count: h.count, holdMs: this.o.holdMs });
    return ops;
  }

  /** Highest rank the climax allows, oldest first inside a rank. */
  private pick(): number {
    const floor = this.climax === "death" ? Infinity
      : this.climax === "boss" ? RANK_BOSS_NEWS
        : -Infinity;
    let best = -1;
    for (let i = 0; i < this.held.length; i++) {
      const h = this.held[i];
      if (h.rank < floor) continue;
      if (best < 0 || h.rank > this.held[best].rank
        || (h.rank === this.held[best].rank && h.at < this.held[best].at)) best = i;
    }
    return best;
  }

  /**
   * A door's news is SEQUENTIAL news (r3 finding 2): during a descent one
   * line owns the glass at a time, and the gap is the previous line's own
   * reading time. Everywhere else the cap is the cap.
   */
  private slots(): number {
    return this.climax === "descend" ? 1 : this.o.max;
  }

  private gap(): number {
    return this.climax === "descend" ? Math.max(this.o.gapMs, this.lastDwell) : this.o.gapMs;
  }

  /** Rule 4: past the cap the CHEAPEST, oldest waiting line spills. */
  private spill(): NotifOp[] {
    const ops: NotifOp[] = [];
    while (this.held.length > this.o.queueMax) {
      let victim = 0;
      for (let i = 1; i < this.held.length; i++) {
        if (this.held[i].rank < this.held[victim].rank
          || (this.held[i].rank === this.held[victim].rank && this.held[i].at < this.held[victim].at)) victim = i;
      }
      const [gone] = this.held.splice(victim, 1);
      ops.push({ op: "drop", a: gone.a, why: "overflow" });
    }
    return ops;
  }

  private expire(now: number): void {
    for (const [k, l] of this.live) if (l.until <= now) this.live.delete(k);
    for (const [k, t] of this.banners) if (t <= now) this.banners.delete(k);
  }
}

/** How long a line owns the glass before the next one is released during a
 *  descent: its own reading time, floored and capped. */
export function dwellMs(text: string): number {
  return Math.min(2600, Math.max(1400, 26 * text.length));
}
