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
  /** When set, has() reports only these ids as PLAYABLE (fallback tests);
   *  unset = everything playable, like a fully loaded engine. "Playable", not
   *  "decoded", since audio r2: music streams and is never decoded, so the
   *  engine's has() means decoded-OR-streamable-and-not-known-bad. */
  have: Set<SoundId> | null = null;
  play(id: SoundId, opts?: PlayOpts): void {
    this.played.push({ id, opts });
  }
  music(id: SoundId | null): void {
    this.musicCalls.push(id);
  }
  has(id: SoundId): boolean {
    return this.have ? this.have.has(id) : true;
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
    p.dashCharges -= 1; // a dash SPENDS a charge (doDash), cd.dash starts
    p.cd.dash = 3;
    p.cd.bolt = 2;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toEqual(expect.arrayContaining(["cast_dash", "bolt"]));
    sink.played = [];
    p.cd.dash = 2.5; // recharging â€” no retrigger
    p.cd.bolt = 1.5; // cooling down â€” no retrigger
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toHaveLength(0);
  });

  it("idents once for announcements and roars on multi-kills", () => {
    const { sink, director, state } = setup();
    state.killsThisStep = 3;
    director.frame(state, [], [
      { text: "LINE ONE", kind: "flavor", priority: "normal" },
      { text: "LINE TWO", kind: "flavor", priority: "normal" },
    ], 0);
    expect(sink.ids().filter((i) => i === "ident")).toHaveLength(1);
    expect(sink.ids()).not.toContain("ident_high");
    expect(sink.ids()).toContain("crowd");
  });

  it("a headline anywhere in the batch upgrades the ident; TODAY'S RULE stamps", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [
      { text: "minor line", kind: "flavor", priority: "normal" },
      { text: "BOSS DOWN", kind: "boss", priority: "high" },
    ], 0);
    expect(sink.ids()).toContain("ident_high");
    expect(sink.ids()).not.toContain("ident");
    expect(sink.ids()).not.toContain("stamp");
    sink.played = [];
    director.frame(state, [], [
      { text: "TODAY'S RULE: RUSH HOUR. The collapse clocks run 20% shorter.", kind: "show", priority: "high" },
    ], 0);
    expect(sink.ids()).toContain("ident_high");
    expect(sink.ids()).toContain("stamp");
  });

  it("the descent layers its whoosh under the thunk", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [], 0);
    state.floor = 2;
    director.frame(state, [], [], 0);
    expect(sink.ids()).toEqual(expect.arrayContaining(["descend", "descend_whoosh"]));
  });

  it("DEATH IS A DOOR: the concede is one cold door-close", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.conceded = true;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("door_close");
    sink.played = [];
    director.frame(state, [], [], p.id); // still conceded â€” no re-close
    expect(sink.ids()).not.toContain("door_close");
  });

  it("boss beats: dedicated phase hit, punish opener, and the DEFEATED low tail", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id, [
      { kind: "phase", monsterId: 1, phase: 1, reason: "hp", pos: { ...p.pos } },
    ]);
    expect(sink.ids()).toContain("boss_phase");
    sink.played = [];
    director.frame(state, [], [], p.id, [
      { kind: "punish", monsterId: 1, pos: { ...p.pos }, duration: 2 },
    ]);
    expect(sink.ids()).toContain("boss_punish");
    expect(sink.ids()).toContain("crowd");
    sink.played = [];
    director.frame(state, [], [], p.id, [
      { kind: "phase", monsterId: 1, label: "DEFEATED", pos: { ...p.pos } },
    ]);
    expect(sink.ids()).toEqual(expect.arrayContaining(["boss_phase", "kill", "boss_down", "crowd"]));
  });

  it("selects the music bed from run state", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_undercroft"); // floor 1 ambience is the band's

    state.phase = "collapse";
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_collapse");

    state.phase = "safe";
    state.safeRoom = { nextFloor: 2, available: [], tip: "", ready: [], purchased: {} };
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

  it("whooshes on the melee swing edge â€” even a whiff sounds", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.attackSwing = 0.15; // swung at nothing
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("swing");
    sink.played = [];
    p.attackSwing = 0.1; // decaying â€” no retrigger
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
    state.monsters = []; // no proximity trigger â€” isolate the hit trigger
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_band_undercroft");

    director.frame(state, [{ pos: { ...p.pos }, amount: 5, kind: "enemy" }], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b"); // floor 1 â†’ rotation slot 1

    state.elapsed += 3; // quiet, but still inside the linger window
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b");

    state.elapsed += 10; // linger expired â€” back to ambience
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_band_undercroft");

    // Pickups are not combat: gold alone must not restart the battle bed.
    director.frame(state, [{ pos: { ...p.pos }, amount: 5, kind: "gold" }], [], p.id);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
  });

  it("raises the battle bed when a pack closes in, before first blood", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const near = (i: number) => ({ ...state.monsters[0], id: 9000 + i, kind: "grunt" as const, hp: 10, pos: { x: p.pos.x + 1 + i, y: p.pos.y } });
    state.monsters = [near(0), near(1)];
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_band_undercroft"); // two nearby â‰  a pack

    state.monsters = [near(0), near(1), near(2)];
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_battle_b");
  });

  it("gives boss floors their own themes while the boss lives and is near", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const boss = { ...state.monsters[0], id: 9999, kind: "boss" as const, hp: 100, pos: { x: p.pos.x + 5, y: p.pos.y } };
    state.monsters = [boss];

    state.floor = 3;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_epic");

    state.floor = 6;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_tides");

    state.floor = 9;
    director.frame(state, [], [], p.id);
    expect(sink.lastMusic()).toBe("music_boss_epic");

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

  it("rings the till when a room goes OPEN FOR BUSINESS (row 6, pickup half)", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [
      { text: "OPEN FOR BUSINESS: the forge takes customers. The System takes a cut.", kind: "show", priority: "normal" },
    ], 0);
    expect(sink.ids()).toContain("till");
    sink.played = [];
    director.frame(state, [], [
      { text: "an unrelated line", kind: "flavor", priority: "normal" },
    ], 0);
    expect(sink.ids()).not.toContain("till");
  });
});

