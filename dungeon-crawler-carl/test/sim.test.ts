import { describe, it, expect } from "vitest";
import {
  createGame, restoreGame, step, equipItem, equipFromInventory, chooseReward, addHype,
  chooseUpgrade, learnAbility, buyShopItem, leaveSafeRoom, addPlayer, setReady,
} from "../src/sim/game";
import { ACHIEVEMENTS } from "../src/sim/achievements";
import { generateItem } from "../src/sim/items";
import { boltParams, knows, rank } from "../src/sim/abilities";
import { NO_INTENT, Tile, type FloorMap, type Intent, type Vec2 } from "../src/sim/types";
import { CONFIG, floorBand, floorTimeBudget } from "../src/sim/config";
import { createRng, nextFloat } from "../src/sim/rng";

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function mkMon(over: Partial<import("../src/sim/types").Monster> = {}) {
  return {
    id: 1, kind: "grunt" as const, pos: { x: 0, y: 0 },
    hp: 1, maxHp: 1, damage: 0, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0, ...over,
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
    const hpAtCollapse = g.players[0].hp;
    step(g, idle(), 0.1);
    expect(g.players[0].hp).toBeLessThan(hpAtCollapse);
    // Keep collapsing; player must eventually die.
    for (let i = 0; i < 2000 && g.players[0].alive; i++) step(g, idle(), 0.1);
    expect(g.players[0].alive).toBe(false);
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
    expect(g1.players[0].pos).toEqual(g2.players[0].pos);
    expect(g1.players[0].hp).toEqual(g2.players[0].hp);
    expect(g1.monsters.map((m) => m.hp)).toEqual(g2.monsters.map((m) => m.hp));
    expect(g1.players[0].gold).toEqual(g2.players[0].gold);
  });
});

describe("descent", () => {
  it("using the stairs opens a safe room; leaving it advances the floor", () => {
    const g = createGame(5);
    // Move the player onto the stairs directly (sim allows host-set positions).
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.safeRoom).not.toBeNull();
    expect(g.floor).toBe(1); // still "between" floors
    // Paused while in the safe room.
    const x0 = g.players[0].pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.players[0].pos.x).toBe(x0);
    leaveSafeRoom(g);
    expect(g.safeRoom).toBeNull();
    expect(g.floor).toBe(2);
    expect(g.phase).toBe("safe");
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(2));
  });

  it("does not descend when not on the stairs", () => {
    const g = createGame(5);
    g.players[0].pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    // Ensure spawn isn't coincidentally on the stairs.
    if (Math.hypot(g.players[0].pos.x - g.map.stairs.x, g.players[0].pos.y - g.map.stairs.y) > 1) {
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
    expect(restored.players[0].level).toBe(5);
    expect(restored.players[0].gold).toBe(140);
    expect(restored.players[0].maxHp).toBe(180);
    expect(restored.players[0].hp).toBe(55);
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
    g.players[0].facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 999, pos: { x: g.players[0].pos.x + 1, y: g.players[0].pos.y }, hp: 999, maxHp: 999, xp: 10 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const combat = g.hits.filter((h) => h.kind === "enemy" || h.kind === "crit");
    expect(combat.length).toBe(1);
    expect(combat[0].amount).toBeGreaterThan(0);
  });

  it("awards a loot box every N kills and records it", () => {
    const g = createGame(7);
    // Kill lootBoxEveryKills monsters in one swing by stacking them in-arc at point blank.
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].baseDamage = 100000;
    g.monsters.length = 0;
    for (let i = 0; i < CONFIG.lootBoxEveryKills; i++) {
      g.monsters.push(mkMon({ id: 1000 + i, pos: { x: g.players[0].pos.x + 0.6, y: g.players[0].pos.y } }));
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
    g.players[0].facing = { x: 1, y: 0 };
    const x0 = g.players[0].pos.x;
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, dash: true }, 1 / 60);
    // Cooldown + i-frames are set regardless of geometry; position never regresses.
    expect(g.players[0].dashCd).toBeGreaterThan(0);
    expect(g.players[0].dashTime).toBeGreaterThan(0);
    expect(g.players[0].pos.x).toBeGreaterThanOrEqual(x0);
  });

  it("bolt spawns a player projectile that damages a monster it reaches", () => {
    const g = createGame(11);
    g.players[0].facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + 2, y: g.players[0].pos.y }, hp: 999, maxHp: 999 }));
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
    g.monsters.push(mkMon({ id: 1, kind: "ranged", pos: { x: g.players[0].pos.x + 1.5, y: g.players[0].pos.y }, hp: 50, maxHp: 50, damage: 5, attackRange: 6.5 }));
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
    const p = g.players[0];
    const baseDmg = p.baseDamage;
    equipItem(p, { id: 1, slot: "weapon", rarity: "rare", name: "Test Blade", affixes: { damage: 15, crit: 0.1 } });
    expect(p.baseDamage).toBe(baseDmg + 15);
    expect(p.critChance).toBeCloseTo(CONFIG.playerCritChance + 0.1);
    expect(p.weaponRarity).toBe("rare");
  });

  it("auto-equips a better item on pickup and stashes a worse one", () => {
    const g = createGame(2);
    const p = g.players[0];
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
    const p = g.players[0];
    equipItem(p, { id: 1, slot: "weapon", rarity: "common", name: "A", affixes: { damage: 5 } });
    p.inventory.push({ id: 2, slot: "weapon", rarity: "rare", name: "B", affixes: { damage: 20 } });
    equipFromInventory(g, 0, 0);
    expect(p.equipment.weapon?.id).toBe(2);
    expect(p.inventory.some((i) => i.id === 1)).toBe(true); // old weapon returned to bag
    expect(p.baseDamage).toBe(CONFIG.playerBaseDamage + 20);
  });
});

