import { CONFIG } from "../sim/config";

/**
 * DEATH IS A DOOR (NICHE.md 4.7): a guaranteed superlative per seat at race
 * end — four seats, four DIFFERENT headlines; the System has never been at a
 * loss for words. Pure arithmetic over run summaries the server already has
 * (no sim changes). A conceded seat still gets one — "leaving early costs
 * nothing" — with the doc's exact framing bolted on the front.
 */
export interface SeatSummary {
  id: number;
  name: string;
  won: boolean;
  floor: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  gold: number;
  level: number;
  conceded: boolean;
}

interface Category {
  /** Seats are ranked by this; the leader (strictly > 0) claims the line. */
  value: (s: SeatSummary) => number;
  line: (s: SeatSummary) => string;
}

// Order = assignment priority. The winner's line is handled before any of
// these, so every category here is a consolation with teeth.
const CATEGORIES: Category[] = [
  {
    value: (s) => s.floor,
    line: (s) => `DEEPEST RIVAL — FLOOR ${s.floor} OF ${CONFIG.finalFloor}`,
  },
  {
    value: (s) => s.kills,
    line: (s) => `THE EXTERMINATOR — ${s.kills} KILLS`,
  },
  {
    value: (s) => s.damageDealt,
    line: (s) => `THE WRECKING CREW — ${Math.round(s.damageDealt)} DAMAGE DEALT`,
  },
  {
    value: (s) => s.damageTaken,
    line: (s) => `THE HUMAN SHIELD — ATE ${Math.round(s.damageTaken)} DAMAGE AND KEPT WALKING`,
  },
  {
    value: (s) => s.gold,
    line: (s) => `THE ECONOMY — ${s.gold} GOLD BANKED`,
  },
  {
    value: (s) => s.level,
    line: (s) => `THE PROSPECT — LEVEL ${s.level}`,
  },
];

/**
 * One headline per seat, all different. The winner always gets the crown;
 * everyone else claims their most flattering UNCLAIMED category (walked in
 * priority order); a seat that leads nothing still leaves with a line —
 * the guarantee is the point.
 */
export function raceSuperlatives(seats: SeatSummary[]): Map<number, string> {
  const out = new Map<number, string>();
  if (seats.length === 0) return out;
  const winner = seats.find((s) => s.won);
  if (winner) out.set(winner.id, `TOOK THE DUNGEON — ${winner.kills} KILLS ON THE WAY`);
  const rest = seats.filter((s) => !out.has(s.id));
  const claimed = new Set<number>(); // category indices already used
  // Deterministic: seats in id order, categories in priority order.
  for (const seat of [...rest].sort((a, b) => a.id - b.id)) {
    let picked = -1;
    for (let ci = 0; ci < CATEGORIES.length; ci++) {
      if (claimed.has(ci)) continue;
      const v = CATEGORIES[ci].value(seat);
      if (v <= 0) continue;
      // Claim it only if nobody UNASSIGNED leads this category harder.
      const rivals = rest.filter((s) => s.id !== seat.id && !out.has(s.id));
      if (rivals.every((s) => CATEGORIES[ci].value(s) <= v)) { picked = ci; break; }
    }
    if (picked < 0) {
      // Lead nothing? Take the best unclaimed category you have any number in.
      for (let ci = 0; ci < CATEGORIES.length; ci++) {
        if (!claimed.has(ci) && CATEGORIES[ci].value(seat) > 0) { picked = ci; break; }
      }
    }
    const base = picked >= 0
      ? CATEGORIES[picked].line(seat)
      : "SHOWED UP. THE SYSTEM RESPECTS ATTENDANCE.";
    if (picked >= 0) claimed.add(picked);
    out.set(seat.id, seat.conceded ? `DIED EARLY, DIED SPECTACULARLY: ${base}` : base);
  }
  return out;
}

/** The wire/next-session sentence for one seat, System-addressed. */
export function headlineLine(name: string, superlative: string): string {
  return `THE SYSTEM, RE: ${name.toUpperCase()}'S LAST RACE — ${superlative}`;
}