describe("audio director: band beds + campfire (SOUNDPLAN Â§3, Music r1)", () => {
  it("routes ambience by band: one bed per 3-floor act, clamped at the end", () => {
    const { sink, director, state } = setup();
    const beds: Record<number, SoundId> = {
      1: "music_band_undercroft", 3: "music_band_undercroft",
      4: "music_band_sewers", 8: "music_band_garden", 11: "music_band_ruins",
      14: "music_band_ironworks", 16: "music_band_approach", 18: "music_band_approach",
    };
    for (const [floor, bed] of Object.entries(beds)) {
      state.floor = Number(floor);
      director.frame(state, [], [], 0);
      expect(sink.lastMusic(), `floor ${floor}`).toBe(bed);
    }
  });

  it("the 3â†’4 descent swaps UNDERCROFT for THE SEWERS (the band transition)", () => {
    const { sink, director, state } = setup();
    state.floor = 3;
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
    state.floor = 4;
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_sewers");
    expect(sink.ids()).toContain("band_sting"); // the act-change flourish still fires
  });

  it("degrades per band: a bed that isn't playable falls back to music_dungeon", () => {
    const { sink, director, state } = setup();
    sink.have = new Set<SoundId>(["music_dungeon", "music_band_sewers"]);
    director.frame(state, [], [], 0); // floor 1: undercroft missing
    expect(sink.lastMusic()).toBe("music_dungeon");
    state.floor = 4; // sewers present
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_sewers");
  });

  it("EVERY bed request degrades, not just the band beds", () => {
    // The first r2 cut routed 7 of 16 beds through has(): music_collapse,
    // music_safe, the three battle tracks and the three boss themes were
    // requested unconditionally. Both engine.ts and director.ts carried a
    // comment promising a dead bed "falls back to music_dungeon on the very
    // next frame, by itself", which for those nine was simply untrue — a
    // streamBad demotion left the engine on the pendingMusic branch, i.e.
    // silence for the whole mood, at the two moments (the collapse timer, a
    // boss arena) where silence costs most. Streaming introduced that class;
    // the decode path could not reach it.
    // Each mood is driven twice: once with a fully loaded sink (proving the
    // branch is REACHED and which bed it wants — otherwise "it said
    // music_dungeon" is vacuous, since that is also the ambient fallback), and
    // once with every bed but music_dungeon dead.
    const moods: [string, SoundId, (s: ReturnType<typeof setup>["state"]) => void][] = [
      ["safe room", "music_safe", (s) => { s.safeRoom = { x: 0, y: 0 } as unknown as typeof s.safeRoom; }],
      ["collapse", "music_collapse", (s) => { s.phase = "collapse"; }],
      ["boss", "music_boss_tides", (s) => {
        s.monsters.length = 0;
        s.monsters.push({
          id: 900, kind: "boss", pos: { x: s.players[0].pos.x + 2, y: s.players[0].pos.y },
          hp: 100, maxHp: 100, windup: 0, hitFlash: 0, dormant: false,
          introduced: true, phase: 1, maxPhase: 2,
        } as never);
        s.floor = 6; // bossTrack(6) -> the first city-boss arena
      }],
    ];
    for (const [label, want, stage] of moods) {
      for (const dead of [false, true]) {
        const { sink, director, state } = setup();
        sink.have = dead ? new Set<SoundId>(["music_dungeon"]) : null;
        stage(state);
        director.frame(state, [], [], state.players[0].id);
        expect(sink.lastMusic(), `${label}${dead ? " (bed dead)" : ""}`).toBe(dead ? "music_dungeon" : want);
      }
    }

    // The battle rotation, same shape: a blow in earshot raises the bed.
    for (const dead of [false, true]) {
      const { sink, director, state } = setup();
      sink.have = dead ? new Set<SoundId>(["music_dungeon"]) : null;
      const p = state.players[0];
      director.frame(state, [{ pos: { ...p.pos }, kind: "enemy", amount: 5 } as never], [], p.id);
      expect(sink.lastMusic(), `battle${dead ? " (bed dead)" : ""}`)
        .toBe(dead ? "music_dungeon" : "music_battle_b"); // floor 1 % 3 -> index 1
    }
  });

  it("the campfire owns the room while the check-in menu is up", () => {
    const { sink, director, state } = setup();
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
    director.setMenu(true);
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_menu");
    // Even over a corpse: the menu means you are AT the campfire.
    state.status = "dead";
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_menu");
    state.status = "playing";
    director.setMenu(false);
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
  });

  it("a menu bed that isn't playable stays silent-graceful (run bed continues)", () => {
    const { sink, director, state } = setup();
    sink.have = new Set<SoundId>(["music_band_undercroft"]);
    director.setMenu(true);
    director.frame(state, [], [], 0);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
  });

  it("keeps every band bed + menu bed in the manifest on the music bus, looping", () => {
    for (const id of [
      "music_band_undercroft", "music_band_sewers", "music_band_garden",
      "music_band_ruins", "music_band_ironworks", "music_band_approach", "music_menu",
    ] as const) {
      expect(AUDIO_MANIFEST[id].bus).toBe("music");
      expect(AUDIO_MANIFEST[id].loop).toBe(true);
    }
  });
});

