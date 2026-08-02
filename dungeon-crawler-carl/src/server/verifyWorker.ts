/**
 * THE VERIFY WORKER (COMPETITIVE.md 2.4 rule 1). A worker_threads thread that
 * imports the sim and replays a submitted proof to certification.
 *
 * Why a thread and not the request handler: the box is ONE shared vCPU with a
 * 33 ms budget per 30 Hz tick ACROSS EVERY LIVE PARTY. A full-run replay is
 * seconds of CPU; on the tick thread that is seconds of frozen dungeon for
 * everyone on the machine.
 *
 * Why the worker still yields: a thread is not free either - it competes for
 * the same core. So the replay runs in slices and sleeps between them, holding
 * itself to budgetMsPerSec (default 250, a quarter of a core). One worker, one
 * job at a time, disposable on any failure.
 */
import { parentPort } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import {
  REPLAY_DT, decodeProof, ReplayEraError, ReplayFormatError, ReplaySession, diffClaim,
  type RunClaim, type RunProofHeader, type RunSummary,
} from "../sim/replay";
import { RULES_HASH } from "../sim/rulesHash";

/**
 * THE ONLY RULESET A BOARD ROW MAY HAVE BEEN PLAYED UNDER.
 *
 * `validateProofShape` checks version, hash, seed, ticks, dt, startKind, actions
 * and claim, and never looks at `header.mode` or `header.runKind` - and
 * `ReplaySession` builds the world straight from them
 * (`createGame(seed, mode, runKind)`). So a ROAM recording replayed cleanly and
 * came back `ok: true`: measured on seed 2024, the shipped bot ended a RACE dead
 * on floor 5 with 115 kills and ended a ROAM on floor 16 with 171 kills and a
 * roam-only ultimate, CERTIFIED. Roam floors have no boss gate and a flat
 * 30-minute budget instead of `floorTimeBudget`, so the same policy walks about
 * four times as far in the time a race walks one - which takes DEEPEST outright,
 * owns KILLS, and takes every band board at roughly 2x pace.
 *
 * The client refusal for this existed and was POLITE only (`recBlocked = "ROAM
 * has no clock and no board"`), which is precisely the pattern 2.5 step 2 says
 * it made STRUCTURAL for test starts. This is the structural half, and it lives
 * on the server: one gate, applied at the door AND inside the worker, so a
 * hand-rolled artifact never reaches `ReplaySession` at all.
 */
export const RANKED_RUN_KIND = "race";
export const RANKED_MODES: readonly string[] = ["coop"];

/**
 * Is this header a ruleset the ladder ranks? Returns null when it is, or the
 * player-facing reason when it is not.
 */
export function rulesetRefusal(h: Pick<RunProofHeader, "mode" | "runKind">): string | null {
  if (h.runKind !== RANKED_RUN_KIND) {
    return `${String(h.runKind).toUpperCase()} has no collapse clock and no boss gate, so its floors `
      + "are not the floors a board ranks. Only a RACE carries a board row.";
  }
  if (!RANKED_MODES.includes(String(h.mode))) {
    return `${String(h.mode).toUpperCase()} is hosted differently from the descent a proof reproduces, `
      + "so it is not eligible for a board.";
  }
  return null;
}

/**
 * THE ERAS THIS WORKER CAN ACTUALLY EXECUTE - keyed to loadable sim modules,
 * never to a string list.
 *
 * This file imports exactly ONE sim (`../sim/replay`) and passed the CALLER'S
 * `eras[]` straight through as `availableEras`, while `assertPlayableEra` only
 * checks list membership. Widen `eras` to four (which is precisely what
 * `CompetitiveApiOptions.eras` says will happen when sim-eras ships) and the
 * worker replays era-N-2 proofs against era-N rules: silent divergence with no
 * referee, producing false REJECTIONS of honest runs and - worse - false
 * CERTIFICATIONS wherever the divergence happens not to move the six diffed
 * fields. That is 2.6f's forbidden failure mode, running on the server.
 *
 * When `src/sim-eras/` lands, each era registers its own replay module HERE,
 * beside its hash, and this map is what the gate is keyed on. Until then the
 * honest answer is one entry, and an older proof comes back `unverifiable`
 * (the row keeps its stamp) rather than being replayed under the wrong rules.
 */
