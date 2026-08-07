/**
 * THE DEBUT — the first run of a fresh profile (TUTORIAL.md, "open edges").
 *
 * Two owed sim changes, both measured off cold browser passes and both scoped
 * to a world the host flagged as a first-timer's first descent:
 *
 *   1. FIRST-RUN MERCY. Three of four cold passes died on floor 1 without
 *      finishing the FIRST objective; one pass cycled "Get Moving 0/3 -> 2/3 ->
 *      reset" twelve times over seven minutes. Floor 1 of a debut now has no
 *      fail state: killing blows become a CUT TO COMMERCIAL, and the collapse
 *      clock HOLDS instead of going lethal.
 *   2. AN AFFORDABLE FIRST SHELF. Two cold rounds arrived at the first shop
 *      with 24 then 16 gold against a 35-gold cheapest entry. A debut crawler
 *      is advanced a float, and the first shelf is guaranteed shoppable
 *      against the shelf that actually generated.
 *
 * Everything here is also an assertion about what is NOT true: an ordinary run
 * built by the same seed still dies, still collapses, still starts broke.
 */
import { describe, it, expect } from "vitest";
import {
  buyCatalogItem, cheapestUsefulShelfPrice, createGame, createTestGame, damagePlayerHit,
  firstRunMercyActive, handlePlayerDeath, restoreGame, step,
} from "../src/sim/game";
import { CONFIG, floorTimeBudget } from "../src/sim/config";
import { CATALOG_BY_ID } from "../src/sim/catalog";
import { RunRecorder, ReplaySession, encodeProof, decodeProof, validateProofShape, REPLAY_DT } from "../src/sim/replay";
import type { GameState, Intent, Monster } from "../src/sim/types";

const DT = 1 / 30;
const idle = (): Intent => ({ move: { x: 0, y: 0 }, attack: false, useStairs: false });

/** A world built the way the host builds a debut (main3d isDebutRun). */
function debut(seed = 4242): GameState {
  return createGame(seed, "coop", "race", null, true);
}

/** Advance n sim-seconds, collecting every announcement (they are per-step). */
function run(g: GameState, seconds: number, each?: (g: GameState, i: number) => void): string[] {
  const said: string[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    each?.(g, i);
    step(g, idle(), DT);
    for (const a of g.announcements) said.push(a.text);
    if (g.status !== "playing") break;
  }
  return said;
}

/** Drag the floor's cast onto the crawler and wake it: a first-timer standing
 *  still in a room they walked into, which is exactly the measured death. */
function swarm(g: GameState, n = 8): void {
  const p = g.players[0];
  const live = g.monsters.filter((m: Monster) => m.hp > 0).slice(0, n);
  for (const m of live) {
    m.dormant = false;
    m.pos = { x: p.pos.x + 0.4, y: p.pos.y + 0.4 };
  }
}

