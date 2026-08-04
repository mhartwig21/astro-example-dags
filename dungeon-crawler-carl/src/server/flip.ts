// THE WINDOW IS A CONFIG, NOT A CONSTANT (NICHE.md §4.5). At friends scale
// the population is effectively one timezone, so the daily flip should land
// in THAT population's evening — not at a UTC midnight chosen for a global
// audience that doesn't exist yet. The flip hour is a server config
// (DAILY_FLIP_HOUR_UTC, 0–23, default 0); 00:00 UTC is what we graduate back
// to when <60% of weekly session starts come from one 4-hour local window
// (§7's graduation number).
//
// Deliberately SERVER-side, not src/sim: dayFromMs lives in the sim tree and
// the rules hash covers that tree — a scheduling config must never burn an
// era (every recorded proof would stop being playable over a lobby detail).
// The sim's own day handling is untouched: a daily's day string still rides
// the code/event row, and dailySeed(day) is the same pure function everywhere.

import { dayFromMs } from "../sim/daily";

/** Clamp anything env-shaped to a real hour. Bad input = midnight UTC. */
export function parseFlipHour(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 0;
}

/** The population's current daily day: the calendar day that began at the
 *  configured flip hour. flipHour=0 is exactly the old UTC-midnight day. */
export function flipDayFromMs(ms: number, flipHourUtc: number): string {
  return dayFromMs(ms - flipHourUtc * 3600_000);
}

/** When this day's dungeon opened (the flip instant), in epoch ms. */
export function flipOpensAtMs(day: string, flipHourUtc: number): number {
  return Date.parse(day + "T00:00:00Z") + flipHourUtc * 3600_000;
}

/** Countdown to the next rotation — the honest between-windows line
 *  ("THE DUNGEON ROTATES 20:00 YOUR TIME" is this number, restated local). */
export function msUntilFlip(ms: number, flipHourUtc: number): number {
  const day = flipDayFromMs(ms, flipHourUtc);
  return flipOpensAtMs(day, flipHourUtc) + 86_400_000 - ms;
}
