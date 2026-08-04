/**
 * THE VERIFY QUEUE (COMPETITIVE.md 2.4 + 2.7.3). Everything that decides WHICH
 * submissions cost CPU, in what order, and what happens when there are too many.
 *
 * Four rules, and each one is a direct answer to a way this could go wrong on a
 * single shared vCPU:
 *
 * 1. Never on the tick thread - the work happens in a worker (verifyWorker.ts),
 *    or in a chunked inline executor when a worker cannot be spawned.
 * 2. Verify only what could matter, AND only an account own improvements. The
 *    second clause is the load-bearing one: dailies allow unlimited attempts, so
 *    without it event volume equals attempts by every player rather than
 *    improvements by the population.
 * 3. Provisional, then promoted: claimed -> verifying -> verified | rejected |
 *    unverifiable. Only verified rows reach the top 3 or earn CP.
 * 4. A hard duty cycle whose backpressure SHEDS rather than closes. Closing the
 *    board is precisely the outcome a flooder wants; under shedding a flood
 *    degrades the flooder own entries first and the honest tail last.
 */
import type { RunSummary } from "../sim/replay";
import { RULES_HASH } from "../sim/rulesHash";
import {
  COST_SCALE_MAX, COST_SCALE_MIN, costScaleFrom, maxCertifiableTicks, tickCostUs,
  type VerifyReply, type VerifyRequest,
} from "./verifyWorker";

/** 25% of one core. The whole budget the box will ever spend on verification. */
export const VERIFY_BUDGET_MS_PER_SEC = 250;
/** A single job that runs longer than this is killed and rejected. */
export const VERIFY_JOB_CEILING_MS = 120_000;
/** Past this much estimated backlog, the queue drops its own tail. */
export const VERIFY_BACKLOG_SHED_SEC = 900;
/** Per-subject daily CPU budgets. Over budget, submissions are still ACCEPTED
 *  and stored claimed - they are just never queued. */
export const VERIFY_MS_PER_IP_PER_DAY = 600_000;
export const VERIFY_MS_PER_ACCOUNT_PER_DAY = 900_000;
/** Queue depth past which we stop accepting new jobs into memory at all. */
export const VERIFY_MAX_QUEUE = 500;

/** Priority classes (COMPETITIVE.md 2.4 rule 2): event entry > top-3 candidate
 *  > top-25 candidate. WITHIN a class, cheapest-first by claimed tick count, so
 *  a pile of 50-minute artifacts can never starve the dailies - it only ever
 *  starves itself. */
export const PRIORITY_EVENT = 0;
export const PRIORITY_TOP3 = 1;
export const PRIORITY_TOP25 = 2;

export interface VerifyJob {
  runId: string;
  proofId: string;
  bytes: Uint8Array;
  priority: number;
  /** Claimed ticks - the cheapest-first sort key and the cost estimate. */
  ticks: number;
  accountId: string;
  ip: string;
  /** Has this account ever had a run verified? Trust ordering for shedding. */
  hasHistory: boolean;
  eventSeed?: number;
  requireFreshStart?: boolean;
  enqueuedAt: number;
  /**
   * THE ERA THE PROOF WAS RECORDED UNDER, carried from the submitted header so
   * certification can stamp the row with the rules it was certified UNDER
   * (2.6c: `rules_hash = H`) rather than with whatever the server happens to be
   * running today. They coincide while `eras` holds one entry; the moment
   * sim-eras widens it, stamping the current hash would make the era chip - the
   * one thing 2.6c says LoL cannot show you - start lying on the first deploy.
   */
  rulesHash: string;
}

export type VerifyResult =
  | { runId: string; ok: true; summary: RunSummary; msSpent: number; cpuMs: number }
  | {
      runId: string; ok: false; state: "rejected" | "unverifiable"; detail: string;
      msSpent: number; cpuMs: number;
    };

/** How the replay actually runs. Injected so tests (and a box where a worker
 *  cannot be spawned) get the same queue semantics with a different engine. */
export interface VerifyExecutor {
  run(req: VerifyRequest): Promise<VerifyReply>;
  dispose(): void;
}

