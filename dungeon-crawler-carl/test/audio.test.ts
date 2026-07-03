import { describe, it, expect } from "vitest";
import { createGame } from "../src/sim/game";
import { AudioDirector } from "../src/audio/director";
import type { AudioSink, PlayOpts } from "../src/audio/engine";
import type { SoundId } from "../src/audio/manifest";
import { AUDIO_MANIFEST } from "../src/audio/manifest";

// The director is pure logic over sim state + feedback buffers, so it tests
// with a recording sink and real GameState objects from the deterministic sim.

class FakeSink implements AudioSink {
  played: { id: SoundId; opts?: PlayOpts }[] = [];
  musicCalls: (SoundId | null)[] = [];
  play(id: SoundId, opts?: PlayOpts): void {
    this.played.push({ id, opts });
  }
  music(id: SoundId | null): void {
    this.musicCalls.push(id);
  }
  ids(): SoundId[] {
    return this.played.map((p) => p.id);
  }
  lastMusic(): SoundId | null | undefined {
    return this.musicCalls[this.musicCalls.length - 1];
  }
}

function setup() {
  const sink = new FakeSink();
  const director = new AudioDirector(sink);
  const state = createGame(42);
  return { sink, director, state };
}

describe("audio director", () => {
  it("maps hit events to sounds with distance attenuation and pan", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(
      state,
      [
        { pos: { x: p.pos.x + 3, y: p.pos.y }, amount: 5, kind: "enemy" },
        { pos: { x: p.pos.x, y: p.pos.y }, amount: 7, kind: "crit" },
        { pos: { x: p.pos.x + 100, y: p.pos.y }, amount: 5, kind: "enemy" }, // out of earshot
      ],
      [],
      p.id,
    );
    expect(sink.ids()).toContain("hit");
    expect(sink.ids()).toContain("crit");
    expect(sink.played.filter((s) => s.id === "hit")).toHaveLength(1);
    const hit = sink.played.find((s) => s.id === "hit")!;
    expect(hit.opts!.gain!).toBeLessThan(1);
    expect(hit.opts!.pan!).toBeGreaterThan(0); // +x is screen-right under the iso camera
  });

  it("does not fire edge sounds on the first frame, then detects edges", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [], 0);
    expect(sink.ids()).toHaveLength(0);

    state.phase = "warning";
    state.players[0].level += 1;
    director.frame(state, [], [], 0);
    expect(sink.ids()).toContain("warning");
    expect(sink.ids()).toContain("level_up");
  });

  it("plays skill sounds on rising edges only", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.dashTime = 0.2;
    p.cd.bolt = 2;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toEqual(expect.arrayContaining(["dash", "bolt"]));
    sink.played = [];
    p.dashTime = 0.1; // still active — no retrigger
    p.cd.bolt = 1.5; // cooling down — no retrigger
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toHaveLength(0);
  });

  it("chimes once for announcements and roars on multi-kills", () => {
    const { sink, director, state } = setup();
    state.killsThisStep = 3;
    director.frame(state, [], ["LINE ONE", "LINE TWO"], 0);
    expect(sink.ids().filter((i) => i === "announce")).toHaveLength(1);
    expect(sink.ids()).toContain("crowd");
  });

  it("selects the music bed from run state", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_dungeon");

    state.phase = "collapse";
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_collapse");

    state.phase = "safe";
    state.safeRoom = { nextFloor: 2, stock: [], tip: "", ready: [] };
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_safe");

    state.safeRoom = null;
    state.status = "dead";
    director.frame(state, [], [], 0);
    expect(sink.ids()).toContain("death");
    expect(sink.lastMusic()).toBeNull();
  });

  it("plays the sponsor sting when a draft opens and unlock when doors open", () => {
    const { sink, director, state } = setup();
    state.map.locked = true;
    director.frame(state, [], [], 0);
    state.players[0].pendingRewards = [
      { id: 1, kind: "gold", title: "t", desc: "d", amount: 5 },
    ];
    state.map.locked = false;
    director.frame(state, [], [], 0);
    expect(sink.ids()).toEqual(expect.arrayContaining(["sponsor", "door_unlock"]));
  });

  it("layers a kill thump on killing blows (but not on player deaths)", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [
      { pos: { x: p.pos.x + 1, y: p.pos.y }, amount: 9, kind: "enemy", killed: true },
      { pos: { x: p.pos.x, y: p.pos.y }, amount: 30, kind: "player", killed: true },
    ], [], p.id);
    expect(sink.ids().filter((i) => i === "kill")).toHaveLength(1);
  });

  it("whooshes on the melee swing edge — even a whiff sounds", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.attackSwing = 0.15; // swung at nothing
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("swing");
    sink.played = [];
    p.attackSwing = 0.1; // decaying — no retrigger
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("swing");
  });

  it("plays one tell per enemy windup", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    const m = {
      id: 9, kind: "grunt" as const, pos: { x: p.pos.x + 2, y: p.pos.y },
      hp: 10, maxHp: 10, damage: 5, speed: 0, attackRange: 1, attackCooldown: 0,
      shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
      windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0,
    };
    state.monsters.push(m);
    director.frame(state, [], [], p.id);
    m.windup = 0.4; // commits to an attack
    m.windupTotal = 0.4;
    director.frame(state, [], [], p.id);
    director.frame(state, [], [], p.id); // still the same windup
    expect(sink.ids().filter((i) => i === "tell")).toHaveLength(1);
  });

  it("raises the battle bed on combat hits and stands down after the linger", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters = []; // no proximity trigger — isolate the hit trigger
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_dungeon");

    director.frame(state, [{ pos: { ...p.pos }, amount: 5, kind: "enemy" }], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b"); // floor 1 → rotation slot 1

    state.elapsed += 3; // quiet, but still inside the linger window
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b");

    state.elapsed += 10; // linger expired — back to ambience
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_dungeon");

    // Pickups are not combat: gold alone must not restart the battle bed.
    director.frame(state, [{ pos: { ...p.pos }, amount: 5, kind: "gold" }], [], p.id);
    expect(sink.lastMusic()).toBe("music_dungeon");
  });

  it("raises the battle bed when a pack closes in, before first blood", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const near = (i: number) => ({ ...state.monsters[0], id: 9000 + i, kind: "grunt" as const, hp: 10, pos: { x: p.pos.x + 1 + i, y: p.pos.y } });
    state.monsters = [near(0), near(1)];
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_dungeon"); // two nearby ≠ a pack

    state.monsters = [near(0), near(1), near(2)];
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b");
  });

  it("gives boss floors their own themes while the boss lives and is near", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const boss = { ...state.monsters[0], id: 9999, kind: "boss" as const, hp: 100, pos: { x: p.pos.x + 5, y: p.pos.y } };
    state.monsters = [boss];

    state.floor = 6;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_epic");

    state.floor = 12;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_tides");

    state.floor = 18;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_colossal");

    // The boss theme even outranks the collapse bed while the fight is on...
    state.phase = "collapse";
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_colossal");

    // ...but a dead boss hands the soundtrack back (battle lingers post-kill).
    boss.hp = 0;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_collapse");
  });

  it("keeps every manifest url under public/audio/", () => {
    for (const def of Object.values(AUDIO_MANIFEST)) {
      expect(def.url).toMatch(/^\/audio\//);
    }
  });
});
