import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { GameServer } from "../src/server/gameServer";
import { openDb, type PersistDb } from "../src/server/db";
import { deserialize, deserializeDynamic, mergeColdPlayers, serialize, SNAPSHOT_VERSION } from "../src/sim/snapshot";
import { step } from "../src/sim/game";
import type { GameState } from "../src/sim/types";

// PERSISTENCE.md P1+P2: accounts, character saves, and world hibernate/restore
// in SQLite. The DB layer is unit-tested against a temp file; the server tests
// drive the real protocol (join with a token, disconnect until the instance
// drops, rejoin) and assert the character AND the world come back.

const DAY = 24 * 3600 * 1000;

describe("PersistDb", () => {
  let dir: string;
  let db: PersistDb;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dcc-db-"));
    db = openDb(join(dir, "test.sqlite"))!;
    expect(db).not.toBeNull();
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips accounts, parties, and member saves", () => {
    db.touchAccount("acct-carl-1234", "Carl", 1000);
    db.touchAccount("acct-carl-1234", "Carl the Bold", 2000); // rename sticks
    expect(db.getParty("NOPE")).toBeNull();
    db.upsertParty("CAMP-1", "coop", "roam", 1, 1000);
    db.upsertParty("CAMP-1", "coop", "roam", 4, 2000); // floor advances
    expect(db.getParty("CAMP-1")).toEqual({ mode: "coop", runKind: "roam", floor: 4 });
    expect(db.getMember("CAMP-1", "acct-carl-1234")).toBeNull();
    db.upsertMember("CAMP-1", "acct-carl-1234", 0, '{"gold":777}', 2000);
    db.upsertMember("CAMP-1", "acct-carl-1234", 2, '{"gold":888}', 3000); // reseat updates
    expect(db.getMember("CAMP-1", "acct-carl-1234")).toEqual({ playerId: 2, saveJson: '{"gold":888}' });
  });

  it("expiry: race parties last a week, roam campaigns a month and a half", () => {
    const now = 10_000;
    db.upsertParty("RACE-EXP", "coop", "race", 2, now);
    db.upsertMember("RACE-EXP", "acct-carl-1234", 0, "{}", now);
    db.upsertParty("ROAM-EXP", "coop", "roam", 2, now);
    db.sweepExpired(now + 8 * DAY); // a quiet week+ kills the race party only
    expect(db.getParty("RACE-EXP")).toBeNull();
    expect(db.getMember("RACE-EXP", "acct-carl-1234")).toBeNull(); // cascades
    expect(db.getParty("ROAM-EXP")).not.toBeNull();
    db.sweepExpired(now + 46 * DAY);
    expect(db.getParty("ROAM-EXP")).toBeNull();
  });
});

// ---- Server: the join → save → drop → rejoin loop over the real protocol ----

interface TestClient {
  ws: WebSocket;
  playerId: number;
  token: string;
  lastSnap: GameState | null;
  close: () => void;
}

