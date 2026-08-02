// QUALITY PRESETS — the fill-rate ladder.
//
// WHY THIS FILE EXISTS. On the reference machine (Intel iGPU, 1440x900 @ dpr2,
// so a 2880x1704 backbuffer) combat measured 115 ms/frame. Two findings drove
// everything here:
//
//  1. THE MSAA CLIFF. The composer's render target was `samples: 4` on a
//     HalfFloat (RGBA16F) surface. 8 bytes/px x 4 samples x 4.9 Mpx is ~157 MB
//     of multisampled traffic per frame, on a GPU with no dedicated VRAM — and
//     every pass that READS the composer target forces a resolve blit, so the
//     cost was being paid several times over. Measured on the shipped build at
//     native resolution: 60 ms with samples=4, 9 ms with samples=0. That single
//     flag was 85% of the frame. samples=2 is not a compromise (-7%): the cost
//     is having a multisampled HDR target at all, not the sample count.
//     Geometry AA moves to SMAA, which is ~3 fullscreen LDR passes — measured
//     under the noise floor on this device.
//
//  2. 60 fps AT TRUE NATIVE IS NOT REACHABLE ON THIS GPU, AND THE LADDER SPENDS
//     RESOLUTION BECAUSE THERE IS NOTHING ELSE LEFT TO SPEND.
//
//     An earlier revision of this comment claimed "ULTRA at full native
//     resolution already clears the 16.7 ms budget." That was wrong and is
//     retracted. Measured with tools/_ablate.mjs (interleaved wall-clock
//     ablation, 3 reps, one page session, real ANGLE/D3D11 Intel iGPU,
//     1440x852 @ dpr 2 = 2880x1704 = 4.91 Mpx, staged combat on floor 8),
//     as MEAN frame time:
//
//         ULTRA, everything on ........................ 51.0 ms
//           - bloom off ............................... 50.1 ms   (-2%)
//           - SMAA off ................................ 49.9 ms   (-2%)
//           - colour grade off ........................ 50.8 ms   (-0%)
//           - shadow pass off ......................... 44.3 ms  (-13%)
//           - GTAO off ................................ 41.8 ms  (-18%)
//           - ENTIRE post chain off ................... 34.8 ms  (-32%)
//           - post chain AND shadows off .............. 29.8 ms  (-42%)
//         ULTRA at renderScale 0.707 (2.45 Mpx) ....... 24.5 ms
//         ULTRA at renderScale 0.5   (1.23 Mpx) ....... 13.5 ms
//
//     Read the fourth-from-last row: with EVERY post pass disabled and the
//     shadow pass disabled — nothing left but the world geometry — a native
//     frame still costs 29.8 ms. No post-processing setting can reach 16.7 ms
//     from there, because none of them is what is being paid for. Things that
//     were checked and are NOT the cause: the RGBA16F surface (forcing the
//     composer targets to 8-bit changed nothing, +2%), the depth-texture
//     attachment (+2%), particle/FX overdraw (+6%, i.e. noise).
//
//     What IS being paid for is the lit world fragment shader at 4.91 Mpx:
//     a forward renderer evaluating ~14 point lights plus the world-light
//     system's four extra texture fetches, per fragment. Hiding every point
//     light — a thing we cannot ship — recovers only 20%.
//
//     Fitting the three resolution rows gives mean ~= 1.6 ms + 9.65 ms/Mpx.
//     Solving for 16.7 ms lands at ~1.56 Mpx, and the cheaper AO settings
//     below buy back enough to make BALANCED's 1.92 Mpx the 60 fps rung.
//
//  3. SO THE LADDER SPENDS RESOLUTION AND *ONLY* RESOLUTION.
//
//     A previous revision also cut ambient occlusion, particle density, mote
//     density and light counts on the bottom rung. That is the wrong trade:
//     those are the things a player can NAME ("the shadows under things are
//     gone", "there's less going on"), whereas pixel ratio reads as softness.
//     Every rung below now keeps GTAO, full FX density, full mote density and
//     identical light pools; what changes down the ladder is pixel ratio, the
//     AO buffer's own scale, its sample counts, and the shadow map size.
//     ULTRA is bit-for-bit the reference look and is deliberately untouched.
//
// PIXEL RATIO is therefore the only real lever, its cost is quadratic in it,
// and that is why it is the first field of a profile.

export type QualityName = "ultra" | "high" | "balanced" | "performance";

/** Best → cheapest. Auto-detect walks this array. */
export const QUALITY_ORDER: readonly QualityName[] = ["ultra", "high", "balanced", "performance"];

