import { describe, it, expect, vi, afterEach } from "vitest";
import { MusicDeckPool } from "../src/audio/deck";
import type { SoundId } from "../src/audio/manifest";

// ===========================================================================
// THE STREAMING MUSIC PATH (src/audio/deck.ts — the half of audio r2 that
// decides whether the game has music at all).
//
// The r2 critics' sharpest finding was not a defect, it was an ABSENCE: ~530
// lines of new engine-critical code shipped with zero tests, in a repo with
// 1276 of them, while MusicDeck takes its AudioContext and its destination by
// CONSTRUCTOR INJECTION and is therefore trivially testable against a stub.
// Every case below is a failure mode that shipped unrun, and every one of them
// is a mode the decoded path could not reach — there, has() was
// `buffers.has(id)`, so a bed either had a decoded buffer or was never asked
// for. Streaming is what put "claimed but silent" into the state space.
//
// No jsdom and no real AudioContext. A GainNode is an object with a `gain`
// that records ramps; an HTMLAudioElement is an EventTarget with a `src`.
// That is the whole surface MusicDeck touches.
// ===========================================================================

class StubParam {
  value = 0;
  ramps: { to: number; at: number }[] = [];
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void { this.value = v; }
  linearRampToValueAtTime(v: number, at: number): void { this.ramps.push({ to: v, at }); this.value = v; }
  setTargetAtTime(): void {}
}
class StubGain {
  gain = new StubParam();
  connect(): void {}
}
/** Only what MusicDeck asks of a context. */
class StubCtx {
  currentTime = 0;
  sources: unknown[] = [];
  createGain(): StubGain { return new StubGain(); }
  createMediaElementSource(el: unknown): { connect: () => void } {
    // The real constraint this stands in for: a second call for the same
    // element THROWS, which is why decks are permanent and the `src` swaps.
    if (this.sources.includes(el)) throw new Error("InvalidStateError");
    this.sources.push(el);
    return { connect: () => {} };
  }
}

/** A media element that plays, stalls, is blocked, or fails on command. */
class StubAudio extends EventTarget {
  static made: StubAudio[] = [];
  src = "";
  preload = "none";
  loop = false;
  crossOrigin: string | null = null;
  currentTime = 0;
  paused = true;
  error: { code: number } | null = null;
  playCalls = 0;
  /** What the next play() promise does. */
  mode: "ok" | "blocked" | "broken" = "ok";
  buffered = { length: 0, start: (): number => 0, end: (): number => 0 };
  constructor() { super(); StubAudio.made.push(this); }
  getAttribute(k: string): string | null { return k === "src" ? (this.src || null) : null; }
  removeAttribute(k: string): void { if (k === "src") this.src = ""; }
  load(): void {}
  pause(): void { this.paused = true; }
  play(): Promise<void> {
    this.playCalls++;
    if (this.mode === "blocked") return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    if (this.mode === "broken") return Promise.reject(Object.assign(new Error("nope"), { name: "NotSupportedError" }));
    this.paused = false;
    return Promise.resolve();
  }
  /** The element reaches `playing` — the only thing that ramps a deck in. */
  speak(): void { this.paused = false; this.dispatchEvent(new Event("playing")); }
  /** The element fails. code 1 = MEDIA_ERR_ABORTED = WE swapped the src. */
  breakWith(code = 4): void { this.error = { code }; this.dispatchEvent(new Event("error")); }
}

function harness(count = 3, mode: StubAudio["mode"] = "ok") {
  StubAudio.made = [];
  (globalThis as unknown as { Audio: unknown }).Audio = StubAudio;
  // The elements are constructed inside the pool, so the mode has to be set
  // via the prototype default before construction for the reject cases.
  const ctx = new StubCtx();
  const pool = new MusicDeckPool(ctx as unknown as AudioContext, new StubGain() as unknown as AudioNode, count);
  for (const el of StubAudio.made) el.mode = mode;
  return { ctx, pool, els: StubAudio.made };
}

const claim = { volume: 0.5, loop: true, fade: 1.2, onError: (): void => {} };

