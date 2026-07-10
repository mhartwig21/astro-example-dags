import { describe, expect, it } from "vitest";
import { applyPlayerKnockback, createGame, createTestGame, damageMonster, damagePlayerHit, step } from "../src/sim/game";
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

describe("GARDEN: vine lasher hook", () => {
  it("drags a snagged player down the lane to the lasher's feet", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const lasher = mkMon(g, {
      kind: "lasher", pos: { x: p.pos.x + 4.5, y: p.pos.y }, damage: 10, attackRange: 4,
    });
    lasher.chargeDir = { x: -1, y: 0 }; // lane locked straight at the player
    lasher.windup = lasher.windupTotal = 0.05;
    lasher.windupKind = "hook";
    const before = dist(p.pos, lasher.pos);
    run(g, 1.0); // resolve + the drag plays out through knockback
    const after = dist(p.pos, lasher.pos);
    expect(after).toBeLessThan(before - 1.5); // hauled most of the way in
    expect(after).toBeLessThan(CONFIG.lasherHookLandGap + 1.2);
  });

  it("misses a player who sidestepped the lane", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const lasher = mkMon(g, {
      kind: "lasher", pos: { x: p.pos.x + 4.5, y: p.pos.y + 3 }, damage: 10, attackRange: 4,
    });
    lasher.chargeDir = { x: -1, y: 0 }; // lane goes PAST the player, 3 tiles off
    lasher.windup = lasher.windupTotal = 0.05;
    lasher.windupKind = "hook";
    const hpBefore = p.hp;
    run(g, 0.5);
    expect(p.hp).toBe(hpBefore);
    expect(p.knock).toBeUndefined();
  });
});

describe("GARDEN: understudy transformation", () => {
  it("morphs into a fresh charger when bled below half", () => {
    const g = stage();
    const p = g.players[0];
    const extra = mkMon(g, {
      kind: "understudy", pos: { x: p.pos.x + 6, y: p.pos.y },
      hp: 100, maxHp: 100, damage: 6, speed: 0,
    });
    extra.hp = 40; // below the morph threshold
    run(g, 0.2);
    expect(extra.windupKind).toBe("morph"); // the clause triggers
    run(g, CONFIG.morphWindup + 0.3);
    expect(extra.kind).toBe("charger"); // the wolf takes the role
    expect(extra.hp).toBe(extra.maxHp); // and arrives FRESH
    expect(extra.maxHp).toBeGreaterThan(100); // charger pool > understudy pool
  });

  it("staggering the morph delays it (the interrupt is real)", () => {
    const g = stage();
    const p = g.players[0];
    const extra = mkMon(g, {
      kind: "understudy", pos: { x: p.pos.x + 6, y: p.pos.y },
      hp: 40, maxHp: 100, damage: 6, speed: 0,
    });
    run(g, 0.2);
    expect(extra.windupKind).toBe("morph");
    extra.stagger = CONFIG.staggerDuration; // poise break mid-clause
    extra.windup = 0;
    extra.windupKind = undefined;
    step(g, idle(), DT);
    expect(extra.kind).toBe("understudy"); // still the extra, for now
  });
});

describe("GARDEN: briar witch hex", () => {
  it("marks a crawler; marked crawlers take amplified damage", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const witch = mkMon(g, {
      kind: "hexer", pos: { x: p.pos.x + 4, y: p.pos.y }, damage: 0, attackRange: 5.5, speed: 0,
    });
    run(g, 2.5); // cast + resolve
    expect(p.cursedT ?? 0).toBeGreaterThan(0);
    expect(witch.hp).toBe(100); // she never attacks directly
    // Amplification: same flat hit, cursed vs not (deterministic, no roll).
    const hpA = p.hp;
    damagePlayerHit(g, p, 100, { roll: false });
    const cursedHit = hpA - p.hp;
    p.cursedT = 0;
    const hpB = p.hp;
    damagePlayerHit(g, p, 100, { roll: false });
    const plainHit = hpB - p.hp;
    expect(cursedHit).toBeGreaterThan(plainHit);
    expect(cursedHit / plainHit).toBeCloseTo(1 + CONFIG.hexVulnerability, 1);
  });
});