function connect(port: number, code: string, name: string, token?: string, roam = false): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client: TestClient = { ws, playerId: -1, token: "", lastSnap: null, close: () => ws.close() };
    // Mirrors NetClient: full snapshots carry the world; dynamic ones ride the
    // cached one and inherit unchanged player cold blocks.
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
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name, token, roam: roam || undefined })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "welcome") {
        client.playerId = msg.playerId;
        client.token = msg.token;
        client.lastSnap = absorb(msg.snapshot, true);
        resolve(client);
      } else if (msg.t === "snap") {
        client.lastSnap = absorb(msg.snapshot, msg.full === true) ?? client.lastSnap;
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

describe("server persistence (accounts + character saves)", () => {
  let dir: string;
  let server: GameServer;
  let port: number;
  // The tests reach into the private instance map to stage progression the
  // save must carry (playing to floor N for real is a balance test's job).
  const instances = () =>
    (server as unknown as { instances: Map<string, { state: GameState }> }).instances;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dcc-persist-"));
    server = new GameServer(0, undefined, undefined, join(dir, "dcc.sqlite"));
    await server.ready();
    port = server.port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints a token for tokenless joins and echoes a provided one", async () => {
    const anon = await connect(port, "TOK-1", "Carl");
    expect(anon.token).toMatch(/^[A-Za-z0-9-]{36}$/); // server-minted UUID
    anon.close();
    const named = await connect(port, "TOK-1", "Donut", "donut-token-0001");
    expect(named.token).toBe("donut-token-0001");
    named.close();
    await waitFor(() => instances().size === 0);
  });

  it("a character survives the instance being dropped and comes back on rejoin", async () => {
    const a = await connect(port, "SAVE-1", "Carl", "carl-token-00001");
    // Stage progression directly in the live sim, then leave.
    const inst = instances().get("SAVE-1")!;
    const p = inst.state.players.find((pl) => pl.id === a.playerId)!;
    p.gold = 777;
    p.level = 9;
    a.close();
    await waitFor(() => instances().size === 0); // empty instance checkpoints + drops

    // Same account: character restored into a regenerated world.
    const b = await connect(port, "SAVE-1", "Carl", "carl-token-00001");
    const mine = b.lastSnap!.players.find((pl) => pl.id === b.playerId)!;
    expect(mine.gold).toBe(777);
    expect(mine.level).toBe(9);
    b.close();
    await waitFor(() => instances().size === 0);
  });

  it("a different account does NOT inherit the saved character", async () => {
    const s = await connect(port, "SAVE-1", "Mongo", "mongo-token-0001");
    const mine = s.lastSnap!.players.find((pl) => pl.id === s.playerId)!;
    expect(mine.gold).not.toBe(777);
    expect(mine.level).toBe(1);
    s.close();
    await waitFor(() => instances().size === 0);
  });

  it("the WORLD survives: a hibernated instance restores, not regenerates", async () => {
    const a = await connect(port, "WORLD-1", "Carl", "carl-token-00001");
    const inst = instances().get("WORLD-1")!;
    expect(inst.state.monsters.length).toBeGreaterThan(0);
    inst.state.monsters.length = 0; // stage a distinctive world: floor cleared
    a.close();
    await waitFor(() => instances().size === 0); // hibernate

    const b = await connect(port, "WORLD-1", "Carl", "carl-token-00001");
    expect(b.lastSnap!.monsters.length).toBe(0); // a regenerated floor would be full
    b.close();
    await waitFor(() => instances().size === 0);
  });

  it("a version-mismatched snapshot falls back: fresh world, characters kept", async () => {
    const a = await connect(port, "WORLD-2", "Carl", "carl-token-00001");
    const inst = instances().get("WORLD-2")!;
    inst.state.players.find((pl) => pl.id === a.playerId)!.gold = 555;
    inst.state.monsters.length = 0;
    a.close();
    await waitFor(() => instances().size === 0);
    // Sabotage: pretend the world snapshot came from an incompatible old sim.
    server.db!.saveSnapshot("WORLD-2", SNAPSHOT_VERSION + 999, "{corrupt", Date.now());

    const b = await connect(port, "WORLD-2", "Carl", "carl-token-00001");
    expect(b.lastSnap!.monsters.length).toBeGreaterThan(0); // regenerated world
    expect(b.lastSnap!.players.find((pl) => pl.id === b.playerId)!.gold).toBe(555); // save survived
    b.close();
    await waitFor(() => instances().size === 0);
  });

  it("a finished run clears the campaign: the next join starts fresh", async () => {
    const a = await connect(port, "WORLD-3", "Carl", "carl-token-00001");
    const inst = instances().get("WORLD-3")!;
    inst.state.players.find((pl) => pl.id === a.playerId)!.gold = 999;
    inst.state.status = "won";
    a.close();
    await waitFor(() => instances().size === 0);

    const b = await connect(port, "WORLD-3", "Carl", "carl-token-00001");
    expect(b.lastSnap!.status).toBe("playing"); // a new dungeon, not the finished one
    expect(b.lastSnap!.players.find((pl) => pl.id === b.playerId)!.gold).not.toBe(999);
    b.close();
    await waitFor(() => instances().size === 0);
  });

  it("the party's floor and run kind survive the drop", async () => {
    const a = await connect(port, "CAMP-9", "Carl", "carl-token-00001", true);
    expect(a.lastSnap!.runKind).toBe("roam"); // first joiner's flag decides
    instances().get("CAMP-9")!.state.floor = 3; // stage a descent
    a.close();
    await waitFor(() => instances().size === 0);

    // Rejoin without any flags: the stored party remembers what it is.
    const b = await connect(port, "CAMP-9", "Carl", "carl-token-00001");
    expect(b.lastSnap!.runKind).toBe("roam");
    expect(b.lastSnap!.floor).toBe(3);
    b.close();
    await waitFor(() => instances().size === 0);
  });

  it("a client whose socket already closed (but whose close event hasn't fired here yet) doesn't block reclaim", async () => {
    // Regression test for a real production bug: the server's "held" check
    // used to count ANY entry still physically in inst.clients as a live
    // second tab, even one whose socket had already closed — a gap that can
    // last several seconds (network/proxy propagation), well inside the
    // client's own first auto-reconnect attempt (netClient.ts fires at 1s).
    // A fast reconnect landed in that gap and got shunted onto a disposable
    // guest character instead of reclaiming its own. Simulated directly
    // (rather than raced against real timing, which would be flaky) by
    // forcing the server's view of the socket to report CLOSED while it's
    // still sitting in inst.clients — exactly the state during that gap.
    const a = await connect(port, "STALE-1", "Carl", "stale-token-0001");
    const inst = instances().get("STALE-1")! as unknown as {
      clients: { ws: WebSocket; playerId: number }[];
    };
    const client = inst.clients.find((c) => c.playerId === a.playerId)!;
    Object.defineProperty(client.ws, "readyState", { value: WebSocket.CLOSED, configurable: true });

    const b = await connect(port, "STALE-1", "Carl", "stale-token-0001");
    expect(b.playerId).toBe(a.playerId); // reclaimed, not shunted to a guest seat

    // Cleanup: `a`'s socket has a permanently-mocked readyState now, so its
    // own close handshake can't be relied on — just drop both raw sockets and
    // let the next test's fresh party code avoid any collision. afterAll's
    // server.close() force-terminates anything still open regardless.
    a.ws.terminate();
    b.close();
  });
});

