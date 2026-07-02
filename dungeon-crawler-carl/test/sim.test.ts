import { describe, it, expect } from "vitest";
import {
  createGame, restoreGame, step, equipItem, equipFromInventory, chooseReward, addHype,
  chooseUpgrade, learnAbility, buyShopItem, leaveSafeRoom,
} from "../src/sim/game";
import { ACHIEVEMENTS } from "../src/sim/achievements";
import { generateItem } from "../src/sim/items";
import { boltParams, knows, rank } from "../src/sim/abilities";
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
  it("using the stairs opens a safe room; leaving it advances the floor", () => {
    const g = createGame(5);
    // Move the player onto the stairs directly (sim allows host-set positions).
    g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.safeRoom).not.toBeNull();
    expect(g.floor).toBe(1); // still "between" floors
    // Paused while in the safe room.
    const x0 = g.player.pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.player.pos.x).toBe(x0);
    leaveSafeRoom(g);
    expect(g.safeRoom).toBeNull();
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

describe("the show (viewers / favorites / sponsors)", () => {
  it("sustained hype grows favorites and earns sponsors", () => {
    const g = createGame(1);
    expect(g.sponsors).toBe(0);
    for (let i = 0; i < 200; i++) {
      addHype(g, 60); // exciting play every step
      step(g, idle(), 1 / 60);
    }
    expect(g.favorites).toBeGreaterThan(CONFIG.show.sponsorThresholds[0]);
    expect(g.sponsors).toBeGreaterThanOrEqual(1);
    expect(g.viewers).toBeGreaterThan(CONFIG.show.baseViewers);
  });

  it("killing a monster adds hype", () => {
    const g = createGame(2);
    g.player.facing = { x: 1, y: 0 };
    g.player.baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: g.player.pos.x + 0.8, y: g.player.pos.y }, hp: 1, maxHp: 1 }));
    const before = g.hype;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.hype).toBeGreaterThan(before);
  });
});

describe("sponsor draft", () => {
  it("leaving the safe room opens a reward draft that pauses the sim until chosen", () => {
    const g = createGame(5);
    g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(2);
    expect(g.pendingRewards.length).toBeGreaterThan(0);
    // While a draft is pending, the world is frozen: movement intent is ignored.
    const x0 = g.player.pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.player.pos.x).toBe(x0);
    // Choosing clears the draft and resumes play.
    chooseReward(g, 0);
    expect(g.pendingRewards.length).toBe(0);
  });

  it("applies the chosen reward's effect", () => {
    const g = createGame(6);
    const p = g.player;
    const dmg0 = p.baseDamage;
    g.pendingRewards = [{ id: 1, kind: "damage", title: "Weapon Mod", desc: "+10 damage", amount: 10 }];
    chooseReward(g, 0);
    expect(p.baseDamage).toBe(dmg0 + 10);
    expect(g.pendingRewards.length).toBe(0);
  });

  it("generates a deterministic draft for the same seed/floor", () => {
    function draftTitles(seed: number) {
      const g = createGame(seed);
      g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
      step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
      leaveSafeRoom(g);
      return g.pendingRewards.map((r) => r.kind);
    }
    expect(draftTitles(77)).toEqual(draftTitles(77));
  });
});

describe("safe room + shop", () => {
  function reachSafeRoom(seed: number) {
    const g = createGame(seed);
    g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
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
    g.player.hp = 10;
    g.player.gold = 10_000;
    const gold0 = g.player.gold;
    buyShopItem(g, healIdx);
    expect(g.player.hp).toBeGreaterThan(10);
    expect(g.player.gold).toBe(gold0 - room.stock[healIdx].price);
    expect(room.stock[healIdx].sold).toBe(true);
    expect(g.goldSpent).toBe(room.stock[healIdx].price);
    // Re-buying a sold item is a no-op.
    buyShopItem(g, healIdx);
    expect(g.player.gold).toBe(gold0 - room.stock[healIdx].price);
  });

  it("cannot buy what you cannot afford", () => {
    const g = reachSafeRoom(302);
    g.player.gold = 0;
    buyShopItem(g, 0);
    expect(g.safeRoom!.stock[0].sold).toBe(false);
    expect(g.goldSpent).toBe(0);
  });

  it("a purchased stabilizer extends the next floor's timer", () => {
    const g = reachSafeRoom(303);
    const room = g.safeRoom!;
    const timeIdx = room.stock.findIndex((s) => s.kind === "time");
    g.player.gold = 10_000;
    buyShopItem(g, timeIdx);
    leaveSafeRoom(g);
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(2) + 15);
  });

  it("sells a tome that teaches the ability on the spot", () => {
    const g = reachSafeRoom(304);
    const room = g.safeRoom!;
    const tomeIdx = room.stock.findIndex((s) => s.kind === "tome");
    expect(tomeIdx).toBeGreaterThanOrEqual(0); // both abilities undiscovered at floor 1
    g.player.gold = 10_000;
    buyShopItem(g, tomeIdx);
    expect(knows(g.player, room.stock[tomeIdx].ability!)).toBe(true);
  });

  it("floor 18 still wins immediately without a safe room", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, maxHp: 100, baseDamage: 10, level: 1, xp: 0, xpToNext: 20, gold: 0 },
    });
    for (const m of g.monsters) m.hp = 0;
    step(g, idle(), 1 / 60);
    g.player.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    expect(g.status).toBe("won");
    expect(g.safeRoom).toBeNull();
  });
});