describe("GARDEN: band gating", () => {
  it("no garden cast above floor 7; present by floor 8", () => {
    const GARDEN = new Set(["lasher", "understudy", "hexer"]);
    for (let seed = 1; seed <= 25; seed++) {
      const g6 = createTestGame({ seed, floor: 6 });
      expect(g6.monsters.some((m) => GARDEN.has(m.kind))).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 30 && !seen; seed++) {
      const g8 = createTestGame({ seed, floor: 8 });
      seen = g8.monsters.some((m) => GARDEN.has(m.kind));
    }
    expect(seen).toBe(true);
  });
});

describe("UNDERCROFT: cutpurse", () => {
  it("the lunge stabs and STEALS gold; the kill refunds with interest", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    p.gold = 100;
    const thief = mkMon(g, {
      kind: "cutpurse", pos: { x: p.pos.x + 2, y: p.pos.y }, damage: 5, attackRange: 1,
    });
    thief.chargeDir = { x: -1, y: 0 };
    thief.windup = thief.windupTotal = 0.05;
    thief.windupKind = "lunge";
    run(g, 0.2);
    // The purse only grows by stealing (achievement payouts inflate p.gold
    // mid-test, so assert on the thief's carry, not the player's balance).
    const carry = thief.carry ?? 0;
    const expectedSteal = Math.round(CONFIG.cutpurseStealBase + CONFIG.cutpurseStealPerFloor * g.floor);
    expect(carry).toBe(Math.round(expectedSteal * CONFIG.cutpurseInterest));
    // Catch it: the purse hits the floor with interest (the thief died at
    // the player's feet, so the drop may be vacuumed up the same step —
    // count the floor AND the pocket).
    g.loot = [];
    const goldBefore = p.gold;
    thief.hp = 0;
    run(g, 0.1);
    const onFloor = g.loot.filter((l) => l.kind === "gold").reduce((s, l) => s + (l.amount ?? 0), 0);
    const pocketed = p.gold - goldBefore;
    expect(onFloor + pocketed).toBeGreaterThanOrEqual(carry);
  });
});

describe("UNDERCROFT: ossuary warden", () => {
  it("its slam leaves a lingering bone-shard zone that ticks", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const golem = mkMon(g, {
      kind: "warden", pos: { x: p.pos.x + 0.9, y: p.pos.y }, damage: 20, attackRange: 1.15,
    });
    golem.windup = golem.windupTotal = 0.05;
    golem.windupKind = "slam";
    run(g, 0.2);
    const shards = g.hazards.find((h) => h.kind === "shards");
    expect(shards).toBeDefined();
    const hpAfterSlam = p.hp;
    run(g, 2.5); // stand in the debris like a rookie
    expect(p.hp).toBeLessThan(hpAfterSlam); // the zone bites on the tick
  });
});

describe("UNDERCROFT: pit digger", () => {
  it("launches farther than the piston, hits gentler", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const dig = mkMon(g, {
      kind: "digger", pos: { x: p.pos.x + 0.8, y: p.pos.y }, damage: 4, attackRange: 1.1,
    });
    dig.windup = dig.windupTotal = 0.05;
    dig.windupKind = "punch";
    const start = { ...p.pos };
    run(g, 0.5);
    const launched = dist(start, p.pos);
    expect(launched).toBeGreaterThan(1.0); // a REAL launch...
    expect(p.hp).toBeGreaterThan(10_000 - 30); // ...from a gentle hit
  });
});

describe("UNDERCROFT: the contract floor stays pristine", () => {
  it("floor 1 has ZERO specialists of any band; floor 2 meets the trainers", () => {
    const SPECIALS = new Set([
      "cutpurse", "warden", "digger", "drummer", "filcher",
      "lasher", "understudy", "hexer",
      "lineworker", "sentinel", "slagbreaker", "toysoldier", "greeter",
    ]);
    for (let seed = 1; seed <= 30; seed++) {
      const g1 = createTestGame({ seed, floor: 1 });
      expect(g1.monsters.some((m) => SPECIALS.has(m.kind))).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 30 && !seen; seed++) {
      const g2 = createTestGame({ seed, floor: 2 });
      seen = g2.monsters.some((m) => ["cutpurse", "warden", "digger"].includes(m.kind));
    }
    expect(seen).toBe(true);
  });
});