export interface QualityProfile {
  readonly name: QualityName;
  /** Label for the settings row. */
  readonly label: string;
  /** One-line explanation for the settings row's <small>. */
  readonly blurb: string;

  // ---- Resolution ----
  /** Hard cap on devicePixelRatio. The dominant cost knob: every pixel-bound
   *  pass scales with its square. */
  readonly pixelRatioCap: number;

  // ---- Anti-aliasing ----
  /** Composer render-target MSAA. Keep at 0 — see the cliff note above. Left
   *  configurable only so a future non-Intel path can opt back in. */
  readonly msaaSamples: number;
  /** SMAA post pass (replaces the render target's MSAA). */
  readonly smaa: boolean;

  // ---- Ambient occlusion ----
  readonly gtao: boolean;
  /** Resolution scale for the AO buffer itself. The denoise pass stays at full
   *  resolution and is depth+normal weighted, so it doubles as a bilateral
   *  upsample — half-res AO costs a quarter of the samples without the halo
   *  bleed a plain bilinear stretch would give. */
  readonly gtaoScale: number;
  /** Denoise/upsample buffer scale. 1 = full-res bilateral upsample. */
  readonly gtaoDenoiseScale: number;
  readonly gtaoSamples: number;
  readonly gtaoDenoiseSamples: number;

  // ---- Bloom ----
  readonly bloom: boolean;
  /** Input resolution scale for the mip chain. UnrealBloomPass already halves
   *  internally, so 0.5 here means the brightest mip is quarter-res. Bloom is
   *  a wide blur; the result is indistinguishable well below 1.0. */
  readonly bloomScale: number;

  // ---- Shadows ----
  /** Key-light shadow map edge, or 0 to drop shadow casting entirely. */
  readonly shadowMapSize: number;
  /** Rebuild the shadow map every N composed frames (1 = every frame). The map
   *  persists between rebuilds, so N=2 halves the shadow-pass draw calls and is
   *  invisible on an iso camera that only pans. */
  readonly shadowInterval: number;

  // ---- Overdraw / population ----
  /** Combat particle spawn budget, 0..1. */
  readonly fxDensity: number;
  /** Ambient mote draw budget, 0..1. */
  readonly moteDensity: number;
  /** Pooled transient impact lights. */
  readonly fxLights: number;
  /** Pooled dynamic torch lights (the baked light grid carries the rest). */
  readonly torchLights: number;
}

// NOTE ON LIGHT COUNTS: a forward renderer compiles a distinct program per
// light count, and both pools are pre-built and pre-compiled during
// Renderer3D.prewarm(). Changing either number AFTER prewarm would trigger a
// mid-game shader build — exactly the multi-second hitch this work exists to
// remove. So the pool sizes are read once, when the pools are first built, and
// a later preset switch deliberately leaves them alone (see Renderer3D).
// Consequently EVERY profile below declares the SAME counts: a differing value
// would be a field that silently does nothing, which is worse than no field.

const ULTRA: QualityProfile = {
  name: "ultra",
  label: "ULTRA",
  blurb: "full resolution, full ambient occlusion — the reference look",
  pixelRatioCap: 2,
  msaaSamples: 0,
  smaa: true,
  gtao: true,
  gtaoScale: 0.5,        // half-res AO, full-res bilateral upsample: no visible delta
  gtaoDenoiseScale: 1,
  gtaoSamples: 12,
  gtaoDenoiseSamples: 8,
  bloom: true,
  bloomScale: 0.5,
  shadowMapSize: 2048,
  shadowInterval: 1,
  fxDensity: 1,
  moteDensity: 1,
  fxLights: 4,
  torchLights: 8,
};

const HIGH: QualityProfile = {
  ...ULTRA,
  name: "high",
  label: "HIGH",
  blurb: "capped at 1.5x pixel density; everything else as ULTRA",
  pixelRatioCap: 1.5,
  gtaoSamples: 9,
  gtaoDenoiseSamples: 6,
  shadowInterval: 2,
};

