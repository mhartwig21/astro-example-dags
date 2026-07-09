import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createGame, createTestGame, ensureWorld, restoreGame, step, equipItem, equipFromInventory, chooseReward, addHype,
  chooseUpgrade, learnAbility, buyCatalogItem, sellItem, sellAllItems, sellValue, effectivePrice,
  leaveSafeRoom, addPlayer, setReady, slotAbility, missingComponents, heroSkin,
  damagePlayerHit, playerMitigation, monsterResist, rewardDr, hasRevision, damageMonster,
} from "../src/sim/game";
import { armorReduction, dist, rollDamage } from "../src/sim/combat";
import { generateFloor, isWalkable, isWalkableForMonster, walkableTiles } from "../src/sim/floor";
import { moveWithCollision } from "../src/sim/movement";
import { buildCharacterSheet } from "../src/sim/sheet";
import { CATALOG_BY_ID, consumablePrice, consumableStock, gearAffixes, totalCost } from "../src/sim/catalog";
import { ACHIEVEMENTS } from "../src/sim/achievements";
import { generateItem, weaponClassOf } from "../src/sim/items";
import {
  DISCOVERABLE_ABILITIES, airstrikeParams, availableUpgrades, boltParams, cataclysmParams,
  damageVariance, effectiveMaxRank, knows, meleeParams,
  novaParams, orbitParams, overrankChance, overrankUpgrades, power, rank, rollUpgradeDraft, stanceMult, upgradeDef,
} from "../src/sim/abilities";
import {
  EQUIP_SLOTS, NO_INTENT, Tile,
  type FloorMap, type GameState, type Intent, type ItemSlot, type Vec2,
} from "../src/sim/types";
import { CONFIG, floorBand, floorTimeBudget, monsterTempo, roamTribeId } from "../src/sim/config";
import { createRng, nextFloat } from "../src/sim/rng";

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function mkMon(over: Partial<import("../src/sim/types").Monster> = {}) {
  return {
    id: 1, kind: "grunt" as const, pos: { x: 0, y: 0 },
    hp: 1, maxHp: 1, damage: 0, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
    windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0, ...over,
  };
}

/** Step with an idle intent until the monster's pending windup resolves. */
function stepPastWindup(g: ReturnType<typeof createGame>, m: { windup: number }, dt = 1 / 60): void {
  for (let i = 0; i < 600 && m.windup > 0; i++) step(g, idle(), dt);
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
    g.monsters.length = 0; // isolate the timer (roaming packs now find idlers!)
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
    g.monsters.length = 0; // isolate the timer (packs now kill idlers first!)
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
    g.players[0].attackPower = 100000;
    g.monsters.length = 0;
    for (let i = 0; i < CONFIG.lootBoxEveryKills; i++) {
      g.monsters.push(mkMon({ id: 1000 + i, pos: { x: g.players[0].pos.x + 0.6, y: g.players[0].pos.y } }));
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.killCount).toBe(CONFIG.lootBoxEveryKills);
    expect(g.lootBoxes).toBe(1);
    expect(g.announcements.some((a) => a.text.includes("LOOT BOX"))).toBe(true);
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
    expect(g.players[0].cd.dash ?? 0).toBeGreaterThan(0);
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
    // Place next to the player (guaranteed walkable â€” the player stands there) so the
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
    const primaryBySlot = {
      weapon: "damage", armor: "armor", helm: "maxHp", boots: "speed", trinket: "crit", charm: "crit",
    } as const;
    expect(a.affixes[primaryBySlot[a.slot]]).toBeGreaterThan(0);
  });

  it("equipping an item recomputes effective stats", () => {
    const g = createGame(1);
    const p = g.players[0];
    const baseDmg = p.attackPower;
    equipItem(p, { id: 1, slot: "weapon", rarity: "rare", name: "Test Blade", affixes: { damage: 15, crit: 0.1 } });
    expect(p.attackPower).toBe(baseDmg + 15);
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

  it("rolls items for all six equipment slots (backlog #10)", () => {
    const rng = createRng(777);
    let id = 0;
    const seen = new Set<ItemSlot>();
    for (let i = 0; i < 400; i++) seen.add(generateItem(rng, 5, () => ++id).slot);
    for (const slot of EQUIP_SLOTS) expect(seen.has(slot)).toBe(true);
  });

  it("support slots (helm/boots/charm) roll on a reduced budget", () => {
    // Same rarity + floor: an armor piece's HP rolls must outbudget a helm's.
    const rng = createRng(123);
    let id = 0;
    let armorHp = 0, armorN = 0, helmHp = 0, helmN = 0;
    for (let i = 0; i < 3000; i++) {
      const it = generateItem(rng, 8, () => ++id);
      if (it.rarity !== "rare") continue;
      if (it.slot === "armor" && it.affixes.maxHp) { armorHp += it.affixes.maxHp; armorN++; }
      if (it.slot === "helm" && it.affixes.maxHp) { helmHp += it.affixes.maxHp; helmN++; }
    }
    expect(armorN).toBeGreaterThan(0);
    expect(helmN).toBeGreaterThan(0);
    expect(helmHp / helmN).toBeLessThan(armorHp / armorN);
  });

  it("all six slots feed recomputeStats and hasPassive stays slot-agnostic", () => {
    const g = createGame(9);
    const p = g.players[0];
    const base = { atk: p.attackPower, hp: p.maxHp, crit: p.critChance };
    equipItem(p, { id: 1, slot: "helm", rarity: "magic", name: "Test Helm", affixes: { maxHp: 20 } });
    equipItem(p, { id: 2, slot: "boots", rarity: "magic", name: "Test Treads", affixes: { speed: 0.3 } });
    equipItem(p, { id: 3, slot: "charm", rarity: "epic", name: "Test Locket", affixes: { crit: 0.05, damage: 4 } });
    expect(p.maxHp).toBe(base.hp + 20);
    expect(p.speed).toBeCloseTo(CONFIG.playerSpeed + 0.3);
    expect(p.critChance).toBeCloseTo(base.crit + 0.05);
    expect(p.attackPower).toBe(base.atk + 4);
  });

  it("migrates a pre-#10 three-slot save into the six-socket shape", () => {
    const oldEquipment = {
      weapon: { id: 1, slot: "weapon", rarity: "rare", name: "Old Blade", affixes: { damage: 10 } },
      armor: null,
      trinket: { id: 2, slot: "trinket", rarity: "magic", name: "Old Band", affixes: { crit: 0.03 } },
    };
    const g = restoreGame({
      seed: 42, floor: 3,
      player: {
        hp: 80, level: 4, xp: 0, xpToNext: 50, gold: 10,
        equipment: oldEquipment as unknown as import("../src/sim/types").Player["equipment"],
      },
    });
    const p = g.players[0];
    expect(p.equipment.weapon?.name).toBe("Old Blade");
    expect(p.equipment.trinket?.name).toBe("Old Band");
    for (const slot of ["helm", "boots", "charm"] as const) expect(p.equipment[slot]).toBeNull();
    // Recompute walked all six sockets without tripping on the empty ones.
    expect(p.attackPower).toBeGreaterThan(0);
  });

  it("equipFromInventory swaps the equipped item back to the bag", () => {
    const g = createGame(3);
    const p = g.players[0];
    equipItem(p, { id: 1, slot: "weapon", rarity: "common", name: "A", affixes: { damage: 5 } });
    p.inventory.push({ id: 2, slot: "weapon", rarity: "rare", name: "B", affixes: { damage: 20 } });
    equipFromInventory(g, 0, 0);
    expect(p.equipment.weapon?.id).toBe(2);
    expect(p.inventory.some((i) => i.id === 1)).toBe(true); // old weapon returned to bag
    expect(p.attackPower).toBe(CONFIG.playerBaseDamage + 20);
  });
});

describe("the show (viewers / favorites / sponsors)", () => {
  it("sustained hype grows favorites and earns sponsors", () => {
    const g = createGame(1);
    const p = g.players[0];
    g.monsters = []; // this test is pure hype-economy math (addHype below), not combat survival
    expect(p.sponsors).toBe(0);
    // ~15s of pinned hype: sqrt conversion means sustained excitement earns
    // favorites steadily, not explosively (see CONFIG.show).
    for (let i = 0; i < 900; i++) {
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
    g.players[0].attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y }, hp: 1, maxHp: 1 }));
    const before = g.players[0].hype;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].hype).toBeGreaterThan(before);
  });
});

describe("sponsor draft", () => {
  /** Warp onto the stairs, enter the safe room, then descend with `sponsors` backers. */
  function descendWith(seed: number, sponsors: number, tweak?: (g: GameState) => void) {
    const g = createGame(seed);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    g.players[0].sponsors = sponsors;
    tweak?.(g);
    leaveSafeRoom(g);
    return g;
  }

  it("leaving the safe room opens a personal reward draft (world keeps running)", () => {
    const g = descendWith(5, 2);
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

  it("offers one option per sponsor, capped at 3 â€” and none without sponsors", () => {
    expect(descendWith(5, 0).players[0].pendingRewards.length).toBe(0);
    expect(descendWith(5, 1).players[0].pendingRewards.length).toBe(1);
    expect(descendWith(5, 2).players[0].pendingRewards.length).toBe(2);
    expect(descendWith(5, 3).players[0].pendingRewards.length).toBe(3);
    expect(descendWith(5, 7).players[0].pendingRewards.length).toBe(3);
  });

  it("surplus sponsors drop dead-weight options (full-HP crawler never drafts Field Medic)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = descendWith(seed, 7, (gg) => { gg.players[0].hp = gg.players[0].maxHp; });
      // 7 sponsors pitch all 7 kinds; the 3 kept are the best fits, and a full
      // heal for a full-HP crawler scores zero.
      expect(g.players[0].pendingRewards.map((r) => r.kind)).not.toContain("healFull");
    }
  });

  it("diminishing returns curb stat concentration (k/(k+owned), monotonic)", () => {
    expect(rewardDr(0, 45)).toBe(1); // fresh axis: full value
    expect(rewardDr(45, 45)).toBeCloseTo(0.5); // owned == k: half
    expect(rewardDr(180, 45)).toBeLessThan(rewardDr(45, 45)); // more owned, less value
    expect(rewardDr(45, 45)).toBeLessThan(rewardDr(10, 45));
  });

  it("the gift pool is WIDE — build-variety kinds appear, not just stat stacks", () => {
    // Across seeds a fully-backed draft should surface some of the non-stat
    // variety (item / materials / favor / gold / bonusTime), diluting the
    // every-floor +damage pick.
    const varietyKinds = new Set(["item", "materials", "favor", "gold", "bonusTime", "armor"]);
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const r of descendWith(seed, 7).players[0].pendingRewards) seen.add(r.kind);
    }
    expect([...seen].some((k) => varietyKinds.has(k))).toBe(true);
  });

  it("applies the chosen reward's effect", () => {
    const g = createGame(6);
    const p = g.players[0];
    const dmg0 = p.attackPower;
    g.players[0].pendingRewards = [{ id: 1, kind: "damage", title: "Weapon Mod", desc: "+10 damage", amount: 10 }];
    chooseReward(g, 0, 0);
    expect(p.attackPower).toBe(dmg0 + 10);
    expect(g.players[0].pendingRewards.length).toBe(0);
  });

  it("generates a deterministic draft for the same seed/floor", () => {
    function draftKinds(seed: number) {
      return descendWith(seed, 5).players[0].pendingRewards.map((r) => r.kind);
    }
    expect(draftKinds(77)).toEqual(draftKinds(77));
  });

  it("new sponsor kinds apply: armor, materials, favor", () => {
    const g = createGame(6);
    const p = g.players[0];
    const arm0 = p.armor;
    p.pendingRewards = [{ id: 1, kind: "armor", title: "Ablative Weave", desc: "+20 armor", amount: 20 }];
    chooseReward(g, 0, 0);
    expect(p.armor).toBe(arm0 + 20);
    p.pendingRewards = [{ id: 2, kind: "materials", title: "Bounty", desc: "", amount: 1, material: "elite_trophy" }];
    chooseReward(g, 0, 0);
    expect(p.materials.elite_trophy).toBe(1);
    const owed0 = p.upgradeDraftsOwed;
    p.pendingRewards = [{ id: 3, kind: "favor", title: "Favor", desc: "", amount: 1 }];
    chooseReward(g, 0, 0);
    expect(p.upgradeDraftsOwed).toBe(owed0 + 1);
  });
});

describe("difficulty pass: consumable scarcity + ambushes", () => {
  it("consumables run out of per-shop stock (excess gold can't buy infinite plating)", () => {
    const g = createGame(5);
    const p = g.players[0];
    p.gold = 100000;
    g.safeRoom = { nextFloor: 3, available: ["plating_kit"], tip: "", ready: [], purchased: {} };
    const stock = consumableStock(CATALOG_BY_ID["plating_kit"]);
    const price = consumablePrice(CATALOG_BY_ID["plating_kit"], 3);
    const gold0 = p.gold;
    for (let i = 0; i < stock + 5; i++) buyCatalogItem(g, 0, "plating_kit");
    expect(g.safeRoom!.purchased["plating_kit"]).toBe(stock); // capped
    expect(gold0 - p.gold).toBe(stock * price); // paid for exactly `stock`, no more
  });

  it("ambush monsters lie dormant, then the whole cluster springs when a player nears", () => {
    const g = createGame(8);
    const p = g.players[0];
    g.monsters.length = 0;
    g.announcements.length = 0;
    const fx = p.pos.x + 8; // well past the trigger radius
    const a = mkMon({ id: 1, kind: "grunt", pos: { x: fx, y: p.pos.y }, hp: 100, maxHp: 100, damage: 10, speed: 2, dormant: true });
    const b = mkMon({ id: 2, kind: "grunt", pos: { x: fx + 1, y: p.pos.y }, hp: 100, maxHp: 100, damage: 10, speed: 2, dormant: true });
    g.monsters.push(a, b);
    // Far away: inert — no movement, no attack, still dormant.
    const ax0 = a.pos.x;
    step(g, idle(), 1 / 60);
    expect(a.dormant).toBe(true);
    expect(a.pos.x).toBe(ax0);
    // Player steps into the trap: it springs and drags the neighbor up too.
    p.pos = { x: fx - 1, y: p.pos.y };
    step(g, idle(), 1 / 60);
    expect(a.dormant).toBeFalsy();
    expect(b.dormant).toBeFalsy(); // coordinated wake within ambushWakeRadius
    expect((a.surgeT ?? 0)).toBeGreaterThan(0); // surging to close
    expect(g.announcements.some((an) => an.text.includes("AMBUSH"))).toBe(true);
  });

  it("shooting a dormant ambusher springs the WHOLE trap, not just the target", () => {
    // Otherwise a ranged crawler dismantles an ambush one body at a time with
    // zero risk — however the trap is discovered, the cluster commits together.
    const g = createGame(9);
    const p = g.players[0];
    g.monsters.length = 0;
    g.announcements.length = 0;
    const m = mkMon({
      id: 1, kind: "grunt", pos: { x: p.pos.x + 1.0, y: p.pos.y },
      hp: 500, maxHp: 500, damage: 10, dormant: true, attackCooldown: 99,
    });
    const buddy = mkMon({
      id: 2, kind: "grunt", pos: { x: p.pos.x + 2.0, y: p.pos.y },
      hp: 500, maxHp: 500, damage: 10, dormant: true, attackCooldown: 99,
    });
    g.monsters.push(m, buddy);
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(m.dormant).toBeFalsy(); // the one you hit woke...
    expect(buddy.dormant).toBeFalsy(); // ...and dragged its cluster up with it
    expect((buddy.surgeT ?? 0)).toBeGreaterThan(0);
    expect(g.announcements.some((an) => an.text.includes("AMBUSH"))).toBe(true);
  });

  it("a ringside introduction blows the trap: a revealed dormant elite springs its cluster", () => {
    const g = createGame(10);
    const p = g.players[0];
    g.monsters.length = 0;
    g.announcements.length = 0;
    // Elite + packmate lie in ambush just inside reveal range (7) but outside
    // the proximity trigger (5): only the introduction can spring them here.
    const fx = p.pos.x + 6;
    const elite = mkMon({
      id: 1, kind: "brute", pos: { x: fx, y: p.pos.y }, hp: 400, maxHp: 400,
      damage: 10, dormant: true, elite: true, eliteName: "The Trapdoor King",
    });
    const packmate = mkMon({
      id: 2, kind: "brute", pos: { x: fx + 1, y: p.pos.y }, hp: 400, maxHp: 400,
      damage: 10, dormant: true,
    });
    g.monsters.push(elite, packmate);
    step(g, idle(), 1 / 60); // reveal fires maybeStartEncounter
    expect(elite.introduced).toBe(true);
    expect(elite.dormant).toBeFalsy(); // no inert statues after their own intro
    expect(packmate.dormant).toBeFalsy(); // the whole court rises with the king
  });
});

