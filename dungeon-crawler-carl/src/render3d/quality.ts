// PERFORMANCE MODES — three rungs, each with a contract it was measured against.
//
// ============================================================================
// OPT R3: THE FRAME WAS NOT WHERE THREE ROUNDS OF THIS FILE SAID IT WAS
// ============================================================================
//
// Read this section before the historical ones below it. Four things it
// retracts, each with the measurement that retracts it.
//
// 1. THE SCENE WAS WRONG. Every contract here was stated against a scene where
//    the crawler is teleported into the densest pack and PINNED ALIVE in it —
//    standing still, never swinging. The game is not played standing still. The
//    contract scene is now `fight` (SCENES), and the pinned scene is kept
//    beside it so the gap stays visible.
//
// 2. THE TEST GRADED A DIFFERENT NUMBER FROM THE ONE THE CONTRACT STATES.
//    `maxOverPct` is documented as the share of frames over `budgetMs`, and
//    test/quality.test.ts asserted the share over 33.3 ms for EVERY mode —
//    including LOW, whose budget is 20. LOW's stated ceiling had therefore
//    never been evaluated once, and it was failing it: 4.5% of frames over 33.3
//    against 29.9% over its own 20 ms. MeasuredShape carries `overBudget` now.
//
// 3. THE FRAME WAS NOT A GPU BUDGET PROBLEM AT LOW, AND THE PROOF IS A NULL
//    RESULT. Sweeping LOW's render scale through a single page session halved
//    the GPU clock — 15.1 ms to 7.1 ms — and DELIVERED TIME DID NOT MOVE (15.19
//    ms at full scale, 14.96 at half). A frame whose GPU cost you can halve for
//    free is not GPU-bound, and no lever in this file spends the main thread.
//
//    The V8 sampling profiler over the same fight window found what does
//    (CPU_PROFILE): a SYNCHRONOUS `gl.readPixels` in the boss-exposure governor
//    at 1.55 ms/frame, and two MutationObserver callbacks doing
//    `getComputedStyle` + `offsetWidth` across every overlay — both carrying a
//    comment claiming they ran "on mutation, never per frame" — at 0.77
//    ms/frame. Together 17.5% of a 13.26 ms main thread. Removing them took the
//    floor-15 fight from 25.96 to 11.97 ms delivered at LOW, 30.90 to 24.11 at
//    MEDIUM, 54.44 to 43.60 at HIGH.
//
//    AND IT EXPLAINS THE FIGHT/PINNED GAP. The fight used to cost 20-30% more
//    than the same pack standing still; it now costs the same. The difference
//    WAS the reflow storms, and the HUD churns hardest while you fight.
//
// 4. A SHADER MICRO-OPTIMISATION MEASURED NEUTRAL AND IS PUBLISHED AS SUCH.
//    The world-lit fragment shader was doing seven dependent texture fetches
//    per fragment over the whole screen; two were removed (the fog mask and the
//    walk-distance field became one RG8 fetch, and the murk/atmosphere/glint
//    block moved inside a coherent branch that explored ground skips). On the
//    GPU clock, reverting both scored 0.982 and 1.009 — i.e. nothing. The
//    changes are kept because they strictly remove work, but the world material
//    is NOT sampler-bound, and the negative result is the useful part: see
//    GPU_LAYERS and POINT_LIGHT_SHARE for where that frame actually is.
//
// AND THE INSTRUMENT CHANGED, WHICH IS WHY ANY OF THIS IS TRUSTABLE. Three
// earlier attempts at a GPU clock produced plausible numbers and all three were
// wrong (tools/o3lab.mjs lists them); the ladder's old contention canary left
// the game's per-frame CPU running and so rose with SCENE LOAD, discarding
// every HIGH fight window and every discrete-GPU fight window on a quiet box.
// Every window is now scored on the median of EXT_disjoint_timer_query_webgl2
// TIME_ELAPSED over the composed frame, and the Intel session behind MEASURED
// ran with the contamination meter at zero foreign browsers.
//
// ============================================================================
// WHY THIS FILE WAS RE-CUT (and what the four-rung ladder got wrong)
// ============================================================================
//
// The ladder this replaces had four rungs (ULTRA/HIGH/BALANCED/PERFORMANCE) and
// spent exactly one thing: PIXEL RATIO. Its own comment said so in capitals —
// "SO THE LADDER SPENDS RESOLUTION AND *ONLY* RESOLUTION". That was a correct
// conclusion from a wrong measurement, and both halves have to be retracted.
//
// 1. EVERY NUMBER THAT LADDER WAS BUILT ON WAS TAKEN ON THE WRONG GPU.
//    This box has an Intel iGPU and an NVIDIA RTX 5090 Laptop GPU. Chromium's
//    `--use-angle=d3d11` — the flag every previous round used — selects the
//    INTEL part. The discrete part needs `--force_high_performance_gpu`. The
//    page's own `powerPreference: "high-performance"` does not reach far enough
//    up the stack to matter; adapter selection happens above the page.
//    tools/_gpupick.mjs reproduces all three cases.
//
// 2. RETRACTED, WITH THE MEASUREMENT THAT RETRACTS IT: "RESOLUTION CANNOT
//    SEPARATE THE TIERS, BECAUSE MOST OF THE FRAME IS CPU."
//
//    That sentence stood here in capitals and it is wrong on the Intel part.
//    It was concluded from MEDIAN rAF deltas, and the median of a queue-ahead
//    distribution is a description of the cheap mode only: when the swap chain
//    fills, rAF hands back a run of near-free callbacks and then one long one,
//    so a median can read 10 ms while the player is getting 22 fps. The file
//    knew this — the auto-tuner comment three hundred lines below says a
//    median "reads 10 ms, wonderful and never downgrades a machine running at
//    24 fps" — and then the ladder was measured with one anyway.
//
//    Re-measured on DELIVERED THROUGHPUT (frames / wall seconds, which counts
//    the cheap queued callback as the frame the player paid for), sweeping
//    renderScale in ONE page session, floor-15 dense pack, HIGH, vsync off
//    (tools/r2_fill.mjs):
//
//        4.91 Mpx -> 52.95 ms      2.07 Mpx -> 28.56 ms
//        3.14 Mpx -> 38.81 ms      1.23 Mpx -> 19.50 ms
//
//        fit:  delivered ms = 8.3 + 9.1 * backbuffer megapixels
//
//    Four points, straight line, and the intercept is real. So the Intel frame
//    is BOTH things, in a ratio that flips across the ladder: at HIGH's 4.9 Mpx
//    the pixels are 84% of the frame, at LOW's 1.2 Mpx they are 57%. Resolution
//    is the strongest lever this ladder has on the weak path, and the fixed
//    8.3 ms is the reason LOW could never reach 16.7 ms no matter how small the
//    buffer got.
//
//    ON THE DISCRETE PART THE SAME SWEEP IS FLAT and the original conclusion
//    survives verbatim. Sandwiched A/B on the RTX 5090 at HIGH, dense pack
//    (tools/r2_post.mjs): disabling the ENTIRE post chain — GTAO, bloom, grade
//    and SMAA together — moved delivered frame time by 0.29 ms of 12.0, i.e.
//    2.4%. The two adapters do not share a bottleneck and must not share a
//    diagnosis.
//
// 3. WHAT THE FRAME IS ACTUALLY SPENT ON, per adapter, measured by sandwiched
//    A/B in the floor-15 dense pack at HIGH (tools/r2_cpu.mjs, r2_post.mjs).
//    Every arm sits between two baseline windows and is scored as a ratio to
//    its own neighbours, because absolute pooling does not survive this box.
//
//                                  RTX 5090 (14.2 ms)   Intel (52.9 ms)
//        submit nothing at all          -9.2 ms              --
//        scene pass + shadow pass       -6.5 ms            ~-20 ms
//        shadow pass alone              -2.0 ms              --
//        ENTIRE post chain              -0.0 ms            ~-25 ms
//          of which GTAO                                   ~-17 ms
//          of which SMAA                                    ~-8 ms
//        every AnimationMixer off       -0.4 ms              --
//        freeze the scene graph         -0.4 ms              ~0 ms
//        particles + sprites            -1.5 ms              --
//
//    Read the two columns as two different machines, because they are. On the
//    RTX nothing about the pixels matters and the frame is submission plus host
//    JS. On the Intel part the post chain alone is roughly half the frame and
//    GTAO alone is a third of it.
//
//    AND THE SCENE-GRAPH WALK IS NOT THE FRAME ON EITHER. The previous round
//    won a real fix here (7,595 matrices a frame to draw 13 monsters) and then
//    over-generalised from it: freezing the graph outright now moves 3% on the
//    RTX and nothing measurable on the Intel part. That work is done.
//
// ============================================================================
// SO THE MODES SPEND THREE THINGS, AND THE FIRST ONE IS MOST OF IT
// ============================================================================
//
//   pixelRatioCap        softness. 9.1 ms/Mpx on the iGPU, ~0 on the dGPU —
//                        the dominant lever on the machine the promises are
//                        made to, and nearly a no-op on the other.
//   shadow map + cadence crispness and staleness of contact shadows.
//   AO / bloom scale     the post tail. NOT small on the Intel part: GTAO is a
//                        third of that frame, which is why the AO denoise now
//                        runs at the AO buffer's own resolution on every rung.
//   off-screen rig rate  rigs that are not on screen animate at a lower rate.
//                        Kept because it is invisible by construction, not
//                        because it is large — it is ~3% on the RTX.
//
// WHAT WAS RETIRED THIS ROUND: `rigBudget`, the cap on how many ON-SCREEN rigs
// could take a full-rate mixer update. It demoted bodies the player was looking
// at (measured: 14 at full rate against 23-45 in frustum on LOW) to save a
// fraction of half a millisecond. See the gate in Renderer3D.update().
//
// WHAT IS **NOT** A MODE LEVER, because it is free and therefore belongs to
// every mode: parking out-of-vision bodies out of the scene graph entirely,
// refreshing the HUD's screen rects on a cadence instead of six
// getBoundingClientRect calls per frame, and phase-spreading the gated mixer
// flushes so they stop landing on one frame in ten. A win with no visual cost
// is not a setting; tiering it would just make HIGH needlessly slow.
//
// AND WHAT IS STILL NOT CUT: ambient occlusion, particle density, mote density
// and the light pools are IDENTICAL on all three rungs, and no mode demotes a
// body that is on screen. Those are losses a player can name.

