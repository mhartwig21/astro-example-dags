import { describe, it, expect } from "vitest";
import { createGame, step, equipItem, learnAbility, leaveSafeRoom } from "../src/sim/game";
import { applyStatus, statusOf, statusTimeMult, tickStatuses } from "../src/sim/status";
import { boltParams } from "../src/sim/abilities";
import { CONFIG } from "../src/sim/config";
import type { Intent, Monster, StatusEffect } from "../src/sim/types";

// Status-effect layer (DESIGN 5.11): burn / poison / chill on both sides of
// the fight. The framework is pure (status.ts); DoT damage must flow through
// the damageMonster / damagePlayerHit choke points so schools, resists,
// armor, and hit events compose — that composition is what this file guards.

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function mkMon(over: Partial<Monster> = {}): Monster {
  return {
    id: 1, kind: "grunt" as const, pos: { x: 0, y: 0 },
    hp: 1, maxHp: 1, damage: 0, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
    windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0, ...over,
  };
}

describe("status framework (pure rules)", () => {
  it("burn refreshes instead of stacking, keeping the stronger magnitude", () => {
    const t: { statuses?: StatusEffect[] } = {};
    applyStatus(t, { kind: "burn", duration: 3, magnitude: 10, school: "magic" });
    t.statuses![0].remaining = 0.5; // nearly out
    applyStatus(t, { kind: "burn", duration: 3, magnitude: 6, school: "magic" });
    expect(t.statuses).toHaveLength(1);
    expect(t.statuses![0].remaining).toBe(3); // refreshed
    expect(t.statuses![0].magnitude).toBe(10); // stronger roll kept
    expect(t.statuses![0].stacks).toBe(1); // never stacks
  });

  it("poison stacks to the cap and each stack adds a full tick's damage", () => {
    const t: { statuses?: StatusEffect[] } = {};
    for (let i = 0; i < CONFIG.poisonMaxStacks + 2; i++) {
      applyStatus(t, { kind: "poison", duration: 5, magnitude: 4, school: "physical" });
    }
    expect(t.statuses).toHaveLength(1);
    expect(t.statuses![0].stacks).toBe(CONFIG.poisonMaxStacks);
    // Advance one poison interval: the due tick pays magnitude x stacks.
    const due = tickStatuses(t, CONFIG.poisonTickSeconds);
    expect(due).toHaveLength(1);
    expect(due[0].damage).toBe(4 * CONFIG.poisonMaxStacks);
    expect(due[0].school).toBe("physical");
  });

  it("burn ticks on its fast clock and expires cleanly", () => {
    const t: { statuses?: StatusEffect[] } = {};
    applyStatus(t, { kind: "burn", duration: CONFIG.burnDuration, magnitude: 5, school: "magic" });
    let ticks = 0;
    for (let i = 0; i < 100; i++) ticks += tickStatuses(t, 0.1).length;
    expect(ticks).toBe(Math.round(CONFIG.burnDuration / CONFIG.burnTickSeconds));
    expect(t.statuses).toHaveLength(0); // pruned after expiry
  });

  it("chill deals no damage and reads as a time multiplier", () => {
    const t: { statuses?: StatusEffect[] } = {};
    expect(statusTimeMult(t)).toBe(1);
    applyStatus(t, { kind: "chill", duration: 2.5, magnitude: 0.3, school: "magic" });
    expect(statusTimeMult(t)).toBeCloseTo(0.7);
    const due = tickStatuses(t, 2.0);
    expect(due).toHaveLength(0); // no DoT from cold
    tickStatuses(t, 1.0);
    expect(statusOf(t, "chill")).toBeUndefined(); // faded
  });
});