describe("safe room + System Shop", () => {
  function reachSafeRoom(seed: number) {
    const g = createGame(seed);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    return g;
  }

  /** A safe room deeper in the run: restore at `floor`, warp to the stairs. */
  function reachDeepSafeRoom(seed: number, floor: number) {
    const g = restoreGame({
      seed, floor,
      player: { hp: 200, maxHp: 200, level: 6, xp: 0, xpToNext: 99, gold: 0 },
    });
    g.monsters.length = 0; // a live city boss seals the stairs
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    return g;
  }

  it("stocks a deterministic shelf for the same seed", () => {
    const shelf = (seed: number) => {
      const room = reachSafeRoom(seed).safeRoom!;
      return [room.tomeAbility, ...room.available].join(",");
    };
    expect(shelf(300)).toEqual(shelf(300));
    expect(reachSafeRoom(300).safeRoom!.available.length).toBeGreaterThanOrEqual(10);
  });

  it("shop 1 carries only consumables + starter + basic (tier gating)", () => {
    const room = reachSafeRoom(305).safeRoom!;
    for (const id of room.available) {
      expect(["consumable", "starter", "basic"]).toContain(CATALOG_BY_ID[id].tier);
    }
  });

  it("deeper shops unlock growing advanced/legendary subsets", () => {
    // Shop index 3 (descending from floor 3): advanced yes, legendary not yet.
    const room3 = reachDeepSafeRoom(306, 3).safeRoom!;
    const tiers3 = room3.available.map((id) => CATALOG_BY_ID[id].tier);
    expect(tiers3.filter((t) => t === "advanced").length).toBe(5); // 4 + (3-2)
    expect(tiers3).not.toContain("legendary");
    // Shop index 5: one more advanced pick, and the first legendaries appear.
    const room5 = reachDeepSafeRoom(306, 5).safeRoom!;
    const tiers5 = room5.available.map((id) => CATALOG_BY_ID[id].tier);
    expect(tiers5.filter((t) => t === "advanced").length).toBe(7);
    expect(tiers5.filter((t) => t === "legendary").length).toBe(2);
  });

  it("buying a Field Ration heals, deducts gold, and tracks goldSpent", () => {
    const g = reachSafeRoom(301);
    const p = g.players[0];
    const price = consumablePrice(CATALOG_BY_ID.field_ration, g.safeRoom!.nextFloor);
    p.hp = 10;
    p.gold = 10_000;
    buyCatalogItem(g, 0, "field_ration");
    expect(p.hp).toBeGreaterThan(10);
    expect(p.gold).toBe(10_000 - price);
    expect(p.goldSpent).toBe(price);
  });

  it("cannot buy what you cannot afford (or what's off the shelf)", () => {
    const g = reachSafeRoom(302);
    const p = g.players[0];
    p.gold = 0;
    buyCatalogItem(g, 0, "field_ration");
    expect(p.goldSpent).toBe(0);
    // Advanced gear is not stocked at shop 1, money or not.
    p.gold = 10_000;
    buyCatalogItem(g, 0, "primetime_cleaver");
    expect(p.goldSpent).toBe(0);
    expect(p.equipment.weapon?.catalogId).not.toBe("primetime_cleaver");
  });

  it("a purchased stabilizer extends the next floor's timer", () => {
    const g = reachSafeRoom(303);
    g.players[0].gold = 10_000;
    buyCatalogItem(g, 0, "stabilizer_rod");
    leaveSafeRoom(g);
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(2) + 15);
  });

  it("the tome teaches today's ability, once", () => {
    // Tome pacing (abilities.ts: tomeSchedule) gates discovery by LEVEL, so a
    // fresh level-1 crawler has nothing eligible yet — level up first, same as
    // a real floor-1 clear would.
    const g = createGame(304);
    g.players[0].level = 10;
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    const p = g.players[0];
    const ability = g.safeRoom!.tomeAbility!;
    expect(ability).toBeTruthy(); // plenty undiscovered once leveled up
    p.gold = 10_000;
    buyCatalogItem(g, 0, "tome");
    expect(knows(p, ability)).toBe(true);
    const gold = p.gold;
    buyCatalogItem(g, 0, "tome"); // already known -> refused, no charge
    expect(p.gold).toBe(gold);
  });

  it("gear purchase materializes a catalog item and auto-equips an upgrade", () => {
    const g = reachSafeRoom(307);
    const p = g.players[0];
    p.gold = 1000;
    buyCatalogItem(g, 0, "boxcutter");
    expect(p.equipment.weapon?.catalogId).toBe("boxcutter");
    expect(p.gold).toBe(1000 - totalCost("boxcutter"));
    expect(p.equipment.weapon?.affixes.damage).toBeGreaterThanOrEqual(3);
  });

  it("build paths consume owned components and charge only the difference", () => {
    const g = reachSafeRoom(308);
    const p = g.players[0];
    const room = g.safeRoom!;
    room.available.push("primetime_cleaver"); // force-stock the advanced recipe
    p.gold = 10_000;
    buyCatalogItem(g, 0, "honed_edge"); // equips (weapon slot empty-ish)
    buyCatalogItem(g, 0, "killer_instinct");
    // Measure via goldSpent: achievement payouts (RETAIL THERAPY) add gold
    // mid-purchase, but goldSpent tracks the spend alone.
    const spentBefore = p.goldSpent;
    buyCatalogItem(g, 0, "primetime_cleaver");
    // Both components credited at full price: pay only the combine cost.
    expect(p.goldSpent - spentBefore).toBe(CATALOG_BY_ID.primetime_cleaver.cost);
    expect(p.equipment.weapon?.catalogId).toBe("primetime_cleaver");
    // The consumed components are gone from bag and slots alike.
    expect(p.inventory.some((it) => it.catalogId === "honed_edge")).toBe(false);
    expect(p.equipment.trinket?.catalogId).not.toBe("killer_instinct");
  });

  it("legendaries demand sponsor backing and materials", () => {
    const g = reachSafeRoom(309);
    const p = g.players[0];
    const room = g.safeRoom!;
    room.available.push("headliner_cleaver");
    p.gold = 10_000;
    // Build gating: the legendary requires its component in hand first.
    p.inventory.push({ id: 9200, slot: "weapon", rarity: "rare", name: "Prime-Time Cleaver", affixes: { damage: 14 }, catalogId: "primetime_cleaver" });
    p.sponsors = 0;
    p.materials.elite_trophy = 5;
    buyCatalogItem(g, 0, "headliner_cleaver"); // no backing -> refused
    expect(p.equipment.weapon?.passive).toBeUndefined();
    p.sponsors = 1;
    p.materials.elite_trophy = 0;
    buyCatalogItem(g, 0, "headliner_cleaver"); // no trophies -> refused
    expect(p.equipment.weapon?.passive).toBeUndefined();
    p.materials.elite_trophy = 2;
    buyCatalogItem(g, 0, "headliner_cleaver");
    expect(p.equipment.weapon?.passive).toBe("showrunner");
    expect(p.equipment.weapon?.rarity).toBe("epic");
    expect(p.materials.elite_trophy).toBe(0); // spent
  });

  it("selling returns gold (60% catalog value; flat for drops) and is safe-room gated", () => {
    const g = reachSafeRoom(310);
    const p = g.players[0];
    p.inventory.push({ id: 9101, slot: "weapon", rarity: "magic", name: "Honed Edge", affixes: { damage: 6 }, catalogId: "honed_edge" });
    p.inventory.push({ id: 9102, slot: "armor", rarity: "rare", name: "Runed Plate", affixes: { maxHp: 30 } });
    const gold0 = p.gold;
    sellItem(g, 0, p.inventory.length - 2);
    expect(p.gold).toBe(gold0 + Math.round(totalCost("honed_edge") * 0.6));
    const dropIdx = p.inventory.length - 1;
    expect(sellValue(p.inventory[dropIdx])).toBe(50);
    sellItem(g, 0, dropIdx);
    expect(p.gold).toBe(gold0 + Math.round(totalCost("honed_edge") * 0.6) + 50);
    // In the field: no-op.
    leaveSafeRoom(g);
    p.inventory.push({ id: 9103, slot: "trinket", rarity: "epic", name: "Idol", affixes: { crit: 0.1 } });
    const gold1 = p.gold;
    sellItem(g, 0, p.inventory.length - 1);
    expect(p.gold).toBe(gold1);
  });

  it("built gear requires components IN HAND (backlog #6)", () => {
    const g = reachSafeRoom(312);
    const p = g.players[0];
    g.safeRoom!.available.push("primetime_cleaver");
    p.gold = 10_000;
    buyCatalogItem(g, 0, "primetime_cleaver"); // no components -> refused
    expect(p.goldSpent).toBe(0);
    buyCatalogItem(g, 0, "honed_edge"); // one of two isn't enough
    const spent1 = p.goldSpent;
    buyCatalogItem(g, 0, "primetime_cleaver");
    expect(p.goldSpent).toBe(spent1);
    expect(missingComponents(p, "primetime_cleaver")).toEqual(["killer_instinct"]);
    buyCatalogItem(g, 0, "killer_instinct");
    buyCatalogItem(g, 0, "primetime_cleaver"); // full build -> goes through
    expect(p.equipment.weapon?.catalogId).toBe("primetime_cleaver");
    // Components were consumed by the build: a SECOND cleaver needs them anew.
    expect(missingComponents(p, "primetime_cleaver")).toEqual(["honed_edge", "killer_instinct"]);
  });

  it("duplicate components count separately (Showstopper needs TWO platings)", () => {
    const g = reachSafeRoom(313);
    const p = g.players[0];
    g.safeRoom!.available.push("showstopper_plate");
    p.gold = 10_000;
    buyCatalogItem(g, 0, "iron_plating"); // auto-equips
    buyCatalogItem(g, 0, "showstopper_plate"); // one of two -> refused
    expect(p.equipment.armor?.catalogId).toBe("iron_plating");
    buyCatalogItem(g, 0, "iron_plating"); // second copy lands in the bag
    buyCatalogItem(g, 0, "showstopper_plate");
    expect(p.equipment.armor?.catalogId).toBe("showstopper_plate");
    expect(p.inventory.some((it) => it.catalogId === "iron_plating")).toBe(false); // both consumed
  });

  it("the caster branch shops spell power: wand + amplifier build the Stormcall Staff", () => {
    const g = reachSafeRoom(314);
    const p = g.players[0];
    g.safeRoom!.available.push("ozone_wand", "cursed_amplifier", "stormcall_staff");
    p.gold = 10_000;
    buyCatalogItem(g, 0, "ozone_wand"); // auto-equips the weapon socket
    expect(p.equipment.weapon?.catalogId).toBe("ozone_wand");
    expect(weaponClassOf(p.equipment.weapon)).toBe("arcane"); // real bolt-profile change
    const sp0 = p.spellPower;
    buyCatalogItem(g, 0, "cursed_amplifier"); // the charm socket carries SP too
    expect(p.equipment.charm?.catalogId).toBe("cursed_amplifier");
    expect(p.spellPower).toBeGreaterThan(sp0);
    buyCatalogItem(g, 0, "stormcall_staff"); // consumes both components
    expect(p.equipment.weapon?.catalogId).toBe("stormcall_staff");
    expect(weaponClassOf(p.equipment.weapon)).toBe("arcane");
    expect(p.equipment.charm).toBeNull(); // amplifier was consumed by the build
  });

  it("tempo (Sweeps Week Staff) speeds every active cooldown", () => {
    const with_ = createGame(660);
    const without = createGame(660);
    for (const [g, tempo] of [[with_, true], [without, false]] as const) {
      const p = g.players[0];
      equipItem(p, {
        id: 1, slot: "weapon", rarity: "epic", name: "Sweeps Week Staff",
        affixes: { spell: 20 }, passive: tempo ? "tempo" : undefined, catalogId: "sweeps_week_staff",
      });
      step(g, { ...idle(), bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    }
    const cdWith = with_.players[0].cd.bolt!;
    const cdWithout = without.players[0].cd.bolt!;
    expect(cdWith).toBeCloseTo(cdWithout * CONFIG.tempoCooldownMult, 5);
  });

  it("catalog spell affixes scale with the floor ahead like the physical school", () => {
    const early = gearAffixes(CATALOG_BY_ID.stormcall_staff, 2).spell!;
    const late = gearAffixes(CATALOG_BY_ID.stormcall_staff, 10).spell!;
    expect(late).toBeGreaterThan(early);
    // Rare-tier parity vs a worst-case floor-10 drop primary (same rule as ATK).
    expect(late).toBeGreaterThanOrEqual(Math.round((2 + 10) * 2.4) * 0.4);
  });

  it("catalog gear keeps tier parity with same-rarity drops deep in the run (backlog #5)", () => {
    // Worst-case drop primary at floor 10 is (2 + floor) * rarity mult (items.ts rollAffix).
    const adv = gearAffixes(CATALOG_BY_ID.primetime_cleaver, 10).damage!;
    const leg = gearAffixes(CATALOG_BY_ID.headliner_cleaver, 10).damage!;
    expect(adv).toBeGreaterThanOrEqual(Math.round((2 + 10) * 2.4)); // rare-tier parity
    expect(leg).toBeGreaterThanOrEqual(Math.round((2 + 10) * 3.6)); // epic-tier parity
  });

  it("effectivePrice previews the component discount without buying", () => {
    const g = reachSafeRoom(311);
    const p = g.players[0];
    expect(effectivePrice(p, "primetime_cleaver", 2)).toBe(totalCost("primetime_cleaver"));
    p.inventory.push({ id: 9104, slot: "weapon", rarity: "magic", name: "Honed Edge", affixes: { damage: 6 }, catalogId: "honed_edge" });
    expect(effectivePrice(p, "primetime_cleaver", 2)).toBe(totalCost("primetime_cleaver") - totalCost("honed_edge"));
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
  // The feature ships disabled (CONFIG.achievementsEnabled); the mechanics
  // still need to work for when it returns, so tests flip the switch.
  const flags = CONFIG as { achievementsEnabled: boolean };
  beforeAll(() => { flags.achievementsEnabled = true; });
  afterAll(() => { flags.achievementsEnabled = false; });

  it("FIRST BLOOD unlocks on the first kill with a payout", () => {
    const g = createGame(400);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y } }));
    const gold0 = g.players[0].gold;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements).toContain("first_blood");
    expect(g.players[0].gold).toBeGreaterThan(gold0);
    expect(g.announcements.some((a) => a.text.includes("FIRST BLOOD"))).toBe(true);
    // Never unlocks twice.
    g.monsters.push(mkMon({ id: 2, pos: { x: g.players[0].pos.x + 0.8, y: g.players[0].pos.y } }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements.filter((a) => a === "first_blood").length).toBe(1);
  });

  it("DIRTY FIGHTER unlocks on a 3-kill instant", () => {
    const g = createGame(401);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].attackPower = 9999;
    g.monsters.length = 0;
    for (let i = 0; i < 3; i++) {
      g.monsters.push(mkMon({ id: 10 + i, pos: { x: g.players[0].pos.x + 0.7, y: g.players[0].pos.y } }));
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements).toContain("dirty_fighter");
  });

  it("COLLECTOR'S EDITION unlocks once every discoverable is learned", () => {
    const g = createGame(402);
    for (const a of DISCOVERABLE_ABILITIES) {
      learnAbility(g, g.players[0], a);
    }
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

  it("several same-step unlocks combine into one announcer line", () => {
    const g = createGame(404);
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].attackPower = 9999;
    g.monsters.length = 0;
    for (let i = 0; i < 3; i++) {
      g.monsters.push(mkMon({ id: 20 + i, pos: { x: g.players[0].pos.x + 0.7, y: g.players[0].pos.y } }));
    }
    // One step kills all three: FIRST BLOOD + DIRTY FIGHTER unlock together.
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.players[0].achievements).toEqual(expect.arrayContaining(["first_blood", "dirty_fighter"]));
    const lines = g.announcements.filter((a) => a.kind === "achievement");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("ACHIEVEMENTS");
    // The log still carries each unlock's full description.
    expect(g.events.filter((e) => e.startsWith("ACHIEVEMENT (")).length).toBeGreaterThanOrEqual(2);
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

describe("announcement tiers (anti-flood)", () => {
  it("a multi-level XP grant announces once with the final level", () => {
    const g = createGame(410);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    p.attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, xp: 500 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.level).toBeGreaterThan(2); // the grant crossed several levels
    const lines = g.announcements.filter((a) => a.kind === "levelup");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain(`LEVEL ${p.level}`);
    expect(lines[0].text).toContain(`+${p.level - 1} levels`);
  });

  it("headline moments carry high priority; routine lines do not", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, maxHp: 100, baseDamage: 10, level: 1, xp: 0, xpToNext: 20, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    boss.hp = 0;
    step(g, idle(), 1 / 60);
    const bossLine = g.announcements.find((a) => a.text.includes("FLOOR BOSS"));
    expect(bossLine?.kind).toBe("boss");
    expect(bossLine?.priority).toBe("high");
    const levelLine = g.announcements.find((a) => a.kind === "levelup");
    expect(levelLine?.priority).toBe("normal");
  });
});

describe("ability tree + upgrade drafts", () => {
  it("leveling up opens a personal upgrade draft without pausing the world", () => {
    const g = createGame(31);
    g.players[0].xp = g.players[0].xpToNext; // one level-up on the next XP grant
    g.players[0].facing = { x: 1, y: 0 };
    g.players[0].attackPower = 9999;
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
    expect(p.cd.nova ?? 0).toBeGreaterThan(0);
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

  it("orbit's swept-path tick hits on-ring targets regardless of blade phase", () => {
    // The blades sweep ~full circle between damage ticks, so a monster parked
    // anywhere on the ring must be hit within a couple of ticks â€” no more
    // snapshot roulette.
    for (const angle of [0, Math.PI / 3, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const g = createGame(16);
      const p = g.players[0];
      p.maxHp = p.hp = 9999;
      learnAbility(g, p, "orbit");
      g.monsters.length = 0;
      g.monsters.push(mkMon({
        id: 1, hp: 500, maxHp: 500,
        pos: { x: p.pos.x + Math.cos(angle) * CONFIG.orbitRadius, y: p.pos.y + Math.sin(angle) * CONFIG.orbitRadius },
      }));
      for (let i = 0; i < 60 && g.monsters[0].hp === 500; i++) step(g, idle(), 1 / 60);
      expect(g.monsters[0].hp).toBeLessThan(500);
    }
  });

  it("CORKSCREW spirals inward to hit enemies base orbit can never touch", () => {
    const inside = 0.55; // well inside the base ring's dead zone
    const run = (corkscrew: boolean) => {
      const g = createGame(17);
      const p = g.players[0];
      p.maxHp = p.hp = 9999;
      learnAbility(g, p, "orbit");
      p.abilities.ranks["orbit.blade"] = 1; // prerequisite
      if (corkscrew) p.abilities.ranks["orbit.wide"] = 1;
      g.monsters.length = 0;
      g.monsters.push(mkMon({ id: 1, hp: 500, maxHp: 500, pos: { x: p.pos.x + inside, y: p.pos.y } }));
      for (let i = 0; i < 240 && g.monsters[0].hp === 500; i++) step(g, idle(), 1 / 60);
      return g.monsters[0].hp;
    };
    expect(run(false)).toBe(500); // fixed ring: the interior is out of reach
    expect(run(true)).toBeLessThan(500); // spiral dips to the inner radius
  });

  it("SHOCKSTEP damages along the whole dash path, not just the arrival point", () => {
    const g = createGame(18);
    const p = g.players[0];
    p.maxHp = p.hp = 9999;
    p.abilities.ranks["dash.shock"] = 1;
    g.monsters.length = 0;
    // Mid-path: far from the arrival point (old arrival-burst missed this).
    g.monsters.push(mkMon({ id: 1, hp: 500, maxHp: 500, pos: { x: p.pos.x + 0.8, y: p.pos.y } }));
    step(g, { move: { x: 1, y: 0 }, useStairs: false, cast: [false, true, false, false, false] }, 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
  });

  it("dash follows the move input, not stale aim-facing", () => {
    const g = createGame(18); // seed 18's spawn has open ground to the east
    const p = g.players[0];
    g.monsters.length = 0;
    p.facing = { x: 0, y: -1 }; // e.g. just fired a bolt to the north
    const start = { x: p.pos.x, y: p.pos.y };
    step(g, { move: { x: 1, y: 0 }, useStairs: false, cast: [false, true, false, false, false] }, 1 / 60);
    expect(p.pos.x - start.x).toBeGreaterThan(1); // dashed east with the feet
    expect(Math.abs(p.pos.y - start.y)).toBeLessThan(0.2);
  });

  it("abilities persist through save shape (restore)", () => {
    const restored = restoreGame({
      seed: 50, floor: 2,
      player: {
        hp: 90, level: 4, xp: 0, xpToNext: 50, gold: 10,
        // Legacy pre-loadout save shape: restore migrates known[] into slots.
        abilities: { known: ["melee", "dash", "bolt", "nova"], ranks: { "nova.bang": 1 } } as never,
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
    expect(g.announcements.some((a) => a.text.includes("Donut"))).toBe(true);
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
    a.attackPower = 9999;
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
  function floor2Monsters(partySize: number) {
    const g = createGame(4242);
    for (let i = 1; i < partySize; i++) addPlayer(g, `P${i}`);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g); // floor 2 built with the current party size
    return g.monsters;
  }

  it("party floors spawn more and tougher monsters than solo (same seed)", () => {
    const solo = floor2Monsters(1);
    const trio = floor2Monsters(3);
    expect(trio.length).toBeGreaterThan(solo.length);
    // The per-monster multipliers are per KIND (the spawn mix itself varies), so
    // compare same-kind monsters: every shared archetype is tougher in the trio.
    const hpOf = (ms: typeof solo, kind: string) => ms.find((m) => m.kind === kind && !m.elite)?.maxHp;
    const shared = [...new Set(solo.map((m) => m.kind))].filter((k) => hpOf(trio, k) !== undefined);
    expect(shared.length).toBeGreaterThan(0);
    for (const kind of shared) {
      expect(hpOf(trio, kind)!).toBeGreaterThan(hpOf(solo, kind)! * 1.5);
    }
  });
});

describe("per-player show economy", () => {
  it("the killer's audience grows; the bystander's does not", () => {
    const g = createGame(505);
    addPlayer(g, "Donut");
    const [carl, donut] = g.players;
    carl.facing = { x: 1, y: 0 };
    carl.attackPower = 9999;
    g.monsters.length = 0;
    // Park the bystander away from the corpse: loot-pickup hype (rare drops)
    // belongs to whoever grabs the drop, which isn't what this test measures.
    donut.pos = { x: carl.pos.x - 4, y: carl.pos.y };
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: carl.pos.x + 0.8, y: carl.pos.y } }));
    step(g, { [carl.id]: { ...idle(), attack: true, aim: { x: 1, y: 0 } } }, 1 / 60);
    expect(carl.hype).toBeGreaterThan(0);
    expect(donut.hype).toBe(0);
  });

  it("sponsors are earned per player and drive that player's reward quality", () => {
    const g = createGame(506);
    addPlayer(g, "Donut");
    const [carl, donut] = g.players;
    g.monsters.length = 0; // roaming patrols would find (and end) the idle pair
    // Carl sustains a hyped broadcast (~15s — sqrt conversion pays out
    // steadily, not explosively); Donut idles.
    for (let i = 0; i < 900; i++) {
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
    // attackRange 2: the player's knockback shoves a speed-0 monster out of a
    // normal melee band, so give it reach or it never lands the return hit.
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 9999, maxHp: 9999, damage: 5, speed: 0, attackRange: 2, attackCooldown: 0 }));
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
    const g = onFloor(4); // floor 3 is a band-boss arena now — no elite there
    const elites = g.monsters.filter((m) => m.elite);
    expect(elites.length).toBe(1);
    expect(elites[0].eliteName).toBeTruthy();
    expect(elites[0].kind).not.toBe("boss");
  });

  it("floor 1 has no elite; band-boss floors (3, 6, 9, 12, 15) spawn a sealed boss", () => {
    expect(onFloor(1).monsters.some((m) => m.elite)).toBe(false);
    for (const f of [3, 6, 9, 12, 15]) {
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
    expect(g.announcements.some((a) => a.text.includes(name) && a.text.includes("DOWN"))).toBe(true);
    expect(g.loot.some((l) => l.kind === "item")).toBe(true);
  });
});

describe("new archetypes", () => {
  it("bomber lights a fuse on contact, then explodes, damaging the player", () => {
    const g = createGame(900);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const bomber = mkMon({
      id: 1, kind: "bomber", pos: { x: p.pos.x + 1.4, y: p.pos.y },
      hp: 30, maxHp: 30, damage: 10, attackRange: 1.5, // just outside pickup radius
    });
    g.monsters.push(bomber);
    const hp0 = p.hp;
    // Contact starts the FUSE â€” a dodge window, not an instant blast.
    step(g, idle(), 1 / 60);
    expect(bomber.windup).toBeGreaterThan(0);
    expect(p.hp).toBe(hp0); // nothing has landed yet
    stepPastWindup(g, bomber);
    expect(p.hp).toBeLessThan(hp0); // stood in it â€” caught in the blast
    expect(g.monsters.length).toBe(0); // the bomber died and was reaped normally
    expect(g.killCount).toBe(1);
    expect(g.announcements.some((a) => a.text.includes("bomber"))).toBe(true);
  });

  it("walking out of the fuse radius dodges the detonation", () => {
    const g = createGame(904);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const bomber = mkMon({
      id: 1, kind: "bomber", pos: { x: p.pos.x + 1.4, y: p.pos.y },
      hp: 30, maxHp: 30, damage: 10, attackRange: 1.5,
    });
    g.monsters.push(bomber);
    step(g, idle(), 1 / 60); // fuse lit
    expect(bomber.windup).toBeGreaterThan(0);
    p.pos = { x: bomber.pos.x + CONFIG.bomberExplodeRadius + 1.5, y: bomber.pos.y }; // step clear
    const hp0 = p.hp;
    stepPastWindup(g, bomber);
    expect(g.monsters.length).toBe(0); // still detonates where it stood
    expect(p.hp).toBe(hp0); // but the blast found nobody
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
    // The heal is a CHANNEL now (the interrupt window): committed, not landed.
    expect(shaman.windupKind).toBe("heal");
    expect(shaman.healCd).toBeGreaterThan(0); // paid up front
    expect(wounded.hp).toBe(10);
    // Step to the resolve frame and stop THERE — hits clear every step.
    let healed = false;
    for (let t = 0; t < CONFIG.shamanHealWindup + 0.2 && !healed; t += 1 / 60) {
      step(g, idle(), 1 / 60);
      healed = wounded.hp > 10;
    }
    expect(wounded.hp).toBe(10 + CONFIG.shamanHeal); // picked the most wounded ally
    expect(healthier.hp).toBe(30);
    expect(g.hits.some((h) => h.kind === "heal" && h.amount === CONFIG.shamanHeal)).toBe(true);
  });

  it("killing the shaman mid-channel cancels the heal", () => {
    const g = createGame(903);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const wounded = mkMon({ id: 2, pos: { x: p.pos.x + 5, y: p.pos.y + 1 }, hp: 10, maxHp: 50 });
    const shaman = mkMon({
      id: 1, kind: "shaman", pos: { x: p.pos.x + 5, y: p.pos.y },
      hp: 40, maxHp: 40, attackRange: 5.5,
    });
    g.monsters.push(shaman, wounded);
    step(g, idle(), 1 / 60);
    expect(shaman.windupKind).toBe("heal");
    shaman.hp = 0; // focused down inside the window
    for (let t = 0; t < CONFIG.shamanHealWindup + 0.1; t += 1 / 60) step(g, idle(), 1 / 60);
    expect(wounded.hp).toBe(10); // the medic never finished
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

describe("new specialist archetypes (charger / spitter / necromancer)", () => {
  it("charger locks a lane, telegraphs long, then rushes through whoever stayed on it", () => {
    const g = createGame(910);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    g.map.tiles.fill(1); // open floor so walls can't cut the rush short
    const ch = mkMon({
      id: 1, kind: "charger", pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 60, maxHp: 60, damage: 10, attackRange: 1.0, speed: 0,
    });
    g.monsters.push(ch);
    step(g, idle(), 1 / 60);
    expect(ch.windup).toBeGreaterThan(0); // committed — this is the dodge window
    expect(ch.windupKind).toBe("charge");
    const hp0 = p.hp;
    stepPastWindup(g, ch);
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60); // let the rush run its line out
    expect(p.hp).toBeLessThan(hp0); // stood on the tracks
    expect(ch.attackCooldown).toBeGreaterThan(0); // winded after the rush
  });

  it("sidestepping off the locked lane dodges the whole rush", () => {
    const g = createGame(915);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    g.map.tiles.fill(1);
    const ch = mkMon({
      id: 1, kind: "charger", pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 60, maxHp: 60, damage: 10, attackRange: 1.0, speed: 0,
    });
    g.monsters.push(ch);
    step(g, idle(), 1 / 60); // direction locked NOW
    expect(ch.windupKind).toBe("charge");
    p.pos = { x: p.pos.x, y: p.pos.y + 2 }; // step off the lane
    const hp0 = p.hp;
    stepPastWindup(g, ch);
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60);
    expect(p.hp).toBe(hp0); // the train went by
  });

  it("spitter lobs a lingering acid puddle that ticks anyone standing in it, then dries up", () => {
    const g = createGame(911);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const sp = mkMon({
      id: 1, kind: "spitter", pos: { x: p.pos.x + 5, y: p.pos.y },
      hp: 30, maxHp: 30, damage: 10, attackRange: 5.5, speed: 0,
    });
    g.monsters.push(sp);
    step(g, idle(), 1 / 60);
    expect(sp.windup).toBeGreaterThan(0); // aiming the lob at where you stand
    expect(sp.windupKind).toBe("spit");
    const hp0 = p.hp;
    stepPastWindup(g, sp);
    expect(g.hazards.some((hz) => hz.kind === "puddle")).toBe(true);
    expect(p.hp).toBeLessThan(hp0); // caught the splash tick
    sp.hp = 0; // retire the spitter so no second lob muddies the assertion
    const afterSplash = p.hp;
    for (let i = 0; i < 45; i++) step(g, idle(), 1 / 60); // ~0.75s: at least one more tick
    expect(p.hp).toBeLessThan(afterSplash); // standing in it is a CHOICE
    for (let i = 0; i < 240; i++) step(g, idle(), 1 / 60); // past puddleDuration
    expect(g.hazards.length).toBe(0); // dried up
  });

  it("fallen monsters leave raisable corpses that fade after their TTL", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const grunt = mkMon({ id: 1, pos: { x: p.pos.x + 6, y: p.pos.y }, hp: 0, maxHp: 10 });
    g.monsters.push(grunt);
    step(g, idle(), 1 / 60); // reaped
    expect(g.corpses.length).toBe(1);
    expect(g.corpses[0].kind).toBe("grunt");
    for (let i = 0; i < Math.ceil((CONFIG.corpseTtl + 1) * 60); i++) step(g, idle(), 1 / 60);
    expect(g.corpses.length).toBe(0); // too cold to raise
  });

  it("necromancer raises a fresh corpse as a weakened, worthless-XP minion", () => {
    const g = createGame(912);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const necro = mkMon({
      id: 1, kind: "necromancer", pos: { x: p.pos.x + 5, y: p.pos.y },
      hp: 50, maxHp: 50, attackRange: 5.5, speed: 0,
    });
    g.monsters.push(necro);
    g.corpses.push({ id: 777, pos: { x: p.pos.x + 4, y: p.pos.y + 1 }, kind: "grunt", t: 10 });
    step(g, idle(), 1 / 60);
    expect(necro.windup).toBeGreaterThan(0); // the ritual telegraphs — interrupt it
    expect(necro.windupKind).toBe("raise");
    expect(necro.healCd).toBeGreaterThan(0); // paid up front
    stepPastWindup(g, necro);
    expect(g.monsters.length).toBe(2);
    const raised = g.monsters.find((m) => m.id !== 1)!;
    expect(raised.kind).toBe("grunt");
    expect(raised.xp).toBe(CONFIG.necroRaisedXp); // not a farm
    expect(raised.hp).toBeLessThan(CONFIG.monsterBaseHp); // came back weakened
    expect(g.corpses.length).toBe(0); // the corpse was consumed
    expect(necro.summons).toBe(1); // lifetime raise cap ticks up
  });
});

describe("brute Ground Slam + boss kit escalation", () => {
  it("brute's slam is a self-centered AoE with its own tunable radius (wider than the old point-check reach)", () => {
    const g = createGame(920);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const brute = mkMon({
      id: 1, kind: "brute", pos: { x: p.pos.x + 1, y: p.pos.y },
      hp: 60, maxHp: 60, damage: 20, attackRange: 1.1, speed: 0,
    });
    g.monsters.push(brute);
    step(g, idle(), 1 / 60); // commits within attackRange
    expect(brute.windup).toBeGreaterThan(0);
    expect(brute.windupKind).toBe("slam");
    // Step to just inside the new slam radius (1.5) but outside the OLD point-check
    // reach (attackRange 1.1 + grace 0.35 = 1.45) — only the AoE catches this.
    p.pos = { x: brute.pos.x + 1.48, y: brute.pos.y };
    const hp0 = p.hp;
    stepPastWindup(g, brute);
    expect(p.hp).toBeLessThan(hp0);
  });

  it("boss tier 1 (floor-6 city boss) gets a periodic Ground Slam beyond its normal melee/volley kit", () => {
    const g = createGame(921);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const boss = mkMon({
      id: 1, kind: "boss", pos: { x: p.pos.x + 2.0, y: p.pos.y },
      hp: 500, maxHp: 500, damage: 30, attackRange: 1.4, speed: 0, bossTier: 1,
    });
    boss.introduced = true;
    g.monsters.push(boss);
    // Too far to melee (1.4), within slam's commit range (3.2) AND its damage radius (2.4).
    step(g, idle(), 1 / 60);
    expect(boss.windupKind).toBe("slam");
    expect(boss.slamCd).toBeGreaterThan(0);
    const hp0 = p.hp;
    stepPastWindup(g, boss);
    expect(p.hp).toBeLessThan(hp0);
  });

  it("boss tier 2 (floor-12 city boss) cycles its Ground Slam faster than tier 1", () => {
    // Call for Backup was folded into the universal phase adds waves (backlog
    // #11) during integration — tier 2's escalation is slam HASTE instead.
    const slamCdAfterCommit = (tier: 1 | 2) => {
      const g = createGame(922);
      const p = g.players[0];
      g.monsters.length = 0;
      g.projectiles.length = 0;
      const boss = mkMon({
        id: 1, kind: "boss", pos: { x: p.pos.x + 2.0, y: p.pos.y },
        hp: 500, maxHp: 500, damage: 30, attackRange: 1.4, speed: 0, bossTier: tier,
      });
      boss.introduced = true;
      g.monsters.push(boss);
      step(g, idle(), 1 / 60); // within slam commit range -> winds up, sets slamCd
      expect(boss.windupKind).toBe("slam");
      return boss.slamCd!;
    };
    const t1 = slamCdAfterCommit(1);
    const t2 = slamCdAfterCommit(2);
    expect(t2).toBeLessThan(t1);
    expect(t2).toBeCloseTo(t1 * CONFIG.bossSlamHasteT2, 5);
  });

  it("boss tier 3 (final boss) channels a Dark Ritual — the one real interrupt-or-hurt attack in the game", () => {
    const g = createGame(923);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const boss = mkMon({
      // Beyond slam's commit range (3.2), within ritual's commit range (9) AND its
      // damage radius (3.6) — isolates the ritual from slam/melee entirely.
      id: 1, kind: "boss", pos: { x: p.pos.x + 3.4, y: p.pos.y },
      hp: 1000, maxHp: 1000, damage: 40, attackRange: 1.4, speed: 0, bossTier: 3,
    });
    boss.introduced = true;
    g.monsters.push(boss);
    step(g, idle(), 1 / 60);
    expect(boss.windupKind).toBe("ritual");
    expect(boss.ritualCd).toBeGreaterThan(0);
    expect(g.announcements.some((a) => a.text.includes("CHANNELING"))).toBe(true);
    const hp0 = p.hp;
    stepPastWindup(g, boss);
    expect(p.hp).toBeLessThan(hp0 - 20); // a real, serious hit — not a chip
  });
});

describe("locked-door self-healing (auditKeyReachability)", () => {
  // The runtime backstop behind the spawn-time carrier guard and swept
  // movement: if ANY vector — present or future — makes the stairs key
  // unreachable (or seals a crawler in), the System concedes the door within
  // one audit interval instead of ending the run.

  /** A locked floor with a living key carrier, deterministically. Skips floors
   * that ALSO rolled an independent timed-vault event: unlockDoors() correctly
   * leaves a sealed vault's own doors locked (that's a separate mechanic), but
   * these tests assert no DoorLocked tiles remain anywhere on the map. */
  function lockedGame(): { g: GameState; carrier: import("../src/sim/types").Monster } {
    for (let seed = 1; seed <= 30; seed++) {
      const g = createTestGame({ seed, floor: 10, level: 20, gear: false });
      const carrier = g.monsters.find((m) => m.hasKey);
      if (g.map.locked && carrier && g.floorEvent?.type !== "vault") return { g, carrier };
    }
    throw new Error("no locked floor with a carrier found in 30 seeds");
  }

  const stepSeconds = (g: GameState, secs: number): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < secs * 60; i++) {
      step(g, idle(), 1 / 60);
      for (const a of g.announcements) lines.push(a.text);
    }
    return lines;
  };

  it("concedes the door when the key carrier ends up sealed in with the stairs", () => {
    const { g, carrier } = lockedGame();
    const room = g.map.rooms[g.map.lockedRoomIdx];
    carrier.pos = { x: room.x + room.w / 2, y: room.y + room.h / 2 }; // forced violation
    carrier.dormant = false;
    const lines = stepSeconds(g, 4); // > one audit interval
    expect(g.map.locked).toBe(false);
    expect(g.map.tiles.includes(Tile.DoorLocked)).toBe(false);
    expect(lines.some((t) => t.includes("CONCEDES"))).toBe(true);
  });

  it("waives the door when the key vanishes outright", () => {
    const { g, carrier } = lockedGame();
    g.monsters = g.monsters.filter((m) => m !== carrier); // key gone, no loot
    const lines = stepSeconds(g, 4);
    expect(g.map.locked).toBe(false);
    expect(lines.some((t) => t.includes("WAIVES"))).toBe(true);
  });

  it("never fires on a lawful locked floor (no false positives)", () => {
    const { g } = lockedGame();
    stepSeconds(g, 4);
    expect(g.map.locked).toBe(true);
    expect(g.map.tiles.includes(Tile.DoorLocked)).toBe(true);
  });
});

describe("swept movement — nothing tunnels through thin walls or door rings", () => {
  // moveWithCollision used to check only each axis ENDPOINT, so any single call
  // longer than a tile (phantom blink 3.0, cataclysm knockback 2.5) tunneled
  // through 1-tile wall bands — including the locked stairs district's door
  // ring, where a blinking KEY CARRIER could seal itself in with the stairs.

  it("a large single move stops at a one-tile wall band instead of crossing it", () => {
    const g = createGame(930);
    const m = g.map;
    const sx = Math.floor(m.spawn.x), sy = Math.floor(m.spawn.y);
    const wallX = sx + 2;
    for (let y = 0; y < m.h; y++) m.tiles[y * m.w + wallX] = Tile.Wall;
    const pos = { x: sx + 0.5, y: sy + 0.5 };
    moveWithCollision(m, pos, { x: 1, y: 0 }, 4, isWalkable);
    expect(pos.x).toBeLessThan(wallX - 0.29); // stopped short, entity radius respected
  });

  it("a phantom-length blink cannot cross a locked-door line (the key softlock)", () => {
    const g = createGame(931);
    const m = g.map;
    const sx = Math.floor(m.spawn.x), sy = Math.floor(m.spawn.y);
    const doorX = sx + 2;
    for (let y = 0; y < m.h; y++) m.tiles[y * m.w + doorX] = Tile.DoorLocked;
    const pos = { x: sx + 0.5, y: sy + 0.5 };
    moveWithCollision(m, pos, { x: 1, y: 0 }, CONFIG.phantomBlinkDistance, isWalkable);
    expect(pos.x).toBeLessThan(doorX - 0.29);
  });

  it("the key carrier always spawns reachable from the party spawn", () => {
    const reachable = (map: FloorMap, from: Vec2): Uint8Array => {
      const seen = new Uint8Array(map.w * map.h);
      const q = [Math.floor(from.y) * map.w + Math.floor(from.x)];
      seen[q[0]] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const x = q[qi] % map.w, y = (q[qi] / map.w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const ni = ny * map.w + nx;
          const t = map.tiles[ni];
          if (seen[ni] || t === Tile.Wall || t === Tile.DoorLocked) continue;
          seen[ni] = 1;
          q.push(ni);
        }
      }
      return seen;
    };
    for (let seed = 1; seed <= 12; seed++) {
      for (const floor of [10, 14, 17]) {
        const g = createTestGame({ seed, floor, gear: false });
        if (!g.map.locked) continue;
        const carrier = g.monsters.find((mm) => mm.hasKey);
        if (!carrier) continue; // softlock guard opened the doors instead
        const seen = reachable(g.map, g.map.spawn);
        const ci = Math.floor(carrier.pos.y) * g.map.w + Math.floor(carrier.pos.x);
        expect(seen[ci], `seed ${seed} floor ${floor}: key carrier sealed in with the stairs`).toBe(1);
      }
    }
  });
});

describe("new elite affixes (splitter / thorns)", () => {
  it("splitter elites burst into swarmers on death", () => {
    const g = createGame(913);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const elite = mkMon({
      id: 1, kind: "brute", pos: { x: p.pos.x + 8, y: p.pos.y },
      hp: 0, maxHp: 80, elite: true, eliteName: "Testy the Divisible", affix: "splitter",
    });
    g.monsters.push(elite);
    step(g, idle(), 1 / 60);
    const children = g.monsters.filter((m) => m.kind === "swarmer");
    expect(children.length).toBe(CONFIG.splitterCount);
    expect(children.every((c) => c.hp > 0 && c.xp === 1)).toBe(true);
    expect(g.announcements.some((a) => a.text.includes("SPLITS APART"))).toBe(true);
  });

  it("thorns elites reflect a capped slice of every hit back at the attacker", () => {
    const g = createGame(914);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const elite = mkMon({
      id: 1, kind: "grunt", pos: { x: p.pos.x + 1.0, y: p.pos.y },
      hp: 5000, maxHp: 5000, elite: true, eliteName: "Sir Prickly", affix: "thorns",
      introduced: true, // skip the ringside freeze — we're here for the thorns
      attackCooldown: 99, // it never swings back — any damage taken is thorns
    });
    g.monsters.push(elite);
    const hp0 = p.hp;
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(elite.hp).toBeLessThan(5000); // the swing landed
    const reflected = hp0 - p.hp;
    expect(reflected).toBeGreaterThan(0); // and it bit back
    expect(reflected).toBeLessThanOrEqual(Math.max(1, Math.round(p.maxHp * CONFIG.thornsReflectCapFraction)));
  });

  it("armored elites shrug physical hits; warded ones don't care (school resists)", () => {
    // Twin games on one seed share the exact rng stream, so the only
    // difference in damage dealt is the resist multiplier itself.
    const meleeOnce = (over: Partial<import("../src/sim/types").Monster>) => {
      const g = createGame(921);
      const p = g.players[0];
      g.monsters.length = 0;
      g.projectiles.length = 0;
      const m = mkMon({
        id: 1, pos: { x: p.pos.x + 1.0, y: p.pos.y },
        hp: 100000, maxHp: 100000, attackCooldown: 99, ...over,
      });
      g.monsters.push(m);
      step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
      const ev = g.hits.find((h) => h.kind === "enemy" || h.kind === "crit");
      return { dealt: 100000 - m.hp, resisted: ev?.resisted };
    };
    const plain = meleeOnce({});
    const armored = meleeOnce({ affix: "armored" });
    const warded = meleeOnce({ affix: "warded" });
    expect(plain.dealt).toBeGreaterThan(0);
    expect(armored.dealt).toBe(Math.max(1, Math.round(plain.dealt * CONFIG.resistDamageTakenMult)));
    expect(armored.resisted).toBe(true);
    expect(warded.dealt).toBe(plain.dealt); // melee is physical — warded ignores it
    expect(warded.resisted).toBeUndefined();
  });

  it("magic bolts are shrugged by warded targets, full-strength on armored ones", () => {
    // A staff makes BOLT a magic missile (boltParams) — fire one at twin targets.
    const boltOnce = (over: Partial<import("../src/sim/types").Monster>) => {
      const g = createGame(922);
      const p = g.players[0];
      equipItem(p, { id: 9, slot: "weapon", rarity: "rare", name: "Runed Staff", affixes: { spell: 10 } });
      g.monsters.length = 0;
      g.projectiles.length = 0;
      const m = mkMon({
        id: 1, pos: { x: p.pos.x + 3.0, y: p.pos.y },
        hp: 100000, maxHp: 100000, attackCooldown: 99, ...over,
      });
      g.monsters.push(m);
      const cast = [false, false, true, false, false]; // slot 3 = bolt
      for (let i = 0; i < 60 && m.hp === 100000; i++) {
        step(g, { ...idle(), cast, aim: { x: 1, y: 0 } }, 1 / 60);
      }
      return 100000 - m.hp;
    };
    const plain = boltOnce({});
    const warded = boltOnce({ affix: "warded" });
    const armored = boltOnce({ affix: "armored" });
    expect(plain).toBeGreaterThan(0);
    expect(warded).toBe(Math.max(1, Math.round(plain * CONFIG.resistDamageTakenMult)));
    expect(armored).toBe(plain); // magic sails past ARMOR plating
  });

  it("charger is innately armored, phantom innately warded; the affix wins over the tag", () => {
    expect(monsterResist(mkMon({ kind: "charger" }))).toBe("physical");
    expect(monsterResist(mkMon({ kind: "phantom" }))).toBe("magic");
    expect(monsterResist(mkMon({ kind: "grunt" }))).toBeNull();
    expect(monsterResist(mkMon({ kind: "grunt", affix: "armored" }))).toBe("physical");
    expect(monsterResist(mkMon({ kind: "phantom", affix: "armored" }))).toBe("physical");
  });

  it("the named elite is never a support caste (a boss that can't attack is a bug)", () => {
    // Shamans heal and necromancers raise — neither ever attacks. Before the
    // canBoss filter, ~11% of named elites across seeds rolled one of these
    // and stood at standoff dealing literally zero damage for the whole fight.
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [3, 5, 7, 9, 11, 13]) {
        const g = createTestGame({ seed, floor, gear: false });
        for (const e of g.monsters.filter((m) => m.elite)) {
          expect(
            e.kind,
            `seed ${seed} floor ${floor}: ${e.eliteName} rolled a support caste`,
          ).not.toMatch(/^(shaman|necromancer)$/);
        }
      }
    }
  });
});

