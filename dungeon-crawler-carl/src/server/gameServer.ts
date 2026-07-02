import { WebSocketServer, WebSocket } from "ws";
import { createGame, addPlayer, step, chooseReward, chooseUpgrade, buyShopItem, setReady, equipFromInventory } from "../sim/game";
import { serialize } from "../sim/snapshot";
import { NO_INTENT, type GameState, type Intent, type PartyIntents } from "../sim/types";

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

export class GameServer {
  private wss: WebSocketServer;
  private instances = new Map<string, Instance>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  get port(): number {
    return (this.wss.address() as { port: number }).port;
  }

  /** Resolves when the server is listening (useful for tests). */
  ready(): Promise<void> {
    return new Promise((resolve) => this.wss.on("listening", resolve));
  }

  close(): void {
    for (const inst of this.instances.values()) clearInterval(inst.timer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
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

      if (msg.t === "join" && typeof msg.code === "string" && typeof msg.name === "string") {
        const inst = this.getOrCreateInstance(msg.code);
        // First joiner takes the pre-made players[0] seat; later joiners drop in.
        const seatless = inst.state.players.filter(
          (p) => !inst.clients.some((c) => c.playerId === p.id),
        );
        const player = seatless[0] ?? addPlayer(inst.state, msg.name);
        player.name = msg.name;
        inst.clients.push({ ws, playerId: player.id });
        joined = { inst, playerId: player.id };
        ws.send(JSON.stringify({ t: "welcome", playerId: player.id, snapshot: serialize(inst.state) }));
        return;
      }

      if (!joined) return; // everything below requires a seat
      const { inst, playerId } = joined;
      switch (msg.t) {
        case "intent":
          inst.intents[playerId] = msg.intent as Intent;
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
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("gameServer.ts");
if (isMain) {
  const port = Number(process.env.PORT ?? 5281);
  const server = new GameServer(port);
  void server.ready().then(() => {
    console.log(`DCC authoritative server listening on ws://localhost:${port}`);
    console.log(`Party instances tick at ${TICK_HZ}Hz, snapshots every ${SNAPSHOT_EVERY} ticks.`);
  });
}