export type QualityName = "low" | "medium" | "high";

/** Best → cheapest. The auto-tuner walks this array. */
export const QUALITY_ORDER: readonly QualityName[] = ["high", "medium", "low"];

/**
 * WHAT A MODE PROMISES.
 *
 * The budget is a CEILING in the worst scene on the WEAK PATH (the Intel iGPU),
 * not a target to sit on. MEDIUM measuring better than 33.3 ms is a bonus, not
 * a contract violation; MEDIUM measuring worse is a bug.
 */
export interface ModeContract {
  /**
   * DELIVERED ms/frame this mode may not exceed on the weak path in the worst
   * scene, or null for "no gate".
   *
   * IT IS DELIVERED TIME, NOT THE MEDIAN, AND THAT IS THE WHOLE CORRECTION.
   * The previous ladder stated its budgets against MEASURED[] medians, and the
   * acceptance pass measured what that bought: HIGH on the Intel part in an
   * EMPTY ROOM read a median of 9.7 ms while delivering 22.3 fps — 44.8 ms per
   * frame the player actually received. The median flattered by 4.6x, in the
   * one direction that makes a promise look kept. Delivered ms is frames
   * divided by wall seconds; a queued cheap callback cannot hide inside it.
   */
  readonly budgetMs: number | null;
  /**
   * Ceiling on the SHARE of individual frames allowed over `budgetMs`, in
   * percent. A throughput number alone still cannot see a stutter: a mode can
   * average 25 ms and spend one frame in five above 33. Both halves are the
   * promise, so both halves are checked.
   */
  readonly maxOverPct: number | null;
  /** Plain-language version of the promise, for the settings row. */
  readonly promise: string;
  /**
   * WHAT THIS MODE MEANS ON A DISCRETE GPU — the sentence the settings row
   * prints when the unmasked renderer is not an integrated part.
   *
   * IT EXISTS BECAUSE THE LADDER IS MEANINGLESS THERE AND NOTHING SAID SO.
   * Measured on an RTX 5090 Laptop GPU in the fight scene, the three modes
   * deliver 17.79 / 16.78 / 20.11 ms — LOW is not merely close to MEDIUM, it is
   * SLOWER than it, and it is 22.4% over its own 20 ms budget while MEDIUM is
   * 5.7% over 33.3. A player on that machine who picks the performance mode
   * buys a softer picture and no frames at all. The previous ladder carried a
   * whole discrete-GPU column that no contract read and no promise mentioned;
   * this is the half of it a player is entitled to.
   */
  readonly discrete: string;

  // ---- THE LEVER CEILINGS THE BUDGET WAS MEASURED AT ----
  //
  // A budget in milliseconds is a fact about ONE build at ONE moment. It cannot
  // notice that somebody later raised LOW's pixel ratio "just a bit", because
  // the transcribed number does not move when the preset does. These four caps
  // are what the measurement was taken with, so raising any of them invalidates
  // the measured number and test/quality.test.ts refuses.
  //
  // They are deliberately set EXACTLY at the shipped values: this is a
  // regression guard, and the honest position after a change is to re-measure
  // and move both the cap and the number together, not to leave slack that lets
  // a preset drift away from its evidence in silence.
  readonly maxPixelRatio: number;
  /** shadowWeight(): (mapSize/2048)^2 / interval. */
  readonly maxShadowCost: number;
  /** rigWeight(): share of the full-rate mixer cost still paid. */
  readonly maxRigCost: number;
  /** postWeight(): share of GTAO+bloom still paid. */
  readonly maxPostCost: number;
}

export interface QualityProfile {
  readonly name: QualityName;
  /** Label for the settings row. */
  readonly label: string;
  /** One-line explanation for the settings row's <small>. */
  readonly blurb: string;
  readonly contract: ModeContract;

  // ---- Resolution ----
  /** Hard cap on devicePixelRatio. Quadratic in the pixel-bound part of the
   *  frame — which on the discrete GPU is approximately none of it. */
  readonly pixelRatioCap: number;

  // ---- Anti-aliasing ----
  /** Composer render-target MSAA. Keep at 0 — see the MSAA cliff note below.
   *  Left configurable only so a future non-Intel path can opt back in. */
  readonly msaaSamples: number;
  /** SMAA post pass (replaces the render target's MSAA). */
  readonly smaa: boolean;

  // ---- Ambient occlusion ----
  readonly gtao: boolean;
  /** Resolution scale for the AO buffer itself. */
  readonly gtaoScale: number;
  /**
   * Denoise buffer scale. INVARIANT: every shipped mode sets this EQUAL to
   * `gtaoScale`, and test/quality.test.ts enforces it.
   *
   * WHY IT MOVED. It used to be 1 on HIGH — a full-resolution, depth+normal
   * weighted denoise over an AO buffer that was rendered at half resolution,
   * justified as "it doubles as a bilateral upsample". The arithmetic of that
   * on the weak path: the AO pass is 1.23 Mpx x 12 taps = 14.7 Mtaps, and the
   * denoise above it was 4.91 Mpx x 8 samples x 2 rings = 78 Mtaps — five times
   * the pass it was cleaning, spent re-blurring values bilinear interpolation
   * had just invented. GTAO measured a third of the entire Intel frame.
   *
   * Denoising at the AO buffer's own resolution and letting the composite's
   * bilinear fetch do the upsample removes that multiplier. It is not a quality
   * cut in the direction the old comment feared: the halo bleed it warned about
   * comes from upsampling UNFILTERED half-res AO, and the filtering still
   * happens — just at the resolution the data actually has.
   */
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