describe("the show (viewers / favorites / sponsors)", () => {
  it("sustained hype grows favorites and earns sponsors", () => {
    const g = createGame(1);
    const p = g.players[0];
    expect(p.sponsors).toBe(0);
    for (let i = 0; i < 200; i++) {
      addHype(g, p, 60); // exciting play every step
      step(g, idle(), 1 / 60);
    }
    expect(p.favorites).toBeGreaterThan(CONFIG.show.sponsorThresholds[0]);
    expect(p.sponsors).toBeGreaterThanOrEqual(1);
    expect(p.viewers).toBeGreaterThan(CONFIG.show.baseViewers);
  });

  it("killing a monster adds hype", () => {
    const g = createGame(2);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y }, hp: 1, maxHp: 1 }));
    const before = g.players[0].hype;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].hype).toBeGreaterThan(before);
  });
});

describe("sponsor draft", () => {
  it("leaving the safe room opens a personal reward draft (world keeps running)", () => {
    const g = createGame(5);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(2);
    expect(g.players[0].pendingRewards.length).toBeGreaterThan(0);
    // Multiplayer-safe: movement still works while the draft pends.
    const x0 = g.players[0].pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.players[0].pos.x).toBeGreaterThan(x0);
    // Choosing clears the draft.
    chooseReward(g, 0, 0);
    expect(g.players[0].pendingRewards.length).toBe(0);
  });

  it("applies the chosen reward's effect", () => {
    const g = createGame(6);
    const p = g.players[0];
    const dmg0 = p.baseDamage;
    g.players[0].pendingRewards = [{ id: 1, kind: "damage", title: "Weapon Mod", desc: "+10 damage", amount: 10 }];
    chooseReward(g, 0, 0);
    expect(p.baseDamage).toBe(dmg0 + 10);
    expect(g.players[0].pendingRewards.length).toBe(0);
  });

  it("generates a deterministic draft for the same seed/floor", () => {
    function draftTitles(seed: number) {
      const g = createGame(seed);
      g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
      leaveSafeRoom(g);
      return g.players[0].pendingRewards.map((r) => r.kind);
    }
    expect(draftTitles(77)).toEqual(draftTitles(77));
  });
});

describe("safe room + shop", () => {
  function reachSafeRoom(seed: number) {
    const g = createGame(seed);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    return g;
  }

  it("stocks a deterministic shop for the same seed", () => {
    const stock = (seed: number) =>
      reachSafeRoom(seed).safeRoom!.stock.map((s) => `${s.kind}:${s.title}:${s.price}`);
    expect(stock(300)).toEqual(stock(300));
    expect(reachSafeRoom(300).safeRoom!.stock.length).toBeGreaterThanOrEqual(5);
  });

  it("buying deducts gold, applies the effect, and marks the item sold", () => {
    const g = reachSafeRoom(301);
    const room = g.safeRoom!;
    const healIdx = room.stock.findIndex((s) => s.kind === "heal");
    g.players[0].hp = 10;
    g.players[0].gold = 10_000;
    const gold0 = g.players[0].gold;
    buyShopItem(g, 0, healIdx);
    expect(g.players[0].hp).toBeGreaterThan(10);
    expect(g.players[0].gold).toBe(gold0 - room.stock[healIdx].price);
    expect(room.stock[healIdx].sold).toBe(true);
    expect(g.players[0].goldSpent).toBe(room.stock[healIdx].price);
    // Re-buying a sold item is a no-op.
    buyShopItem(g, 0, healIdx);
    expect(g.players[0].gold).toBe(gold0 - room.stock[healIdx].price);
  });

  it("cannot buy what you cannot afford", () => {
    const g = reachSafeRoom(302);
    g.players[0].gold = 0;
    buyShopItem(g, 0, 0);
    expect(g.safeRoom!.stock[0].sold).toBe(false);
    expect(g.players[0].goldSpent).toBe(0);
  });

  it("a purchased stabilizer extends the next floor's timer", () => {
    const g = reachSafeRoom(303);
    const room = g.safeRoom!;
    const timeIdx = room.stock.findIndex((s) => s.kind === "time");
    g.players[0].gold = 10_000;
    buyShopItem(g, 0, timeIdx);
    leaveSafeRoom(g);
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(2) + 15);
  });

  it("sells a tome that teaches the ability on the spot", () => {
    const g = reachSafeRoom(304);
    const room = g.safeRoom!;
    const tomeIdx = room.stock.findIndex((s) => s.kind === "tome");
    expect(tomeIdx).toBeGreaterThanOrEqual(0); // both abilities undiscovered at floor 1
    g.players[0].gold = 10_000;
    buyShopItem(g, 0, tomeIdx);
    expect(knows(g.players[0], room.stock[tomeIdx].ability!)).toBe(true);
  });

  it("floor 18 still wins immediately without a safe room", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, maxHp: 100, baseDamage: 10, level: 1, xp: 0, xpToNext: 20, gold: 0 },
    });
    for (const m of g.monsters) m.hp = 0;
    step(g, idle(), 1 / 60);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.status).toBe("won");
    expect(g.safeRoom).toBeNull();
  });
});

