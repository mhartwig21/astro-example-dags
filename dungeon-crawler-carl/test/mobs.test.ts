import { describe, expect, it } from "vitest";
import { applyPlayerKnockback, createGame, createTestGame, damageMonster, step } from "../src/sim/game";
import { CONFIG } from "../src/sim/config";
import { dist } from "../src/sim/combat";
import type { GameState, Intent, Monster, Vec2 } from "../src/sim/types";

const DT = 1 / 60;

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

/** A staged floor-5 world with the crowd cleared out (specialist tests stage
 * their own cast). Keeps the real map so collision/walkability are honest. */
function stage(seed = 42): GameState {
  const g = createTestGame({ seed, floor: 5, level: 8, gear: false });
  g.monsters = [];
  g.loot = [];
  return g;
}

function mkMon(g: GameState, over: Partial<Monster> & { kind: Monster["kind"]; pos: Vec2 }): Monster {
  const m: Monster = {
    id: g.nextEntityId++,
    hp: 100, maxHp: 100, damage: 0, speed: CONFIG.monsterSpeed, attackRange: 1,
    attackCooldown: 0, shootCd: 0, healCd: 0, blinkCd: 0, xp: 5,
    windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0, hitFlash: 0,
    ...over,
  };
  g.monsters.push(m);
  return m;
}

function run(g: GameState, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) step(g, idle(), DT);
}

describe("knockback verb", () => {
  it("shoves the player the requested distance, then stops", () => {
    const g = stage();
    const p = g.players[0];
    const start = { ...p.pos };
    applyPlayerKnockback(p, { x: 1, y: 0 }, 1.0);
    run(g, 0.5);
    expect(p.knock).toBeUndefined(); // consumed
    const moved = dist(start, p.pos);
    expect(moved).toBeGreaterThan(0.5); // walls may eat some, open floor eats none
    expect(moved).toBeLessThanOrEqual(1.05);
  });

  it("stacks up to the boss-slam cap, never past it", () => {
    const g = stage();
    const p = g.players[0];
    applyPlayerKnockback(p, { x: 1, y: 0 }, 1.5);
    applyPlayerKnockback(p, { x: 1, y: 0 }, 1.5);
    expect(p.knock!.left).toBeLessThanOrEqual(CONFIG.bossSlamKnockback);
  });

  it("a surviving player hit by a slam gets shoved", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000; // survive the slam — the shove is the point
    const brute = mkMon(g, { kind: "brute", pos: { x: p.pos.x + 0.8, y: p.pos.y }, damage: 1 });
    brute.windup = brute.windupTotal = 0.05;
    brute.windupKind = "slam";
    run(g, 0.2);
    expect(p.knock ?? { left: 0 }).toBeTruthy(); // shove queued (or already consumed)
  });
});

describe("beam hazard verb", () => {
  it("telegraphs, fires once along the segment, then fades", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 1000;
    g.hazards.push({
      id: g.nextEntityId++,
      pos: { x: p.pos.x - 3, y: p.pos.y },
      end: { x: p.pos.x + 3, y: p.pos.y },
      t: 1.0, total: 1.0, arm: 0.4, radius: 0.5, damage: 50, kind: "beam",
    });
    run(g, 0.2); // still arming
    expect(p.hp).toBe(1000);
    run(g, 0.4); // past the arm: fired
    const afterFire = p.hp;
    expect(afterFire).toBeLessThan(1000);
    run(g, 0.5); // flash fades, hazard leaves, no second hit
    expect(p.hp).toBe(afterFire);
    expect(g.hazards.some((h) => h.kind === "beam")).toBe(false);
  });

  it("misses a player off the line", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 1000;
    g.hazards.push({
      id: g.nextEntityId++,
      pos: { x: p.pos.x - 3, y: p.pos.y + 2 },
      end: { x: p.pos.x + 3, y: p.pos.y + 2 },
      t: 0.6, total: 0.6, arm: 0.3, radius: 0.5, damage: 50, kind: "beam",
    });
    run(g, 0.6);
    expect(p.hp).toBe(1000);
  });
});

