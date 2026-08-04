import type Database from "better-sqlite3";
import { dailyRuleFor, DAILY_RULES } from "../sim/dailyRules";
import { flipDayFromMs } from "./flip";

/**
 * THE CREW WIRE (NICHE.md 4.6): an opt-in Discord webhook per crew — the one
 * mechanism in the design that reaches a player whose app is CLOSED. A crew
 * is a named, saved group: webhook URL + crew name, registered once by
 * whoever owns the Discord channel. The game's social graph is deliberately
 * external (§5 bans friends lists); the wire leans into that.
 *
 * The privacy stance, enforced structurally rather than by promise:
 *  - Opt-in per crew. Registration IS the opt-in; nothing posts anywhere
 *    until a channel owner brings a webhook.
 *  - No DMs, no individual tracking. A crew row stores a channel, never a
 *    member list — the server cannot address a person, only a room. The
 *    five events are all room-scale facts (a race forming, a day flipping).
 *  - One-click revoke: the registration response carries a revoke link;
 *    opening it deletes the row. Discord's own "delete webhook" works too.
 *  - Kill switch server-side: CREW_WIRE_OFF=1 silences every call site.
 *  - Rate-limited per crew, capped per day; failure mode is a silently
 *    skipped ping (NICHE.md §8: the only new external dependency).
 *
 * Webhook URLs must be Discord webhook URLs — the server refuses anything
 * else, because "POST wherever a client asks" is an SSRF primitive, not a
 * feature.
 */

export interface CrewRow {
  id: string;
  name: string;
  webhookUrl: string;
  revokeToken: string;
  /** Standing crew window (NICHE.md 4.5 layer 2): UTC weekday 0-6 (Sunday=0)
   *  + UTC hour, or null when the crew never scheduled one. */
  windowDow: number | null;
  windowHour: number | null;
  createdAt: number;
}

export const MAX_CREWS = 200;
export const CREW_NAME_MAX = 24;
/** Discord webhook URLs only — everything else is refused at registration. */
const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export function validWebhook(url: unknown): url is string {
  return typeof url === "string" && url.length <= 300 && WEBHOOK_RE.test(url);
}

/** Crew display name: same spirit as sanitizeName, applied server-side. */
export function sanitizeCrewName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[^\w \-'.]/g, "").trim().slice(0, CREW_NAME_MAX);
  return s || "THE CREW";
}

const CREW_SCHEMA = `
CREATE TABLE IF NOT EXISTS crews (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  webhook_url  TEXT NOT NULL,
  revoke_token TEXT NOT NULL UNIQUE,
  window_dow   INTEGER,
  window_hour  INTEGER,
  created_at   INTEGER NOT NULL
);
`;

export class CrewStore {
  constructor(private db: Database.Database) {
    db.exec(CREW_SCHEMA);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM crews").get() as { n: number }).n;
  }