// 1.2, NOT 1.25, AND THE 0.05 IS THE WHOLE DIFFERENCE BETWEEN 57 AND 60 FPS.
// Measured VSYNC-PACED (tools/_prcheck.mjs, 3 reps, real GPU, staged combat —
// uncapped rAF cannot answer this question because it never sees the vsync
// interval), walking the effective pixel ratio on this rung:
//     1.25  (1.92 Mpx)  17.47 ms  57.2 fps   <- misses, ~1 frame in 25
//     1.20  (1.77 Mpx)  16.64 ms  60.1 fps   <- locked
//     1.15  (1.62 Mpx)  16.65 ms  60.1 fps
//     1.10  (1.48 Mpx)  16.65 ms  60.1 fps
// Identical numbers at 1.15 and 1.10 mean 1.20 is not sitting on the edge: it
// is inside the interval with room, and buying more room buys nothing back.
const BALANCED: QualityProfile = {
  ...ULTRA,
  name: "balanced",
  label: "BALANCED",
  blurb: "1.2x pixel density — the 60 fps rung on integrated graphics",
  pixelRatioCap: 1.2,
  gtaoScale: 0.5,
  gtaoDenoiseScale: 0.5, // bilinear upsample in the AO blend; softer, much cheaper
  gtaoSamples: 6,
  gtaoDenoiseSamples: 4,
  bloomScale: 0.4,
  shadowMapSize: 1536,
  shadowInterval: 2,
};

// PERFORMANCE KEEPS THE OCCLUSION PASS. It used to set `gtao: false`, which is
// the single most visible thing in the whole ladder: contact shadows under
// props, mobs and wall bases simply vanish and the scene goes flat. Measured
// cost of keeping it at this rung's 1.23 Mpx with the AO buffer at quarter
// scale: ~2 ms. That is a price worth paying — and there is no rung below this
// one, so a machine that lands here has nowhere to fall anyway.
//
// Likewise fxDensity/moteDensity/fxLights/torchLights are NOT reduced here.
// Thinning particles and removing torch lights is a content change a player can
// name; pixel ratio is softness they mostly cannot. (The light counts were also
// already inert after prewarm — see the note above — so the old values were a
// profile field that did not describe the running game.)
const PERFORMANCE: QualityProfile = {
  ...ULTRA,
  name: "performance",
  label: "PERFORMANCE",
  blurb: "1x pixel density, cheaper occlusion — for integrated graphics",
  pixelRatioCap: 1,
  gtaoScale: 0.25,
  gtaoDenoiseScale: 0.5,
  gtaoSamples: 6,
  gtaoDenoiseSamples: 4,
  bloomScale: 0.35,
  shadowMapSize: 1024,
  shadowInterval: 2,
};

export const QUALITY_PRESETS: Record<QualityName, QualityProfile> = {
  ultra: ULTRA,
  high: HIGH,
  balanced: BALANCED,
  performance: PERFORMANCE,
};

/** "auto" = let the tuner choose and keep choosing; anything else pins it. */
export type QualityChoice = QualityName | "auto";

const STORAGE_KEY = "dcc:quality:v1";

export function loadQualityChoice(): QualityChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "auto" || (v && v in QUALITY_PRESETS)) return v as QualityChoice;
  } catch { /* private mode / blocked storage — auto is a fine default */ }
  return "auto";
}

export function saveQualityChoice(v: QualityChoice): void {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* best-effort */ }
}

/**
 * `?quality=ultra` — a URL pin that beats both storage and auto-detect, and is
 * deliberately NOT persisted.
 *
 * This exists for the capture harnesses. They run under SwiftShader (software
 * GL) at a few frames per second, so the tuner correctly concludes the machine
 * is hopeless and walks the preset down mid-capture — which silently turns "a
 * screenshot of ULTRA" into "a screenshot of whatever it had decided by frame
 * 60". Any before/after comparison then compares two different presets. Pinning
 * from the URL makes a captured frame mean one specific rung.
 */
export function urlQualityOverride(): QualityChoice | null {
  try {
    const v = new URLSearchParams(location.search).get("quality");
    if (v === "auto" || (v && v in QUALITY_PRESETS)) return v as QualityChoice;
  } catch { /* no location (worker/test) — no override */ }
  return null;
}