describe("burn: nova Afterburn", () => {
  it("ignites everything the nova touched; ticks are magic-school and tinted", () => {
    const g = createGame(7001);
    const p = g.players[0];
    learnAbility(g, p, "nova");
    p.abilities.ranks["nova.scorch"] = 1;
    g.monsters.length = 0;
    const m = mkMon({ id: 900, pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 5000, maxHp: 5000 });
    g.monsters.push(m);
    step(g, { ...idle(), nova: true }, 1 / 60);
    const burn = statusOf(m, "burn");
    expect(burn).toBeDefined();
    expect(burn!.school).toBe("magic");
    const hpAfterNova = m.hp;
    // Ride out one burn tick; the tick must route through damageMonster
    // (hit event carries effect: "burn" + school magic).
    let burnHits = 0;
    for (let i = 0; i < 12; i++) {
      step(g, idle(), 0.05);
      burnHits += g.hits.filter((h) => h.effect === "burn" && h.school === "magic").length;
    }
    expect(burnHits).toBeGreaterThan(0);
    expect(m.hp).toBeLessThan(hpAfterNova);
  });

  it("re-igniting refreshes the burn instead of stacking a second one", () => {
    const g = createGame(7002);
    const p = g.players[0];
    learnAbility(g, p, "nova");
    p.abilities.ranks["nova.scorch"] = 2;
    g.monsters.length = 0;
    const m = mkMon({ id: 901, pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 50000, maxHp: 50000 });
    g.monsters.push(m);
    step(g, { ...idle(), nova: true }, 1 / 60);
    for (let i = 0; i < 20; i++) step(g, idle(), 0.05); // burn partway down
    p.cd.nova = 0;
    step(g, { ...idle(), nova: true }, 1 / 60);
    expect(m.statuses!.filter((s) => s.kind === "burn")).toHaveLength(1);
    expect(statusOf(m, "burn")!.remaining).toBeCloseTo(CONFIG.burnDuration, 1);
  });
});