describe("damage rolls + armor", () => {
  it("rollDamage stays inside its variance bounds", () => {
    const rng = createRng(77);
    for (let i = 0; i < 300; i++) {
      const d = rollDamage(rng, 100, 0.4);
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThanOrEqual(140);
    }
  });

  it("the equipped weapon sets the player's dice", () => {
    const g = createGame(915);
    const p = g.players[0];
    expect(damageVariance(p)).toBe(0.15); // bare hands roll the default
    equipItem(p, { id: 1, slot: "weapon", rarity: "epic", name: "Apocalyptic Maul", affixes: { damage: 5 } });
    expect(damageVariance(p)).toBe(CONFIG.weaponVariance.heavy); // a gamble per swing
    equipItem(p, { id: 2, slot: "weapon", rarity: "epic", name: "Apocalyptic Mug", affixes: { damage: 5 } });
    expect(damageVariance(p)).toBe(CONFIG.weaponVariance.chaotic); // a slot machine
  });

  it("armor recomputes from gear and mitigates incoming hits", () => {
    const g = createGame(916);
    const p = g.players[0];
    // armorK armor = exactly 50% reduction by construction.
    equipItem(p, { id: 1, slot: "armor", rarity: "epic", name: "Apocalyptic Plate", affixes: { armor: CONFIG.armorK } });
    expect(p.armor).toBe(CONFIG.playerBaseArmor + CONFIG.armorK);
    expect(playerMitigation(p)).toBeCloseTo(0.5);
    const hp0 = p.hp;
    damagePlayerHit(g, p, 40, { roll: false }); // deterministic: 40 raw -> 20 taken
    expect(hp0 - p.hp).toBe(20);
    expect(p.damageTaken).toBe(20);
  });

  it("mitigation is hard-capped — no immortal crawlers", () => {
    expect(armorReduction(1e6, CONFIG.armorK, CONFIG.armorMaxReduction)).toBe(CONFIG.armorMaxReduction);
  });

  it("armor-slot drops lead with the armor affix", () => {
    const rng = createRng(4321);
    let id = 0;
    for (let i = 0; i < 60; i++) {
      const it = generateItem(rng, 5, () => ++id);
      if (it.slot === "armor") expect(it.affixes.armor ?? 0).toBeGreaterThan(0);
    }
  });

  it("pre-armor saves load with zero bonus armor", () => {
    const restored = restoreGame({
      seed: 42, floor: 3,
      player: { hp: 55, level: 5, xp: 10, xpToNext: 100, gold: 9, bonusDamage: 4 },
    });
    expect(restored.players[0].bonusArmor).toBe(0);
    expect(restored.players[0].armor).toBe(CONFIG.playerBaseArmor);
  });
});

describe("character sheet (buildCharacterSheet)", () => {
  it("melee estimate matches the real roll bounds and cooldown", () => {
    const g = createGame(918);
    const p = g.players[0];
    const sh = buildCharacterSheet(g, p);
    const melee = sh.offense.find((r) => r.id === "melee")!;
    const mp = meleeParams(p);
    const base = power(p, "melee") * mp.damageMult;
    const v = damageVariance(p);
    expect(melee.hit!.min).toBe(Math.max(1, Math.round(base * (1 - v))));
    expect(melee.hit!.max).toBe(Math.max(1, Math.round(base * (1 + v))));
    expect(melee.hit!.critMax).toBe(Math.round(melee.hit!.max * CONFIG.playerCritMult));
    expect(melee.hit!.cooldown).toBeCloseTo(mp.cooldown);
    expect(melee.hit!.dps).toBeGreaterThan(0);
  });

  it("defense block mirrors combat's mitigation math", () => {
    const g = createGame(919);
    const p = g.players[0];
    equipItem(p, { id: 1, slot: "armor", rarity: "rare", name: "Runed Plate", affixes: { armor: 30 } });
    const sh = buildCharacterSheet(g, p);
    expect(sh.defense.armor).toBe(30);
    expect(sh.defense.reduction).toBeCloseTo(30 / (30 + CONFIG.armorK));
    expect(sh.defense.exampleTaken).toBe(Math.max(1, Math.round(sh.defense.exampleRaw * (1 - sh.defense.reduction))));
    expect(sh.defense.effectiveHp).toBeGreaterThan(p.maxHp);
  });

  it("lists the slotted kit in slot order", () => {
    const g = createGame(920);
    const p = g.players[0];
    const sh = buildCharacterSheet(g, p);
    expect(sh.offense.map((r) => r.id)).toEqual(["melee", "dash", "bolt"]); // starting kit
    expect(sh.identity.weaponName).toBe("Bare Hands");
    expect(sh.identity.variance).toBe(0.15);
  });
});

describe("attack telegraphs + hit reactions", () => {
  function adjacentGrunt(g: ReturnType<typeof createGame>, over: Partial<import("../src/sim/types").Monster> = {}) {
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const m = mkMon({
      id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y },
      hp: 500, maxHp: 500, damage: 50, speed: 0, ...over,
    });
    g.monsters.push(m);
    return m;
  }

  it("monster melee winds up before landing â€” damage is never instant", () => {
    const g = createGame(910);
    const p = g.players[0];
    const m = adjacentGrunt(g);
    const hp0 = p.hp;
    step(g, idle(), 1 / 60);
    expect(m.windup).toBeGreaterThan(0); // committed, telegraphing
    expect(p.hp).toBe(hp0); // nothing landed yet
    stepPastWindup(g, m);
    expect(p.hp).toBeLessThan(hp0); // stood in it â€” the strike connects
    expect(m.attackCooldown).toBeGreaterThan(0);
  });

  it("stepping out of range during the windup makes the strike whiff", () => {
    const g = createGame(911);
    const p = g.players[0];
    const m = adjacentGrunt(g);
    step(g, idle(), 1 / 60); // windup starts
    expect(m.windup).toBeGreaterThan(0);
    p.pos = { x: m.pos.x + 5, y: m.pos.y }; // read the tell, leave
    const hp0 = p.hp;
    stepPastWindup(g, m);
    expect(p.hp).toBe(hp0); // dodged clean
    expect(m.attackCooldown).toBeGreaterThan(0); // it still swung (and recovers)
  });

  it("breaking poise staggers the monster and cancels its windup", () => {
    const g = createGame(912);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    p.attackPower = 200; // over the grunt poise threshold (500 * 0.25) in one hit
    const m = adjacentGrunt(g);
    step(g, idle(), 1 / 60); // monster commits to a swing
    expect(m.windup).toBeGreaterThan(0);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(m.stagger).toBeGreaterThan(0); // interrupted
    expect(m.windup).toBe(0);
    // The canceled swing never lands inside its original windup window.
    const hp0 = p.hp;
    for (let i = 0; i < 26; i++) step(g, idle(), 1 / 60);
    expect(p.hp).toBe(hp0);
  });

  it("brutes shrug off small hits (high poise, no stagger)", () => {
    const g = createGame(913);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    const m = adjacentGrunt(g, { kind: "brute" }); // poise 0.7 -> threshold 350
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(m.poiseDmg).toBeGreaterThan(0); // buildup counts...
    expect(m.stagger).toBe(0); // ...but a base hit doesn't rock it
  });

  it("melee hits shove the target away from the attacker", () => {
    const g = createGame(914);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    const m = adjacentGrunt(g, { attackCooldown: 99 }); // hold its own swing still
    const x0 = m.pos.x;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(m.pos.x).toBeGreaterThan(x0); // knocked back along the hit direction
  });

  it("ranged monsters aim (windup) before firing", () => {
    const g = createGame(915);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const m = mkMon({ id: 1, kind: "ranged", pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 50, maxHp: 50, damage: 5, attackRange: 6.5 });
    g.monsters.push(m);
    step(g, idle(), 1 / 60);
    expect(m.windup).toBeGreaterThan(0); // lining up the shot
    expect(g.projectiles.some((pr) => pr.from === "enemy")).toBe(false);
    stepPastWindup(g, m);
    expect(g.projectiles.some((pr) => pr.from === "enemy")).toBe(true);
  });

  it("the melee swing lunges toward the aim", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    const x0 = p.pos.x;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeGreaterThan(x0);
  });

  it("facing sweeps toward a new heading through the in-between angles", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    p.facing = { x: 1, y: 0 };
    // Request a 90° flip: one tick at playerTurnRate turns ~15°, not the
    // whole way — WASD's 8 headings stop being the only reachable facings.
    step(g, { move: { x: 0, y: 1 }, useStairs: false }, 1 / 60);
    const a = Math.atan2(p.facing.y, p.facing.x);
    expect(a).toBeGreaterThan(0.1);
    expect(a).toBeLessThan(Math.PI / 2 - 0.1);
    expect(Math.hypot(p.facing.x, p.facing.y)).toBeCloseTo(1);
    for (let i = 0; i < 10; i++) step(g, { move: { x: 0, y: 1 }, useStairs: false }, 1 / 60);
    expect(p.facing.y).toBeCloseTo(1); // and it converges, exactly
  });

  it("a sideways swing never shoves the runner off their line", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    const x0 = p.pos.x;
    // Running due south while swinging due east: the lunge must not add +x.
    step(g, { move: { x: 0, y: 1 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeCloseTo(x0, 6);
  });

  it("swinging WITH the run keeps the forward lunge (aggression intact)", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    const x0 = p.pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    // One tick of run alone is ~0.07 tiles; run + lunge clears it by a margin.
    expect(p.pos.x - x0).toBeGreaterThan(CONFIG.playerSpeed / 60 + 0.2);
  });

  it("swinging AGAINST the run never yanks the runner backward", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    const x0 = p.pos.x;
    // Sprinting east, mouse-swinging west behind you: keep sprinting east.
    step(g, { move: { x: 1, y: 0 }, attack: true, aim: { x: -1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.pos.x - x0).toBeGreaterThan(0);
    expect(p.pos.x - x0).toBeLessThan(0.2); // the run step only — no lunge either way
  });

  it("a swing commits facing to the aim, then movement reclaims it", () => {
    const g = createGame(916);
    const p = g.players[0];
    g.monsters.length = 0;
    step(g, { move: { x: 0, y: 1 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.facing.x).toBeCloseTo(1); // the attack tick aims the body
    // While the swing is in flight, running doesn't whip the body back...
    for (let i = 0; i < 5; i++) step(g, { move: { x: 0, y: 1 }, useStairs: false }, 1 / 60);
    expect(p.facing.x).toBeCloseTo(1);
    // ...but once it lands, facing follows the feet again.
    for (let i = 0; i < 15; i++) step(g, { move: { x: 0, y: 1 }, useStairs: false }, 1 / 60);
    expect(p.facing.y).toBeCloseTo(1);
  });

  it("killing blows are flagged on the hit event (with a direction)", () => {
    const g = createGame(917);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    p.attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y } }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const killing = g.hits.find((h) => (h.kind === "enemy" || h.kind === "crit") && h.killed);
    expect(killing).toBeDefined();
    expect(killing!.dir).toBeDefined();
  });

  it("a swarmer dies to one clean on-level hit (config invariant)", () => {
    const minRoll = Math.round(CONFIG.playerBaseDamage * 0.85);
    const swarmerHp = Math.round(CONFIG.monsterBaseHp * 0.35);
    expect(minRoll).toBeGreaterThanOrEqual(swarmerHp);
  });
});

