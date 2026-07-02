import { createServer, type Server as HttpServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createGame, addPlayer, step, chooseReward, chooseUpgrade, buyShopItem, setReady, equipFromInventory } from "../sim/game";
import { serialize } from "../sim/snapshot";
import { NO_INTENT, type GameState, type Intent, type PartyIntents, type Vec2 } from "../sim/types";

// Authoritative multiplayer server (DESIGN.md milestone). One deterministic sim
// per party instance; clients send intents + choices, the server ticks the sim at
// a fixed rate and broadcasts snapshots + transient events. The sim module is the
// exact same code the offline browser host runs — no game logic lives here.
//
// Protocol (JSON messages):
//   client -> server:
//     { t: "join", code: string, name: string }        join/create a party
//     { t: "intent", intent: Intent }                  input for upcoming ticks
//     { t: "choose", kind: "upgrade"|"reward", idx }   pick a draft card
//     { t: "buy", idx: number }                        safe-room purchase
//     { t: "ready" }                                   safe-room ready-up
//   server -> client:
//     { t: "welcome", playerId, snapshot }             join accepted
//     { t: "snap", tick, snapshot }                    full state (interval below)
//     { t: "events", events, announcements, hits }     this tick's transients

export const TICK_HZ = 30;
export const SNAPSHOT_EVERY = 2; // full snapshot every N ticks (15/s)

// Abuse guards for an internet-facing deployment. Generous for friendly play,
// tight enough that a hostile client can't balloon memory or the tick budget.
export const MAX_PARTY_SIZE = 6;
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
  return {
    move: vec(o.move),
    attack: o.attack === true,
    aim: o.aim === undefined ? undefined : vec(o.aim),
    useStairs: o.useStairs === true,
    dash: o.dash === true,
    bolt: o.bolt === true,
    nova: o.nova === true,
  };
}

interface Client {
  ws: WebSocket;
  playerId: number;
}

interface Instance {
  code: string;
  state: GameState;
  clients: Client[];
  intents: PartyIntents;
  tick: number;
  timer: NodeJS.Timeout;
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
  ".txt": "text/plain; charset=utf-8",
};

export class GameServer {
  private http: HttpServer;
  private wss: WebSocketServer;
  private instances = new Map<string, Instance>();
  private staticDir: string | null;

  /**
   * One process serves everything: HTTP (built client from `staticDir` + a
   * /health endpoint) and the game WebSocket on the same port. Plain Node —
   * no platform-specific APIs, so the container runs anywhere (Fly, GCP, a VPS).
   */
  constructor(port: number, staticDir?: string) {
    this.staticDir = staticDir && existsSync(staticDir) ? resolve(staticDir) : null;
    this.http = createServer((req, res) => this.onRequest(req.url ?? "/", res));
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_WS_PAYLOAD });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.http.listen(port);
  }

  private onRequest(url: string, res: import("node:http").ServerResponse): void {
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, instances: this.instances.size }));
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
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
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
        const inst = this.getOrCreateInstance(code);
        // First joiner takes the pre-made players[0] seat; later joiners drop in.
        const seatless = inst.state.players.filter(
          (p) => !inst.clients.some((c) => c.playerId === p.id),
        );
        if (!seatless[0] && inst.state.players.length >= MAX_PARTY_SIZE) {
          ws.send(JSON.stringify({ t: "error", reason: "party full" }));
          ws.close();
          return;
        }
        const player = seatless[0] ?? addPlayer(inst.state, name);
        player.name = name;
        inst.clients.push({ ws, playerId: player.id });
        joined = { inst, playerId: player.id };
        ws.send(JSON.stringify({ t: "welcome", playerId: player.id, snapshot: serialize(inst.state) }));
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
          buyShopItem(inst.state, playerId, Number(msg.idx));
          break;
        case "ready":
          setReady(inst.state, playerId);
          break;
        case "equip":
          equipFromInventory(inst.state, playerId, Number(msg.idx));
          break;
      }
    });

    ws.on("close", () => {
      if (!joined) return;
      const { inst, playerId } = joined;
      inst.clients = inst.clients.filter((c) => c.ws !== ws);
      inst.intents[playerId] = NO_INTENT; // seat stays; character idles until rejoin
      if (inst.clients.length === 0) {
        // Empty instance: stop ticking and drop it (persistence comes later).
        clearInterval(inst.timer);
        this.instances.delete(inst.code);
      }
    });
  }

  private getOrCreateInstance(code: string): Instance {
    let inst = this.instances.get(code);
    if (inst) return inst;
    const state = createGame(seedFromCode(code));
    inst = {
      code,
      state,
      clients: [],
      intents: {},
      tick: 0,
      timer: setInterval(() => this.tickInstance(inst!), 1000 / TICK_HZ),
    };
    this.instances.set(code, inst);
    return inst;
  }

  private tickInstance(inst: Instance): void {
    inst.tick++;
    // Fixed dt: sim time advances by exactly one tick regardless of wall clock.
    step(inst.state, inst.intents, 1 / TICK_HZ);
    // Edge-triggered intent flags (dash/nova/useStairs) must not repeat next tick.
    for (const id of Object.keys(inst.intents)) {
      const i = inst.intents[Number(id)];
      inst.intents[Number(id)] = { ...i, dash: false, nova: false, useStairs: false };
    }

    const s = inst.state;
    if (s.events.length || s.announcements.length || s.hits.length) {
      this.broadcast(inst, { t: "events", events: s.events, announcements: s.announcements, hits: s.hits });
    }
    if (inst.tick % SNAPSHOT_EVERY === 0) {
      this.broadcast(inst, { t: "snap", tick: inst.tick, snapshot: serialize(s) });
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
  const server = new GameServer(port, staticDir);
  void server.ready().then(() => {
    console.log(`Dungeon Crawler Claude server on :${port} (ws + ${staticDir ? `static from ${staticDir}` : "no static"})`);
    console.log(`Party instances tick at ${TICK_HZ}Hz, snapshots every ${SNAPSHOT_EVERY} ticks.`);
  });
}
