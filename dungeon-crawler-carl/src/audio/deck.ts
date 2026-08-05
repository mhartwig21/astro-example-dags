import type { SoundId } from "./manifest";

// MUSIC DECKS — the streaming half of the engine (audio r2, the music-loading
// fix). Measured problem: engine.load() decoded EVERY manifest entry into an
// AudioBuffer at boot. The music family is 16 files / 22.0MB on disk / 1625.3s
// of audio, and decodeAudioData resamples to the context rate, so those 16
// files cost 1625.3s x 48000 x 2ch x 4 bytes = ~624MB of resident Float32 PCM
// for the whole session (battle_winter alone: 262.45s = 100.8MB). Every SFX
// clip on disk together is 76.16 channel-seconds = 14.6MB decoded — the entire
// eager path costs less than one boss bed, which is why SFX keeps it: cast
// latency is that path's whole justification.
//
// So music streams from HTMLAudioElements instead. Three constraints shaped
// this file:
//
//  1. createMediaElementSource() THROWS on a second call for the same element,
//     so the node must be permanent and the `src` is what swaps. Hence decks
//     (element + node + gain, long-lived) rather than one element per bed.
//  2. THREE decks, not two: outgoing bed + incoming bed + headroom for a
//     release still fading when the next swap arrives (the director can flip
//     battle<->ambient every BATTLE_LINGER=6s, and the fade is 1.2s).
//  3. The fade-in must start when the deck actually PRODUCES audio (the
//     `playing` event), not when it was asked for. A buffer source is audible
//     the instant it starts; a media element has a fetch in front of it, and
//     ramping at request time makes a slow first fetch arrive part-way up the
//     1.2s crossfade — i.e. a bed that fades in from half volume.
//     THE OTHER HALF OF THAT (r2 fix round): if only the fade-IN waits for
//     `playing`, the 1.2s crossfade stops being a crossfade and becomes two
//     decoupled ramps — outgoing gone at t=1.2s, incoming starting at
//     t=fetch-latency, and a HOLE in between at every first-entry band change
//     on a cold cache. The engine therefore holds the outgoing bed until this
//     deck reports `playing` (see `onStart` and engine.music()'s hand-off).
//     That was presented as a correctness fix in the first cut; it was half a
//     fix, and the missing half was the round's most audible cost.
//
//  4. A media element can fail in ways a decoded buffer cannot, and MOST of
//     them are not the `error` event. A stalled fetch fires `stalled`/
//     `waiting`; a dropped connection mid-bed fires neither on some paths; a
//     play() rejected for anything other than autoplay policy resolves
//     nowhere. Every one of those parks a deck at gain 0 while the engine
//     reports healthy music. Hence WATCHDOG_MS: if a claimed deck has not
//     produced audio by then, and it is not merely waiting for a user
//     gesture, it is treated exactly like a 404.
//
// Everything downstream is untouched: the deck gain lands on buses.music, so
// the 1.2s crossfade, the -6dB announcer sidechain and the 0.22 APPROACH duck
// all still work on exactly the nodes they worked on before.
//
// LOOPING is the one honest risk here and it is deliberately NOT hidden.
// AudioBufferSourceNode.loop is sample-accurate; HTMLMediaElement.loop is a
// decoder seek-to-zero and MAY gap. This file ships rung 1 of the ladder —
// native el.loop — because rungs 2 and 3 are chosen BY MEASUREMENT (the
// ?debug=1 music meter in engine.ts reports the longest silent run across a
// wrap) and nobody has run that measurement yet. If a bed measures a gap:
// rung 2 is a ping-pong crossfade across two decks (the pool already has the
// spare deck for it, and beds are loop-folded so end/start are level-matched
// by construction — that IS the 0.1-1.5dB seam number in SOUNDPLAN §3);
// rung 3 is dropping that ONE id back to the decoded path via `stream: false`
// in the manifest. Do not write rung 2 speculatively — measure first.

/**
 * How long a claimed deck may stay silent before it counts as dead.
 * 12s is chosen against the worst SHIPPED case rather than a round number:
 * the largest bed is 3.4MB over a plain 200 with no range support
 * (gameServer.ts serveStatic), which is ~10s on a 3Mbit link — and the
 * element only needs enough buffered to fire `playing`, not the whole file.
 * A deck waiting on a user gesture is NOT counted (see armWatchdog).
 */
const WATCHDOG_MS = 12000;

/** How a claimed deck should behave for one bed. */
export interface DeckClaim {
  /** The bed's manifest volume — the fade-in's target, not a bus level. */
  volume: number;
  loop: boolean;
  /** Crossfade seconds (engine's FADE = 1.2, the shipped bed-swap time). */
  fade: number;
  /** The element failed (404 / undecodable / tainted / stalled past the
   *  watchdog). The deck has ALREADY freed itself by the time this runs —
   *  the engine only has to demote the id so has() reports it unavailable and
   *  the director's very next frame falls back to music_dungeon. */
  onError: () => void;
  /** This deck is actually producing audio. The engine uses it to release the
   *  bed being replaced, so the crossfade is a crossfade and not a hole. */
  onStart?: () => void;
}