describe("achievements", () => {
  it("FIRST BLOOD unlocks on the first kill with a payout", () => {
    const g = createGame(400);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y } }));
    const gold0 = g.players[0].gold;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements).toContain("first_blood");
    expect(g.players[0].gold).toBeGreaterThan(gold0);
    expect(g.announcements.some((a) => a.includes("FIRST BLOOD"))).toBe(true);
    // Never unlocks twice.
    g.monsters.push(mkMon({ id: 2, pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y } }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements.filter((a) => a === "first_blood").length).toBe(1);
  });

  it("DIRTY FIGHTER unlocks on a 3-kill instant", () => {
    const g = createGame(401);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].baseDamage = 9999;
    g.monsters.length = 0;
    for (let i = 0; i < 3; i++) {
      g.monsters.push(mkMon({ id: 10 + i, pos: { x: g.players[0].pos.x + 0.7, y: g.players[0].pos.y } }));
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements).toContain("dirty_fighter");
  });

  it("COLLECTOR'S EDITION unlocks once both abilities are learned", () => {
    const g = createGame(402);
    learnAbility(g, g.players[0], "nova");
    learnAbility(g, g.players[0], "orbit");
    step(g, idle(), 1 / 60);
    expect(g.players[0].achievements).toContain("collector");
  });

  it("achievements persist through save/restore", () => {
    const restored = restoreGame({
      seed: 403, floor: 2,
      player: {
        hp: 90, level: 2, xp: 0, xpToNext: 27, gold: 5,
        achievements: ["first_blood", "crumbs"], goldSpent: 120,
      },
    });
    expect(restored.players[0].achievements).toEqual(["first_blood", "crumbs"]);
    expect(restored.players[0].goldSpent).toBe(120);
  });

  it("every achievement id is unique", () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
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

describe("ability tree + upgrade drafts", () => {
  it("leveling up opens a personal upgrade draft without pausing the world", () => {
    const g = createGame(31);
    g.players[0].xp = g.players[0].xpToNext; // one level-up on the next XP grant
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y }, xp: 1 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].level).toBe(2);
    expect(g.players[0].pendingUpgrades.length).toBeGreaterThan(0);
    // Multiplayer-safe: the world KEEPS RUNNING while the draft pends.
    const x0 = g.players[0].pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.players[0].pos.x).toBeGreaterThan(x0);
    // Choosing applies the node rank.
    const offer = g.players[0].pendingUpgrades[0];
    chooseUpgrade(g, 0, 0);
    expect(rank(g.players[0], offer.id)).toBe(offer.nextRank);
    expect(g.players[0].pendingUpgrades.length).toBe(0);
  });

  it("offers only upgrades for known abilities, deterministically per seed", () => {
    function offers(seed: number) {
      const g = createGame(seed);
      g.players[0].upgradeDraftsOwed = 1;
      step(g, idle(), 1 / 60);
      return g.players[0].pendingUpgrades.map((u) => u.id);
    }
    const a = offers(88);
    expect(a.length).toBe(CONFIG.upgradeDraftSize);
    expect(a).toEqual(offers(88));
    const g = createGame(88);
    g.players[0].upgradeDraftsOwed = 1;
    step(g, idle(), 1 / 60);
    for (const u of g.players[0].pendingUpgrades) expect(knows(g.players[0], u.ability)).toBe(true);
  });

  it("Split Shot fires a fan of bolts", () => {
    const g = createGame(12);
    g.players[0].abilities.ranks["bolt.split"] = 2;
    expect(boltParams(g.players[0]).count).toBe(3);
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.projectiles.filter((p) => p.from === "player").length).toBe(3);
  });

  it("a tome pickup teaches the ability; nova then works", () => {
    const g = createGame(13);
    const p = g.players[0];
    expect(knows(p, "nova")).toBe(false);
    g.loot = [{ id: 900, pos: { x: p.pos.x, y: p.pos.y }, kind: "tome", amount: 0, ability: "nova" }];
    step(g, idle(), 1 / 60);
    expect(knows(p, "nova")).toBe(true);
    expect(g.loot.length).toBe(0);
    // Nova now damages nearby monsters.
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, nova: true }, 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
    expect(p.novaCd).toBeGreaterThan(0);
  });

  it("nova does nothing before it is learned", () => {
    const g = createGame(14);
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + 1, y: g.players[0].pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, nova: true }, 1 / 60);
    expect(g.monsters[0].hp).toBe(500);
  });

  it("orbit blades tick damage automatically once learned", () => {
    const g = createGame(15);
    learnAbility(g, g.players[0], "orbit");
    g.monsters.length = 0;
    // Park a monster on the orbit circle; some tick within a full revolution must hit.
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + CONFIG.orbitRadius, y: g.players[0].pos.y }, hp: 500, maxHp: 500 }));
    for (let i = 0; i < 120 && g.monsters[0]?.hp === 500; i++) step(g, idle(), 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
  });

  it("abilities persist through save shape (restore)", () => {
    const restored = restoreGame({
      seed: 50, floor: 2,
      player: {
        hp: 90, level: 4, xp: 0, xpToNext: 50, gold: 10,
        abilities: { known: ["melee", "dash", "bolt", "nova"], ranks: { "nova.bang": 1 } },
      },
    });
    expect(knows(restored.players[0], "nova")).toBe(true);
    expect(rank(restored.players[0], "nova.bang")).toBe(1);
  });
});