  // ---- Rig animation (the one CPU lever left) ----
  //
  // Floor 15: 149 rigs, 18 on screen. AnimationMixer.update over the other 131
  // poses bones that no pass reads. ONE knob, not two: `rigBudget` — a cap on
  // how many ON-SCREEN rigs could animate at full rate — was retired in opt r2
  // because it demoted bodies the player was looking at (14 at full rate
  // against 23-45 in frustum on LOW) to buy 3% of the frame on the RTX. The
  // header note above has the measurement.
  //
  // NOTE THE MECHANISM IS RATE, NOT ON/OFF. A skipped mixer would leave
  // one-shot clips ("busy") never draining, crossfades never finishing, and
  // LoopOnce actions never firing `finished` — the rig would come back on
  // screen wedged mid-swing. Instead the off-screen rigs ACCUMULATE dt and
  // flush one larger mixer.update at the rate below, so every clip still
  // advances in real time and only the sampling granularity changes.
  /** Mixer flush rate (Hz) for rigs that are not on screen. Infinity = every
   *  frame, i.e. no gate at all. */
  readonly offscreenRigHz: number;

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

// THE MSAA CLIFF, kept because it is still true and still load-bearing. The
// composer's render target was once `samples: 4` on a HalfFloat (RGBA16F)
// surface: 8 bytes/px x 4 samples x 4.9 Mpx is ~157 MB of multisampled traffic
// per frame on a GPU with no dedicated VRAM, and every pass that READS the
// composer target forces a resolve blit, so the cost was paid several times
// over. Measured at native resolution: 60 ms with samples=4, 9 ms with
// samples=0. samples=2 is not a compromise (-7%): the cost is having a
// multisampled HDR target at all, not the sample count. Geometry AA moves to
// SMAA, ~3 fullscreen LDR passes, measured under the noise floor.
//
// POST-CHAIN PASS AUDIT (opt r4). The composed frame ran renderer.render() 23
// times per rAF — RenderPass, GTAO (AO + denoise + blend), UnrealBloom's ~12
// internal steps, OutputPass, a Grade ShaderPass, and SMAA's three. Three
// things were checked and only one of them was waste:
//
//   * A DISABLED PASS IS FREE. EffectComposer's loop is `if (pass.enabled ===
//     false) continue` — no target bind, no quad, no resolve. A preset that
//     turns gtao/bloom/smaa off genuinely pays nothing, so `postWeight()` is
//     not understating anything.
//   * THERE IS NO TRAILING COPY BLIT TO MERGE. The composer marks the LAST
//     ENABLED pass `renderToScreen`, so SMAA's blend step already writes the
//     default framebuffer directly. Nothing to fuse with it.
//   * THE GRADE PASS WAS A WHOLE ROUND TRIP FOR SIX ALU OPS, and it is gone:
//     it now runs at the end of OutputPass's own fragment shader
//     (OutputGradePass in renderer3d.ts). 23 -> 22 renderer.render() calls and
//     one fewer full-resolution RGBA16F read+write — ~30 MB/frame of traffic
//     at the 1652x1148 backbuffer, on a part with no dedicated VRAM.
//
//     Floor-16 fight, Intel part, CPU throttle 4x, 1180x820 @ dsf2, two runs
//     per arm, 30 s windows: p50 50.0/50.1 -> 33.3/33.3 ms, delivered 17.4/19.4
//     -> 34.7/34.9 fps. The size of that step is the vsync grid, not the size
//     of the pass: the frame was sitting just ABOVE 33.3 ms, so shaving a
//     millisecond or two off it moves the delivered frame from three vsyncs to
//     two. The same removal on a frame that is not near a boundary would buy
//     the millisecond and nothing else. (Session was contended — 82 foreign
//     chrome processes — so read the A/B, not the absolutes.)
//
//     Pixel-identical by construction and it was checked, not assumed: the two
//     shader paths were rendered into ONE frozen frame in one synchronous task
//     (tools/postchain_pixgate.mjs). With SMAA off, max channel delta 1 on all
//     three scenes. With SMAA on, 32-76 isolated pixels of 1.9 M exceed delta
//     4 — a thresholded edge classifier reclassifying a pixel whose input
//     moved by one LSB, which is what any 1-LSB change anywhere in the chain
//     does to it.
//
// NOTE ON LIGHT COUNTS: a forward renderer compiles a distinct program per
// light count, and both pools are pre-built and pre-compiled during
// Renderer3D.prewarm(). Changing either number AFTER prewarm would trigger a
// mid-game shader build — exactly the multi-second hitch r2 traced and killed.
// So the pool sizes are read once, when the pools are first built, and a later
// mode switch deliberately leaves them alone (see Renderer3D). Consequently
// every profile declares the SAME counts: a differing value would be a field
// that silently does nothing, which is worse than no field.

/**
 * HIGH — the best this engine can do. NOT budget-gated, by design.
 *
 * Everything it measured is in MEASURED below, in full: delivered throughput,
 * p50, p90, p99 and the share of frames over 33.3 ms, on both adapters, in both
 * the dense pack and the quiet room. Nothing is transcribed twice — a number
 * repeated in a doc comment is a number that will rot out of agreement with the
 * table, and the last ladder rotted exactly that way.
 *
 * THE ONE THING TO READ THERE: on the Intel part HIGH delivers roughly a third
 * of what it delivers on the RTX while its MEDIAN reads close to the same. That
 * gap is the swap chain — rAF queues cheap callbacks until it fills, then
 * blocks — and it is why every number in this file is now stated on delivered
 * time. A player who picks HIGH on an integrated part has been told what they
 * are buying: the settings row says "no frame-rate promise" in those words.
 */
const HIGH: QualityProfile = {
  name: "high",
  label: "HIGH",
  blurb: "everything at full strength — no frame-rate promise",
  contract: {
    budgetMs: null,
    maxOverPct: null,
    promise: "the best this engine can do — uncapped, and it will cost what it costs",
    discrete: "on a discrete GPU this is close to free: it measured 20.1 ms against "
      + "LOW's 17.8 in the worst fight, so there is very little to save by choosing anything else",
    maxPixelRatio: 2,
    maxShadowCost: 1,
    maxRigCost: 1,
    maxPostCost: 0.9,
  },
  pixelRatioCap: 2,
  msaaSamples: 0,
  smaa: true,
  gtao: true,
  gtaoScale: 0.5,
  gtaoDenoiseScale: 0.5,   // == gtaoScale on every rung; see the field's note
  gtaoSamples: 12,
  gtaoDenoiseSamples: 8,
  bloom: true,
  bloomScale: 0.5,
  shadowMapSize: 2048,
  shadowInterval: 1,
  offscreenRigHz: Infinity,
  fxDensity: 1,
  moteDensity: 1,
  fxLights: 4,
  torchLights: 8,
};

/**
 * MEDIUM — the default.
 *
 * IT NO LONGER SITS ON ITS OWN BOUNDARY. The acceptance pass caught this
 * contract flipping between sessions of the same build — 22.8% and 26.0% of
 * frames over 33.3 ms against a 25% cap, one pass and one fail — which is a
 * coin flip with a number written next to it, not a contract. Measured now in
 * the fight scene it is 18.4%, and in the pinned pack 15.7%: the cap is
 * unchanged and the margin is real.
 *
 * HISTORY. ITS PROMISE WAS FALSE AND HAS BEEN REWRITTEN. The shipped line was "never
 * below 30 fps, even in the worst fight, on integrated graphics", and the
 * settings row prints `contract.promise` verbatim, so that sentence was a
 * player-facing guarantee. Measured on the Intel part with the preset verified
 * active, it was broken in the WORST case (22.2% of frames over 33.3 ms) and
 * broken again in a QUIET EMPTY ROOM (17.2% over 33.3, p99 188.4 ms) — one
 * frame in five, with nothing on screen.
 *
 * "Never" is not a claim this engine can make on that adapter, and the correct
 * response is to stop making it rather than to keep measuring it with a kinder
 * statistic. What MEDIUM promises now is what MEASURED supports: the mode is
 * budgeted on DELIVERED throughput with an explicit ceiling on the share of
 * frames that may exceed it, and the promise text says "aims" where the
 * measurement says "usually" — see budgetMs / maxOverPct.
 */
const MEDIUM: QualityProfile = {
  ...HIGH,
  name: "medium",
  label: "MEDIUM",
  blurb: "the default — the full look, tuned to hold a playable frame on integrated graphics",
  contract: {
    budgetMs: 33.3,
    maxOverPct: 25,
    promise: "the default — aims to stay above 30 fps on integrated graphics, and it still looks like the game",
    discrete: "on a discrete GPU this is the fastest of the three as well as the "
      + "sharpest — it measured 16.8 ms in the worst fight against LOW's 17.8, so there is "
      + "no reason to go below it",
    maxPixelRatio: 1.4,
    maxShadowCost: 0.28125,   // (1536/2048)^2 / 2
    maxRigCost: 0.2967,       // 18 on screen at full rate + 131 off at 12 Hz, of 149
    maxPostCost: 0.69,
  },
  pixelRatioCap: 1.4,
  gtaoScale: 0.5,
  gtaoDenoiseScale: 0.5,
  gtaoSamples: 9,
  gtaoDenoiseSamples: 6,
  bloomScale: 0.45,
  shadowMapSize: 1536,
  shadowInterval: 2,
  offscreenRigHz: 12,
};

/**
 * LOW — the mode that carries the frame-rate guarantee.
 *
 * IT NOW MEETS ITS CONTRACT, AND THE CONTRACT IS GRADED ON THE RIGHT NUMBER.
 *
 * `maxOverPct` moved from 10 to 15 and that is a TIGHTENING, not a loosening,
 * because 10 was never evaluated: the test read the share of frames over
 * 33.3 ms, where LOW sits at 4.5%, instead of the share over its own 20 ms
 * budget, where it sat at 29.9%. A ceiling nothing grades is not a commitment.
 * 15 is where two independent sessions in two scenes agree (9.5% and 9.8% in
 * the fight, 10.7% and 12.7% in the pinned pack) — the same standard this round
 * applied to MEDIUM's boundary.
 *
 * WHAT IT SPENDS TO GET THERE. Resolution is its stated lever and it is spent
 * harder: pixelRatioCap 0.8 (from 1) and the shadow map rebuilt every fourth
 * composed frame (from every third). On a devicePixelRatio-2 display that is a
 * softer frame and nothing else, and a player who picks the performance mode is
 * choosing exactly that trade.
 *
 * THE REST OF THE WIN WAS NOT A LEVER AT ALL. LOW went from 25.96 ms to
 * 11.97 ms in the worst scene, and only a fraction of that is the pixel ratio:
 * the rest is the two main-thread costs opt r3 removed (CPU_PROFILE). LOW is
 * where that matters most, because at LOW the GPU has headroom the main thread
 * was refusing to use — halving its GPU clock did not move its delivered time.
 *
 * HISTORY. IT USED TO PROMISE 60 fps AND IT NEVER DELIVERED 60 fps. The old contract was
 * budgetMs 16.7, justified by a MEASURED median of 15.1 — while the same
 * samples had a mean of 17.2, which the file admitted was over, and a delivered
 * throughput nobody wrote down. The fill fit says why the promise was
 * unreachable in principle: on the Intel part
 *
 *     delivered ms = 8.3 + 9.1 * backbuffer Mpx
 *
 * and LOW's buffer is 1.227 Mpx at the reference viewport. Even at ZERO pixels
 * the fixed term alone is half the 16.7 ms budget; the mode could not have got
 * there by turning anything in this file down. A promise that the levers cannot
 * reach is not a tight promise, it is a wrong one.
 *
 * So the number moved to one the measurement supports, and the levers moved to
 * earn it — see MEASURED for both the before and the after.
 *
 * WHAT IT GIVES UP, honestly: the frame is rendered at 1x pixel density (softer
 * — the only thing a player is likely to notice), contact shadows are half the
 * map resolution and rebuild every third frame, ambient occlusion is quarter
 * resolution, and rigs that are NOT ON SCREEN pose at 6 Hz.
 *
 * WHAT IT NO LONGER GIVES UP: bodies the player is looking at. `rigBudget: 14`
 * used to demote a third to a half of the visible pack to 6 Hz — measured, with
 * the gate's own output — while quality.ts claimed in this very file that "an
 * off-screen rig is off screen". That cap is gone.
 *
 * There is no mode below this one. A machine that cannot hold this has nowhere
 * left to fall, which is why it is allowed to look plainer.
 */
const LOW: QualityProfile = {
  ...HIGH,
  name: "low",
  label: "LOW",
  blurb: "the performance mode — the softest frame this engine draws, same game, nothing on screen is cut",
  contract: {
    budgetMs: 20,
    maxOverPct: 15,
    promise: "the smoothest this engine gets — aims to stay above 50 fps on integrated graphics",
    discrete: "on a discrete GPU this buys you nothing but a softer picture: it measured "
      + "17.8 ms in the worst fight against MEDIUM's 16.8, i.e. very slightly SLOWER than the "
      + "sharper mode. Pick it only on integrated graphics",
    maxPixelRatio: 0.8,
    maxShadowCost: 0.0625,    // (1024/2048)^2 / 4
    maxRigCost: 0.2088,       // 18 on screen at full rate + 131 off at 6 Hz, of 149
    maxPostCost: 0.2409,  // gtaoScale .25 x 5 samples, denoise .25 x 4, bloom .35
  },
  pixelRatioCap: 0.8,
  gtaoScale: 0.25,
  gtaoDenoiseScale: 0.25,
  gtaoSamples: 5,
  gtaoDenoiseSamples: 4,
  bloomScale: 0.35,
  shadowMapSize: 1024,
  shadowInterval: 4,
  offscreenRigHz: 6,
};

export const QUALITY_PRESETS: Record<QualityName, QualityProfile> = {
  high: HIGH,
  medium: MEDIUM,
  low: LOW,
};

// ============================================================================
// WHAT MAKES THE CONTRACT TESTABLE — and the cost model that was NOT shipped
// ============================================================================
//
// A comment saying "LOW measured 11.2 ms" rots the moment somebody raises
// LOW.pixelRatioCap, and nothing catches it. The first attempt at a fix was a
// linear cost model: write the measured ablation deltas down as per-lever
// coefficients, reconstruct each preset's frame time from its own fields, and
// assert the reconstruction lands inside the budget.
//
// IT DOES NOT FIT, AND THE REASON IS WORTH KEEPING. Measured p10 on the Intel
// part across the three shipped presets:
//
//     LOW    ->  MEDIUM     +3.6 ms   for +1.18 Mpx and +0.11 rig weight
//     MEDIUM ->  HIGH       +3.5 ms   for +2.50 Mpx and +0.70 rig weight
//
// The second step buys twice the pixels and six times the rig work for the same
// money. Any non-negative linear fit through those three points needs a
// NEGATIVE rig coefficient, which is nonsense. The frame is sub-linear because
// at HIGH it stops being a queue of independent frames: rAF runs ahead, fills
// the swap chain, and blocks — the same bimodal distribution that makes the
// median flatter HIGH (median 24.2 against a mean of 55.1). A model fitted
// through that would be a number generator with the shape of physics, and it
// would have been fitted by tuning coefficients until the presets passed, which
// is precisely the thing the test is supposed to prevent.
//
// SO THE CONTRACT IS CHECKED THE BORING WAY, IN TWO HALVES:
//   1. the transcribed MEASURED median must be inside the declared budgetMs;
//   2. the preset's own lever values must be inside the contract's four
//      max*Cost caps — the values the measurement in (1) was taken at.
// Together those fail on exactly the thing that matters: a preset drifting away
// from the evidence that justified its promise. No fitted constants, nothing
// that can be quietly tuned into agreement.

export type Adapter = "igpu" | "dgpu";
export type SceneName = "fight" | "dense" | "quiet";

/**
 * THE SCENES THE CONTRACTS ARE STATED AGAINST — and the one that was missing.
 *
 * REFERENCE_SCENE, which every previous number in this file was measured in,
 * teleported the crawler into the densest live pack and PINNED THEM ALIVE
 * there: standing still, never swinging, never spending an ability. Staging the
 * same floor-15 pack with the crawler actually FIGHTING measured 15-45% worse
 * in every mode while showing FEWER bodies on screen (fight windows averaged
 * 20-27 visible against dense's 35), which is the whole argument: the cost was
 * never the density, and a ladder measured standing still is a ladder measured
 * in a scene the game is not played in.
 *
 * So `fight` is the contract scene now, and `dense` is kept beside it because
 * the two of them disagreeing is information.
 *
 * AND THEY NO LONGER DISAGREE, WHICH IS THIS ROUND'S CLEANEST RESULT. Before
 * the main-thread work below was removed, the fight was 20-30% worse than the
 * pinned pack at every rung. After, the two are inside each other's noise
 * (LOW 11.97 vs 12.12 ms, MEDIUM 24.11 vs 22.20, HIGH 43.60 vs 44.17). The gap
 * WAS the two forced-reflow storms — both of them driven by HUD churn, and the
 * HUD churns hardest when you are fighting.
 */
export const SCENES: Record<SceneName, string> = {
  fight:
    "floor 15, staged dense pack WITH THE CRAWLER FIGHTING (tools/o3_modes.mjs "
    + "--scene fight): teleported into the densest live cluster, whole pack "
    + "revived to full HP between every window so a thinning pack cannot charge "
    + "the later modes for a lighter scene, and the basic attack held down with "
    + "all four ability slots plus the ultimate fired on rotation for the entire "
    + "window through real KeyboardEvents. 1440x852 CSS @ devicePixelRatio 2; "
    + "vsync off; 3 reps with the mode order ROTATED inside each rep, all inside "
    + "ONE page session; ~1,700 scene nodes.",
  dense:
    "the same staging with the crawler pinned alive and NOT attacking — the old "
    + "REFERENCE_SCENE, kept so the fight/pinned gap stays visible. It is the "
    + "scene every contract in this file used to be stated against.",
  quiet:
    "the same session shape with the crawler walked to the farthest point from "
    + "any live monster. Fewer bodies, same backbuffer, same post chain, same "
    + "shader-build exposure — the scene in which a previous round found "
    + "MEDIUM's promise broken on one frame in five with nothing on screen.",
};

/** The scene the budgets are graded in. */
export const WORST_SCENE: SceneName = "fight";

/** CSS-pixel area of the reference viewport, in megapixels at ratio 1. */
const REFERENCE_CSS_MPX = (1440 * 852) / 1e6;

/** Backbuffer megapixels this preset asks for, in the reference viewport. */
export function referenceMegapixels(p: QualityProfile): number {
  const ratio = Math.min(2, p.pixelRatioCap); // the reference display is dpr 2
  return REFERENCE_CSS_MPX * ratio * ratio;
}

/**
 * Fraction of the shadow pass a preset still pays. Area scales with the map
 * edge squared; cadence divides the draw calls.
 */
export function shadowWeight(p: QualityProfile): number {
  if (p.shadowMapSize <= 0) return 0;
  const area = (p.shadowMapSize / 2048) ** 2;
  return area / Math.max(1, p.shadowInterval);
}

/**
 * Fraction of the full-rate mixer cost a preset still pays, in the reference
 * scene: 149 rigs, 18 of them on screen. ON-SCREEN RIGS ALWAYS ANIMATE EVERY
 * FRAME; the only thing a preset spends is the rate the off-screen 131 are
 * sampled at.
 */
const REF_RIGS = 149;
const REF_RIGS_ON_SCREEN = 18;
export function rigWeight(p: QualityProfile): number {
  const off = REF_RIGS - REF_RIGS_ON_SCREEN;
  const offRate = Math.min(1, p.offscreenRigHz / 60);
  return (REF_RIGS_ON_SCREEN + off * offRate) / REF_RIGS;
}

/** Fraction of the post chain a preset still pays. */
export function postWeight(p: QualityProfile): number {
  const ao = p.gtao
    ? (p.gtaoScale / 0.5) * (p.gtaoSamples / 12) * 0.7
      + (p.gtaoDenoiseScale / 1) * (p.gtaoDenoiseSamples / 8) * 0.2
    : 0;
  const bl = p.bloom ? (p.bloomScale / 0.5) * 0.1 : 0;
  return ao + bl;
}

/**
 * THE FULL SHAPE OF ONE MODE IN ONE SCENE ON ONE ADAPTER.
 *
 * `overBudget` IS NEW AND IT IS THE POINT OF THIS ROUND'S TEST FIX. The shape
 * carried only `over33`, and test/quality.test.ts graded EVERY mode's
 * `maxOverPct` against it — including LOW, whose budgetMs is 20, not 33.3.
 * `maxOverPct` is documented as "the SHARE of individual frames allowed over
 * budgetMs", so LOW's stated ceiling had never once been evaluated: it was
 * graded against a threshold 66% looser than the field describes. The previous
 * round fixed MEASURED to carry a full distribution and then read the wrong
 * percentile out of it, which is the same flattering-statistic failure one
 * layer down.
 */
export interface MeasuredShape {
  /** Frames delivered per wall-clock second. The honest headline. */
  readonly fps: number;
  /** Wall ms per delivered frame = 1000/fps. What `budgetMs` is checked against. */
  readonly delivered: number;
  /** Median rAF delta — carried ONLY so the gap to `delivered` stays visible. */
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  /** % of individual frames over 33.3 ms. Comparable across modes. */
  readonly over33: number;
  /** % of frames over THIS mode's own budgetMs. What `maxOverPct` grades. */
  readonly overBudget: number | null;
}

/**
 * WHAT WAS ACTUALLY ON THE CLOCK, per scene, per mode, per adapter.
 *
 * Transcribed from tools/_o3modes_final_igpu.json and _o3modes_final_dgpu.json
 * (tools/o3_modes.mjs). Nothing in this file derives them.
 *
 * THE HARNESS EARNS THE NUMBERS AND IS PART OF THE CLAIM. Mode order rotates
 * inside every rep, the pack is revived to full between every window, the raw
 * frame deltas survive to the end, and a window whose preset fingerprint moved
 * is refused outright. The Intel session ran with the contamination meter at
 * ZERO foreign browsers throughout — the first time that has been true for a
 * table in this file; the RTX session ran with 9, so its absolutes are an upper
 * bound and only its own ladder is meaningful.
 *
 * THE CONTENTION CANARY IS GONE AND ITS ABSENCE IS DELIBERATE. The one this
 * replaces rendered the post chain over an empty scene and timed rAF, which
 * leaves the game's ENTIRE per-frame CPU running — so on a completely quiet box
 * it rose with SCENE LOAD (4-5 ms parked in the pack, 8-18 ms mid-fight) and,
 * against its own 14 ms ceiling, discarded all three HIGH fight windows and
 * every discrete-GPU fight window. A gate that systematically evicts the
 * expensive mode from the expensive scene biases the table toward the cheap, in
 * the same direction as every other error this round was convened to fix. What
 * replaced it is a real instrument, not a better threshold: every window also
 * carries the median of EXT_disjoint_timer_query_webgl2 TIME_ELAPSED over the
 * composed frame, so contention shows up as a wall/GPU disagreement instead of
 * silently deciding which windows count.
 *
 * READ `delivered` AGAINST `p50` FIRST. Where they agree the frame is genuinely
 * paced; where `delivered` is a multiple of `p50` the swap chain is queueing
 * cheap callbacks in front of expensive ones and the median is describing the
 * queue rather than the machine.
 */
export const MEASURED: Record<SceneName, Record<QualityName, Record<Adapter, MeasuredShape>>> = {
  fight: {
    high: {
      igpu: { fps: 22.94, delivered: 43.60, p50: 16.8, p90: 106.3, p99: 345.5, over33: 31.1, overBudget: null },
      dgpu: { fps: 49.74, delivered: 20.11, p50: 14.7, p90: 34.3, p99: 83.1, over33: 11.3, overBudget: null },
    },
    medium: {
      igpu: { fps: 41.48, delivered: 24.11, p50: 11.2, p90: 54.8, p99: 126.0, over33: 18.4, overBudget: 18.4 },
      dgpu: { fps: 59.58, delivered: 16.78, p50: 13.6, p90: 27.7, p99: 53.9, over33: 5.7, overBudget: 5.7 },
    },
    low: {
      igpu: { fps: 83.52, delivered: 11.97, p50: 8.6, p90: 19.1, p99: 60.0, over33: 4.5, overBudget: 9.5 },
      dgpu: { fps: 56.22, delivered: 17.79, p50: 12.6, p90: 26.9, p99: 88.9, over33: 5.9, overBudget: 22.4 },
    },
  },
  dense: {
    high: {
      igpu: { fps: 22.64, delivered: 44.17, p50: 17.6, p90: 117.7, p99: 264.5, over33: 39.0, overBudget: null },
      dgpu: { fps: 57.62, delivered: 17.36, p50: 14.3, p90: 29.6, p99: 46.5, over33: 6.6, overBudget: null },
    },
    medium: {
      igpu: { fps: 45.05, delivered: 22.20, p50: 11.1, p90: 49.0, p99: 145.3, over33: 15.7, overBudget: 15.7 },
      dgpu: { fps: 68.38, delivered: 14.62, p50: 11.2, p90: 27.7, p99: 43.9, over33: 4.7, overBudget: 4.7 },
    },
    low: {
      igpu: { fps: 82.49, delivered: 12.12, p50: 9.1, p90: 24.7, p99: 49.3, over33: 5.5, overBudget: 12.7 },
      dgpu: { fps: 69.03, delivered: 14.49, p50: 11.3, p90: 26.2, p99: 42.9, over33: 4.8, overBudget: 21.5 },
    },
  },
  quiet: {
    high: {
      igpu: { fps: 74.58, delivered: 13.41, p50: 11.8, p90: 22.5, p99: 69.8, over33: 5.5, overBudget: null },
      dgpu: { fps: 176.25, delivered: 5.67, p50: 5.4, p90: 7.1, p99: 10.2, over33: 0, overBudget: null },
    },
    medium: {
      igpu: { fps: 148.26, delivered: 6.74, p50: 3.9, p90: 16.9, p99: 36.2, over33: 1.6, overBudget: 1.6 },
      dgpu: { fps: 245.70, delivered: 4.07, p50: 4.0, p90: 5.3, p99: 6.5, over33: 0, overBudget: 0 },
    },
    low: {
      igpu: { fps: 325.67, delivered: 3.07, p50: 2.8, p90: 4.5, p99: 6.3, over33: 0.1, overBudget: 0.1 },
      dgpu: { fps: 217.47, delivered: 4.60, p50: 4.3, p90: 6.3, p99: 9.4, over33: 0, overBudget: 0 },
    },
  },
};

/**
 * MEASURED_QUIET DID NOT REPRODUCE, AND THIS IS THE RETRACTION.
 *
 * The table it replaced recorded HIGH in a quiet room at 36.20 fps, p50 4.3,
 * p99 609.2 ms — and quality.ts quoted that 609.2 in prose as a finding. Run
 * again on a box with the contamination meter at zero, the same mode in the
 * same scene measured 74.58 fps, p50 11.8, p99 69.8. MEDIUM was transcribed at
 * 79.00 fps and measures 148.26.
 *
 * The transcribed numbers were a photograph of a contended machine, and the
 * file taught you how to see that and then did not look: their p50-to-delivered
 * ratio was 6.4x against 1.1x here, which is the signature of a swap chain
 * queueing behind somebody else's GPU work. The quiet room now lives in
 * MEASURED.quiet like every other scene, measured by the same harness, in the
 * same session, on both adapters.
 */
export const RETRACTED_MEASURED_QUIET = {
  note: "transcribed on a contended box; see MEASURED.quiet for the reproduction",
  high: { fps: 36.20, delivered: 27.63, p50: 4.3, p90: 10.4, p99: 609.2, over33: 5.9 },
  medium: { fps: 79.00, delivered: 12.66, p50: 2.3, p90: 8.2, p99: 163.7, over33: 5.0 },
  low: { fps: 204.48, delivered: 4.89, p50: 2.4, p90: 9.8, p99: 38.8, over33: 2.5 },
} as const;

/**
 * WHERE THE GPU FRAME ACTUALLY GOES — the first layer map in this file measured
 * with a GPU clock rather than inferred from wall time.
 *
 * Sandwiched A/B in the fight scene at MEDIUM on the Intel part
 * (tools/o3_where.mjs), scored on the MEDIAN of
 * EXT_disjoint_timer_query_webgl2 TIME_ELAPSED over the composed frame. Each
 * value is the GPU-time ratio you get by REMOVING that layer, so 0.40 means
 * "removing this leaves 40% of the GPU frame".
 *
 * THIS IS WHY THE WALL-CLOCK ABLATIONS IN EARLIER ROUNDS DISAGREED WITH
 * THEMSELVES. The identical arm scored 0.884 and 1.431 in consecutive reps when
 * scored on delivered time, because an unfenced rAF window on this box samples
 * a bimodal distribution whose mode mix depends on when the window opened. On
 * the GPU clock the same windows read 22.1-23.3 ms while wall time read
 * 24.8-45.2 ms. Two other instruments were tried and both lied in a way that
 * looked like data — see tools/o3lab.mjs, which lists all three failures.
 */
export const GPU_LAYERS: Record<string, number> = {
  /** Post chain over an EMPTY scene: the scene pass is 86% of the GPU frame. */
  emptyScene: 0.141,
  /** The floor group — tiles, walls, ~900 props — is the single biggest item. */
  noFloorGroup: 0.377,
  /** Quartering the backbuffer pixels. The frame is still strongly fill-bound. */
  quarterPixels: 0.324,
  /** Every monster mesh, gone. Bodies are not the frame; they never were. */
  noMonsters: 0.867,
  /** Every point light off — see POINT_LIGHT_SHARE. */
  noPointLights: 0.777,
  /** GTAO off. */
  noGtao: 0.892,
  /** The key light's shadow PASS off (the map is still sampled). */
  noShadowPass: 0.965,
  /** The generative PBR detail map's ALU contribution. */
  noSurfaceDetail: 0.983,
};

/**
 * THE BIGGEST LEVER IN THIS ENGINE THAT NOBODY IS ALLOWED TO PULL.
 *
 * A forward PBR fragment shader evaluates EVERY point light for EVERY fragment.
 * This game keeps 4 pooled impact lights + 8 pooled torch lights + the hero
 * lamp resident, and the world material covers the whole screen. Turning them
 * all off is a GPU-time ratio of 0.777 across three rotated reps (spread
 * 0.770-0.821) — 22% of the GPU frame, larger than GTAO, larger than the shadow
 * pass, larger than every post pass put together.
 *
 * IT IS LOCKED BY A REAL CONSTRAINT, NOT BY TIMIDITY. three.js forks the
 * program cache key on NUM_POINT_LIGHTS, so changing how many lights are
 * resident triggers a synchronous GLSL->HLSL->D3D build — the multi-hundred-
 * millisecond hitch the whole late-program catcher exists to avoid. That is why
 * every profile in this file declares the SAME light counts and why the pool
 * sizes are read once, at prewarm.
 *
 * The way through is prewarm, not policy: build the light-count permutations
 * behind the loading screen the way buildCharacterZoo() already builds the
 * skinning/alpha/side permutations, and the count becomes free to change — at
 * which point idle pooled lights can actually turn off and LOW can spend light
 * count the way it spends resolution. That is the next round's headline, and it
 * is written down here with its number so it cannot be forgotten again.
 */
export const POINT_LIGHT_SHARE = { gpuRatioWithoutThem: 0.777, reps: [0.770, 0.777, 0.821] };

/**
 * WHAT THIS ROUND ACTUALLY REMOVED, measured with the V8 sampling profiler over
 * the same floor-15 fight window the ladder is measured in (tools/o3_cpu.mjs).
 *
 * WHY THE PROFILE AND NOT A WALL-CLOCK RATIO. Both of these are one-way changes
 * that cannot be flipped at runtime, so a same-session A/B is not available —
 * and cross-session absolutes are not evidence on this machine. The profile is
 * the stronger claim anyway: it is the same instrument before and after, and
 * what it says is that two entries which were together 17.5% of a 13.26 ms main
 * thread are simply absent from the profile afterwards.
 *
 *  1. `readPixels` — the boss-exposure governor read 64 pixels back from the
 *     default framebuffer with a SYNCHRONOUS `gl.readPixels`, which flushes the
 *     command queue and blocks the main thread until the GPU has caught up. It
 *     is now a PIXEL_PACK_BUFFER read drained by a fence on a later frame.
 *  2. `shown` / `visible` — two MutationObserver callbacks (the touch layer's
 *     input authority and the host's modal watcher) each did `getComputedStyle`
 *     plus an `offsetWidth` read across every registered overlay. Both carried
 *     a comment saying they ran "on mutation, never per frame"; in a fight the
 *     HUD mutates watched attributes MANY times per frame, so each batch forced
 *     a full style+layout flush of the document. Coalesced to one run per
 *     animation frame.
 *
 * THE LADDER MOVED WITH THEM, on a box the contamination meter read as empty at
 * both ends. Floor-15 fight, Intel part, delivered ms:
 *
 *     LOW     25.96 -> 11.97      29.9% -> 9.5% of frames over its 20 ms budget
 *     MEDIUM  30.90 -> 24.11      25.7% -> 18.4% over 33.3 ms
 *     HIGH    54.44 -> 43.60
 *
 * That is a cross-session pair and is stated as one; the profile above is what
 * carries the causal claim.
 */
export const CPU_PROFILE = {
  scene: "floor 15, fight, LOW, Intel part, 906 frames",
  deliveredMsBefore: 13.26,
  deliveredMsAfter: 10.77,
  removed: [
    { what: "gl.readPixels (boss exposure governor)", beforeMsPerFrame: 1.553, afterMsPerFrame: 0 },
    { what: "forced reflow in the modal/authority watchers", beforeMsPerFrame: 0.766, afterMsPerFrame: 0 },
  ],
  /** Still there, and stated: the late-program catcher's compile polling. */
  remaining: [
    { what: "getProgramParameter (compileAsync polling)", msPerFrame: 0.403 },
    { what: "shown (authority watcher, now once per frame)", msPerFrame: 0.374 },
  ],
} as const;

/**
 * [shader-guard] fires per minute of floor-15 play, AFTER full readiness
 * (assets settled, #loading gone and boxless, plus three seconds). Each fire is
 * one synchronous GLSL->HLSL->D3D build on the frame a material is first drawn.
 *
 * `claimedByR2: 0` IS A RETRACTION, KEPT VISIBLE ON PURPOSE. The previous round
 * recorded `after: 0` and wrote "across 4.1 min of measured play after: zero
 * fires". Measured again on a quiet box across three separate sessions of the
 * ladder harness, the shipped build fires 3.46-5.34 times per minute, minting
 * robot_glow, skeleton, glass, demonlord and unnamed depth permutations. It is
 * a large reduction and it is not a close, and the difference matters because
 * the late-program catcher is kept at a STATED throughput cost specifically to
 * buy the tail.
 *
 * This round narrowed the exposure window rather than widening the claim: the
 * catcher's sweep ran every 30 frames, so a material could be created and then
 * DRAWN for up to 29 frames before the sweep that was meant to park it. At 4
 * frames that window is ~100 ms instead of ~750 ms, at a measured cost of
 * 0.403 ms/frame of compile polling (CPU_PROFILE.remaining).
 */
export const SHADER_BUILDS_PER_MIN = {
  /** The previous round's own measurement of the build BEFORE its catcher. */
  r2Before: 2.75,
  /** What that round then WROTE DOWN as the result. It is not true. */
  claimedByR2: 0,
  /**
   * Measured now, by tools/o3_modes.mjs, across three ladder sessions on a box
   * whose contamination meter read zero foreign browsers: 3.46, 3.99 and 5.34
   * fires per minute. Stated as the mean of the three.
   *
   * NO BEFORE/AFTER RATIO IS CLAIMED FOR THIS ROUND'S CADENCE CHANGE, because
   * this harness never measured the 30-frame cadence and the previous round's
   * 2.75 came from a different harness in a different scene. What is claimed is
   * narrow and checkable: the number is not zero, it was recorded as zero, and
   * the mechanism that leaves a residue is named above.
   */
  after: 4.26,
} as const;

/**
 * WHAT A QUALITY-MODE CHANGE COSTS — measured against a same-staging control
 * that does everything except the reallocation (tools/o3_switch.mjs, 9 switches
 * on the Intel part).
 *
 * applyQuality's doc comment frames its work as reassuring: "Everything touched
 * here is reallocation of buffers or a pass toggle". That first half is the
 * problem, not the comfort. Reallocating the composer's two HalfFloat targets
 * and their depth textures, the GTAO buffers, the bloom mip chain, the SMAA
 * targets and the shadow map is tens of megabytes of GPU allocation, and the
 * call itself measured 106-577 ms (median 372) while building ZERO shader
 * programs. It is allocation, exactly as the comment says, and allocation is
 * not cheap.
 *
 * WHAT IT IS NOT: a tail. The frames AFTER the switch are indistinguishable
 * from the control (worst-frame median 28.6 ms against the control's 28.7), so
 * the entire cost is inside the synchronous call. That matters for the fix: it
 * is one long task, not a settling period, and AUTO runs it on a machine it has
 * just judged too slow, mid-fight.
 */
export const MODE_SWITCH = {
  /** Median wall ms inside applyQuality itself. */
  applyMs: 372,
  applyRangeMs: [106, 577] as const,
  /** Worst frame in the 10 frames after the switch, and after the control. */
  worstFrameMs: 28.6,
  controlWorstFrameMs: 28.7,
  programsBuilt: 0,
} as const;

/** "auto" = let the tuner choose and keep choosing; anything else pins it. */
export type QualityChoice = QualityName | "auto";

// v2, AND THE MIGRATION IS NOT OPTIONAL. The v1 key stored the four-rung names,
// and one of them — "high" — survives into v2 meaning something completely
// different: v1 "high" was the 1.5x-pixel-ratio second rung, v2 "high" is the
// uncapped top. Reading a v1 value as a v2 name would silently move a player
// who had chosen a mid rung onto the one mode with no frame-rate promise.
const STORAGE_KEY = "dcc:quality:v2";
const LEGACY_KEY = "dcc:quality:v1";

/** v1 rung -> v2 mode. Two of the four collapse; that is the point of three. */
const LEGACY_NAMES: Record<string, QualityChoice> = {
  auto: "auto",
  ultra: "high",
  high: "medium",        // v1 HIGH was 1.5x pixel ratio, i.e. a middle rung
  balanced: "medium",
  performance: "low",
};

function normalize(v: string | null): QualityChoice | null {
  if (!v) return null;
  if (v === "auto" || v in QUALITY_PRESETS) return v as QualityChoice;
  return null;
}

export function loadQualityChoice(): QualityChoice {
  try {
    const v = normalize(localStorage.getItem(STORAGE_KEY));
    if (v) return v;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && legacy in LEGACY_NAMES) {
      const mapped = LEGACY_NAMES[legacy];
      try { localStorage.setItem(STORAGE_KEY, mapped); } catch { /* best-effort */ }
      return mapped;
    }
  } catch { /* private mode / blocked storage — auto is a fine default */ }
  return "auto";
}