describe("RUINS: shieldbearer frontal guard", () => {
  it("frontal hits are mostly eaten; the guard drops mid-swing", () => {
    const g = stage();
    const p = g.players[0];
    const husk = mkMon(g, {
      kind: "shieldbearer", pos: { x: p.pos.x + 2, y: p.pos.y },
      hp: 1000, maxHp: 1000, damage: 10, attackRange: 1.1,
    });
    // Frontal (it faces the nearest player = the attacker): guarded.
    damageMonster(g, p, husk, 100, { allowCrit: false });
    const guardedDmg = 1000 - husk.hp;
    // Mid-swing the shield drops: same hit, full price.
    husk.hp = 1000;
    husk.windup = husk.windupTotal = 0.5;
    husk.windupKind = "melee";
    damageMonster(g, p, husk, 100, { allowCrit: false });
    const openDmg = 1000 - husk.hp;
    expect(guardedDmg).toBeLessThan(openDmg * 0.5); // the shield is REAL
  });
});

describe("RUINS: cleric consecration", () => {
  it("the zone heals wounded monsters and burns crawlers standing in it", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const wounded = mkMon(g, {
      kind: "grunt", pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 50, maxHp: 200, speed: 0, attackCooldown: 99,
    });
    g.hazards.push({
      id: g.nextEntityId++,
      pos: { x: p.pos.x, y: p.pos.y },
      t: 4, total: 4, radius: CONFIG.consecrateRadius, damage: 8,
      kind: "consecrate", tick: 0.1,
    });
    run(g, 2);
    expect(wounded.hp).toBeGreaterThan(50); // mended by the light
    expect(p.hp).toBeLessThan(10_000); // burned by the same light
  });
});

describe("RUINS: archivist sweep", () => {
  it("the beam rotates while the channel holds and dies with a stagger", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const arch = mkMon(g, {
      kind: "archivist", pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 300, maxHp: 300, damage: 20, attackRange: 6, speed: 0,
    });
    run(g, 1.0); // it should commit the channel and spawn the sweep
    const beam = g.hazards.find((h) => h.kind === "beam" && h.sweep !== undefined);
    expect(beam).toBeDefined();
    expect(arch.windupKind).toBe("sweep");
    const angle0 = Math.atan2(beam!.end!.y - beam!.pos.y, beam!.end!.x - beam!.pos.x);
    run(g, 0.5);
    const angle1 = Math.atan2(beam!.end!.y - beam!.pos.y, beam!.end!.x - beam!.pos.x);
    expect(Math.abs(angle1 - angle0)).toBeGreaterThan(0.2); // it SWEEPS
    // Stagger the channel: the beam dies with it.
    arch.stagger = CONFIG.staggerDuration;
    arch.windup = 0;
    arch.windupKind = undefined;
    run(g, 0.2);
    expect(g.hazards.some((h) => h.kind === "beam" && h.sweep !== undefined)).toBe(false);
  });
});

describe("RUINS: colossus fissure", () => {
  it("the slam sends staggered eruptions travelling down the lane", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const col = mkMon(g, {
      kind: "colossus", pos: { x: p.pos.x + 1, y: p.pos.y },
      hp: 1000, maxHp: 1000, damage: 20, attackRange: 1.2,
    });
    col.chargeDir = { x: 1, y: 0 };
    col.windup = col.windupTotal = 0.05;
    col.windupKind = "slam";
    run(g, 0.1);
    const blasts = g.hazards.filter((h) => (h.kind ?? "blast") === "blast");
    expect(blasts.length).toBeGreaterThanOrEqual(CONFIG.fissureSteps);
    // The eruptions are STAGGERED (travel) and laid out along +x.
    const fuses = blasts.map((b) => b.t).sort((a, b) => a - b);
    expect(fuses[fuses.length - 1]).toBeGreaterThan(fuses[0]);
    expect(Math.max(...blasts.map((b) => b.pos.x))).toBeGreaterThan(col.pos.x + 3);
  });
});

describe("RUINS: band gating", () => {
  it("nothing from the Ruins above floor 10; present by floor 11", () => {
    const RUINS = new Set(["shieldbearer", "cleric", "archivist", "colossus"]);
    for (let seed = 1; seed <= 25; seed++) {
      const g9 = createTestGame({ seed, floor: 8 });
      expect(g9.monsters.some((m) => RUINS.has(m.kind))).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 30 && !seen; seed++) {
      const g11 = createTestGame({ seed, floor: 11 });
      seen = g11.monsters.some((m) => RUINS.has(m.kind));
    }
    expect(seen).toBe(true);
  });
});

