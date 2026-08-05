import { AUDIO_MANIFEST, type SoundDef, type SoundId } from "./manifest";
import { MusicDeckPool, type MusicDeck } from "./deck";

// WebAudio playback engine. Silent-by-default: load() decodes whatever clips
// exist under public/audio/ and skips the rest, so play() on a missing sound is
// a no-op (same fallback philosophy as the glTF model loader). Handles the
// browser autoplay policy by resuming the context on the first user gesture.
//
// Graph: source -> per-play gain/pan -> bus gain (sfx/music/ui) -> master gain
// -> compressor -> destination. Mute/volume persist per browser.
//
// TWO SOURCE PATHS (audio r2 — the music-loading fix; see deck.ts for the
// measurements and the loop ladder):
//   SFX/UI/announcer  -> fetch + decodeAudioData at boot, kept as AudioBuffers.
//                        76.16 channel-seconds across 80 files = 14.6MB
//                        decoded. Stays eager: a cast cue that arrives after
//                        the cast is a bug, and that latency is this path's
//                        entire justification.
//   music (bus)       -> streamed through MusicDeckPool. Decoding the 16 music
//                        files cost ~624MB of resident Float32 PCM for the
//                        session (1625.3s x 48000 x 2ch x 4B) and 22.0MB of
//                        wire traffic INSIDE the boot card. Both are now
//                        on-demand.
// Everything between the source and the speakers is unchanged, on purpose:
// buses, the 1.2s crossfade, the announcer sidechain and the APPROACH duck all
// live downstream of the source and cannot tell the two paths apart.

export interface PlayOpts {
  gain?: number; // 0..1 multiplier on the sound's manifest volume
  pan?: number; // -1 (left) .. 1 (right)
  // BOSSES V2 §5.4: playback rate. Audio is the fastest telegraph channel we
  // have, and every boss needs its OWN signature sound — but the game ships
  // no new clips. Pitching the shared `tell` per boss (see BOSS_SIGNATURES in
  // render3d/bossSignatures.ts) gives 18 distinguishable tells out of one file.
  rate?: number;
  // Bypass the manifest's spam guard. Used only where the caller already
  // rate-limits (one boss beat per event) and the beat MUST be heard.
  force?: boolean;
}

/** What the AudioDirector needs — implemented by AudioEngine, faked in tests. */
export interface AudioSink {
  play(id: SoundId, opts?: PlayOpts): void;
  music(id: SoundId | null): void;
  // BULLET TIME: sweep a master low-pass so the whole mix goes underwater
  // while the world is slowed. Optional — test fakes and simple sinks skip it.
  muffle?(on: boolean): void;
  // BOSSES V2 §5.1 — THE APPROACH. The corridor into an arena ducks the bed
  // to a single drone: the fog reveal at the arena door is the last quiet
  // moment in the run, and it only lands if the music gets out of the way.
  // 1 = normal, 0 = silent. Optional, like muffle.
  duck?(level: number): void;
  // Music r1: is this clip PLAYABLE? The director uses it to fall back
  // per-band (a band bed that failed to load degrades to the generic dungeon
  // ambience instead of silence). Optional — sinks without it are treated as
  // having everything, which keeps the director's choice deterministic in
  // tests.
  //
  // Audio r2 widened the meaning from "decoded" to "playable", because under
  // streaming NO music id is ever decoded and a literal reading would report
  // every band bed missing — silently degrading the whole game to
  // music_dungeon, a regression the fake-sink tests cannot see. Streamed ids
  // are optimistically available and demoted on a real element error.
  has?(id: SoundId): boolean;
}

const STORE_KEY = "dcc:audio:v1";

// ---- Debug instrumentation (?debug=1 only — see SOUNDPLAN.md §5) ----------
// Nobody in the build loop can hear, so audio quality claims must be numbers.
// This hook is the in-game half of that: a ring of recent play() calls
// (including throttled attempts) plus running time-domain peaks measured at
// the compressor INPUT (headroom) and the compressor OUTPUT (hard clipping).
// tools/audio/probe.mjs drives a staged fight and asserts against it.