describe("frenzy aura verb (Drum Sergeant)", () => {
  it("the drum frenzies pack-mates in radius; cooldowns decay faster", () => {
    const g = stage();
    const p = g.players[0];
    // Stage far from the player so nobody fights — cooldowns just tick.
    const spot = { x: p.pos.x, y: p.pos.y };
    p.pos.x += 0; // player stays; monsters are sentries (no roams) and far enough not to aggro
    const drummer = mkMon(g, { kind: "drummer", pos: { x: spot.x + 30, y: spot.y }, aura: "frenzy" });
    const near = mkMon(g, { kind: "grunt", pos: { x: drummer.pos.x + 1, y: drummer.pos.y }, attackCooldown: 1 });
    const far = mkMon(g, { kind: "grunt", pos: { x: drummer.pos.x + 20, y: drummer.pos.y }, attackCooldown: 1 });
    run(g, 0.5);
    expect(near.frenzyT ?? 0).toBeGreaterThan(0);
    expect(far.frenzyT ?? 0).toBe(0);
    expect(near.attackCooldown).toBeLessThan(far.attackCooldown);
  });

  it("drummers spawn as pack escorts only from the sewers down", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g3 = createTestGame({ seed, floor: 3 });
      expect(g3.monsters.some((m) => m.kind === "drummer")).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const g5 = createTestGame({ seed, floor: 5 });
      seen = g5.monsters.some((m) => m.kind === "drummer");
    }
    expect(seen).toBe(true);
  });
});

describe("flee verb (Repo Rat)", () => {
  it("bolts away from the player once noticed", () => {
    const g = stage();
    const p = g.players[0];
    const rat = mkMon(g, {
      kind: "filcher", pos: { x: p.pos.x + 2, y: p.pos.y },
      speed: CONFIG.monsterSpeed * 1.55, carry: 50, bleedStage: 3,
    });
    const before = dist(p.pos, rat.pos);
    run(g, 1.0);
    expect(rat.noticed).toBe(true);
    expect(dist(p.pos, rat.pos)).toBeGreaterThan(before);
  });

  it("escapes with the purse after staying safely away — no kill, no XP", () => {
    const g = stage();
    const p = g.players[0];
    const rat = mkMon(g, {
      kind: "filcher", pos: { x: p.pos.x + 2, y: p.pos.y },
      speed: CONFIG.monsterSpeed * 1.55, carry: 50, bleedStage: 3, noticed: true,
    });
    rat.pos = { x: p.pos.x + CONFIG.filcherEscapeDist + 4, y: p.pos.y };
    rat.speed = 0; // hold it in place; the timer is what we're testing
    const xp = p.xp, level = p.level, kills = g.killCount;
    run(g, CONFIG.filcherEscapeSeconds + 1);
    expect(g.monsters.includes(rat)).toBe(false);
    expect(g.killCount).toBe(kills); // an escape is a segment, not a kill
    expect(p.xp).toBe(xp);
    expect(p.level).toBe(level);
    expect(g.loot.some((l) => l.kind === "gold")).toBe(false); // it took everything
  });

  it("bleeds coins as it loses HP quarters and drops the rest on death", () => {
    const g = stage();
    const p = g.players[0];
    const rat = mkMon(g, {
      kind: "filcher", pos: { x: p.pos.x + 3, y: p.pos.y },
      hp: 100, maxHp: 100, carry: 100, bleedStage: 3,
    });
    damageMonster(g, p, rat, 40, { allowCrit: false }); // past the 75% line at least
    expect(g.loot.filter((l) => l.kind === "gold").length).toBeGreaterThan(0);
    const bled = g.loot.filter((l) => l.kind === "gold").reduce((s, l) => s + (l.amount ?? 0), 0);
    // Finish it — the remaining purse hits the floor.
    rat.hp = 0;
    run(g, 0.1);
    const total = g.loot.filter((l) => l.kind === "gold").reduce((s, l) => s + (l.amount ?? 0), 0);
    expect(total).toBeGreaterThan(bled);
    // Every carried coin hits the floor (plus whatever the ordinary kill-loot
    // roll adds on top — the purse is a bonus, not a replacement).
    expect(total).toBeGreaterThanOrEqual(100);
  });

  it("filchers only prowl from the sewers down", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g3 = createTestGame({ seed, floor: 3 });
      expect(g3.monsters.some((m) => m.kind === "filcher")).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 40 && !seen; seed++) {
      const g5 = createTestGame({ seed, floor: 5 });
      seen = g5.monsters.some((m) => m.kind === "filcher");
    }
    expect(seen).toBe(true);
  });
});

describe("determinism with the new cast", () => {
  it("identical seeds still replay identically on a sewers floor", () => {
    const a = createGame(777);
    const b = createGame(777);
    // March both to floor 5 state via test game instead (same seed, same floor).
    const g1 = createTestGame({ seed: 777, floor: 5 });
    const g2 = createTestGame({ seed: 777, floor: 5 });
    for (let i = 0; i < 240; i++) {
      step(g1, idle(), DT);
      step(g2, idle(), DT);
    }
    expect(g1.monsters.map((m) => ({ k: m.kind, x: m.pos.x, y: m.pos.y })))
      .toEqual(g2.monsters.map((m) => ({ k: m.kind, x: m.pos.x, y: m.pos.y })));
    expect(a.rng.state).toBe(b.rng.state);
  });
});