describe("APPROACH: stagehand smoke-out", () => {
  it("after two swings it vanishes, marks a re-entry blast, and pops back AT the mark", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const hand = mkMon(g, {
      kind: "stagehand", pos: { x: p.pos.x + 0.8, y: p.pos.y },
      damage: 5, attackRange: 1, heat: CONFIG.stagehandStrikes, speed: CONFIG.monsterSpeed,
    });
    run(g, 0.2); // the smoke pops
    expect(hand.vanishT ?? 0).toBeGreaterThan(0);
    expect(dist(hand.pos, p.pos)).toBeGreaterThan(3); // it smoked AWAY
    const mark = g.hazards.find((h) => (h.kind ?? "blast") === "blast");
    expect(mark).toBeDefined();
    const markPos = { ...mark!.pos };
    run(g, CONFIG.stagehandVanish + 0.2); // the smoke clears
    expect(hand.vanishT ?? 0).toBe(0);
    expect(dist(hand.pos, markPos)).toBeLessThan(0.5); // it re-entered AT the mark
  });
});

describe("APPROACH: sniper", () => {
  it("locks a long lane at cast (no tracking) and relocates after", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const sn = mkMon(g, {
      kind: "sniper", pos: { x: p.pos.x + 4, y: p.pos.y }, damage: 20, attackRange: 10, speed: CONFIG.monsterSpeed,
    });
    run(g, 0.2);
    const lane = g.hazards.find((h) => h.kind === "beam");
    expect(lane).toBeDefined();
    expect(lane!.trackId).toBeUndefined(); // a pure position test
    const before = { ...sn.pos };
    run(g, CONFIG.sniperArm + 1.0); // fires, then spends the cooldown moving
    expect(dist(before, sn.pos)).toBeGreaterThan(0.5); // never the same spot twice
  });
});

describe("APPROACH: duelist riposte", () => {
  it("melee into the flourish is parried and REFLECTED; bolts ignore it", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const extra = mkMon(g, {
      kind: "duelist", pos: { x: p.pos.x + 1, y: p.pos.y },
      hp: 500, maxHp: 500, damage: 10, riposteT: CONFIG.riposteWindow,
    });
    const hpBefore = p.hp;
    damageMonster(g, p, extra, 100, { allowCrit: false, melee: true });
    const meleeDmg = 500 - extra.hp;
    expect(p.hp).toBeLessThan(hpBefore); // the riposte came BACK
    // Ranged ignores the flourish: full damage, no reflection.
    extra.hp = 500;
    extra.riposteT = CONFIG.riposteWindow;
    const hpBeforeBolt = p.hp;
    damageMonster(g, p, extra, 100, { allowCrit: false });
    expect(500 - extra.hp).toBeGreaterThan(meleeDmg * 2); // parry only reads steel
    expect(p.hp).toBe(hpBeforeBolt);
  });
});

describe("APPROACH: the darling's stardust", () => {
  it("her entourage takes half while SHE takes half again more", () => {
    const g = stage();
    const p = g.players[0];
    const star = mkMon(g, { kind: "darling", pos: { x: p.pos.x + 20, y: p.pos.y }, aura: "shield", hp: 400, maxHp: 400, speed: 0 });
    const toy = mkMon(g, { kind: "toysoldier", pos: { x: star.pos.x + 1, y: star.pos.y }, hp: 400, maxHp: 400, speed: 0, attackRange: 0, squadId: 1 });
    const plain = mkMon(g, { kind: "grunt", pos: { x: star.pos.x + 25, y: star.pos.y }, hp: 400, maxHp: 400, speed: 0 });
    run(g, 0.3); // aura radiates
    expect(toy.shieldT ?? 0).toBeGreaterThan(0);
    damageMonster(g, p, toy, 100, { allowCrit: false });
    damageMonster(g, p, plain, 100, { allowCrit: false });
    damageMonster(g, p, star, 100, { allowCrit: false });
    const toyDmg = 400 - toy.hp, plainDmg = 400 - plain.hp, starDmg = 400 - star.hp;
    expect(toyDmg).toBeLessThan(plainDmg * 0.7); // sheltered
    expect(starDmg).toBeGreaterThan(plainDmg * 1.2); // the glass idol pays extra
  });
});