  register(row: CrewRow): void {
    this.db.prepare(
      `INSERT INTO crews (id, name, webhook_url, revoke_token, window_dow, window_hour, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.name, row.webhookUrl, row.revokeToken, row.windowDow, row.windowHour, row.createdAt);
  }

  /** One-click revoke: the token deletes the row, the wire goes silent. */
  revoke(token: string): boolean {
    return this.db.prepare("DELETE FROM crews WHERE revoke_token = ?").run(token).changes > 0;
  }

  byId(id: string): CrewRow | null {
    const r = this.db.prepare("SELECT * FROM crews WHERE id = ?").get(id) as
      | { id: string; name: string; webhook_url: string; revoke_token: string; window_dow: number | null; window_hour: number | null; created_at: number }
      | undefined;
    return r ? {
      id: r.id, name: r.name, webhookUrl: r.webhook_url, revokeToken: r.revoke_token,
      windowDow: r.window_dow, windowHour: r.window_hour, createdAt: r.created_at,
    } : null;
  }

  list(): CrewRow[] {
    const rows = this.db.prepare("SELECT * FROM crews ORDER BY created_at").all() as
      { id: string; name: string; webhook_url: string; revoke_token: string; window_dow: number | null; window_hour: number | null; created_at: number }[];
    return rows.map((r) => ({
      id: r.id, name: r.name, webhookUrl: r.webhook_url, revokeToken: r.revoke_token,
      windowDow: r.window_dow, windowHour: r.window_hour, createdAt: r.created_at,
    }));
  }
}

/** A race whose code carries a crew's prefix belongs to that crew — the one
 *  deterministic link between an instance and a channel, chosen so the wire
 *  never needs (and never gets) a member list. CREW-<id>-anything. */
export function crewIdFromCode(code: string): string | null {
  const m = /^CREW-([A-Za-z0-9]{4,12})(-|$)/.exec(code);
  return m ? m[1] : null;
}

/** Next occurrence of a crew's standing window at or after `now` (epoch ms). */
export function nextWindowMs(now: number, dow: number, hourUtc: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  const shift = (dow - d.getUTCDay() + 7) % 7;
  let at = t + shift * 86_400_000;
  if (at <= now) at += 7 * 86_400_000;
  return at;
}

// Rate limits: generous for a channel people chose to wire, tight enough
// that a bug (or a busy night) never turns the wire into spam Discord has
// to police for us.
export const WIRE_MIN_GAP_MS = 15_000;
export const WIRE_MAX_PER_DAY = 40;

export interface WireOptions {
  /** Kill switch (env CREW_WIRE_OFF): every post becomes a no-op. */
  enabled: boolean;
  /** Public origin for join links, e.g. https://dungeon-crawler-claude.fly.dev */
  baseUrl: string;
  /** Injected transport (tests). Default: fetch to the webhook, 5s timeout. */
  post?: (webhookUrl: string, content: string) => Promise<void>;
  now?: () => number;
  /**
   * Fires once per DISPATCHED post (past the kill switch and the rate
   * limits). §7's falsification number — "app opens within 15 minutes of a
   * wire ping vs baseline" — needs every ping on durable record; the
   * in-memory `posts` counter resets on deploy and a Prometheus scrape is
   * too coarse to anchor a 15-minute window. GameServer writes a
   * usage_events row (kind "wire_post") here.
   */
  onPosted?: (crewId: string, event: string) => void;
}

export class CrewWire {
  private lastPostAt = new Map<string, number>();
  private postedOnDay = new Map<string, { day: string; n: number }>();
  /** Window dedupe: crewId -> the window instant already announced. */
  private windowSoonFired = new Map<string, number>();
  private windowOpenFired = new Map<string, number>();
  private lastFlipDay: string | null = null;
  private readonly now: () => number;
  private readonly send: (url: string, content: string) => Promise<void>;
  /** Posts actually dispatched — /health-visible via GameServer metrics. */
  posts = 0;

  constructor(private store: CrewStore, private opts: WireOptions) {
    this.now = opts.now ?? Date.now;
    this.send = opts.post ?? defaultPost;
  }

  /** Rate-limited, fire-and-forget. The wire never blocks the tick and a
   *  down webhook is a skipped ping, not an error anyone waits on. `event`
   *  names which of the five 4.6 events this post carries — it goes to
   *  onPosted (the durable wire_post row), never to Discord. */
  postTo(crew: CrewRow, content: string, event = "post"): boolean {
    if (!this.opts.enabled) return false;
    const now = this.now();
    const day = flipDayFromMs(now, 0);
    const last = this.lastPostAt.get(crew.id) ?? 0;
    if (now - last < WIRE_MIN_GAP_MS) return false;
    const bucket = this.postedOnDay.get(crew.id);
    const n = bucket && bucket.day === day ? bucket.n : 0;
    if (n >= WIRE_MAX_PER_DAY) return false;
    this.lastPostAt.set(crew.id, now);
    this.postedOnDay.set(crew.id, { day, n: n + 1 });
    this.posts++;
    this.opts.onPosted?.(crew.id, event);
    void this.send(crew.webhookUrl, content).catch(() => { /* skipped ping */ });
    return true;
  }

  private postAll(content: string, event: string): void {
    for (const crew of this.store.list()) this.postTo(crew, content, event);
  }

  private joinUrl(code: string): string {
    return `${this.opts.baseUrl}/iso.html?rivals=1&join=${encodeURIComponent(code)}`;
  }

  // ---- the five events (NICHE.md 4.6 — these, and nothing else) ----------

  /** 1. RACE FORMING: a public rush race found its second human. */
  raceForming(code: string, seats: number, cap: number, msLeft: number): void {
    const secs = Math.max(0, Math.round(msLeft / 1000));
    this.postAll(
      `**RACE FORMING** — ${seats}/${cap} seated, gun in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}. `
      + `The System is holding a seat with your name misspelled on it.\njoin → ${this.joinUrl(code)}`,
      "race_forming",
    );
  }

  /** 2. CREW WINDOW: 15 minutes out, then at the gun (per 4.5 layer 2). */
  windowSoon(crew: CrewRow, at: number): void {
    if (this.windowSoonFired.get(crew.id) === at) return;
    this.windowSoonFired.set(crew.id, at);
    this.postTo(crew,
      `**${crew.name.toUpperCase()} — YOUR WINDOW OPENS IN 15 MINUTES.** `
      + `The System has swept the arena and hidden the good loot. Stretch.`,
      "window_soon");
  }

  windowOpen(crew: CrewRow, at: number, day: string): void {
    if (this.windowOpenFired.get(crew.id) === at) return;
    this.windowOpenFired.set(crew.id, at);
    const code = `CREW-${crew.id}-${day}`;
    this.postTo(crew,
      `**${crew.name.toUpperCase()} — THE WINDOW IS OPEN.** Four seats, one dungeon, `
      + `starting gun at second zero.\nrace → ${this.joinUrl(code)}`,
      "window_open");
  }

  /** 3. DAILY FLIPPED (+ today's rule; + yesterday's named winner when the
   *  board has one — the §4.8 line rides the flip ping it belongs to), and
   *  4. YOUR CREW'S DAILY BOARD LINE, riding the same ping: `crewLine` is the
   *  crew's own best row on the board that just closed, derived from board
   *  rows of accounts that raced under the crew's CREW- codes — never from a
   *  member list (the crew row stays a channel; the derivation is
   *  GameServer.crewBoardLine's). Per-crew content, one POST per crew. */
  dailyFlipped(day: string, yesterdayWinner: string | null,
    crewLine?: (crewId: string) => string | null): void {
    const rule = dailyRuleFor(day);
    const base = [
      `**THE DUNGEON ROTATED.** The daily ${day} is open.`,
      rule ? DAILY_RULES[rule].line : null,
      yesterdayWinner,
    ].filter((l): l is string => !!l);
    for (const crew of this.store.list()) {
      const lines = [
        ...base,
        crewLine?.(crew.id) ?? null,
        `run it → ${this.opts.baseUrl}/iso.html`,
      ].filter((l): l is string => !!l);
      this.postTo(crew, lines.join("\n"), "daily_flip");
    }
  }

  /** 5. RACE RECAP: the finished race's card + superlatives, posted to the
   *  crew whose code it ran under — which is also how a racer who conceded
   *  and left still gets their headline in the channel (NICHE.md 4.7). */
  raceRecap(crewId: string, headline: string, superlatives: string[], rematchCode: string): void {
    const crew = this.store.byId(crewId);
    if (!crew) return;
    const lines = [
      `**${headline}**`,
      ...superlatives.map((s) => `· ${s}`),
      `rematch → ${this.joinUrl(rematchCode)}`,
    ];
    this.postTo(crew, lines.join("\n"), "race_recap");
  }

  /**
   * The minute sweep: crew windows (15-out + at-the-gun) and the daily flip.
   * Dedupe is in-memory — a deploy inside the window's exact minute can at
   * worst repeat one ping, which Discord survives and the doc's failure
   * budget (silently skipped ping) more than covers.
   */
  sweep(now: number, flipHourUtc: number, yesterdayWinner: () => string | null,
    crewLine?: (crewId: string) => string | null): void {
    if (!this.opts.enabled) return;
    // Daily flip: fire on the edge only — boot primes the day without posting.
    const day = flipDayFromMs(now, flipHourUtc);
    if (this.lastFlipDay === null) this.lastFlipDay = day;
    else if (day !== this.lastFlipDay) {
      this.lastFlipDay = day;
      this.dailyFlipped(day, yesterdayWinner(), crewLine);
    }
    // Crew windows.
    for (const crew of this.store.list()) {
      if (crew.windowDow == null || crew.windowHour == null) continue;
      // The window that is nearest — possibly already begun (grace: 5 min).
      const next = nextWindowMs(now, crew.windowDow, crew.windowHour);
      const current = next - 7 * 86_400_000;
      const at = now - current <= 5 * 60_000 ? current : next;
      const lead = at - now;
      if (lead <= 15 * 60_000 && lead > 5 * 60_000) this.windowSoon(crew, at);
      if (lead <= 0 && now - at <= 5 * 60_000) {
        this.windowOpen(crew, at, flipDayFromMs(at, flipHourUtc));
      }
    }
  }

  /** The next few scheduled crew windows — the RUSH surface's calendar. */
  upcomingWindows(now: number, limit = 3): { crew: string; at: number }[] {
    const out: { crew: string; at: number }[] = [];
    for (const crew of this.store.list()) {
      if (crew.windowDow == null || crew.windowHour == null) continue;
      out.push({ crew: crew.name, at: nextWindowMs(now, crew.windowDow, crew.windowHour) });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, limit);
  }
}

/** Production transport: one POST, 5s cap, mentions structurally disarmed
 *  (crawler names are player-supplied; none of them get to say @everyone). */
async function defaultPost(webhookUrl: string, content: string): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}