export interface VerifyQueueHooks {
  /** Called when a job starts - the row goes `verifying` (pulsing on the UI). */
  onStart(job: VerifyJob): void;
  /** Called with the verdict. The store writes the derived facts here. */
  onResult(job: VerifyJob, result: VerifyResult): void;
  /** Called when a job is shed. NOT lost: stored claimed with a deferred note
   *  and re-queued when the backlog clears. */
  onShed(job: VerifyJob): void;
  /**
   * Charge measured CPU to the IP and the account (COMPETITIVE.md 2.7.3).
   *
   * `cpuMs` IS THE UNIT THE BUDGET IS DENOMINATED IN, and it used to be handed
   * `reply.msSpent` - wall clock, duty-cycle sleeps and all - against a budget
   * `estimateMs` predicts in CPU ms (blocker 7). `wallMs` travels alongside for
   * the operator gauges, and neither is ever asked to be the other.
   */
  onSpend(job: VerifyJob, cpuMs: number, wallMs: number): void;
}

export interface VerifyQueueOptions {
  executor: VerifyExecutor;
  hooks: VerifyQueueHooks;
  eras?: string[];
  budgetMsPerSec?: number;
  ceilingMs?: number;
  shedBacklogSec?: number;
  maxQueue?: number;
}

export class VerifyQueue {
  private q: VerifyJob[] = [];
  private running: VerifyJob | null = null;
  private opts: VerifyQueueOptions;
  /**
   * HOW MUCH SLOWER THIS BOX IS THAN THE ONE 2.3 MEASURED - a dimensionless
   * multiplier on `tickCostUs`'s depth curve, as an EMA.
   *
   * It used to be an absolute `usPerTick`, seeded at 110 and corrected by every
   * job. Because per-tick cost is dominated by monster count (2.3: 20 us in a
   * boss arena, 675 us on floor 16), that scalar converged on "whatever the
   * last few submissions happened to be" in about ten jobs - and
   * `certifiableTicks` is inversely proportional to it, so a handful of
   * deliberately deep submissions from ONE account pushed the ceiling below
   * full-clear length for everybody (blocker 8). Against the curve, a deep
   * submission confirms the box instead of indicting it, and the value is
   * clamped and published so an operator can tell drift from poisoning.
   */
  private costScale = 1;
  private closed = false;
  msTotal = 0;
  /** The CPU half of the same total - what the per-subject budgets ration. */
  cpuMsTotal = 0;
  verified = 0;
  rejected = 0;
  unverifiable = 0;
  shed = 0;

  constructor(opts: VerifyQueueOptions) {
    this.opts = opts;
  }

  /** Swap the executor at runtime. The server boots with the inline one so
   *  the first submit is never dropped, then upgrades to a worker the moment
   *  one proves it can spawn - a boot-time worker probe must not gate play. */
  setExecutor(executor: VerifyExecutor): void {
    if (this.closed || executor === this.opts.executor) return;
    const old = this.opts.executor;
    this.opts.executor = executor;
    old.dispose();
  }

  get depth(): number { return this.q.length + (this.running ? 1 : 0); }
  get busy(): boolean { return this.running !== null; }

  /** Estimated seconds of WALL CLOCK to drain, at the duty cycle. The number
   *  /health and /metrics expose, and the number shedding triggers on. */
  backlogSeconds(): number {
    let cpuMs = 0;
    for (const j of this.q) cpuMs += this.estimateMs(j.ticks);
    if (this.running) cpuMs += this.estimateMs(this.running.ticks);
    const duty = (this.opts.budgetMsPerSec ?? VERIFY_BUDGET_MS_PER_SEC) / 1000;
    return cpuMs / 1000 / duty;
  }

  /** Estimated CPU cost of one job, in ms - what the daily budgets charge, in
   *  the same unit the worker now reports back (`VerifyReply.cpuMs`). */
  estimateMs(ticks: number): number {
    return (ticks * tickCostUs(ticks, this.costScale)) / 1000;
  }

  /** The measured box-speed multiplier, for /health and /metrics. An operator
   *  cannot tell drift from poisoning if the number is not on a surface. */
  get scale(): number { return this.costScale; }

  /** The longest run this box can re-execute inside its own budget, in ticks.
   *  Verification depth was a SILENT function of box speed; this is the number
   *  the submit path refuses against and the screens print (blocker 21). It has
   *  a documented FLOOR at full-clear length, so no submitter can move it below
   *  the length of the game (blocker 8). */
  get certifiableTicks(): number {
    return maxCertifiableTicks(
      this.opts.budgetMsPerSec ?? VERIFY_BUDGET_MS_PER_SEC,
      this.opts.ceilingMs ?? VERIFY_JOB_CEILING_MS,
      this.costScale,
    );
  }

