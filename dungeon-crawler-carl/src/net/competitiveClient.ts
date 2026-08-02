/**
 * CLIENT SIDE OF THE COMPETITIVE LAYER (COMPETITIVE.md MUST-5 / 4.1 / 8).
 *
 * The host (main3d.ts) owns the SCREENS; this module owns the wire. It is the
 * only place that knows the endpoint shapes, the gzip step, the era gate on an
 * incoming proof, and where the ghost worker lives.
 *
 * Three rules encoded here rather than left to a caller to remember:
 *  - A proof is submitted COMPRESSED. The container is already tiny (a whole
 *    13-minute run is ~20-30 KB gzipped); the server gunzips behind a bound.
 *  - A downloaded proof is gated on its rules era BEFORE anything executes it.
 *    A silent desync on the client has no referee (2.6f).
 *  - Submission is a CHOICE. submitRun takes an explicit visibility, because a
 *    proof is a 60 Hz recording of everything the player did and publishing it
 *    is not something to default silently (8.1).
 */
import { encodeProof, type RunProof } from "../sim/replay";
import { RULES_HASH } from "../sim/rulesHash";
import { buildGhostTrack, type GhostReply, type GhostRequest } from "./ghostWorker";

const ANON_KEY = "dcc:anon:v1";

export interface SubmitResult {
  runId: string;
  state: string;
  queued: boolean;
  reason?: string;
  attemptNo?: number;
  scoresCp?: boolean;
  /** The seal is unreachable until this account has a provider identity. Typed,
   *  so the verdict renders a BUTTON rather than string-matching prose. */
  needsIdentity?: boolean;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return bytes; // the server accepts a raw container too
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? ("HTTP " + r.status));
  return body;
}

export class CompetitiveClient {
  constructor(private base = "") {}

  /**
   * A token the SERVER minted. A client-invented one still works for everything
   * that consumes no CPU, but it is not a rate-limiting subject, so we ask for
   * a real one once and keep it.
   */
  async anonToken(): Promise<string> {
    try {
      const cached = localStorage.getItem(ANON_KEY);
      if (cached) return cached;
    } catch { /* private mode: session-only identity */ }
    const { token } = await json<{ token: string }>(this.base + "/auth/anon", { method: "POST" });
    try { localStorage.setItem(ANON_KEY, token); } catch { /* ignore */ }
    return token;
  }

  events(): Promise<unknown> {
    return json(this.base + "/events/current");
  }

  /** Start a contract. The ticket is what makes the attempt count honest, and
   *  the START being observed is what closes practise-offline-then-submit. */
  startEvent(eventId: string, token: string): Promise<{
    eventId: string; seed: number; attemptNo: number; ticket: string; scoresCp: boolean;
    rulesHash: string;
    /** Does this account have a provider identity? CP and the seal both need
     *  one, and the honest place to say so is the DOOR (6.2 Beat 5). */
    linked: boolean;
    unlinkedReason: string | null;
  }> {
    return json(this.base + "/events/" + encodeURIComponent(eventId) + "/start?token=" + encodeURIComponent(token), {
      method: "POST",
    });
  }

  board(kind: string, opts: {
    event?: string; archetype?: string; size?: number; verified?: boolean; limit?: number;
  } = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (opts.event) q.set("event", opts.event);
    if (opts.archetype) q.set("archetype", opts.archetype);
    if (opts.size) q.set("size", String(opts.size));
    if (opts.verified) q.set("verified", "1");
    if (opts.limit) q.set("limit", String(opts.limit));
    return json(this.base + "/boards/" + encodeURIComponent(kind) + "?" + q);
  }

  bandBoard(band: number, limit = 25): Promise<unknown> {
    return json(this.base + "/bands/" + band + "?limit=" + limit);
  }

  /**
   * SOMEBODY ELSE'S CAREER, BY THE ONE-WAY PUBLIC ID a board row carries.
   *
   * This used to be the only profile call, and every caller in the host passed
   * its own BEARER TOKEN as the path segment, because the server fell back to
   * treating an unresolved segment as an account id. That fallback was a
   * confirmation oracle for a leaked token (blocker 10); it is gone, and so is
   * the ambiguity here - a credential travels as `?token=`, never as a path.
   */
  profile(publicId: string): Promise<unknown> {
    return json(this.base + "/crawler/" + encodeURIComponent(publicId));
  }

