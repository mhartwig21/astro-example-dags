/**
 * SERVER-ISSUED TOKENS (COMPETITIVE.md 2.7.2 / 3.2A).
 *
 * The hole in the obvious answer: "a per-account bucket" is useless when AN
 * ACCOUNT IS FREE. auth.ts accepts any client-supplied string matching
 * /^[A-Za-z0-9_-]{8,64}$/ as an account token - no server issuance, no secret -
 * and db.ts materializes the account on first use. A fresh token per submission
 * defeats a per-account bucket completely, and because event entries are
 * verification-mandatory, each free token PURCHASES CPU. That is not a
 * rate-limit leak, it is a denial-of-ladder.
 *
 * The fix is one HMAC per request and no session table: an anonymous token is
 * `<random>.<hmac>`, and anything that does not verify is refused. Existing
 * client-invented tokens are grandfathered as claimed-only until they link a
 * provider, which is also the migration path.
 *
 * The same one-line mechanism issues EVENT TICKETS, which is what makes an
 * attempt count honest: the START is observed rather than the finish, so
 * "play offline, retry until it is good, submit the winner as attempt 1" stops
 * working. A player can still practise the day seed entirely offline; they
 * simply cannot earn CP for it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const LEGACY_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * How much WALL CLOCK a ticketed attempt may spend beyond its own run length
 * before the ticket stops backing an attempt-1 CP claim.
 *
 * The lower bound is arithmetic: a run of N ticks cannot be submitted sooner
 * than `N * dt` after the contract was signed, because that is how long it
 * takes to play. The upper bound is the one that actually closes the dodge -
 * without it, "sign once, play twenty runs offline, submit the best" fits
 * inside an unbounded window and arrives as attempt 1. Fifteen minutes is
 * generous enough for the safe room, the menu and an alt-tab, and small
 * enough that the window holds roughly one run rather than an afternoon of
 * them. A ticket that falls outside it is not a rejection - the row is stored,
 * unproven, with the reason printed, and the contract can be signed again.
 */
export const TICKET_GRACE_MS = 15 * 60_000;
/** Slack on the lower bound, for clock skew between the box and the browser. */
export const TICKET_SKEW_MS = 5_000;

export interface TicketClaim {
  attemptNo: number;
  issuedAtMs: number;
  /** The signature. Single-use is enforced against THIS, not against the
   *  attempt number, so a re-issued ticket for the same attempt is a different
   *  key and a replayed one is the same key. */
  sig: string;
}

const TICKET_PAYLOAD = (eventId: string, accountId: string, attemptNo: number, issued: number): string =>
  "ticket:" + eventId + ":" + accountId + ":" + attemptNo + ":" + issued;

export class TokenService {
  private secret: string;

  constructor(secret?: string) {
    // No SESSION_SECRET means tokens die on restart. Harmless: the client asks
    // for a new one and nothing but rate-limit continuity is lost.
    this.secret = secret ?? randomBytes(32).toString("hex");
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private verify(payload: string, sig: string): boolean {
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** POST /auth/anon: a token the SERVER minted, so a per-token bucket means
   *  something. No session table, no storage, one HMAC per request. */
  issueAnon(): string {
    const id = randomBytes(12).toString("base64url");
    return id + "." + this.sign("anon:" + id);
  }

  /** True for a token this server issued. */
  isServerIssued(token: string): boolean {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return false;
    const id = token.slice(0, dot);
    return this.verify("anon:" + id, token.slice(dot + 1));
  }

  /** Anything usable as an account id at all - server-issued or grandfathered.
   *  Grandfathered tokens keep working for everything that consumes no CPU. */
  isUsable(token: unknown): token is string {
    return typeof token === "string" && (LEGACY_TOKEN.test(token) || this.isServerIssued(token));
  }

  /**
   * `<eventId>.<attemptNo>.<issuedAtSec>.<hmac>` - one integer per account per
   * event, no storage growth beyond a counter and a short-lived spent list.
   *
   * THE TIMESTAMP IS NOT DECORATION, IT IS THE HALF OF 3.2A THAT WAS MISSING.
   * The ticket used to sign `eventId:accountId:attemptNo` and nothing else, so
   * it was a permanent, replayable bearer credential for "attempt 1": call
   * /start once, keep ticket #1, play twenty runs entirely offline, submit the
   * best one, and it arrived as `attempt 1, scoresCp: true` - the exact dodge
   * the ticket is documented as closing. A stamped ticket lets the server
   * assert what it could not before: THE RUN HAPPENED INSIDE THE WINDOW THE
   * SIGNATURE OPENED (see TICKET_GRACE_MS).
   */
  issueTicket(eventId: string, accountId: string, attemptNo: number, nowMs: number): string {
    const issued = Math.floor(nowMs / 1000);
    const body = eventId + "." + attemptNo + "." + issued;
    return body + "." + this.sign(TICKET_PAYLOAD(eventId, accountId, attemptNo, issued));
  }

  /** What the ticket proves: the attempt number, when it was signed, and the
   *  signature itself, which is the single-use key (see `consumeTicket`). */
  readTicket(ticket: unknown, eventId: string, accountId: string): TicketClaim | null {
    if (typeof ticket !== "string") return null;
    const parts = ticket.split(".");
    if (parts.length !== 4) return null;
    if (parts[0] !== eventId) return null;
    const attemptNo = Number(parts[1]);
    const issuedAt = Number(parts[2]);
    if (!Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > 100000) return null;
    if (!Number.isInteger(issuedAt) || issuedAt < 0) return null;
    if (!this.verify(TICKET_PAYLOAD(eventId, accountId, attemptNo, issuedAt), parts[3])) return null;
    return { attemptNo, issuedAtMs: issuedAt * 1000, sig: parts[3] };
  }

  /** Two-step confirm for FORGET ME on an anonymous account: the delete stops
   *  being a one-line request for anyone who ever saw the token. */
  issueDeleteNonce(accountId: string, nowMs: number): string {
    const stamp = Math.floor(nowMs / 1000);
    return stamp + "." + this.sign("delete:" + accountId + ":" + stamp);
  }

  checkDeleteNonce(nonce: unknown, accountId: string, nowMs: number, ttlSec = 300): boolean {
    if (typeof nonce !== "string") return false;
    const [stampStr, sig] = nonce.split(".");
    const stamp = Number(stampStr);
    if (!Number.isInteger(stamp)) return false;
    if (Math.abs(Math.floor(nowMs / 1000) - stamp) > ttlSec) return false;
    return !!sig && this.verify("delete:" + accountId + ":" + stamp, sig);
  }
}
