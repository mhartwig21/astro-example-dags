import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createGame, addPlayer, applySavedPlayer, buildFloor, isCrawlerSkin, step, chooseReward, chooseUpgrade, buyCatalogItem, sellItem, sellAllItems, claimAchievementLootBox, setReady, equipFromInventory, slotAbility, setUltimate, type SavedProgress } from "../sim/game";
import { ABILITY_INFO, type AbilityId } from "../sim/abilities";
import {
  serialize, serializeDynamic, serializeFor, serializeForDynamic, rivalWorldKey,
  deserialize, SNAPSHOT_VERSION,
} from "../sim/snapshot";
import { toSaveData } from "../persist/save";
import { Leaderboard } from "./leaderboard";
import { openDb, type PersistDb } from "./db";
import { Metrics } from "./metrics";
import { NO_INTENT, type GameState, type Intent, type PartyIntents, type Player, type Vec2 } from "../sim/types";

// Authoritative multiplayer server (DESIGN.md milestone). One deterministic sim
// per party instance; clients send intents + choices, the server ticks the sim at
// a fixed rate and broadcasts snapshots + transient events. The sim module is the
// exact same code the offline browser host runs — no game logic lives here.
//
// Protocol (JSON messages):
//   client -> server:
//     { t: "join", code, name, token?, rivals?, roam? } join/create a party;
//       token is the account id from a previous welcome (saves key off it)
//     { t: "intent", intent: Intent }                  input for upcoming ticks
//     { t: "choose", kind: "upgrade"|"reward", idx }   pick a draft card
//     { t: "buy", id: string }                         System Shop purchase (catalog id)
//     { t: "sell", idx: number }                       sell a bag item back
//     { t: "sellAll" }                                 liquidate the whole bag
//     { t: "claimAchievement", id: string }             open an earned achievement's loot box
//     { t: "ready" }                                   safe-room ready-up
//   server -> client:
//     { t: "welcome", playerId, token, snapshot }      join accepted (full state;
//       keep the token — it is the account id saves key off)
//     { t: "snap", tick, full?, snapshot }             state (interval below).
//         full=true carries map + fog (join/floor change/doors unlocking);
//         otherwise DYNAMIC — no map/fog, the client keeps its cached world
//         and reveals fog locally (see snapshot.ts). Halves the payload.
//     { t: "events", events, announcements, hits }     this tick's transients

export const TICK_HZ = 30;
export const SNAPSHOT_EVERY = 2; // full snapshot every N ticks (15/s)
export const CHECKPOINT_EVERY = 60 * TICK_HZ; // periodic save while active (~60s)
// ws heartbeat: bounds how long a connection that never sends a close frame
// (a hard network drop) can linger before its seat frees up. Long enough to
// be cheap over a month-long idle Roam party, short enough to reasonably
// bound a genuinely dead connection.
export const HEARTBEAT_INTERVAL_MS = 20_000;

// Abuse guards for an internet-facing deployment. Generous for friendly play,
// tight enough that a hostile client can't balloon memory or the tick budget.
export const MAX_PARTY_SIZE = 6;
// Roam campaigns seat a bigger band: month-long, drop-in/drop-out, and rarely
// all online at once. Wire cost is covered by the dynamic-snapshot diet
// (~half payload); parked members cost nothing between sessions.
export const MAX_PARTY_SIZE_ROAM = 10;
export const MAX_RIVALS = 4; // the competitive race seats exactly four contracts
export const MAX_INSTANCES = 200;
export const MAX_WS_PAYLOAD = 16 * 1024; // bytes; intents/choices are tiny
export const MAX_CODE_LEN = 32;
export const MAX_NAME_LEN = 24;

/** Coerce a client-supplied number to a finite value in [-limit, limit]. */
function num(v: unknown, limit: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-limit, Math.min(limit, n));
}

function vec(v: unknown): Vec2 {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o.x, 1e3), y: num(o.y, 1e3) };
}

/** Never trust the wire: rebuild the intent from validated primitives. */
export function sanitizeIntent(raw: unknown): Intent {
  const o = (raw ?? {}) as Record<string, unknown>;
  const cast = Array.isArray(o.cast) ? o.cast.slice(0, 5).map((c) => c === true) : undefined;
  return {
    move: vec(o.move),
    attack: o.attack === true,
    aim: o.aim === undefined ? undefined : vec(o.aim),
    useStairs: o.useStairs === true,
    flask: o.flask === true,
    dash: o.dash === true,
    bolt: o.bolt === true,
    nova: o.nova === true,
    ping: o.ping === undefined ? undefined : vec(o.ping),
    cast,
  };
}

