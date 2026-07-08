import { describe, it, expect } from "vitest";
import { chooseReward, restoreGame, step } from "../src/sim/game";
import { CONFIG } from "../src/sim/config";
import { Tile, type FloorEvent, type GameState } from "../src/sim/types";

// Floor events (floors 2+, never boss floors): System Shrine, timed vault,
// sponsor challenge. All pure sim data — these tests exercise the seeded
// rolls, the telegraph/announce etiquette, and each event's contract.

const idle = () => ({ move: { x: 0, y: 0 }, useStairs: false });

function atFloor(seed: number, floor: number): GameState {
  return restoreGame({
    seed, floor,
    player: { hp: 300, level: 8, xp: 0, xpToNext: 9999, gold: 0, bonusMaxHp: 150 },
  });
}

/** Scan seeds/floors for a floor whose event matches; deterministic. */
function findEvent<T extends FloorEvent["type"]>(
  type: T,
  extra: (g: GameState) => boolean = () => true,
): GameState {
  for (let seed = 1; seed <= 120; seed++) {
    for (const floor of [2, 4, 5, 7, 8]) {
      const g = atFloor(seed, floor);
      if (g.floorEvent?.type === type && extra(g)) return g;
    }
  }
  throw new Error(`no ${type} event found in scan — seeding broke?`);
}

describe("floor events: seeding", () => {
  it("is deterministic: same seed, same floor, same event", () => {
    const a = atFloor(17, 4).floorEvent;
    const b = atFloor(17, 4).floorEvent;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never rolls events on floor 1 or on boss floors", () => {
    for (const seed of [3, 17, 42]) {
      expect(restoreGame({ seed, floor: 1, player: { hp: 100, level: 1, xp: 0, xpToNext: 20, gold: 0 } }).floorEvent).toBeNull();
      for (const floor of [3, 6, 12, 18]) {
        expect(atFloor(seed, floor).floorEvent, `seed ${seed} floor ${floor}`).toBeNull();
      }
    }
  });

  it("events land on a healthy share of ordinary floors — and not all of them", () => {
    let some = 0, total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const floor of [2, 4, 5, 7]) {
        total++;
        if (atFloor(seed, floor).floorEvent) some++;
      }
    }
    expect(some / total).toBeGreaterThan(0.4);
    expect(some / total).toBeLessThan(0.95);
  });
});

describe("floor events: System Shrine", () => {
  function touchShrine(g: GameState) {
    const shrine = g.loot.find((l) => l.kind === "shrine")!;
    g.monsters = []; // nobody interrupts a business meeting
    g.projectiles = [];
    g.players[0].pos = { x: shrine.pos.x, y: shrine.pos.y };
    step(g, idle(), 1 / 60);
    return g.players[0];
  }

  it("places a touchable shrine prop; touching it opens a pick-1 bargain", () => {
    const g = findEvent("shrine");
    expect(g.loot.some((l) => l.kind === "shrine")).toBe(true);
    const p = touchShrine(g);
    expect(p.pendingRewards).toHaveLength(3);
    expect(p.pendingRewards.map((r) => r.kind)).toEqual(["shrineBlood", "shrineGreed", "shrineDecline"]);
    expect(g.loot.some((l) => l.kind === "shrine")).toBe(false); // consumed
  });

  it("Blood Price: pays HP on the spot for permanent crit (never lethal)", () => {
    const g = findEvent("shrine");
    const p = touchShrine(g);
    const hp0 = p.hp;
    const crit0 = p.critChance;
    chooseReward(g, p.id, 0);
    expect(p.hp).toBe(Math.max(1, hp0 - Math.round(p.maxHp * CONFIG.shrineBloodCostFraction)));
    expect(p.critChance).toBeCloseTo(crit0 + CONFIG.shrineBloodCrit, 5);
    // The offering is a bargain, not a hit — it can leave you at 1, never 0.
    expect(p.alive).toBe(true);
  });

  it("Greed Clause: this floor's monsters speed up and its gold pays double", () => {
    const g = findEvent("shrine");
    const shrine = g.loot.find((l) => l.kind === "shrine")!;
    const p = g.players[0];
    const speed0 = g.monsters[0]?.speed ?? 0;
    g.projectiles = [];
    p.pos = { x: shrine.pos.x, y: shrine.pos.y };
    // Keep the monsters this time — the clause applies to them.
    for (const m of g.monsters) { m.pos = { x: 1.5, y: 1.5 }; m.dormant = false; }
    step(g, idle(), 1 / 60);
    chooseReward(g, p.id, 1);
    expect(g.goldSurge).toBe(true);
    if (g.monsters.length > 0) {
      expect(g.monsters[0].speed).toBeCloseTo(speed0 * CONFIG.shrineGreedSpeedMult, 3);
    }
  });

  it("Walk Away: no cost, no gain, shrine spent", () => {
    const g = findEvent("shrine");
    const p = touchShrine(g);
    const hp0 = p.hp, crit0 = p.critChance, gold0 = p.gold;
    chooseReward(g, p.id, 2);
    expect(p.hp).toBe(hp0);
    expect(p.critChance).toBe(crit0);
    expect(p.gold).toBe(gold0);
    expect(p.pendingRewards).toHaveLength(0);
  });

  it("never clobbers a pending sponsor draft — the shrine waits", () => {
    const g = findEvent("shrine");
    const shrine = g.loot.find((l) => l.kind === "shrine")!;
    const p = g.players[0];
    g.monsters = [];
    p.pendingRewards = [{ id: 1, kind: "gold", title: "X", desc: "x", amount: 5 }];
    p.pos = { x: shrine.pos.x, y: shrine.pos.y };
    step(g, idle(), 1 / 60);
    expect(p.pendingRewards[0].kind).toBe("gold"); // untouched
    expect(g.loot.some((l) => l.kind === "shrine")).toBe(true); // still there
  });
});

