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

  it("keeps every manifest url under public/audio/", () => {
    for (const def of Object.values(AUDIO_MANIFEST)) {
      expect(def.url).toMatch(/^\/audio\//);
    }
  });
});