export function saveQualityChoice(v: QualityChoice): void {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* best-effort */ }
}

/**
 * `?quality=low` — a URL pin that beats both storage and auto-detect, and is
 * deliberately NOT persisted.
 *
 * THE RETIRED NAMES STILL RESOLVE, BUT `high` HAS CHANGED MEANING AND THAT IS A
 * HAZARD WORTH STATING. `ultra`, `balanced` and `performance` no longer exist as
 * modes and are mapped (to high, medium, low). `high` DOES still exist and now
 * refers to the uncapped top mode — where in the four-rung ladder it was the
 * second rung at 1.5x pixel ratio. The three live names win, because a URL that
 * names a shipping mode must select that mode.
 *
 * The consequence: any harness in tools/ that passes `?quality=high` is now
 * pinning something more expensive than it did before, and any archived capture
 * labelled "high" is a picture of the OLD second rung, not of what that URL
 * produces today. Scripts that meant the middle should say `medium`.
 *
 * The URL pin exists for those harnesses. They run under SwiftShader (software GL) at
 * a few frames per second, so the tuner correctly concludes the machine is
 * hopeless and walks the mode down mid-capture — which silently turns "a
 * screenshot of HIGH" into "a screenshot of whatever it had decided by frame
 * 60". Any before/after comparison then compares two different modes. Pinning
 * from the URL makes a captured frame mean one specific mode.
 */
