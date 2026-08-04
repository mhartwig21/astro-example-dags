// TODAY'S RULE (NICHE.md §4.8): one seeded run-level mutator per day, the
// same for everyone, announced in the System's voice. The rule re-ranks the
// build space for a day — replayability compounding, not content spend — and
// gives the live daily its texture: today's rule is today's meta, for one day.
//
// Pure module: the rule id is a function of the DAY STRING (hosts supply it,
// like dailySeed), never the wall clock. The sim reads state.dailyRule at a
// handful of named seams in game.ts/ai.ts; null means "no rule" and every
// seam collapses to the base game — solo runs, private races and the balance
// contract all measure the base game unless a rule is explicitly dealt in.
//
// POOL DISCIPLINE (§4.8 + §7): the pool is a portfolio, not a museum. A rule
// ships only through the balance sweep (win rate inside 25-55% on a sweep
// with the rule forced), and a live rule whose day dips participation >20%
// vs trailing average — or lands outside the band — is pulled. Rotation
// stays DARK (dailyRuleFor returns null) until DAILY_RULE_ROTATION has
// members; step 0's gate-lift is what opened it (2026-08-04).

export type DailyRuleId = "rush_hour" | "overstaffed" | "hair_trigger";

export interface DailyRuleDef {
  id: DailyRuleId;
  /** Headline name, System register — the daily card and the wire print it. */
  name: string;
  /** The System's announcement, delivered once at second zero. */
  line: string;
}

export const DAILY_RULES: Record<DailyRuleId, DailyRuleDef> = {
  rush_hour: {
    id: "rush_hour",
    name: "RUSH HOUR",
    line: "TODAY'S RULE: RUSH HOUR. The collapse clocks run 20% shorter. "
      + "Appearance fees are up 50%, payable in gold, on the floor, where you dropped it.",
  },
  overstaffed: {
    id: "overstaffed",
    name: "OVERSTAFFED",
    line: "TODAY'S RULE: OVERSTAFFED. Management has issued a second named "
      + "menace per floor. Named menaces carry severance packages. Collect them.",
  },
  hair_trigger: {
    id: "hair_trigger",
    name: "HAIR TRIGGER",
    line: "TODAY'S RULE: HAIR TRIGGER. Bosses telegraph 25% faster and hit "
      + "20% harder. The System considers this a readability exercise.",
  },
};

/** The rotation: rules currently dealt into the daily draw. Grows a rule a
 *  week (NICHE.md §6 step 8), each through the balance sweep first. */
export const DAILY_RULE_ROTATION: DailyRuleId[] = ["rush_hour", "overstaffed", "hair_trigger"];

/** djb2 over a salted day string — same family as dailySeed, different salt
 *  so the rule draw never correlates with the dungeon draw. */
export function dailyRuleFor(day: string): DailyRuleId | null {
  if (DAILY_RULE_ROTATION.length === 0) return null; // rotation dark
  const s = `dcc-rule-${day}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return DAILY_RULE_ROTATION[h % DAILY_RULE_ROTATION.length];
}

// ---- The seams (each consulted exactly once in game.ts/ai.ts) ----

/** RUSH HOUR: collapse budget multiplier (race floors only). */
export function ruleCollapseMult(rule: DailyRuleId | null | undefined): number {
  return rule === "rush_hour" ? 0.8 : 1;
}

/** RUSH HOUR: gold pickups pay more — the shorter clock's severance. */
export function ruleGoldMult(rule: DailyRuleId | null | undefined): number {
  return rule === "rush_hour" ? 1.5 : 1;
}

/** OVERSTAFFED: a second neighborhood elite per ordinary floor. */
export function ruleSecondElite(rule: DailyRuleId | null | undefined): boolean {
  return rule === "overstaffed";
}

/** OVERSTAFFED: elites always drop one extra catalog component. */
export function ruleEliteSeverance(rule: DailyRuleId | null | undefined): boolean {
  return rule === "overstaffed";
}

/** HAIR TRIGGER: boss telegraph duration multiplier (clamped downstream —
 *  beginBossWindup's 0.2s hard rule still holds). */
export function ruleBossTelegraphMult(rule: DailyRuleId | null | undefined): number {
  return rule === "hair_trigger" ? 0.75 : 1;
}

/** HAIR TRIGGER: boss damage multiplier, applied once at boss creation. */
export function ruleBossDamageMult(rule: DailyRuleId | null | undefined): number {
  return rule === "hair_trigger" ? 1.2 : 1;
}
