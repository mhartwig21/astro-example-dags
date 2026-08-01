// ROAM MODE v2 (SETTLEMENTS.md): settlements, residents, dialogue, quests,
// the guide, and campaign persistence. Everything here is deterministic —
// same seed, same floor, same content.
import { describe, it, expect } from "vitest";
import {
  buildFloor, buyCatalogItem, createGame, nearestPlayer, restoreGame, slotAbility, step,
} from "../src/sim/game";
import {
  chooseDialogue, closeDialogue, npcsOf, playerInSettlement, settlementShopFor,
} from "../src/sim/npc";
import { isWalkable, isWalkableForMonster, settlementRoomAt } from "../src/sim/floor";
import { toSaveData } from "../src/persist/save";
import { CONFIG, roamTribeId } from "../src/sim/config";
import type { GameState, Intent, Npc, Quest, Settlement } from "../src/sim/types";

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function roam(seed = 42): GameState {
  return createGame(seed, "coop", "roam");
}

function talkTo(g: GameState, npc: Npc): void {
  const p = g.players[0];
  p.pos = { x: npc.pos.x, y: npc.pos.y };
  step(g, { [p.id]: { ...idle(), useStairs: true } }, 1 / 30);
}

function questByKey(g: GameState, key: string): Quest | undefined {
  return g.quests.find((q) => q.key === key);
}

function settlementOf(g: GameState, npc: Npc): Settlement {
  return g.settlements!.find((s) => s.id === npc.settlementId)!;
}

describe("Roam settlements (multiple per megafloor)", () => {
  it("carves 3-4 settlement rooms; the first is the entrance one, nearest spawn", () => {
    for (const seed of [1, 7, 42, 1234]) {
      const g = roam(seed);
      const idxs = g.map.settlementRoomIdxs!;
      expect(idxs.length).toBeGreaterThanOrEqual(CONFIG.roamSettlementsMin);
      expect(idxs.length).toBeLessThanOrEqual(CONFIG.roamSettlementsMax);
      for (const i of idxs) expect(g.map.roles[i]).toBe("settlement");
      expect(g.map.settlementRoomIdx).toBe(idxs[0]);
      // Entrance settlement: no other settlement room is closer to spawn.
      const d = (i: number) => {
        const r = g.map.rooms[i];
        return Math.hypot(r.x + r.w / 2 - g.map.spawn.x, r.y + r.h / 2 - g.map.spawn.y);
      };
      for (const i of idxs.slice(1)) expect(d(idxs[0])).toBeLessThanOrEqual(d(i));
      // Settlements mirror the map: one Settlement record per room, entrance flagged.
      expect(g.settlements!.length).toBe(idxs.length);
      expect(g.settlements![0].entrance).toBe(true);
      expect(g.settlements!.slice(1).every((s) => !s.entrance)).toBe(true);
    }
  });

  it("every settlement room (not just the first) is a monster-free sanctuary with a skirt", () => {
    const g = roam(42);
    for (const si of g.map.settlementRoomIdxs!) {
      const r = g.map.rooms[si];
      const x = r.x + 1, y = r.y + 1;
      expect(isWalkable(g.map, x, y)).toBe(true);
      expect(isWalkableForMonster(g.map, x, y)).toBe(false);
      // The no-aggro pad extends beyond the walls.
      expect(settlementRoomAt(g.map, r.x - CONFIG.roamSettlementPad, r.y, CONFIG.roamSettlementPad)).toBe(si);
    }
    // No monster spawns inside any settlement room.
    for (const m of g.monsters) {
      expect(settlementRoomAt(g.map, m.pos.x, m.pos.y, 0)).toBe(-1);
    }
  });

  it("a crawler inside a settlement is not a target (the no-aggro rule)", () => {
    const g = roam(42);
    const p = g.players[0];
    const r = g.map.rooms[g.map.settlementRoomIdx];
    p.pos = { x: r.x + 1.5, y: r.y + 1.5 };
    expect(playerInSettlement(g, p)).toBe(true);
    expect(nearestPlayer(g, { x: r.x - 2, y: r.y - 2 })).toBeNull();
    // Step outside the walls: fair game again.
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    expect(playerInSettlement(g, p)).toBe(false);
    expect(nearestPlayer(g, { x: p.pos.x + 3, y: p.pos.y })).toBe(p);
  });

  it("staffs each settlement with 2-4 named residents incl. a trader and a quartermaster; Mordecai guides the entrance", () => {
    const g = roam(42);
    for (const s of g.settlements!) {
      const residents = g.npcs!.filter((n) => n.settlementId === s.id);
      expect(residents.length).toBe(s.npcIds.length);
      expect(residents.length).toBeGreaterThanOrEqual(2);
      expect(residents.length).toBeLessThanOrEqual(4);
      const roles = residents.map((n) => n.role);
      expect(roles).toContain("trader");
      expect(roles).toContain("quartermaster");
      for (const n of residents) expect(n.name.length).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
    }
    const guide = g.npcs!.find((n) => n.role === "guide")!;
    expect(guide.name).toBe("Mordecai");
    expect(settlementOf(g, guide).entrance).toBe(true);
    // Legacy singular field points at the guide (renderer compatibility).
    expect(g.npc!.id).toBe(guide.id);
  });

  it("settlement content is deterministic per (seed, floor)", () => {
    const a = roam(77);
    const b = roam(77);
    expect(JSON.stringify(a.settlements)).toBe(JSON.stringify(b.settlements));
    expect(JSON.stringify(a.npcs)).toBe(JSON.stringify(b.npcs));
    expect(JSON.stringify(a.quests)).toBe(JSON.stringify(b.quests));
  });
});

