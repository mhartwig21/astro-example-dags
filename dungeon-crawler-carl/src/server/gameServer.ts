import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createGame, addPlayer, applySavedPlayer, buildFloor, step, chooseReward, chooseUpgrade, buyCatalogItem, sellItem, sellAllItems, setReady, equipFromInventory, slotAbility, setUltimate, type SavedProgress } from "../sim/game";
import { ABILITY_INFO, type AbilityId } from "../sim/abilities";
import {
  serialize, serializeDynamic, serializeFor, serializeForDynamic, rivalWorldKey,
  deserialize, SNAPSHOT_VERSION,
} from "../sim/snapshot";
import { toSaveData } from "../persist/save";
import { Leaderboard } from "./leaderboard";
import { openDb, type PersistDb } from "./db";
import { NO_INTENT, type GameState, type Intent, type PartyIntents, type Vec2 } from "../sim/types";

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

// Abuse guards for an internet-facing deployment. Generous for friendly play,
// tight enough that a hostile client can't balloon memory or the tick budget.
export const MAX_PARTY_SIZE = 6;
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
  worldKey: string; // co-op: the world last broadcast in FULL ("" = never)
}

/** Accept a well-formed client token; anything else gets a fresh identity. */
function validToken(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
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
};

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

  /**
   * One process serves everything: HTTP (built client from `staticDir` + a
   * /health endpoint) and the game WebSocket on the same port. Plain Node —
   * no platform-specific APIs, so the container runs anywhere (Fly, GCP, a VPS).
   */
  constructor(port: number, staticDir?: string, leaderboardFile?: string, dbFile?: string) {
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
  }

  private onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = req.url ?? "/";
    if (url.split("?")[0] === "/leaderboard") {
      this.onLeaderboard(req, res);
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
    // are immutable; everything else (models/audio/icons) gets a short TTL.
    const ext = extname(file);
    const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file);
    const cache = ext === ".html"
      ? "no-cache"
      : hashed
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": cache,
    });
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

  close(): void {
    // Flush every live run before the process goes away — this is what makes
    // a deploy restart survivable for characters (SIGTERM handler below).
    for (const inst of this.instances.values()) this.checkpoint(inst);
    this.leaderboard.flush();
    this.db?.close();
    for (const inst of this.instances.values()) clearInterval(inst.timer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    this.http.close();
  }

  private onConnection(ws: WebSocket): void {
    let joined: { inst: Instance; playerId: number } | null = null;

    ws.on("message", (raw) => {
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
        const held = new Set(inst.clients.map((c) => c.playerId));
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
          const cap = inst.state.mode === "rivals" ? MAX_RIVALS : MAX_PARTY_SIZE;
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
        const client: Client = { ws, playerId: player.id, accountId: token, bound };
        // The welcome below is a FULL snapshot; recurring snaps can stay dynamic.
        if (inst.state.mode === "rivals") client.worldKey = rivalWorldKey(inst.state, player.id);
        inst.clients.push(client);
        if (bound && this.db) {
          this.db.upsertMember(code, token, player.id, JSON.stringify(toSaveData(inst.state, player)), now);
        }
        joined = { inst, playerId: player.id };
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
      this.checkpoint(inst); // final save while the leaving client is still bound
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
          } catch {
            state = null;
          }
        }
        renovated = state === null;
      }
    }
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
      worldKey: "", // first snapshot tick broadcasts FULL
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
    if (!this.db) return;
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
      this.checkpoint(inst);
    } else if (inst.tick % CHECKPOINT_EVERY === 0) {
      this.checkpoint(inst);
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
          c.ws.send(JSON.stringify({
            t: "snap", tick: inst.tick, full: full || undefined,
            snapshot: full ? serializeFor(s, c.playerId) : serializeForDynamic(s, c.playerId),
          }));
        }
      } else {
        const key = `${s.floor}:${s.mapVersion}`;
        const full = key !== inst.worldKey;
        inst.worldKey = key;
        this.broadcast(inst, {
          t: "snap", tick: inst.tick, full: full || undefined,
          snapshot: full ? serialize(s) : serializeDynamic(s),
        });
      }
    }
    const ms = performance.now() - t0;
    this.tickMsEma = this.tickMsEma * 0.98 + ms * 0.02;
    if (ms > this.tickMsMax) this.tickMsMax = ms;
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
    for (const c of inst.clients) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
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
  // every character save before the process dies so restarts lose nothing.
  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void server.ready().then(() => {
    console.log(`Dungeon Crawler Claude server on :${port} (ws + ${staticDir ? `static from ${staticDir}` : "no static"})`);
    console.log(`Party instances tick at ${TICK_HZ}Hz, snapshots every ${SNAPSHOT_EVERY} ticks.`);
  });
}