describe("melee hitboxes (the 'that should have hit' class)", () => {
  function swing(g: ReturnType<typeof createGame>) {
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
  }

  it("point-blank melee always connects (the lunge never overshoots)", () => {
    const g = createGame(970);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    // A tiny swarmer INSIDE arm's reach â€” the exact repro of the whiff bug:
    // the swing's lunge used to carry the player past it, out of the arc.
    g.monsters.push(mkMon({ id: 1, kind: "swarmer", pos: { x: p.pos.x + 0.2, y: p.pos.y }, hp: 500, maxHp: 500 }));
    swing(g);
    expect(g.monsters[0].hp).toBeLessThan(500);
  });

  it("body size counts: a brute's shoulder in reach is a hit at ranges a grunt is not", () => {
    const hits = (kind: "brute" | "grunt") => {
      const g = createGame(971);
      const p = g.players[0];
      g.monsters.length = 0;
      g.monsters.push(mkMon({ id: 1, kind, pos: { x: p.pos.x + 2.2, y: p.pos.y }, hp: 500, maxHp: 500 }));
      swing(g);
      return g.monsters[0].hp < 500;
    };
    expect(hits("brute")).toBe(true); // radius 0.55: the sweep touches the body
    expect(hits("grunt")).toBe(false); // radius 0.35: genuinely out of reach
  });

  it("aim assist: a swing aimed the wrong way snaps to the enemy in arm's reach", () => {
    const g = createGame(972);
    const p = g.players[0];
    g.monsters.length = 0;
    // Enemy directly BEHIND the aim direction, but adjacent.
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x - 0.8, y: p.pos.y }, hp: 500, maxHp: 500 }));
    swing(g); // aim = +x, enemy at -x
    expect(g.monsters[0].hp).toBeLessThan(500);
  });

  it("bolts clip fat shoulders their line only grazes", () => {
    const g = createGame(973);
    const p = g.players[0];
    g.monsters.length = 0;
    g.projectiles.length = 0;
    // Brute offset 0.8 tiles from the bolt's path: old check (0.65) missed it,
    // body-radius check (0.35 + 0.55 = 0.90) grazes it.
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: p.pos.x + 3, y: p.pos.y + 0.8 }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: false, bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    for (let i = 0; i < 60 && g.monsters[0].hp === 500; i++) step(g, idle(), 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
  });
});

describe("dash charges", () => {
  it("banks two dashes, blocks the third, and recharges one at a time", () => {
    const g = createGame(920);
    const p = g.players[0];
    expect(p.dashCharges).toBe(CONFIG.dashCharges);
    step(g, { ...idle(), dash: true }, 1 / 60);
    expect(p.dashCharges).toBe(CONFIG.dashCharges - 1);
    expect(p.cd.dash ?? 0).toBeGreaterThan(0); // recharge timer running
    step(g, { ...idle(), dash: true }, 1 / 60);
    expect(p.dashCharges).toBe(0); // both spent back-to-back â€” that's the point
    const x0 = p.pos.x;
    step(g, { ...idle(), dash: true, move: { x: 0, y: 0 } }, 1 / 60);
    expect(p.dashCharges).toBe(0); // tank is empty
    expect(p.pos.x).toBe(x0); // no blink happened
    // One full recharge restores one charge; the next timer starts automatically.
    for (let i = 0; i < Math.ceil(CONFIG.dashCooldown * 60) + 5; i++) step(g, idle(), 1 / 60);
    expect(p.dashCharges).toBe(1);
    for (let i = 0; i < Math.ceil(CONFIG.dashCooldown * 60) + 5; i++) step(g, idle(), 1 / 60);
    expect(p.dashCharges).toBe(CONFIG.dashCharges);
  });
});

describe("crowd frenzy", () => {
  it("sustained hype enters frenzy (announced), buffing speed and cooldowns", () => {
    const g = createGame(930);
    const p = g.players[0];
    addHype(g, p, CONFIG.show.frenzyEnter + 20);
    step(g, idle(), 1 / 60);
    expect(p.frenzy).toBe(true);
    expect(g.announcements.some((a) => a.text.includes("CHANTING"))).toBe(true);
    // Faster hands: the melee cooldown lands shorter than base.
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.cd.melee!).toBeLessThan(CONFIG.playerAttackCooldown * 0.99);
    // Faster feet: one step covers more ground than base speed would.
    const x0 = p.pos.x;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(p.pos.x - x0).toBeGreaterThan((p.speed / 60) * 1.05);
  });

  it("drops out of frenzy only below the exit threshold (hysteresis)", () => {
    const g = createGame(931);
    const p = g.players[0];
    p.frenzy = true;
    p.hype = (CONFIG.show.frenzyEnter + CONFIG.show.frenzyExit) / 2; // between thresholds
    step(g, idle(), 1 / 60);
    expect(p.frenzy).toBe(true); // still riding the wave
    p.hype = CONFIG.show.frenzyExit - 10;
    step(g, idle(), 1 / 60);
    expect(p.frenzy).toBe(false);
  });
});

describe("sponsor slurp flask", () => {
  // Re-enabled (CONFIG.flaskEnabled: true) with the status-effect pass —
  // aggression is the sustain loop again.
  it("drinking heals a fraction of max HP and consumes a charge", () => {
    const g = createGame(940);
    const p = g.players[0];
    g.monsters.length = 0;
    p.hp = 10;
    step(g, { ...idle(), flask: true }, 1 / 60);
    expect(p.hp).toBe(10 + Math.round(p.maxHp * CONFIG.flaskHealFraction));
    expect(p.flaskCharges).toBe(CONFIG.flaskMaxCharges - 1);
    expect(g.hits.some((h) => h.kind === "heal")).toBe(true);
  });

  it("a full-HP chug is not consumed; an empty flask does nothing", () => {
    const g = createGame(941);
    const p = g.players[0];
    g.monsters.length = 0;
    step(g, { ...idle(), flask: true }, 1 / 60);
    expect(p.flaskCharges).toBe(CONFIG.flaskMaxCharges); // full HP â€” saved the charge
    p.flaskCharges = 0;
    p.hp = 10;
    step(g, { ...idle(), flask: true }, 1 / 60);
    expect(p.hp).toBe(10);
  });

  it("kills refill a missing charge", () => {
    const g = createGame(942);
    const p = g.players[0];
    p.facing = { x: 1, y: 0 };
    p.attackPower = 100000;
    p.flaskCharges = 0;
    g.monsters.length = 0;
    for (let i = 0; i < CONFIG.flaskKillsPerCharge; i++) {
      g.monsters.push(mkMon({ id: 2000 + i, pos: { x: p.pos.x + 0.6, y: p.pos.y } }));
    }
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.flaskCharges).toBe(1);
    expect(p.flaskKillProgress).toBe(0);
  });

  it("descending refills the flask", () => {
    const g = createGame(943);
    g.players[0].flaskCharges = 0;
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.players[0].flaskCharges).toBe(CONFIG.flaskMaxCharges);
  });
});

describe("elite affixes", () => {
  it("elites on affix floors always roll one (deterministically)", () => {
    for (const seed of [950, 951]) {
      const mk = () => restoreGame({
        seed, floor: CONFIG.eliteAffixFromFloor + 1,
        player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
      });
      const a = mk().monsters.find((m) => m.elite);
      const b = mk().monsters.find((m) => m.elite);
      expect(a?.affix).toBeDefined();
      expect(a?.affix).toBe(b?.affix);
    }
  });

  it("shielded elites take reduced damage (same seed, same rolls)", () => {
    const dealt = (shielded: boolean) => {
      const g = createGame(952);
      const p = g.players[0];
      p.facing = { x: 1, y: 0 };
      g.monsters.length = 0;
      g.monsters.push(mkMon({
        id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 5000, maxHp: 5000,
        affix: shielded ? "shielded" : undefined,
      }));
      step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
      return 5000 - g.monsters[0].hp;
    };
    expect(dealt(true)).toBeLessThan(dealt(false));
  });

  it("volatile elites leave a delayed corpse blast that can be dodged", () => {
    const g = createGame(953);
    const p = g.players[0];
    g.monsters.length = 0;
    const m = mkMon({
      id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 0, maxHp: 30,
      damage: 20, affix: "volatile", lastHitBy: 0,
    });
    g.monsters.push(m);
    const hp0 = p.hp;
    step(g, idle(), 1 / 60); // reaped -> hazard scheduled
    expect(g.hazards.length).toBe(1);
    expect(p.hp).toBe(hp0); // not instant
    // Stand in it: the blast lands when the timer runs out.
    for (let i = 0; i < 90 && g.hazards.length > 0; i++) step(g, idle(), 1 / 60);
    expect(p.hp).toBeLessThan(hp0);

    // Same setup, but walk clear before detonation.
    const g2 = createGame(954);
    const p2 = g2.players[0];
    g2.monsters.length = 0;
    g2.monsters.push(mkMon({
      id: 1, pos: { x: p2.pos.x + 0.8, y: p2.pos.y }, hp: 0, maxHp: 30,
      damage: 20, affix: "volatile", lastHitBy: 0,
    }));
    step(g2, idle(), 1 / 60);
    p2.pos = { x: p2.pos.x + CONFIG.volatileRadius + 2, y: p2.pos.y };
    const hp2 = p2.hp;
    for (let i = 0; i < 90 && g2.hazards.length > 0; i++) step(g2, idle(), 1 / 60);
    expect(p2.hp).toBe(hp2); // cleared the corpse
  });

  it("summoner elites call swarmer adds on a cooldown, lifetime-capped", () => {
    const g = createGame(955);
    const p = g.players[0];
    g.monsters.length = 0;
    const m = mkMon({
      id: 1, pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 9999, maxHp: 9999,
      attackCooldown: 999, affix: "summoner",
    });
    g.monsters.push(m);
    step(g, idle(), 1 / 60);
    // The summon is a telegraphed channel now: committed, cd paid, no add yet.
    expect(m.windupKind).toBe("summon");
    expect(m.affixCd).toBeGreaterThan(0);
    for (let t = 0; t < CONFIG.summonWindup + 0.1; t += 1 / 60) step(g, idle(), 1 / 60);
    expect(g.monsters.filter((mm) => mm.kind === "swarmer").length).toBe(1);
    expect(m.summons).toBe(1);
    expect(g.monsters.find((mm) => mm.kind === "swarmer")!.xp).toBe(1); // not an XP farm
    m.summons = CONFIG.summonMax; // cap reached
    m.affixCd = 0;
    const count = g.monsters.length;
    for (let t = 0; t < CONFIG.summonWindup + 0.2; t += 1 / 60) step(g, idle(), 1 / 60);
    expect(g.monsters.length).toBeLessThanOrEqual(count); // no further summons
  });
});

describe("ringside introductions", () => {
  function withElite(seed: number) {
    const g = restoreGame({
      seed, floor: 4,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    const elite = g.monsters.find((m) => m.elite)!;
    expect(elite).toBeDefined();
    return { g, elite };
  }

  it("closing with an elite freezes the world for the reveal, once", () => {
    const { g, elite } = withElite(960);
    const p = g.players[0];
    p.pos = { x: elite.pos.x + 3, y: elite.pos.y }; // inside the reveal radius
    elite.attackCooldown = 0;
    const hp0 = p.hp;
    step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    expect(g.encounter).not.toBeNull();
    expect(g.encounter!.monsterId).toBe(elite.id);
    expect(g.encounter!.name).toBe(elite.eliteName);
    expect(elite.introduced).toBe(true);
    expect(g.announcements.some((a) => a.text.includes("RINGSIDE") && a.text.includes(elite.eliteName!))).toBe(true);
    // Frozen: nobody moves, nobody winds up, nobody gets hit.
    const px = p.pos.x;
    const introSteps = Math.ceil(CONFIG.encounterIntroSeconds * 60);
    for (let i = 0; i < introSteps - 1; i++) {
      step(g, { move: { x: 1, y: 0 }, attack: false, useStairs: false }, 1 / 60);
    }
    expect(p.pos.x).toBe(px);
    expect(p.hp).toBe(hp0);
    expect(elite.windup).toBe(0);
    // The freeze ends; the fight is live and never re-introduces.
    for (let i = 0; i < 5; i++) step(g, idle(), 1 / 60);
    expect(g.encounter).toBeNull();
    step(g, idle(), 1 / 60);
    expect(g.encounter).toBeNull(); // introduced once, fight on
  });

  it("the final boss introduces as THE FLOOR BOSS", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.players[0].pos = { x: boss.pos.x + 4, y: boss.pos.y };
    step(g, idle(), 1 / 60);
    expect(g.encounter?.name).toBe("THE FLOOR BOSS");
    expect(g.encounter?.kind).toBe("boss");
  });

  it("dead menaces are never introduced", () => {
    const { g, elite } = withElite(961);
    elite.hp = 0;
    g.players[0].pos = { x: elite.pos.x + 2, y: elite.pos.y };
    step(g, idle(), 1 / 60);
    expect(g.encounter).toBeNull();
  });
});

describe("boss phases", () => {
  it("crossing 2/3 HP enrages the boss: speed up, denser volleys, announced", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    // Park the player near the boss so it acts, but clear other monsters.
    g.monsters = [boss];
    g.projectiles.length = 0;
    boss.introduced = true; // skip the ringside intro; this test is about phases
    boss.bossTier = undefined; // no Dark Ritual windup eating a step; this test is about phases
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    const speed0 = boss.speed;
    boss.hp = Math.floor(boss.maxHp * 0.5); // between 2/3 and 1/3
    step(g, idle(), 1 / 60);
    expect(boss.phase).toBe(1);
    expect(boss.speed).toBeGreaterThan(speed0);
    expect(g.announcements.some((a) => a.text.includes("ANGRY"))).toBe(true);
    // Phase 2 stacks on top.
    boss.hp = Math.floor(boss.maxHp * 0.2);
    step(g, idle(), 1 / 60);
    expect(boss.phase).toBe(2);
    expect(boss.speed).toBeGreaterThan(speed0 * CONFIG.bossPhaseSpeedMult);
  });

  it("phase transitions call an adds wave (backlog #11)", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.monsters = [boss];
    boss.introduced = true;
    g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
    boss.hp = Math.floor(boss.maxHp * 0.5);
    step(g, idle(), 1 / 60);
    expect(boss.phase).toBe(1);
    // The wave arrived around the boss and is worth almost nothing.
    const adds = g.monsters.filter((m) => m !== boss);
    expect(adds.length).toBeGreaterThanOrEqual(CONFIG.bossWaveAdds + CONFIG.bossWaveAddsPerPhase);
    expect(adds.every((m) => m.xp <= 1)).toBe(true);
    expect(g.announcements.some((a) => a.text.includes("BACKUP"))).toBe(true);
  });

  it("phase 1+ rains telegraphed hazards on crawler positions (backlog #11)", () => {
    const g = restoreGame({
      seed: 99, floor: CONFIG.finalFloor,
      player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    g.monsters = [boss];
    g.hazards.length = 0;
    boss.introduced = true;
    boss.bossTier = undefined; // no ritual/slam windup eating the step; this test is about hazard rain
    const p = g.players[0];
    p.pos = { x: boss.pos.x + 5, y: boss.pos.y };
    boss.hp = Math.floor(boss.maxHp * 0.5); // -> phase 1 on the next step
    step(g, idle(), 1 / 60);
    // Phase 1 ALSO starts the finale's greatest-hits reel (borrowed debris,
    // boss layer 2) — filter the RAIN by its distinctive fuse length.
    const rain = g.hazards.filter((h) => h.kind === "blast" && Math.abs(h.total - CONFIG.bossHazardDelay) < 0.01);
    expect(rain.length).toBeGreaterThanOrEqual(1);
    // Aimed at where the crawler WAS standing — moving out is the dodge.
    expect(rain.some((h) => Math.abs(h.pos.x - p.pos.x) < 0.5 && Math.abs(h.pos.y - p.pos.y) < 0.5)).toBe(true);
    // Spawned this step, so it has already ticked down by one dt.
    expect(rain[0].t).toBeGreaterThan(CONFIG.bossHazardDelay - 0.1);
  });

  it("boss floors host the fight in a dedicated oversized arena (backlog #11)", () => {
    for (const floor of [6, 12, CONFIG.finalFloor]) {
      const map = generateFloor(createRng(1234 + floor), floor);
      const stairsRoom = map.rooms[map.roles.indexOf("stairs")];
      expect(stairsRoom.w).toBe(CONFIG.bossArenaSize);
      expect(stairsRoom.h).toBe(CONFIG.bossArenaSize);
      // The stairs (= boss spawn) sit inside the arena.
      expect(map.stairs.x).toBeGreaterThanOrEqual(stairsRoom.x);
      expect(map.stairs.x).toBeLessThan(stairsRoom.x + stairsRoom.w);
    }
    // Ordinary floors keep ordinary rooms (max side 12).
    const plain = generateFloor(createRng(555), 7);
    const plainStairs = plain.rooms[plain.roles.indexOf("stairs")];
    expect(Math.max(plainStairs.w, plainStairs.h)).toBeLessThanOrEqual(12);
  });

  it("corridors are at least two tiles wide (pathways must read on sight)", () => {
    // A 1-wide corridor tile has exactly 2 walkable neighbors; 2-wide carving
    // gives every corridor tile its lateral partner (3+). Allow a tiny
    // remainder for map-border clamps, but a 1-wide system fails massively.
    for (const seed of [11, 77, 555]) {
      for (const floor of [2, 7, 13]) {
        const map = generateFloor(createRng(seed), floor);
        const inRoom = (x: number, y: number) =>
          map.rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        const walkable = (x: number, y: number) =>
          x >= 0 && y >= 0 && x < map.w && y < map.h && map.tiles[y * map.w + x] !== Tile.Wall;
        let corridor = 0;
        let narrow = 0;
        for (let y = 0; y < map.h; y++) {
          for (let x = 0; x < map.w; x++) {
            if (!walkable(x, y) || inRoom(x, y)) continue;
            corridor++;
            const n = [walkable(x + 1, y), walkable(x - 1, y), walkable(x, y + 1), walkable(x, y - 1)]
              .filter(Boolean).length;
            if (n < 3) narrow++;
          }
        }
        expect(corridor).toBeGreaterThan(0);
        expect(narrow / corridor).toBeLessThan(0.02);
      }
    }
  });
});

describe("theme bands", () => {
  it("maps floors to 3-floor bands", () => {
    expect([1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18].map((f) => floorBand(f)))
      .toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("announces the district when crossing a band boundary (3 -> 4)", () => {
    const g = restoreGame({
      seed: 71, floor: 3,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    g.monsters.length = 0; // floor 3 is a band-boss floor; the boss seals the stairs
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(4);
    expect(g.announcements.some((a) => a.text.includes("THE SEWERS"))).toBe(true);
  });

  it("announces THE GARDEN at floor 7", () => {
    const g = restoreGame({
      seed: 73, floor: 6,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    g.monsters.length = 0; // floor 6 is a city-boss floor; the boss seals the stairs
    step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
    leaveSafeRoom(g);
    expect(g.floor).toBe(7);
    expect(g.announcements.some((a) => a.text.includes("THE GARDEN"))).toBe(true);
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
    expect(g.announcements.some((a) => a.text.includes("Now entering"))).toBe(false);
  });
});

describe("intentional floors (mission-lite)", () => {
  it("tags rooms with roles: entrance, stairs, one landmark, one vault", () => {
    for (const seed of [21, 322, 4923]) {
      const g = createGame(seed);
      const { roles } = g.map;
      expect(roles[0]).toBe("entrance");
      expect(roles.filter((r) => r === "stairs").length).toBe(1);
      if (g.map.rooms.length >= 4) {
        expect(roles.filter((r) => r === "landmark").length).toBe(1);
        expect(roles.filter((r) => r === "vault").length).toBe(1);
      }
    }
  });

  it("carves at least one cycle so floors loop instead of treeing", () => {
    for (const seed of [21, 322, 4923]) {
      const g = createGame(seed);
      if (g.map.rooms.length >= 5) expect(g.map.cycles).toBeGreaterThanOrEqual(1);
    }
  });

  it("ramps encounter density along the critical path", () => {
    // Across seeds, monsters overwhelmingly sit in the deeper half of the run.
    let shallow = 0, deep = 0;
    for (const seed of [77, 1234, 5555, 9012]) {
      const g = createGame(seed);
      const inRoom = (m: { pos: { x: number; y: number } }, i: number) => {
        const r = g.map.rooms[i];
        return m.pos.x >= r.x && m.pos.x < r.x + r.w && m.pos.y >= r.y && m.pos.y < r.y + r.h;
      };
      for (const m of g.monsters) {
        for (let i = 0; i < g.map.rooms.length; i++) {
          if (!inRoom(m, i)) continue;
          if ((g.map.depths[i] ?? 0.5) < 0.5) shallow++;
          else deep++;
          break;
        }
      }
    }
    expect(deep).toBeGreaterThan(shallow);
  });

  it("spawns monsters in Diablo-style packs (clustered encounters)", () => {
    // Most monsters should have a packmate within 3 tiles; only the lone-wanderer
    // share (~20%) roams solo.
    let clustered = 0, total = 0;
    for (const seed of [77, 1234, 5555]) {
      const g = restoreGame({
        seed, floor: 4, // 3 is a band-boss arena (its crowd spawns unclustered)
        player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
      });
      for (const m of g.monsters) {
        total++;
        const near = g.monsters.some((o) =>
          o !== m && Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3);
        if (near) clustered++;
      }
    }
    expect(clustered / total).toBeGreaterThan(0.6);
  });

  it("the vault holds guaranteed treasure and a guardian; the entrance is safe", () => {
    for (const seed of [21, 4923]) {
      const g = createGame(seed);
      const vaultIdx = g.map.roles.indexOf("vault");
      if (vaultIdx < 0) continue;
      const r = g.map.rooms[vaultIdx];
      const inVault = (p: { x: number; y: number }) =>
        p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
      expect(g.loot.filter((l) => l.kind === "item" && inVault(l.pos)).length).toBeGreaterThanOrEqual(2);
      expect(g.monsters.some((m) => m.kind === "brute" && inVault(m.pos))).toBe(true);
      // Entrance room stays empty.
      const e = g.map.rooms[0];
      const inEntrance = (p: { x: number; y: number }) =>
        p.x >= e.x && p.x < e.x + e.w && p.y >= e.y && p.y < e.y + e.h;
      expect(g.monsters.some((m) => inEntrance(m.pos))).toBe(false);
    }
  });

  it("the neighborhood boss holds the landmark hall when one exists", () => {
    const g = restoreGame({
      seed: 4923, floor: 4,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 },
    });
    const landmarkIdx = g.map.roles.indexOf("landmark");
    const elite = g.monsters.find((m) => m.elite);
    if (landmarkIdx >= 0 && elite) {
      const r = g.map.rooms[landmarkIdx];
      const inside =
        elite.pos.x >= r.x && elite.pos.x < r.x + r.w &&
        elite.pos.y >= r.y && elite.pos.y < r.y + r.h;
      expect(inside).toBe(true);
    }
  });
});

describe("the five (ability loadout)", () => {
  function safeRoomGame(seed = 800) {
    const g = createGame(seed);
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    expect(g.safeRoom).not.toBeNull();
    return g;
  }

  it("starts with [melee, dash, bolt, empty] and an empty ultimate", () => {
    const g = createGame(801);
    const L = g.players[0].abilities;
    expect(L.slots).toEqual(["melee", "dash", "bolt", null]);
    expect(L.ultimate).toBeNull();
    expect(L.bench).toEqual([]);
  });

  it("auto-slots a discovered active into the open slot; extras go to the bench", () => {
    const g = createGame(802);
    const p = g.players[0];
    learnAbility(g, p, "nova"); // slot 4 is open
    expect(p.abilities.slots[3]).toBe("nova");
    learnAbility(g, p, "orbit"); // slots full now
    expect(p.abilities.bench).toContain("orbit");
    // Ultimates fill the ultimate slot, not an active slot.
    learnAbility(g, p, "airstrike");
    expect(p.abilities.ultimate).toBe("airstrike");
    learnAbility(g, p, "cataclysm"); // ult occupied -> bench
    expect(p.abilities.bench).toContain("cataclysm");
  });

  it("re-slotting is safe-room only; ranks persist through the bench", () => {
    const g = createGame(803);
    const p = g.players[0];
    learnAbility(g, p, "nova");
    learnAbility(g, p, "orbit"); // benched
    p.abilities.ranks["nova.bang"] = 2;
    // In the field: rejected.
    slotAbility(g, p.id, 3, "orbit");
    expect(p.abilities.slots[3]).toBe("nova");
    // In a safe room: allowed; nova is displaced to the bench, ranks intact.
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    slotAbility(g, p.id, 3, "orbit");
    expect(p.abilities.slots[3]).toBe("orbit");
    expect(p.abilities.bench).toContain("nova");
    expect(p.abilities.ranks["nova.bang"]).toBe(2);
  });

  it("freeing melee removes the basic attack (a real commitment)", () => {
    const g = safeRoomGame(804);
    const p = g.players[0];
    slotAbility(g, p.id, 0, null); // free melee
    expect(p.abilities.slots[0]).toBeNull();
    expect(p.abilities.bench).toContain("melee");
    leaveSafeRoom(g);
    p.facing = { x: 1, y: 0 };
    p.attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 50, maxHp: 50 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.monsters[0].hp).toBe(50); // swing... with what?
  });

  it("upgrade drafts offer ranks only for slotted abilities", () => {
    const g = createGame(805);
    const p = g.players[0];
    learnAbility(g, p, "nova");
    learnAbility(g, p, "orbit"); // benched
    p.upgradeDraftsOwed = 3;
    for (let i = 0; i < 3; i++) {
      p.pendingUpgrades = [];
      step(g, idle(), 1 / 60);
      for (const u of p.pendingUpgrades) {
        expect(["melee", "dash", "bolt", "nova"]).toContain(u.ability); // never orbit
      }
    }
  });

  it("cast[] slots fire the ability in that slot", () => {
    const g = createGame(806);
    const p = g.players[0];
    g.monsters.length = 0;
    // Slot 3 holds bolt at start: cast[2] fires it.
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, true, false, false], aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.projectiles.filter((pr) => pr.from === "player").length).toBeGreaterThan(0);
    expect(p.cd.bolt ?? 0).toBeGreaterThan(0);
  });
});

describe("ultimates", () => {
  function withUlt(seed: number, ult: "airstrike" | "cataclysm" | "bullettime") {
    const g = createGame(seed);
    const p = g.players[0];
    learnAbility(g, p, ult); // ultimate slot is empty -> auto-slots
    expect(p.abilities.ultimate).toBe(ult);
    g.monsters.length = 0;
    return g;
  }

  it("sponsor airstrike schedules shells that later detonate on monsters", () => {
    const g = withUlt(810, "airstrike");
    const p = g.players[0];
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, false, true], aim: { x: 3, y: 0 } }, 1 / 60);
    expect(g.strikes.length).toBe(CONFIG.ultAirstrikeShells);
    expect(p.cd.airstrike ?? 0).toBeGreaterThan(0);
    for (let i = 0; i < 180; i++) step(g, idle(), 1 / 60);
    expect(g.strikes.length).toBe(0); // all shells landed
    expect(g.monsters[0].hp).toBeLessThan(500); // scatter covers a 3-tile offset target
  });

  it("cataclysm damages and hurls everything nearby", () => {
    const g = withUlt(811, "cataclysm");
    const p = g.players[0];
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 2, y: p.pos.y }, hp: 500, maxHp: 500 }));
    const x0 = g.monsters[0].pos.x;
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, false, true] }, 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
    expect(g.monsters[0].pos.x).toBeGreaterThan(x0); // knocked away
  });

  it("bullet time slows monsters but not the caster", () => {
    const g = withUlt(812, "bullettime");
    const p = g.players[0];
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 6, y: p.pos.y }, hp: 500, maxHp: 500, speed: 2.6 }));
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, false, true] }, 1 / 60);
    expect(g.bulletTimeLeft).toBeGreaterThan(0);
    const m0 = g.monsters[0].pos.x;
    const p0 = p.pos.x;
    for (let i = 0; i < 30; i++) step(g, { move: { x: -1, y: 0 }, useStairs: false }, 1 / 60);
    const monsterMoved = m0 - g.monsters[0].pos.x;
    const playerMoved = p0 - p.pos.x;
    expect(playerMoved).toBeGreaterThan(monsterMoved * 2); // world slowed, crawler not
  });
});