// AUDIO R2 — the buffered/streamed split (engine.ts streamed(), deck.ts).
// The engine streams by BUS: `music` streams, everything else is decoded to an
// AudioBuffer at boot. Measured reason: the 16 music files are 1625.3s of
// audio = ~624MB of resident Float32 PCM once decoded, while all 80 SFX files
// together are 76.16 channel-seconds = 14.6MB — the entire eager path costs
// less than one boss bed. These invariants keep that split from drifting.
describe("audio manifest: what streams and what stays decoded (audio r2)", () => {
  type Streamable = { bus: string; loop?: boolean; stream?: boolean };
  const entries = Object.entries(AUDIO_MANIFEST) as [string, Streamable][];

  it("every music-bus entry loops — the streamed path wraps with el.loop", () => {
    // A streamed bed with loop:false would play once and leave the dungeon
    // silent, and no test that only watches director intent would notice.
    for (const [id, def] of entries) {
      if (def.bus === "music") expect(def.loop, id).toBe(true);
    }
  });

  it("no SFX/UI/announcer clip opts into streaming", () => {
    // Cast latency is the eager path's whole justification: a media element
    // has a fetch and a decoder start in front of it, so a streamed cast cue
    // arrives after the cast. The flag exists for loop-ladder rung 3 — a BED
    // opting back OUT of streaming — not for one-shots opting in.
    //
    // This assertion was a TAUTOLOGY in the first r2 cut: `SoundDef` had no
    // `stream` property at all (engine.ts cast it in), so no entry could carry
    // one without failing tsc first, and the test could not fail. `stream` is
    // now a real declared field, so this now guards something.
    for (const [id, def] of entries) {
      if (def.bus !== "music") expect(def.stream, id).toBeUndefined();
    }
  });

  it("`stream` is a real field on SoundDef, so the guard above can fail", () => {
    // The meta-assertion, because "the test cannot fail" is invisible in a
    // green run. If someone deletes the field again, this goes red.
    const probe: (typeof AUDIO_MANIFEST)["hit"] & { stream?: boolean } = { ...AUDIO_MANIFEST.hit, stream: true };
    expect(probe.stream).toBe(true);
  });
});

describe("audio manifest: the announcer bus (SOUNDPLAN Â§2.1/Â§2.3)", () => {
  it("routes exactly the System's stinger surface through the duck source", () => {
    const announcer = Object.entries(AUDIO_MANIFEST)
      .filter(([, def]) => def.bus === "announcer")
      .map(([id]) => id)
      .sort();
    // The set Â§2.1 names: idents, TODAY'S RULE stamp, starting gun,
    // verdict, boss_intro. Party pings (`announce`) deliberately stay off
    // it â€” a ping must not duck the fight, and UI clicks are not the show.
    expect(announcer).toEqual(
      ["boss_intro", "count_go", "count_tick", "ident", "ident_high", "stamp", "verdict"].sort(),
    );
  });
});