describe("THE DEBUT CANNOT BE FAILED OUT OF THE OPENING OBJECTIVE", () => {
  it("a killing blow on floor 1 is a CUT TO COMMERCIAL, not a death", () => {
    const g = debut();
    const p = g.players[0];
    p.pos = { x: g.map.spawn.x + 9, y: g.map.spawn.y + 9 };
    p.hype = 40;
    expect(firstRunMercyActive(g, p)).toBe(true);

    handlePlayerDeath(g, p, "the measured floor-1 death");

    expect(g.status).toBe("playing"); // the run does not end
    expect(p.alive).toBe(true);
    expect(p.mercySaves).toBe(1);
    // It costs position, most of the bar, and every point of hype the fight
    // earned — the knockdown is generous, not weightless.
    expect(p.hp).toBe(Math.round(p.maxHp * CONFIG.firstRunMercyHpFraction));
    expect(p.pos).toEqual({ x: g.map.spawn.x, y: g.map.spawn.y });
    expect(p.hype).toBe(0);
    expect((p.reviveGraceT ?? 0)).toBeGreaterThan(0);
  });

  it("the grace window is a BEAT, not immunity: it decays in co-op", () => {
    const g = debut();
    const p = g.players[0];
    handlePlayerDeath(g, p, "x");
    expect(damagePlayerHit(g, p, 5, { roll: false })).toBe(false); // untouchable, briefly
    run(g, CONFIG.firstRunMercyGraceSeconds + 0.5);
    expect(p.reviveGraceT).toBe(0);
    const before = p.hp;
    damagePlayerHit(g, p, 5, { roll: false });
    expect(p.hp).toBeLessThan(before); // the dungeon can reach you again
  });

  it("holds under a floor that never stops trying: 40 killing blows, one run", () => {
    const g = debut(77);
    const p = g.players[0];
    for (let i = 0; i < 40; i++) {
      p.reviveGraceT = 0; // defeat the grace window on purpose: no CAP is claimed
      // The real shape of every call site: choke point, then the death line.
      if (damagePlayerHit(g, p, 9999, { roll: false, src: "grunt" })) {
        handlePlayerDeath(g, p, "again");
      }
      step(g, idle(), DT);
    }
    expect(g.status).toBe("playing");
    expect(p.alive).toBe(true);
    expect(p.mercySaves).toBe(40);
  });

  it("a source that forgets to route its own death cannot fail the run either", () => {
    // Not every damage site asks damagePlayerHit for its answer. The step loop
    // asks the STATE instead, so the promise does not depend on call sites.
    const g = debut(9);
    const p = g.players[0];
    p.hp = -12;
    step(g, idle(), DT);
    expect(p.alive).toBe(true);
    expect(p.hp).toBeGreaterThan(0);
    expect(g.status).toBe("playing");
  });

  it("standing still in a live pack for three minutes: still playing (the control dies)", () => {
    for (const seed of [11, 202, 3003]) {
      const g = debut(seed);
      run(g, 180, (gg, i) => { if (i % 30 === 0) swarm(gg); });
      expect(g.status).toBe("playing");
      expect(g.players[0].alive).toBe(true);
      expect(g.players[0].mercySaves ?? 0).toBeGreaterThan(0); // it was really lethal

      const control = createGame(seed); // same dungeon, ordinary run
      run(control, 180, (gg, i) => { if (i % 30 === 0) swarm(gg); });
      expect(control.status).toBe("dead");
    }
  });

  it("the collapse clock HOLDS on floor 1 instead of going lethal", () => {
    const g = debut(5150);
    g.monsters.length = 0; // isolate the clock
    const budget = floorTimeBudget(1);
    expect(g.timeBudget).toBeCloseTo(budget, 5);
    const said = run(g, budget + 60);

    expect(g.status).toBe("playing");
    expect(g.phase).toBe("warning"); // the destabilization lesson still lands...
    expect(g.timeRemaining).toBeCloseTo(CONFIG.firstRunClockHoldSeconds, 5);
    expect(said.filter((s) => s.includes("PRODUCTION NOTE")).length).toBe(1); // ...announced once
    expect(said.some((s) => s.includes("destabilizing"))).toBe(true);

    const control = createGame(5150);
    control.monsters.length = 0;
    run(control, budget + 60);
    expect(control.phase).toBe("collapse");
    expect(control.status).toBe("dead");
  });

  it("the hold sits BELOW the warning line, or the collapse lesson never fires", () => {
    // The one arithmetic relationship the clock hold depends on, stated where
    // a retune of either knob will trip over it.
    expect(CONFIG.firstRunClockHoldSeconds)
      .toBeLessThan(floorTimeBudget(1) * CONFIG.warningFraction);
    expect(CONFIG.firstRunClockHoldSeconds).toBeGreaterThan(0);
  });
});

describe("THE MERCY IS A WINDOW, AND IT CLOSES", () => {
  it("floor 2 is the real game: the same blow kills", () => {
    const g = debut(31);
    const p = g.players[0];
    g.monsters.length = 0;
    p.pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, DT);
    expect(g.safeRoom).toBeTruthy();
    g.safeRoom = null;
    g.floor = 2; // where leaveSafeRoom puts them

    expect(firstRunMercyActive(g, p)).toBe(false);
    handlePlayerDeath(g, p, "floor 2 means it");
    expect(p.alive).toBe(false);
    expect(g.status).toBe("dead");
  });

  it("no other constructor in the game can reach it", () => {
    expect(createGame(1).firstRun).toBeFalsy();
    expect(createGame(1, "coop", "race", null).firstRun).toBeFalsy();
    expect(createGame(1, "rivals", "race").firstRun).toBeFalsy();
    expect(createTestGame({ floor: 1 }).firstRun).toBeFalsy();
    const ordinary = createGame(1);
    handlePlayerDeath(ordinary, ordinary.players[0], "x");
    expect(ordinary.status).toBe("dead");
  });

  it("survives a refresh: the save round-trips the flag", () => {
    const g = debut(808);
    const p = g.players[0];
    const resumed = restoreGame({
      seed: g.seed, floor: 1, firstRun: true,
      player: { hp: p.hp, level: 1, xp: 0, xpToNext: 100, gold: 12 },
    });
    expect(resumed.firstRun).toBe(true);
    expect(resumed.players[0].gold).toBe(12); // the float is not paid twice
    handlePlayerDeath(resumed, resumed.players[0], "x");
    expect(resumed.status).toBe("playing");
    // ...and a save without the flag resumes into the ordinary game.
    const plain = restoreGame({
      seed: g.seed, floor: 1,
      player: { hp: 100, level: 1, xp: 0, xpToNext: 100, gold: 12 },
    });
    handlePlayerDeath(plain, plain.players[0], "x");
    expect(plain.status).toBe("dead");
  });
});