interface Client {
  ws: WebSocket;
  playerId: number;
  worldKey?: string; // rivals: the world this client last got in FULL
  accountId: string;
  // False only when this account is already seated by another live connection
  // (second tab): the extra seat plays as a guest and never writes the save.
  bound: boolean;
  joinedAt: number; // wall clock — session_end reports the session length
  // Heartbeat (defense in depth alongside the `held` readyState check above):
  // true whenever a pong has arrived since the last ping. A connection that
  // never sends a proper close frame at all (a hard network drop, not just a
  // slow one) would otherwise linger in inst.clients indefinitely.
  isAlive: boolean;
}

interface Instance {
  code: string;
  state: GameState;
  clients: Client[];
  intents: PartyIntents;
  tick: number;
  lastFloor: number; // floor transitions trigger a checkpoint
  // Player ids seated by any connection since this instance was created. A
  // member rejoining a LIVE instance keeps their in-sim character (which may
  // have progressed past the save); on a regenerated instance the seat is
  // fresh, so the saved progression is applied instead.
  seated: Set<number>;
  timer: NodeJS.Timeout;
  lastStatus: string; // playing -> won/dead edge fires the run_end event
  worldKey: string; // co-op: the world last broadcast in FULL ("" = never)
  // Per-player fingerprints of the SLOW block (equipment/inventory/abilities…)
  // — serializeDynamic omits it while unchanged; see snapshot.ts cold split.
  coldCache: Map<number, string>;
}

