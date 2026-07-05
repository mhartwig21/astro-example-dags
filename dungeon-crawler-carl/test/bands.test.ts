import { describe, it, expect } from "vitest";
import { createGame, isCityBossFloor, restoreGame } from "../src/sim/game";
import { step } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";
import { NO_INTENT, type GameState, type Monster } from "../src/sim/types";

// Band bosses + signature mechanics: every band-end floor (3, 6, 9, 12, 15)
// hosts a sealed arena whose boss layers ONE band-themed ability on the shared
// melee+volley+phase kit. These tests pin the ladder (names, tiers, HP) and
// exercise each signature's telegraph-first contract.

const idle = () => ({ move: { x: 0, y: 0 }, useStairs: false });

function atFloor(floor: number, seed = 909): GameState {
  return restoreGame({
    seed, floor,
    player: { hp: 400, level: 12, xp: 0, xpToNext: 9999, gold: 0, bonusMaxHp: 300 },
  });
}

/** The arena boss, isolated: other monsters cleared, intro already played. */
function isolatedBoss(g: GameState): Monster {
  const boss = g.monsters.find((m) => m.kind === "boss")!;
  g.monsters = [boss];
  boss.introduced = true;
  return boss;
}

describe("band-boss ladder", () => {
  it("every band-end floor is a boss floor; nothing else is", () => {
    for (let f = 1; f <= 18; f++) {
      expect(isCityBossFloor(f), `floor ${f}`).toBe(f % 3 === 0 && f < CONFIG.finalFloor);
    }
  });

  it("each arena spawns its named boss with the band's signature and tier", () => {
    const want = [
      { floor: 3, name: "The Crypt Concierge", signature: "graverising", tier: undefined },
      { floor: 6, name: "The Sump King", signature: "flood", tier: 1 },
      { floor: 9, name: "The Topiary Warden", signature: "roots", tier: 1 },
      { floor: 12, name: "The Condemned Architect", signature: "debris", tier: 2 },
      { floor: 15, name: "The Furnace Marshal", signature: "flamewall", tier: 2 },
    ] as const;
    for (const w of want) {
      const boss = atFloor(w.floor).monsters.find((m) => m.kind === "boss")!;
      expect(boss.eliteName, `floor ${w.floor}`).toBe(w.name);
      expect(boss.signature, `floor ${w.floor}`).toBe(w.signature);
      expect(boss.bossTier, `floor ${w.floor}`).toBe(w.tier);
      expect(boss.maxHp, `floor ${w.floor}`).toBe(CONFIG.bandBossHp[w.floor / 3 - 1]);
    }
    // The finale is untouched: tier 3, no band signature — Dark Ritual is the crown.
    const finale = atFloor(CONFIG.finalFloor).monsters.find((m) => m.kind === "boss")!;
    expect(finale.bossTier).toBe(3);
    expect(finale.signature).toBeUndefined();
  });

  it("HP climbs monotonically and floors 6/12 keep their pre-band pools", () => {
    for (let i = 1; i < CONFIG.bandBossHp.length; i++) {
      expect(CONFIG.bandBossHp[i]).toBeGreaterThan(CONFIG.bandBossHp[i - 1]);
    }
    expect(CONFIG.bandBossHp[1]).toBe(5400); // floor 6, as before the band pass
    expect(CONFIG.bandBossHp[3]).toBe(18360); // floor 12, as before (5400 * 3.4)
  });

  it("the floor-3 opener is gentle: small pool, softer hits, no Ground Slam", () => {
    const boss = atFloor(3).monsters.find((m) => m.kind === "boss")!;
    expect(boss.maxHp).toBeLessThanOrEqual(1500);
    expect(boss.damage).toBeLessThan(CONFIG.bossDamage * 0.6);
    expect(boss.bossTier).toBeUndefined(); // no slam kit on the trainer boss
  });
});