export function urlQualityOverride(): QualityChoice | null {
  try {
    const raw = new URLSearchParams(location.search).get("quality");
    if (!raw) return null;
    return normalize(raw) ?? LEGACY_NAMES[raw] ?? null;
  } catch { /* no location (worker/test) — no override */ }
  return null;
}

/**
 * TEST MODE FREEZES THE TUNER. THE GATE HAS TO SCORE ONE BUILD, NOT A COIN
 * FLIP (acceptance blocker, r2 SPEND).
 *
 * What was measured against the shipped build: "the same floor-2 empty room
 * landed on BALANCED/1.20x in one session and PERFORMANCE/1.00x in the next,
 * and my first look pass landed floors 2 and 14 on BALANCED then PERFORMANCE
 * across two runs of the same script." That is the tuner working exactly as
 * designed — it judges a WALL-CLOCK window, and a laptop shared with a sibling
 * workflow does not hand out the same window twice. But it means a look score
 * or a frame time for "this build" is really a score for whichever mode the
 * machine's mood picked that minute, and two such numbers can be compared
 * neither to each other nor to a budget.
 *
 * THE FIX IS TO FREEZE, NOT TO PIN. Pinning a literal mode here would be a
 * second lie: the harness would then measure a mode this machine might never
 * choose. `guessQuality` is already deterministic — it reads the unmasked
 * renderer string and devicePixelRatio, no timing anywhere — so the STARTUP
 * GUESS is reproducible on a given machine by construction. Under ?test the
 * guess stands and the runtime tuner simply never gets to move it.
 *
 * Escape hatches, both explicit: `?test&quality=auto` restores the tuner
 * verbatim, and `?test&quality=low` pins a mode for a deliberate A/B. Real play
 * — anything without ?test — is untouched.
 */