describe("THE FIRST SHELF IS A SHELF, NOT A WINDOW", () => {
  /** Warp to the stairs and descend, so the first safe room generates. */
  function reachFirstShop(g: GameState): GameState {
    g.monsters.length = 0;
    g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
    step(g, { move: { x: 0, y: 0 }, useStairs: true }, DT);
    expect(g.safeRoom).toBeTruthy();
    expect(g.safeRoom!.nextFloor).toBe(g.floor + 1);
    return g;
  }

  it("a debut crawler can always afford something useful at shop 1 — and buy it", () => {
    for (const seed of [1, 2, 3, 17, 4242, 90210]) {
      const g = reachFirstShop(debut(seed));
      const p = g.players[0];
      const room = g.safeRoom!;
      const cheapest = cheapestUsefulShelfPrice(p, room);
      expect(cheapest).toBeGreaterThan(0);
      expect(p.gold).toBeGreaterThanOrEqual(cheapest);

      // "Affordable" has to mean BUYABLE, so buy it.
      const id = room.available.find((cid) =>
        cheapestUsefulShelfPrice(p, { ...room, available: [cid] }) === cheapest)!;
      const entry = CATALOG_BY_ID[id];
      expect(entry).toBeTruthy();
      // ...and USEFUL: gear, or a consumable that heals/plates/buys time.
      expect(entry.slot !== undefined || ["heal", "time", "maxHp"].includes(entry.effect ?? ""))
        .toBe(true);
      const goldBefore = p.gold;
      const carriedBefore = p.inventory.length + Object.values(p.equipment).filter(Boolean).length;
      buyCatalogItem(g, p.id, id);
      const carriedAfter = p.inventory.length + Object.values(p.equipment).filter(Boolean).length;
      expect(p.gold).toBeLessThan(goldBefore); // the purchase happened
      if (entry.slot) expect(carriedAfter).toBeGreaterThan(carriedBefore);
    }
  });

  it("the float is ANNOUNCED on a frame a host can hear, exactly once", () => {
    // A line emitted at construction is cleared by step()'s buffer reset
    // before any host drains it — the r5 law ("delivery is the paint")
    // applied to the System's own channel.
    const g = debut(99);
    expect(g.announcements.some((a) => a.text.includes("PRODUCTION FLOAT"))).toBe(false);
    const said = run(g, 20);
    expect(said.filter((s) => s.includes("PRODUCTION FLOAT")).length).toBe(1);
    // ...and a RESUMED debut does not re-announce a float it already spent.
    const resumed = restoreGame({
      seed: 99, floor: 1, firstRun: true,
      player: { hp: 100, level: 1, xp: 0, xpToNext: 100, gold: 12 },
    });
    expect(run(resumed, 5).some((s) => s.includes("PRODUCTION FLOAT"))).toBe(false);
  });

  it("the float covers the cheapest first shelf before a single kill", () => {
    // The measured wall was 16-24 gold against 35. The stipend is the fix at
    // the cause, and this is the arithmetic it has to keep satisfying.
    const g = reachFirstShop(debut(64));
    expect(CONFIG.firstRunStipendGold)
      .toBeGreaterThanOrEqual(cheapestUsefulShelfPrice(g.players[0], g.safeRoom!));
    expect(debut(64).players[0].gold).toBe(CONFIG.firstRunStipendGold);
    expect(createGame(64).players[0].gold).toBe(0); // ordinary runs start broke, as before
  });

  it("guarantees the shelf even for a debut crawler who arrives with nothing", () => {
    const g = debut(1234);
    g.players[0].gold = 0; // spent it, lost it, never earned it
    reachFirstShop(g);
    const room = g.safeRoom!;
    const need = cheapestUsefulShelfPrice(g.players[0], room);
    expect(g.players[0].gold).toBe(need); // topped up to exactly the cheapest useful entry
    buyCatalogItem(g, g.players[0].id, room.available.find((cid) =>
      cheapestUsefulShelfPrice(g.players[0], { ...room, available: [cid] }) === need)!);
    expect(g.players[0].goldSpent).toBe(need);
  });

  it("...and only at shop 1 — the second shelf is the real economy", () => {
    const g = debut(1234);
    g.floor = 2;
    g.players[0].gold = 0;
    reachFirstShop(g); // now generating the shop after floor 2
    expect(g.safeRoom!.nextFloor).toBe(3);
    expect(g.players[0].gold).toBe(0); // no float, no top-up, no mercy
  });
});

describe("A DEBUT IS REPLAYABLE, AND IT IS NOT A CONTEST", () => {
  it("the flag rides the proof header, so the replay rebuilds the same world", () => {
    const g = debut(2718);
    const rec = new RunRecorder({ seed: 2718, mode: "coop", runKind: "race", firstRun: true });
    for (let i = 0; i < 60; i++) step(g, rec.record(idle()), REPLAY_DT);
    const proof = decodeProof(encodeProof(rec.finish(g, g.players[0].id)));

    expect(validateProofShape(proof)).toBeNull();
    expect(proof.header.firstRun).toBe(true);
    const session = new ReplaySession(proof);
    expect(session.state.firstRun).toBe(true);
    expect(session.state.players[0].gold).toBe(CONFIG.firstRunStipendGold);
    // The divergence this field exists to prevent: replayed as an ordinary
    // run, the same stream starts from a different bankroll on tick zero.
    const asOrdinary = new ReplaySession({ ...proof, header: { ...proof.header, firstRun: undefined } });
    expect(asOrdinary.state.firstRun).toBeFalsy();
    expect(asOrdinary.state.players[0].gold).toBe(0);
  });
});