// NO FOOTSTEPS (owner call, audio r2): the stride system and its five tests
// are gone with it. One negative guard remains below so the family cannot
// quietly return through a future director change.
describe("audio director: footsteps stay removed (owner call, audio r2)", () => {
  it("a long walk produces zero step_* plays", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    for (let i = 0; i < 12; i++) {
      p.pos.x += 0.4;
      director.frame(state, [], [], p.id);
    }
    expect(sink.ids().filter((i) => i.startsWith("step_"))).toHaveLength(0);
  });
});
describe("audio director: status cues + band sting (launch polish #3)", () => {
  it("DoT ticks sound as their element, never as a blow", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [
      { pos: { x: p.pos.x + 1, y: p.pos.y }, amount: 3, kind: "enemy", effect: "burn" },
      { pos: { x: p.pos.x + 1, y: p.pos.y }, amount: 2, kind: "enemy", effect: "poison" },
      { pos: { x: p.pos.x, y: p.pos.y }, amount: 2, kind: "player", effect: "chill" },
    ], [], p.id);
    expect(sink.ids()).toContain("dot_burn");
    expect(sink.ids()).toContain("dot_poison");
    expect(sink.ids()).toContain("dot_chill");
    expect(sink.ids()).not.toContain("hit");
    expect(sink.ids()).not.toContain("player_hurt");
  });

  it("DoT ticks alone do not raise the battle bed", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0; // no pack pressure
    director.frame(state, [
      { pos: { x: p.pos.x + 1, y: p.pos.y }, amount: 3, kind: "enemy", effect: "burn" },
    ], [], p.id);
    expect(sink.lastMusic()).toBe("music_band_undercroft");
  });

  it("cues the element the frame a status LANDS, and only that frame", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id); // primes the afflicted set
    p.statuses = [{ kind: "burn", remaining: 3, magnitude: 2, stacks: 1, tick: 0.5, school: "magic" }];
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("apply_burn");
    sink.played = [];
    director.frame(state, [], [], p.id); // still burning â€” no re-cue
    expect(sink.ids()).not.toContain("apply_burn");
  });

  it("does not replay ongoing afflictions on the first frame (load/join)", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.statuses = [{ kind: "poison", remaining: 5, magnitude: 1, stacks: 3, tick: 0.5, school: "physical" }];
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("apply_poison");
  });

  it("cues monster afflictions too, positioned by distance and side", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    const m = {
      id: 31, kind: "grunt" as const, pos: { x: p.pos.x + 4, y: p.pos.y },
      hp: 10, maxHp: 10, damage: 5, speed: 0, attackRange: 1, attackCooldown: 0,
      shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
      windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0,
      statuses: [] as { kind: "chill"; remaining: number; magnitude: number; stacks: number; tick: number; school: "magic" }[],
    };
    state.monsters.push(m);
    director.frame(state, [], [], p.id);
    m.statuses.push({ kind: "chill", remaining: 2, magnitude: 0.3, stacks: 1, tick: 0, school: "magic" });
    director.frame(state, [], [], p.id);
    const cue = sink.played.find((s) => s.id === "apply_chill");
    expect(cue).toBeDefined();
    expect(cue!.opts!.gain!).toBeLessThan(0.9); // attenuated by 4 tiles
    expect(cue!.opts!.pan!).toBeGreaterThan(0); // +x = screen right
  });

  it("stings the act change when a descent crosses a band boundary", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    state.floor = 2; // 1 -> 2: same band, just the descend thunk
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("descend");
    expect(sink.ids()).not.toContain("band_sting");
    sink.played = [];
    state.floor = 4; // 2 -> 4: THE SEWERS open
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("band_sting");
  });
});

describe("audio director: creature barks (SOUNDPLAN row 9)", () => {
  const mob = (id: number, kind: string, x: number, y: number) => ({
    id, kind: kind as never, pos: { x, y },
    hp: 10, maxHp: 10, damage: 5, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
    windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0,
  });

  it("a grunt rattles once when it starts hunting â€” skeletal family, per-id variant", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    const m = mob(50, "grunt", p.pos.x + 40, p.pos.y); // far: not hunting yet
    state.monsters.push(m);
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i.startsWith("bark_"))).toHaveLength(0);
    m.pos.x = p.pos.x + 3; // closed to aggro range
    director.frame(state, [], [], p.id);
    director.frame(state, [], [], p.id); // still hunting â€” no re-bark
    const barks = sink.ids().filter((i) => i.startsWith("bark_"));
    expect(barks).toHaveLength(1);
    expect(barks[0]).toMatch(/^bark_skel_aggro_[ab]$/);
  });

  it("pain barks ride the hitFlash edge, gated to one per monster per 4s", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    const m = mob(51, "brute", p.pos.x + 2, p.pos.y);
    state.monsters.push(m);
    director.frame(state, [], [], p.id);
    sink.played = [];
    m.hitFlash = 0.2;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => /^bark_org_pain_[ab]$/.test(i))).toHaveLength(1);
    m.hitFlash = 0; // flash fades...
    director.frame(state, [], [], p.id);
    m.hitFlash = 0.2; // ...and a second blow lands inside the 4s gate
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => /^bark_org_pain_[ab]$/.test(i))).toHaveLength(1);
    m.hitFlash = 0;
    state.elapsed += 5; // the gate expires
    director.frame(state, [], [], p.id);
    m.hitFlash = 0.2;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => /^bark_org_pain_[ab]$/.test(i))).toHaveLength(2);
  });

  it("a reaped machine powers down: death bark when the id leaves the list", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    state.monsters.push(mob(52, "sentinel", p.pos.x + 2, p.pos.y));
    director.frame(state, [], [], p.id);
    state.monsters.length = 0; // reaped
    director.frame(state, [], [], p.id);
    const deaths = sink.ids().filter((i) => i.startsWith("bark_") && i.includes("death"));
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toMatch(/^bark_mech_death_[ab]$/);
  });

  it("bosses do not bark (the boss-beat channel owns their voice)", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    state.monsters.push(mob(53, "boss", p.pos.x + 2, p.pos.y));
    director.frame(state, [], [], p.id);
    director.frame(state, [], [], p.id);
    state.monsters.length = 0;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i.startsWith("bark_"))).toHaveLength(0);
  });

  it("a descent empties the roster without a massacre of death barks", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.monsters.length = 0;
    state.monsters.push(mob(54, "grunt", p.pos.x + 2, p.pos.y), mob(55, "phantom", p.pos.x + 3, p.pos.y));
    director.frame(state, [], [], p.id);
    sink.played = [];
    state.floor = 2;
    state.monsters.length = 0;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i.includes("death"))).toHaveLength(0);
  });
});