export function autoTuneFrozen(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    return q.has("test") && q.get("quality") !== "auto";
  } catch { return false; }
}

/** What the caller knows about the device without touching a GL context. */
export interface DeviceHint {
  /** matchMedia("(pointer: coarse)") — a finger, not a cursor. */
  coarse?: boolean;
  /** min(screen width, screen height) in CSS px. */
  shortEdge?: number;
}

/**
 * STARTUP GUESS — used for the very first frames, before any frame time exists.
 *
 * IT NEVER GUESSES HIGH **ON AN UNKNOWN MACHINE**. The four-rung ladder started
 * every machine at its TOP rung and let the tuner descend; the re-cut swung to
 * "never HIGH at boot" — and appearance r2 measured what THAT costs: an RTX
 * 5090 Laptop GPU booted into MEDIUM at pixelRatio 1.4, twice, verified on the
 * game's own context (tools/_ad4/capture.json). The machines most able to show
 * the HIGH art were buying the softer middle preset for the first minutes of
 * every session, because the climb needs a sub-11 ms mean over three windows
 * and vsync pins the mean near 16.7 — on a 120 Hz panel the tuner can climb,
 * on a 60 Hz one it may never. A default should not depend on the panel.
 *
 * So the guess now reads the one fact the measurement said matters: an
 * IDENTIFIED DISCRETE ADAPTER boots HIGH. On those parts HIGH is close to free
 * — MEASURED.fight has the RTX delivering 20.1 ms at HIGH against 17.8 at LOW —
 * and the runtime tuner still owns the exceptional case (an old dGPU that
 * misses frames steps down within two windows, and `ceiling` keeps it there).
 * The match is deliberately conservative: strings that name a discrete product
 * line (GeForce/RTX/GTX/Quadro, Radeon RX/PRO/VII, Arc A/B-series). "Intel
 * Arc Graphics" (Meteor Lake iGPU), "AMD Radeon Graphics" (APU) and every
 * unidentifiable string stay on MEDIUM — the mode that promises something.
 *
 * The one place the guess still goes DOWN on sight is a phone.
 */