describe("signature: Grave Rising (floor 3, THE UNDERCROFT)", () => {
  it("channels a raise when a fresh corpse is in reach, and the dead get up weakened", () => {
    const g = atFloor(3);
    const boss = isolatedBoss(g);
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    g.corpses.push({ id: 777, pos: { x: boss.pos.x + 1, y: boss.pos.y }, kind: "grunt", t: 10 });
    step(g, idle(), 1 / 60);
    expect(boss.windupKind).toBe("raise");
    expect(boss.sigCd).toBeGreaterThan(0);
    // Let the channel finish.
    for (let i = 0; i < Math.ceil(CONFIG.graveRaiseWindup * 60) + 2; i++) step(g, idle(), 1 / 60);
    const raised = g.monsters.find((m) => m.kind === "grunt");
    expect(raised).toBeDefined();
    expect(g.corpses.find((c) => c.id === 777)).toBeUndefined();
    expect(raised!.xp).toBe(CONFIG.necroRaisedXp); // no farming the concierge
  });

  it("never commits the channel with no corpse in reach", () => {
    const g = atFloor(3);
    const boss = isolatedBoss(g);
    g.corpses.length = 0;
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    expect(boss.windupKind).not.toBe("raise");
    expect(boss.sigCd ?? 0).toBe(0); // nothing paid for nothing cast
  });
});

describe("signature: Flood Surge (floor 6, THE SEWERS)", () => {
  function flood(seed = 909) {
    const g = atFloor(6, seed);
    const boss = isolatedBoss(g);
    g.players[0].pos = { x: boss.pos.x + 6, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    return { g, boss };
  }

  it("lays armed sludge pools that are harmless through the telegraph", () => {
    const { g } = flood();
    const pools = g.hazards.filter((h) => h.kind === "sludge");
    expect(pools.length).toBeGreaterThan(3);
    for (const hz of pools) {
      expect(hz.arm).toBeCloseTo(CONFIG.floodTelegraph, 5);
      expect(hz.total).toBeCloseTo(CONFIG.floodTelegraph + CONFIG.floodDuration, 5);
    }
    // Park a crawler dead-center in a pool for the whole telegraph: no damage.
    // (Retire the boss first — this measures the POOL, not its volleys.)
    g.monsters = [];
    g.projectiles = [];
    const p = g.players[0];
    p.pos = { x: pools[0].pos.x, y: pools[0].pos.y };
    const hp0 = p.hp;
    const armSteps = Math.floor((CONFIG.floodTelegraph - 0.2) * 60);
    for (let i = 0; i < armSteps; i++) step(g, idle(), 1 / 60);
    expect(p.hp).toBe(hp0); // telegraphs never bite (repo pillar)
    // ...but once live, the sludge ticks.
    for (let i = 0; i < 40; i++) {
      step(g, idle(), 1 / 60);
      p.pos = { x: pools[0].pos.x, y: pools[0].pos.y }; // stay in the soup
    }
    expect(p.hp).toBeLessThan(hp0);
  });

  it("announces the first surge only (the visuals carry the reruns)", () => {
    const { g, boss } = flood();
    expect(boss.sigUsed).toBe(true);
    boss.sigCd = 0;
    const lines: string[] = [];
    step(g, idle(), 1 / 60);
    lines.push(...g.announcements.map((a) => a.text));
    expect(lines.some((t) => t.includes("SLUICES"))).toBe(false);
  });
});

describe("signature: Entangling Roots (floor 9, THE GARDEN)", () => {
  it("live root zones snare (heavy slow) but never damage; dashing is immune", () => {
    const g = atFloor(9);
    const boss = isolatedBoss(g);
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 6, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    const zones = g.hazards.filter((h) => h.kind === "roots");
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((z) => z.damage === 0)).toBe(true);
    // Stand in one until it goes live: snared, slowed, unhurt.
    // (Retire the boss — this measures the ZONE, not its volleys.)
    g.monsters = [];
    g.projectiles = [];
    const zone = zones[0];
    const hp0 = p.hp;
    p.pos = { x: zone.pos.x, y: zone.pos.y };
    for (let i = 0; i < Math.ceil((CONFIG.rootsTelegraph + 0.3) * 60); i++) {
      step(g, idle(), 1 / 60);
      p.pos = { x: zone.pos.x, y: zone.pos.y };
    }
    expect(p.rootT).toBeGreaterThan(0);
    expect(p.hp).toBe(hp0);
    // Snared movement crawls at the slow multiplier.
    const before = { x: p.pos.x, y: p.pos.y };
    step(g, { move: { x: 0, y: -1 }, useStairs: false }, 1 / 60);
    const moved = Math.hypot(p.pos.x - before.x, p.pos.y - before.y);
    expect(moved).toBeLessThan(p.speed * (1 / 60) * (CONFIG.rootsSlowMult + 0.1));
    // A dashing crawler is never gripped.
    p.rootT = 0;
    p.dashTime = 0.1;
    p.pos = { x: zone.pos.x, y: zone.pos.y };
    step(g, idle(), 1 / 60);
    expect(p.rootT).toBe(0);
  });
});

