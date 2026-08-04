/**
 * THE PLAYER-FACING COMPETITIVE LAYER - logic half (COMPETITIVE.md 3-6, 8).
 *
 * `main3d.ts` owns the SCREENS; this module owns everything those screens need
 * in order to be TRUE: the grade arithmetic and its cold-start fallback, the
 * sentence that names your death, the split ledger, the challenge codec, and
 * typed views of the server projections. Keeping it here means the numbers on
 * the post-run screen and the numbers on the ladder are computed by one piece
 * of code, and that code is testable without a DOM.
 *
 * The rule this module exists to enforce: NOTHING ON SCREEN MAY IMPLY A
 * POPULATION IT DOES NOT HAVE. Every comparison carries the set it was measured
 * against (vs YOUR 27 RUNS - TODAY'S 84), every unproven row says so on its
 * face, and a first run gets a real grade off an authored absolute curve rather
 * than a flattering placeholder.
 */
import { CONFIG, FLOOR_BANDS, floorBand } from "../sim/config";
import type { RunBuild } from "../sim/replay";
import type { LastHitSrc } from "../sim/types";
import type { RunRecord } from "../persist/history";

// ---------------------------------------------------------------------------
// Typed views of the server projections (competitiveApi.ts publicRun et al.)
// ---------------------------------------------------------------------------

export type RunState = "claimed" | "verifying" | "verified" | "rejected" | "unverifiable";

export interface BoardRun {
  id: string;
  name: string;
  /** The crawler's DERIVED public name (sha256 of the account id). Never the
   *  account id: that string IS the bearer token the server authenticates on,
   *  and a board that carried it handed every reader a working credential for
   *  every ranked player. The client only ever needed it for the YOU / RIVAL
   *  tag on a row. */
  publicId: string;
  eventId: string | null;
  state: RunState;
  reason: string | null;
  rulesEra: string | null;
  /** WHICH GAME this row was played under - not just which numbers. The era
   *  chip answers the second question; nothing answered the first, and the roam
   *  exploit lived in exactly that blind spot. */
  mode?: string;
  runKind?: string;
  /** Whether a film ever existed for this row, and whether it still does.
   *  "never" is a RIVALS row the authoritative sim decided itself: there was
   *  nothing to record, and telling the player it "aged out of retention" is a
   *  false statement in the one product whose pitch is that it does not make
   *  them. */
  film?: "retained" | "expired" | "never";
  playable: boolean;
  won: boolean;
  floor: number;
  timeSec: number;
  ticks: number;
  kills: number;
  level: number;
  ultimate: string | null;
  partySize: number;
  attemptNo: number | null;
  private: boolean;
  /** Verifier-derived and stored at certification, so a board row can fill a
   *  scoreboard column instead of printing a dash. 0 on rows sealed before
   *  these were persisted. */
  damageDealt: number;
  damageTaken: number;
  goldSpent: number;
  bandSplits: number[] | null;
  death: LastHitSrc | null;
  build: RunBuild | null;
  verifiedAt: number | null;
  at: number;
  /** Only on /bands/:n rows. */
  bandTicks?: number;
}

export interface BoardPage {
  kind: string;
  eventId: string | null;
  rulesEra: string;
  splitGate: number;
  /** THE BOARD: rows the server re-executed and certified. The verified /
   *  unproven split lives in the RESPONSE SHAPE, not in one renderer, so a
   *  consumer that reads nothing else cannot print a claim as a rank. */
  entries: BoardRun[];
  verified?: BoardRun[];
  /** Stored exactly as a client reported them. No rank, never a result. */
  unproven?: BoardRun[];
}

export interface EventView {
  id: string;
  kind: "daily" | "weekly";
  day: string;
  seed: number;
  opensAt: number;
  closesAt: number;
  season: string;
  frozen: boolean;
  rulesHash: string;
  /** TODAY'S RULE pinned on the event row (NICHE.md §4.8); null = base game.
   *  Absent on servers predating the pin. */
  dailyRule?: string | null;
  entrants: number;
}

export interface EventsView {
  season: string;
  daily: EventView;
  weekly: EventView;
}

export interface Standing {
  cp: number;
  rank: number;
  entrants: number;
  eventsCounted: number;
  tier: string | null;
  placementRemaining: number;
  /** Ranked accounts a season needs before tier NAMES mean anything. */
  tierFloor: number;
}

export interface ProfileView {
  publicId: string;
  name: string | null;
  seals: number;
  /** Rows on the server, sealed or not. Deliberately a different word from
   *  `seals`: the career panel labelled a histogram built from ALL runs "N
   *  sealed runs" and printed SEALS 0 three hundred pixels below it. */
  runsSubmitted?: number;
  refused?: number;
  career: { runs: number; wins: number; deepest: number; kills: number; time_sec: number } | null;
  standing: Standing;
  season: string;
  /** Every row this account submitted, by ending floor. */
  deathsByFloor: number[];
  /** The same chart over CERTIFIED rows only - the population the seal count,
   *  the CP and the board rows are drawn from. */
  sealedDeathsByFloor?: number[];
  /** Band personal bests as the SERVER computes them, from verified rows that
   *  passed the traversal predicate. This is the authority; the localStorage
   *  ledger is only an offline cache of it. */
  bandBests: (number | null)[];
  deepest: number;
  fastestClear: BoardRun | null;
  mastery: { ultimate: string; xp: number }[];
  following: string[];
  recent: BoardRun[];
}

export interface HeadToHead {
  played: number;
  mine: number;
  theirs: number;
  drawn: number;
  recent: {
    eventId: string; won: boolean; mineFloor: number; theirFloor: number;
    mineTicks: number; theirTicks: number; result: "won" | "lost" | "drew";
  }[];
}

export interface RivalContract {
  eventId: string;
  seed: number;
  resolvesAt: number;
  rival: { publicId: string; cp: number; name: string | null } | null;
  rivalRun: BoardRun | null;
  myCp: number;
  /** Every contested event the two of you both finished. */
  head: HeadToHead | null;
  /** What the contract is worth, and how the pairing was made - both stated on
   *  the card rather than left as folklore. */
  stake: string;
  pairing: string;
}

// ---------------------------------------------------------------------------
// THE GRADE (COMPETITIVE.md 6.2 Beat 1)
// ---------------------------------------------------------------------------

export type Letter = "S" | "A" | "B" | "C" | "D";

export interface GradePart {
  key: "DEPTH" | "TEMPO" | "SURVIVAL" | "EXECUTION";
  score: number; // 0..100
  detail: string; // the raw number, so the grade is auditable
}

export interface RunGrade {
  letter: Letter;
  score: number;
  parts: GradePart[];
  /** Names the comparison set. A grade must never imply a population it does
   *  not have - this string is what keeps that promise. */
  basis: string;
  /** One line of System commentary. */
  line: string;
}

/** The facts a grade is computed from. Deliberately a plain struct: the host
 *  builds it from the live run, a test builds it from nothing. */
export interface RunFacts {
  floor: number;
  won: boolean;
  elapsedSec: number;
  kills: number;
  level: number;