describe("fog of war", () => {
  it("reveals tiles around the player and leaves distant tiles hidden", () => {
    const g = createGame(60);
    step(g, idle(), 1 / 60);
    const { map, explored } = g;
    const player = g.players[0];
    const at = (x: number, y: number) => explored[Math.floor(y) * map.w + Math.floor(x)];
    expect(at(player.pos.x, player.pos.y)).toBe(1);
    // A tile far outside the vision radius stays dark (corners are far from any spawn
    // within a 48x48 grid given fogVisionRadius).
    const far = [{ x: 0, y: 0 }, { x: map.w - 1, y: 0 }, { x: 0, y: map.h - 1 }, { x: map.w - 1, y: map.h - 1 }]
      .find((c) => Math.hypot(c.x - player.pos.x, c.y - player.pos.y) > CONFIG.fogVisionRadius + 2)!;
    expect(explored[far.y * map.w + far.x]).toBe(0);
    expect(g.exploredVersion).toBeGreaterThan(0);
  });

  it("explored tiles persist as the player moves away (fog is memory, not light)", () => {
    const g = createGame(61);
    step(g, idle(), 1 / 60);
    const { map } = g;
    const startIdx = Math.floor(g.players[0].pos.y) * map.w + Math.floor(g.players[0].pos.x);
    // Teleport far away and step; the start tile must remain explored.
    g.players[0].pos = { x: map.stairs.x, y: map.stairs.y };
    step(g, idle(), 1 / 60);
    expect(g.explored[startIdx]).toBe(1);
  });
});

