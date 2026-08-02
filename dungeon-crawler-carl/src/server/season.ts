/**
 * SEASONS, CP AND TIERS (COMPETITIVE.md 3.2C / 3.5). Pure functions - no DB,
 * no clock beyond the timestamp handed in - so the arithmetic on the post-run
 * screen and the arithmetic on the ladder are literally the same code.
 *
 * The deliberate departures from LoL, both of which follow from the game being
 * a solo performance against a fixed dungeon rather than symmetric PvP:
 *
 *  - CP is a PORTFOLIO, not a rating: your season score is the sum of your best
 *    10 event results. Missing a week costs a counting slot, not a number you
 *    have to defend.
 *  - THERE IS NO DECAY. CP is not a claim about your current strength; it is a
 *    record of what you did this season, and you do not un-do it. Urgency comes
 *    from the season reset. If the top ever needs freshness pressure, the lever
 *    already exists: only your best 10 of ~50 events count, so late results
 *    displace early ones on their own.
 */
import { dailySeed, dayFromMs } from "../sim/daily";

/** 6-8 weeks - one cour of the show. Anchored so seasons are computable
 *  offline and identically on the client. */
export const SEASON_LENGTH_DAYS = 49;
export const SEASON_EPOCH_MS = Date.UTC(2026, 0, 5); // a Monday

export function seasonIdFor(ms: number): string {
  const n = Math.max(0, Math.floor((ms - SEASON_EPOCH_MS) / (SEASON_LENGTH_DAYS * 86400_000)));
  return "S" + (n + 1);
}

export function seasonEndsAt(ms: number): number {
  const n = Math.max(0, Math.floor((ms - SEASON_EPOCH_MS) / (SEASON_LENGTH_DAYS * 86400_000)));
  return SEASON_EPOCH_MS + (n + 1) * SEASON_LENGTH_DAYS * 86400_000;
}

/** Flat floor for finishing a ticketed event at all, before placement. */
export const CP_PARTICIPATION = 40;

/**
 * CP for a placed run. Transparent enough to print on the post-run screen,
 * which is the point: a player who learns the rule from the screen is informed,
 * a player who discovers it at the end of a season is furious and correct.
 */
export function cpFor(rank: number, entrants: number): number {
  if (rank < 1 || entrants < 1) return 0;
  const share = 1 - rank / entrants;
  const placed = share <= 0 ? 0 : Math.round(1000 * dpow15(share));
  return CP_PARTICIPATION + placed;
}

/** x^1.5 without Math.pow - this number is printed to players and compared
 *  across machines, so it uses the exactly-rounded subset like the sim does. */
function dpow15(x: number): number {
  return x * Math.sqrt(x);
}

export const TIERS = [
  "BRONZE ENTRANT", "SILVER PROSPECT", "GOLD CONTENDER", "CHAMPION", "HEADLINER", "THE SHOW",
] as const;
export type Tier = (typeof TIERS)[number];

/** Population floors, and the reason they exist: at under ~60 ranked accounts
 *  EVERY ranked player is a HEADLINER and a sixth of the game is in THE SHOW.
 *  LoL can afford absolute segmentation at 100M MAU; cosplaying it here is the
 *  exact failure the ladder design set out to avoid. Below the floors the
 *  ladder shows CP and "rank 7 of 34", which is honest and perfectly
 *  motivating, and the tier names arrive as the population earns them. */
export const SHOW_MIN_ACCOUNTS = 200;
export const HEADLINER_MIN_ACCOUNTS = 60;
/**
 * ...and the floor applies to the WHOLE LADDER, not just the two prestige
 * names. Awarding BRONZE ENTRANT to the last-placed player in a four-account
 * season is the same nonsense as awarding HEADLINER to the first: both dress a
 * population of four in the costume of a population of four hundred, and the
 * player can count the entrants. Below this, the honest display is the one the
 * design already argued for - CP plus "rank 7 of 34" - and the System says
 * plainly what unlocks the names.
 */
export const TIER_MIN_ACCOUNTS = 60;
/** Placement: no tier is shown until 3 events are banked. Same purpose as
 *  LoL's ten placement games, without pretending we estimate a hidden MMR. */
export const PLACEMENT_EVENTS = 3;

export interface Standing {
  cp: number;
  rank: number;
  entrants: number;
  eventsCounted: number;
  /** null while in placement, or below the population floor for any tier. */
  tier: Tier | null;
  placementRemaining: number;
  /** Ranked accounts required before ANY tier name is awarded. Printed, so a
   *  suppressed tier reads as a season that has not filled up yet rather than
   *  as a bug. */
  tierFloor: number;
}

/** Live percentile bands over the season CP distribution. */
export function standingFor(
  cp: number, rank: number, entrants: number, eventsCounted: number,
): Standing {
  const placementRemaining = Math.max(0, PLACEMENT_EVENTS - eventsCounted);
  const base: Standing = {
    cp, rank, entrants, eventsCounted, tier: null, placementRemaining, tierFloor: TIER_MIN_ACCOUNTS,
  };
  if (placementRemaining > 0 || entrants < TIER_MIN_ACCOUNTS) return base;
  const pct = rank / entrants; // 0 = best
  if (pct <= 0.01 && entrants >= SHOW_MIN_ACCOUNTS) return { ...base, tier: "THE SHOW" };
  if (pct <= 0.05 && entrants >= HEADLINER_MIN_ACCOUNTS) return { ...base, tier: "HEADLINER" };
  if (pct <= 0.20) return { ...base, tier: "CHAMPION" };
  if (pct <= 0.45) return { ...base, tier: "GOLD CONTENDER" };
  if (pct <= 0.75) return { ...base, tier: "SILVER PROSPECT" };
  return { ...base, tier: "BRONZE ENTRANT" };
}

// ---- event identity --------------------------------------------------------

export interface EventSpec {
  id: string;
  kind: "daily" | "weekly";
  day: string;
  seed: number;
  opensAt: number;
  closesAt: number;
  season: string;
}

/** THE DAILY CONTRACT. dailySeed already exists and the board already runs;
 *  what is new is that every entry is verification-mandatory. */
export function dailyEvent(nowMs: number): EventSpec {
  const day = dayFromMs(nowMs);
  const opens = Date.parse(day + "T00:00:00Z");
  return {
    id: "daily-" + day,
    kind: "daily",
    day,
    seed: dailySeed(day),
    opensAt: opens,
    closesAt: opens + 86400_000,
    season: seasonIdFor(nowMs),
  };
}

/** THE WEEKLY CONTRACT - the Clash analogue, minus the "five friends free at
 *  8pm" requirement that makes Clash hard to actually play. Open 7 days. */
export function weeklyEvent(nowMs: number): EventSpec {
  const day = dayFromMs(nowMs);
  const dow = new Date(day + "T00:00:00Z").getUTCDay();
  const mondayMs = Date.parse(day + "T00:00:00Z") - ((dow + 6) % 7) * 86400_000;
  const monday = dayFromMs(mondayMs);
  return {
    id: "weekly-" + monday,
    kind: "weekly",
    day: monday,
    seed: dailySeed("weekly-" + monday),
    opensAt: mondayMs,
    closesAt: mondayMs + 7 * 86400_000,
    season: seasonIdFor(nowMs),
  };
}
