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

  /** `<eventId>.<attemptNo>.<hmac>` - one integer per account per event, no
   *  storage growth beyond a counter. */
  issueTicket(eventId: string, accountId: string, attemptNo: number): string {
    const body = eventId + "." + attemptNo;
    return body + "." + this.sign("ticket:" + eventId + ":" + accountId + ":" + attemptNo);
  }

  /** Returns the attempt number the ticket proves, or null. */
  readTicket(ticket: unknown, eventId: string, accountId: string): number | null {
    if (typeof ticket !== "string") return null;
    const parts = ticket.split(".");
    if (parts.length !== 3) return null;
    if (parts[0] !== eventId) return null;
    const attempt = Number(parts[1]);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100000) return null;
    return this.verify("ticket:" + eventId + ":" + accountId + ":" + attempt, parts[2]) ? attempt : null;
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