describe("multiplayer party sim", () => {
  it("addPlayer drops a second crawler in with a fresh kit", () => {
    const g = createGame(700);
    const donut = addPlayer(g, "Donut");
    expect(g.players.length).toBe(2);
    expect(donut.id).toBe(1);
    expect(donut.alive).toBe(true);
    expect(g.announcements.some((a) => a.includes("Donut"))).toBe(true);
  });

  it("per-player intents move players independently", () => {
    const g = createGame(701);
    addPlayer(g, "Donut");
    const [a, b] = g.players;
    const ax0 = a.pos.x, bx0 = b.pos.x;
    for (let i = 0; i < 30; i++) {
      step(g, { [a.id]: { ...idle(), move: { x: 1, y: 0 } }, [b.id]: { ...idle(), move: { x: -1, y: 0 } } }, 1 / 60);
    }
    expect(a.pos.x).toBeGreaterThan(ax0);
    expect(b.pos.x).toBeLessThan(bx0);
  });

  it("kill XP splits across living party members", () => {
    const g = createGame(702);
    addPlayer(g, "Donut");
    const [a, b] = g.players;
    a.facing = { x: 1, y: 0 };
    a.baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: a.pos.x + 0.8, y: a.pos.y }, xp: 10 }));
    step(g, { [a.id]: { ...idle(), attack: true, aim: { x: 1, y: 0 } } }, 1 / 60);
    expect(a.xp).toBe(5);
    expect(b.xp).toBe(5);
    // Kill credit goes to the killer only.
    expect(a.kills).toBe(1);
    expect(b.kills).toBe(0);
  });

  it("monsters hunt the nearest living player", () => {
    const g = createGame(703);
    addPlayer(g, "Donut");
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.projectiles.length = 0;
    // Park B far away; put a grunt right next to A with real damage.
    b.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    g.monsters.push(mkMon({ id: 1, pos: { x: a.pos.x + 0.5, y: a.pos.y }, hp: 999, maxHp: 999, damage: 5, speed: 0 }));
    const aHp = a.hp, bHp = b.hp;
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60);
    expect(a.hp).toBeLessThan(aHp); // A (nearest) got hit
    expect(b.hp).toBe(bHp); // B untouched
  });

  it("one death is not a wipe; a full wipe ends the run", () => {
    const g = createGame(704);
    addPlayer(g, "Donut");
    const [a, b] = g.players;
    a.hp = 1;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: a.pos.x + 0.5, y: a.pos.y }, hp: 999, maxHp: 999, damage: 50, speed: 0 }));
    b.pos = { x: g.map.stairs.x, y: g.map.stairs.y }; // B far away and safe
    for (let i = 0; i < 120 && a.alive; i++) step(g, idle(), 1 / 60);
    expect(a.alive).toBe(false);
    expect(g.status).toBe("playing"); // show goes on
    // Now B goes down too.
    b.hp = 1;
    g.monsters[0].pos = { x: b.pos.x + 0.5, y: b.pos.y };
    for (let i = 0; i < 120 && b.alive; i++) step(g, idle(), 1 / 60);
    expect(g.status).toBe("dead");
  });

  it("safe room requires everyone ready; dead players respawn at half HP on descent", () => {
    const g = createGame(705);
    addPlayer(g, "Donut");
    const [a, b] = g.players;
    b.alive = false;
    b.hp = 0;
    a.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { [a.id]: { ...idle(), useStairs: true } }, 1 / 60);
    expect(g.safeRoom).not.toBeNull();
    setReady(g, a.id);
    expect(g.safeRoom).not.toBeNull(); // B hasn't readied
    setReady(g, b.id);
    expect(g.safeRoom).toBeNull();
    expect(g.floor).toBe(2);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(Math.round(b.maxHp * 0.5));
  });

  it("party runs stay deterministic with PartyIntents", () => {
    function play(seed: number) {
      const g = createGame(seed);
      addPlayer(g, "Donut");
      for (let i = 0; i < 240; i++) {
        step(g, {
          0: { ...idle(), move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 } },
          1: { ...idle(), move: { x: 0, y: 1 }, bolt: i % 30 === 0 },
        }, 1 / 60);
      }
      return {
        pos: g.players.map((p) => ({ ...p.pos })),
        hp: g.players.map((p) => p.hp),
        kills: g.players.map((p) => p.kills),
        monsters: g.monsters.map((m) => m.hp),
      };
    }
    expect(play(808)).toEqual(play(808));
  });
});

describe("wide hallways + bigger floors", () => {
  it("every walkable tile belongs to a 2x2 walkable block (no 1-wide chokepoints)", () => {
    for (const seed of [11, 222, 3333]) {
      const g = createGame(seed);
      const { w, h, tiles } = g.map;
      const walk = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x] !== 0; // 0 = Wall
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!walk(x, y)) continue;
          // Part of at least one fully-walkable 2x2 block.
          let ok = false;
          for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
            if (walk(x + ox, y + oy) && walk(x + ox + 1, y + oy) &&
                walk(x + ox, y + oy + 1) && walk(x + ox + 1, y + oy + 1)) { ok = true; break; }
          }
          expect(ok, `1-wide tile at ${x},${y} (seed ${seed})`).toBe(true);
        }
      }
    }
  });

  it("floors are 72x72 with a longer base timer", () => {
    const g = createGame(1);
    expect(g.map.w).toBe(72);
    expect(g.map.h).toBe(72);
    expect(floorTimeBudget(1)).toBe(120);
  });
});

describe("multiplayer difficulty scaling", () => {
  function floor2MonsterStats(partySize: number) {
    const g = createGame(4242);
    for (let i = 1; i < partySize; i++) addPlayer(g, `P${i}`);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g); // floor 2 built with the current party size
    return {
      count: g.monsters.length,
      avgHp: g.monsters.reduce((s, m) => s + m.maxHp, 0) / g.monsters.length,
      avgDmg: g.monsters.reduce((s, m) => s + m.damage, 0) / g.monsters.length,
    };
  }

  it("party floors spawn more and tougher monsters than solo (same seed)", () => {
    const solo = floor2MonsterStats(1);
    const trio = floor2MonsterStats(3);
    expect(trio.count).toBeGreaterThan(solo.count);
    expect(trio.avgHp).toBeGreaterThan(solo.avgHp * 1.5);
    expect(trio.avgDmg).toBeGreaterThan(solo.avgDmg * 1.2);
  });
});

