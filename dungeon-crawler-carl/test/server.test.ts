import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { GameServer, seedFromCode } from "../src/server/gameServer";
import { serialize, deserialize, serializeDynamic, deserializeDynamic, mergeColdPlayers } from "../src/sim/snapshot";
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
    // Reattached to a cached world: the world arrays are the cached objects
    // themselves, identities/integers are exact, floats are wire-rounded.
    const world = deserialize(serialize(a));
    const b = deserializeDynamic(dyn, world.map, world.explored);
    expect(b.map).toBe(world.map);
    expect(b.explored).toBe(world.explored);
    expect(b.players.map((p) => [p.id, p.name, p.hp, p.gold])).toEqual(
      a.players.map((p) => [p.id, p.name, p.hp, p.gold]));
    expect(b.players[0].pos.x).toBeCloseTo(a.players[0].pos.x, 2);
    expect(b.players[0].pos.y).toBeCloseTo(a.players[0].pos.y, 2);
    expect(b.rng).toEqual(a.rng); // integer state — exact
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
    // Wire monsters keep every field the hosts read and shed the AI bookkeeping.
    const w = dyn.monsters.find((m) => m.id === near.id)!;
    expect(w.pos).toEqual({ x: near.pos.x, y: near.pos.y });
    expect(w.kind).toBe(near.kind);
    expect(w.hp).toBe(near.hp);
    expect(w.maxHp).toBe(near.maxHp);
    expect(w.attackRange).toBe(near.attackRange); // telegraph rings need it
    expect(w.damage).toBeUndefined(); // server-only stats stay home
    expect(w.xp).toBeUndefined();
    expect(w.poiseDmg).toBeUndefined();
    const we = dyn.monsters.find((m) => m.id === farElite.id)!;
    expect(we.eliteName).toBe("THE LANDLORD"); // the boss bar's name survives
  });

  it("cold split: unchanged gear/bags ship once, then stay home until they change", () => {
    const g = createGame(777);
    const cache = new Map<number, string>();
    // First dynamic snapshot with a cache: the slow block ships (baseline).
    const first = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(first.players[0].equipment).toBeDefined();
    expect(first.players[0].inventory).toBeDefined();
    // Nothing changed: the slow block stays home.
    const second = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(second.players[0].equipment).toBeUndefined();
    expect(second.players[0].inventory).toBeUndefined();
    expect(second.players[0].hp).toBe(g.players[0].hp); // hot fields still ride
    // The client merges the block forward from its previous snapshot.
    mergeColdPlayers(second.players, first.players);
    expect(second.players[0].equipment).toEqual(first.players[0].equipment);
    expect(second.players[0].abilities).toEqual(first.players[0].abilities);
    // A change (loot enters the bag) ships the block again on the next snap.
    g.players[0].inventory = [...g.players[0].inventory];
    g.players[0].tipsSeen = [...(g.players[0].tipsSeen ?? []), "bolt"];
    const third = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(third.players[0].equipment).toBeDefined();
    expect(third.players[0].tipsSeen).toContain("bolt");
  });

  it("wire floats are rounded to sub-pixel precision (dynamic only)", () => {
    const a = createGame(31337);
    drive(a, 97); // odd step count: positions land on long doubles
    const dyn = serializeDynamic(a);
    expect(dyn).not.toMatch(/\d\.\d{4,}/); // no 17-digit doubles on the wire
    // Full snapshots stay EXACT — they feed persistence and golden determinism.
    expect(serialize(a)).toContain(String(a.players[0].pos.x));
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
    // ones (the recurring kind) ride on it and inherit unchanged cold blocks.
    let world: { map: GameState["map"]; explored: Uint8Array } | null = null;
    const absorb = (snapshot: string, full: boolean): GameState | null => {
      if (full) {
        const s = deserialize(snapshot);
        world = { map: s.map, explored: s.explored };
        return s;
      }
      if (!world) return null;
      const s = deserializeDynamic(snapshot, world.map, world.explored);
      if (client.lastSnap) mergeColdPlayers(s.players, client.lastSnap.players);
      return s;
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

  it("claiming an achievement's loot box applies over the network", async () => {
    const a = await connect(port, "ACH-1", "Carl");
    const instances = (server as unknown as { instances: Map<string, { state: GameState }> }).instances;
    const inst = instances.get("ACH-1")!;
    const p = inst.state.players.find((pl) => pl.id === a.playerId)!;
    p.achievements.push("first_blood");
    p.unclaimedAchievements = ["first_blood"];
    const lootBefore = inst.state.lootBoxes;
    a.send({ t: "claimAchievement", id: "first_blood" });
    await waitFor(() => inst.state.lootBoxes > lootBefore);
    expect(p.unclaimedAchievements).not.toContain("first_blood");
    a.close();
  });

  it("a tick that throws drops only that instance — other parties keep playing", async () => {
    const doomed = await connect(port, "CRASH-1", "Carl");
    const bystander = await connect(port, "SAFE-1", "Donut");
    const closed = new Promise<void>((r) => doomed.ws.on("close", () => r()));
    // Corrupt the sim so the next tick throws — stands in for any future
    // in-sim hole. Before the guard this killed the whole process.
    const instances = (server as unknown as { instances: Map<string, { state: unknown }> }).instances;
    instances.get("CRASH-1")!.state = null;
    await closed; // the doomed party's socket closes...
    expect(instances.has("CRASH-1")).toBe(false); // ...and its instance is gone
    // ...but the process lives and the OTHER party still receives snapshots.
    const n = bystander.snaps.length;
    await waitFor(() => bystander.snaps.length > n);
    bystander.close();
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

describe("static file serving: caching + compression (the load-time budget)", () => {
  let server: GameServer;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = mkdtempSync(join(tmpdir(), "dcc-static-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    // Repetitive bytes so gzip visibly shrinks it (GLBs behave the same way).
    writeFileSync(join(dir, "assets", "thing.glb"), Buffer.alloc(64 * 1024, 7));
    writeFileSync(join(dir, "assets", "pic.png"), Buffer.alloc(1024, 9));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
    server = new GameServer(0, dir);
    await server.ready();
    port = server.port;
  });

  afterAll(async () => {
    server.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  it("assets get a day-long TTL and an ETag; HTML always revalidates", async () => {
    const asset = await fetch(`http://127.0.0.1:${port}/assets/thing.glb`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("max-age=86400");
    expect(asset.headers.get("etag")).toMatch(/^W\//);
    const html = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(html.headers.get("cache-control")).toBe("no-cache");
  });

  it("If-None-Match returns 304 with no body — a repeat visit never re-downloads", async () => {
    const first = await fetch(`http://127.0.0.1:${port}/assets/thing.glb`);
    const etag = first.headers.get("etag")!;
    const again = await fetch(`http://127.0.0.1:${port}/assets/thing.glb`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it("gzips GLBs on the wire (and the bytes round-trip)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/thing.glb`, {
      headers: { "accept-encoding": "gzip" },
    });
    // fetch transparently decompresses; verify the negotiated encoding + content.
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(64 * 1024);
    expect(body[0]).toBe(7);
    expect(res.headers.get("vary")).toBe("accept-encoding");
    // The raw stream must actually be gzip: ask node's http directly.
    const { get } = await import("node:http");
    const enc = await new Promise<string>((resolve2) => {
      get({ host: "127.0.0.1", port, path: "/assets/thing.glb", headers: { "accept-encoding": "gzip" } },
        (r) => { resolve2(String(r.headers["content-encoding"])); r.resume(); });
    });
    expect(enc).toBe("gzip");
  });

  it("skips recompressing formats that are already compressed (png)", async () => {
    const { get } = await import("node:http");
    const enc = await new Promise<string>((resolve2) => {
      get({ host: "127.0.0.1", port, path: "/assets/pic.png", headers: { "accept-encoding": "gzip" } },
        (r) => { resolve2(String(r.headers["content-encoding"])); r.resume(); });
    });
    expect(enc).toBe("undefined");
  });
});