export const ERA_SIMS: Readonly<Record<string, { ReplaySession: typeof ReplaySession }>> = {
  [RULES_HASH]: { ReplaySession },
};

export const EXECUTABLE_ERAS: readonly string[] = Object.keys(ERA_SIMS);

/** Narrow a requested era list to the ones a sim module actually backs. A
 *  caller asking for more is not an error - it is answered with less. */
export function executableEras(want: readonly string[] | undefined): string[] {
  const list = (want ?? EXECUTABLE_ERAS).filter((e) => e in ERA_SIMS);
  return list.length ? list : [];
}

export interface VerifyRequest {
  id: string;
  /** The stored artifact: gzip container or the raw container. */
  bytes: Uint8Array;
  /** Rules eras the CALLER believes this build can execute. Intersected with
   *  `ERA_SIMS` before anything replays (COMPETITIVE.md 2.6b/2.6f). */
  eras?: string[];
  /** For an event entry, the seed the event PINS. A mismatch is a rejection
   *  before a single tick runs (COMPETITIVE.md 2.5 step 2). */
  requireSeed?: number;
  /** Event entries and board rows must start fresh; a createTestGame start is
   *  never eligible, which makes the client-side testMode exclusion structural. */
  requireFreshStart?: boolean;
  budgetMsPerSec?: number;
  ceilingMs?: number;
  chunkTicks?: number;
  /** The queue's measured BOX-SPEED MULTIPLIER against 2.3's dev-box cost curve
   *  (`tickCostUs`). Used to say the depth limit OUT LOUD, before the clock is
   *  spent, instead of letting it express itself as an accusation two minutes
   *  later. A multiplier rather than a us/tick scalar, because per-tick cost is
   *  a function of DEPTH and a scalar therefore describes the last thing
   *  submitted rather than the machine (blocker 8). */
  costScale?: number;
}

/**
 * THE COST MODEL, WHICH IS A CURVE AND NOT A SCALAR (blocker 8).
 *
 * The queue used to carry ONE global mutable `usPerTick`, seeded at 110 and
 * EMA-corrected by every job any account submitted - and `certifiableTicks` is
 * inversely proportional to it. 2.3 measured the thing that makes that fatal:
 * per-tick cost is dominated by MONSTER COUNT, not by the box - "20 us in a
 * 4-entity boss arena, 675 us on floor 16 with 192 monsters". So a handful of
 * deliberately deep submissions from one account converge the scalar upward in
 * about ten jobs and drag the certification ceiling below full-clear length for
 * EVERYBODY, with nothing on /health to tell drift from poisoning.
 *
 * The fix is to stop describing a curve with a point. 2.3's own measured table
 * (ticks -> us/tick: 4,282 -> 72; 19,626 -> 141; 25,947 -> 143; 45,419 -> 230;
 * 48,265 -> 240) is very close to linear in run length, because runs get deeper
 * as they get longer:
 *
 *     us/tick(ticks) = scale * (55 + 0.0038 * ticks)
 *
 * `scale` is then DIMENSIONLESS - "how much slower is this box than the dev box
 * it was measured on" - and a deep submission no longer moves it, because the
 * model already expected a deep run to cost more. Re-deriving the table above
 * gives scale 0.97 / 1.06 / 0.94 / 1.00 / 1.01: five runs spanning an order of
 * magnitude in depth, all reporting the same box.
 */
export const TICK_COST_BASE_US = 55;
export const TICK_COST_SLOPE_US = 0.0038;

/** Expected CPU microseconds per replayed tick for a run of this length. */
export function tickCostUs(ticks: number, scale = 1): number {
  return scale * (TICK_COST_BASE_US + TICK_COST_SLOPE_US * Math.max(0, ticks));
}

/** The box-speed multiplier a completed job implies. Inverting the curve is
 *  what makes a floor-16 sample and a floor-3 sample comparable. */
export function costScaleFrom(ticks: number, cpuMs: number): number {
  const expectedUs = TICK_COST_BASE_US + TICK_COST_SLOPE_US * Math.max(0, ticks);
  return (cpuMs * 1000) / Math.max(1, ticks * expectedUs);
}

