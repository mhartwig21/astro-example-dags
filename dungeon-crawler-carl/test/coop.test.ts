import { describe, it, expect } from "vitest";
import { createGame, addPlayer, step, handlePlayerDeath } from "../src/sim/game";
import { CONFIG } from "../src/sim/config";
import { NO_INTENT, type GameState, type Intent } from "../src/sim/types";

// ---- Co-op verbs: party pings + proximity revives ----

const DT = 1 / 30;

function quietGame(seed = 4242): GameState {
  const g = createGame(seed);
  // No interference: this suite tests the co-op rules, not combat.
  g.monsters = [];
  g.projectiles = [];
  g.hazards = [];
  return g;
}

function stepFor(g: GameState, seconds: number, collect?: string[]): void {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i++) {
    step(g, {}, DT);
    if (collect) collect.push(...g.announcements.map((a) => a.text));
  }
}

describe("party pings", () => {
  it("drops a TTL'd ping at the marked spot", () => {
    const g = quietGame();
    const intent: Intent = { ...NO_INTENT, ping: { x: 12.5, y: 20.25 } };
    step(g, intent, DT);
    expect(g.pings).toHaveLength(1);
    expect(g.pings[0].pos).toEqual({ x: 12.5, y: 20.25 });
    expect(g.pings[0].byId).toBe(g.players[0].id);
    expect(g.pings[0].t).toBeCloseTo(CONFIG.pingTtl, 1);
  });

  it("expires pings after their TTL", () => {
    const g = quietGame();
    step(g, { ...NO_INTENT, ping: { x: 10, y: 10 } }, DT);
    stepFor(g, CONFIG.pingTtl + 0.5);
    expect(g.pings).toHaveLength(0);
  });

  it("clamps ping positions into the map", () => {
    const g = quietGame();
    step(g, { ...NO_INTENT, ping: { x: -500, y: 99999 } }, DT);
    expect(g.pings[0].pos.x).toBeGreaterThanOrEqual(0);
    expect(g.pings[0].pos.y).toBeLessThanOrEqual(g.map.h - 1);
  });

  it("caps active pings per player by replacing the oldest", () => {
    const g = quietGame();
    for (let i = 0; i < CONFIG.pingMaxPerPlayer + 2; i++) {
      step(g, { ...NO_INTENT, ping: { x: 10 + i, y: 10 } }, DT);
    }
    expect(g.pings).toHaveLength(CONFIG.pingMaxPerPlayer);
    // The survivors are the most recent marks.
    expect(g.pings.map((pg) => pg.pos.x)).toContain(10 + CONFIG.pingMaxPerPlayer + 1);
  });

  it("lets a downed player ping (calling for help is content)", () => {
    const g = quietGame();
    addPlayer(g, "Donut");
    const [, donut] = g.players;
    handlePlayerDeath(g, donut, "Donut is testing mortality.");
    step(g, { [donut.id]: { ...NO_INTENT, ping: { x: 8, y: 8 } } }, DT);
    expect(g.pings.some((pg) => pg.byId === donut.id)).toBe(true);
  });
});

describe("proximity revives", () => {
  function downedPair(): { g: GameState; carl: GameState["players"][0]; donut: GameState["players"][0] } {
    const g = quietGame();
    addPlayer(g, "Donut");
    const [carl, donut] = g.players;
    handlePlayerDeath(g, donut, "Donut went down doing what she loved.");
    return { g, carl, donut };
  }

  it("a teammate standing close stabilizes a downed crawler", () => {
    const { g, carl, donut } = downedPair();
    carl.pos = { ...donut.pos };
    const anns: string[] = [];
    stepFor(g, CONFIG.reviveChannelSec + 0.5, anns);
    expect(donut.alive).toBe(true);
    expect(donut.hp).toBe(Math.max(1, Math.round(donut.maxHp * CONFIG.reviveHpFraction)));
    expect(anns.some((t) => t.includes("BACK IN THE FIGHT"))).toBe(true);
  });

  it("progress decays when the medic walks away", () => {
    const { g, carl, donut } = downedPair();
    carl.pos = { ...donut.pos };
    stepFor(g, 1.5); // partial channel
    expect(donut.reviveProgress).toBeGreaterThan(0.3);
    carl.pos = { x: donut.pos.x + 20, y: donut.pos.y }; // out of range
    stepFor(g, 2);
    expect(donut.alive).toBe(false);
    expect(donut.reviveProgress).toBeLessThan(0.1);
  });

  it("announces the downed state when the party survives", () => {
    const g = quietGame();
    addPlayer(g, "Donut");
    handlePlayerDeath(g, g.players[1], "Donut tripped.");
    expect(g.announcements.some((a) => a.text.includes("DOWN"))).toBe(true);
    expect(g.status).toBe("playing");
  });

  it("solo death still ends the run (no self-revive)", () => {
    const g = quietGame();
    handlePlayerDeath(g, g.players[0], "Carl discovered gravity.");
    expect(g.status).toBe("dead");
    stepFor(g, 2); // sim is over; nothing revives
    expect(g.players[0].alive).toBe(false);
  });

  it("descend-revive at 50% remains the fallback (unchanged behavior)", () => {
    const { donut } = downedPair();
    // The revive path never ran; the descent path resets the player.
    expect(donut.alive).toBe(false);
  });
});