describe("connection heartbeat", () => {
  // A separate server with a fast heartbeat interval so the tests don't wait
  // on the real HEARTBEAT_INTERVAL_MS (20s).
  let dir: string;
  let server: GameServer;
  let port: number;
  const instances = () =>
    (server as unknown as { instances: Map<string, { clients: { isAlive: boolean; ws: WebSocket }[] }> }).instances;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dcc-heartbeat-"));
    server = new GameServer(0, undefined, undefined, join(dir, "dcc.sqlite"), 100);
    await server.ready();
    port = server.port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("terminates a connection that missed its last heartbeat pong", async () => {
    // A hard network drop never sends a close frame at all — nothing short
    // of a heartbeat detects it. Force the exact state a missed pong leaves
    // behind (isAlive already false when the next sweep runs) rather than
    // fighting the ws library's own automatic ping/pong reply, which a
    // healthy test client can't easily suppress.
    const a = await connect(port, "ZOMBIE-1", "Carl", "zombie-token-0001");
    const client = instances().get("ZOMBIE-1")!.clients[0];
    client.isAlive = false;
    await waitFor(() => instances().size === 0, 2000);
    a.close();
  });

  it("does not terminate a connection that keeps responding to pings", async () => {
    await connect(port, "HEALTHY-1", "Carl", "healthy-token-0001");
    await new Promise((r) => setTimeout(r, 350)); // several heartbeat cycles at 100ms
    expect(instances().get("HEALTHY-1")?.clients.length).toBe(1);
  });
});

