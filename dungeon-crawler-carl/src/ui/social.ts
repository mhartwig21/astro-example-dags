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
  accountId: string;
  eventId: string | null;
  state: RunState;
  reason: string | null;
  rulesEra: string | null;
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
  entries: BoardRun[];
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
  accountId: string;
  name: string | null;
  seals: number;
  career: { runs: number; wins: number; deepest: number; kills: number; time_sec: number } | null;
  standing: Standing;
  season: string;
  deathsByFloor: number[];
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
  rival: { accountId: string; cp: number; name: string | null } | null;
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
    DEPTH: "You did not go deep enough to matter. The cameras were still warming up.",
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
 * because the dungeon IS the seed. This is the cheap half of 8.2; the
 * expensive half (?run=<id>) needs the server to still hold the proof, and the
 * code carries that id so the two degrade into each other.
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
  /** Run id, when the run was sealed and is worth racing as a ghost. */
  run?: string;
}

const CODE_VERSION = 1;

export function encodeChallenge(c: Challenge): string {
  const tuple = [
    CODE_VERSION, c.seed >>> 0, c.ev ?? "", c.by.slice(0, 24), c.floor,
    c.won ? 1 : 0, Math.round(c.timeSec), c.kills, c.level, c.ult ?? "", c.run ?? "",
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
      run: str(10) || undefined,
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
// GHOSTS (COMPETITIVE.md 4.1)
// ---------------------------------------------------------------------------

export interface GhostState {
  label: string;
  /** 10 Hz keyframes, precomputed off-thread by ghostWorker. */
  track: { hz: number; x: number[]; y: number[]; floor: number[] };
  floorEntryTicks: number[];
  ticks: number;
  /** Source run, when the ghost came off a board row. */
  runId?: string;
}

/** Where the ghost is at a given tick, lerped between keyframes. Null once the
 *  ghost run is over - a finished rival simply stops being on the floor with
 *  you, which is the honest read and the one the HUD chip prints. */
export function ghostAt(g: GhostState, tick: number): { x: number; y: number; floor: number } | null {
  const step = 60 / g.track.hz;
  const idx = tick / step;
  const i = Math.floor(idx);
  if (i < 0 || i >= g.track.x.length) return null;
  const j = Math.min(i + 1, g.track.x.length - 1);
  const t = idx - i;
  return {
    x: g.track.x[i] + (g.track.x[j] - g.track.x[i]) * t,
    y: g.track.y[i] + (g.track.y[j] - g.track.y[i]) * t,
    floor: g.track.floor[i],
  };
}

/**
 * THE SPLIT DELTA - the drama (4.1). Positive means you are BEHIND: you
 * entered this floor that many seconds later than the ghost did. Null while
 * the ghost never reached your floor, because "infinitely ahead" is not a
 * number and pretending otherwise is how split displays start lying.
 */
export function splitDelta(g: GhostState, floor: number, myEntryTick: number): number | null {
  const theirs = g.floorEntryTicks[floor - 1] ?? -1;
  if (theirs < 0 || myEntryTick < 0) return null;
  return (myEntryTick - theirs) / 60;
}

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

/** Every row on every board carries its state AND its era, because a board
 *  that silently blends rules eras is lying - and showing it is the one thing
 *  LoL literally cannot do, since their all-time stats blend twelve years of
 *  patches without a word. */
export function sealChip(
  state: RunState, era: string | null, isPrivate = false, weight: SealWeight = "ranked",
): SealChip {
  const eraNote = era ? ` · rules era ${era}` : "";
  switch (state) {
    case "verified":
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
}

export function verdictSeal(
  state: RunState | "unsubmitted" | "blocked",
  era: string | null,
  isPrivate = false,
  ranked = false,
  reason?: string | null,
): VerdictSeal {
  const eraNote = era ? ` Rules era ${era}.` : "";
  switch (state) {
    case "verified":
      return {
        cls: `vseal verified${ranked ? " ranked" : ""}${isPrivate ? " private" : ""}`,
        kicker: "THE SYSTEM RE-RAN YOUR CRAWL",
        word: isPrivate ? "SEALED · PRIVATE" : "SEALED",
        line: (ranked
          ? "Every input, replayed on the System's own machine. Same dungeon, same damage, same death — and it holds a board position."
          : "Every input, replayed on the System's own machine. Same dungeon, same damage, same death. It ranks nowhere, and it is still true.")
          + (isPrivate ? " Nobody else will ever be handed the film." : "") + eraNote,
        terminal: true,
      };
    case "verifying":
      return {
        cls: "vseal verifying",
        kicker: "THE SYSTEM IS RE-RUNNING YOUR CRAWL",
        word: "VERIFYING",
        line: "Sixty inputs a second, played back against the same rules you played under. It either agrees with you or it does not.",
        terminal: false,
      };
    case "rejected":
      return {
        cls: "vseal rejected",
        kicker: "THE SYSTEM DISAGREES WITH YOU",
        word: "REFUSED",
        line: reason
          ? `The replay did not produce the run you claimed. ${reason}`
          : "The replay did not produce the run you claimed, so the row does not stand. The System does not explain twice; it explains once, here.",
        terminal: true,
      };
    case "unverifiable":
      return {
        cls: "vseal aged",
        kicker: "OUT OF EXECUTABLE ERAS",
        word: "UNPROVEN",
        line: `This run was recorded under rules this build can no longer execute, so it keeps whatever it earned and nothing more.${eraNote}`,
        terminal: true,
      };
    case "blocked":
      return {
        cls: "vseal blocked",
        kicker: "NO PROOF OFFERED",
        word: "UNSEALED",
        line: reason ?? "This run was never offered to the board, so there is nothing for the System to certify.",
        terminal: true,
      };
    case "unsubmitted":
      return {
        cls: "vseal pending",
        kicker: "THE RECORDING IS SEALED AGAINST THE RUN",
        word: "READY TO SUBMIT",
        line: "Twenty-odd kilobytes that reproduce this run exactly. Nothing has been sent yet.",
        terminal: false,
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
      };
  }
}

/** WATCH / RACE availability, with the refusal STATED rather than a greyed-out
 *  button (2.6f). A silent disable is how a player concludes the ladder is
 *  broken; a named era is how they conclude the game is honest. */
export function playability(r: BoardRun, currentEra: string): { ok: boolean; why: string } {
  if (r.private) return { ok: false, why: "PRIVATE — this crawler kept the film" };
  if (r.state !== "verified") return { ok: false, why: "UNPROVEN — only sealed runs are raceable" };
  if (!r.rulesEra) return { ok: false, why: "no proof retained for this row" };
  if (r.rulesEra !== currentEra) {
    return { ok: false, why: `RECORDED UNDER RULES ERA ${r.rulesEra} — NOT PLAYABLE ON ERA ${currentEra}` };
  }
  if (!r.playable) return { ok: false, why: "the proof has aged out of retention" };
  return { ok: true, why: "" };
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