  /** Returns false when the queue is full and the row must stay `claimed`. */
  enqueue(job: VerifyJob): boolean {
    if (this.closed) return false;
    if (this.depth >= (this.opts.maxQueue ?? VERIFY_MAX_QUEUE)) return false;
    this.q.push(job);
    this.sort();
    this.shedIfOverloaded();
    void this.pump();
    return this.q.includes(job) || this.running === job;
  }

  /** priority asc, then cheapest-first, then oldest-first. */
  private sort(): void {
    this.q.sort((a, b) =>
      a.priority - b.priority || a.ticks - b.ticks || a.enqueuedAt - b.enqueuedAt);
  }

  /**
   * BACKPRESSURE THAT SHEDS (COMPETITIVE.md 2.4 rule 4). Drop from the TAIL,
   * least-trusted first: accounts with no verified history before accounts with
   * one, newest before oldest. A shed entry is not lost - the hook stores it
   * claimed with a deferred note and the caller re-queues when the backlog
   * clears. This is why a flood cannot close the board: it degrades the
   * flooder own entries first and the honest tail of the queue last.
   */
  private shedIfOverloaded(): void {
    const limit = this.opts.shedBacklogSec ?? VERIFY_BACKLOG_SHED_SEC;
    if (this.backlogSeconds() <= limit) return;
    // Shed candidates, worst-trust first.
    const order = [...this.q].sort((a, b) =>
      Number(a.hasHistory) - Number(b.hasHistory)
      || b.enqueuedAt - a.enqueuedAt
      || b.ticks - a.ticks);
    for (const victim of order) {
      if (this.backlogSeconds() <= limit) break;
      const i = this.q.indexOf(victim);
      if (i < 0) continue;
      this.q.splice(i, 1);
      this.shed++;
      this.opts.hooks.onShed(victim);
    }
  }

  private pumping = false;
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.q.length > 0) {
        const job = this.q.shift()!;
        this.running = job;
        this.opts.hooks.onStart(job);
        const reply = await this.opts.executor.run({
          id: job.runId,
          bytes: job.bytes,
          eras: this.opts.eras ?? [RULES_HASH],
          requireSeed: job.eventSeed,
          requireFreshStart: job.requireFreshStart,
          budgetMsPerSec: this.opts.budgetMsPerSec ?? VERIFY_BUDGET_MS_PER_SEC,
          ceilingMs: this.opts.ceilingMs ?? VERIFY_JOB_CEILING_MS,
          // The live cost model, so the worker can STATE the depth limit before
          // it spends the clock instead of expressing it as an accusation two
          // minutes later (COMPETITIVE.md 2.3, blocker 21).
          costScale: this.costScale,
        });
        this.running = null;
        this.msTotal += reply.msSpent;
        this.cpuMsTotal += reply.cpuMs;
        if (job.ticks > 500 && reply.cpuMs > 0) {
          // CORRECT THE MODEL FROM MEASURED CPU, NOT FROM WALL CLOCK SCALED BY
          // A DUTY FACTOR - the executors sleep differently, so that derivation
          // was wrong for one of them by construction. And correct the
          // dimensionless SCALE, so a deep job (which the curve already expects
          // to cost more per tick) confirms the box instead of dragging every
          // other player's ceiling down with it.
          const sample = costScaleFrom(job.ticks, reply.cpuMs);
          if (sample > 0.05 && sample < 20) {
            this.costScale = Math.min(
              COST_SCALE_MAX,
              Math.max(COST_SCALE_MIN, this.costScale * 0.8 + sample * 0.2),
            );
          }
        }
        this.opts.hooks.onSpend(job, reply.cpuMs, reply.msSpent);
        if (reply.ok) {
          this.verified++;
          this.opts.hooks.onResult(job, {
            runId: job.runId, ok: true, summary: reply.summary,
            msSpent: reply.msSpent, cpuMs: reply.cpuMs,
          });
        } else {
          if (reply.state === "rejected") this.rejected++; else this.unverifiable++;
          this.opts.hooks.onResult(job, {
            runId: job.runId, ok: false, state: reply.state, detail: reply.detail,
            msSpent: reply.msSpent, cpuMs: reply.cpuMs,
          });
        }
      }
    } finally {
      this.pumping = false;
      this.running = null;
    }
  }

  /** Drain for tests: resolves when the queue is empty. */
  async drain(): Promise<void> {
    await this.pump();
    while (this.pumping || this.q.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  close(): void {
    this.closed = true;
    this.q = [];
    this.opts.executor.dispose();
  }
}