describe("per-player show economy", () => {
  it("the killer's audience grows; the bystander's does not", () => {
    const g = createGame(505);
    addPlayer(g, "Donut");
    const [carl, donut] = g.players;
    carl.facing = { x: 1, y: 0 };
    carl.baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: carl.pos.x + 0.8, y: carl.pos.y } }));
    step(g, { [carl.id]: { ...idle(), attack: true, aim: { x: 1, y: 0 } } }, 1 / 60);
    expect(carl.hype).toBeGreaterThan(0);
    expect(donut.hype).toBe(0);
  });

  it("sponsors are earned per player and drive that player's reward quality", () => {
    const g = createGame(506);
    addPlayer(g, "Donut");
    const [carl, donut] = g.players;
    // Carl sustains a hyped broadcast; Donut idles.
    for (let i = 0; i < 200; i++) {
      addHype(g, carl, 60);
      step(g, idle(), 1 / 60);
    }
    expect(carl.sponsors).toBeGreaterThanOrEqual(1);
    expect(donut.sponsors).toBe(0);
  });
});

describe("cumulative damage stats", () => {
  it("tracks damage dealt by the attacker and damage taken by the victim", () => {
    const g = createGame(606);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 9999, maxHp: 9999, damage: 5, speed: 0, attackCooldown: 0 }));
    // One swing lands; the monster also swings back over time.
    for (let i = 0; i < 90; i++) {
      step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    }
    expect(p.damageDealt).toBeGreaterThan(0);
    expect(p.damageTaken).toBeGreaterThan(0);
    // Dealt matches what the monster lost.
    expect(Math.round(p.damageDealt)).toBe(9999 - g.monsters[0].hp);
  });

  it("persists damage stats through save/restore", () => {
    const restored = restoreGame({
      seed: 607, floor: 2,
      player: { hp: 90, level: 2, xp: 0, xpToNext: 27, gold: 0, damageDealt: 321, damageTaken: 123 },
    });
    expect(restored.players[0].damageDealt).toBe(321);
    expect(restored.players[0].damageTaken).toBe(123);
  });
});