describe("signature: Collapsing Masonry (floor 12, THE RUINS)", () => {
  it("rains telegraphed debris circles from phase 0, one targeting each crawler", () => {
    const g = atFloor(12);
    const boss = isolatedBoss(g);
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 6, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    expect(boss.phase ?? 0).toBe(0); // no phase needed — the signature IS the rain
    const circles = g.hazards.filter((h) => h.kind !== "puddle" && h.kind !== "sludge" && h.kind !== "roots");
    expect(circles.length).toBeGreaterThanOrEqual(CONFIG.debrisCount - 2); // walls may eat a few
    expect(circles.some((h) => Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) < 0.5)).toBe(true);
    for (const hz of circles) expect(hz.total).toBeCloseTo(CONFIG.debrisDelay, 5);
  });
});

describe("signature: Flame Sweep (floor 15, THE IRONWORKS)", () => {
  it("builds an advancing wall: farther rows detonate later, along one axis", () => {
    const g = atFloor(15);
    const boss = isolatedBoss(g);
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 7, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    const fire = g.hazards;
    expect(fire.length).toBeGreaterThan(CONFIG.flameRows); // several circles per row
    // Delay grows with distance from the boss — that IS the advance.
    const byDelay = new Map<number, number[]>();
    for (const hz of fire) {
      const d = Math.hypot(hz.pos.x - boss.pos.x, hz.pos.y - boss.pos.y);
      const key = Math.round(hz.total * 100);
      byDelay.set(key, [...(byDelay.get(key) ?? []), d]);
    }
    const delays = [...byDelay.keys()].sort((a, b) => a - b);
    expect(delays.length).toBeGreaterThanOrEqual(3); // staggered rows, not one boom
    const rowDist = (k: number) => Math.min(...byDelay.get(k)!);
    for (let i = 1; i < delays.length; i++) {
      expect(rowDist(delays[i])).toBeGreaterThan(rowDist(delays[i - 1]));
    }
  });
});

describe("band bosses: playability", () => {
  it("the bot clears floors 1-3 — the trainer boss is beatable before collapse", () => {
    for (const seed of [11, 47]) {
      const g = createGame(seed);
      const r = runBot(g, 3);
      expect(r.died, `seed ${seed}: bot died on floor ${g.floor}`).toBe(false);
      expect(r.floorsCleared, `seed ${seed}: cleared ${r.floorsCleared}/3`).toBe(3);
      const f3 = r.floors.find((f) => f.floor === 3);
      expect(f3?.timeRemaining ?? -1, `seed ${seed}: floor 3 beat the collapse`).toBeGreaterThan(0);
    }
  });

  it("signatures stay deterministic: same seed, same surge", () => {
    const run = () => {
      const g = atFloor(6, 4242);
      const boss = isolatedBoss(g);
      g.players[0].pos = { x: boss.pos.x + 6, y: boss.pos.y };
      for (let i = 0; i < 120; i++) step(g, NO_INTENT, 1 / 60);
      return JSON.stringify(g.hazards.map((h) => [h.kind, h.pos.x.toFixed(4), h.pos.y.toFixed(4), h.t.toFixed(4)]));
    };
    expect(run()).toBe(run());
  });
});