/** One element + its permanent source node + its gain. */
export class MusicDeck {
  private readonly el: HTMLAudioElement;
  private readonly gain: GainNode;
  /** The bed this deck is carrying — held through the release fade and
   *  cleared only in teardown(), so streams() can still name a bed that is
   *  audibly fading out. A deck the pool would hand out is never named here. */
  id: SoundId | null = null;
  /** True from release() until its timer completes. Kept as a separate flag
   *  from `id` so `busy` and `playing` can disagree: a releasing deck is still
   *  making sound and must not be re-claimed. */
  private releasing = false;
  private want = false; // we asked for playback (retried on unlock)
  private started = false; // the element has produced audio for this claim
  private volume = 1;
  private fade = 1.2;
  private onError: (() => void) | null = null;
  private onStart: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: AudioContext, dest: AudioNode) {
    this.el = new Audio();
    // `none` until a bed is actually claimed: the whole point of this round is
    // that music costs nothing until it is wanted.
    this.el.preload = "none";
    // Same-origin in every deployment we ship, but an untagged element that
    // ever DID load cross-origin feeds SILENCE through a MediaElementSource
    // (the tainted-media rule) — which would look exactly like a working game
    // with no music. Tag it so the failure is a CORS error we can see instead.
    this.el.crossOrigin = "anonymous";
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    // Permanent — see constraint 1 at the top of this file.
    this.ctx.createMediaElementSource(this.el).connect(this.gain);
    this.gain.connect(dest);
    this.el.addEventListener("playing", () => this.rampIn());
    this.el.addEventListener("error", () => {
      // MEDIA_ERR_ABORTED (1) means WE replaced the src (a bed swap, or the
      // unlock prime being taken over by a real claim) — not that the file is
      // bad. Demoting a perfectly good bed on every swap would walk the whole
      // soundtrack down to music_dungeon over a run.
      if (this.el.error?.code === 1) return;
      this.fail();
    });
  }

  /** A deck the pool must not hand out: carrying a bed, or fading one out. */
  get busy(): boolean {
    return this.id !== null || this.releasing;
  }

  /** Has this deck actually produced audio for its current claim? Distinct
   *  from busy: a claimed-but-silent deck is exactly the state the watchdog
   *  and the crossfade hand-off exist to reason about. */
  get playing(): boolean {
    return this.started && this.id !== null;
  }

  /**
   * Seconds of media this element has buffered ahead. The streamed path's
   * memory lives HERE — in the element's own decode-ahead and network buffers
   * — and residentPcmBytes() (which walks AudioBuffers) is structurally blind
   * to it. Reported through debugHook.streamedBufferedSec() so the round's
   * memory claim is at least measured on both legs rather than proven by the
   * absence of a decodeAudioData call.
   */
  bufferedSec(): number {
    try {
      const b = this.el.buffered;
      let total = 0;
      for (let i = 0; i < b.length; i++) total += b.end(i) - b.start(i);
      return total;
    } catch {
      return 0; // element torn down mid-read
    }
  }

  /**
   * THE FAILURE PATH, and it frees the deck FIRST.
   *
   * The first r2 cut left this to the engine's onError callback, which added
   * the id to streamBad and nulled `this.current` — discarding the only handle
   * to this deck's release(). `busy` stayed true forever (id set, releasing
   * false), so three bed failures over a session exhausted a 3-deck pool
   * permanently and the game went silent for the rest of the run WITH NO
   * RECOVERY PATH, including the music_dungeon fallback the whole demotion
   * mechanism exists to reach. The deck now tears itself down before the
   * callback runs, so the engine cannot fail to free it.
   */
  private fail(): void {
    const cb = this.onError;
    // Released/idle decks clear onError before tearing down src, because the
    // teardown itself (load() with no src) legitimately fires `error`.
    if (!cb) return;
    this.onError = null;
    this.onStart = null;
    this.want = false;
    this.clearTimer();
    this.clearWatchdog();
    this.teardown();
    cb();
  }

  /** Start (or restart) the silence watchdog — see constraint 4 up top. */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.started) this.fail();
    }, WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Point this deck at a bed and start it (or queue it behind the unlock). */
  claim(id: SoundId, url: string, opts: DeckClaim): void {
    this.id = id;
    this.volume = opts.volume;
    this.fade = opts.fade;
    this.onError = opts.onError;
    this.onStart = opts.onStart ?? null;
    this.releasing = false;
    this.started = false;
    this.clearTimer();
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(0, t);
    this.el.loop = opts.loop;
    this.el.preload = "auto";
    this.el.src = url;
    try {
      this.el.currentTime = 0;
    } catch {
      // Not seekable yet (no metadata): a fresh src already starts at 0.
    }
    this.want = true;
    this.armWatchdog();
    this.tryPlay();
  }

  /** Fade out over `fade`, then pause and free the deck. The +0.05s mirrors
   *  the buffered path's src.stop(now + FADE + 0.05) exactly.
   *  `id` deliberately survives the fade (cleared in teardown) so streams()
   *  can name a bed that is still audible — the first cut's active() filtered
   *  on `id !== null` and went blind for the 1.2s a bed spends fading out. */
  release(fade: number): void {
    this.want = false;
    this.releasing = true;
    this.started = false;
    this.onStart = null;
    this.clearWatchdog();
    const t = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.teardown();
    }, (fade + 0.05) * 1000);
  }

  /** First user gesture: retry anything the autoplay policy refused, and give
   *  every idle element one gesture-blessed play/pause. iOS historically
   *  requires a gesture PER ELEMENT before it will ever play one; this is the
   *  standard unlock, and it is a stated unknown — there is no iOS device on
   *  the dev box to verify it, so it is written to be harmless if unneeded. */
  unlock(): void {
    if (this.want) {
      // Re-arm: until this gesture the deck was BLOCKED, not stalled, and
      // tryPlay's NotAllowedError branch disarmed the watchdog for exactly
      // that reason. From here on, silence means something is wrong.
      this.armWatchdog();
      this.tryPlay();
      return;
    }
    if (this.el.getAttribute("src")) return; // mid-teardown; leave it alone
    this.el.src = SILENT_WAV;
    const p = this.el.play();
    // The pause must re-check: a play() promise settles a tick or two later,
    // and the director can claim this very deck in between (the gesture that
    // unlocks audio is often the same click that starts the run). Pausing
    // unconditionally here would stop the bed that just took the deck, and it
    // would present as "music silently never starts", once, on first click.
    if (p) void p.then(() => { if (!this.want && this.id === null) this.el.pause(); }).catch(() => undefined);
  }

  private tryPlay(): void {
    const p = this.el.play();
    if (!p) return;
    void p.catch((e: unknown) => {
      // NotAllowedError = autoplay policy (no gesture yet). unlock() retries;
      // `want` is the queue. Never surface this as an error: it is the normal
      // state of a page that has not been clicked — but DO disarm the
      // watchdog, or every un-clicked page would demote its bed after 12s.
      const name = (e as { name?: string } | null)?.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        // AbortError: our own src swap raced the pending play(). Harmless.
        if (name === "NotAllowedError") this.clearWatchdog();
        return;
      }
      // Anything else (NotSupportedError = undecodable, and the long tail)
      // never fires `error` on some paths and would otherwise park the deck
      // at gain 0 forever while the engine reported healthy music.
      this.fail();
    });
  }

  private rampIn(): void {
    this.clearWatchdog();
    if (!this.want) return; // released before the first frame of audio arrived
    this.started = true;
    const t = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.volume, t + this.fade);
    // The hand-off: only NOW is it safe to take the previous bed away.
    const cb = this.onStart;
    this.onStart = null;
    cb?.();
  }

  private teardown(): void {
    this.id = null;
    this.started = false;
    this.clearWatchdog();
    this.onError = null; // before the src goes: load() with no src fires error
    try {
      this.el.pause();
    } catch {
      /* already gone */
    }
    this.el.removeAttribute("src");
    this.el.preload = "none";
    try {
      this.el.load(); // the documented way to make the element drop its buffer
    } catch {
      /* best effort */
    }
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.releasing = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** 44-byte zero-sample WAV: the gesture-unlock payload (see MusicDeck.unlock). */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

export class MusicDeckPool {
  private readonly decks: MusicDeck[];

  constructor(ctx: AudioContext, dest: AudioNode, count = 3) {
    this.decks = Array.from({ length: count }, () => new MusicDeck(ctx, dest));
  }

  /** A free deck carrying `id`, or null if all three are busy (which would
   *  mean three swaps inside one 1.2s fade — the caller treats it as "not
   *  playable yet" and retries, rather than stealing a fading deck). */
  claim(id: SoundId, url: string, opts: DeckClaim): MusicDeck | null {
    const deck = this.decks.find((d) => !d.busy);
    if (!deck) return null;
    deck.claim(id, url, opts);
    return deck;
  }

  unlock(): void {
    for (const d of this.decks) d.unlock();
  }

  /** Bed ids currently held by a deck — debugHook.streams(), the streamed
   *  counterpart of buffers() now that no music id is ever in buffers().
   *  INCLUDES a deck mid-release: it is audible for another 1.2s, and an
   *  instrument that cannot see an audible bed is not an instrument. */
  active(): SoundId[] {
    return this.decks.map((d) => d.id).filter((id): id is SoundId => id !== null);
  }

  /** Bed ids that have actually produced audio — the honest "what is playing".
   *  A claimed deck that is still fetching, stalled or gesture-blocked appears
   *  in active() and NOT here, which is the distinction every music assertion
   *  in probe-beds.mjs was previously unable to make. */
  started(): SoundId[] {
    return this.decks.filter((d) => d.playing).map((d) => d.id!).filter(Boolean);
  }

  /** Total seconds of media buffered across all decks — where the streamed
   *  path's memory actually lives (MusicDeck.bufferedSec explains). */
  bufferedSec(): number {
    return this.decks.reduce((n, d) => n + d.bufferedSec(), 0);
  }
}