  damageTaken: number;
  draftsClaimed: number;
  draftsOffered: number;
  /** Floors this run actually LEFT. Not floor-1: a test-chamber start drops
   *  you at depth without having cleared anything, and dividing the clock by
   *  twelve floors nobody walked hands out a perfect tempo. */
  floorsCleared: number;
  /**
   * The run began at depth (test chamber, or a start that only ever entered
   * one floor). DEPTH IS THEN NOT A MEASURE OF ANYTHING THIS RUN DID, and the
   * tile must not score it as one: printing DEPTH 100 in gold forty pixels
   * above a red TEST CHAMBER — NOT RANKED banner is two elements asserting
   * opposite things about the same number. Scored on the floors actually
   * walked out of instead.
   */
  startedAtDepth?: boolean;
}

/** Fewer than this many finished local runs and a percentile is a lie: fall
 *  back to the authored absolute curve (COMPETITIVE.md 6.2 cold start 1). */
export const COLD_START_RUNS = 5;

/**
 * THE ABSOLUTE CURVE. Authored once from the balance bot's own distribution
 * (tools/replaymeasure.ts and the balance contract in test/balance.test.ts),
 * and it is what makes a FIRST grade meaningful rather than flattering - the
 * only version worth having. Each entry is the raw measure that scores 50.
 */
const CURVE = {
  /** A median run dies in the back half of THE SEWERS. */
  floor: 6,
  /** Sim seconds per floor. Faster is better; the collapse timer is ~150s. */
  secPerFloor: 95,

  /** Sim seconds a full bar of health lasts a competent crawler. */
  secPerHealthBar: 85,
  /** Kills per minute of run time. */
  killsPerMin: 9,
};

/** Map a measure to 0..100 where `mid` scores 50. `higherIsBetter=false`
 *  inverts. A gentle curve, so one outlier cannot pin a part at 0 or 100. */
