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
  /** The queue's measured microseconds of CPU per replayed tick. Used to say
   *  the depth limit OUT LOUD, before the clock is spent, instead of letting it
   *  express itself as an accusation two minutes later (COMPETITIVE.md 2.3). */
  usPerTick?: number;
}

/**
 * HOW LONG A RUN THIS BOX CAN CERTIFY, in ticks - the boundary blocker 21 says
 * exists and nothing stated. `spent()` is WALL CLOCK including the duty sleeps,
 * so a 120 s ceiling at 250 ms/s buys about 30 s of CPU; at the measured
 * 110 us/tick that is roughly 270k ticks here and, at 2.3's own 1.5-3x Fly
 * penalty, 90-180k there. Past it the run is `unverifiable` with the limit
 * printed, never `rejected`: a box that ran out of clock has not caught anybody
 * lying.
 */
export function maxCertifiableTicks(
  budgetMsPerSec = 250, ceilingMs = 120_000, usPerTick = 110,
): number {
  const cpuMs = ceilingMs * (Math.max(10, budgetMsPerSec) / 1000);
  // Leave a fifth of the budget as headroom: the EMA is an average, and a busy
  // box that certifies on one attempt and accuses on the next is worse than a
  // box that refuses both plainly.
  return Math.max(3600, Math.floor((cpuMs * 1000 * 0.8) / Math.max(1, usPerTick)));
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

export type VerifyReply =
  | { id: string; ok: true; msSpent: number; summary: ReturnType<ReplaySession["summary"]> }
  | { id: string; ok: false; msSpent: number; state: "rejected" | "unverifiable"; detail: string };

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
  const fail = (state: "rejected" | "unverifiable", detail: string): VerifyReply =>
    ({ id: req.id, ok: false, msSpent: spent(), state, detail });

  let session: ReplaySession;
  const maxTicks = maxCertifiableTicks(budget, ceiling, req.usPerTick);
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
  return { id: req.id, ok: true, msSpent: spent(), summary };
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
        id: req.id, ok: false, msSpent: 0, state: "unverifiable",
        detail: "the verifier failed while re-running this proof, so nothing was decided about it: "
          + String(err),
      } satisfies VerifyReply),
    );
  });
}