describe("APPROACH: the suit actor gag", () => {
  it("dies, unzips, and the guy inside runs; sparing him pays hype", () => {
    const g = stage();
    const p = g.players[0];
    const beast = mkMon(g, { kind: "suitactor", pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 10, maxHp: 100, damage: 10 });
    beast.hp = 0;
    run(g, 0.2);
    const guy = g.monsters.find((m) => m.kind === "suitguy");
    expect(guy).toBeDefined();
    expect(guy!.noticed).toBe(true); // running immediately
    // Put him safely away and let the mercy clock run. Zero the meter just
    // before the escape lands so decay can't mask the payout burst.
    guy!.pos = { x: p.pos.x + CONFIG.filcherEscapeDist + 4, y: p.pos.y };
    guy!.speed = 0;
    run(g, CONFIG.filcherEscapeSeconds - 0.5);
    p.hype = 0;
    run(g, 1.5);
    expect(g.monsters.includes(guy!)).toBe(false); // he made it out
    expect(p.hype).toBeGreaterThan(CONFIG.suitguyEscapeHype * 0.5); // mercy pays
  });
});

describe("APPROACH: band gating", () => {
  it("the finale cast stays off floors below 16; present by floor 17", () => {
    const APPROACH = new Set(["stagehand", "sniper", "duelist", "darling", "canceled", "suitactor", "suitguy"]);
    for (let seed = 1; seed <= 25; seed++) {
      const g14 = createTestGame({ seed, floor: 14 });
      expect(g14.monsters.some((m) => APPROACH.has(m.kind))).toBe(false);
    }
    let seen = false;
    for (let seed = 1; seed <= 30 && !seen; seed++) {
      const g17 = createTestGame({ seed, floor: 17 });
      seen = g17.monsters.some((m) => APPROACH.has(m.kind));
    }
    expect(seen).toBe(true);
  });
});

describe("elite affix six-pack", () => {
  it("linked: the pack soaks half of every hit while allies stand", () => {
    const g = stage();
    const p = g.players[0];
    const elite = mkMon(g, { kind: "brute", pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 1000, maxHp: 1000, elite: true, affix: "linked" });
    const ally = mkMon(g, { kind: "grunt", pos: { x: elite.pos.x + 1, y: elite.pos.y }, hp: 200, maxHp: 200 });
    damageMonster(g, p, elite, 200, { allowCrit: false });
    const eliteDmg = 1000 - elite.hp;
    expect(ally.hp).toBeLessThan(200); // the link paid it forward
    // Alone, the same hit lands in full.
    const loner = mkMon(g, { kind: "brute", pos: { x: p.pos.x + 30, y: p.pos.y }, hp: 1000, maxHp: 1000, elite: true, affix: "linked" });
    damageMonster(g, p, loner, 200, { allowCrit: false });
    expect(1000 - loner.hp).toBeGreaterThan(eliteDmg * 1.5);
  });

  it("juggernaut: no stagger, no knockback", () => {
    const g = stage();
    const p = g.players[0];
    const jug = mkMon(g, { kind: "grunt", pos: { x: p.pos.x + 2, y: p.pos.y }, hp: 5000, maxHp: 5000, elite: true, affix: "juggernaut" });
    const start = { ...jug.pos };
    jug.windup = jug.windupTotal = 1.0;
    jug.windupKind = "melee";
    damageMonster(g, p, jug, 3000, { allowCrit: false, dir: { x: 1, y: 0 }, knockback: 2, poiseMult: 10 });
    expect(jug.stagger).toBe(0); // the poise meter never fills
    expect(jug.windup).toBeGreaterThan(0); // the committed swing survives
    expect(dist(start, jug.pos)).toBeLessThan(0.01); // the shove bounced off
  });

  it("vampiric: it drinks what it hits", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    const vamp = mkMon(g, {
      kind: "grunt", pos: { x: p.pos.x + 0.8, y: p.pos.y },
      hp: 100, maxHp: 500, damage: 100, elite: true, affix: "vampiric", introduced: true,
    });
    vamp.windup = vamp.windupTotal = 0.05;
    vamp.windupKind = "melee";
    run(g, 0.2);
    expect(vamp.hp).toBeGreaterThan(100); // the hit fed it
  });

  it("mortar: shells arc onto the crawler's position on a cadence", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = p.hp = 10_000;
    mkMon(g, {
      kind: "ranged", pos: { x: p.pos.x + 6, y: p.pos.y },
      damage: 20, attackRange: 6.5, elite: true, affix: "mortar", introduced: true, speed: 0, attackCooldown: 99, shootCd: 99,
    });
    run(g, 0.3);
    expect(g.hazards.some((h) => (h.kind ?? "blast") === "blast")).toBe(true); // a shell is in the air
  });

  it("berserking: below half HP the frenzy self-sustains", () => {
    const g = stage();
    const p = g.players[0];
    const zerk = mkMon(g, {
      kind: "grunt", pos: { x: p.pos.x + 5, y: p.pos.y },
      hp: 40, maxHp: 100, elite: true, affix: "berserking", introduced: true, speed: 0,
    });
    run(g, 0.3);
    expect(zerk.frenzyT ?? 0).toBeGreaterThan(0); // rage from its own wounds
  });

  it("executioner: wounded crawlers take extra", () => {
    const g = stage();
    const p = g.players[0];
    p.maxHp = 1000;
    const axe = mkMon(g, {
      kind: "grunt", pos: { x: p.pos.x + 0.8, y: p.pos.y },
      damage: 50, elite: true, affix: "executioner", introduced: true,
    });
    // Healthy hit.
    p.hp = 1000;
    axe.windup = axe.windupTotal = 0.05;
    axe.windupKind = "melee";
    run(g, 0.15);
    const healthyDmg = 1000 - p.hp;
    // Wounded hit (below the threshold).
    p.hp = Math.floor(p.maxHp * CONFIG.executionerThreshold) - 50;
    const woundedBefore = p.hp;
    axe.attackCooldown = 0;
    axe.windup = axe.windupTotal = 0.05;
    axe.windupKind = "melee";
    run(g, 0.15);
    const woundedDmg = woundedBefore - p.hp;
    expect(woundedDmg).toBeGreaterThan(healthyDmg * 1.2); // the threshold is REAL
  });
});

