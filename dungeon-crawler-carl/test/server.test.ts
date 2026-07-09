import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { GameServer, seedFromCode } from "../src/server/gameServer";
import { serialize, deserialize, serializeDynamic, deserializeDynamic } from "../src/sim/snapshot";
import { createGame, createTestGame, step } from "../src/sim/game";
import type { GameState, Intent } from "../src/sim/types";

// ---- Phase 3: snapshot golden test ----

function drive(g: GameState, n: number): void {
  const intents: Intent[] = [
    { move: { x: 1, y: 0 }, attack: true, useStairs: false, aim: { x: 1, y: 0 } },
    { move: { x: 0, y: 1 }, attack: false, useStairs: false, bolt: true },
    { move: { x: -1, y: 0 }, attack: true, useStairs: false },
  ];
  for (let i = 0; i < n; i++) step(g, intents[i % intents.length], 1 / 30);
}

describe("snapshot (serialize/deserialize)", () => {
  it("round-trips and steps identically to the original (golden determinism)", () => {
    const a = createGame(31337);
    drive(a, 120);
    const b = deserialize(serialize(a));
    // Typed arrays revived.
    expect(b.map.tiles).toBeInstanceOf(Uint8Array);
    expect(b.explored).toBeInstanceOf(Uint8Array);
    // Continue BOTH for another 120 steps: identical evolution.
    drive(a, 120);
    drive(b, 120);
    expect(serialize(a)).toBe(serialize(b));
  });

  it("DYNAMIC snapshots ship no map/fog and reattach onto a cached world", () => {
    const a = createGame(31337);
    drive(a, 120);
    const dyn = serializeDynamic(a);
    expect(dyn).not.toContain('"tiles"');
    expect(dyn).not.toContain('"explored"');
    // The diet is the point: the recurring snapshot sheds the grid + mask.
    expect(dyn.length).toBeLessThan(serialize(a).length * 0.75);
    // Reattached to a cached world, everything non-monster survives verbatim
    // and the world arrays are the cached objects themselves.
    const world = deserialize(serialize(a));
    const b = deserializeDynamic(dyn, world.map, world.explored);
    expect(b.map).toBe(world.map);
    expect(b.explored).toBe(world.explored);
    expect(b.players).toEqual(JSON.parse(serialize(a)).players);
    expect(b.rng).toEqual(a.rng);
  });

  it("interest management: far chaff is trimmed, headliners and the key always ship", () => {
    const a = createGame(31337);
    const p = a.players[0];
    p.alive = true;
    // A legible cast of four, staged around the crawler.
    a.monsters = a.monsters.slice(0, 4);
    const [near, farGrunt, farElite, farCarrier] = a.monsters;
    near.pos = { x: p.pos.x + 2, y: p.pos.y };
    farGrunt.pos = { x: p.pos.x + 40, y: p.pos.y + 40 };
    farElite.pos = { x: p.pos.x + 40, y: p.pos.y - 40 };
    farElite.elite = true;
    farElite.eliteName = "THE LANDLORD";
    farCarrier.pos = { x: p.pos.x - 40, y: p.pos.y + 40 };
    farCarrier.hasKey = true;
    const dyn = JSON.parse(serializeDynamic(a)) as GameState;
    const shipped = dyn.monsters.map((m) => m.id);
    expect(shipped).toContain(near.id); // in the bubble
    expect(shipped).toContain(farElite.id); // boss bar / ringside never starve
    expect(shipped).toContain(farCarrier.id); // the key matters wherever it is
    expect(shipped).not.toContain(farGrunt.id); // fog-hidden chaff stays home
    // The authoritative count rides along so hosts can tell "cleared" from "far".
    expect(dyn.monstersLeft).toBe(4);
    // Shipped monsters are VERBATIM — the filter trims, never rewrites.
    expect(dyn.monsters.find((m) => m.id === near.id)).toEqual(JSON.parse(JSON.stringify(near)));
  });

  it("payload contract: a dense-floor dynamic snapshot is a fraction of the full state", () => {
    const g = createTestGame({ seed: 42, floor: 15, level: 18 });
    drive(g, 60);
    const full = serialize(g);
    const dyn = serializeDynamic(g);
    const shipped = (JSON.parse(dyn) as GameState).monsters.length;
    expect(g.monsters.length).toBeGreaterThan(50); // the floor really is dense
    expect(shipped).toBeLessThan(g.monsters.length); // and most of it stays home
    expect(dyn.length).toBeLessThan(full.length * 0.6); // wire cost stays a fraction
  });
});

// ---- Phase 4: authoritative server with two simulated clients ----

interface TestClient {
  ws: WebSocket;
  playerId: number;
  lastSnap: GameState | null;
  snaps: { full: boolean; bytes: number }[];
  events: string[];
  send: (msg: unknown) => void;
  close: () => void;
}

