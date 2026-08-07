import { describe, it, expect } from "vitest";
import { createGame } from "../src/sim/game";
import { AudioDirector } from "../src/audio/director";
import { MixBus, TIER, tierOf } from "../src/audio/mix";
import type { AudioSink, PlayOpts } from "../src/audio/engine";
import type { SoundId } from "../src/audio/manifest";
import type { HitEvent } from "../src/sim/types";

// ===========================================================================
// THE MIX LAYER — prioritisation and masking (src/audio/mix.ts).
//
// Owner verdict, 2026-08-07, after playing the integrated build: "The sound
// effects for kills is way too much I think... there needs to be a masking
// layer which prioritizes certain sounds over others."
//
// NOBODY IN THIS LOOP CAN HEAR. So this file asserts the two things a count
// can actually settle, and neither of them is "it sounds good":
//   1. THE FEEL RULE HOLDS: a lone kill is untouched — same clip, same gain,
//      same frame. The fix is not a quieter kill.
//   2. THE DENSITY RULE HOLDS: twenty kills in a moment are one emphatic
//      event, the cues that must read are never refused, and the crowdable
//      part of the mix is bounded.
// The mix's QUALITY remains unverified until the owner's ear says otherwise
// (SOUNDPLAN §1.3a is the register of that verdict, and it is still open).
// ===========================================================================

class FakeSink implements AudioSink {
  played: { id: SoundId; opts?: PlayOpts }[] = [];
  /** Real-ish clip lengths so the voice budget is exercised, not defaulted. */
  private durs: Partial<Record<string, number>> = {
    hit: 0.43, crit: 0.65, kill: 0.24, swing: 0.19, tell: 0.28,
    player_hurt: 0.53, gold: 0.85, crowd: 2.0, level_up: 0.33,
  };
  play(id: SoundId, opts?: PlayOpts): void {
    this.played.push({ id, opts });
  }
  music(): void {}
  has(): boolean {
    return true;
  }
  duration(id: SoundId): number | undefined {
    return this.durs[id] ?? (id.startsWith("bark_") ? 1.1 : 0.4);
  }
  ids(): SoundId[] {
    return this.played.map((p) => p.id);
  }
  count(id: SoundId): number {
    return this.ids().filter((i) => i === id).length;
  }
}

const dead = (n: number, at: { x: number; y: number }): HitEvent[] =>
  Array.from({ length: n }, () => ({ pos: { ...at }, amount: 12, kind: "enemy" as const, killed: true }));

describe("mix layer: the tier table is the policy, and it is ordered", () => {
  it("ranks the player's own body above the telegraph above the chatter", () => {
    expect(tierOf("player_hurt")).toBe(TIER.critical);
    expect(tierOf("death")).toBe(TIER.critical);
    expect(tierOf("tell")).toBe(TIER.telegraph);
    expect(tierOf("boss_punish")).toBe(TIER.telegraph);
    expect(tierOf("level_up")).toBe(TIER.progression);
    // A death is more information than a blow, so it outranks one.
    expect(tierOf("kill")).toBeGreaterThan(tierOf("hit"));
    // Barks were 29-31% of the whole voice budget at pack density: texture.
    expect(tierOf("bark_skel_death_a")).toBe(TIER.chatter);
    expect(tierOf("dot_burn")).toBe(TIER.chatter);
    // Unlisted families inherit by pattern rather than falling off the table.
    expect(tierOf("cast_cataclysm")).toBe(TIER.act);
    expect(tierOf("apply_burn")).toBe(TIER.impact);
  });
});

describe("mix layer: what a crowded room does to a cue", () => {
  it("bounds the crowdable tiers but never refuses a critical or a telegraph", () => {
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    // 40 distinct chatter/impact asks inside one instant — the shape the
    // census measured (peak 55-59 concurrent voices at floor-15 pack density).
    for (let i = 0; i < 40; i++) mix.play(`bark_skel_pain_${i % 2 === 0 ? "a" : "b"}` as SoundId);
    for (let i = 0; i < 40; i++) mix.play("hit");
    const crowded = mix.concurrent();
    expect(crowded).toBeLessThanOrEqual(16);
    // ...and into exactly that pile, the two cues that must read still land.
    expect(mix.play("player_hurt")).toBe(true);
    expect(mix.play("tell")).toBe(true);
    expect(sink.count("player_hurt")).toBe(1);
    expect(sink.count("tell")).toBe(1);
  });

  it("forces the telegraph past the engine's blind FIFO guard", () => {
    // The census: `tell` was silenced 290 of 420 times at floor-17 pack
    // density by a per-id guard with no notion of importance. The mix layer
    // is now its rate limit, so what it admits it also forces.
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    mix.play("tell");
    mix.play("player_hurt");
    expect(sink.played.find((s) => s.id === "tell")!.opts!.force).toBe(true);
    expect(sink.played.find((s) => s.id === "player_hurt")!.opts!.force).toBe(true);
    // Chatter keeps the engine guard as a second net — it can only remove more.
    mix.beginFrame(1000); // past the focus window player_hurt just opened
    mix.play("bark_org_pain_a");
    expect(sink.played.find((s) => s.id === "bark_org_pain_a")!.opts?.force).toBeFalsy();
  });

  it("never turns anything down: no gain the caller asked for is modified", () => {
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    mix.play("hit", { gain: 0.6, pan: -0.3 });
    mix.play("tell", { gain: 0.9 });
    expect(sink.played[0].opts!.gain).toBe(0.6);
    expect(sink.played[0].opts!.pan).toBe(-0.3);
    expect(sink.played[1].opts!.gain).toBe(0.9);
  });

  it("stops a clip layering over itself (player_hurt measured 92.8%, five deep)", () => {
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    for (let i = 0; i < 6; i++) {
      mix.beginFrame(i * 16); // six frames inside player_hurt's own 530ms
      mix.play("player_hurt");
    }
    expect(sink.count("player_hurt")).toBe(1);
    mix.beginFrame(900); // the clip is over: the next blow speaks again
    expect(mix.play("player_hurt")).toBe(true);
  });

  it("a headline cue clears the chatter for a moment (the duck, as admission)", () => {
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    expect(mix.play("bark_hum_aggro_a")).toBe(true);
    mix.beginFrame(1000);
    // level_up is deliberately OFF the announcer bus (§1.3a: that bus is the
    // sidechain duck source and a level edge would pump the bed all run), so
    // it gets its space here instead — measured 90% buried on FLOOR 3.
    mix.play("level_up");
    mix.beginFrame(1050);
    expect(mix.play("bark_hum_aggro_b")).toBe(false);
    mix.beginFrame(1400); // window closed
    expect(mix.play("bark_hum_aggro_b")).toBe(true);
  });

  it("drops the previous run's budget on a run boundary", () => {
    const sink = new FakeSink();
    const mix = new MixBus(sink);
    mix.beginFrame(0);
    for (let i = 0; i < 20; i++) mix.play(`bark_air_pain_${i % 2 ? "a" : "b"}` as SoundId);
    expect(mix.concurrent()).toBeGreaterThan(0);
    mix.beginFrame(0, true);
    expect(mix.concurrent()).toBe(0);
  });
});