describe("Roam dialogue (state.dialogue — the settlement register)", () => {
  it("interacting near a resident opens a session with lines and choices; announcements stay untouched", () => {
    const g = roam(42);
    const trader = g.npcs!.find((n) => n.role === "trader")!;
    talkTo(g, trader);
    const s = g.dialogue!;
    expect(s).toBeTruthy();
    expect(s.npcId).toBe(trader.id);
    expect(s.portraitId).toBe("trader");
    expect(s.lines.length).toBeGreaterThan(0);
    expect(s.lines[0].speaker).toBe(trader.name);
    expect(s.choices.some((c) => c.effect === "vendor")).toBe(true);
    expect(s.choices.some((c) => c.effect === "farewell")).toBe(true);
    // VOICE.md boundary: no dialogue line ever rides the System's channel
    // (the step may announce sim events of its own; those aren't dialogue).
    for (const a of g.announcements) {
      expect(s.lines.some((l) => a.text.includes(l.text))).toBe(false);
    }
  });

  it("greetings are deterministic: same seed/floor/NPC, same words — re-talking included", () => {
    const g1 = roam(7);
    const g2 = roam(7);
    const n1 = g1.npcs!.find((n) => n.role === "elder")!;
    const n2 = g2.npcs!.find((n) => n.id === n1.id)!;
    talkTo(g1, n1);
    talkTo(g2, n2);
    expect(g1.dialogue!.lines).toEqual(g2.dialogue!.lines);
    const first = g1.dialogue!.lines[0].text;
    closeDialogue(g1, g1.players[0].id);
    expect(g1.dialogue).toBeNull();
    talkTo(g1, n1);
    expect(g1.dialogue!.lines[0].text).toBe(first);
  });

  it("vendor/reslot choices raise the host-open signal; farewell closes; walking away auto-closes", () => {
    const g = roam(42);
    const p = g.players[0];
    const trader = g.npcs!.find((n) => n.role === "trader")!;
    talkTo(g, trader);
    chooseDialogue(g, p.id, "vendor");
    expect(g.dialogue!.open).toBe("vendor");
    chooseDialogue(g, p.id, "farewell");
    expect(g.dialogue).toBeNull();

    const qm = g.npcs!.find((n) => n.role === "quartermaster")!;
    talkTo(g, qm);
    chooseDialogue(g, p.id, "reslot");
    expect(g.dialogue!.open).toBe("reslot");
    // Walk out of earshot: the session closes on the next step.
    p.pos = { x: qm.pos.x + 5, y: qm.pos.y };
    step(g, { [p.id]: idle() }, 1 / 30);
    expect(g.dialogue).toBeNull();
  });

  it("the quartermaster's patch-up heals for gold and refuses the broke", () => {
    const g = roam(42);
    const p = g.players[0];
    const qm = g.npcs!.find((n) => n.role === "quartermaster")!;
    const price = CONFIG.roamHealCostBase + g.floor * CONFIG.roamHealCostPerFloor;
    p.hp = 10;
    p.statuses = [{ kind: "poison", remaining: 5, magnitude: 2, stacks: 1, tick: 1, school: "physical" }];
    p.gold = 0;
    talkTo(g, qm);
    chooseDialogue(g, p.id, "heal");
    expect(p.hp).toBe(10); // no gold, no service
    p.gold = price + 5;
    chooseDialogue(g, p.id, "heal");
    expect(p.hp).toBe(p.maxHp);
    expect(p.statuses).toEqual([]);
    expect(p.gold).toBe(5);
  });

  it("the rumor-monger sells the stairway: gold out, ping + revealed ground in", () => {
    const g = roam(42);
    const p = g.players[0];
    const rumor = g.npcs!.find((n) => n.role === "rumor")!;
    const price = CONFIG.roamRumorCostBase + g.floor * CONFIG.roamRumorCostPerFloor;
    p.gold = price;
    talkTo(g, rumor);
    chooseDialogue(g, p.id, "rumor");
    expect(p.gold).toBe(0);
    const st = g.map.stairs;
    expect(g.pings.some((pg) => Math.hypot(pg.pos.x - st.x, pg.pos.y - st.y) < 1)).toBe(true);
    expect(g.explored[Math.floor(st.y) * g.map.w + Math.floor(st.x)]).toBe(1);
  });
});