function connect(port: number, code: string, name: string, rivals = false): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client: TestClient = {
      ws,
      playerId: -1,
      lastSnap: null,
      snaps: [],
      events: [],
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
    };
    // Mirrors NetClient: full snapshots refresh the cached world, dynamic
    // ones (the recurring kind) ride on it.
    let world: { map: GameState["map"]; explored: Uint8Array } | null = null;
    const absorb = (snapshot: string, full: boolean): GameState | null => {
      if (full) {
        const s = deserialize(snapshot);
        world = { map: s.map, explored: s.explored };
        return s;
      }
      return world ? deserializeDynamic(snapshot, world.map, world.explored) : null;
    };
    ws.on("open", () => client.send({ t: "join", code, name, rivals: rivals || undefined }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "welcome") {
        client.playerId = msg.playerId;
        client.lastSnap = absorb(msg.snapshot, true);
        resolve(client);
      } else if (msg.t === "snap") {
        client.snaps.push({ full: msg.full === true, bytes: msg.snapshot.length });
        client.lastSnap = absorb(msg.snapshot, msg.full === true) ?? client.lastSnap;
      } else if (msg.t === "events") {
        client.events.push(...msg.events, ...msg.announcements.map((a: { text: string }) => a.text));
      }
    });
    ws.on("error", reject);
  });
}

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("authoritative server", () => {
  let server: GameServer;
  let port: number;

  beforeAll(async () => {
    server = new GameServer(0); // ephemeral port
    await server.ready();
    port = server.port;
  });

  afterAll(() => server.close());

  it("seeds an instance deterministically from the party code", () => {
    expect(seedFromCode("CRAWL-42")).toBe(seedFromCode("CRAWL-42"));
    expect(seedFromCode("CRAWL-42")).not.toBe(seedFromCode("CRAWL-43"));
  });

  it("two clients share one instance: join, move, and see each other", async () => {
    const a = await connect(port, "PARTY-1", "Carl");
    const b = await connect(port, "PARTY-1", "Donut");

    // Distinct seats in the same party.
    expect(a.playerId).not.toBe(b.playerId);
    await waitFor(() => (b.lastSnap?.players.length ?? 0) >= 2);
    expect(b.lastSnap!.players.map((p) => p.name).sort()).toEqual(["Carl", "Donut"]);

    // A moves right; BOTH clients observe the movement in snapshots.
    const ax0 = a.lastSnap!.players.find((p) => p.id === a.playerId)!.pos.x;
    a.send({ t: "intent", intent: { move: { x: 1, y: 0 }, attack: false, useStairs: false } });
    await waitFor(() => {
      const seenByA = a.lastSnap?.players.find((p) => p.id === a.playerId)?.pos.x ?? ax0;
      const seenByB = b.lastSnap?.players.find((p) => p.id === a.playerId)?.pos.x ?? ax0;
      return seenByA > ax0 + 0.5 && seenByB > ax0 + 0.5;
    });

    // Stop moving; both snapshots converge on the same authoritative position.
    a.send({ t: "intent", intent: { move: { x: 0, y: 0 }, attack: false, useStairs: false } });
    await waitFor(() => {
      if (!a.lastSnap || !b.lastSnap) return false;
      const pa = a.lastSnap.players.find((p) => p.id === a.playerId)!.pos;
      const pb = b.lastSnap.players.find((p) => p.id === a.playerId)!.pos;
      return Math.abs(pa.x - pb.x) < 1e-9 && Math.abs(pa.y - pb.y) < 1e-9;
    });

    a.close();
    b.close();
  });

  it("recurring snapshots are DYNAMIC — the world ships once, not 15 times a second", async () => {
    const a = await connect(port, "DIET-1", "Carl");
    await waitFor(() => a.snaps.length >= 6);
    // At most one full (the fresh instance's first broadcast); the steady
    // state is dynamic, and dynamic frames are decisively smaller.
    const fulls = a.snaps.filter((s) => s.full);
    const dyns = a.snaps.filter((s) => !s.full);
    expect(fulls.length).toBeLessThanOrEqual(1);
    expect(dyns.length).toBeGreaterThanOrEqual(5);
    if (fulls.length > 0) {
      expect(Math.max(...dyns.map((s) => s.bytes))).toBeLessThan(fulls[0].bytes * 0.75);
    }
    // And the merged view still has a world to render.
    expect(a.lastSnap!.map.tiles.length).toBeGreaterThan(0);
    expect(a.lastSnap!.explored.length).toBe(a.lastSnap!.map.tiles.length);
    a.close();
  });

  it("different codes get different instances (and different dungeons)", async () => {
    const a = await connect(port, "PARTY-A", "Carl");
    const b = await connect(port, "PARTY-B", "Carl");
    expect(a.lastSnap!.seed).not.toBe(b.lastSnap!.seed);
    expect(a.lastSnap!.players.length).toBe(1);
    expect(b.lastSnap!.players.length).toBe(1);
    a.close();
    b.close();
  });

  it("RIVALS: personal snapshots carry the race standings and personal shops", async () => {
    const a = await connect(port, "RACE-1", "Carl", true);
    const b = await connect(port, "RACE-1", "Donut");
    expect(a.lastSnap!.mode).toBe("rivals"); // first joiner's flag decides
    await waitFor(() => (b.lastSnap?.rivals?.length ?? 0) >= 2);
    // Standings meta covers everyone; the world view is per-client.
    expect(b.lastSnap!.mode).toBe("rivals");
    expect(b.lastSnap!.rivals!.map((r) => r.name).sort()).toEqual(["Carl", "Donut"]);
    expect(b.lastSnap!.worlds).toBeUndefined(); // the multiverse never ships
    expect(b.lastSnap!.map.tiles.length).toBeGreaterThan(0); // but YOUR floor does
    a.close();
    b.close();
  });
});
