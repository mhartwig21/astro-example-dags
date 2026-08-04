import { AUDIO_MANIFEST, type SoundDef, type SoundId } from "./manifest";

// WebAudio playback engine. Silent-by-default: load() decodes whatever clips
// exist under public/audio/ and skips the rest, so play() on a missing sound is
// a no-op (same fallback philosophy as the glTF model loader). Handles the
// browser autoplay policy by resuming the context on the first user gesture.
//
// Graph: source -> per-play gain/pan -> bus gain (sfx/music/ui) -> master gain
// -> compressor -> destination. Mute/volume persist per browser.

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
  // Music r1: is this clip decoded and playable? The director uses it to
  // fall back per-band (a band bed that failed to load degrades to the
  // generic dungeon ambience instead of silence). Optional — sinks without
  // it are treated as having everything, which keeps the director's choice
  // deterministic in tests.
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
  /** Decoded clip ids (missing files never appear here). */
  buffers(): string[];
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
  private current: { id: SoundId; gain: GainNode; src: AudioBufferSourceNode } | null = null;
  private pendingMusic: SoundId | null = null; // requested before unlock/decode
  private prefs = loadPrefs();
  private compressor: DynamicsCompressorNode | null = null;
  private dbg: {
    plays: PlayRecord[];
    peakPre: number;
    peakPost: number;
    anPre: AnalyserNode | null;
    anPost: AnalyserNode | null;
    buf: Float32Array<ArrayBuffer>;
  } | null = null;

  /** Fetch + decode every manifest clip that exists; missing files stay silent.
   * onProgress reports clips SETTLED (decoded or missing-and-skipped) so the
   * boot screen can show real progress while the sound library front-loads. */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const ids = Object.keys(AUDIO_MANIFEST) as SoundId[];
    const ctx = this.ensureContext();
    if (!ctx) { onProgress?.(ids.length, ids.length); return; } // no WebAudio: stay silent
    let settled = 0;
    await Promise.all(
      ids.map(async (id) => {
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
    // Music requested while clips were still decoding starts now.
    if (this.pendingMusic && this.buffers.has(this.pendingMusic)) {
      const id = this.pendingMusic;
      this.pendingMusic = null;
      this.music(id);
    }
  }

  get muted(): boolean {
    return this.prefs.muted;
  }

  /** True once the clip is decoded (missing/undecodable files never are). */
  has(id: SoundId): boolean {
    return this.buffers.has(id);
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
    if (id !== null && !this.buffers.has(id)) {
      // Clip not (yet) available — remember the request; load() retries it.
      this.pendingMusic = id;
      id = null;
      if (!this.current) return;
    }
    if (id !== null) this.pendingMusic = null;
    if (this.current?.id === id) return;

    const FADE = 1.2;
    if (this.current) {
      const old = this.current;
      old.gain.gain.setValueAtTime(old.gain.gain.value, ctx.currentTime);
      old.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE);
      old.src.stop(ctx.currentTime + FADE + 0.05);
      this.current = null;
    }
    if (id === null) return;

    const def: SoundDef = AUDIO_MANIFEST[id];
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(id)!;
    src.loop = def.loop ?? true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(def.volume ?? 1, ctx.currentTime + FADE);
    src.connect(gain);
    gain.connect(this.buses[def.bus]!);
    src.start();
    this.current = { id, gain, src };
    this.record(`music:${id}`, performance.now(), def.volume ?? 1, 1);
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
    // Autoplay policy: the context starts suspended until a user gesture.
    const unlock = () => {
      void ctx.resume();
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
   * Debug-only (?debug=1): analyser taps + play ring. Idempotent; costs
   * nothing until called (record() is a null check per play otherwise).
   * Peaks are RUNNING MAXIMA sampled per animation frame — at 60fps a 2048-
   * sample window (~43ms at 48kHz) overlaps every frame, so no transient
   * between polls is missed.
   */
  debugHook(): AudioDebugHook {
    if (!this.dbg) {
      this.dbg = { plays: [], peakPre: 0, peakPost: 0, anPre: null, anPost: null, buf: new Float32Array(2048) };
      const ctx = this.ensureContext();
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