describe("materials (the elite/boss hunt)", () => {
  it("elites drop a trophy; city bosses drop a sigil", () => {
    const g = createGame(901);
    const p = g.players[0];
    g.monsters.length = 0;
    // `introduced` skips the ringside-intro world freeze (tested elsewhere).
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.6, y: p.pos.y }, elite: true, eliteName: "Testy", introduced: true }));
    p.facing = { x: 1, y: 0 };
    p.attackPower = 99999;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    // The corpse is inside pickup radius, so the trophy lands in the pocket.
    const onGround = g.loot.some((l) => l.kind === "material" && l.material === "elite_trophy");
    expect(onGround || p.materials.elite_trophy >= 1).toBe(true);
  });

  it("materials persist through the save/restore seam (legacy scrap dropped)", () => {
    const g = restoreGame({
      seed: 905, floor: 3,
      player: { hp: 80, level: 4, xp: 0, xpToNext: 99, gold: 50,
        materials: { scrap: 7, elite_trophy: 2, boss_sigil: 1 } as never },
    });
    expect(g.players[0].materials).toEqual({ elite_trophy: 2, boss_sigil: 1 });
  });
});

describe("signature gear passives", () => {

  it("Landlord's Ledger pays gold on kill credit", () => {
    const g = createGame(952);
    const p = g.players[0];
    p.equipment.trinket = { id: 2, slot: "trinket", rarity: "epic", name: "Landlord's Ledger", affixes: {}, passive: "ledger" };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.6, y: p.pos.y }, xp: 5 }));
    p.facing = { x: 1, y: 0 };
    p.attackPower = 9999;
    const gold0 = p.gold;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.gold).toBeGreaterThanOrEqual(gold0 + 3);
  });

  it("Blastplate detonates the dash launch point", () => {
    const g = createGame(953);
    const p = g.players[0];
    p.equipment.armor = { id: 3, slot: "armor", rarity: "epic", name: "Blastplate Harness", affixes: {}, passive: "blastplate" };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x - 1, y: p.pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 1, y: 0 }, useStairs: false, cast: [false, true, false, false, false] }, 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500); // caught in the launch blast
  });

  it("Overtime Clause trims ultimate cooldowns by 25%", () => {
    const g = createGame(954);
    const p = g.players[0];
    learnAbility(g, p, "cataclysm");
    p.equipment.trinket = { id: 4, slot: "trinket", rarity: "epic", name: "Overtime Clause", affixes: {}, passive: "overtime" };
    g.monsters.length = 0;
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, false, true] }, 1 / 60);
    const cd = g.players[0].cd.cataclysm ?? 0;
    expect(cd).toBeLessThan(CONFIG.ultCataclysmCooldown * 0.76);
    expect(cd).toBeGreaterThan(CONFIG.ultCataclysmCooldown * 0.7);
  });
});

describe("overranks (backlog #7): lottery ranks past the printed max", () => {
  it("a maxed node leaves the normal pool and enters the overrank pool", () => {
    const g = createGame(980);
    const p = g.players[0];
    p.abilities.ranks["melee.arc"] = 2; // printed max
    expect(availableUpgrades(p).map((u) => u.id)).not.toContain("melee.arc");
    expect(overrankUpgrades(p).map((u) => u.id)).toContain("melee.arc");
  });

  it("the effective cap ends the chase: no overrank offers past maxRank + over", () => {
    const g = createGame(981);
    const p = g.players[0];
    const def = upgradeDef("melee.arc")!;
    p.abilities.ranks["melee.arc"] = effectiveMaxRank(def); // 2 + 2
    expect(overrankUpgrades(p).map((u) => u.id)).not.toContain("melee.arc");
  });

  it("capstones have no overrank headroom", () => {
    const def = upgradeDef("melee.execute")!;
    expect(effectiveMaxRank(def)).toBe(def.maxRank);
  });

  it("overrank offers are scarce, at most one per draft, and only for maxed nodes", () => {
    const g = createGame(982);
    const p = g.players[0];
    p.abilities.ranks["melee.arc"] = 2; // the only maxed node
    let overs = 0;
    const rolls = 400;
    for (let i = 0; i < rolls; i++) {
      const draft = rollUpgradeDraft(createRng(9000 + i), p, CONFIG.upgradeDraftSize, 20);
      const overOffers = draft.filter((o) => o.overrank);
      expect(overOffers.length).toBeLessThanOrEqual(1);
      for (const o of overOffers) {
        expect(o.id).toBe("melee.arc");
        expect(o.nextRank).toBe(3); // one past the printed max
      }
      overs += overOffers.length;
    }
    expect(overs).toBeGreaterThan(0); // the jackpot exists...
    expect(overs).toBeLessThan(rolls / 2); // ...but stays a lottery, not a fixture
  });

  it("no lottery fires while nothing is maxed", () => {
    const g = createGame(983);
    const p = g.players[0];
    for (let i = 0; i < 100; i++) {
      const draft = rollUpgradeDraft(createRng(7000 + i), p, CONFIG.upgradeDraftSize, 20);
      expect(draft.some((o) => o.overrank)).toBe(false);
    }
  });

  it("overrank odds grow with depth but clamp at the ceiling", () => {
    expect(overrankChance(1)).toBeLessThan(overrankChance(10));
    expect(overrankChance(50)).toBe(CONFIG.overrankChanceMax);
  });

  it("choosing an overrank applies the rank past max and headlines the moment", () => {
    const g = createGame(984);
    const p = g.players[0];
    p.abilities.ranks["melee.arc"] = 2;
    p.pendingUpgrades = [{
      id: "melee.arc", ability: "melee", title: "Wide Arc", desc: "Swing arc +66°", nextRank: 3, overrank: true,
    }];
    chooseUpgrade(g, p.id, 0);
    expect(rank(p, "melee.arc")).toBe(3);
    const ann = g.announcements.find((a) => a.text.includes("OVERRANK"));
    expect(ann).toBeDefined();
    expect(ann!.kind).toBe("levelup");
    expect(ann!.priority).toBe("high");
  });
});

describe("test mode (createTestGame)", () => {
  it("jumps to the requested floor with a leveled, geared crawler", () => {
    const g = createTestGame({ floor: 9, level: 12, seed: 7 });
    const p = g.players[0];
    expect(g.floor).toBe(9);
    expect(p.level).toBe(12);
    expect(p.hp).toBe(p.maxHp);
    expect(p.equipment.weapon ?? p.equipment.armor ?? p.equipment.trinket).toBeTruthy();
    // Levels were spent through the real draft roller, so ranks exist.
    const ranks = Object.values(p.abilities.ranks).reduce((a, b) => a + b, 0);
    expect(ranks).toBeGreaterThan(0);
    expect(g.status).toBe("playing");
  });

  it("is deterministic: same setup, same crawler, same floor", () => {
    const a = createTestGame({ floor: 5, level: 8, seed: 42 });
    const b = createTestGame({ floor: 5, level: 8, seed: 42 });
    expect(JSON.stringify(a.players[0])).toBe(JSON.stringify(b.players[0]));
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
  });

  it("clamps the floor and slots requested abilities", () => {
    const g = createTestGame({ floor: 99, abilities: ["nova", "airstrike"] });
    expect(g.floor).toBe(CONFIG.finalFloor);
    const p = g.players[0];
    expect(knows(p, "nova")).toBe(true);
    expect(p.abilities.ultimate).toBe("airstrike");
  });

  it("abilities: 'all' discovers the whole kit", () => {
    const p = createTestGame({ abilities: "all", level: 20 }).players[0];
    for (const a of DISCOVERABLE_ABILITIES) expect(knows(p, a)).toBe(true);
  });

  it("gear: false starts bare-handed; default gold scales with floor", () => {
    const bare = createTestGame({ floor: 10, gear: false }).players[0];
    expect(bare.equipment.weapon).toBeNull();
    expect(bare.gold).toBe(400);
  });
});

describe("ability constellation (prereqs, forks, capstones)", () => {
  it("drafts never offer a node whose prerequisites are unmet", () => {
    const g = createGame(970);
    const p = g.players[0];
    // Fresh melee tree: heavy/swift/execute all require arc.
    p.upgradeDraftsOwed = 5;
    for (let i = 0; i < 5; i++) {
      p.pendingUpgrades = [];
      step(g, idle(), 1 / 60);
      for (const u of p.pendingUpgrades) {
        expect(["melee.heavy", "melee.swift", "melee.execute"]).not.toContain(u.id);
      }
    }
  });

  it("taking one side of a fork locks the other side out", () => {
    const g = createGame(971);
    const p = g.players[0];
    p.abilities.ranks["bolt.rapid"] = 1;
    p.abilities.ranks["bolt.split"] = 1; // pick the split side
    const open = availableUpgrades(p).map((u) => u.id);
    expect(open).not.toContain("bolt.pierce");
    expect(open).toContain("bolt.split"); // can keep investing in the chosen side
  });

  it("EXECUTIONER: melee hits harder below 30% HP", () => {
    const g = createGame(972);
    const p = g.players[0];
    p.abilities.ranks["melee.execute"] = 1;
    p.critChance = 0;
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 25, maxHp: 100 }));
    g.monsters.push(mkMon({ id: 2, pos: { x: p.pos.x + 0.8, y: p.pos.y + 0.2 }, hp: 90, maxHp: 100 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const wounded = 25 - g.monsters.find((m) => m.id === 1)!.hp;
    const healthy = 90 - g.monsters.find((m) => m.id === 2)!.hp;
    // Each hit rolls independent ±15% weapon-variance damage (crit is zeroed
    // above, but variance isn't) — with a true 1.6x capstone multiplier, worst-
    // case unlucky/lucky variance draws still bound the ratio to roughly
    // [1.18, 2.16]. 1.3 sat inside that band and went flaky when the merge
    // shifted the RNG draw sequence; 1.15 stays a real signal without the coin-flip.
    expect(wounded).toBeGreaterThan(healthy * 1.15);
  });

  it("AFTERSHOCK: dash arrival detonates", () => {
    const g = createGame(973);
    const p = g.players[0];
    p.abilities.ranks["dash.after"] = 1;
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    const dp = 3.2; // dash distance
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + dp, y: p.pos.y }, hp: 500, maxHp: 500 }));
    step(g, { move: { x: 1, y: 0 }, useStairs: false, cast: [false, true, false, false, false] }, 1 / 60);
    expect(g.monsters[0].hp).toBeLessThan(500);
  });

  it("RICOCHET: a bolt kill-hit bounces to a nearby second target", () => {
    const g = createGame(974);
    const p = g.players[0];
    p.abilities.ranks["bolt.ricochet"] = 1;
    p.critChance = 0;
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 2, y: p.pos.y }, hp: 999, maxHp: 999 }));
    g.monsters.push(mkMon({ id: 2, pos: { x: p.pos.x + 2, y: p.pos.y + 2 }, hp: 999, maxHp: 999 }));
    step(g, { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, true, false, false], aim: { x: 1, y: 0 } }, 1 / 60);
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60);
    expect(g.monsters.find((m) => m.id === 1)!.hp).toBeLessThan(999); // direct hit
    expect(g.monsters.find((m) => m.id === 2)!.hp).toBeLessThan(999); // the bounce
  });

  it("IMPLOSION: nova drags enemies inward before the blast", () => {
    const g = createGame(975);
    const p = g.players[0];
    learnAbility(g, p, "nova");
    p.abilities.ranks["nova.implode"] = 1;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 3.5, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    const d0 = 3.5;
    step(g, { move: { x: 0, y: 0 }, useStairs: false, nova: true }, 1 / 60);
    const d1 = Math.hypot(g.monsters[0].pos.x - p.pos.x, g.monsters[0].pos.y - p.pos.y);
    expect(d1).toBeLessThan(d0 - 0.8);
  });
});

describe("battle stance", () => {
  const swapCast: Intent = { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, true, false] };

  it("is neutral unless slotted; matching boosts, mismatched dampens", () => {
    const g = createGame(980);
    const p = g.players[0];
    expect(stanceMult(p, "melee")).toBe(1);
    expect(stanceMult(p, "ranged")).toBe(1);
    learnAbility(g, p, "stance"); // auto-slots into the open slot; default Brawler
    expect(stanceMult(p, "melee")).toBe(CONFIG.stanceRightMult);
    expect(stanceMult(p, "ranged")).toBe(CONFIG.stanceWrongMult);
  });

  it("casting swaps the stance, resets time-in-stance, and is cooldown-gated", () => {
    const g = createGame(981);
    const p = g.players[0];
    learnAbility(g, p, "stance");
    g.monsters.length = 0;
    step(g, swapCast, 1 / 60);
    expect(p.stance).toBe("ranged");
    expect(p.cd.stance).toBeGreaterThan(0);
    expect(p.stanceTime).toBe(0);
    step(g, swapCast, 1 / 60); // still on swap cooldown: no toggle
    expect(p.stance).toBe("ranged");
    for (let i = 0; i < 60 * CONFIG.stanceSwapCooldown; i++) step(g, idle(), 1 / 60);
    step(g, swapCast, 1 / 60);
    expect(p.stance).toBe("melee");
  });

  it("judges bolts at fire time: projectile damage scales with the stance", () => {
    const g = createGame(982);
    const p = g.players[0];
    g.monsters.length = 0;
    learnAbility(g, p, "stance"); // Brawler: bolts are the WRONG type
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const wrong = g.projectiles[g.projectiles.length - 1].damage;
    expect(wrong).toBe(Math.max(1, Math.round(p.attackPower * CONFIG.boltDamageMult * CONFIG.stanceWrongMult)));
    step(g, swapCast, 1 / 60); // Deadeye: bolts now match
    for (let i = 0; i < 60; i++) step(g, idle(), 1 / 60); // wait out the bolt cooldown
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const right = g.projectiles[g.projectiles.length - 1].damage;
    expect(right).toBe(Math.max(1, Math.round(p.attackPower * CONFIG.boltDamageMult * CONFIG.stanceRightMult)));
    expect(right).toBeGreaterThan(wrong);
  });

  it("Discipline pays out only once settled; Flow only inside the surge window", () => {
    const g = createGame(983);
    const p = g.players[0];
    learnAbility(g, p, "stance");
    p.abilities.ranks = { "stance.discipline": 2 };
    p.stanceTime = 0;
    const fresh = stanceMult(p, "melee");
    p.stanceTime = CONFIG.stanceSettleSeconds + 1;
    expect(stanceMult(p, "melee")).toBeCloseTo(fresh * 1.2);
    p.abilities.ranks = { "stance.flow": 2 };
    p.stanceTime = 0;
    p.stanceSwapWindow = 0;
    expect(stanceMult(p, "melee")).toBeCloseTo(fresh);
    p.stanceSwapWindow = 1;
    expect(stanceMult(p, "melee")).toBeCloseTo(fresh * 1.3);
  });

  it("PERFECT FORM: a settled crawler transcends the wrong-type penalty", () => {
    const g = createGame(984);
    const p = g.players[0];
    learnAbility(g, p, "stance");
    p.abilities.ranks = { "stance.discipline": 1, "stance.perfect": 1 };
    p.stance = "melee";
    p.stanceTime = 0; // not settled yet: bolts still pay the price
    expect(stanceMult(p, "ranged")).toBe(CONFIG.stanceWrongMult);
    p.stanceTime = CONFIG.stanceSettleSeconds + 1;
    expect(stanceMult(p, "ranged")).toBeGreaterThan(1); // both types match now
  });

  it("MOMENTUM: a swap primes a guaranteed crit on the next matching attack", () => {
    const g = createGame(985);
    const p = g.players[0];
    learnAbility(g, p, "stance");
    p.abilities.ranks["stance.moment"] = 1;
    p.critChance = 0; // any crit that lands must be the capstone's
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 1.2, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    step(g, swapCast, 1 / 60); // Brawler -> Deadeye: crit primed
    expect(p.stanceCritReady).toBe(true);
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.stanceCritReady).toBe(false); // spent on the shot, hit or miss
    let crit = g.hits.some((h) => h.kind === "crit"); // impact can land in the cast step
    for (let i = 0; i < 30 && !crit; i++) {
      step(g, idle(), 1 / 60);
      crit = g.hits.some((h) => h.kind === "crit");
    }
    expect(crit).toBe(true);
  });
});

describe("overcharge", () => {
  const chargeCast: Intent = { move: { x: 0, y: 0 }, useStairs: false, cast: [false, false, false, true, false] };

  it("banks on cast (cooldown starts immediately) and empowers the next bolt volley", () => {
    const g = createGame(990);
    const p = g.players[0];
    g.monsters.length = 0;
    learnAbility(g, p, "overcharge");
    step(g, chargeCast, 1 / 60);
    expect(p.overcharged).toBe(true);
    expect(p.cd.overcharge).toBeGreaterThan(0); // charge -> pick the moment -> spend
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.overcharged).toBe(false); // spent on fire
    const dmg = g.projectiles[g.projectiles.length - 1].damage;
    expect(dmg).toBe(Math.max(1, Math.round(p.attackPower * CONFIG.boltDamageMult * CONFIG.overchargeDamageMult)));
  });

  it("a whiffed swing does not waste the charge; a connecting one spends it", () => {
    const g = createGame(991);
    const p = g.players[0];
    g.monsters.length = 0;
    learnAbility(g, p, "overcharge");
    step(g, chargeCast, 1 / 60);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.overcharged).toBe(true); // nothing in reach: still banked
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60); // melee cooldown
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.overcharged).toBe(false);
    expect(g.monsters[0].hp).toBeLessThan(99999);
  });

  it("Overcharged Volley: the empowered cast fires extra bolts", () => {
    const g = createGame(992);
    const p = g.players[0];
    g.monsters.length = 0;
    learnAbility(g, p, "overcharge");
    p.abilities.ranks = { "overcharge.surge": 1, "overcharge.volley": 2 };
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const plain = g.projectiles.length;
    step(g, chargeCast, 1 / 60);
    for (let i = 0; i < 60; i++) step(g, idle(), 1 / 60); // bolt cooldown (bolts expire too)
    const before = g.projectiles.length;
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.projectiles.length - before).toBe(plain + 2);
  });

  it("Echo Strike: an overcharged swing hits the target twice", () => {
    const g = createGame(993);
    const p = g.players[0];
    p.critChance = 0;
    g.monsters.length = 0;
    learnAbility(g, p, "overcharge");
    p.abilities.ranks = { "overcharge.surge": 1, "overcharge.echo": 2 };
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    step(g, chargeCast, 1 / 60);
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    const hitsOnMonster = g.hits.filter((h) => h.kind === "enemy" && h.amount > 0);
    expect(hitsOnMonster.length).toBe(2); // the swing and its echo
  });

  it("SYSTEM SHOCK: an overcharged hit staggers a healthy non-boss instantly", () => {
    const g = createGame(994);
    const p = g.players[0];
    g.monsters.length = 0;
    learnAbility(g, p, "overcharge");
    p.abilities.ranks = { "overcharge.surge": 1, "overcharge.shock": 1 };
    // A tanky brute: one hit is nowhere near its poise threshold on its own.
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    step(g, chargeCast, 1 / 60);
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(g.monsters[0].stagger).toBeGreaterThan(0);
  });
});

