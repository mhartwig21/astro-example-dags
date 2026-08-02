/**
 * The two ways a proof actually gets replayed, behind one interface so the
 * queue semantics (COMPETITIVE.md 2.4) are identical either way.
 *
 * WorkerExecutor is the production path: a worker_threads thread that never
 * touches the tick thread. InlineExecutor is the fallback and the test path -
 * same code, same duty cycle, same slicing, just on this thread. The fallback
 * is not theoretical: the server runs under `node --import tsx`, and if a
 * worker ever fails to inherit the loader we degrade to slower verification
 * rather than to no verification.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { VerifyExecutor } from "./verify";
import { verifyArtifact, type VerifyReply, type VerifyRequest } from "./verifyWorker";

/** Chunked replay on THIS thread. It still slices and sleeps, so it is polite;
 *  it is simply not isolated from the event loop the way a thread is. */
export class InlineExecutor implements VerifyExecutor {
  run(req: VerifyRequest): Promise<VerifyReply> {
    return verifyArtifact(req);
  }
  dispose(): void { /* nothing to tear down */ }
}

/** One worker, one job at a time. Disposable on any failure: a crashed worker
 *  fails the job in flight and the next enqueue spawns a fresh one. */
export class WorkerExecutor implements VerifyExecutor {
  private worker: Worker | null = null;
  private pending: { resolve: (r: VerifyReply) => void; id: string } | null = null;
  private disposed = false;

  private spawn(): Worker {
    const url = new URL("./verifyWorker.ts", import.meta.url);
    // execArgv carries the tsx loader into the thread; without it the worker
    // cannot import a .ts module and we fall back to inline.
    const w = new Worker(fileURLToPath(url), { execArgv: ["--import", "tsx"] });
    w.on("message", (reply: VerifyReply) => {
      const p = this.pending;
      this.pending = null;
      if (p && reply.id === p.id) p.resolve(reply);
    });
    w.on("error", (err: Error) => {
      const p = this.pending;
      this.pending = null;
      this.worker = null;
      if (p) {
        p.resolve({ id: p.id, ok: false, msSpent: 0, state: "rejected", detail: "worker error: " + err.message });
      }
    });
    w.on("exit", () => { this.worker = null; });
    w.unref();
    return w;
  }

  run(req: VerifyRequest): Promise<VerifyReply> {
    if (this.disposed) {
      return Promise.resolve({ id: req.id, ok: false, msSpent: 0, state: "rejected", detail: "executor closed" });
    }
    if (!this.worker) {
      try {
        this.worker = this.spawn();
      } catch (err) {
        return Promise.resolve({
          id: req.id, ok: false, msSpent: 0, state: "rejected",
          detail: "cannot spawn worker: " + String(err),
        });
      }
    }
    return new Promise<VerifyReply>((resolve) => {
      this.pending = { resolve, id: req.id };
      // Copy into a DEDICATED ArrayBuffer before transferring. The artifact
      // usually arrives as a node Buffer, which is a view into a shared
      // allocation pool - transferring that pool detaches every OTHER live
      // Buffer sharing it, and the symptom is a proof that arrives in the
      // worker as garbage and gets REJECTED. An honest run failing
      // verification because of an allocator detail is the worst possible bug
      // in this subsystem, so the copy is not negotiable. It is tens of KB.
      const copy = new Uint8Array(req.bytes.byteLength);
      copy.set(req.bytes);
      this.worker!.postMessage({ ...req, bytes: copy }, [copy.buffer]);
    });
  }

  dispose(): void {
    this.disposed = true;
    void this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Production choice with a proven fallback: spawn a worker, wait for it to come
 * up, and if it cannot, say so once and verify inline. `DCC_VERIFY_INLINE=1`
 * forces inline (tests, and a box where threads are undesirable).
 */
export async function makeExecutor(): Promise<VerifyExecutor> {
  if (process.env.DCC_VERIFY_INLINE === "1") return new InlineExecutor();
  try {
    const url = fileURLToPath(new URL("./verifyWorker.ts", import.meta.url));
    const probe = new Worker(url, { execArgv: ["--import", "tsx"] });
    probe.unref();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("worker boot timed out")), 15_000);
      probe.once("online", () => { clearTimeout(t); resolve(); });
      probe.once("error", (e) => { clearTimeout(t); reject(e); });
    });
    await probe.terminate();
    return new WorkerExecutor();
  } catch (err) {
    console.warn("VERIFY: worker_threads unavailable, verifying inline:", String(err));
    return new InlineExecutor();
  }
}
