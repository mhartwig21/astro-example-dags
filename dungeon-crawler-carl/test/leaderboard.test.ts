import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GameServer } from "../src/server/gameServer";
import { Leaderboard, rankEntries, type LbEntry } from "../src/server/leaderboard";
import { dailySeed, isValidDay, dayFromMs } from "../src/sim/daily";

// ---- The Daily Crawl: shared seed + score board ----

const DAY = "2026-07-05";
const NOW = Date.parse(`${DAY}T15:00:00Z`);

function entry(over: Partial<LbEntry> & { name: string }): LbEntry {
  return { floor: 5, won: false, timeSec: 600, kills: 40, at: 0, ...over };
}

describe("daily seed", () => {
  it("is deterministic per day and distinct across days", () => {
    expect(dailySeed("2026-07-05")).toBe(dailySeed("2026-07-05"));
    expect(dailySeed("2026-07-05")).not.toBe(dailySeed("2026-07-06"));
    expect(Number.isInteger(dailySeed("2026-07-05"))).toBe(true);
  });

  it("validates day strings strictly", () => {
    expect(isValidDay("2026-07-05")).toBe(true);
    expect(isValidDay("2026-7-5")).toBe(false);
    expect(isValidDay("yesterday")).toBe(false);
    expect(isValidDay("2026-13-40")).toBe(false);
  });

  it("derives the UTC day from a timestamp", () => {
    expect(dayFromMs(NOW)).toBe(DAY);
  });
});

describe("leaderboard ranking + validation", () => {
  it("ranks: full clears first, then depth, then speed", () => {
    const ranked = rankEntries([
      entry({ name: "slowpoke", won: true, floor: 18, timeSec: 4000 }),
      entry({ name: "deep", floor: 15 }),
      entry({ name: "shallow", floor: 3 }),
      entry({ name: "speedrun", won: true, floor: 18, timeSec: 2400 }),
    ]);
    expect(ranked.map((e) => e.name)).toEqual(["speedrun", "slowpoke", "deep", "shallow"]);
  });

  it("accepts a valid run and returns its rank", () => {
    const lb = new Leaderboard();
    expect(lb.submit(DAY, { name: "Carl", floor: 7, won: false, timeSec: 900, kills: 80 }, NOW)).toBe(1);
    expect(lb.submit(DAY, { name: "Donut", floor: 9, won: false, timeSec: 800, kills: 90 }, NOW)).toBe(1);
    expect(lb.get(DAY).map((e) => e.name)).toEqual(["Donut", "Carl"]);
  });

  it("keeps each crawler's best entry, not their latest", () => {
    const lb = new Leaderboard();
    lb.submit(DAY, { name: "Carl", floor: 9, won: false, timeSec: 900, kills: 80 }, NOW);
    lb.submit(DAY, { name: "Carl", floor: 4, won: false, timeSec: 300, kills: 10 }, NOW); // worse rerun
    expect(lb.get(DAY)).toHaveLength(1);
    expect(lb.get(DAY)[0].floor).toBe(9);
    lb.submit(DAY, { name: "Carl", floor: 18, won: true, timeSec: 2500, kills: 300 }, NOW); // improvement
    expect(lb.get(DAY)[0].won).toBe(true);
  });

  it("rejects malformed and stale submissions", () => {
    const lb = new Leaderboard();
    expect(lb.submit("nonsense", entry({ name: "x" }), NOW)).toBeNull();
    expect(lb.submit("2020-01-01", entry({ name: "x" }), NOW)).toBeNull(); // ancient day
    expect(lb.submit(DAY, { name: "", floor: 5, timeSec: 10, kills: 1 }, NOW)).toBeNull();
    expect(lb.submit(DAY, { name: "x", floor: 99, timeSec: 10, kills: 1 }, NOW)).toBeNull();
    expect(lb.submit(DAY, { name: "x", floor: 5, timeSec: -3, kills: 1 }, NOW)).toBeNull();
    expect(lb.submit(DAY, { name: "x", floor: 5, timeSec: 10, kills: NaN }, NOW)).toBeNull();
    expect(lb.get(DAY)).toHaveLength(0);
  });
});

describe("leaderboard over HTTP", () => {
  let server: GameServer;
  let base: string;

  beforeAll(async () => {
    server = new GameServer(0); // ephemeral port, no static dir, in-memory board
    await server.ready();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.close());

  it("POST records a run and GET returns the ranked board", async () => {
    const day = dayFromMs(Date.now());
    const post = await fetch(`${base}/leaderboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day, name: "Carl", floor: 12, won: false, timeSec: 1500, kills: 200 }),
    });
    expect(post.status).toBe(200);
    const posted = (await post.json()) as { ok: boolean; rank: number };
    expect(posted.ok).toBe(true);
    expect(posted.rank).toBe(1);

    const get = await fetch(`${base}/leaderboard?day=${day}`);
    expect(get.status).toBe(200);
    const board = (await get.json()) as { day: string; entries: { name: string; floor: number }[] };
    expect(board.day).toBe(day);
    expect(board.entries[0]).toMatchObject({ name: "Carl", floor: 12 });
  });

  it("rejects junk with 400", async () => {
    const bad = await fetch(`${base}/leaderboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: "never", name: "Carl", floor: 12 }),
    });
    expect(bad.status).toBe(400);
  });
});