/** Accept a well-formed client token; anything else gets a fresh identity. */
function validToken(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** What a crawler IS right now, for the balance record: the build (slots +
 *  ultimate + gear), the power numbers, and the run stats. Small on purpose —
 *  one row per floor per crawler must stay cheap forever. */
function buildSummary(p: Player): Record<string, unknown> {
  return {
    name: p.name,
    level: p.level,
    slots: p.abilities.slots,
    ultimate: p.abilities.ultimate,
    ranks: Object.values(p.abilities.ranks).reduce((a, b) => a + b, 0),
    weapon: p.equipment.weapon?.name ?? null,
    maxHp: p.maxHp,
    armor: p.armor,
    attackPower: p.attackPower,
    spellPower: p.spellPower,
    crit: +p.critChance.toFixed(3),
    kills: p.kills,
    damageDealt: Math.round(p.damageDealt),
    damageTaken: Math.round(p.damageTaken),
    gold: p.gold,
    sponsors: p.sponsors,
    alive: p.alive,
  };
}

/** Deterministic seed from an invite code (djb2), so a party code IS the dungeon. */
export function seedFromCode(code: string): number {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = (Math.imul(h, 33) ^ code.charCodeAt(i)) >>> 0;
  return h;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
};

// Worth gzipping on the wire: text plus GLB (raw geometry shrinks ~60%).
// PNG/OGG/MP3 are internally compressed already — recompressing wastes CPU.
const COMPRESSIBLE = new Set([".glb", ".js", ".css", ".html", ".json", ".svg", ".txt", ".ttf", ".wav"]);

export class GameServer {
  private http: HttpServer;
  private wss: WebSocketServer;
  private instances = new Map<string, Instance>();
  private staticDir: string | null;
  readonly leaderboard: Leaderboard;
  readonly db: PersistDb | null;
  // Capacity telemetry for /health: EMA + max of per-instance tick cost.
  private tickMsEma = 0;
  private tickMsMax = 0;
  private startedAt = Date.now();
  // Prometheus registry behind /metrics (Fly scrapes it into Grafana).
  readonly metrics = new Metrics();
  // ws heartbeat sweep (defense in depth for the `held` readyState check in
  // onConnection — see HEARTBEAT_INTERVAL_MS). Configurable so tests don't
  // wait 20 real seconds for a zombie connection to get reaped.
  private heartbeatTimer: NodeJS.Timeout;

  /**
   * One process serves everything: HTTP (built client from `staticDir` + a
   * /health endpoint) and the game WebSocket on the same port. Plain Node —
   * no platform-specific APIs, so the container runs anywhere (Fly, GCP, a VPS).
   */
  constructor(
    port: number, staticDir?: string, leaderboardFile?: string, dbFile?: string,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  ) {
    this.staticDir = staticDir && existsSync(staticDir) ? resolve(staticDir) : null;
    this.leaderboard = new Leaderboard(leaderboardFile);
    // Account + save persistence (PERSISTENCE.md P1). No dbFile (tests, bare
    // dev runs) means no persistence — everything else behaves as before.
    this.db = dbFile ? openDb(dbFile) : null;
    this.db?.sweepExpired(Date.now());
    this.http = createServer((req, res) => this.onRequest(req, res));
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_WS_PAYLOAD });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.http.listen(port);
    this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), heartbeatIntervalMs);
    // Gauges are read lazily at scrape time — zero cost between scrapes.
    this.metrics.gauge("dcc_instances", () => this.instances.size);
    this.metrics.gauge("dcc_players_connected", () => {
      let n = 0;
      for (const inst of this.instances.values()) n += inst.clients.length;
      return n;
    });
    this.metrics.gauge("dcc_tick_ms_ema", () => +this.tickMsEma.toFixed(3));
    this.metrics.gauge("dcc_tick_ms_max", () => +this.tickMsMax.toFixed(1));
    this.metrics.gauge("dcc_rss_bytes", () => process.memoryUsage().rss);
    this.metrics.gauge("dcc_uptime_seconds", () => Math.round((Date.now() - this.startedAt) / 1000));
  }

  private onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = req.url ?? "/";
    if (url.split("?")[0] === "/leaderboard") {
      this.onLeaderboard(req, res);
      return;
    }
    if (url === "/metrics") {
      // Prometheus exposition — Fly scrapes this (fly.toml [metrics]) into
      // the managed Grafana at fly-metrics.net.
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(this.metrics.render());
      return;
    }
    if (url === "/health") {
      // Capacity telemetry: budget per tick at 30Hz is 33ms ACROSS ALL
      // instances (one Node thread). tickMsEma is per-instance cost; total
      // thread load ~= tickMsEma * instances * 30 / 1000.
      let players = 0;
      for (const inst of this.instances.values()) players += inst.clients.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        instances: this.instances.size,
        players,
        tickMsEma: +this.tickMsEma.toFixed(2),
        tickMsMax: +this.tickMsMax.toFixed(1),
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
        uptimeMin: Math.round((Date.now() - this.startedAt) / 60000),
      }));
      return;
    }
    if (!this.staticDir) {
      res.writeHead(404).end("game server (no static bundle)");
      return;
    }
    // Static file serving with path-traversal protection.
    const clean = normalize(decodeURIComponent(url.split("?")[0])).replace(/^([/\\])+/, "");
    let file = resolve(join(this.staticDir, clean || "index.html"));
    if (!file.startsWith(this.staticDir)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    // Cache policy: we deploy many times a day, and a browser mixing old HTML
    // with new hashed chunks (or vice versa) renders a dungeon that doesn't
    // match the sim. HTML must always revalidate; Vite's content-hashed bundles
    // are immutable. Assets (models/audio/icons/fonts) are the load-time
    // budget — ~90MB across 200+ files — so they get a real TTL plus an ETag:
    // within a day a repeat visit costs ZERO asset requests, after that each
    // file revalidates to a 304 (no re-download) unless it actually changed.
    const ext = extname(file);
    const st = statSync(file);
    const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file);
    const assetish = /^(assets|audio|icons|fonts)[/\\]/.test(clean);
    const cache = ext === ".html"
      ? "no-cache"
      : hashed
        ? "public, max-age=31536000, immutable"
        : assetish
          ? "public, max-age=86400, stale-while-revalidate=604800"
          : "public, max-age=300";
    // Weak ETag from size+mtime — cheap, and correct for whole-file replaces.
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "cache-control": cache,
      etag,
      vary: "accept-encoding",
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers["content-type"] = MIME[ext] ?? "application/octet-stream";
    // On-the-fly gzip for compressible types. GLBs are mostly raw geometry
    // buffers and shrink ~60%; PNGs/OGGs are already compressed and skipped.
    // Streaming (no buffering) keeps memory flat on the single Fly machine.
    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    if (acceptsGzip && COMPRESSIBLE.has(ext)) {
      headers["content-encoding"] = "gzip";
      res.writeHead(200, headers);
      createReadStream(file).pipe(createGzip({ level: 6 })).pipe(res);
      return;
    }
    headers["content-length"] = String(st.size);
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  }

  /**
   * Daily Crawl board: GET /leaderboard?day=YYYY-MM-DD (today if omitted),
   * POST /leaderboard {day, name, floor, won, timeSec, kills}. CORS is open —
   * the board is public data, and the Vite dev client lives on another port.
   */
  private onLeaderboard(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method === "GET") {
      const day = new URL(req.url ?? "/", "http://x").searchParams.get("day")
        ?? new Date().toISOString().slice(0, 10);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...cors });
      res.end(JSON.stringify({ day, entries: this.leaderboard.get(day).slice(0, 100) }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      let overflow = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) { overflow = true; req.destroy(); }
      });
      req.on("end", () => {
        if (overflow) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, cors).end();
          return;
        }
        const rank = this.leaderboard.submit(String(msg.day ?? ""), msg, Date.now());
        res.writeHead(rank === null ? 400 : 200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify(rank === null ? { ok: false } : { ok: true, rank }));
      });
      return;
    }
    res.writeHead(405, cors).end();
  }

  get port(): number {
    return (this.http.address() as { port: number }).port;
  }

  /** Resolves when the server is listening (useful for tests). */
  ready(): Promise<void> {
    return new Promise((resolve) => {
      if (this.http.listening) resolve();
      else this.http.on("listening", resolve);
    });
  }

  /**
   * Standard ws heartbeat: a connection that didn't pong since the last ping
   * gets terminated — this is what bounds a hard network drop (no close frame
   * ever sent) instead of leaking the seat/instance indefinitely. terminate()
   * fires the normal close handler synchronously (ws library semantics), so
   * checkpoint/session_end/cleanup all still run through the one code path;
   * nothing here duplicates that logic.
   */
  private sweepHeartbeat(): void {
    for (const inst of this.instances.values()) {
      for (const c of inst.clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        if (!c.isAlive) { c.ws.terminate(); continue; }
        c.isAlive = false;
        c.ws.ping();
      }
    }
  }

  close(): void {
    // Flush every live run before the process goes away — this is what makes
    // a deploy restart survivable (SIGINT handler below). Untrack instances
    // BEFORE terminating sockets: each terminate fires a close handler that
    // must not re-checkpoint an already-flushed instance against a closed DB.
    clearInterval(this.heartbeatTimer);
    for (const inst of this.instances.values()) {
      this.checkpoint(inst);
      clearInterval(inst.timer);
    }
    this.instances.clear();
    this.leaderboard.flush();
    this.db?.close();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.http.close();
  }

  private onConnection(ws: WebSocket): void {
    let joined: { inst: Instance; playerId: number } | null = null;

    ws.on("message", (raw) => {
      this.metrics.count("dcc_ws_messages_in_total");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // ignore malformed frames
      }

      if (msg.t === "join" && typeof msg.code === "string" && typeof msg.name === "string" && !joined) {
        const code = msg.code.slice(0, MAX_CODE_LEN);
        const name = (msg.name.slice(0, MAX_NAME_LEN).trim() || "Crawler");
        if (!this.instances.has(code) && this.instances.size >= MAX_INSTANCES) {
          ws.send(JSON.stringify({ t: "error", reason: "server full" }));
          ws.close();
          return;
        }
        // Identity: an anonymous bearer token keys the account's saves. The
        // server mints one for tokenless (or malformed) joins and echoes it
        // back in the welcome; the client keeps it for next time.
        const token = validToken(msg.token) ?? randomUUID();
        const now = Date.now();
        this.db?.touchAccount(token, name, now);
        // RIVALS/ROAM: the first joiner's flags decide the instance's shape.
        const inst = this.getOrCreateInstance(code, msg.rivals === true, msg.roam === true);
        // `held` must reflect LIVE sockets only — a client whose socket already
        // closed/is closing, but whose "close" event hasn't fired here yet
        // (network/proxy propagation lag — observed 3-10s in production), would
        // otherwise read as a live second tab and shunt a fast reconnect into a
        // disposable guest seat instead of reclaiming its own character. The
        // stale entry is left in inst.clients untouched — its own close handler
        // still runs normally, later, exactly as before; only this computed set
        // ignores it.
        const held = new Set(
          inst.clients.filter((c) => c.ws.readyState === WebSocket.OPEN).map((c) => c.playerId),
        );
        const member = this.db?.getMember(code, token) ?? null;
        let player: (typeof inst.state.players)[number] | undefined;
        let bound = true;
        if (member) {
          const own = inst.state.players.find((p) => p.id === member.playerId);
          if (own && held.has(own.id)) bound = false; // same account, second tab: guest seat
          else if (own) player = own; // their seat, live or regenerated — theirs to reclaim
        }
        if (!player) {
          // Drop-in: never seat someone in a character another account owns —
          // on a RESTORED world the idle seats are members' live characters,
          // parked until they return. The pre-made players[0] seat still goes
          // to the first unclaimed joiner.
          const owned = new Set<number>();
          if (this.db) {
            for (const m of this.db.memberSeats(code)) if (m.accountId !== token) owned.add(m.playerId);
          }
          const seatless = inst.state.players.filter((p) => !held.has(p.id) && !owned.has(p.id));
          const cap = inst.state.mode === "rivals" ? MAX_RIVALS
            : inst.state.runKind === "roam" ? MAX_PARTY_SIZE_ROAM
            : MAX_PARTY_SIZE;
          if (!seatless[0] && inst.state.players.length >= cap) {
            ws.send(JSON.stringify({ t: "error", reason: "party full" }));
            ws.close();
            return;
          }
          player = seatless[0] ?? addPlayer(inst.state, name);
        }
        // A member returning to a REGENERATED instance finds a fresh sim seat:
        // reload their character from the save. On a live instance the in-sim
        // character has kept playing (or idling) past the save — keep it.
        if (member && bound && !inst.seated.has(player.id)) {
          try {
            applySavedPlayer(player, JSON.parse(member.saveJson) as SavedProgress);
            // A checkpoint can catch a crawler downed (hp 0). Nobody reloads
            // into a corpse in a fresh world — the System pities them a sliver.
            if (player.hp <= 0) player.hp = 1;
          } catch {
            // Corrupt/incompatible save: the crawler restarts, the party doesn't crash.
          }
        }
        inst.seated.add(player.id);
        player.name = name;
        // Campfire look: cosmetic, so the joiner's current pick always wins
        // (like the name). Invalid/absent values leave the seat as it was.
        if (isCrawlerSkin(msg.skin)) player.skin = msg.skin;
        const client: Client = { ws, playerId: player.id, accountId: token, bound, joinedAt: now, isAlive: true };
        ws.on("pong", () => { client.isAlive = true; });
        // The welcome below is a FULL snapshot; recurring snaps can stay dynamic.
        if (inst.state.mode === "rivals") client.worldKey = rivalWorldKey(inst.state, player.id);
        inst.clients.push(client);
        if (bound && this.db) {
          this.db.upsertMember(code, token, player.id, JSON.stringify(toSaveData(inst.state, player)), now);
        }
        joined = { inst, playerId: player.id };
        this.metrics.count("dcc_joins_total");
        this.db?.logEvent("session_start", code, token, {
          name, mode: inst.state.mode, runKind: inst.state.runKind,
          floor: inst.state.floor, partySize: inst.clients.length,
          returning: !!member,
        }, now);
        ws.send(JSON.stringify({
          t: "welcome", playerId: player.id, token,
          snapshot: inst.state.mode === "rivals" ? serializeFor(inst.state, player.id) : serialize(inst.state),
        }));
        // Joining can announce too (drop-in lines, the restore-fallback
        // "renovated" notice) — flush before the next tick clears them.
        this.flushTransients(inst);
        return;
      }

      if (!joined) return; // everything below requires a seat
      const { inst, playerId } = joined;
      switch (msg.t) {
        case "intent":
          inst.intents[playerId] = sanitizeIntent(msg.intent);
          break;
        case "choose":
          if (msg.kind === "upgrade") chooseUpgrade(inst.state, playerId, Number(msg.idx));
          else chooseReward(inst.state, playerId, Number(msg.idx));
          break;
        case "buy":
          buyCatalogItem(inst.state, playerId, String(msg.id));
          break;
        case "sell":
          sellItem(inst.state, playerId, Number(msg.idx));
          break;
        case "sellAll":
          sellAllItems(inst.state, playerId);
          break;
        case "claimAchievement":
          claimAchievementLootBox(inst.state, playerId, String(msg.id));
          break;
        case "ready":
          setReady(inst.state, playerId);
          break;
        case "equip":
          equipFromInventory(inst.state, playerId, Number(msg.idx));
          break;
        case "slot": {
          // Safe-room loadout change (the sim re-validates the gate + tiers).
          const ability = typeof msg.ability === "string" && msg.ability in ABILITY_INFO
            ? (msg.ability as AbilityId) : null;
          if (msg.slot === "ult" && ability) setUltimate(inst.state, playerId, ability);
          else if (msg.slot === "unult") setUltimate(inst.state, playerId, null);
          else if (msg.slot === "bench" && ability) {
            const p = inst.state.players.find((pl) => pl.id === playerId);
            const idx = p ? p.abilities.slots.indexOf(ability) : -1;
            if (idx >= 0) slotAbility(inst.state, playerId, idx, null);
          } else if (ability) {
            slotAbility(inst.state, playerId, Number(msg.slot), ability);
          }
          break;
        }
      }
      // Actions above can announce (purchases, unlocks, band transitions on
      // descend). The next tick clears those channels before broadcasting, so
      // flush them to the party now.
      this.flushTransients(inst);
    });

    ws.on("close", () => {
      if (!joined) return;
      const { inst, playerId } = joined;
      // Server shutdown terminates sockets AFTER close() already flushed
      // every instance and closed the DB — those late close events must not
      // re-checkpoint (an untracked instance is already saved and gone).
      if (this.instances.get(inst.code) !== inst) return;
      this.checkpoint(inst); // final save while the leaving client is still bound
      this.metrics.count("dcc_leaves_total");
      const leaving = inst.clients.find((c) => c.ws === ws);
      if (leaving && this.db?.isOpen()) {
        const p = inst.state.players.find((pl) => pl.id === playerId);
        this.db.logEvent("session_end", inst.code, leaving.accountId, {
          seconds: Math.round((Date.now() - leaving.joinedAt) / 1000),
          floor: inst.state.floor,
          ...(p ? { player: buildSummary(p) } : {}),
        }, Date.now());
      }
      inst.clients = inst.clients.filter((c) => c.ws !== ws);
      inst.intents[playerId] = NO_INTENT; // seat stays; character idles until rejoin
      if (inst.clients.length === 0) {
        // Empty instance: stop ticking and drop it from memory. Characters
        // (and the party's floor) are checkpointed above; the world itself is
        // regenerated from seed on the next join. World snapshots are P2.
        clearInterval(inst.timer);
        this.instances.delete(inst.code);
      }
    });
  }

  private getOrCreateInstance(code: string, rivals = false, roam = false): Instance {
    let inst = this.instances.get(code);
    if (inst) return inst;
    // A known party outranks the joiner's flags: the party code committed to a
    // mode/run kind when it was first created, and it resumes as that.
    const stored = this.db?.getParty(code) ?? null;
    const mode: GameState["mode"] = stored ? (stored.mode === "rivals" ? "rivals" : "coop") : rivals ? "rivals" : "coop";
    const runKind: GameState["runKind"] = stored ? (stored.runKind === "roam" ? "roam" : "race") : roam ? "roam" : "race";
    // P2 hibernate/restore: a stored world snapshot resumes the sim exactly
    // where the party left it — monsters, loot, timers, everyone's character.
    // Rivals states nest per-floor worlds whose typed arrays don't survive
    // serialize(), so only shared-world (coop/roam) parties hibernate.
    let state: GameState | null = null;
    let renovated = false; // a snapshot existed but couldn't be used
    if (stored && mode === "coop" && this.db) {
      const snap = this.db.getSnapshot(code);
      if (snap) {
        if (snap.version === SNAPSHOT_VERSION) {
          try {
            state = deserialize(snap.snapshot);
          } catch (err) {
            console.error(`world restore failed for ${code} (falling back to seed):`, err);
            state = null;
          }
        } else {
          console.log(`world snapshot for ${code} is v${snap.version}, want v${SNAPSHOT_VERSION} — regenerating`);
        }
        renovated = state === null;
      }
    }
    if (state) console.log(`world restored for ${code} (floor ${state.floor}, ${state.players.length} seats)`);
    // Everyone in a restored world is a live character, not a stale save —
    // rejoiners must reclaim them as-is rather than re-applying save_json.
    const seated = new Set<number>(state ? state.players.map((p) => p.id) : []);
    if (!state) {
      state = createGame(seedFromCode(code), mode, runKind);
      // Fallback (PERSISTENCE.md): regenerate the party's floor from seed;
      // characters reload from their saves as members rejoin. Rivals track
      // per-player floors, so only shared-world parties fast-forward.
      if (stored && mode === "coop" && stored.floor > state.floor) buildFloor(state, stored.floor);
      if (renovated) {
        // The world snapshot outlived the sim that wrote it. Progression is
        // intact via character saves; own the reset in the System's voice.
        state.announcements.push({
          text: "SCHEDULED MAINTENANCE COMPLETE. This floor has been renovated. Your progression survived; the furniture did not.",
          kind: "progress", priority: "normal",
        });
      }
    }
    inst = {
      code,
      state,
      clients: [],
      intents: {},
      tick: 0,
      lastFloor: state.floor,
      seated,
      timer: setInterval(() => this.tickInstance(inst!), 1000 / TICK_HZ),
      lastStatus: state.status,
      worldKey: "", // first snapshot tick broadcasts FULL
      coldCache: new Map(),
    };
    this.instances.set(code, inst);
    if (!stored) this.db?.upsertParty(code, mode, runKind, state.floor, Date.now());
    return inst;
  }

  /** One transaction: the party's floor, every bound connected member's
   *  character save, and (coop/roam) the full world snapshot. Disconnected
   *  members were checkpointed as they left. A finished run instead clears
   *  the party so the next join under this code starts fresh. */
  private checkpoint(inst: Instance): void {
    if (!this.db || !this.db.isOpen()) return;
    if (inst.state.status !== "playing") {
      this.db.clearParty(inst.code);
      return;
    }
    const now = Date.now();
    this.db.checkpoint(() => {
      this.db!.upsertParty(inst.code, inst.state.mode, inst.state.runKind, inst.state.floor, now);
      for (const c of inst.clients) {
        if (!c.bound) continue;
        const p = inst.state.players.find((pl) => pl.id === c.playerId);
        if (!p) continue;
        this.db!.upsertMember(inst.code, c.accountId, p.id, JSON.stringify(toSaveData(inst.state, p)), now);
      }
      if (inst.state.mode === "coop") {
        this.db!.saveSnapshot(inst.code, SNAPSHOT_VERSION, serialize(inst.state), now);
      }
    });
  }

  private tickInstance(inst: Instance): void {
    try {
      this.tickInstanceBody(inst);
    } catch (err) {
      // A throw inside one party's tick (sim bug, serialization hole) must
      // never escape the interval callback — that kills the whole process and
      // every party on the box. Drop just this instance: characters are
      // checkpointed if the state still serializes, sockets close, and the
      // clients auto-reconnect into a regenerated world.
      console.error(`instance ${inst.code} tick failed — dropping it:`, err);
      clearInterval(inst.timer);
      this.instances.delete(inst.code);
      try {
        this.checkpoint(inst);
      } catch {
        // The corrupt state is likely what threw; member saves from the last
        // good checkpoint stand.
      }
      for (const c of inst.clients) c.ws.close();
    }
  }

  private tickInstanceBody(inst: Instance): void {
    const t0 = performance.now();
    inst.tick++;
    // Fixed dt: sim time advances by exactly one tick regardless of wall clock.
    step(inst.state, inst.intents, 1 / TICK_HZ);
    // Edge-triggered intent flags (dash/nova/useStairs) must not repeat next tick.
    for (const id of Object.keys(inst.intents)) {
      const i = inst.intents[Number(id)];
      inst.intents[Number(id)] = { ...i, dash: false, nova: false, useStairs: false, ping: undefined };
    }

    // Checkpoint on floor transitions (the progression beat worth never losing)
    // and every ~60s of active play as a backstop.
    if (inst.state.floor !== inst.lastFloor) {
      inst.lastFloor = inst.state.floor;
      this.metrics.count("dcc_floors_descended_total");
      // The balance record: who reached this floor, as WHAT build. One row
      // per floor per party — the future's "what wins floor 12" query.
      this.db?.logEvent("floor", inst.code, null, {
        floor: inst.state.floor,
        mode: inst.state.mode,
        runKind: inst.state.runKind,
        elapsed: Math.round(inst.state.elapsed),
        players: inst.state.players.map(buildSummary),
      }, Date.now());
      this.checkpoint(inst);
    } else if (inst.tick % CHECKPOINT_EVERY === 0) {
      this.checkpoint(inst);
    }

    // Run over (win or wipe): the edge fires exactly once per run.
    if (inst.state.status !== inst.lastStatus) {
      if (inst.lastStatus === "playing") {
        this.metrics.count(inst.state.status === "won" ? "dcc_runs_won_total" : "dcc_runs_lost_total");
        this.db?.logEvent("run_end", inst.code, null, {
          status: inst.state.status,
          floor: inst.state.floor,
          mode: inst.state.mode,
          runKind: inst.state.runKind,
          elapsed: Math.round(inst.state.elapsed),
          players: inst.state.players.map(buildSummary),
        }, Date.now());
      }
      inst.lastStatus = inst.state.status;
    }

    const s = inst.state;
    if (s.events.length || s.announcements.length || s.hits.length) {
      this.broadcast(inst, { t: "events", events: s.events, announcements: s.announcements, hits: s.hits });
    }
    if (inst.tick % SNAPSHOT_EVERY === 0) {
      // FULL (map + fog) only when the client's world identity changes —
      // floor descent or a mapVersion bump (doors unlocking). Every other
      // snapshot is DYNAMIC: the client keeps its cached world.
      if (s.mode === "rivals") {
        // Personal snapshots: each rival sees THEIR floor + the standings.
        for (const c of inst.clients) {
          if (c.ws.readyState !== WebSocket.OPEN) continue;
          const key = rivalWorldKey(s, c.playerId);
          const full = key !== c.worldKey;
          c.worldKey = key;
          const data = JSON.stringify({
            t: "snap", tick: inst.tick, full: full || undefined,
            snapshot: full ? serializeFor(s, c.playerId) : serializeForDynamic(s, c.playerId),
          });
          this.metrics.count("dcc_snapshot_bytes_total", data.length);
          this.metrics.count("dcc_snapshot_messages_total");
          c.ws.send(data);
        }
      } else {
        const key = `${s.floor}:${s.mapVersion}`;
        const full = key !== inst.worldKey;
        inst.worldKey = key;
        this.broadcast(inst, {
          t: "snap", tick: inst.tick, full: full || undefined,
          snapshot: full ? serialize(s) : serializeDynamic(s, inst.coldCache),
        });
      }
    }
    const ms = performance.now() - t0;
    this.tickMsEma = this.tickMsEma * 0.98 + ms * 0.02;
    if (ms > this.tickMsMax) this.tickMsMax = ms;
    this.metrics.count("dcc_ticks_total");
    this.metrics.count("dcc_tick_ms_total", ms);
  }

  /** Ship pending transients (events/announcements/hits) to the party and
   *  clear the channels — the next step() would silently wipe them. */
  private flushTransients(inst: Instance): void {
    const s = inst.state;
    if (s.events.length || s.announcements.length || s.hits.length) {
      this.broadcast(inst, { t: "events", events: s.events, announcements: s.announcements, hits: s.hits });
      s.events = [];
      s.announcements = [];
      s.hits = [];
    }
  }

  private broadcast(inst: Instance, msg: unknown): void {
    const data = JSON.stringify(msg);
    const snap = (msg as { t?: string }).t === "snap";
    for (const c of inst.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      c.ws.send(data);
      if (snap) {
        this.metrics.count("dcc_snapshot_bytes_total", data.length);
        this.metrics.count("dcc_snapshot_messages_total");
      } else {
        this.metrics.count("dcc_event_bytes_total", data.length);
      }
    }
  }
}