const DISCRETE_GPU =
  /geforce|\brtx\b|\bgtx\b|quadro|radeon(\(tm\))?\s+(rx|pro|vii)\b|\barc(\(tm\))?\s+[ab]\d{3}/i;

export function guessQuality(
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null, hint?: DeviceHint,
): QualityName {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;

  let renderer = "";
  try {
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    if (dbg && gl) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
  } catch { /* extension is optional and privacy-gated in some browsers */ }

  // A PHONE IS A PHONE EVEN WHEN IT WILL NOT SAY SO.
  //
  // The mobile branch below reads WEBGL_debug_renderer_info — which Safari does
  // not expose. On an iPhone the renderer string is "", the mobile branch never
  // fires, and control falls through to the desktop default: a phone at dpr 3
  // running MEDIUM's 1.4x cap. Coarse pointer plus a short screen edge is the
  // same fact, obtained from an API nobody gates.
  if (hint?.coarse) {
    const edge = hint.shortEdge ?? Infinity;
    if (edge < 560) return "low";
    if (edge < 1100) return "medium";
  }
  // Mobile tile-based GPUs: not "a slower desktop GPU" — bandwidth and
  // sustained-power limits put them a tier below anything else here, and a
  // phone's pixel ratio is usually 3.
  if (/adreno|mali|powervr|apple a\d/i.test(renderer)) {
    return dpr >= 3 ? "low" : "medium";
  }
  // AN IDENTIFIED DISCRETE GPU BOOTS AT THE TOP — see the doc comment above.
  // Ordered after the mobile branches on purpose: a phone-shaped device never
  // reaches this line even if its renderer string were exotic.
  if (DISCRETE_GPU.test(renderer)) return "high";
  return "medium";
}

