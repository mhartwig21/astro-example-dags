/**
 * Round-5 probe: is `party_size >= 2` on the server-vouched CONTRACTS row a
 * statement about a RACE, or about how many websocket frames one client sent?
 *
 * Boots the real GameServer on its own SQLite file, joins a rivals instance
 * TWICE from the same process (the second socket closes immediately), forces
 * the run-end edge, and reads the real CONTRACTS board back over real HTTP.
 */
import { rmSync } from "node:fs";
import WebSocket from "ws";
import { GameServer } from "../src/server/gameServer";

const PORT = 5931;
const DB = "tools/_r5probe.sqlite";
for (const f of [DB, DB + "-shm", DB + "-wal"]) { try { rmSync(f); } catch { /* fresh */ } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function join(code: string, name: string, rivals: boolean): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT);
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name, rivals })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { t: string };
      if (m.t === "welcome") resolve(ws);
    });
  });
}

async function main(): Promise<void> {
  const server = new GameServer(PORT, undefined, "tools/_r5probe.json", DB);
  await sleep(400);
  const insts = (server as unknown as { instances: Map<string, any> }).instances;

  // ONE human. Two joins. The sock puppet never sends an intent.
  const a = await join("PROBE1", "EXPLOIT", true);
  const b = await join("PROBE1", "SOCKPUPPET", true);
  await sleep(200);
  const inst = insts.get("PROBE1");
  console.log("seats after two joins  :", inst.state.players.length,
    inst.state.players.map((p: any) => p.name));
  b.close();                       // the puppet leaves. Immediately.
  await sleep(600);
  console.log("live clients after leave:", inst.clients.length);
  console.log("sim seats after leave   :", inst.state.players.length,
    "  <-- this is what partySize is read from");

  // Force the run-end edge the way clearing floor 18 would. Nothing about the
  // BOARD predicate depends on how the win was reached; this is the row write.
  inst.state.floor = 18;
  inst.state.elapsed = 700;
  inst.state.players[0].kills = 411;
  inst.state.players[0].level = 24;
  inst.state.status = "won";
  inst.state.winnerId = inst.state.players[0].id;
  await sleep(500);

  const r = await fetch(`http://127.0.0.1:${PORT}/boards/contracts?limit=10`);
  const body = await r.json() as any;
  console.log("\nCONTRACTS entries:", body.entries.length);
  for (const e of body.entries) {
    console.log("  ", e.name, "| state", e.state, "| mode", e.mode + "/" + e.runKind,
      "| party", e.partySize, "| film", e.film, "| ticks", e.ticks, "| won", e.won);
  }
  console.log("\nAPI note on that payload:\n  ", body.note);

  a.close();
  server.close();
  await sleep(300);
  process.exit(0);
}
void main();