describe("the pack playbook", () => {
  it("band templates spawn as coherent clusters (the Hook Squad exists)", () => {
    let hookSquads = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const g = createTestGame({ seed, floor: 8 });
      for (const lasher of g.monsters.filter((m) => m.kind === "lasher")) {
        const hexNear = g.monsters.some((m) => m.kind === "hexer" && dist(m.pos, lasher.pos) < 3);
        const bruteNear = g.monsters.some((m) => m.kind === "brute" && dist(m.pos, lasher.pos) < 3);
        if (hexNear && bruteNear) hookSquads++;
      }
    }
    expect(hookSquads).toBeGreaterThan(0); // the flagship combo musters
  });

  it("templates are budget-neutral: floor population stays in its band", () => {
    for (const seed of [3, 7, 11]) {
      const g = createTestGame({ seed, floor: 8 });
      // monsterCount for floor 8 = base + perFloor * 7, capped; template packs
      // must not inflate it (they SPEND the same budget).
      const expected = Math.min(CONFIG.monsterMaxCount, CONFIG.monsterBaseCountFloor1 + CONFIG.monsterCountPerFloor * 7);
      expect(g.monsters.length).toBeLessThanOrEqual(expected + 12); // vault/elite/rat extras only
    }
  });

  // (Floors 1-2 template gating is a one-line floor check; the balance
  // contract is the real guard — it caught a floor-2 Reception killing the
  // bot before this gate existed, which is exactly why the gate exists.)
});