export interface PlayRecord {
  id: string;
  at: number; // performance.now() at trigger
  ctxAt: number; // AudioContext.currentTime at trigger
  gain: number; // effective gain (manifest volume x opts.gain)
  rate: number; // effective playback rate
  throttled?: boolean; // the spam guard swallowed this attempt (no sound)
  // The engine was unable to play at all (distinct from throttling): the
  // director DID fire — impact-sync analysis must not count these as misses.
  skipped?: "noctx" | "nobuf" | "muted" | "suspended";
}

export interface AudioDebugHook {
  /** Recent play attempts, oldest first (ring capped at 512). */
  plays: PlayRecord[];
  /** Running max |sample| at the compressor input since the last reset. */
  peakPre(): number;
  /** Running max |sample| at the compressor output (the honest clip test). */
  peakPost(): number;
  resetPeaks(): void;
  /** Decoded clip ids (missing files never appear here).
   *  AUDIO R2 — MEANING CHANGED: music ids no longer appear here, because
   *  music streams and is never decoded. Anything asserting "buffers() lists
   *  the beds" is now wrong by construction; use streams(). */
  buffers(): string[];
  /** Bed ids currently held by a streaming deck, INCLUDING one mid-release
   *  (audible for another 1.2s) — the music-side counterpart of buffers().
   *  Empty in ?audio=buffered mode (everything is a buffer). */
  streams(): string[];
  /** Bed ids that have actually produced audio. `streams()` says what was
   *  CLAIMED; this says what is SOUNDING, and the gap between them is the
   *  entire failure class streaming introduced. */
  streamsStarted(): string[];
  /** Seconds of media buffered across the decks — where the streamed path's
   *  memory now lives. residentPcmBytes() is structurally blind to it. */
  streamedBufferedSec(): number;
  /**
   * Resident decoded PCM in bytes: the sum of length * channels * 4 over the
   * live AudioBuffers.
   *
   * READ THIS BEFORE QUOTING IT. On the streamed leg this number is
   * SELF-FULFILLING: load() is coded never to put a music id into
   * `this.buffers`, so it cannot report anything but a low number unless the
   * skip itself is broken. It proves "we did not call decodeAudioData", which
   * is also obvious from reading load(). It does NOT prove process memory
   * went down, and it is blind to the media elements' own decode-ahead and
   * network buffers (see streamedBufferedSec).
   *
   * What it IS good for is the A/B: run the same probe on ?audio=buffered and
   * on the default, and the difference between the two legs is real, because
   * the buffered leg genuinely allocates every bed. That comparison — not the
   * streamed number alone — is the claim. A process-level measurement
   * (performance.measureUserAgentSpecificMemory, or the CDP Memory domain) is
   * the honest instrument and NOBODY HAS RUN ONE; until someone does, "620MB
   * → under 20MB" is a decode-side arithmetic claim, not a measured one.
   */
  residentPcmBytes(): number;
  /** Running RMS at the music bus since the last resetMusicMeters().
   *  Streaming makes this necessary: currentMusic() proves only that the
   *  director ASKED for a bed — a 404ing, stalled or CORS-tainted deck
   *  satisfies it while the game plays in silence. */
  musicEnergy(): number;
  /** Loop-seam instrument (?debug=1): the longest run of |x| < 1e-4 and the
   *  peak seen on the music path since the last reset, measured on contiguous
   *  128-sample blocks by an AudioWorklet. An AnalyserNode polled per rAF
   *  gives 43ms windows and CANNOT resolve a 10ms loop gap; this can.
   *  null = the worklet could not be installed, which means the loop claim is
   *  UNPROVEN, not passed. */
  musicSeam(): { longestSilentMs: number; peak: number } | null;
  resetMusicMeters(): void;
  currentMusic(): string | null;
  musicBusGain(): number;
  /** The announcer sidechain's current music/sfx duck gains (§2.3 probe). */
  musicDuckGain(): number;
  sfxDuckGain(): number;
  /** Fire a clip on demand (probe-only: the §5 duck test needs a stinger
   *  at a knowable instant, not whenever the sim next announces). */
  trigger(id: SoundId, opts?: PlayOpts): void;
  ctxState(): string;
  ctxTime(): number;
}

interface AudioPrefs {
  muted: boolean;
  volume: number;
}

function loadPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AudioPrefs>;
      return {
        muted: p.muted === true,
        volume: typeof p.volume === "number" ? Math.min(1, Math.max(0, p.volume)) : 0.8,
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { muted: false, volume: 0.8 };
}

export class AudioEngine implements AudioSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muffleNode: BiquadFilterNode | null = null;
  private buses: Partial<Record<"sfx" | "music" | "ui" | "announcer", GainNode>> = {};
  // §2.3 sidechain: announcer plays ride these down (music -6dB, sfx -3dB,
  // 80ms attack / 600ms release). Separate nodes from the bus gains so the
  // APPROACH duck (which owns buses.music.gain) and the sidechain never
  // fight over one AudioParam's schedule.
  private duckMusic: GainNode | null = null;
  private duckSfx: GainNode | null = null;
  private duckReleaseAt = 0; // ctx-time the current announcer duck lets go
  private approachLevel = 1; // last director duck() level (the tie rule)
  private buffers = new Map<SoundId, AudioBuffer>();
  private lastPlayed = new Map<SoundId, number>();
  // `release` is the path-agnostic stop: the buffered path ramps its per-play
  // gain and src.stop()s, the streamed path ramps the deck gain and pauses.
  // Callers only ever want "take the current bed away over FADE seconds".
  private current: { id: SoundId; release: (fade: number) => void } | null = null;
  // THE BED BEING REPLACED, still audible while the incoming one buffers.
  // Streaming needs this and the buffered path never did: a buffer source is
  // audible the instant start() runs, so "release the old, start the new" WAS
  // a crossfade. A media element has a network fetch in front of it, and the
  // first r2 cut kept the release-at-request-time half — outgoing gone at
  // t=1.2s, incoming arriving at t=fetch-latency, a hole at every first-entry
  // band change on a cold cache. At most one bed is held (see music()).
  private outgoing: { id: SoundId; release: (fade: number) => void } | null = null;
  private pendingMusic: SoundId | null = null; // requested before unlock/decode
  private decks: MusicDeckPool | null = null;
  // Streamed ids whose element reported an error (404 / undecodable / tainted).
  // Availability is OPTIMISTIC with error-driven demotion: has() reports a
  // streamed id available until it actually fails, and the director's next
  // frame re-asks and falls back to music_dungeon on its own. The rejected
  // alternative was a HEAD sweep at load() to make has() honest before first
  // use — 16 extra round trips on EVERY boot to be correct about a state that
  // only exists when someone deletes a shipped file.
  private streamBad = new Set<SoundId>();
  // ?audio=buffered — forces the pre-r2 all-decoded path. This is both the A/B
  // instrument for the memory proof (the baseline leg reads ~6.2e8 resident
  // PCM, the streamed leg must read < 2.0e7) and the one-URL rollback if a
  // bed's loop turns out unacceptable in the wild.
  private readonly forceBuffered: boolean;
  private prefs = loadPrefs();
  private compressor: DynamicsCompressorNode | null = null;
  private dbg: {
    plays: PlayRecord[];
    peakPre: number;
    peakPost: number;
    anPre: AnalyserNode | null;
    anPost: AnalyserNode | null;
    buf: Float32Array<ArrayBuffer>;
    // Music-path meters (see AudioDebugHook.musicEnergy/musicSeam).
    meter: AudioWorkletNode | null;
    seam: { longestSilentMs: number; peak: number; rms: number } | null;
    anMusic: AnalyserNode | null; // energy fallback when the worklet won't load
    energy: number;
  } | null = null;

  constructor(opts: { forceBuffered?: boolean } = {}) {
    this.forceBuffered =
      opts.forceBuffered ??
      (typeof location !== "undefined" && new URLSearchParams(location.search).get("audio") === "buffered");
  }

  /** Does this id stream instead of decoding? The rule is the BUS, not a
   *  per-clip opinion: music streams, everything else stays eager (deck.ts
   *  explains why the SFX side is not worth streaming). A future manifest may
   *  carry an explicit per-entry `stream` flag — loop-ladder rung 3 is one bed
   *  opting back into sample-accurate looping with `stream: false` — so an
   *  explicit flag wins if present. Streaming needs a media element; without
   *  one (jsdom, exotic hosts) fall back to the decoded path. */
  private streamed(id: SoundId): boolean {
    if (this.forceBuffered || typeof Audio === "undefined") return false;
    const def: SoundDef = AUDIO_MANIFEST[id];
    return def.stream ?? def.bus === "music";
  }

  /** Fetch + decode every NON-STREAMED manifest clip that exists; missing files
   * stay silent. Streamed ids (music) are not touched here at all — not
   * fetched, not decoded, not HEADed: their whole point is that they cost
   * nothing until the director wants them.
   * onProgress still reports EVERY id as settled so the boot bar stays honest
   * about what it is counting (main3d.ts weights this at a share of the boot
   * card; that weight is now wrong in the other direction — see the report). */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const ids = Object.keys(AUDIO_MANIFEST) as SoundId[];
    const ctx = this.ensureContext();
    if (!ctx) { onProgress?.(ids.length, ids.length); return; } // no WebAudio: stay silent
    let settled = 0;
    await Promise.all(
      ids.map(async (id) => {
        if (this.streamed(id)) { onProgress?.(++settled, ids.length); return; }
        try {
          const res = await fetch(AUDIO_MANIFEST[id].url);
          if (!res.ok) return;
          const data = await res.arrayBuffer();
          this.buffers.set(id, await ctx.decodeAudioData(data));
        } catch {
          // Absent or undecodable — leave it out; play() no-ops.
        } finally {
          onProgress?.(++settled, ids.length);
        }
      }),
    );
    // Music requested while clips were still decoding starts now. Streaming
    // removes the "requested while still decoding" case entirely (a deck can
    // be claimed the instant it is asked for), so in practice this now only
    // catches a bed asked for before the context existed.
    if (this.pendingMusic && this.has(this.pendingMusic)) {
      const id = this.pendingMusic;
      this.pendingMusic = null;
      this.music(id);
    }
  }

  get muted(): boolean {
    return this.prefs.muted;
  }

  /** True once the clip is PLAYABLE: decoded, or streamed and not known-bad.
   *  (r2: was `buffers.has(id)`. Left literal, every band bed would report
   *  missing under streaming and the director would degrade the entire game to
   *  music_dungeon — silently, since the fake-sink tests cannot see it.) */
  has(id: SoundId): boolean {
    if (this.buffers.has(id)) return true;
    return this.streamed(id) && !this.streamBad.has(id);
  }

  toggleMute(): boolean {
    this.prefs.muted = !this.prefs.muted;
    this.applyMaster();
    this.savePrefs();
    return this.prefs.muted;
  }

  setVolume(v: number): void {
    this.prefs.volume = Math.min(1, Math.max(0, v));
    this.applyMaster();
    this.savePrefs();
  }

  /** One-shot playback with optional distance gain + stereo pan. */
  play(id: SoundId, opts: PlayOpts = {}): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(id);
    if (!ctx || !buf || this.prefs.muted || ctx.state !== "running") {
      if (this.dbg) {
        const why = !ctx ? "noctx" : !buf ? "nobuf" : this.prefs.muted ? "muted" : "suspended";
        const d = this.dbg;
        d.plays.push({ id, at: performance.now(), ctxAt: ctx?.currentTime ?? 0, gain: 0, rate: 0, skipped: why });
        if (d.plays.length > 4096) d.plays.splice(0, d.plays.length - 4096);
      }
      return;
    }
    const def: SoundDef = AUDIO_MANIFEST[id];
    const now = performance.now();
    const last = this.lastPlayed.get(id) ?? -Infinity;
    if (!opts.force && now - last < (def.throttleMs ?? 70)) {
      // Swallowed by the spam guard. The debug ring still records the attempt
      // so the probe can PROVE rate limiting (attempts > plays, spacing >= throttle).
      this.record(id, now, 0, 0, true);
      return;
    }
    this.lastPlayed.set(id, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Slight random detune so rapid repeats (swarm hits) don't machine-gun.
    // An explicit `rate` (a boss's signature pitch) takes over, keeping only a
    // sliver of jitter so a repeated tell still breathes.
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * 0.05);
    const gain = ctx.createGain();
    gain.gain.value = (def.volume ?? 1) * Math.min(1, Math.max(0, opts.gain ?? 1));
    let head: AudioNode = gain;
    if (opts.pan !== undefined && typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.min(1, Math.max(-1, opts.pan));
      gain.connect(pan);
      head = pan;
    }
    src.connect(gain);
    head.connect(this.buses[def.bus]!);
    src.start();
    // §2.3: the show talks over the dungeon — an announcer play sidechains
    // music/sfx down for its own duration.
    if (def.bus === "announcer") this.sidechain(buf.duration / src.playbackRate.value);
    this.record(id, now, gain.gain.value, src.playbackRate.value);
  }

  /** §2.3 announcer sidechain: music -6dB, sfx -3dB; 80ms attack, 600ms
   *  release after the stinger ends. Overlapping stingers extend the hold.
   *  Tie rule: at most ONE duck source — while the APPROACH duck rides the
   *  music bus below 0.5 (deeper than -6dB), the sidechain stays out of the
   *  way rather than stacking multiplicatively on top of it. */
  private sidechain(holdSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.duckMusic || !this.duckSfx) return;
    if (this.approachLevel < 0.5) return; // approach duck owns the room
    const now = ctx.currentTime;
    const release = Math.max(now + holdSec, this.duckReleaseAt);
    this.duckReleaseAt = release;
    for (const [node, level] of [
      [this.duckMusic, 0.5], // -6dB
      [this.duckSfx, 0.708], // -3dB
    ] as const) {
      const g = node.gain;
      const cur = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(cur, now);
      g.setTargetAtTime(level, now, 0.027); // ~80ms to within 5%
      g.setTargetAtTime(1, release, 0.2); // ~600ms release tail
    }
  }

  /** Switch the looping music bed (crossfade); null fades music out. */
  music(id: SoundId | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (id === null) this.pendingMusic = null;
    if (id !== null && !this.has(id)) {
      // Clip not (yet) available — remember the request; load()/unlock retry.
      this.pendingMusic = id;
      id = null;
      if (!this.current) return;
    }
    if (id !== null) this.pendingMusic = null;
    if (this.current?.id === id) return;

    const FADE = 1.2;
    if (id === null) {
      // A real fade to silence (victory/death/verdict own the room, §2.3).
      this.retire(FADE);
      if (this.current) {
        this.current.release(FADE);
        this.current = null;
      }
      return;
    }

    const def: SoundDef = AUDIO_MANIFEST[id];
    // `this.current` is set at REQUEST time on BOTH paths, even with the
    // context still suspended — the buffered path always did (start() on a
    // suspended context is legal and just waits) and probe-beds asserts
    // currentMusic() regardless of context state. The streamed path preserves
    // that exactly: a play() the autoplay policy refuses is queued on the deck
    // and retried from the unlock handler, while currentMusic() already reads
    // the bed the director asked for.
    if (this.streamed(id)) {
      const sid = id;
      const prev = this.current;
      const deck: MusicDeck | null = this.decks?.claim(sid, def.url, {
        volume: def.volume ?? 1,
        loop: def.loop ?? true,
        fade: FADE,
        onStart: () => this.retire(FADE),
        onError: () => {
          // 404 / undecodable / tainted / stalled past the watchdog. Demote
          // the id: the director re-asks every frame, has() now says no, and
          // bed() falls back to music_dungeon on the very next frame — the
          // same self-healing shape as the model loader's stand-ins.
          // The DECK has already freed itself (deck.fail()); the first r2 cut
          // relied on this callback to do it, which leaked a deck per failure.
          this.streamBad.add(sid);
          if (this.current?.id === sid) this.current = null;
          // The bed being replaced is still playing, because the hand-off
          // below never happened. Leave it — audible wrong-bed beats silence
          // while the director's next frame routes to music_dungeon.
        },
      }) ?? null;
      if (!deck) {
        // All three decks busy = three bed swaps inside one 1.2s fade. Treat it
        // as "not playable yet" rather than stealing a deck mid-fade; the
        // director asks again next frame. NOTE the order: the outgoing bed was
        // NOT released above, so pool exhaustion no longer means silence.
        this.pendingMusic = sid;
        return;
      }
      // THE HAND-OFF. Everything audible stays audible until the incoming deck
      // fires `playing` and calls retire(). At most one bed is held: if one
      // already is, `prev` is a deck that never got to speak, so it goes now.
      if (this.outgoing) prev?.release(FADE);
      else this.outgoing = prev;
      this.current = { id: sid, release: (fade) => deck.release(fade) };
      // Gain 0 at claim, and it only ramps on `playing` — logging def.volume
      // here (as the first cut did) reports a level this deck may never reach.
      this.record(`music:${id}`, performance.now(), 0, 1);
      return;
    }
    // Buffered: a source node is audible the instant start() runs, so there is
    // no latency to cover and the outgoing bed goes immediately.
    this.retire(FADE);
    if (this.current) {
      this.current.release(FADE);
      this.current = null;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(id)!;
    src.loop = def.loop ?? true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(def.volume ?? 1, ctx.currentTime + FADE);
    src.connect(gain);
    gain.connect(this.buses[def.bus]!);
    src.start();
    this.current = {
      id,
      release: (fade) => {
        gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
        src.stop(ctx.currentTime + fade + 0.05);
      },
    };
    this.record(`music:${id}`, performance.now(), def.volume ?? 1, 1);
  }

  /** Let go of the bed held across a hand-off, if there is one. */
  private retire(fade: number): void {
    const out = this.outgoing;
    this.outgoing = null;
    out?.release(fade);
  }

  /** BULLET TIME underwater sweep: low-pass the whole mix down to ~700Hz,
   * back to inaudible (20kHz) when the world speeds up again. */
  muffle(on: boolean): void {
    if (!this.ctx || !this.muffleNode) return;
    this.muffleNode.frequency.setTargetAtTime(on ? 700 : 20000, this.ctx.currentTime, 0.08);
  }

  /** BOSSES V2 §5.1: ride the music bus down for the approach, back up at the
   *  seal. Slow constants on purpose — a duck you can hear working is a bug. */
  duck(level: number): void {
    const bus = this.buses.music;
    if (!this.ctx || !bus) return;
    this.approachLevel = Math.max(0, Math.min(1, level));
    bus.gain.setTargetAtTime(this.approachLevel, this.ctx.currentTime, 0.5);
  }

  // ---- internals ----

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const compressor = ctx.createDynamicsCompressor();
    compressor.connect(ctx.destination);
    this.compressor = compressor;
    // Master low-pass sits open (20kHz = inaudible) until Bullet Time sweeps
    // it down; a filter in the chain is cheaper than re-patching the graph.
    this.muffleNode = ctx.createBiquadFilter();
    this.muffleNode.type = "lowpass";
    this.muffleNode.frequency.value = 20000;
    this.muffleNode.connect(compressor);
    this.master = ctx.createGain();
    this.master.connect(this.muffleNode);
    // Sidechain duck nodes sit between the duckable buses and master (§2.3).
    this.duckMusic = ctx.createGain();
    this.duckMusic.connect(this.master);
    this.duckSfx = ctx.createGain();
    this.duckSfx.connect(this.master);
    for (const bus of ["sfx", "music", "ui", "announcer"] as const) {
      const g = ctx.createGain();
      g.connect(bus === "music" ? this.duckMusic : bus === "sfx" ? this.duckSfx : this.master);
      this.buses[bus] = g;
    }
    this.applyMaster();
    // Streaming decks (music). Built here, once, because each one owns a
    // permanent MediaElementAudioSourceNode into buses.music — the deck gain
    // sits exactly where a per-play music gain used to, so the sidechain and
    // the APPROACH duck are unaware anything changed.
    if (typeof Audio !== "undefined" && !this.forceBuffered) {
      this.decks = new MusicDeckPool(ctx, this.buses.music!, 3);
    }
    // Autoplay policy: the context starts suspended until a user gesture.
    const unlock = () => {
      void ctx.resume();
      // Media elements have their OWN gesture gate, separate from the
      // context's: a deck whose play() was refused before the click has to be
      // told to try again, and idle elements want one gesture-blessed play so
      // iOS will ever let them start (deck.ts unlock()).
      this.decks?.unlock();
      if (this.pendingMusic && this.has(this.pendingMusic)) {
        const id = this.pendingMusic;
        this.pendingMusic = null;
        this.music(id);
      }
      if (ctx.state === "running" || ctx.state === "closed") {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    this.ctx = ctx;
    return ctx;
  }

  private applyMaster(): void {
    if (this.master) this.master.gain.value = this.prefs.muted ? 0 : this.prefs.volume;
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.prefs));
    } catch {
      /* best-effort */
    }
  }

  // ---- debug instrumentation (SOUNDPLAN.md §5; wired to __dcc.audio) ----

  private record(id: string, at: number, gain: number, rate: number, throttled?: boolean): void {
    const d = this.dbg;
    if (!d) return;
    d.plays.push({ id, at, ctxAt: this.ctx?.currentTime ?? 0, gain, rate, ...(throttled ? { throttled } : {}) });
    // 4096: a 10s staged brawl generates ~600 attempts; a ring that trims
    // mid-probe silently fabricates "missed" impact-sync matches (measured).
    if (d.plays.length > 4096) d.plays.splice(0, d.plays.length - 4096);
  }

  /**
   * The music-path meter (?debug=1 only). Two numbers nobody in this loop can
   * hear their way to:
   *   - musicEnergy: audio is actually FLOWING. Streaming needs this; the
   *     buffered path never did. currentMusic() proves the director asked for
   *     a bed, and a 404ing, stalled or CORS-tainted deck satisfies that
   *     while the game plays silence.
   *   - musicSeam: the longest run of |x| < 1e-4 across a loop wrap. This is
   *     the instrument that decides the loop ladder (deck.ts): native el.loop
   *     stays only if the run is < 2ms with no transient above the loop's own
   *     p95 — the same seam definition SOUNDPLAN §5 uses offline, so the
   *     in-browser number is directly comparable to the committed per-bed
   *     figures (0.1-1.5dB, no clicks).
   * It is an AudioWorklet and not an AnalyserNode on purpose: an analyser
   * polled per rAF sees 43ms windows and cannot resolve a 10ms gap. A worklet
   * sees every contiguous 128-sample block.
   * The module is a Blob URL because the alternative is shipping a worklet
   * file in public/ that only ?debug=1 ever loads.
   */
  private installMusicMeter(ctx: AudioContext, musicBus: GainNode): void {
    // Fallback tap first, so energy works even if the worklet never lands.
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    musicBus.connect(an);
    this.dbg!.anMusic = an;
    if (!ctx.audioWorklet) return;
    const src = `
      class DccMusicMeter extends AudioWorkletProcessor {
        constructor() { super(); this.reset(); this.port.onmessage = () => this.reset(); }
        reset() { this.run = 0; this.longest = 0; this.peak = 0; this.sum = 0; this.n = 0; this.acc = 0; }
        process(inputs) {
          const ch = inputs[0];
          if (!ch || ch.length === 0) return true;
          const L = ch[0], R = ch[1] || ch[0];
          for (let i = 0; i < L.length; i++) {
            const a = Math.abs(L[i]) > Math.abs(R[i]) ? Math.abs(L[i]) : Math.abs(R[i]);
            if (a > this.peak) this.peak = a;
            this.sum += a * a; this.n++;
            if (a < 1e-4) { if (++this.run > this.longest) this.longest = this.run; } else this.run = 0;
          }
          this.acc += L.length;
          if (this.acc >= sampleRate / 10) {
            this.port.postMessage({ longest: this.longest, peak: this.peak,
              rms: Math.sqrt(this.sum / (this.n || 1)), rate: sampleRate });
            this.acc = 0; this.sum = 0; this.n = 0;
          }
          return true;
        }
      }
      registerProcessor('dcc-music-meter', DccMusicMeter);
    `;
    const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
    void ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const d = this.dbg;
        if (!d) return;
        const node = new AudioWorkletNode(ctx, "dcc-music-meter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e: MessageEvent) => {
          const m = e.data as { longest: number; peak: number; rms: number; rate: number };
          d.seam = { longestSilentMs: (m.longest / m.rate) * 1000, peak: m.peak, rms: m.rms };
          if (m.rms > d.energy) d.energy = m.rms;
        };
        musicBus.connect(node);
        // A node whose output reaches nothing is not guaranteed to be pulled by
        // the rendering graph — so its (silent) output goes to the destination
        // through a hard zero. Costs one gain node, under ?debug=1 only.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink).connect(ctx.destination);
        d.meter = node;
      })
      .catch(() => {
        // No worklet (insecure context, older engine): musicSeam() stays null,
        // which the probe must read as UNPROVEN rather than as a pass.
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  /**
   * Debug-only (?debug=1): analyser taps + play ring. Idempotent; costs
   * nothing until called (record() is a null check per play otherwise).
   * Peaks are RUNNING MAXIMA sampled per animation frame — at 60fps a 2048-
   * sample window (~43ms at 48kHz) overlaps every frame, so no transient
   * between polls is missed.
   */
  debugHook(): AudioDebugHook {
    if (!this.dbg) {
      this.dbg = {
        plays: [], peakPre: 0, peakPost: 0, anPre: null, anPost: null, buf: new Float32Array(2048),
        meter: null, seam: null, anMusic: null, energy: 0,
      };
      const ctx = this.ensureContext();
      if (ctx && this.buses.music) this.installMusicMeter(ctx, this.buses.music);
      if (ctx && this.master && this.compressor) {
        const mk = () => {
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          return an;
        };
        // Pre = compressor input (post-master, post-muffle): the headroom
        // contract. Post = compressor output: the hard-clip test.
        this.dbg.anPre = mk();
        this.dbg.anPost = mk();
        this.muffleNode!.connect(this.dbg.anPre);
        this.compressor.connect(this.dbg.anPost);
        const poll = () => {
          const d = this.dbg;
          if (!d || !d.anPre || !d.anPost) return;
          d.anPre.getFloatTimeDomainData(d.buf);
          for (let i = 0; i < d.buf.length; i++) {
            const a = Math.abs(d.buf[i]);
            if (a > d.peakPre) d.peakPre = a;
          }
          d.anPost.getFloatTimeDomainData(d.buf);
          for (let i = 0; i < d.buf.length; i++) {
            const a = Math.abs(d.buf[i]);
            if (a > d.peakPost) d.peakPost = a;
          }
          // Energy fallback: only used when the worklet refused to install.
          // 43ms windows — fine for "is the bed audible at all", useless for
          // the seam (which is why musicSeam() stays null in that case).
          if (!d.meter && d.anMusic) {
            d.anMusic.getFloatTimeDomainData(d.buf);
            let sum = 0;
            for (let i = 0; i < d.buf.length; i++) sum += d.buf[i] * d.buf[i];
            const rms = Math.sqrt(sum / d.buf.length);
            if (rms > d.energy) d.energy = rms;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }
    }
    const d = this.dbg;
    return {
      plays: d.plays,
      peakPre: () => d.peakPre,
      peakPost: () => d.peakPost,
      resetPeaks: () => {
        d.peakPre = 0;
        d.peakPost = 0;
      },
      buffers: () => [...this.buffers.keys()],
      streams: () => this.decks?.active() ?? [],
      streamsStarted: () => this.decks?.started() ?? [],
      streamedBufferedSec: () => this.decks?.bufferedSec() ?? 0,
      residentPcmBytes: () => {
        let n = 0;
        for (const b of this.buffers.values()) n += b.length * b.numberOfChannels * 4;
        return n;
      },
      musicEnergy: () => d.energy,
      musicSeam: () => (d.seam ? { longestSilentMs: d.seam.longestSilentMs, peak: d.seam.peak } : null),
      resetMusicMeters: () => {
        d.energy = 0;
        d.seam = null;
        d.meter?.port.postMessage("reset");
      },
      currentMusic: () => this.current?.id ?? null,
      musicBusGain: () => this.buses.music?.gain.value ?? 0,
      musicDuckGain: () => this.duckMusic?.gain.value ?? 1,
      sfxDuckGain: () => this.duckSfx?.gain.value ?? 1,
      trigger: (id, opts) => this.play(id, opts),
      ctxState: () => this.ctx?.state ?? "none",
      ctxTime: () => this.ctx?.currentTime ?? 0,
    };
  }
}
