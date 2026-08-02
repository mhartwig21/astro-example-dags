/**
 * THE GHOST WORKER (COMPETITIVE.md 4.1). Replays a stored proof off the main
 * thread and streams back a GHOST TRACK - the crawler transform per keyframe
 * plus its floor-entry ticks - so racing a rival costs the frame an array index
 * and a lerp instead of a second sim.
 *
 * Why this is not optional arithmetic. The naive version runs a second
 * GameState on the main thread, one ghost tick per local tick: 20 us in a boss
 * arena, 675 us on floor 16 with 192 monsters. An earlier draft priced that as
 * "0.1-4% of a frame" against a 16,667 us budget. That is the IDEAL frame, not
 * this project's: on the target device (Intel iGPU via ANGLE D3D11) combat
 * frames land at 16.65 ms against a 16.67 ms vsync deadline, achieved by
 * dropping to pixel ratio 1.2. There is no spare 4% of a frame. Adding 0.675 ms
 * of main-thread sim at depth does not cost slack; it costs the frame, on the
 * one constraint the whole perf round was fought over.
 *
 * A ghost has no render state and no interaction with your world - it is a
 * rival's TRAJECTORY, never a shared world - so it is fully precomputable, and
 * replay already runs at 150-250x realtime. The worker is minutes ahead of the
 * player within the first seconds of the run.
 *
 * The same machinery is what a REPLAY scrubber needs (seek = index into the
 * track), so it is one piece serving both.
 */
import { decodeProof, ReplayEraError, ReplaySession, type GhostTrack } from "../sim/replay";

export interface GhostRequest {
  /** The raw (already inflated) proof container. */
  bytes: Uint8Array;
  /** Keyframe rate. 10 Hz is ~2 B/tick equivalent and lerps invisibly. */
  ghostHz?: number;
  /** Eras this bundle can execute - the client era gate (2.6f). */
  eras?: string[];
}

export type GhostReply =
  | { ok: true; track: GhostTrack; floorEntryTicks: number[]; ticks: number; label: string }
  | { ok: false; reason: string; era: string | null };

/** Build a ghost track. Exported so tests and the main thread can call it
 *  directly without a worker (small proofs, or a browser without workers). */
export function buildGhostTrack(req: GhostRequest): GhostReply {
  try {
    const proof = decodeProof(req.bytes);
    const s = new ReplaySession(proof, { ghostHz: req.ghostHz ?? 10, availableEras: req.eras });
    while (!s.advance(4096)) { /* 150-250x realtime; minutes ahead in seconds */ }
    const summary = s.summary();
    return {
      ok: true,
      track: s.ghost!,
      floorEntryTicks: summary.floorEntryTicks,
      ticks: summary.ticks,
      label: proof.header.playerName ?? "RIVAL",
    };
  } catch (err) {
    // NEVER step a foreign proof into the current sim "to see what happens".
    // It will not throw - the artifact decodes and the sim runs - it will
    // quietly diverge and render a wrong ghost with a wrong split delta, and
    // the player has no way to detect it (2.6f).
    if (err instanceof ReplayEraError) {
      return { ok: false, reason: err.message, era: err.proofHash.slice(0, 7) };
    }
    return { ok: false, reason: String((err as Error).message ?? err), era: null };
  }
}

// Module-worker entry. Guarded so importing this file (tests, the main-thread
// fallback) never installs a listener.
declare const self: { onmessage?: (e: MessageEvent<GhostRequest>) => void; postMessage(m: unknown): void };
if (typeof self !== "undefined" && typeof (self as { document?: unknown }).document === "undefined") {
  self.onmessage = (e: MessageEvent<GhostRequest>): void => {
    self.postMessage(buildGhostTrack(e.data));
  };
}