/**
 * STARTUP GUESS — used for the very first frames, before any frame time exists.
 *
 * WHAT WE ACTUALLY MEASURED, on the reference machine (Intel iGPU, 1440x852 CSS
 * at devicePixelRatio 2 = 2880x1704), in staged combat, as sustained THROUGHPUT
 * rather than median frame time:
 *
 *     ULTRA       (4.91 Mpx)   49 ms/frame     20 fps
 *     HIGH        (2.76 Mpx)   27 ms/frame     37 fps
 *     BALANCED    (1.77 Mpx)   15 ms/frame     66 fps
 *     PERFORMANCE (1.23 Mpx)   10 ms/frame     98 fps
 *
 * which is very nearly a straight line: mean ~= 1.6 ms + 9.65 ms per megapixel.
 * Solving it for the 16.7 ms budget gives ~1.6-1.9 Mpx, i.e. a pixel ratio
 * around 1.2 — which is what BALANCED is. Once the MSAA cliff is gone the
 * frame is dominated by the world render pass itself (ablating the ENTIRE post
 * chain only recovers 32%, and ablating the shadow pass on top of that only
 * gets to 42%), so no amount of post-processing tuning moves this; pixel ratio
 * is the lever, and this is where it lands.
 *
 * So: the one hardware class we have hard numbers for starts where the numbers
 * say. Everything else starts at ULTRA and lets the tuner descend — guessing
 * low for an unknown machine ships a permanently softer frame to hardware that
 * never needed it, and the tuner's climb back up is deliberately slow.
 */
/** What the caller knows about the device without touching a GL context. */
export interface DeviceHint {
  /** matchMedia("(pointer: coarse)") — a finger, not a cursor. */
  coarse?: boolean;
  /** min(screen width, screen height) in CSS px. */
  shortEdge?: number;
}

export function guessQuality(
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null, hint?: DeviceHint,
): QualityName {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 8) : 8;

  let renderer = "";
  try {
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    if (dbg && gl) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
  } catch { /* extension is optional and privacy-gated in some browsers */ }

  // A PHONE IS A PHONE EVEN WHEN IT WILL NOT SAY SO.
  //
  // The mobile branch below reads WEBGL_debug_renderer_info — which Safari does
  // not expose. On an iPhone the renderer string is "", the mobile branch never
  // fires, the integrated branch never fires, and control falls through to
  // "cores > 4 -> ultra": a phone booting at ULTRA with no pixel-ratio cap at
  // dpr 3. Coarse pointer plus a short screen edge is the same fact, obtained
  // from an API nobody gates. PERFORMANCE keeps GTAO, full FX density and full
  // mote density — only sharpness goes.
  if (hint?.coarse) {
    const edge = hint.shortEdge ?? Infinity;
    if (edge < 560) return "performance";
    if (edge < 1100) return "balanced";
  }
  // Mobile tile-based GPUs: not "a slower desktop GPU" — bandwidth and
  // sustained-power limits put them a tier below anything below, and a phone's
  // pixel ratio is usually 3.
  if (/adreno|mali|powervr|apple a\d/i.test(renderer)) {
    return dpr >= 3 ? "performance" : "balanced";
  }
  // The measured case: an integrated GPU behind a HiDPI panel is paying 4x the
  // pixels of the same chip at dpr 1. Apple's integrated parts are excluded —
  // they report "Apple GPU"/"Apple M…" and are in a different performance class.
  const integrated = /intel|iris|uhd graphics|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d/i.test(renderer);
  if (integrated && dpr > 1.5) return "balanced";
  if (integrated) return "high";
  if (cores <= 4) return "high";
  return "ultra";
}

/**
 * RUNTIME AUTO-DETECT.
 *
 * IT JUDGES THROUGHPUT, NOT THE MEDIAN FRAME TIME. That distinction is the
 * whole reason this class is written the way it is.
 *
 * When the GPU is the bottleneck, the browser does not hand you one slow frame
 * after another: rAF runs ahead and queues cheap frames until the swap chain
 * fills, then blocks for a long one. The frame-time distribution goes BIMODAL.
 * Measured on the reference machine at ULTRA, native resolution, in combat:
 *
 *     p10 5.9 ms | p50 10 ms | p75 60 ms | p90 145 ms | p99 218 ms
 *     ... while actually delivering 24 fps (42 ms per frame of wall clock).
 *
 * A median-based tuner reads "10 ms, wonderful" and never downgrades a machine
 * running at 24 fps. Mean over a fixed wall-clock window cannot be fooled that
 * way, so that is what is used.
 *
 * The rest is hysteresis, because a tuner that visibly flips resolution back
 * and forth is worse than one that guesses slightly wrong:
 *   - Windows are WALL-CLOCK, not frame counts. Frame-count windows take
 *     longest to fill exactly when frames are slow — i.e. when a decision is
 *     most urgent.
 *   - Two consecutive bad windows to step DOWN. One is noise.
 *   - Stepping down remembers a ceiling and the tuner never climbs back above a
 *     rung that already failed.
 *   - Climbing needs a much better margin than descending needs a worse one,
 *     plus three consecutive good windows.
 *   - Genuinely pathological frames (shader builds, tab-switches, GC pauses)
 *     are excluded entirely — no preset can prevent those, so counting them
 *     would downgrade a machine for something a downgrade cannot fix.
 */