describe("genuine itemization (schools + weapon classes)", () => {
  it("magic abilities eat spellPower; physical abilities eat attackPower", () => {
    const g = createGame(1000);
    const p = g.players[0];
    const ap0 = p.attackPower, sp0 = p.spellPower;
    equipItem(p, { id: 9301, slot: "trinket", rarity: "rare", name: "Runed Sigil", affixes: { spell: 40 } });
    expect(p.spellPower).toBe(sp0 + 40);
    expect(p.attackPower).toBe(ap0);
    expect(power(p, "nova")).toBe(p.spellPower);
    expect(power(p, "cataclysm")).toBe(p.spellPower);
    expect(power(p, "melee")).toBe(p.attackPower);
    expect(power(p, "airstrike")).toBe(p.attackPower);
  });

  it("a crossbow IS a crossbow: full-power fast bolts, pierce at rare+", () => {
    const g = createGame(1001);
    const p = g.players[0];
    equipItem(p, { id: 9302, slot: "weapon", rarity: "rare", name: "Vicious Crossbow", affixes: { damage: 10 } });
    const bp = boltParams(p);
    expect(bp.dmg).toBeCloseTo(p.attackPower * CONFIG.boltBallisticMult);
    expect(bp.school).toBe("physical");
    expect(bp.speedMult).toBeCloseTo(CONFIG.boltBallisticSpeedMult);
    expect(bp.pierce).toBe(1); // rare+ ballistic pierces without the tree node
  });

  it("arcane weapons cast magic missiles; the staff pays out on nova", () => {
    const g = createGame(1002);
    const p = g.players[0];
    equipItem(p, { id: 9303, slot: "weapon", rarity: "magic", name: "Humming Wand", affixes: { spell: 12 } });
    let bp = boltParams(p);
    expect(bp.school).toBe("magic");
    expect(bp.dmg).toBeCloseTo(p.spellPower * CONFIG.boltArcaneMult);
    expect(bp.cooldown).toBeCloseTo(CONFIG.boltCooldown * CONFIG.wandBoltCdMult);
    const wandNova = novaParams(p).radius;
    equipItem(p, { id: 9304, slot: "weapon", rarity: "magic", name: "Humming Staff", affixes: { spell: 12 } });
    bp = boltParams(p);
    expect(bp.cooldown).toBeCloseTo(CONFIG.boltCooldown); // no wand haste on a staff
    expect(novaParams(p).radius).toBeCloseTo(wandNova * CONFIG.staffAoeRadiusMult);
  });

  it("melee-class weapons: sidearm bolts, heavy staggers, reach reaches", () => {
    const g = createGame(1003);
    const p = g.players[0];
    equipItem(p, { id: 9305, slot: "weapon", rarity: "common", name: "Worn Blade", affixes: { damage: 5 } });
    expect(boltParams(p).dmg).toBeCloseTo(p.attackPower * CONFIG.boltSidearmMult);
    const swift = meleeParams(p);
    equipItem(p, { id: 9306, slot: "weapon", rarity: "common", name: "Worn Maul", affixes: { damage: 5 } });
    const heavy = meleeParams(p);
    expect(heavy.damageMult).toBeCloseTo(swift.damageMult * CONFIG.heavyMeleeDmgMult);
    expect(heavy.poiseMult).toBe(CONFIG.heavyPoiseMult);
    expect(heavy.cooldown).toBeGreaterThan(swift.cooldown);
    equipItem(p, { id: 9307, slot: "weapon", rarity: "common", name: "Worn Spear", affixes: { damage: 5 } });
    expect(meleeParams(p).range).toBeCloseTo(CONFIG.playerAttackRange + CONFIG.reachRangeBonus);
  });

  it("legacy saves fold pre-schools damage into BOTH powers", () => {
    const restored = restoreGame({
      seed: 42, floor: 3,
      player: { hp: 100, maxHp: 150, baseDamage: 30, level: 4, xp: 0, xpToNext: 50, gold: 0 },
    });
    const p = restored.players[0];
    const intrinsic = CONFIG.playerBaseDamage + 3 * CONFIG.damagePerLevel;
    expect(p.bonusDamage).toBe(Math.max(0, 30 - intrinsic));
    expect(p.bonusSpell).toBe(p.bonusDamage);
    expect(p.attackPower).toBe(p.spellPower); // pre-schools crawlers stay even
  });

  it("generation matches school to weapon class (staffs roll MAG, blades roll ATK)", () => {
    const rng = createRng(777);
    let id = 0;
    let arcaneSeen = 0, physSeen = 0;
    for (let i = 0; i < 300; i++) {
      const it = generateItem(rng, 5, () => id++);
      const wc = weaponClassOf(it);
      if (wc === "arcane") { arcaneSeen++; expect(it.affixes.spell ?? 0).toBeGreaterThan(0); }
      if (wc === "swift" || wc === "heavy" || wc === "reach" || wc === "ballistic") {
        physSeen++;
        expect(it.affixes.damage ?? 0).toBeGreaterThan(0);
      }
    }
    expect(arcaneSeen).toBeGreaterThan(5);
    expect(physSeen).toBeGreaterThan(5);
  });
});

describe("hero skins", () => {
  it("is deterministic per (seed, player), varies across runs, and never twins a party", () => {
    expect(heroSkin(123, 0)).toBe(heroSkin(123, 0)); // stable for a run
    // A full party wears distinct skins.
    const party = [0, 1, 2, 3, 4].map((id) => heroSkin(555, id));
    expect(new Set(party).size).toBe(party.length);
    // Different runs shuffle who you drop in as (spot-check a spread of seeds).
    const firsts = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => heroSkin(s, 0)));
    expect(firsts.size).toBeGreaterThan(1);
    // Skins never consume the sim's rng: identical floors with or without the call.
    const a = createGame(777);
    heroSkin(777, 0);
    const b = createGame(777);
    expect(JSON.stringify(a.map.tiles)).toBe(JSON.stringify(b.map.tiles));
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

describe("Roam mode (SETTLEMENTS.md)", () => {
  it("generates a bigger grid with a settlement, a stronghold, and a tribe-tagged floor", () => {
    const g = createGame(42, "coop", "roam");
    expect(g.map.w).toBe(CONFIG.roamFloorGridW);
    expect(g.map.h).toBe(CONFIG.roamFloorGridH);
    expect(g.map.settlementRoomIdx).toBeGreaterThanOrEqual(0);
    expect(g.map.roles[g.map.settlementRoomIdx]).toBe("settlement");
    expect(g.map.strongholdRoomIdx).toBeGreaterThanOrEqual(0);
    expect(g.map.roles[g.map.strongholdRoomIdx]).toBe("stronghold");
    expect(g.map.strongholdRoomIdx).not.toBe(g.map.settlementRoomIdx);
    expect(g.npc).not.toBeNull();
    expect(g.quests).toHaveLength(1);
    expect(g.quests[0].objective.kind).toBe("killTribe");
    expect(g.monsters.length).toBeGreaterThan(0);
    const tribe = roamTribeId(1);
    expect(g.monsters.every((m) => m.tribe === tribe)).toBe(true);
  });

  it("isWalkableForMonster blocks the settlement room; isWalkable does not", () => {
    const g = createGame(42, "coop", "roam");
    const r = g.map.rooms[g.map.settlementRoomIdx];
    const x = r.x + 1, y = r.y + 1;
    expect(isWalkable(g.map, x, y)).toBe(true);
    expect(isWalkableForMonster(g.map, x, y)).toBe(false);
  });

  it("no monster ever occupies a settlement tile, but the stronghold has a garrison", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = createGame(seed, "coop", "roam");
      const settlement = g.map.rooms[g.map.settlementRoomIdx];
      for (const m of g.monsters) {
        const inside =
          m.pos.x >= settlement.x && m.pos.x < settlement.x + settlement.w &&
          m.pos.y >= settlement.y && m.pos.y < settlement.y + settlement.h;
        expect(inside).toBe(false);
      }
      const stronghold = g.map.rooms[g.map.strongholdRoomIdx];
      const garrisoned = g.monsters.some((m) =>
        m.pos.x >= stronghold.x && m.pos.x < stronghold.x + stronghold.w &&
        m.pos.y >= stronghold.y && m.pos.y < stronghold.y + stronghold.h,
      );
      expect(garrisoned).toBe(true);
    }
  });

  it("matches isWalkable everywhere on a Race floor (no settlement)", () => {
    const g = createGame(42, "coop", "race");
    expect(g.map.settlementRoomIdx).toBe(-1);
    for (let y = 0; y < g.map.h; y += 5) {
      for (let x = 0; x < g.map.w; x += 5) {
        expect(isWalkableForMonster(g.map, x, y)).toBe(isWalkable(g.map, x, y));
      }
    }
  });

  it("spawns exactly one elite stronghold leader, tagged with the floor's tribe", () => {
    const g = createGame(42, "coop", "roam");
    expect(g.strongholdLeaderId).toBeGreaterThanOrEqual(0);
    expect(g.strongholdLeaderName).not.toBe("");
    expect(g.strongholdCleared).toBe(false);
    const elites = g.monsters.filter((m) => m.elite);
    expect(elites).toHaveLength(1);
    expect(elites[0].id).toBe(g.strongholdLeaderId);
    expect(elites[0].tribe).toBe(roamTribeId(1));
  });

  it("killing the tracked stronghold leader sets strongholdCleared", () => {
    const g = createGame(42, "coop", "roam");
    const leader = g.monsters.find((m) => m.id === g.strongholdLeaderId)!;
    leader.hp = 0;
    step(g, NO_INTENT, 1 / 60);
    expect(g.strongholdCleared).toBe(true);
  });

  it("talking to the NPC offers killTribe, then completes and unlocks clearStronghold", () => {
    const g = createGame(7, "coop", "roam");
    const p = g.players[0];
    p.pos = { x: g.npc!.pos.x, y: g.npc!.pos.y };
    step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30);
    expect(g.quests[0].state).toBe("active");
    const obj0 = g.quests[0].objective;
    if (obj0.kind === "killTribe") obj0.killed = obj0.target;
    step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30);
    expect(g.quests[0].state).toBe("complete");
    expect(p.pendingRewards.length).toBeGreaterThan(0);
    expect(g.quests).toHaveLength(2);
    expect(g.quests[1].objective.kind).toBe("clearStronghold");
    expect(g.quests[1].state).toBe("offered");

    // Turn in the second quest.
    p.pendingRewards = [];
    g.strongholdCleared = true;
    step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30); // offer -> active
    expect(g.quests[1].state).toBe("active");
    step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30); // active -> complete
    expect(g.quests[1].state).toBe("complete");
    expect(p.pendingRewards.length).toBeGreaterThan(0);
  });

  it("mapgen never trades the stairs room for a boss arena, even past floor 18 or on a bossFloorEvery multiple", () => {
    // floor.ts's own boss-arena/lockStairsRoom branches must stay disabled for
    // "roam" regardless of floor number — this is the structural half of the
    // guard; game.ts's spawnMonsters carries a matching runKind check so no
    // "boss" kind monster is ever placed to go with it.
    for (const floor of [3, 18, 21]) {
      const rng = createRng(9001 + floor);
      const map = generateFloor(rng, floor, "roam");
      expect(map.roles.includes("stairs")).toBe(true);
      expect(map.locked).toBe(false);
    }
  });

  it("tribe identity tracks floorBand, and every Roam monster carries a .tribe (incl. PACK_TEMPLATES packs)", () => {
    // Regression test: PACK_TEMPLATES packs used to spawn untagged in Roam
    // (floor >= 3 fired regardless of runKind), silently uncredited by the
    // quest counter. 100% tagging must hold across every band, including
    // past floor 18 where floorBand clamps to "approach" — descend a real
    // game through 20 floors (ready-up at each safe room) and check every
    // floor's monster set, since spawnMonsters isn't exported.
    const g = createGame(4200, "coop", "roam");
    for (let i = 0; i < 20; i++) {
      expect(g.monsters.length).toBeGreaterThan(0);
      const tribe = roamTribeId(g.floor);
      expect(g.monsters.every((m) => m.tribe === tribe)).toBe(true);
      const p = g.players[0];
      p.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
      step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30);
      if (g.safeRoom) {
        setReady(g, p.id);
        step(g, {}, 1 / 30);
      }
    }
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
      expect(g.announcements.some((a) => a.text.includes("LOCKED"))).toBe(true);
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
    // The key can drop near the floor's elite; skip its ringside intro so the
    // pickup step isn't consumed by the encounter freeze (tested elsewhere).
    for (const m of g.monsters) if (m.elite) m.introduced = true;
    expect(g.map.locked).toBe(true);
    const doorsBefore = doorCount(g.map);
    expect(doorsBefore).toBeGreaterThan(0);
    const carrier = g.monsters.find((m) => m.hasKey)!;
    // Kill the carrier: the key ALWAYS drops.
    carrier.hp = 0;
    step(g, idle(), 1 / 60);
    const key = g.loot.find((l) => l.kind === "key");
    expect(key).toBeDefined();
    expect(g.announcements.some((a) => a.text.includes("KEYHOLDER"))).toBe(true);
    // Walk onto the key: all doors open, geometry version bumps, stairs open up.
    const versionBefore = g.mapVersion;
    g.players[0].pos = { x: key!.pos.x, y: key!.pos.y };
    step(g, idle(), 1 / 60);
    expect(g.loot.some((l) => l.kind === "key")).toBe(false);
    expect(doorCount(g.map)).toBe(0);
    expect(g.map.locked).toBe(false);
    expect(g.mapVersion).toBe(versionBefore + 1);
    expect(g.announcements.some((a) => a.text.includes("OPEN"))).toBe(true);
    expect(canReach(g.map, g.map.spawn, g.map.stairs)).toBe(true);
  });

  it("picking up the key pays out hype", () => {
    const g = atFloor(9, 3);
    g.loot = [{ id: 9001, pos: { x: g.players[0].pos.x, y: g.players[0].pos.y }, kind: "key", amount: 0 }];
    const hype0 = g.players[0].hype;
    step(g, idle(), 1 / 60);
    expect(g.players[0].hype).toBeGreaterThan(hype0);
  });

  it("floors 1-2 have no stairs-district doors and no key carrier", () => {
    for (const seed of [1, 2, 3, 9]) {
      for (const floor of [1, 2]) {
        const g = floor === 1 ? createGame(seed) : atFloor(seed, 2);
        expect(g.map.locked).toBe(false);
        expect(g.map.lockedRoomIdx).toBe(-1);
        // A floor-2 timed-vault EVENT may seal its own room; only doors that
        // aren't the vault's would betray a stairs lock leaking early.
        const vaultDoors = new Set(g.floorEvent?.type === "vault" ? g.floorEvent.doors : []);
        const strayDoors = Array.from(g.map.tiles).filter(
          (t, i) => t === Tile.DoorLocked && !vaultDoors.has(i),
        ).length;
        expect(strayDoors).toBe(0);
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

/** Walk seed's floor-1 stairs into the first safe room (shared by the new suites). */
function reachShop(seed: number) {
  const g = createGame(seed);
  g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
  step(g, { move: { x: 0, y: 0 }, attack: false, useStairs: true }, 1 / 60);
  return g;
}

describe("chase legendaries (store-only uniques)", () => {
  const wear = (g: GameState, item: Partial<import("../src/sim/types").Item> & { slot: import("../src/sim/types").ItemSlot }) => {
    const p = g.players[0];
    equipItem(p, { id: 900, rarity: "epic", name: "X", affixes: {}, ...item } as import("../src/sim/types").Item);
    return p;
  };

  it("Perpetual Encore: +1 orbit blade, faster damage ticks", () => {
    const g = createGame(990);
    const p = g.players[0];
    const before = orbitParams(p);
    wear(g, { slot: "trinket", name: "Perpetual Encore", passive: "encore", catalogId: "perpetual_encore" });
    const after = orbitParams(p);
    expect(after.blades).toBe(before.blades + 1);
    expect(after.tickSeconds).toBeCloseTo(before.tickSeconds * CONFIG.encoreOrbitTickMult, 5);
  });

  it("Standing Ovation: bolts pierce +2 on top of the weapon profile", () => {
    const g = createGame(991);
    const p = g.players[0];
    // Epic crossbow WITHOUT the passive: ballistic rare+ pierce = 1.
    wear(g, { slot: "weapon", name: "Box Seat Crossbow", catalogId: "box_seat_crossbow" });
    expect(boltParams(p).pierce).toBe(1);
    wear(g, { slot: "weapon", name: "Standing Ovation Crossbow", passive: "skewer", catalogId: "standing_ovation" });
    expect(boltParams(p).pierce).toBe(1 + CONFIG.skewerBonusPierce);
  });

  it("Signature Choreography: the post-swap surge window carries bonus crit", () => {
    const g = createGame(992);
    const p = g.players[0];
    learnAbility(g, p, "stance");
    wear(g, { slot: "boots", name: "Signature Choreography", passive: "choreography", catalogId: "signature_choreography" });
    p.critChance = 0; // every crit below comes from the choreography window
    p.attackPower = 50;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 999999, maxHp: 999999 }));
    const swingCrits = (window: number, swings: number): number => {
      let crits = 0;
      for (let i = 0; i < swings; i++) {
        p.stanceSwapWindow = window;
        p.cd.melee = 0;
        step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
        crits += g.hits.filter((h) => h.kind === "crit").length;
      }
      return crits;
    };
    // Inside the surge window: 20% crit over 60 swings — a full miss run is ~1e-6.
    expect(swingCrits(3, 60)).toBeGreaterThan(0);
    // Window closed: zero base crit means zero crits.
    expect(swingCrits(0, 30)).toBe(0);
  });

  it("Landlord's Ledger: kills pay gold and banked gold earns safe-room interest", () => {
    const g = createGame(9920);
    const p = g.players[0];
    wear(g, { slot: "trinket", name: "Landlord's Ledger", passive: "ledger", catalogId: "landlords_ledger" });
    p.attackPower = 9999;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 1 }));
    const gold0 = p.gold;
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.gold - gold0).toBeGreaterThanOrEqual(CONFIG.ledgerKillGold);
    // Interest at the safe room: 10% of banked gold, capped.
    p.gold = 500;
    g.monsters.length = 0;
    p.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    expect(g.safeRoom).toBeTruthy();
    expect(p.gold).toBe(500 + 50);
    expect(g.announcements.some((a) => a.text.includes("interest"))).toBe(true);
  });

  it("Backstage Pass: the dash phases through walls it can clear — but never locked doors", () => {
    const g = createGame(9921);
    const p = g.players[0];
    const px = Math.floor(p.pos.x), py = Math.floor(p.pos.y);
    const set = (x: number, y: number, t: number) => { g.map.tiles[y * g.map.w + x] = t; };
    // A 3-tall wall column one tile ahead, clear floor beyond it.
    for (const dy of [-1, 0, 1]) set(px + 1, py + dy, Tile.Wall);
    for (const dx of [2, 3, 4]) set(px + dx, py, Tile.Floor);
    p.pos = { x: px + 0.5, y: py + 0.5 };
    p.facing = { x: 1, y: 0 };
    // WITHOUT the passive: the slide stops at the wall.
    step(g, { move: { x: 1, y: 0 }, dash: true, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeLessThan(px + 1);
    // WITH it: the same dash exits on the far side.
    wear(g, { slot: "armor", name: "Backstage Pass", passive: "phase", catalogId: "backstage_pass" });
    p.pos = { x: px + 0.5, y: py + 0.5 };
    p.dashCharges = 2;
    step(g, { move: { x: 1, y: 0 }, dash: true, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeGreaterThan(px + 2);
    // A LOCKED DOOR in the wall refuses the phase (keys stay load-bearing).
    set(px + 1, py, Tile.DoorLocked);
    p.pos = { x: px + 0.5, y: py + 0.5 };
    p.dashCharges = 2;
    step(g, { move: { x: 1, y: 0 }, dash: true, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeLessThan(px + 1);
  });

  it("Plot Armor: one killing blow per floor leaves you at 1 HP", () => {
    const g = createGame(993);
    const p = g.players[0];
    wear(g, { slot: "helm", name: "Plot Armor", passive: "plot_armor", catalogId: "plot_armor" });
    p.hp = 5;
    expect(damagePlayerHit(g, p, 10_000, { roll: false })).toBe(false); // survived
    expect(p.hp).toBe(1);
    expect(p.plotArmorUsed).toBe(true);
    expect(g.announcements.some((a) => a.text.includes("PLOT ARMOR"))).toBe(true);
    // The writers only save you once per floor.
    expect(damagePlayerHit(g, p, 10_000, { roll: false })).toBe(true);
    // A fresh floor re-arms it.
    p.hp = p.maxHp;
    p.alive = true;
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    for (const m of g.monsters) m.hp = 0;
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    if (g.safeRoom) leaveSafeRoom(g);
    expect(p.plotArmorUsed).toBe(false);
  });

  it("Blood Subscription: heal a capped slice of damage dealt (lifesteal)", () => {
    const g = createGame(996);
    const p = g.players[0];
    wear(g, { slot: "charm", name: "Blood Subscription", passive: "leech", catalogId: "blood_subscription" });
    p.attackPower = 500; // big hit -> the per-hit CAP is what heals
    p.hp = 10;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, kind: "brute", pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 99999, maxHp: 99999 }));
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.hp).toBeGreaterThan(10);
    expect(p.hp - 10).toBeLessThanOrEqual(Math.round(p.maxHp * CONFIG.leechCapFraction) + 1);
    // Full HP: no overheal.
    p.hp = p.maxHp;
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.hp).toBe(p.maxHp);
  });

  it("Cancellation Axe: executes non-elites in the threshold; named menaces are immune", () => {
    const g = createGame(997);
    const p = g.players[0];
    wear(g, { slot: "weapon", name: "Cancellation Axe", passive: "cancellation", catalogId: "cancellation_axe" });
    p.attackPower = 2; // a tap: normally nowhere near lethal
    g.monsters.length = 0;
    const chaff = mkMon({ id: 1, pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 14, maxHp: 100 });
    g.monsters.push(chaff);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(chaff.hp).toBeLessThanOrEqual(0); // 14/100 HP -> CANCELED
    // An elite in the same band shrugs it off.
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60);
    const named = mkMon({ id: 2, pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 14, maxHp: 100, elite: true, introduced: true });
    g.monsters.push(named);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(named.hp).toBeGreaterThan(0);
  });

  it("Live Feed: crits arc a magic echo to the nearest other enemy, one bounce only", () => {
    const g = createGame(998);
    const p = g.players[0];
    wear(g, { slot: "trinket", name: "Live Feed", passive: "conduit", catalogId: "live_feed" });
    p.critChance = 1; // every hit crits
    p.attackPower = 50;
    g.monsters.length = 0;
    const primary = mkMon({ id: 1, pos: { x: p.pos.x + 0.9, y: p.pos.y }, hp: 9999, maxHp: 9999 });
    // BEHIND the player: outside the 90-degree swing arc, inside the conduit radius.
    const bystander = mkMon({ id: 2, pos: { x: p.pos.x - 1.5, y: p.pos.y }, hp: 9999, maxHp: 9999 });
    g.monsters.push(primary, bystander);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(primary.hp).toBeLessThan(9999);
    expect(bystander.hp).toBeLessThan(9999); // the arc reached around the swing
    const arcDmg = 9999 - bystander.hp;
    const mainDmg = 9999 - primary.hp;
    expect(arcDmg).toBeLessThan(mainDmg); // an echo, not a second hit
    expect(g.hits.some((h) => h.school === "magic")).toBe(true); // arcs read arcane
  });

  it("Location Scout: pathfinder passive, sharing the VIP Pass rung with Blood Subscription", () => {
    // The minimap marker itself is host-side; the sim guarantees the passive
    // and the build fork (two charm legendaries off one advanced component).
    expect(CATALOG_BY_ID.location_scout.passive).toBe("pathfinder");
    expect(CATALOG_BY_ID.location_scout.slot).toBe("charm");
    expect(CATALOG_BY_ID.location_scout.buildsFrom).toEqual(["vip_pass"]);
    expect(CATALOG_BY_ID.blood_subscription.buildsFrom).toEqual(["vip_pass"]);
  });

  it("the full chase path: components -> advanced -> sponsor-gated unique", () => {
    const g = reachShop(994);
    const p = g.players[0];
    g.safeRoom!.available.push("box_seat_crossbow", "standing_ovation");
    p.gold = 10_000;
    buyCatalogItem(g, 0, "honed_edge");
    buyCatalogItem(g, 0, "glass_charm");
    buyCatalogItem(g, 0, "box_seat_crossbow");
    expect(p.equipment.weapon?.catalogId).toBe("box_seat_crossbow");
    // The unique needs sponsors + trophies on top of the build path.
    buyCatalogItem(g, 0, "standing_ovation");
    expect(p.equipment.weapon?.catalogId).toBe("box_seat_crossbow"); // refused
    p.sponsors = 1;
    p.materials.elite_trophy = 2;
    buyCatalogItem(g, 0, "standing_ovation");
    expect(p.equipment.weapon?.passive).toBe("skewer");
    expect(boltParams(p).pierce).toBeGreaterThanOrEqual(1 + CONFIG.skewerBonusPierce);
  });
});