describe("chill: Frost Bolts + the chilling elite", () => {
  function fireBoltAt(g: ReturnType<typeof createGame>, frostRank: number, target: Monster): void {
    const p = g.players[0];
    p.abilities.ranks["bolt.frost"] = frostRank;
    g.monsters.length = 0;
    target.pos = { x: p.pos.x + 1.5, y: p.pos.y };
    g.monsters.push(target);
    step(g, { ...idle(), bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    for (let i = 0; i < 30 && !statusOf(target, "chill"); i++) step(g, idle(), 1 / 60);
  }

  it("bolt impacts chill by the node's slow fraction", () => {
    const g = createGame(7010);
    expect(boltParams(g.players[0]).chill).toBe(0); // untaken = no rider
    const m = mkMon({ id: 910, hp: 4000, maxHp: 4000, attackCooldown: 999 });
    fireBoltAt(g, 1, m);
    const chill = statusOf(m, "chill");
    expect(chill).toBeDefined();
    expect(chill!.magnitude).toBeCloseTo(CONFIG.chillSlowPerRank);
  });

  it("bosses shrug off half the slow (interaction, not immunity)", () => {
    const g = createGame(7011);
    const boss = mkMon({
      id: 911, kind: "boss", hp: 900000, maxHp: 900000,
      attackCooldown: 999, shootCd: 999, healCd: 999,
      introduced: true, // skip the ringside world-freeze
    });
    fireBoltAt(g, 1, boss);
    const chill = statusOf(boss, "chill");
    expect(chill).toBeDefined();
    expect(chill!.magnitude).toBeCloseTo(CONFIG.chillSlowPerRank * CONFIG.chillBossMult);
  });

  it("a chilled monster's windup ticks slower (attack speed slowed)", () => {
    const g = createGame(7012);
    g.monsters.length = 0;
    const far = { x: g.players[0].pos.x + 40, y: g.players[0].pos.y }; // out of aggro
    const slow = mkMon({ id: 912, pos: { x: far.x, y: far.y }, hp: 100, maxHp: 100, windup: 1, windupTotal: 1, windupKind: "melee" });
    const fast = mkMon({ id: 913, pos: { x: far.x, y: far.y }, hp: 100, maxHp: 100, windup: 1, windupTotal: 1, windupKind: "melee" });
    applyStatus(slow, { kind: "chill", duration: 10, magnitude: 0.3, school: "magic" });
    g.monsters.push(slow, fast);
    step(g, idle(), 0.5);
    expect(fast.windup).toBeCloseTo(0.5, 5);
    expect(slow.windup).toBeCloseTo(1 - 0.5 * 0.7, 5); // clock at 70%
  });

  it("a CHILLING elite's aura slows the crawler's feet and hands", () => {
    const g = createGame(7013);
    const p = g.players[0];
    g.monsters.length = 0;
    g.monsters.push(mkMon({
      id: 914, pos: { x: p.pos.x + 2, y: p.pos.y }, hp: 5000, maxHp: 5000,
      elite: true, eliteName: "Frosty the Foreclosure", affix: "chilling",
      attackCooldown: 999, introduced: true, // skip the ringside freeze
    }));
    step(g, idle(), 1 / 60);
    expect(statusOf(p, "chill")).toBeDefined();
    // Feet: a chilled step covers less ground than a clean one.
    const x0 = p.pos.x;
    step(g, { ...idle(), move: { x: -1, y: 0 } }, 0.1);
    const chilledStep = x0 - p.pos.x;
    expect(chilledStep).toBeLessThan(p.speed * 0.1 * 0.85);
    // Hands: cooldowns recover on the chilled clock too.
    p.cd.melee = 1;
    step(g, idle(), 0.5);
    expect(p.cd.melee).toBeGreaterThan(0.5); // ticked slower than real time
  });
});

describe("poison: acid puddles + the Venom Clause", () => {
  it("lingering in spitter acid stacks poison that keeps biting after you leave", () => {
    const g = createGame(7020);
    const p = g.players[0];
    g.monsters.length = 0;
    g.hazards.push({
      id: 990, pos: { x: p.pos.x, y: p.pos.y }, t: 10, total: 10,
      radius: CONFIG.puddleRadius, damage: 8, kind: "puddle", tick: 0,
    });
    // Soak through several puddle ticks: stacks build toward the cap.
    for (let i = 0; i < Math.ceil(4 / 0.1); i++) step(g, idle(), 0.1);
    const psn = statusOf(p, "poison");
    expect(psn).toBeDefined();
    expect(psn!.stacks).toBe(CONFIG.poisonMaxStacks);
    // Step OUT of the acid: the poison keeps ticking (that's the point).
    g.hazards.length = 0;
    const hpOut = p.hp;
    let poisonHits = 0;
    for (let i = 0; i < Math.ceil(2 / 0.1); i++) {
      step(g, idle(), 0.1);
      poisonHits += g.hits.filter((h) => h.effect === "poison" && h.kind === "player").length;
    }
    expect(poisonHits).toBeGreaterThan(0);
    expect(p.hp).toBeLessThan(hpOut);
  });

  it("poison ticks are mitigated by armor (choke-point composition)", () => {
    const g = createGame(7021);
    const p = g.players[0];
    g.monsters.length = 0;
    applyStatus(p, { kind: "poison", duration: 5, magnitude: 30, school: "physical" });
    step(g, idle(), CONFIG.poisonTickSeconds + 0.01);
    const unarmored = g.hits.find((h) => h.effect === "poison")!.amount;
    expect(unarmored).toBe(30); // roll:false — the raw tick
    const g2 = createGame(7021);
    const p2 = g2.players[0];
    g2.monsters.length = 0;
    equipItem(p2, { id: 1, slot: "armor", rarity: "rare", name: "Test Plate", affixes: { armor: CONFIG.armorK } });
    applyStatus(p2, { kind: "poison", duration: 5, magnitude: 30, school: "physical" });
    step(g2, idle(), CONFIG.poisonTickSeconds + 0.01);
    const armored = g2.hits.find((h) => h.effect === "poison")!.amount;
    expect(armored).toBe(15); // armorK armor = 50% mitigation
  });

  it("Venom Clause: crits inject poison; DoT kills credit the source", () => {
    const g = createGame(7022);
    const p = g.players[0];
    p.critChance = 1; // every hit crits
    p.equipment.charm = { id: 5, slot: "charm", rarity: "epic", name: "Venom Clause", affixes: {}, passive: "venom" };
    g.monsters.length = 0;
    const m = mkMon({ id: 920, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 10000, maxHp: 10000 });
    g.monsters.push(m);
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    const psn = statusOf(m, "poison");
    expect(psn).toBeDefined();
    expect(psn!.sourceId).toBe(p.id);
    // A second crit stacks it.
    p.cd.melee = 0;
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(statusOf(m, "poison")!.stacks).toBe(2);
    // Let the venom finish a weakened target: the kill credits the poisoner.
    m.hp = 1;
    const kills0 = p.kills;
    for (let i = 0; i < 30 && m.hp > 0; i++) step(g, idle(), 0.1);
    expect(g.monsters.includes(m)).toBe(false); // reaped
    expect(p.kills).toBe(kills0 + 1);
  });
});

describe("DoT through resists (schools compose)", () => {
  it("a warded monster shrugs a slice of the burn; hits read resisted", () => {
    const g = createGame(7030);
    g.monsters.length = 0;
    const far = { x: g.players[0].pos.x + 40, y: g.players[0].pos.y };
    const plain = mkMon({ id: 930, pos: { x: far.x, y: far.y }, hp: 4000, maxHp: 4000 });
    const warded = mkMon({ id: 931, pos: { x: far.x, y: far.y + 1 }, hp: 4000, maxHp: 4000, affix: "warded" });
    for (const m of [plain, warded]) {
      applyStatus(m, { kind: "burn", duration: 3, magnitude: 100, school: "magic" });
      g.monsters.push(m);
    }
    step(g, idle(), CONFIG.burnTickSeconds + 0.01);
    const hits = g.hits.filter((h) => h.effect === "burn");
    expect(hits).toHaveLength(2);
    const [plainHit, wardedHit] = hits; // monster order is deterministic
    expect(wardedHit.resisted).toBe(true);
    expect(plainHit.resisted).toBeUndefined();
    // ±15% roll bands never overlap across the 0.7x resist multiplier.
    expect(wardedHit.amount).toBeLessThan(plainHit.amount);
    expect(plain.hp - 4000 + plainHit.amount).toBe(0); // damage matches the event
  });
});

describe("status hygiene", () => {
  it("descending scrubs the crawler clean (statuses reset per floor)", () => {
    const g = createGame(7040);
    const p = g.players[0];
    applyStatus(p, { kind: "poison", duration: 60, magnitude: 2, school: "physical" });
    applyStatus(p, { kind: "chill", duration: 60, magnitude: 0.3, school: "magic" });
    p.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { ...idle(), useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(p.statuses).toHaveLength(0);
  });

  it("DoT ticks never crit and never build poise (no stagger-locking a brute)", () => {
    const g = createGame(7041);
    g.players[0].critChance = 1;
    g.monsters.length = 0;
    const far = { x: g.players[0].pos.x + 40, y: g.players[0].pos.y };
    const m = mkMon({ id: 940, kind: "brute", pos: { x: far.x, y: far.y }, hp: 100000, maxHp: 100000 });
    applyStatus(m, { kind: "burn", duration: 3, magnitude: 50, school: "magic", sourceId: 0 });
    g.monsters.push(m);
    for (let i = 0; i < 12; i++) step(g, idle(), 0.1);
    expect(g.hits.some((h) => h.kind === "crit" && h.effect === "burn")).toBe(false);
    expect(m.poiseDmg).toBe(0);
    expect(m.stagger).toBe(0);
  });
});