describe("floor events: timed vault", () => {
  it("seals the vault room; approach springs it; the timer re-seals it", () => {
    // Excludes floors that ALSO rolled an independent stairs-lock: if that
    // lock's key carrier happens to spawn unreachable, the very first step
    // fires the locked-door self-heal audit (correctly) in the SAME tick the
    // vault springs open, double-bumping mapVersion and muddying this assert.
    const g = findEvent("vault", (g) => !g.map.locked);
    const ev = g.floorEvent as Extract<FloorEvent, { type: "vault" }>;
    const room = g.map.rooms[ev.roomIdx];
    expect(ev.phase).toBe("sealed");
    expect(ev.doors.length).toBeGreaterThan(0);
    for (const i of ev.doors) expect(g.map.tiles[i]).toBe(Tile.DoorLocked);

    // Walk up to the doors: the vault springs open. Keep the key carrier —
    // deleting it makes the locked-door self-heal audit (correctly) waive the
    // stairs doors, which double-bumps mapVersion and muddies this assert.
    g.monsters = g.monsters.filter((m) => m.hasKey);
    const p = g.players[0];
    p.pos = { x: room.x - 1.5, y: room.y + room.h / 2 };
    const v0 = g.mapVersion;
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("open");
    expect(g.mapVersion).toBe(v0 + 1);
    for (const i of ev.doors) expect(g.map.tiles[i]).toBe(Tile.Floor);
    expect(g.events.some((t) => t.includes("VAULT OPENS"))).toBe(true);

    // Let the timer run out with everyone clear: it seals forever.
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    ev.openT = 0.001;
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("resealed");
    for (const i of ev.doors) expect(g.map.tiles[i]).toBe(Tile.DoorLocked);
  });

  it("never seals a crawler inside — it holds until the room clears", () => {
    const g = findEvent("vault");
    const ev = g.floorEvent as Extract<FloorEvent, { type: "vault" }>;
    const room = g.map.rooms[ev.roomIdx];
    g.monsters = [];
    const p = g.players[0];
    p.pos = { x: room.x + room.w / 2, y: room.y + room.h / 2 }; // teleported inside
    step(g, idle(), 1 / 60); // springs open (proximity)
    expect(ev.phase).toBe("open");
    ev.openT = 0.01;
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("open"); // held for the straggler
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("resealed");
  });

  it("the floor KEY never opens the vault's own doors", () => {
    const g = findEvent("vault", (gg) => gg.map.locked);
    const ev = g.floorEvent as Extract<FloorEvent, { type: "vault" }>;
    g.monsters = []; // the carrier is irrelevant; drop a key directly
    const p = g.players[0];
    g.loot.push({ id: 99999, pos: { x: p.pos.x, y: p.pos.y }, kind: "key", amount: 0 });
    step(g, idle(), 1 / 60);
    expect(g.map.locked).toBe(false); // stairs district opened...
    for (const i of ev.doors) expect(g.map.tiles[i]).toBe(Tile.DoorLocked); // ...vault didn't
  });
});

describe("floor events: sponsor challenge", () => {
  function enterHall(g: GameState) {
    const ev = g.floorEvent as Extract<FloorEvent, { type: "challenge" }>;
    const room = g.map.rooms[ev.roomIdx];
    for (const m of g.monsters) m.introduced = true; // skip ringside freezes
    g.players[0].pos = { x: room.x + room.w / 2, y: room.y + room.h / 2 };
    step(g, idle(), 1 / 60);
    return ev;
  }

  it("activates on entry and pays gold + hype for an untouched clear", () => {
    const g = findEvent("challenge");
    const ev = enterHall(g);
    expect(ev.phase).toBe("active");
    expect(g.events.some((t) => t.includes("SPONSOR CHALLENGE"))).toBe(true);
    const p = g.players[0];
    const gold0 = p.gold;
    // Execute the tracked pack from the judges' table.
    for (const id of ev.ids) {
      const m = g.monsters.find((mm) => mm.id === id);
      if (m) m.hp = 0;
    }
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y }; // out of harm's way for the reap
    g.monsters = g.monsters.filter((m) => ev.ids.includes(m.id)); // isolate the verdict
    g.projectiles = [];
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("cleared");
    expect(p.gold).toBeGreaterThanOrEqual(gold0 + ev.gold);
    expect(g.events.some((t) => t.includes("CHALLENGE COMPLETE"))).toBe(true);
  });

  it("voids the purse the moment any crawler takes a hit", () => {
    const g = findEvent("challenge");
    const ev = enterHall(g);
    expect(ev.phase).toBe("active");
    g.players[0].damageTaken += 10; // any source of pain counts
    step(g, idle(), 1 / 60);
    expect(ev.phase).toBe("failed");
    expect(g.events.some((t) => t.includes("VOID"))).toBe(true);
  });
});