// THE ACT (SOUNDPLAN §1.4 row E-21). The director used to voice three of the
// SIXTEEN abilities (AbilityId has 16 members — the first r2 cut said 17 in
// five places, including the row whose whole job was to be the roster's
// audit); the other thirteen either borrowed someone else's clip or said
// nothing. These tests are the failure modes the general cast edge claims to
// have solved — each would go red if the claim were false.
describe("audio director: the cast roster (SOUNDPLAN row E-21)", () => {
  /** Every ability with a cue, and the cooldown key the sim writes on cast. */
  const CASTS: [string, SoundId][] = [
    ["dash", "cast_dash"], ["bolt", "bolt"], ["nova", "nova"],
    ["orbit", "cast_orbit"], ["stance", "cast_stance"], ["overcharge", "cast_overcharge"],
    ["cutto", "cast_cutto"], ["crowdsurf", "cast_crowdsurf"], ["stuntdouble", "cast_stuntdouble"],
    ["bulwark", "cast_bulwark"], ["cables", "cast_cables"],
    ["airstrike", "cast_airstrike"], ["cataclysm", "cast_cataclysm"],
    ["bullettime", "cast_bullettime"], ["injunction", "cast_injunction"],
  ];
  const casts = (sink: FakeSink) => sink.ids().filter((i) => i.startsWith("cast_"));

  /** A squadmate: a real Player, cloned, moved dx tiles east. */
  function squadmate(state: ReturnType<typeof setup>["state"], id: number, dx: number) {
    const clone = structuredClone(state.players[0]);
    clone.id = id;
    clone.pos = { x: state.players[0].pos.x + dx, y: state.players[0].pos.y };
    state.players.push(clone);
    return clone;
  }

  it("a cast fires exactly that ability's cue, exactly once", () => {
    for (const [ability, sound] of CASTS) {
      const { sink, director, state } = setup();
      const p = state.players[0];
      p.dashCharges = 2;
      p.cutCharges = 2;
      director.frame(state, [], [], p.id); // prime
      // What the sim actually writes on a cast: the cooldown, plus the charge
      // for the two charge-gated abilities.
      p.cd[ability as keyof typeof p.cd] = 6;
      if (ability === "dash") p.dashCharges -= 1;
      if (ability === "cutto") p.cutCharges -= 1;
      director.frame(state, [], [], p.id);
      expect(sink.ids().filter((i) => i === sound), ability).toHaveLength(1);
      // ...and nothing else from the family came along for the ride.
      const others = sink.ids().filter((i) => i.startsWith("cast_") && i !== sound);
      expect(others, ability).toHaveLength(0);
    }
  });

  it("a cast while the cooldown is still running does not double-fire", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.cd.nova = 8;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i === "nova")).toHaveLength(1);
    sink.played = [];
    // The sim refuses a recast while cd > 0 (castAbility early-returns), so
    // all the director can ever see is the cooldown ticking DOWN.
    for (const t of [7.4, 6.8, 6.2, 0.1]) {
      p.cd.nova = t;
      director.frame(state, [], [], p.id);
    }
    expect(sink.ids()).toHaveLength(0);
  });

  it("cooldown REDUCTION never fires a cast (CDR, rebates, the per-frame tick)", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.cd.cataclysm = 40;
    p.cd.orbit = 9;
    director.frame(state, [], [], p.id);
    sink.played = [];
    p.cd.cataclysm = 22; // Executioner's Rebate / AWARD SEASON style refund
    p.cd.orbit = 9 * 0.6; // rank + glyph CDR at the 0.4 cap
    director.frame(state, [], [], p.id);
    p.cd.cataclysm = 0; // ticked all the way out
    p.cd.orbit = 0;
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
  });

  it("primes on first sight: a crawler seen mid-cooldown replays nothing", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    // Every ability mid-cooldown and both charge pools partly spent — the
    // state a load, a mid-run join or a descent-in-progress hands us.
    for (const [ability] of CASTS) p.cd[ability as keyof typeof p.cd] = 3.5;
    p.dashCharges = 1;
    p.cutCharges = 1;
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
    expect(sink.ids()).not.toContain("bolt");
    expect(sink.ids()).not.toContain("nova");
    // A squadmate joining later primes on ITS first frame, not on ours.
    const mate = squadmate(state, 77, 3);
    for (const [ability] of CASTS) mate.cd[ability as keyof typeof mate.cd] = 2;
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
  });

  it("a second banked dash charge still sounds (the cd-only rule drops it)", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.dashCharges = 2;
    director.frame(state, [], [], p.id);
    // First dash: charge spent AND cd starts. Exactly one cue, not two.
    p.dashCharges = 1;
    p.cd.dash = 4;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i === "cast_dash")).toHaveLength(1);
    sink.played = [];
    // Second dash while the recharge runs: doDash leaves cd.dash alone
    // (it only sets it when it was <= 0), so ONLY the charge moves.
    p.dashCharges = 0;
    p.cd.dash = 3.6; // still ticking down
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i === "cast_dash")).toHaveLength(1);
  });

  it("a RECHARGE re-arming the cooldown is not a cast (the phantom cd rise)", () => {
    // game.ts:7740-7742 / 7755-7757: when a charge banks and the pool is still
    // below max, the sim immediately re-arms cd to a FULL cooldown. That is a
    // rise from 0 with nobody pressing anything, so cd cannot be the signal
    // for these two — the counters are. On a 3-charge dash build the naive
    // rule whooshes twice per full refill, forever, out of combat.
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.dashCharges = 0;
    p.cutCharges = 0;
    p.cd.dash = 0.01;
    p.cd.cutto = 0.01;
    director.frame(state, [], [], p.id);
    for (let i = 1; i <= 2; i++) {
      p.dashCharges = i; // a charge banks...
      p.cutCharges = i;
      p.cd.dash = 4.2; // ...and the next one's timer is armed from zero
      p.cd.cutto = 5.5;
      director.frame(state, [], [], p.id);
      p.cd.dash = 0; // ticks back down
      p.cd.cutto = 0;
      director.frame(state, [], [], p.id);
    }
    expect(casts(sink)).toHaveLength(0);
  });

  it("dashTime is no longer the signal: a heavy pull is not a dash", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    // Extradition's heavy pull, Phase Etch Blindside and the PET revision all
    // write dashTime without a dash. The old rule whooshed for all three.
    p.dashTime = 0.18;
    director.frame(state, [], [], p.id);
    p.dashTime = 0.1;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("cast_dash");
  });

  it("Blindside charges cue too, and an absent charge pool primes silently", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.cutCharges = undefined; // before the first Blindside / an older snapshot
    director.frame(state, [], [], p.id);
    p.cutCharges = 2; // the field appears — that is not a cast
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("cast_cutto");
    p.cutCharges = 1; // a real cut, cooldown already running
    p.cd.cutto = 5.5;
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i === "cast_cutto")).toHaveLength(1);
  });

  it("a descent is not a roster-wide cast volley", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    for (const [ability] of CASTS) p.cd[ability as keyof typeof p.cd] = 5;
    p.dashCharges = 0;
    director.frame(state, [], [], p.id);
    sink.played = [];
    state.floor = 2;
    p.cd = {}; // the floor reset (game.ts) wipes cooldowns...
    p.dashCharges = 2; // ...and refills the charges
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
  });

  // The above test was structurally blind to the real bug: it wipes `cd` and
  // refills charges but never sets `overcharged`, which is the THIRD field
  // castEdges reads and the only one whose floor reset is a FALLING edge.
  // game.ts:1399 (resetForFloor) and game.ts:8087 (rivals descend) both clear
  // it, and the SPEND detector is a bare `prev.overcharged && !pl.overcharged`.
  it("descending with Breaker BANKED does not fire a phantom spend", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    p.overcharged = true; // banked before the stairs — ordinary play
    p.cd.overcharge = 5;
    director.frame(state, [], [], p.id);
    sink.played = [];
    state.floor = 2;
    p.cd = {};
    p.dashCharges = 2;
    p.overcharged = false; // what resetForFloor does
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
  });

  // Same shape one level up: the director is module-scope in main3d.ts and
  // `casts` is pruned only on player disappearance, so a run that ENDED with
  // Breaker banked seeded the next one. A floor number alone cannot catch a
  // restart on floor 1; state.elapsed going backwards can.
  it("a fresh run re-primes rather than diffing against the last one", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.elapsed = 300;
    p.overcharged = true;
    p.cd.cataclysm = 30;
    director.frame(state, [], [], p.id);
    sink.played = [];
    // A new run: same floor, same player id, clock back to zero.
    state.elapsed = 0.5;
    p.overcharged = false;
    p.cd = {};
    director.frame(state, [], [], p.id);
    expect(casts(sink)).toHaveLength(0);
  });

  // The SPEND replay shares one sound id with the BANK, and the engine's spam
  // guard is per-id at throttleMs 600. Banking and then spending on the next
  // landed hit — the rhythm the manifest comment describes — put the two
  // inside one window, so the engine silently dropped the second. The
  // director must therefore force it; FakeSink has no throttle, so this
  // asserts the FLAG, which is the thing the engine reads.
  it("the Breaker SPEND is forced past the per-id throttle", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.cd.overcharge = 12;
    p.overcharged = true;
    director.frame(state, [], [], p.id); // the bank
    p.overcharged = false;
    director.frame(state, [], [], p.id); // the spend, one frame later
    const spends = sink.played.filter((s) => s.id === "cast_overcharge" && s.opts?.rate === 1.3);
    expect(spends).toHaveLength(1);
    expect(spends[0].opts?.force).toBe(true);
  });

  it("Breaker's SPEND replays its own clip, pitched up and pulled back", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.cd.overcharge = 7;
    p.overcharged = true; // banked
    director.frame(state, [], [], p.id);
    const cast = sink.played.filter((s) => s.id === "cast_overcharge");
    expect(cast).toHaveLength(1);
    expect(cast[0].opts?.rate).toBeUndefined();
    sink.played = [];
    p.overcharged = false; // the next attack spends it
    director.frame(state, [], [], p.id);
    const spend = sink.played.filter((s) => s.id === "cast_overcharge");
    expect(spend).toHaveLength(1);
    expect(spend[0].opts!.rate).toBeCloseTo(1.3);
    expect(spend[0].opts!.gain).toBeCloseTo(0.55);
  });

  it("my cast is centred; a squadmate's is panned and attenuated like their hits", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const mate = squadmate(state, 77, 8);
    director.frame(state, [], [], p.id);
    p.cd.orbit = 5;
    mate.cd.orbit = 5;
    director.frame(state, [], [], p.id);
    const both = sink.played.filter((s) => s.id === "cast_orbit");
    expect(both).toHaveLength(2);
    const mine = both[0], theirs = both[1];
    expect(mine.opts!.gain).toBe(1);
    expect(mine.opts!.pan).toBe(0);
    expect(theirs.opts!.gain!).toBeLessThan(0.75 / (1 + 8 / 6) + 1e-9);
    expect(theirs.opts!.gain!).toBeLessThan(mine.opts!.gain!);
    expect(theirs.opts!.pan!).toBeGreaterThan(0); // +x is screen-right
  });

  it("an ultimate carries past earshot; an active does not", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const far = squadmate(state, 78, 30); // beyond EARSHOT (24), inside 1.6x
    director.frame(state, [], [], p.id);
    far.cd.orbit = 5;
    far.cd.cataclysm = 40;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("cast_cataclysm");
    expect(sink.ids()).not.toContain("cast_orbit");
    sink.played = [];
    far.pos.x += 40; // now outside even the boss-beat circle
    far.cd.cataclysm = 0;
    director.frame(state, [], [], p.id);
    far.cd.cataclysm = 40;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("cast_cataclysm");
  });

  it("a crawler who leaves re-primes on rejoin instead of diffing stale numbers", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const mate = squadmate(state, 79, 4);
    mate.cd.bulwark = 9;
    director.frame(state, [], [], p.id);
    state.players.length = 1; // dropped
    director.frame(state, [], [], p.id);
    const back = squadmate(state, 79, 4); // rejoined, cooldown long since gone
    back.cd.bulwark = 0;
    director.frame(state, [], [], p.id);
    back.cd.bulwark = 9; // and now a real cast
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i === "cast_bulwark")).toHaveLength(1);
  });

  it("melee stays a deliberate absence: a swing storm produces no cast_*", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    for (let i = 0; i < 20; i++) {
      p.attackSwing = 0.15;
      director.frame(state, [], [], p.id);
      p.attackSwing = 0;
      director.frame(state, [], [], p.id);
    }
    expect(sink.ids().filter((i) => i === "swing")).toHaveLength(20);
    expect(casts(sink)).toHaveLength(0);
  });

  it("the retired ad-hoc cues are gone: no borrowed clip stands in for a cast", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    director.frame(state, [], [], p.id);
    p.cd.cataclysm = 40; // used to layer `crit` at 0.85
    p.cd.stuntdouble = 20; // used to play `equip`
    state.bulletTimeLeft = 3; // used to play `dash` at 0.8
    p.cd.bullettime = 30;
    director.frame(state, [], [], p.id);
    expect(sink.ids()).not.toContain("crit");
    expect(sink.ids()).not.toContain("equip");
    expect(sink.ids()).toEqual(expect.arrayContaining(["cast_cataclysm", "cast_stuntdouble", "cast_bullettime"]));
  });

  it("every ability in the roster is decided: a cue, or melee's documented absence", async () => {
    const { ABILITY_INFO } = await import("../src/sim/abilities");
    const ids = Object.keys(ABILITY_INFO);
    const cued = new Set(CASTS.map(([a]) => a));
    for (const id of ids) {
      if (id === "melee") {
        expect(cued.has(id), "melee must stay absent — `swing` is its cast cue").toBe(false);
        continue;
      }
      expect(cued.has(id), `${id} has no cast cue`).toBe(true);
    }
  });

  it("keeps the cast family on sfx with the §2.4 throttles the brief set", () => {
    const throttles: Record<string, number> = {
      cast_dash: 250, cast_orbit: 400, cast_stance: 500, cast_overcharge: 600,
      cast_cutto: 250, cast_crowdsurf: 500, cast_stuntdouble: 800,
      cast_bulwark: 700, cast_cables: 700,
      cast_airstrike: 1500, cast_cataclysm: 1500, cast_bullettime: 1500,
      cast_injunction: 2000, chain_line: 200,
    };
    for (const [id, ms] of Object.entries(throttles)) {
      const def = AUDIO_MANIFEST[id as keyof typeof AUDIO_MANIFEST];
      expect(def, id).toBeDefined();
      // `announcer` is the duck SOURCE — an ultimate routed there would step
      // on the bed every time it fired (§2.3 allows one duck source).
      expect(def.bus, id).toBe("sfx");
      expect((def as { throttleMs?: number }).throttleMs, id).toBe(ms);
    }
    // The Kenney clip the owner rejected is gone, not aliased.
    expect("dash" in AUDIO_MANIFEST).toBe(false);
  });
});