describe("Roam guide (Mordecai)", () => {
  it("orientation reveals every settlement's ground and names the districts", () => {
    const g = roam(42);
    const p = g.players[0];
    const guide = g.npcs!.find((n) => n.role === "guide")!;
    talkTo(g, guide);
    const v0 = g.exploredVersion;
    chooseDialogue(g, p.id, "orient");
    expect(g.exploredVersion).toBeGreaterThan(v0);
    for (const s of g.settlements!) {
      const r = g.map.rooms[s.roomIdx];
      const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
      expect(g.explored[cy * g.map.w + cx]).toBe(1);
    }
    const text = g.dialogue!.lines.map((l) => l.text).join(" ");
    for (const s of g.settlements!.filter((ss) => !ss.entrance)) {
      expect(text).toContain(s.name);
    }
  });

  it("advice is first-time gated through the tipsSeen ledger (persisted with the save)", () => {
    const g = roam(42);
    const p = g.players[0];
    const guide = g.npcs!.find((n) => n.role === "guide")!;
    talkTo(g, guide);
    chooseDialogue(g, p.id, "tip");
    expect(p.tipsSeen).toContain("roam.sanctuary");
    const first = g.dialogue!.lines[0].text;
    chooseDialogue(g, p.id, "tip");
    expect(g.dialogue!.lines[0].text).not.toBe(first); // next tip, not a repeat
    expect(p.tipsSeen!.filter((t) => t.startsWith("roam.")).length).toBe(2);
  });
});

describe("Roam vendor (the settlement shop through the SafeRoom seams)", () => {
  it("stocks a shelf per settlement and sells through buyCatalogItem while inside the walls", () => {
    const g = roam(42);
    const p = g.players[0];
    const s = g.settlements![0];
    expect(s.shop.available).toContain("field_ration");
    expect(s.shop.available.length).toBeGreaterThan(3); // consumables + gear picks
    const r = g.map.rooms[s.roomIdx];
    p.pos = { x: r.x + 1.5, y: r.y + 1.5 };
    expect(settlementShopFor(g, p)).toBe(s.shop);
    p.hp = 10;
    p.gold = 500;
    buyCatalogItem(g, p.id, "field_ration");
    expect(p.gold).toBeLessThan(500);
    expect(p.hp).toBeGreaterThan(10);
    expect(s.shop.purchased["field_ration"]).toBe(1);
  });

  it("no sale outside a settlement (and none at all on Race floors)", () => {
    const g = roam(42);
    const p = g.players[0];
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    p.gold = 500;
    buyCatalogItem(g, p.id, "field_ration");
    expect(p.gold).toBe(500);
    const race = createGame(42, "coop", "race");
    expect(settlementShopFor(race, race.players[0])).toBeNull();
  });

  it("re-slotting abilities works inside a settlement (the safe-room service, in-map)", () => {
    const g = roam(42);
    const p = g.players[0];
    const r = g.map.rooms[g.map.settlementRoomIdx];
    const slotted0 = p.abilities.slots[0];
    // Outside: locked, exactly like mid-combat in Race.
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    slotAbility(g, p.id, 0, null);
    expect(p.abilities.slots[0]).toBe(slotted0);
    // Inside the walls: the bench opens.
    p.pos = { x: r.x + 1.5, y: r.y + 1.5 };
    slotAbility(g, p.id, 0, null);
    expect(p.abilities.slots[0]).toBeNull();
  });
});