export interface AutoTunerOpts {
  /** Wall-clock length of a judged window. */
  windowMs?: number;
  /**
   * Minimum frames before a window counts. Keep this SMALL. It is tempting to
   * demand a healthy sample size, but the window is wall-clock: a machine
   * running at 5 fps only ever puts ~7 frames in a 1.5 s window, so a large
   * minimum silently discards every window on exactly the machines that most
   * need downgrading — the tuner goes blind at the worst end of its range.
   * Background-tab throttling is already handled by `stallMs`, which drops the
   * ~1000 ms frames a hidden tab produces before they can reach the window.
   */
  minFrames?: number;
  /** Step down when the window's mean frame time exceeds this. */
  downMs?: number;
  /** Step up when the window's mean frame time is under this. */
  upMs?: number;
  /** Frames longer than this are stalls, not load — excluded from the mean. */
  stallMs?: number;
  /** Windows to wait after any change before judging again. */
  settleWindows?: number;
}

export class QualityAutoTuner {
  private readonly windowMs: number;
  private readonly minFrames: number;
  private readonly downMs: number;
  private readonly upMs: number;
  private readonly stallMs: number;
  private readonly settleWindows: number;

  private acc = 0;
  private count = 0;
  private badRun = 0;
  private goodRun = 0;
  private settle = 0;
  /** Highest rung not yet proven too expensive (index into QUALITY_ORDER). */
  private ceiling = 0;
  private idx: number;

  constructor(start: QualityName, opts: AutoTunerOpts = {}) {
    this.idx = Math.max(0, QUALITY_ORDER.indexOf(start));
    this.windowMs = opts.windowMs ?? 1500;
    this.minFrames = opts.minFrames ?? 4;
    // DOWN AT 24 ms (42 fps), NOT 20 (50 fps). The rung this ladder is designed
    // to land on for the reference machine measures ~17 ms mean in combat, and
    // a threshold of 20 sits inside that rung's own run-to-run spread — so the
    // tuner would demote a machine that is hitting its target, and `ceiling`
    // makes that demotion permanent for the session. The threshold has to be
    // far enough above the intended rung to mean "this machine is genuinely not
    // coping", not "this window was unlucky".
    this.downMs = opts.downMs ?? 24;
    this.upMs = opts.upMs ?? 11;       // 90 fps: enough headroom to afford more
    this.stallMs = opts.stallMs ?? 400;
    this.settleWindows = opts.settleWindows ?? 2;
  }

  get current(): QualityName {
    return QUALITY_ORDER[this.idx];
  }

  /** Pin the tuner to a preset (manual override) without disabling it. */
  reset(to: QualityName): void {
    this.idx = Math.max(0, QUALITY_ORDER.indexOf(to));
    this.ceiling = this.idx;
    this.acc = this.count = 0;
    this.badRun = this.goodRun = 0;
    this.settle = this.settleWindows;
  }

  /**
   * Feed one frame. Returns the new preset when the tuner decides to change,
   * or null (the overwhelmingly common case) when nothing should happen.
   */
  sample(frameMs: number): QualityName | null {
    if (!(frameMs > 0) || frameMs > this.stallMs) return null;
    this.acc += frameMs;
    this.count++;
    if (this.acc < this.windowMs) return null;

    const mean = this.count >= this.minFrames ? this.acc / this.count : 0;
    this.acc = this.count = 0;
    if (mean === 0) return null;

    if (this.settle > 0) { this.settle--; return null; }

    if (mean > this.downMs) {
      this.goodRun = 0;
      if (++this.badRun >= 2 && this.idx < QUALITY_ORDER.length - 1) {
        this.badRun = 0;
        this.idx++;
        this.ceiling = this.idx; // never climb back into a rung that missed
        this.settle = this.settleWindows;
        return this.current;
      }
      return null;
    }

    this.badRun = 0;
    if (mean < this.upMs) {
      // Climbing is allowed only back toward a rung that has never failed, so
      // in practice this only fires when the startup guess was too pessimistic.
      if (++this.goodRun >= 3 && this.idx > this.ceiling) {
        this.goodRun = 0;
        this.idx--;
        this.settle = this.settleWindows;
        return this.current;
      }
    } else {
      this.goodRun = 0;
    }
    return null;
  }
}