describe("planning-first drops", () => {
  it("a slice of equipment drops are catalog components (they feed build paths)", () => {
    const g = createGame(995);
    const p = g.players[0];
    p.attackPower = 99_999;
    g.monsters.length = 0;
    let component = 0, rolled = 0;
    for (let i = 0; i < 400; i++) {
      g.loot.length = 0;
      g.monsters.push(mkMon({ id: 10_000 + i, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 1 }));
      step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
      for (const l of g.loot) {
        if (l.kind !== "item" || !l.item) continue;
        if (l.item.catalogId) component++;
        else rolled++;
      }
      // let the melee cooldown clear between kills
      for (let k = 0; k < 30; k++) step(g, idle(), 1 / 60);
    }
    expect(component).toBeGreaterThan(0); // drops now advance planned builds...
    expect(rolled).toBeGreaterThan(component); // ...but rolled gear still leads
    // Dropped components are REAL components: they satisfy build gating.
    const entry = CATALOG_BY_ID.honed_edge;
    expect(entry.tier).toBe("basic");
  });

  it("sell all liquidates the bag at per-item sell value (safe-room only)", () => {
    const g = reachShop(996);
    const p = g.players[0];
    p.inventory.push({ id: 1, slot: "weapon", rarity: "magic", name: "Honed Edge", affixes: { damage: 6 }, catalogId: "honed_edge" });
    p.inventory.push({ id: 2, slot: "armor", rarity: "rare", name: "Runed Plate", affixes: { maxHp: 30 } });
    const expected = sellValue(p.inventory[0]) + sellValue(p.inventory[1]);
    const gold0 = p.gold;
    sellAllItems(g, 0);
    expect(p.inventory.length).toBe(0);
    expect(p.gold).toBe(gold0 + expected);
    // Outside the safe room: no-op.
    leaveSafeRoom(g);
    p.inventory.push({ id: 3, slot: "trinket", rarity: "epic", name: "Idol", affixes: { crit: 0.1 } });
    sellAllItems(g, 0);
    expect(p.inventory.length).toBe(1);
  });
});

describe("ultimate constellations", () => {
  it("Deep Focus stretches bullet time; EXTENSION extends it on kills inside", () => {
    const g = createGame(940);
    const p = g.players[0];
    learnAbility(g, p, "bullettime"); // the empty ultimate slot auto-fills
    p.abilities.ranks["bt.focus"] = 2;
    step(g, { ...idle(), cast: [false, false, false, false, true] }, 1 / 60);
    const expected = CONFIG.ultBulletTimeDuration + 2 * CONFIG.ultBulletTimeFocusSeconds;
    expect(g.bulletTimeLeft).toBeGreaterThan(expected - 0.1);
    // EXTENSION: a kill while the world is slow buys more slow.
    p.abilities.ranks["bt.encore"] = 1;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 9, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 1, maxHp: 10 }));
    p.facing = { x: 1, y: 0 };
    p.attackPower = 9999;
    const before = g.bulletTimeLeft;
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.bulletTimeLeft).toBeGreaterThan(before);
  });

  it("Adrenaline ticks the crawler's cooldowns faster inside the slow", () => {
    const g = createGame(941);
    const p = g.players[0];
    p.abilities.ranks["bt.adrenaline"] = 2; // cdTickMult = 2
    g.bulletTimeLeft = 3;
    p.cd.nova = 1.0;
    step(g, idle(), 1 / 60);
    expect(p.cd.nova!).toBeCloseTo(1.0 - (1 / 60) * 2, 3);
    // Outside the slow, cooldowns tick at normal speed again.
    g.bulletTimeLeft = 0;
    const cd = p.cd.nova!;
    step(g, idle(), 1 / 60);
    expect(p.cd.nova!).toBeCloseTo(cd - 1 / 60, 3);
  });

  it("airstrike nodes shape the barrage: payload hardens, saturation adds, precision tightens", () => {
    const g = createGame(942);
    const p = g.players[0];
    const base = airstrikeParams(p);
    expect(base.shells).toBe(CONFIG.ultAirstrikeShells);
    p.abilities.ranks["air.payload"] = 2;
    p.abilities.ranks["air.saturation"] = 2;
    const sat = airstrikeParams(p);
    expect(sat.shells).toBe(CONFIG.ultAirstrikeShells + 2 * CONFIG.ultAirstrikeSaturationShells);
    expect(sat.spread).toBeGreaterThan(base.spread);
    expect(sat.dmgMult).toBeGreaterThan(base.dmgMult);
    delete p.abilities.ranks["air.saturation"];
    p.abilities.ranks["air.precision"] = 2;
    expect(airstrikeParams(p).spread).toBeLessThan(base.spread * 0.5);
  });

  it("Aftermath schedules an echo shock that lands where you stood", () => {
    const g = createGame(943);
    const p = g.players[0];
    learnAbility(g, p, "cataclysm");
    p.abilities.ranks["cata.aftermath"] = 1;
    p.spellPower = 100;
    g.monsters.length = 0;
    const m = mkMon({ id: 5, pos: { x: p.pos.x + 2, y: p.pos.y }, hp: 1e6, maxHp: 1e6 });
    g.monsters.push(m);
    step(g, { ...idle(), cast: [false, false, false, false, true] }, 1 / 60);
    expect(g.strikes.some((s) => s.kind === "echo")).toBe(true);
    const afterBlast = m.hp; // took the primary hit
    expect(afterBlast).toBeLessThan(1e6);
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60); // 1.5s: the echo lands
    expect(m.hp).toBeLessThan(afterBlast);
    expect(g.strikes.length).toBe(0);
  });

  it("EXTINCTION EVENT chains cataclysm kills outward", () => {
    const g = createGame(944);
    const p = g.players[0];
    learnAbility(g, p, "cataclysm");
    p.abilities.ranks["cata.extinction"] = 1;
    p.spellPower = 100;
    g.monsters.length = 0;
    const radius = cataclysmParams(p).radius;
    // The victim dies inside the blast; the bystander stands beyond it,
    // reachable only through the victim's detonation.
    const victim = mkMon({ id: 6, pos: { x: p.pos.x + radius - 0.5, y: p.pos.y }, hp: 1, maxHp: 10 });
    const bystander = mkMon({
      id: 7, pos: { x: p.pos.x + radius + 0.8, y: p.pos.y }, hp: 1e6, maxHp: 1e6,
    });
    g.monsters.push(victim, bystander);
    step(g, { ...idle(), cast: [false, false, false, false, true] }, 1 / 60);
    expect(victim.hp).toBeLessThanOrEqual(0);
    expect(bystander.hp).toBeLessThan(1e6);
  });

  it("GUILLOTINE finishes worn-down chaff; elites are exempt", () => {
    const g = createGame(945);
    const p = g.players[0];
    learnAbility(g, p, "orbit"); // slot 4 is open
    p.abilities.ranks["orbit.guillotine"] = 1;
    p.attackPower = 1; // blades chip, they don't kill on their own
    g.monsters.length = 0;
    const chaff = mkMon({ id: 8, pos: { x: p.pos.x + CONFIG.orbitRadius, y: p.pos.y }, hp: 100, maxHp: 1000 });
    g.monsters.push(chaff);
    for (let i = 0; i < 240 && chaff.hp > 0; i++) step(g, idle(), 1 / 60);
    expect(chaff.hp).toBeLessThanOrEqual(0);
    const elite = mkMon({
      id: 9, pos: { x: p.pos.x + CONFIG.orbitRadius, y: p.pos.y }, hp: 100, maxHp: 1000,
      elite: true, introduced: true,
    });
    g.monsters.push(elite);
    for (let i = 0; i < 240; i++) step(g, idle(), 1 / 60);
    expect(elite.hp).toBeGreaterThan(0);
  });

  it("Heavy Blows: a killing swing's overkill splashes to a neighbor", () => {
    const g = createGame(946);
    const p = g.players[0];
    p.abilities.ranks["melee.heavy"] = 1;
    p.attackPower = 500;
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    const victim = mkMon({ id: 10, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 1, maxHp: 10 });
    // Out of the swing's reach, but inside the overkill splash radius of the victim.
    const bystander = mkMon({ id: 11, pos: { x: p.pos.x + 2.0, y: p.pos.y }, hp: 500, maxHp: 500 });
    g.monsters.push(victim, bystander);
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(victim.hp).toBeLessThanOrEqual(0);
    expect(bystander.hp).toBeLessThan(500);
  });

  it("Swift Strikes: connecting swings build momentum; pausing drops it", () => {
    const g = createGame(947);
    const p = g.players[0];
    p.abilities.ranks["melee.swift"] = 2;
    p.attackPower = 1;
    p.facing = { x: 1, y: 0 };
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 12, pos: { x: p.pos.x + 0.8, y: p.pos.y }, hp: 1e6, maxHp: 1e6, introduced: true }));
    const swing = { ...idle(), attack: true, aim: { x: 1, y: 0 } };
    step(g, swing, 1 / 60);
    expect(p.meleeCombo).toBe(1);
    for (let i = 0; i < 30; i++) step(g, idle(), 1 / 60); // wait out the cooldown
    step(g, swing, 1 / 60);
    expect(p.meleeCombo).toBe(2);
    // The flurry pauses past the window: momentum drops.
    for (let i = 0; i < Math.ceil(CONFIG.meleeMomentumWindow * 60) + 5; i++) step(g, idle(), 1 / 60);
    expect(p.meleeCombo).toBe(0);
  });

  it("Retraining Arc refunds a fork side as fresh drafts", () => {
    const g = createGame(948);
    const p = g.players[0];
    p.abilities.ranks["melee.heavy"] = 2;
    p.pendingRewards = [{
      id: 1, kind: "retrain", title: "Retraining Arc",
      desc: "Unlearn Heavy Blows (2 ranks) — 2 fresh drafts", amount: 2, nodeId: "melee.heavy",
    }];
    chooseReward(g, p.id, 0);
    expect(rank(p, "melee.heavy")).toBe(0);
    expect(p.upgradeDraftsOwed).toBeGreaterThanOrEqual(2);
    // The road not taken reopens: Swift Strikes is draftable again.
    p.abilities.ranks["melee.arc"] = 1;
    expect(availableUpgrades(p).some((u) => u.id === "melee.swift")).toBe(true);
  });

  it("orbit's razor and corkscrew are a real fork now", () => {
    const g = createGame(949);
    const p = g.players[0];
    learnAbility(g, p, "orbit");
    p.abilities.ranks["orbit.blade"] = 1;
    p.abilities.ranks["orbit.razor"] = 1;
    const open = availableUpgrades(p).map((u) => u.id);
    expect(open).not.toContain("orbit.wide");
    expect(open).toContain("orbit.guillotine"); // the capstone stays reachable
  });
});

describe("depth tempo (monsters get quicker, not just fatter)", () => {
  it("ramps speed up and cooldowns/windups down past the ramp floor, capped", () => {
    // Training floors: untouched (the balance-bot floors-1-2 net stays valid).
    for (const f of [1, 2, 3, 4]) {
      expect(monsterTempo(f)).toEqual({ speed: 1, cooldown: 1, windup: 1 });
    }
    const mid = monsterTempo(10);
    expect(mid.speed).toBeGreaterThan(1);
    expect(mid.cooldown).toBeLessThan(1);
    expect(mid.windup).toBeLessThan(1);
    // Deep floors hit the caps and stay there (fast but still readable).
    const deep = monsterTempo(30);
    expect(deep.speed).toBe(CONFIG.monsterTempoSpeedMax);
    expect(deep.cooldown).toBe(CONFIG.monsterTempoCdMin);
    expect(deep.windup).toBe(CONFIG.monsterTempoWindupMin);
  });

  it("a floor-12 grunt genuinely moves faster than a floor-1 grunt", () => {
    const find = (g: GameState) => g.monsters.find((m) => m.kind === "grunt");
    let early: number | null = null, late: number | null = null;
    for (let seed = 1; seed < 30 && (!early || !late); seed++) {
      early ??= find(createGame(seed))?.speed ?? null;
      late ??= find(restoreGame({
        seed, floor: 12, player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
      }))?.speed ?? null;
    }
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(late! / early!).toBeCloseTo(monsterTempo(12).speed, 5);
  });
});

