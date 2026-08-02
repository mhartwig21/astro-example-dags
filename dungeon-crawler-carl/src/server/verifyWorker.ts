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
import { decodeProof, ReplayEraError, ReplayFormatError, ReplaySession, diffClaim } from "../sim/replay";
import { RULES_HASH } from "../sim/rulesHash";

export interface VerifyRequest {
  id: string;
  /** The stored artifact: gzip container or the raw container. */
  bytes: Uint8Array;
  /** Rules eras this build can execute (the sim-eras map, COMPETITIVE.md 2.6b). */
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
  const eras = req.eras ?? [RULES_HASH];
  const spent = (): number => Date.now() - t0;
  const fail = (state: "rejected" | "unverifiable", detail: string): VerifyReply =>
    ({ id: req.id, ok: false, msSpent: spent(), state, detail });

  let session: ReplaySession;
  try {
    const proof = decodeProof(inflateArtifact(req.bytes));
    if (req.requireFreshStart && proof.header.startKind !== "fresh") {
      return fail("rejected", "not a fresh start");
    }
    if (req.requireSeed !== undefined && proof.header.seed !== req.requireSeed) {
      return fail("rejected", "seed does not match the event");
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
      if (spent() > ceiling) return fail("rejected", "exceeded the wall-clock ceiling");
      if (restMs > 0) await sleep(restMs);
    }
  } catch {
    return fail("rejected", "replay threw");
  }

  const summary = session.summary();
  const lies = diffClaim(summary, session.proofClaim);
  if (lies.length) return fail("rejected", "claim disagrees with the replay: " + lies.join(", "));
  return { id: req.id, ok: true, msSpent: spent(), summary };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: VerifyRequest) => {
    void verifyArtifact(req).then(
      (reply) => port.postMessage(reply),
      (err: unknown) => port.postMessage({
        id: req.id, ok: false, msSpent: 0, state: "rejected",
        detail: "worker error: " + String(err),
      } satisfies VerifyReply),
    );
  });
}
