import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { GameServer, seedFromCode, dayFromDailyCode, MAX_PARTY_SIZE, HEARTBEAT_INTERVAL_MS } from "../src/server/gameServer";
import { dailySeed } from "../src/sim/daily";
import { dailyRuleFor } from "../src/sim/dailyRules";
import { serialize, deserialize, serializeDynamic, deserializeDynamic, mergeColdPlayers, mergeSlowState } from "../src/sim/snapshot";
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

  it("state slow split: breakables/roam data ship once, stay home, and merge forward", () => {
    const g = createGame(777, "coop", "roam");
    const cache = new Map<number, string>();
    // First dynamic snapshot with a cache: the slow block ships (baseline).
    const first = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(first.npc).toBeDefined(); // the wire marker field (null only in race mode)
    expect(first.breakables).toBeDefined();
    expect(first.settlements).toBeDefined();
    // Nothing changed: the whole block stays home.
    const second = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect((second as Partial<GameState>).npc).toBeUndefined();
    expect(second.breakables).toBeUndefined();
    expect(second.settlements).toBeUndefined();
    expect(second.quests).toBeUndefined();
    expect(second.players[0].hp).toBe(g.players[0].hp); // hot fields still ride
    // The client merges the block forward from its previous snapshot.
    mergeSlowState(second, first);
    expect(second.npc).toEqual(first.npc);
    expect(second.breakables).toEqual(first.breakables);
    expect(second.settlements).toEqual(first.settlements);
    // A change (a crate takes a hit) ships the whole block again.
    if (g.breakables?.[0]) g.breakables[0].hp -= 1;
    const third = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(third.npc).toBeDefined();
    expect(third.breakables).toBeDefined();
    // Without a cache (no per-client baseline: rivals, bare calls) it always ships.
    const bare = JSON.parse(serializeDynamic(g)) as GameState;
    expect(bare.npc).toBeDefined();
    expect(bare.breakables).toBeDefined();
  });

  it("dynamic snapshots carry no transients (the events channel owns them)", () => {
    const a = createGame(31337);
    drive(a, 120);
    a.events.push("a thing happened");
    a.announcements.push({ text: "A THING", kind: "flavor", priority: "normal" });
    a.hits.push({ pos: { x: 1, y: 1 }, amount: 5, kind: "enemy" });
    const dyn = JSON.parse(serializeDynamic(a)) as GameState;
    expect(dyn.events).toEqual([]);
    expect(dyn.announcements).toEqual([]);
    expect(dyn.hits).toEqual([]);
    // Full snapshots stay exact — they feed persistence + golden determinism.
    const full = JSON.parse(serialize(a)) as GameState;
    expect(full.events.length).toBe(1);
    expect(full.hits.length).toBe(1);
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

interface GateFrame {
  seats: { name: string; ready: boolean }[];
  msLeft: number;
  started?: boolean;
}

interface TestClient {
  ws: WebSocket;
  playerId: number;
  lastSnap: GameState | null;
  snaps: { full: boolean; bytes: number }[];
  events: string[];
  gates: GateFrame[]; // starting-gun frames (rivals pre-run hold)
  send: (msg: unknown) => void;
  close: () => void;
}

function connect(port: number, code: string, name: string, rivals = false, isPublic = false): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client: TestClient = {
      ws,
      playerId: -1,
      lastSnap: null,
      snaps: [],
      events: [],
      gates: [],
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
    ws.on("open", () => client.send({ t: "join", code, name, rivals: rivals || undefined, public: isPublic || undefined }));
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
      } else if (msg.t === "gate") {
        client.gates.push(msg as GateFrame);
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

type OpenParty = { code: string; players: number; cap: number; floor: number };
function openParties(port: number): Promise<OpenParty[]> {
  return fetch(`http://127.0.0.1:${port}/open-parties`).then((r) => r.json());
}
// Same shape as waitFor, but the condition itself is async (a fetch) — polls
// /open-parties until `code`'s presence matches `present`.
async function waitForOpenParty(port: number, code: string, present: boolean, ms = 4000): Promise<OpenParty | undefined> {
  const t0 = Date.now();
  for (;;) {
    const found = (await openParties(port)).find((p) => p.code === code);
    if (present ? found : !found) return found;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for open-parties state");
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

  it("Quick Join: /open-parties lists public co-op parties with free seats, joins one, and drops it once full", async () => {
    const priv = await connect(port, "PRIV-1", "Carl"); // ordinary private party — never listed
    const host = await connect(port, "OPEN-1", "Hostella", false, true);

    const entry = await waitForOpenParty(port, "OPEN-1", true);
    expect(entry).toEqual({ code: "OPEN-1", players: 1, cap: MAX_PARTY_SIZE, floor: 1 });
    expect((await openParties(port)).some((p) => p.code === "PRIV-1")).toBe(false);

    // A stranger joins straight off the listed code and lands in the same party.
    const joiner = await connect(port, entry!.code, "Stranger");
    await waitFor(() => (joiner.lastSnap?.players.length ?? 0) >= 2);
    expect(joiner.lastSnap!.seed).toBe(host.lastSnap!.seed);

    // Fill the remaining seats; at capacity the party drops off the list.
    const rest = await Promise.all(
      Array.from({ length: MAX_PARTY_SIZE - 2 }, (_, i) => connect(port, "OPEN-1", `Filler${i}`)),
    );
    await waitForOpenParty(port, "OPEN-1", false);

    priv.close();
    host.close();
    joiner.close();
    rest.forEach((c) => c.close());
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

  it("THE STARTING GUN: a fresh rivals race holds at second zero until every seat is ready", async () => {
    const a = await connect(port, "GUN-1", "Carl", true);
    const b = await connect(port, "GUN-1", "Donut");
    // Held: gate frames flow (seat list + countdown), the sim does not step —
    // no recurring snapshots, elapsed pinned at 0.
    await waitFor(() => {
      const holds = a.gates.filter((x) => !x.started);
      const g = holds[holds.length - 1];
      return !!g && g.seats.length === 2 && b.gates.some((x) => x.seats.length === 2);
    });
    expect(a.snaps.length).toBe(0); // no sim ticks broadcast while held
    const holds = a.gates.filter((x) => !x.started);
    const held = holds[holds.length - 1];
    expect(held.msLeft).toBeGreaterThan(0);
    expect(held.seats.map((s: { ready: boolean }) => s.ready)).toEqual([false, false]);
    // A private-code race is the base game: the READY card shows no rule.
    expect((held as { rule?: string | null }).rule ?? null).toBeNull();
    // Movement buffered at the gate must not smuggle a head start.
    a.send({ t: "intent", intent: { move: { x: 1, y: 0 }, attack: false, useStairs: false } });
    // One ready is not a gun; readiness is visible to the other seat.
    a.send({ t: "ready" });
    await waitFor(() => b.gates.some((g) => !g.started && g.seats.some((s) => s.ready)));
    expect(a.gates.some((g) => g.started)).toBe(false);
    // Second ready fires it: both clients see the gun and the sim starts
    // stepping from second zero for everyone.
    b.send({ t: "ready" });
    await waitFor(() => a.gates.some((g) => g.started) && b.gates.some((g) => g.started));
    await waitFor(() => a.snaps.length >= 2 && (a.lastSnap?.elapsed ?? 0) > 0);
    expect(a.lastSnap!.elapsed).toBeLessThan(3); // started at zero, not mid-race
    // The System called the start on the announcement rail.
    expect(a.events.some((e) => /THE GUN/i.test(e))).toBe(true);
    a.close();
    b.close();
  });

  it("THE STARTING GUN: the countdown expiring fires without unanimous ready", async () => {
    // Own server so the gate can be milliseconds long instead of a minute.
    const fast = new GameServer(0, undefined, undefined, undefined, HEARTBEAT_INTERVAL_MS, 350);
    await fast.ready();
    const c = await connect(fast.port, "GUN-2", "Slowpoke", true);
    await waitFor(() => c.gates.some((g) => g.started));
    await waitFor(() => (c.lastSnap?.elapsed ?? 0) > 0);
    c.close();
    fast.close();
  });

  it("THE STARTING GUN: co-op parties are never gated", async () => {
    const c = await connect(port, "GUN-3", "Carl"); // co-op: ticks immediately
    await waitFor(() => c.snaps.length >= 2);
    expect(c.gates.length).toBe(0);
    c.close();
  });

  it("THE LIVE DAILY: a DAILY-coded rivals race runs that day's dungeon under that day's rule", async () => {
    const day = "2026-08-04";
    expect(dayFromDailyCode(`DAILY-${day}-AB12`)).toBe(day);
    expect(dayFromDailyCode("PARTY-1")).toBeNull();
    expect(dayFromDailyCode("DAILY-9999-99-99-X")).toBeNull(); // nonsense dates fall back to code seeding
    const c = await connect(port, `DAILY-${day}-AB12`, "Carl", true);
    expect(c.lastSnap!.mode).toBe("rivals");
    expect(c.lastSnap!.seed).toBe(dailySeed(day)); // the dungeon IS the day's
    expect(c.lastSnap!.dailyRule).toBe(dailyRuleFor(day)); // and the rule rides the wire
    // The System announced the rule at second zero (welcome flush).
    await waitFor(() => c.events.some((e) => /TODAY'S RULE/.test(e)));
    // TODAY'S RULE ON THE READY CARD (NICHE.md §4.8): the gate is a modal and
    // modals hide the banner rail, so the gate frames themselves carry the
    // rule — the one surface every racer reads at second zero.
    await waitFor(() => c.gates.some((g) => !g.started && (g as { rule?: string | null }).rule === dailyRuleFor(day)));
    // A LATE JOINER of the held race still gets the rule DURABLY: the private
    // copy rides both channels — the banner for the moment, the event for the
    // #hud-log — because the gate outlives the banner (the critic's repro:
    // joiner polled 25s, rule text never visible, nothing in the log after).
    const late = await connect(port, `DAILY-${day}-AB12`, "Donut");
    await waitFor(() => late.events.some((e) => /TODAY'S RULE/.test(e)));
    await waitFor(() => late.gates.some((g) => !g.started && (g as { rule?: string | null }).rule === dailyRuleFor(day)));
    late.close();
    c.close();
    // A co-op party wearing the prefix is NOT a daily — the rush is a race.
    const coop = await connect(port, `DAILY-${day}-COOP`, "Donut");
    expect(coop.lastSnap!.seed).toBe(seedFromCode(`DAILY-${day}-COOP`));
    expect(coop.lastSnap!.dailyRule ?? null).toBeNull();
    coop.close();
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

describe("release infra: all-time boards, hygiene, OAuth (mock provider)", () => {
  let server: GameServer;
  let port: number;
  let dbFile: string;
  let mock: import("node:http").Server;
  let mockPort: number;

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dbFile = join(mkdtempSync(join(tmpdir(), "dcc-db-")), "test.sqlite");
    server = new GameServer(0, undefined, undefined, dbFile);
    await server.ready();
    port = server.port;

    // A fake OAuth provider: authorize is never fetched by the server (the
    // browser goes there); token + user endpoints are.
    const { createServer } = await import("node:http");
    mock = createServer((req, res) => {
      if (req.url?.startsWith("/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "prov-777", global_name: "Mock Crawler" }));
    });
    await new Promise<void>((r) => mock.listen(0, () => r()));
    mockPort = (mock.address() as { port: number }).port;
    server.auth.registerProvider("mock", {
      authUrl: `http://127.0.0.1:${mockPort}/authorize`,
      tokenUrl: `http://127.0.0.1:${mockPort}/token`,
      userUrl: `http://127.0.0.1:${mockPort}/user`,
      clientId: "cid", clientSecret: "sec", scope: "identify",
      identity: (u) => (typeof u.id === "string" ? { id: u.id, display: String(u.global_name) } : null),
    });
  });

  afterAll(() => {
    server.close();
    mock.close();
  });

  it("serves the legacy all-time boards read-only, labelled UNSEALED", async () => {
    // The only writer left is the server itself, vouching for a run its own
    // authoritative sim produced. There is no client-facing write path.
    server.leaderboard.submitAlltime({ name: "Carl", floor: 18, won: true, timeSec: 1500, kills: 300 }, Date.now());
    server.leaderboard.submitAlltime({ name: "Donut", floor: 12, won: false, timeSec: 900, kills: 450 }, Date.now());
    const deepest = await (await fetch(`http://127.0.0.1:${port}/leaderboard?cat=deepest`)).json();
    expect(deepest.entries[0].name).toBe("Carl");
    expect(deepest.unsealed).toBe(true);
    expect(deepest.note).toContain("LEGACY");
    const kills = await (await fetch(`http://127.0.0.1:${port}/leaderboard?cat=kills`)).json();
    expect(kills.entries[0].name).toBe("Donut");
    // fastest only ranks full clears.
    const fastest = await (await fetch(`http://127.0.0.1:${port}/leaderboard?cat=fastest`)).json();
    expect(fastest.entries.map((e: { name: string }) => e.name)).toEqual(["Carl"]);
  });

  it("the unauthenticated board write is GONE, flood or not", async () => {
    // The old hole: 12 forged rows a minute per IP, throttled but accepted.
    // Now nothing is accepted at all, so there is nothing left to throttle.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/leaderboard`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ board: "alltime", name: `Flood${i}`, floor: 18, won: true, timeSec: 60, kills: 9999 }),
      });
      codes.push(r.status);
    }
    expect(new Set(codes)).toEqual(new Set([410]));
    const deepest = await (await fetch(`http://127.0.0.1:${port}/leaderboard?cat=deepest`)).json();
    expect(deepest.entries.map((e: { name: string }) => e.name).join()).not.toContain("Flood");
  });

  it("OAuth: login redirects with a signed state; callback links the browser token", async () => {
    const login = await fetch(`http://127.0.0.1:${port}/auth/login/mock?token=browser-token-1234`, { redirect: "manual" });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location")!);
    expect(authorize.origin).toBe(`http://127.0.0.1:${mockPort}`);
    const state = authorize.searchParams.get("state")!;
    const cb = await fetch(`http://127.0.0.1:${port}/auth/callback/mock?code=xyz&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    const dest = new URLSearchParams(new URL(cb.headers.get("location")!).hash.replace(/^#/, ""));
    expect(dest.get("auth")).toBe("browser-token-1234"); // LINKED, not replaced
    expect(dest.get("who")).toBe("Mock Crawler");
  });

  it("OAuth: a known identity RECOVERS its account from any device", async () => {
    const login = await fetch(`http://127.0.0.1:${port}/auth/login/mock?token=some-other-device-9`, { redirect: "manual" });
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(`http://127.0.0.1:${port}/auth/callback/mock?code=xyz&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    const dest = new URLSearchParams(new URL(cb.headers.get("location")!).hash.replace(/^#/, ""));
    expect(dest.get("auth")).toBe("browser-token-1234"); // the ORIGINAL account
  });

  it("whoami reports identities + career stats; delete forgets everything", async () => {
    // Career stats only move on a VERIFIED run now, so the fixture writes the
    // aggregate the way the verifier does rather than through a forged POST.
    server.db?.bumpAccountStats("browser-token-1234", { won: false, floor: 9, kills: 55, timeSec: 700 }, Date.now());
    // ...and a legacy JSON row under the same crawler name, which is exactly
    // what FORGET ME could never reach: those rows key on the NAME.
    server.leaderboard.submitAlltime(
      { name: "Mock Crawler", floor: 9, won: false, timeSec: 700, kills: 55 }, Date.now(),
    );
    const who = await (await fetch(`http://127.0.0.1:${port}/auth/whoami?token=browser-token-1234`)).json();
    expect(who.identities.map((i: { provider: string }) => i.provider)).toContain("mock");
    expect(who.stats.runs).toBe(1);
    expect(who.stats.deepest).toBe(9);

    await fetch(`http://127.0.0.1:${port}/auth/delete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "browser-token-1234", names: ["Mock Crawler"] }),
    });
    const gone = await (await fetch(`http://127.0.0.1:${port}/auth/whoami?token=browser-token-1234`)).json();
    expect(gone.identities).toEqual([]);
    expect(gone.stats).toBeNull();
    // THE CASCADE (COMPETITIVE.md 1.2): the JSON board goes too.
    const deepest = await (await fetch(`http://127.0.0.1:${port}/leaderboard?cat=deepest`)).json();
    expect(deepest.entries.map((e: { name: string }) => e.name)).not.toContain("Mock Crawler");
  });

  it("tampered OAuth state is rejected", async () => {
    const cb = await fetch(`http://127.0.0.1:${port}/auth/callback/mock?code=xyz&state=forged.sig`, { redirect: "manual" });
    expect(new URL(cb.headers.get("location")!).hash).toContain("autherr");
  });
});

describe("POST /telemetry: the funnel's rungs land in usage_events (NICHE.md 4.2 + §7)", () => {
  let server: GameServer;
  let port: number;
  let dbFile: string;

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dbFile = join(mkdtempSync(join(tmpdir(), "dcc-telemetry-")), "test.sqlite");
    server = new GameServer(0, undefined, undefined, dbFile);
    await server.ready();
    port = server.port;
  });

  afterAll(() => server.close());

  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/telemetry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("accepts every funnel kind and keys it to the account", async () => {
    const token = "funnel-test-token-1234";
    for (const [kind, data] of [
      ["card_open", { seed: 42, cold: true, mobile: false, daily: false }],
      ["first_input", { msSinceOpen: 812 }],
      ["run_start", { seed: 42, kind: "random", fromCard: true }],
      ["run_end", { status: "dead", floor: 3 }],
      ["card_copy", { mode: "solo", seed: 42 }],
      ["door", { act: "runback", seed: 42 }],
    ] as const) {
      const r = await post({ kind, token, data });
      expect(r.status, kind).toBe(200);
    }
    const events = server.db!.listEvents();
    const kinds = events.map((e) => e.kind);
    for (const k of ["card_open", "first_input", "run_start", "run_end", "card_copy", "door"]) {
      expect(kinds).toContain(k);
    }
    // Keyed by account: the §7 funnel (cold open → first run → second run
    // within 24h) is a per-account query, so the token must survive the trip.
    expect(events.every((e) => e.accountId === token)).toBe(true);
    // The cold flag — the cohort the growth thesis is measured on — survives too.
    const open = events.find((e) => e.kind === "card_open")!;
    expect((open.data as { cold: boolean }).cold).toBe(true);
  });

  it("rejects kinds outside the allowlist — telemetry is not a free logging API", async () => {
    expect((await post({ kind: "evil", token: "t", data: {} })).status).toBe(400);
    expect((await post({ kind: 42, token: "t", data: {} })).status).toBe(400);
  });
});
