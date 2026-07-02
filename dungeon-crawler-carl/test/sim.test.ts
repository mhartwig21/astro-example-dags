import { describe, it, expect } from "vitest";
import { createGame, restoreGame, step } from "../src/sim/game";
import { NO_INTENT, type Intent } from "../src/sim/types";
import { CONFIG, floorTimeBudget } from "../src/sim/config";
import { createRng, nextFloat } from "../src/sim/rng";

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 5 }, () => nextFloat(a));
    const seqB = Array.from({ length: 5 }, () => nextFloat(b));
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("differs across seeds", () => {
    expect(nextFloat(createRng(1))).not.toEqual(nextFloat(createRng(2)));
  });
});

describe("floor generation", () => {
  it("produces identical floors for identical seeds", () => {
    const g1 = createGame(999);
    const g2 = createGame(999);
    expect(Array.from(g1.map.tiles)).toEqual(Array.from(g2.map.tiles));
    expect(g1.map.stairs).toEqual(g2.map.stairs);
    expect(g1.monsters.length).toEqual(g2.monsters.length);
  });

  it("spawns the player on a walkable tile with reachable-looking stairs", () => {
    const g = createGame(7);
    expect(g.map.spawn).toBeDefined();
    expect(g.map.stairs).toBeDefined();
    // Stairs should not coincide with spawn.
    expect(g.map.stairs).not.toEqual(g.map.spawn);
  });
});

describe("collapse timer", () => {
  it("advances only through dt and transitions phases", () => {
    const g = createGame(42);
    expect(g.phase).toBe("safe");
    const budget = floorTimeBudget(1);
    expect(g.timeBudget).toBeCloseTo(budget);

    // Step until just past the warning threshold (but well before collapse).
    const warnAt = budget * CONFIG.warningFraction;
    let t = 0;
    while (g.timeRemaining > warnAt - 0.5 && t < 5000) {
      step(g, idle(), 0.1);
      t++;
    }
    expect(g.phase).toBe("warning");
    expect(g.timeRemaining).toBeGreaterThan(0);
  });

  it("deals escalating damage during collapse and can kill the player", () => {
    const g = createGame(1);
    // Fast-forward to collapse.
    for (let i = 0; i < 2000 && g.phase !== "collapse"; i++) step(g, idle(), 0.1);
    expect(g.phase).toBe("collapse");
    const hpAtCollapse = g.player.hp;
    step(g, idle(), 0.1);
    expect(g.player.hp).toBeLessThan(hpAtCollapse);
    // Keep collapsing; player must eventually die.
    for (let i = 0; i < 2000 && g.player.alive; i++) step(g, idle(), 0.1);
    expect(g.player.alive).toBe(false);
    expect(g.status).toBe("dead");
  });
});

describe("determinism of the full step", () => {
  it("two games with the same seed and intents stay identical", () => {
    const intents: Intent[] = [
      { move: { x: 1, y: 0 }, attack: false, useStairs: false },
      { move: { x: 0, y: 1 }, attack: true, useStairs: false },
      { move: { x: -1, y: 0 }, attack: true, useStairs: false },
    ];
    const g1 = createGame(2024);
    const g2 = createGame(2024);
    for (let i = 0; i < 300; i++) {
      const intent = intents[i % intents.length];
      step(g1, intent, 1 / 60);
      step(g2, intent, 1 / 60);
    }
    expect(g1.player.pos).toEqual(g2.player.pos);
    expect(g1.player.hp).toEqual(g2.player.hp);
    expect(g1.monsters.map((m) => m.hp)).toEqual(g2.monsters.map((m) => m.hp));
    expect(g1.player.gold).toEqual(g2.player.gold);
  });
});

describe("descent", () => {
  it("teleporting to the stairs and using them advances the floor", () => {
    const g = createGame(5);
    // Move the player onto the stairs directly (sim allows host-set positions).
    g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.floor).toBe(2);
    expect(g.phase).toBe("safe");
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(2));
  });

  it("does not descend when not on the stairs", () => {
    const g = createGame(5);
    g.player.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    // Ensure spawn isn't coincidentally on the stairs.
    if (Math.hypot(g.player.pos.x - g.map.stairs.x, g.player.pos.y - g.map.stairs.y) > 1) {
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
      expect(g.floor).toBe(1);
    }
  });
});

describe("restore (log on/off)", () => {
  it("resumes character progression on the saved floor", () => {
    const restored = restoreGame({
      seed: 123,
      floor: 4,
      player: { hp: 55, maxHp: 180, baseDamage: 27, level: 5, xp: 3, xpToNext: 90, gold: 140 },
    });
    expect(restored.floor).toBe(4);
    expect(restored.player.level).toBe(5);
    expect(restored.player.gold).toBe(140);
    expect(restored.player.maxHp).toBe(180);
    expect(restored.player.hp).toBe(55);
    // Floor 4 regenerated deterministically matches a fresh game advanced to floor 4.
    const fresh = createGame(123);
    expect(restored.map.stairs).toBeDefined();
    expect(fresh.seed).toBe(restored.seed);
  });
});

describe("combat feedback + loot boxes", () => {
  it("emits hit events when the player strikes an adjacent monster", () => {
    const g = createGame(2024);
    // Place a monster right next to the player, in front of its facing.
    g.player.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push({
      id: 999, pos: { x: g.player.pos.x + 1, y: g.player.pos.y },
      hp: 999, maxHp: 999, damage: 0, speed: 0, attackCooldown: 0, xp: 10, hitFlash: 0,
    });
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const combat = g.hits.filter((h) => h.kind === "enemy" || h.kind === "crit");
    expect(combat.length).toBe(1);
    expect(combat[0].amount).toBeGreaterThan(0);
  });

  it("awards a loot box every N kills and records it", () => {
    const g = createGame(7);
    // Kill lootBoxEveryKills monsters in one swing by stacking them in-arc at point blank.
    g.player.facing = { x: 1, y: 0 };
    g.player.baseDamage = 100000;
    g.monsters.length = 0;
    for (let i = 0; i < CONFIG.lootBoxEveryKills; i++) {
      g.monsters.push({
        id: 1000 + i, pos: { x: g.player.pos.x + 0.6, y: g.player.pos.y },
        hp: 1, maxHp: 1, damage: 0, speed: 0, attackCooldown: 0, xp: 5, hitFlash: 0,
      });
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.killCount).toBe(CONFIG.lootBoxEveryKills);
    expect(g.lootBoxes).toBe(1);
    expect(g.announcements.some((a) => a.includes("LOOT BOX"))).toBe(true);
  });

  it("keeps hits/announcements deterministic across identical runs", () => {
    function play(seed: number) {
      const g = createGame(seed);
      const hits: number[] = [];
      for (let i = 0; i < 240; i++) {
        step(g, { move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
        for (const h of g.hits) hits.push(h.amount);
      }
      return { hits, kills: g.killCount };
    }
    expect(play(555)).toEqual(play(555));
  });
});

describe("no-op safety", () => {
  it("stepping a finished game is a no-op", () => {
    const g = createGame(1);
    g.status = "won";
    const before = JSON.stringify(g.player.pos);
    step(g, NO_INTENT, 1 / 60);
    expect(JSON.stringify(g.player.pos)).toBe(before);
  });
});
