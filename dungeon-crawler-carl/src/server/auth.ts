import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersistDb } from "./db";
import { sanitizeName } from "./names";

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

  constructor(private db: PersistDb | null, env: Record<string, string | undefined> = process.env) {
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

    if (path === "/auth/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on("end", () => {
        try {
          const { token } = JSON.parse(body) as { token?: string };
          if (token && /^[A-Za-z0-9_-]{8,64}$/.test(token)) this.db?.deleteAccount(token);
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
