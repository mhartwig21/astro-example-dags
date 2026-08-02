/**
 * THE COMPETITIVE HTTP SURFACE (COMPETITIVE.md MUST-5).
 *
 *   POST /auth/anon            server-issued anonymous token (2.7.2)
 *   POST /runs                 submit a proof
 *   GET  /runs/:id             metadata + artifact, for ghosts and replay
 *   POST /runs/:id/private     owner-only distribution toggle (8.1)
 *   GET  /boards/:kind         all-time and per-event ladders
 *   GET  /bands/:n             per-band splits board (3.3)
 *   GET  /crawler/:id          career + personal bests
 *   GET  /events/current       the open daily and weekly contracts
 *   POST /events/:id/start     issues the signed attempt ticket (3.2A)
 *   GET  /rivals/contract      today asynchronous rival pairing (4.2)
 *
 * Everything here is bare Node: no framework, no router library, no session
 * store. The trust model is stated once, at the top of the submit path, and
 * enforced there rather than sprinkled: an ANONYMOUS crawler can play, keep a
 * local career, read every board, race every ghost and submit a CLAIMED row;
 * only a LINKED identity can spend the box CPU on verification or earn CP.
 * The ask lands at the one moment it is obviously worth paying - the first time
 * a run is good enough to be worth sealing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { decodeProof, MAX_PROOF_BYTES, REPLAY_DT, validateProofShape, type RunProof } from "../sim/replay";
import { RULES_HASH } from "../sim/rulesHash";
import { dayFromMs } from "../sim/daily";
import { sanitizeName } from "./names";
import { executableEras, inflateArtifact } from "./verifyWorker";
import {
  BOARD_KINDS, RANK_REFUSED_REASON, SPLIT_GATE_ENTRIES, publicIdFor,
  type BoardKind, type CompetitiveStore, type RunRow,
} from "./competitive";
import {
  VerifyQueue, VERIFY_MS_PER_ACCOUNT_PER_DAY, VERIFY_MS_PER_IP_PER_DAY,
  PRIORITY_EVENT, PRIORITY_TOP3, PRIORITY_TOP25,
  type VerifyExecutor, type VerifyJob,
} from "./verify";
import { TICKET_GRACE_MS, TICKET_SKEW_MS, type TokenService } from "./tokens";
import type { PersistDb } from "./db";
import { cpFor, dailyEvent, seasonIdFor, standingFor, weeklyEvent, type EventSpec } from "./season";

/** Body cap for a submit. The artifact cap is 128 KB; gzip only shrinks it, so
 *  anything materially bigger is not a run, it is an attack. */
const MAX_BODY = MAX_PROOF_BYTES + 8192;
/** Personal proof retention, on top of whatever is on a board (2.4 Storage). */
export const KEEP_PROOFS_PER_ACCOUNT = 10;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export interface CompetitiveApiOptions {
  store: CompetitiveStore;
  db: PersistDb | null;
  tokens: TokenService;
  /** How replays actually run. Injected so the queue semantics are the same
   *  whether the work happens in a worker or inline (verifyExecutor.ts). */
  executor: VerifyExecutor;
  /** Duty-cycle overrides. Tests turn these down; production uses the
   *  documented 250 ms/s of one core. */
  budgetMsPerSec?: number;
  ceilingMs?: number;
  shedBacklogSec?: number;
  maxQueue?: number;
  /** Rules eras this build can execute. One today; four once sim-eras ships. */
  eras?: string[];
  now?: () => number;
}

interface SubmitOutcome {
  runId: string;
  state: string;
  queued: boolean;
  /** Why it was not queued, in words the post-run screen can print verbatim. */
  reason?: string;
  attemptNo?: number;
  scoresCp?: boolean;
}

export class CompetitiveApi {
  readonly store: CompetitiveStore;
  private db: PersistDb | null;
  private tokens: TokenService;
  readonly queue: VerifyQueue;
  private eras: string[];
  private now: () => number;
  private buckets = new Map<string, { tokens: number; at: number }>();
  /** Accounts cooling down after a rejection - a false claim costs time. */
  private cooldown = new Map<string, number>();
  /** Shed jobs waiting for the backlog to clear (2.4 rule 4: not lost). */
  private deferred: VerifyJob[] = [];

  constructor(o: CompetitiveApiOptions) {
    this.store = o.store;
    this.db = o.db;
    this.tokens = o.tokens;
    // KEYED TO MODULES, NOT TO STRINGS (2.6f). Whatever the deployment asks
    // for, an era with no sim behind it can only ever produce a silent desync,
    // so it is dropped here as well as in the worker - and the same narrowed
    // list is what the wire's `playable` flag is computed from, so the client
    // is never offered a ghost the box cannot replay.
    this.eras = executableEras(o.eras);
    this.now = o.now ?? Date.now;
    // The queue is built HERE, with this API as its hooks, so there is exactly
    // one object that knows how a verdict becomes a row.
    this.queue = new VerifyQueue({
      executor: o.executor,
      eras: this.eras,
      budgetMsPerSec: o.budgetMsPerSec,
      ceilingMs: o.ceilingMs,
      shedBacklogSec: o.shedBacklogSec,
      maxQueue: o.maxQueue,
      hooks: {
        onStart: (job) => this.store.setState(job.runId, "verifying"),
        onResult: (job, r) => {
          if (r.ok) this.onVerified(job, r.summary);
          else this.onFailed(job, r.state, r.detail);
        },
        onShed: (job) => this.onShed(job),
        onSpend: (job, ms) => this.onSpend(job, ms),
      },
    });
    // PATCH DAY (2.6e): any event pinned to an era this build cannot execute
    // closes early. Verified entries stand; new submissions are refused.
    this.store.freezeStaleEvents(RULES_HASH);
  }

