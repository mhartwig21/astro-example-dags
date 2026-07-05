// The Daily Crawl: one shared dungeon per calendar day. The seed is a pure
// function of the date string, so every crawler on Earth (and the server
// validating their scores) derives the same dungeon with no coordination.
// Pure module — hosts supply the date; nothing here touches the wall clock.

/** djb2 over a salted day string — same family as seedFromCode. */
export function dailySeed(day: string): number {
  const s = `dcc-daily-${day}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** Strict YYYY-MM-DD (UTC calendar date). */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  return y >= 2026 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** The UTC day string for a wall-clock ms timestamp (hosts pass Date.now()). */
export function dayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