describe("observability: /metrics + usage events", () => {
  let dir: string;
  let server: GameServer;
  let port: number;
  const instances = () =>
    (server as unknown as { instances: Map<string, { state: GameState }> }).instances;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dcc-obs-"));
    server = new GameServer(0, undefined, undefined, join(dir, "dcc.sqlite"));
    await server.ready();
    port = server.port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const metric = (text: string, name: string): number => {
    const m = text.match(new RegExp(`^${name} (.+)$`, "m"));
    return m ? Number(m[1]) : NaN;
  };

  it("/metrics serves Prometheus series that move with real traffic", async () => {
    const c = await connect(port, "OBS-1", "Carl");
    await waitFor(() => c.lastSnap !== null);
    await new Promise((r) => setTimeout(r, 250)); // a few ticks + snapshots
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(text).toContain("# TYPE dcc_ticks_total counter");
    expect(text).toContain("# TYPE dcc_players_connected gauge");
    expect(metric(text, "dcc_joins_total")).toBeGreaterThanOrEqual(1);
    expect(metric(text, "dcc_players_connected")).toBe(1);
    expect(metric(text, "dcc_ticks_total")).toBeGreaterThan(0);
    expect(metric(text, "dcc_tick_ms_total")).toBeGreaterThan(0);
    expect(metric(text, "dcc_snapshot_bytes_total")).toBeGreaterThan(0);
    c.close();
    await waitFor(() => instances().size === 0);
    const after = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metric(after, "dcc_leaves_total")).toBeGreaterThanOrEqual(1);
    expect(metric(after, "dcc_players_connected")).toBe(0);
  });

  it("sessions and floor transitions land in usage_events with build summaries", async () => {
    const c = await connect(port, "OBS-2", "Carl", "obs-carl-token-1");
    // Stage a descent directly; the next tick sees the floor edge and logs it.
    instances().get("OBS-2")!.state.floor = 2;
    await waitFor(() => server.db!.listEvents("floor").some((e) => e.partyCode === "OBS-2"));
    c.close();
    await waitFor(() => instances().size === 0);

    const start = server.db!.listEvents("session_start").find((e) => e.partyCode === "OBS-2")!;
    expect(start.accountId).toBe("obs-carl-token-1");
    expect(start.data).toMatchObject({ name: "Carl", mode: "coop", partySize: 1 });

    const floor = server.db!.listEvents("floor").find((e) => e.partyCode === "OBS-2")!;
    const fd = floor.data as { floor: number; players: { name: string; level: number; slots: unknown[] }[] };
    expect(fd.floor).toBe(2);
    expect(fd.players[0].name).toBe("Carl");
    expect(fd.players[0].slots.length).toBe(4); // the build rides every row

    const end = server.db!.listEvents("session_end").find((e) => e.partyCode === "OBS-2")!;
    const ed = end.data as { seconds: number; player: { kills: number } };
    expect(ed.seconds).toBeGreaterThanOrEqual(0);
    expect(ed.player.kills).toBeGreaterThanOrEqual(0);
  });

  it("a run ending writes the outcome and the final builds, exactly once", async () => {
    const c = await connect(port, "OBS-3", "Donut");
    instances().get("OBS-3")!.state.status = "dead";
    await waitFor(() => server.db!.listEvents("run_end").some((e) => e.partyCode === "OBS-3"));
    await new Promise((r) => setTimeout(r, 150)); // more ticks: the edge must not re-fire
    const ends = server.db!.listEvents("run_end").filter((e) => e.partyCode === "OBS-3");
    expect(ends.length).toBe(1);
    const data = ends[0].data as { status: string; players: { name: string }[] };
    expect(data.status).toBe("dead");
    expect(data.players[0].name).toBe("Donut");
    c.close();
    await waitFor(() => instances().size === 0);
  });
});

describe("roam party cap", () => {
  let dir: string;
  let server: GameServer;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dcc-roamcap-"));
    server = new GameServer(0, undefined, undefined, join(dir, "dcc.sqlite"));
    await server.ready();
    port = server.port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a roam campaign seats 10; the 11th crawler is turned away", async () => {
    const crawlers: TestClient[] = [];
    for (let i = 0; i < 10; i++) {
      crawlers.push(await connect(port, "BIGBAND", `Crawler${i}`, `roam-cap-token-${i}0`, i === 0));
    }
    expect(new Set(crawlers.map((c) => c.playerId)).size).toBe(10);
    // Seat 11: the door is closed.
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("open", () => ws.send(JSON.stringify({ t: "join", code: "BIGBAND", name: "TooMany" })));
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg.t === "error") reject(new Error(msg.reason));
          else if (msg.t === "welcome") resolve(msg);
        });
      }),
    ).rejects.toThrow("party full");
    for (const c of crawlers) c.close();
  });
});

// ---- Golden fixture: a checked-in persisted world must stay loadable ----
//
// A Roam campaign snapshot written in week 1 must load in week 4 after the sim
// changed under it. If this test fails, the PR either needs optional-with-
// default treatment for its new GameState fields, or a SNAPSHOT_VERSION bump —
// then regenerate the fixture: npx tsx scripts/makeSnapshotFixture.ts

describe("persisted world snapshot (golden fixture)", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "world-snapshot.json"), "utf8"),
  ) as { version: number; snapshot: string };

  it("matches the current SNAPSHOT_VERSION", () => {
    expect(fixture.version).toBe(SNAPSHOT_VERSION);
  });

  it("deserializes and steps deterministically under today's sim", () => {
    const a = deserialize(fixture.snapshot);
    const b = deserialize(fixture.snapshot);
    const intent = { move: { x: 1, y: 0 }, attack: true, useStairs: false };
    for (let i = 0; i < 100; i++) {
      step(a, intent, 1 / 30);
      step(b, intent, 1 / 30);
    }
    expect(serialize(a)).toBe(serialize(b));
  });
});