describe("MusicDeck: the failure modes streaming introduced", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a failed bed FREES its deck — the leak that permanently emptied the pool", () => {
    // The first r2 cut left freeing to the engine's onError callback, which
    // added the id to streamBad and nulled `this.current` — the only handle to
    // that deck's release(). `busy` stayed true forever (id set, releasing
    // false), so three bed failures over a session exhausted a 3-deck pool and
    // the game went silent for the rest of the run with no recovery path,
    // INCLUDING the music_dungeon fallback the whole demotion mechanism
    // exists to reach.
    const { pool, els } = harness(3);
    let demoted = 0;
    for (const id of ["music_battle_a", "music_battle_b", "music_battle_c"] as SoundId[]) {
      expect(pool.claim(id, "/audio/music/x.ogg", { ...claim, onError: () => { demoted++; } }), id).not.toBeNull();
    }
    for (const el of els) el.breakWith(4);
    expect(demoted).toBe(3);
    expect(pool.claim("music_dungeon" as SoundId, "/audio/music/dungeon.ogg", claim)).not.toBeNull();
    expect(pool.active()).toEqual(["music_dungeon"]);
  });

  it("MEDIA_ERR_ABORTED is OUR src swap, not a bad file", () => {
    // Demoting on every swap would walk the whole soundtrack down to
    // music_dungeon over the course of one run.
    const { pool, els } = harness(1);
    let demoted = 0;
    pool.claim("music_safe" as SoundId, "/a.ogg", { ...claim, onError: () => { demoted++; } });
    els[0].breakWith(1);
    expect(demoted).toBe(0);
    expect(pool.active()).toEqual(["music_safe"]);
  });

  it("a bed that never reaches `playing` is demoted by the watchdog", () => {
    // The deck used to listen to exactly two events. A stalled fetch fires
    // `stalled`/`waiting` and never `error`, so the id was never demoted, the
    // gain stayed pinned at 0 from claim(), and engine.music()'s identity
    // check meant the director never re-asked: permanent silence that every
    // debug hook reported as healthy music.
    vi.useFakeTimers();
    const { pool } = harness(1);
    let demoted = false;
    pool.claim("music_band_ironworks" as SoundId, "/a.ogg", { ...claim, onError: () => { demoted = true; } });
    vi.advanceTimersByTime(11_000);
    expect(demoted).toBe(false); // still inside the budget for a cold 3.4MB bed
    vi.advanceTimersByTime(2_000);
    expect(demoted).toBe(true);
    expect(pool.claim("music_dungeon" as SoundId, "/b.ogg", claim)).not.toBeNull();
  });

  it("a bed that DOES speak cancels its own watchdog", () => {
    vi.useFakeTimers();
    const { pool, els } = harness(1);
    let demoted = false;
    pool.claim("music_menu" as SoundId, "/a.ogg", { ...claim, onError: () => { demoted = true; } });
    els[0].speak();
    vi.advanceTimersByTime(60_000);
    expect(demoted).toBe(false);
  });

  it("waiting for a user gesture is NOT a stall", async () => {
    // Otherwise every un-clicked page demotes its bed after 12s and arrives at
    // music_dungeon by the time the player presses anything.
    vi.useFakeTimers();
    const { pool, els } = harness(1, "blocked");
    let demoted = false;
    pool.claim("music_menu" as SoundId, "/a.ogg", { ...claim, onError: () => { demoted = true; } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(demoted).toBe(false);
    expect(pool.active()).toEqual(["music_menu"]);
    // ...and the gesture re-arms it: from here on, silence means broken.
    els[0].mode = "ok";
    pool.unlock();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(demoted).toBe(true);
  });

  it("a play() rejection that is NOT the autoplay policy demotes the bed", async () => {
    // NotSupportedError (undecodable) resolves nowhere on some paths and never
    // fires `error`; the first cut swallowed every rejection identically.
    vi.useFakeTimers();
    const { pool } = harness(1, "broken");
    let demoted = false;
    pool.claim("music_collapse" as SoundId, "/a.ogg", { ...claim, onError: () => { demoted = true; } });
    await vi.advanceTimersByTimeAsync(0);
    expect(demoted).toBe(true);
  });

  it("a claimed deck is not a PLAYING deck until the element says so", () => {
    const { pool, els } = harness(1);
    const deck = pool.claim("music_safe" as SoundId, "/a.ogg", claim)!;
    expect(deck.playing).toBe(false);
    els[0].speak();
    expect(deck.playing).toBe(true);
  });

  it("streams() still names a bed that is fading out; started() does not", () => {
    // A releasing deck is audible for another 1.2s. The first cut's active()
    // filtered on `id !== null` and went blind for exactly that window.
    const { pool, els } = harness(1);
    const deck = pool.claim("music_battle_a" as SoundId, "/a.ogg", claim)!;
    els[0].speak();
    expect(pool.started()).toEqual(["music_battle_a"]);
    deck.release(1.2);
    expect(pool.active()).toEqual(["music_battle_a"]);
    expect(pool.started()).toEqual([]);
  });

  it("the hand-off fires only when the incoming deck actually speaks", () => {
    // This is what turns two decoupled ramps back into a crossfade: the engine
    // holds the outgoing bed until this callback runs.
    const { pool, els } = harness(1);
    let handed = 0;
    pool.claim("music_band_garden" as SoundId, "/a.ogg", { ...claim, onStart: () => { handed++; } });
    expect(handed).toBe(0); // still fetching — the outgoing bed must keep playing
    els[0].speak();
    expect(handed).toBe(1);
  });

  it("a released deck frees itself after the fade and can be re-claimed", () => {
    vi.useFakeTimers();
    const { pool, els } = harness(1);
    const deck = pool.claim("music_battle_a" as SoundId, "/a.ogg", claim)!;
    els[0].speak();
    deck.release(1.2);
    expect(pool.claim("music_safe" as SoundId, "/b.ogg", claim)).toBeNull(); // still fading
    vi.advanceTimersByTime(1_300);
    expect(pool.active()).toEqual([]);
    expect(pool.claim("music_safe" as SoundId, "/b.ogg", claim)).not.toBeNull();
  });

  it("a full pool returns null rather than stealing a fading deck", () => {
    const { pool } = harness(2);
    expect(pool.claim("music_battle_a" as SoundId, "/a.ogg", claim)).not.toBeNull();
    expect(pool.claim("music_battle_b" as SoundId, "/b.ogg", claim)).not.toBeNull();
    expect(pool.claim("music_battle_c" as SoundId, "/c.ogg", claim)).toBeNull();
  });

  it("each deck gets its OWN element — createMediaElementSource throws twice", () => {
    // The constraint that forced the whole deck design. The stub throws like
    // the real API, so a regression that reused an element fails here.
    const { pool, els } = harness(3);
    expect(els).toHaveLength(3);
    expect(new Set(els).size).toBe(3);
    expect(pool.active()).toEqual([]);
  });
});