describe("boss hierarchy", () => {
  function onFloor(floor: number, seed = 909) {
    return restoreGame({
      seed, floor,
      player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
  }

  it("ordinary floors (2+) spawn one named neighborhood boss with boosted stats", () => {
    const g = onFloor(3);
    const elites = g.monsters.filter((m) => m.elite);
    expect(elites.length).toBe(1);
    expect(elites[0].eliteName).toBeTruthy();
    expect(elites[0].kind).not.toBe("boss");
  });

  it("floor 1 has no elite; city-boss floors (6, 12) spawn a sealed city boss", () => {
    expect(onFloor(1).monsters.some((m) => m.elite)).toBe(false);
    for (const f of [6, 12]) {
      const g = onFloor(f);
      const boss = g.monsters.find((m) => m.kind === "boss");
      expect(boss).toBeDefined();
      expect(boss!.eliteName).toBeTruthy();
      expect(boss!.maxHp).toBeLessThan(CONFIG.bossHp); // scaled below the final boss
      // Exit sealed while the boss lives.
      g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
      expect(g.safeRoom).toBeNull();
      expect(g.floor).toBe(f);
    }
  });

  it("killing a city boss unseals the floor (and does not win the run)", () => {
    const g = onFloor(6);
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    boss.hp = 0;
    step(g, idle(), 1 / 60);
    expect(g.status).toBe("playing");
    expect(g.loot.some((l) => l.kind === "item")).toBe(true); // guaranteed bonus drops
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.safeRoom).not.toBeNull(); // unsealed
  });

  it("killing the neighborhood boss drops bonus loot and announces by name", () => {
    const g = onFloor(4);
    const elite = g.monsters.find((m) => m.elite)!;
    const name = elite.eliteName!;
    elite.hp = 0;
    step(g, idle(), 1 / 60);
    expect(g.announcements.some((a) => a.includes(name) && a.includes("DOWN"))).toBe(true);
    expect(g.loot.some((l) => l.kind === "item")).toBe(true);
  });
});

describe("new archetypes", () => {
  it("bomber explodes on contact, damaging the player, and dies in its own blast", () => {
    const g = createGame(900);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    g.monsters.push(mkMon({
      id: 1, kind: "bomber", pos: { x: p.pos.x + 0.5, y: p.pos.y },
      hp: 30, maxHp: 30, damage: 10, attackRange: 0.9,
    }));
    const hp0 = p.hp;
    step(g, idle(), 1 / 60);
    expect(p.hp).toBeLessThan(hp0); // caught in the blast
    expect(g.monsters.length).toBe(0); // the bomber died and was reaped normally
    expect(g.killCount).toBe(1);
    expect(g.hits.some((h) => h.kind === "player")).toBe(true);
    expect(g.announcements.some((a) => a.includes("bomber"))).toBe(true);
  });

  it("a bomber shot down at range cooks off at half radius (near miss = no damage)", () => {
    const g = createGame(903);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    // Inside the full 1.6-tile radius but outside the half (0.8-tile) death blast.
    const bomber = mkMon({
      id: 1, kind: "bomber", pos: { x: p.pos.x + 1.2, y: p.pos.y },
      hp: 30, maxHp: 30, damage: 10, speed: 0, attackRange: 0.9, lastHitBy: 0,
    });
    g.monsters.push(bomber);
    bomber.hp = 0; // "shot down" before reaching anyone
    const hp0 = p.hp;
    step(g, idle(), 1 / 60);
    expect(g.monsters.length).toBe(0); // reaped, with kill credit
    expect(g.players[0].kills).toBe(1);
    expect(p.hp).toBe(hp0); // half-radius danger zone fell short
  });

  it("shaman heals the lowest-HP wounded monster nearby and emits a heal hit", () => {
    const g = createGame(901);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const wounded = mkMon({ id: 2, pos: { x: p.pos.x + 5, y: p.pos.y + 1 }, hp: 10, maxHp: 50 });
    const healthier = mkMon({ id: 3, pos: { x: p.pos.x + 5, y: p.pos.y - 1 }, hp: 30, maxHp: 50 });
    const shaman = mkMon({
      id: 1, kind: "shaman", pos: { x: p.pos.x + 5, y: p.pos.y },
      hp: 40, maxHp: 40, attackRange: 5.5,
    });
    g.monsters.push(shaman, wounded, healthier);
    step(g, idle(), 1 / 60);
    expect(wounded.hp).toBe(10 + CONFIG.shamanHeal); // picked the most wounded ally
    expect(healthier.hp).toBe(30);
    expect(shaman.healCd).toBeGreaterThan(0);
    expect(g.hits.some((h) => h.kind === "heal" && h.amount === CONFIG.shamanHeal)).toBe(true);
  });

  it("phantom blinks toward the player, closing far more than a walk step", () => {
    const g = createGame(902);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    g.map.tiles.fill(1); // open floor everywhere so walls can't clip the blink
    const ph = mkMon({
      id: 1, kind: "phantom", pos: { x: p.pos.x + 6, y: p.pos.y },
      hp: 20, maxHp: 20, speed: 0, attackRange: 1.0,
    });
    g.monsters.push(ph);
    step(g, idle(), 1 / 60);
    const d1 = Math.hypot(ph.pos.x - p.pos.x, ph.pos.y - p.pos.y);
    expect(6 - d1).toBeGreaterThan(2); // a blink (~3 tiles), not a walk step
    expect(ph.blinkCd).toBeGreaterThan(0);
  });
});

describe("theme bands", () => {
  it("maps floors to 4-floor bands", () => {
    expect([1, 4, 5, 8, 9, 12, 13, 16, 17, 18].map((f) => floorBand(f)))
      .toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("announces the district when crossing a band boundary (4 -> 5)", () => {
    const g = restoreGame({
      seed: 71, floor: 4,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(5);
    expect(g.announcements.some((a) => a.includes("THE SEWERS"))).toBe(true);
  });

  it("does not re-announce within a band (5 -> 6)", () => {
    const g = restoreGame({
      seed: 72, floor: 5,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    // Floor 5 may be locked (3+); teleporting to stairs is host-level, doors ignored.
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(6);
    expect(g.announcements.some((a) => a.includes("Now entering"))).toBe(false);
  });
});

describe("no-op safety", () => {
  it("stepping a finished game is a no-op", () => {
    const g = createGame(1);
    g.status = "won";
    const before = JSON.stringify(g.players[0].pos);
    step(g, NO_INTENT, 1 / 60);
    expect(JSON.stringify(g.players[0].pos)).toBe(before);
  });
});

describe("locked floors", () => {
  /** BFS over walkable tiles (4-connectivity); DoorLocked blocks like Wall. */
  function reachable(map: FloorMap, from: Vec2): Uint8Array {
    const seen = new Uint8Array(map.w * map.h);
    const queue = [Math.floor(from.y) * map.w + Math.floor(from.x)];
    seen[queue[0]] = 1;
    while (queue.length > 0) {
      const i = queue.shift()!;
      const x = i % map.w, y = Math.floor(i / map.w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
        const ni = ny * map.w + nx;
        const t = map.tiles[ni];
        if (seen[ni] || t === Tile.Wall || t === Tile.DoorLocked) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return seen;
  }
  const canReach = (map: FloorMap, from: Vec2, to: Vec2) =>
    !!reachable(map, from)[Math.floor(to.y) * map.w + Math.floor(to.x)];
  const doorCount = (map: FloorMap) =>
    Array.from(map.tiles).filter((t) => t === Tile.DoorLocked).length;
  const atFloor = (seed: number, floor: number) =>
    restoreGame({ seed, floor, player: { hp: 100, level: 1, xp: 0, xpToNext: 20, gold: 0 } });

  // Seeds whose floor-3 layouts lock (the generator's softlock guard may decline
  // a layout where sealing the stairs room would cut off a grazing corridor).
  const LOCKED_SEEDS = [1, 2, 9, 28];

  it("floors >= 3 seal the stairs room: stairs unreachable, every other room reachable", () => {
    for (const seed of LOCKED_SEEDS) {
      const g = atFloor(seed, 3);
      const map = g.map;
      expect(map.locked).toBe(true);
      expect(doorCount(map)).toBeGreaterThan(0);
      expect(g.announcements.some((a) => a.includes("LOCKED"))).toBe(true);
      // Spawn -> stairs is blocked by the locked doors...
      expect(canReach(map, map.spawn, map.stairs)).toBe(false);
      // ...but every room other than the stairs room stays reachable.
      const seen = reachable(map, map.spawn);
      map.rooms.forEach((r, i) => {
        if (i === map.lockedRoomIdx) return;
        const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
        expect(seen[cy * map.w + cx]).toBe(1);
      });
    }
  });

  it("exactly one non-boss monster carries the key, and it is reachable", () => {
    for (const seed of LOCKED_SEEDS) {
      const g = atFloor(seed, 3);
      const carriers = g.monsters.filter((m) => m.hasKey);
      expect(carriers.length).toBe(1);
      expect(carriers[0].kind).not.toBe("boss");
      // The carrier is never sealed inside the stairs district (softlock guard).
      expect(canReach(g.map, g.map.spawn, carriers[0].pos)).toBe(true);
    }
  });

  it("killing the carrier drops a key; picking it up opens every door", () => {
    const g = atFloor(2, 3);
    expect(g.map.locked).toBe(true);
    const doorsBefore = doorCount(g.map);
    expect(doorsBefore).toBeGreaterThan(0);
    const carrier = g.monsters.find((m) => m.hasKey)!;
    // Kill the carrier: the key ALWAYS drops.
    carrier.hp = 0;
    step(g, idle(), 1 / 60);
    const key = g.loot.find((l) => l.kind === "key");
    expect(key).toBeDefined();
    expect(g.announcements.some((a) => a.includes("KEYHOLDER"))).toBe(true);
    // Walk onto the key: all doors open, geometry version bumps, stairs open up.
    const versionBefore = g.mapVersion;
    g.players[0].pos = { x: key!.pos.x, y: key!.pos.y };
    step(g, idle(), 1 / 60);
    expect(g.loot.some((l) => l.kind === "key")).toBe(false);
    expect(doorCount(g.map)).toBe(0);
    expect(g.map.locked).toBe(false);
    expect(g.mapVersion).toBe(versionBefore + 1);
    expect(g.announcements.some((a) => a.includes("OPEN"))).toBe(true);
    expect(canReach(g.map, g.map.spawn, g.map.stairs)).toBe(true);
  });

  it("picking up the key pays out hype", () => {
    const g = atFloor(9, 3);
    g.loot = [{ id: 9001, pos: { x: g.players[0].pos.x, y: g.players[0].pos.y }, kind: "key", amount: 0 }];
    const hype0 = g.players[0].hype;
    step(g, idle(), 1 / 60);
    expect(g.players[0].hype).toBeGreaterThan(hype0);
  });

  it("floors 1-2 have no locked doors and no key carrier", () => {
    for (const seed of [1, 2, 3, 9]) {
      for (const floor of [1, 2]) {
        const g = floor === 1 ? createGame(seed) : atFloor(seed, 2);
        expect(g.map.locked).toBe(false);
        expect(g.map.lockedRoomIdx).toBe(-1);
        expect(doorCount(g.map)).toBe(0);
        expect(g.monsters.some((m) => m.hasKey)).toBe(false);
        expect(canReach(g.map, g.map.spawn, g.map.stairs)).toBe(true);
      }
    }
  });

  it("locked floors stay deterministic (same doors, same carrier)", () => {
    const a = atFloor(2, 3);
    const b = atFloor(2, 3);
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(a.monsters.find((m) => m.hasKey)?.id).toBe(b.monsters.find((m) => m.hasKey)?.id);
  });
});