/** How far the measured scale is ever allowed to move the ceiling. Past 3x the
 *  dev-box baseline the box is either broken or being poisoned, and in neither
 *  case is the right answer to shrink every honest player's allowance. */
export const COST_SCALE_MIN = 0.5;
export const COST_SCALE_MAX = 3;

/**
 * A FLOOR UNDER THE CEILING, AT THE LENGTH OF THE THING THE GAME IS ABOUT.
 *
 * 2.3 extrapolates a full 18-floor clear at 55-60k ticks. A verification
 * ceiling that any submitter can drive below that is a ceiling that can be
 * driven below "the game" - and the clamp alone does not prevent it: at the
 * production budget, scale 1.0 affords ~72.5k ticks and scale 3.0 (the clamp
 * MAXIMUM) affords ~39k, which is 11 sim-minutes and refuses every clear on the
 * board.
 *
 * So the floor is RELATIVE, not absolute: no measurement may push the ceiling
 * below a full clear, but the OPERATOR'S OWN BUDGET still bounds it. A box
 * configured with a one-millisecond job ceiling gets a one-millisecond answer -
 * that is a decision somebody made, not a lever a submitter pulled. The
 * distinction is the whole point: the ceiling stops being a function of who
 * submitted last, and stays a function of what the box was given.
 */
export const FULL_CLEAR_TICKS = 66_000;
/** Below this nothing is certifiable at all; a box this constrained is not
 *  running a ladder. Retained from the previous absolute floor. */
export const MIN_CERTIFIABLE_TICKS = 3600;

/**
 * HOW LONG A RUN THIS BOX CAN CERTIFY, in ticks - the boundary blocker 21 says
 * exists and nothing stated. Past it the run is `unverifiable` with the limit
 * printed, never `rejected`: a box that ran out of clock has not caught anybody
 * lying.
 *
 * With the curve above this is a quadratic rather than a division:
 * solve `T * scale * (base + slope*T) = budgetUs` for T.
 */
export function maxCertifiableTicks(
  budgetMsPerSec = 250, ceilingMs = 120_000, costScale = 1,
): number {
  // `spent()` is WALL CLOCK including the duty sleeps, so a 120 s ceiling at
  // 250 ms/s buys about 30 s of CPU. Leave a fifth as headroom: a busy box that
  // certifies on one attempt and accuses on the next is worse than one that
  // refuses both plainly.
  const budgetUs = ceilingMs * (Math.max(10, budgetMsPerSec) / 1000) * 1000 * 0.8;
  const solve = (s: number): number => {
    const a = s * TICK_COST_SLOPE_US;
    const b = s * TICK_COST_BASE_US;
    return (-b + Math.sqrt(b * b + 4 * a * budgetUs)) / (2 * a);
  };
  const measured = solve(Math.min(COST_SCALE_MAX, Math.max(COST_SCALE_MIN, costScale)));
  // The floor is a full clear OR whatever the operator's own budget affords at
  // the unpoisoned baseline, whichever is SMALLER. A measurement can never take
  // the ceiling below the game; a deployment decision still can.
  const floor = Math.min(FULL_CLEAR_TICKS, solve(1));
  return Math.max(MIN_CERTIFIABLE_TICKS, Math.floor(Math.max(measured, floor)));
}

/** The same boundary in the unit a player thinks in. */
function simMinutes(ticks: number): number {
  return Math.max(1, Math.round((ticks * REPLAY_DT) / 60));
}

/**
 * THE REJECTION, WITH THE NUMBERS IN IT (COMPETITIVE.md 6.2 Beat 5: "a
 * rejection that arrives with no explanation is how honest players conclude the
 * ladder is rigged").
 *
 * `diffClaim` pushes bare field identifiers - "status", "kills" - because it
 * lives inside the sim and its job is to answer whether the claim is true. The
 * verifier holds BOTH sides at that moment: it knows you claimed 42 kills and
 * the replay produced 39. The highest-stakes negative moment in the product was
 * printing a debug token, so the sentence is built here, on the server, where
 * both halves are in scope and no era is spent to do it.
 */