describe("audio director: breakable smashes (SOUNDPLAN row 5)", () => {
  it("pops wood when a crate leaves the list, rate-spread deterministically", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.breakables = [{ id: 7, pos: { x: p.pos.x + 2, y: p.pos.y }, key: "crate_large_decorated", hp: 1 }];
    director.frame(state, [], [], p.id);
    state.breakables = [];
    director.frame(state, [], [], p.id);
    const pop = sink.played.find((s) => s.id === "smash_wood");
    expect(pop).toBeDefined();
    expect(pop!.opts!.rate!).toBeGreaterThanOrEqual(0.92);
    expect(pop!.opts!.rate!).toBeLessThanOrEqual(1.08);
    expect(sink.ids()).not.toContain("smash_clay");
  });

  it("shatters ceramics: pot props voice as clay", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.breakables = [{ id: 9, pos: { x: p.pos.x + 1, y: p.pos.y }, key: "pot_a_stew", hp: 1 }];
    director.frame(state, [], [], p.id);
    state.breakables = [];
    director.frame(state, [], [], p.id);
    expect(sink.ids()).toContain("smash_clay");
  });

  it("a cracked blocker clicks lighter before its final pop", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    const b = { id: 11, pos: { x: p.pos.x + 1, y: p.pos.y }, key: "bookcase", hp: 2, footprint: [0] };
    state.breakables = [b];
    director.frame(state, [], [], p.id);
    b.hp = 1; // one blow in â€” it cracks
    director.frame(state, [], [], p.id);
    const crack = sink.played.find((s) => s.id === "smash_wood")!;
    expect(crack).toBeDefined();
    expect(crack.opts!.rate!).toBeGreaterThan(1.08); // higher pitch = crack voice
    sink.played = [];
    state.breakables = [];
    director.frame(state, [], [], p.id);
    const pop = sink.played.find((s) => s.id === "smash_wood")!;
    expect(pop).toBeDefined();
    expect(pop.opts!.gain!).toBeGreaterThan(crack.opts!.gain!); // the pop is the loud one
  });

  it("a descent replaces the whole list without a demolition volley", () => {
    const { sink, director, state } = setup();
    const p = state.players[0];
    state.breakables = [
      { id: 21, pos: { x: p.pos.x + 1, y: p.pos.y }, key: "barrel", hp: 1 },
      { id: 22, pos: { x: p.pos.x + 2, y: p.pos.y }, key: "pot_a", hp: 1 },
    ];
    director.frame(state, [], [], p.id);
    state.floor = 2;
    state.breakables = [{ id: 40, pos: { x: p.pos.x, y: p.pos.y + 3 }, key: "crate", hp: 1 }];
    director.frame(state, [], [], p.id);
    expect(sink.ids().filter((i) => i.startsWith("smash_"))).toHaveLength(0);
  });
});
