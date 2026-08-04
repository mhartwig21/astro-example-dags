/**
 * THE FRONT DOOR + THE CREW WIRE (NICHE.md 4.5 + 4.6).
 *
 * 4.5: RIVALS becomes findable — /open-parties stops filtering to co-op and
 * lists races while they are still FORMING (gate held, joinable at second
 * zero); /rush is the queue's one round trip (join target + the population's
 * clock + the honest between-windows data). The flip hour is a CONFIG: the
 * daily rotates in the population's evening, not at a principled UTC
 * midnight — and the daily EVENT flips with it, or the server would hold two
 * different "today"s.
 *
 * 4.6: an opt-in Discord webhook per crew — five events, rate-limited,
 * one-click revoke, kill switch, Discord-URLs-only (a server that POSTs
 * wherever a client asks is an SSRF primitive, not a feature).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { GameServer } from "../src/server/gameServer";
import { flipDayFromMs, flipOpensAtMs, msUntilFlip, parseFlipHour } from "../src/server/flip";
import { dailyEvent } from "../src/server/season";
import { dayFromMs, dailySeed } from "../src/sim/daily";
import {
  CrewStore, CrewWire, crewIdFromCode, nextWindowMs, validWebhook,
  WIRE_MIN_GAP_MS, type CrewRow,
} from "../src/server/crewWire";
import { handlePlayerDeath } from "../src/sim/game";
import type { GameState } from "../src/sim/types";

// ---- flip arithmetic (pure) ------------------------------------------------

describe("the flip hour is a config, not a constant (4.5)", () => {
  const noon = Date.parse("2026-08-04T12:00:00Z");

  it("flipHour 0 is exactly the old UTC-midnight day", () => {
    expect(flipDayFromMs(noon, 0)).toBe(dayFromMs(noon));
  });

  it("before the configured evening the dungeon is still YESTERDAY's", () => {
    // Flip at 19:00 UTC: at noon the 08-04 dungeon hasn't opened yet.
    expect(flipDayFromMs(noon, 19)).toBe("2026-08-03");
    expect(flipDayFromMs(Date.parse("2026-08-04T19:00:00Z"), 19)).toBe("2026-08-04");
    expect(flipDayFromMs(Date.parse("2026-08-04T18:59:59Z"), 19)).toBe("2026-08-03");
  });

  it("msUntilFlip counts down to the configured hour, not midnight", () => {
    expect(msUntilFlip(noon, 19)).toBe(7 * 3600_000);
    expect(msUntilFlip(noon, 0)).toBe(12 * 3600_000);
    expect(flipOpensAtMs("2026-08-04", 19)).toBe(Date.parse("2026-08-04T19:00:00Z"));
  });

  it("parseFlipHour: env strings clamp to a real hour, garbage means midnight", () => {
    expect(parseFlipHour("19")).toBe(19);
    expect(parseFlipHour("0")).toBe(0);
    expect(parseFlipHour("24")).toBe(0);
    expect(parseFlipHour("evening")).toBe(0);
    expect(parseFlipHour(undefined)).toBe(0);
  });

  it("the daily EVENT flips with the config — one server, one today", () => {
    const e = dailyEvent(noon, 19);
    expect(e.day).toBe("2026-08-03");
    expect(e.seed).toBe(dailySeed("2026-08-03"));
    expect(e.opensAt).toBe(Date.parse("2026-08-03T19:00:00Z"));
    expect(e.closesAt).toBe(Date.parse("2026-08-04T19:00:00Z"));
    // Default is the old behavior, byte for byte.
    const plain = dailyEvent(noon);
    expect(plain.day).toBe("2026-08-04");
    expect(plain.opensAt).toBe(Date.parse("2026-08-04T00:00:00Z"));
  });
});

// ---- wire client helper ------------------------------------------------------

interface Client {
  playerId: number;
  gates: { started?: boolean; seats: unknown[]; msLeft: number }[];
  send: (msg: unknown) => void;
  close: () => void;
}

function connect(port: number, code: string, name: string, rivals = false, isPublic = false): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client: Client = {
      playerId: -1,
      gates: [],
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    ws.on("open", () => client.send({ t: "join", code, name, rivals: rivals || undefined, public: isPublic || undefined }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "welcome") { client.playerId = msg.playerId; resolve(client); }
      if (msg.t === "gate") client.gates.push(msg);
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

interface RushView {
  ok: boolean; day: string; code: string; msToFlip: number; flipHourUtc: number;
  forming: { code: string; players: number; cap: number; mode: string; msLeft?: number }[];
  crawlers: number;
  windows: { crew: string; at: number }[];
}

// ---- the front door over HTTP ----------------------------------------------

describe("THE FRONT DOOR: /rush + /open-parties list forming races (4.5)", () => {
  let server: GameServer;
  let port: number;
  const posts: { url: string; content: string }[] = [];

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbFile = join(mkdtempSync(join(tmpdir(), "dcc-frontdoor-")), "test.sqlite");
    server = new GameServer(0, undefined, undefined, dbFile, undefined, undefined, {
      flipHourUtc: 0,
      wireEnabled: true,
      wirePost: async (url, content) => { posts.push({ url, content }); },
    });
    await server.ready();
    port = server.port;
  });

  afterAll(() => server.close());

  const rush = (): Promise<RushView> =>
    fetch(`http://127.0.0.1:${port}/rush`).then((r) => r.json() as Promise<RushView>);

  it("an empty queue is honest: countdown + a fresh DAILY code, no theater", async () => {
    const v = await rush();
    expect(v.ok).toBe(true);
    expect(v.forming).toEqual([]);
    // Open rushes default to TODAY'S dungeon (4.8): the minted code is a
    // daily code, so the instance seeds from dailySeed(day) + today's rule.
    expect(v.code.startsWith(`DAILY-${v.day}-RUSH-`)).toBe(true);
    expect(v.msToFlip).toBeGreaterThan(0);
    expect(v.msToFlip).toBeLessThanOrEqual(86_400_000);
  });

  it("a forming public race is findable, joinable, and disappears at the gun", async () => {
    const first = await rush();
    const a = await connect(port, first.code, "Carl", true, true);
    // The queue coalesces: the NEXT /rush points at the forming race.
    await waitFor(() => a.gates.length > 0);
    const v = await rush();
    expect(v.code).toBe(first.code);
    expect(v.forming.length).toBe(1);
    expect(v.forming[0].mode).toBe("rivals");
    expect(v.forming[0].players).toBe(1);
    expect(v.forming[0].cap).toBe(4);
    expect(v.forming[0].msLeft).toBeGreaterThan(0);
    // /open-parties lists it too — the co-op-only filter is gone.
    const open = (await (await fetch(`http://127.0.0.1:${port}/open-parties`)).json()) as
      { code: string; mode: string; msLeft?: number }[];
    const row = open.find((p) => p.code === first.code);
    expect(row?.mode).toBe("rivals");
    expect(row?.msLeft).toBeGreaterThan(0);
    // Second human joins through the front door and the gun fires.
    const b = await connect(port, v.code, "Donut", true);
    a.send({ t: "ready" });
    b.send({ t: "ready" });
    await waitFor(() => a.gates.some((g) => g.started === true));
    // A race whose gun has fired is NOT a door anymore.
    const after = await rush();
    expect(after.forming.find((p) => p.code === first.code)).toBeUndefined();
    const openAfter = (await (await fetch(`http://127.0.0.1:${port}/open-parties`)).json()) as { code: string }[];
    expect(openAfter.find((p) => p.code === first.code)).toBeUndefined();
    a.close();
    b.close();
  });

  it("private rivals codes are untouched: never listed, never the rush target", async () => {
    const a = await connect(port, "PRIVATE-RACE", "Carl", true, false);
    const v = await rush();
    expect(v.forming.find((p) => p.code === "PRIVATE-RACE")).toBeUndefined();
    expect(v.code).not.toBe("PRIVATE-RACE");
    const open = (await (await fetch(`http://127.0.0.1:${port}/open-parties`)).json()) as { code: string }[];
    expect(open.find((p) => p.code === "PRIVATE-RACE")).toBeUndefined();
    a.close();
  });

  it("RACE FORMING pings the wire once, at the second human, public races only (4.6 event 1)", async () => {
    // Register a crew so the wire has a channel.
    const reg = await fetch(`http://127.0.0.1:${port}/crew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "The Regulars", webhook: "https://discord.com/api/webhooks/123456/token-abc_DEF" }),
    });
    const crew = (await reg.json()) as { ok: boolean; crewId: string; revokeToken: string; codePrefix: string };
    expect(crew.ok).toBe(true);

    posts.length = 0;
    const v = await rush();
    const a = await connect(port, v.code, "Carl", true, true);
    await waitFor(() => a.gates.length > 0);
    expect(posts.length).toBe(0); // one human is not a scene
    const b = await connect(port, v.code, "Donut", true);
    await waitFor(() => posts.length === 1);
    expect(posts[0].url).toContain("discord.com/api/webhooks");
    expect(posts[0].content).toMatch(/RACE FORMING/);
    expect(posts[0].content).toContain(`join=${encodeURIComponent(v.code)}`);
    // A third seat does NOT re-ping (once per instance).
    const c = await connect(port, v.code, "Katia", true);
    await new Promise((r) => setTimeout(r, 200));
    expect(posts.length).toBe(1);
    a.close(); b.close(); c.close();
  });

  it("a CREW-coded race recaps to its crew — conceded seats included (4.6 event 5 / 4.7)", async () => {
    const reg = await fetch(`http://127.0.0.1:${port}/crew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Recap Crew", webhook: "https://discord.com/api/webhooks/999/tok" }),
    });
    const crew = (await reg.json()) as { crewId: string; codePrefix: string };
    const code = `${crew.codePrefix}TONIGHT`;
    expect(crewIdFromCode(code)).toBe(crew.crewId);

    const a = await connect(port, code, "Carl", true);
    const b = await connect(port, code, "Donut", true);
    a.send({ t: "ready" });
    b.send({ t: "ready" });
    await waitFor(() => a.gates.some((g) => g.started === true));

    const instances = (server as unknown as {
      instances: Map<string, { state: GameState }>;
    }).instances;
    const inst = instances.get(code)!;
    // Donut goes down, concedes, and walks — 4.7's exact case.
    const donut = inst.state.players.find((p) => p.id === b.playerId)!;
    handlePlayerDeath(inst.state, donut, "test blow");
    await waitFor(() => (inst.state.players.find((p) => p.id === b.playerId)?.downedT ?? 0) > 0);
    b.send({ t: "concede" });
    await waitFor(() => donut.conceded === true);
    b.close();

    posts.length = 0;
    // Wait past the wire's per-crew gap so the recap isn't rate-limited away.
    await new Promise((r) => setTimeout(r, 50));
    (server.crewWire as unknown as { lastPostAt: Map<string, number> }).lastPostAt.clear();
    inst.state.winnerId = a.playerId;
    inst.state.status = "won";
    await waitFor(() => posts.length === 1);
    expect(posts[0].url).toContain("/api/webhooks/999/");
    expect(posts[0].content).toMatch(/CARL TOOK THE DUNGEON/);
    expect(posts[0].content).toMatch(/Donut: .*\(CONCEDED\)/);
    expect(posts[0].content).toContain(`join=${encodeURIComponent(code)}`); // the rematch door
    a.close();
  });

  it("registration refuses non-Discord webhooks (SSRF is not a feature)", async () => {
    for (const bad of [
      "https://example.com/api/webhooks/1/x",
      "http://discord.com/api/webhooks/1/x",
      "https://discord.com.evil.io/api/webhooks/1/x",
      "https://127.0.0.1/api/webhooks/1/x",
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}/crew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "X", webhook: bad }),
      });
      expect(r.status).toBe(400);
    }
  });

  it("one click cuts the wire: /crew/revoke deletes the row", async () => {
    const reg = await fetch(`http://127.0.0.1:${port}/crew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Doomed", webhook: "https://discord.com/api/webhooks/42/tok" }),
    });
    const crew = (await reg.json()) as { crewId: string; revokeToken: string };
    expect(server.db!.crews.byId(crew.crewId)).not.toBeNull();
    const r = await fetch(`http://127.0.0.1:${port}/crew/revoke?k=${crew.revokeToken}`);
    expect(r.status).toBe(200);
    expect(server.db!.crews.byId(crew.crewId)).toBeNull();
    // A second click says so instead of pretending.
    const again = await fetch(`http://127.0.0.1:${port}/crew/revoke?k=${crew.revokeToken}`);
    expect(again.status).toBe(404);
  });
});

// ---- the wire's own discipline (pure, injected clock + transport) -----------

function crewRow(o: Partial<CrewRow> = {}): CrewRow {
  return {
    id: "ABCD1234", name: "The Regulars",
    webhookUrl: "https://discord.com/api/webhooks/1/tok",
    revokeToken: "a".repeat(32),
    windowDow: null, windowHour: null, createdAt: 0, ...o,
  };
}

function wireRig(rows: CrewRow[], enabled = true): {
  wire: CrewWire; posts: string[]; clock: { now: number };
} {
  const store = new CrewStore(new Database(":memory:"));
  for (const r of rows) store.register(r);
  const posts: string[] = [];
  const clock = { now: Date.parse("2026-08-04T12:00:00Z") };
  const wire = new CrewWire(store, {
    enabled,
    baseUrl: "https://x.test",
    post: async (_url, content) => { posts.push(content); },
    now: () => clock.now,
  });
  return { wire, posts, clock };
}

describe("the crew wire's discipline (4.6)", () => {
  it("webhook validation accepts real Discord shapes only", () => {
    expect(validWebhook("https://discord.com/api/webhooks/123/a-b_C")).toBe(true);
    expect(validWebhook("https://discordapp.com/api/webhooks/123/tok")).toBe(true);
    expect(validWebhook("https://discord.com/api/webhooks/123/tok?wait=true")).toBe(false);
    expect(validWebhook("ftp://discord.com/api/webhooks/1/x")).toBe(false);
    expect(validWebhook(42)).toBe(false);
  });

  it("rate limit: a second post inside the gap is dropped, not queued", () => {
    const { wire, posts, clock } = wireRig([crewRow()]);
    expect(wire.postTo(wire["store"].list()[0], "one")).toBe(true);
    expect(wire.postTo(wire["store"].list()[0], "two")).toBe(false);
    clock.now += WIRE_MIN_GAP_MS + 1;
    expect(wire.postTo(wire["store"].list()[0], "three")).toBe(true);
    expect(posts).toEqual(["one", "three"]);
  });

  it("kill switch: a disabled wire posts nothing, everywhere", () => {
    const { wire, posts, clock } = wireRig([crewRow()], false);
    wire.raceForming("DAILY-2026-08-04-RUSH-XX", 2, 4, 30_000);
    wire.dailyFlipped("2026-08-04", null);
    wire.sweep(clock.now, 0, () => null);
    expect(posts).toEqual([]);
  });

  it("the daily flip fires on the day EDGE — a boot never re-announces today", () => {
    const { wire, posts, clock } = wireRig([crewRow()]);
    wire.sweep(clock.now, 0, () => null); // boot: primes, no post
    expect(posts.length).toBe(0);
    clock.now += 3600_000;
    wire.sweep(clock.now, 0, () => null); // same day: silent
    expect(posts.length).toBe(0);
    clock.now = Date.parse("2026-08-05T00:00:30Z");
    wire.sweep(clock.now, 0, () => "THE SYSTEM CONGRATULATES: CARL — YESTERDAY'S DUNGEON, FLOOR 9 OF 18.");
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatch(/THE DUNGEON ROTATED/);
    expect(posts[0]).toMatch(/TODAY'S RULE/); // 2026-08-05 deals a rule
    expect(posts[0]).toMatch(/CONGRATULATES: CARL/); // the named winner rides along
  });

  it("the flip respects the configured hour", () => {
    const { wire, posts, clock } = wireRig([crewRow()]);
    clock.now = Date.parse("2026-08-04T18:00:00Z");
    wire.sweep(clock.now, 19, () => null); // primes on 08-03 (pre-flip)
    clock.now = Date.parse("2026-08-04T18:59:00Z");
    wire.sweep(clock.now, 19, () => null);
    expect(posts.length).toBe(0);
    clock.now = Date.parse("2026-08-04T19:00:30Z");
    wire.sweep(clock.now, 19, () => null);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("2026-08-04");
  });

  it("crew windows: 15 minutes out, then at the gun, each exactly once (4.5 layer 2)", () => {
    // 2026-08-04 is a Tuesday (UTC dow 2). Window: Tuesdays 21:00 UTC.
    const { wire, posts, clock } = wireRig([crewRow({ windowDow: 2, windowHour: 21 })]);
    expect(nextWindowMs(Date.parse("2026-08-04T12:00:00Z"), 2, 21))
      .toBe(Date.parse("2026-08-04T21:00:00Z"));
    wire.sweep(clock.now, 0, () => null); // noon: nothing
    expect(posts.length).toBe(0);
    clock.now = Date.parse("2026-08-04T20:46:00Z");
    wire.sweep(clock.now, 0, () => null);
    wire.sweep(clock.now + 30_000, 0, () => null); // sweep cadence: no double
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatch(/WINDOW OPENS IN 15 MINUTES/);
    clock.now = Date.parse("2026-08-04T21:00:15Z");
    wire.sweep(clock.now, 0, () => null);
    expect(posts.length).toBe(2);
    expect(posts[1]).toMatch(/THE WINDOW IS OPEN/);
    expect(posts[1]).toContain("join=CREW-ABCD1234-2026-08-04"); // the race code IS the recap link-back
    clock.now += 60_000;
    wire.sweep(clock.now, 0, () => null); // still inside grace: no repeat
    expect(posts.length).toBe(2);
    // The RUSH surface can see the calendar.
    const up = wire.upcomingWindows(Date.parse("2026-08-05T00:00:00Z"));
    expect(up.length).toBe(1);
    expect(up[0].at).toBe(Date.parse("2026-08-11T21:00:00Z"));
  });
});