describe("director: the kill channel, coalesced", () => {
  function setup() {
    const sink = new FakeSink();
    const director = new AudioDirector(sink);
    const state = createGame(42);
    return { sink, director, state };
  }

  it("A LONE KILL IS UNTOUCHED — the feel rule the fix must not break", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    state.elapsed += 1;
    sink.played = [];
    director.frame(state, [{ pos: { ...p.pos }, amount: 12, kind: "enemy", killed: true }], [], p.id);
    expect(sink.count("hit")).toBe(1);
    expect(sink.count("kill")).toBe(1);
    const k = sink.played.find((s) => s.id === "kill")!;
    expect(k.opts!.gain).toBe(1); // at the player's feet: no attenuation
    expect(k.opts!.rate).toBeUndefined(); // the ordinary voicing, not the emphasis
  });

  it("TWENTY KILLS IN A MOMENT ARE ONE EMPHATIC EVENT, not twenty thumps", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    state.elapsed += 1;
    sink.played = [];
    director.frame(state, dead(20, p.pos), [], p.id);
    expect(sink.count("kill")).toBe(1);
    const k = sink.played.find((s) => s.id === "kill")!;
    // THE REWARD, NOT THE MUTE: same clip, same gain, pitched down so the
    // wipe reads as heavier. Nothing is quieter than a single kill.
    expect(k.opts!.rate!).toBeLessThan(1);
    expect(k.opts!.gain).toBe(1);
    expect(sink.count("crowd")).toBe(1);
    // And the blows behind them are capped too — this used to be 20 `hit`s.
    expect(sink.count("hit")).toBeLessThanOrEqual(4);
  });

  it("a kill storm cannot retrigger the kill cue every frame", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    sink.played = [];
    // Two seconds of a pack wipe: two kills every frame, 60fps.
    for (let i = 0; i < 120; i++) {
      state.elapsed += 1 / 60;
      director.frame(state, dead(2, p.pos), [], p.id);
    }
    // 240 kills. Before the mix layer this was one `kill` per killed HitEvent
    // (240 asks, ~22 surviving the engine's blind 90ms guard, plus 240 death
    // barks and 240 hits underneath). The gate bounds it to a handful.
    expect(sink.count("kill")).toBeLessThanOrEqual(2000 / 260 + 1);
    expect(sink.count("kill")).toBeGreaterThan(0);
  });

  it("the player's own hurt is voiced once per frame however many blows land", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    state.elapsed += 1;
    sink.played = [];
    director.frame(state, [
      { pos: { ...p.pos }, amount: 3, kind: "player" },
      { pos: { ...p.pos }, amount: 30, kind: "player" },
      { pos: { ...p.pos }, amount: 7, kind: "player" },
    ], [], p.id);
    expect(sink.count("player_hurt")).toBe(1);
  });

  it("the nearest wind-up is the telegraph that speaks", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const mons = state.monsters.slice(0, 3);
    if (mons.length < 2) return; // seed-dependent floor; nothing to assert
    director.frame(state, [], [], p.id);
    state.elapsed += 1;
    sink.played = [];
    mons.forEach((m, i) => {
      m.windup = 0.5;
      m.pos.x = p.pos.x + 3 + i * 5; // the FIRST is the nearest
      m.pos.y = p.pos.y;
    });
    director.frame(state, [], [], p.id);
    expect(sink.count("tell")).toBe(1);
    const tell = sink.played.find((s) => s.id === "tell")!;
    // Loudest possible tell for 3 tiles out: it is the near one, not the far one.
    expect(tell.opts!.gain!).toBeCloseTo(0.9 / (1 + 3 / 6), 5);
  });
});