export function describeClaimDiff(summary: RunSummary, claim: RunClaim, fields: readonly string[]): string {
  const say = (field: string): string | null => {
    switch (field) {
      case "status":
        return `you claimed the run ended ${labelStatus(claim.status)}; the replay ended ${labelStatus(summary.status)}`;
      case "won":
        return claim.won
          ? "you claimed a clear; the replay never reached the exit"
          : "your claim says the run did not clear; the replay walked out";
      case "floor":
        return `you claimed floor ${claim.floor}; the replay reached floor ${summary.floor}`;
      case "ticks":
        return `you claimed ${claim.ticks.toLocaleString()} ticks; the replay ran ${summary.ticks.toLocaleString()}`;
      case "kills":
        return `you claimed ${claim.kills.toLocaleString()} kills; the replay counted ${summary.kills.toLocaleString()}`;
      case "level":
        return `you claimed level ${claim.level}; the replay finished at level ${summary.level}`;
      case "ultimate":
        return `you claimed the ultimate ${claim.ultimate ?? "none"}; the replay ended holding ${summary.ultimate ?? "none"}`;
      default:
        return null;
    }
  };
  const parts = fields.map(say).filter((s): s is string => !!s);
  if (parts.length === 0) return "the replay did not reproduce the submitted claim";
  return parts.join("; ");
}

function labelStatus(s: string): string {
  return s === "won" ? "in a clear" : s === "dead" ? "in a death" : `as "${s}"`;
}

/**
 * TWO CLOCKS, NAMED APART (blocker 7).
 *
 * `msSpent` is WALL CLOCK: it includes the duty-cycle sleeps, which are the
 * majority of it (at 250 ms/s, three quarters). `cpuMs` is the time actually
 * spent inside `session.advance` - the scarce resource the daily budgets in
 * 2.7.3 exist to ration, and the same unit `VerifyQueue.estimateMs` predicts.
 *
 * The queue charged `msSpent` against a budget it estimated in CPU ms, so at
 * the documented duty a full clear estimated ~6.0 s and was charged ~23.9 s -
 * a 4x mismatch inside one ledger, which puts an honest heavy player against
 * the wall at a quarter of the stated allowance. Deriving one from the other
 * with a duty factor would be wrong too, because `InlineExecutor` and the
 * worker sleep differently. So the worker MEASURES the number it is charged
 * for, and the two clocks travel together and never stand in for each other.
 */
export type VerifyReply =
  | {
      id: string; ok: true; msSpent: number; cpuMs: number;
      summary: ReturnType<ReplaySession["summary"]>;
    }
  | {
      id: string; ok: false; msSpent: number; cpuMs: number;
      state: "rejected" | "unverifiable"; detail: string;
    };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Gunzip if the payload carries the gzip magic; otherwise pass through. */
export function inflateArtifact(bytes: Uint8Array): Uint8Array {
  // Buffer.from(view) copies; Buffer.from(arrayBuffer) does not, and getting
  // that backwards on a pooled Buffer is how you gunzip somebody else's bytes.
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
    return new Uint8Array(gunzipSync(Buffer.from(view.buffer, view.byteOffset, view.byteLength)));
  }
  return view;
}

/**
 * The full check, in order, cheap rejects first (COMPETITIVE.md 2.5).
 * A REJECTION means the claim was false. UNVERIFIABLE means we could not run
 * the proof at all - an era we no longer carry - and that is deliberately NOT
 * the same verdict: the row keeps whatever stamp it earned and the player is
 * told plainly rather than accused (COMPETITIVE.md 2.6d).
 */