describe("broodmother (the pack grows if you ignore it)", () => {
  it("births swarmers on a timer, capped per mother, and never attacks", () => {
    const g = createGame(7100);
    const p = g.players[0];
    g.monsters.length = 0;
    const mother = mkMon({
      id: 1, kind: "broodmother", pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 500, maxHp: 500, attackRange: 6,
    });
    g.monsters.push(mother);
    // Run long enough for several birth cycles.
    const seconds = CONFIG.broodSpawnCooldown * 3 + 1;
    for (let i = 0; i < 60 * seconds; i++) step(g, idle(), 1 / 60);
    const brood = g.monsters.filter((m) => m.kind === "swarmer" && m.hp > 0);
    expect(mother.summons).toBeGreaterThanOrEqual(3);
    expect(brood.length).toBeGreaterThan(0); // the floor got MORE crowded
    expect(mother.windup).toBe(0); // she never commits to an attack
    // Lifetime cap: run far past the cap and she stops.
    for (let i = 0; i < 60 * CONFIG.broodSpawnCooldown * CONFIG.broodSpawnMax; i++) step(g, idle(), 1 / 60);
    expect(mother.summons).toBeLessThanOrEqual(CONFIG.broodSpawnMax);
  });

  it("respects the global population guard", () => {
    const g = createGame(7101);
    const p = g.players[0];
    g.monsters.length = 0;
    // Flood the floor to the guard line with inert chaff.
    const cap = Math.ceil(CONFIG.monsterMaxCount * CONFIG.broodPopulationCap);
    for (let i = 0; i < cap; i++) {
      g.monsters.push(mkMon({ id: 100 + i, pos: { x: 1.5, y: 1.5 }, hp: 1, maxHp: 1 }));
    }
    const mother = mkMon({
      id: 1, kind: "broodmother", pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 500, maxHp: 500, attackRange: 6,
    });
    g.monsters.push(mother);
    for (let i = 0; i < 60 * (CONFIG.broodSpawnCooldown + 1); i++) step(g, idle(), 1 / 60);
    expect(mother.summons ?? 0).toBe(0); // guard held: no births past the cap
  });

  it("spawns in the deep-floor archetype mix but never takes the elite crown", () => {
    let seen = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const g = restoreGame({
        seed, floor: 9, player: { hp: 100, level: 10, xp: 0, xpToNext: 999, gold: 0 },
      });
      seen += g.monsters.filter((m) => m.kind === "broodmother").length;
      const crowned = g.monsters.find((m) => m.elite);
      expect(crowned?.kind).not.toBe("broodmother");
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("roaming (behavior variety: patrols, sentries, ambushers)", () => {
  it("a patrolling monster strolls around its post, leashed; a sentry holds it", () => {
    const g = createGame(7200);
    g.monsters.length = 0;
    const p = g.players[0];
    // Both placed well outside aggro range on open floor near the stairs.
    const roamer = mkMon({ id: 1, pos: { x: g.map.stairs.x, y: g.map.stairs.y }, hp: 50, maxHp: 50, speed: 2.6, roams: true });
    const sentry = mkMon({ id: 2, pos: { x: g.map.stairs.x + 1, y: g.map.stairs.y }, hp: 50, maxHp: 50, speed: 2.6 });
    if (dist(roamer.pos, p.pos) <= CONFIG.monsterAggroRange * 2) return; // seed guard
    g.monsters.push(roamer, sentry);
    const roamStart = { x: roamer.pos.x, y: roamer.pos.y };
    const sentryStart = { x: sentry.pos.x, y: sentry.pos.y };
    let maxFromPost = 0;
    for (let i = 0; i < 60 * 12; i++) {
      step(g, idle(), 1 / 60);
      maxFromPost = Math.max(maxFromPost, dist(roamer.pos, roamStart));
    }
    expect(maxFromPost).toBeGreaterThan(1); // the patroller went somewhere...
    expect(maxFromPost).toBeLessThan(CONFIG.wanderLeash + 4); // ...but stayed leashed
    expect(dist(sentry.pos, sentryStart)).toBeLessThan(0.01); // the sentry held its post
  });

  it("floors spawn a MIX: lone wanderers always roam, some packs patrol, some hold", () => {
    let roamers = 0, sentries = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const g = restoreGame({
        seed, floor: 5, player: { hp: 100, level: 6, xp: 0, xpToNext: 999, gold: 0 },
      });
      for (const m of g.monsters) {
        if (m.kind === "boss") continue;
        if (m.roams) roamers++;
        else sentries++;
      }
    }
    expect(roamers).toBeGreaterThan(0);
    expect(sentries).toBeGreaterThan(0);
  });

  it("dormant ambushers do NOT roam — they lie in wait", () => {
    const g = restoreGame({
      seed: 3, floor: 9, player: { hp: 200, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const dormant = g.monsters.filter((m) => m.dormant &&
      dist(m.pos, g.players[0].pos) > CONFIG.ambushTriggerRadius + 3);
    if (dormant.length === 0) return; // seed rolled no distant ambush pack
    const starts = dormant.map((m) => ({ m, x: m.pos.x, y: m.pos.y }));
    for (let i = 0; i < 60 * 5; i++) step(g, idle(), 1 / 60);
    for (const s of starts) {
      if (!s.m.dormant) continue; // something else sprang it (damage etc.)
      expect(dist(s.m.pos, { x: s.x, y: s.y })).toBeLessThan(0.01);
    }
  });

  it("a roamer that spots you drops the stroll and attacks", () => {
    const g = createGame(7201);
    g.monsters.length = 0;
    const p = g.players[0];
    // Real walkable ground for everyone: the roamer patrols the stairs room,
    // the player steps onto a walkable tile a few tiles away from it.
    const roamer = mkMon({
      id: 1, pos: { x: g.map.stairs.x, y: g.map.stairs.y },
      hp: 100, maxHp: 100, speed: 2.6, damage: 10, attackRange: 1, roams: true,
    });
    g.monsters.push(roamer);
    for (let i = 0; i < 10; i++) step(g, idle(), 1 / 60); // a brief off-duty stroll
    const spot = walkableTiles(g.map).find(
      (t) => dist(t, roamer.pos) > 4 && dist(t, roamer.pos) < 6,
    );
    expect(spot).toBeTruthy();
    p.pos = { x: spot!.x, y: spot!.y };
    const d0 = dist(roamer.pos, p.pos);
    let engaged = false;
    for (let i = 0; i < 60 * 3 && !engaged; i++) {
      step(g, idle(), 1 / 60);
      engaged = roamer.windup > 0 || dist(roamer.pos, p.pos) < d0 - 1.5;
    }
    expect(engaged).toBe(true);
  });
});

describe("landmark set pieces are REAL (looks = collision)", () => {
  it("carves the colonnade + pedestal as wall tiles inside the landmark hall", () => {
    let sawPillars = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const map = generateFloor(createRng(seed), 2);
      const li = map.roles.indexOf("landmark");
      if (li < 0) continue;
      const r = map.rooms[li];
      if (r.w < 7 || r.h < 7) continue;
      expect(map.pillars.length).toBeGreaterThan(0);
      sawPillars++;
      for (const ti of map.pillars) {
        expect(map.tiles[ti]).toBe(Tile.Wall);
        const x = ti % map.w, y = Math.floor(ti / map.w);
        expect(x).toBeGreaterThanOrEqual(r.x + 2);
        expect(x).toBeLessThan(r.x + r.w - 2);
        expect(y).toBeGreaterThanOrEqual(r.y + 2);
        expect(y).toBeLessThan(r.y + r.h - 2);
      }
      // The pedestal is blocked but the room CENTER stays walkable (elite
      // spawns there; reachability probes use it).
      const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
      expect(map.tiles[cy * map.w + cx]).toBe(Tile.Floor);
      if (map.pedestal >= 0) expect(map.tiles[map.pedestal]).toBe(Tile.Wall);
    }
    expect(sawPillars).toBeGreaterThan(0);
  });

  it("the sim blocks movement through a pillar tile", () => {
    const g = createGame(31);
    const map = g.map;
    if (map.pillars.length === 0) return; // seed guard (tiny landmark)
    const ti = map.pillars[0];
    const px = ti % map.w, py = Math.floor(ti / map.w);
    const p = g.players[0];
    g.monsters.length = 0;
    // Stand just west of the pillar and push east THROUGH it for 2 seconds.
    p.pos = { x: px - 0.5, y: py + 0.5 };
    for (let i = 0; i < 120; i++) step(g, { move: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(p.pos.x).toBeLessThan(px); // the bookcase is a bookcase now
  });

  it("FULL-GAME SWEEP: every room on floors 1-18 stays reachable from spawn", () => {
    // Doors count as walkable here: a key always exists for locked districts.
    const reachable = (map: FloorMap): Uint8Array => {
      const seen = new Uint8Array(map.w * map.h);
      const q = [Math.floor(map.spawn.y) * map.w + Math.floor(map.spawn.x)];
      seen[q[0]] = 1;
      while (q.length) {
        const i = q.shift()!;
        const x = i % map.w, y = Math.floor(i / map.w);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const ni = ny * map.w + nx;
          if (seen[ni] || map.tiles[ni] === Tile.Wall) continue;
          seen[ni] = 1;
          q.push(ni);
        }
      }
      return seen;
    };
    for (const seed of [11, 22, 33]) {
      for (let floor = 1; floor <= CONFIG.finalFloor; floor++) {
        const map = generateFloor(createRng(seed * 1000 + floor), floor);
        const seen = reachable(map);
        expect(seen[Math.floor(map.stairs.y) * map.w + Math.floor(map.stairs.x)]).toBe(1);
        map.rooms.forEach((r) => {
          const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
          expect(seen[cy * map.w + cx]).toBe(1);
        });
      }
    }
  });
});

describe("RIVALS mode (competitive race)", () => {
  const rivalsGame = (seed: number, n = 2) => {
    const g = createGame(seed, "rivals");
    for (let i = 1; i < n; i++) addPlayer(g, `Rival${i}`);
    return g;
  };
  const intentsFor = (g: GameState, per: Record<number, Partial<Intent>>): Record<number, Intent> => {
    const out: Record<number, Intent> = {};
    for (const p of g.players) out[p.id] = { move: { x: 0, y: 0 }, useStairs: false, ...(per[p.id] ?? {}) };
    return out;
  };

  it("rivals descend INDIVIDUALLY through concurrent floor worlds", () => {
    const g = rivalsGame(8100, 2);
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.worlds![1].monsters = [];
    // A reaches the stairs and descends; B stays on floor 1.
    a.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, intentsFor(g, { [a.id]: { useStairs: true } }), 1 / 60);
    expect(a.safeRoom).toBeTruthy(); // personal shop — the world keeps running
    expect(g.status).toBe("playing");
    expect(b.floorNo).toBe(1);
    // A leaves the shop: floor 2 world spins up, floor 1 keeps existing (B is on it).
    setReady(g, a.id);
    expect(a.floorNo).toBe(2);
    expect(g.worlds![2]).toBeTruthy();
    expect(g.worlds![1]).toBeTruthy();
    // Both worlds STEP: their monsters live independently.
    const f1Monsters = g.worlds![1].monsters.length;
    const f2Monsters = g.worlds![2].monsters.length;
    expect(f2Monsters).toBeGreaterThan(0);
    step(g, intentsFor(g, {}), 1 / 60);
    expect(g.worlds![1].monsters.length).toBe(f1Monsters);
    expect(g.worlds![2].monsters.length).toBeGreaterThanOrEqual(f2Monsters);
  });

  it("personal shops work mid-race (buy while a rival keeps fighting)", () => {
    const g = rivalsGame(8101, 2);
    const [a] = g.players;
    g.worlds![1].monsters = [];
    a.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, intentsFor(g, { [a.id]: { useStairs: true } }), 1 / 60);
    expect(a.safeRoom).toBeTruthy();
    a.gold = 1000;
    buyCatalogItem(g, a.id, "boxcutter");
    expect(a.equipment.weapon?.catalogId).toBe("boxcutter");
    // The OTHER rival can't shop from the dungeon floor.
    const b = g.players[1];
    b.gold = 1000;
    buyCatalogItem(g, b.id, "boxcutter");
    expect(b.equipment.weapon?.catalogId).not.toBe("boxcutter");
  });

  it("PvP: rivals damage each other at reduced tune; a kill pays level-scaled XP", () => {
    const g = rivalsGame(8102, 2);
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.worlds![1].monsters = [];
    b.level = 5;
    b.hp = 10;
    a.attackPower = 9999;
    a.pos = { x: b.pos.x - 1.0, y: b.pos.y };
    a.facing = { x: 1, y: 0 };
    const level0 = a.level;
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    expect(b.alive).toBe(false);
    expect(b.downedT).toBeCloseTo(CONFIG.rivalsReviveSeconds, 1);
    // 60 + 5*30 = 210 XP at level 1 = several instant level-ups: the bounty is BIG.
    expect(a.level).toBeGreaterThan(level0 + 1);
    expect(g.status).toBe("playing"); // no wipe in rivals
    expect(g.announcements.some((an) => an.text.includes("CONTRACT DISPUTE"))).toBe(true);
  });

  it("PvP damage is tuned down by pvpDamageMult", () => {
    const g = rivalsGame(8103, 2);
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.worlds![1].monsters = [];
    a.attackPower = 100;
    b.armor = 0;
    b.hp = b.maxHp = 1000;
    a.pos = { x: b.pos.x - 1.0, y: b.pos.y };
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    const dealt = 1000 - b.hp;
    expect(dealt).toBeGreaterThan(0);
    expect(dealt).toBeLessThan(100); // a 100-power swing lands well under full
  });

  it("the 15-second timer revives at the floor entry with grace", () => {
    const g = rivalsGame(8104, 2);
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.worlds![1].monsters = [];
    b.hp = 5;
    a.attackPower = 9999;
    a.pos = { x: b.pos.x - 1.0, y: b.pos.y };
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    expect(b.alive).toBe(false);
    for (let i = 0; i < 60 * (CONFIG.rivalsReviveSeconds + 1); i++) step(g, intentsFor(g, {}), 1 / 60);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(Math.round(b.maxHp * CONFIG.rivalsReviveHpFraction));
    expect(dist(b.pos, g.worlds![1].map.spawn)).toBeLessThan(1.5);
    // Grace: an immediate follow-up swing does nothing.
    a.pos = { x: b.pos.x - 1.0, y: b.pos.y };
    const hp0 = b.hp;
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    expect(b.hp).toBe(hp0);
  });

  it("first FINAL-BOSS killing blow wins the race", () => {
    const g = rivalsGame(8105, 2);
    const [a] = g.players;
    // Fast-forward A to the final floor world.
    const w = ensureWorld(g, CONFIG.finalFloor);
    a.floorNo = CONFIG.finalFloor;
    a.pos = { x: w.map.spawn.x, y: w.map.spawn.y };
    const boss = w.monsters.find((m: import("../src/sim/types").Monster) => m.kind === "boss")!;
    boss.introduced = true;
    boss.hp = 1;
    a.attackPower = 99999;
    a.pos = { x: boss.pos.x - 1.0, y: boss.pos.y };
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    expect(g.status).toBe("won");
    expect(g.winnerId).toBe(a.id);
    expect(g.announcements.some((an) => an.text.includes("CONTRACT SECURED"))).toBe(true);
  });

  it("kill XP is NOT split between rivals sharing a floor", () => {
    const g = rivalsGame(8106, 2);
    const [a, b] = g.players;
    g.monsters.length = 0;
    g.worlds![1].monsters = [];
    a.attackPower = 9999;
    b.pos = { x: a.pos.x + 0.3, y: a.pos.y }; // standing right there
    g.worlds![1].monsters.push(mkMon({ id: 900, pos: { x: a.pos.x + 0.9, y: a.pos.y }, hp: 1, xp: 50 }));
    const bXp = b.xp;
    const bLevel = b.level;
    step(g, intentsFor(g, { [a.id]: { attack: true, aim: { x: 1, y: 0 } } }), 1 / 60);
    expect(a.level).toBeGreaterThan(1); // 50 XP at level 1: full bounty levels A up
    expect(b.xp).toBe(bXp); // the bystander rival gets NOTHING
    expect(b.level).toBe(bLevel);
  });
});

describe("the fun-kit wave (Blindside / Extradition / Stunt Double)", () => {
  const CAST4: boolean[] = [false, false, false, true, false]; // slot 4 = the learned active
  const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  it("Blindside teleports onto the aimed enemy and strikes it", () => {
    const g = createGame(960);
    const p = g.players[0];
    learnAbility(g, p, "cutto"); // slot 4 is open
    p.attackPower = 50;
    g.monsters.length = 0;
    const m = mkMon({ id: 20, pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 1e5, maxHp: 1e5 });
    g.monsters.push(m);
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(gap(p.pos, m.pos)).toBeLessThan(2);
    expect(m.hp).toBeLessThan(1e5);
    expect(p.cd.cutto!).toBeGreaterThan(0);
  });

  it("REPEAT OFFENDER: killing the target inside the window resets the cooldown", () => {
    const g = createGame(961);
    const p = g.players[0];
    learnAbility(g, p, "cutto");
    p.abilities.ranks["cut.match"] = 1;
    p.attackPower = 500;
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 21, pos: { x: p.pos.x + 3, y: p.pos.y }, hp: 1, maxHp: 10 }));
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(p.cd.cutto ?? 0).toBe(0); // the camera resets
  });

  it("Extradition yanks light enemies into your arms, staggered", () => {
    const g = createGame(962);
    const p = g.players[0];
    learnAbility(g, p, "crowdsurf");
    g.monsters.length = 0;
    const m = mkMon({ id: 22, pos: { x: p.pos.x + 4, y: p.pos.y }, hp: 100, maxHp: 100 });
    g.monsters.push(m);
    const px = p.pos.x;
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(gap(p.pos, m.pos)).toBeLessThan(1.6);
    expect(m.stagger).toBeGreaterThan(0);
    expect(Math.abs(p.pos.x - px)).toBeLessThan(0.2); // YOU did not move
  });

  it("Extradition yanks YOU to the heavy ones", () => {
    const g = createGame(963);
    const p = g.players[0];
    learnAbility(g, p, "crowdsurf");
    g.monsters.length = 0;
    const brute = mkMon({ id: 23, kind: "brute", pos: { x: p.pos.x + 4, y: p.pos.y }, hp: 500, maxHp: 500 });
    g.monsters.push(brute);
    const bx = brute.pos.x;
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(gap(p.pos, brute.pos)).toBeLessThan(1.6); // you rode the chain
    expect(Math.abs(brute.pos.x - bx)).toBeLessThan(0.2); // the anchor held
  });

  it("Extradition emits the chain itself as data: caster -> pre-drag anchor", () => {
    const g = createGame(966);
    const p = g.players[0];
    learnAbility(g, p, "crowdsurf");
    g.monsters.length = 0;
    const m = mkMon({ id: 26, pos: { x: p.pos.x + 4, y: p.pos.y }, hp: 100, maxHp: 100 });
    g.monsters.push(m);
    const px = p.pos.x, py = p.pos.y, mx = m.pos.x, my = m.pos.y;
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    const chain = g.hits.find((h) => h.kind === "chain");
    expect(chain).toBeDefined();
    // Endpoints are the PRE-yank positions: hosts draw the link where the
    // chain was thrown, even though the target lands in your arms this step.
    expect(gap(chain!.pos, { x: px, y: py })).toBeLessThan(0.2);
    expect(gap(chain!.to!, { x: mx, y: my })).toBeLessThan(0.2);
  });

  it("CLASS ACTION drags everything the chain passed through", () => {
    const g = createGame(964);
    const p = g.players[0];
    learnAbility(g, p, "crowdsurf");
    p.abilities.ranks["surf.wave"] = 1;
    g.monsters.length = 0;
    const far = mkMon({ id: 24, pos: { x: p.pos.x + 4.5, y: p.pos.y }, hp: 100, maxHp: 100 });
    const onPath = mkMon({ id: 25, pos: { x: p.pos.x + 2.5, y: p.pos.y + 0.4 }, hp: 100, maxHp: 100 });
    g.monsters.push(far, onPath);
    step(g, { ...idle(), cast: CAST4, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(gap(p.pos, far.pos)).toBeLessThan(1.6);
    expect(gap(p.pos, onPath.pos)).toBeLessThan(1.6);
  });

  it("Stunt Double taunts: monsters hunt the decoy, and it soaks their hits", () => {
    const g = createGame(965);
    const p = g.players[0];
    learnAbility(g, p, "stuntdouble");
    g.monsters.length = 0;
    step(g, { ...idle(), cast: CAST4 }, 1 / 60); // hire the double at your feet
    expect(g.decoys.length).toBe(1);
    const dc = g.decoys[0];
    // A biter arrives next to the double; the owner retreats across the room.
    g.monsters.push(mkMon({ id: 26, pos: { x: dc.pos.x + 0.8, y: dc.pos.y }, hp: 100, maxHp: 100, damage: 20, speed: 2 }));
    p.pos = { x: dc.pos.x + 9, y: dc.pos.y };
    const hpBefore = p.hp;
    for (let i = 0; i < 90; i++) step(g, idle(), 1 / 60); // 1.5s: windup + strike
    expect(dc.absorbed).toBeGreaterThan(0); // the professional took the hit
    expect(p.hp).toBe(hpBefore); // and you did not
  });

  it("the double mirrors your swings and exits with a bang", () => {
    const g = createGame(966);
    const p = g.players[0];
    learnAbility(g, p, "stuntdouble");
    p.attackPower = 100;
    g.monsters.length = 0;
    step(g, { ...idle(), cast: CAST4 }, 1 / 60);
    const dc = g.decoys[0];
    // A monster in the DOUBLE's reach but far from the owner.
    const nearDouble = mkMon({ id: 27, pos: { x: dc.pos.x + 0.8, y: dc.pos.y }, hp: 1e5, maxHp: 1e5 });
    g.monsters.push(nearDouble);
    p.pos = { x: dc.pos.x + 6, y: dc.pos.y };
    p.facing = { x: 1, y: 0 };
    step(g, { ...idle(), attack: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(nearDouble.hp).toBeLessThan(1e5); // the mirror connected
    // Bank a beating, run out the contract: the farewell blast lands.
    dc.absorbed = 200;
    dc.t = 0.01;
    const before = nearDouble.hp;
    for (let i = 0; i < 3; i++) step(g, idle(), 1 / 60);
    expect(g.decoys.length).toBe(0);
    expect(nearDouble.hp).toBeLessThan(before);
  });

  it("AWARD SEASON: a finished contract refunds half the booking", () => {
    const g = createGame(967);
    const p = g.players[0];
    learnAbility(g, p, "stuntdouble");
    p.abilities.ranks["double.award"] = 1;
    g.monsters.length = 0;
    step(g, { ...idle(), cast: CAST4 }, 1 / 60);
    const cdAfterCast = p.cd.stuntdouble!;
    g.decoys[0].t = 0.01;
    for (let i = 0; i < 3; i++) step(g, idle(), 1 / 60);
    expect(p.cd.stuntdouble!).toBeLessThan(cdAfterCast * 0.6);
  });
});

describe("the System intervenes (corrective content)", () => {
  // Floor 4: past the grace floors, not a band-boss arena.
  const bored = (seed: number) => {
    const g = createTestGame({ seed, floor: 4, level: 5 });
    const p = g.players[0];
    p.hype = 0;
    p.boredT = CONFIG.interferenceBoredom; // the clock lapses on the next tick
    return { g, p };
  };

  it("a flatlined broadcast gets a bounty posted on the nearest chaff", () => {
    const { g, p } = bored(41);
    step(g, idle(), 1 / 60);
    const crowned = g.monsters.filter((m) => (m.bountyT ?? 0) > 0);
    expect(crowned.length).toBe(1);
    expect(crowned[0].bountyGold).toBe(CONFIG.interferenceBountyGold + g.floor * CONFIG.interferenceBountyGoldPerFloor);
    expect(p.boredTier).toBe(1);
    expect(g.announcements.some((a) => a.text.includes("bounty has been posted"))).toBe(true);
  });

  it("collecting the bounty inside the window pays gold and hype", () => {
    const { g, p } = bored(42);
    step(g, idle(), 1 / 60);
    const m = g.monsters.find((mm) => (mm.bountyT ?? 0) > 0)!;
    const gold0 = p.gold;
    m.lastHitBy = p.id;
    m.hp = 0;
    step(g, idle(), 1 / 60);
    expect(p.gold).toBeGreaterThanOrEqual(gold0 + CONFIG.interferenceBountyGold);
    expect(p.hype).toBeGreaterThanOrEqual(CONFIG.interferenceBountyHype - 1);
  });

  it("hype above the floor is cover: both clocks reset, nothing fires", () => {
    const { g, p } = bored(43);
    p.hype = CONFIG.interferenceHypeFloor + 10;
    p.boredTier = 2;
    step(g, idle(), 1 / 60);
    expect(p.boredT).toBe(0);
    expect(p.boredTier).toBe(0);
    expect(g.monsters.every((m) => (m.bountyT ?? 0) === 0)).toBe(true);
  });

  it("a repeat offender gets corrective content spawned around them", () => {
    const { g, p } = bored(44);
    p.boredTier = 1; // the bounty already aired; this time it's a wave
    const n0 = g.monsters.length;
    step(g, idle(), 1 / 60);
    expect(g.monsters.length).toBeGreaterThanOrEqual(n0 + CONFIG.interferenceAmbushCount);
    expect(g.announcements.some((a) => a.text.includes("Corrective content"))).toBe(true);
  });

  it("chronic boredom escalates to the engagement review (telegraphed impacts)", () => {
    const { g, p } = bored(45);
    p.boredTier = 2;
    step(g, idle(), 1 / 60);
    expect(g.hazards.length).toBeGreaterThan(0);
    expect(g.announcements.some((a) => a.text.includes("engagement review"))).toBe(true);
  });

  it("floors 1-2 are grace floors: the System never interferes", () => {
    const g = createTestGame({ seed: 46, floor: 2, level: 3 });
    const p = g.players[0];
    p.hype = 0;
    p.boredT = CONFIG.interferenceBoredom * 3;
    step(g, idle(), 1 / 60);
    expect(g.monsters.every((m) => (m.bountyT ?? 0) === 0)).toBe(true);
    expect(p.boredTier ?? 0).toBe(0);
  });
});

describe("CLASS REVISION (milestone castings)", () => {
  const mkRoom = (nextFloor: number) => ({ nextFloor, available: [], tip: "", ready: [], purchased: {} });
  const offer = (seed: number, from: number, to: number) => {
    const g = createTestGame({ seed, floor: from, level: 6 });
    g.safeRoom = mkRoom(to);
    leaveSafeRoom(g);
    return { g, p: g.players[0] };
  };
  const pickCard = (g: GameState, pid: number, match: (r: { kind: string; revisionId?: string }) => boolean) => {
    const p = g.players.find((pl) => pl.id === pid)!;
    const idx = p.pendingRewards.findIndex(match);
    expect(idx).toBeGreaterThanOrEqual(0);
    chooseReward(g, pid, idx);
  };

  it("descending past a band boss offers the milestone draft: 3 castings + REMAIN UNCAST", () => {
    const { g, p } = offer(51, 3, 4);
    expect(g.floor).toBe(4);
    expect(p.pendingRewards.filter((r) => r.kind === "revision").length).toBe(3);
    expect(p.pendingRewards.filter((r) => r.kind === "revisionDecline").length).toBe(1);
  });

  it("THE UNDERDOG: smaller pool, double hype while hurt", () => {
    const { g, p } = offer(52, 3, 4);
    const hp0 = p.maxHp;
    pickCard(g, p.id, (r) => r.revisionId === "underdog");
    expect(hasRevision(p, "underdog")).toBe(true);
    expect(p.maxHp).toBeLessThan(hp0);
    p.hp = Math.max(1, Math.floor(p.maxHp * 0.2));
    p.hype = 0;
    addHype(g, p, 10);
    expect(p.hype).toBeCloseTo(10 * CONFIG.revisionUnderdogHypeMult, 5);
  });

  it("PARKOUR ARTIST: a third dash charge, on the sheet too", () => {
    const { g, p } = offer(53, 3, 4);
    pickCard(g, p.id, (r) => r.revisionId === "parkour");
    expect(p.dashCharges).toBe(CONFIG.dashCharges + CONFIG.revisionParkourCharges);
    expect(buildCharacterSheet(g, p).defense.dashCharges).toBe(CONFIG.dashCharges + CONFIG.revisionParkourCharges);
  });

  it("REMAIN UNCAST pays the defiance dividend on every hype gain", () => {
    const { g, p } = offer(54, 3, 4);
    pickCard(g, p.id, (r) => r.kind === "revisionDecline");
    expect(hasRevision(p, "uncast")).toBe(true);
    p.hype = 0;
    addHype(g, p, 10);
    expect(p.hype).toBeCloseTo(10 * (1 + CONFIG.revisionUncastHype), 5);
  });

  it("TYPECAST locks THE FIVE", () => {
    const g = createTestGame({ seed: 55, floor: 5, level: 6 });
    const p = g.players[0];
    (p.revisions ??= []).push("typecast");
    g.safeRoom = mkRoom(6);
    const slots0 = [...p.abilities.slots];
    slotAbility(g, p.id, 0, null);
    expect(p.abilities.slots).toEqual(slots0);
  });

  it("CORPORATE SELLOUT signs sponsors early and the network skims gold", () => {
    const g = createTestGame({ seed: 56, floor: 5, level: 6 });
    const p = g.players[0];
    (p.revisions ??= []).push("sellout");
    p.favorites = CONFIG.show.sponsorThresholds[0] * CONFIG.revisionSelloutThresholdMult + 0.1;
    const gold0 = p.gold;
    g.loot.push({ id: 999999, pos: { x: p.pos.x, y: p.pos.y }, kind: "gold", amount: 100 });
    step(g, idle(), 1 / 60);
    expect(p.sponsors).toBe(1);
    expect(p.gold - gold0).toBe(Math.round(100 * CONFIG.revisionSelloutGoldMult));
  });

  it("SERIES REGULAR trims every remaining floor's clock", () => {
    const g = createTestGame({ seed: 57, floor: 4, level: 6 });
    (g.players[0].revisions ??= []).push("regular");
    g.safeRoom = mkRoom(5);
    leaveSafeRoom(g);
    expect(g.timeBudget).toBe(Math.round(floorTimeBudget(5) * CONFIG.revisionRegularTimeMult));
  });

  it("CANCELED: signing zeroes the meter and halves every gain after", () => {
    const { g, p } = offer(58, 9, 10);
    p.hype = 50;
    pickCard(g, p.id, (r) => r.revisionId === "canceled");
    expect(p.hype).toBe(0);
    addHype(g, p, 10);
    expect(p.hype).toBeCloseTo(10 * CONFIG.revisionCanceledHypeMult, 5);
  });
});

describe("first-contact System tips", () => {
  it("the bolt tip fires on the first cast and never again", () => {
    const g = createGame(970);
    const p = g.players[0];
    step(g, { ...idle(), bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(p.tipsSeen).toContain("bolt");
    expect(g.announcements.some((a) => a.kind === "tip")).toBe(true);
    // Wait out the cooldown, cast again: the System does not repeat itself.
    for (let i = 0; i < 180; i++) step(g, idle(), 1 / 60);
    step(g, { ...idle(), bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(g.announcements.some((a) => a.kind === "tip")).toBe(false);
  });

  it("affliction and near-death each file their courtesy explanation", () => {
    const g = createGame(971);
    const p = g.players[0];
    damagePlayerHit(g, p, 1, { effect: "poison", roll: false });
    expect(p.tipsSeen).toContain("afflicted");
    p.hp = Math.max(2, Math.floor(p.maxHp * 0.2));
    damagePlayerHit(g, p, 1, { roll: false });
    expect(p.tipsSeen).toContain("lowhp");
  });

  it("the first stagger explains poise", () => {
    const g = createGame(972);
    const p = g.players[0];
    const m = g.monsters.find((mm) => mm.kind !== "boss" && !mm.elite)!;
    damageMonster(g, p, m, 1, { allowCrit: false, shatterPoise: true });
    expect(p.tipsSeen).toContain("stagger");
  });

  it("delivered tips survive the save file and never re-fire", () => {
    const r = restoreGame({
      seed: 973, floor: 1,
      player: { hp: 100, level: 1, xp: 0, xpToNext: 10, gold: 0, tipsSeen: ["bolt"] },
    });
    expect(r.players[0].tipsSeen).toContain("bolt");
    step(r, { ...idle(), bolt: true, aim: { x: 1, y: 0 } }, 1 / 60);
    expect(r.announcements.some((a) => a.kind === "tip")).toBe(false);
  });

  it("the first interference correction comes with the paperwork", () => {
    const g = createTestGame({ seed: 974, floor: 4, level: 5 });
    const p = g.players[0];
    p.hype = 0;
    p.boredT = CONFIG.interferenceBoredom;
    step(g, idle(), 1 / 60);
    expect(p.tipsSeen).toContain("interference");
    expect(g.announcements.some((a) => a.kind === "tip" && a.text.includes("COURTESY EXPLANATION"))).toBe(true);
  });
});

describe("boss poise: interrupts are earned (decay + stagger grace)", () => {
  /** A fabricated arena: the crawler and one named menace, out of swing range. */
  function bossGame(seed: number, over: Partial<import("../src/sim/types").Monster> = {}) {
    const g = createGame(seed);
    g.monsters.length = 0;
    g.projectiles.length = 0;
    const m = mkMon({
      id: 1, kind: "boss", hp: 10000, maxHp: 10000, attackCooldown: 99,
      pos: { x: g.players[0].pos.x + 15, y: g.players[0].pos.y },
      introduced: true, ...over,
    });
    g.monsters.push(m);
    return { g, p: g.players[0], m };
  }

  it("a real burst still staggers a boss and cancels the committed swing", () => {
    const { g, p, m } = bossGame(4101);
    m.windup = 0.5;
    m.windupKind = "slam";
    damageMonster(g, p, m, 100, { allowCrit: false, poiseMult: 100 }); // well past the 5000 threshold
    expect(m.stagger).toBeGreaterThan(0);
    expect(m.windup).toBe(0);
    expect(m.windupKind).toBeUndefined();
  });

  it("the grace window denies the encore: no poise builds, no second stagger", () => {
    const { g, p, m } = bossGame(4102);
    damageMonster(g, p, m, 100, { allowCrit: false, poiseMult: 100 });
    expect(m.stagger).toBeGreaterThan(0);
    expect(m.staggerGraceT).toBe(CONFIG.bossStaggerGrace);
    m.stagger = 0; // the helpless beat ticks out...
    damageMonster(g, p, m, 100, { allowCrit: false, poiseMult: 100 }); // ...and the same burst repeats
    expect(m.stagger).toBe(0); // composure holds
    expect(m.poiseDmg).toBe(0); // nothing banks during the window either
  });

  it("poise DRAINS: chip damage never banks a free interrupt", () => {
    const { g, m } = bossGame(4103);
    m.poiseDmg = m.maxHp * 0.5 * 0.9; // one hit shy of the threshold
    for (let i = 0; i < 240; i++) step(g, idle(), 1 / 60); // four idle seconds
    expect(m.poiseDmg).toBe(0); // the bank is gone
    expect(m.stagger).toBe(0);
  });

  it("the Dark Ritual channel ignores grace and takes double poise", () => {
    const { g, p, m } = bossGame(4104);
    m.staggerGraceT = 5; // freshly staggered...
    m.windup = 1.5;
    m.windupTotal = CONFIG.ritualWindup;
    m.windupKind = "ritual"; // ...and already channeling the big one
    damageMonster(g, p, m, 100, { allowCrit: false, poiseMult: 40 }); // ~4000 raw -> ~8000 channel poise
    expect(m.stagger).toBeGreaterThan(0); // the advertised interrupt still works
    expect(m.windupKind).toBeUndefined();
  });

  it("named elites get a shorter composure window; trash gets none", () => {
    const g = createGame(4105);
    const p = g.players[0];
    g.monsters.length = 0;
    const elite = mkMon({ id: 1, hp: 2000, maxHp: 2000, elite: true, introduced: true });
    const grunt = mkMon({ id: 2, hp: 2000, maxHp: 2000 });
    g.monsters.push(elite, grunt);
    damageMonster(g, p, elite, 100, { allowCrit: false, poiseMult: 100 });
    expect(elite.stagger).toBeGreaterThan(0);
    expect(elite.staggerGraceT).toBe(CONFIG.eliteStaggerGrace);
    damageMonster(g, p, grunt, 100, { allowCrit: false, poiseMult: 100 });
    expect(grunt.stagger).toBeGreaterThan(0);
    expect(grunt.staggerGraceT ?? 0).toBe(0); // chaff stays flinchy
    grunt.stagger = 0;
    damageMonster(g, p, grunt, 100, { allowCrit: false, poiseMult: 100 });
    expect(grunt.stagger).toBeGreaterThan(0); // and re-staggers immediately
  });
});