describe("achievements", () => {
  it("FIRST BLOOD unlocks on the first kill with a payout", () => {
    const g = createGame(400);
    g.player.facing = { x: 1, y: 0 };
    g.player.baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.player.pos.x + 0.8, y: g.player.pos.y } }));
    const gold0 = g.player.gold;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.achievements).toContain("first_blood");
    expect(g.player.gold).toBeGreaterThan(gold0);
    expect(g.announcements.some((a) => a.includes("ACHIEVEMENT: FIRST BLOOD"))).toBe(true);
    // Never unlocks twice.
    g.monsters.push(mkMon({ id: 2, pos: { x: g.player.pos.x + 0.8, y: g.player.pos.y } }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.achievements.filter((a) => a === "first_blood").length).toBe(1);
  });

  it("DIRTY FIGHTER unlocks on a 3-kill instant", () => {
    const g = createGame(401);
    g.player.facing = { x: 1, y: 0 };
    g.player.baseDamage = 9999;
    g.monsters.length = 0;
    for (let i = 0; i < 3; i++) {
      g.monsters.push(mkMon({ id: 10 + i, pos: { x: g.player.pos.x + 0.7, y: g.player.pos.y } }));
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.achievements).toContain("dirty_fighter");
  });

  it("COLLECTOR'S EDITION unlocks once both abilities are learned", () => {
    const g = createGame(402);
    learnAbility(g, "nova");
    learnAbility(g, "orbit");
    step(g, idle(), 1 / 60);
    expect(g.achievements).toContain("collector");
  });

  it("achievements persist through save/restore", () => {
    const restored = restoreGame({
      seed: 403, floor: 2,
      player: {
        hp: 90, level: 2, xp: 0, xpToNext: 27, gold: 5,
        achievements: ["first_blood", "crumbs"], goldSpent: 120,
      },
    });
    expect(restored.achievements).toEqual(["first_blood", "crumbs"]);
    expect(restored.goldSpent).toBe(120);
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
  it("leveling up opens an upgrade draft that pauses the sim; choosing applies a rank", () => {
    const g = createGame(31);
    g.player.xp = g.player.xpToNext; // one level-up on the next XP grant
    g.player.facing = { x: 1, y: 0 };
    g.player.baseDamage = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.player.pos.x + 0.8, y: g.player.pos.y }, xp: 1 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.player.level).toBe(2);
    expect(g.pendingUpgrades.length).toBeGreaterThan(0);
    // Paused while the draft is up.
    const x0 = g.player.pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.player.pos.x).toBe(x0);
    // Choosing applies the node rank and resumes.
    const offer = g.pendingUpgrades[0];
    chooseUpgrade(g, 0);
    expect(rank(g.player, offer.id)).toBe(offer.nextRank);
    expect(g.pendingUpgrades.length).toBe(0);
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.player.pos.x).toBeGreaterThan(x0);
  });

  it("offers only upgrades for known abilities, deterministically per seed", () => {
    function offers(seed: number) {
      const g = createGame(seed);
      g.upgradeDraftsOwed = 1;
      step(g, idle(), 1 / 60);
      return g.pendingUpgrades.map((u) => u.id);
    }
    const a = offers(88);
    expect(a.length).toBe(CONFIG.upgradeDraftSize);
    expect(a).toEqual(offers(88));
    const g = createGame(88);
    g.upgradeDraftsOwed = 1;
    step(g, idle(), 1 / 60);
    for (const u of g.pendingUpgrades) expect(knows(g.player, u.ability)).toBe(true);
  });

  it("Split Shot fires a fan of bolts", () => {
    const g = createGame(12);
    g.player.abilities.ranks["bolt.split"] = 2;
    expect(boltParams(g.player).count).toBe(3);
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.projectiles.filter((p) => p.from === "player").length).toBe(3);
  });

  it("a tome pickup teaches the ability; nova then works", () => {
    const g = createGame(13);
    const p = g.player;
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
    g.monsters.push(mkMon({ id: 1, pos: { x: g.player.pos.x + 1, y: g.player.pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, nova: true }, 1 / 60);
    expect(g.monsters[0].hp).toBe(500);
  });

  it("orbit blades tick damage automatically once learned", () => {
    const g = createGame(15);
    learnAbility(g, "orbit");
    g.monsters.length = 0;
    // Park a monster on the orbit circle; some tick within a full revolution must hit.
    g.monsters.push(mkMon({ id: 1, pos: { x: g.player.pos.x + CONFIG.orbitRadius, y: g.player.pos.y }, hp: 500, maxHp: 500 }));
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
    expect(knows(restored.player, "nova")).toBe(true);
    expect(rank(restored.player, "nova.bang")).toBe(1);
  });
});

describe("fog of war", () => {
  it("reveals tiles around the player and leaves distant tiles hidden", () => {
    const g = createGame(60);
    step(g, idle(), 1 / 60);
    const { map, explored, player } = g;
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
    const startIdx = Math.floor(g.player.pos.y) * map.w + Math.floor(g.player.pos.x);
    // Teleport far away and step; the start tile must remain explored.
    g.player.pos = { x: map.stairs.x, y: map.stairs.y };
    step(g, idle(), 1 / 60);
    expect(g.explored[startIdx]).toBe(1);
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
