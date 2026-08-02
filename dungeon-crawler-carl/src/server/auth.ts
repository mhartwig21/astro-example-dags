import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersistDb } from "./db";
import { sanitizeName } from "./names";
import type { TokenService } from "./tokens";

// OAuth for release (Discord + Google, code flow) on bare Node — no framework,
// no session store. The design rides the EXISTING anonymous-token account
// system (PERSISTENCE.md): signing in never creates a parallel identity world,
// it links a provider identity to the token the browser already holds, so the
// crawler you leveled anonymously is the crawler you keep. A provider identity
// recovers exactly one account — that's cross-device sign-in.
//
// Config via env (fly secrets): DISCORD_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/
// SECRET, SESSION_SECRET (state signing), PUBLIC_URL (redirect base; falls
// back to the request host). Providers without config simply don't exist —
// the client hides the buttons. Setup runbook: DEPLOY.md "OAuth".

interface Provider {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  identity: (profile: Record<string, unknown>) => { id: string; display: string } | null;
}

const STATE_TTL_MS = 10 * 60_000;

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

export class AuthService {
  private providers = new Map<string, Provider>();
  private secret: string;
  private publicUrl: string | null;

  /** Set on a successful provider callback: the account is freshly re-authed
   *  for a short window, which is what a linked account needs to delete. */
  private freshAuth = new Map<string, number>();
  /** Per-IP bucket on the delete endpoint specifically. */
  private deleteBuckets = new Map<string, { tokens: number; at: number }>();
  private tokens: TokenService | null;

