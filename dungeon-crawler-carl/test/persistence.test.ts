import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { GameServer } from "../src/server/gameServer";
import { openDb, type PersistDb } from "../src/server/db";
import { deserialize } from "../src/sim/snapshot";
import type { GameState } from "../src/sim/types";

// PERSISTENCE.md P1: accounts + character saves in SQLite. The DB layer is
// unit-tested against a temp file; the server tests drive the real protocol
// (join with a token, disconnect until the instance drops, rejoin) and assert
// the character comes back.

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
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name, token, roam: roam || undefined })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "welcome") {
        client.playerId = msg.playerId;
        client.token = msg.token;
        client.lastSnap = deserialize(msg.snapshot);
        resolve(client);
      } else if (msg.t === "snap") {
        client.lastSnap = deserialize(msg.snapshot);
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
});