  /** MY career. The token is presented AS a token, where `isUsable` decides. */
  myProfile(token: string): Promise<unknown> {
    return json(this.base + "/crawler/me?token=" + encodeURIComponent(token));
  }

  rivalContract(token: string): Promise<unknown> {
    return json(this.base + "/rivals/contract?token=" + encodeURIComponent(token));
  }

  run(runId: string, token?: string): Promise<unknown> {
    const q = token ? "?token=" + encodeURIComponent(token) : "";
    return json(this.base + "/runs/" + encodeURIComponent(runId) + q);
  }

  /**
   * Submit a run. `visibility` is explicit and has no default on purpose: the
   * disclosure card (8.1) has three buttons, and this function is what two of
   * them call.
   */
  async submitRun(
    proof: RunProof, token: string, name: string,
    visibility: "public" | "private",
  ): Promise<SubmitResult> {
    const body = await gzip(encodeProof(proof));
    const q = new URLSearchParams({ token, name });
    if (visibility === "private") q.set("private", "1");
    // NO `size`. Party size used to ride the query string onto a proof-verified
    // row and print as "party of N" beside the gold seal, unverified by
    // anything (COMPETITIVE.md 7.4 makes it a BOARD AXIS). The server no longer
    // reads it; sending it would only be a lie the server ignores.
    return json<SubmitResult>(this.base + "/runs?" + q, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: body as BodyInit,
    });
  }

  /** Toggle distribution on your own run. Verification and rank are unaffected. */
  setPrivate(runId: string, token: string, on: boolean): Promise<{ ok: boolean }> {
    return json(this.base + "/runs/" + encodeURIComponent(runId) + "/private?token="
      + encodeURIComponent(token) + "&on=" + (on ? "1" : "0"), { method: "POST" });
  }

  /**
   * Download a proof for WATCH or RACE. Returns the era verdict alongside the
   * bytes so the caller can render the explicit refusal state
   * ("RECORDED UNDER RULES ERA 5 - NOT PLAYABLE ON ERA 8") rather than a
   * silently disabled button.
   */
  async proof(runId: string, token?: string): Promise<{
    bytes: Uint8Array | null; rulesEra: string | null; playable: boolean; reason?: string;
  }> {
    const q = new URLSearchParams({ proof: "1" });
    if (token) q.set("token", token);
    const r = await fetch(this.base + "/runs/" + encodeURIComponent(runId) + "?" + q);
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string; rulesHash?: string };
      return {
        bytes: null,
        rulesEra: body.rulesHash ? body.rulesHash.slice(0, 7) : null,
        playable: false,
        reason: body.error ?? ("HTTP " + r.status),
      };
    }
    const hash = r.headers.get("x-dcc-rules-hash") ?? "";
    const bytes = new Uint8Array(await r.arrayBuffer());
    const playable = hash === RULES_HASH;
    return {
      bytes, rulesEra: hash.slice(0, 7) || null, playable,
      reason: playable ? undefined
        : "RECORDED UNDER RULES ERA " + hash.slice(0, 7) + " - NOT PLAYABLE ON ERA " + RULES_HASH.slice(0, 7),
    };
  }
}

/**
 * Precompute a ghost track in a worker. Falls back to the main thread only if
 * the platform has no module workers - the fallback is a stall, not a desync,
 * which is the right way round.
 */
export function precomputeGhost(req: GhostRequest): Promise<GhostReply> {
  const W = (globalThis as { Worker?: typeof Worker }).Worker;
  if (!W) return Promise.resolve(buildGhostTrack(req));
  return new Promise<GhostReply>((resolve) => {
    let w: Worker;
    try {
      w = new W(new URL("./ghostWorker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(buildGhostTrack(req));
      return;
    }
    w.onmessage = (e: MessageEvent<GhostReply>): void => { resolve(e.data); w.terminate(); };
    w.onerror = (): void => { resolve(buildGhostTrack(req)); w.terminate(); };
    w.postMessage({ ...req, eras: req.eras ?? [RULES_HASH] });
  });
}