  constructor(
    private db: PersistDb | null,
    env: Record<string, string | undefined> = process.env,
    tokens: TokenService | null = null,
  ) {
    this.tokens = tokens;
    // No SESSION_SECRET = states die on restart; harmless (retry the login).
    this.secret = env.SESSION_SECRET ?? randomUUID();
    this.publicUrl = env.PUBLIC_URL?.replace(/\/$/, "") ?? null;
    if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
      this.providers.set("discord", {
        authUrl: "https://discord.com/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        userUrl: "https://discord.com/api/users/@me",
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        scope: "identify",
        identity: (u) => (typeof u.id === "string"
          ? { id: u.id, display: String(u.global_name ?? u.username ?? "Crawler") }
          : null),
      });
    }
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      this.providers.set("google", {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: "openid profile",
        identity: (u) => (typeof u.sub === "string"
          ? { id: u.sub, display: String(u.name ?? "Crawler") }
          : null),
      });
    }
  }

  enabled(): string[] {
    return [...this.providers.keys()];
  }

  /** Test seam: register a fake provider (mock endpoints on localhost). */
  registerProvider(name: string, p: Provider): void {
    this.providers.set(name, p);
  }

  private base(req: IncomingMessage): string {
    if (this.publicUrl) return this.publicUrl;
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
    return `${proto}://${req.headers.host ?? "localhost"}`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private makeState(provider: string, token: string | null): string {
    const payload = b64url(JSON.stringify({ p: provider, t: token, n: randomUUID(), ts: Date.now() }));
    return `${payload}.${this.sign(payload)}`;
  }

  private readState(state: string): { p: string; t: string | null } | null {
    const [payload, sig] = state.split(".");
    if (!payload || !sig || this.sign(payload) !== sig) return null;
    try {
      const o = JSON.parse(Buffer.from(payload, "base64url").toString()) as { p: string; t: string | null; ts: number };
      if (Date.now() - o.ts > STATE_TTL_MS) return null;
      return o;
    } catch {
      return null;
    }
  }

  /** Same-origin check: a delete must come from our own page, not from a
   *  link someone clicked. Absent Origin (curl, native) is allowed - it is
   *  the CROSS-origin case a browser can be tricked into. */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      return host === req.headers.host || host === new URL(this.publicUrl ?? "http://x").host;
    } catch {
      return false;
    }
  }

  private allowDelete(req: IncomingMessage): boolean {
    const ip = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "?");
    const now = Date.now();
    const b = this.deleteBuckets.get(ip) ?? { tokens: 5, at: now };
    b.tokens = Math.min(5, b.tokens + ((now - b.at) / 60_000) * 2);
    b.at = now;
    this.deleteBuckets.set(ip, b);
    if (this.deleteBuckets.size > 2000) this.deleteBuckets.clear();
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Route /auth/* requests. Returns false when the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (!path.startsWith("/auth/")) return false;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") { json(204, {}); return true; }

    if (path === "/auth/providers") {
      json(200, { providers: this.enabled() });
      return true;
    }

    const login = path.match(/^\/auth\/login\/([a-z]+)$/);
    if (login && req.method === "GET") {
      const prov = this.providers.get(login[1]);
      if (!prov) { json(404, { error: "unknown provider" }); return true; }
      const token = url.searchParams.get("token");
      const q = new URLSearchParams({
        client_id: prov.clientId,
        redirect_uri: `${this.base(req)}/auth/callback/${login[1]}`,
        response_type: "code",
        scope: prov.scope,
        state: this.makeState(login[1], token && /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : null),
      });
      res.writeHead(302, { location: `${prov.authUrl}?${q}` });
      res.end();
      return true;
    }

    const cb = path.match(/^\/auth\/callback\/([a-z]+)$/);
    if (cb && req.method === "GET") {
      const prov = this.providers.get(cb[1]);
      const state = this.readState(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code");
      const fail = (why: string) => {
        res.writeHead(302, { location: `${this.base(req)}/iso.html#autherr=${encodeURIComponent(why)}` });
        res.end();
      };
      if (!prov || !state || state.p !== cb[1] || !code) { fail("bad state"); return true; }
      try {
        const tr = await fetch(prov.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: prov.clientId,
            client_secret: prov.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: `${this.base(req)}/auth/callback/${cb[1]}`,
          }),
        });
        if (!tr.ok) { fail("token exchange failed"); return true; }
        const tok = (await tr.json()) as { access_token?: string };
        if (!tok.access_token) { fail("no access token"); return true; }
        const ur = await fetch(prov.userUrl, { headers: { authorization: `Bearer ${tok.access_token}` } });
        if (!ur.ok) { fail("profile fetch failed"); return true; }
        const who = prov.identity((await ur.json()) as Record<string, unknown>);
        if (!who) { fail("no identity"); return true; }
        const display = sanitizeName(who.display);
        // The linking rule: a known identity RECOVERS its account (sign-in on
        // a new device); an unknown one LINKS to the browser's current token
        // (nobody loses the crawler they leveled anonymously).
        let account = this.db?.findIdentity(cb[1], who.id) ?? null;
        if (!account) {
          account = state.t ?? randomUUID();
          this.db?.linkIdentity(cb[1], who.id, account, display, Date.now());
        } else {
          this.db?.linkIdentity(cb[1], who.id, account, display, Date.now()); // refresh display
        }
        // A provider round trip just happened: that is the re-auth FORGET ME
        // requires from a linked account (COMPETITIVE.md 2.7).
        this.freshAuth.set(account, Date.now());
        const dest = new URLSearchParams({ auth: account, who: display, provider: cb[1] });
        res.writeHead(302, { location: `${this.base(req)}/iso.html#${dest}` });
        res.end();
      } catch {
        fail("provider unreachable");
      }
      return true;
    }

    if (path === "/auth/whoami" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(token) || !this.db) { json(200, { identities: [], stats: null }); return true; }
      json(200, {
        identities: this.db.identitiesOf(token),
        stats: this.db.getAccountStats(token),
      });
      return true;
    }

    // FORGET ME. Hardened BEFORE it has a verified career to erase
    // (COMPETITIVE.md 2.7): knowing the token alone used to be enough, the
    // token rode in a JSON body, there was no origin check and no confirm.
    // That was survivable while it wiped one aggregate stats row. It is not
    // survivable now that it wipes proofs, CP, board rows, mastery and
    // follows. Deletion must stay EASY AND IRREVERSIBLE for the person who
    // owns the account, and stop being a one-line request for anyone who ever
    // saw their token.
    if (path === "/auth/delete" && req.method === "POST") {
      if (!this.allowDelete(req)) { json(429, { ok: false, error: "slow down" }); return true; }
      if (!this.sameOrigin(req)) { json(403, { ok: false, error: "bad origin" }); return true; }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on("end", () => {
        try {
          const { token, nonce, names } = JSON.parse(body) as
            { token?: string; nonce?: string; names?: unknown };
          if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) { json(400, { ok: false }); return; }
          const linked = (this.db?.identitiesOf(token).length ?? 0) > 0;
          if (linked) {
            // A linked account must have signed in through its provider in the
            // last 10 minutes. Nothing else proves the PERSON is present.
            const at = this.freshAuth.get(token) ?? 0;
            if (Date.now() - at > 10 * 60_000) {
              json(401, { ok: false, error: "reauth", providers: this.enabled() });
              return;
            }
          } else if (this.tokens) {
            // Anonymous: a two-step confirm. The first call hands back a
            // short-lived nonce; only the second one deletes.
            if (!this.tokens.checkDeleteNonce(nonce, token, Date.now())) {
              json(202, { ok: false, confirm: this.tokens.issueDeleteNonce(token, Date.now()) });
              return;
            }
          }
          // Names the browser knows, so FORGET ME can reach the retired
          // name-keyed JSON boards (COMPETITIVE.md 1.2). Sanitized and capped
          // like any other player-supplied string: this deletes rows, so it is
          // bounded and never trusted as an identity.
          const extra = Array.isArray(names)
            ? names.filter((n): n is string => typeof n === "string")
              .slice(0, 5).map((n) => sanitizeName(n))
            : [];
          this.db?.deleteAccount(token, extra);
          this.freshAuth.delete(token);
          json(200, { ok: true });
        } catch {
          json(400, { ok: false });
        }
      });
      return true;
    }

    json(404, { error: "not found" });
    return true;
  }
}