export async function verifyArtifact(req: VerifyRequest): Promise<VerifyReply> {
  const t0 = Date.now();
  const budget = Math.max(10, Math.min(1000, req.budgetMsPerSec ?? 250));
  const ceiling = req.ceilingMs ?? 120_000;
  const chunk = req.chunkTicks ?? 600;
  // The gate is keyed to modules, not to strings: whatever the caller asked
  // for, only an era with a sim behind it is ever handed to ReplaySession.
  const eras = executableEras(req.eras);
  const spent = (): number => Date.now() - t0;
  // The CPU half of the ledger, accumulated slice by slice so it never counts a
  // duty-cycle sleep (blocker 7).
  let cpuMs = 0;
  const fail = (state: "rejected" | "unverifiable", detail: string): VerifyReply =>
    ({ id: req.id, ok: false, msSpent: spent(), cpuMs, state, detail });

  let session: ReplaySession;
  const maxTicks = maxCertifiableTicks(budget, ceiling, req.costScale);
  try {
    const proof = decodeProof(inflateArtifact(req.bytes));
    if (req.requireFreshStart && proof.header.startKind !== "fresh") {
      return fail("rejected", "not a fresh start");
    }
    // THE RULESET GATE, BEFORE A SINGLE TICK RUNS. A roam header builds a roam
    // world inside ReplaySession and replays to a perfectly honest floor 16.
    const ruleset = rulesetRefusal(proof.header);
    if (ruleset) return fail("rejected", ruleset);
    if (req.requireSeed !== undefined && proof.header.seed !== req.requireSeed) {
      return fail("rejected", "seed does not match the event");
    }
    // THE DEPTH LIMIT, STATED BEFORE THE CLOCK IS SPENT (blocker 21). Replaying
    // for two minutes and then calling the player a cheat is the one outcome
    // this boundary must never produce.
    if (proof.header.ticks > maxTicks) {
      return fail(
        "unverifiable",
        `this run is longer than the box can re-execute inside its verification budget — `
        + `${simMinutes(proof.header.ticks)} sim-minutes submitted against a ceiling of about `
        + `${simMinutes(maxTicks)}. Nothing here says the run is false; the System simply cannot `
        + `afford to watch all of it, so the row keeps whatever it earned.`,
      );
    }
    // Constructing the session runs the era gate AND the shape validation.
    session = new ReplaySession(proof, { availableEras: eras });
  } catch (err) {
    if (err instanceof ReplayEraError) return fail("unverifiable", err.message);
    if (err instanceof ReplayFormatError) return fail("rejected", err.message);
    return fail("rejected", "artifact unreadable");
  }

  // Slice-and-sleep: work `budget` ms out of every 1000, so a 6-second replay
  // occupies 24 seconds of wall clock and never 6 seconds of the core.
  const workMs = Math.max(4, Math.round(budget / 8));
  const restMs = Math.max(0, Math.round((workMs * 1000) / budget) - workMs);
  try {
    for (;;) {
      const sliceStart = Date.now();
      let done = false;
      while (!done && Date.now() - sliceStart < workMs) done = session.advance(chunk);
      cpuMs += Date.now() - sliceStart;
      if (done) break;
      // A BOX THAT RAN OUT OF CLOCK HAS NOT CAUGHT ANYBODY LYING (2.6d).
      // `rejected` is the state reserved for "the claim was false", and it came
      // with a ten-minute account cooldown and the line "The replay did not
      // produce the run you claimed" - for a RESOURCE failure. Capability
      // failures are `unverifiable`: the row keeps whatever stamp it earned and
      // the player is told plainly rather than accused.
      if (spent() > ceiling) {
        return fail(
          "unverifiable",
          `the verification budget on this machine ran out before the replay finished — about `
          + `${simMinutes(maxTicks)} sim-minutes is what it can afford, and this run is longer. `
          + `That is a limit of the box, not a verdict on the run.`,
        );
      }
      if (restMs > 0) await sleep(restMs);
    }
  } catch (err) {
    // A throw inside the replay is ambiguous - a malformed artifact and a box
    // that fell over look the same from here - and `unverifiable` is the safe
    // direction: it grants no seal, no rank and no CP, and it does not accuse.
    return fail("unverifiable", "the replay could not be completed on this machine: " + String(err));
  }

  const summary = session.summary();
  const lies = diffClaim(summary, session.proofClaim);
  if (lies.length) {
    return fail("rejected", describeClaimDiff(summary, session.proofClaim, lies));
  }
  return { id: req.id, ok: true, msSpent: spent(), cpuMs, summary };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: VerifyRequest) => {
    void verifyArtifact(req).then(
      (reply) => port.postMessage(reply),
      // A WORKER THAT FELL OVER IS NOT A LIAR (2.6d). This used to answer
      // `rejected`, which costs the account a ten-minute cooldown and prints
      // "The System disagrees with you" for an infrastructure failure.
      (err: unknown) => port.postMessage({
        id: req.id, ok: false, msSpent: 0, cpuMs: 0, state: "unverifiable",
        detail: "the verifier failed while re-running this proof, so nothing was decided about it: "
          + String(err),
      } satisfies VerifyReply),
    );
  });
}
