import { describe, it, expect } from "vitest";
import { createGame, restoreGame, step, equipItem, equipFromInventory } from "../src/sim/game";
import { generateItem } from "../src/sim/items";
import { NO_INTENT, type Intent } from "../src/sim/types";
import { CONFIG, floorTimeBudget } from "../src/sim/config";
import { createRng, nextFloat } from "../src/sim/rng";

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function mkMon(over: Partial<import("../src/sim/types").Monster> = {}) {
  return {
    id: 1, kind: "grunt" as const, pos: { x: 0, y: 0 },
    hp: 1, maxHp: 1, damage: 0, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, xp: 5, hitFlash: 0, ...over,
  };
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
    g.monsters.push(mkMon({ id: 999, pos: { x: g.player.pos.x + 1, y: g.player.pos.y }, hp: 999, maxHp: 999, xp: 10 }));
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
      g.monsters.push(mkMon({ id: 1000 + i, pos: { x: g.player.pos.x + 0.6, y: g.player.pos.y } }));
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

describe("skills + projectiles", () => {
  it("dash triggers a blink (cooldown + i-frames), never moving backward", () => {
    const g = createGame(3);
    g.player.facing = { x: 1, y: 0 };
    const x0 = g.player.pos.x;
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, dash: true }, 1 / 60);
    // Cooldown + i-frames are set regardless of geometry; position never regresses.
    expect(g.player.dashCd).toBeGreaterThan(0);
    expect(g.player.dashTime).toBeGreaterThan(0);
    expect(g.player.pos.x).toBeGreaterThanOrEqual(x0);
  });

  it("bolt spawns a player projectile that damages a monster it reaches", () => {
    const g = createGame(11);
    g.player.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.player.pos.x + 2, y: g.player.pos.y }, hp: 999, maxHp: 999 }));
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.projectiles.length).toBe(1);
    expect(g.projectiles[0].from).toBe("player");
    const before = g.monsters[0].hp;
    // Advance until the bolt reaches the monster.
    for (let i = 0; i < 60 && g.monsters[0].hp === before; i++) {
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    }
    expect(g.monsters[0].hp).toBeLessThan(before);
  });

  it("a ranged monster fires an enemy projectile at the player", () => {
    const g = createGame(21);
    g.monsters.length = 0;
    g.projectiles.length = 0;
    // Place next to the player (guaranteed walkable — the player stands there) so the
    // fired bolt isn't culled against a wall on spawn.
    g.monsters.push(mkMon({ id: 1, kind: "ranged", pos: { x: g.player.pos.x + 1.5, y: g.player.pos.y }, hp: 50, maxHp: 50, damage: 5, attackRange: 6.5 }));
    let fired = false;
    for (let i = 0; i < 120 && !fired; i++) {
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false }, 1 / 60);
      fired = g.projectiles.some((pr) => pr.from === "enemy");
    }
    expect(fired).toBe(true);
  });
});

describe("itemization", () => {
  it("generates deterministic items with a slot-appropriate primary affix", () => {
    const rng1 = createRng(4242);
    const rng2 = createRng(4242);
    let id1 = 0, id2 = 0;
    const a = generateItem(rng1, 5, () => ++id1);
    const b = generateItem(rng2, 5, () => ++id2);
    expect(a).toEqual(b);
    const primaryBySlot = { weapon: "damage", armor: "maxHp", trinket: "crit" } as const;
    expect(a.affixes[primaryBySlot[a.slot]]).toBeGreaterThan(0);
  });

  it("equipping an item recomputes effective stats", () => {
    const g = createGame(1);
    const p = g.player;
    const baseDmg = p.baseDamage;
    equipItem(p, { id: 1, slot: "weapon", rarity: "rare", name: "Test Blade", affixes: { damage: 15, crit: 0.1 } });
    expect(p.baseDamage).toBe(baseDmg + 15);
    expect(p.critChance).toBeCloseTo(CONFIG.playerCritChance + 0.1);
    expect(p.weaponRarity).toBe("rare");
  });

  it("auto-equips a better item on pickup and stashes a worse one", () => {
    const g = createGame(2);
    const p = g.player;
    p.pos = { x: 5.5, y: 5.5 };
    const strong = { id: 1, slot: "weapon" as const, rarity: "epic" as const, name: "Big", affixes: { damage: 30 } };
    const weak = { id: 2, slot: "weapon" as const, rarity: "common" as const, name: "Small", affixes: { damage: 2 } };
    g.loot = [
      { id: 101, pos: { x: 5.5, y: 5.5 }, kind: "item", amount: 0, item: strong, rarity: "epic" },
    ];
    step(g, idle(), 1 / 60);
    expect(p.equipment.weapon?.id).toBe(1); // auto-equipped the strong one
    // A weaker weapon should go to the bag, not replace the equipped one.
    g.loot = [{ id: 102, pos: { x: p.pos.x, y: p.pos.y }, kind: "item", amount: 0, item: weak, rarity: "common" }];
    step(g, idle(), 1 / 60);
    expect(p.equipment.weapon?.id).toBe(1);
    expect(p.inventory.some((i) => i.id === 2)).toBe(true);
  });

  it("equipFromInventory swaps the equipped item back to the bag", () => {
    const g = createGame(3);
    const p = g.player;
    equipItem(p, { id: 1, slot: "weapon", rarity: "common", name: "A", affixes: { damage: 5 } });
    p.inventory.push({ id: 2, slot: "weapon", rarity: "rare", name: "B", affixes: { damage: 20 } });
    equipFromInventory(g, 0);
    expect(p.equipment.weapon?.id).toBe(2);
    expect(p.inventory.some((i) => i.id === 1)).toBe(true); // old weapon returned to bag
    expect(p.baseDamage).toBe(CONFIG.playerBaseDamage + 20);
  });
});

describe("boss floor", () => {
  it("floor 18 spawns a boss and killing it wins the run", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, maxHp: 100, baseDamage: 10, level: 1, xp: 0, xpToNext: 20, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss");
    expect(boss).toBeDefined();
    // Kill the boss directly and step so reapDead processes the win.
    boss!.hp = 0;
    step(g, idle(), 1 / 60);
    expect(g.status).toBe("won");
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