describe("Roam quests (the board)", () => {
  it("posts 2-3 quests per floor, each from a different resident", () => {
    for (const seed of [1, 7, 42]) {
      const g = roam(seed);
      expect(g.quests.length).toBeGreaterThanOrEqual(CONFIG.roamQuestsPerFloorMin);
      expect(g.quests.length).toBeLessThanOrEqual(CONFIG.roamQuestsPerFloorMax);
      const givers = g.quests.map((q) => q.giverNpcId);
      expect(new Set(givers).size).toBe(givers.length);
      expect(g.quests[0].key).toBe("cull");
      for (const q of g.quests) expect(q.state).toBe("offered");
    }
  });

  it("cull: tribe kills only credit an ACTIVE quest", () => {
    const g = roam(42);
    const p = g.players[0];
    const q = questByKey(g, "cull")!;
    const kill = () => {
      const m = g.monsters.find((mm) => mm.hp > 0 && !mm.elite)!;
      m.hp = 0;
      step(g, { [p.id]: idle() }, 1 / 30);
    };
    kill();
    expect((q.objective as { killed: number }).killed).toBe(0); // not accepted yet
    const giver = g.npcs!.find((n) => n.id === q.giverNpcId)!;
    talkTo(g, giver);
    chooseDialogue(g, p.id, "accept:cull");
    p.pos = { x: g.map.spawn.x, y: g.map.spawn.y };
    kill();
    expect((q.objective as { killed: number }).killed).toBe(1);
    expect(g.monsters.every((m) => m.hp <= 0 || m.tribe === roamTribeId(g.floor))).toBe(true);
  });

  it("cache: accepting spawns the prop in the vault; picking it up completes; the giver pays", () => {
    // The archetype rotation (floor % 3) puts the cache first on floors
    // divisible by 3 — rebuild the campaign's floor 3.
    let g: GameState | null = null;
    for (let seed = 1; seed < 60 && !g; seed++) {
      const c = roam(seed);
      buildFloor(c, 3);
      if (questByKey(c, "cache")) g = c;
    }
    expect(g).not.toBeNull();
    const p = g!.players[0];
    const q = questByKey(g!, "cache")!;
    const giver = g!.npcs!.find((n) => n.id === q.giverNpcId)!;
    expect(g!.loot.some((l) => l.kind === "cache")).toBe(false);
    talkTo(g!, giver);
    chooseDialogue(g!, p.id, "accept:cache");
    const prop = g!.loot.find((l) => l.kind === "cache")!;
    expect(prop).toBeTruthy();
    const o = q.objective as { kind: "cache"; roomIdx: number; recovered: boolean };
    const vr = g!.map.rooms[o.roomIdx];
    expect(g!.map.roles[o.roomIdx]).toBe("vault");
    expect(prop.pos.x).toBeGreaterThanOrEqual(vr.x);
    expect(prop.pos.x).toBeLessThanOrEqual(vr.x + vr.w);
    // Walk onto it.
    p.pos = { x: prop.pos.x, y: prop.pos.y };
    step(g!, { [p.id]: idle() }, 1 / 30);
    expect(o.recovered).toBe(true);
    talkTo(g!, giver);
    chooseDialogue(g!, p.id, "turnin:cache");
    expect(q.state).toBe("complete");
    expect(p.pendingRewards.some((r) => r.source === "quest")).toBe(true);
  });

  it("delivery: turn-in happens at the RECIPIENT in another settlement", () => {
    let g: GameState | null = null;
    for (let seed = 1; seed < 60 && !g; seed++) {
      const c = roam(seed);
      if (questByKey(c, "delivery")) g = c;
    }
    expect(g).not.toBeNull();
    const p = g!.players[0];
    const q = questByKey(g!, "delivery")!;
    const o = q.objective as Extract<Quest["objective"], { kind: "delivery" }>;
    const giver = g!.npcs!.find((n) => n.id === q.giverNpcId)!;
    const target = g!.npcs!.find((n) => n.id === o.toNpcId)!;
    expect(target.settlementId).not.toBe(giver.settlementId);
    talkTo(g!, giver);
    chooseDialogue(g!, p.id, "accept:delivery");
    // The giver can't take the hand-off; the recipient offers it.
    expect(g!.dialogue!.choices.some((c) => c.id === "turnin:delivery")).toBe(false);
    talkTo(g!, target);
    expect(g!.dialogue!.choices.some((c) => c.id === "turnin:delivery")).toBe(true);
    chooseDialogue(g!, p.id, "turnin:delivery");
    expect(o.delivered).toBe(true);
    expect(q.state).toBe("complete");
    expect(p.pendingRewards.some((r) => r.source === "quest")).toBe(true);
  });

  it("beacons: proximity lights each spot; all lit completes; the giver pays", () => {
    let g: GameState | null = null;
    for (let seed = 1; seed < 80 && !g; seed++) {
      const c = roam(seed);
      if (questByKey(c, "beacons")) g = c;
    }
    expect(g).not.toBeNull();
    const p = g!.players[0];
    const q = questByKey(g!, "beacons")!;
    const o = q.objective as Extract<Quest["objective"], { kind: "beacons" }>;
    const giver = g!.npcs!.find((n) => n.id === q.giverNpcId)!;
    // Standing on a spot before accepting lights nothing.
    p.pos = { x: o.spots[0].x, y: o.spots[0].y };
    step(g!, { [p.id]: idle() }, 1 / 30);
    expect(o.spots[0].lit).toBe(false);
    talkTo(g!, giver);
    chooseDialogue(g!, p.id, "accept:beacons");
    for (const s of o.spots) {
      p.pos = { x: s.x, y: s.y };
      step(g!, { [p.id]: idle() }, 1 / 30);
      expect(s.lit).toBe(true);
    }
    talkTo(g!, giver);
    chooseDialogue(g!, p.id, "turnin:beacons");
    expect(q.state).toBe("complete");
    expect(p.pendingRewards.some((r) => r.source === "quest")).toBe(true);
  });

  it("turn-in waits politely while another draft is pending", () => {
    const g = roam(7);
    const p = g.players[0];
    const q = questByKey(g, "cull")!;
    const giver = g.npcs!.find((n) => n.id === q.giverNpcId)!;
    talkTo(g, giver);
    chooseDialogue(g, p.id, "accept:cull");
    (q.objective as { killed: number }).killed = (q.objective as { target: number }).target;
    p.pendingRewards = [{ id: 999, kind: "gold", title: "x", desc: "x", amount: 1 }];
    chooseDialogue(g, p.id, "turnin:cull");
    expect(q.state).toBe("active"); // refused, not lost
    p.pendingRewards = [];
    chooseDialogue(g, p.id, "turnin:cull");
    expect(q.state).toBe("complete");
  });
});

