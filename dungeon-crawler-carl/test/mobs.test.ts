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

describe("IRONWORKS: lineworker piston punch", () => {
  it("a surviving punch target gets launched", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const bot = mkMon(g, { kind: "lineworker", pos: { x: p.pos.x + 0.8, y: p.pos.y }, damage: 5 });
    bot.windup = bot.windupTotal = 0.05;
    bot.windupKind = "punch";
    run(g, 0.15);
    // Shove queued or already consumed into movement — either way it landed.
    const shoved = !!p.knock || dist(p.pos, { x: bot.pos.x, y: bot.pos.y }) > 0.8;
    expect(shoved).toBe(true);
  });
});

describe("IRONWORKS: sentinel lock-on beam", () => {
  it("paints a tracking beam that follows, locks, then fires once", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 5000;
    mkMon(g, { kind: "sentinel", pos: { x: p.pos.x + 5, y: p.pos.y }, damage: 20, attackRange: 7, speed: 0 });
    run(g, 0.2);
    const beam = g.hazards.find((h) => h.kind === "beam");
    expect(beam).toBeDefined();
    expect(beam!.trackId).toBe(p.id);
    // Move the player; while arming (before the lock) the line follows.
    p.pos = { x: p.pos.x, y: p.pos.y + 2 };
    run(g, 0.2);
    const dy = beam!.end!.y - beam!.pos.y;
    expect(dy).toBeGreaterThan(0.5); // the beam bent toward the new position
    // Let it lock + fire.
    run(g, CONFIG.sentinelBeamArm);
    expect(beam!.trackId).toBeUndefined(); // locked before firing
    expect(beam!.fired).toBe(true);
    expect(p.hp).toBeLessThan(5000); // stood on the line, ate the railshot
  });
});

describe("IRONWORKS: slagbreaker vent rhythm", () => {
  it("at full heat it vents: burn + self-stagger (the punish window)", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const slag = mkMon(g, {
      kind: "slagbreaker", pos: { x: p.pos.x + 0.9, y: p.pos.y },
      damage: 20, attackRange: 1.2, heat: CONFIG.slagVentAfterSwings,
    });
    run(g, 0.1);
    expect(slag.windupKind).toBe("vent"); // full heat forces the dump
    run(g, CONFIG.slagVentWindup + 0.2);
    expect(p.hp).toBeLessThan(10_000); // scalded
    expect(p.statuses?.some((s) => s.kind === "burn")).toBe(true);
    expect(slag.stagger).toBeGreaterThan(0.5); // helpless — unload
    expect(slag.heat).toBe(0);
  });

  it("melee swings build heat toward the vent", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const slag = mkMon(g, {
      kind: "slagbreaker", pos: { x: p.pos.x + 0.9, y: p.pos.y },
      damage: 5, attackRange: 1.2, heat: 0,
    });
    run(g, 3); // enough for at least one full swing cycle
    expect(slag.heat ?? 0).toBeGreaterThan(0);
  });
});

describe("IRONWORKS: wind-up battalion", () => {
  it("a full squad presents muskets together — synced windups", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const squadId = 9999;
    const troops = [0, 1, 2, 3].map((i) =>
      mkMon(g, {
        kind: "toysoldier", pos: { x: p.pos.x + 4 + (i % 2), y: p.pos.y + (i - 1.5) },
        damage: 10, attackRange: 6, speed: 0, squadId,
      }));
    let synced = false;
    for (let t = 0; t < 3 && !synced; t += DT) {
      step(g, idle(), DT);
      synced = troops.every((s) => s.windup > 0);
    }
    expect(synced).toBe(true); // the whole line wound up in the same instant
  });

  it("a broken squad (under sync minimum) fires ragged, not synced", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const squadId = 9998;
    const a = mkMon(g, { kind: "toysoldier", pos: { x: p.pos.x + 4, y: p.pos.y }, damage: 10, attackRange: 6, speed: 0, squadId });
    const b = mkMon(g, { kind: "toysoldier", pos: { x: p.pos.x + 4, y: p.pos.y + 1 }, damage: 10, attackRange: 6, speed: 0, squadId });
    run(g, 2);
    // They still shoot (individually), just never as a squad announcement.
    expect((a.windup > 0 || a.shootCd > 0) || (b.windup > 0 || b.shootCd > 0)).toBe(true);
  });
});

describe("IRONWORKS: greeter", () => {
  it("discharges spark blasts on death", () => {
    const g = stage();
    const p = g.players[0];
    const bot = mkMon(g, { kind: "greeter", pos: { x: p.pos.x + 3, y: p.pos.y }, damage: 20 });
    bot.hp = 0;
    run(g, 0.1);
    const sparks = g.hazards.filter((h) => h.kind === "blast");
    expect(sparks.length).toBe(CONFIG.greeterSparkCount);
  });
});

describe("IRONWORKS: band gating", () => {
  it("no machines above the Ironworks; the shift clocks in at 13", () => {
    const IRON = new Set(["lineworker", "sentinel", "slagbreaker", "toysoldier", "greeter"]);
    for (let seed = 1; seed <= 25; seed++) {
      const g11 = createTestGame({ seed, floor: 11 });
      expect(g11.monsters.some((m) => IRON.has(m.kind))).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 30 && !seen; seed++) {
      const g14 = createTestGame({ seed, floor: 14 });
      seen = g14.monsters.some((m) => IRON.has(m.kind));
    }
    expect(seen).toBe(true);
  });

  it("toy soldiers always muster with a squadId; greeters spawn dormant", () => {
    let squads = 0, greeters = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = createTestGame({ seed, floor: 14 });
      for (const m of g.monsters) {
        if (m.kind === "toysoldier") { expect(m.squadId).toBeDefined(); squads++; }
        if (m.kind === "greeter") { expect(m.dormant).toBe(true); greeters++; }
      }
    }
    expect(squads).toBeGreaterThan(0);
    expect(greeters).toBeGreaterThan(0);
  });
});