function scoreAgainst(value: number, mid: number, higherIsBetter = true): number {
  if (mid <= 0) return 50;
  const ratio = higherIsBetter ? value / mid : mid / Math.max(value, 1e-6);
  // 100 * r / (r + 1) is 50 at parity and saturates smoothly either side.
  return clamp(Math.round((100 * ratio) / (ratio + 1)), 0, 100);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Percentile of `value` within `pool` (0..100, higher = better), or null when
 *  the pool is too small to mean anything. */
function percentile(value: number, pool: number[], higherIsBetter = true): number | null {
  if (pool.length < COLD_START_RUNS) return null;
  let beaten = 0;
  for (const p of pool) {
    if (higherIsBetter ? value >= p : value <= p) beaten++;
  }
  return Math.round((beaten / pool.length) * 100);
}

export function letterFor(score: number): Letter {
  if (score >= 88) return "S";
  if (score >= 74) return "A";
  if (score >= 58) return "B";
  if (score >= 40) return "C";
  return "D";
}

/**
 * Grade a finished run. Four equal parts, each a percentile against your own
 * history and today's board where those exist, and against the authored curve
 * where they do not. The returned `basis` always names which happened.
 */
export function gradeRun(
  run: RunFacts,
  history: readonly RunRecord[],
  board: readonly BoardRun[] | null,
  maxHp: number,
): RunGrade {
  const mine = history.filter((r) => r.timeSec > 0);
  const haveHistory = mine.length >= COLD_START_RUNS;
  const todays = (board ?? []).filter((b) => b.floor > 0);
  const haveBoard = todays.length >= COLD_START_RUNS;

  // DEPTH - floor reached, against your own median and the day's field. A run
  // HANDED its depth is scored on the floors it actually walked out of, which
  // is usually zero: the meter and the NOT RANKED banner have to agree.
  const depthPool = [...mine.map((r) => r.floor), ...todays.map((b) => b.floor)];
  const depthMeasure = run.startedAtDepth ? run.floorsCleared : run.floor;
  const depth = percentile(depthMeasure, depthPool) ?? scoreAgainst(depthMeasure, CURVE.floor);

  // TEMPO - sim seconds per floor COMPLETED. The distinction matters: a run
  // that dies eight seconds into floor 1 has not set a blistering pace, it has
  // no pace at all, and dividing by the floor you died ON would hand it a 98.

  const completed = Math.max(0, run.floorsCleared);
  const spf = completed > 0 ? run.elapsedSec / completed : 0;
  const tempoPool = [
    ...mine.map((r) => r.timeSec / Math.max(1, r.won ? CONFIG.finalFloor : r.floor - 1)),
    ...todays.map((b) => b.timeSec / Math.max(1, b.won ? CONFIG.finalFloor : b.floor - 1)),
  ];
  const tempo = completed > 0
    ? (percentile(spf, tempoPool, false) ?? scoreAgainst(spf, CURVE.secPerFloor, false))
    // No floor cleared: the only honest tempo question is whether you lasted
    // long enough to have one. Graded against a single floor of the clock.
    : scoreAgainst(run.elapsedSec, CURVE.secPerFloor);

  // SURVIVAL - SECONDS PER HEALTH BAR LOST. Deliberately not damage-per-floor:
  // that metric is undefined for a run that clears no floors, and it hands a
  // flattering number to a crawler who died in eight seconds having barely
  // been hit. How long a bar of health LASTED you is meaningful at any run
  // length, and it is what the word survival actually means. The board carries
  // no damage column, so this part is always yours-or-the-curve.
  const barsLost = Math.max(0.02, run.damageTaken / Math.max(1, maxHp));
  const secPerBar = run.elapsedSec / barsLost;
  const survival = percentile(
    secPerBar,
    mine.map((r) => r.timeSec / Math.max(0.02, r.damageTaken / Math.max(1, maxHp))),
  ) ?? scoreAgainst(secPerBar, CURVE.secPerHealthBar);

  // EXECUTION - kills per minute, plus the drafts you actually claimed. Banked
  // power you never spent is the most common quiet mistake in the game.
  const kpm = run.kills / Math.max(1, run.elapsedSec / 60);
  const kpmScore = percentile(kpm, [
    ...mine.map((r) => r.kills / Math.max(1, r.timeSec / 60)),
    ...todays.map((b) => b.kills / Math.max(1, b.timeSec / 60)),
  ]) ?? scoreAgainst(kpm, CURVE.killsPerMin);
  const claimRate = run.draftsOffered > 0 ? run.draftsClaimed / run.draftsOffered : 1;
  const execution = clamp(Math.round(kpmScore * 0.7 + claimRate * 100 * 0.3), 0, 100);

  const parts: GradePart[] = [
    {
      key: "DEPTH",
      score: depth,
      detail: run.startedAtDepth
        ? `floor ${run.floor} — started here, not walked`
        : run.won ? `all ${CONFIG.finalFloor} floors` : `floor ${run.floor}`,
    },

    {
      key: "TEMPO",
      score: tempo,
      detail: completed > 0
        ? `${Math.round(spf)}s per floor cleared`
        : `${Math.round(run.elapsedSec)}s alive, no floor cleared`,
    },

    { key: "SURVIVAL", score: survival, detail: `a health bar lasted you ${Math.round(secPerBar)}s` },
    {
      key: "EXECUTION",
      score: execution,
      detail: `${kpm.toFixed(1)} kills/min · ${run.draftsClaimed}/${run.draftsOffered} drafts claimed`,
    },
  ];

  let score = Math.round(parts.reduce((a, p) => a + p.score, 0) / parts.length);
  // THE DEPTH CEILING. Without it the average is gameable by dying instantly:
  // a run that ends on floor 1 takes almost no damage and clears no floors
  // slowly, so three of the four parts reward it. You may finish at most one
  // letter above the depth you actually reached, and the basis says so when
  // the ceiling is what decided the letter.
  const ceiling = depth + 25;
  const capped = score > ceiling;
  score = Math.min(score, ceiling);
  // A CLEAR IS NEVER WORSE THAN AN A, AND THE LETTER STILL HAS TO SAY SOMETHING.
  // A flat `max(score, 76)` floored EVERY clear at exactly A, so a scrappy
  // eighteen floors and a dominant one printed the same glyph - the biggest
  // element on the screen carrying no information on the one result that
  // matters most. The clear instead spends the whole top of the scale: the
  // composite is remapped into 76..100 around parity, so 76 is the survivor
  // who limped out and S is earned by clearing WELL.
  if (run.won && !run.startedAtDepth) {
    score = clamp(Math.round(76 + (score - 50) * 0.48), 76, 100);
  }

  const basis = haveHistory && haveBoard
    ? `vs YOUR ${mine.length} RUNS · TODAY'S ${todays.length}`
    : haveHistory
      ? `vs YOUR ${mine.length} RUNS`
      : haveBoard
        ? `vs TODAY'S ${todays.length} · THE HOUSE CURVE`
        : "vs THE HOUSE CURVE — no crowd yet";

  const letter = letterFor(score);
  return {
    letter,
    score,
    parts,
    basis: capped && !run.won ? `${basis} · CAPPED BY DEPTH` : basis,
    line: commentary(letter, run, parts),
  };
}

/** The System's voice. Keyed on the letter AND on the weakest part, so the
 *  commentary always says something the player can act on. */
function commentary(letter: Letter, run: RunFacts, parts: GradePart[]): string {
  const worst = [...parts].sort((a, b) => a.score - b.score)[0];
  if (run.won) {
    if (letter === "S") return "PERFECT BROADCAST. The network has already greenlit the sequel.";
    // A clear that is not an S got there the hard way, and the screen should
    // say which way. "You walked out" for every clear alike is the same flat
    // reading the letter used to give.
    const short: Record<GradePart["key"], string> = {
      DEPTH: "on paper, at least.",
      TEMPO: "Slowly. The audience had time to order food.",
      SURVIVAL: "Bleeding the whole way. The medical bill is the sequel budget.",
      EXECUTION: "Underpowered — you left drafts banked and walked out anyway.",
    };
    return `YOU WALKED OUT. ${short[worst.key]}`;
  }
  const nag: Record<GradePart["key"], string> = {
    // ...AND THE DEPTH LINE READS THE FLOOR (blocker 15). This fired on a
    // floor-13 death - two thirds of the dungeon, deeper than most runs ever
    // get - and told the crawler the cameras were still warming up. DEPTH being
    // the WEAKEST of four parts is not the same claim as "you went nowhere".
    DEPTH: run.floor >= 10
      ? `Floor ${run.floor}, and the exit is still ${CONFIG.finalFloor - run.floor} floors past where you `
        + "stopped. Depth is the number that pays and you were in sight of it."
      : run.floor >= 4
        ? `Floor ${run.floor}. Respectable, and a long way short of the story.`
        : "You did not go deep enough to matter. The cameras were still warming up.",
    TEMPO: "You dawdled. The collapse timer is not a suggestion and the audience is not patient.",
    SURVIVAL: "You took every hit on offer. Try the version where you do not.",
    EXECUTION: "You left power on the table — banked drafts do not accrue interest.",
  };
  const head: Record<Letter, string> = {
    S: "SEASON HIGHLIGHT.",
    A: "STRONG SHOWING.",
    B: "SOLID CONTENT.",
    C: "THE NETWORK HAS NOTES.",
    D: "THAT WAS UNWATCHABLE.",
  };
  return `${head[letter]} ${nag[worst.key]}`;
}

// ---------------------------------------------------------------------------
// THE DEATH, NAMED (COMPETITIVE.md 6.2 Beat 3)
// ---------------------------------------------------------------------------

export interface DeathContext {
  /** Abilities that were off cooldown when the blow landed. */
  ready: string[];
  flasks: number;
  unclaimedDrafts: number;
}

/** The headline: who hit you, for how much, out of what. Straight off
 *  Player.lastHitSrc - the sim records the attacker at the damagePlayerHit
 *  funnel, so this is DATA, not a render-layer guess. */

export function deathHeadline(src: LastHitSrc | null): string {
  if (!src) return "";
  const pct = src.maxHp > 0 ? Math.round((src.hpBefore / src.maxHp) * 100) : 0;
  return `${deathName(src)} — ${Math.round(src.dmg)} damage, from ${pct}% HP.`;
}

/** The killer, in words. An announcer name wins outright; otherwise the sim id
 *  is humanized, because "HAZARD:BLAST" is a database row and this line is
 *  supposed to be the most memorable sentence on the screen. */
export function deathName(src: LastHitSrc): string {
  if (src.label) return src.label.toUpperCase();
  const raw = (src.by ?? "something").toLowerCase();
  if (raw.startsWith("hazard:")) return `A ${raw.slice(7).replace(/[_:]/g, " ").toUpperCase()} TRAP`;
  if (raw === "collapse") return "THE COLLAPSE";
  return raw.replace(/[_:]/g, " ").toUpperCase();
}

/** The second line: the outs you were holding. This is the sentence worth more
 *  than every stat tile on the screen, so it never pads - an empty context
 *  says so plainly instead of inventing a lesson. */
export function deathContext(ctx: DeathContext): string {
  const bits: string[] = [];
  if (ctx.ready.length > 0) bits.push(`${listOf(ctx.ready)} ${ctx.ready.length === 1 ? "was" : "were"} up`);
  const held: string[] = [];
  if (ctx.flasks > 0) held.push(`${ctx.flasks} flask${ctx.flasks === 1 ? "" : "s"}`);
  if (ctx.unclaimedDrafts > 0) {
    held.push(`${ctx.unclaimedDrafts} unclaimed draft${ctx.unclaimedDrafts === 1 ? "" : "s"}`);
  }

  if (held.length > 0) bits.push(`you died holding ${listOf(held)}`);
  if (bits.length === 0) return "You had nothing left to press. That one is on the dungeon.";
  return `${bits.map((b) => b.replace(/^./, (c) => c.toUpperCase())).join(". ")}.`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// SPLITS (COMPETITIVE.md 3.3 / 6.2 Beat 4)
// ---------------------------------------------------------------------------

export interface BandSplit {
  band: number;
  name: string;
  /** Ticks spent in this band, 0 when never entered. */
  ticks: number;
  /** Your personal best on this band, or null. */
  pbTicks: number | null;
  /** The board leader's, or null. */
  leaderTicks: number | null;
}

/** Ticks per band from the floor-entry ticks the host recorded live. The same
 *  arithmetic the verifier runs (ReplaySession.summary), so the client preview
 *  and the sealed row agree instead of drifting by a rounding rule. */
export function bandSplitsFrom(floorEntryTicks: readonly number[], endTick: number): number[] {
  const bands = new Array<number>(FLOOR_BANDS.length).fill(0);
  for (let f = 0; f < CONFIG.finalFloor; f++) {
    const entered = floorEntryTicks[f] ?? -1;
    if (entered < 0) continue;
    let left = endTick;
    for (let g = f + 1; g < CONFIG.finalFloor; g++) {
      const next = floorEntryTicks[g] ?? -1;
      if (next >= 0) { left = next; break; }
    }
    bands[floorBand(f + 1)] += Math.max(0, left - entered);
  }
  return bands;
}

/** The band where the run was lost: the worst delta against the reference.
 *  Returns -1 when there is nothing honest to compare against. */
export function worstBand(splits: readonly BandSplit[]): number {
  let worst = -1;
  let delta = 0;
  for (const s of splits) {
    if (s.ticks <= 0) continue;
    // Against BOTH references, worst wins. Beat 4 is "your time per band vs
    // your PB vs the board leader"; measuring LOST HERE against yourself alone
    // can only ever tell you that you had a bad day, never that the field is
    // walking a band you are crawling.
    for (const ref of [s.pbTicks, s.leaderTicks]) {
      if (!ref) continue;
      const d = s.ticks - ref;
      if (d > delta) { delta = d; worst = s.band; }
    }
  }
  return worst;
}

/**
 * The board leader's band splits, for Beat 4's third bar. The leader is the
 * best row the CURRENT ERA can still stand behind: an unproven claim is not a
 * benchmark, and a row sealed under other numbers is not a comparison.
 * Returns an all-null array when the field has nothing to offer, so the
 * caller never has to invent one.
 */
export function leaderSplits(board: readonly BoardRun[] | null, currentEra: string): (number | null)[] {
  const empty = new Array<number | null>(FLOOR_BANDS.length).fill(null);
  const row = (board ?? []).find(
    (r) => r.state === "verified" && r.rulesEra === currentEra
      && !!r.bandSplits && r.bandSplits.some((t) => t > 0),
  );
  if (!row?.bandSplits) return empty;
  return empty.map((_, i) => (row.bandSplits![i] ?? 0) > 0 ? row.bandSplits![i] : null);
}

export function bandName(i: number): string {
  return FLOOR_BANDS[clamp(i, 0, FLOOR_BANDS.length - 1)].name;
}

// ---------------------------------------------------------------------------
// SHARING (COMPETITIVE.md 8.2)
// ---------------------------------------------------------------------------

/**
 * A CHALLENGE CODE: a seed plus a claim, in about eighty characters - small
 * enough to paste into a chat message, and it reproduces the whole dungeon,
 * because the dungeon IS the seed. Opening one pins the seed and states the
 * claim; the comparison happens once, at the end of YOUR run. It never
 * carries a recording - a racing ghost is the rejected feature, and NICHE.md
 * §5 bans it by name.
 */
export interface Challenge {
  seed: number;
  /** Event id when the run was a contract, so ACCEPT lands on the same board. */
  ev?: string;
  by: string;
  floor: number;
  won: boolean;
  timeSec: number;
  kills: number;
  level: number;
  ult?: string | null;
}

const CODE_VERSION = 1;

export function encodeChallenge(c: Challenge): string {
  const tuple = [
    CODE_VERSION, c.seed >>> 0, c.ev ?? "", c.by.slice(0, 24), c.floor,
    c.won ? 1 : 0, Math.round(c.timeSec), c.kills, c.level, c.ult ?? "",
  ];
  return b64urlEncode(JSON.stringify(tuple));
}

export function decodeChallenge(code: string): Challenge | null {
  try {
    const t = JSON.parse(b64urlDecode(code.trim())) as unknown[];
    if (!Array.isArray(t) || t[0] !== CODE_VERSION) return null;
    const num = (i: number): number => (typeof t[i] === "number" ? (t[i] as number) : 0);
    const str = (i: number): string => (typeof t[i] === "string" ? (t[i] as string) : "");
    const seed = num(1) >>> 0;
    if (!Number.isFinite(seed) || seed === 0) return null;
    // Old codes carried an eleventh entry - a sealed run id for ghost racing.
    // The ghost layer is gone; the extra entry is ignored, never an error, so
    // a pre-removal link still opens its dungeon.
    return {
      seed,
      ev: str(2) || undefined,
      by: str(3).slice(0, 24) || "a rival crawler",
      floor: clamp(num(4), 0, 99),
      won: num(5) === 1,
      timeSec: clamp(num(6), 0, 6 * 3600),
      kills: clamp(num(7), 0, 100000),
      level: clamp(num(8), 0, 99),
      ult: str(9) || null,
    };
  } catch {
    return null;
  }
}

/** A BUILD CODE: the receipt half of 8.2. Derived from a run's final state,
 *  so a shared build is permanently attached to evidence that it worked -
 *  LoL's build sites are aggregate guesses, this one is a receipt. */
export function encodeBuild(b: RunBuild): string {
  const tuple = [
    CODE_VERSION, b.level, b.ultimate ?? "", b.slots.map((s) => s ?? ""),
    Object.entries(b.ranks).filter(([, n]) => n > 0),
    b.gear.map((g) => [g.slot, g.rarity]),
  ];
  return b64urlEncode(JSON.stringify(tuple));
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// CLOCKS - one set of formatters, so no two surfaces disagree by a rounding
// rule
// ---------------------------------------------------------------------------

/** Speedrun-style signed clock: +1:12 / -0:04. */
export function signedTime(sec: number): string {
  const sign = sec > 0 ? "+" : sec < 0 ? "−" : "";
  const a = Math.abs(sec);
  const m = Math.floor(a / 60);
  const s = Math.floor(a % 60);
  return m > 0 ? `${sign}${m}:${String(s).padStart(2, "0")}` : `${sign}${a < 10 ? a.toFixed(1) : String(s)}s`;
}

export function mmss(sec: number): string {
  const c = Math.max(0, Math.round(sec));
  return `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`;
}

/**
 * THE RECORD CLOCK: m:ss.cc. Splits are exact tick counts, and whole seconds
 * throw that precision away at exactly the moment it decides an order - five
 * crawlers printing "1:45" at the top of a band board with no visible
 * tiebreak makes the rank look arbitrary, because to the reader it IS.
 * Centiseconds are free: the data was always this precise.
 */
export function mmssc(sec: number): string {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Ticks straight to the record clock, with no float round-trip. */
export function ticksClock(ticks: number): string {
  return mmssc(Math.max(0, ticks) / 60);
}

// ---------------------------------------------------------------------------
// SEAL PRESENTATION (COMPETITIVE.md 2.4 rule 3, 2.6c)
// ---------------------------------------------------------------------------

export interface SealChip {
  cls: string;
  label: string;
  title: string;
}

/**
 * What a seal is worth depends on what it certifies, and the chip has to show
 * it. Every verified row wearing the identical filled-gold seal - a rank-1
 * fifteen-minute clear and an eight-second floor-1 death alike - spends the
 * scarcity that makes the seal mean anything. RANKED rows (a board position)
 * keep the filled gold; a run that was replayed and certified but holds no
 * position gets a plain hairline chip. Both are true; only one is a trophy.
 */
export type SealWeight = "ranked" | "plain";

/**
 * HOW THIS ROW GOT ITS SEAL, WHICH IS NOT ALWAYS THE SAME STORY (blocker 11).
 *
 * `verified` covers two genuinely different events, and the chip printed the
 * SAME sentence for both: "the server re-executed this run and certified it".
 * That is true of a proof-verified row and FALSE of a server-vouched one -
 * `insertServerVouched` writes `verified` with `proof_id NULL` for a RIVALS
 * contract that was never re-executed because it never left the server. On a
 * board whose entire pitch is "every entry that ranks is a proof, not a claim"
 * (0. The thesis), the tooltip was asserting a re-execution that provably did
 * not happen - and the only existing tell, "party of N", is absent on a solo
 * rivals row, because N is 1.
 *
 * Both are honest seals. They are not the same seal, and the chip says which
 * one it is wearing.
 */
export type SealProvenance = "replayed" | "vouched";

/** The provenance of a row, from the row. A verified row that NEVER had a film
 *  is the vouched path; there is no other way to be certified without one. */
export function provenanceOf(r: Pick<BoardRun, "state" | "film">): SealProvenance {
  return r.state === "verified" && r.film === "never" ? "vouched" : "replayed";
}

/** Every row on every board carries its state AND its era, because a board
 *  that silently blends rules eras is lying - and showing it is the one thing
 *  LoL literally cannot do, since their all-time stats blend twelve years of
 *  patches without a word. */
export function sealChip(
  state: RunState, era: string | null, isPrivate = false, weight: SealWeight = "ranked",
  provenance: SealProvenance = "replayed",
): SealChip {
  const eraNote = era ? ` · rules era ${era}` : "";
  switch (state) {
    case "verified":
      if (provenance === "vouched") {
        return {
          cls: (weight === "plain" ? "seal verified plain" : "seal verified") + " vouched",
          label: isPrivate ? "SERVER-RUN · PRIVATE" : "SERVER-RUN",
          title: "the System's own authoritative sim decided this race as it happened, tick by tick — "
            + "it was never re-executed, because it never left the server, and there is no film to hand "
            + `out${eraNote}`
            + (weight === "plain" ? ". Sealed, but it holds no board position." : ""),
        };
      }
      return {
        cls: weight === "plain" ? "seal verified plain" : "seal verified",
        label: isPrivate ? "SEALED · PRIVATE" : "SEALED",
        title: `the server re-executed this run and certified it${eraNote}`
          + (weight === "plain" ? ". Certified, but it holds no board position." : "")
          + (isPrivate ? ". It ranks, but it is never distributed." : ""),
      };
    case "verifying":
      return { cls: "seal verifying", label: "VERIFYING", title: "queued for replay on the server" };
    case "rejected":
      return { cls: "seal rejected", label: "REJECTED", title: "the replay did not produce the claimed result" };
    case "unverifiable":
      return {
        cls: "seal aged",
        label: "UNPROVEN",
        title: `recorded under rules this build cannot execute${eraNote} — the row keeps whatever it earned`,
      };
    default:
      return { cls: "seal claimed", label: "CLAIMED", title: "stored as reported, never replayed — unproven" };
  }
}

/**
 * WHICH GAME THIS ROW WAS PLAYED, IN WORDS ON THE ROW (blocker 11).
 *
 * `mode` and `runKind` have been on the wire since the roam exploit was closed
 * and no surface rendered either of them, so the only visible difference
 * between a permadeath race and a ruleset with no permadeath at all was a party
 * count that reads "1" on a solo rivals instance. Returns null for the plain
 * descent every board is made of - a label on every row labels nothing.
 */
export function rulesetLabel(
  r: { mode?: string; runKind?: string },
): string | null {
  const kind = (r.runKind ?? "race").toLowerCase();
  const mode = (r.mode ?? "coop").toLowerCase();
  if (kind === "race" && mode === "coop") return null;
  if (kind === "roam") return "ROAM — no collapse clock, no boss gate";
  if (mode === "rivals") return "RIVALS RACE — death is a 15s time-out, not an ending";
  return `${mode.toUpperCase()} · ${kind.toUpperCase()}`;
}

/**
 * THE SEAL, AT THE SIZE OF WHAT IT CERTIFIES (6.2 Beat 5).
 *
 * A 10.5px chip in a hairline-ruled row is the right treatment for the seal
 * on a board row, where it is one column of forty. It is the WRONG treatment
 * on the verdict, where it is the entire structural advantage of the product:
 * the server re-executed a fifteen-minute run, input by input, and agreed with
 * you. That is the one thing League of Legends cannot copy, and a text swap
 * from VERIFYING to SEALED is not a way to say it.
 *
 * So the verdict gets a block, not a chip: a kicker, a word at headline size,
 * and one sentence in the System's voice explaining what just happened. The
 * `stamped` flag is what the host hangs the strike animation on - it is true
 * only on the transition INTO a terminal state, so the stamp lands once.
 */
export interface VerdictSeal {
  /** State class for the block (`vseal ...`). */
  cls: string;
  kicker: string;
  word: string;
  line: string;
  /** Terminal states stamp; pending ones breathe. */
  terminal: boolean;
  /**
   * A CONTROL, WHEN THE LINE ASKS FOR AN ACTION (6.2 Beat 5 specified this as a
   * BUTTON).
   *
   * The shipped default player - a fresh anonymous token signing the daily from
   * the front door - reached the verdict and read "unsealed. The System does
   * not put its name on an anonymous claim. LINK AN IDENTITY." That string
   * existed in exactly one place in the tree: as a server refusal. There was no
   * button, no link, no OAuth affordance anywhere on the screen; the only
   * sign-in control lived on the MENU and was `display:none` unless providers
   * were configured. The ten seconds ended with the game demanding an action
   * and providing no way to take it.
   */
  action: { kind: "link"; label: string; note: string } | null;
}

/**
 * WHAT A ROW ACTUALLY HOLDS, in words. `GET /runs/:id` answers with the board
 * keys the run occupies; the seal is weighted on THAT rather than on "is my id
 * in the daily-contract deepest board I happened to load", which is how a
 * free-seed run taking rank 1 all-time was told "It ranks nowhere".
 */
/**
 * NEVER PRINT A BARE BOARD NAME THAT IS NOT THE BOARD THE PLAYER WILL FIND.
 *
 * `holdsBoards` answers with SCOPED keys - `deepest@daily-2026-08-02`,
 * `kills@daily-2026-08-02`, `band0` - and this function used to strip the scope
 * with `b.split("@")[0]`, so the seal read "it holds a position on DEEPEST,
 * KILLS, THE UNDERCROFT" and the player clicked through to STANDINGS >
 * ALL-TIME > DEEPEST and read "this museum is empty". The scope is not
 * decoration; it IS which board, and this is the one product whose entire pitch
 * is that the server does not lie about what a run is worth.
 */
export function boardLabel(key: string): string {
  const [bare, scope] = key.split("@");
  if (bare.startsWith("band")) return `${bandName(Number(bare.slice(4)) || 0)} — BAND BOARD`;
  const where = !scope ? "ALL-TIME"
    : scope.startsWith("weekly") ? "THE WEEKLY CONTRACT"
      : scope.startsWith("daily") ? "TODAY'S CONTRACT"
        : scope.toUpperCase();
  return `${bare.toUpperCase()} — ${where}`;
}

/** Scope suffix for one board key, or "" for a band board (which has no scope
 *  axis - it is its own board). */
function boardScope(key: string): string {
  const [bare, scope] = key.split("@");
  if (bare.startsWith("band")) return "";
  return !scope ? "ALL-TIME"
    : scope.startsWith("weekly") ? "THE WEEKLY CONTRACT"
      : scope.startsWith("daily") ? "TODAY'S CONTRACT"
        : scope.toUpperCase();
}

export function boardsPhrase(boards: readonly string[] | null | undefined): string {
  if (!boards || boards.length === 0) return "";
  // GROUPED BY BOARD, SCOPES JOINED. A run that takes DEEPEST on both the
  // contract and the museum holds two boards and the phrase has to say so - but
  // "DEEPEST — TODAY'S CONTRACT, DEEPEST — ALL-TIME, KILLS — TODAY'S CONTRACT
  // and 1 more" is a mouthful that buries the thing worth reading, which is the
  // NAME of what you took.
  const byBoard = new Map<string, string[]>();
  for (const key of boards) {
    const [bare] = key.split("@");
    const name = bare.startsWith("band")
      ? `${bandName(Number(bare.slice(4)) || 0)} — BAND BOARD` : bare.toUpperCase();
    const scope = boardScope(key);
    const list = byBoard.get(name) ?? [];
    if (scope && !list.includes(scope)) list.push(scope);
    byBoard.set(name, list);
  }
  const names = [...byBoard].map(([name, scopes]) =>
    scopes.length === 0 ? name
      : scopes.length === 1 ? `${name} — ${scopes[0]}`
        : `${name} — ${scopes.slice(0, -1).join(", ")} AND ${scopes[scopes.length - 1]}`);
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export const LINK_ACTION = {
  kind: "link" as const,
  label: "LINK AN IDENTITY",
  note: "one click, one provider. Verification costs the System real CPU, so it is spent on crawlers "
    + "it can name — and the run you just played is the one it starts with.",
};

export function verdictSeal(
  state: RunState | "unsubmitted" | "blocked" | "vouched",
  era: string | null,
  isPrivate = false,
  ranked = false,
  reason?: string | null,
  boards: readonly string[] | null = null,
  /** The server says this account has no provider identity, so the seal is
   *  unreachable until it has one. The refusal now arrives with the control. */
  needsIdentity = false,
): VerdictSeal {
  const eraNote = era ? ` Rules era ${era}.` : "";
  const link = needsIdentity ? LINK_ACTION : null;
  switch (state) {
    case "verified": {
      const holds = boardsPhrase(boards);
      return {
        cls: `vseal verified${ranked ? " ranked" : ""}${isPrivate ? " private" : ""}`,
        kicker: "THE SYSTEM RE-RAN YOUR CRAWL",
        word: isPrivate ? "SEALED · PRIVATE" : "SEALED",
        line: (ranked
          ? "Every input, replayed on the System's own machine. Same dungeon, same damage, same death — and it holds "
            + (holds ? `a position on ${holds}.` : "a board position.")
          : "Every input, replayed on the System's own machine. Same dungeon, same damage, same death. It ranks nowhere, and it is still true.")
          + (isPrivate ? " Nobody else will ever be handed the film." : "") + eraNote,
        terminal: true,
        action: null,
      };
    }
    // THE ONE SCORE THE SERVER VOUCHES FOR ITSELF (1.1). A rivals win writes a
    // SEALED, era-stamped contracts row server-side — and the player's own
    // post-run screen suppressed the seal block entirely (`if (net) { display =
    // "none" }`), after `recBlocked` told them "party runs are hosted by the
    // server". The one genuinely server-authoritative score in the product was
    // the one the player was never shown earning.
    case "vouched":
      return {
        cls: "vseal verified ranked vouched",
        kicker: "THE SYSTEM RAN THIS ONE ITSELF",
        word: "SEALED",
        line: "No proof was needed and none exists: this race was decided on the System's own "
          + "authoritative sim, tick by tick, with the System watching every one of them. It is the "
          + "only score in the product that never had to be re-executed, because it was never "
          + `anywhere else.${eraNote}`,
        terminal: true,
        action: null,
      };
    case "verifying":
      return {
        cls: "vseal verifying",
        kicker: "THE SYSTEM IS RE-RUNNING YOUR CRAWL",
        word: "VERIFYING",
        line: "Sixty inputs a second, played back against the same rules you played under. It either agrees with you or it does not.",
        terminal: false,
        action: null,
      };
    case "rejected":
      // THE REJECTION CARRIES THE NUMBERS. The verifier holds both sides at the
      // moment it decides - it knows you claimed 42 kills and the replay
      // produced 39 - and this block used to print a bare field identifier
      // ("...claim disagrees with the replay: status") because the reason was
      // `diffClaim`'s debug output concatenated. A debug token is not an
      // explanation, and 6.2 Beat 5 is explicit that a rejection with no
      // explanation is how honest players conclude the ladder is rigged.
      return {
        cls: "vseal rejected",
        kicker: "THE SYSTEM DISAGREES WITH YOU",
        word: "REFUSED",
        line: reason
          ? `The replay did not produce the run you claimed — ${reason}. The row does not stand.`
          : "The replay did not produce the run you claimed, so the row does not stand. The System does not explain twice; it explains once, here.",
        terminal: true,
        action: null,
      };
    case "unverifiable":
      // NOT AN ACCUSATION. This state covers an era this build cannot execute
      // AND a capability failure - the box running out of verification clock,
      // a worker that could not spawn - and 2.6d is explicit that neither is
      // `rejected`: the row keeps whatever stamp it earned and the player is
      // told plainly rather than accused. The reason, when there is one, says
      // which happened.
      return {
        cls: "vseal aged",
        kicker: "NOT DECIDED",
        word: "UNPROVEN",
        line: reason
          ? `${reason} Nothing here says the run is false — the System could not run it, which is a `
            + `different sentence and the row keeps whatever it earned.${eraNote}`
          : `This run was recorded under rules this build can no longer execute, so it keeps whatever it earned and nothing more.${eraNote}`,
        terminal: true,
        action: link,
      };
    case "blocked":
      return {
        cls: "vseal blocked",
        kicker: "NO PROOF OFFERED",
        word: "UNSEALED",
        line: reason ?? "This run was never offered to the board, so there is nothing for the System to certify.",
        terminal: true,
        action: link,
      };
    case "unsubmitted":
      // SEALED IS SPENT ONCE, ON THE THING THAT EARNS IT. The pre-submit
      // kicker used to read "THE RECORDING IS SEALED AGAINST THE RUN" ninety
      // pixels above the word this whole trust model rests on - spending the
      // one term that means "the server re-executed this" on "hashed locally,
      // nothing sent". Nothing here has been certified by anybody.
      return {
        cls: "vseal pending",
        kicker: "NOTHING HAS LEFT THIS MACHINE",
        word: "READY TO SUBMIT",
        line: "Twenty-odd kilobytes that reproduce this run exactly, written down and waiting. "
          + "The System has not seen a byte of it.",
        terminal: false,
        action: link,
      };
    default:
      return {
        cls: "vseal claimed",
        kicker: "STORED AS REPORTED",
        word: "CLAIMED",
        line: reason
          ? `Not replayed. ${reason}`
          : "Stored exactly as your client reported it and never re-executed, so the System does not put its name on it. Unproven rows never reach the top of a board.",
        terminal: true,
        action: link,
      };
  }
}

/**
 * THE SEAL STATE, as arithmetic rather than as a hope.
 *
 * Instrumented on the shipping build: `vseal pending` at t+0, `vseal verified
 * ranked` by t+900ms. No `verifying` frame was ever painted, so the player had
 * no way to see that the server had done anything.
 *
 * Returns how many milliseconds a terminal verdict must be HELD (never
 * dropped) before it is painted, so the state it replaces has been legible for
 * at least SEAL_MIN_PENDING_MS. 0 means paint it now.
 *
 * SEAL_CASCADE_MS is how long after the card appears the seal block is
 * READABLE. It was 1400 while the verdict opened as a staged cascade and the
 * block spent 980ms at opacity 0 before rising; that cascade is reverted - the
 * panel now arrives complete and at rest - so the block is readable the moment
 * the card is, and the offset is zero.
 */
export const SEAL_MIN_PENDING_MS = 1200;
export const SEAL_CASCADE_MS = 0;

export function sealHoldMs(
  now: number,
  /** performance.now() when the verdict card was displayed; 0 if not yet. */
  verdictVisibleAt: number,
  /** performance.now() when the current pending block was painted. */
  pendingSince: number,
  terminal: boolean,
  /** False for the very first paint: a screen that OPENS on a terminal verdict
   *  (a rehearsal, a refused recording) has no pending state to honour. */
  hadPriorPaint: boolean,
): number {
  if (!terminal || !hadPriorPaint || verdictVisibleAt <= 0) return 0;
  const visibleFrom = Math.max(pendingSince, verdictVisibleAt + SEAL_CASCADE_MS);
  return Math.max(0, SEAL_MIN_PENDING_MS - (now - visibleFrom));
}

// ---------------------------------------------------------------------------
// THE DEFAULT STATE COMPARES YOU TO SOMEBODY (COMPETITIVE.md 6 Beat 2)
// ---------------------------------------------------------------------------

/**
 * THE MARK. League's default post-game IS the scoreboard; ours costs a keypress
 * and advertises itself in 11.5px type, so the screen a player sees after every
 * single run compared them to nobody at all.
 *
 * One row, permanently, in the default state: the crawler at the top of today's
 * contract, what they did, and the gap. When the board is dark or empty it
 * falls back to YOUR OWN deepest — which is still a comparison, and is the one
 * an offline player can act on.
 */
export interface Benchmark {
  /** Who is being compared against: a board leader, or your own ledger. */
  who: string;
  /** What they did, in one phrase. */
  what: string;
  /** The gap, signed and in the player's favour when they are ahead. */
  gap: string;
  /** True when the player is level with or past the mark. */
  ahead: boolean;
  /** Which population this mark came from, printed so it is never implied. */
  source: string;
}

/**
 * THE LEADER OF A BOARD YOU ARE ON IS NOT YOUR RIVAL (blocker 5).
 *
 * `benchmark` took the top verified row and called it "the leader" with no idea
 * whether it was the player's own row - so THE MARK, the one comparison the
 * default post-run state makes, printed "CARL / FLOOR 1 / level with the
 * leader" about the player, against themselves. The test-chamber verdict
 * printed "12 floors deeper than the leader" about the same person for the same
 * reason. This function knows how to say it correctly - the unlinked branch
 * prints "YOUR OWN DEEPEST" - it simply was never told which rows were mine.
 *
 * Shared with the scoreboard's TODAY'S #1 column, so the two surfaces cannot
 * disagree about who is at the top the way they did (the column head read
 * "#1 — KATIA" while the board beneath it showed Katia at rank 2).
 */
export function boardLeader(
  board: readonly BoardRun[] | null, myPublicId?: string | null,
): { row: BoardRun; rank: number; mine: boolean } | null {
  const sealed = (board ?? []).filter((r) => r.state === "verified");
  if (sealed.length === 0) return null;
  const mineAtTop = !!myPublicId && sealed[0].publicId === myPublicId;
  // Rank is the position on the SEALED ordering, which is the board the reader
  // is looking at - not the index in a page that may still hold claims.
  const rivalIdx = sealed.findIndex((r) => !myPublicId || r.publicId !== myPublicId);
  if (mineAtTop && rivalIdx > 0) {
    return { row: sealed[rivalIdx], rank: rivalIdx + 1, mine: false };
  }
  return { row: sealed[0], rank: 1, mine: mineAtTop };
}

export function benchmark(
  me: { floor: number; won: boolean; elapsedSec: number },
  board: readonly BoardRun[] | null,
  myBestFloor: number,
  myPublicId?: string | null,
): Benchmark | null {
  const top = boardLeader(board, myPublicId);
  // I HOLD THE MARK. The one case the old code turned into a comparison with
  // myself is the case that deserves the best sentence on the screen.
  if (top && top.mine) {
    return {
      who: "YOU HOLD THE MARK",
      what: (top.row.won ? "CLEARED IT" : `FLOOR ${top.row.floor}`)
        + ` · ${ticksClock(top.row.ticks)} · ${count(top.row.kills, "kill")}`,
      gap: "nobody has beaten it yet — that row is the one everyone else is reading",
      ahead: true,
      source: "today's contract, sealed rows only",
    };
  }
  const leader = top?.row ?? null;
  if (leader && top) {
    // WHAT TO CALL THEM. When the player holds rank 1, the crawler the screen
    // compares against is the one BELOW them, and calling that person "the
    // leader" is the same category of untruth as comparing you to yourself.
    const foil = top.rank === 1 ? "the leader" : `rank ${top.rank}`;
    const src = top.rank === 1
      ? "today's contract, sealed rows only"
      : `today's contract, sealed rows only — you hold rank 1, this is rank ${top.rank}`;
    const what = (leader.won ? "CLEARED IT" : `FLOOR ${leader.floor}`)
      + ` · ${ticksClock(leader.ticks)} · ${count(leader.kills, "kill")}`;
    if (me.won && !leader.won) {
      return { who: leader.name.toUpperCase(), what, gap: "you cleared it and they did not", ahead: true, source: src };
    }
    const d = me.floor - leader.floor;
    const gap = leader.won && !me.won
      ? `${Math.max(0, 18 - me.floor)} floors short of the exit they walked out of`
      : d > 0 ? `${d} floor${d === 1 ? "" : "s"} deeper than ${foil}`
        : d === 0 ? `level with ${foil} — they were ${signedTime(me.elapsedSec - leader.timeSec)} on the clock`
          : `${-d} floor${d === -1 ? "" : "s"} short of ${foil}`;
    return { who: leader.name.toUpperCase(), what, gap, ahead: d >= 0, source: src };
  }
  if (myBestFloor > 0) {
    const d = me.floor - myBestFloor;
    return {
      who: "YOUR OWN DEEPEST",
      what: `FLOOR ${myBestFloor}`,
      gap: d > 0 ? `${d} floor${d === 1 ? "" : "s"} past it` : d === 0 ? "matched it" : `${-d} short of it`,
      ahead: d >= 0,
      source: "this browser's ledger — no sealed row on today's contract yet",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// WHAT EVERY RUN BANKS, INCLUDING THE BAD ONES (COMPETITIVE.md 6 Beat 5)
// ---------------------------------------------------------------------------

/**
 * A floor-3 death used to produce "+0 CP", a hairline seal reading "It ranks
 * nowhere", and "no personal bests this run — the ledger is unmoved": three of
 * the four informational blocks on the screen saying that nothing happened.
 * Admirably honest, and exactly why a player closes the tab.
 *
 * League always lands something. So does this, and it costs nothing against the
 * verification spine because none of it is a claim about the ladder: it is the
 * browser's own ledger, counted, and said out loud. A run that banks nothing
 * else still banks itself.
 */
export interface BankedTick {
  label: string;
  value: string;
  /** What this run added, when it added something. */
  delta?: string;
}

export function bankedTicks(
  history: readonly RunRecord[],
  episode: number,
  run: { kills: number; timeSec: number; floor: number },
): BankedTick[] {
  const kills = history.reduce((a, r) => a + r.kills, 0);
  const minutes = Math.round(history.reduce((a, r) => a + r.timeSec, 0) / 60);
  const out: BankedTick[] = [
    { label: "EPISODE", value: `#${Math.max(1, episode)}`, delta: "filed" },
  ];
  if (run.kills > 0) {
    out.push({ label: "CAREER KILLS", value: kills.toLocaleString(), delta: `+${run.kills.toLocaleString()}` });
  }
  // A 7.76-SECOND RUN DID NOT BANK A MINUTE (blocker 15). `Math.max(1, ...)`
  // rounded every run up to one minute and printed a bare "+1" beside a value
  // in minutes, so an eight-second death read as "377 min +1". Under a minute
  // the delta is stated in the unit it actually happened in, and the unit is
  // on the number rather than implied by the row above it.
  const secs = Math.max(0, Math.round(run.timeSec));
  out.push({
    label: "TIME IN THE DUNGEON",
    value: `${minutes} min`,
    delta: secs < 60 ? `+${secs}s` : `+${Math.round(secs / 60)} min`,
  });
  return out;
}

/**
 * THE NEXT THING TO AIM AT. A run that banked nothing still has a next target,
 * and naming it is what turns "the ledger is unmoved" into a reason to press R.
 * Drawn from the same milestone vocabulary as the career timeline, so the two
 * screens never disagree about what counts.
 */
export function nextMilestone(bestFloor: number, won: boolean): { title: string; detail: string } {
  if (!won) {
    for (const f of [3, 6, 9, 12, 15, 18]) {
      if (bestFloor < f) {
        return {
          title: `REACH FLOOR ${f}`,
          detail: bestFloor > 0
            ? `${bandName(Math.floor((f - 1) / 3))} — your deepest is ${bestFloor}`
            : `${bandName(Math.floor((f - 1) / 3))} — nothing on the ledger yet`,
        };
      }
    }
  }
  return { title: "WALK OUT AGAIN, FASTER", detail: "the exit is the only record left to beat" };
}

// ---------------------------------------------------------------------------
// MASTERY + MILESTONES (COMPETITIVE.md 5.2)
// ---------------------------------------------------------------------------

/** Mastery level from verified-run xp (the server banks floor*10 per sealed
 *  run). A triangular curve: level N costs 60*N, so the early levels come fast
 *  and the deep ones need deep runs - and unlike LoL mastery, every point of
 *  it is backed by a replayable proof. */
export function masteryLevel(xp: number): { level: number; into: number; need: number } {
  let level = 0;
  let rest = Math.max(0, xp);
  for (;;) {
    const need = 60 * (level + 1);
    if (rest < need) return { level, into: rest, need };
    rest -= need;
    level++;
    if (level > 99) return { level, into: 0, need: 1 };
  }
}

export interface Milestone {
  at: number;
  title: string;
  detail: string;
}

/** The dated timeline people screenshot. Derived from the local ledger so it
 *  works offline and for anonymous crawlers; the server profile adds seals. */
export function milestonesFrom(history: readonly RunRecord[]): Milestone[] {
  const asc = [...history].sort((a, b) => a.endedAt - b.endedAt);
  // ONE RUN CAN MINT SEVERAL MILESTONES, all stamped with the same endedAt: a
  // first clear crosses floors 3, 6, 9, 12, 15 and 18 in one go. Sorting by
  // timestamp alone leaves those tied, and a tied sort is free to emit them in
  // any order - which is how a descending timeline ends up reading upward
  // inside a single day. The seq counter is the order they were EARNED, so
  // ties break
  // the only way a reader can follow.
  const out: (Milestone & { seq: number })[] = [];
  let seq = 0;
  let deepest = 0;
  let firstWin = false;
  let firstDaily = false;
  for (const r of asc) {
    for (const mark of [3, 6, 9, 12, 15, 18]) {
      if (deepest < mark && r.floor >= mark) {
        out.push({
          at: r.endedAt,
          seq: seq++,
          title: `FIRST FLOOR ${mark}`,
          detail: `${bandName(floorBand(mark))} — reached as ${r.name}`,
        });
      }
    }
    deepest = Math.max(deepest, r.floor);
    if (r.won && !firstWin) {
      firstWin = true;
      out.push({
        at: r.endedAt,
        seq: seq++,
        title: "FIRST CLEAR",
        detail: `all ${CONFIG.finalFloor} floors in ${mmss(r.timeSec)}`,
      });
    }
    if (r.mode === "daily" && !firstDaily) {
      firstDaily = true;
      out.push({
        at: r.endedAt, seq: seq++, title: "FIRST CONTRACT",
        detail: `the daily crawl of ${r.day ?? "an unnamed day"}`,
      });
    }
  }
  return out
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .slice(0, 12)
    .map(({ at, title, detail }) => ({ at, title, detail }));
}

// ---------------------------------------------------------------------------
// Small shared helpers the screens need
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
};

/** Player-supplied text is NEVER interpolated raw. Names come off the wire
 *  sanitized by the server; this is the second belt. */
/**
 * "1 kills". Unconditional plurals on a surface that prints exact tick counts
 * (blocker 15): five sites concatenated `s` whatever the number was, and the
 * one that shows up most is the row a floor-1 death produces.
 */
export function count(n: number, noun: string, plural = noun + "s"): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : plural}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function untilText(ms: number, now = Date.now()): string {
  const s = Math.max(0, (ms - now) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