/**
 * RUNTIME AUTO-TUNER.
 *
 * IT JUDGES THROUGHPUT, NOT THE MEDIAN FRAME TIME. That distinction is the
 * whole reason this class is written the way it is.
 *
 * When the frame is bottlenecked, the browser does not hand you one slow frame
 * after another: rAF runs ahead and queues cheap frames until the swap chain
 * fills, then blocks for a long one. The frame-time distribution goes BIMODAL.
 * Measured on the reference machine at native resolution, in combat:
 *
 *     p10 5.9 ms | p50 10 ms | p75 60 ms | p90 145 ms | p99 218 ms
 *     ... while actually delivering 24 fps (42 ms per frame of wall clock).
 *
 * A median-based tuner reads "10 ms, wonderful" and never downgrades a machine
 * running at 24 fps. Mean over a fixed wall-clock window cannot be fooled that
 * way, so that is what is used.
 *
 * The rest is hysteresis, because a tuner that visibly flips modes back and
 * forth is worse than one that guesses slightly wrong:
 *   - Windows are WALL-CLOCK, not frame counts. Frame-count windows take
 *     longest to fill exactly when frames are slow — i.e. when a decision is
 *     most urgent.
 *   - Two consecutive bad windows to step DOWN. One is noise.
 *   - Stepping down remembers a ceiling and the tuner never climbs back above a
 *     mode that already failed.
 *   - Climbing needs a much better margin than descending needs a worse one,
 *     plus three consecutive good windows.
 *   - Genuinely pathological frames (shader builds, tab-switches, GC pauses)
 *     are excluded entirely — no mode can prevent those, so counting them would
 *     downgrade a machine for something a downgrade cannot fix.
 *
 * WHAT IT MAY NOT DO IS MOVE A PLAYER OUT OF A MODE THEY PICKED. That rule is
 * enforced one level up, in Renderer3D: when a mode is pinned the tuner runs in
 * ADVISORY mode and its decisions are surfaced as a suggestion the player can
 * take or ignore, never applied behind their back. See `QualityAutoTuner.advice`
 * and Renderer3D.setQualityNoticeListener.
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
  /** Highest mode not yet proven too expensive (index into QUALITY_ORDER). */
  private ceiling = 0;
  private idx: number;
  /** Mean of the window that produced the most recent decision — the number a
   *  visible notice quotes, so the player is told WHY and not just WHAT. */
  private lastMean = 0;

  constructor(start: QualityName, opts: AutoTunerOpts = {}) {
    this.idx = Math.max(0, QUALITY_ORDER.indexOf(start));
    this.windowMs = opts.windowMs ?? 1500;
    this.minFrames = opts.minFrames ?? 4;
    // DOWN AT 24 ms (42 fps), NOT 20 (50 fps). MEDIUM — the mode this ladder
    // lands the reference machine on — measures ~24.6 ms mean in the WORST
    // scene, and a threshold that sits inside a mode's own worst case would
    // demote a machine that is meeting its contract, permanently for the
    // session (`ceiling` makes it stick). The threshold has to mean "this
    // machine is genuinely not coping", not "this window was a hard fight".
    //
    // 34 ms is one frame past MEDIUM's own 33.3 ms ceiling: a machine whose
    // MEAN is worse than the mode's declared worst case really is not coping.
    //
    // WHAT THAT MEANT BEFORE opt r2, AND WHY IT IS NO LONGER THE SAME BARGAIN.
    // The acceptance pass measured this threshold's consequence precisely: 90 s
    // pinned in the dense pack, all 29 windows MEDIUM, backbuffer constant,
    // zero quality-change callbacks — AUTO never left MEDIUM while MEDIUM was
    // delivering 30-37 fps, because downMs sat above MEDIUM's own worst mean.
    // The tuner was correct and useless at the same time. The fix was not to
    // lower the threshold — a tuner that demotes a mode meeting its contract is
    // broken, and `ceiling` makes the demotion permanent for the session — but
    // to make the mode worth staying in: MEDIUM now delivers 41.2 fps in that
    // same worst scene (MEASURED). The threshold is unchanged; the thing it was
    // failing to rescue no longer needs rescuing.
    this.downMs = opts.downMs ?? 34;
    this.upMs = opts.upMs ?? 11;       // 90 fps: enough headroom to afford more
    this.stallMs = opts.stallMs ?? 400;
    this.settleWindows = opts.settleWindows ?? 2;
  }

  get current(): QualityName {
    return QUALITY_ORDER[this.idx];
  }

  /** Window mean behind the last decision, for the notice text. */
  get lastWindowMs(): number {
    return this.lastMean;
  }

  /** Pin the tuner to a mode (manual override) without disabling it. */
  reset(to: QualityName): void {
    this.idx = Math.max(0, QUALITY_ORDER.indexOf(to));
    this.ceiling = this.idx;
    this.acc = this.count = 0;
    this.badRun = this.goodRun = 0;
    this.settle = this.settleWindows;
  }

  /**
   * Feed one frame. Returns the new mode when the tuner decides to change, or
   * null (the overwhelmingly common case) when nothing should happen.
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
        this.ceiling = this.idx; // never climb back into a mode that missed
        this.settle = this.settleWindows;
        this.lastMean = mean;
        return this.current;
      }
      return null;
    }

    this.badRun = 0;
    if (mean < this.upMs) {
      // Climbing is allowed only back toward a mode that has never failed, so
      // in practice this only fires when the startup guess was too pessimistic.
      if (++this.goodRun >= 3 && this.idx > this.ceiling) {
        this.goodRun = 0;
        this.idx--;
        this.settle = this.settleWindows;
        this.lastMean = mean;
        return this.current;
      }
    } else {
      this.goodRun = 0;
    }
    return null;
  }

  /**
   * ADVISORY SAMPLE — for when the player has PINNED a mode.
   *
   * Same judgement, no side effects on the pinned mode: the tuner's own index
   * still moves (so it does not re-suggest the same step every 3 seconds), but
   * the caller is expected to SHOW the result rather than apply it. This is the
   * mechanism behind "if it steps down, that is a visible thing, not a secret".
   */
  advice(frameMs: number): QualityName | null {
    return this.sample(frameMs);
  }
}