  /** Shut the queue and its executor down (server close, tests). */
  close(): void {
    this.queue.close();
  }

  /** Health/metrics surface for the duty cycle (2.4 rule 4). */
  stats(): Record<string, number> {
    return {
      verify_queue_depth: this.queue.depth,
      verify_ms_total: Math.round(this.queue.msTotal),
      verify_backlog_seconds: Math.round(this.queue.backlogSeconds()),
      verify_verified_total: this.queue.verified,
      verify_rejected_total: this.queue.rejected,
      verify_unverifiable_total: this.queue.unverifiable,
      verify_shed_total: this.queue.shed,
      verify_deferred: this.deferred.length,
    };
  }

  // ---- plumbing ----------------------------------------------------------

  private ipOf(req: IncomingMessage): string {
    return String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "?");
  }

  /** Token bucket per IP. Separate from the legacy board bucket on purpose:
   *  submitting a proof and reading a board are different appetites. */
  private allow(ip: string, burst = 8, perMin = 8): boolean {
    const now = this.now();
    const b = this.buckets.get(ip) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMin);
    b.at = now;
    this.buckets.set(ip, b);
    if (this.buckets.size > 5000) this.buckets.clear(); // memory backstop
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
    res.end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let n = 0;
      let over = false;
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > cap) { over = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  /** A linked provider identity is what costs the submitter something real. */
  private isLinked(accountId: string): boolean {
    return (this.db?.identitiesOf(accountId).length ?? 0) > 0;
  }

  private hasVerifiedHistory(accountId: string): boolean {
    return this.store.runsByAccount(accountId, 50).some((r) => r.state === "verified");
  }

  /** Make sure today contracts exist, pinned to the era that created them. */
  private ensureEvents(nowMs: number): { daily: EventSpec; weekly: EventSpec } {
    const daily = dailyEvent(nowMs);
    const weekly = weeklyEvent(nowMs);
    for (const e of [daily, weekly]) {
      this.store.upsertEvent({ ...e, rulesHash: RULES_HASH });
    }
    return { daily, weekly };
  }

  // ---- submit ------------------------------------------------------------

  /**
   * The whole decision, in the order it must run: cheap rejects on the request
   * thread, then the queue rules, then storage. Nothing here replays anything -
   * the expensive work is handed to the queue and answered asynchronously,
   * which is what "provisional, then promoted" means on the wire.
   */
  async submit(
    artifact: Uint8Array, accountId: string, rawName: string, ip: string,
    opts: { private?: boolean; partySize?: number } = {},
  ): Promise<SubmitOutcome | { error: string }> {
    const now = this.now();
    const day = dayFromMs(now);

    // Inflate ONCE, here, and keep the raw container. Storing the bytes as
    // they arrived would double-gzip them, and the worker - which inflates
    // exactly once - would then reject a perfectly honest run for bad magic.
    let raw: Uint8Array;
    let proof: RunProof;
    try {
      raw = inflateArtifact(artifact);
      proof = decodeProof(raw);
    } catch (err) {
      return { error: "unreadable artifact: " + (err as Error).message };
    }
    const shape = validateProofShape(proof);
    if (shape) return { error: shape };

    const h = proof.header;
    const c = proof.claim;
    const displayName = sanitizeName(rawName);
    const runId = day + "-" + Math.random().toString(36).slice(2, 10) + "-" + (now % 100000);
    const eventId = typeof h.eventId === "string" ? h.eventId : null;

    // --- event legitimacy (2.5 step 2). Checked before anything is stored.
    let attemptNo: number | null = null;
    let eventSeed: number | undefined;
    /** Set when a ticket VERIFIES but does not back the run it arrived with. */
    let ticketRefusal: string | null = null;
    if (eventId) {
      this.ensureEvents(now);
      const evt = this.store.getEvent(eventId);
      if (!evt) return { error: "unknown event" };
      if (evt.frozen) {
        return { error: "PATCH DAY. That contract is closed early. The lawyers apologize." };
      }
      if (now > evt.closesAt + 3600_000) return { error: "that contract has closed" };
      if (h.seed !== evt.seed) return { error: "seed does not match the event" };
      eventSeed = evt.seed;

      // THE TICKET HAS TO FIT THE RUN (3.2A). A signature alone proves only
      // that the contract was signed at some point; it does not prove that
      // THIS run is the one that followed. Three checks turn it back into what
      // the design says it is - the START being observed rather than the
      // finish - and each of them stores the row and states its reason rather
      // than throwing the run away.
      const claim = this.tokens.readTicket(h.ticket, eventId, accountId);
      if (claim) {
        const runMs = h.ticks * REPLAY_DT * 1000;
        const sinceSigned = now - claim.issuedAtMs;
        if (sinceSigned + TICKET_SKEW_MS < runMs) {
          // Arithmetic: a run of N ticks cannot reach the box before it has
          // been played. This one claims to have.
          ticketRefusal = "the attempt ticket is younger than the run it carries — "
            + Math.round(runMs / 1000) + "s of play submitted "
            + Math.max(0, Math.round(sinceSigned / 1000)) + "s after the contract was signed";
        } else if (sinceSigned > runMs + TICKET_GRACE_MS) {
          // ...and the half that actually closes "sign once, play twenty runs
          // offline, submit the best as attempt 1".
          ticketRefusal = "the attempt ticket has gone cold — it was signed "
            + Math.round(sinceSigned / 60_000) + " minutes ago for a "
            + Math.round(runMs / 60_000) + " minute run. Sign the contract again and play it.";
        } else if (!this.store.consumeTicket(claim.sig, accountId, eventId, claim.attemptNo, now)) {
          ticketRefusal = "that attempt ticket has already been spent — one signature, one submission";
        } else {
          attemptNo = claim.attemptNo;
        }
      }
    }

    const row: RunRow = {
      id: runId, accountId, displayName, eventId, seed: h.seed, rulesHash: null,
      mode: h.mode, partySize: Math.max(1, Math.min(6, opts.partySize ?? 1)),
      won: c.won, floor: c.floor, timeTicks: c.ticks, kills: c.kills, level: c.level,
      ultimate: c.ultimate, bandSplits: null, deathCause: null, finalBuild: null,
      damageDealt: 0, damageTaken: 0, goldSpent: 0,
      attemptNo, private: !!opts.private, state: "claimed", rejectReason: null,
      verifiedAt: null, proofId: null, createdAt: now,
    };

    // --- can this even be verified? ---------------------------------------
    const refuse = (reason: string, state: "claimed" | "unverifiable" = "claimed"): SubmitOutcome => {
      this.store.insertRun({ ...row, state });
      if (state !== "claimed") this.store.setState(runId, state, reason);
      else if (reason) this.store.setState(runId, "claimed", reason);
      return { runId, state, queued: false, reason, attemptNo: attemptNo ?? undefined };
    };

    if (h.startKind !== "fresh") {
      return refuse("a test-mode start is never eligible for a board");
    }
    if (!this.eras.includes(h.rulesHash)) {
      // NOT rejected. The row keeps whatever stamp it earned and the player is
      // told plainly, and offered a re-run - the seed is in the artifact, and
      // for a daily the seed IS the day (2.6d).
      return refuse(
        "recorded under rules era " + h.rulesHash.slice(0, 7) + " - this build runs "
        + RULES_HASH.slice(0, 7),
        "unverifiable",
      );
    }
    if (!this.isLinked(accountId)) {
      return refuse("unsealed. The System does not put its name on an anonymous claim. LINK AN IDENTITY.");
    }
    const cool = this.cooldown.get(accountId) ?? 0;
    if (now < cool) {
      return refuse("cooling down after a rejected submission");
    }
    if (eventId && attemptNo === null) {
      return refuse(ticketRefusal
        ?? "no attempt ticket - start the contract from the game to earn CP");
    }

    // --- the queue rule (2.4 rule 2) --------------------------------------
    let priority = PRIORITY_TOP25;
    let queueable = false;
    if (eventId) {
      const best = this.store.bestVerifiedOnEvent(accountId, eventId);
      const improves = !best
        || (row.won && !best.won)
        || row.floor > best.floor
        || (row.floor === best.floor && row.won === best.won && row.timeTicks < best.timeTicks);
      if (!improves) {
        return refuse("attempt recorded - it did not beat your verified best on this contract");
      }
      queueable = true;
      priority = PRIORITY_EVENT;
    } else {
      for (const kind of BOARD_KINDS) {
        if (this.store.wouldRank(kind, row, 3)) { queueable = true; priority = PRIORITY_TOP3; break; }
      }
      if (!queueable) {
        for (const kind of BOARD_KINDS) {
          if (this.store.wouldRank(kind, row, 25)) { queueable = true; priority = PRIORITY_TOP25; break; }
        }
      }
      if (!queueable) {
        // KEEP THE FILM FOR THIS ONE. `wouldRank` is a snapshot of a board that
        // moves, so a near miss is re-offered later (see reconsiderRankRefused)
        // - which it cannot be if the proof was thrown away at the door. The
        // artifact lands inside this account's own last-10 retention and is
        // swept by the same rule as everything else.
        const nearId = "p-" + runId;
        this.store.insertRun({ ...row, state: "claimed", proofId: nearId });
        this.store.putProof({
          id: nearId, accountId, rulesHash: h.rulesHash, seed: h.seed,
          eventId, ticks: h.ticks, bytes: gzipSync(Buffer.from(raw), { level: 6 }), now,
        });
        const reason = RANK_REFUSED_REASON + " It is re-offered if the rows above it move.";
        this.store.setState(runId, "claimed", reason);
        return { runId, state: "claimed", queued: false, reason, attemptNo: attemptNo ?? undefined };
      }
    }

    // --- verify-CPU accounting (2.7.3) ------------------------------------
    const estMs = this.queue.estimateMs(h.ticks);
    const ipKey = "ip:" + ip;
    const acctKey = "acct:" + accountId;
    if (this.store.verifyMsSpent(ipKey, day) + estMs > VERIFY_MS_PER_IP_PER_DAY
      || this.store.verifyMsSpent(acctKey, day) + estMs > VERIFY_MS_PER_ACCOUNT_PER_DAY) {
      return refuse("stored, unproven - daily verification budget spent");
    }

    // --- accepted into the queue ------------------------------------------
    const proofId = "p-" + runId;
    const stored = gzipSync(Buffer.from(raw), { level: 6 });
    this.store.insertRun({ ...row, state: "claimed", proofId });
    this.store.putProof({
      id: proofId, accountId, rulesHash: h.rulesHash, seed: h.seed,
      eventId, ticks: h.ticks, bytes: stored, now,
    });
    const job: VerifyJob = {
      runId, proofId, bytes: stored, priority, ticks: h.ticks, accountId, ip,
      hasHistory: this.hasVerifiedHistory(accountId), eventSeed,
      requireFreshStart: true, enqueuedAt: now, rulesHash: h.rulesHash,
    };
    const accepted = this.queue.enqueue(job);
    if (!accepted) {
      this.deferred.push(job);
      this.store.setState(runId, "claimed", "deferred - the verify queue is saturated");
      return { runId, state: "claimed", queued: false, reason: "deferred", attemptNo: attemptNo ?? undefined };
    }
    return {
      runId, state: "verifying", queued: true,
      attemptNo: attemptNo ?? undefined,
      scoresCp: !!eventId && attemptNo === 1,
    };
  }

  // ---- the verdict -------------------------------------------------------

  /**
   * CERTIFICATION (2.5.5 / 2.6c). The verifier-derived facts are written onto
   * the row HERE, once, and never recomputed on read - which is what lets a row
   * stay informative after its proof stops being executable. Career stats,
   * mastery and CP all hang off this moment, and off nothing else: a claimed
   * row moves no career number, which is the whole point of the seal.
   */
  onVerified(job: VerifyJob, summary: import("../sim/replay").RunSummary): void {
    const now = this.now();
    const run = this.store.getRun(job.runId);
    if (!run) return;
    this.store.certify(job.runId, {
      won: summary.won, floor: summary.floor, timeTicks: summary.ticks, kills: summary.kills,
      level: summary.level, ultimate: summary.ultimate, bandSplits: summary.bandSplitTicks,
      // The traversal flags come from the REPLAY, never from the submitter: a
      // band record has to be a band the run actually walked out of.
      bandComplete: summary.bandComplete,
      deathCause: summary.death, finalBuild: summary.build,
      damageDealt: summary.damageDealt, damageTaken: summary.damageTaken,
      goldSpent: summary.goldSpent,
      // THE ERA OF THE PROOF, NOT THE ERA OF THE BOX. 2.6c requires
      // `rules_hash = H`, the hash the row was certified UNDER; passing
      // RULES_HASH stamps every row with today's era, which is invisible while
      // `eras` holds one entry and becomes a lie on the first widened deploy.
      rulesHash: job.rulesHash || RULES_HASH,
    }, now);

    // Career aggregates, on VERIFIED runs only.
    this.db?.bumpAccountStats(run.accountId, {
      won: summary.won, floor: summary.floor, kills: summary.kills,
      timeSec: Math.round(summary.ticks * REPLAY_DT),
    }, now);
    // Mastery is per-ultimate and weighted by depth, and unlike LoL's every
    // point of it is backed by a replayable proof.
    if (summary.ultimate) this.store.bumpMastery(run.accountId, summary.ultimate, summary.floor * 10, now);

    // CP: EVENTS ONLY, and only the FIRST ticketed attempt (3.2C). Your first
    // run on a seed is the one nobody can practise for, so it is the one the
    // ladder counts. Everything after it still takes the board row.
    if (run.eventId && run.attemptNo === 1 && !this.store.firstScoredRun(run.accountId, run.eventId)) {
      const evt = this.store.getEvent(run.eventId);
      const season = evt?.season ?? seasonIdFor(now);
      const entrants = Math.max(1, this.store.eventEntrants(run.eventId));
      const rank = this.store.eventRank(run.eventId, run.id);
      this.store.markScored(run.accountId, run.eventId, run.id);
      this.store.recordCp(run.accountId, season, run.eventId, cpFor(rank, entrants), run.id, now);
    }
    this.afterJob(job);
  }

  onFailed(job: VerifyJob, state: "rejected" | "unverifiable", detail: string): void {
    this.store.setState(job.runId, state, detail);
    if (state === "rejected") {
      // A rejection is told plainly and immediately, and it costs the submitter
      // time - a rejection that arrives with no explanation is how honest
      // players conclude the ladder is rigged (6 Beat 5).
      this.cooldown.set(job.accountId, this.now() + 10 * 60_000);
      const run = this.store.getRun(job.runId);
      if (run?.proofId) this.store.setState(job.runId, "rejected", detail);
    }
    this.afterJob(job);
  }

  /** Charge the measured CPU, then re-admit shed work if the backlog cleared. */
  private afterJob(job: VerifyJob): void {
    this.store.sweepVerifyBudget(dayFromMs(this.now() - 48 * 3600_000));
    this.store.sweepSpentTickets(this.now() - 48 * 3600_000);
    while (this.deferred.length > 0 && this.queue.backlogSeconds() < 60) {
      const j = this.deferred.shift()!;
      if (!this.queue.enqueue(j)) { this.deferred.unshift(j); break; }
      this.store.setState(j.runId, "claimed", "re-queued");
    }
    // A ROW REFUSED FOR RANK IS RE-ASKED, NOT CONDEMNED. `wouldRank` is
    // evaluated against the board AS IT STANDS AT SUBMIT TIME, so a run that
    // missed the top 25 by one place was permanently `claimed` with the reason
    // "it would not reach a board top 25" and never looked at again - even
    // after the rows above it were rejected, deleted by FORGET ME, or pushed
    // off by an eviction. The shed path already re-queues; this is the same
    // courtesy for the other refusal, bounded to the rows whose film is still
    // on disk.
    this.reconsiderRankRefused();
    void job;
  }

  /** Re-offer recently refused-for-rank rows whose proof is still retained.
   *  Bounded work: a handful of rows, one board query each, only when the
   *  queue is otherwise idle enough to take them. */
  private reconsiderRankRefused(limit = 8): void {
    if (this.queue.backlogSeconds() > 30) return;
    for (const row of this.store.rankRefused(limit)) {
      const proof = row.proofId ? this.store.getProof(row.proofId) : null;
      if (!proof) continue;
      const better = BOARD_KINDS.some((kind) => this.store.wouldRank(kind, row, 25));
      if (!better) continue;
      const job: VerifyJob = {
        runId: row.id, proofId: row.proofId!, bytes: proof.bytes,
        priority: PRIORITY_TOP25, ticks: row.timeTicks, accountId: row.accountId,
        // The submitting IP is not on the row, so the CPU is charged to a
        // shared re-queue subject and, as always, to the ACCOUNT - which is
        // the budget that actually bounds a flood (2.7.3).
        ip: "requeue", hasHistory: this.hasVerifiedHistory(row.accountId),
        eventSeed: undefined, requireFreshStart: true, enqueuedAt: this.now(),
        rulesHash: proof.rulesHash,
      };
      if (!this.queue.enqueue(job)) return;
      this.store.setState(row.id, "claimed", "re-queued — the board moved under it");
    }
  }

  /** Shed: stored claimed with a deferred note, re-queued when the backlog
   *  clears. NOT lost, and never a closed board (2.4 rule 4). */
  onShed(job: VerifyJob): void {
    this.store.setState(job.runId, "claimed", "deferred - verification backlog");
    this.deferred.push(job);
  }

  onSpend(job: VerifyJob, ms: number): void {
    const day = dayFromMs(this.now());
    this.store.spendVerifyMs("ip:" + job.ip, day, ms);
    this.store.spendVerifyMs("acct:" + job.accountId, day, ms);
  }

  // ---- routes ------------------------------------------------------------

  /** Returns false when the path is not ours (the caller falls through). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = url.searchParams;
    const owns = path === "/auth/anon" || path === "/runs" || path.startsWith("/runs/")
      || path.startsWith("/boards/") || path.startsWith("/bands/") || path.startsWith("/crawler/")
      || path === "/events/current" || path.startsWith("/events/") || path === "/rivals/contract";
    if (!owns) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, CORS).end(); return true; }
    const ip = this.ipOf(req);
    const now = this.now();

    // POST /auth/anon - a token the SERVER minted (2.7.2).
    if (path === "/auth/anon" && req.method === "POST") {
      if (!this.allow(ip, 4, 4)) { this.json(res, 429, { error: "slow down" }); return true; }
      this.json(res, 200, { token: this.tokens.issueAnon() });
      return true;
    }

    // GET /events/current
    if (path === "/events/current" && req.method === "GET") {
      const { daily, weekly } = this.ensureEvents(now);
      const decorate = (e: EventSpec): unknown => {
        const stored = this.store.getEvent(e.id);
        return {
          ...e, frozen: !!stored?.frozen, rulesHash: stored?.rulesHash ?? RULES_HASH,
          entrants: this.store.eventEntrants(e.id),
        };
      };
      this.json(res, 200, { season: seasonIdFor(now), daily: decorate(daily), weekly: decorate(weekly) });
      return true;
    }

    // POST /events/:id/start - the ticket. The START is observed, which is what
    // makes an attempt count honest (3.2A).
    const start = MATCH_EVENT_START.exec(path);
    if (start && req.method === "POST") {
      if (!this.allow(ip, 12, 12)) { this.json(res, 429, { error: "slow down" }); return true; }
      const token = q.get("token") ?? "";
      if (!this.tokens.isUsable(token)) { this.json(res, 401, { error: "bad token" }); return true; }
      this.ensureEvents(now);
      const evt = this.store.getEvent(start[1]);
      if (!evt) { this.json(res, 404, { error: "unknown event" }); return true; }
      if (evt.frozen) {
        this.json(res, 409, { error: "PATCH DAY. This contract is closed early. The lawyers apologize." });
        return true;
      }
      const attemptNo = this.store.nextAttempt(token, evt.id);
      this.json(res, 200, {
        eventId: evt.id, seed: evt.seed, attemptNo,
        ticket: this.tokens.issueTicket(evt.id, token, attemptNo, now),
        scoresCp: attemptNo === 1,
        rulesHash: evt.rulesHash,
        // The window is STATED rather than discovered. A ticket backs the run
        // that follows it; it is not a permanent licence to submit the best of
        // twenty offline attempts as attempt one.
        graceMs: TICKET_GRACE_MS,
      });
      return true;
    }

    // POST /runs - submit a proof.
    if (path === "/runs" && req.method === "POST") {
      if (!this.allow(ip)) { this.json(res, 429, { error: "slow down" }); return true; }
      const token = q.get("token") ?? "";
      if (!this.tokens.isUsable(token)) { this.json(res, 401, { error: "bad token" }); return true; }
      const body = await this.readBody(req, MAX_BODY);
      if (!body) { this.json(res, 413, { error: "artifact too large" }); return true; }
      const out = await this.submit(new Uint8Array(body), token, q.get("name") ?? "", ip, {
        private: q.get("private") === "1",
        partySize: Number(q.get("size") ?? 1),
      });
      if ("error" in out) { this.json(res, 400, out); return true; }
      this.json(res, 200, out);
      return true;
    }

    // POST /runs/:id/private - owner-only distribution toggle (8.1).
    const priv = MATCH_RUN_PRIVATE.exec(path);
    if (priv && req.method === "POST") {
      const token = q.get("token") ?? "";
      if (!this.tokens.isUsable(token)) { this.json(res, 401, { error: "bad token" }); return true; }
      const ok = this.store.setPrivate(priv[1], token, q.get("on") !== "0");
      this.json(res, ok ? 200 : 404, { ok });
      return true;
    }

    // GET /runs/:id - metadata, and the artifact for ghosts and replay.
    const one = MATCH_RUN.exec(path);
    if (one && req.method === "GET") {
      const run = this.store.getRun(one[1]);
      if (!run) { this.json(res, 404, { error: "not found" }); return true; }
      const token = q.get("token") ?? "";
      const owner = this.tokens.isUsable(token) && token === run.accountId;
      // A private run RANKS but is never distributed: 404 to everyone but its
      // owner, never served as a ghost, never offered as RACE THE LEADER.
      if (run.private && !owner) { this.json(res, 404, { error: "not found" }); return true; }
      if (q.get("proof") === "1") {
        // A RUN THE SERVER REFUSED IS NOT A GHOST. The proof was served with
        // no state check at all, so a challenge link built from a `claimed` or
        // `rejected` run handed a stranger a raceable rival the server had
        // explicitly declined to certify - and 2.6f's whole point is that the
        // refusal is STATED. The owner can still pull their own artifact back.
        if (run.state !== "verified" && !owner) {
          this.json(res, 409, {
            error: run.state === "rejected"
              ? "REFUSED ON VERIFICATION - the replay did not produce the claimed run, so it is not raceable"
              : "UNPROVEN - only runs the server re-executed are handed out as ghosts",
            rulesHash: run.rulesHash, playable: false,
          });
          return true;
        }
        const proof = run.proofId ? this.store.getProof(run.proofId) : null;
        if (!proof) {
          this.json(res, 410, {
            error: "the proof has aged out of retention",
            rulesHash: run.rulesHash, playable: false,
          });
          return true;
        }
        const playable = this.eras.includes(proof.rulesHash);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "cache-control": "public, max-age=86400",
          "x-dcc-rules-hash": proof.rulesHash,
          "x-dcc-playable": playable ? "1" : "0",
          ...CORS,
        });
        res.end(proof.bytes);
        return true;
      }
      // WHAT THIS ROW ACTUALLY HOLDS. The verdict screen weights its seal on
      // it (6.2), and it used to answer the question against today's daily
      // board alone - so a free-seed run taking rank 1 all-time got the plain
      // hairline and the line "It ranks nowhere, and it is still true", which
      // is false about the run that most deserved the gold.
      this.json(res, 200, { ...this.publicRun(run), boards: this.store.holdsBoards(run.id) });
      return true;
    }

    // GET /boards/:kind
    const board = MATCH_BOARD.exec(path);
    if (board && req.method === "GET") {
      const kind = board[1] as BoardKind;
      if (!(BOARD_KINDS as readonly string[]).includes(kind)) {
        this.json(res, 404, { error: "unknown board" });
        return true;
      }
      const eventParam = q.get("event");
      const eventId = eventParam === "daily" ? dailyEvent(now).id
        : eventParam === "weekly" ? weeklyEvent(now).id
          : eventParam;
      const archetype = q.get("archetype");
      const size = q.get("size") ? Number(q.get("size")) : null;
      const rows = this.store.board({
        kind, eventId: eventId ?? null, archetype, partySize: size,
        verifiedOnly: q.get("verified") === "1",
        limit: Number(q.get("limit") ?? 50),
      });
      // THE VERIFIED / UNPROVEN SPLIT BELONGS IN THE RESPONSE SHAPE, not in one
      // renderer. `entries` used to mix both in one ranked array, bounded only
      // by validateProofShape (floor 1..18, kills up to 1,000,000) - so a
      // fabricated floor-18 / one-million-kill row rode inside a payload whose
      // own subtitle says "every ranked row is a proof the server re-executed".
      // main3d's boardListHtml did the right thing with it; a share page, an
      // embed, a third party or a future mobile host would not have.
      const verified = rows.filter((r) => r.state === "verified").map((r) => this.publicRun(r));
      const unproven = rows.filter((r) => r.state !== "verified").map((r) => this.publicRun(r));
      this.json(res, 200, {
        kind, eventId: eventId ?? null, rulesEra: RULES_HASH.slice(0, 7),
        splitGate: SPLIT_GATE_ENTRIES,
        archetypeEntrants: archetype ? this.store.splitEntrants("ultimate", archetype, eventId ?? null) : null,
        // `entries` is the BOARD: proofs only, so a consumer that reads nothing
        // else cannot render a claim as a rank.
        entries: verified,
        verified,
        unproven,
        note: "entries are runs this server re-executed and certified. unproven rows were stored "
          + "exactly as a client reported them, hold no rank, and are never a result.",
      });
      return true;
    }

    // GET /bands/:n - the per-band board the splits give us for free (3.3).
    // The ORDER BY is part of the response, not a secret: at this population
    // exact ties are common, and a board that will not say how it broke one is
    // asking the reader to assume it did not.
    const band = MATCH_BAND.exec(path);
    if (band && req.method === "GET") {
      const rows = this.store.bandBoard(Number(band[1]), Number(q.get("limit") ?? 25));
      this.json(res, 200, {
        band: Number(band[1]),
        tiebreak: "split ticks, then the earliest run to be certified",
        entries: rows.map((r) => ({ ...this.publicRun(r), bandTicks: r.bandTicks })),
      });
      return true;
    }

    // GET /crawler/:id - the profile. The id may be a PUBLIC id (what a board
    // row and a share link carry) or the caller's own bearer token (how the
    // client asks for its own career). The public id is tried first, so a
    // shared profile link never has to contain a credential.
    const who = MATCH_CRAWLER.exec(path);
    if (who && req.method === "GET") {
      const accountId = this.store.accountForPublicId(who[1]) ?? who[1];
      this.json(res, 200, this.profile(accountId, now));
      return true;
    }

    // GET /rivals/contract - the asynchronous rival pairing (4.2). A sorted
    // array on one machine: no queue, no wait, no lobby.
    if (path === "/rivals/contract" && req.method === "GET") {
      const token = q.get("token") ?? "";
      if (!this.tokens.isUsable(token)) { this.json(res, 401, { error: "bad token" }); return true; }
      this.json(res, 200, this.rivalContract(token, now));
      return true;
    }

    this.json(res, 404, { error: "not found" });
    return true;
  }

  // ---- projections -------------------------------------------------------

  /**
   * The public shape of a row. Note what it always carries: the STATE and the
   * ERA. A board that silently blends rules eras is lying, and it is something
   * LoL literally cannot show you, because their all-time stats blend twelve
   * years of patches without a word.
   */
  publicRun(r: RunRow): Record<string, unknown> {
    return {
      // NEVER `accountId`. It is the bearer token: POST /runs passes it in as
      // the account id and TokenService.isUsable authenticates that exact
      // string, so one unauthenticated GET /boards/deepest used to hand out a
      // working credential for every ranked crawler on the board. The client
      // only ever needed it for the YOU / RIVAL tag on a row, and a one-way
      // derived id does that job exactly as well.
      id: r.id, name: r.displayName, publicId: publicIdFor(r.accountId), eventId: r.eventId,
      state: r.state, reason: r.rejectReason,
      rulesEra: r.rulesHash ? r.rulesHash.slice(0, 7) : null,
      playable: !!r.rulesHash && this.eras.includes(r.rulesHash) && !!r.proofId && !r.private,
      won: r.won, floor: r.floor, timeSec: Math.round(r.timeTicks * REPLAY_DT),
      ticks: r.timeTicks, kills: r.kills, level: r.level, ultimate: r.ultimate,
      partySize: r.partySize, attemptNo: r.attemptNo, private: r.private,
      // Verifier-derived and stored at certification (2.5.5), so a board row can
      // fill a scoreboard column instead of printing a dash next to a number
      // the server demonstrably knows.
      damageDealt: r.damageDealt, damageTaken: r.damageTaken, goldSpent: r.goldSpent,
      bandSplits: r.bandSplits, death: r.deathCause, build: r.finalBuild,
      verifiedAt: r.verifiedAt, at: r.createdAt,
    };
  }

  /** The profile (5.2). The histogram is the most interesting chart the game
   *  can draw: a whole career in one glance. */
  profile(accountId: string, now: number): Record<string, unknown> {
    const runs = this.store.runsByAccount(accountId, 200);
    const byFloor = new Array<number>(18).fill(0);
    for (const r of runs) if (r.floor >= 1 && r.floor <= 18) byFloor[r.floor - 1]++;
    const season = seasonIdFor(now);
    const cp = this.store.seasonCp(accountId, season);
    const entrants = this.store.seasonSize(season);
    const rank = this.store.seasonRank(season, accountId);
    const verified = runs.filter((r) => r.state === "verified");
    const bestFast = verified.filter((r) => r.won).sort((a, b) => a.timeTicks - b.timeTicks)[0] ?? null;
    return {
      publicId: publicIdFor(accountId),
      name: runs[0]?.displayName ?? null,
      seals: verified.length,
      career: this.db?.getAccountStats(accountId) ?? null,
      standing: standingFor(cp?.cp ?? 0, rank, entrants, cp?.eventsCounted ?? 0),
      season,
      deathsByFloor: byFloor,
      // THE ONE SOURCE OF TRUTH for band personal bests. The career panel used
      // to render a localStorage ledger with its own completeness rule, so the
      // profile and the band board could disagree about the same record.
      bandBests: this.store.bandBests(accountId),
      deepest: verified.reduce((m, r) => Math.max(m, r.floor), 0),
      fastestClear: bestFast ? this.publicRun(bestFast) : null,
      mastery: this.store.masteryOf(accountId),
      following: this.store.following(accountId).map(publicIdFor),
      recent: runs.slice(0, 10).map((r) => this.publicRun(r)),
    };
  }

  /**
   * CONTRACT ISSUED (4.2): the System pairs you with a crawler near your CP on
   * today seed. Computed on read from a sorted array - the nightly job the
   * design describes is not needed at this population, and a query that cannot
   * drift is better than a job that can.
   */
  rivalContract(accountId: string, now: number): Record<string, unknown> {
    const season = seasonIdFor(now);
    const mine = this.store.seasonCp(accountId, season)?.cp ?? 0;
    const ladder = this.store.seasonLadder(season, 100).filter((e) => e.accountId !== accountId);
    let rival: { accountId: string; cp: number } | null = null;
    for (const e of ladder) {
      if (!rival || Math.abs(e.cp - mine) < Math.abs(rival.cp - mine)) rival = e;
    }
    const daily = dailyEvent(now);
    const theirs = rival
      ? this.store.board({ kind: "deepest", eventId: daily.id, verifiedOnly: true, limit: 100 })
        .find((r) => r.accountId === rival.accountId) ?? null
      : null;
    return {
      eventId: daily.id, seed: daily.seed, resolvesAt: daily.closesAt,
      rival: rival
        ? { publicId: publicIdFor(rival.accountId), cp: rival.cp, name: theirs?.displayName ?? null }
        : null,
      rivalRun: theirs ? this.publicRun(theirs) : null,
      myCp: mine,
      // THE LEDGER. A rivalry with no record of what happened last time is a
      // pairing, not a rivalry - and this is the one number LoL cannot show
      // you about a specific opponent across a season.
      head: rival ? this.headToHead(accountId, rival.accountId) : null,
      // THE STAKE, stated. Nothing is taken from the loser: contract points are
      // a record of what you did, not a wager, and a ladder that confiscates
      // them turns every pairing into a reason not to play.
      stake: "the head-to-head ledger and the board row. No CP changes hands - CP is a record, not a wager.",
      pairing: "nearest season CP on today's seed, recomputed every day. No queue, no lobby, nobody has to be online.",
    };
  }

  /**
   * HEAD TO HEAD across every event both crawlers actually finished. Computed
   * on read from two indexed scans: a rivalry table would be one more thing to
   * keep in agreement with the boards, and this cannot drift because it IS the
   * boards.
   */
  headToHead(mineId: string, theirsId: string): {
    played: number; mine: number; theirs: number; drawn: number; recent: {
      eventId: string; won: boolean; mineFloor: number; theirFloor: number;
      mineTicks: number; theirTicks: number; result: "won" | "lost" | "drew";
    }[];
  } {
    const mineBy = new Map(this.store.eventBests(mineId).map((r) => [r.eventId, r]));
    const theirBy = new Map(this.store.eventBests(theirsId).map((r) => [r.eventId, r]));
    const rows: {
      eventId: string; won: boolean; mineFloor: number; theirFloor: number;
      mineTicks: number; theirTicks: number; result: "won" | "lost" | "drew";
    }[] = [];
    let mine = 0, theirs = 0, drawn = 0;
    for (const [eventId, a] of mineBy) {
      const b = theirBy.get(eventId);
      if (!b) continue; // only contested events count - a walkover is not a win
      // The board's own order, so the ledger and the ladder never disagree.
      let result: "won" | "lost" | "drew" = "drew";
      if (a.won !== b.won) result = a.won ? "won" : "lost";
      else if (a.floor !== b.floor) result = a.floor > b.floor ? "won" : "lost";
      else if (a.ticks !== b.ticks) result = a.ticks < b.ticks ? "won" : "lost";
      if (result === "won") mine++; else if (result === "lost") theirs++; else drawn++;
      rows.push({
        eventId, won: a.won, mineFloor: a.floor, theirFloor: b.floor,
        mineTicks: a.ticks, theirTicks: b.ticks, result,
      });
    }
    rows.sort((x, y) => (x.eventId < y.eventId ? 1 : -1)); // event ids are dated
    return { played: rows.length, mine, theirs, drawn, recent: rows.slice(0, 6) };
  }
}

// Route patterns, hoisted so the router does not recompile them per request.
const MATCH_EVENT_START = new RegExp("^/events/([A-Za-z0-9_-]{1,64})/start$");
const MATCH_RUN_PRIVATE = new RegExp("^/runs/([A-Za-z0-9_-]{1,64})/private$");
const MATCH_RUN = new RegExp("^/runs/([A-Za-z0-9_-]{1,64})$");
const MATCH_BOARD = new RegExp("^/boards/([a-z]+)$");
const MATCH_BAND = new RegExp("^/bands/([0-5])$");
const MATCH_CRAWLER = new RegExp("^/crawler/([A-Za-z0-9_.-]{1,80})$");