// Direct execution: `npm run server` (tsx). Guarded so importing never starts one.
// In production (Docker) STATIC_DIR points at the built client, so this one
// process serves the site AND the game on a single port.
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("gameServer.ts");
if (isMain) {
  const port = Number(process.env.PORT ?? 5281);
  const staticDir = process.env.STATIC_DIR; // e.g. "dist" in the container
  const lbFile = process.env.LEADERBOARD_FILE ?? "leaderboard.json";
  const dbFile = process.env.DB_FILE ?? "dcc.sqlite"; // prod: /data/dcc.sqlite (fly.toml)
  const server = new GameServer(port, staticDir, lbFile, dbFile);
  // Fly sends SIGINT (then SIGKILL after kill_timeout) on deploy/stop: flush
  // every world + character save before the process dies so restarts lose
  // nothing. Requires the container CMD to be `node --import tsx ...` — an
  // `npx tsx` wrapper eats the signal and the flush never runs (observed in
  // prod: Fly waited out the grace period, then hard-killed).
  const shutdown = (signal: string): void => {
    console.log(`${signal}: checkpointing live instances and exiting`);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  void server.ready().then(() => {
    console.log(`Dungeon Crawler Claude server on :${port} (ws + ${staticDir ? `static from ${staticDir}` : "no static"})`);
    console.log(`Party instances tick at ${TICK_HZ}Hz, snapshots every ${SNAPSHOT_EVERY} ticks.`);
  });
}