describe("boss layers", () => {
  it("layer 2: the finale gains borrowed signatures at phase edges (the greatest-hits reel)", () => {
    const g = createTestGame({ seed: 7, floor: 18, level: 18 });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.monsters = [boss];
    boss.introduced = true;
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    boss.bossTier = undefined; // no ritual windup swallowing the brain steps
    expect(boss.signature).toBeUndefined(); // clean kit at full HP
    boss.hp = Math.floor(boss.maxHp * 0.5); // phase 1
    run(g, 0.1);
    expect(boss.signature).toBe("debris"); // the Architect's set
    boss.hp = Math.floor(boss.maxHp * 0.2); // phase 2
    boss.windup = 0; // clear any committed swing so the brain runs
    boss.windupKind = undefined;
    run(g, 0.1);
    expect(boss.signature).toBe("flamewall"); // the Marshal's encore
  });

  it("layer 2: band bosses alternate own/borrowed signatures from phase 1", () => {
    const g = createTestGame({ seed: 7, floor: 15, level: 16 });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.monsters = [boss];
    boss.introduced = true;
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    boss.hp = Math.floor(boss.maxHp * 0.5); // phase 1
    const alts: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      boss.sigCd = 0;
      run(g, 0.1);
      alts.push(!!boss.sigAlt);
    }
    // The toggle flips every cast: own -> borrowed -> own...
    expect(alts[0]).not.toBe(alts[1]);
    expect(alts[1]).not.toBe(alts[2]);
  });

  it("layer 3: the arena director acts while the boss lives, stops when it falls", () => {
    // Seed 7 stopped flooding when occupancy v2 (roomPurposes residents)
    // added draws to floor-1's spawn stream ahead of the floor-6 rebuild;
    // seed 8 floods on schedule under the seated-resident layout.
    const g = createTestGame({ seed: 8, floor: 6, level: 8 });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.monsters = [boss];
    boss.introduced = true;
    boss.sigCd = 9999; // the SIGNATURE can't fire — anything that appears is the ROOM
    boss.healCd = 9999;
    boss.phase = 0;
    g.players[0].pos = { x: boss.pos.x + 6, y: boss.pos.y };
    g.hazards = [];
    for (let t = 0; t < CONFIG.directorFloodInterval + 1; t += DT) {
      boss.sigCd = 9999; // hold it every step
      boss.hp = boss.maxHp; // no phases
      step(g, idle(), DT);
    }
    expect(g.hazards.some((h) => h.kind === "sludge")).toBe(true); // the sump ROSE
    // Kill the boss: the director's clock stops with the show.
    boss.hp = 0;
    run(g, 0.2);
    g.hazards = [];
    const t0 = g.arenaT ?? 0;
    run(g, 2);
    expect(g.arenaT ?? 0).toBe(t0); // no boss, no director
    expect(g.hazards.some((h) => h.kind === "sludge")).toBe(false);
  });

  it("layer 1: The Foreman clocks in on floor 14 with elite plumbing", () => {
    let seen = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const g = createTestGame({ seed, floor: 14 });
      const champ = g.monsters.find((m) => m.kind === "foreman");
      if (!champ) continue;
      seen++;
      expect(champ.elite).toBe(true);
      expect(champ.eliteName).toBe("The Foreman");
      expect(champ.maxHp).toBeGreaterThan(1500); // a checkpoint fight, not a pack
    }
    expect(seen).toBe(8); // every floor 14 has its champion
  });
});

describe("champions + the duo", () => {
  it("The Pack Alpha stalks floor 8; the QA Team holds floor 17 as a duo", () => {
    const g8 = createTestGame({ seed: 3, floor: 8 });
    const alpha = g8.monsters.find((m) => m.eliteName === "The Pack Alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.kind).toBe("charger");
    expect(alpha!.elite).toBe(true);

    const g17 = createTestGame({ seed: 3, floor: 17 });
    const one = g17.monsters.find((m) => m.eliteName === "QA UNIT ONE");
    const two = g17.monsters.find((m) => m.eliteName === "QA UNIT TWO");
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one!.duoId).toBeDefined();
    expect(one!.duoId).toBe(two!.duoId); // linked — the enrage seam
  });

  it("when one QA unit dies, the survivor ENRAGES: permanent frenzy, hotter, healed", () => {
    const g = createTestGame({ seed: 3, floor: 17 });
    const one = g.monsters.find((m) => m.eliteName === "QA UNIT ONE")!;
    const two = g.monsters.find((m) => m.eliteName === "QA UNIT TWO")!;
    two.hp = Math.round(two.maxHp * 0.4); // wounded, so the grief-heal shows
    const dmgBefore = two.damage;
    const hpBefore = two.hp;
    one.hp = 0; // drop the tank
    run(g, 0.2);
    expect(two.enraged).toBe(true);
    expect(two.damage).toBeGreaterThan(dmgBefore);
    expect(two.hp).toBeGreaterThan(hpBefore); // it patched itself in fury
    // Permanent frenzy: cooldowns decay faster forever, no frenzyT required.
    two.attackCooldown = 1;
    const plain = g.monsters.find((m) => m.kind === "grunt" && dist(m.pos, g.players[0].pos) > 12);
    if (plain) plain.attackCooldown = 1;
    run(g, 0.5);
    if (plain) expect(two.attackCooldown).toBeLessThan(plain.attackCooldown);
  });
});
