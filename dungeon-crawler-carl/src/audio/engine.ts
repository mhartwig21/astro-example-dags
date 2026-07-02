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
}

/** What the AudioDirector needs — implemented by AudioEngine, faked in tests. */
export interface AudioSink {
  play(id: SoundId, opts?: PlayOpts): void;
  music(id: SoundId | null): void;
}

const STORE_KEY = "dcc:audio:v1";

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
  private buses: Partial<Record<"sfx" | "music" | "ui", GainNode>> = {};
  private buffers = new Map<SoundId, AudioBuffer>();
  private lastPlayed = new Map<SoundId, number>();
  private current: { id: SoundId; gain: GainNode; src: AudioBufferSourceNode } | null = null;
  private pendingMusic: SoundId | null = null; // requested before unlock/decode
  private prefs = loadPrefs();

  /** Fetch + decode every manifest clip that exists; missing files stay silent. */
  async load(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return; // no WebAudio (old browser / non-DOM host): stay silent
    await Promise.all(
      (Object.keys(AUDIO_MANIFEST) as SoundId[]).map(async (id) => {
        try {
          const res = await fetch(AUDIO_MANIFEST[id].url);
          if (!res.ok) return;
          const data = await res.arrayBuffer();
          this.buffers.set(id, await ctx.decodeAudioData(data));
        } catch {
          // Absent or undecodable — leave it out; play() no-ops.
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
    if (!ctx || !buf || this.prefs.muted || ctx.state !== "running") return;
    const def: SoundDef = AUDIO_MANIFEST[id];
    const now = performance.now();
    const last = this.lastPlayed.get(id) ?? -Infinity;
    if (now - last < (def.throttleMs ?? 70)) return; // combat spam guard
    this.lastPlayed.set(id, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Slight random detune so rapid repeats (swarm hits) don't machine-gun.
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.05;
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
    this.master = ctx.createGain();
    this.master.connect(compressor);
    for (const bus of ["sfx", "music", "ui"] as const) {
      const g = ctx.createGain();
      g.connect(this.master);
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
}