describe("Roam persistence (BACKLOG #11 + #25)", () => {
  it("runKind round-trips: CONTINUE resumes a Roam campaign, and old saves default to Race", () => {
    const g = roam(42);
    const save = toSaveData(g, g.players[0]);
    expect(save.runKind).toBe("roam");
    const back = restoreGame(save);
    expect(back.runKind).toBe("roam");
    expect(back.map.w).toBe(CONFIG.roamFloorGridW);
    expect(back.settlements!.length).toBeGreaterThan(0);
    // Pre-Roam saves carry no runKind: Race, exactly as before.
    const race = restoreGame({ ...save, runKind: undefined, roam: undefined });
    expect(race.runKind).toBe("race");
    expect(race.map.w).toBe(CONFIG.floorGridW);
  });

  it("quest progress, vendor stock, and dialogue-seen tips survive a save/load", () => {
    const g = roam(42);
    const p = g.players[0];
    // Progress the cull quest.
    const cull = questByKey(g, "cull")!;
    const giver = g.npcs!.find((n) => n.id === cull.giverNpcId)!;
    talkTo(g, giver);
    chooseDialogue(g, p.id, "accept:cull");
    (cull.objective as { killed: number }).killed = 4;
    // Consume vendor stock.
    const s = settlementOf(g, giver);
    const r = g.map.rooms[s.roomIdx];
    p.pos = { x: r.x + 1.5, y: r.y + 1.5 };
    p.gold = 500;
    buyCatalogItem(g, p.id, "field_ration");
    // Hear a guide tip (rides tipsSeen, already persisted).
    const guide = g.npcs!.find((n) => n.role === "guide")!;
    talkTo(g, guide);
    chooseDialogue(g, p.id, "tip");

    const back = restoreGame(toSaveData(g, p));
    const cull2 = questByKey(back, "cull")!;
    expect(cull2.state).toBe("active");
    expect((cull2.objective as { killed: number }).killed).toBe(4);
    const s2 = back.settlements!.find((ss) => ss.roomIdx === s.roomIdx)!;
    expect(s2.shop.purchased["field_ration"]).toBe(1);
    expect(back.players[0].tipsSeen).toContain("roam.sanctuary");
  });

  it("the dynamically-appended stronghold quest is recreated on load", () => {
    const g = roam(7);
    const p = g.players[0];
    const cull = questByKey(g, "cull")!;
    const giver = g.npcs!.find((n) => n.id === cull.giverNpcId)!;
    talkTo(g, giver);
    chooseDialogue(g, p.id, "accept:cull");
    (cull.objective as { killed: number }).killed = (cull.objective as { target: number }).target;
    chooseDialogue(g, p.id, "turnin:cull");
    chooseDialogue(g, p.id, "accept:stronghold");
    g.strongholdCleared = true; // the leader fell after the save... before it:
    const back = restoreGame(toSaveData(g, p));
    const sh = questByKey(back, "stronghold")!;
    expect(sh).toBeTruthy();
    expect(sh.state).toBe("active");
    expect(questByKey(back, "cull")!.state).toBe("complete");
    expect(back.strongholdCleared).toBe(true);
    // The leader does not respawn into a cleared campaign.
    expect(back.monsters.some((m) => m.id === back.strongholdLeaderId)).toBe(false);
  });

  it("#25: smashed hoards stay smashed across a save/load rebuild", () => {
    // Smash a clutter breakable through the real melee seam.
    let done = false;
    for (let seed = 1; seed <= 40 && !done; seed++) {
      const g = roam(seed);
      const b = (g.breakables ?? []).find((bb) => !bb.footprint);
      if (!b) continue;
      done = true;
      const p = g.players[0];
      g.monsters = [];
      p.pos = { x: b.pos.x - 0.9, y: b.pos.y };
      const key = `${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}`;
      step(g, { [p.id]: { ...idle(), attack: true, aim: { x: 1, y: 0 } } }, 1 / 60);
      expect(g.roamSmashed).toContain(key);
      const back = restoreGame(toSaveData(g, p));
      expect((back.breakables ?? []).some(
        (bb) => `${bb.pos.x.toFixed(2)},${bb.pos.y.toFixed(2)}` === key,
      )).toBe(false);
      // And a fresh campaign at the same seed still stocks it (no leakage).
      const fresh = roam(seed);
      expect((fresh.breakables ?? []).some(
        (bb) => `${bb.pos.x.toFixed(2)},${bb.pos.y.toFixed(2)}` === key,
      )).toBe(true);
    }
    expect(done).toBe(true);
  });

  it("npcsOf tolerates v1 snapshots that only carried the singular npc field", () => {
    const g = roam(42);
    const solo = { ...g, npcs: undefined } as GameState;
    expect(npcsOf(solo).length).toBe(1);
    expect(npcsOf(solo)[0].id).toBe(g.npc!.id);
  });
});
