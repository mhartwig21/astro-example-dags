// Display-name hygiene. Names are player-supplied and land on PUBLIC surfaces
// (leaderboards, party chips, rival standings), so the server normalizes them
// at every ingress: join, board submits, profile reads. Friendly-scale policy:
// strip the unprintable, cap the length, and refuse the worst words -- this is
// a moderation seatbelt, not a moderation system.

const MAX_LEN = 24;

// Leet-normalization for the block check ("a55h0le" reads as its intent).
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
};

// Deliberately short: slurs and the words nobody defends on a public board.
// Substring-matched after normalization -- extend as the community reports.
const BLOCKED = [
  "nigger", "nigga", "faggot", "kike", "spic", "chink", "tranny", "retard",
  "hitler", "nazi", "rape", "raping",
];

// Control chars, zero-width/format chars, bidi overrides, BOM. Built from
// escaped strings so the ranges stay visible in source (raw control chars
// in a regex literal are unreadable and easy to corrupt).
const UNPRINTABLE = new RegExp(
  "[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]",
  "g",
);
const ZALGO_STACKS = new RegExp("[\u0300-\u036f]{3,}", "g");

function normalized(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((c) => LEET[c] ?? c)
    .join("")
    .replace(/[^a-z]/g, "");
}

/**
 * Clean a raw display name: control/format characters out, combining-mark
 * zalgo capped, whitespace collapsed, length capped. Returns the fallback
 * when nothing survives or the name trips the block list.
 */
export function sanitizeName(raw: unknown, fallback = "Crawler"): string {
  const s = String(raw ?? "")
    .replace(UNPRINTABLE, "")
    .replace(ZALGO_STACKS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LEN)
    .trim();
  if (s.length < 2) return fallback;
  if (BLOCKED.some((w) => normalized(s).includes(w))) return fallback;
  return s;
}
